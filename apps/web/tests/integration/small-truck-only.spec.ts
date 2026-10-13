/**
 * SMALL TRUCK ONLY customers (owner request after the first live night, 12 Oct 2026; owner decisions
 * 13 Oct 2026) - end-to-end against the running web app + solver:
 *
 *  - a customer marked "Small truck only (3-ton)" (PATCH /api/customers/:id, audited) is planned on the
 *    6-bay truck only, although the 12-bay truck is cheaper and has room: the request sends its stop with
 *    allowed_truck_ids = the small trucks, the optimizer echoes the rule, and the plan screen marks the stop
 *    SMALL TRUCK ONLY (not red: its truck is small);
 *  - a customer marked AFTER planning, on the 12-bay truck: LOCK of its load is refused with 409
 *    SMALL_TRUCK_ONLY naming it, the plan screen shows the mark red and the day screen's step 3 calls the
 *    plan out of date (outdated.smallTruckBlocked: RE-PLAN on); unmarked again, the load locks;
 *  - the setting lowered after planning (a small truck = at most 4 bays): LOCK of the 6-bay load is
 *    refused the same way; raised again, it locks.
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running (the solver of this release: an older
 * one ignores the allowed trucks, and the plan says so).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';
let day = '';
let runV1 = '';
let bigId = '';
let smallId = '';

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
  fd.set('file', new Blob([[head, ...rows.map(([so, c, i, q]) => [so, dmy(date), c, i, q])].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `st-${date}.csv`);
  fd.set('depotId', depotId);
  fd.set('deliveryDate', date);
  const up = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
  expect(up.status).toBe(200);
  const v = (await json(up)).data;
  expect(v.validation.errorRows).toBe(0);
  const c = await fetchWith(t.cookieJar, `${BASE}/api/orders/${v.batchId}/confirm`, j(v.validation.late.isLate ? { lateReason: 'Test' } : {}));
  expect(c.status).toBe(200);
}

/** The day screen's overview (GET /api/dispatch/day). */
async function dayScreen() {
  return (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/day?date=${day}&depotId=${depotId}`))).data;
}

async function waitForPlan(runId: string, max = 120) {
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') return st.data;
  }
  throw new Error('optimization did not finish');
}
const plan = async () => (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/plan`))).data;
const lock = (loadId: string) => fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/loads/${loadId}`, j({ status: 'LOCKED' }, 'PATCH'));
const mark = async (code: string, smallTruckOnly: boolean) => {
  const c = await prisma.customer.findFirstOrThrow({ where: { tenantId: t.tenantId, code } });
  const r = await fetchWith(t.cookieJar, `${BASE}/api/customers/${c.id}`, { ...j({ smallTruckOnly }), method: 'PATCH' });
  expect(r.status).toBe(200);
  return c.id;
};

beforeAll(async () => {
  t = await freshTenant('smalltruck');
  day = isoPlus(2);
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, shiftStartMin: 360, driverShiftMaxMinutes: 720, distanceProvider: 'HAVERSINE', osrmUrl: null },
  });
  depotId = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } })).id;
  // NMWC's sizes: a 10-ton with 12 bays (cheap to run here) and a 3-ton with 6 bays (dear, one load a day:
  // the day's 8.5 pallets cannot all ride it, so the 10-ton always carries some of the other customers).
  bigId = (await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'T10', capacityCases: 1140, capacityWeightKg: 0, fixedCostPerDay: 5, costPerKm: 0.05, bays: 12 } })).id;
  smallId = (await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'T03', capacityCases: 570, capacityWeightKg: 0, fixedCostPerDay: 60, costPerKm: 0.2, bays: 6, maxTripsPerDay: 1 } })).id;
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TN1.5L', name: 'Tanuf 1.5L', weightPerCaseKg: 10, casesPerPallet: 95 } });
  for (const [code, lat, lng] of [['SHOP', 23.588, 58.41], ['HYPER', 23.6, 58.372], ['MART', 23.555, 58.335]] as const) {
    await prisma.customer.create({
      data: { tenantId: t.tenantId, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 2, priorityConfirmed: true },
    });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('small truck only customers', () => {
  it('a marked customer is planned on the 6-bay truck only; the request carries the allowed trucks and the optimizer echoes the rule', async () => {
    const shopId = await mark('SHOP', true);
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: t.tenantId, entity: 'Customer', entityId: shopId, action: 'UPDATE' }, orderBy: { createdAt: 'desc' } });
    expect((audit?.afterJson as any)?.smallTruckOnly).toBe(true);
    await addOrders(day, [
      ['SO-1', 'SHOP', 'TN1.5L', '100'], // 1.1 pallets: fits either truck
      ['SO-2', 'HYPER', 'TN1.5L', '400'], // 4.2 pallets
      ['SO-3', 'MART', 'TN1.5L', '300'], // 3.2 pallets
    ]);
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true }));
    expect(r.status).toBe(202);
    runV1 = (await json(r)).data.runId;
    expect((await waitForPlan(runV1)).run.status).toBe('READY');

    const job = await prisma.runJob.findFirstOrThrow({ where: { runId: runV1 }, orderBy: { createdAt: 'desc' } });
    const stops = (job.requestJson as any).stops as any[];
    const shopStops = stops.filter((s) => s.customer_id === shopId);
    expect(shopStops.length).toBeGreaterThan(0);
    for (const s of shopStops) expect([s.allowed_truck_ids, s.allowed_trucks_label]).toEqual([[smallId], 'a small truck (at most 6 bays)']);
    for (const s of stops.filter((x) => x.customer_id !== shopId)) expect(s.allowed_truck_ids).toBeUndefined();

    const p = await plan();
    expect(p.reconciliation.ok).toBe(true);
    const onTrucks = p.loads.flatMap((l: any) => l.stops.map((s: any) => ({ code: s.customerCode, truck: l.truckCode, s })));
    const shop = onTrucks.filter((x: any) => x.code === 'SHOP');
    expect(shop.length).toBeGreaterThan(0);
    for (const x of shop) {
      expect(x.truck).toBe('T03');
      expect(x.s.smallTruckOnly).toBe(true);
      expect(x.s.smallTruckBreach).toBeUndefined();
    }
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runV1 } });
    const sc = await prisma.scenarioResult.findUniqueOrThrow({ where: { id: run.chosenScenarioId! } });
    expect((sc.detailsJson as any).allowed_trucks_rule).toBe(true);
    expect((sc.detailsJson as any).feasibility.status).toBe('VERIFIED');
  });

  it('a customer marked after planning on the 12-bay truck: LOCK is refused (409 SMALL_TRUCK_ONLY), the plan shows it red; unmarked, the load locks', async () => {
    const p = await plan();
    const bigLoad = p.loads.find((l: any) => l.truckCode === 'T10' && l.stops.some((s: any) => s.customerCode !== 'SHOP'));
    expect(bigLoad).toBeTruthy();
    const victim = bigLoad.stops.find((s: any) => s.customerCode !== 'SHOP').customerCode as string;
    await mark(victim, true);
    try {
      const r = await lock(bigLoad.id);
      expect(r.status).toBe(409);
      const b = await json(r);
      expect(b.error.code).toBe('SMALL_TRUCK_ONLY');
      expect(b.error.customers).toEqual([victim]);
      expect(b.error.error ?? b.error.message ?? '').toMatch(/T10 \(12 bays\) is not a small truck/);
      expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: bigLoad.id } })).status).toBe('PLANNED');
      const again = (await plan()).loads.find((l: any) => l.id === bigLoad.id);
      expect(again.stops.find((s: any) => s.customerCode === victim)).toMatchObject({ smallTruckOnly: true, smallTruckBreach: true });
      // Step 3: the plan is out of date (RE-PLAN on), not "up to date" while LOCK is refused.
      expect((await dayScreen()).outdated.smallTruckBlocked).toBe(1);
    } finally {
      await mark(victim, false);
    }
    expect((await dayScreen()).outdated.smallTruckBlocked).toBe(0);
    expect((await lock(bigLoad.id)).status).toBe(200);
  });

  it('the setting lowered after planning (at most 4 bays): LOCK of the 6-bay load is refused; raised again, it locks', async () => {
    const p = await plan();
    const smallLoad = p.loads.find((l: any) => l.truckCode === 'T03' && l.stops.some((s: any) => s.customerCode === 'SHOP'));
    expect(smallLoad).toBeTruthy();
    await prisma.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { smallTruckMaxBays: 4 } });
    try {
      const r = await lock(smallLoad.id);
      expect(r.status).toBe(409);
      const b = await json(r);
      expect(b.error).toMatchObject({ code: 'SMALL_TRUCK_ONLY', truckCode: 'T03', truckBays: 6, smallTruckMaxBays: 4, customers: ['SHOP'] });
    } finally {
      await prisma.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { smallTruckMaxBays: 6 } });
    }
    expect((await lock(smallLoad.id)).status).toBe(200);
  });
});
