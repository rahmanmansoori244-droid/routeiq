/**
 * MOVES BY HAND (PR M2/M3), ON REAL POSTGRESQL (library level: the web server and the solver are not
 * used; the optimizer - its /optimize-dispatch and /retime-truck-days - and next-auth's session are faked
 * in this process). Needs DATABASE_URL (migrated). Synthetic data only.
 *
 * A day of three trucks (T01: two stops, T02: two stops, T03: one stop) and one order left unserved is
 * optimized; then a dispatcher checks and saves changes by hand (lib/dispatch/plan-edit.ts, -apply.ts):
 *  - a stop moved from T01 to T02: version 2 MANUAL_ADJUSTMENT, the parent SUPERSEDED, reconciled, the
 *    edited trucks VERIFIED in the web's own timetable check, every row of the edited trucks with today's
 *    snapshot (critic M4), T03's load and rows equal to the parent's in every column (its driver kept),
 *    the audit rows ROUTE_MANUALLY_CHANGED and PLAN_VERSION_CREATED;
 *  - an unserved order put on a load (its unserved row gone, the order ASSIGNED), a stop taken off the
 *    plan (REMOVED_BY_HAND, the order UNSERVED), a best place resolved for the save;
 *  - the option's own unserved list follows the rows (an order put on leaves it, a stop taken off joins it as
 *    REMOVED_BY_HAND); the save's after-commit steps (the day's hire checks stopped, the salesman day read again);
 *  - refusals: a LOCKED source (unlock, then it works), a move over a truck's cases (refused at Check and at
 *    Save, also with FEASIBILITY_GATE=warn); Best place where the stop already is (409 NO_CHANGE, never a solver
 *    failure); Put on a truck of an order on a load or moved to another day; a product without cases per pallet
 *    only on the trucks it re-times; a cases per pallet corrected after a day planned by pallets (409
 *    PALLET_FACTOR_CHANGED for a move, a take off and a put on; with the planned figure the saved load reads
 *    as stored, release review F1); the solver outdated, busy, not configured or failing (503);
 *  - races: a stale preview hash (PREVIEW_CHANGED with the new preview), a load of an edited truck locked
 *    between Check and Save (DAY_CHANGED, nothing written), a load of ANOTHER truck locked meanwhile (the
 *    save goes through: the stale check covers the touched trucks only, critic M2), a second save of the
 *    same check (SUPERSEDED), a check older than 10 minutes (PREVIEW_OLD);
 *  - the web check disagreeing with the solver rolls the whole save back (EDIT_CHECK_FAILED);
 *  - the switch through the real routes: off 404, check mode Check 200 and Save 409 CHECK_ONLY, VIEWER 403.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad, RetimeRequest, RetimeResponse, RetimeTruckOut } from '@routeiq/shared-types';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

// ---------------------------------------------------------------------------------------------
// Fakes: the session and the optimizer.

const m = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@/lib/auth', () => m);

/**
 * What the fake re-timing does: `lie` answers ok for a load over the truck's cases (the web check must catch it);
 * `reply`, when set, is the next call's whole answer (the solver outdated, busy, failing).
 */
const fake = vi.hoisted(() => ({ lie: false, retimeCalls: 0, afterRetime: null as null | (() => Promise<void>), reply: null as null | Record<string, unknown> }));

/** The steps after a save's commit (review M-03): the day's hire checks stopped, the salesman link's day read again. */
const afterCommit = vi.hoisted(() => ({ hireCancels: [] as unknown[][], salesForgets: [] as unknown[][] }));
vi.mock('@/lib/dispatch/hire-whatif', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown> & { cancelHireChecksOfDay: (...a: unknown[]) => Promise<number> };
  return {
    ...real,
    cancelHireChecksOfDay: async (...a: unknown[]) => {
      afterCommit.hireCancels.push(a);
      return real.cancelHireChecksOfDay(...a);
    },
  };
});
vi.mock('@/lib/sales-link/day-read', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown> & { forgetSalesDay: (...a: unknown[]) => void };
  return {
    ...real,
    forgetSalesDay: (...a: unknown[]) => {
      afterCommit.salesForgets.push(a);
      real.forgetSalesDay(...a);
    },
  };
});

vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(
      message: string,
      public status = 0,
      public responseBody: unknown = null,
      public code?: string,
    ) {
      super(message);
    }
  }
  type Stop = DispatchRequest['stops'][number];
  /** A load's timetable: 20 min out, 30 min a stop (15 unloading), 20 min back; 5 OMR + 2 a stop. */
  function timed(truckId: string, loadNo: number, depart: number, stops: Stop[]): PlannedLoad {
    let cum = 0;
    const out = stops.map((s, k) => {
      cum += 5;
      const arrival = depart + 20 + 30 * k;
      return {
        sequence: k + 1, stop_id: s.stop_id, order_ids: s.order_ids, customer_id: s.customer_id, arrival_min: arrival, service_start_min: arrival, departure_min: arrival + 15,
        wait_min: 0, leg_km: 5, cum_km: cum, leg_min: 15, cases: s.demand_cases, kg: s.demand_kg ?? 0, hard_window_ok: true, pref_window_ok: true,
      };
    });
    const ret = (out.at(-1)?.departure_min ?? depart) + 20;
    const cases = stops.reduce((a, s) => a + s.demand_cases, 0);
    return {
      truck_id: truckId, load_no: loadNo, depart_min: depart, return_min: ret, distance_km: cum + 5, duration_min: ret - depart, cases, kg: stops.reduce((a, s) => a + (s.demand_kg ?? 0), 0),
      utilization_pct: 10, fuel_litres: 1, fuel_cost: 0.5, distance_cost: 1, time_cost: 1, fixed_cost: 2, total_cost: 5 + 2 * stops.length, return_leg_km: 5, stops: out,
      // A day planned by pallets: the load's units as the optimizer echoes them (the sum of its stops').
      ...(stops.some((s) => typeof s.demand_pallet_units === 'number') ? { pallet_units: stops.reduce((a, s) => a + (s.demand_pallet_units ?? 0), 0) } : {}),
    } as PlannedLoad;
  }
  function truckDay(req: DispatchRequest, truckId: string, loads: string[][]) {
    const truck = req.trucks.find((t) => t.id === truckId)!;
    const frozen = truck.frozen_trips ?? [];
    // A same-day request: no new load leaves before loading can start (loading_from_min) and the truck is turned round.
    let at = Math.max(360, (req.config.loading_from_min ?? -1e9) + (req.config.reload_min ?? 30), ...frozen.map((f) => f.return_min + 90));
    const byId = new Map(req.stops.map((s) => [s.stop_id, s]));
    const out: PlannedLoad[] = [];
    loads.forEach((ids, i) => {
      const l = timed(truckId, frozen.length + i + 1, at, ids.map((id) => byId.get(id)!));
      out.push(l);
      at = l.return_min + 90;
    });
    const over = out.filter((l) => l.cases > truck.capacity_cases);
    const violations = over.map((l) => ({ code: 'CAPACITY_CASES' as const, truck_id: truckId, load_no: l.load_no, stop_id: null, message: `${truck.code} load ${l.load_no} needs ${l.cases} cases; the truck takes ${truck.capacity_cases}.`, short_by_min: l.cases - truck.capacity_cases }));
    const feasible = fake.lie || violations.length === 0;
    const money = out.reduce((a, l) => a + l.total_cost, 0);
    return { loads: out, feasible, violations: fake.lie ? [] : violations, money, km: out.reduce((a, l) => a + l.distance_km, 0), last: out.at(-1)?.return_min ?? null, first: out[0]?.depart_min ?? null };
  }
  function scenario(loads: PlannedLoad[], feasible: boolean, violations: { code: string }[]): DispatchScenario {
    return {
      name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'RETIMED', solver_time_sec: 0, time_limit_sec: 0, objective_value: 1,
      objective: { unserved_penalty: 0, fixed_cost: 0, distance_cost: 0, fuel_cost: 0, time_cost: 0, overtime_cost: 0, window_penalty: 0, margin_served: null },
      trucks_used: new Set(loads.map((l) => l.truck_id)).size, trips: loads.length, total_distance_km: loads.reduce((a, l) => a + l.distance_km, 0),
      total_duration_min: loads.reduce((a, l) => a + l.duration_min, 0), total_cases: loads.reduce((a, l) => a + l.cases, 0), total_kg: 0, avg_utilization_pct: 10,
      fuel_litres: 0, fuel_cost: 0, operating_cost: loads.reduce((a, l) => a + l.total_cost, 0), loads, unserved: [], warnings: [],
      truck_days: [...new Set(loads.map((l) => l.truck_id))].map((t) => ({ truck_id: t, loads: loads.filter((l) => l.truck_id === t).length, frozen_loads: 0, day_start_min: 360, paid_from_min: 360, last_return_min: 600, paid_min: 240, overtime_min: 0, fixed_cost: 2, trip_cost: 0, distance_cost: 1, fuel_cost: 0.5, driver_cost: 1, overtime_cost: 0, total_cost: 5 })),
      feasibility: { status: feasible ? 'VERIFIED' : 'VIOLATED', timing: 'EXACT', violations: violations as never },
      // By pallets: the pallet rule the optimizer echoes (units of 1/1000 pallet, bays filled to 100%).
      ...(loads.some((l) => typeof l.pallet_units === 'number') ? { pallet_unit: 0.001, pallet_fill_pct: 100 } : {}),
    } as unknown as DispatchScenario;
  }
  return {
    SolverError,
    /**
     * The first optimization: the first five stops (split parts first, then by id) in turn on T01, T02,
     * T03 (so T01 and T02 get two, T03 one, and two parts of a split customer go on different trucks),
     * the rest left out.
     */
    callDispatchSolver: vi.fn(async (req: DispatchRequest): Promise<DispatchResponse> => {
      const stops = [...req.stops].sort((a, b) => Number(b.stop_id.includes('#')) - Number(a.stop_id.includes('#')) || a.stop_id.localeCompare(b.stop_id));
      const trucks = [...req.trucks].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
      const plan = trucks.map((_, i) => stops.slice(0, 5).filter((__, k) => k % trucks.length === i));
      const loads = plan.map((ss, i) => timed(trucks[i]!.id, 1, 360, ss)).filter((l) => l.stops.length);
      const unserved = stops.slice(5).map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' as const, reason_message: 'Fleet capacity shortage' }));
      const sc = { ...scenario(loads, true, []), solver_status: 'ROUTING_SUCCESS', unserved };
      return { run_id: req.run_id, engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, scenarios: [sc], warnings: [] } as DispatchResponse;
    }),
    callRouteGeometry: vi.fn(async () => ({ kind: 'not_configured' })),
    /** /retime-truck-days: the edited trucks timed as above; best place = the cheapest place (later is cheaper). */
    callRetimeTruckDays: vi.fn(async (body: RetimeRequest) => {
      fake.retimeCalls++;
      if (fake.reply) {
        const r = fake.reply;
        fake.reply = null;
        return r;
      }
      const req = body.request;
      let days = body.truck_days.map((d) => ({ truck_id: d.truck_id, loads: d.loads }));
      let options: RetimeResponse['options'] = [];
      if (body.best) {
        const b = body.best;
        const base = days.find((d) => d.truck_id === b.truck_id)!.loads;
        const places: { loads: string[][]; load_index: number | null; new_load_at: number | null; position: number }[] = [];
        if (b.load_index !== null && b.load_index !== undefined) {
          for (let p = 0; p <= base[b.load_index]!.length; p++) places.push({ loads: base.map((l, i) => (i === b.load_index ? [...l.slice(0, p), b.stop_id, ...l.slice(p)] : l)), load_index: b.load_index, new_load_at: null, position: p });
        } else {
          for (let at = 0; at <= base.length; at++) places.push({ loads: [...base.slice(0, at), [b.stop_id], ...base.slice(at)], load_index: null, new_load_at: at, position: 0 });
        }
        const ranked = places
          .map((pl) => ({ pl, t: truckDay(req, b.truck_id, pl.loads) }))
          .filter((x) => x.t.feasible)
          .map((x) => ({ ...x, cost: x.t.money - x.pl.position * 0.1 - (x.pl.new_load_at ?? 0) * 0.1 }))
          .sort((a, c) => a.cost - c.cost);
        options = ranked.slice(0, 3).map((x) => ({ truck_id: b.truck_id, load_index: x.pl.load_index, new_load_at: x.pl.new_load_at, position: x.pl.position, loads: x.pl.loads, money_omr: x.t.money, soft_omr: 0, km: x.t.km, last_return_min: x.t.last ?? 0 }));
        if (options[0]) days = days.map((d) => (d.truck_id === b.truck_id ? { truck_id: d.truck_id, loads: options![0]!.loads } : d));
      }
      const after = days.map((d) => ({ d, t: truckDay(req, d.truck_id, d.loads) }));
      const before = new Map((body.before ?? []).map((d) => [d.truck_id, truckDay(req, d.truck_id, d.loads)]));
      const trucks: RetimeTruckOut[] = after.map(({ d, t }) => {
        const bt = before.get(d.truck_id);
        return {
          truck_id: d.truck_id, feasible: t.feasible, violations: t.violations, loads: t.loads.length, money_omr: t.feasible ? t.money : null, soft_omr: 0, km: t.km,
          first_depart_min: t.first, last_return_min: t.last, break_start_min: null,
          before: bt ? { feasible: bt.feasible, violations: bt.violations, loads: bt.loads.length, money_omr: bt.money, soft_omr: 0, km: bt.km, first_depart_min: bt.first, last_return_min: bt.last } : null,
          delta_money_omr: bt && t.feasible ? t.money - bt.money : null, delta_soft_omr: 0, delta_km: bt ? t.km - bt.km : null, delta_last_return_min: bt && t.last !== null && bt.last !== null ? t.last - bt.last : null,
        };
      });
      const ok = trucks.every((t) => t.feasible) && (!body.best || options.length > 0);
      const loads = after.flatMap((x) => x.t.loads);
      const answer: RetimeResponse = {
        ok, matrix_provider: 'HAVERSINE', distance_quality: 'ESTIMATED', distance_is_estimated: true,
        scenario: scenario(loads, ok, trucks.flatMap((t) => t.violations)), trucks, options, best_total: options.length, best_tried: options.length,
        delta_money_omr: trucks.every((t) => typeof t.delta_money_omr === 'number') ? trucks.reduce((a, t) => a + (t.delta_money_omr ?? 0), 0) : null,
        delta_soft_omr: 0, delta_km: trucks.reduce((a, t) => a + (t.delta_km ?? 0), 0), timings: 1, seconds: 0, warnings: [],
      };
      if (fake.afterRetime) {
        const hook = fake.afterRetime;
        fake.afterRetime = null;
        await hook();
      }
      return { kind: 'answer', body: answer };
    }),
  };
});

// ---------------------------------------------------------------------------------------------
// Modules under test (imported after the fakes).

/* eslint-disable @typescript-eslint/consistent-type-imports */
let planService: typeof import('@/lib/dispatch/plan-service');
let start: typeof import('@/lib/dispatch/start-optimize');
let edit: typeof import('@/lib/dispatch/plan-edit');
let apply: typeof import('@/lib/dispatch/plan-edit-apply');
let checkRoute: typeof import('@/app/api/runs/[id]/edit/check/route');
let saveRoute: typeof import('@/app/api/runs/[id]/edit/route');
/* eslint-enable @typescript-eslint/consistent-type-imports */

const g = globalThis as unknown as { __routeiqInflight?: Map<string, Promise<void>> };
const slugs: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  planService = await import('@/lib/dispatch/plan-service');
  start = await import('@/lib/dispatch/start-optimize');
  edit = await import('@/lib/dispatch/plan-edit');
  apply = await import('@/lib/dispatch/plan-edit-apply');
  checkRoute = await import('@/app/api/runs/[id]/edit/check/route');
  saveRoute = await import('@/app/api/runs/[id]/edit/route');
});

beforeEach(() => {
  fake.lie = false;
  fake.afterRetime = null;
  fake.reply = null;
  process.env.PLAN_EDIT = 'on';
  delete process.env.FEASIBILITY_GATE;
});

afterAll(async () => {
  delete process.env.PLAN_EDIT;
  for (const p of g.__routeiqInflight?.values() ?? []) await p.catch(() => undefined);
  for (const s of slugs) await cleanupTenant(s);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------
// Seeding

type U = { id: string; tenantId: string | null; role: string; name: string; email: string };
let seq = 0;

/** Muscat's date `n` days ahead (never a day that is over, never the same-day timing). */
function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function mkUser(tenantId: string, role: 'TENANT_ADMIN' | 'PLANNER' | 'VIEWER', label: string): Promise<U> {
  return prisma.user.create({
    data: { tenantId, role, name: label, email: `${label}-${Date.now().toString(36)}-${seq++}@plan-edit.test`.toLowerCase(), passwordHash: 'x' },
    select: { id: true, tenantId: true, role: true, name: true, email: true },
  });
}

async function jobsDone(runId: string) {
  for (let i = 0; i < 200; i++) {
    const p = g.__routeiqInflight?.get(runId);
    if (p) await p.catch(() => undefined);
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'OPTIMIZING') return run;
    await sleep(50);
  }
  throw new Error(`plan ${runId} still optimizing`);
}

/** A planned day: T01 two stops, T02 two stops, T03 one stop (with a hand-set driver), one order unserved. */
async function plannedDay(label: string, opts: { t02Cases?: number; bigFirst?: boolean; dayOffset?: number; pallets?: boolean } = {}) {
  const slug = `pe-${label}-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
  slugs.push(slug);
  const t = await prisma.tenant.create({ data: { slug, name: `PE ${label}`, country: 'Oman' } });
  await prisma.tenantConfig.create({ data: { tenantId: t.id, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  const admin = await mkUser(t.id, 'TENANT_ADMIN', `${label}-admin`);
  const planner = await mkUser(t.id, 'PLANNER', `${label}-planner`);
  const viewer = await mkUser(t.id, 'VIEWER', `${label}-viewer`);
  const depot = await prisma.depot.create({ data: { tenantId: t.id, code: 'D1', name: 'Depot', lat: 23.5, lng: 58.3 } });
  const trucks: Record<string, string> = {};
  for (const [code, cases] of [['T01', 200], ['T02', opts.t02Cases ?? 200], ['T03', 200]] as const) {
    trucks[code] = (await prisma.truck.create({ data: { tenantId: t.id, depotId: depot.id, code, capacityCases: cases, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1, ...(opts.pallets ? { bays: 12 } : {}) } })).id;
  }
  const driver = await prisma.driver.create({ data: { tenantId: t.id, code: 'DR3', name: 'Driver Three' }, select: { id: true } });
  // pallets: the day is planned by pallets (trucks with 12 bays, 50 cases a pallet).
  const product = await prisma.product.create({ data: { tenantId: t.id, code: 'P-1', name: 'Product One', weightPerCaseKg: 10, ...(opts.pallets ? { casesPerPallet: 50 } : {}) } });
  const day = isoPlus(opts.dayOffset ?? 2);
  const orderIds: string[] = [];
  // bigFirst: the first customer is bigger than any truck (300 cases on 200-case trucks): delivered in two parts.
  const cases = (i: number) => (opts.bigFirst && i === 0 ? 300 : 10 + i);
  for (const [i, [code, lat, lng]] of ([['C1', 23.58, 58.41], ['C2', 23.6, 58.37], ['C3', 23.55, 58.33], ['C4', 23.61, 58.45], ['C5', 23.59, 58.39], ['C6', 23.57, 58.36]] as const).entries()) {
    const c = await prisma.customer.create({ data: { tenantId: t.id, code, name: `Customer ${code}`, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
    const o = await prisma.order.create({
      data: {
        tenantId: t.id, customerId: c.id, depotId: depot.id, deliveryDate: new Date(`${day}T00:00:00.000Z`), totalCases: cases(i), totalWeightKg: cases(i) * 10, status: 'VALIDATED', priority: 3,
        lines: { create: [{ productId: product.id, cases: cases(i), weightKg: cases(i) * 10, salesOrderNo: `SO-${i}` }] },
      },
    });
    orderIds.push(o.id);
  }
  const { run } = await planService.getOrCreatePlan(t.id, depot.id, day, admin.id);
  expect((await start.startDispatchOptimize(t.id, run.id, { id: admin.id }, null)).status).toBe(202);
  const done = await jobsDone(run.id);
  expect(done.status).toBe('READY');
  const loads = await prisma.planLoad.findMany({ where: { runId: run.id }, include: { assignments: { orderBy: { sequenceInTruck: 'asc' } } }, orderBy: { loadNo: 'asc' } });
  const loadOf = (code: string) => loads.find((l) => l.truckId === trucks[code])!;
  // T03's driver set by hand: an untouched truck keeps it through the move.
  await prisma.planLoad.update({ where: { id: loadOf('T03').id }, data: { driverId: driver.id, driverSetById: planner.id, driverSetAt: new Date() } });
  const unservedOrderId = (await prisma.unservedOrder.findFirstOrThrow({ where: { scenarioId: done.chosenScenarioId! } })).orderId;
  return { tenantId: t.id, admin, planner, viewer, depotId: depot.id, day, runId: run.id, trucks, loadOf, driverId: driver.id, orderIds, unservedOrderId };
}
type Day = Awaited<ReturnType<typeof plannedDay>>;

const expectOf = (f: Day) => ({ date: f.day, depotId: f.depotId });
const check = (f: Day, move: Parameters<typeof edit.checkPlanEdit>[2]['move'], runId = f.runId) => edit.checkPlanEdit(f.tenantId, runId, { move, expect: expectOf(f) });
const save = (f: Day, c: Awaited<ReturnType<typeof check>>, runId = f.runId, now?: Date) =>
  apply.savePlanEdit(f.tenantId, runId, { move: c.preview.move, expect: expectOf(f), previewHash: c.preview.previewHash, builtAt: c.preview.builtAt }, { id: f.planner.id, name: f.planner.name }, null, { now });
async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string | undefined; details: Record<string, unknown>; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { status?: number; details?: Record<string, unknown>; message?: string };
    return { status: err.status ?? 0, code: err.details?.code as string | undefined, details: err.details ?? {}, message: err.message ?? '' };
  }
  throw new Error('expected a refusal');
}
const versions = (f: Day) => prisma.runPlan.count({ where: { tenantId: f.tenantId, depotId: f.depotId } });
/** A row as its columns are, without the ones a copy gives anew. */
const columns = (r: Record<string, unknown>) => {
  const { id: _i, runId: _r, loadId: _l, carriedFromLoadId: _c, createdAt: _t, assignments: _a, ...rest } = r;
  void _i; void _r; void _l; void _c; void _t; void _a;
  return rest;
};

// ---------------------------------------------------------------------------------------------

describe('a stop moved from one truck to another, saved as version 2', () => {
  it('re-times only the edited trucks, keeps every other row, reconciles and is audited', async () => {
    const f = await plannedDay('move');
    const t01 = f.loadOf('T01');
    const t03 = f.loadOf('T03');
    const parentT03 = await prisma.planLoad.findUniqueOrThrow({ where: { id: t03.id }, include: { assignments: true } });
    const c = await check(f, { kind: 'MOVE', from: { loadId: t01.id, sequence: 2 }, to: { truckId: f.trucks.T02!, loadId: f.loadOf('T02').id, position: 0 } });
    expect(c.preview.ok).toBe(true);
    expect(c.preview.canSave).toBe(true);
    expect(c.preview.trucks.map((t) => t.truckCode)).toEqual(['T01', 'T02']);
    expect(c.preview.deltaCostOmr).toBe(0);
    const saved = await save(f, c);
    expect(saved.version).toBe(2);
    expect(saved.reprint).toEqual(['T01 L1', 'T02 L1']);

    const parent = await prisma.runPlan.findUniqueOrThrow({ where: { id: f.runId } });
    const child = await prisma.runPlan.findUniqueOrThrow({ where: { id: saved.runId } });
    expect(parent.status).toBe('SUPERSEDED');
    expect(child).toMatchObject({ reason: 'MANUAL_ADJUSTMENT', status: 'READY', parentRunId: f.runId });
    expect((child.reconciliationJson as { ok: boolean }).ok).toBe(true);
    const feas = child.feasibilityJson as { trucks: Record<string, { ok: boolean; status: string }> };
    expect(feas.trucks[f.trucks.T01!]).toMatchObject({ ok: true, status: 'VERIFIED' });
    expect(feas.trucks[f.trucks.T02!]).toMatchObject({ ok: true, status: 'VERIFIED' });

    const loads = await prisma.planLoad.findMany({ where: { runId: child.id }, include: { assignments: { orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }] } } });
    const of = (code: string) => loads.find((l) => l.truckId === f.trucks[code])!;
    expect(of('T01').assignments.map((a) => a.orderId)).toEqual([t01.assignments[0]!.orderId]);
    expect(of('T02').assignments.map((a) => a.orderId)).toEqual([t01.assignments[1]!.orderId, ...f.loadOf('T02').assignments.map((a) => a.orderId)]);
    // Every row of the re-timed trucks has today's facts (critic M4), not only the stop moved.
    for (const a of [...of('T01').assignments, ...of('T02').assignments]) expect((a.stopSnapshotJson as { capturedAt: string }).capturedAt).toBe(c.preview.builtAt);
    // The untouched truck: its load and rows exactly as the parent's (a copy), its hand-set driver kept.
    expect(columns(of('T03'))).toEqual(columns(parentT03));
    expect(of('T03').driverId).toBe(f.driverId);
    expect(of('T03').assignments.map(columns)).toEqual(parentT03.assignments.map(columns));
    // The option in use says it was changed by hand; the header reads it from there, never from the reason.
    const option = await prisma.scenarioResult.findUniqueOrThrow({ where: { id: child.chosenScenarioId! } });
    expect((option.detailsJson as { manual?: { count: number } }).manual?.count).toBe(1);
    const audits = await prisma.auditLog.findMany({ where: { tenantId: f.tenantId, entityId: child.id }, select: { action: true, afterJson: true } });
    expect(audits.map((a) => a.action).sort()).toEqual(['PLAN_VERSION_CREATED', 'ROUTE_MANUALLY_CHANGED']);
    const moved = audits.find((a) => a.action === 'ROUTE_MANUALLY_CHANGED')!.afterJson as { move: { kind: string; from: { truckCode: string }; to: { truckCode: string; position: number } } };
    expect(moved.move).toMatchObject({ kind: 'MOVE', from: { truckCode: 'T01' }, to: { truckCode: 'T02', position: 1 } });

    // After the commit: the day's hire checks are stopped and the salesman link reads the new version.
    expect(afterCommit.hireCancels.at(-1)).toEqual([f.tenantId, f.depotId, parent.runDate, expect.stringContaining('the plan was changed by hand')]);
    expect(afterCommit.salesForgets.at(-1)).toEqual([f.tenantId, f.day]);

    // A second save of the same check: the parent is superseded.
    expect((await refusal(save(f, c))).code).toBe('SUPERSEDED');
  });
});

describe('put on, take off, best place', () => {
  it('puts the unserved order on a load: its unserved row goes and the order is ASSIGNED', async () => {
    const f = await plannedDay('place');
    const c = await check(f, { kind: 'PLACE', orderId: f.unservedOrderId, to: { truckId: f.trucks.T03!, loadId: f.loadOf('T03').id, position: 1 } });
    expect(c.preview.ok).toBe(true);
    const saved = await save(f, c);
    const child = await prisma.runPlan.findUniqueOrThrow({ where: { id: saved.runId } });
    expect(await prisma.unservedOrder.count({ where: { scenarioId: child.chosenScenarioId! } })).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: f.unservedOrderId } })).status).toBe('ASSIGNED');
    expect((child.reconciliationJson as { ok: boolean }).ok).toBe(true);
    expect(child.unservedCount).toBe(0);
    // The option's own unserved list agrees with the rows (review F2: the hire box reads it).
    const option = await prisma.scenarioResult.findUniqueOrThrow({ where: { id: child.chosenScenarioId! } });
    expect((option.detailsJson as { unserved: unknown[] }).unserved).toEqual([]);
  });

  it('takes a stop off the plan: REMOVED_BY_HAND, the order UNSERVED, its truck left without a load', async () => {
    const f = await plannedDay('remove');
    const t03 = f.loadOf('T03');
    const c = await check(f, { kind: 'REMOVE', from: { loadId: t03.id, sequence: 1 } });
    expect(c.preview.ok).toBe(true);
    const saved = await save(f, c);
    // Nothing to print again; the sheets of the load that is gone are void (review M-02).
    expect([saved.reprint, saved.gone, saved.trucks]).toEqual([[], ['T03 L1'], ['T03']]);
    const child = await prisma.runPlan.findUniqueOrThrow({ where: { id: saved.runId } });
    // The option's own unserved list agrees with the rows (review F2: the hire box reads it).
    const option = await prisma.scenarioResult.findUniqueOrThrow({ where: { id: child.chosenScenarioId! } });
    const listed = (option.detailsJson as { unserved: { order_ids: string[]; reason_code: string }[] }).unserved;
    expect(listed.map((u) => `${u.order_ids.join('+')}:${u.reason_code}`).sort()).toEqual([`${f.unservedOrderId}:SOLVER_DROPPED_LOW_PRIORITY`, `${t03.assignments[0]!.orderId}:REMOVED_BY_HAND`].sort());
    const rows = await prisma.unservedOrder.findMany({ where: { scenarioId: child.chosenScenarioId! } });
    expect(rows.map((r) => [r.orderId, r.reasonCode]).sort()).toEqual([[f.unservedOrderId, 'SOLVER_DROPPED_LOW_PRIORITY'], [t03.assignments[0]!.orderId, 'REMOVED_BY_HAND']].sort());
    expect((await prisma.order.findUniqueOrThrow({ where: { id: t03.assignments[0]!.orderId } })).status).toBe('UNSERVED');
    expect(await prisma.planLoad.count({ where: { runId: child.id, truckId: f.trucks.T03! } })).toBe(0);
    expect((child.reconciliationJson as { ok: boolean }).ok).toBe(true);
    // It can be put back on a truck by hand afterwards (from the new version).
    const back = await check(f, { kind: 'PLACE', orderId: t03.assignments[0]!.orderId, to: { truckId: f.trucks.T03!, loadId: null, before: null } }, child.id);
    expect(back.preview.ok).toBe(true);
  });

  it('best place: the check resolves it to a place, and the save makes exactly that', async () => {
    const f = await plannedDay('best');
    const t01 = f.loadOf('T01');
    const c = await check(f, { kind: 'MOVE', from: { loadId: t01.id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: f.loadOf('T02').id, position: 'BEST' } });
    expect(c.preview.move).toMatchObject({ to: { truckId: f.trucks.T02, loadId: f.loadOf('T02').id, position: 2 } });
    expect(c.preview.options.length).toBe(2);
    const saved = await save(f, c);
    const t02 = await prisma.planLoad.findFirstOrThrow({ where: { runId: saved.runId, truckId: f.trucks.T02! }, include: { assignments: { orderBy: { sequenceInTruck: 'asc' } } } });
    expect(t02.assignments.at(-1)!.orderId).toBe(t01.assignments[0]!.orderId);
  });
});

describe('a move on the delivery day itself (critic M10)', () => {
  it('re-times from the same-day clock: the new loads leave no earlier than loading can start, and the save keeps it', async () => {
    const f = await plannedDay('sameday', { dayOffset: 0 });
    // The dispatcher checks at 08:00 the company's time (fixed, so the test does not depend on when it runs).
    const at8 = new Date(`${f.day}T04:00:00.000Z`);
    const move = { kind: 'MOVE' as const, from: { loadId: f.loadOf('T01').id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: f.loadOf('T02').id, position: 0 } };
    const c = await edit.checkPlanEdit(f.tenantId, f.runId, { move, expect: expectOf(f), now: at8 });
    const from = c.built.request.config.loading_from_min;
    expect(typeof from).toBe('number');
    expect(from!).toBeGreaterThanOrEqual(480);
    expect(c.preview.ok).toBe(true);
    for (const t of c.preview.trucks) for (const l of t.after!.loads.filter((x) => !x.kept)) expect(l.departMin).toBeGreaterThanOrEqual(from!);
    const saved = await apply.savePlanEdit(f.tenantId, f.runId, { move: c.preview.move, expect: expectOf(f), previewHash: c.preview.previewHash, builtAt: c.preview.builtAt }, { id: f.planner.id }, null, { now: new Date(at8.getTime() + 60_000) });
    const loads = await prisma.planLoad.findMany({ where: { runId: saved.runId, truckId: { in: [f.trucks.T01!, f.trucks.T02!] } } });
    expect(loads.every((l) => l.departMin >= from!)).toBe(true);
    const feas = (await prisma.runPlan.findUniqueOrThrow({ where: { id: saved.runId } })).feasibilityJson as { trucks: Record<string, { ok: boolean }> };
    expect(feas.trucks[f.trucks.T02!]?.ok).toBe(true);
  });
});

describe('a split customer with one part locked (critic M10)', () => {
  it("a move on the truck of its PLANNED part keeps that part's lines and the plan reconciles", async () => {
    const f = await plannedDay('split', { bigFirst: true });
    const t01 = f.loadOf('T01');
    const t02 = f.loadOf('T02');
    const part = (l: typeof t01) => l.assignments.find((a) => a.orderId === f.orderIds[0]);
    expect(part(t01)?.portionLinesJson).toBeTruthy();
    expect(part(t02)?.portionLinesJson).toBeTruthy();
    // Part 1 (on T01) is locked; T02 holds part 2 and another stop, which moves to T03.
    await prisma.planLoad.update({ where: { id: t01.id }, data: { status: 'LOCKED' } });
    const other = t02.assignments.find((a) => a.orderId !== f.orderIds[0])!;
    const c = await check(f, { kind: 'MOVE', from: { loadId: t02.id, sequence: other.sequenceInTruck }, to: { truckId: f.trucks.T03!, loadId: f.loadOf('T03').id, position: 0 } });
    expect(c.preview.ok).toBe(true);
    const saved = await save(f, c);
    const child = await prisma.runPlan.findUniqueOrThrow({ where: { id: saved.runId } });
    expect((child.reconciliationJson as { ok: boolean }).ok).toBe(true);
    const newT02 = await prisma.planLoad.findFirstOrThrow({ where: { runId: child.id, truckId: f.trucks.T02! }, include: { assignments: true } });
    expect(newT02.assignments.map((a) => [a.orderId, a.portionCases, a.portionLinesJson])).toEqual([[f.orderIds[0], part(t02)!.portionCases, part(t02)!.portionLinesJson]]);
    // The merged option's ref of that row resolves to the same lines (critic M3).
    const option = await prisma.scenarioResult.findUniqueOrThrow({ where: { id: child.chosenScenarioId! } });
    const d = option.detailsJson as unknown as { loads: PlannedLoad[]; scope: { portions: Record<string, { orderId: string; lines: unknown }> } };
    const ref = d.loads.find((l) => l.truck_id === f.trucks.T02)!.stops[0]!.order_ids[0]!;
    expect(d.scope.portions[ref]).toMatchObject({ orderId: f.orderIds[0], lines: part(t02)!.portionLinesJson });
  });
});

describe('refusals', () => {
  it('a LOCKED source is refused (unlock first); after unlocking the move checks', async () => {
    const f = await plannedDay('locked');
    const t01 = f.loadOf('T01');
    await prisma.planLoad.update({ where: { id: t01.id }, data: { status: 'LOCKED' } });
    const move = { kind: 'MOVE' as const, from: { loadId: t01.id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: f.loadOf('T02').id, position: 0 } };
    const r = await refusal(check(f, move));
    expect(r).toMatchObject({ status: 409, code: 'LOAD_FROZEN' });
    await prisma.planLoad.update({ where: { id: t01.id }, data: { status: 'PLANNED' } });
    expect((await check(f, move)).preview.ok).toBe(true);
  });

  it('a move over the truck\'s cases is refused at Check and at Save, FEASIBILITY_GATE=warn or not', async () => {
    const f = await plannedDay('cases', { t02Cases: 25 });
    process.env.FEASIBILITY_GATE = 'warn';
    const c = await check(f, { kind: 'MOVE', from: { loadId: f.loadOf('T01').id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: f.loadOf('T02').id, position: 0 } });
    expect(c.preview.ok).toBe(false);
    expect(c.preview.canSave).toBe(false);
    expect(c.preview.trucks.find((t) => t.truckCode === 'T02')!.violations.map((v) => v.code)).toEqual(['CAPACITY_CASES']);
    expect((await refusal(save(f, c))).code).toBe('MOVE_REFUSED');
    expect(await versions(f)).toBe(1);
  });

  it('the web\'s own check disagreeing with the solver rolls the whole save back (EDIT_CHECK_FAILED)', async () => {
    const f = await plannedDay('lie', { t02Cases: 25 });
    fake.lie = true;
    const c = await check(f, { kind: 'MOVE', from: { loadId: f.loadOf('T01').id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: f.loadOf('T02').id, position: 0 } });
    expect(c.preview.ok).toBe(true);
    expect((await refusal(save(f, c))).code).toBe('EDIT_CHECK_FAILED');
    expect(await versions(f)).toBe(1);
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('READY');
  });
});

describe('refusals a dispatcher sees at Check (review F1/M-01, M-03)', () => {
  it("Best place on the stop's own load where it already is: 409 NO_CHANGE in plain words, never 'the route check did not answer'", async () => {
    const f = await plannedDay('nochange');
    const t01 = f.loadOf('T01');
    // The fake's best place in a load is its last position: T01's stop 2 is there already.
    const r = await refusal(check(f, { kind: 'MOVE', from: { loadId: t01.id, sequence: 2 }, to: { truckId: f.trucks.T01!, loadId: t01.id, position: 'BEST' } }));
    expect(r).toMatchObject({ status: 409, code: 'NO_CHANGE' });
    expect(r.message).toMatch(/is already at its best place \(T01 L1, stop 2\): nothing changes/);
    // Stop 1's best place is the end of the load: a preview, whose other places never include where it is now.
    const c = await check(f, { kind: 'MOVE', from: { loadId: t01.id, sequence: 1 }, to: { truckId: f.trucks.T01!, loadId: t01.id, position: 'BEST' } });
    expect(c.preview.move).toMatchObject({ to: { loadId: t01.id, position: 1 } });
    expect(c.preview.options).toEqual([]);
  });

  it('Put on a truck: an order on a load (NOT_UNSERVED), an unserved order moved to another day (NOT_PLANNABLE)', async () => {
    const f = await plannedDay('placerefuse');
    const to = { truckId: f.trucks.T03!, loadId: f.loadOf('T03').id, position: 0 };
    expect(await refusal(check(f, { kind: 'PLACE', orderId: f.loadOf('T01').assignments[0]!.orderId, to }))).toMatchObject({ status: 409, code: 'NOT_UNSERVED' });
    await prisma.order.update({ where: { id: f.unservedOrderId }, data: { deliveryDate: new Date(`${isoPlus(5)}T00:00:00.000Z`) } });
    const r = await refusal(check(f, { kind: 'PLACE', orderId: f.unservedOrderId, to }));
    expect(r).toMatchObject({ status: 409, code: 'NOT_PLANNABLE' });
    expect(r.message).toMatch(/^Customer C\d \(C\d\) cannot be planned now/);
  });

  it('a product without cases per pallet blocks only a move whose trucks carry it, in move words (review M-05)', async () => {
    const f = await plannedDay('pallets');
    // The depot plans by pallets from now on (a truck with bays); the day's product has its factor, a new one on T03's order has none.
    await prisma.truck.update({ where: { id: f.trucks.T01! }, data: { bays: 12 } });
    const p1 = await prisma.product.findFirstOrThrow({ where: { tenantId: f.tenantId, code: 'P-1' } });
    await prisma.product.update({ where: { id: p1.id }, data: { casesPerPallet: 50 } });
    const p2 = await prisma.product.create({ data: { tenantId: f.tenantId, code: 'P-2', name: 'Product Two', weightPerCaseKg: 10 } });
    const t03Order = f.loadOf('T03').assignments[0]!.orderId;
    await prisma.orderLine.create({ data: { orderId: t03Order, productId: p2.id, cases: 2, weightKg: 20, salesOrderNo: 'SO-X' } });
    // T01 to T02: neither carries P-2.
    const elsewhere = await check(f, { kind: 'MOVE', from: { loadId: f.loadOf('T01').id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: f.loadOf('T02').id, position: 0 } });
    expect(elsewhere.preview.trucks.map((t) => t.truckCode)).toEqual(['T01', 'T02']);
    // T01 to T03: T03 is timed again and carries P-2.
    const r = await refusal(check(f, { kind: 'MOVE', from: { loadId: f.loadOf('T01').id, sequence: 1 }, to: { truckId: f.trucks.T03!, loadId: f.loadOf('T03').id, position: 0 } }));
    expect(r).toMatchObject({ status: 409, code: 'PALLET_FACTOR_REQUIRED' });
    expect(r.message).toMatch(/^Cannot plan by pallets: 1 product\(s\) .*: P-2 \(2 cases\)\. .*then check the move again\.$/);
  });

  it('a cases per pallet corrected after a day planned by pallets: a change re-timing its loads is refused (re-plan first); with the planned figure the saved load reads as stored (release review F1)', async () => {
    const f = await plannedDay('pfactor', { pallets: true });
    const t02 = f.loadOf('T02');
    expect(typeof t02.palletUnits).toBe('number');
    const move = { kind: 'MOVE' as const, from: { loadId: f.loadOf('T01').id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: t02.id, position: 0 } };
    // An admin corrects the product's cases per pallet under Products after planning (50 to 20).
    await prisma.product.updateMany({ where: { tenantId: f.tenantId, code: 'P-1' }, data: { casesPerPallet: 20 } });
    const calls = fake.retimeCalls;
    const r = await refusal(check(f, move));
    expect(r).toMatchObject({ status: 409, code: 'PALLET_FACTOR_CHANGED' });
    expect(r.message).toBe(
      'The cases per pallet changed under Products since this plan: P-1 (Product One) is now 20 (planned with 50). This change re-times loads that carry it: RE-PLAN the day first, so every load uses the new figure.',
    );
    expect(r.details.palletFactorChanges).toEqual([{ code: 'P-1', name: 'Product One', planned: 50, now: 20 }]);
    // Refused before the solver is asked; a take off and a put on the same way; Save checks again, so nothing is written.
    expect(fake.retimeCalls).toBe(calls);
    expect((await refusal(check(f, { kind: 'REMOVE', from: { loadId: f.loadOf('T03').id, sequence: 1 } }))).code).toBe('PALLET_FACTOR_CHANGED');
    expect((await refusal(check(f, { kind: 'PLACE', orderId: f.unservedOrderId, to: { truckId: f.trucks.T03!, loadId: f.loadOf('T03').id, position: 1 } }))).code).toBe('PALLET_FACTOR_CHANGED');
    const atSave = await refusal(apply.savePlanEdit(f.tenantId, f.runId, { move, expect: expectOf(f), previewHash: 'x'.repeat(64), builtAt: new Date().toISOString() }, { id: f.planner.id }, null));
    expect(atSave).toMatchObject({ status: 409, code: 'PALLET_FACTOR_CHANGED' });
    expect(await versions(f)).toBe(1);

    // The figure as planned again: the move checks and saves, and the edited load reads exactly as it is stored.
    await prisma.product.updateMany({ where: { tenantId: f.tenantId, code: 'P-1' }, data: { casesPerPallet: 50 } });
    const c = await check(f, move);
    expect(c.preview.ok).toBe(true);
    const saved = await save(f, c);
    const { getPlanDetail } = await import('@/lib/dispatch/plan-detail');
    const after = (await getPlanDetail(f.tenantId, saved.runId))!.loads.find((l) => l.truckCode === 'T02')!;
    expect(typeof after.palletUnits).toBe('number');
    expect(after.manifest.reduce((a, m) => a + (m.palletUnits ?? 0), 0)).toBe(after.palletUnits);
    expect(after.palletNotes ?? []).toEqual([]);
  });

  it('the solver outdated, busy, not configured or failing: 503 with its words, nothing written', async () => {
    const f = await plannedDay('solver');
    const move = { kind: 'MOVE' as const, from: { loadId: f.loadOf('T01').id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: f.loadOf('T02').id, position: 0 } };
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: 'outdated' }, 'SOLVER_OUTDATED'],
      [{ kind: 'busy' }, 'SOLVER_BUSY'],
      [{ kind: 'not_configured' }, 'SOLVER_NOT_CONFIGURED'],
      [{ kind: 'timeout' }, 'SOLVER_FAILED'],
      [{ kind: 'failed', status: 422, detail: 'Unknown stop' }, 'SOLVER_FAILED'],
    ];
    for (const [reply, code] of cases) {
      fake.reply = reply;
      expect(await refusal(check(f, move)), code).toMatchObject({ status: 503, code });
    }
    expect(await versions(f)).toBe(1);
  });
});

describe('races between Check and Save', () => {
  const moveOf = (f: Day) => ({ kind: 'MOVE' as const, from: { loadId: f.loadOf('T01').id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: f.loadOf('T02').id, position: 0 } });

  it('a stale preview hash: PREVIEW_CHANGED with the new preview, nothing written', async () => {
    const f = await plannedDay('hash');
    const c = await check(f, moveOf(f));
    const r = await refusal(apply.savePlanEdit(f.tenantId, f.runId, { move: c.preview.move, expect: expectOf(f), previewHash: '0'.repeat(64), builtAt: c.preview.builtAt }, { id: f.planner.id }, null));
    expect(r.code).toBe('PREVIEW_CHANGED');
    expect((r.details.preview as { previewHash: string }).previewHash).toBe(c.preview.previewHash);
    expect(await versions(f)).toBe(1);
  });

  it("a load of an edited truck locked before Save: the save's own check refuses it (LOAD_FROZEN), nothing written", async () => {
    const f = await plannedDay('lockedafter');
    const c = await check(f, moveOf(f));
    await prisma.planLoad.update({ where: { id: f.loadOf('T02').id }, data: { status: 'LOCKED' } });
    expect((await refusal(save(f, c))).code).toBe('LOAD_FROZEN');
    expect(await versions(f)).toBe(1);
  });

  it("locked after the save's own check and before its transaction: DAY_CHANGED under the locks, nothing written", async () => {
    const f = await plannedDay('lockedrace');
    const c = await check(f, moveOf(f));
    // The save checks again (the solver re-times), then this lands before its transaction reads the trucks again.
    fake.afterRetime = async () => {
      await prisma.planLoad.update({ where: { id: f.loadOf('T02').id }, data: { status: 'LOCKED' } });
    };
    expect((await refusal(save(f, c))).code).toBe('DAY_CHANGED');
    expect(await versions(f)).toBe(1);
    expect(await prisma.auditLog.count({ where: { tenantId: f.tenantId, action: 'ROUTE_MANUALLY_CHANGED' } })).toBe(0);
  });

  it('a load of ANOTHER truck locked meanwhile does not block the move (critic M2)', async () => {
    const f = await plannedDay('elsewhere');
    const c = await check(f, moveOf(f));
    await prisma.planLoad.update({ where: { id: f.loadOf('T03').id }, data: { status: 'LOCKED' } });
    const saved = await save(f, c);
    expect(saved.version).toBe(2);
    expect(await prisma.planLoad.count({ where: { runId: saved.runId, truckId: f.trucks.T03!, status: 'LOCKED' } })).toBe(1);
  });

  it('a check more than 10 minutes old: PREVIEW_OLD', async () => {
    const f = await plannedDay('old');
    const c = await check(f, moveOf(f));
    const r = await refusal(save(f, c, f.runId, new Date(Date.parse(c.preview.builtAt) + 11 * 60_000)));
    expect(r.code).toBe('PREVIEW_OLD');
  });
});

describe('the switch and the roles, through the real routes', () => {
  const sessionOf = (u: U) => ({ user: { id: u.id, tenantId: u.tenantId, role: u.role, name: u.name, email: u.email } });
  const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('off: 404 FEATURE_OFF; check: Check answers, Save 409 CHECK_ONLY; VIEWER 403; another plan 404', async () => {
    const f = await plannedDay('switch');
    const body = { move: { kind: 'REMOVE', from: { loadId: f.loadOf('T03').id, sequence: 1 } }, expect: expectOf(f) };
    process.env.PLAN_EDIT = 'off';
    m.auth.mockResolvedValueOnce(sessionOf(f.planner));
    expect((await checkRoute.POST(post(`/api/runs/${f.runId}/edit/check`, body), { params: { id: f.runId } })).status).toBe(404);
    process.env.PLAN_EDIT = 'check';
    m.auth.mockResolvedValueOnce(sessionOf(f.planner));
    const checked = await checkRoute.POST(post(`/api/runs/${f.runId}/edit/check`, body), { params: { id: f.runId } });
    expect(checked.status).toBe(200);
    const preview = ((await checked.json()) as { data: { previewHash: string; builtAt: string; canSave: boolean; mode: string } }).data;
    expect(preview).toMatchObject({ canSave: false, mode: 'CHECK' });
    m.auth.mockResolvedValueOnce(sessionOf(f.planner));
    const saved = await saveRoute.POST(post(`/api/runs/${f.runId}/edit`, { ...body, previewHash: preview.previewHash, builtAt: preview.builtAt }), { params: { id: f.runId } });
    expect(saved.status).toBe(409);
    expect(((await saved.json()) as { error: { code: string } }).error.code).toBe('CHECK_ONLY');
    m.auth.mockResolvedValueOnce(sessionOf(f.viewer));
    expect((await checkRoute.POST(post(`/api/runs/${f.runId}/edit/check`, body), { params: { id: f.runId } })).status).toBe(403);
    m.auth.mockResolvedValueOnce(sessionOf(f.planner));
    expect((await saveRoute.POST(post(`/api/runs/no-such-run/edit`, { ...body, previewHash: preview.previewHash, builtAt: preview.builtAt }), { params: { id: 'no-such-run' } })).status).toBe(404);
    expect(await versions(f)).toBe(1);
  });
});
