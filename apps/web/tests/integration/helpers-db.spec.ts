/**
 * HELPERS (TRUCK CREW), owner request 13 Oct 2026, on real PostgreSQL, library level: the real route
 * handlers (helpers, drivers, trucks, a load's helpers, the crew report), the plan service and the
 * background job, zod, Prisma and the database's own keys and CHECK constraints; the optimizer is faked
 * in this test process (vi.mock of the solver client: stop i on truck i % n, load floor(i / n) + 1) and
 * the session is faked (vi.mock of auth). Needs DATABASE_URL (migrated); the web server and the solver
 * are not used.
 *
 *  1. The dispatcher (PLANNER) adds helpers; a code already used is a 409 with the code (also for a
 *     driver: the live bug of 12 Oct 2026 answered 500); he sets each truck's usual helper
 *     (TRUCK_USUAL_HELPER_SET); a VIEWER changes nothing.
 *  2. OPTIMIZE: each load gets its truck's usual helper.
 *  3. The dispatcher sets two helpers on one load (LOAD_HELPERS_CHANGED with names); a fourth helper
 *     or a helper twice is refused; the database refuses position 4 and a helper twice on a load.
 *  4. A re-plan (new version): the locked load and the helpers picked by hand stay, the other trips
 *     get the usual helper again; the plan detail and the exports show them.
 *  5. The Crew report: one row per load of the plan in use with driver and helpers; the Excel.
 *  6. Another company: its helper cannot be put on a load, its helper and depot answer 404.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
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

import { POST as createHelper, GET as listHelpers } from '@/app/api/helpers/route';
import { GET as getHelper, PATCH as patchHelper } from '@/app/api/helpers/[id]/route';
import { POST as createDriver } from '@/app/api/drivers/route';
import { PATCH as patchTruck } from '@/app/api/trucks/[id]/route';
import { PATCH as patchLoad } from '@/app/api/runs/[id]/loads/[loadId]/route';
import { GET as getCrewReport } from '@/app/api/dispatch/crew-report/route';
import { prisma as libPrisma } from '@/lib/db';
import { getOrCreatePlan, updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { replan, startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { readCrewReport } from '@/lib/dispatch/crew-report';
import { loadSheetModel } from '@/lib/dispatch/warehouse-sheets';
import { driverPackModel } from '@/lib/dispatch/driver-pack';
import { addDaysIso, todayIso } from '@/lib/dispatch/time';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `help-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const otherSlug = `helpb-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const ids = { tenant: '', other: '', otherHelper: '', otherDepot: '', admin: '', planner: '', viewer: '', depot: '', t1: '', t2: '', ali: '', sam: '', saif: '', omar: '', nasr: '' };
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

async function seedOrders(day: string, n: number) {
  const product = await prisma.product.findFirstOrThrow({ where: { tenantId: ids.tenant } });
  const customers = await prisma.customer.findMany({ where: { tenantId: ids.tenant }, orderBy: { code: 'asc' } });
  for (let i = 0; i < n; i++) {
    await prisma.order.create({
      data: {
        tenantId: ids.tenant,
        customerId: customers[i % customers.length]!.id,
        depotId: ids.depot,
        deliveryDate: dateOf(day),
        totalCases: 10,
        totalWeightKg: 100,
        status: 'VALIDATED',
        priority: 3,
        lines: { create: [{ productId: product.id, cases: 10, weightKg: 100, salesOrderNo: `SO-${day}-${i}` }] },
      },
    });
  }
}

/** Each load of a plan version: "T01:1" -> its helpers' names in order ("-" for none), "(by hand)" when picked by hand. */
async function helpersOf(runId: string) {
  const loads = await prisma.planLoad.findMany({
    where: { runId },
    include: { truck: true, helpers: { orderBy: { position: 'asc' }, include: { helper: true } } },
    orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }],
  });
  return Object.fromEntries(loads.map((l) => [`${l.truck.code}:${l.loadNo}`, `${l.helpers.map((h) => h.helper.name).join(', ') || '-'}${l.helpersSetAt ? ' (by hand)' : ''}`]));
}
const loadOf = async (runId: string, truckId: string, loadNo: number) => prisma.planLoad.findFirstOrThrow({ where: { runId, truckId, loadNo } });

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Helpers ${slug}`, country: 'Oman' } });
  ids.tenant = t.id;
  await prisma.tenantConfig.create({ data: { tenantId: t.id, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  for (const role of ['TENANT_ADMIN', 'PLANNER', 'VIEWER'] as const) {
    const u = await prisma.user.create({ data: { tenantId: t.id, email: `${role.toLowerCase()}@${slug}.test`, passwordHash: 'x', name: role, role } });
    if (role === 'TENANT_ADMIN') ids.admin = u.id;
    else if (role === 'PLANNER') ids.planner = u.id;
    else ids.viewer = u.id;
  }
  ids.depot = (await prisma.depot.create({ data: { tenantId: t.id, code: 'MCT', name: 'Muscat', lat: 23.568, lng: 58.392 } })).id;
  ids.ali = (await prisma.driver.create({ data: { tenantId: t.id, code: 'D01', name: 'Ali' } })).id;
  ids.sam = (await prisma.driver.create({ data: { tenantId: t.id, code: 'D02', name: 'Sam' } })).id;
  ids.t1 = (await prisma.truck.create({ data: { tenantId: t.id, depotId: ids.depot, code: 'T01', capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1, defaultDriverId: ids.ali } })).id;
  ids.t2 = (await prisma.truck.create({ data: { tenantId: t.id, depotId: ids.depot, code: 'T02', capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1, defaultDriverId: ids.sam } })).id;
  await prisma.product.create({ data: { tenantId: t.id, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 10 } });
  for (const [code, lat, lng] of [['C1', 23.588, 58.41], ['C2', 23.6, 58.372], ['C3', 23.555, 58.335], ['C4', 23.61, 58.45]] as const) {
    await prisma.customer.create({ data: { tenantId: t.id, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
  }
  // Another company with a helper of the same code and a depot of its own.
  const o = await prisma.tenant.create({ data: { slug: otherSlug, name: `Other ${otherSlug}`, country: 'Oman' } });
  ids.other = o.id;
  ids.otherHelper = (await prisma.helper.create({ data: { tenantId: o.id, code: 'H01', name: 'Other Saif' } })).id;
  ids.otherDepot = (await prisma.depot.create({ data: { tenantId: o.id, code: 'OTH', name: 'Other', lat: 23.5, lng: 58.3 } })).id;
});

afterAll(async () => {
  session.user = null;
  await cleanupTenant(slug);
  await cleanupTenant(otherSlug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('helpers on each truck and load, like drivers', () => {
  it('1. the dispatcher adds helpers (a used code is a 409, for drivers too) and sets the usual helpers; a viewer changes nothing', async () => {
    as('PLANNER');
    for (const [key, code, name] of [['saif', 'H01', 'Saif'], ['omar', 'H02', 'Omar'], ['nasr', 'H03', 'Nasr']] as const) {
      const r = await answer(await createHelper(send('POST', { code, name, phone: '+968 9000 0000' })));
      expect(r.status).toBe(201);
      ids[key] = r.body.data.id;
    }
    const dup = await answer(await createHelper(send('POST', { code: 'H01', name: 'Saif again' })));
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'CODE_TAKEN', error: 'Helper code H01 is already used. Use another code, or edit that helper.' });
    const dupDriver = await answer(await createDriver(send('POST', { code: 'D01', name: 'Ali again' })));
    expect(dupDriver.status).toBe(409);
    expect(dupDriver.body.error).toMatchObject({ code: 'CODE_TAKEN', error: 'Driver code D01 is already used. Use another code, or edit that driver.' });
    expect(await prisma.driver.count({ where: { tenantId: ids.tenant, code: 'D01' } })).toBe(1);

    expect((await patchTruck(send('PATCH', { defaultHelperId: ids.saif }), { params: { id: ids.t1 } })).status).toBe(200);
    expect((await patchTruck(send('PATCH', { defaultHelperId: ids.omar }), { params: { id: ids.t2 } })).status).toBe(200);
    const set = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: ids.tenant, action: 'TRUCK_USUAL_HELPER_SET', entityId: ids.t1 } });
    expect(set.afterJson).toEqual({ truck: 'T01', from: 'none', to: 'Saif', truckId: ids.t1, fromHelperId: null, toHelperId: ids.saif });

    as('VIEWER');
    expect((await answer(await listHelpers(send('GET')))).body.data.map((h: { code: string }) => h.code)).toEqual(['H01', 'H02', 'H03']);
    expect((await createHelper(send('POST', { code: 'H09', name: 'Nope' }))).status).toBe(403);
    expect((await patchHelper(send('PATCH', { name: 'Nope' }), { params: { id: ids.saif } })).status).toBe(403);
    expect((await patchTruck(send('PATCH', { defaultHelperId: null }), { params: { id: ids.t2 } })).status).toBe(403);
    expect((await prisma.truck.findUniqueOrThrow({ where: { id: ids.t2 } })).defaultHelperId).toBe(ids.omar);
  });

  let v1 = '';
  it('2. OPTIMIZE: every load gets its truck\'s usual helper', async () => {
    await seedOrders(D, 4);
    const { run } = await getOrCreatePlan(ids.tenant, ids.depot, D, ids.planner);
    expect((await startDispatchOptimize(ids.tenant, run.id, planner(), null)).status).toBe(202);
    expect((await jobsDone(run.id)).status).toBe('READY');
    v1 = run.id;
    expect(await helpersOf(v1)).toEqual({ 'T01:1': 'Saif', 'T01:2': 'Saif', 'T02:1': 'Omar', 'T02:2': 'Omar' });
  });

  it('3. the dispatcher sets two helpers on T02 L1 (audited with names); four or one twice is refused; the database keeps 1-3 and each once', async () => {
    as('PLANNER');
    const l = await loadOf(v1, ids.t2, 1);
    const ok = await answer(await patchLoad(send('PATCH', { helperIds: [ids.nasr, ids.omar] }), { params: { id: v1, loadId: l.id } }));
    expect(ok.status).toBe(200);
    expect((await helpersOf(v1))['T02:1']).toBe('Nasr, Omar (by hand)');
    const a = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: ids.tenant, action: 'LOAD_HELPERS_CHANGED', entityId: l.id } });
    expect(a.userId).toBe(ids.planner);
    expect(a.beforeJson).toMatchObject({ helperIds: [ids.omar], helperNames: ['Omar'] });
    expect(a.afterJson).toMatchObject({ helperIds: [ids.nasr, ids.omar], helperNames: ['Nasr', 'Omar'], runId: v1, truckId: ids.t2, loadNo: 1 });
    expect((await patchLoad(send('PATCH', { helperIds: [ids.nasr, ids.omar, ids.saif, ids.nasr] }), { params: { id: v1, loadId: l.id } })).status).toBe(400);
    expect((await patchLoad(send('PATCH', { helperIds: [ids.saif, ids.saif] }), { params: { id: v1, loadId: l.id } })).status).toBe(400);
    as('VIEWER');
    expect((await patchLoad(send('PATCH', { helperIds: [] }), { params: { id: v1, loadId: l.id } })).status).toBe(403);
    expect((await helpersOf(v1))['T02:1']).toBe('Nasr, Omar (by hand)');
    await expect(prisma.planLoadHelper.create({ data: { tenantId: ids.tenant, loadId: l.id, helperId: ids.saif, position: 4 } })).rejects.toThrow(/PlanLoadHelper_position_range/);
    await expect(prisma.planLoadHelper.create({ data: { tenantId: ids.tenant, loadId: l.id, helperId: ids.nasr, position: 3 } })).rejects.toThrow(/Unique constraint/);
  });

  let v2 = '';
  it('4. a re-plan: the locked load and the helpers picked by hand stay; the other trips get the usual helper; the sheets show them', async () => {
    // T01 L1 locked with Saif and Nasr; then a re-plan.
    const t1l1 = await loadOf(v1, ids.t1, 1);
    await updateLoad(ids.tenant, v1, t1l1.id, { helperIds: [ids.saif, ids.nasr], status: 'LOCKED' }, planner(), () => true);
    const rp = await replan(ids.tenant, v1, 'REOPTIMIZE', null, planner(), null);
    expect(rp.status).toBe(202);
    v2 = String(rp.body.runId);
    expect((await jobsDone(v2)).status).toBe('READY');
    const after = await helpersOf(v2);
    expect(after['T01:1']).toBe('Saif, Nasr (by hand)');
    expect(after['T02:1']).toBe('Nasr, Omar (by hand)');
    // Every other trip: the truck's usual helper, never one already out on a trip at that time.
    for (const [k, v] of Object.entries(after)) if (k !== 'T01:1' && k !== 'T02:1') expect([k, v]).toEqual([k, k.startsWith('T01') ? 'Saif' : 'Omar']);
    // The previous version keeps its own rows.
    expect((await helpersOf(v1))['T01:1']).toBe('Saif, Nasr (by hand)');

    const detail = (await getPlanDetail(ids.tenant, v2))!;
    const d11 = detail.loads.find((l) => l.truckCode === 'T01' && l.loadNo === 1)!;
    expect(d11.helpers!.map((h) => h.name)).toEqual(['Saif', 'Nasr']);
    expect(d11.helpersHandSet).toBe(true);
    expect(loadSheetModel(detail, { tenantName: 'NMWC' }).sheets.find((s) => s.loadId === d11.id)!.helpers).toBe('Saif, Nasr');
    expect(driverPackModel(detail, { tenantName: 'NMWC' }).sheets.find((s) => s.loadId === d11.id)!.helpersLine).toBe('Helpers: Saif, Nasr');
  });

  it('5. the Crew report: one row per load of the plan in use with its driver and helpers; the Excel', async () => {
    const { rows } = await readCrewReport(ids.tenant, { from: D, to: D }, null);
    const v2loads = await prisma.planLoad.count({ where: { runId: v2 } });
    expect(rows).toHaveLength(v2loads);
    expect(rows[0]).toMatchObject({ date: D, depot: 'MCT', truck: 'T01', trip: 1, status: 'LOCKED', driver: 'Ali', helper1: 'Saif', helper2: 'Nasr', helper3: '', departedBasis: 'Planned' });
    expect(rows.find((r) => r.truck === 'T02' && r.trip === 1)).toMatchObject({ helper1: 'Nasr', helper2: 'Omar', stops: 1, cases: 10 });
    as('VIEWER');
    const res = await getCrewReport(new Request(`http://localhost/api/dispatch/crew-report?from=${D}&to=${D}&depotId=${ids.depot}`));
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('Loads')!;
    expect([4, 5, 6, 7, 8].map((c) => ws.getCell(4, c).text)).toEqual(['LOCKED', 'Ali', 'Saif', 'Nasr', '']);
  });

  it('6. another company: its helper cannot go on a load or be read; its depot is not found', async () => {
    as('PLANNER');
    const l = await loadOf(v2, ids.t2, 2);
    const refused = await answer(await patchLoad(send('PATCH', { helperIds: [ids.otherHelper] }), { params: { id: v2, loadId: l.id } }));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: 'HELPER_NOT_FOUND' });
    expect((await getHelper(send('GET'), { params: { id: ids.otherHelper } })).status).toBe(404);
    expect((await patchHelper(send('PATCH', { name: 'Taken over' }), { params: { id: ids.otherHelper } })).status).toBe(404);
    expect((await prisma.helper.findUniqueOrThrow({ where: { id: ids.otherHelper } })).name).toBe('Other Saif');
    expect((await patchTruck(send('PATCH', { defaultHelperId: ids.otherHelper }), { params: { id: ids.t1 } })).status).toBe(400);
    expect((await getCrewReport(new Request(`http://localhost/api/dispatch/crew-report?from=${D}&depotId=${ids.otherDepot}`))).status).toBe(404);
    // The other company's report reads none of this company's loads.
    expect((await readCrewReport(ids.other, { from: D, to: D }, null)).rows).toEqual([]);
    // The other company's own H01 is no clash for this company's codes, and the reverse.
    expect(await prisma.helper.count({ where: { code: 'H01', tenantId: { in: [ids.tenant, ids.other] } } })).toBe(2);
  });
});
