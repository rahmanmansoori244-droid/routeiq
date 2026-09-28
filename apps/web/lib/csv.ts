import Papa from 'papaparse';
import * as XLSX from 'xlsx';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
const PARSE_TIMEOUT_MS = 10_000;

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
   * decimals shows "23.5850": for these columns that text is used when it is the same number with
   * more decimals. A cell showing fewer decimals than the number has keeps the number's own. Used for
   * the customer import's lat / lng, whose decimals decide whether a location is exact (audit PR A5).
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
    public readonly sheets: { name: string; rows: number }[],
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
function sheetList(sheets: { name: string; rows: number }[]): string {
  return sheets.map((s) => `"${s.name}" (${rowCount(s.rows)})`).join(', ');
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
    const arr = new Uint8Array(await file.arrayBuffer());
    const sheets = await withTimeout(
      Promise.resolve(parseExcelSheets(arr, { decimalTextColumns: opts.decimalTextColumns })),
      PARSE_TIMEOUT_MS,
      'XLSX parse timed out (possible zip bomb).',
    );
    const pick = pickSheet(sheets, opts);
    // The row limit is for the sheet that is read: a large sheet that is not read (a customer
    // list next to the orders) is only named in the warning, never a reason to refuse the file.
    if (pick.rows.length > MAX_ROWS) {
      throw new Error(`Too many rows: ${pick.rows.length}${sheets.length > 1 ? ` on sheet "${pick.name}"` : ''}. Max ${MAX_ROWS}.`);
    }
    return { fileName, fileType: 'xlsx', rows: pick.rows, warnings: pick.warnings, ...(pick.name ? { sheetName: pick.name } : {}) };
  }

  const warnings: string[] = [];
  const text = await file.text();
  const result = await withTimeout(parseCsv(text), PARSE_TIMEOUT_MS, 'CSV parse timed out.');
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
): { name: string | null; rows: Record<string, string>[]; warnings: string[] } {
  if (!sheets.length) return { name: null, rows: [], warnings: [] };
  // Only rows with a value count: a sheet whose rows are all blank cells (a template) holds no data.
  const dataRows = (s: ParsedSheet) => s.rows.filter((r) => Object.values(r).some((v) => v !== '')).length;
  const withData = sheets.filter((s) => dataRows(s) > 0);
  const pool = withData.length ? withData : sheets;
  const isData = opts.isDataSheet;
  const matching = isData ? pool.filter((s) => isData(Object.keys(s.rows[0] ?? {}))) : [];
  if (matching.length > 1) {
    throw new MultipleSheetsError(
      matching.map((s) => ({ name: s.name, rows: dataRows(s) })),
      opts.rowsWord,
    );
  }
  // No sheet with the expected columns: the first sheet with rows, whose check then names the
  // missing columns (as before).
  const chosen = matching[0] ?? pool[0];
  const others = pool.filter((s) => s !== chosen).map((s) => ({ name: s.name, rows: dataRows(s) }));
  const warnings: string[] = [];
  if (others.length) {
    warnings.push(
      matching.length === 1
        ? `Only sheet "${chosen.name}" was read. Other sheet(s) with rows but without the ${opts.rowsWord ? `${opts.rowsWord} ` : ''}columns were not read: ${sheetList(others)}.`
        : `Only sheet "${chosen.name}" was read. Other sheet(s) with rows were not read: ${sheetList(others)}. Upload each sheet as its own file if it is needed.`,
    );
  }
  return { name: chosen.name, rows: chosen.rows, warnings };
}

/** Every sheet of the workbook that has rows, in workbook order. */
export function parseExcelSheets(buffer: Uint8Array, opts: Pick<ParseOptions, 'decimalTextColumns'> = {}): ParsedSheet[] {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: false, cellNF: false });
  const decimalCols = new Set((opts.decimalTextColumns ?? []).map((c) => c.trim().toLowerCase()));
  const out: ParsedSheet[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    // raw: true keeps real numbers (no "1,234" display strings) and returns date cells as
    // Excel serials, which the order intake converts; display text would depend on locale.
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true });
    if (decimalCols.size && rows.length) {
      // The same rows as shown (the same blank-row rule, so row i is row i).
      const shown = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
      rows.forEach((r, i) => {
        for (const k of Object.keys(r)) {
          if (decimalCols.has(k.trim().toLowerCase())) r[k] = withShownDecimals(r[k], shown[i]?.[k]);
        }
      });
    }
    if (rows.length) out.push({ name: sheetName, rows: rows.map((r) => normalizeKeys(r)) });
  }
  return out;
}

/**
 * A number cell as the text it shows when that text is the same number with more decimals (trailing
 * zeros: 23.585 shown as "23.5850"); else the number itself (a cell showing fewer decimals than the
 * number has, a date, text).
 */
export function withShownDecimals(value: unknown, shown: unknown): unknown {
  if (typeof value !== 'number' || typeof shown !== 'string') return value;
  const t = shown.trim();
  if (!/^[-+]?\d+\.\d+$/.test(t) || Number(t) !== value) return value;
  const places = (x: string) => (x.includes('.') ? x.length - x.indexOf('.') - 1 : 0);
  return places(t) > places(String(value)) ? t : value;
}

function parseCsv(text: string): Promise<{ rows: Record<string, string>[]; errors: Papa.ParseError[] }> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim().toLowerCase(),
      complete: (res) => resolve({ rows: res.data.map(normalizeKeys), errors: res.errors }),
      error: (err: Error) => reject(err),
    });
  });
}

function normalizeKeys(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.trim().toLowerCase();
    out[key] = v == null ? '' : String(v).trim();
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}
