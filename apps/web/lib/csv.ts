import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { MultipleSheetsError, sheetList } from './upload-errors';
import { fileRefusal, MAX_CELLS, MAX_COLS } from './upload-limits';
import {
  guardSpreadsheet,
  idFileFormatsCells,
  notExcel,
  safeDecodeRange,
  sameSheetList,
  sheetjsReader,
  tooManyTextCells,
  webPageOrXml,
  WorkbookRefusedError,
} from './workbook-guard';

// Kept here as well, so `@/lib/csv` still has them (one class: `instanceof` holds either way).
export { MultipleSheetsError } from './upload-errors';
export { MAX_FILE_BYTES } from './upload-limits';

/**
 * Upload limits (owner decision 16, audit E2): 10 MB per file and 50,000 rows on the sheet that is
 * read, as before; a workbook may unpack to at most 50 MB and have at most 10 sheets. The A1
 * review added caps that NMWC's real files (about 15 columns, a few thousand rows) are far from:
 * 200 columns per sheet, 2,500,000 cells (for example 50,000 rows of 49 columns), links over
 * 200,000 cells, 10,000 comments; the A1 v3 review 1,000 metadata entries of each kind and 1,000
 * comment authors. Since the P5 second review a CSV sent as text (read by Papa Parse, not SheetJS)
 * has the column and cell caps too (parseCsv, checkCsvCells); since the review of 8 Oct 2026 every
 * CSV is read so, also one the browser sends as Excel (parseUpload). An upload read as Excel must be
 * an .xlsx or an old .xls; web pages, XML, OpenDocument, .xlsb and other formats are refused
 * (lib/workbook-guard), and so is CSV text that is a web page or binary content. Since the A1 v4
 * review a part SheetJS reads more than once (for another sheet, another spelling of its name, an
 * external link listed again) counts again against these caps, two sheets that read one worksheet
 * part are refused, and so is a workbook with a chart, dialog or macro sheet.
 *
 * What these limits do and do not do. They bound how much work one upload can cause - a file is
 * checked (lib/workbook-guard) before SheetJS reads it, at most READ_ROWS rows of each sheet are
 * turned into cells, and the ranges are checked before any sheet is turned into rows - but a file
 * just under them still takes seconds and up to about 1 GB. Measured on the maintainer's machine
 * when this ran in the web process (A1; times vary by about a third from run to run): an .xlsx of
 * 50,000 rows x 49 columns (0.19 MB, 37 MB unpacked) 9-10 s and 1 GB of memory; the same rows as
 * CSV sent as Excel 7-11 s and 1.2 GB; ten sheets of 50,000 rows 5-6 s; NMWC's shape at the row
 * limit (50,000 rows x 15 columns) about 2.5 s. So since audit P5 this code never runs in the web
 * process for an upload: the routes call parseUploadIsolated (lib/upload-parse), which runs
 * parseUpload in a separate, short-lived process with a memory cap and a time limit that really
 * stop it (the process is killed), while the web process keeps answering. parseUpload itself is
 * unchanged by P5 (the P5 second review added the CSV caps): synchronous once the file is in
 * memory, and nothing inside it can stop it.
 */
export const MAX_ROWS = 50_000;
/** Total size of all parts of an .xlsx once unpacked, measured by unpacking (lib/workbook-guard). */
export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
export const MAX_SHEETS = 10;
/** Parts (files inside the .xlsx zip); a real workbook has well under 100. */
export const MAX_ZIP_PARTS = 1_000;
/**
 * Columns of one sheet or CSV line (200), and cells of all sheets or CSV lines together (2,500,000):
 * in lib/upload-limits, which the web process checks the parser's answer against too.
 */
export { MAX_CELLS, MAX_COLS };
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
   * decimals shows "23.5850": for these columns a cell whose number format shows more decimals than
   * the number has reads as the text it shows ("23.5850"; 23.58 in the same format "23.5800"). A
   * cell showing fewer decimals than the number has keeps the number's own. Used for the customer
   * import's lat / lng, whose decimals decide whether a location is exact (audit PR A5); the import
   * counts one zero at the end at most, whatever the file (A5 fifth review, `countedText` in
   * lib/dispatch/location-input: 23.5800 is 3 decimals - the padding is not precision). CSV text,
   * also a CSV sent as Excel: the text in the file, as it is written. Only the sheet that is read,
   * and in it the one column per name the rows keep, are looked at; each number format is tried
   * once per upload, at most MAX_SHOWN_FORMATS of them (see shownSources and ShownFormats).
   */
  decimalTextColumns?: string[];
}

/** Refusal of a sheet (or CSV) that goes on past READ_ROWS; `rows` = the data rows read. */
function tooManyRowsCut(rows: number, where: string, what: 'sheet' | 'file'): Error {
  if (rows > MAX_ROWS) return new Error(`Too many rows: more than ${MAX_ROWS}${where}. Max ${MAX_ROWS}.`);
  return new Error(
    `Too many rows${where}: the ${what} goes on past row ${READ_ROWS.toLocaleString('en-US')}, and at most ${MAX_ROWS} rows are read. ` +
      'If the rows below your data are empty, delete them and upload again.',
  );
}

/**
 * Reads an uploaded file. Synchronous once the file is in memory: an upload route never calls it
 * itself but through parseUploadIsolated (lib/upload-parse), which runs it in the parser process.
 *
 * The reader is chosen by the file's content, never by the type the browser sends (review of
 * 8 Oct 2026, web-intake-1): Chrome and Edge on a Windows PC with Excel send every .csv as
 * application/vnd.ms-excel, and SheetJS's CSV reader guesses each value's type, so "11/10/2026"
 * became 10 Nov (month first, before the company's date order was ever applied), "00123" became
 * 123 and the item "1-2" a date serial. A real .xlsx or .xls (zip or compound-file bytes, or an old
 * bare BIFF stream) goes to SheetJS through the guard; every file that is text goes to Papa Parse,
 * which keeps every value as the text in the file, whatever the file was sent as.
 */
export async function parseUpload(file: File, opts: ParseOptions = {}): Promise<ParsedFile> {
  // Size and type (lib/upload-limits): the web process checks them too, before the file is sent.
  const refused = fileRefusal(file);
  if (refused) throw new Error(refused);

  const fileName = sanitizeFileName(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const reader = sheetjsReader(bytes);
  const text = reader === 'text' || reader === 'text-ws' || reader === 'text-utf16';
  // Neither a workbook nor text as SheetJS sees it (a web page, SYLK, DIF, an image ...): a file sent
  // as Excel is refused by the guard, with its words, as before; one sent as CSV (or as nothing) is
  // read as text as before, and refused below when it is not text.
  const sentAsExcel = file.type === XLSX_MIME || file.type === XLS_MIME || /\.xlsx?$/i.test(file.name);
  const workbook = reader === 'zip' || reader === 'cfb' || reader === 'biff' || (!text && sentAsExcel);

  if (workbook) {
    const { sheets, showDecimals } = readWorkbook(bytes, opts.decimalTextColumns);
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
    // A sheet name could carry a U+0000 too (an "_x0000_" escape): see normalizeKeys.
    return {
      fileName,
      fileType: 'xlsx',
      rows: pick.rows,
      warnings: pick.warnings.map(withoutNul),
      ...(pick.name ? { sheetName: withoutNul(pick.name) } : {}),
    };
  }

  const decoded = decodeCsvText(bytes);
  const warnings: string[] = [...decoded.warnings];
  const result = parseCsv(decoded.text);
  // A quote that is never closed takes every line after it into one value: the file read as a
  // few rows, the last one's note holding the rest of the file, and no error (review web-intake-2:
  // 390 of 400 orders never reached the day). Refused, naming the line; before the row limit, since
  // the rows Papa made of such a file mean nothing.
  const quote = result.errors.find((e) => e.type === 'Quotes');
  if (quote) throw unclosedQuote(lineOf(decoded.text, quote));
  if (result.truncated) throw tooManyRowsCut(result.rows.length, '', 'file');
  if (result.rows.length > MAX_ROWS) {
    throw new Error(`Too many rows: ${result.rows.length}. Max ${MAX_ROWS}.`);
  }
  // After the row limit, so a file refused for its rows is refused as before.
  checkCsvCells(result.rows, result.header);
  if (result.errors.length) {
    for (const e of result.errors.slice(0, 5)) {
      warnings.push(`CSV parse warning at row ${e.row}: ${e.message}`);
    }
  }
  return { fileName, fileType: 'csv', rows: result.rows.map(normalizeKeys), warnings };
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';

/** U+0000 taken out: PostgreSQL stores no U+0000 in a text or jsonb value (review s5-security-1). */
const withoutNul = (s: string) => (s.includes('\u0000') ? s.replace(/\u0000/g, '') : s);

/** The warning for a file read as windows-1256 (decodeCsvText). */
const READ_AS_ARABIC_WINDOWS =
  'This file is not saved as UTF-8, so its text was read as Arabic Windows text (Windows-1256). Check the names and notes; ' +
  'if they look wrong, save the file in Excel as "CSV UTF-8 (Comma delimited)" and upload that.';
/** Refusals of decodeCsvText: text that says it is UTF-16 and is not, and (a Node without windows-1256) text that is not UTF-8. */
const DAMAGED_UTF16 =
  'This file says it is UTF-16 text, but its text is damaged, so it cannot be read. Open it in Excel, save it as "CSV UTF-8 (Comma delimited)" and upload that.';
const NOT_UTF8 = 'This file is not saved as UTF-8, so it cannot be read. Open it in Excel, save it as "CSV UTF-8 (Comma delimited)" and upload that.';

/**
 * The text of a CSV file, decoded explicitly (review web-intake-3, s6-messy-intake-3). Before, the
 * bytes were decoded as UTF-8 with every byte that is not UTF-8 replaced by U+FFFD, and a CSV sent as
 * Excel was read by SheetJS as Latin-1: Arabic names and notes were stored garbled for good, with no
 * word. Now:
 *  - a UTF-16 byte-order mark (Excel's "Unicode Text"): UTF-16 of that byte order; text that is not
 *    UTF-16 after all (an odd number of bytes) is refused, never read with replacement characters;
 *  - otherwise (a UTF-8 mark taken off) strict UTF-8;
 *  - and when that fails, windows-1256, what Excel's "CSV (Comma delimited)" writes on a PC set to
 *    Arabic, which maps every byte: read, with a warning that says so (READ_AS_ARABIC_WINDOWS).
 * U+0000 is taken out of the text (withoutNul): UTF-16 text without its mark then reads as its
 * letters. Text that holds the control characters of binary content (an image, a PDF, random bytes
 * named .csv) is refused: no CSV has them, and Papa would make rows of them.
 */
function decodeCsvText(bytes: Uint8Array): { text: string; warnings: string[] } {
  const strict = (encoding: string, b: Uint8Array) => new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(b);
  let text: string;
  const warnings: string[] = [];
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    try {
      text = strict(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be', bytes.subarray(2));
    } catch {
      throw new WorkbookRefusedError(DAMAGED_UTF16);
    }
  } else {
    const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
    try {
      text = strict('utf-8', body);
    } catch {
      try {
        text = new TextDecoder('windows-1256').decode(body);
      } catch {
        // A Node built without the full ICU data has no windows-1256: say so, never guess.
        throw new WorkbookRefusedError(NOT_UTF8);
      }
      warnings.push(READ_AS_ARABIC_WINDOWS);
    }
  }
  text = withoutNul(text);
  checkCsvText(text);
  return { text, warnings };
}

/** Control characters no text file has (tab, line feed, vertical tab, form feed and carriage return aside). */
const BINARY_CHARS = /[\u0001-\u0008\u000e-\u001f\u007f]/g;

/**
 * Refuses decoded text that is no CSV, with the words a file sent as Excel gets (lib/workbook-guard):
 * a web page or XML file (it begins with "<", after spaces and line breaks), a SocialCalc file; and
 * binary content: more than 8 control characters, and more than 1 in 100 characters (a CSV has none;
 * random bytes about 1 in 9).
 */
function checkCsvText(text: string): void {
  if (/^\s*</.test(text)) throw webPageOrXml();
  if (text.startsWith('socialcalc:version:')) throw notExcel();
  const controls = text.match(BINARY_CHARS)?.length ?? 0;
  if (controls > 8 && controls * 100 > text.length) {
    throw new WorkbookRefusedError(
      'This file is not a CSV text file or an Excel workbook, so it cannot be read. Save it in Excel as .xlsx or as CSV and upload that.',
    );
  }
}

/** The line of the file (the header is line 1) where a Papa Parse error was found, from its position in the text. */
function lineOf(text: string, e: Papa.ParseError): number {
  if (typeof e.index !== 'number') return (e.row ?? 0) + 1;
  return 1 + (text.slice(0, e.index).match(/\r\n|\r|\n/g)?.length ?? 0);
}

/** Refusal of a CSV with a quote that is not closed where it should be (see parseUpload). */
function unclosedQuote(line: number): WorkbookRefusedError {
  return new WorkbookRefusedError(
    `Line ${line} of this file has a quote (") that is not closed where it should be, so the lines after it would be read as part of one value. ` +
      'The file was not read. Fix that quote (a quote inside a value is written twice: ""), or save the file again from Excel as CSV, and upload again.',
  );
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
 * number has, a date, text). For a number format the text comes from ShownFormats; for CSV sent as
 * Excel it is the text in the file.
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
 * trailing zeros: 23.585 in a cell formatted 0.0000 reads "23.5850" (the number cannot tell 23.5850
 * from 23.585, and 1 in 10 real 4-decimal coordinates ends in 0), 23.58 "23.5800". The customer
 * import counts one of those zeros at most (A5 fifth review: this rule was here, for number formats
 * only, and a CSV saved from the same cells read "23.5800" as 4 decimals), so a rough point formatted
 * to show 4 decimals stays not exact in any file. Anything else (a date, a percentage, text around
 * the number, a scale, a condition, a format SheetJS cannot apply) adds nothing: the number's own
 * decimals count. At most MAX_SHOWN_FORMATS formats are tried in one upload.
 */
class ShownFormats {
  private readonly positive = new Map<string, number | null>();
  private readonly negative = new Map<string, number | null>();
  private tried = 0;

  /** The text a number cell in format `z` shows (see above); undefined when it adds nothing. */
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
    return zeros > places ? `${own}${places ? '' : '.'}${'0'.repeat(zeros - places)}` : undefined;
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
 * PC with Excel installed, so a CSV that Excel saved with "23.5850" comes this way). A file that
 * begins with "ID" goes through SheetJS's SYLK reader first, which formats a value when a format
 * record came before it (and throws where a format cannot be applied); such a file - never a CSV -
 * counts the numbers' own decimals (idFileFormatsCells). A CSV whose first header is "ID" is read
 * with its text like any other (A5 fifth review: every "ID;" file was, so a semicolon CSV lost its
 * trailing zeros only when the browser sent it as Excel). Since the review of 8 Oct 2026 parseUpload
 * gives SheetJS no text at all (CSV text goes to Papa Parse, which keeps every value's text), so the
 * text branch is no longer reached from an upload; it is kept unchanged for readWorkbook's sake.
 */
function shownTextRead(buf: Buffer): { cellNF: true } | { cellText: true } | Record<string, never> {
  const reader = sheetjsReader(buf);
  if (reader !== 'text' && reader !== 'text-ws' && reader !== 'text-utf16') return { cellNF: true };
  if (buf[0] === 0x49 && buf[1] === 0x44 && idFileFormatsCells(buf)) return {};
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

/**
 * Lines a CSV's header is looked for in before the file is parsed (parseCsv): the header is the
 * first of them that is not blank.
 */
const HEADER_LINES = 10;

/**
 * A CSV (Papa Parse, whatever the file was sent as since the review of 8 Oct 2026; before, a CSV
 * sent as Excel went to SheetJS), from its decoded text (decodeCsvText): its rows as Papa makes them
 * (normalizeKeys comes after the checks), the width of its header, Papa's warnings, and whether it
 * goes on past READ_ROWS rows. A header wider than MAX_COLS is refused (P5 second review: a CSV had
 * no column or cell cap, so a row of a million columns, a 7.6 MB file, was read and sent to the web
 * process as one object of a million keys). The rows are checked by checkCsvCells.
 */
function parseCsv(text: string): { rows: Record<string, unknown>[]; header: number; errors: Papa.ParseError[]; truncated: boolean } {
  // The header first, before Papa makes an object with a key for every header name for each row,
  // and renames repeated names one by one (a 2.9 MB header of 1.5 million repeated names took it
  // 3.4 s). The same Papa over the first lines only, with no row objects, reads them as the parse
  // below does (the same delimiter and line break it guesses from the whole text, the same blank
  // lines skipped), so the first line it keeps is that parse's header. A header after more blank
  // lines than that is checked once the file is parsed.
  const first = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy', preview: HEADER_LINES }).data[0];
  if (first && first.length > MAX_COLS) throw tooManyCsvColumns(first.length);
  // Synchronous: Papa parses a string in one go. `preview` stops it after READ_ROWS rows (empty
  // lines count towards it); meta.truncated says that it stopped there.
  const res = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    preview: READ_ROWS,
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const header = res.meta.fields?.length ?? 0;
  if (header > MAX_COLS) throw tooManyCsvColumns(header);
  return { rows: res.data, header, errors: res.errors, truncated: !!res.meta.truncated };
}

/**
 * The rows of a CSV sent as text against the caps (P5 second review), after the row limit: a row of
 * more than MAX_COLS values, or more than MAX_CELLS cells with the header's, is refused. A row with
 * more values than its header keeps the extra ones in one list (Papa's "__parsed_extra", joined into
 * one text by normalizeKeys): each of them counts. Every value is counted as it is in the file, empty
 * ones too (a CSV saved from Excel writes the empty columns after the data on every line; SheetJS,
 * which read the same text sent as Excel until the review of 8 Oct 2026, dropped them).
 */
function checkCsvCells(rows: Record<string, unknown>[], header: number): void {
  let cells = header;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const extra = row.__parsed_extra;
    const values = Object.keys(row).length + (Array.isArray(extra) ? extra.length - 1 : 0);
    if (values > MAX_COLS) throw tooManyCsvColumns(values, i + 2);
    cells += values;
  }
  if (cells > MAX_CELLS) throw tooManyTextCells(cells, MAX_CELLS);
}

/** A CSV whose header (or row `row`, the header being row 1) has more than MAX_COLS values. */
function tooManyCsvColumns(columns: number, row?: number): WorkbookRefusedError {
  return new WorkbookRefusedError(
    `${row === undefined ? 'This file has' : `Row ${row} of this file has`} ${columns.toLocaleString('en-US')} columns; at most ${MAX_COLS} can be read. ` +
      'Delete the columns you do not need (also empty columns after your data) and upload again.',
  );
}

/**
 * A row's keys trimmed and in small letters, its values as trimmed text. U+0000 is taken out of both
 * (withoutNul): a workbook cell can hold one (an "_x0000_" escape), and PostgreSQL refused the upload
 * batch that kept it, answering an empty 500 (review s5-security-1).
 */
function normalizeKeys(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = withoutNul(k).trim().toLowerCase();
    out[key] = v == null ? '' : withoutNul(String(v)).trim();
  }
  return out;
}

/** The file name as stored on the upload batch: no path separators, no U+0000, runs of spaces as one, at most 200 characters. */
export function sanitizeFileName(name: string): string {
  return withoutNul(name)
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}
