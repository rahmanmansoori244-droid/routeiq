/**
 * ISSUE 7 - "USE THIS PLAN" AGAINST CONCURRENT CHANGES, ON REAL POSTGRESQL (library level: the web
 * server and the solver are not used; the optimizer and next-auth's session are faked in this
 * process). Needs DATABASE_URL (migrated). Synthetic data only.
 *
 * The hire suggestion's "Use this plan" (lib/dispatch/hire-use.ts) checked the hire options and the
 * plan before its transaction, then rented and applied with what it had read: a change committed in
 * between was applied over. Each race below commits its change after the press's checks and before
 * its transaction (a barrier after the press reads the hire options), and each failed on main:
 *
 *  - the hire option is switched off (company admin, PATCH /api/hire-options/:id): main rented two
 *    trucks from the inactive option;
 *  - the option's max per day is lowered from 2 to 1: main rented 2;
 *  - another plan option is chosen ("Use instead"): main applied the suggestion computed for the old
 *    option over it as version 2;
 *  - the second way (the day changed, so the trucks are rented and the day re-planned) with the option
 *    switched off: main rented a truck from it and started a re-plan.
 *
 * Fixed: one transaction re-checks everything under locks taken in the dispatch writers' order - the
 * hire codes lock (and in the plan way first the intake and day locks), the plan row FOR UPDATE (the
 * same version, not superseded or optimizing, no job, the same plan option in use), then the hire
 * options used FOR SHARE (each still active with the same size, costs and max per day) - and refuses
 * with HIRE_CHANGED: nothing rented, nothing applied, the suggestion unused. While the press holds them,
 * an admin's change to the option and "Use instead" wait for it (no deadlock).
 *
 * Interleavings are forced with a Prisma query extension that pauses a chosen model operation (a
 * barrier) without changing what it does - installed as the application's client (lib/db.ts honours
 * globalThis.__prisma), so the real routes and helpers run unmodified.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { DispatchRequest, DispatchResponse, DispatchScenario, DispatchStop, DispatchTruck, PlannedLoad } from '@routeiq/shared-types';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

// ---------------------------------------------------------------------------------------------
// Fakes: the session (per call) and the optimizer.

const m = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@/lib/auth', () => m);

const solver = vi.hoisted(() => ({ calls: 0 }));
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
  function load(truck: DispatchTruck, loadNo: number, s: DispatchStop, km: number): PlannedLoad {
    const depart = 360 + loadNo * 150;
    return {
      truck_id: truck.id, load_no: loadNo, depart_min: depart, return_min: depart + 90, distance_km: km, duration_min: 90,
      cases: s.demand_cases, kg: s.demand_kg ?? 0, utilization_pct: 10, fuel_litres: 2, fuel_cost: 0.5, distance_cost: 1, time_cost: 1,
      fixed_cost: 0, total_cost: km / 4, return_leg_km: km / 2,
      stops: [
        { sequence: 1, stop_id: s.stop_id, order_ids: s.order_ids, customer_id: s.customer_id, arrival_min: depart + 20, service_start_min: depart + 20, departure_min: depart + 40, wait_min: 0, leg_km: km / 2, cum_km: km / 2, leg_min: 20, cases: s.demand_cases, kg: s.demand_kg ?? 0, hard_window_ok: true, pref_window_ok: true },
      ],
    } as PlannedLoad;
  }
  function scenario(name: string, loads: PlannedLoad[], unserved: DispatchScenario['unserved']): DispatchScenario {
    return {
      name, status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 0.1, time_limit_sec: 5, objective_value: 1,
      objective: { unserved_penalty: 0, fixed_cost: 0, distance_cost: 0, fuel_cost: 0, time_cost: 0, overtime_cost: 0, window_penalty: 0, margin_served: null },
      trucks_used: new Set(loads.map((l) => l.truck_id)).size, trips: loads.length,
      total_distance_km: loads.reduce((a, l) => a + l.distance_km, 0), total_duration_min: loads.length * 90,
      total_cases: loads.reduce((a, l) => a + l.cases, 0), total_kg: 0, avg_utilization_pct: 10, fuel_litres: 0, fuel_cost: 0,
      operating_cost: loads.reduce((a, l) => a + l.total_cost, 0), loads, unserved, warnings: [],
    } as unknown as DispatchScenario;
  }
  /**
   * The own trucks carry every stop but the last two (by stop id), one load each; the last two are
   * left out for the fleet's capacity - or, with trucks to rent in the request (the hire what-if),
   * go on the first two of them. MIN_DISTANCE puts the own stops on the other own truck (another
   * plan option a dispatcher can choose).
   */
  function plan(req: DispatchRequest, km: number, shift: number) {
    const stops = [...req.stops].sort((a, b) => a.stop_id.localeCompare(b.stop_id));
    const own = req.trucks.filter((t) => !t.hire_candidate);
    const hires = req.trucks.filter((t) => t.hire_candidate);
    const kept = stops.slice(0, Math.max(0, stops.length - 2));
    const extra = stops.slice(kept.length);
    const loads = kept.map((s, i) => load(own[(i + shift) % own.length]!, Math.floor(i / own.length) + 1, s, km));
    const unserved: DispatchScenario['unserved'] = [];
    extra.forEach((s, i) => {
      if (hires[i]) loads.push(load(hires[i]!, 1, s, km));
      else unserved.push({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'SOLVER_DROPPED_LOW_PRIORITY', reason_message: 'Fleet capacity shortage' });
    });
    return { loads, unserved };
  }
  return {
    SolverError,
    callDispatchSolver: vi.fn(async (req: DispatchRequest): Promise<DispatchResponse> => {
      solver.calls++;
      const a = plan(req, 12, 0);
      const scenarios = [scenario('RECOMMENDED', a.loads, a.unserved)];
      if ((req.config?.scenarios ?? []).includes('MIN_DISTANCE')) {
        const b = plan(req, 9, 1);
        scenarios.push(scenario('MIN_DISTANCE', b.loads, b.unserved));
      }
      return { run_id: req.run_id, engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, scenarios, warnings: [] } as DispatchResponse;
    }),
    callRouteGeometry: vi.fn(async () => ({ kind: 'not_configured' })),
  };
});

// ---------------------------------------------------------------------------------------------
// The application's client with barriers.

type Hook = { before?: () => Promise<void>; after?: () => Promise<void> };
const hooks = new Map<string, Hook>();
const appBase = new PrismaClient();
const appClient = appBase.$extends({
  name: 'hireUseBarrier',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const h = hooks.get(`${model}.${operation}`);
        if (h?.before) await h.before();
        const r = await query(args);
        if (h?.after) await h.after();
        return r;
      },
    },
  },
});
/** Pause the next `model.operation` once, before or after it runs, until released. */
function barrier(key: string, when: 'before' | 'after') {
  const reached = deferred();
  const release = deferred();
  hooks.set(key, {
    [when]: async () => {
      hooks.delete(key);
      reached.resolve();
      await release.promise;
    },
  });
  return { reached: reached.promise, release: () => release.resolve() };
}
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once a backend of this database waits on a row lock of these tables (up to `ms`). */
async function someoneWaitsOnLock(table: 'HireOption' | 'RunPlan', ms = 3000): Promise<boolean> {
  for (let t = 0; t < ms; t += 25) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${`%"${table}"%`}`;
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await sleep(25);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Modules under test, imported after the barrier client is installed.

/* eslint-disable @typescript-eslint/consistent-type-imports */
let planService: typeof import('@/lib/dispatch/plan-service');
let start: typeof import('@/lib/dispatch/start-optimize');
let hireWhatIf: typeof import('@/lib/dispatch/hire-whatif');
let hireUse: typeof import('@/lib/dispatch/hire-use');
let optionRoute: typeof import('@/app/api/hire-options/[id]/route');
/* eslint-enable @typescript-eslint/consistent-type-imports */

const g = globalThis as unknown as { __prisma?: unknown; __routeiqInflight?: Map<string, Promise<void>> };
const previousClient = g.__prisma;
const slugs: string[] = [];

beforeAll(async () => {
  g.__prisma = appClient;
  planService = await import('@/lib/dispatch/plan-service');
  start = await import('@/lib/dispatch/start-optimize');
  hireWhatIf = await import('@/lib/dispatch/hire-whatif');
  hireUse = await import('@/lib/dispatch/hire-use');
  optionRoute = await import('@/app/api/hire-options/[id]/route');
});

afterAll(async () => {
  hooks.clear();
  // Every job and check of these tests has ended before their companies go.
  for (const p of g.__routeiqInflight?.values() ?? []) await p.catch(() => undefined);
  for (const s of slugs) await cleanupTenant(s);
  if (previousClient === undefined) delete g.__prisma;
  else g.__prisma = previousClient;
  await appBase.$disconnect();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------
// Seeding: a day the own fleet cannot carry, a hire option, a finished suggestion to rent 2.

type U = { id: string; tenantId: string | null; role: string; name: string; email: string };
let seq = 0;

/** Muscat's date `n` days ahead (never a day that is over, never today's same-day timing). */
function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const sessionOf = (u: U) => ({ user: { id: u.id, tenantId: u.tenantId, role: u.role, name: u.name, email: u.email } });
const send = (url: string, method: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function mkUser(tenantId: string, role: 'TENANT_ADMIN' | 'PLANNER', label: string): Promise<U> {
  return prisma.user.create({
    data: { tenantId, role, name: label, email: `${label}-${Date.now().toString(36)}-${seq++}@hire-races.test`.toLowerCase(), passwordHash: 'x' },
    select: { id: true, tenantId: true, role: true, name: true, email: true },
  });
}

async function jobsDone(runId: string) {
  for (let i = 0; i < 100; i++) {
    const p = g.__routeiqInflight?.get(runId);
    if (p) await p.catch(() => undefined);
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'OPTIMIZING') return run;
    await sleep(50);
  }
  throw new Error(`plan ${runId} still optimizing`);
}

/**
 * A company whose plan for a coming day leaves 2 of its 4 orders out for the fleet's capacity, a
 * depot hire option (10-ton, 50 OMR a day, at most 2), and the finished suggestion: rent 2.
 */
async function suggested(label: string, dayOffset: number) {
  const slug = `i7-${label}-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
  slugs.push(slug);
  const t = await prisma.tenant.create({ data: { slug, name: `I7 ${label}`, country: 'Oman' } });
  await prisma.tenantConfig.create({ data: { tenantId: t.id, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  const admin = await mkUser(t.id, 'TENANT_ADMIN', `${label}-admin`);
  const planner = await mkUser(t.id, 'PLANNER', `${label}-planner`);
  const depot = await prisma.depot.create({ data: { tenantId: t.id, code: 'MCT', name: 'Muscat', lat: 23.568, lng: 58.392 } });
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({ data: { tenantId: t.id, depotId: depot.id, code, capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1 } });
  }
  const product = await prisma.product.create({ data: { tenantId: t.id, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 10 } });
  const customers: string[] = [];
  for (const [code, lat, lng] of [['C1', 23.588, 58.41], ['C2', 23.6, 58.372], ['C3', 23.555, 58.335], ['C4', 23.61, 58.45], ['C5', 23.59, 58.39]] as const) {
    customers.push((await prisma.customer.create({ data: { tenantId: t.id, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } })).id);
  }
  const day = isoPlus(dayOffset);
  let n = 0;
  const order = async (customer: number) =>
    prisma.order.create({
      data: {
        tenantId: t.id, customerId: customers[customer]!, depotId: depot.id, deliveryDate: new Date(`${day}T00:00:00.000Z`),
        totalCases: 10, totalWeightKg: 100, status: 'VALIDATED', priority: 3,
        lines: { create: [{ productId: product.id, cases: 10, weightKg: 100, salesOrderNo: `SO-${day}-${n++}` }] },
      },
    });
  for (let i = 0; i < 4; i++) await order(i);
  const { run } = await planService.getOrCreatePlan(t.id, depot.id, day, admin.id);
  expect((await start.startDispatchOptimize(t.id, run.id, { id: admin.id }, null)).status).toBe(202);
  expect((await jobsDone(run.id)).status).toBe('READY');
  // The option comes after the plan, so the plan's own automatic check finds none (or is the one asked for below).
  const option = await prisma.hireOption.create({
    data: { tenantId: t.id, depotId: depot.id, label: '10-ton', bays: null, capacityCases: 200, payloadKg: 0, costPerDay: 50, costPerKm: null, maxPerDay: 2, active: true },
  });
  const r = await hireWhatIf.startHireCheck(t.id, run.id, { id: planner.id }, null, 'ASKED');
  const suggestionId = 'suggestionId' in r && r.suggestionId ? r.suggestionId : null;
  expect(suggestionId, JSON.stringify(r)).toBeTruthy();
  let s = await prisma.hireSuggestion.findUniqueOrThrow({ where: { id: suggestionId! } });
  for (let i = 0; i < 200 && (s.status === 'QUEUED' || s.status === 'RUNNING'); i++) {
    await sleep(25);
    s = await prisma.hireSuggestion.findUniqueOrThrow({ where: { id: suggestionId! } });
  }
  expect(s.status).toBe('SUCCEEDED');
  const summary = s.summaryJson as { status: string; hires: { optionId: string; count: number }[] };
  expect(summary).toMatchObject({ status: 'HIRE', hires: [{ optionId: option.id, count: 2 }] });
  const scenarios = await prisma.scenarioResult.findMany({ where: { runId: run.id }, select: { id: true, name: true } });
  const minDistanceId = scenarios.find((x) => x.name === 'MIN_DISTANCE')!.id;
  return { tenantId: t.id, admin, planner, depotId: depot.id, day, runId: run.id, optionId: option.id, suggestionId: suggestionId!, minDistanceId, addOrder: () => order(4) };
}
type Fixture = Awaited<ReturnType<typeof suggested>>;

/** The admin's change to the option through the real route (PATCH /api/hire-options/:id). */
async function patchOption(f: Fixture, body: Record<string, unknown>) {
  m.auth.mockResolvedValueOnce(sessionOf(f.admin));
  const res = await optionRoute.PATCH(send(`/api/hire-options/${f.optionId}`, 'PATCH', body), { params: { id: f.optionId } });
  return res.status;
}
/** The admin deletes the option, or moves it to another depot (the real routes): status and error code. */
async function removeOption(f: Fixture, how: 'delete' | 'move') {
  m.auth.mockResolvedValueOnce(sessionOf(f.admin));
  let res: Response;
  if (how === 'delete') {
    res = await optionRoute.DELETE(send(`/api/hire-options/${f.optionId}`, 'DELETE'), { params: { id: f.optionId } });
  } else {
    const other = await prisma.depot.create({ data: { tenantId: f.tenantId, code: `SOH-${seq++}`, name: 'Sohar', lat: 24.34, lng: 56.73 } });
    res = await optionRoute.PATCH(send(`/api/hire-options/${f.optionId}`, 'PATCH', { depotId: other.id }), { params: { id: f.optionId } });
  }
  const body = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code ?? null };
}

const press = (f: Fixture) => hireUse.applyHireSuggestion(f.tenantId, f.runId, f.suggestionId, { id: f.planner.id }, null, { expect: { date: f.day, depotId: f.depotId } });

/** What a press may have left behind, to compare before and after. */
async function stateOf(f: Fixture) {
  const [oneDayTrucks, versions, jobs, audits, s, v1] = await Promise.all([
    prisma.truck.count({ where: { tenantId: f.tenantId, onlyOnDate: { not: null } } }),
    prisma.runPlan.count({ where: { tenantId: f.tenantId, depotId: f.depotId, runDate: new Date(`${f.day}T00:00:00.000Z`) } }),
    prisma.runJob.count({ where: { tenantId: f.tenantId } }),
    prisma.auditLog.count({ where: { tenantId: f.tenantId, action: { in: ['HIRED_TRUCKS_ADDED', 'HIRE_SUGGESTION_USED', 'PLAN_VERSION_CREATED'] } } }),
    prisma.hireSuggestion.findUniqueOrThrow({ where: { id: f.suggestionId }, select: { usedAt: true, usedById: true, usedRunId: true } }),
    prisma.runPlan.findUniqueOrThrow({ where: { id: f.runId }, select: { status: true, supersededAt: true } }),
  ]);
  return { oneDayTrucks, versions, jobs, audits, suggestion: s, v1, solverCalls: solver.calls };
}

const CHANGED = 'The hire options or the plan changed since this suggestion. Press Check hire options again.';

/** Refused with the plain words, and nothing rented, applied, started or audited. */
async function refusedAndNothingApplied(f: Fixture, r: Awaited<ReturnType<typeof press>>, before: Awaited<ReturnType<typeof stateOf>>) {
  expect(r.status, JSON.stringify(r.body)).toBe(409);
  expect(r.body).toMatchObject({ code: 'HIRE_CHANGED', error: CHANGED });
  const after = await stateOf(f);
  expect(after).toEqual({ ...before, suggestion: { usedAt: null, usedById: null, usedRunId: null } });
  expect(after.oneDayTrucks).toBe(0);
  expect(after.versions).toBe(1);
  expect(after.v1.supersededAt).toBeNull();
}

// =============================================================================================
describe('ISSUE 7: "Use this plan" refuses a change committed after its checks (real PostgreSQL)', () => {
  it('control: nothing changes - the two trucks are rented and the suggestion is applied as version 2', async () => {
    const f = await suggested('ctl', 3);
    const r = await press(f);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ applied: 'PLAN', version: 2 });
    const rented = await prisma.truck.findMany({ where: { tenantId: f.tenantId, onlyOnDate: { not: null } }, select: { code: true, hireOptionId: true } });
    expect(rented).toHaveLength(2);
    expect(rented.every((t) => t.hireOptionId === f.optionId && t.code.startsWith('HIRE-10T-'))).toBe(true);
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('SUPERSEDED');
  });

  it('the hire option is switched off after the checks: refused, nothing rented or applied', async () => {
    const f = await suggested('off', 3);
    const before = await stateOf(f);
    const b = barrier('HireOption.findMany', 'after'); // the press has read the options; no transaction yet
    const p = press(f);
    await b.reached;
    expect(await patchOption(f, { active: false })).toBe(200);
    b.release();
    await refusedAndNothingApplied(f, await p, before);
    expect((await prisma.hireOption.findUniqueOrThrow({ where: { id: f.optionId } })).active).toBe(false);
  });

  it("the option's max per day is lowered from 2 to 1 after the checks: refused, never 2 rented", async () => {
    const f = await suggested('max', 3);
    const before = await stateOf(f);
    const b = barrier('HireOption.findMany', 'after');
    const p = press(f);
    await b.reached;
    expect(await patchOption(f, { maxPerDay: 1 })).toBe(200);
    b.release();
    await refusedAndNothingApplied(f, await p, before);
    expect((await prisma.hireOption.findUniqueOrThrow({ where: { id: f.optionId } })).maxPerDay).toBe(1);
  });

  it('another plan option is chosen ("Use instead") after the checks: refused, the chosen option stays in use', async () => {
    const f = await suggested('opt', 3);
    const before = await stateOf(f);
    const b = barrier('HireOption.findMany', 'after');
    const p = press(f);
    await b.reached;
    await planService.chooseScenario(f.tenantId, f.runId, f.minDistanceId, f.admin.id);
    b.release();
    const r = await p;
    const now = await stateOf(f);
    // "Use instead" wrote its own audit rows; compare everything else.
    await refusedAndNothingApplied(f, r, { ...before, audits: now.audits });
    expect(await prisma.auditLog.count({ where: { tenantId: f.tenantId, action: { in: ['HIRED_TRUCKS_ADDED', 'HIRE_SUGGESTION_USED', 'PLAN_VERSION_CREATED'] } } })).toBe(0);
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: f.runId } })).chosenScenarioId).toBe(f.minDistanceId);
  });

  it('the re-plan way (the day changed since the check) with the option switched off after the checks: refused, nothing rented, no re-plan', async () => {
    const f = await suggested('rpl', 4);
    await f.addOrder(); // a fifth order: the day is no longer the one the check planned
    const before = await stateOf(f);
    const b = barrier('HireOption.findMany', 'after');
    const p = press(f);
    await b.reached;
    expect(await patchOption(f, { active: false })).toBe(200);
    b.release();
    await refusedAndNothingApplied(f, await p, before);
  });

  it('the daily driver day rate is changed after the press read the day: it re-plans with the trucks (as when changed before), never applies the check costed at the old rate', async () => {
    const f = await suggested('rate', 6);
    const b = barrier('TenantConfig.findUniqueOrThrow', 'after'); // the press read the day (its settings); no transaction yet
    const p = press(f);
    await b.reached;
    await prisma.tenantConfig.update({ where: { tenantId: f.tenantId }, data: { dailyDriverDayRate: 40 } });
    b.release();
    const r = await p;
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ applied: 'REPLAN' });
    expect(await prisma.auditLog.count({ where: { tenantId: f.tenantId, action: 'HIRE_SUGGESTION_USED', afterJson: { path: ['how'], equals: 'PLAN_APPLIED' } } })).toBe(0);
    await jobsDone(String(r.body.runId));
  });

  for (const how of ['delete', 'move'] as const) {
    it(`an admin's ${how === 'delete' ? 'delete of the option' : 'move of the option to another depot'} while the press rents from it waits for it, then is refused: the rented trucks keep their option`, async () => {
      const f = await suggested(how === 'delete' ? 'del' : 'mov', 7);
      const b = barrier('HireSuggestion.updateMany', 'before'); // inside the press's transaction, after its locks
      const p = press(f);
      await b.reached;
      const removal = removeOption(f, how);
      expect(await someoneWaitsOnLock('HireOption')).toBe(true);
      b.release();
      const r = await p;
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await removal).toEqual({ status: 409, code: 'HIRE_OPTION_IN_USE' });
      const rented = await prisma.truck.findMany({ where: { tenantId: f.tenantId, onlyOnDate: { not: null } }, select: { hireOptionId: true } });
      expect(rented.map((t) => t.hireOptionId)).toEqual([f.optionId, f.optionId]);
      expect(await prisma.hireOption.findUniqueOrThrow({ where: { id: f.optionId }, select: { depotId: true } })).toEqual({ depotId: f.depotId });
    });
  }

  it('while the press holds its locks, the admin\'s change and "Use instead" wait for it: the press applies, then they run (no deadlock)', async () => {
    const f = await suggested('lck', 5);
    const b = barrier('HireSuggestion.updateMany', 'before'); // the claim: inside the transaction, after its locks
    const p = press(f);
    await b.reached;
    const off = patchOption(f, { active: false });
    expect(await someoneWaitsOnLock('HireOption')).toBe(true);
    const instead = planService.chooseScenario(f.tenantId, f.runId, f.minDistanceId, f.admin.id).then(
      () => 'applied',
      (e: { details?: { code?: string } }) => e.details?.code ?? 'error',
    );
    expect(await someoneWaitsOnLock('RunPlan')).toBe(true);
    b.release();
    const r = await p;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ applied: 'PLAN', version: 2 });
    expect(await off).toBe(200);
    // Version 1 was replaced by the press: choosing another of its options is refused, never applied over.
    expect(await instead).toBe('SUPERSEDED');
    expect(await prisma.truck.count({ where: { tenantId: f.tenantId, onlyOnDate: { not: null }, hireOptionId: f.optionId } })).toBe(2);
  });
});
