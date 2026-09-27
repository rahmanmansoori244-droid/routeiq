/**
 * AUDIT PR A2 "Dispatch screen: never save the wrong thing" ON REAL POSTGRESQL, library level: the
 * route handlers are called in this process with the session faked (vi.mock of @/lib/auth) and the
 * optimizer faked (vi.mock of the solver client); everything else - the routes, the plan service,
 * the day overview and the exports - is the real code against the real database. Needs
 * DATABASE_URL (migrated); the web server and the solver are not used.
 *
 *  - F16: a dispatch plan in which every order is unserved has no load. Its Excel export is the
 *    dispatch workbook (isDispatchPlan on the real rows), its PDF export answers 404 NO_LOADS.
 *  - F07: PATCH /api/customers/:id with avgServiceTimeMin null = no own time (the customer-type or
 *    Settings default, not confirmed), 0 = an explicit 0; "" and text are refused; fields not sent
 *    are not confirmed.
 *  - F17: PUT /api/customers/:id/location with an impossible DMS point or whole degrees is refused
 *    (422) and the customer's pin is not changed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import type { DispatchRequest, DispatchResponse, DispatchScenario } from '@routeiq/shared-types';

const session = vi.hoisted(() => ({ user: { id: '', tenantId: '', role: 'TENANT_ADMIN', name: 'Planner', email: 'planner@a2.test' } }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { ...session.user } })) }));

vi.mock('@/lib/solver-client', () => {
  class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  }
  /** Every stop unserved: no truck could take them. */
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
  return { SolverError, callDispatchSolver: vi.fn(async (req: DispatchRequest) => allUnserved(req)) };
});

import { prisma as libPrisma } from '@/lib/db';
import { getOrCreatePlan } from '@/lib/dispatch/plan-service';
import { startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { getDayOverview } from '@/lib/dispatch/day-overview';
import { isDispatchPlan } from '@/lib/dispatch/legacy-runs';
import { CUSTOMER_SERVICE_COLUMN_DEFAULT } from '@/lib/dispatch/customer-attrs';
import { GET as excelGet } from '@/app/api/runs/[id]/export/excel/route';
import { GET as pdfGet } from '@/app/api/runs/[id]/export/pdf/route';
import { PATCH as customerPatch } from '@/app/api/customers/[id]/route';
import { PUT as locationPut } from '@/app/api/customers/[id]/location/route';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `a2db-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let depotId = '';
let customerId = '';

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

async function seedOrders(day: string, n: number) {
  const product = await prisma.product.findFirstOrThrow({ where: { tenantId } });
  const customers = await prisma.customer.findMany({ where: { tenantId }, orderBy: { code: 'asc' } });
  for (let i = 0; i < n; i++) {
    await prisma.order.create({
      data: {
        tenantId,
        customerId: customers[i % customers.length]!.id,
        depotId,
        deliveryDate: new Date(`${day}T00:00:00.000Z`),
        totalCases: 10,
        totalWeightKg: 100,
        status: 'VALIDATED',
        priority: 3,
        lines: { create: [{ productId: product.id, cases: 10, weightKg: 100, salesOrderNo: `SO-${day}-${i}` }] },
      },
    });
  }
}

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Audit A2 ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  const user = await prisma.user.create({ data: { tenantId, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner', role: 'TENANT_ADMIN' } });
  session.user = { ...session.user, id: user.id, tenantId };
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'MCT', name: 'Muscat', lat: 23.568, lng: 58.392 } })).id;
  await prisma.truck.create({ data: { tenantId, depotId, code: 'T01', capacityCases: 200, capacityWeightKg: 3000, fixedCostPerDay: 20, costPerKm: 0.1 } });
  await prisma.product.create({ data: { tenantId, code: 'W-500', name: 'Water 500ml', weightPerCaseKg: 10 } });
  for (const [code, lat, lng] of [['C1', 23.588, 58.41], ['C2', 23.6, 58.372]] as const) {
    const c = await prisma.customer.create({
      data: { tenantId, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true, avgServiceTimeMin: 25, serviceTimeConfirmed: true },
    });
    if (code === 'C1') customerId = c.id;
  }
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('F16: a dispatch plan with every order unserved', () => {
  it('is a dispatch plan: the Excel export is the dispatch workbook, the PDF export has no driver sheets', async () => {
    const day = isoPlus(3);
    await seedOrders(day, 2);
    const { run } = await getOrCreatePlan(tenantId, depotId, day, session.user.id);
    expect((await startDispatchOptimize(tenantId, run.id, { id: session.user.id }, null)).status).toBe(202);
    const done = await jobsDone(run.id);
    expect(done.status).toBe('READY');
    expect(done.chosenScenarioId).toBeTruthy();
    expect(await prisma.planLoad.count({ where: { runId: run.id } })).toBe(0);

    expect(await isDispatchPlan(tenantId, run.id)).toBe(true);
    const detail = (await getPlanDetail(tenantId, run.id))!;
    expect(detail.isDispatchPlan).toBe(true);
    expect(detail.loads).toEqual([]);
    expect(detail.unserved).toHaveLength(2);

    const x = await excelGet(new Request(`http://localhost/api/runs/${run.id}/export/excel`), { params: { id: run.id } });
    expect(x.status).toBe(200);
    expect(x.headers.get('content-disposition')).toMatch(/filename="nmwc-dispatch-MCT-/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await x.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(['SUMMARY', 'UNSERVED - EXCEPTIONS', 'RECONCILIATION', 'ASSUMPTIONS']));
    expect(wb.getWorksheet('UNSERVED - EXCEPTIONS')!.rowCount).toBeGreaterThanOrEqual(3);

    const p = await pdfGet(new Request(`http://localhost/api/runs/${run.id}/export/pdf`), { params: { id: run.id } });
    expect(p.status).toBe(404);
    expect(((await p.json()) as { error: { code: string } }).error.code).toBe('NO_LOADS');
  });
});

describe('F07: PATCH /api/customers/:id - unloading time and confirmation', () => {
  const patch = (body: unknown) => customerPatch(new Request(`http://localhost/api/customers/${customerId}`, json('PATCH', body)), { params: { id: customerId } });
  const row = () => prisma.customer.findUniqueOrThrow({ where: { id: customerId } });

  it('null = no own time: not confirmed, the day screen shows the default; 0 = an explicit 0', async () => {
    const day = isoPlus(4);
    await seedOrders(day, 1); // C1
    expect((await patch({ avgServiceTimeMin: null })).status).toBe(200);
    expect(await row()).toMatchObject({ avgServiceTimeMin: CUSTOMER_SERVICE_COLUMN_DEFAULT, serviceTimeConfirmed: false });
    const overview = await getDayOverview(tenantId, { date: day, depotId });
    const c1 = overview.customers.find((c) => c.customerId === customerId)!;
    expect(c1.serviceSource).toBe('DEFAULT');

    expect((await patch({ avgServiceTimeMin: 0 })).status).toBe(200);
    expect(await row()).toMatchObject({ avgServiceTimeMin: 0, serviceTimeConfirmed: true });
    const again = (await getDayOverview(tenantId, { date: day, depotId })).customers.find((c) => c.customerId === customerId)!;
    expect(again).toMatchObject({ serviceMin: 0, serviceSource: 'CUSTOMER' });
  });

  it('fields not sent are not confirmed; text and blanks are refused and change nothing', async () => {
    await prisma.customer.update({ where: { id: customerId }, data: { priorityConfirmed: false, serviceTimeConfirmed: false, avgServiceTimeMin: 10 } });
    expect((await patch({ hardWindowStartMin: 360, hardWindowEndMin: 660 })).status).toBe(200);
    expect(await row()).toMatchObject({ hardWindowStartMin: 360, hardWindowEndMin: 660, priorityConfirmed: false, serviceTimeConfirmed: false });
    for (const body of [{ avgServiceTimeMin: '' }, { avgServiceTimeMin: '10 min' }, { avgServiceTimeMin: 2.5 }, { hardWindowStartMin: '', hardWindowEndMin: 600 }]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await row()).toMatchObject({ avgServiceTimeMin: 10, serviceTimeConfirmed: false, hardWindowStartMin: 360, hardWindowEndMin: 660 });
  });
});

describe('F17: PUT /api/customers/:id/location refuses impossible or imprecise DMS input', () => {
  it('23°99\' is refused and whole degrees need a pin: 422, the pin is unchanged', async () => {
    const before = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const put = (input: string) => locationPut(new Request(`http://localhost/api/customers/${customerId}/location`, json('PUT', { input })), { params: { id: customerId } });
    const bad = await put(`23°99'00"N 58°24'00"E`);
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'CONFIRM_ON_MAP', message: expect.stringMatching(/minutes must be 0 to 59/) });
    const coarse = await put('23°N 58°E');
    expect(coarse.status).toBe(422);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect({ lat: after.lat, lng: after.lng, input: after.locationInput }).toEqual({ lat: before.lat, lng: before.lng, input: before.locationInput });
  });
});
