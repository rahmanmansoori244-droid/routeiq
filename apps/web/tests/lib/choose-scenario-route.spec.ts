/**
 * POST /api/runs/:id/choose-scenario ("Use instead") answers `driversChanged`: how many driver notes
 * the option just applied left on the plan (trips whose driver changed, and drivers the dispatcher
 * picked by hand whose trip the option does not have). The screen names that count in its toast,
 * so a changed or parked driver is never silent (fourth and fifth reviews of PR3).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';

const { auth } = vi.hoisted(() => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'P', email: 'p@a.example' } }),
}));
vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>, tx?: Record<string, any>) => (tx ?? m.fakePrisma).auditLog.create({ data: { ...input } })) };
});

import { POST as choosePost } from '@/app/api/runs/[id]/choose-scenario/route';
import { PATCH as loadPatch } from '@/app/api/runs/[id]/loads/[loadId]/route';

const T = 'tA';
const DAY = new Date('2026-09-27T00:00:00.000Z');
const scope = { orderIds: ['O2', 'O3'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] };

function solverLoad(truckId: string, loadNo: number, departMin: number, returnMin: number, orderId: string) {
  return {
    truck_id: truckId, load_no: loadNo, depart_min: departMin, return_min: returnMin, distance_km: 10, duration_min: returnMin - departMin, cases: 20, kg: 200,
    utilization_pct: 50, fuel_litres: 1, fuel_cost: 1, total_cost: 5, return_leg_km: 2,
    stops: [{ sequence: 1, stop_id: `s-${orderId}`, order_ids: [orderId], customer_id: 'c', arrival_min: departMin + 20, service_start_min: departMin + 20, departure_min: departMin + 40, wait_min: 0, leg_km: 5, cum_km: 5, hard_window_ok: true, pref_window_ok: true }],
  };
}
function option(id: string, name: string, loads: ReturnType<typeof solverLoad>[]) {
  return {
    id, runId: 'R', name, unservedCount: 0,
    detailsJson: {
      name, status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 1, trucks_used: 1, trips: loads.length, total_distance_km: 10, total_duration_min: 60,
      operating_cost: 5, avg_utilization_pct: 50, loads, unserved: [], warnings: [], objective: null, engine: 'OR-Tools', matrix_provider: 'HAVERSINE',
      distance_is_estimated: true, response_warnings: [], scope,
    },
  };
}
function planLoad(id: string, truckId: string, driverId: string) {
  return {
    id, tenantId: T, runId: 'R', truckId, loadNo: 1, status: 'PLANNED', driverId, departMin: 480, returnMin: 600, distanceKm: 10, durationMin: 120, cases: 20, weightKg: 200,
    utilizationPct: 50, fuelLitres: null, fuelCost: 1, operatingCost: 5, returnLegKm: 2, distanceIsEstimated: true, carriedFromLoadId: null, statusChangedAt: null,
    statusChangedById: null, driverSetById: null, driverSetAt: null, createdAt: new Date(),
  };
}
function assignment(id: string, loadId: string, truckId: string, orderId: string) {
  return {
    id, runId: 'R', truckId, orderId, loadId, loadNo: 1, sequenceInTruck: 1, orderInStop: 0, plannedArrivalMin: 10, plannedDistanceFromPrevKm: 1, plannedLoadCases: 20,
    lockedByUserId: null, manualOverrideReason: null, etaMin: 500, serviceStartMin: 500, departureMin: 520, waitMin: 0, cumulativeKm: 1, hardWindowOk: true, prefWindowOk: true,
    portionCases: null, portionWeightKg: null, portionLinesJson: null,
  };
}

function seed() {
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
  tables.truck = [
    { id: 'T2', tenantId: T, code: 'T02', defaultDriverId: 'ALI' },
    { id: 'T3', tenantId: T, code: 'T03', defaultDriverId: 'SAM' },
  ];
  tables.driver = [
    { id: 'ALI', tenantId: T, active: true, name: 'Ali' },
    { id: 'SAM', tenantId: T, active: true, name: 'Sam' },
    { id: 'BOB', tenantId: T, active: true, name: 'Bob' },
  ];
  tables.order = ['O2', 'O3'].map((id) => ({ id, tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED' }));
  tables.runPlan = [
    {
      id: 'R', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 1, reason: 'INITIAL', optimizationMode: 'BALANCED', chosenScenarioId: 'rec', parentRunId: null,
      supersededAt: null, currentJobId: null, finalizedAt: null, totalOrders: 2, unservedCount: 0, summaryJson: null, reconciliationJson: { ok: true }, changeSummaryJson: null, createdById: 'u1', createdAt: new Date(),
    },
  ];
  tables.planLoad = [planLoad('R2', 'T2', 'ALI'), planLoad('R3', 'T3', 'SAM')];
  tables.routeAssignment = [assignment('A2', 'R2', 'T2', 'O2'), assignment('A3', 'R3', 'T3', 'O3')];
  tables.scenarioResult = [
    option('rec', 'RECOMMENDED', [solverLoad('T2', 1, 480, 600, 'O2'), solverLoad('T3', 1, 480, 600, 'O3')]),
    option('min', 'MIN_TRUCKS', [solverLoad('T2', 1, 480, 600, 'O2'), solverLoad('T2', 2, 620, 740, 'O3')]),
  ];
  tables.unservedOrder = [];
  tables.runJob = [];
  tables.auditLog = [];
}

const req = (method: string, url: string, body: unknown) => new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const choose = async (scenarioId: string) => {
  const res = await choosePost(req('POST', 'http://t/api/runs/R/choose-scenario', { scenarioId }), { params: { id: 'R' } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { driversChanged: number } }).data;
};

beforeEach(() => {
  resetDb();
  seed();
});

describe('choose-scenario answers driversChanged', () => {
  it('counts the parked hand-set driver of an option without its trip; switching back gives him back with no note', async () => {
    const set = await loadPatch(req('PATCH', 'http://t/api/runs/R/loads/R3', { driverId: 'BOB' }), { params: { id: 'R', loadId: 'R3' } });
    expect(set.status).toBe(200);
    expect(await choose('min')).toEqual({ runId: 'R', scenarioId: 'min', driversChanged: 1 });
    expect(row('runPlan', 'R').summaryJson.driverChanges.map((c: { reason: string }) => c.reason)).toEqual(['TRIP_GONE']);
    expect(await choose('rec')).toEqual({ runId: 'R', scenarioId: 'rec', driversChanged: 0 });
    expect(tables.planLoad.find((l) => l.runId === 'R' && l.truckId === 'T3')).toMatchObject({ driverId: 'BOB', driverSetById: 'u1' });
  });

  it('counts a trip whose driver the option changed (the trip that moved onto another trip of its driver)', async () => {
    // Ali filled in on both trucks; the option moves T03 L1 onto T02 L1's hours: T03 gets Sam.
    Object.assign(row('planLoad', 'R3'), { driverId: 'ALI', departMin: 720, returnMin: 840 });
    tables.scenarioResult[0]!.detailsJson.loads[1] = solverLoad('T3', 1, 720, 840, 'O3');
    tables.scenarioResult.push(option('cost', 'MIN_COST', [solverLoad('T2', 1, 480, 600, 'O2'), solverLoad('T3', 1, 540, 660, 'O3')]));
    expect(await choose('cost')).toEqual({ runId: 'R', scenarioId: 'cost', driversChanged: 1 });
  });
});
