/**
 * Integration: stabilization PR6 - scenario-test findings on intake and messages, through the
 * real routes and database.
 *
 *  - B2 (S04): an order workbook with order rows on two sheets (Orders + LateOrder) is refused
 *    with the sheet names; nothing is saved;
 *  - S04: a file for a day whose plan has a dispatched load is late, and LATE_REASON_REQUIRED says
 *    "a plan already exists ... dispatched", not "after the planning cutoff";
 *  - S05: re-uploading lines confirmed for a customer deactivated since lists them as "Already
 *    confirmed" (skipped), not as "inactive" row errors; messages use the master codes.
 *
 * Requires dev server running (no solver calls are made: plan rows are written directly).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';
let truckId = '';
let day = '';

function isoPlus(days: number) {
  const d = new Date(Date.now() + 4 * 3600_000); // Muscat
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const j = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Rows [so, customer, item, cases] with the canonical headers of the scenario files. */
function rowsOf(rows: string[][]) {
  return rows.map(([so, cust, item, qty]) => ({ sales_order_no: so, delivery_date: day, customer_code: cust, branch_code: '', product_code: item, cases: Number(qty) }));
}

async function uploadFile(file: Blob, name: string) {
  const fd = new FormData();
  fd.set('file', file, name);
  fd.set('depotId', depotId);
  fd.set('deliveryDate', day);
  return fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
}

function csv(rows: string[][]) {
  const text = [['SO No', 'Req. Delivery Date', 'Customer Code', 'Item Code', 'Qty (Cases)'], ...rows.map(([so, c, i, q]) => [so, day, c, i, q])].map((r) => r.join(',')).join('\n');
  return new Blob([text], { type: 'text/csv' });
}

async function upload(rows: string[][]) {
  const r = await uploadFile(csv(rows), 'orders.csv');
  expect(r.status).toBe(200);
  return (await json(r)).data as {
    batchId: string;
    validation: { errorRows: number; errors: { row: number; message: string }[]; duplicates: { row: number; message: string }[]; late: { isLate: boolean; reasons: string[] } };
  };
}
const confirm = (batchId: string, body: unknown = {}) => fetchWith(t.cookieJar, `${BASE}/api/orders/${batchId}/confirm`, j(body));

beforeAll(async () => {
  t = await freshTenant('pr6');
  day = isoPlus(3);
  await prisma.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60 } });
  depotId = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'NZW', name: 'Nizwa depot', lat: 22.93, lng: 57.53 } })).id;
  truckId = (await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'T01', capacityCases: 800, capacityWeightKg: 9000, fixedCostPerDay: 25, costPerKm: 0.12 } })).id;
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TEST-W500', name: 'Water 500ml x24', weightPerCaseKg: 12.4 } });
  for (const code of ['S04-C01', 'S04-C02', 'S05-C05']) {
    await prisma.customer.create({ data: { tenantId: t.tenantId, code, name: code, branchKey: '__MAIN__', lat: 22.95, lng: 57.54, geocodeConfidence: 'HIGH', locationVerified: true } });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('B2 (S04): order rows on two sheets of one workbook', () => {
  it('is refused (400 MULTIPLE_SHEETS) with the sheet names; nothing is saved', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsOf([['INV-1', 'S04-C01', 'TEST-W500', '3'], ['INV-2', 'S04-C02', 'TEST-W500', '4']])), 'Orders');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rowsOf([['INV-361', 'S04-C02', 'TEST-W500', '5']])), 'LateOrder');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const before = await prisma.uploadBatch.count({ where: { tenantId: t.tenantId } });
    const r = await uploadFile(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'S04_Orders.xlsx');
    expect(r.status).toBe(400);
    const body = await json(r);
    expect(body.error.code).toBe('MULTIPLE_SHEETS');
    expect(body.error.message).toMatch(/"Orders" \(2 rows\), "LateOrder" \(1 row\)\. Nothing was read\./);
    expect(await prisma.uploadBatch.count({ where: { tenantId: t.tenantId } })).toBe(before);
  });
});

describe('S04: the late reason of a day that already has a plan with a dispatched load', () => {
  it('names the plan and its dispatched load, not the cutoff', async () => {
    const first = await upload([['INV-10', 'S04-C01', 'TEST-W500', '6']]);
    expect((await confirm(first.batchId)).status).toBe(200);
    const order = await prisma.order.findFirstOrThrow({ where: { uploadBatchId: first.batchId } });
    // The plan in use for the day: version 1 with its only load dispatched.
    const run = await prisma.runPlan.create({
      data: { tenantId: t.tenantId, depotId, runDate: new Date(`${day}T00:00:00Z`), status: 'DISPATCHED', createdById: t.userId, version: 1, reason: 'INITIAL' },
    });
    const sc = await prisma.scenarioResult.create({
      data: {
        runId: run.id, name: 'RECOMMENDED', trucksUsed: 1, totalDistanceKm: 5, totalTimeMin: 100, totalCost: 25, avgUtilizationPct: 1, unservedCount: 0,
        detailsJson: { scope: { orderIds: [order.id], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] }, loads: [], response_warnings: [], warnings: [] } as never,
      },
    });
    const load = await prisma.planLoad.create({
      data: { tenantId: t.tenantId, runId: run.id, truckId, loadNo: 1, status: 'DISPATCHED', departMin: 360, returnMin: 500, distanceKm: 5, durationMin: 140, cases: 6, weightKg: 74.4, utilizationPct: 1 },
    });
    await prisma.routeAssignment.create({
      data: { runId: run.id, truckId, orderId: order.id, loadId: load.id, loadNo: 1, sequenceInTruck: 1, orderInStop: 0, plannedArrivalMin: 400, plannedDistanceFromPrevKm: 5, plannedLoadCases: 6 },
    });
    await prisma.runPlan.update({ where: { id: run.id }, data: { chosenScenarioId: sc.id } });

    const late = await upload([['INV-361', 'S04-C02', 'TEST-W500', '5']]);
    expect(late.validation.late.isLate).toBe(true);
    expect(late.validation.late.reasons).toContain(`A plan (version 1) already exists for ${day} (1 of its loads is dispatched).`);
    const r = await confirm(late.batchId);
    expect(r.status).toBe(400);
    const body = await json(r);
    expect(body.error.code).toBe('LATE_REASON_REQUIRED');
    expect(body.error.message).toContain(`A plan (version 1) already exists for ${day} (1 of its loads is dispatched).`);
    expect(body.error.message).not.toMatch(/cutoff/);
    expect((await confirm(late.batchId, { lateReason: 'Urgent clinic order, phoned at 09:00' })).status).toBe(200);
    await prisma.runPlan.update({ where: { id: run.id }, data: { status: 'SUPERSEDED', supersededAt: new Date() } });
  });
});

describe('S05: re-upload after a customer was deactivated', () => {
  it('its confirmed lines are "Already confirmed" (skipped), not "inactive" errors; master codes in messages', async () => {
    const rows = [['INV-S05-00105', 'S05-C05', 'TEST-W500', '5'], ['INV-S05-00106', 'S04-C01', 'TEST-W500', '2']];
    const a = await upload(rows);
    const lateA = a.validation.late.isLate;
    expect((await confirm(a.batchId, lateA ? { lateReason: 'Test' } : {})).status).toBe(200);
    await prisma.customer.updateMany({ where: { tenantId: t.tenantId, code: 'S05-C05' }, data: { active: false } });
    try {
      // The retry file: the same lines, codes in lower case.
      const again = await upload(rows.map(([so, c, i, q]) => [so, c.toLowerCase(), i.toLowerCase(), q]));
      expect(again.validation.errors.some((e) => /is inactive/.test(e.message))).toBe(false);
      const dup = again.validation.duplicates.find((d) => d.message.includes('INV-S05-00105'));
      expect(dup?.message).toMatch(/^Already confirmed: sales order INV-S05-00105, TEST-W500 for S05-C05 on /);
      expect(dup?.message).toMatch(/Customer S05-C05 is inactive now/);
      // The same file again is still refused (it was confirmed): the error names its date (every
      // line is skipped, so not "this date"), and the refused confirm has a code.
      expect(again.validation.errorRows).toBeGreaterThan(0);
      expect(again.validation.errors[0].message).toContain(`These orders were already confirmed for ${day} (file orders.csv`);
      const r = await confirm(again.batchId);
      expect(r.status).toBe(400);
      expect((await json(r)).error.code).toBe('FILE_HAS_ERRORS');
    } finally {
      await prisma.customer.updateMany({ where: { tenantId: t.tenantId, code: 'S05-C05' }, data: { active: true } });
    }
  });
});
