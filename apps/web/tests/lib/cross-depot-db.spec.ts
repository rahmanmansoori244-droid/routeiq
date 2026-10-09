/**
 * ONE TRUCK OR DRIVER ON TWO DEPOTS' PLANS ON ONE DAY (review finding web-plan-service-1), library level
 * on real PostgreSQL: the plan service and its background job, LOCK / LOADING / DISPATCH through
 * updateLoad, with the optimizer faked in this process by one that keeps the optimizer's truck-day rules
 * (one stop per load, trucks in turn; no load before the first departure, the truck's own hours or its
 * locked / dispatched loads' return + reload; a truck with no time left takes none). Needs DATABASE_URL
 * (migrated); the web server and the solver are not used. Each case has its own company.
 *
 * Before the fix each depot's plan saw only its own loads:
 *  1. a truck lent from North to South after its North load was dispatched got a South Load 1 at 06:00,
 *     while it was still out on the North trip, and both were locked and dispatched;
 *  2. two depots that plan at the same moment (each search started before the other's loads existed)
 *     both gave the truck 06:00, and both could lock and dispatch it - also when they lock at once;
 *  3. a driver out on a North load was given (as his truck's usual driver) a South load at the same time,
 *     and could be locked and dispatched on it.
 * Now the planner plans the truck and the driver around the other depot's loads (with the drive between
 * the depots), and LOCK / LOADING / DISPATCH refuse 409 TRUCK_BUSY_ELSEWHERE / DRIVER_BUSY_ELSEWHERE.
 * Synthetic data only.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';

/** The fake optimizer's state: the requests it got, and a search held until the test lets it finish. */
const solver = vi.hoisted(() => ({ requests: [] as unknown[], holdDepotId: null as string | null, held: null as Promise<void> | null }));

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  /** One stop per load, usable trucks in turn; every load is 240 min long. */
  function fakeSolve(req: DispatchRequest): DispatchResponse {
    const cfg = req.config ?? {};
    const firstDeparture = Math.max(cfg.shift_start_min ?? 360, req.depot.open_min ?? 0);
    const reload = cfg.reload_min ?? 30;
    const state = new Map(
      req.trucks.map((t) => {
        const frozen = t.frozen_trips ?? [];
        return [t.id, { loadNo: frozen.length, back: frozen.length ? Math.max(...frozen.map((f) => f.return_min)) : null as number | null }];
      }),
    );
    // The truck's own hours: no load before them, none back after them (an empty window: no load).
    const startOf = (t: DispatchRequest['trucks'][number]) => Math.max(firstDeparture, t.available_from_min ?? 0);
    const usable = req.trucks.filter((t) => startOf(t) + 240 <= (t.available_to_min ?? 2880));
    const stops = [...req.stops].sort((a, b) => a.stop_id.localeCompare(b.stop_id));
    const loads: PlannedLoad[] = stops.map((s, i) => {
      const truck = usable[i % usable.length]!;
      const st = state.get(truck.id)!;
      const depart = Math.max(startOf(truck), st.back === null ? 0 : st.back + reload);
      st.loadNo += 1;
      st.back = depart + 240;
      return {
        truck_id: truck.id,
        load_no: st.loadNo,
        depart_min: depart,
        return_min: depart + 240,
        distance_km: 12,
        duration_min: 240,
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
      };
    });
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
      total_duration_min: loads.length * 240,
      total_cases: loads.reduce((a, l) => a + l.cases, 0),
      total_kg: 0,
      avg_utilization_pct: 10,
      fuel_litres: 0,
      fuel_cost: 0,
      operating_cost: loads.length * 2.5,
      loads,
      unserved: [],
      warnings: [],
    };
    return { run_id: req.run_id, engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, scenarios: [sc], warnings: [] };
  }
  return {
    SolverError,
    callDispatchSolver: vi.fn(async (req: DispatchRequest) => {
      solver.requests.push(req);
      // A search of the held depot runs until the test lets it finish (two depots planning at once).
      if (solver.held && req.depot.id === solver.holdDepotId) await solver.held;
      return fakeSolve(req);
    }),
  };
});

import { prisma as libPrisma } from '@/lib/db';
import { getOrCreatePlan, PlanError, updateLoad } from '@/lib/dispatch/plan-service';
import { startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { driveBetweenMin } from '@/lib/dispatch/cross-depot';
import { cleanupTenant, prisma, uniqueSuffix } from '../integration/helpers';

const NORTH = { lat: 23.58, lng: 58.39 };
const SOUTH = { lat: 23.3, lng: 58.6 };
/** The estimated drive between the two depots at the company defaults (x 1.3 at 40 km/h): 74 min. */
const DRIVE = driveBetweenMin(NORTH, SOUTH, { distanceMultiplier: 1.3, avgSpeedKmh: 40 });
const RELOAD = 30;
const everyRole = () => true;
const slugs: string[] = [];

/** A delivery day far from today on the real clock (never a same-day plan). */
function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DAY = isoPlus(150);
const theDayBefore = () => new Date(`${isoPlus(148)}T06:00:00Z`);

/** A company with a North and a South depot, customers near each, and one product. */
async function company() {
  const slug = `xdepot-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
  slugs.push(slug);
  const t = await prisma.tenant.create({ data: { slug, name: `Two depots ${slug}`, country: 'Oman' } });
  const tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null, shiftStartMin: 360, reloadMinutes: RELOAD } });
  const userId = (await prisma.user.create({ data: { tenantId, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner', role: 'TENANT_ADMIN' } })).id;
  const north = (await prisma.depot.create({ data: { tenantId, code: 'NORTH', name: 'North depot', ...NORTH } })).id;
  const south = (await prisma.depot.create({ data: { tenantId, code: 'SOUTH', name: 'South depot', ...SOUTH } })).id;
  const productId = (await prisma.product.create({ data: { tenantId, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 12 } })).id;
  for (const [code, lat, lng] of [['ACME', 23.6, 58.41], ['BETA', 23.61, 58.45], ['DELTA', 23.32, 58.62], ['ECHO', 23.31, 58.64]] as const) {
    await prisma.customer.create({ data: { tenantId, code, name: `Shop ${code}`, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
  }
  const user = { id: userId, role: 'TENANT_ADMIN' };
  const truck = async (code: string, depotId: string, defaultDriverId: string | null = null) =>
    (await prisma.truck.create({ data: { tenantId, depotId, code, capacityCases: 800, capacityWeightKg: 12000, fixedCostPerDay: 25, costPerKm: 0.12, defaultDriverId } })).id;
  const driver = async (code: string, name: string) => (await prisma.driver.create({ data: { tenantId, code, name } })).id;
  const order = async (code: string, depotId: string, cases: number) => {
    const customer = await prisma.customer.findFirstOrThrow({ where: { tenantId, code } });
    return prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        depotId,
        deliveryDate: new Date(`${DAY}T00:00:00.000Z`),
        totalCases: cases,
        totalWeightKg: cases * 12,
        status: 'VALIDATED',
        priority: 3,
        lines: { create: [{ productId, cases, weightKg: cases * 12, salesOrderNo: `SO-${code}` }] },
      },
    });
  };
  /** Start the depot's optimization for the day (its job runs in the background). */
  const start = async (depotId: string) => {
    const { run } = await getOrCreatePlan(tenantId, depotId, DAY, userId);
    expect((await startDispatchOptimize(tenantId, run.id, user, null, { now: theDayBefore() })).status).toBe(202);
    return run.id;
  };
  /** Plan the depot's day and wait for it. */
  const plan = async (depotId: string) => {
    const runId = await start(depotId);
    expect((await jobsDone(runId)).status).toBe('READY');
    return runId;
  };
  const loadOf = (runId: string, truckId: string) => prisma.planLoad.findFirstOrThrow({ where: { runId, truckId, loadNo: 1 } });
  const move = (runId: string, loadId: string, change: { status?: 'LOCKED' | 'LOADING' | 'DISPATCHED'; driverId?: string | null }) =>
    updateLoad(tenantId, runId, loadId, change, user, everyRole, { now: theDayBefore() });
  return { tenantId, north, south, truck, driver, order, start, plan, loadOf, move };
}

async function jobsDone(runId: string) {
  const g = globalThis as unknown as { __routeiqInflight?: Map<string, Promise<void>> };
  for (let i = 0; i < 100; i++) {
    const p = g.__routeiqInflight?.get(runId);
    if (p) await p;
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'OPTIMIZING') return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`plan ${runId} still optimizing`);
}

/** The refusal a promise ends with (a PlanError's status and details), or null when it went through. */
async function refusal(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(PlanError);
    const err = e as PlanError;
    return { status: err.status, message: err.message, ...(err.details as Record<string, unknown>) };
  }
}

const overlap = (a: { departMin: number; returnMin: number }, b: { departMin: number; returnMin: number }, drive = 0) =>
  a.departMin < b.returnMin + drive && b.departMin < a.returnMin + drive;

afterAll(async () => {
  for (const slug of slugs) await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('a truck lent to another depot after its first load there is out', () => {
  it('is planned at the second depot only once it is back, has driven over and is loaded; both loads lock and dispatch', async () => {
    const c = await company();
    const salim = await c.driver('D1', 'Salim');
    const t01 = await c.truck('T01', c.north);
    await c.order('ACME', c.north, 40);
    await c.order('DELTA', c.south, 12);

    // North: T01 Load 1 06:00-10:00, locked and dispatched with Salim.
    const northRun = await c.plan(c.north);
    const northL1 = await c.loadOf(northRun, t01);
    expect([northL1.departMin, northL1.returnMin]).toEqual([360, 600]);
    await c.move(northRun, northL1.id, { status: 'LOCKED', driverId: salim });
    await c.move(northRun, northL1.id, { status: 'DISPATCHED' });

    // The admin lends T01 to South for the day; South plans its day.
    await prisma.truck.update({ where: { id: t01 }, data: { depotId: c.south } });
    solver.requests.length = 0;
    const southRun = await c.plan(c.south);
    const sent = (solver.requests[0] as DispatchRequest).trucks.find((t) => t.id === t01)!;
    // Back at North 10:00, the drive to South, then reload (loading per case is 0 here).
    const ready = 600 + DRIVE + RELOAD;
    expect(sent.available_from_min).toBe(ready);
    expect(sent.frozen_trips ?? []).toEqual([]); // South's own loads only: its Load 1 is still Load 1
    const southL1 = await c.loadOf(southRun, t01);
    expect(southL1.departMin).toBe(ready);
    expect(overlap(southL1, northL1, DRIVE)).toBe(false);
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: southRun } });
    expect(JSON.stringify(run.summaryJson)).toContain("Truck T01 is on another depot's plan this day (North depot: L1 06:00–10:00 dispatched)");

    // Salim drives T01 at South too, after the North trip: Lock, Loading and Dispatch go through.
    await c.move(southRun, southL1.id, { status: 'LOCKED', driverId: salim });
    await c.move(southRun, southL1.id, { status: 'LOADING' });
    await c.move(southRun, southL1.id, { status: 'DISPATCHED' });
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: southL1.id } })).status).toBe('DISPATCHED');
  });
});

describe('two depots that plan the same trucks at the same moment', () => {
  it('both plans give T01 and T02 06:00; the depot that locks first keeps the truck, the other is refused - also when both lock at once', async () => {
    const c = await company();
    const [d1, d2, d3] = [await c.driver('D1', 'Salim'), await c.driver('D2', 'Khalid'), await c.driver('D3', 'Nasser')];
    const t01 = await c.truck('T01', c.north);
    const t02 = await c.truck('T02', c.north);
    await c.order('ACME', c.north, 40);
    await c.order('BETA', c.north, 20);
    await c.order('DELTA', c.south, 12);
    await c.order('ECHO', c.south, 15);

    // North's search runs (its request already built with T01 and T02); meanwhile both trucks are lent
    // to South, whose plan is built while North has no load yet. Then both searches finish.
    let release!: () => void;
    solver.holdDepotId = c.north;
    solver.held = new Promise<void>((r) => (release = r));
    const northRun = await c.start(c.north);
    await prisma.truck.updateMany({ where: { id: { in: [t01, t02] } }, data: { depotId: c.south } });
    const southRun = await c.start(c.south);
    release();
    solver.held = null;
    expect((await jobsDone(northRun)).status).toBe('READY');
    expect((await jobsDone(southRun)).status).toBe('READY');
    const [n1, n2, s1, s2] = await Promise.all([c.loadOf(northRun, t01), c.loadOf(northRun, t02), c.loadOf(southRun, t01), c.loadOf(southRun, t02)]);
    for (const [a, b] of [[n1, s1], [n2, s2]]) expect([a.departMin, b.departMin, overlap(a, b)]).toEqual([360, 360, true]);

    // T01: North locks and dispatches first. South's Lock is refused and changes nothing.
    await c.move(northRun, n1.id, { status: 'LOCKED', driverId: d1 });
    await c.move(northRun, n1.id, { status: 'DISPATCHED' });
    const truckBusy = await refusal(c.move(southRun, s1.id, { status: 'LOCKED', driverId: d2 }));
    expect(truckBusy).toMatchObject({ status: 409, code: 'TRUCK_BUSY_ELSEWHERE', truckId: t01, depotId: c.north, depotName: 'North depot', otherLoadNo: 1, otherStatus: 'DISPATCHED', driveMin: DRIVE });
    expect(truckBusy!.message).toBe(
      `T01 L1 (06:00–10:00): this truck is also on L1 of the North depot plan of this day, 06:00–10:00 (dispatched), about ${DRIVE} min drive from this depot, and cannot do both. Re-plan this depot: its new loads are then planned around that load.`,
    );
    expect(await prisma.planLoad.findUniqueOrThrow({ where: { id: s1.id } })).toMatchObject({ status: 'PLANNED', driverId: null });
    expect(await prisma.auditLog.count({ where: { tenantId: c.tenantId, entityId: s1.id } })).toBe(0);

    // T02: both depots press Lock at the same moment. One goes through, the other is refused.
    const both = await Promise.all([refusal(c.move(northRun, n2.id, { status: 'LOCKED', driverId: d3 })), refusal(c.move(southRun, s2.id, { status: 'LOCKED', driverId: d2 }))]);
    expect(both.filter((r) => r === null)).toHaveLength(1);
    expect(both.find((r) => r !== null)).toMatchObject({ status: 409, code: 'TRUCK_BUSY_ELSEWHERE', truckId: t02 });
    const statuses = (await prisma.planLoad.findMany({ where: { id: { in: [n2.id, s2.id] } }, select: { status: true } })).map((l) => l.status).sort();
    expect(statuses).toEqual(['LOCKED', 'PLANNED']);
  });
});

describe('a driver out on another depot\'s load', () => {
  it('is not given a load at the same time by the other depot\'s plan, and cannot be locked or dispatched on one', async () => {
    const c = await company();
    const salim = await c.driver('D1', 'Salim');
    const khalid = await c.driver('D2', 'Khalid');
    // Salim is the usual driver of a North truck and of a South truck.
    const n1 = await c.truck('N1', c.north, salim);
    const s1 = await c.truck('S1', c.south, salim);
    await c.order('ACME', c.north, 40);
    await c.order('DELTA', c.south, 12);

    const northRun = await c.plan(c.north);
    const northL1 = await c.loadOf(northRun, n1);
    expect(northL1.driverId).toBe(salim);
    await c.move(northRun, northL1.id, { status: 'LOCKED' });
    await c.move(northRun, northL1.id, { status: 'DISPATCHED' });

    // South's S1 Load 1 is at the same time (06:00-10:00): RouteIQ does not give it Salim.
    const southRun = await c.plan(c.south);
    const southL1 = await c.loadOf(southRun, s1);
    expect(overlap(southL1, northL1)).toBe(true);
    expect(southL1.driverId).toBeNull();

    // Picked by hand and locked in one request: refused, and the driver step is undone with it.
    const busy = await refusal(c.move(southRun, southL1.id, { driverId: salim, status: 'LOCKED' }));
    expect(busy).toMatchObject({ status: 409, code: 'DRIVER_BUSY_ELSEWHERE', driverId: salim, name: 'Salim', otherTruckCode: 'N1', otherLoadNo: 1, depotName: 'North depot' });
    expect(busy!.message).toBe(
      `S1 L1 (06:00–10:00): Salim drives N1 L1 on the North depot plan of this day, 06:00–10:00 (dispatched), about ${DRIVE} min drive from this depot, and cannot drive both. Pick another driver for this load.`,
    );
    expect(await prisma.planLoad.findUniqueOrThrow({ where: { id: southL1.id } })).toMatchObject({ status: 'PLANNED', driverId: null });

    // Set by hand on its own, then Lock: still refused. Another driver: it goes out.
    await c.move(southRun, southL1.id, { driverId: salim });
    expect(await refusal(c.move(southRun, southL1.id, { status: 'LOCKED' }))).toMatchObject({ code: 'DRIVER_BUSY_ELSEWHERE' });
    await c.move(southRun, southL1.id, { driverId: khalid, status: 'LOCKED' });
    await c.move(southRun, southL1.id, { status: 'DISPATCHED' });
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: southL1.id } })).status).toBe('DISPATCHED');
  });
});
