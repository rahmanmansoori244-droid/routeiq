/**
 * NMWC master dispatch workbook - pure (no DB). Builds a PlanDetail fixture with the real
 * reconcile() / computeSummary() so the fixture is internally consistent, renders the
 * workbook, loads it back with exceljs and checks what the warehouse and dispatcher rely on.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { DetailLoad, DetailStop, DetailUnserved, PlanDetail } from '@/lib/dispatch/plan-detail';
import { aggregateSkus, reconcile, type ReconOrder } from '@/lib/dispatch/reconcile';
import { computeSummary } from '@/lib/dispatch/summary';
import { buildDispatchWorkbook, loadSheetName, SHEETS, tenantAssumptions, type WorkbookMeta } from '@/lib/dispatch/workbook';

// ---------------------------------------------------------------------------------------
// Fixture: 2 trucks, 3 loads, several SKUs per stop, 1 unserved order
// ---------------------------------------------------------------------------------------

const PRODUCTS: Record<string, { name: string; kg: number }> = {
  'TAN-500-24': { name: 'Tanuf 500ml x24', kg: 12 },
  'JAB-1500-6': { name: 'Jabal 1.5L x6', kg: 9.5 },
  'TAN-5G': { name: 'Tanuf 5 gallon', kg: 20 },
};

interface FxOrder {
  id: string;
  customerId: string;
  code: string;
  branch: string | null;
  name: string;
  priority: number;
  late: boolean;
  lines: { sku: string; cases: number; so: string }[];
}

const ORDERS: FxOrder[] = [
  { id: 'o1', customerId: 'c1', code: 'C001', branch: 'B1', name: 'Lulu Hypermarket Bausher', priority: 1, late: false,
    lines: [{ sku: 'TAN-500-24', cases: 50, so: 'SO-1001' }, { sku: 'JAB-1500-6', cases: 20, so: 'SO-1001' }] },
  { id: 'o2', customerId: 'c2', code: 'C002', branch: null, name: 'Al Fair Qurum', priority: 2, late: false,
    lines: [{ sku: 'TAN-500-24', cases: 30, so: 'SO-1002' }, { sku: 'TAN-5G', cases: 10, so: 'SO-1002' }] },
  { id: 'o3', customerId: 'c3', code: 'C003', branch: null, name: 'Seeb Trading', priority: 3, late: true,
    lines: [{ sku: 'JAB-1500-6', cases: 60, so: 'SO-1003' }] },
  { id: 'o4', customerId: 'c4', code: 'C004', branch: null, name: 'Nesto Barka', priority: 2, late: false,
    lines: [{ sku: 'TAN-500-24', cases: 100, so: 'SO-1004' }, { sku: 'JAB-1500-6', cases: 25, so: 'SO-1004' }, { sku: 'TAN-5G', cases: 5, so: 'SO-1004' }] },
  { id: 'o5', customerId: 'c5', code: 'C005', branch: null, name: 'Desert Camp Catering', priority: 4, late: true,
    lines: [{ sku: 'TAN-5G', cases: 15, so: 'SO-1005' }] },
  { id: 'o6', customerId: 'c6', code: 'C001', branch: 'B2', name: 'Lulu Hypermarket Mabela', priority: 1, late: false,
    lines: [{ sku: 'TAN-500-24', cases: 40, so: 'SO-1006' }] },
];

const LONG_TRUCK = 'MCT/TRUCK-02-EXTRA-LONG-FLEET-CODE';
const byId = new Map(ORDERS.map((o) => [o.id, o]));
const casesOf = (o: FxOrder) => o.lines.reduce((a, l) => a + l.cases, 0);
const kgOf = (o: FxOrder) => o.lines.reduce((a, l) => a + l.cases * PRODUCTS[l.sku].kg, 0);
const skusOf = (o: FxOrder) =>
  aggregateSkus(o.lines.map((l) => ({ productCode: l.sku, productName: PRODUCTS[l.sku].name, cases: l.cases, weightKg: l.cases * PRODUCTS[l.sku].kg })));

function stop(orderId: string, sequence: number, legKm: number, cumulativeKm: number, etaMin: number): DetailStop {
  const o = byId.get(orderId)!;
  return {
    sequence,
    customerId: o.customerId,
    customerCode: o.code,
    branchCode: o.branch,
    customerName: o.name,
    customerType: 'HYPERMARKET',
    lat: 23.6,
    lng: 58.3,
    priority: o.priority,
    etaMin,
    serviceStartMin: etaMin + 5,
    departureMin: etaMin + 25,
    waitMin: 5,
    window: 'hard 06:00–14:00, preferred 07:00–10:00',
    hardWindow: '06:00–14:00',
    serviceMin: 20,
    cases: casesOf(o),
    weightKg: kgOf(o),
    legKm,
    cumulativeKm,
    hardWindowOk: true,
    prefWindowOk: sequence === 1,
    late: o.late,
    orderIds: [o.id],
    salesOrders: [...new Set(o.lines.map((l) => l.so))],
    skus: skusOf(o),
    mapsUrl: `https://www.google.com/maps/search/?api=1&query=23.6,58.3`,
    split: null,
  };
}

function load(id: string, truckId: string, truckCode: string, loadNo: number, stops: DetailStop[], estimated: boolean): DetailLoad {
  const cases = stops.reduce((a, s) => a + s.cases, 0);
  const km = (stops.at(-1)?.cumulativeKm ?? 0) + 8.4;
  return {
    id,
    truckId,
    truckCode,
    truckCapacityCases: 600,
    truckPayloadKg: 12000,
    driverName: loadNo === 1 ? 'Salim Al Harthy' : null,
    loadNo,
    status: loadNo === 1 ? 'LOCKED' : 'PLANNED',
    carried: false,
    departMin: 360 + (loadNo - 1) * 240,
    returnMin: 360 + (loadNo - 1) * 240 + 205,
    distanceKm: km,
    durationMin: 205,
    cases,
    weightKg: stops.reduce((a, s) => a + s.weightKg, 0),
    utilizationPct: Math.round((1000 * cases) / 600) / 10,
    fuelLitres: km / 4,
    fuelCost: (km / 4) * 0.25,
    operatingCost: 20 + km * 0.15 + (km / 4) * 0.25,
    returnLegKm: 8.4,
    distanceIsEstimated: estimated,
    stops,
    manifest: aggregateSkus(stops.flatMap((s) => s.skus)),
  };
}

function fixture(opts: { estimated?: boolean; revenue?: boolean; noUnserved?: boolean } = {}): PlanDetail {
  const estimated = opts.estimated ?? false;
  const loads = [
    load('L1', 't1', 'T01', 1, [stop('o1', 1, 12.3, 12.3, 400), stop('o2', 2, 4.1, 16.4, 450)], estimated),
    load('L2', 't1', 'T01', 2, [stop('o3', 1, 20.5, 20.5, 640), stop('o6', 2, 7.2, 27.7, 700)], estimated),
    load('L3', 't2', LONG_TRUCK, 1, [stop('o4', 1, 35.0, 35.0, 420)], estimated),
  ];
  const unservedIds = opts.noUnserved ? [] : ['o5'];
  const scope = ORDERS.filter((o) => !opts.noUnserved || o.id !== 'o5');
  const planned = loads.flatMap((l) => l.stops.map((s) => ({ orderId: s.orderIds[0], customerId: s.customerId, truckId: l.truckId, loadNo: l.loadNo })));
  const reconOrders: ReconOrder[] = scope.map((o) => ({
    id: o.id,
    customerId: o.customerId,
    customerKey: `${o.code}::${o.branch ?? '__MAIN__'}`,
    lines: o.lines.map((l) => ({ productCode: l.sku, productName: PRODUCTS[l.sku].name, salesOrderNo: l.so, cases: l.cases })),
  }));
  const reconciliation = reconcile(reconOrders, planned, unservedIds.map((orderId) => ({ orderId, reasonCode: 'MISSING_COORDINATES' })));
  const summary = computeSummary({
    orders: scope.map((o) => ({
      id: o.id,
      customerId: o.customerId,
      priority: o.priority,
      cases: casesOf(o),
      weightKg: kgOf(o),
      salesValue: opts.revenue ? casesOf(o) * 1.2 : null,
      marginValue: opts.revenue ? casesOf(o) * 0.3 : null,
      isLate: o.late,
    })),
    plannedOrderIds: new Set(planned.map((p) => p.orderId)),
    unserved: unservedIds.map((orderId) => ({ orderId, reasonCode: 'MISSING_COORDINATES' })),
    loads: loads.map((l) => ({ ...l })),
    warnings: estimated ? ['OSRM unavailable - distances estimated (Haversine x 1.3).'] : [],
    distanceIsEstimated: estimated,
    distanceProvider: estimated ? 'HAVERSINE' : 'OSRM',
    solver: { engine: 'OR-Tools', scenario: 'RECOMMENDED', status: 'OPTIMIZED', timeSec: 12.4 },
  });
  const o5 = byId.get('o5')!;
  const unserved: DetailUnserved[] = unservedIds.map(() => ({
    orderId: o5.id,
    customerId: o5.customerId,
    customerCode: o5.code,
    branchCode: o5.branch,
    customerName: o5.name,
    cases: casesOf(o5),
    weightKg: kgOf(o5),
    priority: o5.priority,
    reasonCode: 'MISSING_COORDINATES',
    reasonMessage: 'Customer C005 has no delivery location - capture it on the Locations screen.',
    late: o5.late,
    salesOrders: ['SO-1005'],
    partial: false,
  }));
  return {
    run: {
      id: 'run1',
      version: 2,
      status: 'READY',
      reason: 'LATE_ORDER',
      reasonNote: 'Lulu Mabela late order',
      runDate: '2026-09-25',
      depot: { id: 'd1', code: 'MCT', name: 'Muscat Depot', lat: 23.58, lng: 58.4 },
      parentRunId: 'run0',
      createdAt: '2026-09-24T14:00:00.000Z',
      supersededAt: null,
      chosenScenario: 'RECOMMENDED',
    },
    summary,
    reconciliation,
    change: {
      parentVersion: 1, ordersAdded: 1, assignmentsChanged: 0, assignmentsUnchanged: 4, newlyPlanned: 0, newlyUnserved: 0,
      trucksUnchanged: 1, trucksChanged: 1, lockedLoadsPreserved: 1,
      text: '1 order added, 0 assignments changed, 1 truck unchanged, 1 locked/dispatched load preserved',
    },
    scenarios: [],
    loads,
    unserved,
    versions: [],
    job: null,
    warnings: [],
  };
}

const META: WorkbookMeta = {
  tenantName: 'NMWC Test',
  currency: 'OMR',
  generatedAt: new Date('2026-09-24T13:05:00.000Z'),
  generatedBy: 'Planner One',
  assumptions: { Timezone: 'Asia/Muscat', 'Max trips per truck per day': '3' },
};

async function render(d: PlanDetail, meta: WorkbookMeta = META) {
  const buf = await buildDispatchWorkbook(d, meta);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  return wb;
}

const text = (c: ExcelJS.Cell) => (c.value === null || c.value === undefined ? '' : c.text);

/** Every non-empty cell as {row, col, text, value}. */
function cells(ws: ExcelJS.Worksheet) {
  const out: { row: number; col: number; text: string; value: ExcelJS.CellValue }[] = [];
  ws.eachRow((row, r) => row.eachCell((c, col) => out.push({ row: r, col, text: text(c), value: c.value })));
  return out;
}

function find(ws: ExcelJS.Worksheet, pred: (t: string) => boolean, col?: number, afterRow = 0) {
  return cells(ws).find((c) => c.row > afterRow && (col === undefined || c.col === col) && pred(c.text));
}

function sheet(wb: ExcelJS.Workbook, name: string) {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`missing sheet ${name}`);
  return ws;
}

// ---------------------------------------------------------------------------------------

describe('buildDispatchWorkbook', () => {
  it('writes the sheets in the agreed order, one per load', async () => {
    const d = fixture();
    const wb = await render(d);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual([
      'SUMMARY',
      'LOAD PLAN',
      'T01 - L1',
      'T01 - L2',
      loadSheetName(LONG_TRUCK, 1, new Set()),
      'SKU LOADING SUMMARY',
      'UNSERVED - EXCEPTIONS',
      'RECONCILIATION',
      'ASSUMPTIONS',
    ]);
  });

  it('sanitises load sheet names (no []:*?/\\, max 31 chars, unique)', async () => {
    const wb = await render(fixture());
    const names = wb.worksheets.map((w) => w.name);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(n).not.toMatch(/[[\]:*?/\\]/);
    }
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    const long = names[4];
    expect(long).toBe('MCT-TRUCK-02-EXTRA-LONG-FL - L1');
    expect(long.endsWith(' - L1')).toBe(true);

    const used = new Set<string>();
    const a = loadSheetName('A/B:C*D?E[F]G\\H-VERY-LONG-TRUCK-CODE-1', 1, used);
    const b = loadSheetName('A/B:C*D?E[F]G\\H-VERY-LONG-TRUCK-CODE-2', 1, used);
    expect(a).not.toBe(b);
    for (const n of [a, b]) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(n).not.toMatch(/[[\]:*?/\\]/);
    }
    expect(loadSheetName("'quoted'", 2, new Set())).not.toMatch(/^'|'$/);
    // Same truck + load twice (e.g. codes differing only by case) still gives unique names.
    const u = new Set<string>();
    const n1 = loadSheetName('t01', 1, u);
    const n2 = loadSheetName('T01', 1, u);
    expect(n1.toLowerCase()).not.toBe(n2.toLowerCase());
    expect(n2).toBe('T01 - L1 (2)');
  });

  it('every load sheet: manifest TOTAL = load cases, route has DEPOT start/end and stop details', async () => {
    const d = fixture();
    const wb = await render(d);
    const used = new Set<string>(Object.values(SHEETS).map((s) => s.toLowerCase()));
    for (const l of d.loads) {
      const ws = sheet(wb, loadSheetName(l.truckCode, l.loadNo, used));
      const manifestTitle = find(ws, (t) => t === 'LOADING MANIFEST', 1)!;
      const routeTitle = find(ws, (t) => t === 'DELIVERY ROUTE', 1)!;
      expect(manifestTitle && routeTitle).toBeTruthy();

      const total = find(ws, (t) => t === 'TOTAL', 2, manifestTitle.row)!;
      expect(total.row).toBeLessThan(routeTitle.row);
      expect(ws.getCell(total.row, 5).value).toBe(l.cases);
      // Manifest lines sum to the TOTAL row.
      let lines = 0;
      for (let r = manifestTitle.row + 2; r < total.row; r++) lines += Number(ws.getCell(r, 5).value);
      expect(lines).toBe(l.cases);

      // Route: DEPOT, stops in sequence, DEPOT, TOTAL.
      const head = routeTitle.row + 1;
      expect(text(ws.getCell(head, 13))).toBe('SKUs');
      expect(text(ws.getCell(head + 1, 2))).toBe('DEPOT');
      l.stops.forEach((s, i) => {
        const r = head + 2 + i;
        expect(ws.getCell(r, 1).value).toBe(s.sequence);
        expect(text(ws.getCell(r, 2))).toBe(s.customerCode);
        expect(text(ws.getCell(r, 5))).toBe(`P${s.priority}`);
        expect(ws.getCell(r, 11).value).toBe(s.cases);
        expect(text(ws.getCell(r, 13))).toBe(s.skus.map((k) => `${k.productCode} x${k.cases}`).join('; '));
        expect((ws.getCell(r, 17).value as ExcelJS.CellHyperlinkValue).hyperlink).toBe(s.mapsUrl);
      });
      const ret = head + 2 + l.stops.length;
      expect(text(ws.getCell(ret, 2))).toBe('DEPOT');
      expect(ws.getCell(ret, 15).value).toBe(l.returnLegKm);
      expect(ws.getCell(ret + 1, 11).value).toBe(l.cases);
      expect(find(ws, (t) => t.startsWith('Loaded by'))).toBeTruthy();
      expect(find(ws, (t) => t.startsWith('Driver (name'))).toBeTruthy();
      expect(ws.pageSetup.orientation).toBe('landscape');
      expect(ws.pageSetup.fitToWidth).toBe(1);
    }
    // Multi-SKU stop text in the agreed style.
    const t1 = sheet(wb, 'T01 - L1');
    expect(find(t1, (t) => t === 'TAN-500-24 x50; JAB-1500-6 x20', 13)).toBeTruthy();
  });

  it('SKU LOADING SUMMARY totals equal the sum of the loads', async () => {
    const d = fixture();
    const wb = await render(d);
    const ws = sheet(wb, SHEETS.skuSummary);
    const n = d.loads.length;
    expect([...Array(n).keys()].map((i) => text(ws.getCell(4, 3 + i)))).toEqual(['T01-L1', 'T01-L2', `${LONG_TRUCK}-L1`]);
    const total = find(ws, (t) => t === 'TOTAL', 1)!;
    for (let i = 0; i < n; i++) {
      expect(ws.getCell(total.row, 3 + i).value).toBe(d.loads[i].cases);
      let col = 0;
      for (let r = 5; r < total.row; r++) col += Number(ws.getCell(r, 3 + i).value ?? 0);
      expect(col).toBe(d.loads[i].cases);
    }
    const all = d.loads.reduce((a, l) => a + l.cases, 0);
    expect(ws.getCell(total.row, 3 + n).value).toBe(all);
    expect(total.row - 5).toBe(3); // three distinct SKUs
    const check = find(ws, (t) => t === 'Check', 1)!;
    for (let i = 0; i <= n; i++) expect(text(ws.getCell(check.row, 3 + i))).toBe('OK');
  });

  it('UNSERVED sheet lists the unserved order with its reason', async () => {
    const wb = await render(fixture());
    const ws = sheet(wb, SHEETS.unserved);
    const row = find(ws, (t) => t === 'C005', 1)!;
    expect(row).toBeTruthy();
    expect(text(ws.getCell(row.row, 4))).toBe('P4');
    expect(ws.getCell(row.row, 5).value).toBe(15);
    expect(text(ws.getCell(row.row, 7))).toBe('SO-1005');
    expect(text(ws.getCell(row.row, 8))).toBe('LATE');
    expect(text(ws.getCell(row.row, 9))).toBe('MISSING_COORDINATES');
    expect(text(ws.getCell(row.row, 10))).toContain('no delivery location');
    expect(find(ws, (t) => t === 'All orders planned')).toBeUndefined();
  });

  it('UNSERVED sheet says "All orders planned" when nothing is unserved', async () => {
    const wb = await render(fixture({ noUnserved: true }));
    expect(find(sheet(wb, SHEETS.unserved), (t) => t === 'All orders planned')).toBeTruthy();
    expect(text(sheet(wb, SHEETS.reconciliation).getCell(6, 2))).toBe('OK');
  });

  it('labels distances "Estimated km" only when they are estimated', async () => {
    const road = await render(fixture({ estimated: false }));
    expect(find(sheet(road, SHEETS.summary), (t) => t === 'Total road km', 1)).toBeTruthy();
    expect(find(sheet(road, SHEETS.summary), (t) => t === 'Estimated km', 1)).toBeUndefined();
    expect(find(sheet(road, SHEETS.loadPlan), (t) => t === 'Route km', undefined)).toBeTruthy();
    expect(find(sheet(road, 'T01 - L1'), (t) => t === 'Route km', 6)).toBeTruthy();

    const dEst = fixture({ estimated: true });
    const est = await render(dEst);
    const s = sheet(est, SHEETS.summary);
    const label = find(s, (t) => t === 'Estimated km', 1)!;
    expect(label).toBeTruthy();
    expect(s.getCell(label.row, 2).value).toBe(dEst.summary!.totalKm);
    expect(find(s, (t) => t === 'Total road km', 1)).toBeUndefined();
    expect(find(sheet(est, SHEETS.loadPlan), (t) => t === 'Estimated km')).toBeTruthy();
    expect(find(sheet(est, 'T01 - L1'), (t) => t === 'Estimated km', 6)).toBeTruthy();
    expect(find(sheet(est, 'T01 - L1'), (t) => t === 'Km from prev (est.)')).toBeTruthy();
  });

  it('shows "not supplied" for revenue and margin when they are missing, and the numbers when present', async () => {
    const wb = await render(fixture({ revenue: false }));
    const s = sheet(wb, SHEETS.summary);
    const rev = find(s, (t) => t.startsWith('Revenue served'), 1)!;
    const mar = find(s, (t) => t.startsWith('Contribution margin served'), 1)!;
    expect(text(s.getCell(rev.row, 2))).toBe('not supplied');
    expect(text(s.getCell(mar.row, 2))).toBe('not supplied');

    const d = fixture({ revenue: true });
    const s2 = sheet(await render(d), SHEETS.summary);
    const rev2 = find(s2, (t) => t.startsWith('Revenue served'), 1)!;
    const mar2 = find(s2, (t) => t.startsWith('Contribution margin served'), 1)!;
    expect(s2.getCell(rev2.row, 2).value).toBe(d.summary!.revenueServed);
    expect(s2.getCell(mar2.row, 2).value).toBe(d.summary!.marginServed);
    expect(s2.getCell(mar2.row, 2).numFmt).toBe('0.000');
  });

  it('SUMMARY carries the plan header, KPIs, reconciliation status and change text', async () => {
    const d = fixture();
    const s = sheet(await render(d), SHEETS.summary);
    const val = (label: string) => {
      const c = find(s, (t) => t === label, 1);
      if (!c) throw new Error(`no ${label}`);
      return s.getCell(c.row, 2);
    };
    expect(text(s.getCell(1, 1))).toBe('NMWC Daily Dispatch Plan');
    expect(text(val('Depot'))).toBe('MCT - Muscat Depot');
    expect(text(val('Delivery date'))).toBe('2026-09-25');
    expect(text(val('Plan version'))).toBe('v2');
    expect(text(val('Plan reason'))).toBe('LATE_ORDER');
    expect(text(val('Generated at'))).toBe('2026-09-24 17:05'); // Asia/Muscat = UTC+4
    expect(val('Total orders').value).toBe(6);
    expect(val('Orders unserved').value).toBe(1);
    expect(val('P1 service %').value).toBe(100);
    expect(text(val('P5 service %'))).toBe('—');
    expect(val('Physical trucks used').value).toBe(2);
    expect(val('Total trips (loads)').value).toBe(3);
    expect(text(val('Late orders (served / total)'))).toBe('1 / 2');
    expect(text(val('Status'))).toBe('OK');
    expect(find(s, (t) => t.startsWith('1 order added'))).toBeTruthy();
  });

  it('RECONCILIATION shows totals, by SKU, by sales order; ASSUMPTIONS has settings and fixed notes', async () => {
    const d = fixture();
    const wb = await render(d);
    const r = sheet(wb, SHEETS.reconciliation);
    const rc = d.reconciliation!;
    expect(rc.ok).toBe(true);
    expect([r.getCell(4, 3).value, r.getCell(4, 4).value, r.getCell(4, 5).value]).toEqual([rc.uploadedCases, rc.plannedCases, rc.unservedCases]);
    expect(text(r.getCell(4, 6))).toBe('OK');
    expect(text(r.getCell(6, 2))).toBe('OK');
    for (const x of rc.bySku) expect(find(r, (t) => t === x.key, 1)).toBeTruthy();
    for (const x of rc.bySalesOrder) expect(find(r, (t) => t === x.key, 1)).toBeTruthy();
    expect(find(r, (t) => t === 'MISMATCH')).toBeUndefined();

    const a = sheet(wb, SHEETS.assumptions);
    expect(find(a, (t) => t === 'Max trips per truck per day', 1)).toBeTruthy();
    expect(find(a, (t) => t.includes('not a proven optimum'))).toBeTruthy();
    expect(find(a, (t) => t.includes('P1 = HIGHEST'))).toBeTruthy();
    expect(find(a, (t) => t.includes('Preferred windows are soft'))).toBeTruthy();
    expect(find(a, (t) => t.includes('counted once'))).toBeTruthy();
  });

  it('flags a load whose manifest does not match its recorded cases', async () => {
    const d = fixture();
    d.loads[0] = { ...d.loads[0], cases: d.loads[0].cases + 1 };
    const wb = await render(d);
    expect(text(sheet(wb, SHEETS.summary).getCell(find(sheet(wb, SHEETS.summary), (t) => t === 'Status', 1)!.row, 2))).toBe('FAILED');
    expect(find(sheet(wb, 'T01 - L1'), (t) => t.startsWith('MISMATCH'))).toBeTruthy();
    expect(find(sheet(wb, SHEETS.skuSummary), (t) => t === 'MISMATCH')).toBeTruthy();
  });
});

describe('tenantAssumptions', () => {
  it('reports the tenant settings the plan was built with', () => {
    const a = tenantAssumptions(
      {
        timezone: 'Asia/Muscat', planningCutoffMin: 1080, shiftStartMin: 360, driverShiftMaxMinutes: 540, reloadMinutes: 30,
        maxTripsPerTruck: 3, fuelPricePerLitre: 0.25, driverCostPerHour: 1.5, overtimeAfterMin: 540, overtimeCostPerHour: 0,
        prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, distanceProvider: 'OSRM', distanceMultiplier: 1.3, avgSpeedKmh: 40,
        defaultServiceTimeMin: 10, osrmUrl: null, priorityWeightsJson: null,
      },
      { currency: 'OMR', providerUsed: 'OSRM', distanceIsEstimated: false, osrmEnvConfigured: false },
    );
    expect(a['Planning cutoff (day before delivery)']).toContain('18:00');
    expect(a['Shift start (earliest departure)']).toBe('06:00');
    expect(a['Fuel price']).toBe('0.25 OMR per litre');
    // The planner ranks priorities strictly (the weights are no longer used): the export says so.
    expect(a.Priorities).toMatch(/^strict - one higher-priority order always wins/);
    expect(a['Priority weights']).toBeUndefined();
    expect(a['Loading time per case']).toBe('not set (0)');
    expect(a['OSRM server configured']).toMatch(/^no/);
    expect(a['Estimated-distance multiplier']).toBeUndefined();
    expect(tenantAssumptions(null, { currency: 'OMR', providerUsed: null, distanceIsEstimated: null, osrmEnvConfigured: false })).toEqual({
      'Tenant configuration': 'not set - system defaults were used',
    });
  });
});
