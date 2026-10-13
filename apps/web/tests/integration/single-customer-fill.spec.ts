/**
 * ONE CUSTOMER ON A TRUCK may use every bay (owner rule 13 Oct 2026: "keep 90% for trucks with several
 * customers, but let a truck that carries only one customer be filled to 100%") - end-to-end against the
 * running web app + solver, with the production order that was split on 13 Oct:
 *
 *  - Pallet fill 90%; the order is 300 cases of SS250ML (143 per pallet) + 500 of JA1.5L (56 per pallet) =
 *    11,027 units (11.03 pallets), more than 12 bays x 90% (10.8): the request sends ONE stop of 11,027
 *    units and config.single_customer_fill_pct 100, with the plan warning "One customer fills a truck";
 *  - the optimizer plans it alone on the 12-bay truck (never the 11-bay: 11.0 < 11.03), echoes the rule,
 *    and its check is VERIFIED; the other customers ride at 90% at most;
 *  - the plan screen shows the load's limit as every bay (one customer), and LOCK of it goes through (the
 *    web check measures a load of one customer by every bay).
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running (the solver of this release: an older one
 * ignores the rule, leaves the order out as larger than any truck, and the plan says so).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';
let day = '';
let runV1 = '';
let tawoosId = '';

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
  fd.set('file', new Blob([[head, ...rows.map(([so, c, i, q]) => [so, dmy(date), c, i, q])].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `sc-${date}.csv`);
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
const plan = async () => (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/plan`))).data;

beforeAll(async () => {
  t = await freshTenant('onecust');
  day = isoPlus(2);
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, shiftStartMin: 360, driverShiftMaxMinutes: 720, distanceProvider: 'HAVERSINE', osrmUrl: null, palletFillPct: 90 },
  });
  depotId = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } })).id;
  // NMWC's sizes: a 10-ton with 12 bays and 7713-RH with 11, no payload (weight is not a limit).
  await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'T12', capacityCases: 1140, capacityWeightKg: 0, fixedCostPerDay: 20, costPerKm: 0.1, bays: 12, maxTripsPerDay: 2 } });
  await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'T11', capacityCases: 1045, capacityWeightKg: 0, fixedCostPerDay: 20, costPerKm: 0.1, bays: 11, maxTripsPerDay: 2 } });
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'SS250ML', name: 'Small 250ml', weightPerCaseKg: 6, casesPerPallet: 143 } });
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'JA1.5L', name: 'Water 1.5L', weightPerCaseKg: 9.4, casesPerPallet: 56 } });
  for (const [code, lat, lng] of [['TAWOOS', 23.62, 58.47], ['SHOP', 23.588, 58.41], ['HYPER', 23.6, 58.372]] as const) {
    const c = await prisma.customer.create({
      data: { tenantId: t.tenantId, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 2, priorityConfirmed: true },
    });
    if (code === 'TAWOOS') tawoosId = c.id;
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('one customer on a truck may use every bay', () => {
  it('the 11.03-pallet order is one stop, planned alone on the 12-bay truck; the rule is sent and echoed; the check is VERIFIED', async () => {
    await addOrders(day, [
      ['SO-T', 'TAWOOS', 'SS250ML', '300'],
      ['SO-T', 'TAWOOS', 'JA1.5L', '500'],
      ['SO-S', 'SHOP', 'SS250ML', '200'], // 1.4 pallets
      ['SO-H', 'HYPER', 'JA1.5L', '150'], // 2.7 pallets
    ]);
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true }));
    expect(r.status).toBe(202);
    runV1 = (await json(r)).data.runId;
    expect((await waitForPlan(runV1)).run.status).toBe('READY');

    const job = await prisma.runJob.findFirstOrThrow({ where: { runId: runV1 }, orderBy: { createdAt: 'desc' } });
    const req = job.requestJson as any;
    expect(req.config.pallet_fill_pct).toBe(90);
    expect(req.config.single_customer_fill_pct).toBe(100);
    const tawoosStops = (req.stops as any[]).filter((s) => s.customer_id === tawoosId);
    expect(tawoosStops.map((s) => [s.demand_cases, s.demand_pallet_units])).toEqual([[800, 11_027]]);

    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runV1 } });
    const sc = await prisma.scenarioResult.findUniqueOrThrow({ where: { id: run.chosenScenarioId! } });
    const d = sc.detailsJson as any;
    expect(d.single_customer_fill_pct).toBe(100);
    expect(d.feasibility.status).toBe('VERIFIED');
    expect((d.response_warnings as string[]).join(' ')).toMatch(/One customer fills a truck: TAWOOS 11\.0 pallets, alone on a 12-bay truck \(every bay; trucks with several customers keep 90%\)/);
    expect((d.response_warnings as string[]).join(' ')).not.toMatch(/did not apply the one-customer rule/);

    const p = await plan();
    expect(p.reconciliation.ok).toBe(true);
    const load = p.loads.find((l: any) => l.stops.some((s: any) => s.customerCode === 'TAWOOS'));
    expect(load.truckCode).toBe('T12');
    expect(load.stops.map((s: any) => s.customerCode)).toEqual(['TAWOOS']);
    expect(load).toMatchObject({ palletUnits: 11_027, palletRoomUnits: 12_000, palletFillPct: 100, palletOneCustomer: true });
    for (const l of p.loads.filter((x: any) => x.id !== load.id)) {
      if (new Set(l.stops.map((s: any) => s.customerCode)).size > 1) expect(l.palletUnits).toBeLessThanOrEqual(l.bays * 900);
    }
  });

  it('LOCK of the full truck goes through: the web check measures a load of one customer by every bay', async () => {
    const p = await plan();
    const load = p.loads.find((l: any) => l.stops.some((s: any) => s.customerCode === 'TAWOOS'));
    // Loads of a truck are locked in order (Load 1 first): lock the truck's earlier trips, then the full truck.
    const earlier = p.loads.filter((l: any) => l.truckCode === load.truckCode && l.loadNo < load.loadNo).sort((a: any, b: any) => a.loadNo - b.loadNo);
    for (const l of earlier) {
      const e = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/loads/${l.id}`, j({ status: 'LOCKED' }, 'PATCH'));
      expect(e.status, `lock ${l.truckCode} load ${l.loadNo}: ${e.status === 200 ? '' : await e.clone().text()}`).toBe(200);
    }
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/loads/${load.id}`, j({ status: 'LOCKED' }, 'PATCH'));
    expect(r.status, r.status === 200 ? '' : await r.clone().text()).toBe(200);
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: load.id } })).status).toBe('LOCKED');
  });
});
