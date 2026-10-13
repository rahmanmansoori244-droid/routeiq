/**
 * "Small truck only" customers at LOCK / LOADING / DISPATCH (owner request 13 Oct 2026,
 * lib/dispatch/small-truck.ts; plan-service smallTruckGate), on the in-memory database (fake-plan-db.ts):
 * - a load that carries a customer marked "Small truck only (3-ton)" on a truck that is not small now
 *   (more bays than the company's "Small truck = at most N bays", or no bays entered) is refused with
 *   409 SMALL_TRUCK_ONLY, naming the customers and the remedy; nothing changes;
 * - it covers a mark or a setting changed after the plan was made (read live), and a locked load moving
 *   on (its remedy: back to Planned, then re-plan); stepping back is never refused;
 * - FEASIBILITY_GATE=warn does not let it through;
 * - the plan screen marks such stops (SMALL TRUCK ONLY, red on a truck that is too big), and the driver
 *   sheet and the warehouse load sheet print it.
 * The real-PostgreSQL path is in tests/integration/small-truck-only.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>) => m.fakePrisma.auditLog.create({ data: { ...input } })) };
});

import { updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { driverPackModel } from '@/lib/dispatch/driver-pack';
import { loadSheetModel } from '@/lib/dispatch/warehouse-sheets';

const T = 'tA';
const user = { id: 'u1', role: 'TENANT_ADMIN' };
const allow = () => true;
const DAY = new Date('2026-10-14T00:00:00Z');

const RULES = { shiftStartMin: 360, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0.5, maxTrips: 3, depotOpenMin: 0, depotCloseMin: 1440, availableFromMin: null, availableToMin: null };
const truckSnap = (code: string, bays: number | null) => ({
  v: 1, code, capacityCases: 1140, capacityWeightKg: 0, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.1, kmPerLitre: null, ...(bays ? { bays } : {}),
  availableFromMin: null, availableToMin: null, maxTripsPerDay: null, rules: RULES, source: 'PLAN', capturedAt: '2026-10-13T12:00:00Z',
});
const customer = (id: string, over: Record<string, unknown> = {}) => ({
  id, tenantId: T, code: id.toUpperCase(), branchCode: null, branchKey: '__MAIN__', name: `Shop ${id}`, customerType: null, address: 'Seeb',
  accessNotes: null, lat: 23.6, lng: 58.4, priority: 2, priorityConfirmed: true, avgServiceTimeMin: 20, serviceTimeConfirmed: true,
  hardWindowStartMin: 360, hardWindowEndMin: 840, prefWindowStartMin: null, prefWindowEndMin: null, active: true, locationVerified: true, createdFromUpload: false,
  smallTruckOnly: false, ...over,
});
const stopSnap = (c: ReturnType<typeof customer>) => ({
  v: 1, customerId: c.id, code: c.code, branchCode: null, name: c.name, customerType: null, lat: 23.6, lng: 58.4, address: 'Seeb', accessNotes: null,
  hardStartMin: 360, hardEndMin: 840, prefStartMin: null, prefEndMin: null, serviceMin: 20, priority: 2, source: 'PLAN', capturedAt: '2026-10-13T12:00:00Z',
});
const lines = (id: string) => [{ id: `${id}-l1`, cases: 40, weightKg: 400, weightFromMaster: false, salesOrderNo: `INV-${id}`, product: { code: 'TAN', name: 'Tanuf', weightPerCaseKg: 10 } }];

function load(id: string, truckId: string, status = 'PLANNED') {
  return {
    id, tenantId: T, runId: 'P', truckId, loadNo: 1, status, driverId: null, departMin: 400, returnMin: 500, distanceKm: 10, durationMin: 100, cases: 40, weightKg: 400,
    utilizationPct: 40, fuelLitres: null, fuelCost: 1, operatingCost: 5, returnLegKm: 2, distanceIsEstimated: true, carriedFromLoadId: null,
    truckSnapshotJson: truckSnap(truckId, truckId === 'BIG' ? 12 : 6), statusChangedAt: null, statusChangedById: null, createdAt: new Date(),
  };
}
function assignment(id: string, loadId: string, truckId: string, orderId: string, c: ReturnType<typeof customer>) {
  return {
    id, runId: 'P', truckId, orderId, sequenceInTruck: 1, plannedArrivalMin: 20, plannedDistanceFromPrevKm: 5, plannedLoadCases: 40,
    lockedByUserId: null, manualOverrideReason: null, loadId, loadNo: 1, orderInStop: 0, etaMin: 420, serviceStartMin: 420, departureMin: 440,
    waitMin: 0, cumulativeKm: 5, hardWindowOk: true, prefWindowOk: true, portionCases: null, portionWeightKg: null, portionLinesJson: null,
    stopSnapshotJson: stopSnap(c),
  };
}

/** An applied version: BIG (12 bays) L1 carries c1, SMALL (6 bays) L1 carries c2; both PLANNED. */
function seed(c1: Record<string, unknown> = {}, c2: Record<string, unknown> = {}) {
  const cust1 = customer('c1', c1);
  const cust2 = customer('c2', c2);
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true, lat: 23.58, lng: 58.39, openMin: 0, closeMin: 1440 }];
  tables.truck = [
    { id: 'BIG', tenantId: T, code: 'BIG', defaultDriverId: null, capacityCases: 1140, capacityWeightKg: 0, bays: 12, active: true },
    { id: 'SMALL', tenantId: T, code: 'SMALL', defaultDriverId: null, capacityCases: 570, capacityWeightKg: 0, bays: 6, active: true },
  ];
  tables.customer = [cust1, cust2];
  tables.order = [
    { id: 'O1', tenantId: T, customerId: 'c1', customer: cust1, lines: lines('O1'), totalCases: 40, totalWeightKg: 400, priority: 2, salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED', notes: null, depotId: 'D1', deliveryDate: DAY },
    { id: 'O2', tenantId: T, customerId: 'c2', customer: cust2, lines: lines('O2'), totalCases: 40, totalWeightKg: 400, priority: 2, salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED', notes: null, depotId: 'D1', deliveryDate: DAY },
  ];
  tables.runPlan = [{
    id: 'P', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 1, reason: 'INITIAL', optimizationMode: 'BALANCED',
    chosenScenarioId: 'sc1', parentRunId: null, supersededAt: null, currentJobId: null, finalizedAt: null, totalOrders: 2, unservedCount: 0,
    summaryJson: null, reconciliationJson: { ok: true }, changeSummaryJson: null, feasibilityJson: null, createdById: 'u1', createdAt: new Date(),
  }];
  tables.planLoad = [load('L1', 'BIG'), load('M1', 'SMALL')];
  tables.routeAssignment = [assignment('A1', 'L1', 'BIG', 'O1', cust1), assignment('A2', 'M1', 'SMALL', 'O2', cust2)];
  tables.scenarioResult = [{
    id: 'sc1', runId: 'P', name: 'RECOMMENDED', trucksUsed: 2, totalDistanceKm: 20, totalTimeMin: 200, totalCost: 40, avgUtilizationPct: 40, unservedCount: 0, createdAt: new Date(),
    detailsJson: {
      name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 1, trucks_used: 2, trips: 2, total_distance_km: 20, total_duration_min: 200,
      operating_cost: 40, avg_utilization_pct: 40, loads: [], unserved: [], warnings: [], objective: null, engine: 'OR-Tools', matrix_provider: 'HAVERSINE',
      distance_is_estimated: true, response_warnings: [], scope: { orderIds: ['O1', 'O2'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] },
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
  delete process.env.FEASIBILITY_GATE;
});
afterEach(() => {
  delete process.env.FEASIBILITY_GATE;
});

describe('LOCK / LOADING / DISPATCH of a small-truck-only customer on a big truck (409 SMALL_TRUCK_ONLY)', () => {
  it('a customer marked after planning: LOCK of its load on the 12-bay truck is refused, named, nothing changes; the 6-bay load locks', async () => {
    seed({ smallTruckOnly: true }, { smallTruckOnly: true });
    const e = await updateLoad(T, 'P', 'L1', { status: 'LOCKED' }, user, allow).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.details).toMatchObject({ code: 'SMALL_TRUCK_ONLY', truckId: 'BIG', truckCode: 'BIG', truckBays: 12, smallTruckMaxBays: 6, customerIds: ['c1'], customers: ['C1'] });
    expect(e.message).toBe(
      'BIG L1: cannot lock this load. BIG (12 bays) is not a small truck, but this customer takes small trucks only (at most 6 bays): C1 Shop c1. RE-PLAN: RouteIQ puts them on a small truck. If the customer accepts this truck today, untick "Small truck only (3-ton)" on the customer until this load is dispatched, then tick it again.',
    );
    expect(row('planLoad', 'L1').status).toBe('PLANNED');
    expect(tables.auditLog.some((a) => a.action === 'LOAD_LOCKED')).toBe(false);
    await updateLoad(T, 'P', 'M1', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'M1').status).toBe('LOCKED');
  });

  it('a customer that takes any truck locks on any truck (no change for the day without marks)', async () => {
    seed();
    await updateLoad(T, 'P', 'L1', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'L1').status).toBe('LOCKED');
  });

  it('a setting lowered after planning counts: at most 4 bays, the 6-bay truck is not small any more', async () => {
    seed({}, { smallTruckOnly: true });
    row('tenantConfig', 'cfg').smallTruckMaxBays = 4;
    await expect(updateLoad(T, 'P', 'M1', { status: 'LOCKED' }, user, allow)).rejects.toMatchObject({
      status: 409,
      details: { code: 'SMALL_TRUCK_ONLY', truckCode: 'SMALL', truckBays: 6, smallTruckMaxBays: 4 },
    });
    // Raised again to 6: it locks.
    row('tenantConfig', 'cfg').smallTruckMaxBays = 6;
    await updateLoad(T, 'P', 'M1', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'M1').status).toBe('LOCKED');
  });

  it('a truck without bays is never small', async () => {
    seed({}, { smallTruckOnly: true });
    row('truck', 'SMALL').bays = null;
    const e = await updateLoad(T, 'P', 'M1', { status: 'LOCKED' }, user, allow).catch((x) => x);
    expect(e.details).toMatchObject({ code: 'SMALL_TRUCK_ONLY', truckBays: null });
    expect(e.message).toMatch(/^SMALL L1: cannot lock this load\. SMALL \(no bays entered\) is not a small truck/);
  });

  it('a locked load moving on is refused too (back to Planned, then re-plan); stepping back is never refused', async () => {
    seed({ smallTruckOnly: true });
    row('planLoad', 'L1').status = 'LOCKED';
    const e = await updateLoad(T, 'P', 'L1', { status: 'LOADING' }, user, allow).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/^BIG L1: cannot start loading this load\. .* Put this load back to Planned, then RE-PLAN: RouteIQ puts them on a small truck\./);
    await updateLoad(T, 'P', 'L1', { status: 'PLANNED' }, user, allow);
    expect(row('planLoad', 'L1').status).toBe('PLANNED');
  });

  it('DISPATCH is refused the same way, and FEASIBILITY_GATE=warn does not let it through', async () => {
    seed({ smallTruckOnly: true });
    row('planLoad', 'L1').status = 'LOADING';
    process.env.FEASIBILITY_GATE = 'warn';
    await expect(updateLoad(T, 'P', 'L1', { status: 'DISPATCHED' }, user, allow)).rejects.toMatchObject({ status: 409, details: { code: 'SMALL_TRUCK_ONLY' } });
    expect(row('planLoad', 'L1').status).toBe('LOADING');
  });
});

describe('the plan screen and the sheets show it', () => {
  it('SMALL TRUCK ONLY on the stop, red (a breach) on the 12-bay truck; nothing on a customer that takes any truck', async () => {
    seed({ smallTruckOnly: true }, { smallTruckOnly: true });
    const d = (await getPlanDetail(T, 'P'))!;
    const big = d.loads.find((l) => l.id === 'L1')!.stops[0]!;
    const small = d.loads.find((l) => l.id === 'M1')!.stops[0]!;
    expect([big.smallTruckOnly, big.smallTruckBreach]).toEqual([true, true]);
    expect([small.smallTruckOnly, small.smallTruckBreach]).toEqual([true, undefined]);
    // The plan says it before anyone presses Lock.
    expect(d.warnings).toContain(
      'Small truck only customers on a truck that is not small: C1 (BIG L1). These loads cannot be locked, loaded or dispatched - re-plan to put them on a small truck.',
    );
    row('planLoad', 'L1').status = 'LOCKED';
    expect((await getPlanDetail(T, 'P'))!.warnings.some((w) => w.startsWith('Small truck only customers on a locked or loading truck that is not small: C1 (BIG L1).'))).toBe(true);
    seed();
    const plain = (await getPlanDetail(T, 'P'))!.loads.find((l) => l.id === 'L1')!.stops[0]!;
    expect('smallTruckOnly' in plain).toBe(false);
  });

  it('the driver sheet prints SMALL TRUCK ONLY under the customer, and the warehouse load sheet next to its invoice', async () => {
    seed({}, { smallTruckOnly: true });
    const d = (await getPlanDetail(T, 'P'))!;
    const pack = driverPackModel(d, { tenantName: 'NMWC' });
    const stopOf = (truck: string) => pack.sheets.find((s) => s.truckCode === truck)!.stops[0]!;
    expect(stopOf('SMALL').smallTruck).toBe('SMALL TRUCK ONLY');
    expect(stopOf('BIG').smallTruck).toBeUndefined();
    const sheets = loadSheetModel(d, { tenantName: 'NMWC' }).sheets;
    expect(sheets.find((s) => s.truckCode === 'SMALL')!.invoices[0]!.smallTruck).toBe('SMALL TRUCK ONLY');
    expect(sheets.find((s) => s.truckCode === 'BIG')!.invoices[0]!.smallTruck).toBeNull();
  });
});
