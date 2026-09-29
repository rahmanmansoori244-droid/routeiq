/**
 * The checks on an uploaded file that need none of its content: its size and its type. They have no
 * dependencies, so the web process makes them before it hands the file to the parser process
 * (lib/upload-parse), and parseUpload (lib/csv) makes the same ones, with the same messages.
 */

/** 10 MB per file (owner decision 16, audit E2). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The types a browser sends a CSV or an Excel file with (none: judged by the name). */
export const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** Why a file is refused before it is read (too large, a type that is not CSV or Excel), or null. */
export function fileRefusal(file: { size: number; type: string }): string | null {
  if (file.size > MAX_FILE_BYTES) return `File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`;
  if (file.type && !ALLOWED_TYPES.has(file.type)) return `Unsupported file type: ${file.type}. Use CSV or XLSX.`;
  return null;
}
