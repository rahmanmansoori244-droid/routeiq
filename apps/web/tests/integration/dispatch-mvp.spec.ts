/**
 * NMWC DISPATCH MVP - end-to-end definition-of-done workflow against the running web app +
 * solver (HTTP only, like the dispatcher's browser):
 *
 *  upload NMWC-format orders -> validation (new customer = LOCATION REQUIRED, not an error)
 *  -> optimize refused while a location is missing -> Google Maps link saved permanently
 *  -> confirm priority/window -> OPTIMIZE -> recommended plan with multi-load trucks, windows,
 *  capacity, manifests, exact reconciliation -> lock T01 Load 1 -> late P1 order -> re-plan
 *  (v2 keeps the locked load verbatim) -> dispatch -> dispatched load immutable -> re-plan v3
 *  keeps it -> Excel master workbook -> every unserved order has a reason.
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running. Set TEST_EXPECT_OSRM=1 when the
 * solver has a reachable OSRM_URL to also assert road distances were used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';
let deliveryDate = ''; // YYYY-MM-DD, two days out so the upload is never "late" by cutoff
let runV1 = '';
let runV2 = '';
let lockedLoadOrders: string[] = [];
const trucks: Record<string, string> = {};

const DEPOT = { lat: 23.568, lng: 58.392 };

function isoPlus(days: number) {
  const d = new Date(Date.now() + 4 * 3600_000); // Muscat
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dmy(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
const j = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function waitForPlan(runId: string, max = 90) {
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') return st.data;
  }
  throw new Error('optimization did not finish');
}

async function plan(runId: string) {
  const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/plan`);
  expect(r.status).toBe(200);
  return (await json(r)).data;
}

beforeAll(async () => {
  t = await freshTenant('dispatch');
  deliveryDate = isoPlus(2);
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: {
      timezone: 'Asia/Muscat',
      planningCutoffMin: 18 * 60,
      shiftStartMin: 6 * 60,
      driverShiftMaxMinutes: 12 * 60,
      reloadMinutes: 30,
      maxTripsPerTruck: 3,
      fuelPricePerLitre: 0.26,
      driverCostPerHour: 2.5,
      distanceProvider: 'OSRM',
      osrmUrl: null,
    },
  });
  const depot = await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: DEPOT.lat, lng: DEPOT.lng, openMin: 300, closeMin: 1380 } });
  depotId = depot.id;
  for (const [code, cap] of [['T01', 120], ['T02', 120]] as const) {
    const tr = await prisma.truck.create({
      data: { tenantId: t.tenantId, depotId, code, capacityCases: cap, capacityWeightKg: 2500, fixedCostPerDay: 20, costPerKm: 0.08, kmPerLitre: 6, tripCost: 2 },
    });
    trucks[code] = tr.id;
  }
  const products = [
    ['TAN-500-24', 'Tanuf 500ml x24', 12.8],
    ['TAN-1500-6', 'Tanuf 1.5L x6', 9.4],
    ['JAB-500-24', 'Jabal 500ml x24', 12.7],
  ] as const;
  for (const [code, name, w] of products) await prisma.product.create({ data: { tenantId: t.tenantId, code, name, weightPerCaseKg: w } });
  await prisma.customerTypeProfile.create({
    data: { tenantId: t.tenantId, customerType: 'GROCERY', defaultPriority: 4, serviceTimeMin: 8, hardWindowStartMin: 7 * 60, hardWindowEndMin: 21 * 60 },
  });
  const spots: [string, string | null, string, number, number, string][] = [
    ['C100', 'B01', 'Hyper Bawshar', 23.571, 58.397, 'HYPERMARKET'],
    ['C100', 'B02', 'Hyper Seeb', 23.668, 58.19, 'HYPERMARKET'],
    ['C101', null, 'Noor Grocery Khuwair', 23.589, 58.41, 'GROCERY'],
    ['C102', null, 'Qurum Supermarket', 23.614, 58.476, 'SUPERMARKET'],
    ['C103', null, 'Ghubrah Trading', 23.6, 58.372, 'TRADING'],
    ['C104', null, 'Amerat Grocery', 23.52, 58.497, 'GROCERY'],
    ['C105', null, 'Ruwi Catering', 23.598, 58.543, 'CATERING'],
    ['C106', null, 'Azaiba Grocery', 23.598, 58.34, 'GROCERY'],
    ['C107', null, 'Mawaleh Grocery', 23.617, 58.237, 'GROCERY'],
    ['C108', null, 'Ansab Grocery', 23.555, 58.335, 'GROCERY'],
  ];
  for (const [code, branch, name, lat, lng, type] of spots) {
    await prisma.customer.create({
      data: {
        tenantId: t.tenantId,
        code,
        branchCode: branch,
        branchKey: branch ?? '__MAIN__',
        name,
        lat,
        lng,
        geocodeConfidence: 'HIGH',
        locationVerified: true,
        customerType: type as never,
        priority: type === 'HYPERMARKET' ? 1 : 3,
        priorityConfirmed: true,
        avgServiceTimeMin: type === 'HYPERMARKET' ? 30 : 10,
        serviceTimeConfirmed: true,
      },
    });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('NMWC dispatch MVP workflow', () => {
  it('1-5 uploads an NMWC-format file; a new customer becomes LOCATION REQUIRED instead of an error', async () => {
    const d = dmy(deliveryDate);
    const rows = [
      ['SO No', 'SO Date', 'Req. Delivery Date', 'Customer Code', 'Branch', 'Customer Name', 'Item Code', 'Item Description', 'Qty (Cases)', 'Net Value', 'CM'],
      ['SO-1', d, d, 'C100', 'B01', 'Hyper Bawshar', 'TAN-500-24', '', '60', '120', '20'],
      ['SO-1', d, d, 'C100', 'B01', 'Hyper Bawshar', 'TAN-1500-6', '', '40', '80', '12'],
      ['SO-2', d, d, 'C100', 'B02', 'Hyper Seeb', 'TAN-500-24', '', '50', '100', '15'],
      ['SO-3', d, d, 'C101', '', 'Noor Grocery Khuwair', 'JAB-500-24', '', '20', '40', '6'],
      ['SO-4', d, d, 'C102', '', 'Qurum Supermarket', 'TAN-500-24', '', '45', '90', '13'],
      ['SO-4', d, d, 'C102', '', 'Qurum Supermarket', 'JAB-500-24', '', '15', '30', '5'],
      ['SO-5', d, d, 'C103', '', 'Ghubrah Trading', 'TAN-1500-6', '', '30', '60', '9'],
      ['SO-6', d, d, 'C104', '', 'Amerat Grocery', 'TAN-500-24', '', '25', '50', '7'],
      ['SO-7', d, d, 'C105', '', 'Ruwi Catering', 'TAN-500-24', '', '35', '70', '10'],
      ['SO-8', d, d, 'C106', '', 'Azaiba Grocery', 'JAB-500-24', '', '18', '36', '5'],
      ['SO-9', d, d, 'C107', '', 'Mawaleh Grocery', 'TAN-1500-6', '', '22', '44', '6'],
      ['SO-10', d, d, 'C108', '', 'Ansab Grocery', 'TAN-500-24', '', '28', '56', '8'],
      ['SO-11', d, d, 'C9001', '', 'New Trading LLC', 'TAN-500-24', '', '12', '24', '4'],
    ];
    const csv = rows.map((r) => r.map((c) => (c.includes(',') ? `"${c}"` : c)).join(',')).join('\n');
    const fd = new FormData();
    fd.set('file', new Blob([csv], { type: 'text/csv' }), 'nmwc-orders.csv');
    fd.set('depotId', depotId);
    const r = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
    expect(r.status).toBe(200);
    const v = (await json(r)).data.validation;
    expect(v.errorRows).toBe(0);
    expect(v.totals.cases).toBe(400);
    expect(v.totals.customers).toBe(11); // C100/B01 and C100/B02 are two delivery locations
    expect(v.issues.newCustomers.map((c: { code: string }) => c.code)).toEqual(['C9001']);
    expect(v.mapping.customer_code).toBe('customer code');
    const c = await fetchWith(t.cookieJar, `${BASE}/api/orders/${(await prisma.uploadBatch.findFirstOrThrow({ where: { tenantId: t.tenantId } })).id}/confirm`, j({}));
    expect(c.status).toBe(200);
    const cb = (await json(c)).data;
    expect(cb.ordersCreated).toBe(11);
    expect(cb.cases).toBe(400);
    expect(cb.customersCreated).toBe(1);
    const lines = await prisma.orderLine.count({ where: { order: { tenantId: t.tenantId } } });
    expect(lines).toBe(13); // SKU-level detail kept
  });

  it('refuses to optimize while a customer location is missing', async () => {
    const day = (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/day?date=${deliveryDate}&depotId=${depotId}`))).data;
    expect(day.blockingCount).toBe(1);
    expect(day.customers[0].code).toBe('C9001');
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: deliveryDate, depotId, optimize: true }));
    expect(r.status).toBe(409);
    const b = await json(r);
    expect(b.error.code).toBe('LOCATION_REQUIRED');
  });

  it('6-8 saves a Google Maps link location permanently (and rejects non-Google links)', async () => {
    const cust = await prisma.customer.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'C9001' } });
    const bad = await fetchWith(t.cookieJar, `${BASE}/api/customers/${cust.id}/location`, { ...j({ input: 'https://example.com/place?q=23.6,58.4' }), method: 'PUT' });
    expect([400, 422]).toContain(bad.status);
    const url = 'https://www.google.com/maps/place/New+Trading/@23.6,58.44,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d23.601234!4d58.449876';
    const ok = await fetchWith(t.cookieJar, `${BASE}/api/customers/${cust.id}/location`, { ...j({ input: url }), method: 'PUT' });
    expect(ok.status).toBe(200);
    const saved = await prisma.customer.findUniqueOrThrow({ where: { id: cust.id } });
    expect(saved.lat).toBeCloseTo(23.601234, 5);
    expect(saved.lng).toBeCloseTo(58.449876, 5);
    expect(saved.locationVerified).toBe(true);
    expect(saved.locationSource).toBe('GOOGLE_MAPS_URL');
    expect(saved.locationInput).toContain('google.com/maps');
  });

  it('9 confirms priority / receiving window on the customer master', async () => {
    const hyper = await prisma.customer.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'C100', branchKey: 'B01' } });
    const r = await fetchWith(t.cookieJar, `${BASE}/api/customers/${hyper.id}`, {
      ...j({ priority: 1, hardWindowStartMin: 360, hardWindowEndMin: 600, prefWindowStartMin: 390, prefWindowEndMin: 540 }),
      method: 'PATCH',
    });
    expect(r.status).toBe(200);
    const bad = await fetchWith(t.cookieJar, `${BASE}/api/customers/${hyper.id}`, { ...j({ hardWindowStartMin: 600, hardWindowEndMin: 360 }), method: 'PATCH' });
    expect(bad.status).toBe(400);
    const day = (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/day?date=${deliveryDate}&depotId=${depotId}`))).data;
    expect(day.blockingCount).toBe(0);
  });

  it('10-19 optimizes: road matrix, windows, P1, capacity, multi-load trucks, manifests, exact reconciliation', async () => {
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: deliveryDate, depotId, optimize: true }));
    expect(r.status).toBe(202);
    runV1 = (await json(r)).data.runId;
    const st = await waitForPlan(runV1);
    expect(st.run.status).toBe('READY');
    const p = await plan(runV1);
    expect(p.run.chosenScenario).toBe('RECOMMENDED');
    expect(p.scenarios.map((s: { name: string }) => s.name).sort()).toEqual(['MIN_DISTANCE', 'MIN_TRUCKS', 'RECOMMENDED']);
    if (process.env.TEST_EXPECT_OSRM === '1') {
      expect(p.summary.distanceProvider).toBe('OSRM');
      expect(p.summary.distanceIsEstimated).toBe(false);
    } else {
      expect(['OSRM', 'HAVERSINE']).toContain(p.summary.distanceProvider);
    }
    expect(p.reconciliation.ok).toBe(true);
    expect(p.reconciliation.uploadedCases).toBe(400);
    expect(p.reconciliation.plannedCases + p.reconciliation.unservedCases).toBe(400);
    // 400 cases on 2 x 120-case trucks => multiple loads per physical truck
    const byTruck: Record<string, any[]> = {};
    for (const l of p.loads) (byTruck[l.truckCode] ??= []).push(l);
    expect(Math.max(...Object.values(byTruck).map((ls) => ls.length))).toBeGreaterThanOrEqual(2);
    for (const ls of Object.values(byTruck)) {
      ls.sort((a, b) => a.loadNo - b.loadNo);
      for (let i = 1; i < ls.length; i++) expect(ls[i].departMin).toBeGreaterThanOrEqual(ls[i - 1].returnMin + 30);
    }
    for (const l of p.loads) {
      expect(l.cases).toBeLessThanOrEqual(l.truckCapacityCases);
      expect(l.manifest.reduce((a: number, m: { cases: number }) => a + m.cases, 0)).toBe(l.cases);
      expect(l.stops.reduce((a: number, s: { cases: number }) => a + s.cases, 0)).toBe(l.cases);
      for (const s of l.stops) expect(s.hardWindowOk).not.toBe(false);
    }
    const hyper = p.loads.flatMap((l: any) => l.stops).find((s: any) => s.customerCode === 'C100' && s.branchCode === 'B01');
    expect(hyper, 'P1 hypermarket must be served').toBeTruthy();
    expect(hyper.etaMin).toBeLessThanOrEqual(600);
    for (const u of p.unserved) expect(u.reasonCode).toBeTruthy();
    expect(p.summary.serviceByPriority.P1.pct).toBe(100);
  });

  it('20 locks T01 Load 1 (and enforces load order rules)', async () => {
    const p = await plan(runV1);
    const t01 = p.loads.filter((l: any) => l.truckCode === 'T01').sort((a: any, b: any) => a.loadNo - b.loadNo);
    expect(t01.length).toBeGreaterThanOrEqual(1);
    if (t01.length > 1) {
      const early = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/loads/${t01[1].id}`, { ...j({ status: 'LOCKED' }), method: 'PATCH' });
      expect(early.status).toBe(409); // Load 2 cannot be locked before Load 1
    }
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/loads/${t01[0].id}`, { ...j({ status: 'LOCKED' }), method: 'PATCH' });
    expect(r.status).toBe(200);
    lockedLoadOrders = t01[0].stops.flatMap((s: any) => s.orderIds);
    expect(lockedLoadOrders.length).toBeGreaterThan(0);
  });

  it('21-23 a late P1 order is re-planned into a new version that preserves the locked load', async () => {
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/late-order`, j({
      date: deliveryDate,
      depotId,
      customerCode: 'C102',
      priority: 1,
      reason: 'Key account emergency top-up',
      lines: [{ productCode: 'TAN-500-24', cases: 30, salesOrderNo: 'SO-LATE-1' }],
    }));
    expect(r.status).toBe(201);
    const lo = (await json(r)).data;
    expect(lo.late).toBe(true);
    expect(lo.replanNeeded).toBe(true);
    const day = (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/day?date=${deliveryDate}&depotId=${depotId}`))).data;
    expect(day.pending.count).toBe(1);

    const rp = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/replan`, j({ reason: 'LATE_ORDER', note: 'P1 top-up at 22:15' }));
    expect(rp.status).toBe(202);
    const body = (await json(rp)).data;
    runV2 = body.runId;
    expect(body.version).toBe(2);
    await waitForPlan(runV2);
    const v1 = await prisma.runPlan.findUniqueOrThrow({ where: { id: runV1 } });
    expect(v1.status).toBe('SUPERSEDED');
    const p2 = await plan(runV2);
    expect(p2.run.version).toBe(2);
    expect(p2.run.reason).toBe('LATE_ORDER');
    const l1 = p2.loads.find((l: any) => l.truckCode === 'T01' && l.loadNo === 1);
    expect(l1.status).toBe('LOCKED');
    expect(l1.carried).toBe(true);
    expect(l1.stops.flatMap((s: any) => s.orderIds)).toEqual(lockedLoadOrders); // same orders, same sequence
    expect(p2.reconciliation.ok).toBe(true);
    expect(p2.reconciliation.uploadedCases).toBe(430);
    const lateId = lo.orderId;
    const planned = p2.loads.some((l: any) => l.stops.some((s: any) => s.orderIds.includes(lateId)));
    const unserved = p2.unserved.find((u: any) => u.orderId === lateId);
    expect(planned || !!unserved).toBe(true);
    if (unserved) expect(unserved.reasonCode).toBe('LATE_ORDER_NO_CAPACITY');
    expect(p2.change.lockedLoadsPreserved).toBeGreaterThanOrEqual(1);
    expect(p2.change.ordersAdded).toBe(1);
  });

  it('24 dispatched loads cannot change; a further re-plan keeps them', async () => {
    const p2 = await plan(runV2);
    const l1 = p2.loads.find((l: any) => l.truckCode === 'T01' && l.loadNo === 1);
    const d = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/loads/${l1.id}`, { ...j({ status: 'DISPATCHED' }), method: 'PATCH' });
    expect(d.status).toBe(200);
    for (const to of ['PLANNED', 'LOCKED', 'LOADING']) {
      const x = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/loads/${l1.id}`, { ...j({ status: to }), method: 'PATCH' });
      expect(x.status).toBe(409);
    }
    const a = await prisma.routeAssignment.findFirstOrThrow({ where: { loadId: l1.id } });
    const un = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/routes/${a.id}`, { method: 'DELETE' });
    expect(un.status).toBe(409);
    const old = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/unlock`, { method: 'POST' });
    expect(old.status).toBe(409);
    const re = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/optimize`, j({}));
    expect(re.status).toBe(409); // an applied plan is never re-optimized in place

    const rp = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/replan`, j({ reason: 'REOPTIMIZE' }));
    expect(rp.status).toBe(202);
    const runV3 = (await json(rp)).data.runId;
    await waitForPlan(runV3);
    const p3 = await plan(runV3);
    const k = p3.loads.find((l: any) => l.truckCode === 'T01' && l.loadNo === 1);
    expect(k.status).toBe('DISPATCHED');
    expect(k.stops.flatMap((s: any) => s.orderIds)).toEqual(lockedLoadOrders);
    expect(p3.reconciliation.ok).toBe(true);
    expect(p3.versions.map((v: any) => v.version)).toEqual([3, 2, 1]);
    runV2 = runV3;
  });

  it('25-26 exports the Excel master workbook; unserved orders carry reasons', async () => {
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/export/excel`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await r.arrayBuffer());
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toBe('SUMMARY');
    expect(names).toContain('LOAD PLAN');
    expect(names).toContain('SKU LOADING SUMMARY');
    expect(names.some((n) => /UNSERVED/.test(n))).toBe(true);
    expect(names).toContain('ASSUMPTIONS');
    expect(names.some((n) => /^T01 - L1$/.test(n))).toBe(true);
    const p = await plan(runV2);
    for (const u of p.unserved) {
      expect(u.reasonCode).toBeTruthy();
      expect(u.reasonMessage).toBeTruthy();
    }
    const orders = await prisma.order.count({ where: { tenantId: t.tenantId } });
    expect(p.reconciliation.orders).toBe(orders);
  });
});
