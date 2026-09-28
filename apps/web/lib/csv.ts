import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { guardSpreadsheet, safeDecodeRange, sameSheetList, sheetjsReader, WorkbookRefusedError } from './workbook-guard';

/**
 * Upload limits (owner decision 16, audit E2): 10 MB per file and 50,000 rows on the sheet that is
 * read, as before; a workbook may unpack to at most 50 MB and have at most 10 sheets. The A1
 * review added caps that NMWC's real files (about 15 columns, a few thousand rows) are far from:
 * 200 columns per sheet, 2,500,000 cells (for example 50,000 rows of 50 columns), links over
 * 200,000 cells, 10,000 comments; the A1 v3 review 1,000 metadata entries of each kind and 1,000
 * comment authors. An upload read as Excel must be an .xlsx, an old .xls or CSV text; web pages,
 * XML, OpenDocument, .xlsb and other formats are refused (lib/workbook-guard). Since the A1 v4
 * review a part SheetJS reads more than once (for another sheet, another spelling of its name, an
 * external link listed again) counts again against these caps, two sheets that read one worksheet
 * part are refused, and so is a workbook with a chart, dialog or macro sheet.
 *
 * What these limits do and do not do. The file is parsed in the web process, on the event loop,
 * synchronously: while a file is parsed no other request is answered, and nothing can stop the
 * parse once it has started. (Until 27 Sep 2026 a 10 s "parse timeout" was armed here. It could
 * never fire: its timer can only run after the parse has finished. It is gone.) The limits bound
 * how much work one upload can cause - a file is checked (lib/workbook-guard) before SheetJS reads
 * it, at most READ_ROWS rows of each sheet are turned into cells, and the ranges are checked before
 * any sheet is turned into rows - but they do not isolate it, and a file just under them still
 * blocks the app for seconds. Measured on the maintainer's machine (times vary by about a third
 * from run to run): an .xlsx of 50,000 rows x 49 columns (0.19 MB, 37 MB unpacked) 9-10 s and
 * 1 GB of memory (before A1 v4, ten sheets naming that one part took ten times as long); the same rows as CSV sent as Excel 7-11 s and 1.2 GB; ten sheets of 50,000 rows
 * 5-6 s; NMWC's shape at the row limit (50,000 rows x 15 columns) about 2.5 s. Parsing in a worker
 * thread with a memory cap and a timeout that really stops it is audit PR 5.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 50_000;
/** Total size of all parts of an .xlsx once unpacked, measured by unpacking (lib/workbook-guard). */
export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
export const MAX_SHEETS = 10;
/** Parts (files inside the .xlsx zip); a real workbook has well under 100. */
export const MAX_ZIP_PARTS = 1_000;
/** Columns of one sheet (from the first to the last column holding a cell); NMWC's files have about 15. */
export const MAX_COLS = 200;
/** Cells (rows x columns) of all sheets' ranges together: e.g. 50,000 rows of 50 columns. */
export const MAX_CELLS = 2_500_000;
/** Cells all hyperlinks together may cover; SheetJS makes a cell object for each. */
export const MAX_LINK_CELLS = 200_000;
/** Comments (notes) in a workbook; SheetJS's time for many on one cell grows with the square. */
export const MAX_COMMENTS = 10_000;
/**
 * Cell-metadata types and future-metadata blocks (each) in a workbook: SheetJS compares every
 * block with every type. Excel writes one or two (dynamic arrays, rich values).
 */
export const MAX_METADATA = 1_000;
/**
 * People in the threaded comments' person list (the people who wrote them): SheetJS looks up each
 * threaded comment's author in the whole list, so with MAX_COMMENTS comments the lookups stay
 * under 10^7 (10,000 x 10,000 took 0.5 s).
 */
export const MAX_PEOPLE = 1_000;
/**
 * Rows read from each sheet (and from a CSV): the row limit plus room for a header, title rows and
 * one row over the limit. Rows below are never read; a sheet that goes on past them is refused
 * when it is the sheet that is read (see parseUpload), never cut short without a word.
 */
export const READ_ROWS = MAX_ROWS + 100;

const ALLOWED_TYPES = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface ParsedFile {
  fileName: string;
  fileType: string;
  rows: Record<string, string>[];
  warnings: string[];
  /** Excel: the sheet the rows were read from. */
  sheetName?: string;
}

/** One non-empty sheet of a workbook: its name and its rows (keys = the sheet's header row). */
export interface ParsedSheet {
  name: string;
  rows: Record<string, string>[];
  /** The sheet goes on past READ_ROWS: `rows` are only its first rows. */
  truncated?: boolean;
}

export interface ParseOptions {
  /**
   * Which sheets of a workbook hold the rows this upload is for, judged by their header row (e.g.
   * the order columns). Given: a workbook with such rows on more than one sheet is refused
   * (MultipleSheetsError) - it is never cut to one sheet without a word - and the one sheet that
   * has them is read wherever it is in the workbook. Not given: the first sheet with rows.
   */
  isDataSheet?: (headers: string[]) => boolean;
  /** What the rows are, for messages: "order" -> "order rows". */
  rowsWord?: string;
  /**
   * Excel: columns (header names, any case) whose number cells keep the decimals the cell shows. A
   * number holds no trailing zeros (23.5850 is the number 23.585), but a cell formatted to show 4
   * decimals shows "23.5850": for these columns a number format that shows more decimals than the
   * number has adds ONE zero (A5 fourth review: 23.585 shown as 23.5850 counts 4 decimals, but 23.58
   * shown as 23.5800 counts 3, not 4 - the padding is not precision). A cell showing fewer decimals
   * than the number has keeps the number's own. Used for the customer import's lat / lng, whose
   * decimals decide whether a location is exact (audit PR A5). CSV text sent as Excel: the text in
   * the file, as a CSV upload reads it. Only the sheet that is read, and in it the one column per
   * name the rows keep, are looked at; each number format is tried once per upload, at most
   * MAX_SHOWN_FORMATS of them (see shownSources and ShownFormats).
   */
  decimalTextColumns?: string[];
}

/**
 * A workbook with the rows of this upload on more than one sheet (scenario test S04: Orders +
 * LateOrder). Nothing is read: each sheet must be uploaded as its own file, so each is checked
 * (and, for late orders, confirmed with its reason) on its own.
 */
export class MultipleSheetsError extends Error {
  readonly code = 'MULTIPLE_SHEETS';
  constructor(
    public readonly sheets: { name: string; rows: number; truncated?: boolean }[],
    rowsWord = '',
  ) {
    const what = rowsWord ? `${rowsWord} rows` : 'rows with these columns';
    super(
      `This workbook has ${what} on ${sheets.length} sheets: ${sheetList(sheets)}. Nothing was read. ` +
        'Upload each sheet as its own file (save it as a separate workbook or CSV), so each one is checked and confirmed on its own.',
    );
    this.name = 'MultipleSheetsError';
  }
}

const rowCount = (n: number) => `${n.toLocaleString('en-US')} row${n === 1 ? '' : 's'}`;
function sheetList(sheets: { name: string; rows: number; truncated?: boolean }[]): string {
  // A sheet that goes on past READ_ROWS was not read to its end: its count is a floor.
  return sheets.map((s) => `"${s.name}" (${rowCount(s.rows)}${s.truncated ? ' or more' : ''})`).join(', ');
}

/** Refusal of a sheet (or CSV) that goes on past READ_ROWS; `rows` = the data rows read. */
function tooManyRowsCut(rows: number, where: string, what: 'sheet' | 'file'): Error {
  if (rows > MAX_ROWS) return new Error(`Too many rows: more than ${MAX_ROWS}${where}. Max ${MAX_ROWS}.`);
  return new Error(
    `Too many rows${where}: the ${what} goes on past row ${READ_ROWS.toLocaleString('en-US')}, and at most ${MAX_ROWS} rows are read. ` +
      'If the rows below your data are empty, delete them and upload again.',
  );
}

export async function parseUpload(file: File, opts: ParseOptions = {}): Promise<ParsedFile> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
  }
  if (file.type && !ALLOWED_TYPES.has(file.type)) {
    throw new Error(`Unsupported file type: ${file.type}. Use CSV or XLSX.`);
  }

  const fileName = sanitizeFileName(file.name);
  const isExcel =
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.type === 'application/vnd.ms-excel' ||
    /\.xlsx?$/i.test(file.name);

  if (isExcel) {
    const { sheets, showDecimals } = readWorkbook(new Uint8Array(await file.arrayBuffer()), opts.decimalTextColumns);
    const pick = pickSheet(sheets, opts);
    // The row limit is for the sheet that is read: a large sheet that is not read (a customer
    // list next to the orders) is only named in the warning, never a reason to refuse the file.
    const where = sheets.length > 1 ? ` on sheet "${pick.name}"` : '';
    if (pick.truncated) throw tooManyRowsCut(pick.rows.length, where, 'sheet');
    if (pick.rows.length > MAX_ROWS) {
      throw new Error(`Too many rows: ${pick.rows.length}${where}. Max ${MAX_ROWS}.`);
    }
    // The decimals the decimal columns' cells show, on the sheet that is read only (A5 fourth
    // review: every sheet's were worked out, also those of the sheets that are not read).
    const chosen = sheets.find((s) => s.rows === pick.rows);
    if (chosen) showDecimals(chosen);
    return { fileName, fileType: 'xlsx', rows: pick.rows, warnings: pick.warnings, ...(pick.name ? { sheetName: pick.name } : {}) };
  }

  const warnings: string[] = [];
  const text = await file.text();
  const result = parseCsv(text);
  if (result.truncated) throw tooManyRowsCut(result.rows.length, '', 'file');
  if (result.rows.length > MAX_ROWS) {
    throw new Error(`Too many rows: ${result.rows.length}. Max ${MAX_ROWS}.`);
  }
  if (result.errors.length) {
    for (const e of result.errors.slice(0, 5)) {
      warnings.push(`CSV parse warning at row ${e.row}: ${e.message}`);
    }
  }
  return { fileName, fileType: 'csv', rows: result.rows, warnings };
}

/**
 * The sheet to read from a workbook's non-empty sheets (see ParseOptions.isDataSheet). Throws
 * MultipleSheetsError when more than one sheet holds the rows; every other non-empty sheet that
 * is not read is named in a warning, so nothing is left out without a word.
 */
export function pickSheet(
  sheets: ParsedSheet[],
  opts: ParseOptions = {},
): { name: string | null; rows: Record<string, string>[]; warnings: string[]; truncated: boolean } {
  if (!sheets.length) return { name: null, rows: [], warnings: [], truncated: false };
  // Only rows with a value count: a sheet whose rows are all blank cells (a template) holds no
  // data, also when it goes on past READ_ROWS (A1 review: a cut sheet counted as data whatever
  // its first rows were, so a blank formatted first sheet was chosen over the data sheet).
  const dataRows = (s: ParsedSheet) => s.rows.filter((r) => Object.values(r).some((v) => v !== '')).length;
  const withData = sheets.filter((s) => dataRows(s) > 0);
  const pool = withData.length ? withData : sheets;
  const isData = opts.isDataSheet;
  const matching = isData ? pool.filter((s) => isData(Object.keys(s.rows[0] ?? {}))) : [];
  const summary = (s: ParsedSheet) => ({ name: s.name, rows: dataRows(s), ...(s.truncated ? { truncated: true } : {}) });
  if (matching.length > 1) {
    throw new MultipleSheetsError(matching.map(summary), opts.rowsWord);
  }
  // No sheet with the expected columns: the first sheet with rows, whose check then names the
  // missing columns (as before).
  const chosen = matching[0] ?? pool[0]!;
  const others = pool.filter((s) => s !== chosen).map(summary);
  const warnings: string[] = [];
  if (others.length) {
    warnings.push(
      matching.length === 1
        ? `Only sheet "${chosen.name}" was read. Other sheet(s) with rows but without the ${opts.rowsWord ? `${opts.rowsWord} ` : ''}columns were not read: ${sheetList(others)}.`
        : `Only sheet "${chosen.name}" was read. Other sheet(s) with rows were not read: ${sheetList(others)}. Upload each sheet as its own file if it is needed.`,
    );
  }
  return { name: chosen.name, rows: chosen.rows, warnings, truncated: !!chosen.truncated };
}

/**
 * Every sheet of the workbook that has rows, in workbook order, each read to at most READ_ROWS
 * rows. Before SheetJS reads the file it refuses (WorkbookRefusedError) a file that SheetJS would
 * read with a reader whose work cannot be bounded, a workbook that unpacks to more than
 * MAX_UNPACKED_BYTES, has more than MAX_ZIP_PARTS parts, MAX_CELLS cells with a type or a value,
 * MAX_COMMENTS comments, MAX_METADATA metadata entries of a kind or MAX_PEOPLE comment authors, or
 * links over more than MAX_LINK_CELLS cells, each part counted again for every further read, or a
 * chart, dialog or macro sheet (lib/workbook-guard), one with more than MAX_SHEETS sheets, and one
 * whose sheet list SheetJS reads otherwise than the guard. Before any sheet is turned into rows it
 * refuses a sheet wider than MAX_COLS and sheets that span more than MAX_CELLS cells.
 * The decimal columns (ParseOptions.decimalTextColumns) are parseUpload's alone: it works them out on
 * the sheet it reads only (readWorkbook).
 */
export function parseExcelSheets(bytes: Uint8Array): ParsedSheet[] {
  return readWorkbook(bytes).sheets;
}

/** What a decimal column's kept cells hold: a reference to each cell's number format, or a CSV cell's own text. */
type ShownMode = 'format' | 'text';

/**
 * parseExcelSheets, with the decimal columns (ParseOptions.decimalTextColumns): `showDecimals` puts
 * the decimals their number cells show into one sheet's rows. What a cell shows is kept while the
 * file is read (shownSources: a reference, nothing formatted); parseUpload calls `showDecimals` on
 * the sheet it reads, and on no other (A5 fourth review: every sheet's cells were formatted, also
 * those of the sheets that are not read).
 */
function readWorkbook(bytes: Uint8Array, decimalTextColumns: string[] = []): { sheets: ParsedSheet[]; showDecimals: (sheet: ParsedSheet) => void } {
  // A Buffer (a view of the upload, or with a zip's binary parts left out). Given a Uint8Array,
  // SheetJS copies the rest of the file for every part it unpacks (5,000 small parts took 8 s);
  // given a Buffer it takes views.
  const { view: buf, sheetNames } = guardSpreadsheet(bytes, {
    maxUnpackedBytes: MAX_UNPACKED_BYTES,
    maxParts: MAX_ZIP_PARTS,
    maxLinkCells: MAX_LINK_CELLS,
    maxCells: MAX_CELLS,
    maxComments: MAX_COMMENTS,
    maxMetadata: MAX_METADATA,
    maxPeople: MAX_PEOPLE,
    maxSheets: MAX_SHEETS,
  });
  // cellFormula: false. Formulas are not used (their saved values are), and with them SheetJS
  // compares every array-formula cell with every array formula before it: 20,000 such rows (a
  // 275 KB workbook) took 2.6 s, and the time grows with the square of the count.
  // cellText: false. The rows are read as raw values (sheet_to_json raw: true), never as display
  // text, but SheetJS would make the display text of every cell with a number format, parsing the
  // format again for each cell (safe_format, safe_format_xf): one 255-character format on 50,000
  // rows x 44 cells (a 162 KB file within every cap) ran the process out of memory at about 4 GB.
  // Header names still come from format_cell, which formats a header cell on its own (General
  // format for an .xlsx).
  const read = { type: 'buffer', sheetRows: READ_ROWS, cellFormula: false, cellText: false } as const;
  // The sheet count comes from the workbook's list of sheets alone; no sheet is read in this pass.
  const names = XLSX.read(buf, { ...read, bookSheets: true }).SheetNames ?? [];
  if (names.length > MAX_SHEETS) {
    throw new WorkbookRefusedError(
      `This workbook has ${names.length} sheets; at most ${MAX_SHEETS} can be read. Save only the sheet you need as a new workbook or as CSV and upload that.`,
    );
  }
  // The guard counted the parts these sheets read (lib/workbook-guard, sheetReads) for the sheet
  // list it read; SheetJS must have read the same list.
  sameSheetList(sheetNames, names);
  const decimalCols = new Set(decimalTextColumns.map((c) => c.trim().toLowerCase()));
  const shownRead = decimalCols.size ? shownTextRead(buf) : {};
  const mode: ShownMode | null = 'cellNF' in shownRead ? 'format' : 'cellText' in shownRead ? 'text' : null;
  const wb = XLSX.read(buf, { ...read, cellDates: false, cellNF: false, ...shownRead });
  const out: ParsedSheet[] = [];
  const shownOf = new Map<ParsedSheet, { columns: ShownColumn[]; rowNums: (number | undefined)[] }>();
  for (const { name, sheet, range, clamped } of sheetRanges(wb)) {
    // Where the decimal columns' number cells are and what they show (nothing is formatted), taken
    // before the sheet is turned into rows, which are then read exactly as without these columns.
    const columns = mode ? shownSources(sheet, range, decimalCols, mode) : [];
    // raw: true keeps real numbers (no "1,234" display strings) and returns date cells as
    // Excel serials, which the order intake converts; display text would depend on locale.
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true, ...(clamped ? { range } : {}) });
    const truncated = goesPastReadRows(sheet);
    // A sheet with no row that holds a value in its first READ_ROWS rows is empty, even when its
    // range goes on past them (formatting only): it is not a sheet with data, not read and not
    // named. (Before the A1 review it was kept as "cut", so a blank formatted first sheet was
    // read instead of the data sheet and refused with "Too many rows".)
    if (rows.length) {
      const parsed: ParsedSheet = { name, rows: rows.map((r) => normalizeKeys(r)), ...(truncated ? { truncated: true } : {}) };
      out.push(parsed);
      // sheet_to_json gives each row the sheet row it was read from (not enumerable).
      if (columns.length) shownOf.set(parsed, { columns, rowNums: rows.map((r) => (r as { __rowNum__?: number }).__rowNum__) });
    }
  }
  const formats = new ShownFormats();
  const showDecimals = (sheet: ParsedSheet) => {
    const shown = shownOf.get(sheet);
    if (!shown) return;
    shownOf.delete(sheet);
    sheet.rows.forEach((row, i) => {
      const at = shown.rowNums[i];
      if (at === undefined) return;
      for (const { name, byRow } of shown.columns) {
        const source = byRow.get(at);
        const had = row[name];
        if (source === undefined || had === undefined) continue;
        // The row holds the number cell's value as text (normalizeKeys), which reads back as it.
        const value = Number(had);
        if (String(value) !== had) continue;
        const kept = withShownDecimals(value, mode === 'text' ? source : formats.shown(source, value));
        if (typeof kept === 'string') row[name] = kept;
      }
    });
  };
  return { sheets: out, showDecimals };
}

/**
 * A number cell as the text it shows when that text is the same number with more decimals (trailing
 * zeros: 23.585 shown as "23.5850"); else the number itself (a cell showing fewer decimals than the
 * number has, a date, text). For a number format the text comes from ShownFormats (one zero more at
 * most); for CSV sent as Excel it is the text in the file.
 */
export function withShownDecimals(value: unknown, shown: unknown): unknown {
  if (typeof value !== 'number' || typeof shown !== 'string') return value;
  const t = shown.trim();
  if (!/^[-+]?\d+\.\d+$/.test(t) || Number(t) !== value) return value;
  return decimalPlaces(t) > decimalPlaces(String(value)) ? t : value;
}

const decimalPlaces = (x: string) => (x.includes('.') ? x.length - x.indexOf('.') - 1 : 0);

/**
 * Longest number format a decimal column's cell is read with; a cell with a longer one counts the
 * decimals its number has: a location that then has too few is not saved, and someone drops the
 * customer's pin on the map instead. Each format is tried once per upload (ShownFormats), so its
 * length no longer sets a cost per cell; the cap keeps that one try short.
 */
export const MAX_SHOWN_FORMAT = 64;

/**
 * Most different number formats tried in one upload's decimal columns (A5 fourth review). A real
 * customer file has one or two (a column in "0.0000", another in General); a cell in any further
 * format counts the decimals its number has (a location that then has too few is not saved).
 */
export const MAX_SHOWN_FORMATS = 20;

/**
 * The number formats met in one upload's decimal columns, each tried once (A5 fourth review: SheetJS
 * parses a format again for every cell it formats, and a 64-character format it cannot apply took
 * about 50 microseconds a cell, so 50,000 rows of lat / lng on ten sheets blocked the app for 40 s).
 * A format is tried on the number 1 (-1 for a negative number): when it shows "1.0000" (a sign, 1, a
 * point and zeros, padding trimmed) it shows 4 decimals, and a number with fewer is shown with
 * trailing zeros. Of those zeros ONE counts: 23.585 in a cell formatted 0.0000 reads "23.5850" (the
 * number cannot tell 23.5850 from 23.585, and 1 in 10 real 4-decimal coordinates ends in 0), but
 * 23.58 reads "23.580", never "23.5800" - padding is not precision, and a rough point formatted to
 * show 4 decimals stays not exact. Anything else (a date, a percentage, text around the number, a
 * scale, a condition, a format SheetJS cannot apply) adds nothing: the number's own decimals count.
 * At most MAX_SHOWN_FORMATS formats are tried in one upload.
 */
class ShownFormats {
  private readonly positive = new Map<string, number | null>();
  private readonly negative = new Map<string, number | null>();
  private tried = 0;

  /** The text a number cell in format `z` counts as (see above); undefined when it adds nothing. */
  shown(z: string, value: number): string | undefined {
    if (!Number.isFinite(value) || value === 0) return undefined;
    const cache = value < 0 ? this.negative : this.positive;
    let zeros = cache.get(z);
    if (zeros === undefined) {
      zeros = null;
      if (this.tried < MAX_SHOWN_FORMATS) {
        this.tried += 1;
        zeros = zerosShown(z, value < 0 ? -1 : 1);
      }
      cache.set(z, zeros);
    }
    if (!zeros) return undefined;
    const own = String(value);
    if (/e/i.test(own)) return undefined;
    const places = decimalPlaces(own);
    return zeros > places ? `${own}${places ? '' : '.'}0` : undefined;
  }
}

/** How many decimals format `z` always shows (the zeros it shows 1 or -1 with), or null when it is not a plain number format. */
function zerosShown(z: string, probe: 1 | -1): number | null {
  // A format with a condition ("[>=100]0.00;0.0000") shows numbers differently by their size.
  if (/\[\s*[<>=]/.test(z)) return null;
  let text: string;
  try {
    text = String(XLSX.SSF.format(z, probe)).trim();
  } catch {
    return null; // a format SheetJS cannot apply
  }
  const m = /^([-+]?)1(?:\.(0+))?$/.exec(text);
  if (!m || (m[1] === '-') !== (probe < 0)) return null;
  return m[2]?.length ?? 0;
}

/**
 * The read options that keep what the decimal columns' cells show (ParseOptions.decimalTextColumns)
 * on top of the read above; shownSources takes it off every cell again before the rows are read,
 * so the rows are read exactly as without them. An .xlsx or .xls: cellNF, each cell keeps its
 * number format (a reference; cellText stays false and nothing is formatted while the file is
 * read). Text read as CSV: cellText, each cell keeps its own text, which SheetJS's CSV reader has
 * anyway and formats nothing to make (Chrome and Edge send a .csv as application/vnd.ms-excel on a
 * PC with Excel installed, so a CSV that Excel saved with "23.5850" comes this way). Not for text
 * whose first record SheetJS's SYLK reader reads as "ID" before it falls back to CSV: that reader
 * formats cells as it goes, however far it gets; such a file counts the numbers' own decimals.
 */
function shownTextRead(buf: Buffer): { cellNF: true } | { cellText: true } | Record<string, never> {
  const reader = sheetjsReader(buf);
  if (reader !== 'text' && reader !== 'text-ws' && reader !== 'text-utf16') return { cellNF: true };
  if (buf[0] === 0x49 && buf[1] === 0x44) {
    // sylk_to_aoa_str: the first line, trimmed, up to its first ";" is the record type.
    const rest = buf.toString('latin1', 2, Math.min(buf.length, 4_096)).split(/[\r\n]/)[0]!;
    if (rest.trim() === '' || rest[0] === ';' || rest[0] === '\x1b') return {};
  }
  return { cellText: true };
}

/** A decimal column of a sheet: its name in the rows, and what its number cells show (format or text) by sheet row. */
interface ShownColumn {
  name: string;
  byRow: Map<number, string>;
}

/** A number format worth trying on a decimal column's cell: not General (it never shows more decimals than the number has), at most MAX_SHOWN_FORMAT characters. */
const formatToTry = (z: string) => z.length <= MAX_SHOWN_FORMAT && z !== 'General' && !/^general$/i.test(z);

/**
 * The decimal columns of a sheet (ParseOptions.decimalTextColumns) and what their number cells show:
 * a CSV cell its own text, any other a reference to its number format (formatToTry); nothing is
 * formatted here. A column is matched on the key sheet_to_json gives it, trimmed and in any case,
 * and of the columns that match one name only the LAST is kept: normalizeKeys folds "lat", "LAT"
 * and "lat " into one "lat", which holds the last one's value (A5 fourth review: all of them were
 * formatted). Then every cell's number format and text are taken off, so sheet_to_json reads the
 * sheet exactly as it does without these columns (A1: headers named as before, no date format
 * applied to a number, no other cell formatted).
 */
function shownSources(sheet: XLSX.WorkSheet, range: XLSX.Range, decimalCols: Set<string>, mode: ShownMode): ShownColumn[] {
  const cellAt = (r: number, c: number) => sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  const bare = (cell: XLSX.CellObject) => {
    if (cell.z !== undefined) cell.z = undefined;
    if (cell.w !== undefined) cell.w = undefined;
  };
  const top = range.s.r;
  // The header keys as sheet_to_json makes them: the header cell as text ("__EMPTY" when there is
  // none); a name met before gets "_1", "_2", ...
  const seen: Record<string, number> = {};
  const lastColumn = new Map<string, number>();
  for (let c = range.s.c; c <= range.e.c; ++c) {
    const head = cellAt(top, c);
    if (head) bare(head);
    const name = head ? XLSX.utils.format_cell(head) : '__EMPTY';
    let key = name;
    let n = seen[name] || 0;
    if (!n) seen[name] = 1;
    else {
      do key = `${name}_${n++}`;
      while (seen[key]);
      seen[name] = n;
      seen[key] = 1;
    }
    const folded = key.trim().toLowerCase();
    if (decimalCols.has(folded)) lastColumn.set(folded, c);
  }
  const out: ShownColumn[] = [];
  for (const [name, c] of lastColumn) {
    const byRow = new Map<number, string>();
    for (let r = top + 1; r <= range.e.r; ++r) {
      const cell = cellAt(r, c);
      if (cell?.t !== 'n') continue;
      const source = mode === 'text' ? cell.w : cell.z;
      if (typeof source === 'string' && (mode === 'text' || formatToTry(source))) byRow.set(r, source);
    }
    if (byRow.size) out.push({ name, byRow });
  }
  for (const k of Object.keys(sheet)) if (!k.startsWith('!')) bare(sheet[k] as XLSX.CellObject);
  return out;
}

/**
 * The range sheet_to_json walks on each sheet, checked before any sheet is turned into rows. It
 * visits every cell of the range, rows x columns, and gives every row a key for every column,
 * whether or not a cell is there, so the range - not the file - sets the work: a 1.6 KB workbook
 * whose size record says A1:XFD2000 took 28 s, and one with a single header cell in column XFD
 * and 2,000 rows ran out of memory.
 *
 * A range can claim more than the sheet's cells (a size record, formatting, a link's empty cell).
 * When it is wider than MAX_COLS, or the ranges add up to more than MAX_CELLS, it is cut to the
 * last row and column that hold a cell: no value is dropped, only empty trailing columns
 * ("__EMPTY" keys) and blank rows. Within the caps a range is walked as it is, as before. What is
 * still over is refused, naming the sheet.
 */
function sheetRanges(wb: XLSX.WorkBook): { name: string; sheet: XLSX.WorkSheet; range: XLSX.Range; clamped: boolean }[] {
  const plan = wb.SheetNames.flatMap((name) => {
    const sheet = wb.Sheets[name];
    const ref = sheet?.['!ref'];
    // sheet_to_json decodes "!ref" with safe_decode_range, and so does this.
    return sheet && ref ? [{ name, sheet, range: safeDecodeRange(ref), clamped: false }] : [];
  });
  const width = (r: XLSX.Range) => Math.max(0, r.e.c - r.s.c + 1);
  const cells = (r: XLSX.Range) => width(r) * Math.max(0, r.e.r - r.s.r + 1);
  const total = () => plan.reduce((n, p) => n + cells(p.range), 0);
  const clamp = (p: (typeof plan)[number]) => {
    if (p.clamped) return;
    p.range = toLastCell(p.sheet, p.range);
    p.clamped = true;
  };
  for (const p of plan) if (width(p.range) > MAX_COLS || cells(p.range) > MAX_CELLS) clamp(p);
  const wide = plan.find((p) => width(p.range) > MAX_COLS);
  if (wide) {
    throw new WorkbookRefusedError(
      `Sheet "${wide.name}" has ${width(wide.range).toLocaleString('en-US')} columns; at most ${MAX_COLS} can be read. ` +
        'Delete the columns you do not need, or save only the sheet you need as a new workbook or as CSV, and upload that.',
    );
  }
  if (total() > MAX_CELLS) plan.forEach(clamp);
  const n = total();
  if (n > MAX_CELLS) {
    throw new WorkbookRefusedError(
      `This workbook is too large to read: its sheets span ${n.toLocaleString('en-US')} cells (rows x columns); at most ${MAX_CELLS.toLocaleString('en-US')} can be read. Save only the sheet you need as a new workbook or as CSV and upload that.`,
    );
  }
  return plan;
}

/** `range` with its end moved back to the last row and the last column that hold a cell. */
function toLastCell(sheet: XLSX.WorkSheet, range: XLSX.Range): XLSX.Range {
  let row = -1;
  let col = -1;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue; // "!ref", "!merges", ...
    const at = XLSX.utils.decode_cell(key);
    if (at.r > row) row = at.r;
    if (at.c > col) col = at.c;
  }
  return { s: range.s, e: { r: Math.min(range.e.r, row), c: Math.min(range.e.c, col) } };
}

/**
 * Whether a sheet read with sheetRows goes on past READ_ROWS. When SheetJS cuts a sheet it keeps
 * the sheet's own range in "!fullref"; a sheet without a range record ends where the rows it read
 * end, so one that reaches the last row read may go on as well. Both count as cut.
 */
function goesPastReadRows(sheet: XLSX.WorkSheet): boolean {
  const ref = (sheet['!fullref'] as string | undefined) ?? sheet['!ref'];
  if (!ref) return false;
  return XLSX.utils.decode_range(ref).e.r >= READ_ROWS - 1;
}

function parseCsv(text: string): { rows: Record<string, string>[]; errors: Papa.ParseError[]; truncated: boolean } {
  // Synchronous: Papa parses a string in one go. `preview` stops it after READ_ROWS rows (empty
  // lines count towards it); meta.truncated says that it stopped there.
  const res = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    preview: READ_ROWS,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  return { rows: res.data.map(normalizeKeys), errors: res.errors, truncated: !!res.meta.truncated };
}

function normalizeKeys(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.trim().toLowerCase();
    out[key] = v == null ? '' : String(v).trim();
  }
  return out;
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}
