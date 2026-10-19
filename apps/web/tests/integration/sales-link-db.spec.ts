/**
 * THE SALESMAN LINK on real PostgreSQL, library level (owner request 19 Oct 2026): the office routes
 * (/api/dispatch/sales-links) and the salesman's API (/api/s/view) called in the test process with the session
 * faked, over a plan made by the plan service and its background job (the optimizer faked in this process: one
 * stop per load). Needs DATABASE_URL (migrated, with 20261019180000_sales_link); the web server and the solver
 * are not used. Invented data only: "Example Water Co", truck T05, shops TST0001.., routes R1 / R2X.
 *
 *  1. A planner makes today's link (201, then 200 with the same URL; one SALES_LINK_ISSUED row without the
 *     token, its hash or the salt); a date after tomorrow is refused (400 DATE_OUT_OF_RANGE).
 *  2. The salesman's page: R1 shows its delivered stop (R1's line fully delivered on a stop partly delivered
 *     overall) and its planned stop; R2X the same stop not delivered, with the driver's reason; the order
 *     cancelled before planning under "Cancelled" with the reason's label, never the office's note; an unknown
 *     code answers "no deliveries"; nothing of the other company, which has a plan of the same day too: its own
 *     truck T05 carrying its order TSTB01 of route R1 (the relation filters, real here). A truck code ("t05",
 *     "T-05", its digits "05", "Truck T05"; owner decision of 20 Oct 2026) shows both trips of T05 with every
 *     route's lines on the stop (partly delivered: 20 of 30, the driver's reason); never the other company's T05.
 *  3. Tenant scoping: the other company's planner changing this link: 404; signed in to the other company on
 *     the page: 403.
 *  4. Phones opening the page at once are each counted once (the atomic jsonb append), the route found once; the
 *     truck found is kept as "T:T05" and the office reads it apart (trucksSeen).
 *  5. Make a new link: the old one answers 410 LINK_REPLACED, the new one works; turn off: 410 LINK_REVOKED;
 *     past its end: 410 LINK_EXPIRED.
 *  6. The CHECK constraints of the table, and the location retention turning the phones into "" (count kept).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchScenario, PlannedLoad } from '@routeiq/shared-types';

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string; tenantId: string; role: string; name: string; email: string } } }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => session.value) }));
vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  function fakeSolve(req: DispatchRequest): DispatchResponse {
    const perTruck = new Map<string, number>();
    const stops = [...req.stops].sort((a, b) => a.stop_id.localeCompare(b.stop_id));
    const loads: PlannedLoad[] = stops.map((s, i) => {
      const truck = req.trucks[i % req.trucks.length]!;
      const k = (perTruck.get(truck.id) ?? 0) + 1;
      perTruck.set(truck.id, k);
      const depart = 360 + k * 150;
      return {
        truck_id: truck.id,
        load_no: k,
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
import { addDaysIso, todayIso } from '@/lib/dispatch/time';
import { GET as viewGET } from '@/app/api/s/view/route';
import { POST as linksPOST } from '@/app/api/dispatch/sales-links/route';
import { PATCH as linkPATCH } from '@/app/api/dispatch/sales-links/[id]/route';
import { _resetSalesDayMemo } from '@/lib/sales-link/day-read';
import { eraseSalesLinkDevices } from '@/lib/sales-link/service';
import { tokenHash } from '@/lib/sales-link/token';
import type { SalesViewAnswer } from '@/lib/sales-link/view-types';
import { cleanupTenant, prisma, uniqueSuffix, withDriver } from './helpers';

const BASE = 'https://routeiq.example';
const T = todayIso('Asia/Muscat');
const day = new Date(`${T}T00:00:00.000Z`);
/** A UTC time on T (Muscat is +4). */
const at = (hhmmZ: string) => new Date(`${T}T${hhmmZ}:00Z`);
const slugA = `sl-a-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const slugB = `sl-b-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const ids = { a: '', b: '', plannerA: '', plannerB: '', depotA: '', truckA: '', productA: '', runA: '', truckB: '', runB: '' };
let prevSecret: string | undefined;

const as = (who: 'A' | 'B' | null, role = 'PLANNER') => {
  session.value = who ? { user: { id: who === 'A' ? ids.plannerA : ids.plannerB, tenantId: who === 'A' ? ids.a : ids.b, role, name: 'Planner', email: `p@${who}.example` } } : null;
};
const post = (json: unknown) => linksPOST(new Request(`${BASE}/api/dispatch/sales-links`, { method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }));
const patch = (id: string, json: unknown) => linkPATCH(new Request(`${BASE}/api/dispatch/sales-links/${id}`, { method: 'PATCH', body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }), { params: { id } });
let ipNo = 0;
function view(token: string, o: { route?: string; device?: string } = {}) {
  const url = new URL(`${BASE}/api/s/view`);
  if (o.route !== undefined) url.searchParams.set('route', o.route);
  const headers: Record<string, string> = { authorization: `SalesLink ${token}`, 'x-forwarded-for': `198.51.100.${(++ipNo % 250) + 1}` };
  if (o.device) headers['x-sales-device'] = o.device;
  return viewGET(new Request(url, { headers }));
}
const answer = async (r: Response) => (await r.json()) as { data: SalesViewAnswer | null; error: { code: string; date?: string } | null };

async function company(slug: string, name: string) {
  const t = await prisma.tenant.create({ data: { slug, name, country: 'Oman' } });
  await prisma.tenantConfig.create({ data: { tenantId: t.id, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null, shiftStartMin: 360, reloadMinutes: 30, driverShiftMaxMinutes: 720 } });
  const planner = await prisma.user.create({ data: { tenantId: t.id, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner', role: 'PLANNER' } });
  const depot = await prisma.depot.create({ data: { tenantId: t.id, code: 'DEP', name: 'Example depot', lat: 20.1, lng: 55.1 } });
  const truck = await prisma.truck.create({ data: { tenantId: t.id, depotId: depot.id, code: 'T05', capacityCases: 800, capacityWeightKg: 12000, fixedCostPerDay: 25, costPerKm: 0.12 } });
  const product = await prisma.product.create({ data: { tenantId: t.id, code: 'PRD-A', name: 'Product A', weightPerCaseKg: 12 } });
  return { tenantId: t.id, plannerId: planner.id, depotId: depot.id, truckId: truck.id, productId: product.id };
}

async function addOrder(tenantId: string, depotId: string, productId: string, code: string, lines: { so: string; cases: number; route: string }[], extra: Record<string, unknown> = {}) {
  const customer = await prisma.customer.create({ data: { tenantId, code, name: `Example Mart ${code}`, branchKey: '__MAIN__', lat: 20.1 + lines[0]!.cases / 10_000, lng: 55.12, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true, phone: '+000 CUSTOMER-PHONE-SENTINEL' } });
  const cases = lines.reduce((t, l) => t + l.cases, 0);
  return prisma.order.create({
    data: {
      tenantId,
      customerId: customer.id,
      depotId,
      deliveryDate: day,
      totalCases: cases,
      totalWeightKg: cases * 12,
      status: 'VALIDATED',
      priority: 3,
      notes: 'ORDER-NOTE-SENTINEL',
      lines: { create: lines.map((l) => ({ productId, cases: l.cases, weightKg: l.cases * 12, salesOrderNo: l.so, salesRoute: l.route })) },
      ...extra,
    },
    include: { lines: true },
  });
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

let o1: Awaited<ReturnType<typeof addOrder>>;

// The link's address prefers AUTH_URL / NEXTAUTH_URL over the request's origin (driverLinkBaseUrl), and CI sets
// NEXTAUTH_URL for the whole job: the suite runs without them, as a server with neither (review of 19 Oct 2026).
const URL_VARS = ['AUTH_URL', 'NEXTAUTH_URL'] as const;
const prevUrls: Partial<Record<(typeof URL_VARS)[number], string>> = {};

beforeAll(async () => {
  prevSecret = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'sales-link-db-test-secret';
  for (const k of URL_VARS) {
    prevUrls[k] = process.env[k];
    delete process.env[k];
  }
  const a = await company(slugA, 'Example Water Co');
  const b = await company(slugB, 'Other Example Co');
  Object.assign(ids, { a: a.tenantId, b: b.tenantId, plannerA: a.plannerId, plannerB: b.plannerId, depotA: a.depotId, truckA: a.truckId, productA: a.productId, truckB: b.truckId });
  // Company A: one stop holding two salesmen's lines, one stop of R1, and an order of R1 cancelled before planning.
  o1 = await addOrder(a.tenantId, a.depotId, a.productId, 'TST0001', [
    { so: 'INV-1', cases: 20, route: 'R1' },
    { so: 'INV-1', cases: 10, route: 'R2X' },
  ]);
  await addOrder(a.tenantId, a.depotId, a.productId, 'TST0002', [{ so: 'INV-2', cases: 12, route: 'R1' }]);
  await addOrder(a.tenantId, a.depotId, a.productId, 'TST0003', [{ so: 'INV-3', cases: 7, route: 'R1' }], { cancelledAt: new Date(), cancelReason: 'CUSTOMER_CANCELLED', cancelNote: 'OFFICE-NOTE-SENTINEL', cancelledById: a.plannerId });
  // Company B: an order of route R1 too, planned on B's own truck T05 the same day (below).
  const oB = await addOrder(b.tenantId, b.depotId, b.productId, 'TSTB01', [{ so: 'INV-B', cases: 5, route: 'R1' }]);

  const { run } = await getOrCreatePlan(a.tenantId, a.depotId, T, a.plannerId);
  ids.runA = run.id;
  const morningBefore = new Date(at('02:00').getTime() - 2 * 86_400_000);
  expect((await startDispatchOptimize(a.tenantId, run.id, { id: a.plannerId }, null, { now: morningBefore })).status).toBe(202);
  expect((await jobsDone(run.id)).status).toBe('READY');
  // Company B's plan of the same day: its T05 carries TSTB01, so a route or truck lookup that lost its company
  // filter would find B's R1 line or B's T05 (review of 20 Oct 2026: without it the check could not fail).
  const { run: runB } = await getOrCreatePlan(b.tenantId, b.depotId, T, b.plannerId);
  ids.runB = runB.id;
  expect((await startDispatchOptimize(b.tenantId, runB.id, { id: b.plannerId }, null, { now: morningBefore })).status).toBe(202);
  expect((await jobsDone(runB.id)).status).toBe('READY');
  const loadsB = await prisma.planLoad.findMany({ where: { runId: runB.id }, include: { assignments: true } });
  expect(loadsB.map((l) => [l.truckId, l.assignments.map((x) => x.orderId)])).toEqual([[b.truckId, [oB.id]]]);
  const loads = await prisma.planLoad.findMany({ where: { runId: run.id, truckId: a.truckId }, orderBy: { loadNo: 'asc' }, include: { assignments: true } });
  await withDriver(a.tenantId, loads.map((l) => l.id));
  const first = loads.find((l) => l.assignments.some((x) => x.orderId === o1.id))!;
  for (const s of ['LOCKED', 'DISPATCHED'] as const) await updateLoad(a.tenantId, run.id, first.id, { status: s }, { id: a.plannerId, role: 'TENANT_ADMIN' }, () => true, { now: at('03:00') });
  const row = first.assignments.find((x) => x.orderId === o1.id)!;
  // The driver's result at TST0001: R1's line delivered, R2X's not (shop closed): partly delivered overall.
  await prisma.stopVisit.create({
    data: {
      tenantId: a.tenantId,
      depotId: a.depotId,
      deliveryDate: day,
      truckId: a.truckId,
      loadNo: first.loadNo,
      sequence: row.sequenceInTruck,
      customerId: o1.customerId,
      firstLoadId: first.id,
      casesPlanned: 30,
      casesDelivered: 20,
      arrivedAt: at('04:10'),
      departedAt: at('04:25'),
      outcome: 'PARTLY_DELIVERED',
      reason: 'SHOP_CLOSED',
      reasonNote: 'DRIVER-NOTE-SENTINEL',
      outcomeAt: at('04:25'),
      outcomeSource: 'PHONE_MANUAL',
      linesJson: o1.lines.map((l) => ({ orderId: o1.id, lineId: l.id, productCode: 'PRD-A', plannedCases: l.cases, deliveredCases: l.salesRoute === 'R1' ? l.cases : 0 })),
    },
  });
}, 120_000);

afterAll(async () => {
  if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = prevSecret;
  for (const k of URL_VARS) {
    if (prevUrls[k] === undefined) delete process.env[k];
    else process.env[k] = prevUrls[k];
  }
  session.value = null;
  await cleanupTenant(slugA);
  await cleanupTenant(slugB);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

let url = '';
let linkId = '';
const tokenOf = (u: string) => u.split('/s/')[1]!;

describe('1. the office makes the link', () => {
  it('201 then 200 with the same URL; one audit row without the token, its hash or the salt; only today or tomorrow', async () => {
    as('A');
    const r1 = await post({ date: T });
    expect(r1.status).toBe(201);
    const v1 = (await r1.json()).data;
    url = v1.url;
    linkId = v1.id;
    expect(url).toMatch(new RegExp(`^${BASE}/s/[A-Za-z0-9_-]{24}$`));
    const r2 = await post({ date: T });
    expect(r2.status).toBe(200);
    expect((await r2.json()).data.url).toBe(url);
    const rows = await prisma.auditLog.findMany({ where: { tenantId: ids.a, action: 'SALES_LINK_ISSUED' } });
    expect(rows).toHaveLength(1);
    const stored = await prisma.salesLink.findUniqueOrThrow({ where: { id: linkId } });
    const text = JSON.stringify(rows);
    for (const s of [tokenOf(url), tokenHash(tokenOf(url)), stored.salt]) expect(text).not.toContain(s);
    expect(stored.tokenHash).toBe(tokenHash(tokenOf(url)));
    const far = await post({ date: addDaysIso(T, 2) });
    expect(far.status).toBe(400);
    expect((await far.json()).error).toMatchObject({ code: 'DATE_OUT_OF_RANGE' });
    as('A', 'VIEWER');
    expect((await post({ date: T })).status).toBe(403);
  });
});

describe("2. the salesman's page", () => {
  it("R1 and R2X each with their own lines and result; cancelled with the reason's label; nothing of the other company", async () => {
    as(null);
    _resetSalesDayMemo();
    const meta = await answer(await view(tokenOf(url)));
    expect(meta.data).toMatchObject({ meta: { date: T, company: 'Example Water Co' }, lookup: null });
    const r1 = await answer(await view(tokenOf(url), { route: 'r1' }));
    const v = r1.data!.lookup!.results[0]!;
    expect(v).toMatchObject({ kind: 'ROUTE', code: 'R1' });
    const byCode = new Map(v.deliveries.map((d) => [d.customerCode, d]));
    expect([...byCode.keys()].sort()).toEqual(['TST0001', 'TST0002']);
    expect(byCode.get('TST0001')).toMatchObject({ status: 'DELIVERED', invoices: ['INV-1'], cases: 20, delivered: { cases: 20, of: 20 } });
    expect(byCode.get('TST0002')).toMatchObject({ invoices: ['INV-2'], cases: 12 });
    expect(v.offTruck.map((o) => `${o.kind} ${o.customerCode} ${o.why}`)).toEqual(['CANCELLED TST0003 Cancelled - Customer cancelled']);
    const r2x = (await answer(await view(tokenOf(url), { route: 'R2X' }))).data!.lookup!.results[0]!;
    expect(r2x.deliveries.map((d) => [d.customerCode, d.status, d.cases, d.reason])).toEqual([['TST0001', 'NOT_DELIVERED', 10, 'Shop closed (as reported by the driver)']]);
    const text = JSON.stringify([r1, r2x]);
    for (const s of ['TSTB01', 'INV-B', 'OFFICE-NOTE-SENTINEL', 'DRIVER-NOTE-SENTINEL', 'ORDER-NOTE-SENTINEL', 'CUSTOMER-PHONE-SENTINEL', 'Rule 20 Driver', ids.truckA, ids.depotA, ids.runA, ids.truckB, ids.runB]) expect(text).not.toContain(s);
    const unknown = (await answer(await view(tokenOf(url), { route: 'R9' }))).data!.lookup!;
    expect(unknown).toMatchObject({ results: [], notFound: ['R9'] });
  });

  it('a truck code (owner decision of 20 Oct 2026): both trips of T05, every route on the stop, its result and reason', async () => {
    as(null);
    for (const typed of ['t05', 'T-05', '05', 'Truck T05']) {
      const l = (await answer(await view(tokenOf(url), { route: typed }))).data!.lookup!;
      expect(l.notFound).toEqual([]);
      expect(l.results.map((x) => `${x.kind} ${x.code} ${x.query}`)).toEqual(['TRUCK T05 Truck T05']);
    }
    const t = (await answer(await view(tokenOf(url), { route: 'T05' }))).data!.lookup!.results[0]!;
    expect(t.heading).toMatch(/^Truck T05 · /);
    const byCode = new Map(t.deliveries.map((d) => [d.customerCode, d]));
    expect([...byCode.keys()].sort()).toEqual(['TST0001', 'TST0002']);
    // The stop partly delivered overall: both salesmen's lines on the truck's card.
    expect(byCode.get('TST0001')).toMatchObject({ status: 'PARTLY_DELIVERED', routes: ['R1', 'R2X'], invoices: ['INV-1'], cases: 30, delivered: { cases: 20, of: 30 }, reason: 'Shop closed (as reported by the driver)' });
    expect(byCode.get('TST0002')).toMatchObject({ routes: ['R1'], invoices: ['INV-2'], cases: 12 });
    expect(t.trucks.map((x) => [x.truckCode, x.trips])).toEqual([['T05', 2]]);
    expect(new Set(t.deliveries.map((d) => d.loadNo)).size).toBe(2);
    // The order cancelled before planning was never on the truck.
    expect(t.offTruck).toEqual([]);
    // A route and the truck at once. The other company's T05, on its own plan of the same day with TSTB01, is never
    // found: each lookup above named one truck (a second T05 would be a second result), and none of B's lines.
    const mixed = (await answer(await view(tokenOf(url), { route: 'R2X, T05' }))).data!.lookup!;
    expect(mixed.results.map((x) => `${x.kind} ${x.code}`)).toEqual(['ROUTE R2X', 'TRUCK T05']);
    const text = JSON.stringify([t, mixed]);
    for (const s of ['TSTB01', 'INV-B', 'DRIVER-NOTE-SENTINEL', 'ORDER-NOTE-SENTINEL', 'CUSTOMER-PHONE-SENTINEL', ids.truckA, ids.depotA, ids.runA, ids.truckB, ids.runB]) expect(text).not.toContain(s);
  });
});

describe('3. tenant scoping', () => {
  it("the other company's planner cannot change the link (404); its session on the page: 403", async () => {
    as('B');
    expect((await patch(linkId, { action: 'REVOKE' })).status).toBe(404);
    expect((await prisma.salesLink.findUniqueOrThrow({ where: { id: linkId } })).revokedAt).toBeNull();
    const r = await view(tokenOf(url), { route: 'R1' });
    expect(r.status).toBe(403);
    expect((await answer(r)).error!.code).toBe('SIGNED_IN_OTHER_TENANT');
    as(null);
  });
});

describe('4. phones opening the page at once', () => {
  it('are each counted once (atomic jsonb append), and the route found once', async () => {
    as(null);
    const devices = Array.from({ length: 6 }, (_, i) => `${i}`.repeat(32).slice(0, 32));
    const all = await Promise.all(devices.map((device) => view(tokenOf(url), { device, route: 'R1' })));
    expect(all.map((r) => r.status)).toEqual(Array(6).fill(200));
    await Promise.all(devices.map((device) => view(tokenOf(url), { device, route: 'R1' })));
    const row = await prisma.salesLink.findUniqueOrThrow({ where: { id: linkId } });
    expect((row.devicesJson as string[]).length).toBe(6);
    expect(new Set(row.devicesJson as string[]).size).toBe(6);
    // Section 2's salesman (no office session) found R1, R2X and truck T05 ("T:T05"); six phones finding R1 again add nothing.
    expect(row.routesJson).toEqual(['R1', 'R2X', 'T:T05']);
    expect(row.lastSeenAt).not.toBeNull();
    // The office reads them apart: "routes looked up: R1, R2X · trucks looked up: T05".
    as('A');
    expect((await (await post({ date: T })).json()).data).toMatchObject({ routesSeen: ['R1', 'R2X'], trucksSeen: ['T05'] });
    as(null);
  });
});

describe('5. replaced, turned off, expired', () => {
  it('the old token answers 410 LINK_REPLACED, the new one works; turned off: 410 LINK_REVOKED; past its end: LINK_EXPIRED', async () => {
    as('A');
    const r = await patch(linkId, { action: 'REISSUE', reason: 'sent to the wrong group' });
    expect(r.status).toBe(200);
    const fresh = (await r.json()).data;
    expect(fresh.generation).toBe(2);
    expect(fresh.phones).toBe(0);
    as(null);
    expect((await answer(await view(tokenOf(url)))).error).toMatchObject({ code: 'LINK_REPLACED', date: T });
    expect((await view(tokenOf(fresh.url))).status).toBe(200);
    as('A');
    expect((await patch(linkId, { action: 'REVOKE' })).status).toBe(200);
    as(null);
    expect((await answer(await view(tokenOf(fresh.url)))).error!.code).toBe('LINK_REVOKED');
    // Past its end (moved back for the test; the CHECK keeps the end after the issue).
    as('A');
    const again = (await (await patch(linkId, { action: 'REISSUE' })).json()).data;
    await prisma.salesLink.update({ where: { id: linkId }, data: { issuedAt: new Date(Date.now() - 3 * 3600_000), expiresAt: new Date(Date.now() - 3600_000) } });
    as(null);
    expect((await answer(await view(tokenOf(again.url)))).error).toMatchObject({ code: 'LINK_EXPIRED', date: T });
    as('A');
    expect((await patch(linkId, { action: 'REISSUE' })).status).toBe(409);
  });
});

describe('6. the table', () => {
  it('its CHECKs refuse a bad hash, the same hash twice, a non-array list; the retention erases the phones, the count stays', async () => {
    const good = { tenantId: ids.b, salt: 's', keyId: '0a1b2c3d', expiresAt: new Date('2099-01-02T02:00:00Z') };
    await expect(prisma.salesLink.create({ data: { ...good, deliveryDate: new Date('2099-01-01T00:00:00Z'), tokenHash: 'not-a-hash' } })).rejects.toThrow();
    const h = tokenHash(`check-${uniqueSuffix()}`);
    await expect(prisma.salesLink.create({ data: { ...good, deliveryDate: new Date('2099-01-01T00:00:00Z'), tokenHash: h, prevTokenHash: h } })).rejects.toThrow();
    await expect(prisma.salesLink.create({ data: { ...good, deliveryDate: new Date('2099-01-01T00:00:00Z'), tokenHash: h, devicesJson: { a: 1 } } })).rejects.toThrow();
    await expect(prisma.salesLink.create({ data: { ...good, deliveryDate: new Date('2099-01-01T00:00:00Z'), tokenHash: h, generation: 0 } })).rejects.toThrow();
    // An old link of company B with two phones: the retention turns them into "" in one statement.
    const old = await prisma.salesLink.create({
      data: { tenantId: ids.b, deliveryDate: new Date('2026-01-05T00:00:00Z'), salt: 's', keyId: '0a1b2c3d', tokenHash: tokenHash(`old-${uniqueSuffix()}`), issuedAt: new Date('2026-01-04T10:00:00Z'), expiresAt: new Date('2026-01-06T02:00:00Z'), devicesJson: ['aaaaaaaa', 'bbbbbbbb'] },
    });
    expect(await eraseSalesLinkDevices(prisma, ids.b, '2026-02-01')).toBe(1);
    expect((await prisma.salesLink.findUniqueOrThrow({ where: { id: old.id } })).devicesJson).toEqual(['', '']);
    expect(await eraseSalesLinkDevices(prisma, ids.b, '2026-02-01')).toBe(0);
  });
});
