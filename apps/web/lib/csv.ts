import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { checkWorkbookZip, isZipFile, WorkbookRefusedError } from './workbook-guard';

/**
 * Upload limits (owner decision 16, audit E2): 10 MB per file and 50,000 rows on the sheet that is
 * read, as before; a workbook may unpack to at most 50 MB and have at most 10 sheets.
 *
 * What these limits do and do not do. The file is parsed in the web process, on the event loop,
 * synchronously: while a file is parsed no other request is answered, and nothing can stop the
 * parse once it has started. (Until 27 Sep 2026 a 10 s "parse timeout" was armed here. It could
 * never fire: its timer can only run after the parse has finished. It is gone.) The limits bound
 * how much work one upload can cause - a workbook is measured and refused before any sheet is
 * read, and at most READ_ROWS rows of each sheet are turned into cells - but they do not isolate
 * it. Parsing in a worker thread with a memory cap and a timeout that really stops it is audit
 * PR 5.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 50_000;
/** Total size of all parts of an .xlsx once unpacked, measured by unpacking (lib/workbook-guard). */
export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
export const MAX_SHEETS = 10;
/** Parts (files inside the .xlsx zip); a real workbook has well under 100. */
export const MAX_ZIP_PARTS = 1_000;
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
    const sheets = parseExcelSheets(new Uint8Array(await file.arrayBuffer()));
    const pick = pickSheet(sheets, opts);
    // The row limit is for the sheet that is read: a large sheet that is not read (a customer
    // list next to the orders) is only named in the warning, never a reason to refuse the file.
    const where = sheets.length > 1 ? ` on sheet "${pick.name}"` : '';
    if (pick.truncated) throw tooManyRowsCut(pick.rows.length, where, 'sheet');
    if (pick.rows.length > MAX_ROWS) {
      throw new Error(`Too many rows: ${pick.rows.length}${where}. Max ${MAX_ROWS}.`);
    }
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
  // data. A sheet that goes on past READ_ROWS counts as holding data, whatever its first rows are.
  const dataRows = (s: ParsedSheet) => s.rows.filter((r) => Object.values(r).some((v) => v !== '')).length;
  const withData = sheets.filter((s) => s.truncated || dataRows(s) > 0);
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
 * rows. Before any sheet is read it refuses (WorkbookRefusedError) a workbook that unpacks to more
 * than MAX_UNPACKED_BYTES, has more than MAX_ZIP_PARTS parts or has more than MAX_SHEETS sheets.
 */
export function parseExcelSheets(bytes: Uint8Array): ParsedSheet[] {
  if (isZipFile(bytes)) checkWorkbookZip(bytes, { maxUnpackedBytes: MAX_UNPACKED_BYTES, maxParts: MAX_ZIP_PARTS });
  // A Buffer view of the same bytes (nothing is copied). Given a Uint8Array, SheetJS copies the
  // rest of the file for every part it unpacks (5,000 small parts took 8 s); given a Buffer it
  // takes views.
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The sheet count comes from the workbook's list of sheets alone; no sheet is read in this pass.
  const names = XLSX.read(buf, { type: 'buffer', bookSheets: true, sheetRows: READ_ROWS }).SheetNames ?? [];
  if (names.length > MAX_SHEETS) {
    throw new WorkbookRefusedError(
      `This workbook has ${names.length} sheets; at most ${MAX_SHEETS} can be read. Save only the sheet you need as a new workbook or as CSV and upload that.`,
    );
  }
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellNF: false, sheetRows: READ_ROWS });
  const out: ParsedSheet[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    // raw: true keeps real numbers (no "1,234" display strings) and returns date cells as
    // Excel serials, which the order intake converts; display text would depend on locale.
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true });
    const truncated = goesPastReadRows(sheet);
    if (rows.length || truncated) {
      out.push({ name: sheetName, rows: rows.map((r) => normalizeKeys(r)), ...(truncated ? { truncated: true } : {}) });
    }
  }
  return out;
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
