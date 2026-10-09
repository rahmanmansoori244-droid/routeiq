/**
 * The checks on an uploaded file that need none of its content: its size and its type (with its name
 * when the type says nothing, see UNSPECIFIC_TYPES). They have no
 * dependencies, so the web process makes them before it hands the file to the parser process
 * (lib/upload-parse), and parseUpload (lib/csv) makes the same ones, with the same messages. Also
 * the column and cell caps, which the web process checks the parser's answer against.
 */

/** 10 MB per file (owner decision 16, audit E2). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Columns of one sheet (from the first to the last column holding a cell), or fields of one line of
 * a CSV sent as text; NMWC's files have about 15. Here, not in lib/csv, so that the web process can
 * check the parser's answer against it too (lib/upload-parse/protocol.ts, P5 second review).
 */
export const MAX_COLS = 200;
/**
 * Cells (rows x columns) of all sheets' ranges together, or fields of all lines of a CSV sent as
 * text, the header's included: e.g. 50,000 rows of 49 columns. The web process checks the parser's
 * answer against it too (see MAX_COLS).
 */
export const MAX_CELLS = 2_500_000;

/** The types a browser sends a CSV or an Excel file with (none: judged by the name). */
export const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/**
 * Types that say nothing about a file, which some browsers send for a CSV or Excel file all the same
 * (review of 8 Oct 2026, M4): application/octet-stream for an .xlsx on a PC without Office, text/plain
 * or text/comma-separated-values for a .csv on some systems and phones. A file with one of them is
 * read when its name is a .csv, .xlsx or .xls (SPREADSHEET_NAME); what it is, is then decided by its
 * content, as for every upload (lib/csv parseUpload: a workbook by its bytes, else CSV text, and
 * content that is neither, a web page or binary, refused).
 */
export const UNSPECIFIC_TYPES: ReadonlySet<string> = new Set([
  'application/octet-stream',
  'text/plain',
  'text/comma-separated-values',
  'application/csv',
  'text/x-csv',
]);
const SPREADSHEET_NAME = /\.(csv|xlsx|xls)$/i;

/** Why a file is refused before it is read (too large, a type that is not CSV or Excel), or null. */
export function fileRefusal(file: { size: number; type: string; name?: string }): string | null {
  if (file.size > MAX_FILE_BYTES) return `File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`;
  if (!file.type || ALLOWED_TYPES.has(file.type)) return null;
  if (UNSPECIFIC_TYPES.has(file.type) && SPREADSHEET_NAME.test(file.name ?? '')) return null;
  return `Unsupported file type: ${file.type}. Use CSV or XLSX.`;
}
