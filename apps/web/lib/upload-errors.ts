/**
 * The refusals of an upload's content: a workbook with the rows on more than one sheet
 * (MultipleSheetsError, and the sheet list it names) and a file the checks refuse
 * (WorkbookRefusedError, lib/workbook-guard). They have no dependencies, so the upload routes, and
 * lib/upload-parse, which rebuilds them from the parser process's answer, use them without loading
 * SheetJS; lib/csv and lib/workbook-guard re-export them.
 */

/** Refusal of an upload with a message for the dispatcher (the routes answer 400 with it). */
export class WorkbookRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbookRefusedError';
  }
}

/** One sheet as a refusal or a warning names it: its name and its data rows. */
export interface SheetSummary {
  name: string;
  rows: number;
  /** The sheet goes on past the rows that are read: `rows` is a floor. */
  truncated?: boolean;
}

/**
 * A workbook with the rows of this upload on more than one sheet (scenario test S04: Orders +
 * LateOrder). Nothing is read: each sheet must be uploaded as its own file, so each is checked
 * (and, for late orders, confirmed with its reason) on its own.
 */
export class MultipleSheetsError extends Error {
  readonly code = 'MULTIPLE_SHEETS';
  constructor(
    public readonly sheets: SheetSummary[],
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

/** The sheets as a message names them: "Orders" (1,200 rows), "Late" (50,099 rows or more). */
export function sheetList(sheets: SheetSummary[]): string {
  // A sheet that goes on past READ_ROWS was not read to its end: its count is a floor.
  return sheets.map((s) => `"${s.name}" (${rowCount(s.rows)}${s.truncated ? ' or more' : ''})`).join(', ');
}
