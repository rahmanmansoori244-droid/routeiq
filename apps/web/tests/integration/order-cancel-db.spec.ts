/**
 * CANCEL ORDER AND POSTPONE ORDER (owner request of the first live night, 12 Oct 2026) on real
 * PostgreSQL. Library level like ./carry-over.spec.ts: the real route handlers, the plan service,
 * Prisma and the database; the session is faked (vi.mock of lib/auth) and the optimizer is faked in
 * this process (one stop per load, trucks in turn). The web server and the solver are not used. Needs
 * DATABASE_URL (migrated).
 *
 *  1. Cancel before the day is planned: the order leaves the day (counts, scope) and is listed as
 *     cancelled with its reason and who; OPTIMIZE plans the other order only; the same invoice
 *     re-uploaded for that day stays skipped and the message says it was cancelled; Undo opens it
 *     again (pending for RE-PLAN). Audited both ways.
 *  2. Cancel an order on a PLANNED load: that load is refused Lock (409 ORDERS_CANCELLED), the day
 *     and the plan screen say so; RE-PLAN (sent as REOPTIMIZE) becomes MANUAL_ADJUSTMENT, leaves the
 *     cancelled order out, and the other order's new load locks.
 *  3. An order on a LOCKED load: Cancel and Postpone are refused (409 ORDER_ON_LOCKED_LOAD, naming the
 *     truck and load: unlock first); nothing changes.
 *  4. Postpone an order of a future day: the copy is on the later day (carried mark, intake keys, late
 *     reason "Postponed from ..."), the original leaves its day and its planned load is refused Lock
 *     (ORDERS_CARRIED); a day outside the range is refused; Undo bring forward removes the copy; a
 *     cancelled copy cannot be undone that way (COPY_CANCELLED).
 *  5. A cancel after the request of an OPTIMIZE was built: its start is refused (409 ORDERS_CHANGED).
 *  6. Another company's order id answers 404 on all three routes and is not touched; a VIEWER is
 *     refused (403).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';

/** The signed-in user for the routes called directly. */
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
    const loads: PlannedLoad[] = req.stops.map((s, i) => {
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
      unserved: [],
      warnings: [],
    };
    return { run_id: req.run_id, engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, scenarios: [sc], warnings: [] };
  }
  return { SolverError, callDispatchSolver: vi.fn(async (req: DispatchRequest) => fakeSolve(req)) };
});

import { prisma as libPrisma } from '@/lib/db';
import { PlanError } from '@/lib/dispatch/plan-errors';
import { buildDispatchRequest, getOrCreatePlan, updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { getDayOverview } from '@/lib/dispatch/day-overview';
import { undoCarry } from '@/lib/dispatch/carry-over';
import { cancelOrder } from '@/lib/dispatch/order-cancel';
import { replan, startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { validateIntake } from '@/lib/dispatch/intake-server';
import { addDaysIso } from '@/lib/dispatch/time';
import { POST as cancelRoute } from '@/app/api/dispatch/orders/[id]/cancel/route';
import { POST as uncancelRoute } from '@/app/api/dispatch/orders/[id]/uncancel/route';
import { POST as postponeRoute } from '@/app/api/dispatch/orders/[id]/postpone/route';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `cancel-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const otherSlug = `cancel-x-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let userId = '';
let viewerId = '';
let depotId = '';
let productId = '';
const user = () => ({ id: userId, role: 'PLANNER' });
const everyRole = () => true;
const asPlanner = () => {
  session.user = { id: userId, tenantId, role: 'PLANNER', name: 'Planner Salim', email: `planner@${slug}.test` };
};

/** Delivery days far from today on the real clock, so "today" never interferes. */
function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dateOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });
const post = (url: string, json?: unknown) =>
  new Request(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
const cancel = async (id: string, json: unknown = { reason: 'CUSTOMER_CANCELLED' }) => answer(await cancelRoute(post(`/api/dispatch/orders/${id}/cancel`, json), { params: { id } }));
const uncancel = async (id: string) => answer(await uncancelRoute(post(`/api/dispatch/orders/${id}/uncancel`), { params: { id } }));
const postpone = async (id: string, json: unknown) => answer(await postponeRoute(post(`/api/dispatch/orders/${id}/postpone`, json), { params: { id } }));

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

async function customerId(code: string, tid = tenantId) {
  return (await prisma.customer.findFirstOrThrow({ where: { tenantId: tid, code } })).id;
}

/** A confirmed order with sales-order lines and their intake keys, as the file intake writes them. */
async function addOrder(code: string, day: string, cases: number, sos: string[], opts: { tid?: string; depot?: string; product?: string } = {}) {
  const tid = opts.tid ?? tenantId;
  const cid = await customerId(code, tid);
  const per = Math.floor(cases / sos.length);
  const o = await prisma.order.create({
    data: {
      tenantId: tid,
      customerId: cid,
      depotId: opts.depot ?? depotId,
      deliveryDate: dateOf(day),
      totalCases: per * sos.length,
      totalWeightKg: per * sos.length * 12,
      status: 'VALIDATED',
      priority: 3,
      lines: { create: sos.map((so) => ({ productId: opts.product ?? productId, cases: per, weightKg: per * 12, salesOrderNo: so })) },
    },
    include: { lines: true },
  });
  for (const l of o.lines) {
    await prisma.intakeLineKey.create({ data: { tenantId: tid, deliveryDate: dateOf(day), salesOrderNorm: l.salesOrderNo!.toUpperCase(), customerId: cid, productId: l.productId, orderLineId: l.id } });
  }
  return o;
}

async function optimize(day: string) {
  const { run } = await getOrCreatePlan(tenantId, depotId, day, userId);
  const res = await startDispatchOptimize(tenantId, run.id, user(), null);
  expect(res.status).toBe(202);
  const done = await jobsDone(run.id);
  expect(done.status).toBe('READY');
  return done;
}

async function loadOf(runId: string, orderId: string) {
  const a = await prisma.routeAssignment.findFirstOrThrow({ where: { runId, orderId }, include: { load: { include: { truck: true } } } });
  return a.load!;
}

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Cancel ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null, shiftStartMin: 360, reloadMinutes: 30 } });
  userId = (await prisma.user.create({ data: { tenantId, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner Salim', role: 'PLANNER' } })).id;
  viewerId = (await prisma.user.create({ data: { tenantId, email: `viewer@${slug}.test`, passwordHash: 'x', name: 'Viewer', role: 'VIEWER' } })).id;
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'GHL', name: 'Ghala', lat: 23.58, lng: 58.39 } })).id;
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({ data: { tenantId, depotId, code, capacityCases: 800, capacityWeightKg: 12000, fixedCostPerDay: 25, costPerKm: 0.12 } });
  }
  productId = (await prisma.product.create({ data: { tenantId, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 12 } })).id;
  const pins: [string, number, number][] = [['C1', 23.6, 58.41], ['C2', 23.61, 58.45], ['C3', 23.55, 58.3], ['C4', 23.62, 58.5], ['C5', 23.57, 58.36], ['C6', 23.59, 58.38]];
  for (const [code, lat, lng] of pins) {
    await prisma.customer.create({ data: { tenantId, code, name: `Shop ${code}`, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
  }
});

afterAll(async () => {
  await cleanupTenant(slug);
  await cleanupTenant(otherSlug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('cancel and postpone one order (owner request 12 Oct 2026)', () => {
  it('1. cancel before planning: out of the day and of OPTIMIZE, re-upload stays skipped, Undo opens it again', async () => {
    asPlanner();
    const DAY = isoPlus(30);
    const keep = await addOrder('C1', DAY, 10, ['SO-K1']);
    const gone = await addOrder('C2', DAY, 20, ['SO-G1', 'SO-G2']);

    const res = await cancel(gone.id, { reason: 'OTHER', note: 'shop closed for Eid' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orderId: gone.id, already: false, replanNeeded: false, onPlannedLoads: [] });
    expect(res.body.data.message).toBe('Order of Shop C2 (C2) (SO SO-G1, SO-G2; 20 cases) cancelled. It was not planned yet: nothing else to do.');
    const row = await prisma.order.findUniqueOrThrow({ where: { id: gone.id } });
    expect([row.cancelledById, row.cancelReason, row.cancelNote, row.status, !!row.cancelledAt]).toEqual([userId, 'OTHER', 'shop closed for Eid', 'VALIDATED', true]);
    // Cancelling it again changes nothing.
    expect((await cancel(gone.id)).body.data).toMatchObject({ already: true });
    // Other needs a note.
    expect((await cancel(keep.id, { reason: 'OTHER' })).status).toBe(400);

    const day = await getDayOverview(tenantId, { date: DAY, depotId });
    expect(day.orders).toMatchObject({ count: 1, cases: 10 });
    expect(day.cancelled).toEqual([
      expect.objectContaining({ orderId: gone.id, cases: 20, salesOrders: ['SO-G1', 'SO-G2'], reasonText: 'Other: shop closed for Eid', by: 'Planner Salim', onPlannedLoads: [], canUndo: true }),
    ]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: 'ORDER_CANCELLED', entityId: gone.id } });
    expect(audit.afterJson).toMatchObject({ invoices: ['SO-G1', 'SO-G2'], cases: 20, reason: 'OTHER', note: 'shop closed for Eid', date: DAY });

    // OPTIMIZE plans the other order only.
    const plan = await optimize(DAY);
    expect((await prisma.routeAssignment.findMany({ where: { runId: plan.id } })).map((a) => a.orderId)).toEqual([keep.id]);
    expect(await prisma.unservedOrder.count({ where: { orderId: gone.id } })).toBe(0);

    // The same invoice re-uploaded for that day: skipped, and it says it was cancelled.
    const v = await validateIntake(tenantId, [{ sales_order_no: 'SO-G1', delivery_date: DAY, customer_code: 'C2', product_code: 'W-500', cases: '10' }], { depotId });
    expect(v.lines).toEqual([]);
    expect(v.duplicates.map((d) => d.message)).toEqual([expect.stringContaining('Skipped. It was CANCELLED on ')]);
    expect(v.duplicates[0]!.message).toContain('by Planner Salim, so it stays cancelled');

    // Undo: open again, waiting for RE-PLAN.
    const undone = await uncancel(gone.id);
    expect(undone.status).toBe(200);
    expect(undone.body.data).toMatchObject({ orderId: gone.id, replanNeeded: true });
    expect(undone.body.data.message).toMatch(/RE-PLAN adds it/);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: gone.id }, select: { cancelledAt: true, cancelledById: true, cancelReason: true, cancelNote: true } })).toEqual({
      cancelledAt: null,
      cancelledById: null,
      cancelReason: null,
      cancelNote: null,
    });
    const after = await getDayOverview(tenantId, { date: DAY, depotId });
    expect(after.cancelled).toEqual([]);
    expect(after.pending).toMatchObject({ count: 1, orderIds: [gone.id] });
    expect(await prisma.auditLog.count({ where: { tenantId, action: 'ORDER_CANCEL_UNDONE', entityId: gone.id } })).toBe(1);
    // Nothing to undo any more.
    expect((await uncancel(gone.id)).status).toBe(409);
  });

  it('2. cancel on a PLANNED load: Lock refused (ORDERS_CANCELLED) until RE-PLAN leaves it out', async () => {
    asPlanner();
    const DAY = isoPlus(32);
    const a = await addOrder('C3', DAY, 30, ['SO-A']);
    const b = await addOrder('C4', DAY, 40, ['SO-B']);
    const v1 = await optimize(DAY);
    const lb = await loadOf(v1.id, b.id);

    const res = await cancel(b.id, { reason: 'NO_ACCESS_SMALL_TRUCK' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ replanNeeded: true, onPlannedLoads: [`${lb.truck.code} L${lb.loadNo}`] });
    expect(res.body.data.message).toMatch(/RE-PLAN the day to take it off/);

    const refused = await updateLoad(tenantId, v1.id, lb.id, { status: 'LOCKED' }, user(), everyRole).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PlanError);
    expect((refused as PlanError).status).toBe(409);
    expect((refused as PlanError).details).toMatchObject({ code: 'ORDERS_CANCELLED', orderIds: [b.id] });
    expect((refused as PlanError).message).toMatch(/holds 1 cancelled order\(s\): C4\. .*holds nothing else/);
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: lb.id } })).status).toBe('PLANNED');

    const day = await getDayOverview(tenantId, { date: DAY, depotId });
    expect(day.outdated.cancelledOnPlan).toBe(1);
    expect(day.cancelled[0]).toMatchObject({ orderId: b.id, onPlannedLoads: [`${lb.truck.code} L${lb.loadNo}`] });
    const detail = (await getPlanDetail(tenantId, v1.id))!;
    const dl = detail.loads.find((l) => l.id === lb.id)!;
    expect([dl.cancelledHere, dl.stops[0]!.cancelled]).toEqual([1, true]);

    // RE-PLAN as the day screen sends it: the other orders keep their trucks (MANUAL_ADJUSTMENT).
    const rp = await replan(tenantId, v1.id, 'REOPTIMIZE', null, user(), null);
    expect(rp.status).toBe(202);
    expect(rp.body.reason).toBe('MANUAL_ADJUSTMENT');
    const v2 = await jobsDone(String(rp.body.runId));
    expect(v2.status).toBe('READY');
    expect((await prisma.routeAssignment.findMany({ where: { runId: v2.id } })).map((x) => x.orderId)).toEqual([a.id]);
    const la2 = await loadOf(v2.id, a.id);
    await updateLoad(tenantId, v2.id, la2.id, { status: 'LOCKED' }, user(), everyRole);
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: la2.id } })).status).toBe('LOCKED');
    const again = await getDayOverview(tenantId, { date: DAY, depotId });
    expect(again.outdated.cancelledOnPlan).toBe(0);
    expect(again.cancelled[0]).toMatchObject({ orderId: b.id, onPlannedLoads: [] });
  });

  it('3. an order on a LOCKED load: cancel and postpone refused (unlock first), nothing changes', async () => {
    asPlanner();
    const DAY = isoPlus(34);
    const o = await addOrder('C5', DAY, 15, ['SO-L']);
    const v1 = await optimize(DAY);
    const l = await loadOf(v1.id, o.id);
    await updateLoad(tenantId, v1.id, l.id, { status: 'LOCKED' }, user(), everyRole);

    const c = await cancel(o.id);
    expect(c.status).toBe(409);
    expect(c.body.error).toMatchObject({ code: 'ORDER_ON_LOCKED_LOAD' });
    expect(c.body.error.error).toContain(`on ${l.truck.code} load ${l.loadNo} (locked)`);
    expect(c.body.error.error).toContain('unlock the load first (a loading load goes Back to locked first), then cancel');
    const p = await postpone(o.id, { date: addDaysIso(DAY, 1), reason: 'POSTPONED_BY_SALES' });
    expect(p.status).toBe(409);
    expect(p.body.error).toMatchObject({ code: 'ORDER_ON_LOCKED_LOAD' });
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([row.cancelledAt, row.carriedToOrderId]).toEqual([null, null]);
    expect(await prisma.auditLog.count({ where: { tenantId, entityId: o.id, action: { in: ['ORDER_CANCELLED', 'ORDER_POSTPONED'] } } })).toBe(0);
  });

  it('4. postpone an order of a future day: copy on the later day, original out of its day, Undo', async () => {
    asPlanner();
    const DAY = isoPlus(36);
    const TO = addDaysIso(DAY, 2);
    const o = await addOrder('C6', DAY, 24, ['SO-P1', 'SO-P2']);
    const v1 = await optimize(DAY);
    const l = await loadOf(v1.id, o.id);

    // Outside the range: more than 14 days later, or not after the order's day.
    expect((await postpone(o.id, { date: addDaysIso(DAY, 15), reason: 'POSTPONED_BY_SALES' })).body.error).toMatchObject({ code: 'POSTPONE_DATE' });
    expect((await postpone(o.id, { date: DAY, reason: 'POSTPONED_BY_SALES' })).body.error).toMatchObject({ code: 'POSTPONE_DATE' });

    const res = await postpone(o.id, { date: TO, reason: 'POSTPONED_BY_SALES', note: 'customer asked' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ orderId: o.id, fromDate: DAY, toDate: TO, cases: 24, onPlannedLoads: [`${l.truck.code} L${l.loadNo}`], replanTo: false });
    const copy = await prisma.order.findUniqueOrThrow({ where: { id: res.body.data.copyId }, include: { lines: true } });
    expect(copy.deliveryDate.toISOString().slice(0, 10)).toBe(TO);
    expect([copy.carriedFromOrderId, copy.carriedFromDate?.toISOString().slice(0, 10), copy.totalCases, copy.lateReason]).toEqual([
      o.id,
      DAY,
      24,
      expect.stringMatching(/^Postponed from .*: Postponed by sales\/customer: customer asked\.$/),
    ]);
    expect(copy.lines.map((x) => [x.salesOrderNo, x.cases]).sort()).toEqual([['SO-P1', 12], ['SO-P2', 12]]);
    expect((await prisma.intakeLineKey.findMany({ where: { tenantId, deliveryDate: dateOf(TO) } })).map((k) => k.salesOrderNorm).sort()).toEqual(['SO-P1', 'SO-P2']);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).carriedToOrderId).toBe(copy.id);
    expect(await prisma.auditLog.count({ where: { tenantId, action: 'ORDER_POSTPONED', entityId: o.id } })).toBe(1);

    // The original is out of its day; the copy is the later day's, marked carried.
    const from = await getDayOverview(tenantId, { date: DAY, depotId });
    expect(from.orders.count).toBe(0);
    expect(from.carriedOut).toMatchObject({ orders: 1, cases: 24, toDates: [TO] });
    const to = await getDayOverview(tenantId, { date: TO, depotId });
    expect(to.carriedIn).toEqual([expect.objectContaining({ orderId: copy.id, fromDate: DAY })]);
    // Its planned load on the original day cannot be locked with it.
    const refused = await updateLoad(tenantId, v1.id, l.id, { status: 'LOCKED' }, user(), everyRole).catch((e: unknown) => e);
    expect((refused as PlanError).details).toMatchObject({ code: 'ORDERS_CARRIED' });
    // Postponing it again from its old day is refused (it was moved already).
    expect((await postpone(o.id, { date: addDaysIso(DAY, 3), reason: 'POSTPONED_BY_SALES' })).body.error).toMatchObject({ code: 'ORDER_CARRIED' });

    // Undo bring forward removes the copy: the order is open on its own day again.
    await undoCarry(tenantId, o.id, { id: userId });
    expect(await prisma.order.count({ where: { id: copy.id } })).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).carriedToOrderId).toBeNull();

    // A copy cancelled on its day is not undone that way (undo the cancel first).
    const again = await postpone(o.id, { date: TO, reason: 'CUSTOMER_CANCELLED' });
    expect(again.status).toBe(201);
    expect((await cancel(again.body.data.copyId)).status).toBe(200);
    const blocked = await undoCarry(tenantId, o.id, { id: userId }).catch((e: unknown) => e);
    expect((blocked as PlanError).details).toMatchObject({ code: 'COPY_CANCELLED' });
  });

  it('5. a cancel after an OPTIMIZE request was built: the start is refused, nothing is planned with it', async () => {
    asPlanner();
    const DAY = isoPlus(38);
    await addOrder('C1', DAY, 10, ['SO-R1']);
    const late = await addOrder('C2', DAY, 10, ['SO-R2']);
    const { run } = await getOrCreatePlan(tenantId, depotId, DAY, userId);
    const built = await buildDispatchRequest(tenantId, run.id);
    expect(built.scope.orderIds).toContain(late.id);
    await cancelOrder(tenantId, late.id, { reason: 'WRONG_OR_DUPLICATE', note: null }, { id: userId });
    const res = await startDispatchOptimize(tenantId, run.id, user(), null, { prebuilt: built });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ORDERS_CHANGED' });
    expect(await prisma.runJob.count({ where: { runId: run.id } })).toBe(0);
    // Built again, it plans the other order only.
    expect((await buildDispatchRequest(tenantId, run.id)).scope.orderIds).not.toContain(late.id);
  });

  it("6. another company's order answers 404 and is not touched; a VIEWER is refused (403)", async () => {
    const other = await prisma.tenant.create({ data: { slug: otherSlug, name: `Other ${otherSlug}`, country: 'Oman' } });
    await prisma.tenantConfig.create({ data: { tenantId: other.id, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
    const otherDepot = (await prisma.depot.create({ data: { tenantId: other.id, code: 'X', name: 'X', lat: 23.58, lng: 58.39 } })).id;
    const otherProduct = (await prisma.product.create({ data: { tenantId: other.id, code: 'W-500', name: 'Water', weightPerCaseKg: 12 } })).id;
    await prisma.customer.create({ data: { tenantId: other.id, code: 'C1', name: 'Theirs', branchKey: '__MAIN__', lat: 23.6, lng: 58.4 } });
    const DAY = isoPlus(40);
    const theirs = await addOrder('C1', DAY, 5, ['SO-X'], { tid: other.id, depot: otherDepot, product: otherProduct });

    asPlanner();
    expect((await cancel(theirs.id)).status).toBe(404);
    expect((await uncancel(theirs.id)).status).toBe(404);
    expect((await postpone(theirs.id, { date: addDaysIso(DAY, 1), reason: 'POSTPONED_BY_SALES' })).status).toBe(404);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: theirs.id } });
    expect([row.cancelledAt, row.carriedToOrderId]).toEqual([null, null]);

    const mine = await addOrder('C3', DAY, 5, ['SO-V']);
    session.user = { id: viewerId, tenantId, role: 'VIEWER', name: 'Viewer', email: `viewer@${slug}.test` };
    expect((await cancel(mine.id)).status).toBe(403);
    expect((await uncancel(mine.id)).status).toBe(403);
    expect((await postpone(mine.id, { date: addDaysIso(DAY, 1), reason: 'POSTPONED_BY_SALES' })).status).toBe(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: mine.id } })).cancelledAt).toBeNull();
  });
});
