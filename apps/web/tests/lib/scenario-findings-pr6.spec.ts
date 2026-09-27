/**
 * Stabilization PR6 - findings of the five realistic-volume scenario tests (S01-S05, 320-450
 * invoices a day) on intake, messages and exports:
 *
 *  - B2 (S04): a workbook with order rows on two sheets (Orders + LateOrder) is refused, naming the
 *    sheets - never cut to its first sheet without a word;
 *  - S04: LATE_REASON_REQUIRED names the real reason (a plan already exists, loads dispatched), not
 *    always "after the planning cutoff";
 *  - S05: re-uploading lines already confirmed for a customer deactivated since says "already
 *    confirmed" (skipped), not only "inactive"; messages use the master codes; a refused confirm
 *    has a code;
 *  - Excel: the SUMMARY states invoices as well as delivery orders and stops; driver sheets carry
 *    the order and access notes the PDF prints; ASSUMPTIONS claims no road time factor for a
 *    straight-line plan; stored warnings are not duplicated;
 *  - the route search's raw status code is shown in plain words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { resetDb, tables } from './fake-plan-db';

const { auth } = vi.hoisted(() => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'P', email: 'p@a.example' } }),
}));
vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));

import { MultipleSheetsError, parseUpload, pickSheet } from '@/lib/csv';
import { customerKey, isOrderSheet, lineDupKey, normalizeOrderRows, resolveOrderLines, type KnownCustomer, type KnownProduct } from '@/lib/dispatch/order-intake';
import { lateReasonRequiredMessage, planExistsReason } from '@/lib/dispatch/intake-server';
import { invoiceCounts, reconcile, type ReconOrder } from '@/lib/dispatch/reconcile';
import { computeSummary } from '@/lib/dispatch/summary';
import { buildDispatchWorkbook, INVOICES_LABEL, SHEETS, tenantAssumptions, type AssumptionConfig, type WorkbookMeta } from '@/lib/dispatch/workbook';
import { isPlanFoundStatus, solverStatusText, withPlainSolverCodes } from '@/lib/dispatch/solver-status';
import { POST as uploadPost } from '@/app/api/orders/upload/route';
import { POST as confirmPost } from '@/app/api/orders/[batchId]/confirm/route';
import { fixture, ORDERS, PRODUCTS } from './plan-detail-fixture';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Order rows with the canonical headers of the scenario files (S04_Orders.xlsx). */
function orderRows(prefix: string, n: number, customer = 'S04-C01') {
  return Array.from({ length: n }, (_, i) => ({
    sales_order_no: `INV-${prefix}-${String(i + 1).padStart(5, '0')}`,
    delivery_date: '2026-10-07',
    customer_code: customer,
    branch_code: 'MAIN',
    product_code: 'TEST-W500',
    cases: 3 + i,
    weight_kg: (3 + i) * 12.4,
    priority: 3,
    notes: 'SYNTHETIC TEST',
  }));
}

/** A workbook file with one sheet per entry (sheet name -> rows). */
function workbookFile(sheets: Record<string, Record<string, unknown>[]>, name = 'S04_Orders.xlsx') {
  const wb = XLSX.utils.book_new();
  for (const [sheet, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet);
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], name, { type: XLSX_TYPE });
}

const orderSheet = (headers: string[]) => isOrderSheet(headers);

// ---------------------------------------------------------------------------------------
// B2: multi-sheet workbooks
// ---------------------------------------------------------------------------------------

describe('B2 (S04): a workbook with order rows on more than one sheet', () => {
  it('is refused, naming each sheet and its rows - nothing is read', async () => {
    const file = workbookFile({ Orders: orderRows('S04', 5), LateOrder: orderRows('LATE', 2) });
    const err = await parseUpload(file, { isDataSheet: orderSheet, rowsWord: 'order' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MultipleSheetsError);
    const e = err as MultipleSheetsError;
    expect(e.code).toBe('MULTIPLE_SHEETS');
    expect(e.sheets).toEqual([
      { name: 'Orders', rows: 5 },
      { name: 'LateOrder', rows: 2 },
    ]);
    expect(e.message).toBe(
      'This workbook has order rows on 2 sheets: "Orders" (5 rows), "LateOrder" (2 rows). Nothing was read. ' +
        'Upload each sheet as its own file (save it as a separate workbook or CSV), so each one is checked and confirmed on its own.',
    );
  });

  it('one order sheet among other sheets: that sheet is read wherever it is, the others are named in a warning', async () => {
    const file = workbookFile({ Cover: [{ title: 'NMWC daily export', printed: '2026-10-06' }], Orders: orderRows('S04', 4) });
    const parsed = await parseUpload(file, { isDataSheet: orderSheet, rowsWord: 'order' });
    expect(parsed.sheetName).toBe('Orders');
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows[0].customer_code).toBe('S04-C01');
    expect(parsed.warnings).toEqual(['Only sheet "Orders" was read. Other sheet(s) with rows but without the order columns were not read: "Cover" (1 row).']);
  });

  it('an empty template sheet (blank cells only) does not count as a second order sheet', async () => {
    const file = workbookFile({ Orders: orderRows('S04', 2), LateOrder: [{ sales_order_no: '', customer_code: '', product_code: '', cases: '' }] });
    const parsed = await parseUpload(file, { isDataSheet: orderSheet, rowsWord: 'order' });
    expect(parsed.sheetName).toBe('Orders');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.warnings).toEqual([]);
  });

  it('a one-sheet workbook reads as before, with no warning', async () => {
    const parsed = await parseUpload(workbookFile({ Orders: orderRows('S04', 3) }), { isDataSheet: orderSheet, rowsWord: 'order' });
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.warnings).toEqual([]);
  });

  it('other uploads (customer import) still read the first sheet, and name the sheets they did not read', () => {
    const pick = pickSheet([
      { name: 'Customers', rows: [{ code: 'C1' }] },
      { name: 'Branches', rows: [{ code: 'C1' }, { code: 'C2' }] },
    ]);
    expect(pick.name).toBe('Customers');
    expect(pick.warnings[0]).toBe('Only sheet "Customers" was read. Other sheet(s) with rows were not read: "Branches" (2 rows). Upload each sheet as its own file if it is needed.');
  });

  it("the tenant's own column names count as order columns", () => {
    expect(isOrderSheet(['Kunde', 'Artikel', 'Menge'])).toBe(false);
    expect(isOrderSheet(['Kunde', 'Artikel', 'Menge'], { customer_code: ['Kunde'], product_code: ['Artikel'], cases: ['Menge'] })).toBe(true);
    expect(isOrderSheet(['sales_order_no', 'customer_code', 'product_code', 'cases'])).toBe(true);
  });
});

describe('POST /api/orders/upload with a two-sheet workbook (S04 / B2)', () => {
  beforeEach(() => {
    resetDb();
    tables.tenantConfig = [{ id: 'cfg', tenantId: 'tA', orderColumnMapJson: null }];
  });

  it('answers 400 MULTIPLE_SHEETS with the sheets, and saves nothing', async () => {
    const fd = new FormData();
    fd.set('file', workbookFile({ Orders: orderRows('S04', 6), LateOrder: orderRows('LATE', 3) }));
    const res = await uploadPost(new Request('http://localhost/api/orders/upload', { method: 'POST', body: fd }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string; sheets: { name: string; rows: number }[] } };
    expect(body.error.code).toBe('MULTIPLE_SHEETS');
    expect(body.error.message).toMatch(/"Orders" \(6 rows\), "LateOrder" \(3 rows\)\. Nothing was read\. Upload each sheet as its own file/);
    expect(body.error.sheets.map((s) => s.name)).toEqual(['Orders', 'LateOrder']);
    expect(tables.uploadBatch ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// LATE_REASON_REQUIRED names the real reason (S04)
// ---------------------------------------------------------------------------------------

describe('LATE_REASON_REQUIRED names the real reason (S04)', () => {
  it('a day that already has a plan: says so (with dispatched loads), never "after the cutoff"', () => {
    const reason = planExistsReason(1, '2026-10-07', { dispatched: 2, locked: 0 });
    expect(reason).toBe('A plan (version 1) already exists for 2026-10-07 (2 of its loads are dispatched).');
    const msg = lateReasonRequiredMessage([reason]);
    expect(msg).toBe('These orders are late. A plan (version 1) already exists for 2026-10-07 (2 of its loads are dispatched). Enter the reason for accepting them.');
    expect(msg).not.toMatch(/cutoff/);
    expect(planExistsReason(3, '2026-10-07')).toBe('A plan (version 3) already exists for 2026-10-07.');
    expect(planExistsReason(2, '2026-10-07', { dispatched: 1, locked: 2 })).toBe('A plan (version 2) already exists for 2026-10-07 (1 of its loads is dispatched, 2 are locked or loading).');
  });

  it('after the cutoff: says so; late only since the check: says that', () => {
    expect(lateReasonRequiredMessage(['Received after the 18:00 cutoff for 2026-10-07.'])).toBe(
      'These orders are late. Received after the 18:00 cutoff for 2026-10-07. Enter the reason for accepting them.',
    );
    expect(lateReasonRequiredMessage(['A plan (version 1) already exists for 2026-10-07.'], { sinceCheck: true })).toMatch(
      /^These orders became late after the file was checked\. A plan \(version 1\) already exists/,
    );
  });

  describe('POST /api/orders/:batchId/confirm', () => {
    function batch(over: Record<string, unknown> = {}, reasons = ['A plan (version 1) already exists for 2026-10-07 (2 of its loads are dispatched).']) {
      return {
        id: 'B1', tenantId: 'tA', status: 'VALIDATED', errorRows: 0, depotId: 'D1', uploadedAt: new Date(), fileHash: null, fileName: 'S04_LateOrder.xlsx',
        validationJson: { lines: [{ row: 2 }], late: { isLate: true, reasons }, totals: { deliveryDates: ['2026-10-07'] }, depotId: 'D1' },
        ...over,
      };
    }
    const post = (body?: unknown) =>
      confirmPost(
        new Request('http://localhost/api/orders/B1/confirm', { method: 'POST', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }),
        { params: { batchId: 'B1' } },
      );

    beforeEach(() => resetDb());

    it('a late file for a day with a plan in use: the message names the plan and its dispatched loads', async () => {
      tables.uploadBatch = [batch()];
      const res = await post();
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string; reasons: string[] } };
      expect(body.error.code).toBe('LATE_REASON_REQUIRED');
      expect(body.error.message).toMatch(/A plan \(version 1\) already exists for 2026-10-07 \(2 of its loads are dispatched\)/);
      expect(body.error.message).not.toMatch(/cutoff/);
    });

    it('a file with row errors is refused with a code (S05)', async () => {
      tables.uploadBatch = [batch({ errorRows: 7 })];
      const res = await post();
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('FILE_HAS_ERRORS');
      expect(body.error.message).toMatch(/^This file has 7 errors: nothing was added\./);
    });
  });
});

// ---------------------------------------------------------------------------------------
// S05: re-upload after a deactivation
// ---------------------------------------------------------------------------------------

describe('S05: lines already confirmed for a customer deactivated since', () => {
  const D = '2026-10-08';
  const cust = (code: string, active = true): KnownCustomer => ({ id: `id-${code}`, code, branchKey: 'MAIN', name: code, active, lat: 23.6, lng: 58.4 });
  const prod = (code: string, active = true): KnownProduct => ({ id: `id-${code}`, code, name: code, active, weightPerCaseKg: 12.4 });
  const row = (so: string, c: string, item: string, qty: number) => ({ sales_order_no: so, delivery_date: D, customer_code: c, branch_code: 'MAIN', product_code: item, cases: String(qty) });
  const key = (so: string, c: string, item: string) => lineDupKey(D, so, customerKey(c, 'MAIN'), item);

  it('an unchanged line is a duplicate ("Already confirmed", skipped) with the inactive note - not an error', () => {
    const norm = normalizeOrderRows([row('INV-S05-00105', 's05-c05', 'test-w330', 5), row('INV-S05-00375', 's05-c05', 'test-w330', 8)]);
    const confirmed = new Map([
      [key('INV-S05-00105', 'S05-C05', 'TEST-W330'), [5]],
      [key('INV-S05-00375', 'S05-C05', 'TEST-W330'), [8]],
    ]);
    const res = resolveOrderLines(norm, [cust('S05-C05', false)], [prod('TEST-W330')], confirmed);
    expect(res.errors).toEqual([]);
    expect(res.lines).toEqual([]);
    expect(res.duplicates.map((d) => d.row)).toEqual([2, 3]);
    // Master codes (S05-C05, TEST-W330), not the file's lower case.
    expect(res.duplicates[0].message).toBe(
      'Already confirmed: sales order INV-S05-00105, TEST-W330 for S05-C05 / MAIN on 2026-10-08. Skipped. Customer S05-C05 / MAIN is inactive now: its confirmed orders are not planned until it is reactivated.',
    );
  });

  it('a new line of the inactive customer is still an error; a changed quantity says both', () => {
    const norm = normalizeOrderRows([row('INV-NEW', 's05-c05', 'TEST-W330', 4), row('INV-S05-00105', 'S05-C05', 'TEST-W330', 9)]);
    const res = resolveOrderLines(norm, [cust('S05-C05', false)], [prod('TEST-W330')], new Map([[key('INV-S05-00105', 'S05-C05', 'TEST-W330'), [5]]]));
    expect(res.duplicates).toEqual([]);
    expect(res.errors.map((e) => e.row)).toEqual([2, 3]);
    expect(res.errors[0].message).toBe('Customer S05-C05 / MAIN is inactive. Reactivate it or remove the row.');
    expect(res.errors[1].message).toMatch(/^Customer S05-C05 \/ MAIN is inactive\. Reactivate it or remove the row\. Sales order INV-S05-00105, TEST-W330 for S05-C05 \/ MAIN on 2026-10-08 was already confirmed with 5 cases; this file has 9\./);
  });

  it('a product deactivated since: its confirmed line is a duplicate too', () => {
    const norm = normalizeOrderRows([row('INV-1', 'C1', 'OLD-SKU', 6)]);
    const res = resolveOrderLines(norm, [cust('C1')], [prod('OLD-SKU', false)], new Map([[key('INV-1', 'C1', 'OLD-SKU'), [6]]]));
    expect(res.errors).toEqual([]);
    expect(res.duplicates[0].message).toMatch(/^Already confirmed: .* Skipped\. Product OLD-SKU is inactive now: its confirmed lines stay on the day\.$/);
  });
});

// ---------------------------------------------------------------------------------------
// Excel workbook
// ---------------------------------------------------------------------------------------

const META: WorkbookMeta = {
  tenantName: 'NMWC Test',
  currency: 'OMR',
  generatedAt: new Date('2026-09-24T13:05:00.000Z'),
  generatedBy: 'Planner One',
  assumptions: { Timezone: 'Asia/Muscat' },
};

async function render(d: ReturnType<typeof fixture>, meta: WorkbookMeta = META) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildDispatchWorkbook(d, meta)) as unknown as ExcelJS.Buffer);
  return wb;
}
function allText(ws: ExcelJS.Worksheet): string[] {
  const out: string[] = [];
  ws.eachRow((r) => r.eachCell((c) => out.push(c.text)));
  return out;
}
function valueOf(ws: ExcelJS.Worksheet, label: string) {
  let hit: { value: ExcelJS.CellValue; note: string } | null = null;
  ws.eachRow((r, i) => {
    if (r.getCell(1).text === label) hit = { value: ws.getCell(i, 2).value, note: ws.getCell(i, 3).text };
  });
  if (!hit) throw new Error(`no row ${label}`);
  return hit as { value: ExcelJS.CellValue; note: string };
}

/** The fixture's day with more invoices than delivery orders: C004 (o4) has one invoice per line. */
function severalInvoicesPerOrder() {
  const d = fixture();
  const orders: ReconOrder[] = ORDERS.map((o) => ({
    id: o.id,
    customerId: o.customerId,
    customerKey: `${o.code}::${o.branch ?? '__MAIN__'}`,
    lines: o.lines.map((l, i) => ({ productCode: l.sku, productName: PRODUCTS[l.sku].name, salesOrderNo: o.id === 'o4' ? `${l.so}-${i + 1}` : l.so, cases: l.cases })),
  }));
  const planned = d.loads.flatMap((l) => l.stops.map((s) => ({ orderId: s.orderIds[0], customerId: s.customerId, truckId: l.truckId, loadNo: l.loadNo })));
  d.reconciliation = reconcile(orders, planned, [{ orderId: 'o5', reasonCode: 'MISSING_COORDINATES' }]);
  return d;
}

describe('Excel SUMMARY: invoices, delivery orders and stops (S01: "Total orders 200" for 320 invoices)', () => {
  it('counts invoices from the reconciliation: fully planned, partly (split), not planned; case-insensitive; lines without an SO apart', () => {
    const orders: ReconOrder[] = [
      { id: 'a', customerId: 'ca', customerKey: 'A::M', lines: [{ id: 'a1', productCode: 'P', productName: 'P', salesOrderNo: 'SO-1', cases: 5 }, { id: 'a2', productCode: 'Q', productName: 'Q', salesOrderNo: 'so-1', cases: 2 }, { id: 'a3', productCode: 'P', productName: 'P', salesOrderNo: 'SO-2', cases: 1 }] },
      { id: 'b', customerId: 'cb', customerKey: 'B::M', lines: [{ id: 'b1', productCode: 'P', productName: 'P', salesOrderNo: 'SO-3', cases: 10 }] },
      { id: 'c', customerId: 'cc', customerKey: 'C::M', lines: [{ id: 'c1', productCode: 'P', productName: 'P', salesOrderNo: 'SO-4', cases: 4 }] },
      { id: 'n', customerId: 'cn', customerKey: 'N::M', lines: [{ id: 'n1', productCode: 'P', productName: 'P', salesOrderNo: null, cases: 3 }] },
    ];
    const r = reconcile(
      orders,
      [
        { orderId: 'a', customerId: 'ca', truckId: 't', loadNo: 1 },
        { orderId: 'b', customerId: 'cb', truckId: 't', loadNo: 1, lines: [{ lineId: 'b1', cases: 6 }] },
        { orderId: 'n', customerId: 'cn', truckId: 't', loadNo: 1 },
      ],
      [
        { orderId: 'b', reasonCode: 'EXCEEDS_ANY_TRUCK_CAPACITY', lines: [{ lineId: 'b1', cases: 4 }] },
        { orderId: 'c', reasonCode: 'SOLVER_DROPPED_LOW_PRIORITY' },
      ],
    );
    expect(r.ok).toBe(true);
    expect(invoiceCounts(r)).toEqual({ invoices: 4, planned: 2, partial: 1, unserved: 1, ordersWithoutSo: 1 });
  });

  it('SUMMARY states the invoices, the delivery orders (one per customer branch) and the stops', async () => {
    const d = severalInvoicesPerOrder();
    const s = (await render(d)).getWorksheet(SHEETS.summary)!;
    const inv = valueOf(s, INVOICES_LABEL);
    expect(inv.value).toBe(8); // 6 delivery orders, C004 with 3 invoices
    expect(inv.note).toBe('7 fully on trucks, 1 not planned');
    expect(valueOf(s, 'Delivery orders (one per customer branch)').value).toBe(6);
    expect(valueOf(s, 'Stops on trucks').value).toBe(5);
    expect(allText(s)).not.toContain('Total orders');
  });
});

describe('Excel driver sheets carry the notes the PDF prints (S01)', () => {
  it('order notes and access notes are in the Notes column, after the flags', async () => {
    const ws = (await render(fixture())).getWorksheet('T01 - L1')!;
    const texts = allText(ws);
    // C001 / B1: access notes; C002: an order note (plan-detail-fixture).
    expect(texts.some((t) => t.includes('Access: Receiving at the back gate; forklift until 14:00'))).toBe(true);
    expect(texts.some((t) => t.includes('Note: Call the store manager 30 min before'))).toBe(true);
  });
});

describe('Excel: the route search status in plain words; stored warnings once', () => {
  it('SUMMARY never shows the raw OR-Tools code', async () => {
    const d = fixture();
    d.summary = { ...d.summary!, solver: { engine: 'ortools-routing', scenario: 'RECOMMENDED', status: 'ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED', timeSec: 27.25 } };
    const s = (await render(d)).getWorksheet(SHEETS.summary)!;
    expect(allText(s).some((t) => t.includes('ROUTING_'))).toBe(false);
    const row = valueOf(s, 'Route search');
    expect(String(row.value)).toMatch(/^Best plan found in the time allowed: the search stopped at its time limit/);
    expect(row.note).toBe('RECOMMENDED option · searched 27.25 s');
  });

  it('a warning the solver returned twice is stored once', () => {
    const w = 'Distances are ESTIMATED (straight line x road factor). Configure OSRM for road distance.';
    const s = computeSummary({
      orders: [], plannedOrderIds: new Set(), unserved: [], loads: [],
      warnings: [w, w, 'Loads were re-assigned after the route search.'],
      distanceIsEstimated: true, distanceProvider: 'HAVERSINE', solver: null,
    });
    expect(s.warnings).toEqual([w, 'Loads were re-assigned after the route search.']);
  });

  it('plain words for each status code; stored reasons with a raw code are reworded', () => {
    expect(solverStatusText('ROUTING_SUCCESS', 'short')).toBe('best plan found in the time allowed');
    expect(solverStatusText('ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED', 'short')).toBe('best plan found in the time allowed (search stopped at its limit)');
    expect(solverStatusText('ROUTING_FAIL_TIMEOUT', 'short')).toBe('no plan found in the time allowed');
    expect(solverStatusText('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(solverStatusText('')).toBe('Not recorded.');
    expect(isPlanFoundStatus('ROUTING_SUCCESS')).toBe(true);
    expect(isPlanFoundStatus('ROUTING_FAIL')).toBe(false);
    expect(withPlainSolverCodes('The optimizer found no feasible plan (ROUTING_FAIL_TIMEOUT).')).toBe('The optimizer found no feasible plan (no plan found in the time allowed).');
    expect(withPlainSolverCodes(null)).toBeNull();
  });
});

describe('Excel ASSUMPTIONS: no setting the plan did not use (S01: "Road time factor x1.25" on a straight-line plan)', () => {
  const cfg: AssumptionConfig = {
    timezone: 'Asia/Muscat', planningCutoffMin: 1080, shiftStartMin: 360, driverShiftMaxMinutes: 660, reloadMinutes: 30,
    maxTripsPerTruck: 3, fuelPricePerLitre: 0.25, driverCostPerHour: 0, overtimeAfterMin: 540, overtimeCostPerHour: 0,
    prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, distanceProvider: 'HAVERSINE', distanceMultiplier: 1.3, avgSpeedKmh: 40,
    defaultServiceTimeMin: 10, osrmConfigured: false,
  };

  it('a straight-line (HAVERSINE) plan: the road time factor is "not used"', () => {
    const a = tenantAssumptions(cfg, { currency: 'OMR', providerUsed: 'HAVERSINE', distanceIsEstimated: true });
    expect(a['Road time factor (truck vs car)']).toMatch(/^not used in this plan: every distance is a straight-line estimate/);
    expect(a['Estimated-distance multiplier']).toBe('x1.3 on straight-line distance');
    expect(a['Average speed for estimates']).toBe('40 km/h');
    // OSRM configured but no routing server answered for any leg: no road leg either.
    const fallback = tenantAssumptions({ ...cfg, distanceProvider: 'OSRM' }, { currency: 'OMR', providerUsed: 'OSRM', distanceIsEstimated: true });
    expect(fallback['Road time factor (truck vs car)']).toMatch(/^not used in this plan/);
  });

  it('a road plan keeps the factor; with some estimated legs the estimate settings say where they applied', () => {
    const road = { ...cfg, distanceProvider: 'OSRM' };
    const a = tenantAssumptions(road, { currency: 'OMR', providerUsed: 'OSRM', distanceIsEstimated: false, estimatedLegs: 3 });
    expect(a['Road time factor (truck vs car)']).toBe('x1.25 on road travel times (not on estimated legs)');
    expect(a['Estimated-distance multiplier']).toBe('x1.3 on straight-line distance (on the 3 leg(s) that could not be routed on roads)');
    expect(tenantAssumptions(road, { currency: 'OMR', providerUsed: 'OSRM', distanceIsEstimated: false })['Estimated-distance multiplier']).toBeUndefined();
  });

  it('a fuel price with no truck km per litre is "not used"', () => {
    const a = tenantAssumptions(cfg, { currency: 'OMR', providerUsed: 'HAVERSINE', distanceIsEstimated: true, fuelCosted: false });
    expect(a['Fuel price']).toMatch(/^0\.25 OMR per litre - not used in this plan/);
    expect(tenantAssumptions(cfg, { currency: 'OMR', providerUsed: 'HAVERSINE', distanceIsEstimated: true, fuelCosted: true })['Fuel price']).toBe('0.25 OMR per litre');
  });
});
