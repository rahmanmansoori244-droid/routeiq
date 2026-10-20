/**
 * Loading instruction per customer (owner request 16 Oct 2026: some customers need their order loaded on
 * the truck in a specific way; the dispatcher and the warehouse must see it at the top of the load
 * sheet). lib/dispatch/loading-instruction.ts:
 * - the rule: one line, at most 200 characters, '' = none, invisible and direction characters dropped;
 *   what the sheets print (a longer value written to the database by hand is shortened, never dropped:
 *   review M6);
 * - one entry per customer of a load, with its stops; a stop nothing of which is loaded (every order
 *   cancelled or brought forward) is left out, a stop with one order brought forward is not (review L1);
 *   each load on its own (trip 2 of a truck, another truck), a stop brought forward from an earlier day
 *   kept;
 * - POST /api/customers (the Customers page's create) stores it by the same rule;
 * - on the in-memory database (fake-plan-db.ts): getPlanDetail reads it live (a change after LOCK reaches
 *   the plan, the load sheet and the driver sheet, and is never "changed after planning"), it never stops
 *   LOCK, and a stop without one is exactly as before;
 * - the day screen (the REAL PlanView through the hook host): a LOADING INSTRUCTION badge on the load, and
 *   on the stop with its text, only where something of the stop is loaded.
 * The sheets' layout is in warehouse-sheets.spec.ts, driver-pack.spec.ts and dispatch-workbook.spec.ts;
 * the Details dialog and the PATCH in dispatch-customer-details.spec.ts; the real-PostgreSQL path in
 * tests/integration/dispatch-mvp.spec.ts (27f). Every name here is invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';
import { Host, elements, textOf, typeName } from './hook-host';
import { fixture, INSTRUCTED, instructionFixture } from './plan-detail-fixture';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>) => m.fakePrisma.auditLog.create({ data: { ...input } })) };
});
// POST /api/customers (as customer-code.spec.ts): a dispatcher's session and the default service area.
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'Planner One', email: 'one@example.com' } })) }));
vi.mock('@/lib/dispatch/service-area', async () => {
  const { DEFAULT_SERVICE_AREA } = await import('@/lib/dispatch/location-input');
  return { tenantServiceArea: async () => DEFAULT_SERVICE_AREA };
});
// The plan screen through the hook host (as dispatch-one-way-moves.spec.ts): only api(), the toasts and the maps replaced.
vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
const answers = vi.hoisted(() => ({ plan: null as unknown }));
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, errorBody: null });
  return {
    ...actual,
    api: async (url: string) => {
      if (url.endsWith('/plan')) return ok(structuredClone(answers.plan));
      if (url === '/api/drivers' || url === '/api/helpers') return ok([]);
      if (url.endsWith('/outcomes')) return ok(null);
      return ok({});
    },
  };
});
vi.mock('sonner', () => ({ toast: { success() {}, error() {}, warning() {}, info() {} } }));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));

import {
  foldLoadingInstruction,
  instructionLine,
  LOADING_INSTRUCTION_BADGE,
  LOADING_INSTRUCTION_FIELD_LABEL,
  LOADING_INSTRUCTION_MAX,
  loadInstructions,
  loadingInstructionText,
  readLoadingInstruction,
  SPECIAL_LOADING_HEADING,
  specialLoadingLead,
  specialLoadingTitle,
  stopIsLoaded,
  type InstructionStop,
} from '@/lib/dispatch/loading-instruction';
import { updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { driverPackModel } from '@/lib/dispatch/driver-pack';
import { loadSheetModel } from '@/lib/dispatch/warehouse-sheets';
import { renderLoadSheetHtml } from '@/lib/dispatch/warehouse-sheets-html';
import { PlanView } from '@/app/t/[slug]/dispatch/plan-view';
import { POST as createCustomer } from '@/app/api/customers/route';

const WATER = 'Water at the bottom, max 5 layers';

describe('the rule (loading-instruction.ts)', () => {
  it('the words the screens and the sheets use', () => {
    expect(LOADING_INSTRUCTION_BADGE).toBe('LOADING INSTRUCTION');
    expect(SPECIAL_LOADING_HEADING).toBe('SPECIAL LOADING');
    expect(LOADING_INSTRUCTION_FIELD_LABEL).toBe('Loading instruction (warehouse)');
    expect(LOADING_INSTRUCTION_MAX).toBe(200);
    expect(specialLoadingLead(1)).toBe('Load this truck as this customer requires:');
    expect(specialLoadingLead(2)).toBe('Load this truck as these customers require:');
    expect(specialLoadingTitle(1)).toBe('SPECIAL LOADING - load as this customer requires:');
    expect(specialLoadingTitle(3)).toBe('SPECIAL LOADING - load as these customers require:');
  });

  it('as typed: one line, trimmed, control characters dropped; empty = none; at most 200 characters, with the reason', () => {
    expect(readLoadingInstruction(`  ${WATER}  `)).toEqual({ ok: true, text: WATER });
    expect(readLoadingInstruction('Water at the bottom,\r\n\tmax 5\u0000 layers\u0007')).toEqual({ ok: true, text: WATER });
    for (const none of ['', '   ', '\n\n', null, undefined, '\u0000']) expect(readLoadingInstruction(none), JSON.stringify(none)).toEqual({ ok: true, text: null });
    expect(readLoadingInstruction('x'.repeat(200))).toEqual({ ok: true, text: 'x'.repeat(200) });
    // Folded first: 200 characters with line breaks in between are 200 characters.
    expect(readLoadingInstruction(`${'x'.repeat(100)}\n\n\n${'y'.repeat(99)}`)).toEqual({ ok: true, text: `${'x'.repeat(100)} ${'y'.repeat(99)}` });
    expect(readLoadingInstruction('x'.repeat(201))).toEqual({ ok: false, error: 'Loading instruction: at most 200 characters (201 typed).' });
    expect(readLoadingInstruction(5)).toEqual({ ok: false, error: 'Loading instruction: text only.' });
    // Arabic is kept as it is (the HTML load sheet prints it; the driver PDF says it cannot).
    expect(readLoadingInstruction(' الماء في الأسفل ')).toEqual({ ok: true, text: 'الماء في الأسفل' });
  });

  it('invisible and direction characters are dropped, so a hidden right-to-left override cannot reverse the joined lines; joiners alone are none (review of 16 Oct)', () => {
    // A right-to-left override, a zero-width space, an isolate, a mark and a byte-order mark, all invisible.
    expect(readLoadingInstruction('Water\u202E at the bottom\u200B,\u2066 max 5 layers\u2069\u200F\uFEFF')).toEqual({ ok: true, text: WATER });
    for (const none of ['\u200B', '\u202E \u2069', '\uFEFF', '\u200D', ' \u200C\u200D ', '\u061C\u2060']) {
      expect(readLoadingInstruction(none), JSON.stringify(none)).toEqual({ ok: true, text: null });
      expect(loadingInstructionText(none), JSON.stringify(none)).toBeNull();
    }
    // The joiners between letters are kept (they shape Arabic letters and emoji).
    expect(readLoadingInstruction('a\u200Db\u200Cc')).toEqual({ ok: true, text: 'a\u200Db\u200Cc' });
    // Counted without them: 200 letters and two marks are 200 characters.
    expect(readLoadingInstruction(`${'x'.repeat(200)}\u200F\u200F`)).toEqual({ ok: true, text: 'x'.repeat(200) });
    expect(loadingInstructionText('\u202EPallets first\u202C')).toBe('Pallets first');
    expect(foldLoadingInstruction(' Water\n at\u200B the bottom ')).toBe('Water at the bottom');
    expect(foldLoadingInstruction('x'.repeat(250))).toBe('x'.repeat(250));
  });

  it('as printed: a value written to the database by hand is folded and shortened with "…", never dropped (review M6)', () => {
    expect(loadingInstructionText(null)).toBeNull();
    expect(loadingInstructionText('  \n ')).toBeNull();
    expect(loadingInstructionText(`Line one\nline two`)).toBe('Line one line two');
    const long = loadingInstructionText(`${'word '.repeat(60)}end`)!;
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
    expect(long.startsWith('word word')).toBe(true);
    // Never half of a two-unit character.
    const emoji = loadingInstructionText(`${'x'.repeat(198)}😀😀😀`)!;
    expect(emoji).toBe(`${'x'.repeat(198)}…`);
  });
});

describe('the instructions of a load (loadInstructions)', () => {
  const st = (sequence: number, customerId: string, over: Partial<InstructionStop> = {}): InstructionStop => ({
    sequence,
    customerId,
    customerName: `Shop Example ${customerId}`,
    customerCode: customerId.toUpperCase(),
    branchCode: null,
    orderIds: [`o${sequence}`],
    ...over,
  });

  it('one line per customer, in stop order, with its stops ascending; customers without one are not listed', () => {
    const list = loadInstructions([
      st(5, 'a', { loadingInstruction: WATER }),
      st(2, 'b'),
      st(3, 'a', { loadingInstruction: WATER, branchCode: 'B2' }),
      st(4, 'c', { loadingInstruction: 'Cartons on top only' }),
    ]);
    expect(list.map((i) => [i.customerId, i.stops, i.text])).toEqual([
      ['a', [3, 5], WATER],
      ['c', [4], 'Cartons on top only'],
    ]);
    expect(instructionLine(list[0]!)).toBe(`Stops 3, 5 Shop Example a (A / B2): ${WATER}`);
    expect(instructionLine({ ...list[1]!, customerName: 'Hyper Example A', customerCode: 'C100', branchCode: 'B2' })).toBe('Stop 4 Hyper Example A (C100 / B2): Cartons on top only');
    expect(loadInstructions([st(1, 'b'), st(2, 'c', { loadingInstruction: '  ' })])).toEqual([]);
  });

  it('leaves out a stop nothing of which is loaded: every order cancelled, or brought forward to a later day', () => {
    const cancelled = st(1, 'a', { loadingInstruction: WATER, orderIds: ['o1', 'o2'], cancelledOrderIds: ['o1', 'o2'] });
    const carried = st(2, 'b', { loadingInstruction: WATER, orderIds: ['o3'], carriedOrderIds: ['o3'] });
    const both = st(3, 'c', { loadingInstruction: WATER, orderIds: ['o4', 'o5'], cancelledOrderIds: ['o4'], carriedOrderIds: ['o5'] });
    expect(loadInstructions([cancelled, carried, both])).toEqual([]);
    expect([cancelled, carried, both].map(stopIsLoaded)).toEqual([false, false, false]);
  });

  it('keeps a stop with one order cancelled or brought forward and another still loaded (review L1)', () => {
    const partly = st(1, 'a', { loadingInstruction: WATER, orderIds: ['o1', 'o2'], carriedOrderIds: ['o1'] });
    const partlyCancelled = st(2, 'b', { loadingInstruction: WATER, orderIds: ['o3', 'o4'], cancelledOrderIds: ['o4'] });
    expect(loadInstructions([partly, partlyCancelled]).map((i) => i.stops)).toEqual([[1], [2]]);
  });
});

// ------------------------------------------------------------------------------------------------
// On the in-memory database (as small-truck-gate.spec.ts)
// ------------------------------------------------------------------------------------------------

const T = 'tA';
const user = { id: 'u1', role: 'TENANT_ADMIN' };
const allow = () => true;
const DAY = new Date('2026-10-17T00:00:00Z');
const RULES = { shiftStartMin: 360, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0.5, maxTrips: 3, depotOpenMin: 0, depotCloseMin: 1440, availableFromMin: null, availableToMin: null };
const truckSnap = (code: string) => ({
  v: 1, code, capacityCases: 1140, capacityWeightKg: 0, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.1, kmPerLitre: null, bays: 6,
  availableFromMin: null, availableToMin: null, maxTripsPerDay: null, rules: RULES, source: 'PLAN', capturedAt: '2026-10-16T12:00:00Z',
});
const customer = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, tenantId: T, code: id.toUpperCase(), branchCode: null, branchKey: '__MAIN__', name, customerType: null, address: 'Example street',
  accessNotes: null, lat: 23.6, lng: 58.4, priority: 2, priorityConfirmed: true, avgServiceTimeMin: 20, serviceTimeConfirmed: true,
  hardWindowStartMin: 360, hardWindowEndMin: 840, prefWindowStartMin: null, prefWindowEndMin: null, active: true, locationVerified: true, createdFromUpload: false,
  smallTruckOnly: false, ...over,
});
const stopSnap = (c: ReturnType<typeof customer>) => ({
  v: 1, customerId: c.id, code: c.code, branchCode: null, name: c.name, customerType: null, lat: 23.6, lng: 58.4, address: 'Example street', accessNotes: null,
  hardStartMin: 360, hardEndMin: 840, prefStartMin: null, prefEndMin: null, serviceMin: 20, priority: 2, source: 'PLAN', capturedAt: '2026-10-16T12:00:00Z',
});
const lines = (id: string) => [{ id: `${id}-l1`, cases: 40, weightKg: 400, weightFromMaster: false, salesOrderNo: `INV-${id}`, product: { code: 'W15', name: 'Water 1.5L', weightPerCaseKg: 10 } }];
const order = (id: string, c: ReturnType<typeof customer>, over: Record<string, unknown> = {}) => ({
  id, tenantId: T, customerId: c.id, customer: c, lines: lines(id), totalCases: 40, totalWeightKg: 400, priority: 2, salesValue: null, marginValue: null,
  isLate: false, status: 'ASSIGNED', notes: null, depotId: 'D1', deliveryDate: DAY, ...over,
});
function assignment(id: string, loadId: string, orderId: string, c: ReturnType<typeof customer>, sequenceInTruck: number, orderInStop = 0) {
  return {
    id, runId: 'P', truckId: 'T05', orderId, sequenceInTruck, plannedArrivalMin: 20, plannedDistanceFromPrevKm: 5, plannedLoadCases: 40,
    lockedByUserId: null, manualOverrideReason: null, loadId, loadNo: 1, orderInStop, etaMin: 400 + 30 * sequenceInTruck, serviceStartMin: 400 + 30 * sequenceInTruck,
    departureMin: 420 + 30 * sequenceInTruck, waitMin: 0, cumulativeKm: 5 * sequenceInTruck, hardWindowOk: true, prefWindowOk: true, portionCases: null, portionWeightKg: null,
    portionLinesJson: null, stopSnapshotJson: stopSnap(c),
  };
}

/** One plan: T05 L1 carries Hyper Example A (stops 1 and 3, two branches' worth as one row here) and Shop Example B (stop 2). */
function seed(a: Record<string, unknown> = {}, b: Record<string, unknown> = {}) {
  const ca = customer('c100', 'Hyper Example A', a);
  const cb = customer('c200', 'Shop Example B', b);
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true, lat: 23.58, lng: 58.39, openMin: 0, closeMin: 1440 }];
  tables.truck = [{ id: 'T05', tenantId: T, code: 'T05', defaultDriverId: null, capacityCases: 1140, capacityWeightKg: 0, bays: 6, active: true }];
  tables.customer = [ca, cb];
  tables.order = [order('O1', ca), order('O2', cb), order('O3', ca)];
  tables.runPlan = [{
    id: 'P', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 1, reason: 'INITIAL', optimizationMode: 'BALANCED',
    chosenScenarioId: 'sc1', parentRunId: null, supersededAt: null, currentJobId: null, finalizedAt: null, totalOrders: 3, unservedCount: 0,
    summaryJson: null, reconciliationJson: { ok: true }, changeSummaryJson: null, feasibilityJson: null, createdById: 'u1', createdAt: new Date(),
  }];
  tables.planLoad = [{
    id: 'L1', tenantId: T, runId: 'P', truckId: 'T05', loadNo: 1, status: 'PLANNED', driverId: null, departMin: 400, returnMin: 560, distanceKm: 20, durationMin: 160,
    cases: 120, weightKg: 1200, utilizationPct: 40, fuelLitres: null, fuelCost: 1, operatingCost: 5, returnLegKm: 2, distanceIsEstimated: true, carriedFromLoadId: null,
    truckSnapshotJson: truckSnap('T05'), statusChangedAt: null, statusChangedById: null, createdAt: new Date(),
  }];
  tables.routeAssignment = [assignment('A1', 'L1', 'O1', ca, 1), assignment('A2', 'L1', 'O2', cb, 2), assignment('A3', 'L1', 'O3', ca, 3)];
  tables.scenarioResult = [{
    id: 'sc1', runId: 'P', name: 'RECOMMENDED', trucksUsed: 1, totalDistanceKm: 20, totalTimeMin: 160, totalCost: 40, avgUtilizationPct: 40, unservedCount: 0, createdAt: new Date(),
    detailsJson: {
      name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 1, trucks_used: 1, trips: 1, total_distance_km: 20, total_duration_min: 160,
      operating_cost: 40, avg_utilization_pct: 40, loads: [], unserved: [], warnings: [], objective: null, engine: 'OR-Tools', matrix_provider: 'HAVERSINE',
      distance_is_estimated: true, response_warnings: [], scope: { orderIds: ['O1', 'O2', 'O3'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] },
      feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
    },
  }];
  tables.unservedOrder = [];
  tables.runJob = [];
  tables.auditLog = [];
  tables.driver = [];
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, defaultServiceTimeMin: 10, timezone: 'Asia/Muscat' }];
  tables.customerTypeProfile = [];
}

beforeEach(() => {
  resetDb();
});

describe('read live by the plan, the load sheet and the driver sheet (fake database)', () => {
  it('a customer without one: no field on its stops, no box, no line (the plan reads as before)', async () => {
    seed();
    const d = (await getPlanDetail(T, 'P'))!;
    for (const s of d.loads[0]!.stops) {
      expect('loadingInstruction' in s).toBe(false);
      expect('carriedOrderIds' in s).toBe(false);
    }
    expect('loadingInstructions' in loadSheetModel(d, { tenantName: 'Example Co' }).sheets[0]!).toBe(false);
    expect('loadingInstructions' in driverPackModel(d, { tenantName: 'Example Co' }).sheets[0]!).toBe(false);
  });

  it('set after LOCK (LOCK is never refused for it): it reaches the plan, the load sheet and the driver sheet, and is not "changed after planning"', async () => {
    seed();
    await updateLoad(T, 'P', 'L1', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'L1').status).toBe('LOCKED');
    row('customer', 'c100').loadingInstruction = WATER;
    const d = (await getPlanDetail(T, 'P'))!;
    const [s1, s2, s3] = d.loads[0]!.stops;
    expect([s1!.loadingInstruction, s2!.loadingInstruction, s3!.loadingInstruction]).toEqual([WATER, undefined, WATER]);
    // Never a reason to re-plan: no "changed after planning" on the stop or the load.
    expect(d.loads[0]!.stops.flatMap((s) => s.masterChanged)).toEqual([]);
    expect(d.loads[0]!.masterChanged).toEqual([]);

    const sheet = loadSheetModel(d, { tenantName: 'Example Co' }).sheets[0]!;
    expect(sheet.loadingInstructions).toEqual([{ stops: [1, 3], customerId: 'c100', customerName: 'Hyper Example A', customerCode: 'C100', branchCode: null, text: WATER }]);
    expect(sheet.invoices.map((i) => [i.stop, i.loadingInstruction ?? null])).toEqual([
      [1, WATER],
      [2, null],
      [3, WATER],
    ]);
    expect(renderLoadSheetHtml(loadSheetModel(d, { tenantName: 'Example Co' }))).toContain(`<bdi>${WATER}</bdi>`);

    const pack = driverPackModel(d, { tenantName: 'Example Co' }).sheets[0]!;
    expect(pack.loadingInstructions).toEqual([`Stops 1, 3 Hyper Example A (C100): ${WATER}`]);
    expect(pack.stops.map((s) => s.loadingInstruction ?? null)).toEqual([WATER, null, WATER]);

    // Cleared: gone from every paper at the next print.
    row('customer', 'c100').loadingInstruction = null;
    const after = (await getPlanDetail(T, 'P'))!;
    expect(after.loads[0]!.stops.some((s) => 'loadingInstruction' in s)).toBe(false);
  });

  it('a value written straight to the database (line breaks, 250 characters) still prints, folded and shortened (review M6)', async () => {
    seed({ loadingInstruction: `Pallets first\r\n${'then cartons '.repeat(19)}` });
    const s = (await getPlanDetail(T, 'P'))!.loads[0]!.stops[0]!;
    expect(s.loadingInstruction!.startsWith('Pallets first then cartons')).toBe(true);
    expect(s.loadingInstruction!.length).toBeLessThanOrEqual(200);
    expect(s.loadingInstruction!.endsWith('…')).toBe(true);
  });

  it('a stop whose orders are all brought forward is left out; one with an order still due keeps it (review L1)', async () => {
    seed({ loadingInstruction: WATER });
    row('planLoad', 'L1').status = 'LOCKED';
    const later = { deliveryDate: new Date('2026-10-18T00:00:00Z'), totalCases: 40 };
    // Stop 1 holds O1 and O4 (the same customer): only O4 is brought forward. Stop 3 (O3) is brought forward whole.
    const ca = row('customer', 'c100') as ReturnType<typeof customer>;
    tables.order.push(order('O4', ca, { carriedTo: later }));
    tables.routeAssignment.push(assignment('A4', 'L1', 'O4', ca, 1, 1));
    row('order', 'O3').carriedTo = later;
    const d = (await getPlanDetail(T, 'P'))!;
    const [s1, , s3] = d.loads[0]!.stops;
    expect(s1!.carriedOrderIds).toEqual(['O4']);
    expect(s3!.carriedOrderIds).toEqual(['O3']);
    const sheet = loadSheetModel(d, { tenantName: 'Example Co' }).sheets[0]!;
    expect(sheet.loadingInstructions!.map((i) => i.stops)).toEqual([[1]]);
    expect(sheet.invoices.filter((i) => i.loadingInstruction).map((i) => i.stop)).toEqual([1]);
    expect(driverPackModel(d, { tenantName: 'Example Co' }).sheets[0]!.loadingInstructions).toEqual([`Stop 1 Hyper Example A (C100): ${WATER}`]);
  });

  it('special-loading lines (owner request 20 Oct 2026): each order line carries its kg (and its pallet units on a load planned by pallets), and the load sheet splits by them', async () => {
    seed({ loadingInstruction: 'SPECIAL' });
    let d = (await getPlanDetail(T, 'P'))!;
    expect(d.loads[0]!.stops[0]!.orderLines).toEqual([{ orderId: 'O1', lineId: 'O1-l1', salesOrderNo: 'INV-O1', productCode: 'W15', productName: 'Water 1.5L', cases: 40, weightKg: 400 }]);
    // Hyper Example A (stops 1 and 3) under SPECIAL, Shop Example B (stop 2) normal: 40 + 80 = the 120 cases of W15.
    expect(loadSheetModel(d, { tenantName: 'Example Co' }).sheets[0]!.loadingSplit).toEqual({
      normal: [{ productCode: 'W15', productName: 'Water 1.5L', cases: 40 }],
      normalCases: 40,
      groups: [{ text: 'SPECIAL', tag: 'SPECIAL', stops: [1, 3], products: [{ productCode: 'W15', productName: 'Water 1.5L', cases: 80 }], cases: 80 }],
    });
    // Planned by pallets (6 bays, 40 cases a pallet): each line its own units, as the manifest counts them.
    row('planLoad', 'L1').palletUnits = 3000;
    row('planLoad', 'L1').truckSnapshotJson = { ...truckSnap('T05'), palletRoomUnits: 6000, palletFillPct: 100 };
    for (const o of tables.order) for (const ln of o.lines) ln.product.casesPerPallet = 40;
    d = (await getPlanDetail(T, 'P'))!;
    expect(d.loads[0]!.stops.flatMap((s) => s.orderLines.map((l) => [l.lineId, l.weightKg, l.palletUnits]))).toEqual([
      ['O1-l1', 400, 1000],
      ['O2-l1', 400, 1000],
      ['O3-l1', 400, 1000],
    ]);
    expect(d.loads[0]!.manifest[0]).toMatchObject({ productCode: 'W15', cases: 120, palletUnits: 3000 });
  });

  it('a cancelled order: its invoice has no tag; a stop all of whose orders are cancelled is left out', async () => {
    seed({ loadingInstruction: WATER });
    row('planLoad', 'L1').status = 'LOCKED';
    row('order', 'O3').cancelledAt = new Date('2026-10-16T15:00:00Z');
    const d = (await getPlanDetail(T, 'P'))!;
    const sheet = loadSheetModel(d, { tenantName: 'Example Co' }).sheets[0]!;
    expect(sheet.loadingInstructions!.map((i) => i.stops)).toEqual([[1]]);
    expect(sheet.invoices.map((i) => [i.stop, !!i.loadingInstruction])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });
});

describe('the day screen (plan-view.tsx)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { confirm: () => true, prompt: () => null });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function mountPlan(detail: PlanDetail) {
    answers.plan = detail;
    const host: Host<any> = new Host(PlanView as any, { slug: 'example', runId: 'run1', canPlan: true, canDispatch: true, phoneCountryCode: '968', reloadSignal: 0, onBusyChange: () => {}, onChanged: async () => {} });
    host.render();
    await host.settle();
    return host;
  }
  const byTestId = (host: Host<any>, id: string) => elements(host.tree).filter((e) => e.props?.['data-testid'] === id);
  /** The stop rows of a load, opened as the dispatcher opens them (a click on the load row). */
  async function stopRows(host: Host<any>, index: number) {
    const rows = elements(host.tree).filter((e) => typeName(e) === 'tr' && String(e.props?.className ?? '').includes('cursor-pointer') && typeof e.props.onClick === 'function');
    rows[index]!.props.onClick();
    await host.settle();
    const detail = elements(host.tree).find((e) => typeName(e) === 'LoadDetail');
    const sub: Host<any> = new Host(detail.type, detail.props);
    sub.render();
    return sub;
  }

  it('a LOADING INSTRUCTION badge on the load (its lines in the title) and on the stop, with the text readable without hovering', async () => {
    const d = instructionFixture();
    d.loads[0].stops[1] = { ...d.loads[0].stops[1], loadingInstruction: WATER };
    const host = await mountPlan(d);
    const [badge, ...others] = byTestId(host, 'load-instruction-T01-1');
    expect(others).toEqual([]);
    expect(textOf(badge.props.children)).toBe('LOADING INSTRUCTION');
    expect(badge.props.variant).toBe('warning');
    expect(badge.props.title).toBe(`Stop 2 ${INSTRUCTED.b.customerName} (C200): ${WATER}`);
    expect(byTestId(host, 'load-instruction-T01-2')).toEqual([]);
    const sub = await stopRows(host, 0);
    const stopBadges = elements(sub.tree).filter((e) => e.props?.['data-testid'] === 'stop-loading-instruction');
    expect(stopBadges).toHaveLength(1);
    expect(stopBadges[0].props.title).toBe(WATER);
    const texts = elements(sub.tree).filter((e) => e.props?.['data-testid'] === 'stop-loading-instruction-text');
    expect(texts.map((e) => textOf(e.props.children))).toEqual([WATER]);
  });

  it('a stop nothing of which is loaded (every order cancelled, or brought forward) has no badge and no text, like its load and the sheets (review of 16 Oct)', async () => {
    const d = instructionFixture();
    d.loads[0] = {
      ...d.loads[0],
      stops: [
        { ...d.loads[0].stops[0], loadingInstruction: WATER, carriedTo: '2026-09-26', carriedOrderIds: ['o1'] },
        { ...d.loads[0].stops[1], loadingInstruction: 'Cartons on top only', cancelled: true, cancelledOrderIds: ['o2'] },
      ],
    };
    const host = await mountPlan(d);
    expect(byTestId(host, 'load-instruction-T01-1')).toEqual([]);
    const sub = await stopRows(host, 0);
    expect(elements(sub.tree).some((e) => String(e.props?.['data-testid'] ?? '').startsWith('stop-loading-instruction'))).toBe(false);
    // One order of the stop still due: the badge and the text are back on that stop.
    d.loads[0].stops[0] = { ...d.loads[0].stops[0], orderIds: ['o1', 'o1b'] };
    const again = await stopRows(await mountPlan(d), 0);
    expect(elements(again.tree).filter((e) => e.props?.['data-testid'] === 'stop-loading-instruction-text').map((e) => textOf(e.props.children))).toEqual([WATER]);
  });

  it('the loading manifest (owner request 20 Oct 2026): the normal lines, then the block with its tag on every line and its total; TOTAL unchanged', async () => {
    const d = instructionFixture();
    d.loads[0].stops[0] = { ...d.loads[0].stops[0], loadingInstruction: 'SPECIAL' };
    const sub = await stopRows(await mountPlan(d), 0);
    const table = elements(sub.tree).find((e) => e.props?.['data-testid'] === 'manifest-T01-1');
    const rows = elements(table.props.children).filter((e) => typeName(e) === 'tr');
    expect(rows.map((r) => textOf(r.props.children))).toEqual([
      'NORMAL LOADING - every other customer',
      'TAN-500-24Tanuf 500ml x2430360 kg',
      'TAN-5GTanuf 5 gallon10200 kg',
      'Normal loading total40560 kg',
      'SPECIALload separately, as the SPECIAL LOADING box says · Stop 1',
      'TAN-500-24SPECIALTanuf 500ml x2450600 kg',
      'JAB-1500-6SPECIALJabal 1.5L x620190 kg',
      'SPECIAL total70790 kg',
      'TOTAL1101,350 kg',
    ]);
    const heads = byTestId(sub, 'manifest-split-T01-1');
    expect(heads).toHaveLength(1);
    expect(String(heads[0].props.className)).toContain('bg-amber-50');
    const badges = elements(table.props.children).filter((e) => typeName(e) === 'Badge');
    expect(badges.map((b) => [b.props.variant, textOf(b.props.children)])).toEqual([
      ['warning', 'SPECIAL'],
      ['warning', 'SPECIAL'],
      ['warning', 'SPECIAL'],
    ]);
    // Another load of the day: no block.
    const other = await stopRows(await mountPlan(d), 1);
    expect(byTestId(other, 'manifest-split-T01-2')).toEqual([]);
  });

  it('a plan without instructions shows no such badge', async () => {
    const host = await mountPlan(fixture());
    expect(elements(host.tree).some((e) => String(e.props?.['data-testid'] ?? '').startsWith('load-instruction-'))).toBe(false);
    const sub = await stopRows(host, 0);
    expect(elements(sub.tree).some((e) => String(e.props?.['data-testid'] ?? '').startsWith('stop-loading-instruction'))).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------
// Each load on its own (design section 11, review of 16 Oct)
// ------------------------------------------------------------------------------------------------

describe('each load has its own box (the fixture with invented customers)', () => {
  const OPTS = { tenantName: 'Example Co' };
  const A = { ...INSTRUCTED.a, loadingInstruction: WATER };

  it('the same customer on trip 2 of the truck and on another truck: every load sheet and driver sheet has its own box with its own stop', () => {
    const d = instructionFixture();
    d.loads[0].stops[0] = { ...d.loads[0].stops[0], loadingInstruction: WATER };
    // T01 trip 2, stop 2, and the other truck's stop 1 (a split of the same customer).
    d.loads[1].stops[1] = { ...d.loads[1].stops[1], ...A };
    d.loads[2].stops[0] = { ...d.loads[2].stops[0], ...A, split: { part: 2, parts: 2, restUnserved: false } };
    const line = (stop: number) => `Stop ${stop} Hyper Example A (C100 / B1): ${WATER}`;
    // ?truck=T01 prints that truck's loads (lib/exports/warehouse-export.ts): each with its own box.
    const t01 = loadSheetModel(d, { ...OPTS, loadIds: ['L1', 'L2'] }).sheets;
    expect(t01.map((s) => [s.loadId, s.loadingInstructions!.map(instructionLine)])).toEqual([
      ['L1', [line(1)]],
      ['L2', [line(2)]],
    ]);
    expect(loadSheetModel(d, { ...OPTS, loadIds: ['L3'] }).sheets.map((s) => s.loadingInstructions!.map(instructionLine))).toEqual([[line(1)]]);
    const pack = new Map(driverPackModel(d, OPTS).sheets.map((s) => [s.loadId, s.loadingInstructions]));
    expect(Object.fromEntries(pack)).toEqual({ L1: [line(1)], L2: [line(2)], L3: [line(1)] });
  });

  it('a stop brought forward from an earlier day keeps its box and the tag on its invoice', () => {
    const d = instructionFixture();
    d.loads[0].stops[0] = { ...d.loads[0].stops[0], loadingInstruction: WATER, carriedFrom: '2026-09-23' };
    const s = loadSheetModel(d, OPTS).sheets[0]!;
    expect(s.loadingInstructions!.map((i) => i.stops)).toEqual([[1]]);
    expect(s.invoices.filter((i) => i.loadingInstruction).map((i) => i.stop)).toEqual([1]);
    expect(driverPackModel(d, OPTS).sheets.find((x) => x.loadId === 'L1')!.loadingInstructions).toEqual([`Stop 1 Hyper Example A (C100 / B1): ${WATER}`]);
  });
});

describe('POST /api/customers (the Customers page create)', () => {
  const create = (body: Record<string, unknown>) =>
    createCustomer(new Request('http://x/api/customers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Hyper Example A', ...body }) }));
  beforeEach(() => {
    tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat' }];
    tables.customer = [];
  });

  it('stores it by the same rule (one line, trimmed); empty or left out = none; over 200 characters = 400 with the reason, nothing created', async () => {
    expect((await create({ code: 'C100', loadingInstruction: ' Water at the bottom,\r\n max 5 layers ' })).status).toBe(201);
    expect((await create({ code: 'C200', loadingInstruction: '  ' })).status).toBe(201);
    expect((await create({ code: 'C300' })).status).toBe(201);
    expect(tables.customer.map((c) => [c.code, c.loadingInstruction ?? null])).toEqual([
      ['C100', WATER],
      ['C200', null],
      ['C300', null],
    ]);
    const bad = await create({ code: 'C400', loadingInstruction: 'x'.repeat(201) });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain('Loading instruction: at most 200 characters (201 typed).');
    expect(tables.customer).toHaveLength(3);
  });
});
