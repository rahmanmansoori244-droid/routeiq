/**
 * BRING FORWARD (PR9): orders not delivered on their own day, carried to a later day - library level
 * on real PostgreSQL. The optimizer is faked in this process (vi.mock of the solver client): one stop
 * per load, trucks in turn, after each truck's locked / dispatched loads; stops of the customers in
 * `solverMode.unserved` are left unserved. Needs DATABASE_URL (migrated); the web server and the
 * solver are not used.
 *
 *  1. Day 1: C1 on T01 L1 (dispatched, then completed), C2 on T02 L1 (locked: loaded at night, never
 *     left), C3 unserved. Day 2 has no plan. The preview for day 2 lists C2 (load never left) and C3
 *     (unserved), not C1. "Bring forward" carries exactly those, with their cases, sales orders and
 *     weights; the originals are no longer open, unserved or pending on day 1 (day screen, pending,
 *     dashboard), day 1's plan rows are exactly as they were, and its locked load can no longer be
 *     dispatched with them. Running it again carries nothing. OPTIMIZE of day 2 plans the copies, and
 *     every paper marks them.
 *  2. The day it goes to already has a plan with a locked load: the copies wait like late orders, and
 *     RE-PLAN (reason LATE_ORDER) keeps the locked load exactly as it was and adds them.
 *  3. Two "Bring forward" calls at the same time carry each order once (intake lock + unique links);
 *     a day that was never planned is carried whole; a list that changed answers 409 and carries nothing.
 *  4. (PR9 review) A split order: the part on a dispatched load stays delivered (no "carried over" mark
 *     there), only the rest is brought forward, and a re-plan of its day afterwards still reconciles
 *     and its new load can be locked and dispatched.
 *  5. (PR9 second review) The same sales-order line entered again for the next day: only the newer
 *     order is brought forward; once it was, the older one is never offered again (the line would be
 *     delivered twice). Test 1 also checks: a day that is over takes nothing (409 DAY_OVER), and the
 *     earlier day's Step 3 and the 409 say to unload a locked load holding only brought-forward
 *     orders (it was loaded), never "unlock it" or "every load has left the depot".
 *  6. (Owner decision: today's orders) At night, planning tomorrow (its load locked tonight): today's
 *     leftovers - on a load locked last night that has not left, unserved, on a planned afternoon
 *     trip - are listed as today's, none ticked; sent without the Today tick they are refused
 *     (TODAY_NOT_SELECTED); ticked, they go to tomorrow and are closed on today like an earlier
 *     day's, today's load holding one cannot go out and the 409 says to unlock it (so does its
 *     badge on the plan version page: the plan detail gives today); the unticked one stays
 *     today's and its load is dispatched; RE-PLAN of tomorrow adds the copies.
 *
 * Bring forward never looks past the company's today; today's orders are listed as their own
 * group. Every carry here runs with the clock on the day it carries to (`onDay`), after the days it
 * reads, except test 6 (at night on the day before, `atNight`) and test 1's check of today's group.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';

/** Customer ids whose stops the fake optimizer leaves unserved; `unservedStops`: single stops (a split part "<customerId>#2"). */
const solverMode = vi.hoisted(() => ({ unserved: new Set<string>(), unservedStops: new Set<string>() }));
/** The signed-in user for the one route called directly (the batch delete). */
const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => (session.user ? { user: session.user } : null)) }));

vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  function fakeSolve(req: DispatchRequest): DispatchResponse {
    const cfg = req.config ?? {};
    const first = Math.max(cfg.shift_start_min ?? 360, req.depot.open_min ?? 0);
    const reload = cfg.reload_min ?? 30;
    const state = new Map(
      req.trucks.map((t) => {
        const frozen = t.frozen_trips ?? [];
        return [t.id, { loadNo: frozen.length ? Math.max(...frozen.map((f) => f.load_no)) : 0, back: frozen.length ? Math.max(...frozen.map((f) => f.return_min)) : null as number | null }];
      }),
    );
    const left = (s: DispatchRequest['stops'][number]) => solverMode.unserved.has(s.customer_id) || solverMode.unservedStops.has(s.stop_id);
    const served = req.stops.filter((s) => !left(s));
    const loads: PlannedLoad[] = served.map((s, i) => {
      const truck = req.trucks[i % req.trucks.length]!;
      const st = state.get(truck.id)!;
      const depart = Math.max(first, st.back === null ? 0 : st.back + reload);
      const ret = depart + 120;
      st.loadNo += 1;
      st.back = ret;
      return {
        truck_id: truck.id, load_no: st.loadNo, depart_min: depart, return_min: ret, distance_km: 40, duration_min: 120, cases: s.demand_cases, kg: s.demand_kg ?? 0,
        utilization_pct: 10, fuel_litres: 2, fuel_cost: 0.5, distance_cost: 1, time_cost: 1, fixed_cost: 0, total_cost: 2.5, return_leg_km: 20,
        stops: [{
          sequence: 1, stop_id: s.stop_id, order_ids: s.order_ids, customer_id: s.customer_id, arrival_min: depart + 30, service_start_min: depart + 30,
          departure_min: depart + 30 + (s.service_min ?? 10), wait_min: 0, leg_km: 20, cum_km: 20, leg_min: 30, cases: s.demand_cases, kg: s.demand_kg ?? 0,
          hard_window_ok: true, pref_window_ok: true,
        }],
      };
    });
    const sc: DispatchScenario = {
      name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 0.1, time_limit_sec: 5, objective_value: 1,
      objective: { unserved_penalty: 0, fixed_cost: 0, distance_cost: 0, fuel_cost: 0, time_cost: 0, overtime_cost: 0, window_penalty: 0, margin_served: null },
      trucks_used: new Set(loads.map((l) => l.truck_id)).size, trips: loads.length, total_distance_km: loads.length * 40, total_duration_min: loads.length * 120,
      total_cases: loads.reduce((a, l) => a + l.cases, 0), total_kg: 0, avg_utilization_pct: 10, fuel_litres: 0, fuel_cost: 0, operating_cost: loads.length * 2.5, loads,
      unserved: req.stops
        .filter((s) => left(s))
        .map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'SOLVER_DROPPED_LOW_PRIORITY', reason_message: 'No truck had room left (test).' })),
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
import { getDayOverview } from '@/lib/dispatch/day-overview';
import { bringForward, carryOverPreview } from '@/lib/dispatch/carry-over';
import { replan, startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { driverPackModel } from '@/lib/dispatch/driver-pack';
import { carriedOverRows } from '@/lib/dispatch/workbook';
import { carriedLoadTitle, carrySelectionPayload, dayNothingLeftText, defaultCarrySelection } from '@/lib/dispatch/carry-view';
import { fetchRangeRows } from '@/lib/dashboard';
import { fmtDayMonth } from '@/lib/dispatch/time';
import { DELETE as deleteBatch } from '@/app/api/orders/[batchId]/route';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `carry-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let userId = '';
let depotId = '';
let productId = '';
const user = () => ({ id: userId, role: 'TENANT_ADMIN' });
const everyRole = () => true;

/** Delivery days far from today on the real clock (so "today" never interferes), 20 days apart per test. */
function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 10:00 in Muscat two days before `iso` (before any cutoff of the days used). */
const morningBefore = (iso: string) => {
  const d = new Date(`${iso}T06:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 2);
  return d;
};
/** 09:00 in Muscat on `iso`: the days before it are over, so Bring forward to `iso` looks at them. */
const onDay = (iso: string) => new Date(`${iso}T05:00:00Z`);
/** 21:00 in Muscat on `iso`: tomorrow's trucks are being loaded; `iso` is today, its orders are today's group. */
const atNight = (iso: string) => new Date(`${iso}T17:00:00Z`);

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

async function customerId(code: string) {
  return (await prisma.customer.findFirstOrThrow({ where: { tenantId, code } })).id;
}

/** A confirmed order with one sales-order line and its intake key, as the file intake writes them. */
async function addOrder(code: string, day: string, cases: number, so: string) {
  const cid = await customerId(code);
  const deliveryDate = new Date(`${day}T00:00:00.000Z`);
  const o = await prisma.order.create({
    data: {
      tenantId,
      customerId: cid,
      depotId,
      deliveryDate,
      totalCases: cases,
      totalWeightKg: cases * 12,
      status: 'VALIDATED',
      priority: 3,
      salesValue: cases * 2,
      lines: { create: [{ productId, cases, weightKg: cases * 12, salesOrderNo: so, salesValue: cases * 2 }] },
    },
    include: { lines: true },
  });
  await prisma.intakeLineKey.create({ data: { tenantId, deliveryDate, salesOrderNorm: so.toUpperCase(), customerId: cid, productId, orderLineId: o.lines[0]!.id } });
  return o;
}

async function optimize(day: string, now: Date) {
  const { run } = await getOrCreatePlan(tenantId, depotId, day, userId);
  const res = await startDispatchOptimize(tenantId, run.id, user(), null, { now });
  expect(res.status).toBe(202);
  const done = await jobsDone(run.id);
  expect(done.status).toBe('READY');
  return done;
}

async function loadOf(runId: string, orderId: string) {
  const a = await prisma.routeAssignment.findFirstOrThrow({ where: { runId, orderId }, include: { load: true } });
  return a.load!;
}

/** The plan rows of a version, to compare before and after (history must not change). */
async function planRows(runId: string) {
  const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
  return {
    run: { status: run.status, version: run.version, chosenScenarioId: run.chosenScenarioId, summaryJson: run.summaryJson, reconciliationJson: run.reconciliationJson, totalOrders: run.totalOrders, unservedCount: run.unservedCount },
    loads: await prisma.planLoad.findMany({ where: { runId }, orderBy: { id: 'asc' }, select: { id: true, status: true, cases: true, departMin: true, returnMin: true } }),
    assignments: await prisma.routeAssignment.findMany({ where: { runId }, orderBy: { id: 'asc' }, select: { id: true, orderId: true, loadId: true, portionLinesJson: true } }),
    unserved: await prisma.unservedOrder.findMany({ where: { scenario: { runId } }, orderBy: { id: 'asc' }, select: { id: true, orderId: true, reasonCode: true } }),
  };
}

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Carry ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null, shiftStartMin: 360, reloadMinutes: 30 } });
  userId = (await prisma.user.create({ data: { tenantId, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner', role: 'TENANT_ADMIN' } })).id;
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'GHL', name: 'Ghala', lat: 23.58, lng: 58.39 } })).id;
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({ data: { tenantId, depotId, code, capacityCases: 800, capacityWeightKg: 12000, fixedCostPerDay: 25, costPerKm: 0.12 } });
  }
  productId = (await prisma.product.create({ data: { tenantId, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 12 } })).id;
  const pins: [string, number, number][] = [['C1', 23.6, 58.41], ['C2', 23.61, 58.45], ['C3', 23.55, 58.3], ['C4', 23.62, 58.5], ['C5', 23.57, 58.36], ['C6', 23.59, 58.38], ['C7', 23.6, 58.42]];
  for (const [code, lat, lng] of pins) {
    await prisma.customer.create({ data: { tenantId, code, name: `Shop ${code}`, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
  }
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('bring forward the orders not delivered on earlier days (PR9)', () => {
  it('carries exactly the orders not delivered, leaves day 1 as it was, runs once, and day 2 plans them', async () => {
    const DAY1 = isoPlus(20);
    const DAY2 = isoPlus(21);
    const now = morningBefore(DAY1);
    // The morning of day 2: day 1 is over (its locked load never left).
    const carryNow = onDay(DAY2);
    const o1 = await addOrder('C1', DAY1, 10, 'SO-1');
    const o2 = await addOrder('C2', DAY1, 20, 'SO-2');
    const o3 = await addOrder('C3', DAY1, 30, 'SO-3');

    // Day 1: C3 is left unserved; C1's load leaves and comes back; C2's load is locked (loaded at night) and never leaves.
    solverMode.unserved = new Set([await customerId('C3')]);
    const day1 = await optimize(DAY1, now);
    solverMode.unserved = new Set();
    const l1 = await loadOf(day1.id, o1.id);
    const l2 = await loadOf(day1.id, o2.id);
    expect(l1.id).not.toBe(l2.id);
    for (const s of ['LOCKED', 'DISPATCHED', 'COMPLETED'] as const) await updateLoad(tenantId, day1.id, l1.id, { status: s }, user(), everyRole);
    await updateLoad(tenantId, day1.id, l2.id, { status: 'LOCKED' }, user(), everyRole);
    expect(await prisma.unservedOrder.count({ where: { orderId: o3.id, scenario: { runId: day1.id } } })).toBe(1);

    // While day 1 is still today, the preview for day 2 lists C2 and C3 as today's orders - their own
    // group, none ticked: today's loads may still leave (owner decision); C1's load left.
    const early = await carryOverPreview(tenantId, depotId, DAY2, { now: onDay(DAY1) });
    expect(early).toMatchObject({ to: DAY1, today: DAY1, orders: 0, cases: 0, todayOrders: 2, todayCases: 50 });
    expect(early.candidates.map((c) => [c.customerCode, c.ofToday, c.why.map((w) => w.kind)])).toEqual([
      ['C2', true, ['NOT_LEFT']],
      ['C3', true, ['UNSERVED']],
    ]);
    expect(defaultCarrySelection(early.candidates).size).toBe(0);

    // The preview for day 2: C2 (its load never left) and C3 (unserved); C1 was delivered.
    const preview = await carryOverPreview(tenantId, depotId, DAY2, { now: carryNow });
    expect(preview.candidates.map((c) => [c.customerCode, c.cases, c.why.map((w) => w.kind)])).toEqual([
      ['C2', 20, ['NOT_LEFT']],
      ['C3', 30, ['UNSERVED']],
    ]);
    expect(preview).toMatchObject({ orders: 2, cases: 50, blocked: 0 });
    const before = await planRows(day1.id);
    const day1KeysBefore = await prisma.intakeLineKey.findMany({ where: { tenantId, deliveryDate: new Date(`${DAY1}T00:00:00Z`) }, orderBy: { id: 'asc' } });

    // Bring forward.
    const res = await bringForward(tenantId, depotId, DAY2, preview.candidates.map((c) => ({ orderId: c.orderId, cases: c.cases })), { id: userId }, { now: carryNow });
    // Brought forward on day 2 itself: late, like a late order received that day; no plan yet, so no re-plan.
    expect(res).toMatchObject({ orders: 2, cases: 50, late: true, replanNeeded: false, skipped: [] });
    const copies = await prisma.order.findMany({ where: { tenantId, carriedFromOrderId: { in: [o2.id, o3.id] } }, include: { lines: true }, orderBy: { totalCases: 'asc' } });
    expect(copies.map((c) => [c.carriedFromOrderId, c.totalCases, c.totalWeightKg, c.priority, c.salesValue, c.lines.map((l) => [l.salesOrderNo, l.cases, l.weightKg, l.productId])])).toEqual([
      [o2.id, 20, 240, 3, 40, [['SO-2', 20, 240, productId]]],
      [o3.id, 30, 360, 3, 60, [['SO-3', 30, 360, productId]]],
    ]);
    for (const c of copies) {
      expect(c.deliveryDate.toISOString().slice(0, 10)).toBe(DAY2);
      expect(c.carriedFromDate?.toISOString().slice(0, 10)).toBe(DAY1);
      expect(c.depotId).toBe(depotId);
      expect(c.uploadBatchId).toBeNull();
      expect(c.status).toBe('VALIDATED');
    }
    const originals = await prisma.order.findMany({ where: { id: { in: [o1.id, o2.id, o3.id] } }, orderBy: { totalCases: 'asc' } });
    expect(originals.map((o) => [o.id, o.carriedToOrderId !== null, o.carriedById])).toEqual([
      [o1.id, false, null],
      [o2.id, true, userId],
      [o3.id, true, userId],
    ]);
    // The copies' sales-order lines are confirmed for day 2; day 1 keeps its own keys untouched.
    const day2Keys = await prisma.intakeLineKey.findMany({ where: { tenantId, deliveryDate: new Date(`${DAY2}T00:00:00Z`) } });
    expect(day2Keys.map((k) => k.salesOrderNorm).sort()).toEqual(['SO-2', 'SO-3']);
    expect(day2Keys.every((k) => k.uploadBatchId === null)).toBe(true);
    expect(await prisma.intakeLineKey.findMany({ where: { tenantId, deliveryDate: new Date(`${DAY1}T00:00:00Z`) }, orderBy: { id: 'asc' } })).toEqual(day1KeysBefore);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: 'ORDERS_CARRIED_OVER' } });
    expect(audit.afterJson).toMatchObject({ date: DAY2, orders: 2, cases: 50 });

    // Day 1: the plan rows are exactly as they were; the carried orders are no longer open or pending there.
    expect(await planRows(day1.id)).toEqual(before);
    const d1 = await getDayOverview(tenantId, { date: DAY1, depotId });
    expect(d1.orders.count).toBe(1);
    expect(d1.openOrders).toBe(0);
    expect(d1.pending.count).toBe(0);
    expect(d1.carriedOut).toEqual({ orders: 2, cases: 50, toDates: [DAY2] });
    const d1Plan = (await getPlanDetail(tenantId, day1.id))!;
    expect(d1Plan.pendingOrders).toBe(0);
    expect(d1Plan.carriedOut).toEqual({ orders: 2, cases: 50, dates: [DAY2] });
    expect(d1Plan.unserved.find((u) => u.orderId === o3.id)?.carriedTo).toBe(DAY2);
    expect(d1Plan.loads.find((l) => l.id === l2.id)?.carriedAway).toBe(1);
    // The dashboard counts them once, on day 2: day 1 has 1 order, none unserved, and only C1's 10
    // cases (its plan's summary counts 60; the 50 carried are day 2's).
    const [kpi] = await fetchRangeRows(tenantId, DAY1, DAY1);
    expect([Number(kpi.orders_total), Number(kpi.orders_unserved), Number(kpi.cases_total)]).toEqual([1, 0, 10]);
    // Day 1's locked load cannot be dispatched with an order that is now day 2's.
    const refused = await updateLoad(tenantId, day1.id, l2.id, { status: 'DISPATCHED' }, user(), everyRole).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PlanError);
    expect((refused as PlanError).details).toMatchObject({ code: 'ORDERS_CARRIED' });
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: l2.id } })).status).toBe('LOCKED');
    // It holds nothing else - never "re-plan this day" - but it is LOCKED: loaded at night, so its
    // cases are on the truck and planned on day 2 now (second review: never "never loaded").
    expect((refused as PlanError).message).toContain(
      `This load holds nothing else, but it was loaded: its cases were brought forward to ${fmtDayMonth(DAY2)} and are planned there. Unload them back to stock, or tell the warehouse, before the loads of ${fmtDayMonth(DAY2)} are picked`,
    );
    expect((refused as PlanError).message).not.toMatch(/re-plan this day|never loaded|leave it as it is/i);
    // Step 3 of day 1 says the same: the locked load holds only a brought-forward order, so never
    // "unlock it first" (second review), and it names the day they went to.
    expect(d1.plan?.loadsByStatus).toEqual({ COMPLETED: 1, LOCKED: 1 });
    expect(d1.plan?.loadsOfDay).toEqual({ COMPLETED: 1 });
    const step3 = dayNothingLeftText({
      orders: d1.orders.count, openOrders: d1.openOrders, pending: d1.pending.count, chosen: !!d1.plan?.chosen,
      carriedOut: d1.carriedOut, loadsByStatus: d1.plan?.loadsByStatus ?? {}, loadsOfDay: d1.plan?.loadsOfDay,
    });
    expect(step3?.startsWith(`Nothing left to plan: 2 order(s) of this day were brought forward to ${fmtDayMonth(DAY2)} and are planned there`)).toBe(true);
    expect(step3).toContain('1 locked or loading load(s) hold only brought-forward orders and were loaded');
    expect(step3).not.toMatch(/unlock|left the depot/i);
    // Day 1 is over: nothing is listed for it, and nothing can be brought forward to it (second review).
    expect(await carryOverPreview(tenantId, depotId, DAY1, { now: carryNow })).toMatchObject({ dayOver: true, candidates: [] });
    const over = await bringForward(tenantId, depotId, DAY1, [{ orderId: o1.id, cases: 10 }], { id: userId }, { now: carryNow }).catch((e: unknown) => e);
    expect((over as PlanError).details).toMatchObject({ code: 'DAY_OVER' });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o1.id } })).carriedToOrderId).toBeNull();

    // Running it again carries nothing new; the list is empty.
    const again = await bringForward(tenantId, depotId, DAY2, preview.candidates.map((c) => ({ orderId: c.orderId, cases: c.cases })), { id: userId }, { now: carryNow });
    expect(again.orders).toBe(0);
    expect(again.skipped.map((s) => s.code)).toEqual(['ALREADY_CARRIED', 'ALREADY_CARRIED']);
    expect(await prisma.order.count({ where: { tenantId, carriedFromOrderId: { not: null } } })).toBe(2);
    expect((await carryOverPreview(tenantId, depotId, DAY2, { now: carryNow })).candidates).toEqual([]);

    // A re-plan of day 1 has nothing to plan and says why - never "unlock a load": the locked load
    // holds only a brought-forward order, so unlocking it changes nothing.
    const rp0 = await replan(tenantId, day1.id, 'REOPTIMIZE', null, user(), null, {}, undefined, { now: carryNow });
    expect(rp0.status).toBe(409);
    expect(rp0.body).toMatchObject({ code: 'NOTHING_TO_PLAN', carriedAway: 2 });
    expect(String(rp0.body.error)).not.toMatch(/unlock/i);
    // The dispatcher unlocks that load anyway and re-plans day 1: nothing is left to plan there, and
    // the answer says why (never "every load has left the depot" or "upload orders first"); no new version.
    await updateLoad(tenantId, day1.id, l2.id, { status: 'PLANNED' }, user(), everyRole);
    const rp1 = await replan(tenantId, day1.id, 'REOPTIMIZE', null, user(), null, {}, undefined, { now: carryNow });
    expect(rp1.status).toBe(409);
    expect(rp1.body).toMatchObject({ code: 'NOTHING_TO_PLAN', carriedAway: 2 });
    expect(String(rp1.body.error)).toMatch(/brought forward to a later day/);
    expect(String(rp1.body.error)).not.toMatch(/left the depot|Upload orders first/);
    // Unlocked, the load is still at the depot: Step 3 never says "every load has left the depot".
    const d1b = await getDayOverview(tenantId, { date: DAY1, depotId });
    expect(d1b.plan?.loadsOfDay).toEqual({ COMPLETED: 1 });
    const step3b = dayNothingLeftText({
      orders: d1b.orders.count, openOrders: d1b.openOrders, pending: d1b.pending.count, chosen: !!d1b.plan?.chosen,
      carriedOut: d1b.carriedOut, loadsByStatus: d1b.plan?.loadsByStatus ?? {}, loadsOfDay: d1b.plan?.loadsOfDay,
    });
    expect(step3b).not.toMatch(/unlock|left the depot|were loaded/i);
    expect(await prisma.runPlan.count({ where: { tenantId, depotId, runDate: new Date(`${DAY1}T00:00:00Z`) } })).toBe(1);

    // Day 2 (no plan yet): the copies are ordinary open orders; OPTIMIZE plans them, and the papers mark them.
    const own = await addOrder('C4', DAY2, 5, 'SO-4');
    const d2Day = await getDayOverview(tenantId, { date: DAY2, depotId });
    expect(d2Day.carriedIn.map((o) => [o.customerCode, o.fromDate, o.pending])).toEqual([
      ['C2', DAY1, true],
      ['C3', DAY1, true],
    ]);
    const day2 = await optimize(DAY2, now);
    const req = (await prisma.runJob.findFirstOrThrow({ where: { runId: day2.id } })).requestJson as unknown as DispatchRequest;
    expect(req.stops.flatMap((s) => s.order_ids).sort()).toEqual([...copies.map((c) => c.id), own.id].sort());
    const d2Plan = (await getPlanDetail(tenantId, day2.id))!;
    const stops = d2Plan.loads.flatMap((l) => l.stops);
    expect(stops.filter((s) => s.carriedFrom === DAY1).map((s) => s.customerCode).sort()).toEqual(['C2', 'C3']);
    expect(stops.find((s) => s.customerCode === 'C4')?.carriedFrom).toBeNull();
    expect(d2Plan.carriedIn).toEqual({ orders: 2, cases: 50, dates: [DAY1] });
    expect(d2Plan.reconciliation?.ok).toBe(true);
    const sheets = driverPackModel(d2Plan, { tenantName: 'NMWC' }).sheets.flatMap((s) => s.stops);
    const mark = `CARRIED OVER from ${fmtDayMonth(DAY1)} (not delivered that day)`;
    expect(sheets.filter((s) => s.carried).map((s) => s.carried)).toEqual([mark, mark]);
    expect(carriedOverRows(d2Plan)[0]).toEqual(['Brought forward from earlier days', '2 orders · 50 cases', expect.any(String)]);
  });

  it('a day already planned, with a locked load: the copies wait like late orders and RE-PLAN adds them around the locked load', async () => {
    const A = isoPlus(40);
    const B = isoPlus(41);
    const now = morningBefore(A);
    // Day B is planned first and its load locked (loaded the night before).
    const own = await addOrder('C6', B, 8, 'SO-B6');
    const planB = await optimize(B, now);
    const locked = await loadOf(planB.id, own.id);
    await updateLoad(tenantId, planB.id, locked.id, { status: 'LOCKED' }, user(), everyRole);
    // Day A: C5 is left unserved.
    const o5 = await addOrder('C5', A, 12, 'SO-A5');
    solverMode.unserved = new Set([await customerId('C5')]);
    await optimize(A, now);
    solverMode.unserved = new Set();

    // The morning of day B (day A is over), its load locked the night before.
    const res = await bringForward(tenantId, depotId, B, [{ orderId: o5.id, cases: 12 }], { id: userId }, { now: onDay(B) });
    expect(res).toMatchObject({ orders: 1, cases: 12, late: true, replanNeeded: true, planId: planB.id });
    const copy = await prisma.order.findFirstOrThrow({ where: { carriedFromOrderId: o5.id } });
    expect(copy.isLate).toBe(true);
    const dayB = await getDayOverview(tenantId, { date: B, depotId });
    expect(dayB.pending).toMatchObject({ count: 1, cases: 12, carried: 1 });

    // RE-PLAN as the plan screen sends it: it becomes a late-order re-plan; the locked load is kept.
    const rp = await replan(tenantId, planB.id, 'REOPTIMIZE', null, user(), null, {}, undefined, { now });
    expect(rp.status).toBe(202);
    expect(rp.body.reason).toBe('LATE_ORDER');
    const v2 = await jobsDone(String(rp.body.runId));
    expect(v2.status).toBe('READY');
    const loads = await prisma.planLoad.findMany({ where: { runId: v2.id }, include: { assignments: true } });
    const kept = loads.find((l) => l.carriedFromLoadId === locked.id)!;
    expect([kept.status, kept.departMin, kept.returnMin, kept.cases]).toEqual(['LOCKED', locked.departMin, locked.returnMin, locked.cases]);
    expect(kept.assignments.map((a) => a.orderId)).toEqual([own.id]);
    const added = loads.filter((l) => l.status === 'PLANNED');
    expect(added.flatMap((l) => l.assignments.map((a) => a.orderId))).toEqual([copy.id]);
    const sent = (await prisma.runJob.findFirstOrThrow({ where: { runId: v2.id } })).requestJson as unknown as DispatchRequest;
    expect(sent.stops.flatMap((s) => s.order_ids)).toEqual([copy.id]);
    expect(sent.trucks.flatMap((t) => t.frozen_trips ?? [])).toEqual([{ load_no: locked.loadNo, depart_min: locked.departMin, return_min: locked.returnMin, cases: locked.cases }]);
    expect((await getDayOverview(tenantId, { date: B, depotId })).pending.count).toBe(0);
  });

  it('two calls at the same time carry each order once; a day never planned is carried whole; a changed list carries nothing', async () => {
    const X = isoPlus(60);
    const Y = isoPlus(61);
    // The morning of day Y: day X is over.
    const now = onDay(Y);
    // Day X was never planned: its orders were confirmed and nothing more.
    const a = await addOrder('C7', X, 7, 'SO-X7');
    const b = await addOrder('C1', X, 9, 'SO-X1');
    const batch = await prisma.uploadBatch.create({
      data: { tenantId, fileName: 'orders-x.xlsx', fileType: 'xlsx', uploadedById: userId, status: 'CONFIRMED', depotId, deliveryDate: new Date(`${X}T00:00:00Z`) },
    });
    await prisma.order.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { uploadBatchId: batch.id } });
    const preview = await carryOverPreview(tenantId, depotId, Y, { now });
    expect(preview.candidates.map((c) => [c.customerCode, c.cases, c.why[0].kind])).toEqual([
      ['C1', 9, 'NEVER_PLANNED'],
      ['C7', 7, 'NEVER_PLANNED'],
    ]);

    // A list that no longer matches (the screen showed other cases): 409, nothing carried.
    const stale = await bringForward(tenantId, depotId, Y, [{ orderId: a.id, cases: 70 }], { id: userId }, { now }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(PlanError);
    expect((stale as PlanError).details).toMatchObject({ code: 'CARRY_OVER_CHANGED' });
    expect(await prisma.order.count({ where: { tenantId, carriedFromOrderId: { in: [a.id, b.id] } } })).toBe(0);

    const sel = preview.candidates.map((c) => ({ orderId: c.orderId, cases: c.cases }));
    const [r1, r2] = await Promise.all([
      bringForward(tenantId, depotId, Y, sel, { id: userId }, { now }),
      bringForward(tenantId, depotId, Y, sel, { id: userId }, { now }),
    ]);
    expect(r1.orders + r2.orders).toBe(2);
    expect([r1.orders, r2.orders].sort()).toEqual([0, 2]);
    expect([...r1.skipped, ...r2.skipped].map((s) => s.code)).toEqual(['ALREADY_CARRIED', 'ALREADY_CARRIED']);
    for (const o of [a, b]) expect(await prisma.order.count({ where: { carriedFromOrderId: o.id } })).toBe(1);
    expect(await prisma.intakeLineKey.count({ where: { tenantId, deliveryDate: new Date(`${Y}T00:00:00Z`) } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { tenantId, action: 'ORDERS_CARRIED_OVER', afterJson: { path: ['date'], equals: Y } } })).toBe(1);

    // The file of the originals can no longer be deleted: their copies on day Y link to them.
    session.user = { id: userId, tenantId, role: 'PLANNER', name: 'Planner', email: `planner@${slug}.test` };
    const del = await deleteBatch(new Request(`http://localhost/api/orders/${batch.id}`, { method: 'DELETE' }), { params: { batchId: batch.id } });
    expect(del.status).toBe(409);
    expect(((await del.json()) as { error: { code: string } }).error.code).toBe('BATCH_CARRIED');
    expect(await prisma.order.count({ where: { id: { in: [a.id, b.id] } } })).toBe(2);
    expect((await prisma.uploadBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe('CONFIRMED');
  });

  it('a split order: the part that left stays delivered and unmarked, the rest is brought forward, and a re-plan of its day still reconciles and dispatches', async () => {
    const P = isoPlus(80);
    const Q = isoPlus(81);
    const now = morningBefore(P);
    // Bigger than any truck (800 cases): planned in two parts, 800 + 200; the second finds no room.
    const big = await addOrder('C4', P, 1000, 'SO-P4');
    const small = await addOrder('C5', P, 10, 'SO-P5');
    const c4 = await customerId('C4');
    solverMode.unservedStops = new Set([`${c4}#2`]);
    const planP = await optimize(P, now);
    solverMode.unservedStops = new Set();
    const parts = await prisma.routeAssignment.findMany({ where: { runId: planP.id, orderId: big.id }, include: { load: true } });
    expect(parts).toHaveLength(1);
    const partLoad = parts[0]!.load!;
    const leftCases = parts[0]!.portionCases!;
    expect(leftCases).toBeGreaterThan(0);
    expect(leftCases).toBeLessThan(1000);
    expect(await prisma.unservedOrder.count({ where: { orderId: big.id, scenario: { runId: planP.id } } })).toBe(1);
    // Its part leaves the depot.
    for (const s of ['LOCKED', 'DISPATCHED'] as const) await updateLoad(tenantId, planP.id, partLoad.id, { status: s }, user(), everyRole);

    // The morning of Q: only the rest of the split order is open (the small order's load never left, it stays).
    const preview = await carryOverPreview(tenantId, depotId, Q, { now: onDay(Q) });
    const cand = preview.candidates.find((c) => c.orderId === big.id)!;
    expect([cand.cases, cand.orderCases, cand.partial]).toEqual([1000 - leftCases, 1000, true]);
    const res = await bringForward(tenantId, depotId, Q, [{ orderId: big.id, cases: cand.cases }], { id: userId }, { now: onDay(Q) });
    expect(res).toMatchObject({ orders: 1, cases: 1000 - leftCases });
    const copy = await prisma.order.findFirstOrThrow({ where: { carriedFromOrderId: big.id }, include: { lines: true } });
    expect([copy.totalCases, copy.lines.map((l) => [l.salesOrderNo, l.cases])]).toEqual([1000 - leftCases, [['SO-P4', 1000 - leftCases]]]);

    // Day P's plan: the dispatched part is delivered, never "carried over" (its unserved rest is).
    const detail = (await getPlanDetail(tenantId, planP.id))!;
    const out = detail.loads.find((l) => l.id === partLoad.id)!;
    expect([out.status, out.carriedAway, out.stops.map((s) => s.carriedTo)]).toEqual(['DISPATCHED', 0, [null]]);
    expect(detail.unserved.find((u) => u.orderId === big.id)?.carriedTo).toBe(Q);
    const sheet = driverPackModel(detail, { tenantName: 'NMWC', loadIds: [partLoad.id] }).sheets.flatMap((s) => s.stops);
    expect(sheet.map((s) => s.carried)).toEqual([null]);

    // Re-plan day P (the small order is still open there): the split order stays only through its
    // dispatched part, and the new version reconciles, so its new load can be locked and dispatched.
    const rp = await replan(tenantId, planP.id, 'REOPTIMIZE', null, user(), null, {}, undefined, { now });
    expect(rp.status).toBe(202);
    const v2 = await jobsDone(String(rp.body.runId));
    expect(v2.status).toBe('READY');
    const recon = v2.reconciliationJson as { ok: boolean; problems: string[]; uploadedCases: number; plannedCases: number; unservedCases: number };
    expect(recon.problems).toEqual([]);
    expect(recon.ok).toBe(true);
    expect([recon.uploadedCases, recon.plannedCases, recon.unservedCases]).toEqual([leftCases + 10, leftCases + 10, 0]);
    const kept = (await prisma.planLoad.findMany({ where: { runId: v2.id, carriedFromLoadId: partLoad.id } }))[0]!;
    expect(kept.status).toBe('DISPATCHED');
    const smallLoad = await loadOf(v2.id, small.id);
    expect(smallLoad.status).toBe('PLANNED');
    for (const s of ['LOCKED', 'DISPATCHED'] as const) await updateLoad(tenantId, v2.id, smallLoad.id, { status: s }, user(), everyRole);
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: smallLoad.id } })).status).toBe('DISPATCHED');
  });

  it('the same sales-order line entered again for the next day: only the newer order is brought forward, and the older one never after it', async () => {
    const A = isoPlus(100);
    const B = isoPlus(101);
    const C = isoPlus(102);
    const E = isoPlus(103);
    // Never delivered on A; sales entered the same line again in B's file (the intake only warns); not delivered on B either.
    const o1 = await addOrder('C6', A, 15, 'SO-SAME');
    const o2 = await addOrder('C6', B, 15, 'so-same');

    // The morning of C: both are listed; only the newer one (B) is ticked, the older one says why.
    const pv = await carryOverPreview(tenantId, depotId, C, { now: onDay(C) });
    const mine = pv.candidates.filter((c) => c.orderId === o1.id || c.orderId === o2.id);
    expect(mine.map((c) => [c.orderId, c.blocked?.code ?? null])).toEqual([
      [o1.id, 'SAME_LINE_LATER'],
      [o2.id, null],
    ]);
    expect(mine[0]!.blocked?.text).toBe(`Sales order SO-SAME (W-500) is also open on ${fmtDayMonth(B)}: only that order is brought forward.`);
    const res = await bringForward(tenantId, depotId, C, [{ orderId: o2.id, cases: 15 }], { id: userId }, { now: onDay(C) });
    expect(res.orders).toBe(1);

    // Still on C, planning E (tomorrow): B is carried, its copy is on C - today, so it is listed as
    // today's (never planned, not ticked). The older order is listed with the reason and never
    // ticked: only the copy can be brought forward; bringing the older one forward is refused.
    const next = await carryOverPreview(tenantId, depotId, E, { now: onDay(C) });
    const old = next.candidates.find((c) => c.orderId === o1.id)!;
    expect(old.blocked).toEqual({
      code: 'SAME_LINE_LATER',
      text: `Sales order SO-SAME (W-500) is also open today (${fmtDayMonth(C)}): only that order can be brought forward.`,
    });
    const copyOfB = next.candidates.find((c) => c.ofToday && c.salesOrders.includes('so-same'))!;
    expect([copyOfB.date, copyOfB.firstDate, copyOfB.blocked]).toEqual([C, B, null]);
    expect([...defaultCarrySelection(next.candidates)].filter((id) => id === o1.id || id === copyOfB.orderId)).toEqual([]);
    const refused = await bringForward(tenantId, depotId, E, [{ orderId: o1.id, cases: 15 }], { id: userId }, { now: onDay(C) }).catch((e: unknown) => e);
    expect((refused as PlanError).details).toMatchObject({ code: 'CARRY_OVER_CHANGED' });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o1.id } })).carriedToOrderId).toBeNull();
    // The line exists once from C on: the copy of the newer order.
    const lines = await prisma.orderLine.findMany({ where: { salesOrderNo: { in: ['SO-SAME', 'so-same'] }, order: { tenantId, deliveryDate: { gte: new Date(`${C}T00:00:00Z`) } } } });
    expect(lines).toHaveLength(1);
  });

  it("at night: today's leftovers are listed as today's and none is ticked; the ticked ones go to tomorrow, an unticked one stays on today", async () => {
    const T = isoPlus(120); // today, on the clock given
    const N = isoPlus(121); // tomorrow
    const night = atNight(T);
    const plannedAhead = morningBefore(T);
    // Tomorrow is planned and its load locked tonight (NMWC loads tomorrow's trucks after 20:00).
    const ownN = await addOrder('C6', N, 8, 'SO-N6');
    const planN = await optimize(N, plannedAhead);
    const lockedN = await loadOf(planN.id, ownN.id);
    await updateLoad(tenantId, planN.id, lockedN.id, { status: 'LOCKED' }, user(), everyRole);

    // Today: C2 on a load locked last night that has not left, C5 on an afternoon trip still Planned, C3 unserved.
    const o2 = await addOrder('C2', T, 20, 'SO-T2');
    const o3 = await addOrder('C3', T, 30, 'SO-T3');
    const o5 = await addOrder('C5', T, 12, 'SO-T5');
    solverMode.unserved = new Set([await customerId('C3')]);
    const planT = await optimize(T, plannedAhead);
    solverMode.unserved = new Set();
    const l2 = await loadOf(planT.id, o2.id);
    const l5 = await loadOf(planT.id, o5.id);
    // One stop per load, trucks in turn: each is the first load of its own truck.
    expect(l2.truckId).not.toBe(l5.truckId);
    await updateLoad(tenantId, planT.id, l2.id, { status: 'LOCKED' }, user(), everyRole);

    // Planning today itself: today's orders are never listed (never brought forward to their own day).
    expect((await carryOverPreview(tenantId, depotId, T, { now: night })).candidates.filter((c) => c.date === T)).toEqual([]);

    // Planning tomorrow at night: today's leftovers are listed as today's, none ticked.
    const pv = await carryOverPreview(tenantId, depotId, N, { now: night });
    expect(pv).toMatchObject({ today: T, to: T, orders: 0, cases: 0, todayOrders: 3, todayCases: 62, blocked: 0 });
    expect(pv.candidates.map((c) => [c.customerCode, c.ofToday, c.why.map((w) => w.kind), c.blocked])).toEqual([
      ['C2', true, ['NOT_LEFT'], null],
      ['C3', true, ['UNSERVED'], null],
      ['C5', true, ['NOT_LEFT'], null],
    ]);
    expect(pv.candidates[0]!.why[0]!.text).toMatch(/: has not left the depot yet$/);
    expect(defaultCarrySelection(pv.candidates).size).toBe(0);

    // Sent as "select all" would (no Today tick): refused, nothing carried.
    const implied = await bringForward(tenantId, depotId, N, pv.candidates.map((c) => ({ orderId: c.orderId, cases: c.cases })), { id: userId }, { now: night }).catch((e: unknown) => e);
    expect(implied).toBeInstanceOf(PlanError);
    expect((implied as PlanError).details).toMatchObject({ code: 'TODAY_NOT_SELECTED' });
    expect(await prisma.order.count({ where: { tenantId, carriedFromOrderId: { in: [o2.id, o3.id, o5.id] } } })).toBe(0);
    // Never to today itself (D must be later than the order's day).
    const toToday = await bringForward(tenantId, depotId, T, [{ orderId: o5.id, cases: 12, today: true }], { id: userId }, { now: night }).catch((e: unknown) => e);
    expect((toToday as PlanError).details).toMatchObject({ code: 'CARRY_OVER_CHANGED' });

    // The dispatcher ticks C2 (its truck will not go out again today) and C3 under Today; C5 stays unticked.
    const before = await planRows(planT.id);
    const sel = carrySelectionPayload(pv.candidates, new Set([o2.id, o3.id]));
    expect(sel).toEqual([
      { orderId: o2.id, cases: 20, today: true },
      { orderId: o3.id, cases: 30, today: true },
    ]);
    const res = await bringForward(tenantId, depotId, N, sel, { id: userId }, { now: night });
    // Tomorrow already has a plan in use: late, and RE-PLAN adds them.
    expect(res).toMatchObject({ orders: 2, cases: 50, late: true, replanNeeded: true, planId: planN.id, skipped: [] });
    const copies = await prisma.order.findMany({ where: { tenantId, carriedFromOrderId: { in: [o2.id, o3.id] } }, orderBy: { totalCases: 'asc' } });
    expect(copies.map((c) => [c.carriedFromOrderId, c.deliveryDate.toISOString().slice(0, 10), c.carriedFromDate?.toISOString().slice(0, 10), c.totalCases, c.isLate])).toEqual([
      [o2.id, N, T, 20, true],
      [o3.id, N, T, 30, true],
    ]);

    // Today: the originals are closed like an earlier day's, today's plan rows are exactly as they were, C5 is still today's.
    expect(await planRows(planT.id)).toEqual(before);
    const dT = await getDayOverview(tenantId, { date: T, depotId });
    expect(dT.orders.count).toBe(1);
    expect(dT.carriedOut).toEqual({ orders: 2, cases: 50, toDates: [N] });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o5.id } })).carriedToOrderId).toBeNull();
    // C2's load (loaded last night) cannot go out today with it: the 409 says so and says to unlock it.
    for (const s of ['LOADING', 'DISPATCHED'] as const) {
      const refused = await updateLoad(tenantId, planT.id, l2.id, { status: s }, user(), everyRole, { now: night }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(PlanError);
      expect((refused as PlanError).details).toMatchObject({ code: 'ORDERS_CARRIED', orderIds: [o2.id] });
      expect((refused as PlanError).message).toContain(
        `its cases were brought forward to ${fmtDayMonth(N)} and are planned there, so it does not go out today. Unlock it (put it back to Planned)`,
      );
    }
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: l2.id } })).status).toBe('LOCKED');
    // The plan version page (no day screen around it) says the same on the load's badge: the plan detail gives today.
    const pageT = (await getPlanDetail(tenantId, planT.id, { now: night }))!;
    expect(pageT.today).toBe(T);
    const badge = carriedLoadTitle(pageT.loads.find((l) => l.id === l2.id)!, pageT);
    expect(badge).toContain(`its cases were brought forward to ${fmtDayMonth(N)} and are planned there, so it does not go out today. Unlock it (put it back to Planned)`);
    expect(badge).toContain('A later locked or loading load of the same truck must be unlocked first.');
    // The unticked C5 stays today's: its load can still be locked and dispatched today.
    for (const s of ['LOCKED', 'DISPATCHED'] as const) await updateLoad(tenantId, planT.id, l5.id, { status: s }, user(), everyRole, { now: night });
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: l5.id } })).status).toBe('DISPATCHED');
    // Read again: nothing of today is left (C2 and C3 were brought forward, C5's load left the depot).
    expect((await carryOverPreview(tenantId, depotId, N, { now: night })).candidates).toEqual([]);

    // Tomorrow: RE-PLAN adds the copies around the load locked tonight; C5 is not in it.
    const rp = await replan(tenantId, planN.id, 'REOPTIMIZE', null, user(), null, {}, undefined, { now: night });
    expect(rp.status).toBe(202);
    expect(rp.body.reason).toBe('LATE_ORDER');
    const v2 = await jobsDone(String(rp.body.runId));
    expect(v2.status).toBe('READY');
    const loads = await prisma.planLoad.findMany({ where: { runId: v2.id }, include: { assignments: true } });
    const kept = loads.find((l) => l.carriedFromLoadId === lockedN.id)!;
    expect([kept.status, kept.assignments.map((a) => a.orderId)]).toEqual(['LOCKED', [ownN.id]]);
    const sent = (await prisma.runJob.findFirstOrThrow({ where: { runId: v2.id } })).requestJson as unknown as DispatchRequest;
    expect(sent.stops.flatMap((s) => s.order_ids).sort()).toEqual(copies.map((c) => c.id).sort());
  });
});
