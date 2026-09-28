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
 *  5. L5 (A5 second review): a customer import can mark a planned customer's saved point LOW after
 *     planning. Its load cannot then be locked, loaded or dispatched (409 LOCATION_REQUIRED, the
 *     customers named), also after "Use instead" and when the load was locked before the import;
 *     the day says the plan is out of date so RE-PLAN is offered. A5 third review: once the pin is
 *     placed, the stop still goes to the old, flagged point, so LOCK, LOADING and DISPATCH stay
 *     refused (409 STOP_PIN_REPLACED) until a re-plan gives the stop the new pin - also when a second
 *     customer file replaced the flagged point; an ordinary pin correction is not refused. A5 fourth
 *     review: nor is the correction of a flagged point that was confirmed where it was.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';

const session = vi.hoisted(() => ({ user: { id: '', tenantId: '', role: 'TENANT_ADMIN', name: 'Planner', email: 'planner@a5.test' } }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { ...session.user } })) }));

const solverCalls = vi.hoisted(() => [] as DispatchRequest[]);
/** unserved: every stop unserved (sections 1-4); plan: every stop on a truck (section 5). */
const solverMode = vi.hoisted(() => ({ mode: 'unserved' as 'unserved' | 'plan' }));
vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  /** Stop i on truck i % n, load floor(i / n) + 1 (after the truck's frozen trips), and an alternative with the same loads ("Use instead"). */
  function planAll(req: DispatchRequest): DispatchResponse {
    const frozenNos = new Map(req.trucks.map((t) => [t.id, (t.frozen_trips ?? []).length]));
    const loads: PlannedLoad[] = req.stops.map((s, i) => {
      const truck = req.trucks[i % req.trucks.length]!;
      const loadNo = (frozenNos.get(truck.id) ?? 0) + Math.floor(i / req.trucks.length) + 1;
      const depart = 360 + loadNo * 150;
      return {
        truck_id: truck.id, load_no: loadNo, depart_min: depart, return_min: depart + 90, distance_km: 12, duration_min: 90, cases: s.demand_cases, kg: s.demand_kg ?? 0,
        utilization_pct: 10, fuel_litres: 2, fuel_cost: 0.5, distance_cost: 1, time_cost: 1, fixed_cost: 0, total_cost: 2.5, return_leg_km: 6,
        stops: [
          { sequence: 1, stop_id: s.stop_id, order_ids: s.order_ids, customer_id: s.customer_id, arrival_min: depart + 20, service_start_min: depart + 20, departure_min: depart + 40, wait_min: 0, leg_km: 6, cum_km: 6, leg_min: 20, cases: s.demand_cases, kg: s.demand_kg ?? 0, hard_window_ok: true, pref_window_ok: true },
        ],
      };
    });
    const sc: DispatchScenario = {
      name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 0.1, time_limit_sec: 5, objective_value: 1,
      objective: { unserved_penalty: 0, fixed_cost: 0, distance_cost: 0, fuel_cost: 0, time_cost: 0, overtime_cost: 0, window_penalty: 0, margin_served: null },
      trucks_used: new Set(loads.map((l) => l.truck_id)).size, trips: loads.length, total_distance_km: loads.length * 12, total_duration_min: loads.length * 90,
      total_cases: loads.reduce((a, l) => a + l.cases, 0), total_kg: 0, avg_utilization_pct: 10, fuel_litres: 0, fuel_cost: 0, operating_cost: loads.length * 2.5,
      loads, unserved: [], warnings: [],
    };
    const alt: DispatchScenario = { ...sc, name: 'MIN_TRUCKS', loads: sc.loads.map((l) => ({ ...l })) };
    return { run_id: req.run_id, engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, scenarios: [sc, alt], warnings: [] };
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
      return solverMode.mode === 'plan' ? planAll(req) : allUnserved(req);
    }),
  };
});

import { prisma as libPrisma } from '@/lib/db';
import { chooseScenario, getOrCreatePlan, LOCATION_GATE_RULE, noLocationLoadRemedy, replacedPinRemedy, updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail, type PlanDetail } from '@/lib/dispatch/plan-detail';
import { whatsappText } from '@/lib/dispatch/driver-links';
import { replan, startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { getDayOverview, UP_TO_DATE } from '@/lib/dispatch/day-overview';
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
/** The stop of a customer in a plan, with the pin it was planned with. */
const stopOf = (d: PlanDetail | null, customerId: string) => d!.loads.flatMap((l) => l.stops).find((st) => st.customerId === customerId)!;
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
describe('5. a planned customer whose location stops being usable is never locked, loaded or dispatched (L5, A5 second review)', () => {
  const planner = () => ({ id: session.user.id, role: 'TENANT_ADMIN' });
  const everyRole = () => true;
  const importCsv = async (csv: string) => {
    const fd = new FormData();
    fd.set('file', new File([csv], 'customers.csv', { type: 'text/csv' }));
    return answer(await importCustomers(new Request('http://localhost/api/customers/import', { method: 'POST', body: fd })));
  };
  const loadOf = async (runId: string, customerId: string) =>
    (await prisma.routeAssignment.findFirstOrThrow({ where: { runId, order: { customerId } }, include: { load: { include: { truck: true } } } })).load!;
  const statusOf = async (loadId: string) => (await prisma.planLoad.findUniqueOrThrow({ where: { id: loadId } })).status;
  async function planDay(day: string) {
    const { run } = await getOrCreatePlan(tenantId, depotId, day, session.user.id);
    expect((await startDispatchOptimize(tenantId, run.id, { id: session.user.id }, null)).status).toBe(202);
    expect((await jobsDone(run.id)).status).toBe('READY');
    return run.id;
  }

  beforeAll(async () => {
    // A second truck: each customer gets Load 1 of its own truck (loads are locked in order).
    await prisma.truck.create({ data: { tenantId, depotId, code: 'T02', capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1 } });
  });
  beforeEach(() => {
    solverMode.mode = 'plan';
  });
  afterEach(() => {
    solverMode.mode = 'unserved';
  });

  it('a PLANNED load: the day says RE-PLAN, LOCK is refused naming the customer, also after "Use instead"; once the pin is placed it locks', async () => {
    const day = isoPlus(12);
    const k1 = await cust('K1', { lat: 23.6111, lng: 58.4111, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    const k2 = await cust('K2', { lat: 23.588, lng: 58.41, geocodeConfidence: 'HIGH', locationVerified: true });
    await orderFor(k1.id, day, 'SO-K1');
    await orderFor(k2.id, day, 'SO-K2');
    const runId = await planDay(day);
    expect((await getDayOverview(tenantId, { date: day, depotId })).outdated).toEqual(UP_TO_DATE);

    // The new master file has K1 about 4 km away, with 2 decimals: its saved point is marked LOW.
    const imp = await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.64,58.44\n');
    expect(imp.status).toBe(200);
    expect(imp.body.data.locationsNotSaved).toMatchObject([{ code: 'K1', kept: 'SAVED_LOCATION_NEEDS_PIN' }]);
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: k1.id } })).toMatchObject({ lat: 23.6111, lng: 58.4111, geocodeConfidence: 'LOW', locationVerified: false });
    // A file that agrees with the saved point keeps it, and says it is still not used (before: "The
    // location it already has is kept.", with no warning).
    const agrees = await importCsv('code,name,priority,lat,lng\nK1,K1,3,23.61,58.41\n');
    expect(agrees.body.data.locationsNotSaved).toMatchObject([{ code: 'K1', kept: 'SAVED_LOCATION_NOT_USABLE' }]);
    expect(agrees.body.data.warnings.join(' ')).toMatch(/1 saved location\(s\) are not used until the pin is placed by hand: the saved location is not exact/);

    // The day: K1 blocks and the plan in use is out of date, so RE-PLAN is offered (before: every
    // count 0, "The plan is up to date with all orders").
    const day1 = await getDayOverview(tenantId, { date: day, depotId });
    expect(day1.customers.find((c) => c.customerId === k1.id)).toMatchObject({ blocking: true });
    expect(day1.outdated).toEqual({ ...UP_TO_DATE, locationBlocked: 1 });

    // LOCK of K1's load is refused (before: locked, then dispatched to the old point).
    const l1 = await loadOf(runId, k1.id);
    const refused = await updateLoad(tenantId, runId, l1.id, { status: 'LOCKED' }, planner(), everyRole).catch((e) => e);
    expect(refused).toMatchObject({ status: 409, details: { code: 'LOCATION_REQUIRED', customerIds: [k1.id], customers: ['K1'] } });
    expect(refused.message).toBe(`${l1.truck.code} L1: 1 customer on this load has no usable location: K1. ${LOCATION_GATE_RULE} ${noLocationLoadRemedy('PLANNED')}`);
    expect(await statusOf(l1.id)).toBe('PLANNED');

    // "Use instead": the other option was computed before the mark and puts K1 on a new PLANNED
    // load; locking it is refused the same way.
    const plan = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    const alt = await prisma.scenarioResult.findFirstOrThrow({ where: { runId, id: { not: plan.chosenScenarioId! } } });
    await chooseScenario(tenantId, runId, alt.id, session.user.id);
    const l1b = await loadOf(runId, k1.id);
    expect(l1b.status).toBe('PLANNED');
    await expect(updateLoad(tenantId, runId, l1b.id, { status: 'LOCKED' }, planner(), everyRole)).rejects.toMatchObject({ status: 409, details: { code: 'LOCATION_REQUIRED' } });
    expect(await statusOf(l1b.id)).toBe('PLANNED');
    // Control: K2's load (a confirmed location) locks and dispatches.
    const l2 = await loadOf(runId, k2.id);
    await updateLoad(tenantId, runId, l2.id, { status: 'LOCKED' }, planner(), everyRole);
    await updateLoad(tenantId, runId, l2.id, { status: 'DISPATCHED' }, planner(), everyRole);
    expect(await statusOf(l2.id)).toBe('DISPATCHED');

    // The dispatcher drops the pin: K1 is usable again and the plan is out of date because its pin
    // moved (F08). A5 third review: the stop is still planned at the old, flagged point, so LOCK is
    // still refused (before: locked, and sent out to 23.6111, 58.4111); RE-PLAN gives it the new pin.
    expect((await put(k1.id, { lat: 23.6402, lng: 58.4403, source: 'MAP_PIN' })).status).toBe(200);
    expect((await getDayOverview(tenantId, { date: day, depotId })).outdated).toEqual({ ...UP_TO_DATE, masterChanged: 1 });
    const stale = await updateLoad(tenantId, runId, l1b.id, { status: 'LOCKED' }, planner(), everyRole).catch((e) => e);
    expect(stale).toMatchObject({ status: 409, details: { code: 'STOP_PIN_REPLACED', customerIds: [k1.id], customers: ['K1'] } });
    expect(stale.message).toBe(
      `${l1b.truck.code} L${l1b.loadNo}: the stop for K1 still goes to its old point, which was not usable. A new pin was placed after this load was planned. ${LOCATION_GATE_RULE} ${replacedPinRemedy('PLANNED')}`,
    );
    expect(await statusOf(l1b.id)).toBe('PLANNED');
    const again = await replan(tenantId, runId, 'REOPTIMIZE', null, planner(), null);
    expect(again.status).toBe(202);
    const childId = again.body.runId as string;
    expect((await jobsDone(childId)).status).toBe('READY');
    expect(stopOf(await getPlanDetail(tenantId, childId), k1.id)).toMatchObject({ lat: 23.6402, lng: 58.4403 });
    const l1c = await loadOf(childId, k1.id);
    await updateLoad(tenantId, childId, l1c.id, { status: 'LOCKED' }, planner(), everyRole);
    expect(await statusOf(l1c.id)).toBe('LOCKED');
  });

  it('a load LOCKED before the import: LOADING and DISPATCH are refused (with how to go back), unlocking is not; RE-PLAN then asks first', async () => {
    const day = isoPlus(14);
    const k3 = await cust('K3', { lat: 23.555, lng: 58.335, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    await orderFor(k3.id, day, 'SO-K3');
    const runId = await planDay(day);
    const l3 = await loadOf(runId, k3.id);
    await updateLoad(tenantId, runId, l3.id, { status: 'LOCKED' }, planner(), everyRole);

    expect((await importCsv('code,name,priority,lat,lng\nK3,K3,3,23.49,58.30\n')).body.data.locationsNotSaved).toMatchObject([{ code: 'K3', kept: 'SAVED_LOCATION_NEEDS_PIN' }]);
    // Only PLANNED loads make the plan out of date (a re-plan keeps a locked load as it is).
    expect((await getDayOverview(tenantId, { date: day, depotId })).outdated).toEqual(UP_TO_DATE);

    for (const to of ['DISPATCHED', 'LOADING'] as const) {
      const refused = await updateLoad(tenantId, runId, l3.id, { status: to }, planner(), everyRole).catch((e) => e);
      // Before: dispatched, and the order DISPATCHED, to a point the import had just said was not usable.
      expect(refused, to).toMatchObject({ status: 409, details: { code: 'LOCATION_REQUIRED', customers: ['K3'] } });
      expect(refused.message).toContain(noLocationLoadRemedy('LOCKED'));
    }
    expect(await statusOf(l3.id)).toBe('LOCKED');
    expect((await prisma.order.findFirstOrThrow({ where: { tenantId, customerId: k3.id } })).status).not.toBe('DISPATCHED');

    // The way back is open, and a re-plan then asks before leaving K3 unserved.
    await updateLoad(tenantId, runId, l3.id, { status: 'PLANNED' }, planner(), everyRole);
    expect(await statusOf(l3.id)).toBe('PLANNED');
    expect((await getDayOverview(tenantId, { date: day, depotId })).outdated).toEqual({ ...UP_TO_DATE, locationBlocked: 1 });
    const again = await replan(tenantId, runId, 'REOPTIMIZE', null, planner(), null);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'LOCATION_REQUIRED' });
  });

  it('A5 third review: following the refusal (drop the pin) on a LOCKED load, it stays refused until unlock and RE-PLAN; then it goes, to the new pin', async () => {
    const day = isoPlus(16);
    const k5 = await cust('K5', { lat: 23.555, lng: 58.335, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    await orderFor(k5.id, day, 'SO-K5');
    const runId = await planDay(day);
    const l5 = await loadOf(runId, k5.id);
    await updateLoad(tenantId, runId, l5.id, { status: 'LOCKED' }, planner(), everyRole);
    // The customer file has K5 about 2 km away with 3 decimals: its saved point is marked LOW.
    expect((await importCsv('code,name,priority,lat,lng\nK5,K5,3,23.572,58.345\n')).body.data.locationsNotSaved).toMatchObject([{ code: 'K5', kept: 'SAVED_LOCATION_NEEDS_PIN' }]);
    const first = await updateLoad(tenantId, runId, l5.id, { status: 'LOADING' }, planner(), everyRole).catch((e) => e);
    expect(first).toMatchObject({ status: 409, details: { code: 'LOCATION_REQUIRED' } });
    // The refusal says to unlock and RE-PLAN after the pin (before: "then try again").
    expect(first.message).toContain(noLocationLoadRemedy('LOCKED'));
    expect(first.message).toMatch(/unlock this load \(put it back to Planned\) and RE-PLAN, so the stops go to the new pins/);

    // The dispatcher drops the pin at the shop and tries again. Before: LOADING and DISPATCHED went
    // through, with the stop, its links and the WhatsApp text still at 23.555, 58.335.
    expect((await put(k5.id, { lat: 23.5721, lng: 58.3451, source: 'MAP_PIN' })).status).toBe(200);
    for (const to of ['LOADING', 'DISPATCHED'] as const) {
      const refused = await updateLoad(tenantId, runId, l5.id, { status: to }, planner(), everyRole).catch((e) => e);
      expect(refused, to).toMatchObject({ status: 409, details: { code: 'STOP_PIN_REPLACED', customers: ['K5'] } });
      expect(refused.message).toContain(replacedPinRemedy('LOCKED'));
    }
    expect(await statusOf(l5.id)).toBe('LOCKED');
    expect(stopOf(await getPlanDetail(tenantId, runId), k5.id)).toMatchObject({ lat: 23.555, lng: 58.335 });

    // Unlock and RE-PLAN: the stop gets the new pin, and the load locks, loads and goes out.
    await updateLoad(tenantId, runId, l5.id, { status: 'PLANNED' }, planner(), everyRole);
    const again = await replan(tenantId, runId, 'REOPTIMIZE', null, planner(), null);
    expect(again.status).toBe(202);
    const childId = again.body.runId as string;
    expect((await jobsDone(childId)).status).toBe('READY');
    const detail = await getPlanDetail(tenantId, childId);
    const stop = stopOf(detail, k5.id);
    expect(stop).toMatchObject({ lat: 23.5721, lng: 58.3451 });
    expect(stop.mapsUrl).toContain('query=23.5721,58.3451');
    const l5b = await loadOf(childId, k5.id);
    for (const to of ['LOCKED', 'LOADING', 'DISPATCHED'] as const) await updateLoad(tenantId, childId, l5b.id, { status: to }, planner(), everyRole);
    expect(await statusOf(l5b.id)).toBe('DISPATCHED');
    const load = detail!.loads.find((l) => l.id === l5b.id)!;
    const text = whatsappText(detail!.run as never, load as never, 1);
    expect(text).toContain('query=23.5721,58.3451');
    expect(text).not.toContain('23.555,58.335');
  });

  it('A5 third review: the same when a second customer file replaces the flagged point with an exact pair; an ordinary pin correction is not refused', async () => {
    const day = isoPlus(18);
    const k6 = await cust('K6', { lat: 23.5451, lng: 58.3251, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    const k7 = await cust('K7', { lat: 23.5251, lng: 58.3051, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    await orderFor(k6.id, day, 'SO-K6');
    await orderFor(k7.id, day, 'SO-K7');
    const runId = await planDay(day);
    // File 1 points elsewhere (2 decimals): K6's saved point is marked LOW. File 2 has the exact pair.
    expect((await importCsv('code,name,priority,lat,lng\nK6,K6,3,23.56,58.34\n')).body.data.locationsNotSaved).toMatchObject([{ code: 'K6', kept: 'SAVED_LOCATION_NEEDS_PIN' }]);
    expect((await importCsv('code,name,priority,lat,lng\nK6,K6,3,23.5612,58.3405\n')).status).toBe(200);
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: k6.id } })).toMatchObject({ lat: 23.5612, lng: 58.3405, geocodeConfidence: 'HIGH', locationVerified: false });
    const l6 = await loadOf(runId, k6.id);
    // Before: locked, with the stop at 23.5451, 58.3251, the point file 1 had flagged.
    await expect(updateLoad(tenantId, runId, l6.id, { status: 'LOCKED' }, planner(), everyRole)).rejects.toMatchObject({ status: 409, details: { code: 'STOP_PIN_REPLACED', customers: ['K6'] } });
    // Control (A2's "New pin" path, owner default): K7's usable point corrected by hand about 1 km
    // away: its load locks, and the sheets show the planned stop with the new pin noted.
    expect((await put(k7.id, { lat: 23.5341, lng: 58.3101, source: 'MAP_PIN' })).status).toBe(200);
    const l7 = await loadOf(runId, k7.id);
    await updateLoad(tenantId, runId, l7.id, { status: 'LOCKED' }, planner(), everyRole);
    expect(await statusOf(l7.id)).toBe('LOCKED');
  });

  it('A5 fourth review: a flagged point confirmed where it was (its coordinates typed), then corrected by hand, is an ordinary correction: the loads lock and load', async () => {
    const day = isoPlus(20);
    // B: R2's saved point is LOW (nobody confirmed it); a dispatcher confirms it before planning by
    // typing its own coordinates in ADD LOCATION (read as exact).
    const r2 = await cust('R2', { lat: 23.5051, lng: 58.2851, geocodeConfidence: 'LOW', locationSource: 'IMPORT' });
    expect(await put(r2.id, { input: '23.5051, 58.2851' })).toMatchObject({
      status: 200,
      body: { data: { lat: 23.5051, lng: 58.2851, locationVerified: true, geocodeConfidence: 'HIGH' } },
    });
    // A: A1's usable point is planned; a customer file then marks it LOW.
    const a1 = await cust('A1', { lat: 23.5551, lng: 58.3351, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    await orderFor(r2.id, day, 'SO-R2');
    await orderFor(a1.id, day, 'SO-A1');
    const runId = await planDay(day);
    const lr = await loadOf(runId, r2.id);
    const la = await loadOf(runId, a1.id);
    expect(stopOf(await getPlanDetail(tenantId, runId), r2.id)).toMatchObject({ lat: 23.5051, lng: 58.2851 });
    expect((await importCsv('code,name,priority,lat,lng\nA1,A1,3,23.57,58.35\n')).body.data.locationsNotSaved).toMatchObject([{ code: 'A1', kept: 'SAVED_LOCATION_NEEDS_PIN' }]);
    await expect(updateLoad(tenantId, runId, la.id, { status: 'LOCKED' }, planner(), everyRole)).rejects.toMatchObject({ status: 409, details: { code: 'LOCATION_REQUIRED' } });
    // The dispatcher confirms A1 where it is: the load locks (its stop goes to that point).
    expect((await put(a1.id, { input: '23.5551, 58.3351' })).status).toBe(200);
    await updateLoad(tenantId, runId, la.id, { status: 'LOCKED' }, planner(), everyRole);

    // Ordinary corrections of the two confirmed points, about 1 km away (owner default: the planned
    // stop stays, the sheets note the new pin).
    expect((await put(r2.id, { lat: 23.5141, lng: 58.2901, source: 'MAP_PIN' })).status).toBe(200);
    expect((await put(a1.id, { lat: 23.5641, lng: 58.3401, source: 'MAP_PIN' })).status).toBe(200);
    // Before: both refused with 409 STOP_PIN_REPLACED ("its old point, which was not usable"), and
    // A1's locked load sent back through unlock and RE-PLAN.
    await updateLoad(tenantId, runId, lr.id, { status: 'LOCKED' }, planner(), everyRole);
    await updateLoad(tenantId, runId, la.id, { status: 'LOADING' }, planner(), everyRole);
    expect([await statusOf(lr.id), await statusOf(la.id)]).toEqual(['LOCKED', 'LOADING']);
  });

  it('A5 fifth review: a flagged point confirmed by a hand pin a few metres off (a pin exactly on it is refused), then corrected by hand, is an ordinary correction; a pin far away still is not', async () => {
    const day = isoPlus(22);
    const b1 = await cust('B1', { lat: 23.5351, lng: 58.3151, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    const b2 = await cust('B2', { lat: 23.5151, lng: 58.2951, geocodeConfidence: 'HIGH', locationSource: 'IMPORT' });
    await orderFor(b1.id, day, 'SO-B1');
    await orderFor(b2.id, day, 'SO-B2');
    const runId = await planDay(day);
    const l1 = await loadOf(runId, b1.id);
    const l2 = await loadOf(runId, b2.id);
    // A customer file points elsewhere (2 decimals): both saved points are marked LOW.
    expect((await importCsv('code,name,priority,lat,lng\nB1,B1,3,23.55,58.33\nB2,B2,3,23.53,58.31\n')).body.data.locationsNotSaved).toMatchObject([
      { code: 'B1', kept: 'SAVED_LOCATION_NEEDS_PIN' },
      { code: 'B2', kept: 'SAVED_LOCATION_NEEDS_PIN' },
    ]);
    // A pin dropped exactly on B1's flagged point is not placed by hand: refused. The dispatcher drops
    // it on the shop, about 6 m away; the gate counts that as the same place, and the load locks.
    expect(await put(b1.id, { lat: 23.5351, lng: 58.3151, source: 'MAP_PIN' })).toMatchObject({ status: 422, body: { error: { code: 'PIN_REQUIRED' } } });
    expect((await put(b1.id, { lat: 23.53515, lng: 58.3151, source: 'MAP_PIN' })).status).toBe(200);
    await updateLoad(tenantId, runId, l1.id, { status: 'LOCKED' }, planner(), everyRole);
    // Later an ordinary correction of that confirmed pin, about 1 km away: the load goes on (owner
    // default: the planned stop stays, the sheets note the new pin). Before: 409 STOP_PIN_REPLACED,
    // "its old point, which was not usable", and the locked load sent through unlock and RE-PLAN.
    expect((await put(b1.id, { lat: 23.5441, lng: 58.3201, source: 'MAP_PIN' })).status).toBe(200);
    await updateLoad(tenantId, runId, l1.id, { status: 'LOADING' }, planner(), everyRole);
    expect(await statusOf(l1.id)).toBe('LOADING');
    // Control: B2's flagged point replaced by a pin about 2 km away is still refused.
    expect((await put(b2.id, { lat: 23.5301, lng: 58.3051, source: 'MAP_PIN' })).status).toBe(200);
    await expect(updateLoad(tenantId, runId, l2.id, { status: 'LOCKED' }, planner(), everyRole)).rejects.toMatchObject({ status: 409, details: { code: 'STOP_PIN_REPLACED', customers: ['B2'] } });
  });
});
