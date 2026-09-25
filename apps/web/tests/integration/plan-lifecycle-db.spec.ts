/**
 * PLAN LIFECYCLE ON REAL POSTGRESQL, library level (stabilization PR3; review F03, F06, F07).
 * The optimizer is faked in this test process (vi.mock of the solver client), so a failing solve
 * is deterministic; everything else - plan service, locks, the background job - is the real code
 * against the real database. Needs DATABASE_URL (migrated); the web server and solver are not used.
 *
 *  - a re-plan whose optimization fails leaves the new version FAILED but holding the previous
 *    plan (copy-forward): its loads can be locked and dispatched, reconciliation is ok, and a retry
 *    creates the next version and succeeds;
 *  - ten concurrent getOrCreatePlan calls for one day create exactly one plan (day lock);
 *  - two concurrent re-plans of one version create exactly one child;
 *  - review fixes: a re-plan never re-uses an untouched copy's driver without the time-clash check,
 *    and a failed re-plan saves no weight (its copied loads keep matching their orders);
 *  - fourth review: a driver the dispatcher set by hand stays on its trip (marked, the overlap shown
 *    as a warning); one RouteIQ filled in does not, and the change is listed on the plan;
 *  - fifth review: Keep marks a driver RouteIQ filled in; a hand-set driver whose trip an option
 *    does not have is parked in the summary JSON and comes back with the trip.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';

const solverMode = vi.hoisted(() => ({ mode: 'plan' as 'plan' | 'unserved' | 'fail' | 'earlySecondTruck', calls: 0 }));

vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  /**
   * A small valid plan: stop i on truck i % n, load floor(i / n) + 1 - or every stop unserved.
   * Load k leaves at 06:00 + k x 150 min; with earlySecondTruck the second truck's loads leave
   * 150 min earlier (a re-plan that re-times them).
   */
  function fakeSolve(req: DispatchRequest, unservedOnly: boolean, earlySecondTruck = false): DispatchResponse {
    const frozenNos = new Map(req.trucks.map((t) => [t.id, (t.frozen_trips ?? []).length]));
    const loads: PlannedLoad[] = [];
    if (!unservedOnly) {
      req.stops.forEach((s, i) => {
        const truck = req.trucks[i % req.trucks.length]!;
        const loadNo = (frozenNos.get(truck.id) ?? 0) + Math.floor(i / req.trucks.length) + 1;
        const depart = 360 + loadNo * 150 - (earlySecondTruck && i % req.trucks.length === 1 ? 150 : 0);
        loads.push({
          truck_id: truck.id,
          load_no: loadNo,
          depart_min: depart,
          return_min: depart + 90,
          distance_km: 12,
          duration_min: 90,
          cases: s.demand_cases,
          kg: s.demand_kg ?? 0,
          utilization_pct: 10,
          fuel_litres: 2,
          fuel_cost: 0.5,
          distance_cost: 1,
          time_cost: 1,
          fixed_cost: 0,
          total_cost: 2.5,
          return_leg_km: 6,
          stops: [
            { sequence: 1, stop_id: s.stop_id, order_ids: s.order_ids, customer_id: s.customer_id, arrival_min: depart + 20, service_start_min: depart + 20, departure_min: depart + 40, wait_min: 0, leg_km: 6, cum_km: 6, leg_min: 20, cases: s.demand_cases, kg: s.demand_kg ?? 0, hard_window_ok: true, pref_window_ok: true },
          ],
        });
      });
    }
    const sc: DispatchScenario = {
      name: 'RECOMMENDED',
      status: 'OPTIMIZED',
      solver_status: 'ROUTING_SUCCESS',
      solver_time_sec: 0.1,
      time_limit_sec: 5,
      objective_value: 1,
      objective: { unserved_penalty: 0, fixed_cost: 0, distance_cost: 0, fuel_cost: 0, time_cost: 0, overtime_cost: 0, window_penalty: 0, margin_served: null },
      trucks_used: new Set(loads.map((l) => l.truck_id)).size,
      trips: loads.length,
      total_distance_km: loads.length * 12,
      total_duration_min: loads.length * 90,
      total_cases: loads.reduce((a, l) => a + l.cases, 0),
      total_kg: 0,
      avg_utilization_pct: 10,
      fuel_litres: 0,
      fuel_cost: 0,
      operating_cost: loads.length * 2.5,
      loads,
      unserved: unservedOnly ? req.stops.map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'NO_AVAILABLE_TRUCK' as never, reason_message: 'test: no capacity' })) : [],
      warnings: [],
    };
    // An alternative with the same loads, so "Use instead" has something to choose.
    const alt: DispatchScenario = { ...sc, name: 'MIN_TRUCKS', loads: sc.loads.map((l) => ({ ...l })) };
    return { run_id: req.run_id, engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, scenarios: [sc, alt], warnings: [] };
  }
  return {
    SolverError,
    callDispatchSolver: vi.fn(async (req: DispatchRequest) => {
      solverMode.calls++;
      if (solverMode.mode === 'fail') throw new SolverError('test: the route optimizer is down', 502, null);
      return fakeSolve(req, solverMode.mode === 'unserved', solverMode.mode === 'earlySecondTruck');
    }),
  };
});

import { prisma as libPrisma } from '@/lib/db';
import { chooseScenario, getOrCreatePlan, updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { driverClashes } from '@/lib/dispatch/load-state';
import { PlanBusyError } from '@/lib/dispatch/plan-locks';
import { replan, startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `lifedb-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let userId = '';
let depotId = '';
const user = () => ({ id: userId, role: 'TENANT_ADMIN' });
const everyRole = () => true;

function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function jobsDone(runId: string) {
  const g = globalThis as unknown as { __routeiqInflight?: Map<string, Promise<void>> };
  for (let i = 0; i < 50; i++) {
    const p = g.__routeiqInflight?.get(runId);
    if (p) await p;
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'OPTIMIZING') return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`plan ${runId} still optimizing`);
}

async function seedOrders(day: string, n: number) {
  const product = await prisma.product.findFirstOrThrow({ where: { tenantId } });
  const customers = await prisma.customer.findMany({ where: { tenantId }, orderBy: { code: 'asc' } });
  for (let i = 0; i < n; i++) {
    await prisma.order.create({
      data: {
        tenantId,
        customerId: customers[i % customers.length]!.id,
        depotId,
        deliveryDate: new Date(`${day}T00:00:00.000Z`),
        totalCases: 10,
        totalWeightKg: 100,
        status: 'VALIDATED',
        priority: 3,
        lines: { create: [{ productId: product.id, cases: 10, weightKg: 100, salesOrderNo: `SO-${day}-${i}` }] },
      },
    });
  }
}

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Lifecycle ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  userId = (await prisma.user.create({ data: { tenantId, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner', role: 'TENANT_ADMIN' } })).id;
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'MCT', name: 'Muscat', lat: 23.568, lng: 58.392 } })).id;
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({ data: { tenantId, depotId, code, capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1 } });
  }
  await prisma.product.create({ data: { tenantId, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 10 } });
  for (const [code, lat, lng] of [['C1', 23.588, 58.41], ['C2', 23.6, 58.372], ['C3', 23.555, 58.335], ['C4', 23.61, 58.45]] as const) {
    await prisma.customer.create({ data: { tenantId, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
  }
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('a failed re-plan keeps the previous plan (F03 copy-forward)', () => {
  it('v2 is FAILED but holds the previous plan: lockable, dispatchable, reconciled; a retry creates v3', async () => {
    const day = isoPlus(3);
    await seedOrders(day, 4);
    solverMode.mode = 'plan';
    const { run: v1 } = await getOrCreatePlan(tenantId, depotId, day, userId);
    const start = await startDispatchOptimize(tenantId, v1.id, user(), null);
    expect(start.status).toBe(202);
    expect((await jobsDone(v1.id)).status).toBe('READY');
    const v1Loads = await prisma.planLoad.findMany({ where: { runId: v1.id }, orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }] });
    expect(v1Loads.length).toBe(4);
    // Lock one load (the first of its truck).
    const first = v1Loads.find((l) => l.loadNo === 1)!;
    await updateLoad(tenantId, v1.id, first.id, { status: 'LOCKED' }, user(), everyRole);

    // Re-plan while the optimizer is down.
    solverMode.mode = 'fail';
    const rp = await replan(tenantId, v1.id, 'REOPTIMIZE', null, user(), null);
    expect(rp.status).toBe(202);
    const v2Id = String(rp.body.runId);
    const v2 = await jobsDone(v2Id);
    expect(v2.status).toBe('FAILED');
    expect(v2.version).toBe(2);
    expect(v2.chosenScenarioId).toBeTruthy();
    expect((v2.reconciliationJson as { ok?: boolean } | null)?.ok).toBe(true);
    const parent = await prisma.runPlan.findUniqueOrThrow({ where: { id: v1.id } });
    expect(parent.status).toBe('SUPERSEDED');
    const v2Loads = await prisma.planLoad.findMany({ where: { runId: v2Id } });
    expect(v2Loads).toHaveLength(4); // PLANNED and frozen loads of the previous plan
    expect(v2Loads.filter((l) => l.status === 'LOCKED')).toHaveLength(1);
    expect(new Set(v2Loads.map((l) => l.carriedFromLoadId))).toEqual(new Set(v1Loads.map((l) => l.id)));
    const v2Stops = await prisma.routeAssignment.count({ where: { runId: v2Id } });
    expect(v2Stops).toBe(4);
    const job = await prisma.runJob.findFirstOrThrow({ where: { runId: v2Id } });
    expect(job.status).toBe('FAILED');

    // The copy is usable: lock a PLANNED load, dispatch the locked one.
    const lockedCopy = v2Loads.find((l) => l.status === 'LOCKED')!;
    const plannedCopy = v2Loads.find((l) => l.status === 'PLANNED' && l.truckId !== lockedCopy.truckId && l.loadNo === 1) ?? v2Loads.find((l) => l.status === 'PLANNED' && l.truckId === lockedCopy.truckId && l.loadNo === 2)!;
    await updateLoad(tenantId, v2Id, plannedCopy.id, { status: 'LOCKED' }, user(), everyRole);
    await updateLoad(tenantId, v2Id, lockedCopy.id, { status: 'DISPATCHED' }, user(), everyRole);
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: lockedCopy.id } })).status).toBe('DISPATCHED');
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: v2Id } })).status).toBe('READY');

    // A retry creates v3 and succeeds; the frozen loads stay exactly as they are.
    solverMode.mode = 'unserved';
    const retry = await replan(tenantId, v2Id, 'REOPTIMIZE', null, user(), null);
    expect(retry.status).toBe(202);
    expect(retry.body.version).toBe(3);
    const v3 = await jobsDone(String(retry.body.runId));
    expect(v3.status).toBe('READY');
    expect((v3.reconciliationJson as { ok?: boolean } | null)?.ok).toBe(true);
    const v3Loads = await prisma.planLoad.findMany({ where: { runId: v3.id } });
    expect(v3Loads.map((l) => l.status).sort()).toEqual(['DISPATCHED', 'LOCKED']);
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: v2Id } })).status).toBe('SUPERSEDED');
  });

  it('with every order on frozen loads, a re-plan is refused before a version is created (409 NOTHING_TO_PLAN)', async () => {
    const day = isoPlus(4);
    await seedOrders(day, 2);
    solverMode.mode = 'plan';
    const { run } = await getOrCreatePlan(tenantId, depotId, day, userId);
    await startDispatchOptimize(tenantId, run.id, user(), null);
    await jobsDone(run.id);
    for (const l of await prisma.planLoad.findMany({ where: { runId: run.id }, orderBy: { loadNo: 'asc' } })) {
      await updateLoad(tenantId, run.id, l.id, { status: 'LOCKED' }, user(), everyRole);
    }
    const before = await prisma.runPlan.count({ where: { tenantId, depotId, runDate: new Date(`${day}T00:00:00.000Z`) } });
    const res = await replan(tenantId, run.id, 'REOPTIMIZE', null, user(), null);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTHING_TO_PLAN');
    expect(await prisma.runPlan.count({ where: { tenantId, depotId, runDate: new Date(`${day}T00:00:00.000Z`) } })).toBe(before);
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('READY');
  });
});

describe('one live plan per day (F06) and one child per version', () => {
  it('10 concurrent getOrCreatePlan calls for one day create exactly one plan', async () => {
    const day = isoPlus(5);
    const results = await Promise.all(Array.from({ length: 10 }, () => getOrCreatePlan(tenantId, depotId, day, userId)));
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await prisma.runPlan.count({ where: { tenantId, depotId, runDate: new Date(`${day}T00:00:00.000Z`) } })).toBe(1);
  });

  it('two concurrent re-plans of one version: exactly one child, the other is refused', async () => {
    const day = isoPlus(6);
    await seedOrders(day, 2);
    solverMode.mode = 'plan';
    const { run } = await getOrCreatePlan(tenantId, depotId, day, userId);
    await startDispatchOptimize(tenantId, run.id, user(), null);
    await jobsDone(run.id);
    solverMode.mode = 'unserved';
    const [a, b] = await Promise.all([
      replan(tenantId, run.id, 'REOPTIMIZE', null, user(), null),
      replan(tenantId, run.id, 'REOPTIMIZE', null, user(), null),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const children = await prisma.runPlan.findMany({ where: { parentRunId: run.id } });
    expect(children).toHaveLength(1);
    await jobsDone(children[0]!.id);
  });
});

// ---------------------------------------------------------------------------------------------
// Deterministic races (review F07): another connection holds the plan row (SELECT ... FOR UPDATE)
// while the mutators queue behind it; pg_stat_activity shows when each one is waiting.
// ---------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hold the plan row locked in another connection until release() is called. */
async function holdPlanRow(runId: string) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const tx = prisma.$transaction(
    async (t) => {
      await t.$queryRaw`SELECT id FROM "RunPlan" WHERE id = ${runId} FOR UPDATE`;
      locked();
      await released;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  await isLocked;
  return {
    release: async () => {
      release();
      await tx;
    },
  };
}

/** Sessions of this database waiting for a plan row lock. */
async function planRowWaiters(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND cardinality(pg_blocking_pids(pid)) > 0 AND query ILIKE '%FROM "RunPlan"%FOR UPDATE%'`;
  return Number(rows[0]?.n ?? 0);
}

async function untilWaiters(n: number) {
  for (let i = 0; i < 300; i++) {
    if ((await planRowWaiters()) >= n) return;
    await sleep(20);
  }
  throw new Error(`never saw ${n} session(s) waiting for the plan row`);
}

async function optimizedPlan(day: string) {
  await seedOrders(day, 2);
  solverMode.mode = 'plan';
  const { run } = await getOrCreatePlan(tenantId, depotId, day, userId);
  expect((await startDispatchOptimize(tenantId, run.id, user(), null)).status).toBe(202);
  expect((await jobsDone(run.id)).status).toBe('READY');
  const alt = await prisma.scenarioResult.findFirstOrThrow({ where: { runId: run.id, name: 'MIN_TRUCKS' } });
  return { run: await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } }), alt };
}

describe('plan row locks (F07)', () => {
  it('"Use instead" queued behind a re-plan gets 409: the superseded parent is never written READY again', async () => {
    const { run, alt } = await optimizedPlan(isoPlus(7));
    const hold = await holdPlanRow(run.id);
    solverMode.mode = 'unserved';
    const replanning = replan(tenantId, run.id, 'REOPTIMIZE', null, user(), null);
    await untilWaiters(1);
    const choosing = chooseScenario(tenantId, run.id, alt.id, userId).then(
      () => 'applied',
      (e: unknown) => e,
    );
    await untilWaiters(2);
    await hold.release();
    const [rp, ch] = await Promise.all([replanning, choosing]);
    expect(rp.status).toBe(202);
    expect(ch).toMatchObject({ status: 409 });
    const parent = await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } });
    expect(parent.status).toBe('SUPERSEDED');
    expect(parent.supersededAt).not.toBeNull();
    expect(parent.chosenScenarioId).toBe(run.chosenScenarioId);
    await jobsDone(String(rp.body.runId));
  });

  it('"Use instead" and a Lock on the same version are serialized: never an order on two loads', async () => {
    const { run, alt } = await optimizedPlan(isoPlus(8));
    const load1 = await prisma.planLoad.findFirstOrThrow({ where: { runId: run.id, loadNo: 1 } });
    const hold = await holdPlanRow(run.id);
    const choosing = chooseScenario(tenantId, run.id, alt.id, userId).then(
      () => 200,
      (e: { status?: number }) => e.status ?? 500,
    );
    await untilWaiters(1);
    const locking = updateLoad(tenantId, run.id, load1.id, { status: 'LOCKED' }, user(), everyRole).then(
      () => 200,
      (e: { status?: number }) => e.status ?? 500,
    );
    await untilWaiters(2);
    await hold.release();
    const results = await Promise.all([choosing, locking]);
    expect(results).not.toEqual([200, 200]);
    expect(results.every((s) => s === 200 || s === 404 || s === 409)).toBe(true);
    const stops = await prisma.routeAssignment.findMany({ where: { runId: run.id }, select: { orderId: true } });
    expect(stops.length).toBe(new Set(stops.map((s) => s.orderId)).size);
    const after = await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } });
    expect((after.reconciliationJson as { ok?: boolean } | null)?.ok).toBe(true);
  });

  it('a load change waiting more than 5 s for a plan being saved answers 409 "Plan is being saved", not 500', async () => {
    const { run } = await optimizedPlan(isoPlus(9));
    const load1 = await prisma.planLoad.findFirstOrThrow({ where: { runId: run.id, loadNo: 1 } });
    const hold = await holdPlanRow(run.id);
    try {
      const err = await updateLoad(tenantId, run.id, load1.id, { status: 'LOCKED' }, user(), everyRole).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlanBusyError);
      expect((err as PlanBusyError).status).toBe(409);
    } finally {
      await hold.release();
    }
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: load1.id } })).status).toBe('PLANNED');
  });
});

// ---------------------------------------------------------------------------------------------
// Review of PR3 (fixes): copy-forward drivers, and weights saved only with an applied plan.
// ---------------------------------------------------------------------------------------------

describe('copy-forward re-plan and drivers (review: untouched copies are not this version\'s choice; fourth review: hand-set drivers)', () => {
  /**
   * Ali drives the first truck's load 1 (08:30-10:00, then LOCKED) and the second truck's load 2
   * (11:00-12:30), both set by hand. The re-plan moves the second truck's loads 150 min earlier:
   * its load 2 now leaves 08:30, onto Ali's kept load. `handSet` false clears the second load's
   * hand-set marker first, as if RouteIQ had filled Ali in.
   */
  async function retimeOntoKeptLoad(day: string, handSet: boolean) {
    // Five customers, one order each: five stops (the fake solver gives the first truck three loads).
    if (!(await prisma.customer.findFirst({ where: { tenantId, code: 'C5' } }))) {
      await prisma.customer.create({ data: { tenantId, code: 'C5', name: 'C5', branchKey: '__MAIN__', lat: 23.59, lng: 58.43, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
    }
    await seedOrders(day, 5);
    const ali = await prisma.driver.create({ data: { tenantId, code: `ALI-${uniqueSuffix()}`.slice(0, 20), name: 'Ali', active: true } });
    solverMode.mode = 'plan';
    const { run: v1 } = await getOrCreatePlan(tenantId, depotId, day, userId);
    expect((await startDispatchOptimize(tenantId, v1.id, user(), null)).status).toBe(202);
    expect((await jobsDone(v1.id)).status).toBe('READY');
    const v1Loads = await prisma.planLoad.findMany({ where: { runId: v1.id }, orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }] });
    const byTruck = new Map<string, typeof v1Loads>();
    for (const l of v1Loads) byTruck.set(l.truckId, [...(byTruck.get(l.truckId) ?? []), l]);
    // The fake solver: the first truck gets loads 1-3, the second loads 1-2; load k leaves at 06:00 + k x 150 min.
    const [first, second] = [...byTruck.values()].sort((a, b) => b.length - a.length);
    expect(first!.length).toBe(3);
    expect(second!.length).toBe(2);
    const firstL1 = first!.find((l) => l.loadNo === 1)!;
    const secondL2 = second!.find((l) => l.loadNo === 2)!;
    await updateLoad(tenantId, v1.id, firstL1.id, { driverId: ali.id, status: 'LOCKED' }, user(), everyRole);
    await updateLoad(tenantId, v1.id, secondL2.id, { driverId: ali.id }, user(), everyRole);
    const marked = await prisma.planLoad.findUniqueOrThrow({ where: { id: secondL2.id } });
    expect(marked.driverSetById).toBe(userId); // the dispatcher's driver change is marked
    expect(marked.driverSetAt).toBeInstanceOf(Date);
    if (!handSet) await prisma.planLoad.update({ where: { id: secondL2.id }, data: { driverSetById: null, driverSetAt: null } });

    solverMode.mode = 'earlySecondTruck';
    const rp = await replan(tenantId, v1.id, 'REOPTIMIZE', null, user(), null);
    expect(rp.status).toBe(202);
    const v2 = await jobsDone(String(rp.body.runId));
    expect(v2.status).toBe('READY');
    const v2Loads = await prisma.planLoad.findMany({ where: { runId: v2.id } });
    const kept = v2Loads.find((l) => l.carriedFromLoadId === firstL1.id)!;
    expect(kept).toMatchObject({ status: 'LOCKED', driverId: ali.id });
    const retimed = v2Loads.find((l) => l.truckId === secondL2.truckId && l.loadNo === 2)!;
    expect(retimed.departMin).toBe(kept.departMin); // same time as the kept load
    const clashes = driverClashes(v2Loads.map((l) => ({ id: l.id, truckId: l.truckId, driverId: l.driverId, departMin: l.departMin, returnMin: l.returnMin })));
    return { ali, kept, retimed, clashes, detail: (await getPlanDetail(tenantId, v2.id))! };
  }

  it('a PLANNED trip re-timed onto a kept LOCKED load of the same driver does not keep a driver RouteIQ filled in; the change is shown', async () => {
    const { ali, retimed, clashes, detail } = await retimeOntoKeptLoad(isoPlus(10), false);
    expect(retimed.driverId).not.toBe(ali.id); // not a second sheet for Ali
    expect(clashes).toEqual([]); // no driver on two trucks at overlapping times anywhere in the new version
    expect(detail.warnings.some((w) => w.startsWith('Driver changed by this plan:') && w.includes('Ali →') && w.includes('locked, loading or dispatched'))).toBe(true);
  });

  it('a driver the dispatcher set by hand stays on the re-timed trip, with its marker, and the overlap is the yellow warning (fourth review of PR3)', async () => {
    const { ali, kept, retimed, clashes, detail } = await retimeOntoKeptLoad(isoPlus(12), true);
    expect(retimed).toMatchObject({ driverId: ali.id, driverSetById: userId });
    expect(retimed.driverSetAt).toBeInstanceOf(Date);
    expect(clashes.map((c) => [c.a.id, c.b.id].sort())).toEqual([[kept.id, retimed.id].sort()]);
    expect(detail.warnings.some((w) => w.startsWith('Driver changed by this plan:'))).toBe(false);
  });
  it('fifth review: Keep marks a driver RouteIQ filled in; an option without a hand-set trip parks it in the summary JSON, and switching back gives it back', async () => {
    const day = isoPlus(14);
    await seedOrders(day, 4);
    const ali = await prisma.driver.create({ data: { tenantId, code: `ALI-${uniqueSuffix()}`.slice(0, 20), name: 'Ali', active: true } });
    const bob = await prisma.driver.create({ data: { tenantId, code: `BOB-${uniqueSuffix()}`.slice(0, 20), name: 'Bob', active: true } });
    solverMode.mode = 'plan';
    const { run: v1 } = await getOrCreatePlan(tenantId, depotId, day, userId);
    expect((await startDispatchOptimize(tenantId, v1.id, user(), null)).status).toBe(202);
    expect((await jobsDone(v1.id)).status).toBe('READY');
    const loads = await prisma.planLoad.findMany({ where: { runId: v1.id }, orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }] });
    expect(loads.length).toBe(4); // two trucks, two trips each

    // Keep: Ali put on a load without the marker (as before the update), then re-sent by the dispatcher.
    const a = loads[0]!;
    await prisma.planLoad.update({ where: { id: a.id }, data: { driverId: ali.id, driverSetById: null, driverSetAt: null } });
    expect((await getPlanDetail(tenantId, v1.id))!.loads.find((l) => l.id === a.id)!.driverHandSet).toBe(false);
    await updateLoad(tenantId, v1.id, a.id, { driverId: ali.id }, user(), everyRole);
    expect(await prisma.planLoad.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ driverId: ali.id, driverSetById: userId });
    expect((await getPlanDetail(tenantId, v1.id))!.loads.find((l) => l.id === a.id)!.driverHandSet).toBe(true);

    // Bob by hand on the last trip; the other option (MIN_TRUCKS) is made without that truck and trip.
    const b = loads[3]!;
    await updateLoad(tenantId, v1.id, b.id, { driverId: bob.id }, user(), everyRole);
    const setAt = (await prisma.planLoad.findUniqueOrThrow({ where: { id: b.id } })).driverSetAt!;
    const minTrucks = await prisma.scenarioResult.findFirstOrThrow({ where: { runId: v1.id, name: 'MIN_TRUCKS' } });
    const details = minTrucks.detailsJson as { loads: { truck_id: string; load_no: number }[] };
    await prisma.scenarioResult.update({
      where: { id: minTrucks.id },
      data: { detailsJson: { ...details, loads: details.loads.filter((l) => !(l.truck_id === b.truckId && l.load_no === b.loadNo)) } as never },
    });
    const recommended = await prisma.scenarioResult.findFirstOrThrow({ where: { runId: v1.id, name: 'RECOMMENDED' } });

    const away = await chooseScenario(tenantId, v1.id, minTrucks.id, userId);
    expect(away.driverChanges.map((c) => [c.truckId, c.loadNo, c.from?.id, c.reason])).toEqual([[b.truckId, b.loadNo, bob.id, 'TRIP_GONE']]);
    const summary = (await prisma.runPlan.findUniqueOrThrow({ where: { id: v1.id } })).summaryJson as { parkedDrivers?: unknown[] };
    expect(summary.parkedDrivers).toEqual([expect.objectContaining({ truckId: b.truckId, loadNo: b.loadNo, driverId: bob.id, driverSetById: userId, driverSetAt: setAt.toISOString() })]);
    expect((await getPlanDetail(tenantId, v1.id))!.warnings.some((w) => w.startsWith('Driver picked by hand, not in this plan: you picked Bob for'))).toBe(true);

    const back = await chooseScenario(tenantId, v1.id, recommended.id, userId);
    expect(back.driverChanges).toEqual([]);
    const restored = await prisma.planLoad.findFirstOrThrow({ where: { runId: v1.id, truckId: b.truckId, loadNo: b.loadNo } });
    expect(restored).toMatchObject({ driverId: bob.id, driverSetById: userId });
    expect(restored.driverSetAt!.getTime()).toBe(setAt.getTime());
    const kept = await prisma.planLoad.findFirstOrThrow({ where: { runId: v1.id, truckId: a.truckId, loadNo: a.loadNo } });
    expect(kept).toMatchObject({ driverId: ali.id, driverSetById: userId });
  });
});

describe('a failed re-plan saves no weight (review: copied loads keep matching their orders)', () => {
  it('a case weight corrected, then the re-plan fails: order kg unchanged, copied loads match, the warning stays; the retry saves it', async () => {
    const day = isoPlus(11);
    const code = `W-FIX-${uniqueSuffix()}`.slice(0, 20);
    const product = await prisma.product.create({ data: { tenantId, code, name: 'Corrected later', weightPerCaseKg: 10 } });
    const customers = await prisma.customer.findMany({ where: { tenantId }, orderBy: { code: 'asc' } });
    for (let i = 0; i < 2; i++) {
      await prisma.order.create({
        data: {
          tenantId,
          customerId: customers[i]!.id,
          depotId,
          deliveryDate: new Date(`${day}T00:00:00.000Z`),
          totalCases: 10,
          totalWeightKg: 100,
          status: 'VALIDATED',
          priority: 3,
          lines: { create: [{ productId: product.id, cases: 10, weightKg: 100, weightFromMaster: true, salesOrderNo: `SO-W-${day}-${i}` }] },
        },
      });
    }
    solverMode.mode = 'plan';
    const { run: v1 } = await getOrCreatePlan(tenantId, depotId, day, userId);
    expect((await startDispatchOptimize(tenantId, v1.id, user(), null)).status).toBe(202);
    expect((await jobsDone(v1.id)).status).toBe('READY');

    // The case weight is corrected under Products (10 -> 12 kg), then the re-plan's solve fails.
    await prisma.product.update({ where: { id: product.id }, data: { weightPerCaseKg: 12 } });
    solverMode.mode = 'fail';
    const rp = await replan(tenantId, v1.id, 'REOPTIMIZE', null, user(), null);
    expect(rp.status).toBe(202);
    const v2 = await jobsDone(String(rp.body.runId));
    expect(v2.status).toBe('FAILED');
    expect(v2.chosenScenarioId).toBeTruthy();

    const orders = await prisma.order.findMany({ where: { tenantId, deliveryDate: new Date(`${day}T00:00:00.000Z`) }, include: { lines: true } });
    for (const o of orders) {
      expect(o.totalWeightKg).toBe(100);
      expect(o.lines.map((l) => l.weightKg)).toEqual([100]);
    }
    const kgOf = new Map(orders.map((o) => [o.id, o.totalWeightKg]));
    for (const l of await prisma.planLoad.findMany({ where: { runId: v2.id }, include: { assignments: true } })) {
      expect(l.weightKg).toBeCloseTo(l.assignments.reduce((a, x) => a + (x.portionWeightKg ?? kgOf.get(x.orderId) ?? 0), 0), 1);
    }
    expect(await prisma.auditLog.count({ where: { tenantId, action: 'ORDER_WEIGHTS_RESOLVED', entityId: v2.id } })).toBe(0);
    const detail = await getPlanDetail(tenantId, v2.id);
    expect(detail!.warnings.join(' ')).toMatch(/Case weight entered or corrected under Products after this plan was made/);

    // The retry (a new version) plans and saves the new weight with its plan.
    solverMode.mode = 'plan';
    const retry = await replan(tenantId, v2.id, 'REOPTIMIZE', null, user(), null);
    expect(retry.status).toBe(202);
    const v3 = await jobsDone(String(retry.body.runId));
    expect(v3.status).toBe('READY');
    const after = await prisma.orderLine.findMany({ where: { productId: product.id } });
    expect(after.map((l) => l.weightKg)).toEqual([120, 120]);
    expect(await prisma.auditLog.count({ where: { tenantId, action: 'ORDER_WEIGHTS_RESOLVED', entityId: v3.id } })).toBe(1);
  });
});
