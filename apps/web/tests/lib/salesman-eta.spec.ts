/**
 * Salesman ETA (owner request 17 Oct 2026), part B: the export. Pure (no database) for the window rule,
 * the model and the printable page; the route and the facts loader with a small fake database. Invented
 * data only: customers TST0001.., shops "Example Mart", routes R1, R2X, R10, coordinates 10.0001, 20.0002.
 *
 *  - etaSlot: planned arrival -15 min down to the quarter hour, +45 min up to it; kept inside the hours
 *    (opening only when the truck is planned after it; closing only when planned by it, never before the
 *    quarter hour at or after the planned arrival).
 *  - the model: one row per customer of a route (only that route's lines), split customers one line per
 *    part, cancelled orders left out, orders on no stop listed under the table (left out, moved to another
 *    day, added after the plan), "Route not given" last, routes in natural order; per-route customers,
 *    invoices, cases, pallets ("+" when a product has no cases per pallet), distinct trucks and loads; the
 *    day's totals (trucks and loads counted once in the Total row).
 *  - the page: every text escaped, the one Print script under the load sheets' policy, the summary first
 *    and one page per route, and no driver name or phone anywhere.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetailLoad, DetailStop, DetailUnserved, PlanDetail } from '@/lib/dispatch/plan-detail';
import type { DailySummary } from '@/lib/dispatch/summary';

const session = vi.hoisted(() => ({ role: 'VIEWER', tenantId: 'tA' }));
const world = vi.hoisted(() => ({
  isDispatch: true,
  detail: null as unknown,
  orders: [] as Record<string, unknown>[],
  lines: [] as Record<string, unknown>[],
  orderWheres: [] as Record<string, unknown>[],
  lineWheres: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: session.tenantId, role: session.role, name: 'Viewer One', email: 'v@a.example' } })) }));
vi.mock('@/lib/db', () => ({ prisma: { tenant: { findUnique: async () => ({ name: 'Example Water Co' }) } } }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    order: {
      findMany: async (a: { where: Record<string, unknown> }) => {
        world.orderWheres.push(a.where);
        const ids = (a.where.id as { in?: string[] } | undefined)?.in;
        return world.orders.filter((o) => o.tenantId === a.where.tenantId && (ids ? ids.includes(o.id as string) : o.dayOrder === true));
      },
    },
    orderLine: {
      findMany: async (a: { where: { orderId: { in: string[] }; order: { tenantId: string } } }) => {
        world.lineWheres.push(a.where);
        return world.lines.filter((l) => l.tenantId === a.where.order.tenantId && a.where.orderId.in.includes(l.orderId as string));
      },
    },
  }),
}));
vi.mock('@/lib/dispatch/legacy-runs', () => ({ isDispatchPlan: async () => world.isDispatch, isDispatchPlanShape: () => true }));
vi.mock('@/lib/dispatch/plan-detail', () => ({ getPlanDetail: async (tenantId: string) => (tenantId === 'tA' ? world.detail : null) }));

import { etaPalletsText, etaSlot, hhmmRange, loadSalesmanEtaFacts, longDayText, salesmanEtaModel, stopWindow, ARRIVAL_NOTE, NOT_LOCKED_NOTE, PALLETS_FOOTNOTE, type EtaDb, type SalesmanEtaFacts } from '@/lib/exports/salesman-eta';
import { renderSalesmanEtaHtml } from '@/lib/exports/salesman-eta-html';
import { PRINT_SCRIPT, PRINT_SCRIPT_HASH, SHEET_CSP } from '@/lib/dispatch/warehouse-sheets-html';
import { GET } from '@/app/api/runs/[id]/export/salesman-eta/route';

// ---------------------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------------------

const hm = (h: number, m = 0) => h * 60 + m;
const range = (s: { from: number; to: number }) => hhmmRange(s.from, s.to);

describe('etaSlot: the expected arrival window', () => {
  it('planned minus 15 down to the quarter hour, plus 45 up to it', () => {
    expect(range(etaSlot(hm(8, 5)))).toBe('07:45-09:00');
    expect(range(etaSlot(hm(8, 0)))).toBe('07:45-08:45');
    expect(range(etaSlot(hm(8, 14)))).toBe('07:45-09:00');
    expect(range(etaSlot(hm(8, 16)))).toBe('08:00-09:15');
    expect(range(etaSlot(hm(10, 30)))).toBe('10:15-11:15');
  });

  it('never announced before opening when the truck is planned after it', () => {
    expect(range(etaSlot(hm(8, 5), { opens: hm(8), closes: null }))).toBe('08:00-09:00');
    expect(range(etaSlot(hm(8, 0), { opens: hm(8), closes: hm(14) }))).toBe('08:00-08:45');
    // Opens at 06:00: the window's own start is later anyway.
    expect(range(etaSlot(hm(8, 5), { opens: hm(6), closes: hm(14) }))).toBe('07:45-09:00');
    // Planned before opening (the truck waits): not clipped on that side.
    expect(range(etaSlot(hm(7, 50), { opens: hm(8), closes: null }))).toBe('07:30-08:45');
  });

  it('never announced after closing when the truck is planned by it, but always up to the quarter hour after the planned time', () => {
    expect(range(etaSlot(hm(8, 5), { opens: null, closes: hm(8, 30) }))).toBe('07:45-08:30');
    expect(range(etaSlot(hm(8, 29), { opens: null, closes: hm(8, 30) }))).toBe('08:00-08:30');
    expect(range(etaSlot(hm(8, 30), { opens: null, closes: hm(8, 30) }))).toBe('08:15-08:30');
    // Closing at 08:20 with the truck planned at 08:20: the window still reaches 08:30, the quarter hour after it.
    expect(range(etaSlot(hm(8, 20), { opens: null, closes: hm(8, 20) }))).toBe('08:00-08:30');
    // Planned after closing (late): not clipped.
    expect(range(etaSlot(hm(14, 10), { opens: hm(6), closes: hm(14) }))).toBe('13:45-15:00');
  });

  it('a promised time of the order (10:00-10:30) wins over the hours, both sides', () => {
    const w = stopWindow({ promisedWindow: { startMin: hm(10), endMin: hm(10, 30) }, plannedHours: { hardStart: hm(6), hardEnd: hm(14), prefStart: null, prefEnd: null } });
    expect(w).toEqual({ opens: hm(10), closes: hm(10, 30) });
    expect(range(etaSlot(hm(10), w))).toBe('10:00-10:30');
    expect(stopWindow({ promisedWindow: null, plannedHours: { hardStart: hm(6), hardEnd: hm(14), prefStart: hm(7), prefEnd: hm(9) } })).toEqual({ opens: hm(6), closes: hm(14) });
    expect(stopWindow({ promisedWindow: null, plannedHours: { hardStart: null, hardEnd: null, prefStart: hm(7), prefEnd: hm(9) } })).toBeNull();
    expect(stopWindow({ promisedWindow: null, plannedHours: null })).toBeNull();
  });

  it('just after midnight the window starts at 00:00; the day text is the long one', () => {
    expect(range(etaSlot(5))).toBe('00:00-01:00');
    expect(longDayText('2026-10-18')).toBe('Sunday 18 October 2026');
    expect(longDayText('2026-02-28')).toBe('Saturday 28 February 2026');
  });
});

// ---------------------------------------------------------------------------------------
// The fixture (invented data)
// ---------------------------------------------------------------------------------------

const DAY = '2026-10-18';
const NOW = new Date('2026-10-17T17:40:00Z'); // 21:40 in Asia/Muscat
const DRIVER = 'DRIVER-NAME-SENTINEL';
const DRIVER_PHONE = '+000 DRIVER-PHONE-SENTINEL';
const HELPER = 'HELPER-NAME-SENTINEL';
const CUSTOMER_PHONE = 'CUSTOMER-PHONE-SENTINEL';

interface Ln {
  orderId: string;
  lineId: string;
  so: string | null;
  product: 'PRD-A' | 'PRD-B';
  cases: number;
  route: string | null;
}

function stop(o: {
  seq: number;
  customerId: string;
  code: string;
  name?: string;
  branch?: string | null;
  eta: number | null;
  lines: Ln[];
  hours?: [number | null, number | null] | null;
  promised?: [number | null, number | null] | null;
  located?: boolean;
  cancelled?: string[];
  split?: DetailStop['split'];
}): DetailStop {
  const hours = o.hours === undefined ? [hm(6), hm(14)] : o.hours;
  const located = o.located ?? true;
  return {
    sequence: o.seq,
    customerId: o.customerId,
    customerCode: o.code,
    branchCode: o.branch ?? null,
    customerName: o.name ?? `Example Mart ${o.code}`,
    customerType: null,
    lat: located ? 10.0001 : null,
    lng: located ? 20.0002 : null,
    priority: 3,
    etaMin: o.eta,
    serviceStartMin: o.eta,
    departureMin: o.eta === null ? null : o.eta + 15,
    waitMin: 0,
    window: 'any',
    hardWindow: null,
    promised: null,
    serviceMin: 15,
    cases: o.lines.reduce((t, l) => t + l.cases, 0),
    weightKg: 0,
    legKm: 1,
    cumulativeKm: 1,
    hardWindowOk: true,
    prefWindowOk: true,
    late: false,
    orderIds: [...new Set(o.lines.map((l) => l.orderId))],
    salesOrders: [...new Set(o.lines.map((l) => l.so).filter((x): x is string => !!x))],
    skus: [],
    mapsUrl: null,
    address: null,
    notes: [],
    accessNotes: null,
    customerPhone: CUSTOMER_PHONE,
    split: o.split ?? null,
    snapshot: true,
    masterChanged: [],
    carriedFrom: null,
    carriedTo: null,
    cancelled: !!o.cancelled?.length,
    cancelledOrderIds: o.cancelled ?? [],
    orderLines: o.lines.map((l) => ({ orderId: l.orderId, lineId: l.lineId, salesOrderNo: l.so, productCode: l.product, productName: l.product, cases: l.cases })),
    plannedHours: hours ? { hardStart: hours[0], hardEnd: hours[1], prefStart: null, prefEnd: null } : null,
    promisedWindow: o.promised ? { startMin: o.promised[0], endMin: o.promised[1] } : null,
  };
}

function load(id: string, truckId: string, truckCode: string, loadNo: number, status: string, stops: DetailStop[], util: number, km: number): DetailLoad {
  return {
    id,
    truckId,
    truckCode,
    truckCapacityCases: 100,
    truckPayloadKg: 0,
    driverId: 'drv',
    driverName: DRIVER,
    driverPhone: DRIVER_PHONE,
    driverHandSet: false,
    helpers: [{ id: 'h1', code: 'H1', name: HELPER, phone: '+000 HELPER-PHONE', active: true }],
    loadNo,
    status,
    carried: false,
    departMin: hm(6),
    returnMin: hm(16),
    distanceKm: km,
    durationMin: 600,
    cases: stops.reduce((t, s) => t + s.cases, 0),
    weightKg: 0,
    utilizationPct: util,
    fuelLitres: null,
    fuelCost: 0,
    operatingCost: 0,
    cost: null,
    returnLegKm: 1,
    distanceIsEstimated: false,
    stops,
    manifest: [],
    truckSnapshot: true,
    origin: { lat: 10.0001, lng: 20.0002 },
    masterChanged: [],
    timing: null,
    carriedAway: 0,
    cancelledHere: 0,
    break: null,
  };
}

const unserved = (orderId: string, customerId: string, code: string, cases: number, over: Partial<DetailUnserved> = {}): DetailUnserved => ({
  orderId,
  customerId,
  customerCode: code,
  branchCode: null,
  customerName: `Example Mart ${code}`,
  cases,
  weightKg: 0,
  priority: 3,
  reasonCode: 'NO_AVAILABLE_TRUCK',
  reasonMessage: null,
  late: false,
  salesOrders: [],
  partial: false,
  carriedFrom: null,
  carriedTo: null,
  cancelled: false,
  ...over,
});

// The lines, by order. TST0001 buys from two salesmen (R1 and R2X) on one invoice; TST0003 is split over
// two trucks; TST0004's order was cancelled; TST0010's order was brought forward to 20 Oct from a planned load.
const L = {
  o1a: { orderId: 'o1', lineId: 'o1-l1', so: 'INV-1', product: 'PRD-A', cases: 20, route: 'R1' },
  o1b: { orderId: 'o1', lineId: 'o1-l2', so: 'INV-1', product: 'PRD-B', cases: 10, route: 'R2X' },
  o2: { orderId: 'o2', lineId: 'o2-l1', so: 'INV-2', product: 'PRD-A', cases: 15, route: 'R10' },
  o3early: { orderId: 'o3', lineId: 'o3-l1', so: 'INV-3', product: 'PRD-A', cases: 18, route: 'R1' },
  o3late: { orderId: 'o3', lineId: 'o3-l1', so: 'INV-3', product: 'PRD-A', cases: 12, route: 'R1' },
  o4: { orderId: 'o4', lineId: 'o4-l1', so: 'INV-4', product: 'PRD-A', cases: 5, route: 'R1' },
  o5: { orderId: 'o5', lineId: 'o5-l1', so: null, product: 'PRD-A', cases: 8, route: null },
  o10: { orderId: 'o10', lineId: 'o10-l1', so: 'INV-10', product: 'PRD-A', cases: 3, route: 'R1' },
} satisfies Record<string, Ln>;

/** Every order line's facts, as loadSalesmanEtaFacts reads them (the whole line's cases). */
const LINE_FACTS: [string, { orderId: string; salesRoute: string | null; product: 'PRD-A' | 'PRD-B'; cases: number; so: string | null }][] = [
  ['o1-l1', { orderId: 'o1', salesRoute: 'R1', product: 'PRD-A', cases: 20, so: 'INV-1' }],
  ['o1-l2', { orderId: 'o1', salesRoute: 'R2X', product: 'PRD-B', cases: 10, so: 'INV-1' }],
  ['o2-l1', { orderId: 'o2', salesRoute: 'R10', product: 'PRD-A', cases: 15, so: 'INV-2' }],
  ['o3-l1', { orderId: 'o3', salesRoute: 'R1', product: 'PRD-A', cases: 30, so: 'INV-3' }],
  ['o4-l1', { orderId: 'o4', salesRoute: 'R1', product: 'PRD-A', cases: 5, so: 'INV-4' }],
  ['o5-l1', { orderId: 'o5', salesRoute: null, product: 'PRD-A', cases: 8, so: null }],
  ['o6-l1', { orderId: 'o6', salesRoute: 'R2', product: 'PRD-A', cases: 9, so: 'INV-6' }],
  ['o7-l1', { orderId: 'o7', salesRoute: 'R1', product: 'PRD-A', cases: 2, so: 'INV-7' }],
  ['o8-l1', { orderId: 'o8', salesRoute: 'R1', product: 'PRD-A', cases: 4, so: 'INV-8' }],
  ['o9-l1', { orderId: 'o9', salesRoute: 'R11X', product: 'PRD-A', cases: 6, so: 'INV-9' }],
  ['o10-l1', { orderId: 'o10', salesRoute: 'R1', product: 'PRD-A', cases: 3, so: 'INV-10' }],
];
const CASES_PER_PALLET = { 'PRD-A': 50, 'PRD-B': null } as const;

function facts(): SalesmanEtaFacts {
  return {
    lines: new Map(LINE_FACTS.map(([id, f]) => [id, { orderId: f.orderId, salesRoute: f.salesRoute, casesPerPallet: CASES_PER_PALLET[f.product], cases: f.cases, salesOrderNo: f.so }])),
    orders: new Map([
      ['o7', { cancelled: true, carriedTo: null }],
      ['o8', { cancelled: false, carriedTo: '2026-10-19' }],
      ['o10', { cancelled: false, carriedTo: '2026-10-20' }],
    ]),
    pending: [{ orderId: 'o9', customerId: 'c9', customerCode: 'TST0009', branchCode: null, customerName: 'Example Mart TST0009' }],
  };
}

function plan(over: { summary?: DailySummary | null; status?: string; name?: string } = {}): PlanDetail {
  const loads = [
    load('L1', 't1', 'TRK-1', 1, 'LOCKED', [
      stop({ seq: 1, customerId: 'c1', code: 'TST0001', name: over.name, eta: hm(8, 5), lines: [L.o1a, L.o1b] }),
      stop({ seq: 2, customerId: 'c2', code: 'TST0002', branch: 'B1', name: 'Sample Store', eta: hm(10), lines: [L.o2], hours: [hm(10), hm(10, 30)], promised: [hm(10), hm(10, 30)] }),
    ], 80, 50),
    load('L2', 't1', 'TRK-1', 2, 'PLANNED', [
      stop({ seq: 1, customerId: 'c3', code: 'TST0003', eta: hm(15), lines: [L.o3late], hours: [hm(6), hm(15, 30)], split: { part: 2, parts: 2, restUnserved: false } }),
      stop({ seq: 2, customerId: 'c4', code: 'TST0004', eta: hm(15, 30), lines: [L.o4], cancelled: ['o4'] }),
      stop({ seq: 3, customerId: 'c10', code: 'TST0010', eta: hm(16), lines: [L.o10] }),
    ], 60, 30),
    load('L3', 't2', 'TRK-2', 1, 'DISPATCHED', [
      stop({ seq: 1, customerId: 'c3', code: 'TST0003', eta: hm(7), lines: [L.o3early], hours: [hm(6), hm(15, 30)], split: { part: 1, parts: 2, restUnserved: false } }),
      stop({ seq: 2, customerId: 'c5', code: 'TST0005', eta: hm(9), lines: [L.o5], hours: null, located: false }),
    ], 90, 70),
    // A truck with an empty load: not counted anywhere.
    load('L4', 't3', 'TRK-3', 1, 'PLANNED', [], 0, 0),
  ];
  return {
    run: {
      id: 'run1',
      version: 3,
      status: over.status ?? 'READY',
      reason: 'INITIAL',
      reasonNote: null,
      runDate: DAY,
      depot: { id: 'D1', code: 'DEP1', name: 'Example Depot', lat: 10.0001, lng: 20.0002 },
      parentRunId: null,
      createdAt: '2026-10-17T15:00:00.000Z',
      supersededAt: null,
      chosenScenario: 'RECOMMENDED',
    },
    summary: over.summary ?? null,
    reconciliation: null,
    change: null,
    scenarios: [],
    loads,
    unserved: [
      unserved('o6', 'c6', 'TST0006', 9),
      unserved('o7', 'c7', 'TST0007', 2, { cancelled: true }),
      unserved('o8', 'c8', 'TST0008', 4, { carriedTo: '2026-10-19' }),
    ],
    isDispatchPlan: true,
    versions: [],
    job: null,
    warnings: [],
    pendingOrders: 1,
    timezone: 'Asia/Muscat',
  };
}

const model = (d = plan(), f = facts()) => salesmanEtaModel(d, f, { tenantName: 'Example Water Co', now: NOW });

// ---------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------

describe('salesmanEtaModel: one page per sales route', () => {
  it('routes in natural order, "Route not given" last; the head of the pages', () => {
    const m = model();
    expect(m.sections.map((s) => s.route)).toEqual(['R1', 'R2', 'R2X', 'R10', 'R11X', null]);
    expect(m.sections.map((s) => s.heading)).toEqual([
      'Route R1 · deliveries Sunday 18 October 2026',
      'Route R2 · deliveries Sunday 18 October 2026',
      'Route R2X · deliveries Sunday 18 October 2026',
      'Route R10 · deliveries Sunday 18 October 2026',
      'Route R11X · deliveries Sunday 18 October 2026',
      'Route not given · deliveries Sunday 18 October 2026',
    ]);
    expect(m).toMatchObject({
      title: 'Salesman ETA 2026-10-18 v3',
      tenantName: 'Example Water Co',
      depot: { code: 'DEP1', name: 'Example Depot' },
      dayText: 'Sunday 18 October 2026',
      version: 3,
      printedAt: '17 Oct 2026 21:40',
      superseded: false,
      notLocked: true,
    });
  });

  it('a customer is one row per route, with that route\'s lines only; rows sorted by the first expected arrival', () => {
    const m = model();
    const r1 = m.sections[0]!;
    // TST0003 first (07:00 on TRK-2), then TST0001 (08:05); TST0004 cancelled, TST0010 moved away.
    expect(r1.rows.map((r) => [r.no, r.customerCode, r.cases, r.invoices])).toEqual([
      [1, 'TST0003', 30, ['INV-3']],
      [2, 'TST0001', 20, ['INV-1']],
    ]);
    expect(r1).toMatchObject({ customers: 2, cases: 50 });
    const r2x = m.sections.find((s) => s.route === 'R2X')!;
    expect(r2x.rows.map((r) => [r.customerCode, r.cases, r.invoices])).toEqual([['TST0001', 10, ['INV-1']]]);
  });

  it('the window per delivery; a split customer has one line per part with its cases', () => {
    const r1 = model().sections[0]!;
    expect(r1.rows[0]!.parts).toEqual([
      { window: '06:45-07:45', planned: '07:00', cases: 18, part: 'part 1 of 2' },
      { window: '14:45-15:30', planned: '15:00', cases: 12, part: 'part 2 of 2' },
    ]);
    expect(r1.rows[1]!.parts).toEqual([{ window: '07:45-09:00', planned: '08:05', cases: 20, part: null }]);
  });

  it('the map link of the stop pin, the receiving hours and the order\'s own time', () => {
    const m = model();
    const r1 = m.sections[0]!;
    expect(r1.rows[1]).toMatchObject({ mapUrl: 'https://www.google.com/maps?q=10.0001,20.0002', hours: '06:00-14:00', orderTime: null, note: null });
    const r10 = m.sections.find((s) => s.route === 'R10')!;
    expect(r10.rows[0]).toMatchObject({ customerCode: 'TST0002', branchCode: 'B1', hours: null, orderTime: 'this order: 10:00-10:30' });
    expect(r10.rows[0]!.parts[0]!.window).toBe('10:00-10:30');
    const none = m.sections.at(-1)!;
    expect(none.rows[0]).toMatchObject({ customerCode: 'TST0005', mapUrl: null, hours: 'any time', invoices: ['no invoice no.'], cases: 8 });
    expect(none.rows[0]!.parts[0]!.window).toBe('08:45-09:45');
  });

  it('orders on no stop are listed under the table: left out, moved to another day, added after the plan; cancelled ones are left out', () => {
    const m = model();
    const r1 = m.sections[0]!;
    expect(r1.notPlanned).toEqual([
      { customerName: 'Example Mart TST0008', customerCode: 'TST0008', branchCode: null, invoices: ['INV-8'], cases: 4, why: 'moved to 19 Oct' },
      { customerName: 'Example Mart TST0010', customerCode: 'TST0010', branchCode: null, invoices: ['INV-10'], cases: 3, why: 'moved to 20 Oct' },
    ]);
    expect(JSON.stringify(m)).not.toMatch(/TST0004|TST0007|INV-4|INV-7/);
    const r2 = m.sections.find((s) => s.route === 'R2')!;
    expect(r2.rows).toEqual([]);
    expect(r2.notPlanned).toEqual([{ customerName: 'Example Mart TST0006', customerCode: 'TST0006', branchCode: null, invoices: ['INV-6'], cases: 9, why: 'left out of the plan' }]);
    const r11 = m.sections.find((s) => s.route === 'R11X')!;
    expect(r11.notPlanned.map((n) => [n.customerCode, n.cases, n.why])).toEqual([['TST0009', 6, 'added after this plan was made']]);
  });

  it('"Not locked yet" only on the routes with a customer on a load that is not locked', () => {
    const m = model();
    const notLocked = Object.fromEntries(m.sections.map((s) => [String(s.route), s.notLocked]));
    expect(notLocked).toEqual({ R1: true, R2: false, R2X: false, R10: false, R11X: false, null: false });
    expect(NOT_LOCKED_NOTE).toBe('Not locked yet: times can change if the day is re-planned');
  });

  it('a split customer whose rest is on no truck says so on its row', () => {
    const d = plan();
    d.loads[2]!.stops[0]!.split = { part: 1, parts: 2, restUnserved: true };
    expect(model(d).sections[0]!.rows[0]!.note).toMatch(/not on a truck on this day/);
  });
});

describe('salesmanEtaModel: the summary page', () => {
  it('per route: customers, invoices, cases, pallets (one decimal, "+" when a product has no cases per pallet), distinct trucks and loads', () => {
    const m = model();
    expect(m.routes.map((r) => [r.label, r.customers, r.invoices, r.cases, etaPalletsText(r.pallets), r.trucks, r.loads])).toEqual([
      // R1: TST0001 20 + TST0003 18 + 12 cases of PRD-A (50 per pallet): 0.4 + 0.36 + 0.24 = 1.0; on TRK-1 (2 loads) and TRK-2.
      ['R1', 2, 2, 50, '1.0', 2, 3],
      ['R2', 0, 0, 0, '0.0', 0, 0],
      // PRD-B has no cases per pallet: known sum 0, marked.
      ['R2X', 1, 1, 10, '0.0+', 1, 1],
      ['R10', 1, 1, 15, '0.3', 1, 1],
      ['R11X', 0, 0, 0, '0.0', 0, 0],
      ['Route not given', 1, 1, 8, '0.2', 1, 1],
    ]);
  });

  it('the Total row adds customers, invoices, cases and pallets; its trucks and loads are the day\'s, counted once', () => {
    const m = model();
    expect({ ...m.total, pallets: etaPalletsText(m.total.pallets) }).toEqual({ customers: 5, invoices: 5, cases: 83, pallets: '1.5+', trucks: 2, loads: 3 });
  });

  it('the day: trucks and loads with stops, distinct customers and invoices, utilisation and km as the plan screen (loads when there is no summary)', () => {
    const m = model();
    expect({ ...m.day, pallets: etaPalletsText(m.day.pallets) }).toEqual({
      trucks: 2,
      loads: 3,
      // TST0001 counted once although it buys from two routes; INV-1 once although it has lines of two routes.
      customers: 4,
      invoices: 4,
      cases: 83,
      pallets: '1.5+',
      avgUtilizationPct: 76.7,
      km: 150,
      kmLabel: 'Road km',
    });
    const withSummary = model(plan({ summary: { avgUtilizationPct: 81.2, totalKm: 149.6, distanceIsEstimated: true } as DailySummary }));
    expect(withSummary.day).toMatchObject({ avgUtilizationPct: 81.2, km: 149.6, kmLabel: 'Estimated km' });
  });

  it('a replaced plan version is VOID', () => {
    expect(model(plan({ status: 'SUPERSEDED' })).superseded).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------

describe('renderSalesmanEtaHtml', () => {
  it('the summary first, then one page per route, A4 with a page break after each', () => {
    const html = renderSalesmanEtaHtml(model());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('@page { size: A4 portrait;');
    expect(html).toContain('break-after: page');
    const kinds = [...html.matchAll(/<section class="sheet" data-kind="(\w+)"(?: data-route="([^"]*)")?/g)].map((x) => (x[1] === 'route' ? `route:${x[2]}` : x[1]));
    expect(kinds).toEqual(['summary', 'route:R1', 'route:R2', 'route:R2X', 'route:R10', 'route:R11X', 'route:']);
    expect(html).toContain('<h1>SALESMAN ETA · deliveries Sunday 18 October 2026</h1>');
    expect(html).toContain('<h1>Route R1 · deliveries Sunday 18 October 2026</h1>');
    expect(html).toContain('7 pages · A4 portrait');
  });

  it('the one script is the Print button, allowed by the load sheets\' policy (its hash)', () => {
    const html = renderSalesmanEtaHtml(model());
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`<script>${PRINT_SCRIPT}</script>`);
    expect(`sha256-${createHash('sha256').update(PRINT_SCRIPT).digest('base64')}`).toBe(PRINT_SCRIPT_HASH);
    expect(SHEET_CSP).toContain(`script-src '${PRINT_SCRIPT_HASH}'`);
  });

  it('every text is escaped', () => {
    const html = renderSalesmanEtaHtml(model(plan({ name: '<script>alert(1)</script> & "Mart" \'x\'' })));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Mart&quot; &#39;x&#39;');
    const d = plan();
    d.run.depot.name = 'Depot <b>';
    expect(renderSalesmanEtaHtml(salesmanEtaModel(d, facts(), { tenantName: 'A & <B>', now: NOW }))).toMatch(/A &amp; &lt;B&gt;[\s\S]*Depot &lt;b&gt;/);
  });

  it('no driver name, driver phone, helper or customer phone anywhere (the model included)', () => {
    const m = model();
    const html = renderSalesmanEtaHtml(m);
    for (const s of [DRIVER, DRIVER_PHONE, 'DRIVER-PHONE', HELPER, 'HELPER-PHONE', CUSTOMER_PHONE]) {
      expect(html, s).not.toContain(s);
      expect(JSON.stringify(m), s).not.toContain(s);
    }
    expect(html).not.toMatch(/driver/i);
    // No per-truck table: truck codes are not printed.
    expect(html).not.toMatch(/TRK-\d/);
  });

  it('the rows: the window big, the planned time small, map links, the hours, the lists and the notes', () => {
    const html = renderSalesmanEtaHtml(model());
    expect(html).toContain('<span class="big">07:45-09:00</span><br><span class="muted">planned 08:05</span>');
    expect(html).toContain('part 1 of 2: 18 cases');
    expect(html).toContain('<a href="https://www.google.com/maps?q=10.0001,20.0002" target="_blank" rel="noopener noreferrer">Open map</a>');
    expect(html).toContain('no location');
    expect(html).toContain('this order: 10:00-10:30');
    expect(html).toContain('any time');
    expect(html).toContain('Not in the plan for this day (the office will advise)');
    expect(html).toContain('moved to 19 Oct');
    expect(html).toContain('added after this plan was made');
    expect(html).toContain(`${NOT_LOCKED_NOTE}.`);
    expect(html).toContain(ARRIVAL_NOTE);
    expect(html).toContain(PALLETS_FOOTNOTE);
    expect(html).toContain('<td class="n">1.5+</td>');
    // The summary's Total row.
    expect(html).toMatch(/<tr class="total"><td>Total<\/td><td class="n">5<\/td><td class="n">5<\/td><td class="n">83<\/td><td class="n">1.5\+<\/td><td class="n">2<\/td><td class="n">3<\/td><\/tr>/);
  });

  it('a VOID banner on every page of a replaced version', () => {
    const html = renderSalesmanEtaHtml(model(plan({ status: 'SUPERSEDED' })));
    expect(html.match(/VOID: a newer plan version exists/g)).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------------------
// The loader and the route
// ---------------------------------------------------------------------------------------

function seedDb() {
  world.isDispatch = true;
  world.detail = plan();
  world.orderWheres = [];
  world.lineWheres = [];
  const products = { 'PRD-A': { casesPerPallet: 50 }, 'PRD-B': { casesPerPallet: null } };
  world.lines = [
    ...LINE_FACTS.map(([id, f]) => ({ tenantId: 'tA', id, orderId: f.orderId, cases: f.cases, salesOrderNo: f.so, salesRoute: f.salesRoute, product: products[f.product] })),
    // Another company's line under an id of this plan: never read.
    { tenantId: 'tB', id: 'x-l1', orderId: 'o1', cases: 99, salesOrderNo: 'OTHER', salesRoute: 'RX', product: { casesPerPallet: 1 } },
  ];
  const ids = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9', 'o10'];
  world.orders = [
    ...ids.map((id) => ({
      tenantId: 'tA',
      id,
      cancelledAt: id === 'o7' || id === 'o4' ? new Date('2026-10-17T10:00:00Z') : null,
      carriedTo: id === 'o8' ? { deliveryDate: new Date('2026-10-19T00:00:00Z') } : id === 'o10' ? { deliveryDate: new Date('2026-10-20T00:00:00Z') } : null,
      customerId: `c${id.slice(1)}`,
      customer: { code: `TST000${id.slice(1)}`, branchCode: null, name: `Example Mart ${id}` },
      // The day's orders the plan screen counts (o1 is in the plan; o9 is not).
      dayOrder: id === 'o1' || id === 'o9',
    })),
  ];
}

describe('loadSalesmanEtaFacts', () => {
  beforeEach(seedDb);

  it('reads the lines and orders of the plan and of the day\'s orders added after it, all of this company', async () => {
    const { tenantDb } = await import('@/lib/tenant');
    const f = await loadSalesmanEtaFacts(tenantDb('tA') as unknown as EtaDb, 'tA', plan());
    expect(f.pending).toEqual([{ orderId: 'o9', customerId: 'c9', customerCode: 'TST0009', branchCode: null, customerName: 'Example Mart o9' }]);
    expect(f.lines.get('o1-l2')).toEqual({ orderId: 'o1', salesRoute: 'R2X', casesPerPallet: null, cases: 10, salesOrderNo: 'INV-1' });
    expect(f.lines.has('x-l1')).toBe(false);
    expect(f.orders.get('o7')).toEqual({ cancelled: true, carriedTo: null });
    expect(f.orders.get('o10')).toEqual({ cancelled: false, carriedTo: '2026-10-20' });
    // Every read names the company; the day's orders as the plan screen counts them.
    expect(world.lineWheres.every((w) => (w as { order: { tenantId: string } }).order.tenantId === 'tA')).toBe(true);
    expect(world.orderWheres.every((w) => w.tenantId === 'tA')).toBe(true);
    expect(world.orderWheres[0]).toMatchObject({ depotId: 'D1', carriedToOrderId: null, cancelledAt: null, deliveryDate: new Date('2026-10-18T00:00:00.000Z') });
  });

  it('no read of the day\'s orders for a replaced version or when the plan has none pending', async () => {
    const { tenantDb } = await import('@/lib/tenant');
    const d = plan({ status: 'SUPERSEDED' });
    expect((await loadSalesmanEtaFacts(tenantDb('tA') as unknown as EtaDb, 'tA', d)).pending).toEqual([]);
    const none = { ...plan(), pendingOrders: 0 };
    expect((await loadSalesmanEtaFacts(tenantDb('tA') as unknown as EtaDb, 'tA', none)).pending).toEqual([]);
    expect(world.orderWheres.every((w) => 'id' in w)).toBe(true);
  });
});

describe('GET /api/runs/:id/export/salesman-eta', () => {
  beforeEach(() => {
    seedDb();
    session.role = 'VIEWER';
    session.tenantId = 'tA';
  });
  const get = () => GET(new Request('http://x/api/runs/run1/export/salesman-eta'), { params: { id: 'run1' } });

  it('readable by every role (a VIEWER too): the printable page with the load sheets\' headers', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(SHEET_CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await res.text();
    expect(html).toContain('Example Water Co');
    expect(html).toContain('Route R1 · deliveries Sunday 18 October 2026');
    expect(html).toContain('TST0009');
    expect(html).not.toContain(DRIVER);
  });

  it('404 for a run that is not a dispatch plan, for another company\'s run, and NO_LOADS for a plan without loads', async () => {
    world.isDispatch = false;
    expect((await get()).status).toBe(404);
    world.isDispatch = true;
    session.tenantId = 'tB';
    expect((await get()).status).toBe(404);
    session.tenantId = 'tA';
    world.detail = { ...plan(), loads: [] };
    const res = await get();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NO_LOADS');
  });
});
