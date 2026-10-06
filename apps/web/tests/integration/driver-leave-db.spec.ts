/**
 * THE DISPATCHER RUNS THE DRIVERS PAGE (owner request 6 Oct 2026) on real PostgreSQL, library level:
 * the real route handlers (drivers, trucks, driver leave), the plan service and the background job,
 * zod, Prisma and the database's own keys and CHECK constraints; the optimizer is faked in this test
 * process (vi.mock of the solver client: stop i on truck i % n, load floor(i / n) + 1) and the session
 * is faked (vi.mock of auth). Needs DATABASE_URL (migrated); the web server and the solver are not used.
 *
 *  1. The dispatcher (PLANNER) adds a driver and sets each truck's usual driver (TRUCK_USUAL_DRIVER_SET);
 *     another truck field is refused (403, nothing saved); a VIEWER changes nothing.
 *  2. Leave: Ali (T01's usual driver) away three days with Bob covering; an overlapping period is
 *     refused (409); the database refuses dates out of order and a driver covering himself.
 *  3. The day's first plan: T01 gets Bob (the cover), T02 Sam; the load says "Covers Ali".
 *  4. Sam's leave (no cover) is entered after planning: the answer warns he is still on loads; a re-plan
 *     leaves T02 without a driver ("No driver: Sam is on leave until ... - pick a driver", ON_LEAVE
 *     notes) and Dispatch is refused (rule 20) until the dispatcher picks Nasser.
 *  5. Frozen loads never change and a driver picked by hand stays: with T01 L1 locked (Bob) and T02 L2
 *     picked by hand (Nasser), Bob's own leave and a re-plan leave both as they are; T01 L2 gets no
 *     driver (Bob is away, Ali too).
 *  6. The day after the leave, Ali and Sam drive their trucks again by themselves.
 *  7. Every change is audited with the dispatcher; another company sees none of it.
 *  8. (review of 6 Oct 2026) The cover's load is marked (PlanLoad.driverIsCover); the leave moved off the
 *     day, a re-plan gives the usual driver back with a COVER note.
 *  9. (review) Two depots: the cover is the usual driver of a truck of the other depot, planned that day
 *     with him; this depot's plan does not give him ("No driver: Ali is on leave ... - pick a driver").
 * 10. (demo of 7 Oct 2026) Sam's leave entered after planning, nobody re-plans: Lock (through the route),
 *     Loading and Dispatch are refused 409 DRIVER_ON_LEAVE until the dispatcher's answer; each answer is
 *     in the status change's audit row; a load that left before the leave was entered completes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => (session.user ? { user: session.user } : null)) }));

vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  function fakeSolve(req: DispatchRequest): DispatchResponse {
    const frozenNos = new Map(req.trucks.map((t) => [t.id, (t.frozen_trips ?? []).length]));
    const perTruck = new Map<string, number>();
    const loads: PlannedLoad[] = req.stops.map((s, i) => {
      const truck = req.trucks[i % req.trucks.length]!;
      const k = perTruck.get(truck.id) ?? 0;
      perTruck.set(truck.id, k + 1);
      const loadNo = (frozenNos.get(truck.id) ?? 0) + k + 1;
      const depart = 360 + loadNo * 150;
      return {
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
      total_duration_min: loads.length * 90,
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

import { POST as createDriver } from '@/app/api/drivers/route';
import { PATCH as patchTruck } from '@/app/api/trucks/[id]/route';
import { GET as getLeave, POST as postLeave } from '@/app/api/drivers/[id]/leave/route';
import { PATCH as patchLeave } from '@/app/api/drivers/[id]/leave/[leaveId]/route';
import { PATCH as patchLoad } from '@/app/api/runs/[id]/loads/[loadId]/route';
import { prisma as libPrisma } from '@/lib/db';
import { getOrCreatePlan, updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { replan, startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { addDaysIso, fmtDayMonth, todayIso } from '@/lib/dispatch/time';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `leave-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const otherSlug = `leavb-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const ids = { tenant: '', other: '', admin: '', planner: '', viewer: '', depot: '', t1: '', t2: '', ali: '', sam: '', bob: '', nasser: '' };
const everyRole = () => true;
const D = addDaysIso(todayIso('Asia/Muscat'), 3);
const dateOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const as = (role: 'TENANT_ADMIN' | 'PLANNER' | 'VIEWER') => {
  const id = role === 'TENANT_ADMIN' ? ids.admin : role === 'PLANNER' ? ids.planner : ids.viewer;
  session.user = { id, tenantId: ids.tenant, role, name: role, email: `${role.toLowerCase()}@${slug}.test` };
};
const send = (method: string, body?: unknown) =>
  new Request('http://localhost/x', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });
const planner = () => ({ id: ids.planner, role: 'PLANNER' });

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

async function seedOrders(day: string, n: number, depotId = ids.depot) {
  const product = await prisma.product.findFirstOrThrow({ where: { tenantId: ids.tenant } });
  const customers = await prisma.customer.findMany({ where: { tenantId: ids.tenant }, orderBy: { code: 'asc' } });
  for (let i = 0; i < n; i++) {
    await prisma.order.create({
      data: {
        tenantId: ids.tenant,
        customerId: customers[i % customers.length]!.id,
        depotId,
        deliveryDate: dateOf(day),
        totalCases: 10,
        totalWeightKg: 100,
        status: 'VALIDATED',
        priority: 3,
        lines: { create: [{ productId: product.id, cases: 10, weightKg: 100, salesOrderNo: `SO-${day}-${depotId === ids.depot ? '' : 'S'}${i}` }] },
      },
    });
  }
}

/** Each load of a plan version: "T01:1" -> its driver's name (or "none"), "(by hand)" when picked by hand. */
async function driversOf(runId: string) {
  const loads = await prisma.planLoad.findMany({ where: { runId }, include: { truck: true, driver: true }, orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }] });
  return Object.fromEntries(loads.map((l) => [`${l.truck.code}:${l.loadNo}`, `${l.driver?.name ?? 'none'}${l.driverSetAt ? ' (by hand)' : ''}`]));
}
const loadOf = async (runId: string, truckId: string, loadNo: number) => prisma.planLoad.findFirstOrThrow({ where: { runId, truckId, loadNo } });

async function optimize(day: string, depotId = ids.depot) {
  const { run } = await getOrCreatePlan(ids.tenant, depotId, day, ids.planner);
  expect((await startDispatchOptimize(ids.tenant, run.id, planner(), null)).status).toBe(202);
  expect((await jobsDone(run.id)).status).toBe('READY');
  return run.id;
}
async function replanOf(runId: string) {
  const rp = await replan(ids.tenant, runId, 'REOPTIMIZE', null, planner(), null);
  expect(rp.status).toBe(202);
  const next = String(rp.body.runId);
  expect((await jobsDone(next)).status).toBe('READY');
  return next;
}

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Leave ${slug}`, country: 'Oman' } });
  ids.tenant = t.id;
  await prisma.tenantConfig.create({ data: { tenantId: t.id, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  for (const role of ['TENANT_ADMIN', 'PLANNER', 'VIEWER'] as const) {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role.toLowerCase()}@${slug}.test`, passwordHash: 'x', name: role, role } });
    if (role === 'TENANT_ADMIN') ids.admin = u.id;
    else if (role === 'PLANNER') ids.planner = u.id;
    else ids.viewer = u.id;
  }
  ids.depot = (await prisma.depot.create({ data: { tenantId: t.id, code: 'MCT', name: 'Muscat', lat: 23.568, lng: 58.392 } })).id;
  ids.t1 = (await prisma.truck.create({ data: { tenantId: t.id, depotId: ids.depot, code: 'T01', capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1 } })).id;
  ids.t2 = (await prisma.truck.create({ data: { tenantId: t.id, depotId: ids.depot, code: 'T02', capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1 } })).id;
  for (const [key, code, name] of [['ali', 'D01', 'Ali'], ['sam', 'D02', 'Sam'], ['bob', 'D03', 'Bob']] as const) {
    ids[key] = (await prisma.driver.create({ data: { tenantId: t.id, code, name } })).id;
  }
  await prisma.product.create({ data: { tenantId: t.id, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 10 } });
  for (const [code, lat, lng] of [['C1', 23.588, 58.41], ['C2', 23.6, 58.372], ['C3', 23.555, 58.335], ['C4', 23.61, 58.45]] as const) {
    await prisma.customer.create({ data: { tenantId: t.id, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
  }
  // Another company with a driver of the same code and leave of its own.
  const o = await prisma.tenant.create({ data: { slug: otherSlug, name: `Other ${otherSlug}`, country: 'Oman' } });
  ids.other = o.id;
  const od = await prisma.driver.create({ data: { tenantId: o.id, code: 'D01', name: 'Other Ali' } });
  await prisma.driverLeave.create({ data: { tenantId: o.id, driverId: od.id, fromDate: dateOf(D), untilDate: dateOf(D) } });
});

afterAll(async () => {
  session.user = null;
  await cleanupTenant(slug);
  await cleanupTenant(otherSlug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('the dispatcher keeps the drivers, their leave and the usual drivers; the plans follow', () => {
  it('1. adds a driver and sets the usual drivers; another truck field is refused; a viewer changes nothing', async () => {
    as('PLANNER');
    const created = await answer(await createDriver(send('POST', { code: 'D04', name: 'Nasser', phone: '+968 9555 0004' })));
    expect(created.status).toBe(201);
    ids.nasser = created.body.data.id;
    expect((await patchTruck(send('PATCH', { defaultDriverId: ids.ali }), { params: { id: ids.t1 } })).status).toBe(200);
    expect((await patchTruck(send('PATCH', { defaultDriverId: ids.sam }), { params: { id: ids.t2 } })).status).toBe(200);
    // The audit row reads for the owner: the truck's code and the drivers by name (demo of 7 Oct 2026).
    const set = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: ids.tenant, action: 'TRUCK_USUAL_DRIVER_SET', entityId: ids.t1 } });
    expect(set.afterJson).toEqual({ truck: 'T01', from: 'none', to: 'Ali', truckId: ids.t1, fromDriverId: null, toDriverId: ids.ali });
    expect(set.beforeJson).toBeNull();
    const refused = await answer(await patchTruck(send('PATCH', { capacityCases: 1, defaultDriverId: ids.bob }), { params: { id: ids.t1 } }));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 'ADMIN_ONLY_TRUCK_FIELD', fields: ['capacityCases'] });
    expect(await prisma.truck.findUniqueOrThrow({ where: { id: ids.t1 } })).toMatchObject({ capacityCases: 200, defaultDriverId: ids.ali });
    as('VIEWER');
    expect((await createDriver(send('POST', { code: 'D05', name: 'Nope' }))).status).toBe(403);
    expect((await patchTruck(send('PATCH', { defaultDriverId: null }), { params: { id: ids.t2 } })).status).toBe(403);
    expect((await prisma.truck.findUniqueOrThrow({ where: { id: ids.t2 } })).defaultDriverId).toBe(ids.sam);
  });

  it('2. Ali away three days with Bob covering; an overlap is refused; the database keeps dates in order and nobody covers himself', async () => {
    as('PLANNER');
    const added = await answer(await postLeave(send('POST', { from: D, until: addDaysIso(D, 2), coverDriverId: ids.bob, note: 'family' }), { params: { id: ids.ali } }));
    expect(added.status).toBe(201);
    expect(added.body.data.leave).toMatchObject({ from: D, until: addDaysIso(D, 2), coverName: 'Bob', phase: 'COMING' });
    const overlap = await answer(await postLeave(send('POST', { from: addDaysIso(D, 2), until: addDaysIso(D, 5) }), { params: { id: ids.ali } }));
    expect(overlap.status).toBe(409);
    expect(overlap.body.error).toMatchObject({ code: 'LEAVE_OVERLAP' });
    await expect(prisma.driverLeave.create({ data: { tenantId: ids.tenant, driverId: ids.ali, fromDate: dateOf(addDaysIso(D, 9)), untilDate: dateOf(addDaysIso(D, 8)) } })).rejects.toThrow(/DriverLeave_dates_in_order/);
    await expect(prisma.driverLeave.create({ data: { tenantId: ids.tenant, driverId: ids.ali, coverDriverId: ids.ali, fromDate: dateOf(addDaysIso(D, 9)), untilDate: dateOf(addDaysIso(D, 9)) } })).rejects.toThrow(
      /DriverLeave_cover_not_self/,
    );
    as('VIEWER');
    const list = await answer(await getLeave(send('GET'), { params: { id: ids.ali } }));
    expect(list.body.data.periods).toHaveLength(1);
  });

  let v1 = '';
  it("3. the day's first plan: Ali's truck gets Bob (the cover), Sam drives his own; the load says who Bob covers", async () => {
    await seedOrders(D, 4);
    v1 = await optimize(D);
    expect(await driversOf(v1)).toEqual({ 'T01:1': 'Bob', 'T01:2': 'Bob', 'T02:1': 'Sam', 'T02:2': 'Sam' });
    const detail = (await getPlanDetail(ids.tenant, v1))!;
    expect(detail.loads.find((l) => l.truckCode === 'T01' && l.loadNo === 1)!.driverNote).toBe(`Covers Ali (on leave until ${fmtDayMonth(addDaysIso(D, 2))})`);
    expect(detail.driversOnLeave).toEqual([{ driverId: ids.ali, until: addDaysIso(D, 2), coverDriverId: ids.bob }]);
  });

  let v2 = '';
  it('4. Sam away that day (no cover): warned he is still on loads; the re-plan leaves T02 without a driver and Dispatch is refused until one is picked', async () => {
    as('PLANNER');
    const sam = await answer(await postLeave(send('POST', { from: D, until: D }), { params: { id: ids.sam } }));
    expect(sam.status).toBe(201);
    expect(sam.body.data.warnings).toEqual([expect.stringMatching(/^Sam is still the driver of 2 load\(s\) planned on those days \(T02 · L1 on .*, T02 · L2 on /)]);
    v2 = await replanOf(v1);
    expect(await driversOf(v2)).toEqual({ 'T01:1': 'Bob', 'T01:2': 'Bob', 'T02:1': 'none', 'T02:2': 'none' });
    const detail = (await getPlanDetail(ids.tenant, v2))!;
    const note = `No driver: Sam is on leave until ${fmtDayMonth(D)} - pick a driver`;
    expect(detail.loads.filter((l) => l.truckCode === 'T02').map((l) => l.driverNote)).toEqual([note, note]);
    expect(detail.warnings.filter((w) => w.startsWith('Driver changed by this plan: T02'))).toHaveLength(2);
    expect(detail.warnings.every((w) => !w.startsWith('Driver changed') || w.includes(`because Sam is on leave until ${fmtDayMonth(D)}`))).toBe(true);

    const t2l1 = await loadOf(v2, ids.t2, 1);
    await updateLoad(ids.tenant, v2, t2l1.id, { status: 'LOCKED' }, planner(), everyRole);
    await expect(updateLoad(ids.tenant, v2, t2l1.id, { status: 'DISPATCHED' }, planner(), everyRole)).rejects.toMatchObject({ status: 409, details: { code: 'DRIVER_REQUIRED' } });
    await updateLoad(ids.tenant, v2, t2l1.id, { driverId: ids.nasser }, planner(), everyRole);
    await updateLoad(ids.tenant, v2, t2l1.id, { status: 'DISPATCHED' }, planner(), everyRole);
    expect(await loadOf(v2, ids.t2, 1)).toMatchObject({ status: 'DISPATCHED', driverId: ids.nasser });
  });

  it('5. frozen loads never change and a driver picked by hand stays: Bob away too, a re-plan keeps T01 L1 (locked, Bob) and T02 L2 (Nasser by hand)', async () => {
    const t1l1 = await loadOf(v2, ids.t1, 1);
    await updateLoad(ids.tenant, v2, t1l1.id, { status: 'LOCKED' }, planner(), everyRole);
    const t2l2 = await loadOf(v2, ids.t2, 2);
    await updateLoad(ids.tenant, v2, t2l2.id, { driverId: ids.nasser }, planner(), everyRole);
    as('PLANNER');
    expect((await postLeave(send('POST', { from: D, until: addDaysIso(D, 1) }), { params: { id: ids.bob } })).status).toBe(201);
    const lockedBefore = await loadOf(v2, ids.t1, 1);
    const v3 = await replanOf(v2);
    expect(await driversOf(v3)).toEqual({ 'T01:1': 'Bob', 'T01:2': 'none', 'T02:1': 'Nasser (by hand)', 'T02:2': 'Nasser (by hand)' });
    // The locked load is the same physical load, exactly as it was.
    const lockedAfter = await loadOf(v3, ids.t1, 1);
    expect(lockedAfter).toMatchObject({ status: 'LOCKED', driverId: ids.bob, departMin: lockedBefore.departMin, returnMin: lockedBefore.returnMin, carriedFromLoadId: lockedBefore.id });
    const detail = (await getPlanDetail(ids.tenant, v3))!;
    expect(detail.loads.find((l) => l.truckCode === 'T01' && l.loadNo === 1)!.driverNote).toBe(`Bob is on leave until ${fmtDayMonth(addDaysIso(D, 1))}`);
    expect(detail.loads.find((l) => l.truckCode === 'T01' && l.loadNo === 2)!.driverNote).toBe(`No driver: Ali is on leave until ${fmtDayMonth(addDaysIso(D, 2))} - pick a driver`);
  });

  it('6. the day after the leave, Ali and Sam drive their trucks again by themselves', async () => {
    const after = addDaysIso(D, 3);
    await seedOrders(after, 2);
    const run = await optimize(after);
    expect(await driversOf(run)).toEqual({ 'T01:1': 'Ali', 'T02:1': 'Sam' });
    expect((await getPlanDetail(ids.tenant, run))!.driversOnLeave).toEqual([]);
  });

  it('7. every change is audited with the dispatcher; the other company sees none of it', async () => {
    const rows = await prisma.auditLog.findMany({ where: { tenantId: ids.tenant, action: { in: ['CREATE', 'TRUCK_USUAL_DRIVER_SET', 'DRIVER_LEAVE_ADDED'] } } });
    const count = (action: string, entity: string) => rows.filter((r) => r.action === action && r.entity === entity && r.userId === ids.planner).length;
    expect([count('CREATE', 'Driver'), count('TRUCK_USUAL_DRIVER_SET', 'Truck'), count('DRIVER_LEAVE_ADDED', 'DriverLeave')]).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.createdAt instanceof Date)).toBe(true);
    expect(await prisma.driverLeave.count({ where: { tenantId: ids.tenant } })).toBe(3); // so far (steps 8 to 10 add more)
    expect(await prisma.driverLeave.count({ where: { tenantId: ids.other } })).toBe(1);
    // The other company's leave on the same day never reached this company's plans or lists.
    as('PLANNER');
    expect((await getLeave(send('GET'), { params: { id: (await prisma.driver.findFirstOrThrow({ where: { tenantId: ids.other } })).id } })).status).toBe(404);
  });

  it("8. (review) the leave moved off the day after planning: a re-plan gives Ali back - the cover's load was marked, the note says why", async () => {
    const day8 = addDaysIso(D, 6);
    as('PLANNER');
    const added = await answer(await postLeave(send('POST', { from: day8, until: addDaysIso(day8, 2), coverDriverId: ids.bob }), { params: { id: ids.ali } }));
    expect(added.status).toBe(201);
    await seedOrders(day8, 2);
    const run = await optimize(day8);
    expect(await driversOf(run)).toEqual({ 'T01:1': 'Bob', 'T02:1': 'Sam' });
    expect((await loadOf(run, ids.t1, 1)).driverIsCover).toBe(true);
    // Ali stays one day less: the period now starts the day after.
    const moved = await answer(await patchLeave(send('PATCH', { from: addDaysIso(day8, 1), until: addDaysIso(day8, 2), coverDriverId: ids.bob }), { params: { id: ids.ali, leaveId: added.body.data.leave.id } }));
    expect(moved.status).toBe(200);
    const next = await replanOf(run);
    expect(await driversOf(next)).toEqual({ 'T01:1': 'Ali', 'T02:1': 'Sam' });
    expect((await loadOf(next, ids.t1, 1)).driverIsCover).toBe(false);
    const detail = (await getPlanDetail(ids.tenant, next))!;
    expect(detail.warnings.filter((w) => w.startsWith('Driver changed'))).toEqual([
      expect.stringMatching(/^Driver changed by this plan: T01 · L1 .* Bob → Ali, because Bob is no longer the cover of this truck's usual driver/),
    ]);
  });

  it('9. (review) two depots: a cover who drives a truck of the other depot that day is not given; the load says why', async () => {
    const day9 = addDaysIso(D, 10);
    const soh = (await prisma.depot.create({ data: { tenantId: ids.tenant, code: 'SOH', name: 'Sohar', lat: 24.34, lng: 56.73 } })).id;
    await prisma.truck.create({ data: { tenantId: ids.tenant, depotId: soh, code: 'T09', capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1, defaultDriverId: ids.bob } });
    as('PLANNER');
    const added = await answer(await postLeave(send('POST', { from: day9, until: day9, coverDriverId: ids.bob }), { params: { id: ids.ali } }));
    expect(added.status).toBe(201);
    expect(added.body.data.warnings).toEqual([expect.stringMatching(/^Bob is the usual driver of T09: RouteIQ gives him T09 first/)]);
    await seedOrders(day9, 1, soh);
    const sohRun = await optimize(day9, soh);
    expect(await driversOf(sohRun)).toEqual({ 'T09:1': 'Bob' });
    await seedOrders(day9, 2);
    const mct = await optimize(day9);
    expect(await driversOf(mct)).toEqual({ 'T01:1': 'none', 'T02:1': 'Sam' });
    const detail = (await getPlanDetail(ids.tenant, mct))!;
    expect(detail.loads.find((l) => l.truckCode === 'T01')!.driverNote).toBe(`No driver: Ali is on leave until ${fmtDayMonth(day9)} - pick a driver`);
  });

  it("10. (demo of 7 Oct 2026) leave entered after planning, nobody re-plans: Lock, Loading and Dispatch ask first; the answer is audited; a load that has left is never stopped", async () => {
    const day10 = addDaysIso(D, 14);
    await seedOrders(day10, 2);
    const run = await optimize(day10);
    expect(await driversOf(run)).toEqual({ 'T01:1': 'Ali', 'T02:1': 'Sam' });
    // Ali's load goes out first; his leave is entered afterwards.
    const t1 = await loadOf(run, ids.t1, 1);
    await updateLoad(ids.tenant, run, t1.id, { status: 'LOCKED' }, planner(), everyRole);
    await updateLoad(ids.tenant, run, t1.id, { status: 'DISPATCHED' }, planner(), everyRole);
    as('PLANNER');
    for (const who of [ids.sam, ids.ali]) expect((await postLeave(send('POST', { from: day10, until: addDaysIso(day10, 1) }), { params: { id: who } })).status).toBe(201);

    // Through the route, as the plan screen sends it: refused with the words, the driver and the day.
    const t2 = await loadOf(run, ids.t2, 1);
    const ctx = { params: { id: run, loadId: t2.id } };
    const refused = await answer(await patchLoad(send('PATCH', { status: 'LOCKED' }), ctx));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({
      error: `T02 L1: Sam is on leave on ${fmtDayMonth(day10)} - pick another driver, or confirm that he drives.`,
      code: 'DRIVER_ON_LEAVE',
      driverId: ids.sam,
      name: 'Sam',
      day: day10,
      until: addDaysIso(day10, 1),
    });
    expect((await loadOf(run, ids.t2, 1)).status).toBe('PLANNED');
    // The answer: Lock, then Loading and Dispatch ask again and go with the answer.
    expect((await patchLoad(send('PATCH', { status: 'LOCKED', leaveConfirmed: true }), ctx)).status).toBe(200);
    for (const status of ['LOADING', 'DISPATCHED'] as const) {
      await expect(updateLoad(ids.tenant, run, t2.id, { status }, planner(), everyRole)).rejects.toMatchObject({ status: 409, details: { code: 'DRIVER_ON_LEAVE' } });
      await updateLoad(ids.tenant, run, t2.id, { status, leaveConfirmed: true }, planner(), everyRole);
    }
    expect(await loadOf(run, ids.t2, 1)).toMatchObject({ status: 'DISPATCHED', driverId: ids.sam });
    const order = ['LOAD_LOCKED', 'LOAD_LOADING', 'LOAD_DISPATCHED'];
    const rows = (await prisma.auditLog.findMany({ where: { tenantId: ids.tenant, entityId: t2.id } })).sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
    expect(rows.map((r) => [r.action, r.userId, (r.afterJson as { driverOnLeave?: unknown }).driverOnLeave])).toEqual(
      ['LOAD_LOCKED', 'LOAD_LOADING', 'LOAD_DISPATCHED'].map((a) => [a, ids.planner, { driverId: ids.sam, driverName: 'Sam', until: addDaysIso(day10, 1), confirmed: true }]),
    );
    // Ali's load left before his leave was entered: it completes without a question.
    await updateLoad(ids.tenant, run, t1.id, { status: 'COMPLETED' }, planner(), everyRole);
    expect((await loadOf(run, ids.t1, 1)).status).toBe('COMPLETED');
  });
});
