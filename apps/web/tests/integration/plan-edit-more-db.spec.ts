/**
 * MOVES BY HAND, PART 2 (owner feedback of 24 Oct 2026: whole loads, several stops at once, allow anyway), ON
 * REAL POSTGRESQL (library level: the web server and the solver are not used; the optimizer - its
 * /optimize-dispatch and /retime-truck-days v2 - and next-auth's session are faked in this process, following
 * the v2 contract of the design: figures on violations, late_s, `relax` with `relaxed`, several stops / a
 * whole load placed, `loads`, `retime_version`, and a v1 mode). Needs DATABASE_URL (migrated). Synthetic data.
 *
 * A day of three trucks (T01: C1, C4; T02: C2, C5; T03: C3) and C6 left unserved is optimized; then:
 *  - D-1 a swap of two loads; D-2 a whole load moved before another truck's L1; D-3 several stops of two loads
 *    plus an unserved customer with two orders to one load at the best place; D-4 every stop of a load taken
 *    off; D-5 a list of two operations in one save; D-17 a swap and a load move next to a LOCKED L1;
 *  - D-6 a late arrival allowed by hand by a SUPERVISOR: the allowance kept with the load, the gate's WARN,
 *    Lock / Loading / Dispatch pass, the audit RULE_ALLOWED_BY_HAND, the plan detail, the driver sheet and the
 *    WhatsApp text; D-7 capacity at 115 % by a TENANT_ADMIN, a PLANNER refused (403); D-8 the confirmations
 *    checked (OVERRIDES_CHANGED, a short reason, the switch off, checking only, a change that keeps every rule);
 *    D-9 a lying solver (125 %, a figure understated): OVERRIDE_NOT_ALLOWED; D-10 a rule that cannot be allowed;
 *  - D-11 the allowance through later versions (another truck's change, lock, unlock, a RE-PLAN drops it on
 *    Planned loads); D-13 an allowance changed between check and save (DAY_CHANGED); D-14 an older solver;
 *    D-15 Lock for a capacity allowance; D-16 the switch off keeps stored allowances honoured; D-18 a best
 *    place that needs an allowance, saved from the check's own list; D-19 stops exchanged between two full
 *    loads in one list; D-20 an allowance carried by a PLANNER's later change; D-21 the RE-PLAN confirmation
 *    list; D-23 several late stops allowed with one reason.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, FeasibilityViolation, PlannedLoad, RetimeRequest, RetimeResponse, RetimeTruckOut } from '@routeiq/shared-types';
import { cleanupTenant, prisma, uniqueSuffix, withDriver } from './helpers';

const m = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@/lib/auth', () => m);

/**
 * The fake re-timing: `v1` answers like a solver before v2 (no retime_version, no figures, no relaxed); `lie`
 * allows capacity over the 120 % cap; `lie2` understates a load's cases; `blockTrucks` gives every load of those
 * trucks a TRUCK_NOT_ALLOWED; `reply` is the next call's whole answer; `afterRetime` runs after a call.
 */
const fake = vi.hoisted(() => ({
  v1: false,
  lie: false,
  lie2: false,
  blockTrucks: new Set<string>(),
  calls: [] as RetimeRequest[],
  afterRetime: null as null | (() => Promise<void>),
  reply: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/dispatch/hire-whatif', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, cancelHireChecksOfDay: async () => 0 };
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
  type V = FeasibilityViolation;
  const hhmm = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  /** A load: 20 min out, 30 min a stop (wait for opening, 15 unloading), 20 min back; 5 OMR + 2 a stop. */
  function timed(req: DispatchRequest, truckId: string, loadNo: number, depart: number, stops: Stop[]): PlannedLoad {
    let cum = 0;
    const finish = req.config.window_rule === 'FINISH';
    const out = stops.map((s, k) => {
      cum += 5;
      const arrival = depart + 20 + 30 * k;
      const start = Math.max(arrival, s.hard_start_min ?? 0);
      const at = finish ? start + 15 : start;
      const ok = s.hard_end_min === null || s.hard_end_min === undefined || at <= s.hard_end_min;
      return {
        sequence: k + 1, stop_id: s.stop_id, order_ids: s.order_ids, customer_id: s.customer_id, arrival_min: arrival, service_start_min: start, departure_min: start + 15,
        wait_min: start - arrival, leg_km: 5, cum_km: cum, leg_min: 15, cases: s.demand_cases, kg: s.demand_kg ?? 0, hard_window_ok: ok, pref_window_ok: true,
      };
    });
    const ret = (out.at(-1)?.departure_min ?? depart) + 20;
    return {
      truck_id: truckId, load_no: loadNo, depart_min: depart, return_min: ret, distance_km: cum + 5, duration_min: ret - depart, cases: stops.reduce((a, s) => a + s.demand_cases, 0),
      kg: stops.reduce((a, s) => a + (s.demand_kg ?? 0), 0), utilization_pct: 10, fuel_litres: 1, fuel_cost: 0.5, distance_cost: 1, time_cost: 1, fixed_cost: 2, total_cost: 5 + 2 * stops.length, return_leg_km: 5, stops: out,
    } as PlannedLoad;
  }
  /** One truck's day timed and judged (every rule): its violations with the v2 figures, overridable under `relax`. */
  function truckDay(req: DispatchRequest, truckId: string, loads: string[][], relax: RetimeRequest['relax'] | undefined) {
    const truck = req.trucks.find((t) => t.id === truckId)!;
    const frozen = truck.frozen_trips ?? [];
    let at = Math.max(360, (req.config.loading_from_min ?? -1e9) + (req.config.reload_min ?? 30), ...frozen.map((f) => f.return_min + 90));
    const byId = new Map(req.stops.map((s) => [s.stop_id, s]));
    const out: PlannedLoad[] = [];
    loads.forEach((ids, i) => {
      const l = timed(req, truckId, frozen.length + i + 1, at, ids.map((id) => byId.get(id)!));
      out.push(l);
      at = l.return_min + 90;
    });
    const finish = req.config.window_rule === 'FINISH';
    const pct = Math.round(((relax?.capacity_factor ?? 1.2) - 1) * 100);
    const violations: V[] = [];
    const late: string[] = [];
    for (const l of out) {
      const cases = l.cases;
      if (cases > truck.capacity_cases) {
        const within = cases <= Math.floor((truck.capacity_cases * (100 + pct)) / 100);
        violations.push({
          code: 'CAPACITY_CASES', truck_id: truckId, load_no: l.load_no, stop_id: null, message: `${truck.code} load ${l.load_no} needs ${cases} cases; the truck takes ${truck.capacity_cases}.`, short_by_min: cases - truck.capacity_cases,
          ...(fake.v1 ? {} : { value: fake.lie2 ? cases - 1 : cases, limit: truck.capacity_cases, capacity: truck.capacity_cases }),
          ...(relax && !fake.v1 ? { overridable: !!relax.capacity_factor && (within || fake.lie) } : {}),
        });
      }
      for (const s of l.stops) {
        const st = byId.get(s.stop_id)!;
        if (st.hard_end_min === null || st.hard_end_min === undefined) continue;
        const atMin = finish ? s.departure_min : s.service_start_min;
        if (atMin <= st.hard_end_min) continue;
        late.push(s.stop_id);
        violations.push({
          code: 'HARD_WINDOW', truck_id: truckId, load_no: l.load_no, stop_id: s.stop_id, message: `${s.stop_id} starts at ${hhmm(atMin)}, after ${hhmm(st.hard_end_min)}.`, short_by_min: atMin - st.hard_end_min,
          ...(fake.v1 ? {} : { value: atMin, limit: st.hard_end_min, late_s: (atMin - st.hard_end_min) * 60 }),
          ...(relax && !fake.v1 ? { overridable: !!relax.late } : {}),
        });
      }
      if (fake.blockTrucks.has(truckId) && l.stops.length) {
        violations.push({ code: 'TRUCK_NOT_ALLOWED', truck_id: truckId, load_no: l.load_no, stop_id: l.stops[0]!.stop_id, message: `${truck.code} is not a small truck.`, ...(relax && !fake.v1 ? { overridable: false } : {}) });
      }
    }
    const money = out.reduce((a, l) => a + l.total_cost, 0);
    return { loads: out, violations, late, feasible: violations.length === 0, money, km: out.reduce((a, l) => a + l.distance_km, 0), last: out.at(-1)?.return_min ?? null, first: out[0]?.depart_min ?? null };
  }
  function scenario(loads: PlannedLoad[], status: 'VERIFIED' | 'VIOLATED', violations: V[], allowed: V[] = []): DispatchScenario {
    return {
      name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'RETIMED', solver_time_sec: 0, time_limit_sec: 0, objective_value: 1,
      objective: { unserved_penalty: 0, fixed_cost: 0, distance_cost: 0, fuel_cost: 0, time_cost: 0, overtime_cost: 0, window_penalty: 0, margin_served: null },
      trucks_used: new Set(loads.map((l) => l.truck_id)).size, trips: loads.length, total_distance_km: loads.reduce((a, l) => a + l.distance_km, 0),
      total_duration_min: loads.reduce((a, l) => a + l.duration_min, 0), total_cases: loads.reduce((a, l) => a + l.cases, 0), total_kg: 0, avg_utilization_pct: 10,
      fuel_litres: 0, fuel_cost: 0, operating_cost: loads.reduce((a, l) => a + l.total_cost, 0), loads, unserved: [], warnings: [],
      truck_days: [...new Set(loads.map((l) => l.truck_id))].map((t) => ({ truck_id: t, loads: loads.filter((l) => l.truck_id === t).length, frozen_loads: 0, day_start_min: 360, paid_from_min: 360, last_return_min: 600, paid_min: 240, overtime_min: 0, fixed_cost: 2, trip_cost: 0, distance_cost: 1, fuel_cost: 0.5, driver_cost: 1, overtime_cost: 0, total_cost: 5 })),
      feasibility: { status, timing: 'EXACT', violations, ...(allowed.length ? { allowed } : {}) },
    } as unknown as DispatchScenario;
  }
  type Day = { truck_id: string; loads: string[][] };
  /** The trucks of `days` timed; `before` with the allowances it carries (before_relax). */
  function outs(req: DispatchRequest, days: Day[], body: RetimeRequest, relaxed: boolean) {
    const rel = body.before_relax;
    const before = new Map(
      (body.before ?? []).map((d) => {
        const t = truckDay(req, d.truck_id, d.loads, body.relax ?? undefined);
        const covered = (v: V) =>
          (v.code === 'HARD_WINDOW' && !!v.stop_id && (rel?.late_stop_ids ?? []).includes(v.stop_id)) || (v.code === 'CAPACITY_CASES' && (rel?.over_capacity_truck_ids ?? []).includes(d.truck_id) && v.overridable !== false);
        const left = t.violations.filter((v) => !covered(v));
        return [d.truck_id, { ...t, feasible: left.length === 0, violations: left, allowed: t.violations.filter(covered) }];
      }),
    );
    return days.map((d) => {
      const t = truckDay(req, d.truck_id, d.loads, body.relax ?? undefined);
      const allowed = relaxed ? t.violations.filter((v) => v.overridable === true) : [];
      const violations = relaxed ? t.violations.filter((v) => v.overridable !== true) : t.violations;
      const feasible = violations.length === 0;
      const bt = before.get(d.truck_id);
      const out: RetimeTruckOut = {
        truck_id: d.truck_id, feasible, violations, loads: t.loads.length, money_omr: feasible ? t.money : null, soft_omr: 0, km: t.km, first_depart_min: t.first, last_return_min: t.last, break_start_min: null,
        before: bt ? { feasible: bt.feasible, violations: bt.violations, loads: bt.loads.length, money_omr: bt.feasible ? bt.money : null, soft_omr: 0, km: bt.km, first_depart_min: bt.first, last_return_min: bt.last, ...(bt.allowed.length ? { allowed: bt.allowed } : {}) } : null,
        delta_money_omr: bt?.feasible && feasible ? t.money - bt.money : null, delta_soft_omr: 0, delta_km: bt ? t.km - bt.km : null, delta_last_return_min: bt && t.last !== null && bt.last !== null ? t.last - bt.last : null,
        ...(allowed.length ? { allowed } : {}),
      };
      return { out, t };
    });
  }
  /** The places a best stop list can take (the v1 single stop at every position; v2 several / a whole load). */
  function places(req: DispatchRequest, days: Day[], body: RetimeRequest) {
    const b = body.best!;
    const stops = [b.stop_id, ...(b.more_stop_ids ?? [])];
    const base = days.find((d) => d.truck_id === b.truck_id)!.loads;
    const out: { loads: string[][]; load_index: number | null; new_load_at: number | null; position: number }[] = [];
    if (b.load_index !== null && b.load_index !== undefined) {
      if (stops.length > 1) out.push({ loads: base.map((l, i) => (i === b.load_index ? [...l, ...stops] : l)), load_index: b.load_index, new_load_at: null, position: base[b.load_index]!.length });
      else for (let p = 0; p <= base[b.load_index]!.length; p++) out.push({ loads: base.map((l, i) => (i === b.load_index ? [...l.slice(0, p), b.stop_id, ...l.slice(p)] : l)), load_index: b.load_index, new_load_at: null, position: p });
    } else {
      const ats = typeof b.new_load_at === 'number' ? [b.new_load_at] : [...Array(base.length + 1).keys()];
      for (const at of ats) out.push({ loads: [...base.slice(0, at), stops, ...base.slice(at)], load_index: null, new_load_at: at, position: 0 });
    }
    return out;
  }
  function answerFor(body: RetimeRequest): RetimeResponse {
    const req = body.request;
    let days: Day[] = body.truck_days.map((d) => ({ truck_id: d.truck_id, loads: d.loads }));
    let options: NonNullable<RetimeResponse['options']> = [];
    let relaxedDays: Day[] | null = null;
    if (body.best) {
      const b = body.best;
      const ranked = places(req, days, body)
        .map((pl) => ({ pl, t: truckDay(req, b.truck_id, pl.loads, body.relax ?? undefined) }))
        .map((x) => ({ ...x, cost: x.t.money - x.pl.position * 0.1 - (x.pl.new_load_at ?? 0) * 0.1, late: x.t.violations.filter((v) => v.code === 'HARD_WINDOW').reduce((a, v) => a + (v.short_by_min ?? 0), 0), over: x.t.violations.filter((v) => v.code.startsWith('CAPACITY')).length }));
      const ok = ranked.filter((x) => x.t.feasible).sort((a, c) => a.cost - c.cost);
      options = ok.slice(0, 3).map((x) => ({ truck_id: b.truck_id, load_index: x.pl.load_index, new_load_at: x.pl.new_load_at, position: x.pl.position, loads: x.pl.loads, money_omr: x.t.money, soft_omr: 0, km: x.t.km, last_return_min: x.t.last ?? 0 }));
      if (options[0]) days = days.map((d) => (d.truck_id === b.truck_id ? { truck_id: d.truck_id, loads: options[0]!.loads } : d));
      else {
        // No place keeps every rule: the strict fallback is the first place; the relaxed best the least to allow.
        days = days.map((d) => (d.truck_id === b.truck_id ? { truck_id: d.truck_id, loads: ranked[0]!.pl.loads } : d));
        if (body.relax && !fake.v1) {
          const pick = [...ranked].sort((a, c) => a.over - c.over || a.late - c.late || a.cost - c.cost)[0]!;
          relaxedDays = days.map((d) => (d.truck_id === b.truck_id ? { truck_id: d.truck_id, loads: pick.pl.loads } : d));
        }
      }
    }
    const strict = outs(req, days, body, false);
    const ok = strict.every((x) => x.out.feasible) && (!body.best || options.length > 0);
    // The relaxed answer: built only when every strict finding can be allowed (explicit), or for a best with no place.
    if (!relaxedDays && body.relax && !fake.v1 && !ok && strict.flatMap((x) => x.out.violations).every((v) => v.overridable === true)) relaxedDays = days;
    let relaxed: RetimeResponse['relaxed'] = null;
    if (relaxedDays) {
      const st = outs(req, relaxedDays, body, false);
      const rx = outs(req, relaxedDays, body, true);
      const rok = rx.every((x) => x.out.feasible);
      const allowed = rx.flatMap((x) => x.out.allowed ?? []);
      relaxed = {
        ok: rok,
        relaxations: {
          late_stop_ids: [...new Set(allowed.filter((v) => v.code === 'HARD_WINDOW').map((v) => v.stop_id!))].sort(),
          over_capacity_truck_ids: [...new Set(allowed.filter((v) => v.code.startsWith('CAPACITY')).map((v) => v.truck_id!))].sort(),
          capacity_factor: body.relax?.capacity_factor ?? null,
          no_break_truck_ids: [],
        },
        loads: relaxedDays,
        strict: st.map((x) => x.out),
        trucks: rx.map((x) => x.out),
        scenario: rok ? scenario(rx.flatMap((x) => x.t.loads), 'VERIFIED', [], allowed) : null,
        delta_money_omr: rx.every((x) => typeof x.out.delta_money_omr === 'number') ? rx.reduce((a, x) => a + (x.out.delta_money_omr ?? 0), 0) : null,
        delta_soft_omr: 0,
        delta_km: rx.reduce((a, x) => a + (x.out.delta_km ?? 0), 0),
        break_alternative: [],
        warnings: [],
      };
    }
    const trucks = strict.map((x) => x.out);
    return {
      ok, matrix_provider: 'HAVERSINE', distance_quality: 'ESTIMATED', distance_is_estimated: true,
      scenario: scenario(strict.flatMap((x) => x.t.loads), ok ? 'VERIFIED' : 'VIOLATED', trucks.flatMap((t) => t.violations)), trucks, options, best_total: options.length, best_tried: options.length,
      delta_money_omr: trucks.every((t) => typeof t.delta_money_omr === 'number') ? trucks.reduce((a, t) => a + (t.delta_money_omr ?? 0), 0) : null,
      delta_soft_omr: 0, delta_km: trucks.reduce((a, t) => a + (t.delta_km ?? 0), 0), timings: 1, seconds: 0, warnings: [],
      ...(fake.v1 ? {} : { retime_version: 2, loads: days, relaxed }),
    };
  }
  return {
    SolverError,
    /** The first optimization: the stops by latitude (a customer with several orders last), in turn on T01, T02, T03; the sixth left out. */
    callDispatchSolver: vi.fn(async (req: DispatchRequest): Promise<DispatchResponse> => {
      const stops = [...req.stops].sort((a, b) => Number(a.order_ids.length > 1) - Number(b.order_ids.length > 1) || a.lat - b.lat);
      const trucks = [...req.trucks].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
      const plan = trucks.map((_, i) => stops.slice(0, 5).filter((__, k) => k % trucks.length === i));
      const loads = plan.map((ss, i) => timed(req, trucks[i]!.id, 1, 360, ss)).filter((l) => l.stops.length);
      const unserved = stops.slice(5).map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' as const, reason_message: 'Fleet capacity shortage' }));
      const sc = { ...scenario(loads, 'VERIFIED', []), solver_status: 'ROUTING_SUCCESS', unserved };
      return { run_id: req.run_id, engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, scenarios: [sc], warnings: [] } as DispatchResponse;
    }),
    callRouteGeometry: vi.fn(async () => ({ kind: 'not_configured' })),
    callRetimeTruckDays: vi.fn(async (body: RetimeRequest) => {
      fake.calls.push(body);
      if (fake.reply) {
        const r = fake.reply;
        fake.reply = null;
        return r;
      }
      const answer = answerFor(body);
      if (fake.afterRetime) {
        const hook = fake.afterRetime;
        fake.afterRetime = null;
        await hook();
      }
      return { kind: 'answer', body: answer };
    }),
  };
});

/* eslint-disable @typescript-eslint/consistent-type-imports */
let planService: typeof import('@/lib/dispatch/plan-service');
let start: typeof import('@/lib/dispatch/start-optimize');
let edit: typeof import('@/lib/dispatch/plan-edit');
let apply: typeof import('@/lib/dispatch/plan-edit-apply');
let view: typeof import('@/lib/dispatch/plan-edit-view');
let detail: typeof import('@/lib/dispatch/plan-detail');
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
  view = await import('@/lib/dispatch/plan-edit-view');
  detail = await import('@/lib/dispatch/plan-detail');
  checkRoute = await import('@/app/api/runs/[id]/edit/check/route');
  saveRoute = await import('@/app/api/runs/[id]/edit/route');
});

beforeEach(() => {
  fake.v1 = false;
  fake.lie = false;
  fake.lie2 = false;
  fake.blockTrucks = new Set();
  fake.afterRetime = null;
  fake.reply = null;
  fake.calls = [];
  process.env.PLAN_EDIT = 'on';
  delete process.env.PLAN_EDIT_OVERRIDES;
  delete process.env.FEASIBILITY_GATE;
});

afterAll(async () => {
  delete process.env.PLAN_EDIT;
  delete process.env.PLAN_EDIT_OVERRIDES;
  for (const p of g.__routeiqInflight?.values() ?? []) await p.catch(() => undefined);
  for (const s of slugs) await cleanupTenant(s);
  await prisma.$disconnect();
});

type U = { id: string; tenantId: string | null; role: string; name: string; email: string };
let seq = 0;

function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function mkUser(tenantId: string, role: 'TENANT_ADMIN' | 'SUPERVISOR' | 'PLANNER' | 'VIEWER', label: string): Promise<U> {
  return prisma.user.create({
    data: { tenantId, role, name: label, email: `${label}-${Date.now().toString(36)}-${seq++}@plan-edit-more.test`.toLowerCase(), passwordHash: 'x' },
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

const CODES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] as const;

/**
 * A planned day: T01 C1, C4; T02 C2, C5; T03 C3; C6 unserved (the fake plans by latitude). `cases` per customer
 * (default 10 + i), `twoOrdersC6`: C6 has two orders (one unserved visit). The receiving-hours rule is START.
 */
async function plannedDay(label: string, opts: { cases?: number[]; twoOrdersC6?: boolean } = {}) {
  const slug = `pem-${label}-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
  slugs.push(slug);
  const t = await prisma.tenant.create({ data: { slug, name: `PEM ${label}`, country: 'Oman' } });
  await prisma.tenantConfig.create({ data: { tenantId: t.id, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null, windowRule: 'START' } });
  const admin = await mkUser(t.id, 'TENANT_ADMIN', `${label}-admin`);
  const supervisor = await mkUser(t.id, 'SUPERVISOR', `${label}-supervisor`);
  const planner = await mkUser(t.id, 'PLANNER', `${label}-planner`);
  const depot = await prisma.depot.create({ data: { tenantId: t.id, code: 'D1', name: 'Depot', lat: 23.4, lng: 58.3 } });
  const trucks: Record<string, string> = {};
  for (const code of ['T01', 'T02', 'T03']) {
    trucks[code] = (await prisma.truck.create({ data: { tenantId: t.id, depotId: depot.id, code, capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1 } })).id;
  }
  const product = await prisma.product.create({ data: { tenantId: t.id, code: 'P-1', name: 'Product One', weightPerCaseKg: 10 } });
  const day = isoPlus(2);
  const customers: Record<string, string> = {};
  const orderOf: Record<string, string[]> = {};
  for (const [i, code] of CODES.entries()) {
    const c = await prisma.customer.create({ data: { tenantId: t.id, code, name: `Customer ${code}`, branchKey: '__MAIN__', lat: 23.5 + i * 0.01, lng: 58.4, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
    customers[code] = c.id;
    const n = code === 'C6' && opts.twoOrdersC6 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const cases = opts.cases?.[i] ?? 10 + i;
      const o = await prisma.order.create({
        data: {
          tenantId: t.id, customerId: c.id, depotId: depot.id, deliveryDate: new Date(`${day}T00:00:00.000Z`), totalCases: cases, totalWeightKg: cases * 10, status: 'VALIDATED', priority: 3,
          lines: { create: [{ productId: product.id, cases, weightKg: cases * 10, salesOrderNo: `SO-${i}-${k}` }] },
        },
      });
      orderOf[code] = [...(orderOf[code] ?? []), o.id];
    }
  }
  const { run } = await planService.getOrCreatePlan(t.id, depot.id, day, admin.id);
  expect((await start.startDispatchOptimize(t.id, run.id, { id: admin.id }, null)).status).toBe(202);
  expect((await jobsDone(run.id)).status).toBe('READY');
  return { tenantId: t.id, admin, supervisor, planner, depotId: depot.id, day, runId: run.id, trucks, customers, orderOf };
}
type Day = Awaited<ReturnType<typeof plannedDay>>;

const loadsOf = (runId: string) => prisma.planLoad.findMany({ where: { runId }, include: { assignments: { orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }] } }, orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }] });
async function loadOf(f: Day, code: string, loadNo = 1, runId = f.runId) {
  return prisma.planLoad.findFirstOrThrow({ where: { runId, truckId: f.trucks[code]!, loadNo }, include: { assignments: { orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }] } } });
}
/** The customer codes of a load's stops, in order. */
async function codesOf(f: Day, code: string, loadNo = 1, runId = f.runId) {
  const l = await loadOf(f, code, loadNo, runId);
  const byId = Object.fromEntries(Object.entries(f.customers).map(([k, v]) => [v, k]));
  const orders = await prisma.order.findMany({ where: { id: { in: l.assignments.map((a) => a.orderId) } }, select: { id: true, customerId: true } });
  const cust = new Map(orders.map((o) => [o.id, byId[o.customerId]!]));
  return [...new Set(l.assignments.map((a) => cust.get(a.orderId)!))];
}
const expectOf = (f: Day) => ({ date: f.day, depotId: f.depotId });
type Ops = NonNullable<Parameters<typeof edit.checkPlanEdit>[2]['ops']>;
const check = (f: Day, ops: Ops, o: { runId?: string; canOverride?: boolean; skipBreak?: string[] } = {}) =>
  edit.checkPlanEdit(f.tenantId, o.runId ?? f.runId, { ops, expect: expectOf(f), canOverride: o.canOverride ?? true, skipBreak: o.skipBreak });
const who = (u: U) => ({ id: u.id, name: u.name, role: u.role });
/** A save of the check's own list: strict (no overrides) or with overrides (the overrides hash). */
function save(f: Day, c: Awaited<ReturnType<typeof check>>, u: U, overrides?: { id: string; reason: string }[], runId = f.runId) {
  return apply.savePlanEdit(
    f.tenantId,
    runId,
    { ops: c.preview.ops, expect: expectOf(f), skipBreak: c.preview.overrides?.skipBreak, previewHash: overrides ? (c.preview.overrides?.previewHash || '0'.repeat(64)) : c.preview.previewHash, builtAt: c.preview.builtAt, ...(overrides ? { overrides } : {}) },
    who(u),
    null,
  );
}
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
const allowancesOf = async (loadId: string) => view && (await import('@/lib/dispatch/snapshots')).readHandAllowances((await prisma.planLoad.findUniqueOrThrow({ where: { id: loadId } })).truckSnapshotJson);
/** Receiving hours of a customer from now on (today's data: the check re-times with them). */
const hours = (f: Day, code: string, start: number, end: number) => prisma.customer.update({ where: { id: f.customers[code]! }, data: { hardWindowStartMin: start, hardWindowEndMin: end } });
const status = (f: Day, runId: string, loadId: string, s: 'LOCKED' | 'LOADING' | 'DISPATCHED' | 'PLANNED') =>
  planService.updateLoad(f.tenantId, runId, loadId, { status: s }, { id: f.admin.id, role: 'TENANT_ADMIN' }, () => true);

// ---------------------------------------------------------------------------------------------

describe('whole loads: swap and move (owner item 1)', () => {
  it('D-1 swaps two loads of two trucks: each keeps its stop order on its new truck; drivers stay with their trucks; one version, reprint both', async () => {
    const f = await plannedDay('swap');
    const a = await loadOf(f, 'T01');
    const b = await loadOf(f, 'T02');
    const driver = await prisma.driver.create({ data: { tenantId: f.tenantId, code: 'DR1', name: 'Driver One' } });
    await prisma.planLoad.update({ where: { id: a.id }, data: { driverId: driver.id, driverSetById: f.planner.id, driverSetAt: new Date() } });
    const parentT03 = await loadOf(f, 'T03');
    const c = await check(f, [{ kind: 'SWAP_LOADS', a: a.id, b: b.id }]);
    expect(c.preview).toMatchObject({ ok: true, canSave: true, draftable: true, title: 'Swap T01 L1 and T02 L1' });
    expect(c.preview.move).toBeUndefined();
    expect(c.preview.trucks.map((t) => t.truckCode)).toEqual(['T01', 'T02']);
    const saved = await save(f, c, f.planner);
    expect(saved).toMatchObject({ version: 2, reprint: ['T01 L1', 'T02 L1'], gone: [] });
    expect(await codesOf(f, 'T01', 1, saved.runId)).toEqual(['C2', 'C5']);
    expect(await codesOf(f, 'T02', 1, saved.runId)).toEqual(['C1', 'C4']);
    // The driver stays with T01 (its truck), not with the load.
    expect((await loadOf(f, 'T01', 1, saved.runId)).driverId).toBe(driver.id);
    const t03 = await loadOf(f, 'T03', 1, saved.runId);
    expect(t03.assignments.map((x) => x.orderId)).toEqual(parentT03.assignments.map((x) => x.orderId));
    const child = await prisma.runPlan.findUniqueOrThrow({ where: { id: saved.runId } });
    expect((child.reconciliationJson as { ok: boolean }).ok).toBe(true);
    const feas = child.feasibilityJson as { trucks: Record<string, { ok: boolean }> };
    expect(feas.trucks[f.trucks.T01!]?.ok).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: f.tenantId, entityId: child.id, action: 'ROUTE_MANUALLY_CHANGED' } });
    expect((audit.afterJson as { ops: unknown[] }).ops).toEqual([{ kind: 'SWAP_LOADS', a: a.id, b: b.id }]);
    expect((audit.afterJson as { move?: unknown }).move).toBeUndefined();
  });

  it('D-2 moves a whole load before another truck\'s L1: its loads renumber, the source has no load left (gone)', async () => {
    const f = await plannedDay('moveload');
    const a = await loadOf(f, 'T01');
    const b = await loadOf(f, 'T02');
    const c = await check(f, [{ kind: 'MOVE_LOAD', loadId: a.id, to: { truckId: f.trucks.T02!, before: b.id } }]);
    expect(c.preview.ok).toBe(true);
    expect(c.preview.title).toBe('Move T01 L1 to T02, before L1');
    const saved = await save(f, c, f.planner);
    expect(saved).toMatchObject({ reprint: ['T02 L1', 'T02 L2'], gone: ['T01 L1'] });
    expect(await codesOf(f, 'T02', 1, saved.runId)).toEqual(['C1', 'C4']);
    expect(await codesOf(f, 'T02', 2, saved.runId)).toEqual(['C2', 'C5']);
    expect(await prisma.planLoad.count({ where: { runId: saved.runId, truckId: f.trucks.T01! } })).toBe(0);
  });

  it('D-17 a swap and a load move next to a LOCKED L1: L1 stays as it is, the new loads number after it; naming L1 is LOAD_FROZEN', async () => {
    const f = await plannedDay('lockedl1');
    // Give T01 a second load (C6 put on as a new load), then lock T01 L1.
    const c6 = f.orderOf.C6![0]!;
    const put = await check(f, [{ kind: 'PLACE', orderId: c6, to: { truckId: f.trucks.T01!, loadId: null, before: null } }]);
    const v2 = await save(f, put, f.planner);
    const l1 = await loadOf(f, 'T01', 1, v2.runId);
    const l2 = await loadOf(f, 'T01', 2, v2.runId);
    await status(f, v2.runId, l1.id, 'LOCKED');
    const before = await prisma.planLoad.findUniqueOrThrow({ where: { id: l1.id }, include: { assignments: true } });
    const t02 = await loadOf(f, 'T02', 1, v2.runId);
    expect((await refusal(check(f, [{ kind: 'SWAP_LOADS', a: l1.id, b: t02.id }], { runId: v2.runId }))).code).toBe('LOAD_FROZEN');
    expect((await refusal(check(f, [{ kind: 'MOVE_STOPS', stops: [{ loadId: t02.id, sequence: 1 }], to: { truckId: f.trucks.T02!, loadId: t02.id, order: [{ loadId: l1.id, sequence: 1 }, { loadId: t02.id, sequence: 1 }] } }], { runId: v2.runId }))).code).toBe('LOAD_FROZEN');
    const c = await check(f, [{ kind: 'SWAP_LOADS', a: l2.id, b: t02.id }], { runId: v2.runId });
    expect(c.preview.ok).toBe(true);
    const v3 = await save(f, c, f.planner, undefined, v2.runId);
    const kept = (await loadsOf(v3.runId)).find((l) => l.truckId === f.trucks.T01! && l.loadNo === 1)!;
    expect([kept.status, kept.departMin, kept.returnMin, kept.assignments.length]).toEqual(['LOCKED', before.departMin, before.returnMin, before.assignments.length]);
    expect(kept.truckSnapshotJson).toEqual(before.truckSnapshotJson);
    expect(await codesOf(f, 'T01', 2, v3.runId)).toEqual(['C2', 'C5']);
    expect(await codesOf(f, 'T02', 1, v3.runId)).toEqual(['C6']);
    // A whole load moved onto T01 goes after its locked L1.
    const t03 = await loadOf(f, 'T03', 1, v3.runId);
    const moved = await check(f, [{ kind: 'MOVE_LOAD', loadId: t03.id, to: { truckId: f.trucks.T01!, before: null } }], { runId: v3.runId });
    const v4 = await save(f, moved, f.planner, undefined, v3.runId);
    expect(await codesOf(f, 'T01', 3, v4.runId)).toEqual(['C3']);
    expect((await loadOf(f, 'T01', 1, v4.runId)).status).toBe('LOCKED');
  });
});

describe('several stops at once (owner item 2)', () => {
  it('D-3 stops of two loads (one emptied) and an unserved customer with two orders to one load at the best place: resolved to an order, saved exactly', async () => {
    const f = await plannedDay('stops', { twoOrdersC6: true });
    const t01 = await loadOf(f, 'T01');
    const t02 = await loadOf(f, 'T02');
    const t03 = await loadOf(f, 'T03');
    const [o1, o2] = f.orderOf.C6!;
    const c = await check(f, [
      { kind: 'MOVE_STOPS', stops: [{ loadId: t02.id, sequence: 1 }, { loadId: t03.id, sequence: 1 }, { orderId: o1! }, { orderId: o2! }], to: { truckId: f.trucks.T01!, loadId: t01.id } },
    ]);
    expect(c.preview.ok).toBe(true);
    // Both orders of C6 are one stop: three stops placed, the list written out in the order found.
    const op = c.preview.ops[0]!;
    expect(op.kind).toBe('MOVE_STOPS');
    expect(op.kind === 'MOVE_STOPS' && op.to.order?.length).toBe(5);
    expect(c.preview.draftable).toBe(true);
    expect(fake.calls.at(-1)!.best).toMatchObject({ truck_id: f.trucks.T01, load_index: 0, more_stop_ids: expect.any(Array) });
    const saved = await save(f, c, f.planner);
    expect(await codesOf(f, 'T01', 1, saved.runId)).toEqual(['C1', 'C4', 'C2', 'C3', 'C6']);
    expect(saved.gone).toEqual(['T03 L1']);
    const child = await prisma.runPlan.findUniqueOrThrow({ where: { id: saved.runId } });
    expect(await prisma.unservedOrder.count({ where: { scenarioId: child.chosenScenarioId! } })).toBe(0);
    for (const id of [o1!, o2!]) expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('ASSIGNED');
    expect((child.reconciliationJson as { ok: boolean }).ok).toBe(true);
  });

  it('D-4 every stop of a load taken off in one go: the load is gone, REMOVED_BY_HAND rows, the orders UNSERVED', async () => {
    const f = await plannedDay('removeall');
    const t01 = await loadOf(f, 'T01');
    const c = await check(f, [{ kind: 'REMOVE_STOPS', stops: [{ loadId: t01.id, sequence: 1 }, { loadId: t01.id, sequence: 2 }] }]);
    expect(c.preview).toMatchObject({ ok: true, title: 'Take 2 stops off the plan' });
    const saved = await save(f, c, f.planner);
    expect(saved).toMatchObject({ reprint: [], gone: ['T01 L1'] });
    const child = await prisma.runPlan.findUniqueOrThrow({ where: { id: saved.runId } });
    const rows = await prisma.unservedOrder.findMany({ where: { scenarioId: child.chosenScenarioId!, reasonCode: 'REMOVED_BY_HAND' } });
    expect(rows.map((r) => r.orderId).sort()).toEqual([...f.orderOf.C1!, ...f.orderOf.C4!].sort());
    for (const id of [...f.orderOf.C1!, ...f.orderOf.C4!]) expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('UNSERVED');
    expect((child.reconciliationJson as { ok: boolean }).ok).toBe(true);
  });

  it('D-5 a list of two operations (a swap, then several stops as a new load at its best place) is one version and one audit row', async () => {
    const f = await plannedDay('list', { twoOrdersC6: true });
    const t01 = await loadOf(f, 'T01');
    const t02 = await loadOf(f, 'T02');
    const t03 = await loadOf(f, 'T03');
    const c = await check(f, [
      { kind: 'SWAP_LOADS', a: t01.id, b: t02.id },
      { kind: 'MOVE_STOPS', stops: [{ loadId: t03.id, sequence: 1 }, { orderId: f.orderOf.C6![0]! }], to: { truckId: f.trucks.T03!, loadId: null, before: 'BEST' } },
    ]);
    expect(c.preview.ok).toBe(true);
    expect(c.preview.ops[1]).toMatchObject({ kind: 'MOVE_STOPS', to: { truckId: f.trucks.T03, loadId: null, before: null } });
    expect(c.preview.title).toBe('Swap T01 L1 and T02 L1; Move 2 stops to T03, a new load after its last load');
    const saved = await save(f, c, f.planner);
    expect(saved.version).toBe(2);
    expect(await codesOf(f, 'T03', 1, saved.runId)).toEqual(['C3', 'C6']);
    expect(await prisma.auditLog.count({ where: { tenantId: f.tenantId, entityId: saved.runId, action: 'ROUTE_MANUALLY_CHANGED' } })).toBe(1);
  });

  it('D-24 (review F3) a load moved to another truck by step 1 is still named by step 2 (swapped, stops put in it), and saved as one version', async () => {
    const f = await plannedDay('movedlater');
    const t01 = await loadOf(f, 'T01');
    const t02 = await loadOf(f, 'T02');
    const t03 = await loadOf(f, 'T03');
    // Step 1: T01 L1 moved to T03 after its last load. Step 2: a stop of T02 into it, named as the plan screen names it.
    const c = await check(f, [
      { kind: 'MOVE_LOAD', loadId: t01.id, to: { truckId: f.trucks.T03!, before: null } },
      { kind: 'MOVE_STOPS', stops: [{ loadId: t02.id, sequence: 1 }], to: { truckId: f.trucks.T01!, loadId: t01.id, position: 0 } },
    ]);
    expect(c.preview.ok).toBe(true);
    expect(c.preview.title).toBe('Move T01 L1 to T03, after its last load; Move Customer C2 (C2) to T01 L1, stop 1');
    const saved = await save(f, c, f.planner);
    expect(await codesOf(f, 'T03', 1, saved.runId)).toEqual(['C3']);
    expect(await codesOf(f, 'T03', 2, saved.runId)).toEqual(['C2', 'C1', 'C4']);
    expect(await codesOf(f, 'T02', 1, saved.runId)).toEqual(['C5']);
    // Swapped after it was moved: found where it is now (never "no stop left").
    const t03b = await loadOf(f, 'T03', 1, saved.runId);
    const moved = await loadOf(f, 'T03', 2, saved.runId);
    const sw = await check(f, [{ kind: 'MOVE_LOAD', loadId: moved.id, to: { truckId: f.trucks.T01!, before: null } }, { kind: 'SWAP_LOADS', a: moved.id, b: t03b.id }], { runId: saved.runId });
    expect(sw.preview.ok).toBe(true);
    expect(sw.preview.trucks.map((t) => [t.truckCode, (t.after?.loads ?? []).map((l) => l.stops.map((x) => x.label.replace(/^Customer (C\d).*$/, '$1')))])).toEqual([
      ['T03', [['C2', 'C1', 'C4']]],
      ['T01', [['C3']]],
    ]);
    void t03;
  });

  it('D-19 stops exchanged between two full loads: step 1 alone is red but can be kept; the two steps check and save as one version', async () => {
    const f = await plannedDay('exchange');
    // T01 and T02 can take no more than their two stops each.
    await prisma.truck.updateMany({ where: { id: { in: [f.trucks.T01!, f.trucks.T02!] } }, data: { capacityCases: 25 } });
    const t01 = await loadOf(f, 'T01');
    const t02 = await loadOf(f, 'T02');
    const step1 = { kind: 'MOVE_STOPS' as const, stops: [{ loadId: t01.id, sequence: 1 }], to: { truckId: f.trucks.T02!, loadId: t02.id, position: 0 } };
    const one = await check(f, [step1]);
    expect(one.preview.ok).toBe(false);
    expect(one.preview.draftable).toBe(true);
    const step2 = { kind: 'MOVE_STOPS' as const, stops: [{ loadId: t02.id, sequence: 1 }], to: { truckId: f.trucks.T01!, loadId: t01.id, position: 1 } };
    const both = await check(f, [...one.preview.ops, step2]);
    expect(both.preview.ok).toBe(true);
    const saved = await save(f, both, f.planner);
    expect(saved.version).toBe(2);
    expect(await codesOf(f, 'T01', 1, saved.runId)).toEqual(['C4', 'C2']);
    expect(await codesOf(f, 'T02', 1, saved.runId)).toEqual(['C1', 'C5']);
  });
});

describe('allow anyway (owner item 3)', () => {
  /** C3 moved first on T01 L1: C4 then arrives 07:20, after its receiving hours 00:00-07:00 (20 min late). */
  async function lateDay(label: string) {
    const f = await plannedDay(label);
    await hours(f, 'C4', 0, 420);
    const t01 = await loadOf(f, 'T01');
    const t03 = await loadOf(f, 'T03');
    const ops: Ops = [{ kind: 'MOVE_STOPS', stops: [{ loadId: t03.id, sequence: 1 }], to: { truckId: f.trucks.T01!, loadId: t01.id, position: 0 } }];
    return { f, t01, t03, ops };
  }

  it('D-6 a late arrival allowed by a SUPERVISOR: kept with the load, a WARN in the gate, Lock / Loading / Dispatch pass, audited and printed', async () => {
    const { f, ops } = await lateDay('late');
    const c = await check(f, ops);
    expect(c.preview.ok).toBe(false);
    const issue = c.preview.issues.find((i) => i.code === 'HARD_WINDOW')!;
    expect(issue).toMatchObject({ kind: 'LATE', overridable: true, amount: { unit: 'min', value: 440, limit: 420, over: 20 } });
    expect(issue.text).toBe('Customer C4 (C4) on T01 L1 arrives 07:20, after its receiving hours 00:00–07:00: 20 min late');
    expect(c.preview.overrides).toMatchObject({ ok: true, canSave: true, saveNote: null });
    expect(c.preview.overrides!.needed.map((n) => n.id)).toEqual([issue.id]);
    expect(fake.calls.at(-1)!.relax).toEqual({ late: true, capacity_factor: 1.2, no_break: true, seed_no_break: [] });
    // A strict save is refused; with the allowance it saves.
    expect((await refusal(save(f, c, f.supervisor))).code).toBe('MOVE_REFUSED');
    const saved = await save(f, c, f.supervisor, [{ id: issue.id!, reason: 'agreed with customer' }]);
    expect(saved).toMatchObject({ version: 2, allowed: 1, carried: 0 });
    expect(view.savedText(saved)).toContain('1 rule allowed by hand: it is printed on the load sheet and the driver sheet.');
    const l1 = await loadOf(f, 'T01', 1, saved.runId);
    const [a] = (await allowancesOf(l1.id))!;
    expect(a).toMatchObject({ kind: 'LATE', id: issue.id, reason: 'agreed with customer', byName: f.supervisor.name, byRole: 'SUPERVISOR', rule: 'START', windowEndMin: 420, atMin: 440, lateMin: 20, maxLateMin: 20, runId: saved.runId, orderIds: f.orderOf.C4 });
    const child = await prisma.runPlan.findUniqueOrThrow({ where: { id: saved.runId } });
    const feas = child.feasibilityJson as { ok: boolean; violations: { code: string; severity: string; allowedByHand?: { id: string } }[] };
    expect(feas.ok).toBe(true);
    expect(feas.violations.find((v) => v.code === 'HARD_WINDOW')).toMatchObject({ severity: 'WARN', allowedByHand: { id: issue.id } });
    const audits = await prisma.auditLog.findMany({ where: { tenantId: f.tenantId, entityId: child.id }, select: { action: true, afterJson: true } });
    expect(audits.map((x) => x.action).sort()).toEqual(['PLAN_VERSION_CREATED', 'ROUTE_MANUALLY_CHANGED', 'RULE_ALLOWED_BY_HAND']);
    const rule = audits.find((x) => x.action === 'RULE_ALLOWED_BY_HAND')!.afterJson as { confirmed: number; carried: number; byRole: string; overrides: { kind: string; reason: string; lateMin: number }[] };
    expect(rule).toMatchObject({ confirmed: 1, carried: 0, keptOnly: false, byRole: 'SUPERVISOR', overrides: [{ kind: 'LATE', reason: 'agreed with customer', lateMin: 20 }] });
    expect(child.reasonNote).toMatch(/; 1 rule allowed by hand$/);
    // The plan detail says so, and the stop carries the allowance.
    const d = (await detail.getPlanDetail(f.tenantId, saved.runId))!;
    const stop = d.loads.find((l) => l.id === l1.id)!.stops.find((s) => s.customerCode === 'C4')!;
    expect(stop.handAllowed?.reason).toBe('agreed with customer');
    expect(d.allowedByHand?.map((x) => x.text)).toEqual(['Allowed by hand: arrives 07:20, after receiving hours 00:00–07:00 (20 min late) - agreed with customer']);
    expect(d.warnings).toContain('Rules allowed by hand on this plan: T01 L1 (receiving hours).');
    expect(d.manual).toMatchObject({ count: 1, allowed: 1 });
    // The driver sheet and the WhatsApp text say so too (never "outside receiving hours").
    const { driverPackModel } = await import('@/lib/dispatch/driver-pack');
    const sheet = driverPackModel(d, { tenantName: 'T', loadIds: [l1.id] }).sheets[0]!;
    expect(sheet.stops.find((s) => s.customerCode === 'C4')).toMatchObject({ outsideHours: false, allowedByHand: expect.stringContaining('Allowed by hand: arrives 07:20') });
    const { whatsappText } = await import('@/lib/dispatch/driver-links');
    expect(whatsappText(d.run, d.loads.find((x) => x.id === l1.id)!, 1)).toContain('! Allowed by hand: arrives 07:20');
    // Lock, Loading and Dispatch pass the timing gate.
    await withDriver(f.tenantId, [l1.id]);
    for (const s of ['LOCKED', 'LOADING', 'DISPATCHED'] as const) await status(f, saved.runId, l1.id, s);
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: l1.id } })).status).toBe('DISPATCHED');
    expect((await allowancesOf(l1.id))!.length).toBe(1);
  });

  it('D-7 capacity at 115 % saved by a TENANT_ADMIN; a PLANNER with new overrides is refused (403) and nothing is written', async () => {
    const f = await plannedDay('cap');
    await prisma.truck.update({ where: { id: f.trucks.T02! }, data: { capacityCases: 30 } });
    const t01 = await loadOf(f, 'T01');
    const t02 = await loadOf(f, 'T02');
    const ops: Ops = [{ kind: 'MOVE', from: { loadId: t01.id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: t02.id, position: 0 } }];
    const asPlanner = await check(f, ops, { canOverride: false });
    const issue = asPlanner.preview.overrides!.needed[0]!;
    expect(issue).toMatchObject({ kind: 'CAPACITY_CASES', overridable: true, amount: { unit: 'cases', value: 35, limit: 30, capacity: 30, overPct: 17 } });
    expect(asPlanner.preview.overrides).toMatchObject({ ok: true, canSave: false, saveNote: 'Only a supervisor or company admin can allow rules by hand: ask one to make this change (it is not saved).' });
    // The v1 single move keeps its v1 shape for an old browser tab.
    expect(asPlanner.preview.move).toEqual(ops[0]);
    const refused = await refusal(save(f, asPlanner, f.planner, [{ id: issue.id!, reason: 'one day only' }]));
    expect(refused).toMatchObject({ status: 403, code: 'OVERRIDE_ROLE' });
    // A PLANNER sending nothing to confirm while something needs approval: 403 too.
    expect((await refusal(save(f, asPlanner, f.planner, []))).code).toBe('OVERRIDE_ROLE');
    expect(await versions(f)).toBe(1);
    const c = await check(f, ops);
    const saved = await save(f, c, f.admin, [{ id: issue.id!, reason: 'one day only' }]);
    const l = await loadOf(f, 'T02', 1, saved.runId);
    expect((await allowancesOf(l.id))![0]).toMatchObject({ kind: 'CAPACITY_CASES', value: 35, maxValue: 35, capacity: 30, overPct: 17, byRole: 'TENANT_ADMIN' });
    const child = await prisma.runPlan.findUniqueOrThrow({ where: { id: saved.runId } });
    expect((child.feasibilityJson as { ok: boolean }).ok).toBe(true);
    // D-15: Lock passes the timing gate for a capacity allowance.
    await status(f, saved.runId, l.id, 'LOCKED');
  });

  it('D-8 the confirmations are checked: a missing or extra id, a short reason, the switch off, checking only, a change that keeps every rule', async () => {
    const { f, ops } = await lateDay('confirm');
    const c = await check(f, ops);
    const id = c.preview.overrides!.needed[0]!.id!;
    expect((await refusal(save(f, c, f.supervisor, [{ id, reason: 'agreed' }, { id: 'ovr_0123456789abcdef', reason: 'extra' }]))).code).toBe('OVERRIDES_CHANGED');
    expect((await refusal(save(f, c, f.supervisor, [{ id: 'ovr_0123456789abcdef', reason: 'other' }]))).code).toBe('OVERRIDES_CHANGED');
    expect((await refusal(save(f, c, f.supervisor, [{ id, reason: '  \u0007 ' }]))).status).toBe(422);
    // The schema refuses an empty reason before anything is checked.
    const { planEditSaveSchema } = await import('@/lib/schemas');
    expect(planEditSaveSchema.safeParse({ ops, previewHash: 'a'.repeat(64), builtAt: c.preview.builtAt, overrides: [{ id, reason: '' }] }).success).toBe(false);
    process.env.PLAN_EDIT_OVERRIDES = 'off';
    const off = await check(f, ops);
    expect(off.preview.overrides).toBeNull();
    expect(fake.calls.at(-1)!.relax).toBeUndefined();
    expect((await refusal(save(f, c, f.supervisor, [{ id, reason: 'agreed' }]))).code).toBe('OVERRIDES_OFF');
    delete process.env.PLAN_EDIT_OVERRIDES;
    // A change that keeps every rule, sent with overrides.
    await hours(f, 'C4', 0, 1000);
    const fine = await check(f, ops);
    expect(fine.preview.ok).toBe(true);
    expect((await refusal(apply.savePlanEdit(f.tenantId, f.runId, { ops: fine.preview.ops, expect: expectOf(f), previewHash: fine.preview.previewHash, builtAt: fine.preview.builtAt, overrides: [] }, who(f.supervisor), null))).code).toBe('OVERRIDES_CHANGED');
    expect(await versions(f)).toBe(1);
    // Checking only (through the route): Check shows the panel, Save is CHECK_ONLY with overrides too.
    await hours(f, 'C4', 0, 420);
    process.env.PLAN_EDIT = 'check';
    const session = { user: { id: f.supervisor.id, tenantId: f.supervisor.tenantId, role: f.supervisor.role, name: f.supervisor.name, email: f.supervisor.email } };
    const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    m.auth.mockResolvedValueOnce(session);
    const checked = await checkRoute.POST(post(`/api/runs/${f.runId}/edit/check`, { ops, expect: expectOf(f) }), { params: { id: f.runId } });
    const p = ((await checked.json()) as { data: { overrides: { canSave: boolean; saveNote: string; previewHash: string; needed: { id: string }[] } } }).data;
    expect(p.overrides).toMatchObject({ canSave: false, saveNote: view.EDIT_ERROR_TEXT.CHECK_ONLY });
    m.auth.mockResolvedValueOnce(session);
    const r = await saveRoute.POST(post(`/api/runs/${f.runId}/edit`, { ops, expect: expectOf(f), previewHash: p.overrides.previewHash, builtAt: c.preview.builtAt, overrides: [{ id, reason: 'agreed' }] }), { params: { id: f.runId } });
    expect([r.status, ((await r.json()) as { error: { code: string } }).error.code]).toEqual([409, 'CHECK_ONLY']);
  });

  it('D-9 a solver that allows 125 %, or understates a load against the web\'s figures: OVERRIDE_NOT_ALLOWED, nothing written', async () => {
    const f = await plannedDay('lie');
    await prisma.truck.update({ where: { id: f.trucks.T02! }, data: { capacityCases: 28 } });
    const t01 = await loadOf(f, 'T01');
    const t02 = await loadOf(f, 'T02');
    const ops: Ops = [{ kind: 'MOVE', from: { loadId: t01.id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: t02.id, position: 0 } }];
    fake.lie = true;
    const c = await check(f, ops);
    const n = c.preview.overrides!.needed[0]!;
    expect(n).toMatchObject({ kind: 'CAPACITY_CASES', overridable: false, whyNot: '25% over the truck\'s 28 cases: at most 33 cases (20% over) can be allowed by hand on this truck.' });
    expect(c.preview.overrides!.canSave).toBe(false);
    expect((await refusal(save(f, c, f.supervisor, [{ id: n.id!, reason: 'one day only' }]))).code).toBe('OVERRIDE_NOT_ALLOWED');
    fake.lie = false;
    fake.lie2 = true;
    await prisma.truck.update({ where: { id: f.trucks.T02! }, data: { capacityCases: 30 } });
    const c2 = await check(f, ops);
    const n2 = c2.preview.overrides!.needed[0]!;
    expect(n2.whyNot).toBe("The optimizer's figures for this load do not match the plan's (34 / 35 cases): re-plan the day.");
    expect((await refusal(save(f, c2, f.supervisor, [{ id: n2.id!, reason: 'one day only' }]))).code).toBe('OVERRIDE_NOT_ALLOWED');
    expect(await versions(f)).toBe(1);
  });

  it('D-10 a rule that cannot be allowed remains (small truck only): MOVE_REFUSED even for a company admin', async () => {
    const { f, ops } = await lateDay('noway');
    fake.blockTrucks = new Set([f.trucks.T01!]);
    const c = await check(f, ops);
    expect(c.preview.issues.find((i) => i.code === 'TRUCK_NOT_ALLOWED')).toMatchObject({ overridable: false, whyNot: 'Small-truck-only customers cannot be allowed by hand.' });
    expect(c.preview.overrides).toMatchObject({ ok: false, previewHash: '' });
    expect((await refusal(apply.savePlanEdit(f.tenantId, f.runId, { ops: c.preview.ops, expect: expectOf(f), previewHash: c.preview.previewHash, builtAt: c.preview.builtAt, overrides: [] }, who(f.admin), null))).code).toBe('MOVE_REFUSED');
  });

  it('D-18 the owner\'s usual flow: a best place that needs an allowance, saved from the check\'s own list (the hashes agree)', async () => {
    const f = await plannedDay('bestlate');
    // C3 must arrive first (by 06:30) and C4 by 07:00: no place on T01 L1 keeps both.
    await hours(f, 'C3', 0, 390);
    await hours(f, 'C4', 0, 420);
    const t01 = await loadOf(f, 'T01');
    const t03 = await loadOf(f, 'T03');
    const c = await check(f, [{ kind: 'MOVE_STOPS', stops: [{ loadId: t03.id, sequence: 1 }], to: { truckId: f.trucks.T01!, loadId: t01.id } }]);
    expect(c.preview.ok).toBe(false);
    expect(c.preview.overrides).toMatchObject({ ok: true, canSave: true });
    expect(c.preview.draftable).toBe(true);
    expect(c.preview.ops[0]).toMatchObject({ kind: 'MOVE_STOPS', to: { loadId: t01.id, order: [{ loadId: t03.id, sequence: 1 }, { loadId: t01.id, sequence: 1 }, { loadId: t01.id, sequence: 2 }] } });
    const needed = c.preview.overrides!.needed;
    expect(needed.map((n) => n.stopLabel)).toEqual(['Customer C4 (C4)']);
    const saved = await save(f, c, f.supervisor, needed.map((n) => ({ id: n.id!, reason: 'customer agreed' })));
    expect(await codesOf(f, 'T01', 1, saved.runId)).toEqual(['C3', 'C1', 'C4']);
  });

  it('D-20 a PLANNER\'s later change carries the allowance when the issue is the same and no worse (the original approver and maximum kept)', async () => {
    const f = await plannedDay('carry', { cases: [5, 30, 10, 20, 30, 10] });
    await prisma.truck.update({ where: { id: f.trucks.T02! }, data: { capacityCases: 75 } });
    const t01 = await loadOf(f, 'T01');
    const t02 = await loadOf(f, 'T02');
    // A supervisor allows T02 L1 at 85 cases (113 %).
    const c = await check(f, [{ kind: 'MOVE_STOPS', stops: [{ loadId: t01.id, sequence: 1 }, { loadId: t01.id, sequence: 2 }], to: { truckId: f.trucks.T02!, loadId: t02.id, order: [{ loadId: t02.id, sequence: 1 }, { loadId: t02.id, sequence: 2 }, { loadId: t01.id, sequence: 1 }, { loadId: t01.id, sequence: 2 }] } }]);
    const n = c.preview.overrides!.needed[0]!;
    expect(n.amount).toMatchObject({ value: 85, capacity: 75 });
    const v2 = await save(f, c, f.supervisor, [{ id: n.id!, reason: 'no other truck' }]);
    // The planner takes C1 off it again (80 cases): the same allowance covers it.
    const l = await loadOf(f, 'T02', 1, v2.runId);
    const c1 = l.assignments.find((a) => a.orderId === f.orderOf.C1![0])!;
    const later = await check(f, [{ kind: 'MOVE_STOPS', stops: [{ loadId: l.id, sequence: c1.sequenceInTruck }], to: { truckId: f.trucks.T03!, loadId: null, before: null } }], { runId: v2.runId, canOverride: false });
    const carried = later.preview.overrides!.needed[0]!;
    expect(carried).toMatchObject({ kind: 'CAPACITY_CASES', amount: { value: 80 }, carried: { reason: 'no other truck', byName: f.supervisor.name, byRole: 'SUPERVISOR' } });
    expect(later.preview.overrides).toMatchObject({ ok: true, canSave: true });
    const v3 = await save(f, later, f.planner, [], v2.runId);
    expect(v3).toMatchObject({ allowed: 0, carried: 1 });
    const kept = (await allowancesOf((await loadOf(f, 'T02', 1, v3.runId)).id))![0]!;
    expect(kept).toMatchObject({ value: 80, maxValue: 85, byName: f.supervisor.name, byRole: 'SUPERVISOR', reason: 'no other truck', carriedFrom: { id: n.id, runId: v2.runId } });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: f.tenantId, entityId: v3.runId, action: 'RULE_ALLOWED_BY_HAND' } });
    expect(audit.afterJson).toMatchObject({ confirmed: 0, carried: 1, keptOnly: true, byRole: 'PLANNER', overrides: [{ kind: 'CAPACITY_CASES', carried: { fromId: n.id } }] });
    // The plan's line and the version note say it was kept, not allowed now (review F7).
    const v3run = await prisma.runPlan.findUniqueOrThrow({ where: { id: v3.runId } });
    expect(v3run.reasonNote).toMatch(/; 1 rule kept from an earlier approval$/);
    // Worse than allowed (90 cases): not carried, the earlier reason pre-filled, a supervisor needed.
    const t03 = await loadOf(f, 'T03', 1, v3.runId);
    const worse = await check(f, [{ kind: 'MOVE_STOPS', stops: [{ loadId: t03.id, sequence: 1 }], to: { truckId: f.trucks.T02!, loadId: (await loadOf(f, 'T02', 1, v3.runId)).id, position: 0 } }], { runId: v3.runId, canOverride: false });
    const w = worse.preview.overrides!.needed.find((x) => x.kind === 'CAPACITY_CASES')!;
    expect(w).toMatchObject({ carried: null, previous: { reason: 'no other truck' } });
    expect(worse.preview.overrides!.canSave).toBe(false);
  });

  it('D-23 several late stops of a whole load moved: all allowed with one reason in one save', async () => {
    const f = await plannedDay('manylate');
    await hours(f, 'C2', 0, 480);
    await hours(f, 'C5', 0, 480);
    const t01 = await loadOf(f, 'T01');
    const t02 = await loadOf(f, 'T02');
    // T01 L1 moved before T02 L1: T02's own stops go on its second trip, after 08:00.
    const c = await check(f, [{ kind: 'MOVE_LOAD', loadId: t01.id, to: { truckId: f.trucks.T02!, before: t02.id } }]);
    const needed = c.preview.overrides!.needed;
    expect(needed.map((n) => n.kind)).toEqual(['LATE', 'LATE']);
    const saved = await save(f, c, f.supervisor, needed.map((n) => ({ id: n.id!, reason: 'second trip agreed' })));
    expect(saved.allowed).toBe(2);
    const l2 = await loadOf(f, 'T02', 2, saved.runId);
    expect((await allowancesOf(l2.id))!.map((a) => a.reason)).toEqual(['second trip agreed', 'second trip agreed']);
  });
});

describe('allowances through later versions and races', () => {
  async function allowedDay(label: string) {
    const f = await plannedDay(label);
    await hours(f, 'C4', 0, 420);
    const t01 = await loadOf(f, 'T01');
    const t03 = await loadOf(f, 'T03');
    const c = await check(f, [{ kind: 'MOVE_STOPS', stops: [{ loadId: t03.id, sequence: 1 }], to: { truckId: f.trucks.T01!, loadId: t01.id, position: 0 } }]);
    const saved = await save(f, c, f.supervisor, [{ id: c.preview.overrides!.needed[0]!.id!, reason: 'agreed with customer' }]);
    return { f, runId: saved.runId, id: c.preview.overrides!.needed[0]!.id! };
  }

  it('D-11 / D-16 / D-21: copied by a change of another truck, kept through lock and unlock and with the switch off, dropped by a RE-PLAN of the Planned loads', async () => {
    const { f, runId, id } = await allowedDay('life');
    // A change of another truck copies T01's load with its allowance.
    const t02 = await loadOf(f, 'T02', 1, runId);
    const other = await check(f, [{ kind: 'MOVE', from: { loadId: t02.id, sequence: 1 }, to: { truckId: f.trucks.T02!, loadId: t02.id, position: 1 } }], { runId });
    const v3 = await save(f, other, f.planner, undefined, runId);
    const l1 = await loadOf(f, 'T01', 1, v3.runId);
    expect((await allowancesOf(l1.id))!.map((a) => a.id)).toEqual([id]);
    // D-21: the plan detail lists it as on a Planned load (the RE-PLAN confirmation reads it).
    const d = (await detail.getPlanDetail(f.tenantId, v3.runId))!;
    expect(view.allowancesOnPlannedText(d.allowedByHand)).toEqual(['T01 L1: Allowed by hand: arrives 07:20, after receiving hours 00:00–07:00 (20 min late) - agreed with customer']);
    // Lock and unlock keep it; with the switch off the gate still honours it.
    process.env.PLAN_EDIT_OVERRIDES = 'off';
    await status(f, v3.runId, l1.id, 'LOCKED');
    expect(view.allowancesOnPlannedText((await detail.getPlanDetail(f.tenantId, v3.runId))!.allowedByHand)).toEqual([]);
    await status(f, v3.runId, l1.id, 'PLANNED');
    expect((await allowancesOf(l1.id))!.length).toBe(1);
    // D-16 (review F5): with the switch off a change on that truck still keeps what was allowed when it is the same
    // and no worse (the solver is asked with the allowance), so the truck stays editable by hand; nothing new can be
    // allowed (no "skip the break" either).
    const same = await check(f, [{ kind: 'MOVE', from: { loadId: l1.id, sequence: 1 }, to: { truckId: f.trucks.T01!, loadId: l1.id, position: 1 } }], { runId: v3.runId, canOverride: false });
    expect(fake.calls.at(-1)!.relax).toMatchObject({ late: true, seed_no_break: [] });
    expect(fake.calls.at(-1)!.before_relax).toMatchObject({ late_stop_ids: [expect.any(String)] });
    expect(same.preview.overrides).toMatchObject({ ok: true, canSave: true, saveNote: null, breakAlternative: [] });
    expect(same.preview.overrides!.needed).toEqual([expect.objectContaining({ id, carried: expect.objectContaining({ reason: 'agreed with customer' }) })]);
    // Worse (C4 a stop later): not carried, and it cannot be allowed with the switch off.
    const t02v3 = await loadOf(f, 'T02', 1, v3.runId);
    const worse = await check(f, [{ kind: 'MOVE', from: { loadId: t02v3.id, sequence: 1 }, to: { truckId: f.trucks.T01!, loadId: l1.id, position: 2 } }], { runId: v3.runId });
    const w = worse.preview.overrides!.needed.find((n) => n.kind === 'LATE')!;
    expect(w).toMatchObject({ carried: null, overridable: false, whyNot: 'Allowing rules by hand is switched off.' });
    expect(worse.preview.overrides).toMatchObject({ canSave: false, saveNote: 'Allowing rules by hand is switched off.' });
    expect(worse.preview.issues.filter((i) => i.overridable)).toEqual([]);
    expect((await refusal(save(f, worse, f.supervisor, [{ id: w.id!, reason: 'agreed again' }], v3.runId))).code).toBe('OVERRIDES_OFF');
    // The same-and-no-worse change saves (a planner: nothing new is confirmed).
    const v4 = await save(f, same, f.planner, [], v3.runId);
    expect(v4).toMatchObject({ allowed: 0, carried: 1 });
    expect((await allowancesOf((await loadOf(f, 'T01', 1, v4.runId)).id))!.map((a) => [a.id, a.reason, a.byName])).toEqual([[id, 'agreed with customer', f.supervisor.name]]);
    delete process.env.PLAN_EDIT_OVERRIDES;
    // A RE-PLAN plans the Planned loads again with every rule: the allowance is gone with them.
    const rp = await start.replan(f.tenantId, v4.runId, 'REOPTIMIZE', null, { id: f.admin.id }, null);
    expect(rp.status).toBe(202);
    const v5 = String(rp.body.runId);
    expect((await jobsDone(v5)).status).toBe('READY');
    for (const l of await loadsOf(v5)) expect((await allowancesOf(l.id))!.length).toBe(0);
  });

  it('D-13 an allowance changed between the check and the save: DAY_CHANGED, nothing written', async () => {
    const { f, runId } = await allowedDay('race');
    const l1 = await loadOf(f, 'T01', 1, runId);
    // Take C3 off T01 again (C4 is on time then): a strict change on the truck that carries the allowance.
    const c = await check(f, [{ kind: 'MOVE', from: { loadId: l1.id, sequence: 1 }, to: { truckId: f.trucks.T03!, loadId: null, before: null } }], { runId });
    expect(c.preview.ok).toBe(true);
    fake.afterRetime = async () => {
      const snap = l1.truckSnapshotJson as { handAllowed: { at: string }[] };
      await prisma.planLoad.update({ where: { id: l1.id }, data: { truckSnapshotJson: { ...snap, handAllowed: snap.handAllowed.map((a) => ({ ...a, at: new Date(Date.now() + 1000).toISOString() })) } as never } });
    };
    expect((await refusal(save(f, c, f.planner, undefined, runId))).code).toBe('DAY_CHANGED');
    expect(await versions(f)).toBe(2);
  });
});

describe('an older route optimizer (v1)', () => {
  it('D-14 several stops at their best place: 503 SOLVER_OUTDATED; an explicit swap saves; nothing can be allowed (with the words)', async () => {
    const f = await plannedDay('v1');
    fake.v1 = true;
    const t01 = await loadOf(f, 'T01');
    const t02 = await loadOf(f, 'T02');
    expect(await refusal(check(f, [{ kind: 'MOVE_STOPS', stops: [{ loadId: t01.id, sequence: 1 }, { loadId: t01.id, sequence: 2 }], to: { truckId: f.trucks.T02!, loadId: t02.id } }]))).toMatchObject({ status: 503, code: 'SOLVER_OUTDATED' });
    const swap = await check(f, [{ kind: 'SWAP_LOADS', a: t01.id, b: t02.id }]);
    expect(swap.preview.ok).toBe(true);
    expect((await save(f, swap, f.planner)).version).toBe(2);
    await hours(f, 'C2', 0, 400);
    const l = await prisma.planLoad.findFirstOrThrow({ where: { runId: (await prisma.runPlan.findFirstOrThrow({ where: { tenantId: f.tenantId, supersededAt: null } })).id, truckId: f.trucks.T01! } });
    const late = await check(f, [{ kind: 'MOVE', from: { loadId: l.id, sequence: 1 }, to: { truckId: f.trucks.T01!, loadId: l.id, position: 1 } }], { runId: l.runId });
    expect(late.preview.ok).toBe(false);
    expect(late.preview.overrides).toBeNull();
    expect(late.preview.saveNote).toBe(`Cannot be saved: it breaks the rules above. ${view.EDIT_ERROR_TEXT.OVERRIDES_NEED_SOLVER}.`);
    expect(late.preview.issues[0]).toMatchObject({ kind: null, overridable: false });
  });
});
