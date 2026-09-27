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
 *    directory; the hyperlink ranges of every part are added up; binary parts (.bin: .xlsb sheets,
 *    printer settings, macros) are hidden from SheetJS, which needs none of them for an .xlsx;
 *  - an old .xls that is a compound file has its structure checked first (checkCompoundFile), in
 *    linear time, so XLSX.CFB.read itself cannot be made to use time and memory that grow with the
 *    square of the file's size; then, as for a bare BIFF stream, the hyperlink ranges in its
 *    workbook stream are added up before SheetJS reads it;
 *  - any other file is read only when SheetJS reads it as CSV or tab-separated text; a web page, an
 *    XML or OpenDocument file, DIF, Lotus, dBASE, RTF, SocialCalc or a real SYLK file is refused.
 *    A file that begins with "ID" is a CSV that SheetJS reads via its SYLK reader's CSV fallback,
 *    unless it is really SYLK (see looksLikeSylk), so an order or customer CSV with a leading "ID"
 *    column - which a Windows browser sends as application/vnd.ms-excel - is read, not refused.
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
   * Most cells SheetJS may read: counted from the cell tags of a workbook's parts, or from the
   * separators and line breaks of a text file, before it reads them.
   */
  maxCells: number;
  /** Most comments (notes) a workbook may have. */
  maxComments: number;
}

export interface WorkbookZipCheck {
  parts: number;
  unpackedBytes: number;
  /** Cell tags in all parts (rows past `sheetRows` included). */
  cells: number;
  /** Cells covered by all hyperlink ranges, as SheetJS would expand them. */
  linkCells: number;
  /** The bytes SheetJS reads: the upload itself, or it with the binary parts left out. */
  view: Buffer;
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
 * The record types SheetJS's SYLK reader (sylk_to_aoa_str, xlsx 0.20.2) knows. It splits the file
 * into records on line breaks, splits each record on ";", and, with WTF on (read_wb_ID sets it),
 * throws "SYLK bad record" on the first record whose first field is not one of these; read_wb_ID
 * then catches that (WTF is off for the caller) and reads the file as CSV instead.
 */
const SYLK_RECORD_TYPES = new Set(['ID', 'E', 'B', 'O', 'W', 'P', 'NN', 'C', 'F']);

/**
 * Whether SheetJS would read a file that begins with the bytes "ID" as SYLK (and so make a
 * workbook that no cell cap bounds), rather than fall back to CSV. A real SYLK file opens with an
 * "ID" record and then another SYLK record (for example `ID;PWXL` then `P;...` and `C;...`); the
 * SYLK reader accepts it without throwing. A CSV whose first column header is "ID" does not: with
 * a comma or tab the whole first line is one field ("ID,Customer Code" is not "ID"), and with a
 * semicolon the first data row (`1;C1;...`) is not a SYLK record, so the reader throws on it and
 * SheetJS reads the file as CSV (as it did before this guard). Chrome and Edge on a Windows PC
 * with Excel installed send every .csv as application/vnd.ms-excel, so this path is common.
 *
 * This checks the two records that decide it (SheetJS's rule is "every record is a SYLK record",
 * and these two separate all the real cases): the first record's first ";"-field must be exactly
 * "ID", and the next non-empty record's first field must be a SYLK record type.
 */
function looksLikeSylk(b: Uint8Array): boolean {
  // SYLK is ASCII; only the first records matter, so read a small prefix as latin1.
  const head = Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 4096)).toString('latin1');
  const records = head.split(/[\n\r]+/);
  // SheetJS trims each record, then splits on ";" with ";;" as an escaped ";". The record type is
  // the first field; escapes never appear in it in practice, so only the ";;" escape is handled.
  const recordType = (line: string): string =>
    line.trim().replace(/;;/g, '\u0000').split(';')[0]!.replace(/\u0000/g, ';');
  if (recordType(records[0] ?? '') !== 'ID') return false;
  for (let i = 1; i < records.length; i++) {
    if (records[i]!.trim() === '') continue; // SheetJS skips empty records (rstr.length > 0)
    return SYLK_RECORD_TYPES.has(recordType(records[i]!));
  }
  return false; // "ID" alone: SheetJS makes an empty SYLK workbook; read it as (empty) text instead
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
      // throws (WTF off, as lib/csv reads), falls back to its CSV reader. So it is SYLK (refused)
      // only when it really parses as SYLK; otherwise it is delimited text (see looksLikeSylk).
      if (n[1] === 0x44) return looksLikeSylk(b) ? 'other' : 'text';
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
 * Checks an upload that is to be read as Excel and returns the bytes SheetJS should read. Throws
 * WorkbookRefusedError when SheetJS would read it with a reader whose work these checks cannot
 * bound, or when a check fails (see the top of this file).
 */
export function guardSpreadsheet(bytes: Uint8Array, limits: SpreadsheetLimits): Buffer {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (sheetjsReader(b)) {
    case 'zip':
      return checkWorkbookZip(b, limits).view;
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
      return b;
    }
    case 'biff':
      checkLinkCells(biffLinkCells(b), limits.maxLinkCells);
      return b;
    case 'text':
    case 'text-ws':
    case 'text-utf16':
      checkDelimitedText(b, limits.maxCells);
      return b;
    case 'xml':
      throw webPageOrXml();
    default:
      throw notExcel();
  }
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

/**
 * Measures what SheetJS would unpack from this zip archive and refuses it when the total is over
 * `maxUnpackedBytes`, when it has more than `maxParts` parts, when a part says it is smaller or
 * larger than it really is, when a part's two names differ, when its hyperlinks cover more than
 * `maxLinkCells` cells, when it has more than `maxCells` cells with content or `maxComments`
 * comments, and when it is not an Excel workbook. Throws WorkbookRefusedError. Returns what it
 * measured and the bytes SheetJS is to read.
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
  let linkCells = 0;
  let cells = 0;
  let comments = 0;
  let contentTypes = false;
  let binaryWorkbook = false;
  /** Central-directory records SheetJS is given (start, end); binary parts are left out. */
  const kept: [number, number][] = [];
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
      linkCells += scan.links;
      checkLinkCells(linkCells, limits.maxLinkCells);
      cells += scan.cells;
      if (cells > limits.maxCells) throw tooManyCells(cells, limits.maxCells, SAVE_AGAIN);
      comments += scan.comments;
      if (comments > limits.maxComments) {
        throw new WorkbookRefusedError(
          `This workbook has ${comments.toLocaleString('en-US')} comments or more; at most ${limits.maxComments.toLocaleString('en-US')} can be read. ` +
            'Delete the comments (in Excel: Review, Delete), save it and upload it again.',
        );
      }
    }
  }
  if (binaryWorkbook) {
    throw new WorkbookRefusedError('This is an Excel binary workbook (.xlsb), which cannot be read. Save it in Excel as .xlsx and upload that.');
  }
  if (!contentTypes) throw notExcel();
  const view = kept.length === parts ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : withCentralDirectory(b, kept);
  return { parts, unpackedBytes: unpacked, cells, linkCells, view };
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
 * The opening tag of a cell (SheetJS splits a row at /<(?:\w+:)?c[ \/>]/). A tag that closes
 * itself (<c r="B2" s="1"/>: a formatted empty cell, which Excel writes for borders and colours)
 * holds no value; it is not counted, so formatting alone never makes a workbook "too large".
 */
const CELL_TAG = /<(?:\w+:)?c(?:>| [^<>]*>)/g;
/** A comment or threaded comment (not <comments> or <commentList>). */
const COMMENT_TAG = /<(?:\w+:)?(?:threadedComment|comment)[ >/]/g;

/**
 * What one XML part makes SheetJS do beyond its size: `cells`, the cells with content in it (every
 * cell SheetJS reads a value from has an opening tag; rows past `sheetRows` are counted too),
 * `comments`, its comments (SheetJS checks every comment already on a cell before adding one, so
 * many on one cell take time growing with the square: 20,000 took 0.4 s, and 50 MB of them would
 * take minutes), and `links`, the cells its hyperlinks cover. SheetJS finds each <hyperlink ...>
 * tag of a worksheet with HLINK_TAG, reads its `ref` with parsexmltag (from the tag decoded as
 * UTF-8; namespace prefixes and "_..." suffixes dropped, any case) and makes a cell for every
 * address of the range (parse_ws_xml_hlinks). This reads every part that way, whether or not
 * SheetJS reads it as a worksheet, and every link, also those after one without `ref` (where
 * SheetJS stops).
 */
function scanXmlPart(d: Buffer): { cells: number; comments: number; links: number } {
  const utf16 = (d[0] === 0xff && d[1] === 0xfe) || (d[1] === 0xfe && d[2] === 0xff);
  const hasTags = utf16 || d.indexOf('<') >= 0;
  const hasLinks = utf16 || d.indexOf('hyperlink ') >= 0;
  if (!hasTags) return { cells: 0, comments: 0, links: 0 };
  // The tags' structure is ASCII, the same in the bytes read as latin1 (as SheetJS scans them)
  // and in the decoded text; only a matched link tag is decoded, as SheetJS does.
  const text = utf16 ? partText(d) : d.toString('latin1');
  let cells = 0;
  CELL_TAG.lastIndex = 0;
  while (CELL_TAG.exec(text)) if (text.charCodeAt(CELL_TAG.lastIndex - 2) !== 0x2f) cells++;
  let comments = 0;
  COMMENT_TAG.lastIndex = 0;
  while (COMMENT_TAG.exec(text)) comments++;
  let links = 0;
  if (hasLinks) {
    for (const tag of text.match(HLINK_TAG) ?? []) {
      const ref = hyperlinkRef(utf16 ? tag : Buffer.from(tag, 'latin1').toString('utf8'));
      if (!ref) continue;
      const range = safeDecodeRange(ref);
      links += rangeCells(range.s, range.e);
    }
  }
  return { cells, comments, links };
}

/** The `ref` SheetJS's parsexmltag(tag, true) gives a tag: the same key rules, the last value wins. */
function hyperlinkRef(tag: string): string | undefined {
  const z: Record<string, string> = {};
  let eq = 0;
  for (; eq !== tag.length; ++eq) {
    const c = tag.charCodeAt(eq);
    if (c === 32 || c === 10 || c === 13) break;
  }
  if (eq === tag.length) return undefined;
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
  return z.ref;
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
