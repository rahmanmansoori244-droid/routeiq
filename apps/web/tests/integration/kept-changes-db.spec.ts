/**
 * THE KEPT-LOAD WARNING ON REAL POSTGRESQL, library level (lib/dispatch/kept-changes.ts,
 * kept-changes-server.ts). The optimizer is faked in this test process (vi.mock of the solver client);
 * the plan service, the day overview, the plan detail and the re-plan are the real code against the real
 * database. Needs DATABASE_URL (migrated); the web server and solver are not used. Synthetic data only.
 *
 * A day is optimized, one truck's Load 1 and Load 2 are locked, then the customer on Load 2 gets other
 * receiving hours:
 *  (a) the plan screen (getPlanDetail with `kept`) and the day screen (getDayOverview `kept`) list it, the
 *      day's `outdated` stays up to date (a re-plan keeps the load), and the plan screen's stop note says
 *      "hours changed" exactly when the report does (one rule, review W3);
 *  (b) an unlock of Load 1 while Load 2 is locked is refused and changes nothing;
 *  (c) a re-plan with the dialog's fingerprint answers `kept`, records `keptChanged` on PLAN_VERSION_CREATED
 *      and copies the kept loads unchanged;
 *  (d) on the new version, Load 2 then Load 1 back to Planned from the warning: two LOAD_PLANNED rows with
 *      `via`, Load 2's `keptChanges` not empty - read before the load moved (review W2);
 *  (e) another company's version has no report; (f) KEPT_CHANGES=off answers as before;
 *  (g) a DISPATCHED load whose customer changed is not listed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';

vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  /** A small valid plan: stop i on truck i % n, load floor(i / n) + 1 after its frozen trips; load k leaves at 06:00 + k x 150 min. */
  function fakeSolve(req: DispatchRequest): DispatchResponse {
    const frozenNos = new Map(req.trucks.map((t) => [t.id, (t.frozen_trips ?? []).length]));
    const loads: PlannedLoad[] = req.stops.map((s, i) => {
      const truck = req.trucks[i % req.trucks.length]!;
      const loadNo = (frozenNos.get(truck.id) ?? 0) + Math.floor(i / req.trucks.length) + 1;
      const depart = 360 + loadNo * 150;
      return {
        truck_id: truck.id, load_no: loadNo, depart_min: depart, return_min: depart + 90, distance_km: 12, duration_min: 90, cases: s.demand_cases, kg: s.demand_kg ?? 0,
        utilization_pct: 10, fuel_litres: 2, fuel_cost: 0.5, distance_cost: 1, time_cost: 1, fixed_cost: 0, total_cost: 2.5, return_leg_km: 6,
        stops: [{ sequence: 1, stop_id: s.stop_id, order_ids: s.order_ids, customer_id: s.customer_id, arrival_min: depart + 20, service_start_min: depart + 20, departure_min: depart + 40, wait_min: 0, leg_km: 6, cum_km: 6, leg_min: 20, cases: s.demand_cases, kg: s.demand_kg ?? 0, hard_window_ok: true, pref_window_ok: true }],
      };
    });
    const sc: DispatchScenario = {
      name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 0.1, time_limit_sec: 5, objective_value: 1,
      objective: { unserved_penalty: 0, fixed_cost: 0, distance_cost: 0, fuel_cost: 0, time_cost: 0, overtime_cost: 0, window_penalty: 0, margin_served: null },
      trucks_used: new Set(loads.map((l) => l.truck_id)).size, trips: loads.length, total_distance_km: loads.length * 12, total_duration_min: loads.length * 90,
      total_cases: loads.reduce((a, l) => a + l.cases, 0), total_kg: 0, avg_utilization_pct: 10, fuel_litres: 0, fuel_cost: 0, operating_cost: loads.length * 2.5,
      loads, unserved: [], warnings: [],
    };
    return { run_id: req.run_id, engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, scenarios: [sc], warnings: [] };
  }
  return { SolverError, callDispatchSolver: vi.fn(async (req: DispatchRequest) => fakeSolve(req)) };
});

import { prisma as libPrisma } from '@/lib/db';
import { getOrCreatePlan, updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { getDayOverview, UP_TO_DATE } from '@/lib/dispatch/day-overview';
import { replan, startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { keptChangesOf } from '@/lib/dispatch/kept-changes-server';
import { cleanupTenant, prisma, uniqueSuffix, withDriver } from './helpers';

const slug = `keptdb-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
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

/** An optimized day of 4 orders on T05 / T06 (two loads each), every customer receiving 06:00-19:00. */
async function optimizedDay(day: string) {
  await prisma.customer.updateMany({ where: { tenantId }, data: { hardWindowStartMin: 360, hardWindowEndMin: 1140 } });
  const product = await prisma.product.findFirstOrThrow({ where: { tenantId } });
  const customers = await prisma.customer.findMany({ where: { tenantId }, orderBy: { code: 'asc' } });
  for (let i = 0; i < 4; i++) {
    await prisma.order.create({
      data: {
        tenantId, customerId: customers[i]!.id, depotId, deliveryDate: new Date(`${day}T00:00:00.000Z`), totalCases: 10, totalWeightKg: 100, status: 'VALIDATED', priority: 3,
        lines: { create: [{ productId: product.id, cases: 10, weightKg: 100, salesOrderNo: `SO-${day}-${i}` }] },
      },
    });
  }
  const { run } = await getOrCreatePlan(tenantId, depotId, day, userId);
  expect((await startDispatchOptimize(tenantId, run.id, user(), null)).status).toBe(202);
  expect((await jobsDone(run.id)).status).toBe('READY');
  return run.id;
}

/** The truck's loads in order, and the customer on its Load 2. */
async function truckOf(runId: string, code: string) {
  const loads = await prisma.planLoad.findMany({ where: { runId, truck: { code } }, orderBy: { loadNo: 'asc' } });
  const row2 = await prisma.routeAssignment.findFirstOrThrow({ where: { loadId: loads[1]!.id }, include: { order: { select: { customerId: true } } } });
  return { l1: loads[0]!, l2: loads[1]!, customerId: row2.order.customerId };
}

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Kept ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  userId = (await prisma.user.create({ data: { tenantId, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner', role: 'TENANT_ADMIN' } })).id;
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'D01', name: 'Depot', lat: 23.568, lng: 58.392 } })).id;
  for (const code of ['T05', 'T06']) {
    await prisma.truck.create({ data: { tenantId, depotId, code, capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1 } });
  }
  await prisma.product.create({ data: { tenantId, code: 'W-05', name: 'Water', weightPerCaseKg: 10 } });
  for (const [code, lat, lng] of [['C001', 23.588, 58.41], ['C003', 23.6, 58.372], ['C005', 23.555, 58.335], ['C007', 23.61, 58.45]] as const) {
    await prisma.customer.create({ data: { tenantId, code, name: `Shop ${code}`, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
  }
});

afterEach(() => {
  delete process.env.KEPT_CHANGES;
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('locked loads planned with older customer data (real database)', () => {
  it('(a)-(e): listed on both screens, refused out of order, echoed by the re-plan, recorded by the unlock', async () => {
    const day = isoPlus(3);
    const v1 = await optimizedDay(day);
    const { l1, l2, customerId } = await truckOf(v1, 'T05');
    await updateLoad(tenantId, v1, l1.id, { status: 'LOCKED' }, user(), everyRole);
    await updateLoad(tenantId, v1, l2.id, { status: 'LOCKED' }, user(), everyRole);
    // The customer on T05 L2 now receives from 05:00 (planned with 06:00-19:00).
    await prisma.customer.update({ where: { id: customerId }, data: { hardWindowStartMin: 300 } });

    // (a) Both screens list it; the day is not "out of date" for it.
    const plan = await getPlanDetail(tenantId, v1, {}, { kept: true });
    expect(plan!.kept!.loads.map((l) => [l.label, l.worst])).toEqual([['T05 L2', 'STILL_OK']]);
    expect(plan!.kept!.loads[0]!.stops[0]!.changes).toEqual([expect.objectContaining({ kind: 'HOURS', planned: '06:00–19:00', now: '05:00–19:00', widened: true })]);
    for (const l of plan!.loads.filter((x) => x.status !== 'PLANNED')) {
      const listed = !!plan!.kept!.loads.find((k) => k.loadId === l.id)?.stops.some((s) => s.changes.some((c) => c.kind === 'HOURS'));
      expect([l.id, l.stops.some((s) => s.masterChanged.some((c) => c.kind === 'HOURS'))]).toEqual([l.id, listed]);
    }
    const dayView = await getDayOverview(tenantId, { date: day, depotId });
    expect(dayView.kept).toEqual(plan!.kept);
    expect(dayView.outdated).toEqual(UP_TO_DATE);

    // (b) Load 1 cannot go back before Load 2: refused, nothing changed.
    await expect(updateLoad(tenantId, v1, l1.id, { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }, user(), everyRole)).rejects.toMatchObject({ status: 409, message: 'Unlock Load 2 of this truck first.' });
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: l1.id } })).status).toBe('LOCKED');
    expect(await prisma.auditLog.count({ where: { tenantId, action: 'LOAD_PLANNED' } })).toBe(0);

    // (c) The re-plan keeps the loads as they are, says so, and records it.
    const before = await prisma.routeAssignment.findMany({ where: { loadId: { in: [l1.id, l2.id] } }, orderBy: [{ loadNo: 'asc' }], select: { orderId: true, loadNo: true, serviceStartMin: true, departureMin: true, stopSnapshotJson: true } });
    const rp = await replan(tenantId, v1, 'REOPTIMIZE', null, user(), null, {}, undefined, {}, undefined, { keptSeen: plan!.kept!.fingerprint });
    expect(rp.status).toBe(202);
    expect(rp.body.kept).toMatchObject({ loads: 1, breaks: 0, labels: ['T05 L2'], fingerprint: plan!.kept!.fingerprint, unseen: false });
    const v2 = String(rp.body.runId);
    await jobsDone(v2);
    const created = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: 'PLAN_VERSION_CREATED', entityId: v2 } });
    expect((created.afterJson as Record<string, unknown>).keptChanged).toEqual([
      { load: 'T05 L2', status: 'LOCKED', customer: expect.stringMatching(/^C00\d$/), kinds: ['HOURS'], effect: 'STILL_OK', planned: '06:00–19:00', now: '05:00–19:00' },
    ]);
    const copies = await prisma.planLoad.findMany({ where: { runId: v2, carriedFromLoadId: { in: [l1.id, l2.id] } }, orderBy: { loadNo: 'asc' } });
    expect(copies.map((c) => c.status)).toEqual(['LOCKED', 'LOCKED']);
    const after = await prisma.routeAssignment.findMany({ where: { loadId: { in: copies.map((c) => c.id) } }, orderBy: [{ loadNo: 'asc' }], select: { orderId: true, loadNo: true, serviceStartMin: true, departureMin: true, stopSnapshotJson: true } });
    expect(after).toEqual(before);

    // (d) On the new version: Load 2, then Load 1, back to Planned from the warning.
    const [c1, c2] = copies;
    await updateLoad(tenantId, v2, c2!.id, { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }, user(), everyRole);
    await updateLoad(tenantId, v2, c1!.id, { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }, user(), everyRole);
    const rows = await prisma.auditLog.findMany({ where: { tenantId, action: 'LOAD_PLANNED', entityId: { in: [c1!.id, c2!.id] } }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => (r.afterJson as Record<string, unknown>).via)).toEqual(['KEPT_DATA_CHANGED', 'KEPT_DATA_CHANGED']);
    const l2Row = rows.find((r) => r.entityId === c2!.id)!.afterJson as { keptChanges: unknown[] };
    expect(l2Row.keptChanges).toEqual([expect.objectContaining({ load: 'T05 L2', kinds: ['HOURS'] })]);
    expect((rows.find((r) => r.entityId === c1!.id)!.afterJson as { keptChanges: unknown[] }).keptChanges).toEqual([]);
    // Both are Planned now: nothing kept is listed, and the day is out of date for the customer instead.
    expect((await keptChangesOf(libPrisma, tenantId, v2))!.loads).toEqual([]);
    expect((await getDayOverview(tenantId, { date: day, depotId })).outdated.masterChanged).toBe(1);

    // (e) Another company's version: no report.
    expect(await keptChangesOf(libPrisma, `${tenantId}-other`, v2)).toBeNull();
  });

  it('(f) KEPT_CHANGES=off: no report on either screen, and the unlock row is as before', async () => {
    const day = isoPlus(4);
    const v1 = await optimizedDay(day);
    const { l1, l2, customerId } = await truckOf(v1, 'T05');
    await updateLoad(tenantId, v1, l1.id, { status: 'LOCKED' }, user(), everyRole);
    await updateLoad(tenantId, v1, l2.id, { status: 'LOCKED' }, user(), everyRole);
    await prisma.customer.update({ where: { id: customerId }, data: { hardWindowStartMin: 300 } });
    process.env.KEPT_CHANGES = 'off';
    expect((await getPlanDetail(tenantId, v1, {}, { kept: true }))!.kept).toBeNull();
    expect((await getDayOverview(tenantId, { date: day, depotId })).kept).toBeNull();
    await updateLoad(tenantId, v1, l2.id, { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }, user(), everyRole);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: 'LOAD_PLANNED', entityId: l2.id } });
    expect(row.afterJson).not.toHaveProperty('via');
    expect(row.afterJson).not.toHaveProperty('keptChanges');
  });

  it('(g) a DISPATCHED load whose customer changed after planning is not listed (it left: history)', async () => {
    const day = isoPlus(5);
    const v1 = await optimizedDay(day);
    const { l1, l2 } = await truckOf(v1, 'T06');
    await updateLoad(tenantId, v1, l1.id, { status: 'LOCKED' }, user(), everyRole);
    await withDriver(tenantId, [l1.id]); // owner rule 20
    await updateLoad(tenantId, v1, l1.id, { status: 'DISPATCHED' }, user(), everyRole);
    const row1 = await prisma.routeAssignment.findFirstOrThrow({ where: { loadId: l1.id }, include: { order: { select: { customerId: true } } } });
    await prisma.customer.update({ where: { id: row1.order.customerId }, data: { hardWindowStartMin: 300 } });
    const report = await keptChangesOf(libPrisma, tenantId, v1);
    expect(report!.loads.filter((l) => l.loadId === l1.id || l.loadId === l2.id)).toEqual([]);
  });
});
