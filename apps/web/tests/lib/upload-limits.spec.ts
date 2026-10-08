/**
 * Audit 27 Sep 2026, earlier-open item E2 (quick fix; the worker comes in audit PR 5): one Excel
 * upload could block RouteIQ for every user. The file is parsed synchronously on the event loop,
 * so the 10 s "timeout" could never fire; a real 10 MB workbook froze the app for 17-38 s and a
 * crafted file of a few hundred KB for minutes.
 *
 *  - a workbook is measured by unpacking it (never by its zip headers) and refused, before
 *    SheetJS reads it, when it unpacks to more than 50 MB or has more than 1,000 parts; an archive
 *    that is not an Excel workbook, a damaged or password-protected one is refused too;
 *  - a workbook with more than 10 sheets is refused before any sheet is read;
 *  - at most READ_ROWS rows of each sheet (and of a CSV) are read; a sheet that goes on past them
 *    is refused when it is the one read, and named "N rows or more" when it is not - never cut
 *    short without a word. The 10 MB and 50,000-row limits are unchanged;
 *  - no parse timer is armed any more.
 *
 * A1 review (below the first blocks): files that passed all of that and still blocked the app for
 * minutes or crashed it - a range wider than its cells (size record, far-right cell), a part with
 * two names, hyperlink ranges (.xlsx, .xls, binary .xlsb sheets), the other formats SheetJS
 * guesses from a file's first bytes, CSV and .xlsx files with millions of cells, array formulas,
 * comments - and a blank formatted first sheet chosen over the data sheet.
 *
 * A1 v3: files that still did - "ID" files whose SYLK reader works long before SheetJS reads them
 * as CSV (and semicolon "ID" CSVs wrongly refused), a long number format on many cells, metadata
 * entries, a threaded-comment person list, self-closing typed cells.
 *
 * A1 v4: a part that SheetJS reads more than once while the checks counted it once - one
 * worksheet part named by several sheets, a comments part or a drawing named again and again, an
 * external link listed many times - and chart sheets, whose points SheetJS turns into cells past
 * every cap.
 *
 * A1 v5 (the last block): sheets SheetJS finds by number are counted on the parts it numbers them
 * by (a byte-order mark alone as xl/worksheets/sheet.xml made the checks count another part).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('xlsx', async (importOriginal) => {
  const real = await importOriginal<typeof import('xlsx')>();
  return { ...real, read: vi.fn(real.read), utils: { ...real.utils, sheet_to_json: vi.fn(real.utils.sheet_to_json) } };
});
// Papa Parse as it is, with its calls recorded (the P5 second review's CSV checks).
vi.mock('papaparse', async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof import('papaparse') }>()).default;
  return { default: { ...real, parse: vi.fn(real.parse) } };
});

import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { MAX_CELLS, MAX_COLS, MAX_COMMENTS, MAX_LINK_CELLS, MAX_METADATA, MAX_PEOPLE, MAX_ROWS, MAX_SHEETS, MAX_ZIP_PARTS, READ_ROWS, parseExcelSheets, parseUpload } from '@/lib/csv';
import { checkWorkbookZip } from '@/lib/workbook-guard';
import {
  cfbDescendingChain,
  chartSheetParts,
  commentsXml,
  denseSheet,
  handWorkbook,
  hugeSheet,
  rawSheet,
  RELS,
  relsXml,
  row,
  sheetWithLegacyDrawing,
  sheetXml,
  vmlNotes,
  withComments,
  withMetadata,
  withNumberFormat,
  withPeople,
  workbook,
  xlsbWorkbook,
  xlsWithLink,
  xlsxFile,
  xlsxWithBinarySheet,
  zip,
  XLSX_TYPE,
} from './zip-fixtures';

const readSpy = vi.mocked(XLSX.read);
const toJsonSpy = vi.mocked(XLSX.utils.sheet_to_json);
const papaSpy = vi.mocked(Papa.parse);
afterEach(() => {
  readSpy.mockClear();
  toJsonSpy.mockClear();
  papaSpy.mockClear();
  vi.restoreAllMocks();
});

const refusal = (p: Promise<unknown>) => p.then(() => 'accepted', (e: Error) => e.message);
/** The limits parseExcelSheets passes to the guard. */
const LIMITS = {
  maxUnpackedBytes: 50 * 1024 * 1024,
  maxParts: MAX_ZIP_PARTS,
  maxLinkCells: MAX_LINK_CELLS,
  maxCells: MAX_CELLS,
  maxComments: MAX_COMMENTS,
  maxMetadata: MAX_METADATA,
  maxPeople: MAX_PEOPLE,
  maxSheets: MAX_SHEETS,
};
const TOO_BIG = 'This workbook is too large to read: it unpacks to more than 50 MB. Save only the sheet you need as a new workbook or as CSV and upload that.';

/** A SheetJS-written workbook (with the size record Excel writes too), one sheet per entry. */
function sheetjsWorkbook(sheets: Record<string, XLSX.WorkSheet>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, ws] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, ws, name);
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer);
}
const orderRows = (n: number) => [
  ['sales_order_no', 'delivery_date', 'customer_code', 'product_code', 'cases'],
  ...Array.from({ length: n }, (_, i) => [`INV-${i + 1}`, '2026-10-07', `C${i % 200}`, 'W500', 3]),
];
const listRows = (n: number) => [['code', 'name'], ...Array.from({ length: n }, (_, i) => [`C${i}`, `Customer ${i}`])];
const orders = { isDataSheet: (h: string[]) => h.includes('sales_order_no'), rowsWord: 'order' };

describe('a workbook is measured by unpacking it, before SheetJS reads it', () => {
  it('a crafted 0.2 MB file that unpacks to 64 MB is refused at once; SheetJS never sees it', async () => {
    const bytes = workbook({ Orders: { deflated: hugeSheet(64) } });
    expect(bytes.length).toBeLessThan(300_000);
    const t0 = performance.now();
    expect(await refusal(parseUpload(xlsxFile(bytes)))).toBe(TOO_BIG);
    expect(performance.now() - t0).toBeLessThan(5_000); // about 30 ms; it used to parse 1.6 M rows
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('the same file whose zip headers claim 4 KB is refused as well (the size is measured, not read)', async () => {
    const bomb = hugeSheet(64);
    const bytes = workbook({ Orders: { deflated: bomb, claimedSize: 4096 } });
    // Before: SheetJS unpacked all 64 MB into a 4 KB buffer, dropped the rest and read 0 rows.
    expect(await refusal(parseUpload(xlsxFile(bytes)))).toBe(TOO_BIG);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('a part whose header claims a size it does not have is refused as damaged', async () => {
    const data = sheetXml(20);
    const bytes = workbook({ Orders: { data, claimedSize: data.length + 64 } });
    expect(await refusal(parseUpload(xlsxFile(bytes)))).toBe(
      'This workbook is damaged and cannot be read. Open it in Excel, save it again as .xlsx and upload it again.',
    );
  });

  it('a workbook just under 50 MB unpacked is not refused for its size (here: for its rows)', () => {
    const bytes = workbook({ Orders: { deflated: hugeSheet(45) } });
    expect(checkWorkbookZip(bytes, { ...LIMITS, maxUnpackedBytes: 50 * 1024 * 1024 }).unpackedBytes).toBeGreaterThan(45 * 1024 * 1024);
    // About 1.1 M rows: only the first READ_ROWS are turned into rows (it took 9 s and 0.9 GB).
    const [sheet] = parseExcelSheets(bytes);
    expect(sheet!.rows).toHaveLength(READ_ROWS - 1);
    expect(sheet!.truncated).toBe(true);
  });

  it(`more than ${MAX_ZIP_PARTS} parts is refused before SheetJS reads the file`, async () => {
    const extra = Array.from({ length: MAX_ZIP_PARTS }, (_, i) => ({ name: `xl/media/part${i}.xml`, data: Buffer.from('<x/>') }));
    const bytes = workbook({ Orders: sheetXml(3) }, extra);
    expect(await refusal(parseUpload(xlsxFile(bytes)))).toBe(
      'This workbook has 1,005 parts inside; at most 1,000 can be read. Save only the sheet you need as a new workbook or as CSV and upload that.',
    );
    expect(readSpy).not.toHaveBeenCalled();
    // Just at the limit: read.
    const ok = workbook({ Orders: sheetXml(3) }, extra.slice(0, MAX_ZIP_PARTS - 5));
    expect((await parseUpload(xlsxFile(ok))).rows).toHaveLength(3);
  });

  it('an archive that is not an Excel workbook (OpenDocument, Numbers) is refused', async () => {
    const ods = zip([
      { name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.spreadsheet'), stored: true },
      { name: 'META-INF/manifest.xml', data: Buffer.from('<manifest/>') },
      { name: 'content.xml', data: Buffer.from('<office:document-content/>') },
    ]);
    const notExcel = 'This file is not an Excel workbook. Save it in Excel as .xlsx or as CSV and upload that.';
    expect(await refusal(parseUpload(xlsxFile(ods)))).toBe(notExcel);
    const nested = zip([{ name: 'Index.zip', data: workbook({ Orders: sheetXml(3) }), stored: true }]);
    expect(await refusal(parseUpload(xlsxFile(nested)))).toBe(notExcel);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('a password-protected part is refused with a plain message', async () => {
    const bytes = workbook({ Orders: { data: sheetXml(3), flags: 1 } });
    expect(await refusal(parseUpload(xlsxFile(bytes)))).toBe(
      'This workbook is password-protected. Remove the password in Excel, save it and upload it again.',
    );
  });

  it('SheetJS gets a Buffer view of the upload: no copy of the rest of the file per part', async () => {
    await parseUpload(xlsxFile(workbook({ Orders: sheetXml(3) })));
    expect(readSpy).toHaveBeenCalled();
    for (const [data, opts] of readSpy.mock.calls) {
      expect(Buffer.isBuffer(data)).toBe(true);
      expect(opts).toMatchObject({ type: 'buffer', sheetRows: READ_ROWS });
    }
  });

  it('a normal Excel-made workbook is read as before', async () => {
    const parsed = await parseUpload(xlsxFile(sheetjsWorkbook({ Orders: XLSX.utils.aoa_to_sheet(orderRows(40)) })), orders);
    expect(parsed.rows).toHaveLength(40);
    expect(parsed.rows[0]).toMatchObject({ sales_order_no: 'INV-1', cases: '3' });
  });
});

describe(`at most ${MAX_SHEETS} sheets, counted before any sheet is read`, () => {
  const sheets = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`S${i + 1}`, sheetXml(2)]));

  it(`${MAX_SHEETS + 1} sheets: refused, and no sheet was read`, async () => {
    expect(await refusal(parseUpload(xlsxFile(workbook(sheets(MAX_SHEETS + 1)))))).toBe(
      'This workbook has 11 sheets; at most 10 can be read. Save only the sheet you need as a new workbook or as CSV and upload that.',
    );
    // Only the sheet list was read (bookSheets), never a sheet.
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy.mock.calls[0]![1]).toMatchObject({ bookSheets: true });
    expect(toJsonSpy).not.toHaveBeenCalled();
  });

  it(`${MAX_SHEETS} sheets are read`, async () => {
    const parsed = await parseUpload(xlsxFile(workbook(sheets(MAX_SHEETS))));
    expect(parsed.sheetName).toBe('S1');
    expect(parsed.warnings[0]).toContain('Other sheet(s) with rows were not read');
  });
});

describe('each sheet is read to at most READ_ROWS rows; nothing is cut short without a word', () => {
  it('the 50,000-row limit is unchanged: 50,000 read, 50,001 refused with the exact count', async () => {
    // (With a second sheet the message names the sheet: scenario-findings-pr6-review.spec.ts.)
    expect((await parseUpload(xlsxFile(workbook({ Orders: sheetXml(MAX_ROWS) })))).rows).toHaveLength(MAX_ROWS);
    expect(await refusal(parseUpload(xlsxFile(workbook({ Orders: sheetXml(MAX_ROWS + 1) }))))).toBe('Too many rows: 50001. Max 50000.');
  });

  it('a sheet of 80,000 rows is read only to READ_ROWS and refused as "more than 50000"', async () => {
    const bytes = workbook({ Orders: sheetXml(80_000) }); // no size record: the cut is seen from the rows read
    const [sheet] = parseExcelSheets(bytes);
    expect(sheet!.rows).toHaveLength(READ_ROWS - 1);
    expect(sheet!.truncated).toBe(true);
    expect(await refusal(parseUpload(xlsxFile(bytes)))).toBe('Too many rows: more than 50000. Max 50000.');
  });

  it('the sheet that is read goes on below empty rows: refused, not cut at row 50,100', async () => {
    // 50,000 order rows, 200 empty rows, then one more order row: the first 50,100 rows hold
    // only 50,000 orders, but the sheet goes on. Before: the 50,001 rows were counted in full.
    const ws = XLSX.utils.aoa_to_sheet(orderRows(MAX_ROWS));
    XLSX.utils.sheet_add_aoa(ws, [['INV-LAST', '2026-10-07', 'C1', 'W500', 3]], { origin: `A${MAX_ROWS + 202}` });
    const bytes = sheetjsWorkbook({ Orders: ws });
    expect(await refusal(parseUpload(xlsxFile(bytes), orders))).toBe(
      'Too many rows: the sheet goes on past row 50,100, and at most 50000 rows are read. If the rows below your data are empty, delete them and upload again.',
    );
  });

  it('a large sheet that is not read is named with "or more" and does not stop the upload', async () => {
    const bytes = sheetjsWorkbook({ Orders: XLSX.utils.aoa_to_sheet(orderRows(900)), CustomerList: XLSX.utils.aoa_to_sheet(listRows(60_000)) });
    const parsed = await parseUpload(xlsxFile(bytes), orders);
    expect(parsed.rows).toHaveLength(900);
    expect(parsed.warnings).toEqual([
      'Only sheet "Orders" was read. Other sheet(s) with rows but without the order columns were not read: "CustomerList" (50,099 rows or more).',
    ]);
  });
});

describe('CSV: read to at most READ_ROWS rows', () => {
  const csv = (lines: string[], name = 'orders.csv') => new File([lines.join('\n')], name, { type: 'text/csv' });
  const body = (n: number) => ['code,cases', ...Array.from({ length: n }, (_, i) => `C${i},${(i % 9) + 1}`)];

  it('50,000 rows are read; 50,001 are refused with the count; 200,000 stop at READ_ROWS', async () => {
    expect((await parseUpload(csv(body(MAX_ROWS)))).rows).toHaveLength(MAX_ROWS);
    expect(await refusal(parseUpload(csv(body(MAX_ROWS + 1))))).toBe('Too many rows: 50001. Max 50000.');
    // Before: all 200,000 rows were parsed, then refused ("Too many rows: 200000").
    expect(await refusal(parseUpload(csv(body(200_000))))).toBe('Too many rows: more than 50000. Max 50000.');
  });

  it('a CSV sent as Excel (Windows browsers do) has the same row cap', async () => {
    // Since the review of 8 Oct 2026 it is read by Papa Parse like any CSV (upload-csv-text.spec.ts).
    const file = new File([body(120_000).join('\n')], 'orders.csv', { type: 'application/vnd.ms-excel' });
    expect(await refusal(parseUpload(file))).toBe('Too many rows: more than 50000. Max 50000.');
    expect(readSpy).not.toHaveBeenCalled();
  });
});

describe('no parse timer', () => {
  it('parsing arms no timer: it is synchronous, so a timer could never have fired', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await parseUpload(xlsxFile(workbook({ Orders: sheetXml(5) })));
    await parseUpload(new File(['code,cases\nC1,2\n'], 'orders.csv', { type: 'text/csv' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('the 10 MB limit is unchanged', async () => {
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'orders.xlsx', { type: XLSX_TYPE });
    expect(await refusal(parseUpload(big))).toBe('File too large (max 10 MB).');
  });
});

// ---------------------------------------------------------------------------------------------
// A1 review (27 Sep 2026): files that passed every cap above and still blocked the app for
// minutes or ran it out of memory. Each case is the reviewers' own file or its mechanism.
// ---------------------------------------------------------------------------------------------

const DAMAGED = 'This workbook is damaged and cannot be read. Open it in Excel, save it again as .xlsx and upload it again.';
const NOT_EXCEL = 'This file is not an Excel workbook. Save it in Excel as .xlsx or as CSV and upload that.';
const WEB_PAGE = 'This file is a web page or an XML file, not an Excel workbook or CSV. Open it in Excel, save it as .xlsx and upload that.';
const links = (n: number) =>
  `This workbook has links over ${n.toLocaleString('en-US')} cells; at most 200,000 can be read. Remove the links (in Excel: select the cells, right-click, Remove Hyperlinks), save it and upload it again.`;
const header = row(1, ['A', 'code'], ['B', 'cases']);
const twoRows = header + row(2, ['A', 'C2'], ['B', 3]) + row(3, ['A', 'C3'], ['B', 3]);
const asExcel = (body: string | Buffer, name = 'orders.xls') =>
  new File([typeof body === 'string' ? body : new Uint8Array(body)], name, { type: 'application/vnd.ms-excel' });

describe('A1 review: the range a sheet is walked over is checked before any sheet is turned into rows', () => {
  it('a 1.6 KB workbook whose size record says A1:XFD2000 is read as its 2 rows, in milliseconds', async () => {
    // sheet_to_json visits every cell of the range and gives every row a key per column: this
    // file took 28 s (A1:XFD50000: minutes) and each row had 16,384 keys.
    const bytes = workbook({ Orders: rawSheet(twoRows, { before: '<dimension ref="A1:XFD2000"/>' }) });
    expect(bytes.length).toBeLessThan(2_000);
    const t0 = performance.now();
    const parsed = await parseUpload(xlsxFile(bytes));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(parsed.rows).toEqual([{ code: 'C2', cases: '3' }, { code: 'C3', cases: '3' }]);
    // Only the rows and columns that hold a cell were walked.
    expect(toJsonSpy.mock.calls[0]![1]).toMatchObject({ range: { s: { r: 0, c: 0 }, e: { r: 2, c: 1 } } });
  });

  it('a sheet with a cell in column XFD is refused, naming the sheet and its width, before any sheet is turned into rows', async () => {
    // The reviewers' "wide-cell" file: 3.7 KB, took 6 s and 0.76 GB; with 2,000 rows it crashed.
    let data = row(1, ['A', 'code'], ['B', 'cases'], ['XFD', 'x']);
    for (let r = 2; r <= 201; r++) data += row(r, ['A', `C${r}`], ['B', 3]);
    expect(await refusal(parseUpload(xlsxFile(workbook({ Orders: rawSheet(data) }))))).toBe(
      'Sheet "Orders" has 16,384 columns; at most 200 can be read. Delete the columns you do not need, or save only the sheet you need as a new workbook or as CSV, and upload that.',
    );
    expect(toJsonSpy).not.toHaveBeenCalled();
  });

  it(`${MAX_COLS} columns are read; ${MAX_COLS + 1} are refused`, async () => {
    const wide = (cols: number) =>
      workbook({ Orders: rawSheet(row(1, ['A', 'code'], ['B', 'cases'], [XLSX.utils.encode_col(cols - 1), 'last']) + row(2, ['A', 'C2'], ['B', 3])) });
    expect((await parseUpload(xlsxFile(wide(MAX_COLS)))).rows).toHaveLength(1);
    expect(await refusal(parseUpload(xlsxFile(wide(MAX_COLS + 1))))).toMatch(/^Sheet "Orders" has 201 columns; at most 200 can be read/);
  });

  it(`sheets that together span more than ${MAX_CELLS.toLocaleString('en-US')} cells are refused before any is turned into rows`, async () => {
    // Each sheet: 200 columns x 6,251 rows from three cells (within the column cap on its own).
    const sheet = rawSheet(row(1, ['A', 'code'], ['GR', 'last']) + row(6251, ['A', 'C1']));
    expect(await refusal(parseUpload(xlsxFile(workbook({ S1: sheet, S2: sheet }))))).toBe(
      'This workbook is too large to read: its sheets span 2,500,400 cells (rows x columns); at most 2,500,000 can be read. Save only the sheet you need as a new workbook or as CSV and upload that.',
    );
    expect(toJsonSpy).not.toHaveBeenCalled();
  });

  it('within the caps a range is walked as it is: empty columns inside the size record keep their "__empty" keys, as before', async () => {
    const parsed = await parseUpload(xlsxFile(workbook({ Orders: rawSheet(twoRows, { before: '<dimension ref="A1:D3"/>' }) })));
    expect(parsed.rows[0]).toEqual({ code: 'C2', cases: '3', __empty: '', __empty_1: '' });
    expect(toJsonSpy.mock.calls[0]![1]).not.toHaveProperty('range');
  });
});

describe('A1 review: a zip part has one name, the one SheetJS reads', () => {
  it('"[Content_Types].xml" in the central directory but "Index.zip" in the local header (an archive inside) is refused before SheetJS reads it', async () => {
    // SheetJS names a part from its local header and opens a lone "Index.zip" as a workbook of
    // its own; the check read the central directory. The reviewers' 1.2 MB file unpacked to about
    // 400 MB inside SheetJS (14.6 s, 1.7 GB) while the check measured 1.2 MB.
    const inner = workbook({ Orders: { deflated: hugeSheet(60) } });
    const outer = zip([{ name: '[Content_Types].xml', localName: 'Index.zip', data: inner, stored: true }]);
    expect(await refusal(parseUpload(xlsxFile(outer)))).toBe(DAMAGED);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('other names SheetJS finds foreign parts by are refused too: a backslash path, a control character', async () => {
    // SheetJS also looks up "META-INF\manifest.xml" and then reads the file as OpenDocument.
    const ods = workbook({ Orders: sheetXml(3) }, [
      { name: 'META-INF\\manifest.xml', data: Buffer.from('<manifest/>') },
      { name: 'content.xml', data: Buffer.from('<office:document-content/>') },
    ]);
    expect(await refusal(parseUpload(xlsxFile(ods)))).toBe(NOT_EXCEL);
    const control = workbook({ Orders: sheetXml(3) }, [{ name: 'xl/media/x\u0001.xml', data: Buffer.from('<x/>') }]);
    expect(await refusal(parseUpload(xlsxFile(control)))).toBe(DAMAGED);
    expect(readSpy).not.toHaveBeenCalled();
  });
});

describe('A1 review: hyperlink ranges are added up before SheetJS reads the file', () => {
  const linked = (ref: string) => workbook({ Orders: rawSheet(twoRows, { after: `<hyperlinks><hyperlink ref="${ref}" location="Orders!A1"/></hyperlinks>` }) });

  it('one link over A1:T20000 (400,000 cells) is refused before SheetJS reads it', async () => {
    expect(await refusal(parseUpload(xlsxFile(linked('A1:T20000'))))).toBe(links(400_000));
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('one link over the whole sheet (a 1.7 KB file) is refused in milliseconds', async () => {
    // SheetJS makes a cell for every address of a link's range, whatever sheetRows says: this
    // file ran for more than 3 minutes and out of memory.
    const bytes = linked('A1:XFD1048576');
    expect(bytes.length).toBeLessThan(2_000);
    const t0 = performance.now();
    expect(await refusal(parseUpload(xlsxFile(bytes)))).toBe(links(17_179_869_184));
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('a link whose column letters are too many for a number is refused (SheetJS would loop over it forever)', async () => {
    const z = 'Z'.repeat(230); // 26^230 is more than the largest number: the column decodes to Infinity
    expect(await refusal(parseUpload(xlsxFile(linked(`${z}1:${z}2`))))).toBe(
      'This workbook has links over more cells than a sheet has; at most 200,000 can be read. Remove the links (in Excel: select the cells, right-click, Remove Hyperlinks), save it and upload it again.',
    );
  });

  it(`links over ${MAX_LINK_CELLS.toLocaleString('en-US')} cells are read; one more is refused`, async () => {
    expect((await parseUpload(xlsxFile(linked('A1:A200000')))).rows).toHaveLength(2);
    expect(await refusal(parseUpload(xlsxFile(linked('A1:A200001'))))).toBe(links(200_001));
  });

  it('every way SheetJS reads a link range is counted as SheetJS expands it', () => {
    const variants: [string, Buffer][] = [
      ['plain', rawSheet(twoRows, { after: '<hyperlinks><hyperlink ref="A1:C4" location="Orders!A1"/></hyperlinks>' })],
      ['namespace prefixes', rawSheet(twoRows, { after: '<x:hyperlinks><x:hyperlink x:ref="A1:C4" location="Orders!A1"/></x:hyperlinks>' })],
      ['upper case', rawSheet(twoRows, { after: '<hyperlinks><hyperlink REF="A1:C4" location="Orders!A1"/></hyperlinks>' })],
      ['"_" suffix', rawSheet(twoRows, { after: '<hyperlinks><hyperlink ref_x="A1:C4" location="Orders!A1"/></hyperlinks>' })],
      ['spaces and single quotes', rawSheet(twoRows, { after: "<hyperlinks><hyperlink ref = 'A1:C4' location='Orders!A1'/></hyperlinks>" })],
      ['no quotes', rawSheet(twoRows, { after: '<hyperlinks><hyperlink ref=A1:C4 location=x /></hyperlinks>' })],
    ];
    const utf16 = (b: Buffer) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(b.toString('utf8'), 'utf16le')]);
    variants.push(['UTF-16 worksheet', utf16(variants[0]![1])]);
    for (const [what, sheet] of variants) {
      const bytes = workbook({ Orders: sheet });
      const ws = XLSX.read(bytes, { type: 'buffer' }).Sheets.Orders!;
      const expanded = Object.keys(ws).filter((k) => !k.startsWith('!') && (ws[k] as XLSX.CellObject).l).length;
      expect([what, expanded]).toEqual([what, 12]);
      expect([what, checkWorkbookZip(bytes, LIMITS).linkCells]).toEqual([what, 12]);
    }
  });

  it('an old .xls with a link over 1,000 x 500 cells is refused before SheetJS reads it; a one-cell link is read', async () => {
    // Two records per link (the link and its tooltip), each looped over by SheetJS.
    expect(await refusal(parseUpload(asExcel(xlsWithLink(1_000, 500))))).toBe(links(1_000_000));
    expect(readSpy).not.toHaveBeenCalled();
    expect((await parseUpload(asExcel(xlsWithLink(1, 1)))).rows).toEqual([{ code: 'C1', cases: '3' }, { code: 'C2', cases: '4' }]);
  });

  it('an old .xls (4 KB) with a link over 65,536 x 65,536 cells is refused in milliseconds', async () => {
    // SheetJS would loop over 2 x 4.3 billion addresses: about half an hour (2,000 x 2,000: 2 s).
    const t0 = performance.now();
    expect(await refusal(parseUpload(asExcel(xlsWithLink(65_536, 65_536))))).toBe(links(8_589_934_592));
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('an .xlsx whose worksheet is a binary (.xlsb) part is not read: SheetJS never sees binary parts', () => {
    // Its link covers the whole sheet; SheetJS would expand it cell by cell.
    const bytes = xlsxWithBinarySheet({ rows: 1_048_576, cols: 16_384 });
    const t0 = performance.now();
    expect(parseExcelSheets(bytes)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('the same with a one-cell link: the binary sheet is still not read (it would be, as 2 rows, without the check)', () => {
    expect(parseExcelSheets(xlsxWithBinarySheet({ rows: 1, cols: 1 }))).toEqual([]);
  });

  it('a renamed .xlsb is refused with a plain message; a printer-settings part (as Excel writes it) changes nothing', async () => {
    expect(await refusal(parseUpload(xlsxFile(xlsbWorkbook())))).toBe(
      'This is an Excel binary workbook (.xlsb), which cannot be read. Save it in Excel as .xlsx and upload that.',
    );
    const withPrinter = workbook({ Orders: sheetXml(3) }, [{ name: 'xl/printerSettings/printerSettings1.bin', data: Buffer.alloc(1_200, 7) }]);
    expect((await parseUpload(xlsxFile(withPrinter))).rows).toHaveLength(3);
  });
});

describe('A1 review: SheetJS reads only the formats these checks bound', () => {
  it('a web page, an XML spreadsheet or a flat OpenDocument file sent as Excel is refused before SheetJS reads it', async () => {
    // A 763-byte flat OpenDocument file whose one cell repeats 2,000 x 1,000 times took 7.7 s;
    // SheetJS's web-page reader compares every cell with every merged cell (0.7 MB: 1.9 s).
    const fods =
      '<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">' +
      '<office:body><office:spreadsheet><table:table table:name="Orders"><table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="2000" office:value-type="float" office:value="1"/></table:table-row></table:table></office:spreadsheet></office:body></office:document>';
    const files: (string | Buffer)[] = [
      '<html><body><table><tr><td>code</td><td>cases</td></tr><tr><td colspan="2">C1</td></tr></table></body></html>',
      '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Orders"><Table><Row><Cell><Data ss:Type="String">code</Data></Cell></Row></Table></Worksheet></Workbook>',
      fods,
      `\r\n  \n${fods}`,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(fods)]),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`\n${fods}`, 'utf16le')]),
    ];
    for (const f of files) expect(await refusal(parseUpload(asExcel(f)))).toBe(WEB_PAGE);
    expect(await refusal(parseUpload(asExcel(fods, 'orders.xlsx')))).toBe(WEB_PAGE);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('SYLK, DIF, dBASE, RTF and SocialCalc files are refused as not Excel', async () => {
    const files: (string | Buffer)[] = ['ID;PWXL\nC;Y1;X1;K"code"\nE\n', 'TABLE\r\n0,1\r\n""\r\n', Buffer.from([0x03, 0x7e, 0x01, 0x01, 0, 0, 0, 0]), '{\\rtf1 code}', 'socialcalc:version:1.0\n'];
    for (const f of files) expect(await refusal(parseUpload(asExcel(f)))).toBe(NOT_EXCEL);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('a CSV sent as Excel is still read, also with a byte-order mark or as UTF-16 text (by Papa Parse since the review of 8 Oct 2026)', async () => {
    const want = [{ code: 'C1', cases: '3' }];
    expect((await parseUpload(asExcel('code,cases\nC1,3\n', 'orders.csv'))).rows).toEqual(want);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('code,cases\nC1,3\n')]);
    expect((await parseUpload(asExcel(bom, 'orders.csv'))).rows).toEqual(want);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('code\tcases\nC1\t3\n', 'utf16le')]);
    expect((await parseUpload(asExcel(utf16, 'orders.xls'))).rows).toEqual(want);
    // SheetJS guessed the type of every value of a CSV sent as Excel (11/10/2026 read month first,
    // 00123 as 123): it no longer reads CSV text (upload-csv-text.spec.ts).
    expect(readSpy).not.toHaveBeenCalled();
  });

  it(`a CSV sent as Excel has the caps of a CSV: more than ${MAX_COLS} columns, more than ${MAX_CELLS.toLocaleString('en-US')} cells refused; SheetJS never reads it`, async () => {
    // SheetJS's CSV reader tries every value as a number and a date: 5 million cells (9.5 MB) took
    // 20 s, so the guard counted a CSV sent as Excel from its separators. Since the review of 8 Oct
    // 2026 such a file is read by Papa Parse, with the caps of a CSV sent as text (P5 second review).
    expect(await refusal(parseUpload(asExcel(`a${',a'.repeat(MAX_CELLS)}`, 'orders.csv')))).toBe(
      'This file has 2,500,001 columns; at most 200 can be read. Delete the columns you do not need (also empty columns after your data) and upload again.',
    );
    const fields = (n: number, v: (c: number) => string) => Array.from({ length: n }, (_, c) => v(c)).join(',');
    const rows = [fields(100, (c) => `h${c}`), ...Array.from({ length: 25_000 }, () => fields(100, () => '1'))];
    expect(await refusal(parseUpload(asExcel(rows.join('\n'), 'orders.csv')))).toBe(
      'This file is too large to read: it has about 2,500,100 cells (rows x columns); at most 2,500,000 can be read. Split the file, or remove the columns you do not need, and upload again.',
    );
    expect(readSpy).not.toHaveBeenCalled();
  });

  it(`an .xlsx with more than ${MAX_CELLS.toLocaleString('en-US')} cells is refused before SheetJS reads it`, async () => {
    // 50 values per row, 39 MB unpacked (a 0.2 MB file): SheetJS took 9-11 s to read it.
    const sheet = denseSheet(50, 39);
    expect(sheet.cells).toBeGreaterThan(MAX_CELLS);
    const msg = await refusal(parseUpload(xlsxFile(workbook({ Orders: { deflated: sheet } }))));
    expect(msg).toBe(
      `This file is too large to read: it has about ${sheet.cells.toLocaleString('en-US')} cells (rows x columns); at most 2,500,000 can be read. Save only the sheet you need as a new workbook or as CSV and upload that.`,
    );
    expect(readSpy).not.toHaveBeenCalled();
  });

  it(`more than ${MAX_COMMENTS.toLocaleString('en-US')} comments are refused before SheetJS reads the workbook; ${MAX_COMMENTS.toLocaleString('en-US')} are read`, async () => {
    // SheetJS checks every comment already on a cell before it adds one: 20,000 on one cell took
    // 0.4 s and the time grows with the square (50 MB of them: minutes).
    expect(await refusal(parseUpload(xlsxFile(withComments(MAX_COMMENTS + 1))))).toBe(
      'This workbook has 10,001 comments or more; at most 10,000 can be read. Delete the comments (in Excel: Review, Delete), save it and upload it again.',
    );
    expect(readSpy).not.toHaveBeenCalled();
    expect((await parseUpload(xlsxFile(withComments(MAX_COMMENTS)))).rows).toHaveLength(1);
  });

  it('formatted empty cells are not counted as cells; cells with a value are', () => {
    const formatted = Array.from({ length: 1_000 }, (_, i) => `<c r="C${i + 2}" s="1"/>`).join('');
    const count = (data: string) => checkWorkbookZip(workbook({ Orders: rawSheet(data) }), LIMITS).cells;
    expect(count(`${twoRows}<row r="9">${formatted}</row>`)).toBe(6);
    // A1 v3: counted as SheetJS keeps them. <c r="A9"></c> has neither a type nor a value, and
    // SheetJS makes no cell for it (the count was 8 while every open tag counted).
    expect(count(`${twoRows}<row r="9"><c r="A9"></c><x:c r="B9"><x:v>1</x:v></x:c></row>`)).toBe(7);
  });

  it('formulas are not read: each formula cell gives its saved value (cellFormula: false)', async () => {
    // With formulas SheetJS compares every array-formula cell with every array formula before it
    // (20,000 rows: 2.6 s, growing with the square). A formula without a saved value reads as blank.
    const data =
      header +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>C2</t></is></c><c r="B2"><f>1+2</f><v>3</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>C3</t></is></c><c r="B3"><f t="array" ref="B3:B3">1+1</f></c></row>';
    const parsed = await parseUpload(xlsxFile(workbook({ Orders: rawSheet(data) })));
    expect(parsed.rows).toEqual([{ code: 'C2', cases: '3' }, { code: 'C3', cases: '' }]);
    expect(readSpy).toHaveBeenCalled();
    for (const [, opts] of readSpy.mock.calls) expect(opts).toMatchObject({ cellFormula: false });
  });
});

describe('A1 v2: a crafted compound file (.xls) is refused before its FAT is walked', () => {
  it('a descending-chain .xls of 2,000 data sectors is refused as damaged in milliseconds', async () => {
    // Without the structural check, XLSX.CFB.read walks and copies a chain from every sector:
    // about 2,000,000 sectors, ~1.1 GB over ~0.6 s (4,000 sectors: ~4 GB). It is refused as
    // damaged (no /Workbook stream) once the walk is bounded - the point is that it is refused
    // before the walk, not after it.
    const crafted = cfbDescendingChain(2_000); // about 1 MB
    const t0 = performance.now();
    expect(await refusal(parseUpload(asExcel(crafted, 'orders.xls')))).toBe(DAMAGED);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('a real .xls (ascending chains, as Excel and SheetJS write) still reads', async () => {
    expect((await parseUpload(asExcel(xlsWithLink(1, 1)))).rows).toEqual([{ code: 'C1', cases: '3' }, { code: 'C2', cases: '4' }]);
  });
});

describe('A1 v2: a CSV whose first header is "ID", sent as Excel, is read; real SYLK stays refused', () => {
  // Chrome and Edge on a Windows PC with Excel send every .csv as application/vnd.ms-excel, so an
  // order, customer or baseline CSV with a leading "ID" column arrives on the Excel path. SheetJS
  // reads it as CSV (read_wb_ID falls back to its CSV reader); the guard must not refuse it.
  it('a comma CSV starting with "ID" reads its rows (key "id")', async () => {
    const parsed = await parseUpload(asExcel('ID,Customer Code,Product Code,Cases\n1,C1,P1,5\n2,C2,P2,7\n', 'orders.csv'));
    expect(parsed.rows).toEqual([
      { id: '1', 'customer code': 'C1', 'product code': 'P1', cases: '5' },
      { id: '2', 'customer code': 'C2', 'product code': 'P2', cases: '7' },
    ]);
  });

  it('a tab file, an "IDNo" header and a semicolon CSV starting with "ID" are all read, not refused', async () => {
    expect((await parseUpload(asExcel('ID\tcode\tname\n1\tC1\tShop\n', 'orders.csv'))).rows).toEqual([{ id: '1', code: 'C1', name: 'Shop' }]);
    expect((await parseUpload(asExcel('IDNo,code,name\n7,CAT1,Shop\n', 'customers.csv'))).rows).toEqual([{ idno: '7', code: 'CAT1', name: 'Shop' }]);
    expect((await parseUpload(asExcel('ID;Customer Code;Cases\n1;C1;5\n', 'orders.csv'))).rows).toEqual([{ id: '1', 'customer code': 'C1', cases: '5' }]);
  });

  it('a real SYLK file (an ID record then a SYLK record) is still refused as not Excel', async () => {
    expect(await refusal(parseUpload(asExcel('ID;PWXL\nP;PGeneral\nC;Y1;X1;K"code"\nE\n', 'orders.xls')))).toBe(NOT_EXCEL);
    expect(await refusal(parseUpload(asExcel('ID;PWXL\nC;Y1;X1;K"code"\nE\n', 'orders.xls')))).toBe(NOT_EXCEL);
  });
});

describe('A1 review: a blank formatted sheet is not a sheet with data', () => {
  // Sheet1 has no value, only a used range to row 60,000 (formatting); the list is on sheet 2.
  const blankFirst = () =>
    workbook({
      Sheet1: rawSheet('<row r="60000"><c r="H60000" s="1"/></row>', { before: '<dimension ref="A1:H60000"/>' }),
      Customers: rawSheet(row(1, ['A', 'code'], ['B', 'name']) + [2, 3, 4].map((r) => row(r, ['A', `C${r}`], ['B', `Customer ${r}`])).join('')),
    });

  it('a customer import or baseline (no sheet test) reads the list, as before A1, without a warning', async () => {
    const parsed = await parseUpload(xlsxFile(blankFirst(), 'customers.xlsx'));
    expect(parsed).toMatchObject({ sheetName: 'Customers', warnings: [] });
    expect(parsed.rows).toHaveLength(3);
  });

  it('an upload that picks its sheet by columns reads the list and names no blank sheet', async () => {
    const parsed = await parseUpload(xlsxFile(blankFirst()), { isDataSheet: (h) => h.includes('code') && h.includes('name'), rowsWord: 'customer' });
    expect(parsed).toMatchObject({ sheetName: 'Customers', warnings: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// A1 v3 review (28 Sep 2026): five findings, each confirmed by two reviewers with their own files.
// ---------------------------------------------------------------------------------------------

describe('A1 v3: a file that begins with "ID" is refused only when SheetJS reads it as SYLK or its SYLK reader works long', () => {
  // SheetJS runs its SYLK reader on every file that begins with "ID" and reads the file as CSV
  // once that reader throws: at the first record or field it does not know. What it did before
  // that is done for real (a row field grows its sheet to that row).
  it('a semicolon CSV whose first ID is a SYLK record letter ("C", "F", "E", "B") is read as SheetJS reads it', async () => {
    // Before: the second line's first field ("C", "F", ...) was taken for a SYLK record, and the
    // file was refused as "not an Excel workbook"; SheetJS reads each of these as CSV.
    const read = async (csv: string) => (await parseUpload(asExcel(csv, 'orders.csv'))).rows;
    expect(await read('ID;Code;Qty\nC;5;10\n')).toEqual([{ id: 'C', code: '5', qty: '10' }]);
    expect(await read('ID;Grade;Score\nF;maths;40\n')).toEqual([{ id: 'F', grade: 'maths', score: '40' }]);
    expect(await read('ID;Code;Qty\r\nC;5;10\r\nA;7;8\r\n')).toEqual([
      { id: 'C', code: '5', qty: '10' },
      { id: 'A', code: '7', qty: '8' },
    ]);
    expect(await read('ID;Code;Qty\nC;Customer;10\n')).toEqual([{ id: 'C', code: 'Customer', qty: '10' }]);
    // A first data row that is a whole SYLK record: the reader gives up on the next one.
    expect(await read('ID;Code;Qty\nE;5;10\n1;x;2\n')).toEqual([
      { id: 'E', code: '5', qty: '10' },
      { id: '1', code: 'x', qty: '2' },
    ]);
    expect(await read('ID;Code;Qty\nB;5;10\nC;6;11\n')).toEqual([
      { id: 'B', code: '5', qty: '10' },
      { id: 'C', code: '6', qty: '11' },
    ]);
  });

  it('a file whose SYLK reader would grow its sheet to millions of rows before it gives up is refused in milliseconds', async () => {
    // Each passed the check of the first two records and SheetJS then allocated the rows
    // (reviewers: 5,000,000 rows 0.5-0.8 s and 0.7-1.1 GB; 20,000,000 ran out of memory).
    const files = [
      `ID\n${'\n'.repeat(5_000)}C;Y2000000;X1;K1\nE\n`, // the second record was past the first 4,096 bytes
      `ID;${'P'.repeat(5_000)}\nC;Y2000000;X1;K1\nE\n`, // so was the end of the first
      'ID\n\u001b$3;Y2000000;X1;K1\nE\n', // ESC "$3" is SheetJS's escape for "C"
      'ID\nC;Y2000000;X1;K1\nnot SYLK\n', // a SYLK record, then CSV
      'ID\nF;W1 90000000 10\nnot SYLK\n', // column widths over 90 million columns, then CSV
    ];
    const t0 = performance.now();
    for (const f of files) expect(await refusal(parseUpload(asExcel(f, 'orders.csv')))).toBe(NOT_EXCEL);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('a SYLK record with a small row, then CSV, is read as CSV; a real SYLK file stays refused', async () => {
    // Read as CSV by Papa Parse since the review of 8 Oct 2026 (SheetJS's SYLK and CSV readers no
    // longer see CSV text): the values past the header's two columns are kept together, as for any
    // CSV, and named in a warning.
    const parsed = await parseUpload(asExcel('ID;P\nC;Y1;X1;K1\n1;2;3\n', 'orders.csv'));
    expect(parsed.rows).toEqual([
      { id: 'C', p: 'Y1', __parsed_extra: 'X1,K1' },
      { id: '1', p: '2', __parsed_extra: '3' },
    ]);
    // Named by their file rows (review web-intake-4): Papa's own count starts at 0 with the header left out.
    expect(parsed.warnings).toEqual(['CSV parse warning at row 2: Too many fields: expected 2 fields but parsed 4', 'CSV parse warning at row 3: Too many fields: expected 2 fields but parsed 3']);
    expect(readSpy).not.toHaveBeenCalled();
    expect(await refusal(parseUpload(asExcel('ID;PWXL;N;E\nC;Y1;X1;K"a"\nC;Y2;X1;K5\nE\n', 'orders.xls')))).toBe(NOT_EXCEL);
  });
});

describe('A1 v3: number formats are not applied to the cells (cellText: false)', () => {
  it('a long number format on every number cell: SheetJS makes no display text; values and headers read as before', async () => {
    // SheetJS parsed the cell's format again for every number cell to make display text the
    // upload never uses: one 255-character format on 50,000 rows x 44 cells (a 162 KB file within
    // every cap) ran the process out of memory at about 4 GB.
    const bytes = withNumberFormat(2_000, 10, `0${'!'.repeat(254)}`);
    const t0 = performance.now();
    const parsed = await parseUpload(xlsxFile(bytes));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(parsed.rows).toHaveLength(2_000);
    expect(parsed.rows[0]).toMatchObject({ c0: '200', c1: '201', c9: '209' });
    // The workbook SheetJS made: the number cells carry their value and no display text.
    const wb = readSpy.mock.results.at(-1)!.value as XLSX.WorkBook;
    expect(wb.Sheets.Orders!.B2).toEqual({ t: 'n', v: 201 });
    for (const [, opts] of readSpy.mock.calls) expect(opts).toMatchObject({ cellText: false });
  });
});

describe('A1 v3: metadata entries and comment authors are counted before SheetJS reads the workbook', () => {
  const metadata = (n: number) =>
    `This workbook has ${n.toLocaleString('en-US')} metadata entries or more; at most ${MAX_METADATA.toLocaleString('en-US')} can be read. Save only the sheet you need as a new workbook or as CSV and upload that.`;
  const authors = (n: number) =>
    `This workbook lists ${n.toLocaleString('en-US')} comment authors or more; at most ${MAX_PEOPLE.toLocaleString('en-US')} can be read. Save only the sheet you need as a new workbook or as CSV and upload that.`;

  it(`more than ${MAX_METADATA.toLocaleString('en-US')} metadata types and blocks are refused before SheetJS reads the workbook; ${MAX_METADATA.toLocaleString('en-US')} are read`, async () => {
    expect(await refusal(parseUpload(xlsxFile(withMetadata(MAX_METADATA + 1))))).toBe(metadata(MAX_METADATA + 1));
    expect(readSpy).not.toHaveBeenCalled();
    expect((await parseUpload(xlsxFile(withMetadata(MAX_METADATA)))).rows).toHaveLength(1);
  });

  it('a 10 KB workbook with 20,000 metadata types and blocks is refused in milliseconds', async () => {
    // SheetJS looks through every type for each block: this file took about 4 s, 100,000 of each
    // (15 KB) 28 s, and 1,000,000 of each fit under the 50 MB cap (about an hour).
    const bytes = withMetadata(20_000);
    expect(bytes.length).toBeLessThan(12_000);
    const t0 = performance.now();
    expect(await refusal(parseUpload(xlsxFile(bytes)))).toBe(metadata(20_000));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it(`a person list of more than ${MAX_PEOPLE.toLocaleString('en-US')} is refused before SheetJS reads the workbook; ${MAX_PEOPLE.toLocaleString('en-US')} are read`, async () => {
    expect(await refusal(parseUpload(xlsxFile(withPeople(MAX_PEOPLE + 1, 10))))).toBe(authors(MAX_PEOPLE + 1));
    expect(readSpy).not.toHaveBeenCalled();
    expect((await parseUpload(xlsxFile(withPeople(MAX_PEOPLE, 10)))).rows).toHaveLength(1);
  });

  it('2,000 threaded comments by an author missing from a list of 100,000 people (26 KB) are refused in milliseconds', async () => {
    // SheetJS looks up each threaded comment's author in the whole list: this file took about
    // 1.3 s; 9,900 comments and 2.9 million people (142 KB) took 109 s.
    const t0 = performance.now();
    expect(await refusal(parseUpload(xlsxFile(withPeople(100_000, 2_000))))).toBe(authors(100_000));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(readSpy).not.toHaveBeenCalled();
  });
});

describe('A1 v3: every cell SheetJS keeps is counted, also one whose tag closes itself', () => {
  it('each way SheetJS keeps a piece of a row as a cell is counted as one cell; a formatted empty cell is not', () => {
    // SheetJS keeps a piece when its tag has a type or a <v> value follows the tag.
    const variants: [string, string, number][] = [
      ['a type on a tag that closes itself', '<c r="C2" t="b"/>', 1],
      ['a type without quotes', '<c r="C2" t=b/>', 1],
      ['a type after "<c/"', '<c/t=b>', 1],
      ['a type in capitals', '<c r="C2" T="e"/>', 1],
      ['a type with a namespace prefix', '<c r="C2" x:t="b"/>', 1],
      ['a type with a "_" suffix', '<c r="C2" t_x="b"/>', 1],
      ['a namespaced tag with a type', '<x:c r="C2" t="str"/>', 1],
      ['a value after "<c/>"', '<c/><v>1</v>', 1],
      ['a value after a tag that closes itself', '<c r="C2" s="1"/><v>1</v>', 1],
      ['a type in the text before the first cell', 't="b"<c r="C2" s="1"/>', 1],
      ['a formatted empty cell', '<c r="C2" s="1"/>', 0],
      ['an empty cell that does not close itself', '<c r="C2"></c>', 0],
    ];
    const base = row(1, ['A', 'code'], ['B', 'cases']);
    for (const [what, cell, extra] of variants) {
      const bytes = workbook({ Orders: rawSheet(`${base}<row r="2">${cell}</row>`) });
      const ws = XLSX.read(bytes, { type: 'buffer', cellFormula: false }).Sheets.Orders!;
      const made = Object.keys(ws).filter((k) => !k.startsWith('!')).length;
      expect([what, made]).toEqual([what, 2 + extra]);
      expect([what, checkWorkbookZip(bytes, LIMITS).cells]).toEqual([what, 2 + extra]);
    }
  });

  it(`more than ${MAX_CELLS.toLocaleString('en-US')} typed empty cells (<c t="b"/>, each a FALSE cell) are refused before SheetJS reads them`, async () => {
    // Uncounted before: 4.5 million of them (a 133 KB file) took SheetJS 15-19 s and 1.1 GB, and
    // were refused only after it had made every cell.
    const sheet = denseSheet(50, 26, '<c t="b"/>');
    expect(sheet.cells).toBeGreaterThan(MAX_CELLS);
    const t0 = performance.now();
    expect(await refusal(parseUpload(xlsxFile(workbook({ Orders: { deflated: sheet } }))))).toBe(
      `This file is too large to read: it has about ${sheet.cells.toLocaleString('en-US')} cells (rows x columns); at most 2,500,000 can be read. Save only the sheet you need as a new workbook or as CSV and upload that.`,
    );
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(readSpy).not.toHaveBeenCalled();
  });
});

describe('A1 v4: each sheet of a workbook reads its own worksheet part', () => {
  const sheet = rawSheet(row(1, ['A', 'code'], ['B', 'cases']) + row(2, ['A', 'C1'], ['B', 3]));
  const part = { name: 'xl/worksheets/sheet1.xml', data: sheet };
  const two = [
    { name: 'A', rid: 'rId1' },
    { name: 'B', rid: 'rId2' },
  ];
  const first = { id: 'rId1', target: 'worksheets/sheet1.xml' };
  // Each makes SheetJS read xl/worksheets/sheet1.xml for both sheets (checked below with SheetJS).
  const aliases: [string, Buffer][] = [
    ['one relationship for both sheets', handWorkbook([{ name: 'A', rid: 'rId1' }, { name: 'B', rid: 'rId1' }], [first], [part])],
    ['two relationships, one target', handWorkbook(two, [first, { id: 'rId2', target: 'worksheets/sheet1.xml' }], [part])],
    ['a target from the root', handWorkbook(two, [first, { id: 'rId2', target: '/xl/worksheets/sheet1.xml' }], [part])],
    ['a target with the "xl/" folder', handWorkbook(two, [first, { id: 'rId2', target: 'xl/worksheets/sheet1.xml' }], [part])],
    ['a target in capitals', handWorkbook(two, [first, { id: 'rId2', target: 'WORKSHEETS/Sheet1.XML' }], [part])],
    ['a target with a backslash', handWorkbook(two, [first, { id: 'rId2', target: 'worksheets\\sheet1.xml' }], [part])],
    [
      'a workbook in its own folder, the part found next to it',
      handWorkbook(two, [{ id: 'rId1', target: 'sheet1.xml' }, { id: 'rId2', target: 'SHEET1.xml' }], [{ name: 'wb/sheet1.xml', data: sheet }], { workbookPart: 'wb/workbook.xml' }),
    ],
  ];

  it('two sheets that name one worksheet part are refused as damaged before SheetJS reads the file', async () => {
    for (const [what, bytes] of aliases) {
      // SheetJS itself reads the one part once for each sheet.
      const wb = XLSX.read(bytes, { type: 'buffer' });
      expect([what, wb.SheetNames, wb.Sheets.A?.A2?.v, wb.Sheets.B?.A2?.v]).toEqual([what, ['A', 'B'], 'C1', 'C1']);
      readSpy.mockClear();
      expect([what, await refusal(parseUpload(xlsxFile(bytes)))]).toEqual([what, DAMAGED]);
      expect(readSpy).not.toHaveBeenCalled();
    }
  });

  it('ten sheets naming one part of 49 columns (a 30 KB upload) are refused in milliseconds; one sheet naming it is read', async () => {
    // Measured before the fix: 10,000 rows x 49 columns named by ten sheets took 14-18 s and about
    // 1 GB before the range check refused it (1.1-2.5 s for one sheet); 50,000 rows took 94-108 s
    // and 3.4 GB, or ran out of memory with a 2 GB heap.
    const ws = denseSheet(49, 4);
    const named = (n: number) =>
      handWorkbook(Array.from({ length: n }, (_, i) => ({ name: `S${i + 1}`, rid: 'rId1' })), [first], [{ name: 'xl/worksheets/sheet1.xml', deflated: ws }]);
    expect(named(10).length).toBeLessThan(30_000);
    const t0 = performance.now();
    expect(await refusal(parseUpload(xlsxFile(named(10))))).toBe(DAMAGED);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(readSpy).not.toHaveBeenCalled();
    expect(parseExcelSheets(named(1))[0]!.rows.length).toBeGreaterThan(5_000);
  });

  it('sheets that each name their own part, however the target is written, are read as before', () => {
    const other = rawSheet(row(1, ['A', 'code'], ['B', 'cases']) + row(2, ['A', 'C2'], ['B', 4]));
    const bytes = handWorkbook(two, [{ id: 'rId1', target: '/xl/worksheets/sheet1.xml' }, { id: 'rId2', target: 'WORKSHEETS\\Sheet2.XML' }], [
      part,
      { name: 'xl/worksheets/sheet2.xml', data: other },
    ]);
    expect(parseExcelSheets(bytes).map((s) => [s.name, s.rows[0]!.code])).toEqual([
      ['A', 'C1'],
      ['B', 'C2'],
    ]);
  });

  it('the sheet list is read as SheetJS reads it (namespaces, quotes, escapes, UTF-8); a list SheetJS reads otherwise is refused', async () => {
    const tags =
      '<x:sheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="One" sheetId="1" r:id="rId1"/>' +
      "<sheet name='Two' sheetId='2' id='rId2'/>" +
      '<sheet name="Th&amp;ree_x0021_ Caf\u00e9" sheetId="3" r:id="rId3" />';
    const parts = [1, 2, 3].map((i) => ({ name: `xl/worksheets/sheet${i}.xml`, data: sheetXml(1) }));
    const hand = handWorkbook([], [1, 2, 3].map((i) => ({ id: `rId${i}`, target: `worksheets/sheet${i}.xml` })), parts, { sheetTags: tags });
    const one = () => XLSX.utils.aoa_to_sheet(listRows(1));
    const written = sheetjsWorkbook({ Orders: one(), 'A & B': one(), 'Caf\u00e9 \u03a9': one() });
    for (const bytes of [hand, written]) {
      expect(checkWorkbookZip(bytes, LIMITS).sheetNames).toEqual(XLSX.read(bytes, { type: 'buffer', bookSheets: true }).SheetNames);
    }
    expect(checkWorkbookZip(hand, LIMITS).sheetNames).toEqual(['One', 'Two', 'Th&ree! Caf\u00e9']);
    expect(parseExcelSheets(hand).map((s) => s.name)).toEqual(['One', 'Two', 'Th&ree! Caf\u00e9']);
    // Should SheetJS ever read another list than the guard, nothing is read.
    readSpy.mockClear();
    readSpy.mockImplementationOnce(() => ({ SheetNames: ['One', 'Two'] }) as unknown as XLSX.WorkBook);
    expect(await refusal(parseUpload(xlsxFile(hand)))).toBe(DAMAGED);
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});

describe('A1 v4: a part SheetJS reads again for a sheet is counted again', () => {
  const sheet = rawSheet(row(1, ['A', 'code'], ['B', 'cases']) + row(2, ['A', 'C1'], ['B', 3]));
  const comments = (n: number) =>
    `This workbook has ${n.toLocaleString('en-US')} comments or more; at most ${MAX_COMMENTS.toLocaleString('en-US')} can be read. Delete the comments (in Excel: Review, Delete), save it and upload it again.`;
  const READ_AGAIN =
    'This workbook is too large to read: its sheets read the same parts again, more than 50 MB in all. Save only the sheet you need as a new workbook or as CSV and upload that.';
  /** `n` spellings of "../comments1.xml" that differ only in capitals: one part for SheetJS. */
  const spellings = (n: number) =>
    Array.from({ length: n }, (_, i) => `../${[...'comments1.xml'].map((c, b) => (b < 8 && i & (1 << b) ? c.toUpperCase() : c)).join('')}`);
  const commentedSheet = (targets: string[], n: number) =>
    handWorkbook([{ name: 'Orders', rid: 'rId1' }], [{ id: 'rId1', target: 'worksheets/sheet1.xml' }], [
      { name: 'xl/worksheets/sheet1.xml', data: sheet },
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: relsXml(targets.map((target, i) => ({ id: `rId${i + 1}`, type: RELS.comments, target }))) },
      { name: 'xl/comments1.xml', data: commentsXml(n) },
    ]);
  /** `n` sheets, each with its own worksheet part and relationships, all naming the same part `shared` for `type`. */
  const sharing = (n: number, type: string, shared: { name: string; data: Buffer }, ws = sheet) =>
    handWorkbook(
      Array.from({ length: n }, (_, i) => ({ name: `S${i + 1}`, rid: `rId${i + 1}` })),
      Array.from({ length: n }, (_, i) => ({ id: `rId${i + 1}`, target: `worksheets/sheet${i + 1}.xml` })),
      [
        ...Array.from({ length: n }, (_, i) => [
          { name: `xl/worksheets/sheet${i + 1}.xml`, data: ws },
          { name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: relsXml([{ id: 'rId1', type, target: `../${shared.name.slice(3)}` }]) },
        ]).flat(),
        shared,
      ],
    );

  it('a comments part a sheet names several times (in capitals and small letters) is counted each time', async () => {
    // SheetJS reads the part once for each spelling and adds its comments again each time.
    const ws = XLSX.read(commentedSheet(spellings(3), 2), { type: 'buffer' }).Sheets.Orders!;
    expect((ws.B2 as XLSX.CellObject).c).toHaveLength(6);
    readSpy.mockClear();
    expect(await refusal(parseUpload(xlsxFile(commentedSheet(spellings(6), 2_000))))).toBe(comments(12_000));
    expect(readSpy).not.toHaveBeenCalled();
    expect(await parseUpload(xlsxFile(commentedSheet(spellings(5), 2_000)))).toMatchObject({ rows: [{ code: 'C1' }] });
  });

  it('a 3 KB file whose sheet names one comments part 20 times is refused in milliseconds', async () => {
    // SheetJS checks every comment already on a cell before adding one: 20 x 5,000 comments on one
    // cell took 8.8 s before the fix, and 256 spellings of 10,000 comments would take hours.
    const bytes = commentedSheet(spellings(20), 5_000);
    expect(bytes.length).toBeLessThan(4_000);
    const t0 = performance.now();
    expect(await refusal(parseUpload(xlsxFile(bytes)))).toBe(comments(15_000));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('a comments part two sheets name is counted for each sheet', async () => {
    const shared = (n: number) => sharing(2, RELS.comments, { name: 'xl/comments1.xml', data: commentsXml(n) });
    expect(await refusal(parseUpload(xlsxFile(shared(6_000))))).toBe(comments(12_000));
    expect(readSpy).not.toHaveBeenCalled();
    expect(parseExcelSheets(shared(5_000)).map((s) => s.name)).toEqual(['S1', 'S2']);
  });

  it('a drawing of notes (VML) shared by ten sheets is counted for each sheet: 6.5 MB shared by ten is refused', async () => {
    // Measured before the fix: a 51 MB drawing of 400,000 notes shared by ten sheets (a 1.1 MB
    // upload) took 58 s; one sheet reading it 4.3 s.
    const shared = (n: number, notes: number) =>
      sharing(n, RELS.vmlDrawing, { name: 'xl/drawings/vmlDrawing1.vml', data: vmlNotes(notes) }, sheetWithLegacyDrawing('rId1'));
    // SheetJS reads the drawing for each sheet: each sheet gets a cell for every note.
    const wb = XLSX.read(shared(2, 3), { type: 'buffer' });
    expect([wb.Sheets.S1!.B4, wb.Sheets.S2!.B4]).toEqual([{ t: 'z' }, { t: 'z' }]);
    readSpy.mockClear();
    const ten = shared(10, 50_000);
    const t0 = performance.now();
    expect(await refusal(parseUpload(xlsxFile(ten)))).toBe(READ_AGAIN);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(readSpy).not.toHaveBeenCalled();
    expect(parseExcelSheets(shared(1, 50_000)).map((s) => s.name)).toEqual(['S1']);
  });

  it('an external link listed again and again in [Content_Types].xml is counted each time', async () => {
    // SheetJS reads the link part (and its relationships) once for every listing, in both passes.
    const LINK = 'application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml';
    const link = Buffer.from(`<externalLink>${'<x/>'.repeat(250_000)}</externalLink>`);
    const listed = (n: number) =>
      handWorkbook(
        [{ name: 'Orders', rid: 'rId1' }],
        [{ id: 'rId1', target: 'worksheets/sheet1.xml' }],
        [
          { name: 'xl/worksheets/sheet1.xml', data: sheet },
          { name: 'xl/externalLinks/externalLink1.xml', data: link },
          { name: 'xl/externalLinks/_rels/externalLink1.xml.rels', data: relsXml([]) },
        ],
        { types: Array.from({ length: n }, () => ({ part: '/xl/externalLinks/externalLink1.xml', type: LINK })) },
      );
    expect(await refusal(parseUpload(xlsxFile(listed(60))))).toBe(READ_AGAIN);
    expect(readSpy).not.toHaveBeenCalled();
    expect((await parseUpload(xlsxFile(listed(1)))).rows).toHaveLength(1);
  });
});

describe("A1 v4: a workbook's sheets must be worksheets", () => {
  const NOT_A_WORKSHEET =
    'This workbook has a chart sheet (or a dialog or macro sheet), which cannot be read. Delete that sheet, or save only the sheet you need as a new workbook or as CSV, and upload that.';
  const sheet = rawSheet(row(1, ['A', 'code'], ['B', 'cases']) + row(2, ['A', 'C1'], ['B', 3]));
  const withSheet = (type: string) =>
    handWorkbook(
      [{ name: 'Orders', rid: 'rId1' }, { name: 'Chart1', rid: 'rId2' }],
      [{ id: 'rId1', target: 'worksheets/sheet1.xml' }, { id: 'rId2', type, target: 'chartsheets/sheet1.xml' }],
      [{ name: 'xl/worksheets/sheet1.xml', data: sheet }, ...chartSheetParts(3)],
    );

  it('a chart sheet is refused before SheetJS reads it (it makes a cell for each point of the chart, past the row limit and every cap)', async () => {
    // Measured before the fix: a chart of 1,300,000 points (a 3.1 MB upload; the guard counted 1
    // cell) read as a sheet of 1.3 million rows in 5.5 s and 1 GB; one point at index 4,294,967,294
    // (a 1.7 KB upload) blocked the app for about 3 minutes.
    const wb = XLSX.read(withSheet(RELS.chartsheet), { type: 'buffer' });
    expect([wb.Sheets.Chart1!['!ref'], wb.Sheets.Chart1!.A3]).toEqual(['A1:A3', { t: 'n', v: 3, z: 'General' }]);
    readSpy.mockClear();
    expect(await refusal(parseUpload(xlsxFile(withSheet(RELS.chartsheet))))).toBe(NOT_A_WORKSHEET);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('dialog and macro sheets are refused too', async () => {
    for (const type of [RELS.dialogsheet, RELS.macrosheet]) {
      expect(await refusal(parseUpload(xlsxFile(withSheet(type))))).toBe(NOT_A_WORKSHEET);
    }
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('a chart placed on a worksheet (a drawing) is read as before', async () => {
    const ws = Buffer.from(
      rawSheet(row(1, ['A', 'code'], ['B', 'cases']) + row(2, ['A', 'C1'], ['B', 3]), { after: '<drawing r:id="rId1"/>' })
        .toString('utf8')
        .replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '),
    );
    const bytes = handWorkbook([{ name: 'Orders', rid: 'rId1' }], [{ id: 'rId1', target: 'worksheets/sheet1.xml' }], [
      { name: 'xl/worksheets/sheet1.xml', data: ws },
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: relsXml([{ id: 'rId1', type: RELS.drawing, target: '../drawings/drawing1.xml' }]) },
      ...chartSheetParts(3).filter((p) => !p.name.startsWith('xl/chartsheets/')),
    ]);
    expect(await parseUpload(xlsxFile(bytes))).toMatchObject({ rows: [{ code: 'C1', cases: '3' }], warnings: [] });
  });
});

describe('A1 v5: a sheet SheetJS finds by its number is counted on the part SheetJS reads', () => {
  const sheet = rawSheet(row(1, ['A', 'code'], ['B', 'cases']) + row(2, ['A', 'C1'], ['B', 3]));
  const comments = (n: number) =>
    `This workbook has ${n.toLocaleString('en-US')} comments or more; at most ${MAX_COMMENTS.toLocaleString('en-US')} can be read. Delete the comments (in Excel: Review, Delete), save it and upload it again.`;
  /** `n` spellings of "../comments1.xml" that differ only in capitals: one part for SheetJS. */
  const spellings = (n: number) =>
    Array.from({ length: n }, (_, i) => `../${[...'comments1.xml'].map((c, b) => (b < 8 && i & (1 << b) ? c.toUpperCase() : c)).join('')}`);
  /**
   * `sheets` sheets that the workbook's relationships do not name (it has none), so SheetJS finds
   * each one's part by its number: xl/worksheets/sheet1.xml, sheet2.xml, ... or, when
   * xl/worksheets/sheet.xml holds text as SheetJS reads it (its "Numbers iOS" numbering),
   * sheet.xml, sheet1.xml, ... The relationships of the last part, sheet{sheets}.xml, name
   * xl/comments1.xml (`n` comments) once for each of `targets`. `numbers` is the sheet.xml part.
   */
  const byNumber = (numbers: Buffer | null, sheets: number, targets: string[], n: number) =>
    handWorkbook(
      Array.from({ length: sheets }, (_, i) => ({ name: `S${i + 1}`, rid: `rId${i + 1}` })),
      [],
      [
        ...(numbers ? [{ name: 'xl/worksheets/sheet.xml', data: numbers }] : []),
        ...Array.from({ length: sheets }, (_, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheet })),
        {
          name: `xl/worksheets/_rels/sheet${sheets}.xml.rels`,
          data: relsXml(targets.map((target, i) => ({ id: `rId${i + 1}`, type: RELS.comments, target }))),
        },
        { name: 'xl/comments1.xml', data: commentsXml(n) },
      ],
    );
  /** sheet.xml parts whose text, as SheetJS reads it (a UTF-16 byte-order mark is decoded), is empty. */
  const noText: [string, Buffer][] = [
    ['a UTF-16 byte-order mark alone (FF FE)', Buffer.from([0xff, 0xfe])],
    ['a big-endian mark as SheetJS tests it (00 FE FF)', Buffer.from([0x00, 0xfe, 0xff])],
    ['a mark and half a character (FF FE 41)', Buffer.from([0xff, 0xfe, 0x41])],
  ];

  it('SheetJS numbers from xl/worksheets/sheet.xml only when it holds text as SheetJS reads it; the guard counts the part SheetJS reads', () => {
    const variants: [string, Buffer][] = [
      ['empty', Buffer.alloc(0)],
      ...noText,
      ['a mark and one character (FF FE 00 00)', Buffer.from([0xff, 0xfe, 0, 0])],
      ['a space', Buffer.from(' ')],
      ['a worksheet', sheet],
    ];
    for (const sheets of [1, 2]) {
      const seen = variants.map(([what, numbers]) => {
        const bytes = byNumber(numbers, sheets, spellings(3), 2);
        // SheetJS read the last numbered part (and its comments part three times) when the last
        // sheet's B2 has the 6 comments.
        const b2 = XLSX.read(bytes, { type: 'buffer' }).Sheets[`S${sheets}`]?.B2 as XLSX.CellObject | undefined;
        const g = checkWorkbookZip(bytes, LIMITS);
        return [sheets, what, b2?.c?.length === 6, g.readBytes > g.unpackedBytes];
      });
      // SheetJS's own numbering, and the guard counting the comments again exactly when SheetJS read them.
      expect(seen).toEqual(variants.map(([what], i) => [sheets, what, i < 4, i < 4]));
    }
  });

  it('a 3.5 KB file with a byte-order mark as xl/worksheets/sheet.xml is refused for its comments in milliseconds, as without that part', async () => {
    // Measured before the fix: the FF FE part made the guard count the comments of sheet.xml's
    // relationships (there are none) instead of sheet1.xml's, so 20 reads of 5,000 comments passed
    // and SheetJS blocked the app for 10-22 s putting 100,000 comments on one cell.
    for (const [what, numbers] of [['no sheet.xml part', null] as [string, null], ...noText]) {
      for (const sheets of [1, 2]) {
        const bytes = byNumber(numbers, sheets, spellings(20), 5_000);
        expect(bytes.length).toBeLessThan(4_500);
        readSpy.mockClear();
        const t0 = performance.now();
        expect([what, sheets, await refusal(parseUpload(xlsxFile(bytes)))]).toEqual([what, sheets, comments(15_000)]);
        expect(performance.now() - t0).toBeLessThan(500);
        expect(readSpy).not.toHaveBeenCalled();
      }
    }
    // Within the caps the numbered sheets are read as before.
    expect((await parseUpload(xlsxFile(byNumber(noText[0]![1], 1, spellings(1), 2)))).rows).toEqual([{ code: 'C1', cases: '3' }]);
  });

  it('xl/workbook.xml is taken for the workbook part only when it holds text as SheetJS reads it', () => {
    // [Content_Types].xml names no workbook part and lists an external link twice; SheetJS then
    // looks for xl/workbook.xml, finds only a byte-order mark and stops before reading any link.
    const LINK = 'application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml';
    const bytes = zip([
      {
        name: '[Content_Types].xml',
        data: Buffer.from(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            `<Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="${LINK}"/>`.repeat(2) +
            '</Types>',
        ),
      },
      { name: 'xl/workbook.xml', data: Buffer.from([0xff, 0xfe]) },
      { name: 'xl/externalLinks/externalLink1.xml', data: Buffer.from('<externalLink/>') },
      { name: 'xl/externalLinks/_rels/externalLink1.xml.rels', data: relsXml([]) },
    ]);
    expect(() => XLSX.read(bytes, { type: 'buffer' })).toThrow('Could not find workbook');
    const g = checkWorkbookZip(bytes, LIMITS);
    expect([g.sheetNames, g.readBytes]).toEqual([[], g.unpackedBytes]);
  });
});

// ---------------------------------------------------------------------------------------------
// A5 fifth review: the customer import reads the decimals written in a CSV sent as Excel (cellText),
// and did not for any file whose first record is "ID", so a semicolon CSV with a leading "ID" column
// lost its trailing zeros only when the browser sent it as Excel. SheetJS's SYLK reader, which such a
// file goes through first, formats a value with cellText only after a format record: a CSV never
// has one, and a file that does is still read without cellText (the guard's replay says which).
// ---------------------------------------------------------------------------------------------

describe('A5 fifth review: a file that begins with "ID", read for the customer import (lat / lng decimals)', () => {
  const decimals = { decimalTextColumns: ['lat', 'lng'] };
  const cellTextReads = () => readSpy.mock.calls.filter(([, o]) => (o as { cellText?: boolean }).cellText === true).length;

  it('a CSV whose first header is "ID" is read with its cells\' own text, like any other CSV sent as Excel', async () => {
    const parsed = await parseUpload(asExcel('ID;code;lat;lng\n1;C1;23.5850;58.4150\n', 'customers.csv'), decimals);
    expect(parsed.rows).toEqual([{ id: '1', code: 'C1', lat: '23.5850', lng: '58.4150' }]);
    // Since the review of 8 Oct 2026 by Papa Parse, which keeps every value's text, not by SheetJS
    // with cellText (upload-csv-text.spec.ts).
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('a file whose SYLK reader formats a value before it reads the file as CSV is read without the cells\' text, as without the decimal columns', async () => {
    // With cellText, SheetJS formats K23.585 with the format "[h" and throws a string, which its
    // read_wb_ID does not catch: "Cannot read properties of undefined (reading 'indexOf')".
    const file = 'ID;PWXL\nP;P[h\nF;P0;X1\nC;Y1;X1;K23.585\nnot;sylk\n';
    expect(() => XLSX.read(Buffer.from(file), { type: 'buffer', cellText: true })).toThrow(/indexOf/);
    readSpy.mockClear();
    const withDecimals = await parseUpload(asExcel(file, 'customers.csv'), decimals);
    expect(cellTextReads()).toBe(0);
    expect(withDecimals.rows).toEqual((await parseUpload(asExcel(file, 'customers.csv'))).rows);
  });

  it('the most formatting such a file can ask for within the guard is not done: read in milliseconds, no cell formatted', async () => {
    // As many formatted values as the guard's SYLK budget allows (each costs its format twice).
    const body = `ID\nP;P0.0000\n${'F;P0;X1\nC;Y1;X1;K1\n'.repeat(7_000)}not;sylk\n`;
    const t0 = performance.now();
    const parsed = await parseUpload(asExcel(body, 'customers.csv'), decimals);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(cellTextReads()).toBe(0);
    expect(parsed.rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// P5 second review: a CSV sent as text (read by Papa Parse, not SheetJS) had no column or cell cap.
// One row of a million columns (a 7.6 MB file) was read, came back to the web process as one object
// of a million keys, held 70-130 MB there and blocked it for 1-2 s; 1,000 rows of 4,000 columns
// held 188 MB. A1's caps apply to it now, with the words of the Excel path.
// ---------------------------------------------------------------------------------------------

describe('P5 second review: a CSV sent as text has the column and cell caps too', () => {
  const csv = (text: string) => new File([text], 'orders.csv', { type: 'text/csv' });
  const fields = (n: number, value: (c: number) => string) => Array.from({ length: n }, (_, c) => value(c)).join(',');
  const WIDE = (n: number, row?: number) =>
    `${row === undefined ? 'This file has' : `Row ${row} of this file has`} ${n.toLocaleString('en-US')} columns; at most 200 can be read. ` +
    'Delete the columns you do not need (also empty columns after your data) and upload again.';
  const CELLS = (n: number) =>
    `This file is too large to read: it has about ${n.toLocaleString('en-US')} cells (rows x columns); at most 2,500,000 can be read. Split the file, or remove the columns you do not need, and upload again.`;
  /** Papa parses that make row objects (header: true). */
  const rowParses = () => papaSpy.mock.calls.filter(([, o]) => (o as { header?: boolean } | undefined)?.header === true).length;

  it(`a header of ${MAX_COLS} columns is read; ${MAX_COLS + 1} are refused, naming the width`, async () => {
    const wide = (n: number) => csv(`${fields(n, (c) => `h${c}`)}\n${fields(n, () => '1')}\n`);
    expect(Object.keys((await parseUpload(wide(MAX_COLS))).rows[0]!)).toHaveLength(MAX_COLS);
    expect(await refusal(parseUpload(wide(MAX_COLS + 1)))).toBe(WIDE(MAX_COLS + 1));
  });

  it('a header of 1,500,000 columns (2.9 MB) is refused from its first line, before Papa makes a row object', async () => {
    // Before: Papa renamed the repeated names ("a", "a_1", ...) for seconds and the file was read.
    const file = csv(`${fields(1_500_000, () => 'a')}\n`);
    expect(await refusal(parseUpload(file))).toBe(WIDE(1_500_000));
    expect(rowParses()).toBe(0);
  });

  it('the same refusal when blank lines come before the header (found once the file is parsed)', async () => {
    expect(await refusal(parseUpload(csv(`${'\n'.repeat(12)}${fields(MAX_COLS + 5, (c) => `h${c}`)}\nx\n`)))).toBe(WIDE(MAX_COLS + 5));
  });

  it(`a row with more than ${MAX_COLS} values is refused with its row number (the header is row 1); up to ${MAX_COLS} it is read as before`, async () => {
    expect(await refusal(parseUpload(csv(`code,cases\nC1,2\n${fields(MAX_COLS + 1, () => 'x')}\nC3,4\n`)))).toBe(WIDE(MAX_COLS + 1, 3));
    // A row of 1,000,000 values under a narrow header (Papa keeps the extra ones in one list).
    expect(await refusal(parseUpload(csv(`code,cases\n${fields(1_000_000, () => '1')}\n`)))).toBe(WIDE(1_000_000, 2));
    const read = await parseUpload(csv(`code,cases\nC1,2\n${fields(MAX_COLS, () => 'x')}\n`));
    expect(read.rows).toHaveLength(2);
    // The file row (review web-intake-4: Papa's own count from the first data row said "row 1").
    expect(read.warnings).toEqual([`CSV parse warning at row 3: Too many fields: expected 2 fields but parsed ${MAX_COLS}`]);
  });

  it(`more than ${MAX_CELLS.toLocaleString('en-US')} cells in all are refused with the words of a CSV sent as Excel; exactly that many are read`, async () => {
    // 100 columns: the header and 24,999 rows are 2,500,000 cells; one row more is 2,500,100.
    const body = (rows: number) => csv([fields(100, (c) => `h${c}`), ...Array.from({ length: rows }, () => fields(100, () => '1'))].join('\n'));
    expect((await parseUpload(body(24_999))).rows).toHaveLength(24_999);
    expect(await refusal(parseUpload(body(25_000)))).toBe(CELLS(2_500_100));
  });

  it('the row limit is checked first, as before: 50,001 rows of 50 columns are still "Too many rows"', async () => {
    const body = [fields(50, (c) => `h${c}`), ...Array.from({ length: MAX_ROWS + 1 }, () => fields(50, () => '1'))].join('\n');
    expect(await refusal(parseUpload(csv(body)))).toBe('Too many rows: 50001. Max 50000.');
  });

  it('empty columns after the data count: a CSV saved with 250 columns, 2 of them used, is refused, also sent as Excel', async () => {
    // Sent as Excel, SheetJS dropped them and read it; since the review of 8 Oct 2026 every CSV is
    // read by Papa Parse (upload-csv-text.spec.ts), with the same caps whatever the browser sends.
    const text = `code,cases${','.repeat(248)}\nC1,2${','.repeat(248)}\n`;
    expect(await refusal(parseUpload(csv(text)))).toBe(WIDE(250));
    expect(await refusal(parseUpload(asExcel(text, 'orders.csv')))).toBe(WIDE(250));
  });
});
