/**
 * SAME-DAY PLANNING STARTS FROM NOW (stabilization PR8; scenario finding S04 / N2), library level on
 * real PostgreSQL. The clock is fixed through the `now` option of startDispatchOptimize / replan;
 * the optimizer is faked in this process (vi.mock of the solver client) by one that keeps the
 * optimizer's truck-day rules: no load before the first departure it is sent, and after a truck's
 * locked / dispatched load, its return + turnaround + loading time per case. Needs DATABASE_URL
 * (migrated); the web server and solver are not used.
 *
 *  - the plan made the day before is unchanged: first departure 06:00, no "Planned from";
 *  - T01's first load is dispatched at 06:00 (back at 09:57); a late order arrives; a re-plan at
 *    09:00 on the delivery day sends 09:30 as the first departure and T01's dispatched load as it was;
 *    the new version keeps that load's times, every new load leaves at 09:30 or later, T01's next load
 *    after 09:57 + its turnaround; the plan warnings, the stored settings and the ASSUMPTIONS rows say
 *    "Planned from 09:30"; the new loads can be locked (the dispatch gate reads the dispatched 06:00
 *    load by the rules it was planned with).
 *  - PR8 review: the request also says when the plan was made (loading_from_min), so loading per
 *    case counts from then on a truck standing at the depot too. A 700-case load that an optimizer
 *    ignoring it (a solver older than the web) puts on an idle truck at 09:30 is refused by the
 *    dispatch gate (ready 10:05); re-planned by one that honours it, it leaves at 10:05 and locks.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';

/** true: the fake optimizer leaves loading_from_min out, like a solver older than the web. */
const solverMode = vi.hoisted(() => ({ ignoresLoadingFrom: false }));

vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  /** One stop per load, trucks in turn; every load is 237 min long (06:00 -> 09:57). */
  function fakeSolve(req: DispatchRequest): DispatchResponse {
    const cfg = req.config ?? {};
    const firstDeparture = Math.max(cfg.shift_start_min ?? 360, req.depot.open_min ?? 0);
    const reload = cfg.reload_min ?? 30;
    const perCase = cfg.loading_min_per_case ?? 0;
    // A plan made on its delivery day: loading starts then at the earliest, on every truck.
    const loadingFrom = solverMode.ignoresLoadingFrom ? null : (cfg.loading_from_min ?? null);
    const state = new Map(
      req.trucks.map((t) => {
        const frozen = t.frozen_trips ?? [];
        return [t.id, { loadNo: frozen.length, back: frozen.length ? Math.max(...frozen.map((f) => f.return_min)) : null as number | null }];
      }),
    );
    const loads: PlannedLoad[] = req.stops.map((s, i) => {
      const truck = req.trucks[i % req.trucks.length]!;
      const st = state.get(truck.id)!;
      const base = st.back === null ? loadingFrom : loadingFrom === null ? st.back : Math.max(st.back, loadingFrom);
      const ready = base === null ? 0 : Math.ceil(base + reload + perCase * s.demand_cases);
      const depart = Math.max(firstDeparture, ready);
      const ret = depart + 237;
      st.loadNo += 1;
      st.back = ret;
      const service = s.service_min ?? 10;
      return {
        truck_id: truck.id,
        load_no: st.loadNo,
        depart_min: depart,
        return_min: ret,
        distance_km: 40,
        duration_min: 237,
        cases: s.demand_cases,
        kg: s.demand_kg ?? 0,
        utilization_pct: 10,
        fuel_litres: 2,
        fuel_cost: 0.5,
        distance_cost: 1,
        time_cost: 1,
        fixed_cost: 0,
        total_cost: 2.5,
        return_leg_km: 20,
        stops: [
          { sequence: 1, stop_id: s.stop_id, order_ids: s.order_ids, customer_id: s.customer_id, arrival_min: depart + 60, service_start_min: depart + 60, departure_min: depart + 60 + service, wait_min: 0, leg_km: 20, cum_km: 20, leg_min: 60, cases: s.demand_cases, kg: s.demand_kg ?? 0, hard_window_ok: true, pref_window_ok: true },
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
      total_distance_km: loads.length * 40,
      total_duration_min: loads.length * 237,
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
  return { SolverError, callDispatchSolver: vi.fn(async (req: DispatchRequest) => fakeSolve(req)) };
});

import { prisma as libPrisma } from '@/lib/db';
import { PlanError } from '@/lib/dispatch/plan-errors';
import { getOrCreatePlan, updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { planFromAssumption } from '@/lib/dispatch/plan-from';
import { replan, startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { tenantAssumptions } from '@/lib/dispatch/workbook';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `sameday-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let userId = '';
let depotId = '';
const user = () => ({ id: userId, role: 'TENANT_ADMIN' });
const everyRole = () => true;

/** A delivery day that is never today on the real clock, so only the fixed `now` makes it "today". */
function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DAY = isoPlus(6);
const dayBefore = () => {
  const d = new Date(`${DAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
/** 09:00 in Muscat (UTC+4) on the delivery day, and 15:00 the day before. */
const AT_0900 = new Date(`${DAY}T05:00:00Z`);
const DAY_BEFORE_1500 = new Date(`${dayBefore()}T11:00:00Z`);

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

async function addOrder(customerCode: string, n: number, late = false, opts: { day?: string; cases?: number } = {}) {
  const day = opts.day ?? DAY;
  const cases = opts.cases ?? 10;
  const product = await prisma.product.findFirstOrThrow({ where: { tenantId } });
  const customer = await prisma.customer.findFirstOrThrow({ where: { tenantId, code: customerCode } });
  return prisma.order.create({
    data: {
      tenantId,
      customerId: customer.id,
      depotId,
      deliveryDate: new Date(`${day}T00:00:00.000Z`),
      totalCases: cases,
      totalWeightKg: cases * 10,
      status: 'VALIDATED',
      priority: late ? 1 : 3,
      isLate: late,
      lateReason: late ? 'Clinic called at 09:00' : null,
      lines: { create: [{ productId: product.id, cases, weightKg: cases * 10, salesOrderNo: `SO-${day}-${n}` }] },
    },
  });
}

async function requestOf(runId: string) {
  const job = await prisma.runJob.findFirstOrThrow({ where: { runId }, orderBy: { attemptNo: 'desc' } });
  return job.requestJson as unknown as DispatchRequest;
}

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Same day ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({
    data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null, shiftStartMin: 360, reloadMinutes: 30, loadingMinPerCase: 0.05 },
  });
  userId = (await prisma.user.create({ data: { tenantId, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner', role: 'TENANT_ADMIN' } })).id;
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'NZW', name: 'Nizwa', lat: 22.93, lng: 57.53 } })).id;
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({ data: { tenantId, depotId, code, capacityCases: 800, capacityWeightKg: 9000, fixedCostPerDay: 25, costPerKm: 0.12 } });
  }
  await prisma.product.create({ data: { tenantId, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 10 } });
  for (const [code, lat, lng] of [['C1', 22.95, 57.55], ['C2', 22.97, 57.5], ['CLINIC', 22.9, 57.6]] as const) {
    await prisma.customer.create({ data: { tenantId, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
  }
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('a same-day re-plan starts from now (PR8)', () => {
  it('the day before: unchanged; at 09:00 on the day: new loads from 09:30, the dispatched load kept, and the plan says so', async () => {
    await addOrder('C1', 1);
    await addOrder('C2', 2);

    // Planned the afternoon before: first departure 06:00, as always.
    const { run: v1 } = await getOrCreatePlan(tenantId, depotId, DAY, userId);
    expect((await startDispatchOptimize(tenantId, v1.id, user(), null, { now: DAY_BEFORE_1500 })).status).toBe(202);
    expect((await jobsDone(v1.id)).status).toBe('READY');
    expect((await requestOf(v1.id)).config.shift_start_min).toBe(360);
    expect((await requestOf(v1.id)).config.loading_from_min ?? null).toBeNull();
    const v1Detail = (await getPlanDetail(tenantId, v1.id))!;
    expect(v1Detail.warnings.some((w) => w.startsWith('Planned from'))).toBe(false);
    expect(v1Detail.planSettings?.planFrom ?? null).toBeNull();

    // T01's first load leaves at 06:00 and is out until 09:57.
    const v1Loads = await prisma.planLoad.findMany({ where: { runId: v1.id }, include: { truck: true }, orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }] });
    const t01l1 = v1Loads.find((l) => l.truck.code === 'T01' && l.loadNo === 1)!;
    expect([t01l1.departMin, t01l1.returnMin]).toEqual([360, 597]);
    await updateLoad(tenantId, v1.id, t01l1.id, { status: 'LOCKED' }, user(), everyRole);
    await updateLoad(tenantId, v1.id, t01l1.id, { status: 'DISPATCHED' }, user(), everyRole);

    // 09:00 on the delivery day: a clinic calls; re-plan.
    await addOrder('CLINIC', 3, true);
    const rp = await replan(tenantId, v1.id, 'LATE_ORDER', 'Clinic called at 09:00', user(), null, {}, undefined, { now: AT_0900 });
    expect(rp.status).toBe(202);
    const v2 = await jobsDone(String(rp.body.runId));
    expect(v2.status).toBe('READY');

    // What the optimizer was sent: 09:30 as the first departure, T01's dispatched load as it was.
    const sent = await requestOf(v2.id);
    expect(sent.config.shift_start_min).toBe(570);
    expect(sent.config.loading_from_min).toBe(540); // PR8 review: loading starts at 09:00 at the earliest
    const t01 = await prisma.truck.findFirstOrThrow({ where: { tenantId, code: 'T01' } });
    expect(sent.trucks.find((t) => t.id === t01.id)!.frozen_trips).toEqual([{ load_no: 1, depart_min: 360, return_min: 597, cases: 10 }]);
    expect(sent.trucks.every((t) => t.available_from_min === null)).toBe(true);
    const started = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: 'OPTIMIZE_STARTED', entityId: v2.id } });
    expect((started.afterJson as { planFromMin?: number | null }).planFromMin).toBe(570);
    expect((started.afterJson as { loadingFromMin?: number | null }).loadingFromMin).toBe(540);
    const startedV1 = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: 'OPTIMIZE_STARTED', entityId: v1.id } });
    expect((startedV1.afterJson as { planFromMin?: number | null }).planFromMin).toBeNull();

    // The new version: the dispatched load keeps its times; every new load leaves at 09:30 or later;
    // T01 leaves again after 09:57 + 30 min turnaround + 0.05 min per case.
    const v2Loads = await prisma.planLoad.findMany({ where: { runId: v2.id }, include: { truck: true }, orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }] });
    const kept = v2Loads.find((l) => l.status === 'DISPATCHED')!;
    expect([kept.truck.code, kept.loadNo, kept.departMin, kept.returnMin, kept.carriedFromLoadId]).toEqual(['T01', 1, 360, 597, t01l1.id]);
    // C2 (T02's load of the previous plan, never dispatched: planned again) and the clinic.
    const fresh = v2Loads.filter((l) => l.status === 'PLANNED');
    expect(fresh.length).toBe(2);
    for (const l of fresh) expect(l.departMin, `${l.truck.code} L${l.loadNo}`).toBeGreaterThanOrEqual(570);
    const t01Next = fresh.find((l) => l.truck.code === 'T01' && l.loadNo === 2)!;
    expect(t01Next.departMin).toBeGreaterThanOrEqual(597 + 30 + 0.05 * t01Next.cases);
    // With PR7 (B3): the job message counts the kept load and the day's physical trucks (T01 once).
    const v2Job = await prisma.runJob.findFirstOrThrow({ where: { runId: v2.id }, orderBy: { attemptNo: 'desc' } });
    expect(v2Job.message).toMatch(/^2 new loads \+ 1 kept \(locked or dispatched\) on 2 trucks, 0 stop\(s\) unserved/);

    // The plan says so: warnings, the settings kept with it, and the ASSUMPTIONS rows.
    const detail = (await getPlanDetail(tenantId, v2.id))!;
    expect(detail.warnings.some((w) => w.startsWith('Planned from 09:30 (now 09:00 + 30 min preparation)'))).toBe(true);
    expect(detail.planSettings?.planFrom).toEqual({ nowMin: 540, prepMin: 30, fromMin: 570 });
    expect(detail.planSettings?.shiftStartMin).toBe(360);
    expect(detail.planSettings?.loadingFromMin).toBe(540);
    const rows = tenantAssumptions(detail.planSettings!, { currency: 'OMR', providerUsed: 'HAVERSINE', distanceIsEstimated: true });
    expect(rows['Planned from (plan made on the delivery day)']).toBe(planFromAssumption({ nowMin: 540, prepMin: 30, fromMin: 570 }, 0.05));

    // The dispatch gate: the new loads' timetable holds (the 06:00 load is read by its own rules).
    expect(detail.feasibility?.violations.filter((v) => v.severity === 'BLOCK') ?? []).toEqual([]);
    await updateLoad(tenantId, v2.id, t01Next.id, { status: 'LOCKED' }, user(), everyRole);
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: t01Next.id } })).status).toBe('LOCKED');
  });

  it('PR8 review: a 700-case load on a truck idle at the depot is not let out before it can be loaded from now', async () => {
    const day = isoPlus(8);
    const at0900 = new Date(`${day}T05:00:00Z`); // 09:00 in Muscat on that delivery day
    await addOrder('C1', 11, false, { day, cases: 700 });

    // An optimizer that leaves the loading from now out (a solver older than the web) plans 09:30.
    solverMode.ignoresLoadingFrom = true;
    let v1Id = '';
    try {
      const { run } = await getOrCreatePlan(tenantId, depotId, day, userId);
      v1Id = run.id;
      expect((await startDispatchOptimize(tenantId, run.id, user(), null, { now: at0900 })).status).toBe(202);
      expect((await jobsDone(run.id)).status).toBe('READY');
    } finally {
      solverMode.ignoresLoadingFrom = false;
    }
    expect((await requestOf(v1Id)).config.loading_from_min).toBe(540);
    const early = await prisma.planLoad.findFirstOrThrow({ where: { runId: v1Id } });
    expect([early.loadNo, early.departMin, early.cases]).toEqual([1, 570, 700]);

    // The dispatch gate: 30 min turnaround + 0.05 x 700 = 65 min from 09:00, so ready at 10:05.
    const detail = (await getPlanDetail(tenantId, v1Id))!;
    const blocking = detail.feasibility?.violations.filter((v) => v.severity === 'BLOCK') ?? [];
    expect(blocking.map((v) => [v.code, v.loadNo])).toEqual([['TURNAROUND', 1]]);
    expect(blocking[0].message).toContain('the plan was made at 09:00 on its delivery day, so loading starts then: the truck needs 65 min to reload and load 700 cases: ready 10:05');
    if (process.env.FEASIBILITY_GATE !== 'warn') {
      const err = await updateLoad(tenantId, v1Id, early.id, { status: 'LOCKED' }, user(), everyRole).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).status).toBe(409);
      expect((err as PlanError).details).toMatchObject({ code: 'TIMES_NOT_VERIFIED' });
      expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: early.id } })).status).toBe('PLANNED');
    }

    // Re-planned by an optimizer that honours it: the load leaves at 10:05 and locks.
    const rp = await replan(tenantId, v1Id, 'REOPTIMIZE', 'Loading time from now', user(), null, {}, undefined, { now: at0900 });
    expect(rp.status).toBe(202);
    const v2 = await jobsDone(String(rp.body.runId));
    expect(v2.status).toBe('READY');
    const onTime = await prisma.planLoad.findFirstOrThrow({ where: { runId: v2.id, status: 'PLANNED' } });
    expect([onTime.departMin, onTime.cases]).toEqual([605, 700]);
    const v2Detail = (await getPlanDetail(tenantId, v2.id))!;
    expect(v2Detail.feasibility?.violations.filter((v) => v.severity === 'BLOCK') ?? []).toEqual([]);
    await updateLoad(tenantId, v2.id, onTime.id, { status: 'LOCKED' }, user(), everyRole);
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: onTime.id } })).status).toBe('LOCKED');
  });
});
