/**
 * TRUE WEIGHTS OF SPLIT PARTS - end-to-end against the running web app + solver (review F01,
 * stabilization PR2):
 *
 *  - one case heavier than every truck payload (a wrong case weight) is left unserved before
 *    the optimizer as EXCEEDS_ANY_TRUCK_CAPACITY with "check the product weight"; the rest of
 *    the order is planned and the plan reconciles;
 *  - every load's weight is the sum of what it carries and never above its truck's payload;
 *  - with a SMALL (100 kg) and a BIG (1000 kg) truck, 120 kg cases go only on BIG.
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotA = '';
let depotB = '';
const payload: Record<string, number> = {};

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

async function addOrders(depotId: string, day: string, rows: string[][]) {
  const head = ['SO No', 'Req. Delivery Date', 'Customer Code', 'Item Code', 'Qty (Cases)'];
  const fd = new FormData();
  fd.set('file', new Blob([[head, ...rows.map(([so, c, i, q]) => [so, dmy(day), c, i, q])].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `h-${day}.csv`);
  fd.set('depotId', depotId);
  fd.set('deliveryDate', day);
  const up = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
  expect(up.status).toBe(200);
  const v = (await json(up)).data;
  expect(v.validation.errorRows).toBe(0);
  expect((await fetchWith(t.cookieJar, `${BASE}/api/orders/${v.batchId}/confirm`, j({}))).status).toBe(200);
}

async function optimizeAndWait(depotId: string, day: string) {
  const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true }));
  expect(r.status).toBe(202);
  const runId = (await json(r)).data.runId;
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') break;
  }
  const pd = (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/plan`))).data;
  return { runId, pd };
}

function checkLoads(pd: any) {
  for (const l of pd.loads) {
    expect(l.weightKg).toBeCloseTo(l.stops.reduce((a: number, s: any) => a + s.weightKg, 0), 0);
    expect(l.weightKg).toBeLessThanOrEqual(payload[l.truckCode] + 0.05);
  }
}

beforeAll(async () => {
  t = await freshTenant('heavy');
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, shiftStartMin: 360, driverShiftMaxMinutes: 720, distanceProvider: 'HAVERSINE', osrmUrl: null, splitDeliveries: true },
  });
  depotA = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'A', name: 'Depot A', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } })).id;
  depotB = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'B', name: 'Depot B', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } })).id;
  for (const [depotId, code, cases, kg, trips] of [
    [depotA, 'VAN1', 100, 100, 3],
    [depotA, 'VAN2', 100, 100, 3],
    [depotB, 'SMALL', 100, 100, 5],
    [depotB, 'BIG', 100, 1000, 1],
  ] as const) {
    await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code, capacityCases: cases, capacityWeightKg: kg, fixedCostPerDay: 20, costPerKm: 0.08, maxTripsPerDay: trips } });
    payload[code] = kg;
  }
  for (const [code, name, kg] of [['LIGHT', 'Light case', 10], ['HEAVY', 'Case weight typed per pallet', 120]] as const) {
    await prisma.product.create({ data: { tenantId: t.tenantId, code, name, weightPerCaseKg: kg } });
  }
  for (const [code, lat, lng] of [['K1', 23.588, 58.41], ['K2', 23.6, 58.372]] as const) {
    await prisma.customer.create({
      data: { tenantId: t.tenantId, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 2, priorityConfirmed: true },
    });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('true weights of split parts (F01)', () => {
  it('100 kg trucks and a 120 kg case: the case is unserved with "check the product weight"; the rest is planned and reconciles', async () => {
    const day = isoPlus(2);
    await addOrders(depotA, day, [['SO-1', 'K1', 'HEAVY', '1'], ['SO-1', 'K1', 'LIGHT', '15'], ['SO-2', 'K2', 'LIGHT', '5']]);
    const { runId, pd } = await optimizeAndWait(depotA, day);
    expect(pd.reconciliation.problems).toEqual([]);
    expect(pd.reconciliation.ok).toBe(true);
    const heavy = pd.unserved.filter((u: any) => u.reasonCode === 'EXCEEDS_ANY_TRUCK_CAPACITY');
    expect(heavy).toHaveLength(1);
    expect(heavy[0].cases).toBe(1);
    expect(heavy[0].reasonMessage).toMatch(/One case of HEAVY weighs 120 kg, more than any truck payload \(100 kg\) - check the product weight/);
    // The LIGHT cases of the same order are on trucks.
    const k1 = pd.loads.flatMap((l: any) => l.stops).filter((s: any) => s.customerCode === 'K1');
    expect(k1.reduce((a: number, s: any) => a + s.cases, 0)).toBe(15);
    checkLoads(pd);
    // What the solver was sent: no part above the payload it was sized for, and no heavy case.
    const job = await prisma.runJob.findFirstOrThrow({ where: { runId }, orderBy: { attemptNo: 'desc' } });
    for (const s of (job.requestJson as any).stops) expect(s.demand_kg).toBeLessThanOrEqual(100);
  });

  it('SMALL (100 kg) and BIG (1000 kg): 120 kg cases are sized for and planned on BIG only', async () => {
    await prisma.product.create({ data: { tenantId: t.tenantId, code: 'MED', name: 'Big drum', weightPerCaseKg: 120 } });
    const day = isoPlus(3);
    await addOrders(depotB, day, [['SO-10', 'K1', 'MED', '20']]);
    const { runId, pd } = await optimizeAndWait(depotB, day);
    expect(pd.reconciliation.ok).toBe(true);
    const job = await prisma.runJob.findFirstOrThrow({ where: { runId }, orderBy: { attemptNo: 'desc' } });
    const req = job.requestJson as any;
    expect(req.stops.length).toBeGreaterThan(1);
    for (const s of req.stops) expect(s.demand_kg).toBeGreaterThan(100); // true kg: no truck of 100 kg can take them
    for (const l of pd.loads) expect(l.truckCode).toBe('BIG');
    checkLoads(pd);
    const planned = pd.loads.flatMap((l: any) => l.stops).reduce((a: number, s: any) => a + s.cases, 0);
    const unserved = pd.unserved.reduce((a: number, u: any) => a + u.cases, 0);
    expect(planned + unserved).toBe(20);
    expect(pd.warnings.join(' ')).toMatch(/sized for BIG/);
  });
});
