/**
 * Sales-order file intake: header mapping, row normalization and master-data resolution.
 * Pure - no database.
 */
import { describe, expect, it } from 'vitest';
import {
  contentFingerprint,
  customerKey,
  customerTypeFromText,
  excelSerialToIso,
  lineDupKey,
  mapHeaders,
  normalizeOrderRows,
  normSalesOrder,
  parseDateCell,
  resolveOrderLines,
  type KnownCustomer,
  type KnownProduct,
  type NormalizeResult,
} from '@/lib/dispatch/order-intake';

// NMWC export headers (exactly as they appear in the file).
const H = {
  so: 'SO No',
  date: 'Req. Delivery Date',
  cust: 'Customer Code',
  branch: 'Branch',
  item: 'Item Code',
  qty: 'Qty (Cases)',
  value: 'Net Value',
  cm: 'CM',
} as const;

type RowIn = Partial<Record<keyof typeof H | 'prio', string>>;

/** Build an NMWC-style row; every header present (like sheet_to_json with defval: ''). */
function row(r: RowIn, withPriority = false): Record<string, string> {
  const out: Record<string, string> = {
    [H.so]: r.so ?? '',
    [H.date]: r.date ?? '',
    [H.cust]: r.cust ?? '',
    [H.branch]: r.branch ?? '',
    [H.item]: r.item ?? '',
    [H.qty]: r.qty ?? '',
    [H.value]: r.value ?? '',
    [H.cm]: r.cm ?? '',
  };
  if (withPriority) out.Priority = r.prio ?? '';
  return out;
}

const cust = (code: string, branchKey = '__MAIN__', over: Partial<KnownCustomer> = {}): KnownCustomer => ({
  id: `id-${code}-${branchKey}`,
  code,
  branchKey,
  name: `Customer ${code}`,
  active: true,
  lat: 23.5859,
  lng: 58.4059,
  ...over,
});

const prod = (code: string, over: Partial<KnownProduct> = {}): KnownProduct => ({
  id: `id-${code}`,
  code,
  name: `Product ${code}`,
  active: true,
  weightPerCaseKg: 12,
  ...over,
});

const NONE = new Set<string>();

describe('mapHeaders', () => {
  it('maps NMWC-style headers onto canonical fields', () => {
    const m = mapHeaders(Object.values(H));
    expect(m.used).toEqual({
      sales_order_no: 'SO No',
      delivery_date: 'Req. Delivery Date',
      customer_code: 'Customer Code',
      branch_code: 'Branch',
      product_code: 'Item Code',
      cases: 'Qty (Cases)',
      sales_value: 'Net Value',
      margin: 'CM',
    });
    expect(m.unmapped).toEqual([]);
  });

  it('works with the lowercased keys the file parser produces', () => {
    const m = mapHeaders(Object.values(H).map((h) => h.toLowerCase()));
    expect(m.used.delivery_date).toBe('req. delivery date');
    expect(m.used.cases).toBe('qty (cases)');
  });

  it('never maps one column to two fields and reports leftovers', () => {
    const m = mapHeaders(['SO Date', 'Date', 'Customer', 'Customer Name', 'Item', 'Qty', 'Driver Remarks X']);
    expect(m.used.order_date).toBe('SO Date');
    expect(m.used.delivery_date).toBe('Date');
    expect(m.used.customer_code).toBe('Customer');
    expect(m.used.customer_name).toBe('Customer Name');
    expect(m.used.product_code).toBe('Item');
    expect(m.used.cases).toBe('Qty');
    expect(m.unmapped).toEqual(['Driver Remarks X']);
    expect(new Set(Object.values(m.used)).size).toBe(Object.values(m.used).length);
  });

  it('tenant extra aliases are used and win over built-ins', () => {
    const m = mapHeaders(['Customer', 'Payer #', 'Mat.', 'Boxes', 'Delivery Date'], {
      customer_code: ['Payer #'],
      product_code: ['Mat.'],
      cases: ['Boxes'],
    });
    expect(m.used.customer_code).toBe('Payer #');
    expect(m.used.product_code).toBe('Mat.');
    expect(m.used.cases).toBe('Boxes');
    expect(m.used.delivery_date).toBe('Delivery Date');
    expect(m.unmapped).toContain('Customer');
  });
});

describe('parseDateCell / excelSerialToIso', () => {
  it('reads DD/MM/YYYY by default (and - . separators, 2-digit years)', () => {
    expect(parseDateCell('25/09/2026')).toBe('2026-09-25');
    expect(parseDateCell('25-09-2026')).toBe('2026-09-25');
    expect(parseDateCell('25.09.2026')).toBe('2026-09-25');
    expect(parseDateCell('5/9/26')).toBe('2026-09-05');
    expect(parseDateCell('25/09/2026 00:00')).toBe('2026-09-25');
  });

  it('reads MM/DD/YYYY when the tenant dateOrder is MDY', () => {
    expect(parseDateCell('09/25/2026', 'MDY')).toBe('2026-09-25');
    expect(parseDateCell('09/25/2026', 'DMY')).toBeNull(); // month 25 does not exist
    expect(parseDateCell('03/04/2026', 'MDY')).toBe('2026-03-04');
    expect(parseDateCell('03/04/2026', 'DMY')).toBe('2026-04-03');
  });

  it('reads ISO dates and timestamps', () => {
    expect(parseDateCell('2026-09-25')).toBe('2026-09-25');
    expect(parseDateCell('2026/9/5')).toBe('2026-09-05');
    expect(parseDateCell('2026-09-25T00:00:00.000Z')).toBe('2026-09-25');
    expect(parseDateCell('2026-09-25 08:15:00')).toBe('2026-09-25');
  });

  it('reads Excel serials (with or without a time fraction)', () => {
    expect(parseDateCell('46290')).toBe('2026-09-25');
    expect(parseDateCell('46290.75')).toBe('2026-09-25');
    expect(excelSerialToIso(46290)).toBe('2026-09-25');
    expect(excelSerialToIso(100)).toBeNull(); // too small to be a plausible order date
    expect(excelSerialToIso(Number.NaN)).toBeNull();
  });

  it('reads month-name dates', () => {
    expect(parseDateCell('25-Sep-2026')).toBe('2026-09-25');
    expect(parseDateCell('25-SEP-26')).toBe('2026-09-25');
    expect(parseDateCell('25 Sept 2026')).toBe('2026-09-25');
    expect(parseDateCell('25 September 2026')).toBe('2026-09-25');
    expect(parseDateCell('1 May 2026')).toBe('2026-05-01');
  });

  it('reads full month names whose first four letters are not an abbreviation', () => {
    expect(parseDateCell('25 March 2026')).toBe('2026-03-25');
    expect(parseDateCell('1 June 2026')).toBe('2026-06-01');
    expect(parseDateCell('4 July 2026')).toBe('2026-07-04');
    expect(parseDateCell('10 October 2026')).toBe('2026-10-10');
    expect(parseDateCell('25 MARCH 2026')).toBe('2026-03-25');
  });

  it('rejects invalid dates', () => {
    for (const s of ['tomorrow', '31/02/2026', '2026-13-01', '00/01/2026', '25-Foo-2026', '12345678', '1/1/1850']) {
      expect(parseDateCell(s), s).toBeNull();
    }
    expect(parseDateCell('')).toBeNull();
  });
});

describe('normalizeOrderRows', () => {
  it('normalizes a clean NMWC file', () => {
    const res = normalizeOrderRows([
      row({ so: 'SO-1001', date: '25/09/2026', cust: 'C001', branch: 'B01', item: 'W500', qty: '40', value: '120.500', cm: '30.25' }),
      row({ so: 'SO-1001', date: '25/09/2026', cust: 'C001', branch: 'B01', item: 'W1500', qty: '1,200', value: '', cm: '' }),
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.fileCases).toBe(1240);
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0]).toMatchObject({
      row: 2,
      salesOrderNo: 'SO-1001',
      deliveryDate: '2026-09-25',
      customerCode: 'C001',
      branchCode: 'B01',
      branchKey: 'B01',
      productCode: 'W500',
      cases: 40,
      salesValue: 120.5,
      margin: 30.25,
      priority: null,
      weightKg: null,
    });
    expect(res.lines[1]).toMatchObject({ row: 3, cases: 1200, salesValue: null, margin: null });
  });

  it('a blank branch becomes the __MAIN__ branch key', () => {
    const res = normalizeOrderRows([row({ so: 'S1', date: '2026-09-25', cust: 'C001', item: 'W500', qty: '1' })]);
    expect(res.lines[0].branchCode).toBeNull();
    expect(res.lines[0].branchKey).toBe('__MAIN__');
  });

  it('reports missing required columns in one clear message', () => {
    const res = normalizeOrderRows([{ Foo: '1', Bar: '2' }]);
    expect(res.lines).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].row).toBe(1);
    expect(res.errors[0].message).toBe(
      'Missing required column(s): customer code, product / item code, cases / quantity, delivery date (or choose one on the upload screen). Found columns: Foo, Bar.',
    );
  });

  it('a missing date column is fine when a default delivery date is given (with a warning)', () => {
    const rows = [{ 'Customer Code': 'C001', 'Item Code': 'W500', Cases: '5' }];
    const noDefault = normalizeOrderRows(rows);
    expect(noDefault.errors[0].message).toMatch(/delivery date/);
    const res = normalizeOrderRows(rows, { defaultDeliveryDate: '2026-09-25' });
    expect(res.errors).toEqual([]);
    expect(res.lines[0].deliveryDate).toBe('2026-09-25');
    expect(res.warnings).toContain('No delivery-date column: every row uses 2026-09-25.');
    expect(res.warnings.join(' ')).toMatch(/No sales-order number column/);
  });

  it('a blank date cell falls back to the default delivery date', () => {
    const res = normalizeOrderRows([row({ so: 'S1', cust: 'C001', item: 'W500', qty: '3' })], { defaultDeliveryDate: '2026-09-25' });
    expect(res.errors).toEqual([]);
    expect(res.lines[0].deliveryDate).toBe('2026-09-25');
    const noDefault = normalizeOrderRows([row({ so: 'S1', cust: 'C001', item: 'W500', qty: '3' })]);
    expect(noDefault.errors).toEqual([{ row: 2, message: 'Delivery date "" is not a date.', cases: 3 }]);
  });

  it('parses every supported delivery-date format through the row pipeline', () => {
    const dates = ['25/09/2026', '2026-09-25', '46290', '25-Sep-2026'];
    const res = normalizeOrderRows(dates.map((d, i) => row({ so: `S${i}`, date: d, cust: 'C001', item: 'W500', qty: '1' })));
    expect(res.errors).toEqual([]);
    expect(res.lines.map((l) => l.deliveryDate)).toEqual(['2026-09-25', '2026-09-25', '2026-09-25', '2026-09-25']);
    const mdy = normalizeOrderRows([row({ so: 'S1', date: '09/25/2026', cust: 'C001', item: 'W500', qty: '1' })], { dateOrder: 'MDY' });
    expect(mdy.lines[0].deliveryDate).toBe('2026-09-25');
  });

  it('an invalid date is a row error carrying the row cases', () => {
    const res = normalizeOrderRows([row({ so: 'S1', date: '31/02/2026', cust: 'C001', item: 'W500', qty: '7' })]);
    expect(res.lines).toEqual([]);
    expect(res.errors).toEqual([{ row: 2, message: 'Delivery date "31/02/2026" is not a date.', cases: 7 }]);
    expect(res.fileCases).toBe(7);
  });

  it('bad case quantities are row errors, and numeric ones still count in fileCases', () => {
    const base = { so: 'S1', date: '25/09/2026', cust: 'C001', item: 'W500' };
    const res = normalizeOrderRows([
      row({ ...base, qty: '2.5' }),
      row({ ...base, qty: '0' }),
      row({ ...base, qty: '-3' }),
      row({ ...base, qty: 'ten' }),
      row({ ...base, qty: '' }),
      row({ ...base, qty: '10' }),
    ]);
    expect(res.lines.map((l) => l.row)).toEqual([7]);
    expect(res.errors.map((e) => [e.row, e.cases])).toEqual([
      [2, 2.5],
      [3, 0],
      [4, -3],
      [5, null],
      [6, null],
    ]);
    expect(res.errors[0].message).toBe('Cases must be a whole number above 0 (got "2.5").');
    expect(res.errors[3].message).toBe('Cases must be a whole number above 0 (got "ten").');
    expect(res.errors[4].message).toBe('Cases is empty.');
    // Every parseable quantity, including rejected rows: 2.5 + 0 - 3 + 10.
    expect(res.fileCases).toBe(9.5);
  });

  it('missing customer / product codes are row errors', () => {
    const res = normalizeOrderRows([
      row({ so: 'S1', date: '25/09/2026', item: 'W500', qty: '4' }),
      row({ so: 'S1', date: '25/09/2026', cust: 'C001', qty: '6' }),
    ]);
    expect(res.errors).toEqual([
      { row: 2, message: 'Customer code is empty.', cases: 4 },
      { row: 3, message: 'Product / item code is empty.', cases: 6 },
    ]);
    expect(res.fileCases).toBe(10);
  });

  it('priority accepts P1..P5 and 1..5 (P1 highest); anything else is an error', () => {
    const base = { so: 'S1', date: '25/09/2026', cust: 'C001', item: 'W500', qty: '1' };
    const res = normalizeOrderRows(
      [
        row({ ...base, prio: 'P1' }, true),
        row({ ...base, prio: '1' }, true),
        row({ ...base, prio: 'p5' }, true),
        row({ ...base, prio: '' }, true),
        row({ ...base, prio: '6' }, true),
        row({ ...base, prio: 'P0' }, true),
        row({ ...base, prio: 'High' }, true),
      ],
    );
    expect(res.lines.map((l) => l.priority)).toEqual([1, 1, 5, null]);
    expect(res.errors.map((e) => e.row)).toEqual([6, 7, 8]);
    expect(res.errors[0].message).toBe('Priority must be 1-5 or P1-P5 (got "6"). P1 is the highest.');
  });

  it('skips fully blank rows without shifting file row numbers', () => {
    const res = normalizeOrderRows([
      row({ so: 'S1', date: '25/09/2026', cust: 'C001', item: 'W500', qty: '1' }),
      row({}),
      row({ so: '  ', date: ' ' }),
      row({ so: 'S2', date: '25/09/2026', cust: 'C002', item: 'W500', qty: '2' }),
    ]);
    expect(res.errors).toEqual([]);
    expect(res.lines.map((l) => l.row)).toEqual([2, 5]);
    expect(res.fileCases).toBe(3);
  });

  it('an empty file is an error', () => {
    const res = normalizeOrderRows([]);
    expect(res.errors).toEqual([{ row: 1, message: 'The file has no data rows.' }]);
  });

  it('non-numeric value / margin / weight and negative weight are row errors', () => {
    const res = normalizeOrderRows([
      { 'Customer Code': 'C001', 'Item Code': 'W500', Cases: '1', Date: '25/09/2026', 'Net Value': 'abc', Weight: '' },
      { 'Customer Code': 'C001', 'Item Code': 'W500', Cases: '1', Date: '25/09/2026', 'Net Value': '', Weight: '-5' },
      { 'Customer Code': 'C001', 'Item Code': 'W500', Cases: '1', Date: '25/09/2026', 'Net Value': '', Weight: '12.5' },
    ]);
    expect(res.errors.map((e) => e.message)).toEqual(['Weight / value / margin must be numbers.', 'Weight cannot be negative.']);
    expect(res.lines[0].weightKg).toBe(12.5);
  });

  it('a file weight of 0 counts as blank, so the product master weight applies (with a note)', () => {
    const res = normalizeOrderRows([
      { 'Customer Code': 'C001', 'Item Code': 'W500', Cases: '4', Date: '25/09/2026', Weight: '0' },
      { 'Customer Code': 'C001', 'Item Code': 'W500', Cases: '4', Date: '25/09/2026', Weight: '51.2' },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.lines.map((l) => l.weightKg)).toEqual([null, 51.2]);
    expect(res.warnings.join(' ')).toMatch(/1 row\(s\) have weight 0 \(row 2\): treated as blank/);
  });

  it('an unreadable order date is only a warning', () => {
    const res = normalizeOrderRows([{ 'SO Date': 'yesterday', 'Delivery Date': '25/09/2026', 'Customer Code': 'C001', 'Item Code': 'W500', Cases: '1' }]);
    expect(res.errors).toEqual([]);
    expect(res.lines[0].orderDate).toBeNull();
    expect(res.warnings).toContain('Row 2: order date "yesterday" ignored (not a date).');
  });
});

describe('resolveOrderLines', () => {
  const D = '25/09/2026';

  function resolve(rows: Record<string, string>[], customers: KnownCustomer[], products: KnownProduct[], confirmed = NONE) {
    const norm: NormalizeResult = normalizeOrderRows(rows);
    return resolveOrderLines(norm, customers, products, confirmed);
  }

  it('attaches known customers and products', () => {
    const res = resolve([row({ so: 'S1', date: D, cust: 'C001', branch: 'B01', item: 'w500', qty: '5' })], [cust('C001', 'B01')], [prod('W500')]);
    expect(res.errors).toEqual([]);
    expect(res.lines[0]).toMatchObject({
      customerKey: 'C001::B01',
      customerId: 'id-C001-B01',
      productId: 'id-W500', // product codes match case-insensitively
      sourceRows: [2],
    });
    expect(res.issues.newCustomers).toEqual([]);
    expect(res.issues.newProducts).toEqual([]);
  });

  it('an unknown customer is NOT an error: it is listed as new with its rows', () => {
    const res = resolve(
      [
        row({ so: 'S1', date: D, cust: 'NEW1', branch: 'B9', item: 'W500', qty: '5' }),
        row({ so: 'S2', date: D, cust: 'NEW1', branch: 'B9', item: 'W500', qty: '3' }),
      ],
      [],
      [prod('W500')],
    );
    expect(res.errors).toEqual([]);
    expect(res.lines).toHaveLength(2);
    expect(res.lines.every((l) => l.customerId === null)).toBe(true);
    expect(res.issues.newCustomers).toEqual([
      { code: 'NEW1', branchCode: 'B9', branchKey: 'B9', name: 'NEW1', customerType: null, rows: [2, 3] },
    ]);
  });

  it('an unknown product is listed as new with its rows', () => {
    const res = resolve(
      [
        row({ so: 'S1', date: D, cust: 'C001', item: 'X1', qty: '5' }),
        row({ so: 'S2', date: D, cust: 'C001', item: 'x1', qty: '5' }),
      ],
      [cust('C001')],
      [],
    );
    expect(res.errors).toEqual([]);
    expect(res.lines.every((l) => l.productId === null)).toBe(true);
    expect(res.issues.newProducts).toEqual([{ code: 'X1', name: 'X1', rows: [2, 3] }]);
  });

  it('inactive customer / product rows are errors and are not planned', () => {
    const res = resolve(
      [
        row({ so: 'S1', date: D, cust: 'OLD', item: 'W500', qty: '5' }),
        row({ so: 'S2', date: D, cust: 'C001', item: 'DISC', qty: '6' }),
        row({ so: 'S3', date: D, cust: 'C001', item: 'W500', qty: '7' }),
      ],
      [cust('OLD', '__MAIN__', { active: false }), cust('C001')],
      [prod('W500'), prod('DISC', { active: false })],
    );
    expect(res.lines.map((l) => l.row)).toEqual([4]);
    expect(res.errors).toEqual([
      { row: 2, message: 'Customer OLD is inactive. Reactivate it or remove the row.', cases: 5 },
      { row: 3, message: 'Product DISC is inactive.', cases: 6 },
    ]);
    expect(res.totals.cases).toBe(7);
  });

  it('merges the same SO + customer branch + product, with a warning', () => {
    const res = resolve(
      [
        row({ so: 'S1', date: D, cust: 'C001', item: 'W500', qty: '5', value: '10', cm: '2' }),
        row({ so: 'S1', date: D, cust: 'C001', item: 'W500', qty: '3', value: '6', cm: '1' }),
        row({ so: 'S1', date: D, cust: 'C001', item: 'W1500', qty: '1' }),
      ],
      [cust('C001')],
      [prod('W500'), prod('W1500')],
    );
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0]).toMatchObject({ cases: 8, salesValue: 16, margin: 3, sourceRows: [2, 3] });
    expect(res.warnings).toContain('Row 3: same sales order/product as row 2 - quantities added together.');
    expect(res.totals.cases).toBe(9);
    expect(res.totals.lines).toBe(2);
  });

  it('merging does not mutate the normalized lines', () => {
    const norm = normalizeOrderRows([
      row({ so: 'S1', date: D, cust: 'C001', item: 'W500', qty: '5' }),
      row({ so: 'S1', date: D, cust: 'C001', item: 'W500', qty: '3' }),
    ]);
    resolveOrderLines(norm, [cust('C001')], [prod('W500')], NONE);
    expect(norm.lines.map((l) => l.cases)).toEqual([5, 3]);
  });

  it('never merges rows without a sales-order number', () => {
    const res = resolve(
      [
        row({ date: D, cust: 'C001', item: 'W500', qty: '5' }),
        row({ date: D, cust: 'C001', item: 'W500', qty: '5' }),
      ],
      [cust('C001')],
      [prod('W500')],
    );
    expect(res.lines).toHaveLength(2);
    expect(res.lines.map((l) => l.sourceRows)).toEqual([[2], [3]]);
    expect(res.totals.cases).toBe(10);
    expect(res.totals.salesOrders).toBe(0);
  });

  it('does not merge the same SO + product for two different branches', () => {
    const res = resolve(
      [
        row({ so: 'S1', date: D, cust: 'C001', branch: 'B01', item: 'W500', qty: '5' }),
        row({ so: 'S1', date: D, cust: 'C001', branch: 'B02', item: 'W500', qty: '4' }),
      ],
      [cust('C001', 'B01'), cust('C001', 'B02')],
      [prod('W500')],
    );
    expect(res.lines.map((l) => l.customerKey)).toEqual(['C001::B01', 'C001::B02']);
    expect(res.lines.map((l) => l.customerId)).toEqual(['id-C001-B01', 'id-C001-B02']);
    expect(res.totals.customers).toBe(2);
    expect(res.warnings.join(' ')).not.toMatch(/added together/);
  });

  it('skips lines that were already confirmed into duplicates[]', () => {
    const confirmed = new Set([`2026-09-25|S1|${customerKey('C001', '__MAIN__')}|W500`]);
    const res = resolve(
      [
        row({ so: 'S1', date: D, cust: 'C001', item: 'w500', qty: '5' }),
        row({ so: 'S1', date: D, cust: 'C001', item: 'W1500', qty: '2' }),
        row({ date: D, cust: 'C001', item: 'W500', qty: '9' }), // no SO: cannot be matched, kept
      ],
      [cust('C001')],
      [prod('W500'), prod('W1500')],
      confirmed,
    );
    expect(res.duplicates).toHaveLength(1);
    expect(res.duplicates[0]).toMatchObject({ row: 2, cases: 5 });
    expect(res.duplicates[0].message).toMatch(/Already uploaded: sales order S1/);
    expect(res.errors).toEqual([]);
    expect(res.lines.map((l) => l.row)).toEqual([3, 4]);
    expect(res.totals.cases).toBe(11);
  });

  it('computes totals (lines, cases, customers, sales orders, dates)', () => {
    const res = resolve(
      [
        row({ so: 'S1', date: D, cust: 'C001', item: 'W500', qty: '5' }),
        row({ so: 'S1', date: D, cust: 'C001', item: 'W1500', qty: '2' }),
        row({ so: 'S2', date: D, cust: 'C002', item: 'W500', qty: '3' }),
        row({ so: 'S3', date: D, cust: 'C001', branch: 'B7', item: 'W500', qty: '4' }),
        row({ date: D, cust: 'C003', item: 'W500', qty: '1' }),
      ],
      [cust('C001'), cust('C002'), cust('C001', 'B7'), cust('C003')],
      [prod('W500'), prod('W1500')],
    );
    expect(res.totals).toEqual({ lines: 5, cases: 15, customers: 4, salesOrders: 3, deliveryDates: ['2026-09-25'] });
  });

  it('warns when the file holds more than one delivery date', () => {
    const res = resolve(
      [
        row({ so: 'S1', date: '26/09/2026', cust: 'C001', item: 'W500', qty: '5' }),
        row({ so: 'S2', date: '25/09/2026', cust: 'C001', item: 'W500', qty: '5' }),
      ],
      [cust('C001')],
      [prod('W500')],
    );
    expect(res.totals.deliveryDates).toEqual(['2026-09-25', '2026-09-26']);
    expect(res.warnings).toContain('The file contains 2 delivery dates (2026-09-25, 2026-09-26). Each date is planned separately.');
  });

  it('lists existing customers without coordinates and products without weight', () => {
    const res = resolve(
      [
        row({ so: 'S1', date: D, cust: 'C001', branch: 'B01', item: 'W500', qty: '5' }),
        row({ so: 'S2', date: D, cust: 'C001', branch: 'B01', item: 'NOWT', qty: '5' }),
      ],
      [cust('C001', 'B01', { lat: null, lng: null, name: 'Lulu Bawshar' })],
      [prod('W500'), prod('NOWT', { weightPerCaseKg: 0 })],
    );
    expect(res.issues.customersWithoutLocation).toEqual(['C001 / B01 Lulu Bawshar']);
    expect(res.issues.productsWithoutWeight).toEqual(['NOWT']);
  });

  it('a line confirmed with the same quantity is skipped; with another quantity it is an error (no amendments yet)', () => {
    const k = (so: string, item: string) => lineDupKey('2026-09-25', so, customerKey('C001', '__MAIN__'), item);
    const confirmed = new Map([
      [k('S1', 'W500'), [5]],
      [k('S2', 'W500'), [5]],
    ]);
    const res = resolve(
      [
        row({ so: 's1 ', date: D, cust: 'c001', item: 'W500', qty: '5' }), // same line, other case/spacing
        row({ so: 'S2', date: D, cust: 'C001', item: 'W500', qty: '4' }),
        row({ so: 'S2', date: D, cust: 'C001', item: 'W500', qty: '1' }), // merged: 4 + 1 = 5 = confirmed
        row({ so: 'S3', date: D, cust: 'C001', item: 'W500', qty: '9' }),
      ],
      [cust('C001')],
      [prod('W500')],
      confirmed,
    );
    expect(res.duplicates.map((d) => d.row)).toEqual([2, 3]);
    expect(res.errors).toEqual([]);
    expect(res.lines.map((l) => l.row)).toEqual([5]);

    const changed = resolve([row({ so: 'S1', date: D, cust: 'C001', item: 'W500', qty: '7' })], [cust('C001')], [prod('W500')], confirmed);
    expect(changed.lines).toEqual([]);
    expect(changed.errors).toHaveLength(1);
    expect(changed.errors[0]).toMatchObject({ row: 2, cases: 7 });
    expect(changed.errors[0].message).toMatch(/already confirmed with 5 cases; this file has 7\. Changing a confirmed line is not supported yet/);
  });

  it('the same sales order confirmed for another delivery date is a warning, not an error', () => {
    const other = new Map([[`S1|${customerKey('C001', '__MAIN__')}`, ['2026-09-24']]]);
    const norm = normalizeOrderRows([row({ so: 's1', date: D, cust: 'C001', item: 'W500', qty: '5' }), row({ so: 'S1', date: D, cust: 'C001', item: 'W1500', qty: '5' })]);
    const res = resolveOrderLines(norm, [cust('C001')], [prod('W500'), prod('W1500')], NONE, { confirmedOnOtherDates: other });
    expect(res.errors).toEqual([]);
    expect(res.lines).toHaveLength(2);
    expect(res.warnings.filter((w) => /already confirmed for 2026-09-24/.test(w))).toHaveLength(1);
  });

  it('case-variant twins in the master resolve to one row, always the same (active, then with a location)', () => {
    const lower = cust('c001', '__MAIN__', { id: 'id-lower', lat: null, lng: null });
    const upper = cust('C001', '__MAIN__', { id: 'id-upper' });
    for (const master of [[lower, upper], [upper, lower]]) {
      const res = resolve([row({ so: 'S1', date: D, cust: 'c001', item: 'w500', qty: '5' }), row({ so: 'S2', date: D, cust: 'C001', item: 'W500', qty: '5' })], master, [
        prod('w500', { id: 'p-lower', weightPerCaseKg: 0 }),
        prod('W500', { id: 'p-upper' }),
      ]);
      expect(res.lines.map((l) => l.customerId)).toEqual(['id-upper', 'id-upper']);
      expect(res.lines.map((l) => l.productId)).toEqual(['p-upper', 'p-upper']);
      expect(res.warnings.join(' ')).toMatch(/differ only in letter case/);
    }
    // An inactive twin loses to an active one; its rows are not refused.
    const res = resolve([row({ so: 'S1', date: D, cust: 'C001', item: 'W500', qty: '5' })], [cust('C001', '__MAIN__', { active: false }), cust('c001', '__MAIN__', { id: 'id-active' })], [prod('W500')]);
    expect(res.errors).toEqual([]);
    expect(res.lines[0].customerId).toBe('id-active');
  });

  it('a merged line with a blank weight on some rows takes the master weight for those cases', () => {
    const res = resolve(
      [
        { ...row({ so: 'S1', date: D, cust: 'C001', item: 'W500', qty: '5' }), Weight: '64' },
        { ...row({ so: 'S1', date: D, cust: 'C001', item: 'W500', qty: '3' }), Weight: '' },
      ],
      [cust('C001')],
      [prod('W500')],
    );
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatchObject({ cases: 8, weightKg: 64, weightMissingCases: 3 });
  });

  it('flags products without any weight (new SKUs too) and file weights far from the master', () => {
    const res = resolve(
      [
        { ...row({ so: 'S1', date: D, cust: 'C001', item: 'NEWSKU', qty: '5' }), Weight: '' },
        { ...row({ so: 'S2', date: D, cust: 'C001', item: 'NEW2', qty: '5' }), Weight: '50' },
        { ...row({ so: 'S3', date: D, cust: 'C001', item: 'W500', qty: '10' }), Weight: '12' }, // per case, not per line
        { ...row({ so: 'S4', date: D, cust: 'C001', item: 'W1500', qty: '10' }), Weight: '118' },
      ],
      [cust('C001')],
      [prod('W500'), prod('W1500')],
    );
    expect(res.issues.productsWithoutWeight).toEqual(['NEWSKU']);
    const odd = res.warnings.filter((w) => /per case, but the product's case weight/.test(w));
    expect(odd).toHaveLength(1);
    expect(odd[0]).toMatch(/^Row 4: weight 12 kg for 10 cases of W500 is 1\.2 kg per case/);
  });

  it('keeps normalize errors and sorts all errors by row', () => {
    const res = resolve(
      [
        row({ so: 'S1', date: D, cust: 'OLD', item: 'W500', qty: '5' }),
        row({ so: 'S1', date: D, cust: 'C001', item: 'W500', qty: '0' }),
      ],
      [cust('OLD', '__MAIN__', { active: false }), cust('C001')],
      [prod('W500')],
    );
    expect(res.errors.map((e) => e.row)).toEqual([2, 3]);
  });
});

describe('sales-order line identity (IntakeLineKey)', () => {
  it('normalizes the sales order: trimmed, upper-case; blank = no key', () => {
    expect(normSalesOrder('  so-1 ')).toBe('SO-1');
    expect(normSalesOrder('')).toBeNull();
    expect(normSalesOrder('   ')).toBeNull();
    expect(normSalesOrder(null)).toBeNull();
    expect(lineDupKey('2026-09-25', ' so-1', customerKey('c001', 'b1'), 'w500 ')).toBe('2026-09-25|SO-1|C001::B1|W500');
  });

  it('a row without a sales-order number gets no key and is never matched', () => {
    const confirmed = new Map([[lineDupKey('2026-09-25', 'X', customerKey('C001', '__MAIN__'), 'W500'), [5]]]);
    const res = resolveOrderLines(normalizeOrderRows([row({ date: '25/09/2026', cust: 'C001', item: 'W500', qty: '5' })]), [cust('C001')], [prod('W500')], confirmed);
    expect(res.duplicates).toEqual([]);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].salesOrderNo).toBeNull();
  });
});

describe('contentFingerprint (same-file check)', () => {
  const rows = [
    row({ so: 'S1', date: '25/09/2026', cust: 'C001', item: 'W500', qty: '5' }),
    row({ so: 'S2', date: '25/09/2026', cust: 'C002', item: 'W500', qty: '3' }),
  ];
  it('does not depend on row or column order', () => {
    const a = contentFingerprint(normalizeOrderRows(rows).lines);
    const reversedColumns = rows.map((r) => Object.fromEntries(Object.entries(r).reverse()));
    expect(contentFingerprint(normalizeOrderRows([...rows].reverse()).lines)).toBe(a);
    expect(contentFingerprint(normalizeOrderRows(reversedColumns).lines)).toBe(a);
  });
  it('includes the delivery date, also when it comes from the screen', () => {
    const noDate = rows.map(({ [H.date]: _d, ...r }) => r);
    const day1 = contentFingerprint(normalizeOrderRows(noDate, { defaultDeliveryDate: '2026-09-25' }).lines);
    const day2 = contentFingerprint(normalizeOrderRows(noDate, { defaultDeliveryDate: '2026-09-26' }).lines);
    expect(day1).not.toBe(day2);
    expect(day1).toBe(contentFingerprint(normalizeOrderRows(rows).lines));
  });
});

describe('customerTypeFromText', () => {
  it('maps free-text channels to CustomerType values', () => {
    expect(customerTypeFromText('Hypermarket')).toBe('HYPERMARKET');
    expect(customerTypeFromText('super market')).toBe('SUPERMARKET');
    expect(customerTypeFromText('Trading LLC')).toBe('TRADING');
    expect(customerTypeFromText('Catering')).toBe('CATERING');
    expect(customerTypeFromText('Hotel')).toBe('HORECA');
    expect(customerTypeFromText('HORECA')).toBe('HORECA');
    expect(customerTypeFromText('Baqala')).toBe('GROCERY');
    expect(customerTypeFromText('Mini Mart')).toBe('GROCERY');
    expect(customerTypeFromText('Wholesale')).toBe('WHOLESALE');
  });

  it('unknown text is OTHER; blank is null', () => {
    expect(customerTypeFromText('Pharmacy')).toBe('OTHER');
    expect(customerTypeFromText('')).toBeNull();
    expect(customerTypeFromText(null)).toBeNull();
    expect(customerTypeFromText(undefined)).toBeNull();
  });
});
