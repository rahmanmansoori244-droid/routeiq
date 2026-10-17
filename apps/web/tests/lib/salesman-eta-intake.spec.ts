/**
 * Salesman ETA (owner request 17 Oct 2026), part A: the order file's "route" column (the salesman's
 * route code) is kept per invoice line (OrderLine.salesRoute), and every path that creates or copies an
 * order line keeps it: the file check and confirm (a line added together from several rows too), a late
 * order, and the copies made by Bring forward and Postpone (carryCopyData). The column is optional: a file
 * without it maps every column and gives every line exactly as before. The route is never part of a
 * duplicate key. Invented data only (TST codes, R1 / R2X routes).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'Planner One', email: 'p@a.example' } })) }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));

import { HEADER_ALIASES, mapHeaders, normHeader, type CanonicalField } from '@/lib/dispatch/order-headers';
import { contentFingerprint, lineDupKey, normalizeOrderRows, resolveOrderLines, type KnownCustomer, type KnownProduct } from '@/lib/dispatch/order-intake';
import { compareSalesRoutes, normSalesRoute, NO_SALES_ROUTE, SALES_ROUTE_MAX } from '@/lib/dispatch/sales-route';
import { confirmIntake, validateIntake } from '@/lib/dispatch/intake-server';
import { carryCopyData, type CarrySource } from '@/lib/dispatch/carry-over';
import { POST as uploadPost } from '@/app/api/orders/upload/route';
import { POST as lateOrder } from '@/app/api/dispatch/late-order/route';
import { addDaysIso, todayIso } from '@/lib/dispatch/time';

const T = 'tA';
// Ahead of the company's today: an order file for a day that is over is refused.
const DAY = addDaysIso(todayIso('Asia/Muscat'), 2);
const WEB = path.resolve(__dirname, '..', '..');

/** An order file's usual headers (no route column). */
const HEADERS = ['Invoice No', 'Req. Delivery Date', 'Customer Code', 'Branch', 'Customer Name', 'Item Code', 'Qty (Cases)', 'Net Value', 'CM', 'Remarks'];

describe('the route column: mapped when it is there, nothing changes when it is not', () => {
  it('"Route" is the sales route; a file without it maps every other column exactly as with it', () => {
    const without = mapHeaders(HEADERS);
    const withRoute = mapHeaders([...HEADERS, 'Route']);
    expect(without.used.sales_route).toBeUndefined();
    expect(withRoute.used.sales_route).toBe('Route');
    const { sales_route: _taken, ...others } = withRoute.used;
    expect(others).toEqual(without.used);
    expect(withRoute.unmapped).toEqual(without.unmapped);
    // The usual file maps as it always did (the same fields, the same columns).
    expect(without.used).toEqual({
      sales_order_no: 'Invoice No',
      delivery_date: 'Req. Delivery Date',
      customer_code: 'Customer Code',
      branch_code: 'Branch',
      customer_name: 'Customer Name',
      product_code: 'Item Code',
      cases: 'Qty (Cases)',
      sales_value: 'Net Value',
      margin: 'CM',
      notes: 'Remarks',
    });
  });

  it('every name of the route is understood (any case and spacing); "Route" wins over "Salesman"', () => {
    for (const h of ['ROUTE', 'Sales Route', 'salesman_route', 'Route Code', 'Salesman Code', 'Salesman']) {
      expect(mapHeaders([...HEADERS, h]).used.sales_route, h).toBe(h);
    }
    const both = mapHeaders([...HEADERS, 'Salesman', 'Route']);
    expect(both.used.sales_route).toBe('Route');
    expect(both.unmapped).toEqual(['Salesman']);
  });

  it('no name of the route is a name of another field, so it can never take another field\'s column', () => {
    const routeNames = [normHeader('sales_route'), ...HEADER_ALIASES.sales_route];
    for (const a of HEADER_ALIASES.sales_route) expect(normHeader(a), a).toBe(a);
    for (const field of Object.keys(HEADER_ALIASES) as CanonicalField[]) {
      if (field === 'sales_route') continue;
      const names = [normHeader(field), ...HEADER_ALIASES[field]];
      expect(names.filter((n) => routeNames.includes(n)), field).toEqual([]);
    }
    // Declared last: every other field has taken its column before the route is offered one.
    expect(Object.keys(HEADER_ALIASES).at(-1)).toBe('sales_route');
    // A file whose every column is a built-in name of another field gives the route none of them.
    const allOthers = (Object.keys(HEADER_ALIASES) as CanonicalField[]).filter((f) => f !== 'sales_route').flatMap((f) => HEADER_ALIASES[f]);
    expect(mapHeaders(allOthers).used.sales_route).toBeUndefined();
  });

  it("the company's own name for the column is used (Settings, order column names)", () => {
    expect(mapHeaders([...HEADERS, 'Beat'], { sales_route: ['Beat'] }).used.sales_route).toBe('Beat');
  });

  it('the route is never required: a file with only the required columns is read as before', () => {
    const r = normalizeOrderRows([{ customer_code: 'TST0001', product_code: 'PRD-A', cases: '5', delivery_date: DAY }]);
    expect(r.errors).toEqual([]);
    expect(r.lines).toHaveLength(1);
    expect('salesRoute' in r.lines[0]!).toBe(false);
  });
});

describe('normSalesRoute: one spelling per route', () => {
  it('trims, collapses inner spaces, upper-cases; blank is no route', () => {
    expect(normSalesRoute(' r2x ')).toBe('R2X');
    expect(normSalesRoute('r  10\tx')).toBe('R 10 X');
    expect(normSalesRoute('R 1')).toBe('R 1');
    expect(normSalesRoute('')).toBeNull();
    expect(normSalesRoute('   ')).toBeNull();
    expect(normSalesRoute(null)).toBeNull();
    expect(normSalesRoute(undefined)).toBeNull();
  });

  it('keeps at most 40 characters, never half of one', () => {
    expect(SALES_ROUTE_MAX).toBe(40);
    expect(normSalesRoute('r'.repeat(55))).toBe('R'.repeat(40));
    // A character outside the basic plane (two UTF-16 units) at the cut is kept whole.
    const cut = normSalesRoute(`${'A'.repeat(39)}\u{20000}B`)!;
    expect(Array.from(cut)).toHaveLength(40);
    expect(cut.endsWith('\u{20000}')).toBe(true);
    // A space at the cut is not kept at the end.
    expect(normSalesRoute(`${'A'.repeat(39)} B`)).toBe('A'.repeat(39));
  });

  it('routes sort naturally (R1, R2, R10, R11X), no route last', () => {
    const list = ['R10', null, 'R2X', 'R1', 'R11X', 'R2', 'B7'];
    expect([...list].sort(compareSalesRoutes)).toEqual(['B7', 'R1', 'R2', 'R2X', 'R10', 'R11X', null]);
    expect(NO_SALES_ROUTE).toBe('Route not given');
  });
});

const cust = (code: string): KnownCustomer => ({ id: `id-${code}`, code, branchKey: '__MAIN__', name: `Example Mart ${code}`, active: true, lat: 10.0001, lng: 20.0002 });
const prod = (code: string): KnownProduct => ({ id: `id-${code}`, code, name: `Product ${code}`, active: true, weightPerCaseKg: 10 });

describe('the file check keeps each row\'s route', () => {
  const rows = (route: (i: number) => string | null) =>
    [
      ['INV-1', 'TST0001', 'PRD-A', '5'],
      ['INV-1', 'TST0001', 'PRD-B', '3'],
      ['INV-2', 'TST0002', 'PRD-A', '7'],
    ].map(([inv, c, p, n], i) => ({
      'Invoice No': inv!,
      'Customer Code': c!,
      'Item Code': p!,
      'Qty (Cases)': n!,
      'Delivery Date': DAY,
      ...(route(i) !== null ? { Route: route(i)! } : {}),
    }));

  it('normalised per row; a blank cell is no route; errors, warnings and the duplicate keys are the same with or without the column', () => {
    const withRoute = normalizeOrderRows(rows((i) => [' r1 ', '', 'r2x'][i]!));
    const without = normalizeOrderRows(rows(() => null));
    expect(withRoute.lines.map((l) => l.salesRoute)).toEqual(['R1', null, 'R2X']);
    expect(without.lines.every((l) => !('salesRoute' in l))).toBe(true);
    expect(withRoute.errors).toEqual(without.errors);
    expect(withRoute.warnings).toEqual(without.warnings);
    // Not part of any identity: the same file with a route column is the same file.
    expect(contentFingerprint(withRoute.lines)).toBe(contentFingerprint(without.lines));
    const resolvedWith = resolveOrderLines(withRoute, [cust('TST0001'), cust('TST0002')], [prod('PRD-A'), prod('PRD-B')], new Set());
    const resolvedWithout = resolveOrderLines(without, [cust('TST0001'), cust('TST0002')], [prod('PRD-A'), prod('PRD-B')], new Set());
    const keys = (r: typeof resolvedWith) => r.lines.map((l) => lineDupKey(l.deliveryDate, l.salesOrderNo!, l.customerKey, l.productCode));
    expect(keys(resolvedWith)).toEqual(keys(resolvedWithout));
    expect(resolvedWith.totals).toEqual(resolvedWithout.totals);
  });

  it('a line confirmed before is still skipped when the file now carries a route', () => {
    const norm = normalizeOrderRows(rows(() => 'R1'));
    const confirmed = new Map([[lineDupKey(DAY, 'INV-1', 'TST0001::__MAIN__', 'PRD-A'), [5]]]);
    const r = resolveOrderLines(norm, [cust('TST0001'), cust('TST0002')], [prod('PRD-A'), prod('PRD-B')], confirmed);
    expect(r.duplicates.map((d) => d.row)).toEqual([2]);
    expect(r.lines).toHaveLength(2);
  });

  it('rows added together into one line keep the route one of them gives, whichever row gives it', () => {
    const merged = (first: string, second: string) =>
      resolveOrderLines(
        normalizeOrderRows([
          { 'Invoice No': 'INV-9', 'Customer Code': 'TST0001', 'Item Code': 'PRD-A', 'Qty (Cases)': '2', 'Delivery Date': DAY, Route: first },
          { 'Invoice No': 'INV-9', 'Customer Code': 'TST0001', 'Item Code': 'PRD-A', 'Qty (Cases)': '4', 'Delivery Date': DAY, Route: second },
        ]),
        [cust('TST0001')],
        [prod('PRD-A')],
        new Set(),
      ).lines;
    expect(merged('', 'r1').map((l) => [l.cases, l.salesRoute])).toEqual([[6, 'R1']]);
    expect(merged('R2X', '').map((l) => [l.cases, l.salesRoute])).toEqual([[6, 'R2X']]);
    expect(merged('R2X', 'R1').map((l) => [l.cases, l.salesRoute])).toEqual([[6, 'R2X']]);
  });
});

function seed() {
  resetDb();
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, orderColumnMapJson: null, timezone: 'Asia/Muscat', dateOrder: 'DMY', planningCutoffMin: 1080 }];
  tables.depot = [{ id: 'D1', tenantId: T, code: 'DEP1', name: 'Example Depot', lat: 10.0001, lng: 20.0002, active: true, historyOnly: false }];
  tables.customer = [
    { id: 'c1', tenantId: T, code: 'TST0001', branchKey: '__MAIN__', branchCode: null, name: 'Example Mart', active: true, lat: 10.0001, lng: 20.0002, priority: 3, avgServiceTimeMin: 10 },
    { id: 'c2', tenantId: T, code: 'TST0002', branchKey: '__MAIN__', branchCode: null, name: 'Sample Store', active: true, lat: 10.0003, lng: 20.0004, priority: 3, avgServiceTimeMin: 10 },
  ];
  tables.product = [
    { id: 'p1', tenantId: T, code: 'PRD-A', name: 'Product A', active: true, weightPerCaseKg: 12, volumePerCaseL: 0 },
    { id: 'p2', tenantId: T, code: 'PRD-B', name: 'Product B', active: true, weightPerCaseKg: 8, volumePerCaseL: 0 },
  ];
}

describe('confirm stores the route on each order line', () => {
  beforeEach(seed);

  it('as normalised; a blank cell stores none', async () => {
    const rows = [
      { invoice_no: 'INV-1', delivery_date: DAY, customer_code: 'TST0001', product_code: 'PRD-A', cases: '5', route: ' r1 ' },
      { invoice_no: 'INV-1', delivery_date: DAY, customer_code: 'TST0001', product_code: 'PRD-B', cases: '3', route: '' },
      { invoice_no: 'INV-2', delivery_date: DAY, customer_code: 'TST0002', product_code: 'PRD-A', cases: '7', route: 'R2X' },
    ];
    const v = await validateIntake(T, rows, { depotId: 'D1', defaultDeliveryDate: DAY });
    expect(v.mapping.sales_route).toBe('route');
    expect(v.errors).toEqual([]);
    const done = await confirmIntake(fakePrisma as never, T, { id: 'batch1', depotId: 'D1' }, v, { id: 'u1' }, { isLate: false, reason: null });
    expect(done).toMatchObject({ ordersCreated: 2, linesCreated: 3, cases: 15 });
    expect(tables.orderLine!.map((l) => [l.salesOrderNo, l.cases, l.salesRoute]).sort()).toEqual([
      ['INV-1', 3, null],
      ['INV-1', 5, 'R1'],
      ['INV-2', 7, 'R2X'],
    ]);
    // One intake key per invoice line, the route in none of them.
    expect(tables.intakeLineKey).toHaveLength(3);
    expect(JSON.stringify(tables.intakeLineKey)).not.toMatch(/R2X|"R1"/);
  });

  it('a file without the column: every line without a route, the check as before', async () => {
    const rows = [{ invoice_no: 'INV-3', delivery_date: DAY, customer_code: 'TST0001', product_code: 'PRD-A', cases: '2' }];
    const v = await validateIntake(T, rows, { depotId: 'D1', defaultDeliveryDate: DAY });
    expect(v.mapping.sales_route).toBeUndefined();
    expect(v.lines.every((l) => !('salesRoute' in l))).toBe(true);
    await confirmIntake(fakePrisma as never, T, { id: 'batch2', depotId: 'D1' }, v, { id: 'u1' }, { isLate: false, reason: null });
    expect(tables.orderLine!.map((l) => l.salesRoute)).toEqual([null]);
  });

  it('a batch checked before the route was kept (no salesRoute in its lines) confirms without one', async () => {
    const v = await validateIntake(T, [{ invoice_no: 'INV-4', delivery_date: DAY, customer_code: 'TST0002', product_code: 'PRD-B', cases: '1', route: 'R1' }], { depotId: 'D1', defaultDeliveryDate: DAY });
    for (const l of v.lines) delete l.salesRoute;
    await confirmIntake(fakePrisma as never, T, { id: 'batch3', depotId: 'D1' }, v, { id: 'u1' }, { isLate: false, reason: null });
    expect(tables.orderLine!.map((l) => l.salesRoute)).toEqual([null]);
  });

  it('the upload screen shows the column as used ("route -> sales_route")', async () => {
    const text = ['Invoice No,Customer Code,Item Code,Qty (Cases),Route', 'INV-5,TST0001,PRD-A,4,r1', 'INV-6,TST0002,PRD-B,2,'].join('\n');
    const fd = new FormData();
    fd.set('file', new File([text], 'orders.csv', { type: 'text/csv' }));
    fd.set('depotId', 'D1');
    fd.set('deliveryDate', DAY);
    const res = await uploadPost(new Request('http://localhost/api/orders/upload', { method: 'POST', body: fd }));
    const body = (await res.json()) as { data: { validation: { mapping: Record<string, string>; unmappedColumns: string[]; errorRows: number } } };
    expect(res.status).toBe(200);
    // The file reader gives the headers in lower case (lib/csv).
    expect(body.data.validation.mapping.sales_route).toBe('route');
    expect(body.data.validation.unmappedColumns).toEqual([]);
    expect(body.data.validation.errorRows).toBe(0);
    const stored = tables.uploadBatch![0]!.validationJson as { lines: { salesOrderNo: string; salesRoute: string | null }[] };
    expect(stored.lines.map((l) => [l.salesOrderNo, l.salesRoute])).toEqual([
      ['INV-5', 'R1'],
      ['INV-6', null],
    ]);
  });
});

describe('a late order keeps the route typed in', () => {
  beforeEach(seed);
  const post = (extra: Record<string, unknown>) =>
    lateOrder(
      new Request('http://x/api/dispatch/late-order', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: DAY, depotId: 'D1', customerCode: 'TST0001', reason: 'Phoned in after the cutoff', lines: [{ productCode: 'PRD-A', cases: 4 }, { productCode: 'PRD-B', cases: 1 }], ...extra }),
      }),
    );

  it('on every line, normalised like the file column', async () => {
    const res = await post({ salesRoute: ' r2x ' });
    expect(res.status).toBe(201);
    expect(tables.order![0]!.lines.map((l: { salesRoute: string | null }) => l.salesRoute)).toEqual(['R2X', 'R2X']);
  });

  it('none typed in (or blank): no route', async () => {
    expect((await post({})).status).toBe(201);
    expect((await post({ salesRoute: '  ' })).status).toBe(201);
    expect(tables.order!.flatMap((o) => o.lines.map((l: { salesRoute: string | null }) => l.salesRoute))).toEqual([null, null, null, null]);
  });
});

describe('Bring forward and Postpone copy the route with the line (carryCopyData)', () => {
  const src: CarrySource = {
    id: 'S',
    customerId: 'c1',
    deliveryDate: new Date(`${DAY}T00:00:00Z`),
    carriedFromDate: null,
    totalCases: 30,
    totalWeightKg: 300,
    totalVolumeL: 0,
    totalServiceTimeMin: 10,
    paymentCollectionAmount: 0,
    priority: 3,
    priorityFromFile: false,
    notes: null,
    salesValue: null,
    marginValue: null,
    lines: [
      { id: 'S-l1', productId: 'p1', cases: 20, salesOrderNo: 'INV-1', orderDate: null, productDescription: null, weightKg: 200, weightFromMaster: false, salesValue: null, marginValue: null, sourceRow: 2, notes: null, salesRoute: 'R1' },
      { id: 'S-l2', productId: 'p2', cases: 10, salesOrderNo: 'INV-1', orderDate: null, productDescription: null, weightKg: 100, weightFromMaster: false, salesValue: null, marginValue: null, sourceRow: 3, notes: null, salesRoute: null },
    ],
  };
  const cand = {
    date: DAY,
    firstDate: DAY,
    cases: 25,
    lines: [
      { lineId: 'S-l1', productCode: 'PRD-A', salesOrderNo: 'INV-1', cases: 15, lineCases: 20 },
      { lineId: 'S-l2', productCode: 'PRD-B', salesOrderNo: 'INV-1', cases: 10, lineCases: 10 },
    ],
  };

  it('a line with a route keeps it; a line without one is copied as before (no route key)', () => {
    const data = carryCopyData(src, cand, { tenantId: T, depotId: 'D1', date: addDaysIso(DAY, 1), late: false, userId: 'u1', now: new Date() });
    const lines = (data.lines as { create: Record<string, unknown>[] }).create;
    expect(lines.map((l) => l.salesRoute)).toEqual(['R1', undefined]);
    expect('salesRoute' in lines[1]!).toBe(false);
  });
});

describe('the schema and the migration', () => {
  const MIGRATION = '20261017200000_order_line_sales_route';
  const sql = readFileSync(path.join(WEB, 'prisma', 'migrations', MIGRATION, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('OrderLine.salesRoute is an optional text without a default', () => {
    const schema = readFileSync(path.join(WEB, 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
    const block = schema.slice(schema.indexOf('model OrderLine {'), schema.indexOf('}', schema.indexOf('model OrderLine {')));
    expect(block).toMatch(/\n\s+salesRoute\s+String\?\n/);
  });

  it('adds only the nullable column: no default, no data change, no drop; the lock is tried without waiting first', () => {
    expect(code).toContain('ALTER TABLE "OrderLine" ADD COLUMN     "salesRoute" TEXT;');
    expect(code).not.toMatch(/\bDEFAULT\b|\bNOT NULL\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bINSERT\b/i);
    expect(code).toContain('LOCK TABLE "OrderLine" IN ACCESS EXCLUSIVE MODE NOWAIT;');
    expect(code).toContain("PERFORM set_config('lock_timeout', '5s', true);");
    // The rollback is written down.
    expect(sql).toContain('-- Rollback: ALTER TABLE "OrderLine" DROP COLUMN "salesRoute";');
  });

  it('sorts after the migrations that existed when it was written (a later one may follow it)', () => {
    const folders = readdirSync(path.join(WEB, 'prisma', 'migrations'))
      .filter((n) => /^\d{14}_/.test(n))
      .sort();
    expect(folders).toContain(MIGRATION);
    expect(folders.indexOf(MIGRATION)).toBeGreaterThan(folders.indexOf('20261016220000_ivms_review_fixes'));
  });
});
