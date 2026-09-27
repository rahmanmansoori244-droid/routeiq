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
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('xlsx', async (importOriginal) => {
  const real = await importOriginal<typeof import('xlsx')>();
  return { ...real, read: vi.fn(real.read), utils: { ...real.utils, sheet_to_json: vi.fn(real.utils.sheet_to_json) } };
});

import * as XLSX from 'xlsx';
import { MAX_ROWS, MAX_SHEETS, MAX_ZIP_PARTS, READ_ROWS, parseExcelSheets, parseUpload } from '@/lib/csv';
import { checkWorkbookZip } from '@/lib/workbook-guard';
import { hugeSheet, sheetXml, workbook, xlsxFile, zip, XLSX_TYPE } from './zip-fixtures';

const readSpy = vi.mocked(XLSX.read);
const toJsonSpy = vi.mocked(XLSX.utils.sheet_to_json);
afterEach(() => {
  readSpy.mockClear();
  toJsonSpy.mockClear();
  vi.restoreAllMocks();
});

const refusal = (p: Promise<unknown>) => p.then(() => 'accepted', (e: Error) => e.message);
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
    expect(checkWorkbookZip(bytes, { maxUnpackedBytes: 50 * 1024 * 1024, maxParts: MAX_ZIP_PARTS }).unpackedBytes).toBeGreaterThan(45 * 1024 * 1024);
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

  it('a CSV sent as Excel (Windows browsers do) is read by SheetJS with the same row cap', async () => {
    const file = new File([body(120_000).join('\n')], 'orders.csv', { type: 'application/vnd.ms-excel' });
    expect(await refusal(parseUpload(file))).toBe('Too many rows: more than 50000. Max 50000.');
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
