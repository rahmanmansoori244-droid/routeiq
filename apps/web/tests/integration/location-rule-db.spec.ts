/**
 * AUDIT PR A5, THE OWNER'S LOCATION RULE ON REAL POSTGRESQL, library level: the route handlers and
 * the plan service are called in this process with the session faked (vi.mock of @/lib/auth) and
 * the optimizer faked (vi.mock of the solver client, every stop unserved); everything else is the
 * real code against the real database. Needs DATABASE_URL (migrated); the web server and the solver
 * are not used. No network call is made: `fetch` throws.
 *
 * The owner, 27 Sep 2026: "its a standing rule locations should always be correct as part of sop no
 * item will be delivered without location".
 *
 *  1. L1/L2: ADD LOCATION's route refuses a reading that needs a pin sent as read (422 PIN_REQUIRED)
 *     and the customer's saved MEDIUM point sent back unchanged; it reads a short link from the
 *     address the Read found; the customer page's old PATCH path and POST /api/customers refuse.
 *  2. L3: a customer import stores no location that needs a pin; the new customer shows LOCATION
 *     REQUIRED on the day screen; an existing customer keeps its saved point when the file points at
 *     the same place, else that point is marked LOW and blocks the day until the pin is placed.
 *  3. L4: a LOW location nobody confirmed blocks the day and is never sent to the optimizer; with
 *     "optimize anyway" its order is left unserved with a reason that says to drop the pin.
 *  4. L5: a legacy run (previous planner) is not dispatched while one of its customers has no
 *     location; once the pin is placed it is.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario } from '@routeiq/shared-types';

const session = vi.hoisted(() => ({ user: { id: '', tenantId: '', role: 'TENANT_ADMIN', name: 'Planner', email: 'planner@a5.test' } }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { ...session.user } })) }));

const solverCalls = vi.hoisted(() => [] as DispatchRequest[]);
vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  function allUnserved(req: DispatchRequest): DispatchResponse {
    const sc: DispatchScenario = {
      name: 'RECOMMENDED',
      status: 'OPTIMIZED',
      solver_status: 'ROUTING_SUCCESS',
      solver_time_sec: 0.1,
      time_limit_sec: 5,
      objective_value: 1,
      objective: { unserved_penalty: 0, fixed_cost: 0, distance_cost: 0, fuel_cost: 0, time_cost: 0, overtime_cost: 0, window_penalty: 0, margin_served: null },
      trucks_used: 0,
      trips: 0,
      total_distance_km: 0,
      total_duration_min: 0,
      total_cases: 0,
      total_kg: 0,
      avg_utilization_pct: 0,
      fuel_litres: 0,
      fuel_cost: 0,
      operating_cost: 0,
      loads: [],
      unserved: req.stops.map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'NO_AVAILABLE_TRUCK' as never, reason_message: 'test: no capacity' })),
      warnings: [],
    };
    return { run_id: req.run_id, engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, scenarios: [sc], warnings: [] };
  }
  return {
    SolverError,
    callDispatchSolver: vi.fn(async (req: DispatchRequest) => {
      solverCalls.push(req);
      return allUnserved(req);
    }),
  };
});

import { prisma as libPrisma } from '@/lib/db';
import { getOrCreatePlan } from '@/lib/dispatch/plan-service';
import { startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { getDayOverview } from '@/lib/dispatch/day-overview';
import { LOW_LOCATION_MESSAGE } from '@/lib/dispatch/customer-attrs';
import { PIN_REQUIRED_MESSAGE, SAVED_NOT_EXACT_MESSAGE, SAVED_OUTSIDE_AREA_MESSAGE } from '@/lib/dispatch/location-input';
import { PUT as locationPut } from '@/app/api/customers/[id]/location/route';
import { PATCH as customerPatch } from '@/app/api/customers/[id]/route';
import { POST as customerPost } from '@/app/api/customers/route';
import { POST as importCustomers } from '@/app/api/customers/import/route';
import { POST as legacyDispatch } from '@/app/api/runs/[id]/dispatch/route';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `a5loc-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let depotId = '';
let truckId = '';
let productId = '';

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

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });
const put = async (id: string, body: unknown) => answer(await locationPut(new Request(`http://localhost/api/customers/${id}/location`, json('PUT', body)), { params: { id } }));
const cust = (code: string, data: Record<string, unknown>) =>
  prisma.customer.create({ data: { tenantId, code, name: code, branchKey: '__MAIN__', priority: 3, priorityConfirmed: true, avgServiceTimeMin: 20, serviceTimeConfirmed: true, ...data } });
const orderFor = (customerId: string, day: string, so: string) =>
  prisma.order.create({
    data: {
      tenantId, customerId, depotId, deliveryDate: new Date(`${day}T00:00:00.000Z`), totalCases: 10, totalWeightKg: 100, status: 'VALIDATED', priority: 3,
      lines: { create: [{ productId, cases: 10, weightKg: 100, salesOrderNo: so }] },
    },
  });

const noNetwork = vi.fn(async () => {
  throw new Error('no network call is allowed here');
});

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Audit A5 ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  const user = await prisma.user.create({ data: { tenantId, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner', role: 'TENANT_ADMIN' } });
  session.user = { ...session.user, id: user.id, tenantId };
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'MCT', name: 'Muscat', lat: 23.568, lng: 58.392 } })).id;
  truckId = (await prisma.truck.create({ data: { tenantId, depotId, code: 'T01', capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1 } })).id;
  productId = (await prisma.product.create({ data: { tenantId, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 10 } })).id;
});

beforeEach(() => {
  noNetwork.mockClear();
  vi.stubGlobal('fetch', noNetwork);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('1. saving a location (L1, L2)', () => {
  it('a reading that needs a pin, sent as read, is refused and changes nothing; a hand pin is saved', async () => {
    const c = await cust('P1', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    const bad = await put(c.id, { lat: 23.58, lng: 58.4, source: 'MANUAL_LATLNG', input: '23.58, 58.40' });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'PIN_REQUIRED', message: PIN_REQUIRED_MESSAGE });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ lat: 23.5859, lng: 58.4059, locationVerified: false, locationSource: 'IMPORT' });
    expect(await prisma.auditLog.count({ where: { tenantId, entityId: c.id, action: 'CUSTOMER_LOCATION_SET' } })).toBe(0);

    const pin = await put(c.id, { lat: 23.581234, lng: 58.401234, source: 'MAP_PIN', input: '23.58, 58.40' });
    expect(pin.status).toBe(200);
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      lat: 23.581234, lng: 58.401234, locationVerified: true, locationSource: 'MAP_PIN', geocodeConfidence: 'HIGH', locationVerifiedById: session.user.id,
    });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, entityId: c.id, action: 'CUSTOMER_LOCATION_SET' } });
    expect(a.afterJson).toMatchObject({ source: 'MAP_PIN', confidence: 'HIGH', check: 'HAND_PIN' });
  });

  it('a short link is read again from the address the Read found, with no network call', async () => {
    const c = await cust('P2', {});
    const link = 'https://maps.app.goo.gl/A5shortLink';
    const r = await put(c.id, { lat: 23.6703, lng: 58.1889, source: 'GOOGLE_MAPS_URL', input: link, resolvedUrl: 'https://www.google.com/maps/place/Seeb/data=!3d23.6703!4d58.1889' });
    expect(r.status).toBe(200);
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ lat: 23.6703, lng: 58.1889, locationSource: 'GOOGLE_MAPS_URL', geocodeConfidence: 'HIGH', locationInput: link, locationVerified: true });
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("the customer's saved MEDIUM point, saved again without a hand pin, is refused", async () => {
    const c = await cust('P3', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'MEDIUM', locationSource: 'IMPORT' });
    const r = await put(c.id, { lat: 23.5859, lng: 58.4059, source: 'MAP_PIN' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'PIN_REQUIRED', message: SAVED_NOT_EXACT_MESSAGE });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).locationVerified).toBe(false);
  });

  it("the saved point is judged with the company's area, never by the digits of the stored number", async () => {
    // "23.5850, 58.4000" read as exact and stored as 23.585, 58.4: confirmed as it is.
    const zero = await cust('P6', { lat: 23.585, lng: 58.4, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    expect((await put(zero.id, { lat: 23.585, lng: 58.4, source: 'MAP_PIN' })).status).toBe(200);
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: zero.id } })).toMatchObject({ locationVerified: true, geocodeConfidence: 'HIGH' });
    // A HIGH import outside Oman/UAE, never confirmed: refused with that reason, also with "confirm".
    const away = await cust('P7', { lat: 24.7136, lng: 46.6753, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    const r = await put(away.id, { lat: 24.7136, lng: 46.6753, source: 'MAP_PIN', confirmOutsideArea: true });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'PIN_REQUIRED', message: SAVED_OUTSIDE_AREA_MESSAGE });
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: away.id } })).locationVerified).toBe(false);
  });

  it('PATCH /api/customers/:id refuses coordinates; POST /api/customers refuses a pair that needs a pin', async () => {
    const c = await cust('P4', { lat: 23.5859, lng: 58.4059, geocodeConfidence: 'MEDIUM' });
    const p = await answer(await customerPatch(new Request(`http://localhost/api/customers/${c.id}`, json('PATCH', { lat: 58.4059, lng: 23.5859 })), { params: { id: c.id } }));
    expect(p.status).toBe(400);
    expect(p.body.error.code).toBe('USE_SET_LOCATION');
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ lat: 23.5859, lng: 58.4059, locationVerified: false, geocodeConfidence: 'MEDIUM' });

    const n = await answer(await customerPost(new Request('http://localhost/api/customers', json('POST', { code: 'P5', name: 'P5', lat: 23.58, lng: 58.4 }))));
    expect(n.status).toBe(422);
    expect(n.body.error.code).toBe('PIN_REQUIRED');
    expect(await prisma.customer.count({ where: { tenantId, code: 'P5' } })).toBe(0);
  });
});

describe('2. the customer import (L3)', () => {
  it('a location that needs a pin is not stored: the new customer shows LOCATION REQUIRED; an existing one keeps its own only where the file agrees', async () => {
    // I2: the file has it (swapped) about 3 km from its saved point; I4: 3 decimals around its saved point.
    const moved = await cust('I2', { lat: 23.6111, lng: 58.4111, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    const same = await cust('I4', { lat: 23.5901, lng: 58.4101, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    const fd = new FormData();
    fd.set(
      'file',
      new File(
        ['code,name,priority,lat,lng\nI1,Import one,2,23.58,58.40\nI2,Import two,3,58.4059,23.5859\nI3,Import three,3,23.5901,58.4101\nI4,Import four,3,23.590,58.410\n'],
        'customers.csv',
        { type: 'text/csv' },
      ),
    );
    const res = await answer(await importCustomers(new Request('http://localhost/api/customers/import', { method: 'POST', body: fd })));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ errorRows: 0, upserted: 4 });
    expect(res.body.data.locationsNotSaved.map((l: any) => [l.code, l.kept, l.reason])).toEqual([
      ['I1', null, 'Fewer than 4 decimals.'],
      ['I2', 'SAVED_LOCATION_NEEDS_PIN', 'Latitude and longitude look swapped. The file points about 2.9 km from the saved location.'],
      ['I4', 'SAVED_LOCATION', 'Fewer than 4 decimals.'],
    ]);
    const i1 = await prisma.customer.findFirstOrThrow({ where: { tenantId, code: 'I1' } });
    expect(i1).toMatchObject({ lat: null, lng: null, geocodeConfidence: 'MISSING', locationSource: null, priority: 2 });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: moved.id } })).toMatchObject({ lat: 23.6111, lng: 58.4111, name: 'Import two', geocodeConfidence: 'LOW', locationVerified: false });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: same.id } })).toMatchObject({ lat: 23.5901, lng: 58.4101, geocodeConfidence: 'HIGH' });
    expect(await prisma.customer.findFirstOrThrow({ where: { tenantId, code: 'I3' } })).toMatchObject({ lat: 23.5901, lng: 58.4101, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });

    const day = isoPlus(6);
    await orderFor(i1.id, day, 'SO-I1');
    await orderFor(moved.id, day, 'SO-I2');
    await orderFor(same.id, day, 'SO-I4');
    const cards = (await getDayOverview(tenantId, { date: day, depotId })).customers;
    const card = (id: string) => cards.find((c) => c.customerId === id)!;
    expect(card(i1.id).blocking).toBe(true);
    expect(card(i1.id).issues.find((i) => i.blocking)?.code).toBe('LOCATION_REQUIRED');
    expect(card(moved.id).issues.find((i) => i.blocking)).toEqual({ code: 'INVALID_LOCATION', blocking: true, message: LOW_LOCATION_MESSAGE });
    expect(card(same.id).blocking).toBe(false);
  });
});

describe('3. planning never sends a LOW location nobody confirmed (L4)', () => {
  it('blocking on the day; OPTIMIZE asks first; "anyway" leaves its order unserved with a reason to drop the pin', async () => {
    const day = isoPlus(8);
    const low = await cust('L1', { lat: 23.5, lng: 58.3, geocodeConfidence: 'LOW', locationSource: 'IMPORT' });
    const medium = await cust('L2', { lat: 23.5901, lng: 58.4101, geocodeConfidence: 'MEDIUM', locationSource: 'IMPORT' });
    const lowOk = await cust('L3', { lat: 23.6001, lng: 58.4201, geocodeConfidence: 'LOW', locationVerified: true });
    const oLow = await orderFor(low.id, day, 'SO-L1');
    await orderFor(medium.id, day, 'SO-L2');
    await orderFor(lowOk.id, day, 'SO-L3');

    const overview = await getDayOverview(tenantId, { date: day, depotId });
    const card = (id: string) => overview.customers.find((c) => c.customerId === id)!;
    expect(card(low.id)).toMatchObject({ blocking: true, geocodeConfidence: 'LOW' });
    expect(card(low.id).issues.find((i) => i.blocking)).toEqual({ code: 'INVALID_LOCATION', blocking: true, message: LOW_LOCATION_MESSAGE });
    expect(card(medium.id).blocking).toBe(false);
    expect(card(lowOk.id).blocking).toBe(false);

    const { run } = await getOrCreatePlan(tenantId, depotId, day, session.user.id);
    const refused = await startDispatchOptimize(tenantId, run.id, { id: session.user.id }, null);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'LOCATION_REQUIRED', blocking: [{ customerId: low.id, code: 'INVALID_LOCATION', message: LOW_LOCATION_MESSAGE }] });

    solverCalls.length = 0;
    expect((await startDispatchOptimize(tenantId, run.id, { id: session.user.id }, null, { allowMissingLocations: true })).status).toBe(202);
    await jobsDone(run.id);
    expect(solverCalls.at(-1)!.stops.map((s) => s.customer_id).sort()).toEqual([medium.id, lowOk.id].sort());
    const plan = await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } });
    const u = await prisma.unservedOrder.findFirstOrThrow({ where: { scenarioId: plan.chosenScenarioId!, orderId: oLow.id } });
    expect(u).toMatchObject({ reasonCode: 'INVALID_LOCATION', reasonMessage: LOW_LOCATION_MESSAGE });
  });
});

describe('4. a legacy run is not dispatched with a customer without a location (L5)', () => {
  it('409 LOCATION_REQUIRED and nothing dispatched; after the pin is placed, dispatched', async () => {
    const day = isoPlus(10);
    const c = await cust('G1', { lat: null, lng: null, geocodeConfidence: 'MISSING' });
    const o = await orderFor(c.id, day, 'SO-G1');
    const run = await prisma.runPlan.create({ data: { tenantId, depotId, runDate: new Date(`${day}T00:00:00.000Z`), status: 'READY', totalOrders: 1, createdById: session.user.id } });
    const sc = await prisma.scenarioResult.create({
      data: { runId: run.id, name: 'BALANCED', trucksUsed: 1, totalDistanceKm: 5, totalTimeMin: 30, totalCost: 10, avgUtilizationPct: 5, unservedCount: 0, detailsJson: { routes: [], unserved_orders: [] } },
    });
    await prisma.runPlan.update({ where: { id: run.id }, data: { chosenScenarioId: sc.id } });
    await prisma.routeAssignment.create({ data: { runId: run.id, truckId, orderId: o.id, sequenceInTruck: 1, plannedArrivalMin: 30, plannedDistanceFromPrevKm: 5, plannedLoadCases: 10 } });

    const dispatch = async () => answer(await legacyDispatch(new Request(`http://localhost/api/runs/${run.id}/dispatch`, { method: 'POST' }), { params: { id: run.id } }));
    const refused = await dispatch();
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'LOCATION_REQUIRED', error: expect.stringMatching(/1 customer\(s\) on this run have no correct location: G1\. Nothing was dispatched/) });
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('READY');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('VALIDATED');

    expect((await put(c.id, { lat: 23.6123, lng: 58.4123, source: 'MAP_PIN' })).status).toBe(200);
    const ok = await dispatch();
    expect(ok.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('DISPATCHED');
  });
});
