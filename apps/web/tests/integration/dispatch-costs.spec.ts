/**
 * STABILIZATION PR5 - end-to-end against the running web app + solver:
 * - F21: the planner economics saved on Settings (driver cost, overtime, fuel, road factor,
 *   preferred-window penalty) and the truck / depot planner fields reach the optimizer request;
 *   a save over another admin's newer value is refused (409 SETTINGS_CHANGED);
 * - F17: the day's cost is the optimizer's whole-truck-day cost - the summary equals the chosen
 *   option's total on a fresh day, every load carries its breakdown, and after a late-order re-plan
 *   the day total is the locked (carried) loads + the new ones, which the options table shows too;
 * - F23: /api/audit filters by the dispatch events (LOAD_LOCKED) and refuses unknown ones;
 * - F22: a dispatch plan's legacy geometry route answers 409.
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';
let day = '';
let runV1 = '';
let runV2 = '';

const ECONOMICS = { driverCostPerHour: 6, overtimeAfterMin: 120, overtimeCostPerHour: 4, fuelPricePerLitre: 0.25, roadTimeFactor: 1.4, prefWindowPenaltyPerMin: 0.1 };

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
async function waitForPlan(runId: string) {
  for (let i = 0; i < 160; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') return st.data;
  }
  throw new Error('optimization did not finish');
}
const plan = async (runId: string) => (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/plan`))).data;

beforeAll(async () => {
  t = await freshTenant('costs');
  day = isoPlus(2);
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, driverShiftMaxMinutes: 11 * 60, distanceProvider: 'HAVERSINE', osrmUrl: null, reloadMinutes: 30 },
  });
  depotId = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392 } })).id;
  // Two small trucks: a customer per load, so each truck makes several loads (turnarounds to pay).
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code, capacityCases: 110, capacityWeightKg: 0, fixedCostPerDay: 20, costPerKm: 0.08 } });
  }
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TAN-500-24', name: 'Tanuf 500ml x24', weightPerCaseKg: 12.8 } });
  const spots: [string, number, number][] = [
    ['C1', 23.6, 58.372], ['C2', 23.555, 58.335], ['C3', 23.588, 58.41], ['C4', 23.62, 58.45], ['C5', 23.54, 58.3], ['C6', 23.61, 58.33],
  ];
  for (const [code, lat, lng] of spots) {
    await prisma.customer.create({
      data: {
        tenantId: t.tenantId, code, branchKey: '__MAIN__', name: `Customer ${code}`, lat, lng, geocodeConfidence: 'HIGH', locationVerified: true,
        priority: 3, priorityConfirmed: true, avgServiceTimeMin: 20, serviceTimeConfirmed: true,
      },
    });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('planner settings reach the optimizer (review F21)', () => {
  it('saves the economics field by field, and refuses a save over a newer value', async () => {
    const before = await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    const expect_ = Object.fromEntries(Object.keys(ECONOMICS).map((k) => [k, (before as any)[k]]));
    const ok = await fetchWith(t.cookieJar, `${BASE}/api/tenant/config`, j({ config: ECONOMICS, expect: { config: expect_ } }, 'PATCH'));
    expect(ok.status).toBe(200);
    // A second tab still showing the old driver cost cannot overwrite it.
    const stale = await fetchWith(t.cookieJar, `${BASE}/api/tenant/config`, j({ config: { driverCostPerHour: 1 }, expect: { config: { driverCostPerHour: before.driverCostPerHour } } }, 'PATCH'));
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.code).toBe('SETTINGS_CHANGED');
    expect((await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).driverCostPerHour).toBe(6);
    // The old controls are refused.
    expect((await fetchWith(t.cookieJar, `${BASE}/api/tenant/config`, j({ config: { solverTimeLimitSeconds: 60 } }, 'PATCH'))).status).toBe(400);
  });

  it('saves the truck and depot planner fields through their APIs', async () => {
    const t01 = await prisma.truck.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'T01' } });
    const r = await fetchWith(t.cookieJar, `${BASE}/api/trucks/${t01.id}`, j({ tripCost: 1.5, kmPerLitre: 4, maxTripsPerDay: 3, availableFromMin: 330, availableToMin: 1320 }, 'PATCH'));
    expect(r.status).toBe(200);
    const bad = await fetchWith(t.cookieJar, `${BASE}/api/trucks/${t01.id}`, j({ availableToMin: 300 }, 'PATCH'));
    expect(bad.status).toBe(400); // until before from
    const d = await fetchWith(t.cookieJar, `${BASE}/api/depots/${depotId}`, j({ openMin: 300, closeMin: 1380 }, 'PATCH'));
    expect(d.status).toBe(200);
  });

  it('the optimizer gets them, and a fresh day costs exactly what the chosen option reports', async () => {
    const d = dmy(day);
    const head = ['SO No', 'SO Date', 'Req. Delivery Date', 'Customer Code', 'Branch', 'Customer Name', 'Item Code', 'Item Description', 'Qty (Cases)', 'Net Value', 'CM'];
    const rows = ['C1', 'C2', 'C3', 'C4', 'C5'].map((code, i) => [`SO-${i + 1}`, d, d, code, '', `Customer ${code}`, 'TAN-500-24', '', '100', '200', '30']);
    const fd = new FormData();
    fd.set('file', new Blob([[head, ...rows].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `costs-${day}.csv`);
    fd.set('depotId', depotId);
    expect((await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd })).status).toBe(200);
    const batch = await prisma.uploadBatch.findFirstOrThrow({ where: { tenantId: t.tenantId }, orderBy: { uploadedAt: 'desc' } });
    expect((await fetchWith(t.cookieJar, `${BASE}/api/orders/${batch.id}/confirm`, j({}))).status).toBe(200);

    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true }));
    expect(r.status).toBe(202);
    runV1 = (await json(r)).data.runId;
    expect((await waitForPlan(runV1)).run.status).toBe('READY');

    const job = await prisma.runJob.findFirstOrThrow({ where: { runId: runV1 }, orderBy: { createdAt: 'desc' } });
    const req = job.requestJson as any;
    expect(req.config).toMatchObject({
      driver_cost_per_hour: 6, overtime_after_min: 120, overtime_cost_per_hour: 4, fuel_price_per_litre: 0.25, road_time_factor: 1.4,
      pref_window_penalty_per_min: 0.1, time_limit_sec: null,
    });
    const sentT01 = req.trucks.find((x: any) => x.code === 'T01');
    expect(sentT01).toMatchObject({ trip_cost: 1.5, km_per_litre: 4, max_trips: 3, available_from_min: 330, available_to_min: 1320 });
    expect(req.depot).toMatchObject({ open_min: 300, close_min: 1380 });

    const p = await plan(runV1);
    const chosen = p.scenarios.find((s: any) => s.chosen);
    expect(chosen.costVersion).toBe(2);
    expect(p.summary.costBasis).toBe('TRUCK_DAY_SPAN');
    expect(Math.abs(p.summary.operatingCost - chosen.operatingCost)).toBeLessThan(0.01);
    expect(Math.abs(chosen.dayOperatingCost - chosen.operatingCost)).toBeLessThan(0.01); // nothing carried on a fresh day
    for (const l of p.loads) {
      expect(l.cost).toMatchObject({ v: 2, policy: 'TRUCK_DAY_SPAN' });
      expect(Math.abs(l.cost.total - l.operatingCost)).toBeLessThan(0.001);
    }
    // The driver is paid for each truck's whole day: the paid minutes cover its first departure to last return.
    for (const code of ['T01', 'T02']) {
      const mine = p.loads.filter((l: any) => l.truckCode === code);
      if (!mine.length) continue;
      const paid = mine.reduce((a: number, l: any) => a + l.cost.driverPaidMin, 0);
      const span = Math.max(...mine.map((l: any) => l.returnMin)) - Math.min(...mine.map((l: any) => l.departMin));
      expect(Math.abs(paid - span)).toBeLessThanOrEqual(mine.length);
    }
    expect(p.summary.driverPaidHours).toBeGreaterThanOrEqual(p.summary.onRoadHours);
  });

  it('a dispatch plan refuses the legacy geometry route (409)', async () => {
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/route-geometries`);
    expect(r.status).toBe(409);
    expect((await json(r)).error.code).toBe('USE_LOAD_GEOMETRY');
  });
});

describe('re-planned day costs (review F17)', () => {
  it('after a late-order re-plan the day total is the locked loads + the new ones', async () => {
    const p1 = await plan(runV1);
    const first = [...p1.loads].sort((a: any, b: any) => a.departMin - b.departMin)[0];
    const firstOfTruck = p1.loads.filter((l: any) => l.truckId === first.truckId).sort((a: any, b: any) => a.loadNo - b.loadNo)[0];
    expect((await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/loads/${firstOfTruck.id}`, j({ status: 'LOCKED' }, 'PATCH'))).status).toBe(200);

    const lo = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/late-order`, j({
      date: day, depotId, customerCode: 'C6', priority: 1, reason: 'Late top-up for the costs test',
      lines: [{ productCode: 'TAN-500-24', cases: 40, salesOrderNo: 'SO-LATE-C' }],
    }));
    expect(lo.status).toBe(201);
    const rp = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/replan`, j({ reason: 'REOPTIMIZE' }));
    expect(rp.status).toBe(202);
    runV2 = (await json(rp)).data.runId;
    await waitForPlan(runV2);

    const p2 = await plan(runV2);
    const carried = p2.loads.filter((l: any) => l.carried);
    expect(carried.length).toBeGreaterThanOrEqual(1);
    const chosen = p2.scenarios.find((s: any) => s.chosen);
    const frozenCost = carried.reduce((a: number, l: any) => a + l.operatingCost, 0);
    // The chosen option's new loads + the carried locked load = the day (KPI), and the options table says so.
    expect(Math.abs(p2.summary.operatingCost - (frozenCost + chosen.operatingCost))).toBeLessThan(0.01);
    expect(Math.abs(chosen.dayOperatingCost - p2.summary.operatingCost)).toBeLessThan(0.01);
    // The first new load of the locked truck is paid from the locked load's return (nothing twice).
    const lockedTruck = p2.loads.filter((l: any) => l.truckId === firstOfTruck.truckId).sort((a: any, b: any) => a.loadNo - b.loadNo);
    const next = lockedTruck.find((l: any) => !l.carried);
    if (next) expect(next.cost.paidFromMin).toBe(lockedTruck[0].returnMin);
    // The dashboard counts the whole version, not only the new loads.
    const v2 = await prisma.runPlan.findUniqueOrThrow({ where: { id: runV2 } });
    expect(Math.abs((v2.summaryJson as any).operatingCost - p2.summary.operatingCost)).toBeLessThan(0.001);
  });
});

describe('audit filters (review F23)', () => {
  it('LOAD_LOCKED returns only those rows; an unknown action is refused', async () => {
    const r = await fetchWith(t.cookieJar, `${BASE}/api/audit?action=LOAD_LOCKED`);
    expect(r.status).toBe(200);
    const rows = (await json(r)).data as { action: string; entity: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((x) => x.action === 'LOAD_LOCKED' && x.entity === 'PlanLoad')).toBe(true);
    const byEntity = (await json(await fetchWith(t.cookieJar, `${BASE}/api/audit?entity=PlanLoad`))).data as { entity: string }[];
    expect(byEntity.every((x) => x.entity === 'PlanLoad')).toBe(true);
    expect((await fetchWith(t.cookieJar, `${BASE}/api/audit?action=LOAD_DISPACHED`)).status).toBe(400);
    const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
    const dated = (await json(await fetchWith(t.cookieJar, `${BASE}/api/audit?action=LOAD_LOCKED&from=${today}&to=${today}`))).data;
    expect(dated.length).toBe(rows.length);
  });
});
