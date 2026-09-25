/**
 * Integration: idempotent confirm and safe batch delete (review F05, F20, stabilization PR2).
 *
 *  - the same file twice: the first confirm adds the orders, the second is refused (409) and
 *    adds nothing - also when both confirms run at the same time, and for files without
 *    sales-order numbers (content hash);
 *  - a checked file older than 24 h, or one whose customer was deactivated after the check,
 *    cannot be confirmed;
 *  - a batch can be deleted (atomically) until any of its orders is in a plan option; after
 *    that the delete is refused and the plan keeps every row it was made for; the same while a
 *    plan for that day is optimizing;
 *  - an order deleted behind the app's back makes the plan "not reconciled" at the next load
 *    change, and DISPATCHED is refused.
 *
 * Requires dev server running (no solver calls are made: plan rows are written directly).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';
import { parseUpload } from '@/lib/csv';
import { legacyRowsHash } from '@/lib/dispatch/intake-server';

let t: TenantHandle;
let depotId = '';
let day = '';
let truckId = '';

function isoPlus(days: number) {
  const d = new Date(Date.now() + 4 * 3600_000); // Muscat
  d.setUTCDate(d.getUTCDate() + days);
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

/** The CSV text of rows [so, customer, item, cases] for `day`. */
function csvText(rows: string[][], withSo = true) {
  const head = withSo ? ['SO No', 'Req. Delivery Date', 'Customer Code', 'Item Code', 'Qty (Cases)'] : ['Req. Delivery Date', 'Customer Code', 'Item Code', 'Qty (Cases)'];
  const body = rows.map(([so, cust, item, qty]) => (withSo ? [so, dmy(day), cust, item, qty] : [dmy(day), cust, item, qty]));
  return [head, ...body].map((r) => r.join(',')).join('\n');
}

/** Upload rows [so, customer, item, cases] for `day`; returns the batch id. */
async function upload(rows: string[][], opts: { withSo?: boolean; name?: string } = {}) {
  const fd = new FormData();
  fd.set('file', new Blob([csvText(rows, opts.withSo ?? true)], { type: 'text/csv' }), opts.name ?? 'orders.csv');
  fd.set('depotId', depotId);
  fd.set('deliveryDate', day);
  const r = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
  expect(r.status).toBe(200);
  return (await json(r)).data as { batchId: string; validation: { errorRows: number; errors: { message: string }[] } };
}
const confirm = (batchId: string, body: unknown = {}) => fetchWith(t.cookieJar, `${BASE}/api/orders/${batchId}/confirm`, j(body));
const del = (batchId: string) => fetchWith(t.cookieJar, `${BASE}/api/orders/${batchId}`, { method: 'DELETE' });
const orderCount = () => prisma.order.count({ where: { tenantId: t.tenantId } });

/** A plan version for the day whose chosen option holds these orders unserved (and optionally one on a load). */
async function planWith(opts: { unservedOrderIds: string[]; loadOrderId?: string; status?: 'READY' | 'OPTIMIZING' }) {
  const run = await prisma.runPlan.create({
    data: { tenantId: t.tenantId, depotId, runDate: new Date(`${day}T00:00:00Z`), status: opts.status ?? 'READY', createdById: t.userId, version: 1, reason: 'INITIAL' },
  });
  const orderIds = [...opts.unservedOrderIds, ...(opts.loadOrderId ? [opts.loadOrderId] : [])];
  const sc = await prisma.scenarioResult.create({
    data: {
      runId: run.id,
      name: 'RECOMMENDED',
      trucksUsed: opts.loadOrderId ? 1 : 0,
      totalDistanceKm: 0,
      totalTimeMin: 0,
      totalCost: 0,
      avgUtilizationPct: 0,
      unservedCount: opts.unservedOrderIds.length,
      detailsJson: { scope: { orderIds, frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] }, loads: [], response_warnings: [], warnings: [] } as never,
      unservedOrders: { create: opts.unservedOrderIds.map((orderId) => ({ orderId, reasonCode: 'MISSING_COORDINATES' as const, reasonMessage: 'Location missing.' })) },
    },
  });
  let loadId: string | null = null;
  if (opts.loadOrderId) {
    const load = await prisma.planLoad.create({
      data: { tenantId: t.tenantId, runId: run.id, truckId, loadNo: 1, departMin: 400, returnMin: 500, distanceKm: 5, durationMin: 100, cases: 1, weightKg: 12, utilizationPct: 1 },
    });
    loadId = load.id;
    await prisma.routeAssignment.create({
      data: { runId: run.id, truckId, orderId: opts.loadOrderId, loadId, loadNo: 1, sequenceInTruck: 1, orderInStop: 0, plannedArrivalMin: 10, plannedDistanceFromPrevKm: 5, plannedLoadCases: 1 },
    });
  }
  await prisma.runPlan.update({ where: { id: run.id }, data: { chosenScenarioId: sc.id } });
  return { run, scenarioId: sc.id, loadId };
}

beforeAll(async () => {
  t = await freshTenant('intake');
  day = isoPlus(3);
  await prisma.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60 } });
  const depot = await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392 } });
  depotId = depot.id;
  truckId = (await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'T01', capacityCases: 120, capacityWeightKg: 2500, fixedCostPerDay: 20, costPerKm: 0.08 } })).id;
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TAN-500-24', name: 'Tanuf 500ml x24', weightPerCaseKg: 12.8 } });
  for (const code of ['C1', 'C2', 'C3', 'C4', 'C5']) {
    await prisma.customer.create({ data: { tenantId: t.tenantId, code, name: code, branchKey: '__MAIN__', lat: 23.6, lng: 58.4, geocodeConfidence: 'HIGH', locationVerified: true } });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('idempotent confirm (F05)', () => {
  it('the same file twice: confirm A adds the orders, confirm B is refused and adds nothing', async () => {
    const rows = [['SO-1', 'C1', 'TAN-500-24', '10'], ['SO-2', 'C2', 'TAN-500-24', '5']];
    const a = await upload(rows);
    const b = await upload([...rows].reverse()); // the same orders in another row order
    expect((await confirm(a.batchId)).status).toBe(200);
    const before = await orderCount();
    const rb = await confirm(b.batchId);
    expect(rb.status).toBe(409);
    expect((await json(rb)).error.code).toBe('DUPLICATE_FILE');
    expect(await orderCount()).toBe(before);
    expect((await prisma.uploadBatch.findUniqueOrThrow({ where: { id: b.batchId } })).status).toBe('VALIDATED');
    expect(await prisma.intakeLineKey.count({ where: { tenantId: t.tenantId, uploadBatchId: a.batchId } })).toBe(2);
    // Uploading it again now: flagged at the check already.
    const c = await upload(rows);
    expect(c.validation.errorRows).toBeGreaterThan(0);
  });

  it('two confirms of two batches at the same time create one set of orders', async () => {
    const rows = [['SO-3', 'C3', 'TAN-500-24', '7']];
    const a = await upload(rows, { name: 'a.csv' });
    const b = await upload([...rows, ['SO-4', 'C3', 'TAN-500-24', '1']], { name: 'b.csv' }); // other content, overlapping line
    const before = await orderCount();
    const [ra, rb] = await Promise.all([confirm(a.batchId), confirm(b.batchId)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(await orderCount()).toBe(before + 1);
    const lines = await prisma.orderLine.count({ where: { salesOrderNo: 'SO-3', order: { tenantId: t.tenantId } } });
    expect(lines).toBe(1);
  });

  it('a file without sales-order numbers is caught by its content (hash) path', async () => {
    const rows = [['', 'C4', 'TAN-500-24', '3']];
    const a = await upload(rows, { withSo: false });
    const b = await upload(rows, { withSo: false });
    const before = await orderCount();
    const [ra, rb] = await Promise.all([confirm(a.batchId), confirm(b.batchId)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(await orderCount()).toBe(before + 1);
  });

  it('a checked file older than 24 h must be uploaded again', async () => {
    const a = await upload([['SO-5', 'C5', 'TAN-500-24', '2']]);
    await prisma.uploadBatch.update({ where: { id: a.batchId }, data: { uploadedAt: new Date(Date.now() - 25 * 3600_000) } });
    const r = await confirm(a.batchId);
    expect(r.status).toBe(409);
    expect((await json(r)).error.code).toBe('STALE_VALIDATION');
  });

  it('a customer deactivated after the check makes confirm refuse (409) and add nothing', async () => {
    const a = await upload([['SO-6', 'C5', 'TAN-500-24', '2']]);
    await prisma.customer.updateMany({ where: { tenantId: t.tenantId, code: 'C5' }, data: { active: false } });
    const before = await orderCount();
    const r = await confirm(a.batchId);
    expect(r.status).toBe(409);
    expect((await json(r)).error.code).toBe('MASTER_CHANGED');
    expect(await orderCount()).toBe(before);
    await prisma.customer.updateMany({ where: { tenantId: t.tenantId, code: 'C5' }, data: { active: true } });
  });

  it('a file without sales orders confirmed before the stabilization deploy (raw-row hash) is not added again', async () => {
    const rows = [['', 'C3', 'TAN-500-24', '9']];
    const pending = await upload(rows, { withSo: false, name: 'old-export.csv' }); // checked before the old batch is seen
    const parsed = await parseUpload(new File([csvText(rows, false)], 'old-export.csv', { type: 'text/csv' }));
    // How a batch confirmed by the previous release looks: fileHash = SHA-256 of the raw rows.
    await prisma.uploadBatch.create({
      data: { tenantId: t.tenantId, fileName: 'old-export.csv', fileType: 'csv', uploadedById: t.userId, status: 'CONFIRMED', depotId, deliveryDate: new Date(`${day}T00:00:00Z`), fileHash: legacyRowsHash(parsed.rows) },
    });
    const before = await orderCount();
    const r = await confirm(pending.batchId);
    expect(r.status).toBe(409);
    expect((await json(r)).error.code).toBe('DUPLICATE_FILE');
    expect(await orderCount()).toBe(before);
    const again = await upload(rows, { withSo: false, name: 'old-export.csv' });
    expect(again.validation.errorRows).toBeGreaterThan(0);
    expect(again.validation.errors[0].message).toMatch(/already confirmed/);
  });

  it('the same sales-order line with another quantity is an error at the check', async () => {
    const a = await upload([['SO-1', 'C1', 'TAN-500-24', '12']]); // SO-1 was confirmed with 10
    expect(a.validation.errorRows).toBe(1);
    expect(a.validation.errors[0].message).toMatch(/already confirmed with 10 cases; this file has 12/);
  });
});

describe('batch delete (F20)', () => {
  it('an unplanned batch is deleted atomically; re-upload and confirm then work; a second delete is 409', async () => {
    const a = await upload([['SO-20', 'C2', 'TAN-500-24', '4']]);
    expect((await confirm(a.batchId)).status).toBe(200);
    const before = await orderCount();
    const r = await del(a.batchId);
    expect(r.status).toBe(200);
    expect(await orderCount()).toBe(before - 1);
    expect((await prisma.uploadBatch.findUniqueOrThrow({ where: { id: a.batchId } })).status).toBe('DELETED');
    expect(await prisma.auditLog.count({ where: { tenantId: t.tenantId, action: 'DELETE', entity: 'UploadBatch', entityId: a.batchId } })).toBe(1);
    expect((await del(a.batchId)).status).toBe(409);
    const again = await upload([['SO-20', 'C2', 'TAN-500-24', '4']]);
    expect((await confirm(again.batchId)).status).toBe(200);
  });

  it('a batch whose orders are only unserved in a plan option cannot be deleted; the unserved rows stay', async () => {
    const a = await upload([['SO-21', 'C3', 'TAN-500-24', '4']]);
    expect((await confirm(a.batchId)).status).toBe(200);
    const order = await prisma.order.findFirstOrThrow({ where: { uploadBatchId: a.batchId } });
    const { run } = await planWith({ unservedOrderIds: [order.id] });
    const r = await del(a.batchId);
    expect(r.status).toBe(409);
    const body = await json(r);
    expect(body.error.code).toBe('BATCH_IN_PLAN');
    expect(body.error.message).toContain(`${day} (version 1)`);
    expect(await prisma.unservedOrder.count({ where: { orderId: order.id } })).toBe(1);
    expect(await prisma.order.count({ where: { id: order.id } })).toBe(1);
    await prisma.runPlan.update({ where: { id: run.id }, data: { status: 'SUPERSEDED' } });
  });

  it('a batch with an order on a load cannot be deleted (clear 409, not "Referenced record does not exist")', async () => {
    const a = await upload([['SO-22', 'C4', 'TAN-500-24', '1']]);
    expect((await confirm(a.batchId)).status).toBe(200);
    const order = await prisma.order.findFirstOrThrow({ where: { uploadBatchId: a.batchId } });
    const { run } = await planWith({ unservedOrderIds: [], loadOrderId: order.id });
    const r = await del(a.batchId);
    expect(r.status).toBe(409);
    const body = await json(r);
    expect(body.error.code).toBe('BATCH_IN_PLAN');
    // No remedy that cannot remove orders (a late order only adds, a re-plan re-plans the same).
    expect(body.error.message).toMatch(/cannot be deleted/);
    expect(body.error.message).toMatch(/not possible in the app yet/);
    expect(body.error.message).not.toMatch(/late order|re-plan/);
    await prisma.runPlan.update({ where: { id: run.id }, data: { status: 'SUPERSEDED' } });
  });

  it('no delete while a plan for that day is optimizing', async () => {
    const a = await upload([['SO-23', 'C5', 'TAN-500-24', '1']]);
    const late = (await prisma.uploadBatch.findUniqueOrThrow({ where: { id: a.batchId } })).isLate;
    expect((await confirm(a.batchId, late ? { lateReason: 'Test' } : {})).status).toBe(200);
    const { run } = await planWith({ unservedOrderIds: [], status: 'OPTIMIZING' });
    await prisma.runPlan.update({ where: { id: run.id }, data: { chosenScenarioId: null } });
    const r = await del(a.batchId);
    expect(r.status).toBe(409);
    expect((await json(r)).error.code).toBe('PLAN_OPTIMIZING');
    await prisma.runPlan.update({ where: { id: run.id }, data: { status: 'SUPERSEDED' } });
  });

  it('an order removed behind the app makes the plan not reconciled; DISPATCHED is refused', async () => {
    const a = await upload([['SO-24', 'C1', 'TAN-500-24', '2'], ['SO-25', 'C2', 'TAN-500-24', '1']]);
    const late = (await prisma.uploadBatch.findUniqueOrThrow({ where: { id: a.batchId } })).isLate;
    expect((await confirm(a.batchId, late ? { lateReason: 'Test' } : {})).status).toBe(200);
    const [onLoad, unserved] = await prisma.order.findMany({ where: { uploadBatchId: a.batchId }, orderBy: { totalCases: 'desc' } });
    const { run, loadId } = await planWith({ unservedOrderIds: [unserved.id], loadOrderId: onLoad.id });
    // Simulate legacy data: the unserved order vanished (the foreign key now forbids it, so its
    // rows go first, as an old cascade would have done).
    await prisma.$executeRaw`DELETE FROM "UnservedOrder" WHERE "orderId" = ${unserved.id}`;
    await prisma.$executeRaw`DELETE FROM "OrderLine" WHERE "orderId" = ${unserved.id}`;
    await prisma.$executeRaw`DELETE FROM "Order" WHERE id = ${unserved.id}`;
    const lock = await fetchWith(t.cookieJar, `${BASE}/api/runs/${run.id}/loads/${loadId}`, j({ status: 'LOCKED' }, 'PATCH'));
    expect(lock.status).toBe(200);
    const after = await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } });
    const recon = after.reconciliationJson as { ok: boolean; problems: string[] };
    expect(recon.ok).toBe(false);
    expect(recon.problems.join(' ')).toContain(`Order ${unserved.id} is in this plan but no longer exists`);
    const d = await fetchWith(t.cookieJar, `${BASE}/api/runs/${run.id}/loads/${loadId}`, j({ status: 'DISPATCHED' }, 'PATCH'));
    expect(d.status).toBe(409);
    await prisma.runPlan.update({ where: { id: run.id }, data: { status: 'SUPERSEDED' } });
  });
});
