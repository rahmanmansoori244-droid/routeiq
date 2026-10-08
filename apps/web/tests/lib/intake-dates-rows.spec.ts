/**
 * Order intake data checks (review findings s6-messy-intake-2, web-intake-4, web-intake-5 and
 * web-intake-6):
 *
 *  - a delivery date before the company's today (Asia/Muscat) is a row error naming the date and
 *    today; one more than 14 days after it is a warning. A date is read by the company's date order
 *    and never turned round: a cell that could be read the other way round says how it was read, and
 *    what the other reading would be. Before, a past date only got the "after the cutoff" late note
 *    and could be confirmed, and a date years ahead (or read the wrong way round) passed silently;
 *  - error and warning rows, and OrderLine.sourceRow, are the file's own rows also when the file has
 *    blank rows (an .xlsx and a CSV, through parseUpload, the upload route and the confirm). Before,
 *    the reader left blank rows out and the check counted from 2 again: with blank separator rows
 *    it named rows above the real ones, and stored them;
 *  - rows of one sales-order line (sales order, customer branch, product and date) for different
 *    depots are never added together, whatever the row order. Before, they became one line at the
 *    first row's depot: the other depot's cases were planned at the wrong depot;
 *  - a weight column that the file shows is not the kg of each line (the same weight for different
 *    case counts, or kg per case more than twice apart) is not used for products without a case
 *    weight: their lines are weighed from the master, so OPTIMIZE asks for the case weight. Before,
 *    a per-case column was stored as the line kg for good (21.5 kg for 100 cases of 5 L).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { fakePrisma, resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'Planner One', email: 'p@a.example' } }),
}));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));

import { POST as uploadPost } from '@/app/api/orders/upload/route';
import { parseUpload } from '@/lib/csv';
import { confirmIntake, validateIntake } from '@/lib/dispatch/intake-server';
import { excelSerialToIso, normalizeOrderRows, resolveOrderLines, type KnownCustomer, type KnownProduct } from '@/lib/dispatch/order-intake';
import { addDaysIso, todayIso } from '@/lib/dispatch/time';
import { intakeLineWeight } from '@/lib/dispatch/weights';

const T = 'tA';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * An .xlsx of one sheet from rows of cells (an empty array is a blank sheet row). `ref`: the sheet's
 * range, as Excel writes it for a sheet whose cells start below row 1 (SheetJS starts it at A1).
 */
function xlsxFile(aoa: unknown[][], name = 'orders.xlsx', ref?: string): File {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (ref) ws['!ref'] = ref;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  return new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer], name, { type: XLSX_TYPE });
}
const csvFile = (text: string, name = 'orders.csv') => new File([text], name, { type: 'text/csv' });

const cust = (code: string): KnownCustomer => ({ id: `id-${code}`, code, branchKey: '__MAIN__', name: `Customer ${code}`, active: true, lat: 23.6, lng: 58.4 });
const prod = (code: string, weightPerCaseKg = 12): KnownProduct => ({ id: `id-${code}`, code, name: `Product ${code}`, active: true, weightPerCaseKg });
const NONE = new Set<string>();

// ---------------------------------------------------------------------------------------------
// Delivery dates against the company's today (s6-messy-intake-2)
// ---------------------------------------------------------------------------------------------

describe('delivery dates are checked against the company\'s today', () => {
  const TODAY = '2026-10-08';
  const r = (date: string, cases = '5', so = 'S1') => ({ 'SO No': so, 'Delivery Date': date, 'Customer Code': 'C1', 'Item Code': 'W500', Cases: cases });

  it('a date before today is a row error naming the date and today, with its cases; today and 14 days ahead are fine', () => {
    const res = normalizeOrderRows([r('30/09/2026', '4'), r('08/10/2026'), r('22/10/2026'), r('2026-10-07', '6')], { today: TODAY });
    expect(res.errors).toEqual([
      {
        row: 2,
        message: 'Delivery date "30/09/2026" (30 Sep 2026) is before today (8 Oct 2026): that day is over, so its orders cannot be added. Correct the date in the file.',
        cases: 4,
      },
      {
        row: 5,
        message: 'Delivery date "2026-10-07" (7 Oct 2026) is before today (8 Oct 2026): that day is over, so its orders cannot be added. Correct the date in the file.',
        cases: 6,
      },
    ]);
    expect(res.lines.map((l) => [l.row, l.deliveryDate])).toEqual([
      [3, '2026-10-08'],
      [4, '2026-10-22'],
    ]);
    expect(res.warnings).toEqual([]);
    // The rejected rows' cases still count in the file's cases (the check reconciles them).
    expect(res.fileCases).toBe(20);
  });

  it('an Excel date cell (a serial number) is named by its day; a past date chosen on the upload screen says so', () => {
    expect(excelSerialToIso(46301)).toBe('2026-10-06');
    const serial = normalizeOrderRows([r('46301')], { today: TODAY });
    expect(serial.errors[0]!.message).toBe(
      'Delivery date 6 Oct 2026 is before today (8 Oct 2026): that day is over, so its orders cannot be added. Correct the date in the file.',
    );
    const screen = normalizeOrderRows([{ 'Customer Code': 'C1', 'Item Code': 'W500', Cases: '3' }], { today: TODAY, defaultDeliveryDate: '2026-10-07' });
    expect(screen.lines).toEqual([]);
    expect(screen.errors).toEqual([
      {
        row: 2,
        message: 'Delivery date 7 Oct 2026, the date chosen on the upload screen, is before today (8 Oct 2026): that day is over, so its orders cannot be added. Choose another date.',
        cases: 3,
      },
    ]);
  });

  it('a date more than 14 days ahead is a warning, one per date with its rows; the line is kept', () => {
    const res = normalizeOrderRows([r('23/10/2026', '1', 'S1'), r('31/12/2099', '2', 'S2'), r('23/10/2026', '3', 'S3')], { today: TODAY });
    expect(res.errors).toEqual([]);
    expect(res.lines.map((l) => l.deliveryDate)).toEqual(['2026-10-23', '2099-12-31', '2026-10-23']);
    expect(res.warnings).toEqual([
      'Delivery date 23 Oct 2026 (rows 2, 4) is 15 days after today (8 Oct 2026): check the date.',
      'Delivery date 31 Dec 2099 (row 3) is 26,747 days after today (8 Oct 2026): check the date.',
    ]);
  });

  it('a date that reads either way round keeps the company\'s reading (never turned round) and the message says how it was read', () => {
    // The scenario: an MDY export ("10/12/2026" meant 12 Oct) uploaded by a DMY company on 8 Oct.
    const dmy = normalizeOrderRows([r('10/12/2026')], { today: TODAY, dateOrder: 'DMY' });
    expect(dmy.lines[0]!.deliveryDate).toBe('2026-12-10');
    expect(dmy.warnings).toEqual([
      'Delivery date 10 Dec 2026 (row 2) is 63 days after today (8 Oct 2026): check the date. "10/12/2026" is read as day/month (Settings, "Dates in order files"); read as month/day it would be 12 Oct 2026.',
    ]);
    // The same text in an MDY company is 12 Oct: no warning.
    const mdy = normalizeOrderRows([r('10/12/2026')], { today: TODAY, dateOrder: 'MDY' });
    expect(mdy.lines[0]!.deliveryDate).toBe('2026-10-12');
    expect(mdy.warnings).toEqual([]);
    // Read the wrong way round into the past: an error, never a silent switch to the other reading.
    const past = normalizeOrderRows([r('06/10/2026', '9')], { today: TODAY, dateOrder: 'MDY' });
    expect(past.lines).toEqual([]);
    expect(past.errors).toEqual([
      {
        row: 2,
        message:
          'Delivery date "06/10/2026" (10 Jun 2026) is before today (8 Oct 2026): that day is over, so its orders cannot be added. Correct the date in the file. "06/10/2026" is read as month/day (Settings, "Dates in order files"); read as day/month it would be 6 Oct 2026.',
        cases: 9,
      },
    ]);
  });

  it('the upload route compares with the company\'s today in its timezone (Asia/Muscat), not the server\'s', async () => {
    resetDb();
    seedDepotAndConfig();
    const today = todayIso('Asia/Muscat');
    const text = `sales_order_no,delivery_date,customer_code,product_code,cases\nS1,${addDaysIso(today, -1)},C1,W500,4\nS2,${today},C1,W500,5\nS3,${addDaysIso(today, 20)},C1,W500,6\n`;
    const r1 = await upload(csvFile(text));
    expect(r1.status).toBe(200);
    expect(r1.body.data.validation.errors.map((e: { row: number; cases: number }) => [e.row, e.cases])).toEqual([[2, 4]]);
    expect(r1.body.data.validation.errors[0].message).toMatch(/^Delivery date "\d{4}-\d{2}-\d{2}" \(.+\) is before today \(.+\): that day is over/);
    expect(r1.body.data.validation.validRows).toBe(2);
    expect(r1.body.data.validation.warnings.join('\n')).toMatch(/\(row 4\) is 20 days after today/);
    // A file with an error is not confirmable (FILE_HAS_ERRORS): the past day's orders are never added.
    expect(tables.uploadBatch[0].status).toBe('PARSED');
  });
});

// ---------------------------------------------------------------------------------------------
// File rows with blank rows (web-intake-4)
// ---------------------------------------------------------------------------------------------

describe('error and warning rows and OrderLine.sourceRow are the file\'s own rows, also with blank rows', () => {
  const HEAD = ['SO', 'Customer Code', 'Item Code', 'Cases', 'Delivery Date'];

  it('normalizeOrderRows numbers rows by the file rows it is given; rows that do not fit are numbered as before', () => {
    const rows = [
      { SO: 'S1', 'Customer Code': 'C1', 'Item Code': 'W500', Cases: '1', 'Delivery Date': '2026-10-09' },
      { SO: 'S2', 'Customer Code': 'C2', 'Item Code': 'W500', Cases: 'abc', 'Delivery Date': '2026-10-09' },
      { SO: 'S3', 'Customer Code': 'C3', 'Item Code': 'W500', Cases: '4', 'Delivery Date': '2026-10-09' },
    ];
    const res = normalizeOrderRows(rows, { rowNumbers: [2, 5, 6] });
    expect(res.errors.map((e) => e.row)).toEqual([5]);
    expect(res.lines.map((l) => l.row)).toEqual([2, 6]);
    for (const bad of [[2, 5], [2, 5, 5], [2, 1, 6], [1, 2, 3], [2, 5.5, 6]]) {
      expect(normalizeOrderRows(rows, { rowNumbers: bad }).lines.map((l) => l.row), String(bad)).toEqual([2, 4]);
    }
  });

  it('an .xlsx with blank rows: parseUpload gives the sheet rows and the check names them (blank separator rows after each group)', async () => {
    const aoa: unknown[][] = [HEAD];
    let n = 0;
    for (let g = 0; g < 6; g++) {
      for (let k = 0; k < 10; k++) aoa.push([`S${++n}`, `C${n}`, 'W500', 2, '2026-10-09']);
      aoa.push([]);
    }
    aoa.push(['SBAD', 'CBAD', 'W500', 2.5, '2026-10-09']); // sheet row 68 (61 rows read)
    const parsed = await parseUpload(xlsxFile(aoa));
    expect(parsed.rows).toHaveLength(61);
    expect(parsed.rowNumbers!.slice(0, 12)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]);
    const norm = normalizeOrderRows(parsed.rows, { rowNumbers: parsed.rowNumbers });
    expect(norm.errors).toEqual([{ row: 68, message: 'Cases must be a whole number above 0 (got "2.5").', cases: 2.5 }]);
    expect(norm.lines[59]!.row).toBe(66);
  });

  it('an .xlsx whose header is below blank rows (the sheet\'s cells start on row 3): the sheet rows still', async () => {
    const parsed = await parseUpload(xlsxFile([[], [], HEAD, ['S1', 'C1', 'W500', 'x', '2026-10-09']], 'orders.xlsx', 'A3:E4'));
    const norm = normalizeOrderRows(parsed.rows, { rowNumbers: parsed.rowNumbers });
    expect(norm.errors.map((e) => e.row)).toEqual([4]);
  });

  it('a CSV with a blank line and a line of separators: the records as a spreadsheet numbers them', async () => {
    const text = 'SO,Customer Code,Item Code,Cases,Delivery Date\nS1,C001,W500,1,2026-10-09\n\n,,,,\nS2,C002,W500,abc,2026-10-09\nS3,C003,W500,4,2026-10-09\n';
    const parsed = await parseUpload(csvFile(text));
    expect(parsed.rowNumbers).toEqual([2, 5, 6]);
    const norm = normalizeOrderRows(parsed.rows, { rowNumbers: parsed.rowNumbers });
    expect(norm.errors.map((e) => e.row)).toEqual([5]);
    expect(norm.lines.map((l) => l.row)).toEqual([2, 6]);
  });

  it('a CSV: blank lines before the header, Windows line breaks, a semicolon separator and a quoted value with a line break (one row)', async () => {
    const text = '\r\n\r\nSO;Customer Code;Item Code;Cases;Notes\r\nS1;C1;W500;1;"two\r\nlines"\r\n\r\nS2;C2;W500;2;x\r\n';
    const parsed = await parseUpload(csvFile(text));
    expect(parsed.rows.map((r) => r.so)).toEqual(['S1', 'S2']);
    expect(parsed.rowNumbers).toEqual([4, 6]);
  });

  it('a CSV parse warning and a row refused for its width name the file row (the warning said "row 1" for row 5)', async () => {
    const parsed = await parseUpload(csvFile('code,cases\nC1,2\n\n\nC3,4,5\n'));
    expect(parsed.warnings).toEqual(['CSV parse warning at row 5: Too many fields: expected 2 fields but parsed 3']);
    // An unclosed quote is refused since the CSV intake fix (review web-intake-2), naming its file line
    // (Papa counts it by its record from 0: it said "row 3" for row 4).
    await expect(parseUpload(csvFile('code,cases\nC1,2\n\nC3,"x\n'))).rejects.toThrow(/^Line 4 of this file has a quote/);
    const wide = Array.from({ length: 201 }, () => 'x').join(',');
    await expect(parseUpload(csvFile(`code,cases\nC1,2\n\n${wide}\n`))).rejects.toThrow(/^Row 4 of this file has 201 columns; at most 200 can be read\./);
  });

  it('through the upload route: errors and "added together" warnings name the sheet rows, and the confirm stores them as OrderLine.sourceRow', async () => {
    resetDb();
    seedDepotAndConfig();
    tables.customer = ['C1', 'C2', 'C3', 'C4'].map((code) => ({ id: `id-${code}`, tenantId: T, code, branchKey: '__MAIN__', branchCode: null, name: code, active: true, lat: 23.6, lng: 58.4 }));
    tables.product = [{ id: 'id-W500', tenantId: T, code: 'W500', name: 'Water', active: true, weightPerCaseKg: 12 }];
    const day = addDaysIso(todayIso('Asia/Muscat'), 2);
    const aoa: unknown[][] = [
      HEAD, // 1
      ['S1', 'C1', 'W500', 3, day], // 2
      [], // 3
      ['S2', 'C2', 'W500', 4, day], // 4
      [], // 5
      [], // 6
      ['S1', 'C1', 'W500', 2, day], // 7: same line as row 2
      ['S3', 'C3', 'W500', 'abc', day], // 8: bad cases
      [], // 9
      ['S4', 'C4', 'W500', 5, day], // 10
    ];
    const bad = await upload(xlsxFile(aoa));
    expect(bad.status).toBe(200);
    expect(bad.body.data.validation.errors.map((e: { row: number }) => e.row)).toEqual([8]);
    expect(bad.body.data.validation.warnings).toContain('Row 7: same sales order/product as row 2 - quantities added together.');

    // The corrected file (row 8 removed, a blank row in its place) is checked and confirmed.
    aoa[7] = [];
    const parsed = await parseUpload(xlsxFile(aoa));
    const v = await validateIntake(T, parsed.rows, { depotId: 'D1', rowNumbers: parsed.rowNumbers });
    expect(v.errors).toEqual([]);
    await confirmIntake(fakePrisma as never, T, { id: 'batch1', depotId: 'D1' }, v, { id: 'u1' }, { isLate: false, reason: null });
    expect(tables.orderLine!.map((l) => [l.salesOrderNo, l.sourceRow, l.cases]).sort()).toEqual([
      ['S1', 2, 5],
      ['S2', 4, 4],
      ['S4', 10, 5],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// One sales-order line, two depots (web-intake-6)
// ---------------------------------------------------------------------------------------------

describe('rows of one sales-order line for different depots are never added together', () => {
  const D = '2026-12-01';
  const r = (depot: string, cases: string) => ({ SO: 'S1', Date: D, Customer: 'C1', Item: 'W500', Cases: cases, Depot: depot });
  const resolve = (rows: Record<string, string>[]) => resolveOrderLines(normalizeOrderRows(rows), [cust('C1')], [prod('W500')], NONE);

  it('NZW and SHN rows: an error on each row with its own cases, naming the rows and depots, in either row order', () => {
    const msg =
      'Rows 2 and 3 are one sales-order line (sales order S1, W500 for C1 on 2026-12-01) for different depots (NZW on row 2, SHN on row 3). A sales-order line is planned at one depot: correct the depot column, or send the rows under their own sales-order numbers.';
    const a = resolve([r('NZW', '5'), r('SHN', '7')]);
    expect(a.lines).toEqual([]);
    expect(a.errors).toEqual([
      { row: 2, message: msg, cases: 5 },
      { row: 3, message: msg, cases: 7 },
    ]);
    const b = resolve([r('SHN', '7'), r('NZW', '5')]);
    expect(b.lines).toEqual([]);
    expect(b.errors.map((e) => [e.row, e.cases])).toEqual([
      [2, 7],
      [3, 5],
    ]);
    expect(b.errors[0]!.message).toMatch(/for different depots \(SHN on row 2, NZW on row 3\)/);
    expect(a.warnings.join(' ')).not.toMatch(/added together/);
  });

  it('a large line for two depots: one short message for every row (at most ten rows and five depots named)', () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => r(i % 2 ? 'SHN' : 'NZW', '1'));
    rows.push(r('', '1'), r('SOH', '1'), r('MCT', '1'), r('SLL', '1'), r('BRK', '1'));
    const res = resolve(rows);
    expect(res.lines).toEqual([]);
    expect(res.errors).toHaveLength(2_005);
    expect(res.errors.reduce((n, e) => n + (e.cases ?? 0), 0)).toBe(2_005);
    expect(new Set(res.errors.map((e) => e.message)).size).toBe(1);
    expect(res.errors[0]!.message).toBe(
      'Rows 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 1995 more are one sales-order line (sales order S1, W500 for C1 on 2026-12-01) for different depots (NZW on rows 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, ..., SHN on rows 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, ..., no depot on row 2002, SOH on row 2003, MCT on row 2004, ...). A sales-order line is planned at one depot: correct the depot column, or send the rows under their own sales-order numbers.',
    );
  });

  it('a row without a depot is added to its line, which keeps the depot the other row names, in either order; letter case is one depot', () => {
    for (const rows of [[r('', '5'), r('SHN', '7')], [r('SHN', '7'), r('', '5')], [r('shn', '7'), r('SHN', '5')]]) {
      const res = resolve(rows);
      expect(res.errors).toEqual([]);
      expect(res.lines).toHaveLength(1);
      expect(res.lines[0]!.cases).toBe(12);
      expect(res.lines[0]!.depotCode!.toUpperCase()).toBe('SHN');
    }
  });

  it('uploaded for NZW: the two-depot rows are refused, and a line for SHN names all its rows', async () => {
    resetDb();
    seedDepotAndConfig();
    const day = addDaysIso(todayIso('Asia/Muscat'), 3);
    const head = 'sales_order_no,delivery_date,customer_code,product_code,cases,depot';
    const two = await upload(csvFile(`${head}\nS1,${day},C1,W500,5,NZW\nS1,${day},C1,W500,7,SHN\n`), 'D1');
    expect(two.body.data.validation.validRows).toBe(0);
    expect(two.body.data.validation.errors.map((e: { row: number; cases: number }) => [e.row, e.cases])).toEqual([
      [2, 5],
      [3, 7],
    ]);
    for (const text of [`${head}\nS1,${day},C1,W500,5,\nS1,${day},C1,W500,7,SHN\n`, `${head}\nS1,${day},C1,W500,7,SHN\nS1,${day},C1,W500,5,\n`]) {
      const res = await upload(csvFile(text), 'D1');
      expect(res.body.data.validation.validRows).toBe(0);
      expect(res.body.data.validation.errors).toEqual([{ row: 2, message: 'Rows 2 and 3 (one sales-order line) are for depot SHN, but you are uploading for NZW.', cases: 12 }]);
    }
    // One row for another depot keeps its message.
    const one = await upload(csvFile(`${head}\nS1,${day},C1,W500,5,NZW\nS2,${day},C1,W500,7,SHN\n`), 'D1');
    expect(one.body.data.validation.errors).toEqual([{ row: 3, message: 'Row is for depot SHN, but you are uploading for NZW.', cases: 7 }]);
    expect(one.body.data.validation.validRows).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// A weight column that is not the kg of each line (web-intake-5)
// ---------------------------------------------------------------------------------------------

describe('a weight column that is not the kg of each line is not used for products without a case weight', () => {
  const D = '2026-12-01';
  const r = (so: string, item: string, cases: string, weight: string) => ({ SO: so, Date: D, Customer: 'C1', Item: item, Cases: cases, Weight: weight });

  it('the same weight on rows of 100 and 4 cases (kg per case): the lines are weighed from the master, the product is listed without weight, and one warning says why', () => {
    const res = resolveOrderLines(normalizeOrderRows([r('S1', 'TAN-5L-4', '100', '21.5'), r('S2', 'TAN-5L-4', '4', '21.5')]), [cust('C1')], [prod('TAN-5L-4', 0)], NONE);
    expect(res.errors).toEqual([]);
    expect(res.lines.map((l) => [l.cases, l.weightKg, l.weightMissingCases])).toEqual([
      [100, null, 100],
      [4, null, 4],
    ]);
    expect(res.issues.productsWithoutWeight).toEqual(['TAN-5L-4']);
    expect(res.warnings).toEqual([
      'The weight column does not look like the kg of each line: rows 2 and 3 of TAN-5L-4 have 21.5 kg for 100 cases and 21.5 kg for 4 cases (0.2 and 5.4 kg per case). Its weights are not used for products without a case weight (TAN-5L-4): enter their case weights under Products (OPTIMIZE asks for them). If the column is the kg of each line, correct those rows and upload the file again.',
    ]);
    // At confirm such a line is weighed from the product (0 kg = unknown until it has a case weight) and follows it.
    expect(intakeLineWeight(res.lines[0]!, 0)).toEqual({ weightKg: 0, fromMaster: true });
    expect(intakeLineWeight(res.lines[0]!, 21.5)).toEqual({ weightKg: 2150, fromMaster: true });
  });

  it('kg per case more than twice apart, also for a new product; the evidence of one product holds for the whole column', () => {
    const res = resolveOrderLines(
      normalizeOrderRows([r('S1', 'NEW-1', '10', '20'), r('S2', 'NEW-1', '12', '100'), r('S3', 'SOLO', '3', '30'), r('S4', 'W500', '10', '120')]),
      [cust('C1')],
      [prod('SOLO', 0), prod('W500', 12)],
      NONE,
    );
    expect(res.lines.map((l) => [l.productCode, l.weightKg])).toEqual([
      ['NEW-1', null],
      ['NEW-1', null],
      ['SOLO', null],
      ['W500', 120], // a product with a case weight keeps its file kg (and the per-row check against it)
    ]);
    expect(res.issues.productsWithoutWeight).toEqual(['NEW-1', 'SOLO']);
    expect(res.warnings.filter((w) => /weight column does not look/.test(w))).toEqual([
      'The weight column does not look like the kg of each line: rows 2 and 3 of NEW-1 have 20 kg for 10 cases and 100 kg for 12 cases (2 and 8.3 kg per case). Its weights are not used for products without a case weight (NEW-1, SOLO): enter their case weights under Products (OPTIMIZE asks for them). If the column is the kg of each line, correct those rows and upload the file again.',
    ]);
  });

  it('weights in proportion to the cases are the kg of each line, as before (no warning); one row per product proves nothing', () => {
    const per = resolveOrderLines(normalizeOrderRows([r('S1', 'TAN-5L-4', '100', '2150'), r('S2', 'TAN-5L-4', '4', '86'), r('S3', 'TAN-5L-4', '4', '86')]), [cust('C1')], [prod('TAN-5L-4', 0)], NONE);
    expect(per.lines.map((l) => [l.weightKg, l.weightMissingCases])).toEqual([
      [2150, 0],
      [86, 0],
      [86, 0],
    ]);
    expect(per.issues.productsWithoutWeight).toEqual([]);
    expect(per.warnings).toEqual([]);
    const solo = resolveOrderLines(normalizeOrderRows([r('S1', 'TAN-5L-4', '100', '21.5')]), [cust('C1')], [prod('TAN-5L-4', 0)], NONE);
    expect(solo.lines[0]!.weightKg).toBe(21.5);
  });
});

// ---------------------------------------------------------------------------------------------

function seedDepotAndConfig() {
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, orderColumnMapJson: null, timezone: 'Asia/Muscat', dateOrder: 'DMY', planningCutoffMin: 1080 }];
  tables.depot = [
    { id: 'D1', tenantId: T, code: 'NZW', name: 'Nizwa', lat: 22.93, lng: 57.53, active: true, historyOnly: false },
    { id: 'D2', tenantId: T, code: 'SHN', name: 'Sohar', lat: 24.35, lng: 56.7, active: true, historyOnly: false },
  ];
}

async function upload(file: File, depotId = 'D1') {
  const fd = new FormData();
  fd.set('file', file);
  fd.set('depotId', depotId);
  const res = await uploadPost(new Request('http://localhost/api/orders/upload', { method: 'POST', body: fd }));
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
}

beforeEach(() => {
  resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});
