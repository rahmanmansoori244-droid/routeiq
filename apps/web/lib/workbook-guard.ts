import { inflateRawSync } from 'node:zlib';
import * as XLSX from 'xlsx';

/**
 * Checks on an uploaded spreadsheet BEFORE SheetJS reads it (audit E2 quick fix, 27 Sep 2026, and
 * the A1 review fixes).
 *
 * SheetJS reads a file in the web process, on the event loop, and nothing can stop it once it has
 * started. It picks its reader from the file's first bytes, not from its name, and several of its
 * readers do far more work than the file's size suggests:
 *  - an .xlsx is a zip archive whose parts SheetJS unpacks by the sizes in the zip headers (a 606 KB
 *    file that unpacks to 200 MB blocked it for more than 3 minutes);
 *  - a hyperlink over a range makes one cell object for every cell of the range, whatever
 *    `sheetRows` says (a 1.7 KB .xlsx with one link over A1:XFD1048576 ran out of memory; a 4 KB
 *    .xls with one link over 65,536 x 65,536 cells would loop for about half an hour);
 *  - its OpenDocument, HTML and other text readers repeat cells or compare every cell with every
 *    merged range (a 763-byte flat OpenDocument file took 7.7 s).
 *
 * guardSpreadsheet() lets SheetJS read only what these checks can bound, and gives it the bytes
 * to read:
 *  - a zip archive must be an Excel workbook (checkWorkbookZip): every part is unpacked with zlib
 *    under a hard cap, so the size is measured, never taken from the headers; each part's name is
 *    read from its local header, where SheetJS reads it, and must be the name in the central
 *    directory; the hyperlink ranges of every part are added up, and so are the cells, comments,
 *    metadata entries and comment authors SheetJS would make or compare (scanXmlPart); binary
 *    parts (.bin: .xlsb sheets, printer settings, macros) are hidden from SheetJS, which needs none
 *    of them for an .xlsx; which parts SheetJS reads for each sheet is replayed (sheetReads), so a
 *    part it reads more than once is counted once more for every further read, two sheets that
 *    read one worksheet part are refused, and so is a sheet that is not a worksheet (a chart
 *    sheet's chart becomes cells that no cap bounds);
 *  - an old .xls that is a compound file has its structure checked first (checkCompoundFile), in
 *    linear time, so XLSX.CFB.read itself cannot be made to use time and memory that grow with the
 *    square of the file's size; then, as for a bare BIFF stream, the hyperlink ranges in its
 *    workbook stream are added up before SheetJS reads it;
 *  - any other file is read only when SheetJS reads it as CSV or tab-separated text; a web page, an
 *    XML or OpenDocument file, DIF, Lotus, dBASE, RTF, SocialCalc or a real SYLK file is refused.
 *    A file that begins with "ID" is a CSV that SheetJS reads via its SYLK reader's CSV fallback,
 *    unless it is really SYLK or its SYLK reader would do more than a little work first (see
 *    idFileReader), so an order or customer CSV with a leading "ID" column - which a Windows
 *    browser sends as application/vnd.ms-excel - is read, not refused.
 *
 * This bounds the work of one upload; it does not isolate it. A file under the caps is still parsed
 * on the event loop (see lib/csv.ts for what the worst one costs). Parsing in a worker thread with
 * a memory cap and a timeout that really stops it is audit PR 5.
 */

/** Refusal of an upload with a message for the dispatcher (the routes answer 400 with it). */
export class WorkbookRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbookRefusedError';
  }
}

export interface SpreadsheetLimits {
  /** Largest total size of all parts once unpacked. */
  maxUnpackedBytes: number;
  /** Most parts (files inside the zip) a workbook may have. */
  maxParts: number;
  /** Most cells all hyperlink ranges together may cover (SheetJS makes a cell for each). */
  maxLinkCells: number;
  /**
   * Most cells SheetJS may read: counted from the cells of a workbook's parts that have a type or
   * a value, or from the separators and line breaks of a text file, before it reads them.
   */
  maxCells: number;
  /** Most comments (notes) a workbook may have. */
  maxComments: number;
  /** Most cell-metadata types, and most future-metadata blocks, a workbook may have (each). */
  maxMetadata: number;
  /** Most people the threaded comments' person list may name. */
  maxPeople: number;
  /**
   * Most sheets a workbook may list. The guard does not refuse more (lib/csv does, on the sheet
   * list SheetJS reads first); it only stops replaying the sheets' reads there.
   */
  maxSheets: number;
}

export interface WorkbookZipCheck {
  parts: number;
  unpackedBytes: number;
  /** The bytes SheetJS reads: `unpackedBytes`, plus each part's size again for every further read. */
  readBytes: number;
  /**
   * Cells SheetJS makes from all parts: pieces with a type or a value (rows past `sheetRows`
   * included), a part's again for every further read.
   */
  cells: number;
  /** Cells covered by all hyperlink ranges, as SheetJS would expand them. */
  linkCells: number;
  /** The workbook's sheet names, as SheetJS reads them (the sheet list lib/csv checks against). */
  sheetNames: string[];
  /** The bytes SheetJS reads: the upload itself, or it with the binary parts left out. */
  view: Buffer;
}

/** What guardSpreadsheet gives SheetJS to read. */
export interface GuardedSpreadsheet {
  /** The bytes SheetJS is to read. */
  view: Buffer;
  /** For an .xlsx: its sheet names, as SheetJS reads them (see sameSheetList). */
  sheetNames?: string[];
}

const SAVE_AGAIN = 'Save only the sheet you need as a new workbook or as CSV and upload that.';

const damaged = () =>
  new WorkbookRefusedError('This workbook is damaged and cannot be read. Open it in Excel, save it again as .xlsx and upload it again.');
const notExcel = () => new WorkbookRefusedError('This file is not an Excel workbook. Save it in Excel as .xlsx or as CSV and upload that.');
const passwordProtected = () =>
  new WorkbookRefusedError('This workbook is password-protected. Remove the password in Excel, save it and upload it again.');
const tooManyCells = (cells: number, max: number, remedy: string) =>
  new WorkbookRefusedError(
    `This file is too large to read: it has about ${cells.toLocaleString('en-US')} cells (rows x columns); at most ${max.toLocaleString('en-US')} can be read. ${remedy}`,
  );
const tooManyLinks = (cells: number, max: number) =>
  new WorkbookRefusedError(
    `This workbook has links over ${Number.isFinite(cells) ? `${cells.toLocaleString('en-US')} cells` : 'more cells than a sheet has'}; at most ${max.toLocaleString('en-US')} can be read. ` +
      'Remove the links (in Excel: select the cells, right-click, Remove Hyperlinks), save it and upload it again.',
  );

/** The test SheetJS itself uses to read a file as a zip archive (readSync, first four bytes). */
export function isZipFile(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2]! < 9 && b[3]! < 9;
}

const u16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + b[i + 3]! * 0x1000000;
const u64 = (b: Uint8Array, i: number) => u32(b, i) + u32(b, i + 4) * 0x100000000;

/**
 * Which SheetJS reader a file goes to, from its first bytes: the same tests, in the same order, as
 * SheetJS's readSync (xlsx 0.20.2) for a Buffer.
 */
export type SheetjsReader = 'zip' | 'cfb' | 'biff' | 'xml' | 'text' | 'text-ws' | 'text-utf16' | 'other';
const DBF_VERSIONS = [0x02, 0x03, 0x30, 0x31, 0x83, 0x8b, 0x8c, 0xf5];

/**
 * The record types SheetJS's SYLK reader (sylk_to_aoa_str, xlsx 0.20.2) knows, and the field codes
 * its C (cell) and F (format) records know. With WTF on (read_wb_ID sets it) it throws "SYLK bad
 * record" at the first record whose type is not one of these, and at the first field of a C or F
 * record whose code (first letter) is not one of these; read_wb_ID then catches that (WTF is off
 * for the caller) and reads the file as CSV instead.
 */
const SYLK_RECORD_TYPES = new Set(['ID', 'E', 'B', 'O', 'W', 'P', 'NN', 'C', 'F']);
const SYLK_FIELD_CODES: Record<string, string> = { C: 'AXYKESGRC', F: 'XYMFGPSDNWCR' };
/**
 * Steps SheetJS's SYLK reader may take on a file before it gives up and reads it as CSV: one per
 * record, one per row it adds, one per column a width field loops over, one per character of a
 * format it checks. 100,000 is a few milliseconds and about 10 MB; a CSV takes a handful.
 */
const SYLK_MAX_STEPS = 100_000;

/** How many times `for (j = from; j <= to; ++j)` runs; Infinity when it never ends. */
function loopCount(from: number, to: number): number {
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 0;
  // Past 2^53, ++j no longer changes j: such a loop never ends.
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to + 1)) return Infinity;
  return to - from + 1;
}

/**
 * How SheetJS reads a file that begins with the bytes "ID": 'text' when it reads it as CSV after
 * little work, 'other' (refused) when it reads it as SYLK - a workbook that no cell cap bounds - or
 * when it does too much work before it falls back to CSV.
 *
 * SheetJS routes such a file to read_wb_ID, which runs its SYLK reader and reads the file as CSV
 * when that throws. The SYLK reader splits the file into records on line breaks and each record on
 * ";" (";;" is a ";"), and works record by record and field by field: everything before the record
 * or field that makes it throw is done for real. Its costly steps are a Y field (a row: the sheet
 * grows to that row, one array per row), a W field of an F record (column widths: a loop from its
 * first to its last column) and a K field (a value) after an F record gave it a format (the whole
 * format is checked). So "ID", then `C;Y5000000;X1;K1`, then any line that is not SYLK allocates 5
 * million rows (0.6 GB) before SheetJS reads the file as CSV.
 *
 * A CSV whose first header is "ID" makes the reader give up at once: with a comma or a tab the
 * first field is the whole line ("ID,Customer Code" is not "ID"); with a semicolon the first data
 * row is not a SYLK record (`1;C1;5`), or starts with a SYLK record type and goes on with plain
 * data, which is not a field of that record (`C;5;10`: "5" is not a C field; `F;maths;40`). Chrome
 * and Edge on a Windows PC with Excel installed send every .csv as application/vnd.ms-excel, so
 * this path is common.
 *
 * This replays the reader's walk over the whole file, counting its steps (SYLK_MAX_STEPS), up to
 * the first record or field it throws on. A record after the first that holds an ESC character is
 * refused: SheetJS decodes escape sequences before it reads a record (ESC "$3" is a "C"), and no
 * CSV has one. Only the errors WTF raises are replayed; SheetJS may give up earlier on another
 * error (a value before any row), which only means it does less work than counted here, or reads
 * as CSV a short file refused here.
 */
function idFileReader(b: Uint8Array): 'text' | 'other' {
  const text = Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');
  const RECORD_BREAK = /[\n\r]+/g;
  let steps = 0;
  let records = 0; // non-empty records read
  let rows = 0; // the rows the reader's sheet has so far
  const formats: number[] = []; // the length of each format a "P;P..." record defines
  let format: number | null = null; // the length of the format the next value is checked against
  for (let pos = 0; pos <= text.length; ) {
    RECORD_BREAK.lastIndex = pos;
    const brk = RECORD_BREAK.exec(text);
    const record = text.slice(pos, brk ? brk.index : text.length).trim();
    pos = brk ? RECORD_BREAK.lastIndex : text.length + 1;
    if (++steps > SYLK_MAX_STEPS) return 'other';
    if (record === '') continue; // SheetJS skips empty records
    if (records > 0 && record.includes('\u001b')) return 'other';
    records++;
    // The record type is the first field: up to the first ";" that is not part of ";;".
    const sep = record.indexOf(';');
    const type = sep < 0 ? record : record[sep + 1] === ';' ? null : record.slice(0, sep);
    if (type === null || !SYLK_RECORD_TYPES.has(type)) return 'text'; // SYLK bad record: CSV
    if (type === 'P' && sep > 0 && record[sep + 1] === 'P') formats.push(record.slice(3).replace(/;;/g, ';').length);
    const codes = SYLK_FIELD_CODES[type];
    if (!codes) continue; // ID, E, B, O, W, P, NN: no field is refused, no costly step
    const fields = record.replace(/;;/g, '\u0000').split(';').map((f) => f.replace(/\u0000/g, ';'));
    let columnSet = false; // F: an X field (else the format is dropped)
    let value = false; // C: a K field (the format is then used up)
    for (let i = 1; i < fields.length; i++) {
      const field = fields[i]!;
      const code = field.charAt(0);
      if (code === '' || !codes.includes(code)) return 'text'; // SYLK bad record: CSV
      const n = parseInt(field.slice(1), 10);
      if (code === 'Y' && n > rows) {
        steps += n - rows; // the sheet grows to row n, one array per row (Infinity never ends)
        rows = n;
      } else if (code === 'W') {
        const range = field.slice(1).split(' ');
        steps += loopCount(parseInt(range[0]!, 10), parseInt(range[1]!, 10));
      } else if (code === 'K') {
        value = true;
        steps += format ?? 0; // a number is checked against the whole format
      } else if (code === 'P' && type === 'F') {
        format = formats[n] ?? 0;
      } else if (code === 'X' && type === 'F') {
        columnSet = true;
      }
      if (steps > SYLK_MAX_STEPS) return 'other';
    }
    if (type === 'C' && value) {
      steps += format ?? 0; // and the value is formatted with it once
      format = null;
    }
    if (type === 'F' && !columnSet) format = null;
    if (steps > SYLK_MAX_STEPS) return 'other';
  }
  // Every record is SYLK: SheetJS reads the file as SYLK. "ID" alone makes an empty workbook with
  // no work (as before this guard it is left to SheetJS, which reads no rows from it).
  return records <= 1 ? 'text' : 'other';
}
export function sheetjsReader(b: Uint8Array): SheetjsReader {
  const n = [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]];
  const le = (i: number, v: number) => n[i] !== undefined && n[i]! <= v;
  switch (n[0]) {
    case 0xd0:
      if (n[1] === 0xcf && n[2] === 0x11 && n[3] === 0xe0 && n[4] === 0xa1 && n[5] === 0xb1 && n[6] === 0x1a && n[7] === 0xe1) return 'cfb';
      break;
    case 0x09:
      if (le(1, 0x08)) return 'biff';
      break;
    case 0x3c:
      return 'xml';
    case 0x49:
      if (n[1] === 0x49 && n[2] === 0x2a && n[3] === 0x00) return 'other'; // TIFF
      // "ID": SheetJS routes this to read_wb_ID, which reads it as SYLK, or, when the SYLK reader
      // throws (WTF off, as lib/csv reads), falls back to its CSV reader. So it is refused only
      // when it really reads as SYLK or its SYLK reader does too much work before it gives up;
      // otherwise it is delimited text (see idFileReader).
      if (n[1] === 0x44) return idFileReader(b);
      break;
    case 0x54:
      if (n[1] === 0x41 && n[2] === 0x42 && n[3] === 0x4c) return 'other'; // DIF
      break;
    case 0x50:
      return n[1] === 0x4b && n[2]! < 0x09 && n[3]! < 0x09 ? 'zip' : 'text';
    case 0xef:
      return n[3] === 0x3c ? 'xml' : 'text';
    case 0xff:
      if (n[1] === 0xfe) return 'text-utf16';
      if (n[1] === 0x00 && n[2] === 0x02 && n[3] === 0x00) return 'other'; // Lotus
      break;
    case 0x00:
      if (n[1] === 0x00) {
        if (n[2] !== undefined && n[2] >= 0x02 && n[3] === 0x00) return 'other'; // Lotus
        if (n[2] === 0x00 && (n[3] === 0x08 || n[3] === 0x09)) return 'other'; // Lotus
      }
      break;
    case 0x03:
    case 0x83:
    case 0x8b:
    case 0x8c:
      return 'other'; // dBASE
    case 0x7b:
      if (n[1] === 0x5c && n[2] === 0x72 && n[3] === 0x74) return 'other'; // RTF
      break;
    case 0x0a:
    case 0x0d:
    case 0x20:
      return 'text-ws';
    case 0x89:
      if (n[1] === 0x50 && n[2] === 0x4e && n[3] === 0x47) return 'other'; // PNG
      break;
    case 0x08:
      if (n[1] === 0xe7) return 'other'; // Multiplan
      break;
    case 0x0c:
      if (n[1] === 0xec || n[1] === 0xed) return 'other'; // Multiplan
      break;
  }
  if (n[0] !== undefined && DBF_VERSIONS.includes(n[0]) && le(2, 12) && le(3, 31)) return 'other'; // dBASE
  return 'text';
}

/**
 * Checks an upload that is to be read as Excel and returns the bytes SheetJS should read (and, for
 * an .xlsx, its sheet names as SheetJS reads them). Throws WorkbookRefusedError when SheetJS would
 * read it with a reader whose work these checks cannot bound, or when a check fails (see the top
 * of this file).
 */
export function guardSpreadsheet(bytes: Uint8Array, limits: SpreadsheetLimits): GuardedSpreadsheet {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (sheetjsReader(b)) {
    case 'zip': {
      const { view, sheetNames } = checkWorkbookZip(b, limits);
      return { view, sheetNames };
    }
    case 'cfb': {
      // A crafted compound file can make XLSX.CFB.read itself use memory and time that grow with
      // the square of the file's size (make_sector_list walks and copies a FAT chain from every
      // sector), so its structure is checked in linear time before CFB.read is called.
      checkCompoundFile(b);
      let cfb: unknown;
      try {
        cfb = XLSX.CFB.read(b, { type: 'buffer' });
      } catch {
        throw damaged();
      }
      // The streams SheetJS looks for, found the way it finds them (read_cfb, parse_xlscfb).
      if (XLSX.CFB.find(cfb, 'EncryptedPackage') || XLSX.CFB.find(cfb, '/encryption')) throw passwordProtected();
      const stream = XLSX.CFB.find(cfb, '/Workbook') || XLSX.CFB.find(cfb, '/Book');
      if (!stream?.content) throw notExcel();
      checkLinkCells(biffLinkCells(stream.content as Uint8Array), limits.maxLinkCells);
      return { view: b };
    }
    case 'biff':
      checkLinkCells(biffLinkCells(b), limits.maxLinkCells);
      return { view: b };
    case 'text':
    case 'text-ws':
    case 'text-utf16':
      checkDelimitedText(b, limits.maxCells);
      return { view: b };
    case 'xml':
      throw webPageOrXml();
    default:
      throw notExcel();
  }
}

/**
 * Refuses (as damaged) a workbook whose sheet list, as SheetJS read it (`names`), is not the one
 * the guard replayed its reads for (`guarded`, from guardSpreadsheet): its counts would then be
 * for other parts than the ones SheetJS reads. A file that is not an .xlsx has no `guarded` list.
 */
export function sameSheetList(guarded: string[] | undefined, names: string[]): void {
  if (guarded && (guarded.length !== names.length || guarded.some((n, i) => n !== names[i]))) throw damaged();
}

const webPageOrXml = () =>
  new WorkbookRefusedError(
    'This file is a web page or an XML file, not an Excel workbook or CSV. Open it in Excel, save it as .xlsx and upload that.',
  );

/**
 * Text that SheetJS reads as CSV or tab-separated text. Its text reader hands anything that starts
 * with "<" after spaces and line breaks to its XML reader (read_plaintext), and a SocialCalc file
 * to its own reader (prn_to_sheet): both are refused. Its CSV reader makes at most one cell per
 * separator (one of , tab ; | or the one a "sep=" first line names) or line break, plus one, and
 * spends several microseconds on each (it tries every value as a number and as a date): a
 * 9.5 MB file of 5 million cells took 20 s. More than `maxCells` of them are refused unread.
 */
function checkDelimitedText(b: Buffer, maxCells: number): void {
  const reader = sheetjsReader(b);
  let text = reader === 'text-utf16' ? b.subarray(2).toString('utf16le') : b.toString('latin1');
  if (reader === 'text' && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) text = text.slice(3);
  if (reader !== 'text') {
    const first = text.search(/[^\n\r ]/);
    if (first >= 0 && text[first] === '<') throw webPageOrXml();
  }
  if (text.startsWith('socialcalc:version:')) throw notExcel();
  const own = text.startsWith('sep=') ? text.charCodeAt(4) : -1;
  let cells = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x2c || c === 0x09 || c === 0x3b || c === 0x7c || c === 0x0a || c === 0x0d || c === own) cells++;
  }
  if (cells > maxCells) throw tooManyCells(cells, maxCells, 'Split the file, or remove the columns you do not need, and upload again.');
}

function checkLinkCells(cells: number, max: number): void {
  if (cells > max) throw tooManyLinks(cells, max);
}

/**
 * Cells a range covers when SheetJS loops over it (for R from s.r to e.r, for C from s.c to e.c).
 * An address too long for a number (hundreds of letters) decodes to Infinity, and a loop from
 * Infinity to Infinity never ends: such a range counts as endless.
 */
function rangeCells(s: { r: number; c: number }, e: { r: number; c: number }): number {
  if (![s.r, s.c, e.r, e.c].every(Number.isFinite)) return Infinity;
  const rows = e.r - s.r + 1;
  const cols = e.c - s.c + 1;
  return rows > 0 && cols > 0 ? rows * cols : 0;
}

/**
 * Cells covered by the hyperlink records (HLink, HLinkTooltip) of a BIFF workbook stream. SheetJS
 * steps through the stream record by record (4-byte header + its length, continuation records
 * included) and loops over every cell of each record's range; this walks it the same way. Every
 * record is counted, also after an end-of-file record, where SheetJS may already have stopped.
 */
function biffLinkCells(s: Uint8Array): number {
  let total = 0;
  for (let p = 0; p + 4 <= s.length; p += 4 + u16(s, p + 2)) {
    const type = u16(s, p);
    const at = type === 0x01b8 ? p + 4 : type === 0x0800 ? p + 6 : -1; // Ref8U; HLinkTooltip has a 2-byte header first
    if (at < 0 || at + 8 > s.length) continue;
    total += rangeCells({ r: u16(s, at), c: u16(s, at + 4) }, { r: u16(s, at + 2), c: u16(s, at + 6) });
  }
  return total;
}

const s32 = (b: Uint8Array, i: number): number => {
  const v = u32(b, i);
  return v >= 0x80000000 ? v - 0x100000000 : v;
};
const ENDOFCHAIN = -2;

/**
 * Refuses a compound file (an old .xls, or any OLE2 file that begins with the compound-file
 * signature) whose FAT would make XLSX.CFB.read do work that grows with the square of the file's
 * size, in linear time and constant extra memory, before CFB.read is called.
 *
 * SheetJS's make_sector_list (xlsx 0.20.2) starts at dir_start and, wrapping, walks the FAT chain
 * from every sector it has not already seen as a chain start, copying each walk into a new buffer.
 * It only skips a sector as a *start* once some walk has reached it; a later walk can still walk
 * *through* it. In a file whose chains are stored in descending sector order (sector s points to
 * s-1) every sector starts a walk down through all the sectors below it, so the total walk is
 * about D^2/2 for D sectors: a 2 MB file (about 4,000 sectors) copies 8 million sectors, 4 GB, and
 * at the 10 MB limit the web process is killed. No real writer stores chains this way; each sector
 * still has one predecessor, so it reads as one ordinary chain and no simpler structural check
 * catches it.
 *
 * This replays make_sector_list's walk order, counting sectors only (no copies), and refuses the
 * file as damaged once the total passes a few times the sector count - a well-formed file's chains
 * are disjoint, so its total is the sector count. It also refuses a directory that is far larger
 * than any real workbook's (SheetJS's build_full_paths is quadratic in the number of directory
 * entries). Anything CFB.read would reject before make_sector_list (a bad header, a short file) is
 * left to CFB.read, which throws quickly and is turned into "damaged" by the caller.
 */
function checkCompoundFile(file: Uint8Array): void {
  const len = file.length;
  if (len < 512) return; // CFB.read throws "CFB file size < 512"; no walk happens
  const mver = u16(file, 26);
  const ssz = mver === 3 ? 512 : mver === 4 ? 4096 : 0;
  if (!ssz || u16(file, 30) !== (mver === 3 ? 0x09 : 0x0c)) return; // CFB.read throws on the header
  if (mver === 3 && s32(file, 40) !== 0) return; // # directory sectors must be 0 for v3
  const dirStart = s32(file, 48);
  const difatStart = s32(file, 68);
  let difatCnt = s32(file, 72);

  // The number of sectors, indexed from 0; sector s is the ssz bytes at (s + 1) * ssz.
  const sl = Math.ceil(len / ssz) - 1;
  if (sl <= 0) return;

  // FAT sector addresses: the 109 in the header (up to the first negative), then the DIFAT chain.
  const fatAddrs: number[] = [];
  for (let j = 0; j < 109; j++) {
    const q = s32(file, 76 + j * 4);
    if (q < 0) break;
    fatAddrs.push(q);
  }
  const difatSeen = new Set<number>();
  const entriesPerDifat = (ssz >>> 2) - 1;
  for (let idx = difatStart; idx !== ENDOFCHAIN && idx >= 0 && idx < sl; ) {
    if (difatSeen.has(idx)) break; // a looping DIFAT chain
    difatSeen.add(idx);
    const base = (idx + 1) * ssz;
    for (let i = 0; i < entriesPerDifat; i++) {
      const off = base + i * 4;
      if (off + 4 > len) break;
      const q = s32(file, off);
      if (q === ENDOFCHAIN) break;
      fatAddrs.push(q);
    }
    if (difatCnt < 1) break;
    difatCnt -= 1;
    const nextOff = base + ssz - 4;
    if (nextOff + 4 > len) break;
    idx = s32(file, nextOff);
  }

  // The next sector in the FAT chain from j, or a negative value when the chain ends here (the end
  // marker, a free/FAT sector, or a FAT sector that is not present) - so the walk below stops.
  const modulus = ssz - 1;
  const fatNext = (j: number): number => {
    const addr = fatAddrs[Math.floor((j * 4) / ssz)];
    if (addr === undefined || addr < 0 || addr >= sl) return -1;
    const off = (addr + 1) * ssz + ((j * 4) & modulus);
    return off + 4 > len ? -1 : s32(file, off);
  };

  // The directory chain, from dir_start: its entries drive the quadratic build_full_paths.
  const entriesPerSector = ssz >> 7; // 128-byte entries
  const maxDirSectors = Math.ceil(MAX_DIR_ENTRIES / entriesPerSector) + 1;
  if (dirStart >= 0 && dirStart < sl) {
    const dseen = new Set<number>();
    let dj = dirStart;
    let dirSectors = 0;
    while (dj >= 0 && dj < sl && !dseen.has(dj)) {
      dseen.add(dj);
      if (++dirSectors > maxDirSectors) throw damaged();
      dj = fatNext(dj);
    }
  }

  // Replay make_sector_list's walk, counting sectors only. A well-formed file visits each sector
  // once (total = sl); the descending-chain file visits about sl^2 / 2, so it passes the limit -
  // a few times the sector count - after only a few thousand steps and is refused at once.
  const limit = Math.max(sl * 4 + 1024, 50_000);
  const chkd = new Uint8Array(sl);
  const seenGen = new Int32Array(sl); // 0 = unseen; each walk uses a fresh positive generation
  let gen = 0;
  let steps = 0;
  for (let i = 0; i < sl; i++) {
    let k = i + dirStart;
    if (k >= sl) k -= sl;
    if (k < 0 || k >= sl || chkd[k]) continue;
    gen++;
    for (let j = k; j >= 0; ) {
      if (j >= sl) {
        // A FAT entry past the sectors: CFB.read reads one absent sector and stops.
        if (++steps > limit) throw damaged();
        break;
      }
      if (seenGen[j] === gen) break; // a cycle within this one walk
      seenGen[j] = gen;
      chkd[j] = 1;
      if (++steps > limit) throw damaged();
      j = fatNext(j);
    }
  }
}

/** Most directory entries a workbook may have; SheetJS's build_full_paths is quadratic in this. */
const MAX_DIR_ENTRIES = 16_384;

/** Parts that make SheetJS read the archive as something other than an Excel workbook. */
const FOREIGN_PARTS = new Set(['manifest.xml', 'objectdata.xml', 'document.iwa', 'index.zip', 'index.xml', 'index.xml.gz']);

/**
 * The ZIP64 sizes a local header's extra field carries, read as SheetJS reads them
 * (parse_extra_field): uncompressed size, then compressed size.
 */
function zip64Sizes(b: Uint8Array, from: number, to: number): { usz: number; csz: number } | null {
  let p = from;
  while (p + 4 <= to) {
    const id = u16(b, p);
    const size = u16(b, p + 2);
    if (id === 0x0001) {
      if (p + 20 > b.length) throw damaged();
      return { usz: u64(b, p + 4), csz: u64(b, p + 12) };
    }
    p += 4 + size;
  }
  return null;
}

/**
 * A part's path as SheetJS keeps it (cfb_add under "Root Entry/"), without that root: the name it
 * finds parts by ([Content_Types].xml, META-INF/manifest.xml).
 */
function sheetjsPath(name: string): string {
  const root = 'Root Entry/';
  const full = name.startsWith(root) ? name : (root + name).replace('//', '/');
  return full.replace(/^Root Entry\//, '');
}

/**
 * The last segment of a part's name, lower-cased, trailing slashes dropped, split on "/" and "\\":
 * covers both SheetJS's lookups by file name (CFB.find: "Index.zip/" is found as "Index.zip") and by
 * path (safegetzipfile, which also accepts "\\").
 */
function baseName(name: string): string {
  const trimmed = name.replace(/[/\\]+$/, '').toLowerCase();
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}

/** What SheetJS makes or compares from the parts, added up over the parts it reads. */
interface Totals {
  links: number;
  cells: number;
  comments: number;
  metadataTypes: number;
  futureMetadata: number;
  people: number;
}

/** Adds one part's counts to the totals. */
function addScan(t: Totals, scan: XmlPartScan): void {
  t.links += scan.links;
  t.cells += scan.cells;
  t.comments += scan.comments;
  t.metadataTypes += scan.metadataTypes;
  t.futureMetadata += scan.futureMetadata;
  t.people += scan.people;
}

/** Refuses totals over a cap, the first one found in this order. */
function checkTotals(t: Totals, limits: SpreadsheetLimits): void {
  checkLinkCells(t.links, limits.maxLinkCells);
  if (t.cells > limits.maxCells) throw tooManyCells(t.cells, limits.maxCells, SAVE_AGAIN);
  if (t.comments > limits.maxComments) {
    throw new WorkbookRefusedError(
      `This workbook has ${t.comments.toLocaleString('en-US')} comments or more; at most ${limits.maxComments.toLocaleString('en-US')} can be read. ` +
        'Delete the comments (in Excel: Review, Delete), save it and upload it again.',
    );
  }
  const metadata = Math.max(t.metadataTypes, t.futureMetadata);
  if (metadata > limits.maxMetadata) {
    throw new WorkbookRefusedError(
      `This workbook has ${metadata.toLocaleString('en-US')} metadata entries or more; at most ${limits.maxMetadata.toLocaleString('en-US')} can be read. ${SAVE_AGAIN}`,
    );
  }
  if (t.people > limits.maxPeople) {
    throw new WorkbookRefusedError(
      `This workbook lists ${t.people.toLocaleString('en-US')} comment authors or more; at most ${limits.maxPeople.toLocaleString('en-US')} can be read. ${SAVE_AGAIN}`,
    );
  }
}

/**
 * Relationship types of sheets that are not worksheets (SheetJS's RELS.CS, DS and MS, xlsx
 * 0.20.2). For a chart sheet SheetJS reads the chart of its drawing and makes a cell for every
 * point cached in it (parse_chart), with no row limit: a 3.1 MB upload whose chart part caches
 * 1.3 million points (the cell count saw 1 cell) read as 1.3 million rows in 5.5 s and 1 GB, and
 * one point at index 4,294,967,294 in a 1.7 KB upload made it walk an array of 4.3 billion slots
 * for about 3 minutes. RouteIQ reads only worksheets, so a workbook with any of these is refused.
 */
const NOT_WORKSHEET_RELS = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/dialogsheet',
  'http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet',
];
const notWorksheet = () =>
  new WorkbookRefusedError(
    'This workbook has a chart sheet (or a dialog or macro sheet), which cannot be read. Delete that sheet, or save only the sheet you need as a new workbook or as CSV, and upload that.',
  );

/**
 * Measures what SheetJS would unpack from this zip archive and refuses it when the total is over
 * `maxUnpackedBytes`, when it has more than `maxParts` parts, when a part says it is smaller or
 * larger than it really is, when a part's two names differ, when its hyperlinks cover more than
 * `maxLinkCells` cells, when it has more than `maxCells` cells (with a type or a value),
 * `maxComments` comments, `maxMetadata` metadata types or future-metadata blocks, or `maxPeople`
 * comment authors in its person list (see scanXmlPart), and when it is not an Excel workbook.
 *
 * A part SheetJS reads more than once (see sheetReads) is counted once more for every further read:
 * its size, cells, links, comments and the rest. Two sheets that read one worksheet part, and a
 * sheet that is not a worksheet (a chart, dialog or macro sheet), are refused.
 *
 * Throws WorkbookRefusedError. Returns what it measured, the sheet names as SheetJS reads them and
 * the bytes SheetJS is to read.
 */
export function checkWorkbookZip(b: Uint8Array, limits: SpreadsheetLimits): WorkbookZipCheck {
  // End of the central directory: SheetJS takes the last signature in the file, and so does this.
  let eocd = -1;
  for (let i = b.length - 4; i >= 0; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > b.length) throw damaged();
  const parts = u16(b, eocd + 8); // the count SheetJS reads (records on this disk)
  if (parts > limits.maxParts) {
    throw new WorkbookRefusedError(`This workbook has ${parts.toLocaleString('en-US')} parts inside; at most ${limits.maxParts.toLocaleString('en-US')} can be read. ${SAVE_AGAIN}`);
  }

  const mb = Math.round(limits.maxUnpackedBytes / 1024 / 1024);
  const tooBig = () => new WorkbookRefusedError(`This workbook is too large to read: it unpacks to more than ${mb} MB. ${SAVE_AGAIN}`);

  let p = u32(b, eocd + 16); // start of the central directory
  let unpacked = 0;
  const totals: Totals = { links: 0, cells: 0, comments: 0, metadataTypes: 0, futureMetadata: 0, people: 0 };
  let contentTypes = false;
  let binaryWorkbook = false;
  let notWorksheetRel = false;
  /** Central-directory records SheetJS is given (start, end); binary parts are left out. */
  const kept: [number, number][] = [];
  /** The parts SheetJS is given, in the order it finds them. */
  const entries: ZipEntry[] = [];
  for (let k = 0; k < parts; k++) {
    // Central directory record: SheetJS uses where the part starts; the name it uses is the one in
    // the part's local header (parse_local_file), which must be this one.
    if (p + 46 > b.length) throw damaged();
    const nameLen = u16(b, p + 28);
    const at = u32(b, p + 42);
    if (p + 46 + nameLen > b.length) throw damaged();
    const cdName = b.subarray(p + 46, p + 46 + nameLen);
    const record: [number, number] = [p, p + 46 + nameLen + u16(b, p + 30) + u16(b, p + 32)];
    if (record[1] > b.length) throw damaged();
    p = record[1];

    // Local header: SheetJS reads the part from here, with this name and these sizes.
    if (at + 30 > b.length) throw damaged();
    const localNameLen = u16(b, at + 26);
    if (at + 30 + localNameLen > b.length) throw damaged();
    const localName = b.subarray(at + 30, at + 30 + localNameLen);
    // Two names for one part: a check on one name would miss what SheetJS does with the other.
    if (localName.length !== cdName.length || localName.some((c, i) => c !== cdName[i])) throw damaged();
    // No real workbook has control characters in a part name; SheetJS's lookups drop some of them.
    if (localName.some((c) => c < 0x20)) throw damaged();
    const name = Buffer.from(localName).toString('latin1');
    const base = baseName(name);
    if (sheetjsPath(name).toLowerCase() === '[content_types].xml') contentTypes = true;
    if (FOREIGN_PARTS.has(base)) throw notExcel();
    const binary = name.toLowerCase().endsWith('.bin');
    if (binary && base === 'workbook.bin') binaryWorkbook = true;
    if (!binary) kept.push(record);

    const flags = u16(b, at + 6);
    const method = u16(b, at + 8);
    if (flags & 0x2041) throw passwordProtected();
    let csz = u32(b, at + 18);
    let usz = u32(b, at + 22);
    const extraFrom = at + 30 + localNameLen;
    const dataAt = extraFrom + u16(b, at + 28);
    if (dataAt > b.length) throw damaged();
    const z64 = zip64Sizes(b, extraFrom, dataAt);
    if (z64?.usz) usz = z64.usz;
    if (z64?.csz) csz = z64.csz;

    let data: Buffer;
    if (method === 8) {
      // Deflate: unpack for real, never more than what is left of the allowance (+1 byte, so
      // "over" is seen). SheetJS reads to the end of the compressed stream, whatever the header
      // says, and so does zlib.
      const room = limits.maxUnpackedBytes - unpacked;
      try {
        data = inflateRawSync(b.subarray(dataAt), { maxOutputLength: Math.max(1, room + 1) });
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooBig();
        throw damaged();
      }
      // A size in the header that is not the real one: SheetJS would allocate by the header
      // (a huge claim) or silently cut the part (a small one). A zero size (the real one
      // follows the data) is normal.
      if (usz !== 0 && usz !== data.length) throw damaged();
    } else if (method === 0) {
      data = Buffer.from(b.buffer, b.byteOffset + dataAt, Math.max(0, Math.min(csz, b.length - dataAt))); // stored: SheetJS takes these bytes as they are
    } else {
      throw new WorkbookRefusedError('This workbook uses a compression Excel does not use and cannot be read. Save it in Excel as .xlsx and upload it again.');
    }
    unpacked += data.length;
    if (unpacked > limits.maxUnpackedBytes) throw tooBig();
    if (!binary) {
      const scan = scanXmlPart(data);
      addScan(totals, scan);
      checkTotals(totals, limits);
      entries.push({ key: sheetjsPath(name).toLowerCase(), size: data.length, data, scan });
      // SheetJS reads the workbook's relationships from a part whose name ends in ".rels"; the
      // type it compares must be written out in full, so a part that holds it names such a sheet.
      if (name.toLowerCase().endsWith('.rels')) {
        const text = sheetjsText(data);
        if (NOT_WORKSHEET_RELS.some((t) => text.includes(t))) notWorksheetRel = true;
      }
    }
  }
  if (binaryWorkbook) {
    throw new WorkbookRefusedError('This is an Excel binary workbook (.xlsb), which cannot be read. Save it in Excel as .xlsx and upload that.');
  }
  if (!contentTypes) throw notExcel();
  if (notWorksheetRel) throw notWorksheet();

  // Parts SheetJS reads more than once: counted again for every further read, and refused as soon
  // as a cap is passed (so the replay itself never reads much more than the caps allow).
  const reads = entries.map(() => 0);
  let readBytes = unpacked;
  const onRead = (i: number) => {
    if (++reads[i]! < 2) return;
    readBytes += entries[i]!.size;
    if (readBytes > limits.maxUnpackedBytes) {
      throw new WorkbookRefusedError(`This workbook is too large to read: its sheets read the same parts again, more than ${mb} MB in all. ${SAVE_AGAIN}`);
    }
    addScan(totals, entries[i]!.scan);
    checkTotals(totals, limits);
  };
  let sheetNames: string[];
  try {
    sheetNames = sheetReads(entries, onRead, limits.maxSheets);
  } catch (err) {
    if (err instanceof WorkbookRefusedError) throw err;
    throw damaged(); // the replay met something SheetJS would fail on as well
  }

  const view = kept.length === parts ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : withCentralDirectory(b, kept);
  return { parts, unpackedBytes: unpacked, readBytes, cells: totals.cells, linkCells: totals.links, sheetNames, view };
}

/** A part SheetJS is given: its name as SheetJS looks it up (lower case), size, bytes and counts. */
interface ZipEntry {
  key: string;
  size: number;
  data: Buffer;
  scan: XmlPartScan;
}

/**
 * Relationship types SheetJS compares (its RELS table, xlsx 0.20.2): a worksheet, and the comments
 * and threaded comments a sheet's relationships name.
 */
const REL_WORKSHEET = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet',
];
const REL_COMMENTS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const REL_THREADED_COMMENTS = 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment';

/**
 * The parts of [Content_Types].xml SheetJS reads (its ct2type table, xlsx 0.20.2), by content type.
 * Of each kind it reads the first part listed, except external links: every one listed, each time
 * it is listed.
 */
const CONTENT_KINDS = new Map<string, string>([
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', 'workbooks'],
  ['application/vnd.ms-excel.sheet.macroEnabled.main+xml', 'workbooks'],
  ['application/vnd.ms-excel.sheet.binary.macroEnabled.main', 'workbooks'],
  ['application/vnd.ms-excel.addin.macroEnabled.main+xml', 'workbooks'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml', 'workbooks'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml', 'strs'],
  ['application/vnd.ms-excel.sharedStrings', 'strs'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml', 'styles'],
  ['application/vnd.ms-excel.styles', 'styles'],
  ['application/vnd.openxmlformats-package.core-properties+xml', 'coreprops'],
  ['application/vnd.openxmlformats-officedocument.custom-properties+xml', 'custprops'],
  ['application/vnd.openxmlformats-officedocument.extended-properties+xml', 'extprops'],
  ['application/vnd.ms-excel.person+xml', 'people'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml', 'metadata'],
  ['application/vnd.ms-excel.sheetMetadata', 'metadata'],
  ['application/vnd.ms-excel.externalLink', 'links'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml', 'links'],
]);

/**
 * Replays how SheetJS's parse_zip (xlsx 0.20.2, reading an .xlsx with the options lib/csv uses)
 * finds the parts it reads, calls `onRead` with each part (its index in `entries`) every time
 * SheetJS reads it, and returns the sheet names as SheetJS reads them. Refuses two sheets that
 * read one worksheet part (as damaged). A workbook that lists more than `maxSheets` sheets is not
 * replayed past its sheet list: lib/csv refuses it on that list before any sheet is read.
 *
 * SheetJS reads each sheet listed in the workbook part from the part its relationship names: the
 * sheet's r:id is looked up in the workbook's relationships, and the target is tried as
 * "xl/" + target, as it is, and next to the relationships folder, each through its lookup that
 * ignores capitals and takes "\" for "/" (safegetzipfile). Nothing stops two sheets from naming one
 * part, so a part counted once was read (and turned into cells) up to ten times: a 121 KB upload of
 * 50,000 rows x 49 columns in one part, named by ten sheets, took 94-108 s and 3.4 GB before the
 * sheets' range was refused, or ran the process out of memory. For each sheet SheetJS also reads
 * its relationships, every part they name as comments or threaded comments (one read per spelling
 * of the target, so "comments1.xml" and "Comments1.xml" are two reads of one part) and the drawing
 * of notes its <legacyDrawing> names; and it reads every external link as often as
 * [Content_Types].xml lists it. A 3 KB file whose sheet named one comments part 20 times took
 * 8.8 s (each read adds the comments again, and SheetJS checks every comment already on a cell);
 * a 51 MB drawing of notes shared by ten sheets 58 s.
 *
 * Where SheetJS would stop with an error, the replay goes on when it can: it may count reads that
 * never happen (the file is then refused, where SheetJS would have failed on it anyway), never
 * miss one. The reads of the sheet-list pass (lib/csv reads the workbook part, [Content_Types].xml
 * and the external links once more) are not counted: they double those few parts at most.
 */
function sheetReads(entries: ZipEntry[], onRead: (i: number) => void, maxSheets: number): string[] {
  const find = partLookup(entries);
  const read = (i: number | undefined) => {
    if (i !== undefined && i >= 0) onRead(i);
  };
  const found = (file: string) => find(file) !== undefined;
  const text = (i: number | undefined): string | null => (i === undefined || i < 0 ? null : sheetjsText(entries[i]!.data));
  const none: string[] = [];

  const ctPart = find('[Content_Types].xml');
  read(ctPart);
  const ct = parseContentTypes(text(ctPart));
  let workbook = ct.get('workbooks')?.[0];
  if (!ct.get('workbooks')?.length) {
    const i = find('xl/workbook.xml');
    if (i !== undefined && i >= 0 && entries[i]!.size > 0) workbook = 'xl/workbook.xml';
  }
  if (typeof workbook !== 'string') return none; // SheetJS: "Could not find workbook", or an error
  const wbext = workbook.slice(-3) === 'bin' ? 'bin' : 'xml';
  const first = (kind: string) => ct.get(kind)?.[0];
  const readFirst = (kind: string) => {
    const part = first(kind);
    if (typeof part === 'string' && part) read(find(stripFrontSlash(part)));
  };
  readFirst('strs');
  readFirst('styles');
  for (const link of ct.get('links') ?? []) {
    if (typeof link !== 'string') continue;
    const rels = find(relsPathOf(stripFrontSlash(link)));
    if (rels === undefined) continue; // SheetJS gives up on this link before reading it
    read(rels);
    read(find(stripFrontSlash(link)));
  }
  const wbPart = find(stripFrontSlash(workbook));
  if (wbPart === undefined) return none;
  read(wbPart);
  const sheets = workbookSheets(text(wbPart));
  const sheetNames = sheets.map((s) => unescapeXml(utf8read(String(s.name))));
  if (ct.get('coreprops')?.length) {
    readFirst('coreprops');
    if (ct.get('extprops')?.length) readFirst('extprops');
  }
  if (sheets.length > maxSheets) return sheetNames;
  readFirst('custprops');

  const slash = workbook.lastIndexOf('/');
  let wbRelsFile = (workbook.slice(0, slash + 1) + '_rels/' + workbook.slice(slash + 1) + '.rels').replace(/^\//, '');
  if (!found(wbRelsFile)) wbRelsFile = `xl/_rels/workbook.${wbext}.rels`;
  const wbRelsPart = find(wbRelsFile);
  read(wbRelsPart);
  const wbRels = parseRels(text(wbRelsPart), wbRelsFile.replace(/_rels.*/, 's5s'));
  readFirst('metadata');
  readFirst('people');
  const targets = sheetTargets(wbRels, sheets);
  const numbers = find('xl/worksheets/sheet.xml');
  const nmode = numbers !== undefined && numbers >= 0 && entries[numbers]!.size > 0 ? 1 : 0;

  const sheetParts = new Set<number>();
  for (let i = 0; i < sheets.length; i++) {
    let path: string;
    let stype = 'sheet';
    const t = targets?.[i];
    if (t) {
      const target = t[1];
      if (typeof target !== 'string') break; // SheetJS throws here and reads no further sheet
      path = 'xl/' + target.replace(/[\/]?xl\//, '');
      if (!found(path)) path = target;
      if (!found(path)) path = wbRelsFile.replace(/_rels\/[\S\s]*$/, '') + target;
      stype = t[2];
    } else {
      path = ('xl/worksheets/sheet' + (i + 1 - nmode) + '.' + wbext).replace(/sheet0\./, 'sheet.');
    }
    // A chart, dialog or macro sheet never gets here: checkWorkbookZip refused its relationship.
    // safe_parse_sheet: the sheet's relationships, then the sheet itself.
    const relsPart = find(path.replace(/^(.*)(\/)([^/]*)$/, '$1/_rels/$3.rels'));
    read(relsPart);
    const rels = parseRels(text(relsPart), path);
    const part = find(path);
    if (part === undefined) continue; // SheetJS: "Cannot find file"
    read(part);
    if (part >= 0) {
      if (sheetParts.has(part)) throw damaged();
      sheetParts.add(part);
    }
    if (stype !== 'sheet') continue; // "Unrecognized sheet type", thrown after both reads
    // Every part its relationships name as comments or threaded comments, once per key.
    for (const key of Object.keys(rels)) {
      const rel = rels[key] as { Type?: unknown; Target?: unknown };
      if (rel.Type === REL_COMMENTS || rel.Type === REL_THREADED_COMMENTS) read(find(resolvePath(String(rel.Target), path)));
    }
    // The drawing of notes its <legacyDrawing r:id="..."> names. SheetJS takes the first one after
    // the sheet data, or, with none, the relationship whose Id is missing ("undefined"); every
    // one of them is counted.
    const ids = new Set(['undefined']);
    const sheetData = part >= 0 ? entries[part]!.data : null;
    if (sheetData && (sheetData.includes('legacyDrawing') || isUtf16(sheetData))) {
      for (const m of text(part)!.matchAll(/legacyDrawing r:id="(.*?)"/g)) ids.add(m[1]!);
    }
    const byId = rels['!id'] as Record<string, { Target?: unknown } | undefined>;
    for (const id of ids) {
      const rel = byId[id];
      if (rel && typeof rel.Target === 'string') read(find(resolvePath(rel.Target, path)));
    }
  }
  return sheetNames;
}

/**
 * SheetJS's part lookup (safegetzipfile): the first part whose name, without "Root Entry/" and in
 * lower case, is the path in lower case with every "/" as "\" or every "\" as "/". SheetJS's zip
 * reader lists two entries of its own first (the root, and "\u0001Sh33tJ5"), found as -1.
 */
function partLookup(entries: ZipEntry[]): (file: string) => number | undefined {
  const first = new Map<string, number>([
    ['', -1],
    ['\u0001sh33tj5', -1],
  ]);
  entries.forEach((e, i) => {
    if (!first.has(e.key)) first.set(e.key, i);
  });
  return (file) => {
    const back = file.toLowerCase().replace(/\//g, '\\');
    const a = first.get(back);
    const b = first.get(back.replace(/\\/g, '/'));
    return a === undefined ? b : b === undefined ? a : Math.min(a, b);
  };
}

/**
 * The text SheetJS reads a part as (cc2str with its byte-order-mark handling): the bytes as
 * latin1, or UTF-16 decoded and written back as UTF-8 bytes.
 */
function sheetjsText(d: Buffer): string {
  return isUtf16(d) ? Buffer.from(partText(d), 'utf8').toString('latin1') : d.toString('latin1');
}

/** SheetJS's test for a part in UTF-16 (a byte-order mark; its big-endian test looks at bytes 1-2). */
const isUtf16 = (d: Buffer) => (d[0] === 0xff && d[1] === 0xfe) || (d[1] === 0xfe && d[2] === 0xff);

/** SheetJS's tag pattern (tagregex1) and namespace patterns (nsregex, nsregex2), xlsx 0.20.2. */
const TAG = /<[\/\?]?[a-zA-Z0-9:_-]+(?:\s+[^"\s?<>\/]+\s*=\s*(?:"[^"]*"|'[^']*'|[^'"<>\s=]+))*\s*[\/\?]?>/gm;
const NS = /<\w*:/;
const NS2 = /<(\/?)\w+:/;

type XmlTag = Record<string, string>;

/** SheetJS's parsexmltag (xlsx 0.20.2): the tag's attributes, and with `skipRoot` false its name as `0`. */
function parseXmlTag(tag: string, skipRoot = false): XmlTag {
  const z: XmlTag = {};
  let eq = 0;
  for (; eq !== tag.length; ++eq) {
    const c = tag.charCodeAt(eq);
    if (c === 32 || c === 10 || c === 13) break;
  }
  if (!skipRoot) z[0] = tag.slice(0, eq);
  if (eq === tag.length) return z;
  for (const m of tag.match(ATTR) ?? []) {
    const cc = m.slice(1);
    let c = 0;
    for (; c !== cc.length; ++c) if (cc.charCodeAt(c) === 61) break;
    let q = cc.slice(0, c).trim();
    while (cc.charCodeAt(c + 1) === 32) ++c;
    const e = cc.charCodeAt(c + 1);
    const quot = e === 34 || e === 39 ? 1 : 0;
    const v = cc.slice(c + 1 + quot, cc.length - quot);
    let j = 0;
    for (; j !== q.length; ++j) if (q.charCodeAt(j) === 58) break;
    if (j === q.length) {
      if (q.indexOf('_') > 0) q = q.slice(0, q.indexOf('_'));
      z[q] = v;
      z[q.toLowerCase()] = v;
    } else {
      const k = (j === 5 && q.slice(0, 5) === 'xmlns' ? 'xmlns' : '') + q.slice(j + 1);
      if (z[k] && q.slice(j - 3, j) === 'ext') continue;
      z[k] = v;
      z[k.toLowerCase()] = v;
    }
  }
  return z;
}

const XML_ENTITIES: Record<string, string> = { '&quot;': '"', '&apos;': "'", '&gt;': '>', '&lt;': '<', '&amp;': '&' };
/** SheetJS's unescapexml (xlsx 0.20.2): entities, character references, _xHHHH_ codes, CDATA. */
function unescapeXml(text: string): string {
  const i = text.indexOf('<![CDATA[');
  if (i === -1) {
    return text
      .replace(/&(?:quot|apos|gt|lt|amp|#x?([\da-fA-F]+));/gi, (all: string, n: string) => XML_ENTITIES[all] || String.fromCharCode(parseInt(n, all.indexOf('x') > -1 ? 16 : 10)) || all)
      .replace(/_x([\da-fA-F]{4})_/gi, (_: string, c: string) => String.fromCharCode(parseInt(c, 16)));
  }
  const j = text.indexOf(']]>');
  return unescapeXml(text.slice(0, i)) + text.slice(i + 9, j) + unescapeXml(text.slice(j + 3));
}

/** SheetJS's utf8read with a Buffer (utf8readc): the latin1 characters read as UTF-8 bytes. */
const utf8read = (s: string) => Buffer.from(s, 'latin1').toString('utf8');

const stripFrontSlash = (x: string) => (x.charAt(0) === '/' ? x.slice(1) : x);

/** SheetJS's get_rels_path: the relationships part of a part. */
function relsPathOf(file: string): string {
  const n = file.lastIndexOf('/');
  return file.slice(0, n + 1) + '_rels/' + file.slice(n + 1) + '.rels';
}

/** SheetJS's resolve_path: a relationship's target, from the folder of the part that names it. */
function resolvePath(path: string, base: string): string {
  if (path.charAt(0) === '/') return path.slice(1);
  const result = base.split('/');
  if (base.slice(-1) !== '/') result.pop();
  for (const step of path.split('/')) {
    if (step === '..') result.pop();
    else if (step !== '.') result.push(step);
  }
  return result.join('/');
}

/** SheetJS's parse_ct, the lists it reads: part names by kind (CONTENT_KINDS), in order. */
function parseContentTypes(data: string | null): Map<string, (string | undefined)[]> {
  const ct = new Map<string, (string | undefined)[]>();
  for (const x of data?.match(TAG) ?? []) {
    if (!x.includes('Override')) continue; // quick: no other tag can be one
    const y = parseXmlTag(x);
    if (y[0]!.replace(NS, '<') !== '<Override') continue;
    const kind = CONTENT_KINDS.get(y.ContentType as string);
    if (!kind) continue;
    const list = ct.get(kind);
    if (list) list.push(y.PartName);
    else ct.set(kind, [y.PartName]);
  }
  return ct;
}

/** SheetJS's parse_wb_xml, the sheet list: every <sheet ...> tag (any namespace), in order. */
function workbookSheets(data: string | null): XmlTag[] {
  const sheets: XmlTag[] = [];
  for (const x of data?.match(TAG) ?? []) {
    if (!x.includes('sheet')) continue; // quick: no other tag can be one
    const y = parseXmlTag(x);
    if (y[0]!.replace(NS2, '<$1') === '<sheet') sheets.push(y);
  }
  return sheets;
}

type Rels = Record<string, unknown>;
/**
 * SheetJS's parse_rels: each relationship under its target resolved from `currentFilePath` (the
 * last one wins), and under "!id" by its Id. Plain objects, as SheetJS keeps them, so a key such
 * as "__proto__" or "constructor" behaves as it does there.
 */
function parseRels(data: string | null, currentFilePath: string): Rels {
  const rels: Rels = { '!id': {} };
  if (!data) return rels;
  const base = currentFilePath.charAt(0) !== '/' ? '/' + currentFilePath : currentFilePath;
  const hash: Record<string, unknown> = {};
  if (!data.includes('<Relationship')) return rels; // quick: e.g. a worksheet read as relationships
  for (const x of data.match(TAG) ?? []) {
    if (!x.startsWith('<Relationship')) continue; // quick: no other tag can be one
    const y = parseXmlTag(x);
    if (y[0] !== '<Relationship') continue;
    const rel: Record<string, unknown> = { Type: y.Type, Target: unescapeXml(String(y.Target)), Id: y.Id };
    if (y.TargetMode) rel.TargetMode = y.TargetMode;
    const canonic = y.TargetMode === 'External' ? y.Target : resolvePath(String(y.Target), base);
    rels[canonic as string] = rel;
    hash[y.Id as string] = rel;
  }
  rels['!id'] = hash;
  return rels;
}

/** SheetJS's get_sheet_type. */
function sheetType(n: unknown): string {
  if (REL_WORKSHEET.includes(n as string)) return 'sheet';
  if (n === NOT_WORKSHEET_RELS[0]) return 'chart';
  if (n === NOT_WORKSHEET_RELS[1]) return 'dialog';
  if (n === NOT_WORKSHEET_RELS[2]) return 'macro';
  return n && (n as { length?: number }).length ? String(n) : 'sheet';
}

/**
 * SheetJS's safe_parse_wbrels: for each sheet [name, target, type] from the workbook's
 * relationships, or null (then every sheet is read from xl/worksheets/sheet<n>.xml) when a
 * sheet's r:id is not there.
 */
function sheetTargets(wbRels: Rels, sheets: XmlTag[]): [unknown, unknown, string][] | null {
  const byId = wbRels['!id'] as Record<string, { Target?: unknown; Type?: unknown }>;
  try {
    const out = sheets.map((w): [unknown, unknown, string] => {
      if (!w.id) w.id = w.strRelID!;
      const rel = byId[w.id]!;
      return [w.name, rel.Target, sheetType(rel.Type)];
    });
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * The upload with a new central directory listing only `records` (copied as they are) appended
 * after it. SheetJS reads the last end-of-directory record, so it sees only these parts; their data
 * stays where it is.
 */
function withCentralDirectory(b: Uint8Array, records: [number, number][]): Buffer {
  const cd = Buffer.concat(records.map(([s, e]) => b.subarray(s, e)));
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(records.length, 8);
  end.writeUInt16LE(records.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(b.length, 16);
  return Buffer.concat([b, cd, end]);
}

/**
 * The text SheetJS reads an XML part as (cc2str): UTF-16 after a byte-order mark (its big-endian
 * test looks at bytes 1-2 and decodes from byte 2), otherwise the bytes, whose tags it decodes as
 * UTF-8.
 */
function partText(d: Buffer): string {
  if (d[0] === 0xff && d[1] === 0xfe) return d.subarray(2).toString('utf16le');
  if (d[1] === 0xfe && d[2] === 0xff) {
    const s = d.subarray(2);
    const out: string[] = [];
    for (let i = 0; i + 1 < s.length; i += 2) out.push(String.fromCharCode((s[i]! << 8) | s[i + 1]!));
    return out.join('');
  }
  return d.toString('utf8');
}

/** SheetJS's hyperlink tag (hlinkregex) and attribute (attregexg) patterns, xlsx 0.20.2. */
const HLINK_TAG = /<(?:\w+:)?hyperlink [^<>]*>/gm;
const ATTR = /\s([^"\s?>\/]+)\s*=\s*((?:")([^"]*)(?:")|(?:')([^']*)(?:')|([^'">\s]+))/g;

/**
 * Where SheetJS cuts a worksheet into cells, and which pieces it keeps (parse_ws_xml_data, xlsx
 * 0.20.2). It cuts the sheet data at each row end (</row>) and, after each row's opening tag, at
 * each cell start (/<(?:\w+:)?c[ \/>]/); each piece - also the text between a row's opening tag and
 * its first cell start - is read as "<c " + the piece. With formulas and stub cells off (as lib/csv
 * reads) a piece is kept as a cell when its tag has a type (a `t` attribute, as parsexmltag reads
 * it: any case, a namespace prefix, a "_..." suffix) or a <v> value follows the tag, and dropped
 * otherwise. So a formatted empty cell (<c r="B2" s="1"/>, which Excel writes for borders and
 * colours) is not a cell, and formatting alone never makes a workbook "too large"; but a tag that
 * closes itself is a cell when it has a type (<c t="b"/> is a FALSE cell) or a value follows it
 * (<c r="A1" s="1"/><v>1</v>, <c/><v>1</v>).
 *
 * CELL_PIECES finds, in one pass, where pieces start (group 1: a cell start or a row end, without
 * the character after it, which may begin the piece) and the two marks of a kept piece: a `t`
 * attribute (whitespace, ":", ">" or "/" before it; "=", "_" or whitespace after it) and a <v> tag.
 * A piece with a mark counts as one cell. A mark SheetJS does not read as one (a "t=" after the tag,
 * a "<v/>") can only count a piece that is not a cell, never miss one that is.
 */
const CELL_PIECES = /(<(?:\w+:)?c(?=[ \/>])|<\/(?:\w+:)?row(?=>))|[\s:>\/][tT][\s=_]|<(?:\w+:)?v\b/g;
/** A comment or threaded comment (not <comments> or <commentList>). */
const COMMENT_TAG = /<(?:\w+:)?(?:threadedComment|comment)[ >/]/g;
/** A cell-metadata type and a future-metadata block of xl/metadata.xml (not <metadataTypes>). */
const METADATA_TYPE_TAG = /<(?:\w+:)?metadataType[\s/>]/g;
const FUTURE_METADATA_TAG = /<(?:\w+:)?futureMetadata[\s/>]/g;
/** A person of the threaded comments' person list, xl/persons/person.xml (not <personList>). */
const PERSON_TAG = /<(?:\w+:)?person[\s/>]/g;

function countMatches(re: RegExp, text: string): number {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(text)) n++;
  return n;
}

interface XmlPartScan {
  cells: number;
  comments: number;
  links: number;
  metadataTypes: number;
  futureMetadata: number;
  people: number;
}

/**
 * What one XML part makes SheetJS do beyond its size:
 *  - `cells`, the cells SheetJS makes from it (see CELL_PIECES; rows past `sheetRows` are counted
 *    too);
 *  - `comments`, its comments (SheetJS checks every comment already on a cell before adding one, so
 *    many on one cell take time growing with the square: 20,000 took 0.4 s, and 50 MB of them
 *    would take minutes);
 *  - `links`, the cells its hyperlinks cover. SheetJS finds each <hyperlink ...> tag of a worksheet
 *    with HLINK_TAG, reads its `ref` with parsexmltag (from the tag decoded as UTF-8; namespace
 *    prefixes and "_..." suffixes dropped, any case) and makes a cell for every address of the
 *    range (parse_ws_xml_hlinks). This reads every link that way, also those after one without
 *    `ref` (where SheetJS stops);
 *  - `metadataTypes` and `futureMetadata`: for each future-metadata block SheetJS looks through
 *    every metadata type (parse_xlmeta_xml), so the time grows with the product: 100,000 of each
 *    (a 15 KB upload) took 28 s, and 1,000,000 of each fit under the 50 MB cap (about an hour);
 *  - `people`: for each threaded comment SheetJS looks up its author in the whole person list
 *    (sheet_insert_comments), so the time grows with comments x people: 9,900 threaded comments
 *    and a person list of 2.9 million (a 142 KB upload) took 109 s.
 * Every part is read this way, whether or not SheetJS reads it as a worksheet, comments, metadata
 * or a person list.
 */
function scanXmlPart(d: Buffer): XmlPartScan {
  const utf16 = (d[0] === 0xff && d[1] === 0xfe) || (d[1] === 0xfe && d[2] === 0xff);
  // A UTF-16 part is searched after decoding; a UTF-8 one only when its bytes hold the tag name.
  const has = (s: string) => utf16 || d.indexOf(s) >= 0;
  if (!has('<')) return { cells: 0, comments: 0, links: 0, metadataTypes: 0, futureMetadata: 0, people: 0 };
  // The tags' structure is ASCII, the same in the bytes read as latin1 (as SheetJS scans them)
  // and in the decoded text; only a matched link tag is decoded, as SheetJS does.
  const text = utf16 ? partText(d) : d.toString('latin1');
  let cells = 0;
  let kept = false; // the current piece has a type or a value
  CELL_PIECES.lastIndex = 0;
  for (let m = CELL_PIECES.exec(text); m; m = CELL_PIECES.exec(text)) {
    if (m[1] === undefined) {
      kept = true;
    } else {
      if (kept) cells++;
      kept = false;
    }
  }
  if (kept) cells++;
  const comments = countMatches(COMMENT_TAG, text);
  let links = 0;
  if (has('hyperlink ')) {
    for (const tag of text.match(HLINK_TAG) ?? []) {
      const ref = hyperlinkRef(utf16 ? tag : Buffer.from(tag, 'latin1').toString('utf8'));
      if (!ref) continue;
      const range = safeDecodeRange(ref);
      links += rangeCells(range.s, range.e);
    }
  }
  return {
    cells,
    comments,
    links,
    metadataTypes: has('metadataType') ? countMatches(METADATA_TYPE_TAG, text) : 0,
    futureMetadata: has('futureMetadata') ? countMatches(FUTURE_METADATA_TAG, text) : 0,
    people: has('person') ? countMatches(PERSON_TAG, text) : 0,
  };
}

/** The `ref` SheetJS's parsexmltag(tag, true) gives a tag: the same key rules, the last value wins. */
function hyperlinkRef(tag: string): string | undefined {
  return parseXmlTag(tag, true).ref;
}

/**
 * SheetJS's safe_decode_range (xlsx 0.20.2): how parse_ws_xml_hlinks decodes a link's range and
 * sheet_to_json a sheet's "!ref".
 */
export function safeDecodeRange(range: string): { s: { r: number; c: number }; e: { r: number; c: number } } {
  const o = { s: { c: 0, r: 0 }, e: { c: 0, r: 0 } };
  let idx = 0;
  let i = 0;
  let cc = 0;
  const len = range.length;
  for (idx = 0; i < len; ++i) {
    if ((cc = range.charCodeAt(i) - 64) < 1 || cc > 26) break;
    idx = 26 * idx + cc;
  }
  o.s.c = --idx;
  for (idx = 0; i < len; ++i) {
    if ((cc = range.charCodeAt(i) - 48) < 0 || cc > 9) break;
    idx = 10 * idx + cc;
  }
  o.s.r = --idx;
  if (i === len || cc !== 10) {
    o.e.c = o.s.c;
    o.e.r = o.s.r;
    return o;
  }
  ++i;
  for (idx = 0; i !== len; ++i) {
    if ((cc = range.charCodeAt(i) - 64) < 1 || cc > 26) break;
    idx = 26 * idx + cc;
  }
  o.e.c = --idx;
  for (idx = 0; i !== len; ++i) {
    if ((cc = range.charCodeAt(i) - 48) < 0 || cc > 9) break;
    idx = 10 * idx + cc;
  }
  o.e.r = --idx;
  return o;
}
