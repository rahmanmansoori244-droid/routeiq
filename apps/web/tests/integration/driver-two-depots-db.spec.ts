/**
 * A TRUCK WORKING FROM TWO DEPOTS ON ONE DATE (fix of 7 Oct 2026) on real PostgreSQL, library level:
 * the plan service and its background job (the optimizer faked in this process: stop i on truck i % n,
 * one stop per load), the driver link's write path (recordDriverActions, recordDriverPhoto), the
 * manifest, the office's Record outcome, the delivery actuals and Bring forward's reading of the
 * results, with Prisma and the database's own keys. Needs DATABASE_URL (migrated); the web server and
 * the solver are not used.
 *
 * T05 is planned at the North depot (Load 1 ACME 40 cases, Load 2 BETA) and dispatched; then it moves
 * to the South depot, whose plan gives it a Load 1 too (DELTA, 12 cases), dispatched. One driver link
 * covers both depots' loads. Before the fix the driver page's key `1:1` named both first stops: a
 * Delivered for DELTA was recorded as 40 cases delivered to ACME.
 *  1. The manifest gives each depot's Load 1 its own load key and stop keys.
 *  2. Delivered with the South key records DELTA, 12 cases, at the South depot; ACME has no result.
 *  3. An old key `1:1` (a phone that saved before the update) is refused STOP_AMBIGUOUS, nothing stored;
 *     an old key `2:1` (only the North depot has a Load 2) is accepted against BETA.
 *  4. A photo on the South key lands on DELTA's visit; on `1:1` it is refused.
 *  5. Back at depot with the South depot closes the South Load 1 (its only stop has a result): COMPLETED,
 *     the North Load 1 stays DISPATCHED; Back at depot without a depot is refused.
 *  6. The office's Record outcome on the North Load 1 stop 1 records ACME; the actuals Excel rows and
 *     Bring forward's results (per depot) each read their own depot's visit.
 * Synthetic data only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  function fakeSolve(req: DispatchRequest): DispatchResponse {
    const frozenNos = new Map(req.trucks.map((t) => [t.id, (t.frozen_trips ?? []).length]));
    const perTruck = new Map<string, number>();
    // The stops in customer-code order, so the loads are the same on every run.
    const stops = [...req.stops].sort((a, b) => a.stop_id.localeCompare(b.stop_id));
    const loads: PlannedLoad[] = stops.map((s, i) => {
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

import { prisma as libPrisma } from '@/lib/db';
import { getOrCreatePlan, updateLoad } from '@/lib/dispatch/plan-service';
import { startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { outcomeShortfalls } from '@/lib/dispatch/carry-over';
import { recordDriverActions } from '@/lib/delivery/event-service';
import { recordDriverPhoto } from '@/lib/delivery/photo-service';
import { recordOfficeOutcome } from '@/lib/delivery/office-service';
import { readActuals } from '@/lib/delivery/actuals-workbook';
import { driverManifest } from '@/lib/driver-link/manifest';
import { cleanupTenant, prisma, uniqueSuffix, withDriver } from './helpers';

const slug = `twodep-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let userId = '';
const depots = { north: '', south: '' };
let truckId = '';
let productId = '';
const user = () => ({ id: userId, role: 'TENANT_ADMIN' });
const everyRole = () => true;

/** A delivery day far from today on the real clock. */
function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const T = isoPlus(160);
/** A UTC time on T (Muscat is +4). */
const at = (hhmmZ: string) => new Date(`${T}T${hhmmZ}:00Z`);
const morningBefore = () => {
  const d = new Date(`${T}T06:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 2);
  return d;
};

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

async function addOrder(code: string, depotId: string, cases: number) {
  const customer = await prisma.customer.findFirstOrThrow({ where: { tenantId, code } });
  return prisma.order.create({
    data: {
      tenantId,
      customerId: customer.id,
      depotId,
      deliveryDate: new Date(`${T}T00:00:00.000Z`),
      totalCases: cases,
      totalWeightKg: cases * 12,
      status: 'VALIDATED',
      priority: 3,
      lines: { create: [{ productId, cases, weightKg: cases * 12, salesOrderNo: `SO-${code}` }] },
    },
    include: { lines: true },
  });
}

/** Plan the depot's day (fake optimizer), then lock and dispatch every load of T05 with a driver. */
async function planAndDispatch(depotId: string) {
  const { run } = await getOrCreatePlan(tenantId, depotId, T, userId);
  expect((await startDispatchOptimize(tenantId, run.id, user(), null, { now: morningBefore() })).status).toBe(202);
  expect((await jobsDone(run.id)).status).toBe('READY');
  const loads = await prisma.planLoad.findMany({ where: { runId: run.id, truckId }, orderBy: { loadNo: 'asc' }, include: { assignments: true } });
  await withDriver(tenantId, loads.map((l) => l.id));
  for (const l of loads) for (const s of ['LOCKED', 'DISPATCHED'] as const) await updateLoad(tenantId, run.id, l.id, { status: s }, user(), everyRole, { now: at('03:00') });
  return { runId: run.id, loads };
}

let link: { id: string; generation: number; driverIdAtIssue: string | null; expiresAt: Date };
const send = (now: Date, actions: unknown[]) =>
  recordDriverActions({ tenantId, truckId, date: T, link, ip: null, deviceId: null, session: null, now }, { clientNow: now.toISOString(), actions });

/** A minimal JPEG (structure only). */
const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const jpeg = () =>
  Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    ...seg(0xc0, [8, 0, 120, 0, 160, 1, 1, 0x11, 0]),
    ...seg(0xc4, [0, 1, ...Array.from({ length: 15 }, () => 0), 0]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    1, 2, 3,
    0xff, 0xd9,
  ]);

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Two depots ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null, shiftStartMin: 360, reloadMinutes: 30 } });
  userId = (await prisma.user.create({ data: { tenantId, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner', role: 'TENANT_ADMIN' } })).id;
  depots.north = (await prisma.depot.create({ data: { tenantId, code: 'NORTH', name: 'North depot', lat: 23.58, lng: 58.39 } })).id;
  depots.south = (await prisma.depot.create({ data: { tenantId, code: 'SOUTH', name: 'South depot', lat: 23.3, lng: 58.6 } })).id;
  truckId = (await prisma.truck.create({ data: { tenantId, depotId: depots.north, code: 'T05', capacityCases: 800, capacityWeightKg: 12000, fixedCostPerDay: 25, costPerKm: 0.12 } })).id;
  productId = (await prisma.product.create({ data: { tenantId, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 12 } })).id;
  for (const [code, lat, lng] of [['ACME', 23.6, 58.41], ['BETA', 23.61, 58.45], ['DELTA', 23.32, 58.62]] as const) {
    await prisma.customer.create({ data: { tenantId, code, name: `Shop ${code}`, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
  }
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('a truck with a Load 1 at two depots on one date: every result goes to the stop the driver meant', () => {
  it('records each depot\'s stops on their own visits; old keys only where one stop fits', async () => {
    const acme = await addOrder('ACME', depots.north, 40);
    await addOrder('BETA', depots.north, 20);
    const delta = await addOrder('DELTA', depots.south, 12);

    // The North plan, dispatched; then T05 moves to the South depot, whose plan gives it a Load 1 too.
    const north = await planAndDispatch(depots.north);
    expect(north.loads.map((l) => [l.loadNo, l.assignments.map((a) => a.orderId)])).toEqual([
      [1, [acme.id]],
      [2, [expect.any(String)]],
    ]);
    await prisma.truck.update({ where: { id: truckId }, data: { depotId: depots.south } });
    const south = await planAndDispatch(depots.south);
    expect(south.loads.map((l) => [l.loadNo, l.assignments.map((a) => a.orderId)])).toEqual([[1, [delta.id]]]);
    const linkRow = await prisma.driverLink.create({
      data: { tenantId, truckId, deliveryDate: new Date(`${T}T00:00:00Z`), salt: 'test', keyId: 'test0000', tokenHash: `test-${uniqueSuffix()}`, expiresAt: new Date(`${isoPlus(161)}T08:00:00Z`) },
    });
    link = { id: linkRow.id, generation: linkRow.generation, driverIdAtIssue: null, expiresAt: linkRow.expiresAt };
    const N = depots.north;
    const S = depots.south;

    // 1. The manifest: one key per depot's load and stop.
    const m = await driverManifest({ tenantId, truckId, date: T, link: { expiresAt: link.expiresAt, uploadUntil: link.expiresAt, generation: 1 }, office: null, now: at('05:00') });
    const byKey = (x: { key: string }, y: { key: string }) => x.key.localeCompare(y.key);
    expect([...m.loads].sort(byKey).map((l) => [l.key, l.loadNo, l.stops.map((s) => [s.key, s.customerCode, s.cases])])).toEqual(
      [
        [`${N}:1`, 1, [[`${N}:1:1`, 'ACME', 40]]],
        [`${N}:2`, 2, [[`${N}:2:1`, 'BETA', 20]]],
        [`${S}:1`, 1, [[`${S}:1:1`, 'DELTA', 12]]],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );

    // 2. The reproduction: Delivered for DELTA (South, 12 cases) records DELTA, never ACME.
    const r = await send(at('09:00'), [{ key: randomUUID(), type: 'OUTCOME', stop: `${S}:1:1`, at: at('08:50').toISOString(), outcome: 'DELIVERED', photoKeys: [randomUUID()] }]);
    expect(r.results[0]).toMatchObject({ status: 'ok' });
    const visits = await prisma.stopVisit.findMany({ where: { tenantId, truckId } });
    expect(visits).toHaveLength(1);
    const deltaCustomer = await prisma.customer.findFirstOrThrow({ where: { tenantId, code: 'DELTA' } });
    expect(visits[0]).toMatchObject({ depotId: S, loadNo: 1, sequence: 1, customerId: deltaCustomer.id, outcome: 'DELIVERED', casesPlanned: 12, casesDelivered: 12 });
    expect(r.stops[`${S}:1:1`]).toMatchObject({ outcome: 'DELIVERED', casesDelivered: 12 });
    expect(r.stops[`${N}:1:1`]).toBeUndefined();

    // 3. Old keys queued on a phone before the update.
    const ambiguous = await send(at('09:05'), [{ key: randomUUID(), type: 'OUTCOME', stop: '1:1', at: at('09:00').toISOString(), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [] }]);
    expect(ambiguous.results[0]).toMatchObject({ status: 'refused', code: 'STOP_AMBIGUOUS' });
    expect(await prisma.stopEvent.count({ where: { tenantId, truckId, kind: 'OUTCOME' } })).toBe(1);
    const single = await send(at('09:05'), [{ key: randomUUID(), type: 'OUTCOME', stop: '2:1', at: at('09:00').toISOString(), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [] }]);
    expect(single.results[0]).toMatchObject({ status: 'ok' });
    expect(await prisma.stopVisit.findFirstOrThrow({ where: { tenantId, truckId, depotId: N, loadNo: 2, sequence: 1 } })).toMatchObject({ outcome: 'NOT_DELIVERED', casesDelivered: 0 });

    // 4. Photos.
    const ctx = { tenantId, truckId, date: T, link, ip: null, deviceId: null, session: null, now: at('09:10') };
    const meta = (stop: string) => ({ key: randomUUID(), stop, takenAt: at('08:55').toISOString(), clientNow: at('09:10').toISOString(), positionStatus: 'TIMEOUT' as const });
    expect(await recordDriverPhoto(ctx, meta(`${S}:1:1`), jpeg())).toMatchObject({ status: 'ok' });
    expect(await recordDriverPhoto(ctx, meta('1:1'), jpeg())).toMatchObject({ status: 'refused', code: 'STOP_AMBIGUOUS' });
    const photos = await prisma.deliveryPhoto.findMany({ where: { tenantId }, select: { visitId: true } });
    expect(photos).toEqual([{ visitId: visits[0]!.id }]);

    // 5. Back at depot: without a depot it fits two loads (refused); with the South depot the South Load 1 closes.
    expect((await send(at('09:30'), [{ key: randomUUID(), type: 'BACK_AT_DEPOT', load: 1, at: at('09:25').toISOString() }])).results[0]).toMatchObject({ status: 'refused', code: 'STOP_AMBIGUOUS' });
    const backed = await send(at('09:30'), [{ key: randomUUID(), type: 'BACK_AT_DEPOT', load: 1, depot: S, at: at('09:25').toISOString() }]);
    expect(backed.results[0]).toMatchObject({ status: 'ok' });
    expect(backed.back).toEqual({ [`${S}:1`]: expect.any(String) });
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: south.loads[0]!.id } })).status).toBe('COMPLETED');
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: north.loads[0]!.id } })).status).toBe('DISPATCHED');

    // 6. The office records the North Load 1 stop 1 (ACME): its own visit, at the North depot.
    const office = await recordOfficeOutcome(tenantId, { id: userId, name: 'Planner' }, { key: randomUUID(), depotId: N, date: T, truckId, loadNo: 1, sequence: 1, outcome: 'NOT_DELIVERED', reason: 'CUSTOMER_REFUSED' } as never, { now: at('10:00') });
    expect(office).toMatchObject({ result: 'ok' });
    const acmeVisit = await prisma.stopVisit.findFirstOrThrow({ where: { tenantId, truckId, depotId: N, loadNo: 1, sequence: 1 } });
    expect(acmeVisit).toMatchObject({ outcome: 'NOT_DELIVERED', casesPlanned: 40, casesDelivered: 0 });
    expect(await prisma.stopVisit.findFirstOrThrow({ where: { id: visits[0]!.id } })).toMatchObject({ outcome: 'DELIVERED', casesDelivered: 12 });

    // The actuals Excel: one row per depot's stop, each with its own result.
    const actuals = await readActuals(tenantId, { from: T, to: T }, null, { now: at('10:00') });
    const row = (depot: string, trip: number) => actuals.rows.find((x) => x.depot === depot && x.trip === trip && x.stop === 1);
    expect(row('NORTH', 1)).toMatchObject({ customerCode: 'ACME', casesPlanned: 40, casesDelivered: 0 });
    expect(row('SOUTH', 1)).toMatchObject({ customerCode: 'DELTA', casesPlanned: 12, casesDelivered: 12 });

    // Bring forward reads the results per depot: the North depot's shortfalls are ACME and BETA only.
    const northShort = await outcomeShortfalls(prisma, tenantId, N, { from: T, to: T });
    expect(northShort.map((x) => [x.v.loadNo, x.v.sequence, x.v.lines.map((l) => [l.orderId, l.notDelivered])]).sort()).toEqual([
      [1, 1, [[acme.id, 40]]],
      [2, 1, [[expect.any(String), 20]]],
    ]);
    const southShort = await outcomeShortfalls(prisma, tenantId, S, { from: T, to: T });
    expect(southShort.map((x) => x.v.lines.map((l) => [l.orderId, l.notDelivered]))).toEqual([[[delta.id, 0]]]);
  });
});
