/**
 * RECEIVING HOURS: LATEST ARRIVAL (owner request 13 Oct 2026, "14:00 IS the latest arrival") -
 * end-to-end against the running web app + solver:
 *
 *  - by default (TenantConfig.windowRule FINISH) unloading must be finished by the end of the receiving
 *    hours: a store that takes 60 min to unload and whose hours are 13:50-14:00 cannot be planned (the
 *    optimizer leaves it out: HARD_WINDOW_INFEASIBLE, "it can never finish before closing");
 *  - a company admin switches Settings to "Receiving hours end = latest arrival" (PATCH /api/tenant/config,
 *    audited): the request carries window_rule START, the optimizer echoes it, the store is planned to
 *    arrive between 13:50 and 14:00 and unload until after 14:00, the load keeps the rule
 *    (PlanRules.windowRule START), the plan shows no "rules not applied" note, and LOCK passes the
 *    timetable check.
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';

function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000); // Muscat
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dmy(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
const j = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Upload and confirm rows [so, customer, item, cases] for the day. */
async function addOrders(date: string, rows: string[][]) {
  const head = ['SO No', 'Req. Delivery Date', 'Customer Code', 'Item Code', 'Qty (Cases)'];
  const fd = new FormData();
  fd.set('file', new Blob([[head, ...rows.map(([so, c, i, q]) => [so, dmy(date), c, i, q])].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `wr-${date}.csv`);
  fd.set('depotId', depotId);
  fd.set('deliveryDate', date);
  const up = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
  expect(up.status).toBe(200);
  const v = (await json(up)).data;
  expect(v.validation.errorRows).toBe(0);
  const c = await fetchWith(t.cookieJar, `${BASE}/api/orders/${v.batchId}/confirm`, j(v.validation.late.isLate ? { lateReason: 'Test' } : {}));
  expect(c.status).toBe(200);
}

async function waitForPlan(runId: string, max = 120) {
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') return st.data;
  }
  throw new Error('optimization did not finish');
}

/** Orders for STORE and OTHER on `date`, optimized: the run id and its plan. */
async function planDay(date: string, so: string) {
  await addOrders(date, [
    [`${so}-1`, 'STORE', 'TN1.5L', '200'],
    [`${so}-2`, 'OTHER', 'TN1.5L', '100'],
  ]);
  const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date, depotId, optimize: true }));
  expect(r.status).toBe(202);
  const runId = (await json(r)).data.runId as string;
  expect((await waitForPlan(runId)).run.status).toBe('READY');
  const plan = (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/plan`))).data;
  const job = await prisma.runJob.findFirstOrThrow({ where: { runId }, orderBy: { createdAt: 'desc' } });
  return { runId, plan, request: job.requestJson as any };
}

beforeAll(async () => {
  t = await freshTenant('closing');
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, shiftStartMin: 360, driverShiftMaxMinutes: 720, distanceProvider: 'HAVERSINE', osrmUrl: null },
  });
  depotId = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } })).id;
  await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'T01', capacityCases: 1000, capacityWeightKg: 0, fixedCostPerDay: 20, costPerKm: 0.08 } });
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TN1.5L', name: 'Tanuf 1.5L', weightPerCaseKg: 10 } });
  // The store: open until 14:00, and the truck may not come before 13:50 - so it arrives at 13:50 at the
  // earliest, and its 60 min of unloading (confirmed) runs until 14:50 at the earliest.
  await prisma.customer.create({
    data: {
      tenantId: t.tenantId, code: 'STORE', name: 'Store 12', branchKey: '__MAIN__', lat: 23.588, lng: 58.41, geocodeConfidence: 'HIGH', locationVerified: true,
      priority: 2, priorityConfirmed: true, avgServiceTimeMin: 60, serviceTimeConfirmed: true, hardWindowStartMin: 13 * 60 + 50, hardWindowEndMin: 14 * 60,
    },
  });
  await prisma.customer.create({
    data: {
      tenantId: t.tenantId, code: 'OTHER', name: 'Other shop', branchKey: '__MAIN__', lat: 23.6, lng: 58.372, geocodeConfidence: 'HIGH', locationVerified: true,
      priority: 3, priorityConfirmed: true, avgServiceTimeMin: 20, serviceTimeConfirmed: true,
    },
  });
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('receiving hours: latest arrival or unloading finished (company setting)', () => {
  it('by default (FINISH) the store arriving 13:50 with 60 min of unloading is refused: left out, receiving hours cannot be met', async () => {
    expect((await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).windowRule).toBe('FINISH');
    const { plan, request } = await planDay(isoPlus(2), 'F');
    expect(request.config.window_rule).toBe('FINISH');
    const store = plan.unserved.find((u: any) => u.customerCode === 'STORE');
    expect(store).toMatchObject({ reasonCode: 'HARD_WINDOW_INFEASIBLE' });
    expect(store.reasonMessage).toMatch(/can never finish before closing/);
    expect(plan.loads.flatMap((l: any) => l.stops).some((s: any) => s.customerCode === 'STORE')).toBe(false);
    expect(plan.scenarios.find((s: any) => s.chosen).windowRule).toBe('FINISH');
  });

  it('switched to "latest arrival" (START, audited): the same store is planned to arrive by 14:00 and unload after it, and its load locks', async () => {
    const saved = await fetchWith(t.cookieJar, `${BASE}/api/tenant/config`, j({ config: { windowRule: 'START' }, expect: { config: { windowRule: 'FINISH' } } }, 'PATCH'));
    expect(saved.status).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: t.tenantId, entity: 'TenantConfig', action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect(audit.beforeJson).toMatchObject({ config: { windowRule: 'FINISH' } });
    expect(audit.afterJson).toMatchObject({ config: { windowRule: 'START' } });
    const bad = await fetchWith(t.cookieJar, `${BASE}/api/tenant/config`, j({ config: { windowRule: 'ARRIVAL' } }, 'PATCH'));
    expect(bad.status).toBe(400);

    const { runId, plan, request } = await planDay(isoPlus(3), 'S');
    expect(request.config.window_rule).toBe('START');
    expect(plan.unserved.filter((u: any) => u.customerCode === 'STORE')).toEqual([]);
    const load = plan.loads.find((l: any) => l.stops.some((s: any) => s.customerCode === 'STORE'));
    expect(load).toBeTruthy();
    const stop = load.stops.find((s: any) => s.customerCode === 'STORE');
    expect(stop.serviceStartMin).toBeGreaterThanOrEqual(13 * 60 + 50);
    expect(stop.serviceStartMin).toBeLessThanOrEqual(14 * 60);
    expect(stop.departureMin).toBeGreaterThan(14 * 60); // unloading continues after the end of the receiving hours
    expect(stop.hardWindowOk).toBe(true);
    expect(plan.scenarios.find((s: any) => s.chosen).windowRule).toBe('START');
    expect(plan.warnings.filter((w: string) => /Made by a planner without the rule/.test(w))).toEqual([]);
    expect(plan.feasibility).toMatchObject({ ok: true });

    // The load keeps the rule the optimizer echoed; the timetable check at LOCK uses it.
    const row = await prisma.planLoad.findUniqueOrThrow({ where: { id: load.id } });
    expect((row.truckSnapshotJson as any).rules.windowRule).toBe('START');
    const lock = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/loads/${load.id}`, j({ status: 'LOCKED' }, 'PATCH'));
    expect(lock.status).toBe(200);
  });
});
