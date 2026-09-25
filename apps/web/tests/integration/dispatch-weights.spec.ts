/**
 * WEIGHTS, DEACTIVATED CUSTOMERS AND LATE-ORDER CHECKS - end-to-end against the running web app +
 * solver (review F02, F05, ADD-deactivated-masters, L16; stabilization PR2):
 *
 *  - a new SKU confirmed without a weight blocks OPTIMIZE with 409 WEIGHT_REQUIRED; entering the
 *    case weight afterwards is applied to the open lines at the next optimize (audited) and
 *    reaches the solver request;
 *  - "optimize anyway" (allowMissingWeights) plans such lines as 0 kg and the plan says so;
 *  - a line on a locked load keeps its weight when the product weight changes later;
 *  - a deactivated customer's open orders are unserved (INVALID_CUSTOMER) until it is
 *    reactivated;
 *  - the late-order route refuses an SO+SKU already confirmed and inactive customers / products
 *    (409, no order created).
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';
const days: string[] = [];

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

/** Upload and confirm rows [so, customer, item, cases] for a day. */
async function addOrders(day: string, rows: string[][]) {
  const head = ['SO No', 'Req. Delivery Date', 'Customer Code', 'Item Code', 'Qty (Cases)'];
  const fd = new FormData();
  fd.set('file', new Blob([[head, ...rows.map(([so, c, i, q]) => [so, dmy(day), c, i, q])].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `w-${day}.csv`);
  fd.set('depotId', depotId);
  fd.set('deliveryDate', day);
  const up = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
  expect(up.status).toBe(200);
  const v = (await json(up)).data;
  expect(v.validation.errorRows).toBe(0);
  const c = await fetchWith(t.cookieJar, `${BASE}/api/orders/${v.batchId}/confirm`, j(v.validation.late.isLate ? { lateReason: 'Test' } : {}));
  expect(c.status).toBe(200);
  return v;
}

async function waitForPlan(runId: string, max = 120) {
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') return st.data;
  }
  throw new Error('optimization did not finish');
}
const optimize = (day: string, extra: Record<string, unknown> = {}) => fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true, ...extra }));
const plan = async (runId: string) => (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/plan`))).data;
const dayView = async (day: string) => (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/day?date=${day}&depotId=${depotId}`))).data;

beforeAll(async () => {
  t = await freshTenant('weights');
  for (let i = 2; i <= 6; i++) days.push(isoPlus(i));
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, shiftStartMin: 360, driverShiftMaxMinutes: 720, distanceProvider: 'HAVERSINE', osrmUrl: null },
  });
  depotId = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } })).id;
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code, capacityCases: 120, capacityWeightKg: 2500, fixedCostPerDay: 20, costPerKm: 0.08 } });
  }
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TAN-500-24', name: 'Tanuf 500ml x24', weightPerCaseKg: 12.8 } });
  for (const [code, lat, lng] of [['C1', 23.588, 58.41], ['C2', 23.6, 58.372], ['C3', 23.555, 58.335]] as const) {
    await prisma.customer.create({
      data: { tenantId: t.tenantId, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 2, priorityConfirmed: true },
    });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('unknown weights (F02)', () => {
  it('a new SKU without a weight: 409 WEIGHT_REQUIRED; the weight entered later reaches the solver, audited', async () => {
    const day = days[0];
    const v = await addOrders(day, [['SO-1', 'C1', 'TAN-500-24', '10'], ['SO-1', 'C1', 'NEW-1', '4'], ['SO-2', 'C2', 'TAN-500-24', '5']]);
    expect(v.validation.issues.productsWithoutWeight).toEqual(['NEW-1']);
    expect((await dayView(day)).productsWithoutWeight.map((p: any) => p.code)).toEqual(['NEW-1']);

    const r = await optimize(day);
    expect(r.status).toBe(409);
    const b = await json(r);
    expect(b.error.code).toBe('WEIGHT_REQUIRED');
    expect(b.error.unknownWeights).toEqual([{ productCode: 'NEW-1', productName: 'NEW-1', lines: 1, cases: 4 }]);

    const p = await prisma.product.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'NEW-1' } });
    const patch = await fetchWith(t.cookieJar, `${BASE}/api/products/${p.id}`, j({ weightPerCaseKg: 7.5 }, 'PATCH'));
    expect(patch.status).toBe(200);
    const view = await dayView(day);
    expect(view.productsWithoutWeight).toEqual([]);
    expect(view.weightsToApply.map((x: any) => x.code)).toEqual(['NEW-1']);

    const ok = await optimize(day);
    expect(ok.status).toBe(202);
    const runId = (await json(ok)).data.runId;
    await waitForPlan(runId);
    const line = await prisma.orderLine.findFirstOrThrow({ where: { productId: p.id, order: { tenantId: t.tenantId } }, include: { order: true } });
    expect(line.weightKg).toBe(30);
    expect(line.order.totalWeightKg).toBeCloseTo(128 + 30, 3);
    const job = await prisma.runJob.findFirstOrThrow({ where: { runId }, orderBy: { attemptNo: 'desc' } });
    const stop = (job.requestJson as any).stops.find((s: any) => s.order_ids.includes(line.orderId));
    expect(stop.demand_kg).toBeCloseTo(158, 1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: t.tenantId, action: 'ORDER_WEIGHTS_RESOLVED', entityId: runId } });
    expect((audit.afterJson as any).lines).toEqual([expect.objectContaining({ lineId: line.id, beforeKg: 0, afterKg: 30, product: 'NEW-1' })]);
    expect((await dayView(day)).weightsToApply).toEqual([]);
    const pd = await plan(runId);
    expect(pd.reconciliation.ok).toBe(true);
    for (const l of pd.loads) expect(l.weightKg).toBeCloseTo(l.stops.reduce((a: number, s: any) => a + s.weightKg, 0), 0);
  });

  it('optimize anyway (allowMissingWeights): 202, planned as 0 kg, and the plan keeps a warning', async () => {
    const day = days[1];
    await addOrders(day, [['SO-10', 'C1', 'NEW-2', '6'], ['SO-11', 'C2', 'TAN-500-24', '5']]);
    expect((await optimize(day)).status).toBe(409);
    const r = await optimize(day, { allowMissingWeights: true });
    expect(r.status).toBe(202);
    const runId = (await json(r)).data.runId;
    await waitForPlan(runId);
    const pd = await plan(runId);
    expect(pd.warnings.join(' ')).toMatch(/Planned without weights for 1 order line\(s\) \(6 cases\): NEW-2/);
    const started = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: t.tenantId, action: 'OPTIMIZE_STARTED', entityId: runId } });
    expect((started.afterJson as any).allowMissingWeights).toBe(true);
  });

  it('a line on a locked load keeps its weight when the product weight is entered later', async () => {
    const day = days[2];
    await addOrders(day, [['SO-20', 'C3', 'NEW-3', '5'], ['SO-21', 'C2', 'TAN-500-24', '5']]);
    const r = await optimize(day, { allowMissingWeights: true });
    expect(r.status).toBe(202);
    const runId = (await json(r)).data.runId;
    await waitForPlan(runId);
    const pd = await plan(runId);
    const load = pd.loads.find((l: any) => l.stops.some((s: any) => s.customerCode === 'C3'));
    expect(load).toBeTruthy();
    // Lock that truck's loads in order up to the one carrying C3.
    for (const l of pd.loads.filter((x: any) => x.truckId === load.truckId && x.loadNo <= load.loadNo).sort((a: any, b: any) => a.loadNo - b.loadNo)) {
      expect((await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/loads/${l.id}`, j({ status: 'LOCKED' }, 'PATCH'))).status).toBe(200);
    }
    const p = await prisma.product.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'NEW-3' } });
    await fetchWith(t.cookieJar, `${BASE}/api/products/${p.id}`, j({ weightPerCaseKg: 9 }, 'PATCH'));
    // Something open to plan, whatever loads were locked.
    const late = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/late-order`, j({ date: day, depotId, customerCode: 'C1', reason: 'Top-up', lines: [{ productCode: 'TAN-500-24', cases: 3, salesOrderNo: 'SO-22' }] }));
    expect(late.status).toBe(201);
    const rp = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/replan`, j({ reason: 'REOPTIMIZE' }));
    expect(rp.status).toBe(202);
    const v2 = (await json(rp)).data.runId;
    await waitForPlan(v2);
    const line = await prisma.orderLine.findFirstOrThrow({ where: { productId: p.id, order: { tenantId: t.tenantId } } });
    expect(line.weightKg).toBe(0); // frozen: what was loaded does not change
    const p2 = await plan(v2);
    expect(p2.reconciliation.ok).toBe(true);
    const carried = p2.loads.find((l: any) => l.carried && l.stops.some((s: any) => s.customerCode === 'C3'));
    expect(carried.status).toBe('LOCKED');
  });
});

describe('deactivated customer (ADD-deactivated-masters)', () => {
  it('open orders are unserved INVALID_CUSTOMER; reactivating the customer plans them again', async () => {
    const day = days[3];
    await addOrders(day, [['SO-30', 'C1', 'TAN-500-24', '5'], ['SO-31', 'C2', 'TAN-500-24', '5']]);
    const c2 = await prisma.customer.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'C2' } });
    const off = await fetchWith(t.cookieJar, `${BASE}/api/customers/${c2.id}`, j({ active: false }, 'PATCH'));
    expect(off.status).toBe(200);
    expect((await json(off)).data.warning).toMatch(/open order\(s\) of this customer/);
    const view = await dayView(day);
    expect(view.customers.find((c: any) => c.code === 'C2').issues.map((i: any) => i.code)).toEqual(['CUSTOMER_INACTIVE']);

    const r = await optimize(day);
    expect(r.status).toBe(202); // not blocking: left unserved with a reason
    const runId = (await json(r)).data.runId;
    await waitForPlan(runId);
    const pd = await plan(runId);
    expect(pd.reconciliation.ok).toBe(true);
    const u = pd.unserved.find((x: any) => x.customerCode === 'C2');
    expect(u.reasonCode).toBe('INVALID_CUSTOMER');
    const order = await prisma.order.findFirstOrThrow({ where: { tenantId: t.tenantId, customerId: c2.id, deliveryDate: new Date(`${day}T00:00:00Z`) } });
    expect(order.status).toBe('UNSERVED');

    await fetchWith(t.cookieJar, `${BASE}/api/customers/${c2.id}`, j({ active: true }, 'PATCH'));
    const rp = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/replan`, j({ reason: 'REOPTIMIZE' }));
    expect(rp.status).toBe(202);
    const v2 = (await json(rp)).data.runId;
    await waitForPlan(v2);
    const p2 = await plan(v2);
    expect(p2.loads.some((l: any) => l.stops.some((s: any) => s.customerCode === 'C2'))).toBe(true);
  });
});

describe('late-order checks (F05, L16)', () => {
  it('refuses an SO+SKU already confirmed, and inactive customers or products, without creating an order', async () => {
    const day = days[4];
    await addOrders(day, [['SO-40', 'C1', 'TAN-500-24', '5']]);
    const base = { date: day, depotId, customerCode: 'c1', reason: 'Phoned in', priority: 1 };
    const before = await prisma.order.count({ where: { tenantId: t.tenantId } });

    const dup = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/late-order`, j({ ...base, lines: [{ productCode: 'tan-500-24', cases: 5, salesOrderNo: 'so-40' }] }));
    expect(dup.status).toBe(409);
    expect((await json(dup)).error.code).toBe('DUPLICATE_LINES');

    const c3 = await prisma.customer.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'C3' } });
    await prisma.customer.update({ where: { id: c3.id }, data: { active: false } });
    const ic = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/late-order`, j({ ...base, customerCode: 'C3', lines: [{ productCode: 'TAN-500-24', cases: 1 }] }));
    expect(ic.status).toBe(409);
    expect((await json(ic)).error.message).toMatch(/Customer C3 is inactive\. Reactivate it in Customers or use another code/);
    await prisma.customer.update({ where: { id: c3.id }, data: { active: true } });

    const prod = await prisma.product.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'TAN-500-24' } });
    await prisma.product.update({ where: { id: prod.id }, data: { active: false } });
    const ip = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/late-order`, j({ ...base, lines: [{ productCode: 'TAN-500-24', cases: 1 }] }));
    expect(ip.status).toBe(409);
    await prisma.product.update({ where: { id: prod.id }, data: { active: true } });

    const badDate = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/late-order`, j({ ...base, date: '2026-02-31', lines: [{ productCode: 'TAN-500-24', cases: 1 }] }));
    expect(badDate.status).toBe(400);
    expect(await prisma.order.count({ where: { tenantId: t.tenantId } })).toBe(before);

    // Another sales order for the same SKU and customer is fine; a new SKU is reported without weight.
    const ok = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/late-order`, j({ ...base, lines: [{ productCode: 'TAN-500-24', cases: 2, salesOrderNo: 'SO-41' }, { productCode: 'NEW-9', cases: 1, salesOrderNo: 'SO-41' }] }));
    expect(ok.status).toBe(201);
    expect((await json(ok)).data.productsWithoutWeight).toEqual(['NEW-9']);
    const again = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/late-order`, j({ ...base, lines: [{ productCode: 'TAN-500-24', cases: 2, salesOrderNo: 'SO-41' }] }));
    expect(again.status).toBe(409);
  });
});
