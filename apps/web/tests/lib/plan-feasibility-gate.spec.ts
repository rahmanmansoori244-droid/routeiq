/**
 * Stabilization PR4 on the in-memory database (fake-plan-db.ts):
 * - F04: LOCK / LOADING / DISPATCH are refused per truck-day while its timetable is not verified
 *   (409 TIMES_NOT_VERIFIED with the violations); stepping back is never refused; the operator
 *   switch FEASIBILITY_GATE=warn lets it through and audits it; the check is stored on the plan.
 * - F08: applying an option writes the stop and truck snapshots from what the optimizer was sent;
 *   a re-plan copies them (and copies rows without them); the plan detail shows the planned facts
 *   and what changed in the master data since, instead of switching silently.
 * The real-PostgreSQL paths are in tests/integration/dispatch-timing.spec.ts and dispatch-mvp.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
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

import { chooseScenario, createNextVersion, updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { readFeasibility } from '@/lib/dispatch/feasibility';
import type { PlanInputs } from '@/lib/dispatch/snapshots';

const T = 'tA';
const user = { id: 'u1', role: 'TENANT_ADMIN' };
const allow = () => true;
const DAY = new Date('2026-09-27T00:00:00Z');

const RULES = { shiftStartMin: 360, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0.5, maxTrips: 3, depotOpenMin: 0, depotCloseMin: 1440, availableFromMin: null, availableToMin: null };
const truckSnap = (code: string) => ({
  v: 1, code, capacityCases: 100, capacityWeightKg: 1000, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.1, kmPerLitre: null,
  availableFromMin: null, availableToMin: null, maxTripsPerDay: null, rules: RULES, source: 'PLAN', capturedAt: '2026-09-26T12:00:00Z',
});
const stopSnap = { v: 1, customerId: 'c1', code: 'C1', branchCode: null, name: 'Lulu Bausher', customerType: null, lat: 23.6, lng: 58.4,
  address: 'Old address', accessNotes: 'Back gate', hardStartMin: 360, hardEndMin: 840, prefStartMin: null, prefEndMin: null, serviceMin: 20, priority: 2,
  source: 'PLAN', capturedAt: '2026-09-26T12:00:00Z' };

const customer = (over: Record<string, unknown> = {}) => ({
  id: 'c1', tenantId: T, code: 'C1', branchCode: null, branchKey: '__MAIN__', name: 'Lulu Bausher', customerType: null, address: 'Old address',
  accessNotes: 'Back gate', lat: 23.6, lng: 58.4, priority: 2, priorityConfirmed: true, avgServiceTimeMin: 20, serviceTimeConfirmed: true,
  hardWindowStartMin: 360, hardWindowEndMin: 840, prefWindowStartMin: null, prefWindowEndMin: null, active: true, locationVerified: true, createdFromUpload: false,
  ...over,
});

function details(over: Record<string, unknown> = {}) {
  return {
    name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 1, trucks_used: 2, trips: 3,
    total_distance_km: 30, total_duration_min: 300, operating_cost: 50, avg_utilization_pct: 40, loads: [], unserved: [], warnings: [],
    objective: null, engine: 'OR-Tools', matrix_provider: 'HAVERSINE', distance_is_estimated: true, response_warnings: [],
    scope: { orderIds: ['O1', 'O2', 'O3'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] },
    feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
    ...over,
  };
}

function load(id: string, truckId: string, loadNo: number, status = 'PLANNED', extra: Record<string, unknown> = {}) {
  return {
    id, tenantId: T, runId: 'P', truckId, loadNo, status, driverId: null,
    departMin: 400 + (loadNo - 1) * 200, returnMin: 500 + (loadNo - 1) * 200, distanceKm: 10, durationMin: 100, cases: 40, weightKg: 400,
    utilizationPct: 40, fuelLitres: null, fuelCost: 1, operatingCost: 5, returnLegKm: 2, distanceIsEstimated: true, carriedFromLoadId: null,
    truckSnapshotJson: truckSnap(truckId === 'T1' ? 'T01' : 'T02'), statusChangedAt: null, statusChangedById: null, createdAt: new Date(), ...extra,
  };
}

function assignment(id: string, loadId: string, truckId: string, orderId: string, loadNo: number, extra: Record<string, unknown> = {}) {
  const base = 420 + (loadNo - 1) * 200;
  return {
    id, runId: 'P', truckId, orderId, sequenceInTruck: 1, plannedArrivalMin: 20, plannedDistanceFromPrevKm: 5, plannedLoadCases: 40,
    lockedByUserId: null, manualOverrideReason: null, loadId, loadNo, orderInStop: 0, etaMin: base, serviceStartMin: base, departureMin: base + 20,
    waitMin: 0, cumulativeKm: 5, hardWindowOk: true, prefWindowOk: true, portionCases: null, portionWeightKg: null, portionLinesJson: null,
    stopSnapshotJson: stopSnap, ...extra,
  };
}

const lines = (id: string) => [{ id: `${id}-l1`, cases: 40, weightKg: 400, weightFromMaster: false, salesOrderNo: `SO-${id}`, product: { code: 'TAN', name: 'Tanuf', weightPerCaseKg: 10 } }];

/** An applied version: T1 L1 + L2, T2 L1, all PLANNED; the option's report as given. */
function seed(feasibility: unknown = { status: 'VERIFIED', timing: 'EXACT', violations: [] }) {
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true, lat: 23.58, lng: 58.39, openMin: 0, closeMin: 1440 }];
  tables.truck = [
    { id: 'T1', tenantId: T, code: 'T01', defaultDriverId: null, capacityCases: 100, capacityWeightKg: 1000 },
    { id: 'T2', tenantId: T, code: 'T02', defaultDriverId: null, capacityCases: 100, capacityWeightKg: 1000 },
  ];
  tables.customer = [customer()];
  tables.order = ['O1', 'O2', 'O3'].map((id) => ({
    id, tenantId: T, customerId: 'c1', customer: customer(), lines: lines(id), totalCases: 40, totalWeightKg: 400, priority: 3,
    salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED', notes: null, depotId: 'D1', deliveryDate: DAY,
  }));
  tables.runPlan = [{
    id: 'P', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 1, reason: 'INITIAL', optimizationMode: 'BALANCED',
    chosenScenarioId: 'sc1', parentRunId: null, supersededAt: null, currentJobId: null, finalizedAt: null, totalOrders: 3, unservedCount: 0,
    summaryJson: null, reconciliationJson: { ok: true }, changeSummaryJson: null, feasibilityJson: null, createdById: 'u1', createdAt: new Date(),
  }];
  tables.planLoad = [load('L1', 'T1', 1), load('L2', 'T1', 2), load('M1', 'T2', 1)];
  tables.routeAssignment = [assignment('A1', 'L1', 'T1', 'O1', 1), assignment('A2', 'L2', 'T1', 'O2', 2), assignment('A3', 'M1', 'T2', 'O3', 1)];
  tables.scenarioResult = [{ id: 'sc1', runId: 'P', name: 'RECOMMENDED', trucksUsed: 2, totalDistanceKm: 30, totalTimeMin: 300, totalCost: 50, avgUtilizationPct: 40, unservedCount: 0, detailsJson: details({ feasibility }), createdAt: new Date() }];
  tables.unservedOrder = [];
  tables.runJob = [];
  tables.auditLog = [];
  tables.driver = [];
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, defaultServiceTimeMin: 10, timezone: 'Asia/Muscat' }];
  tables.customerTypeProfile = [];
}

const VIOLATED_T1 = {
  status: 'VIOLATED',
  timing: 'ESTIMATED',
  violations: [{ code: 'TURNAROUND', truck_id: 'T1', load_no: 2, message: 'T01 load 2 leaves at 08:34, but the truck needs 50 min to reload: ready 08:54.', short_by_min: 20 }],
};

beforeEach(() => {
  resetDb();
  delete process.env.FEASIBILITY_GATE;
});
afterEach(() => {
  delete process.env.FEASIBILITY_GATE;
});

describe('the feasibility gate (F04)', () => {
  it('refuses LOCK on a truck whose timetable breaks a rule, with the violations; nothing changes', async () => {
    seed(VIOLATED_T1);
    const e = await updateLoad(T, 'P', 'L1', { status: 'LOCKED' }, user, allow).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.details).toMatchObject({ code: 'TIMES_NOT_VERIFIED', truckId: 'T1', truckCode: 'T01', status: 'VIOLATED' });
    expect(e.details.violations[0]).toMatchObject({ code: 'TURNAROUND', loadNo: 2, source: 'SOLVER' });
    expect(e.message).toMatch(/^Truck T01: the timetable is not verified/);
    expect(e.message).toMatch(/Re-plan/);
    expect(row('planLoad', 'L1').status).toBe('PLANNED');
    expect(tables.auditLog.some((a) => a.action === 'LOAD_LOCKED')).toBe(false);
  });

  it('is per truck-day: another truck of the same plan still locks, and the check is stored on the plan', async () => {
    seed(VIOLATED_T1);
    await updateLoad(T, 'P', 'M1', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'M1').status).toBe('LOCKED');
    const f = readFeasibility(row('runPlan', 'P').feasibilityJson)!;
    expect(f.ok).toBe(false);
    expect(f.trucks.T1.status).toBe('VIOLATED');
    expect(f.trucks.T2).toMatchObject({ status: 'VERIFIED', ok: true });
    const audit = tables.auditLog.find((a) => a.action === 'LOAD_LOCKED')!;
    expect(audit.afterJson.timing).toMatchObject({ status: 'VERIFIED', ok: true, gate: 'enforce' });
  });

  it('LOCK and LOADING need cases that reconcile, like DISPATCH', async () => {
    seed();
    row('runPlan', 'P').reconciliationJson = { ok: false };
    await expect(updateLoad(T, 'P', 'M1', { status: 'LOCKED' }, user, allow)).rejects.toMatchObject({ status: 409, details: { code: 'NOT_RECONCILED' } });
    expect(row('planLoad', 'M1').status).toBe('PLANNED');
  });

  it('never refuses the way back (unlock) or LOADING -> LOCKED', async () => {
    seed(VIOLATED_T1);
    row('planLoad', 'L1').status = 'LOADING';
    await updateLoad(T, 'P', 'L1', { status: 'LOCKED' }, user, allow);
    await updateLoad(T, 'P', 'L1', { status: 'PLANNED' }, user, allow);
    expect(row('planLoad', 'L1').status).toBe('PLANNED');
  });

  it('refuses DISPATCH too, and a missed receiving window found by the web check alone', async () => {
    seed();
    row('planLoad', 'M1').status = 'LOCKED';
    row('routeAssignment', 'A3').hardWindowOk = false;
    const e = await updateLoad(T, 'P', 'M1', { status: 'DISPATCHED' }, user, allow).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.details.violations[0]).toMatchObject({ code: 'HARD_WINDOW', source: 'WEB' });
  });

  it('refuses a load over its payload (the physical kg of its stops, F01)', async () => {
    seed();
    row('routeAssignment', 'A3').portionWeightKg = 1200;
    row('routeAssignment', 'A3').portionCases = 40;
    row('routeAssignment', 'A3').portionLinesJson = [{ lineId: 'O3-l1', cases: 40 }];
    const e = await updateLoad(T, 'P', 'M1', { status: 'LOCKED' }, user, allow).catch((x) => x);
    expect(e.details.violations.map((v: { code: string }) => v.code)).toEqual(['CAPACITY_KG']);
  });

  it('FEASIBILITY_GATE=warn lets the change through and audits the violations', async () => {
    seed(VIOLATED_T1);
    process.env.FEASIBILITY_GATE = 'warn';
    await updateLoad(T, 'P', 'L1', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'L1').status).toBe('LOCKED');
    const audit = tables.auditLog.find((a) => a.action === 'LOAD_LOCKED')!;
    expect(audit.afterJson.timing).toMatchObject({ ok: false, gate: 'warn', overridden: 'FEASIBILITY_GATE=warn' });
    expect(audit.afterJson.timing.violations[0]).toMatch(/^TURNAROUND: /);
  });

  it('a problem on a LOCKED load: the 409 says to put it back to Planned first (a re-plan carries it over unchanged)', async () => {
    seed();
    row('planLoad', 'L1').status = 'LOCKED';
    row('routeAssignment', 'A1').hardWindowOk = false; // e.g. stored by the old solver before the deploy
    const e = await updateLoad(T, 'P', 'L1', { status: 'LOADING' }, user, allow).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.details).toMatchObject({ code: 'TIMES_NOT_VERIFIED', unlockFirst: ['T01 L1'] });
    expect(e.details.violations[0]).toMatchObject({ code: 'HARD_WINDOW', loadNo: 1, frozen: true });
    expect(e.message).toMatch(/so put load T01 L1 back to Planned first \("Back to locked" if it is loading, then "Unlock"\), then re-plan\.$/);
    expect(e.message).not.toMatch(/Re-plan to get a timetable/);
    // The way back is open; once Planned, the problem is one a re-plan can fix.
    await updateLoad(T, 'P', 'L1', { status: 'PLANNED' }, user, allow);
    const again = await updateLoad(T, 'P', 'L1', { status: 'LOCKED' }, user, allow).catch((x) => x);
    expect(again.details.unlockFirst).toEqual([]);
    expect(again.message).toMatch(/Re-plan to get a timetable that keeps every rule\.$/);
  });

  it('a plan from before the check (no report, no snapshots) is blocked only on a concrete violation', async () => {
    seed(undefined);
    const d = row('scenarioResult', 'sc1').detailsJson;
    delete d.feasibility;
    for (const l of tables.planLoad) l.truckSnapshotJson = null;
    for (const a of tables.routeAssignment) a.stopSnapshotJson = null;
    await updateLoad(T, 'P', 'L1', { status: 'LOCKED' }, user, allow);
    const f = readFeasibility(row('runPlan', 'P').feasibilityJson)!;
    expect(f).toMatchObject({ ok: true, status: 'STRUCTURAL_ONLY', source: 'LEGACY_STRUCTURAL_ONLY' });
    row('routeAssignment', 'A3').hardWindowOk = false;
    await expect(updateLoad(T, 'P', 'M1', { status: 'LOCKED' }, user, allow)).rejects.toMatchObject({ status: 409 });
  });
});

describe('snapshots (F08)', () => {
  const inputs: PlanInputs = {
    v: 1,
    jobId: 'J1',
    capturedAt: '2026-09-26T12:00:00Z',
    depot: { id: 'D1', lat: 23.58, lng: 58.39, openMin: 0, closeMin: 1440 },
    trucks: { T1: { code: 'T01', capacityCases: 120, capacityWeightKg: 1500, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.1, kmPerLitre: null, availableFromMin: null, availableToMin: null, maxTripsPerDay: 2 } },
    stops: { c1: { customerId: 'c1', lat: 23.61, lng: 58.41, hardStartMin: 420, hardEndMin: 720, prefStartMin: null, prefEndMin: null, serviceMin: 25, priority: 1 } },
    config: { shift_start_min: 360, shift_max_min: 600, reload_min: 20, loading_min_per_case: 0.1, max_trips_per_truck: 3, osrm_configured: false },
    settings: null,
  };

  it('applying an option writes the truck and stop facts the optimizer was sent, not the master data now', async () => {
    seed();
    tables.planLoad = [];
    tables.routeAssignment = [];
    row('runPlan', 'P').chosenScenarioId = null;
    row('runPlan', 'P').status = 'DRAFT';
    const planned = {
      truck_id: 'T1', load_no: 1, depart_min: 400, return_min: 520, distance_km: 12, duration_min: 120, cases: 40, kg: 400, utilization_pct: 33,
      fuel_litres: null, fuel_cost: 0, distance_cost: 1, time_cost: 0, fixed_cost: 20, total_cost: 21, return_leg_km: 4,
      stops: [{ sequence: 1, stop_id: 'c1', order_ids: ['O1'], customer_id: 'c1', arrival_min: 430, service_start_min: 430, departure_min: 455, wait_min: 0, leg_km: 8, cum_km: 8, leg_min: 30, cases: 40, kg: 400, hard_window_ok: true, pref_window_ok: true }],
    };
    row('scenarioResult', 'sc1').detailsJson = details({ inputs, loads: [planned], scope: { orderIds: ['O1'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] } });
    // The customer and the truck changed after the optimizer was called.
    tables.customer = [customer({ lat: 23.7, lng: 58.5, name: 'Lulu Bausher (renamed)' })];
    tables.truck[0].capacityCases = 80;
    await chooseScenario(T, 'P', 'sc1', 'u1');
    const l = tables.planLoad[0];
    expect(l.truckSnapshotJson).toMatchObject({ code: 'T01', capacityCases: 120, capacityWeightKg: 1500, source: 'PLAN' });
    expect(l.truckSnapshotJson.rules).toMatchObject({ reloadMin: 20, loadingMinPerCase: 0.1, maxTrips: 2, shiftMaxMin: 600 });
    const a = tables.routeAssignment[0];
    expect(a.stopSnapshotJson).toMatchObject({ lat: 23.61, lng: 58.41, hardStartMin: 420, hardEndMin: 720, serviceMin: 25, priority: 1, source: 'PLAN' });
    expect(a.stopSnapshotJson.name).toBe('Lulu Bausher (renamed)'); // descriptive fields: from the customer when applied
    expect(readFeasibility(row('runPlan', 'P').feasibilityJson)?.ok).toBe(true);
  });

  it('a re-plan copies the snapshots with the loads; rows without them copy as SQL NULL (no throw)', async () => {
    seed();
    row('planLoad', 'L1').status = 'LOCKED';
    row('planLoad', 'M1').truckSnapshotJson = null; // planned before snapshots existed
    row('routeAssignment', 'A3').stopSnapshotJson = null;
    const { child } = await createNextVersion(T, 'P', 'REOPTIMIZE', null, 'u1');
    const copies = tables.planLoad.filter((l) => l.runId === child.id);
    const l1 = copies.find((l) => l.carriedFromLoadId === 'L1')!;
    expect(l1.truckSnapshotJson).toEqual(truckSnap('T01'));
    expect(copies.find((l) => l.carriedFromLoadId === 'M1')!.truckSnapshotJson).toBe(Prisma.DbNull);
    const stops = tables.routeAssignment.filter((a) => a.runId === child.id);
    expect(stops.find((a) => a.orderId === 'O1')!.stopSnapshotJson).toEqual(stopSnap);
    expect(stops.find((a) => a.orderId === 'O3')!.stopSnapshotJson).toBe(Prisma.DbNull);
    // The copy has its own timetable check.
    expect(readFeasibility(row('runPlan', child.id).feasibilityJson)?.ok).toBe(true);
  });

  it('the plan detail shows the planned facts and what changed since; older rows show today\'s data, labelled', async () => {
    seed();
    // After planning: C1's pin moved 1.6 km, its hours and address changed; T02's payload was edited.
    tables.order.find((o) => o.id === 'O1')!.customer = customer({ lat: 23.615, lng: 58.4, hardWindowEndMin: 600, address: 'New address' });
    tables.order.find((o) => o.id === 'O2')!.customer = customer({ lat: 23.615, lng: 58.4, hardWindowEndMin: 600, address: 'New address' });
    tables.order.find((o) => o.id === 'O3')!.customer = customer({ lat: 23.615, lng: 58.4 });
    tables.truck[1].capacityWeightKg = 800;
    // T02's stop was planned before snapshots existed.
    row('routeAssignment', 'A3').stopSnapshotJson = null;
    const d = (await getPlanDetail(T, 'P'))!;
    const s1 = d.loads.find((l) => l.id === 'L1')!.stops[0];
    expect(s1).toMatchObject({ snapshot: true, lat: 23.6, lng: 58.4, address: 'Old address', window: 'hard 06:00–14:00' });
    expect(s1.mapsUrl).toContain('23.6,58.4');
    expect(s1.masterChanged.map((c) => c.kind).sort()).toEqual(['ADDRESS', 'HOURS', 'LOCATION']);
    const moved = s1.masterChanged.find((c) => c.kind === 'LOCATION')!;
    expect(moved.text).toMatch(/^Location updated after planning: new pin 23\.61500, 58\.40000 \(1\.7 km from the planned one\)/);
    expect(moved).toMatchObject({ newLat: 23.615, newLng: 58.4 });
    const s3 = d.loads.find((l) => l.id === 'M1')!.stops[0];
    expect(s3).toMatchObject({ snapshot: false, lat: 23.615, masterChanged: [] });
    const m1 = d.loads.find((l) => l.id === 'M1')!;
    expect(m1).toMatchObject({ truckSnapshot: true, truckPayloadKg: 1000 });
    expect(m1.masterChanged[0].text).toMatch(/^Truck capacity changed after planning: now 100 cases \/ 800 kg/);
    expect(d.warnings.some((w) => w.startsWith('Location or receiving hours changed after this plan was made: C1'))).toBe(true);
    expect(d.feasibility?.ok).toBe(true);
    expect(d.loads.every((l) => l.timing?.ok)).toBe(true);
  });

  it('access notes are printed as they are now (contact details stay live, like the driver phone)', async () => {
    seed();
    row('planLoad', 'L1').status = 'LOCKED';
    tables.order.find((o) => o.id === 'O1')!.customer = customer({ accessNotes: 'Front gate closed - use the rear gate' });
    const d = (await getPlanDetail(T, 'P'))!;
    const s1 = d.loads.find((l) => l.id === 'L1')!.stops[0];
    expect(s1.accessNotes).toBe('Front gate closed - use the rear gate');
    expect(s1.masterChanged).toEqual([]); // not a planned fact: nothing to re-plan
    expect(row('routeAssignment', 'A1').stopSnapshotJson.accessNotes).toBe('Back gate'); // kept for the record
  });

  it('an inverted receiving window in legacy customer data is not "changed after planning"', async () => {
    seed();
    // Planned as any time (buildDispatchRequest drops a window that ends before it starts).
    for (const a of tables.routeAssignment) a.stopSnapshotJson = { ...stopSnap, hardStartMin: null, hardEndMin: null };
    for (const o of tables.order) o.customer = customer({ hardWindowStartMin: 1320, hardWindowEndMin: 360 });
    const d = (await getPlanDetail(T, 'P'))!;
    expect(d.loads.flatMap((l) => l.stops.flatMap((s) => s.masterChanged))).toEqual([]);
    expect(d.warnings.some((w) => w.includes('receiving hours changed'))).toBe(false);
  });

  it('a truck corrected below what its planned load carries: shown as a warning, the load keeps its snapshot', async () => {
    seed();
    tables.truck[1].capacityWeightKg = 300; // T02's M1 carries 400 kg, planned on a 1000 kg payload
    const d = (await getPlanDetail(T, 'P'))!;
    const w = d.feasibility!.violations.find((v) => v.code === 'CAPACITY_CHANGED')!;
    expect(w).toMatchObject({ severity: 'WARN', truckCode: 'T02', loadNo: 1 });
    expect(d.feasibility!.ok).toBe(true);
    expect(d.loads.find((l) => l.id === 'M1')!.truckPayloadKg).toBe(1000);
  });
});
