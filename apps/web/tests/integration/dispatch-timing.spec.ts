/**
 * DISPATCH TIMING - end-to-end against the running web app + solver: the "Dispatch timing"
 * settings (first departure, turnaround, loading / unloading minutes per case, loads per truck)
 * are saved through the settings API, sent to the optimizer with strict priorities, and every
 * load of the plan leaves the depot only after the truck is back from its previous load AND the
 * next load is loaded.
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';
let day = '';

const TIMING = { shiftStartMin: 7 * 60 + 30, reloadMinutes: 20, loadingMinPerCase: 0.04, serviceMinPerCase: 0.05, maxTripsPerTruck: 3 };

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

beforeAll(async () => {
  t = await freshTenant('timing');
  day = isoPlus(2);
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, driverShiftMaxMinutes: 12 * 60, distanceProvider: 'HAVERSINE', osrmUrl: null },
  });
  const depot = await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } });
  depotId = depot.id;
  // One truck, three customers of 100 cases each: three loads, one after the other.
  await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'T01', capacityCases: 120, capacityWeightKg: 0, fixedCostPerDay: 20, costPerKm: 0.08 } });
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TAN-500-24', name: 'Tanuf 500ml x24', weightPerCaseKg: 12.8 } });
  for (const [code, name, lat, lng] of [
    ['C1', 'Customer One', 23.6, 58.372],
    ['C2', 'Customer Two', 23.555, 58.335],
    ['C3', 'Customer Three', 23.588, 58.41],
  ] as const) {
    await prisma.customer.create({
      data: {
        tenantId: t.tenantId, code, branchKey: '__MAIN__', name, lat, lng, geocodeConfidence: 'HIGH', locationVerified: true,
        priority: 3, priorityConfirmed: true, avgServiceTimeMin: 20, serviceTimeConfirmed: true,
      },
    });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('dispatch timing settings', () => {
  it('saves the timing settings and rejects out-of-range values', async () => {
    const ok = await fetchWith(t.cookieJar, `${BASE}/api/tenant/config`, j({ config: TIMING }, 'PATCH'));
    expect(ok.status).toBe(200);
    const cfg = await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(cfg).toMatchObject(TIMING);
    const bad = await fetchWith(t.cookieJar, `${BASE}/api/tenant/config`, j({ config: { loadingMinPerCase: 5 } }, 'PATCH'));
    expect(bad.status).toBe(400);
    expect((await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).loadingMinPerCase).toBe(0.04);
  });

  it('sends them to the optimizer and times every load with them', async () => {
    const d = dmy(day);
    const head = ['SO No', 'SO Date', 'Req. Delivery Date', 'Customer Code', 'Branch', 'Customer Name', 'Item Code', 'Item Description', 'Qty (Cases)', 'Net Value', 'CM'];
    const rows = [['SO-1', 'C1', 'Customer One'], ['SO-2', 'C2', 'Customer Two'], ['SO-3', 'C3', 'Customer Three']].map(([so, code, name]) => [so, d, d, code, '', name, 'TAN-500-24', '', '100', '200', '30']);
    const fd = new FormData();
    fd.set('file', new Blob([[head, ...rows].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `timing-${day}.csv`);
    fd.set('depotId', depotId);
    const up = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
    expect(up.status).toBe(200);
    const batch = await prisma.uploadBatch.findFirstOrThrow({ where: { tenantId: t.tenantId }, orderBy: { uploadedAt: 'desc' } });
    expect((await fetchWith(t.cookieJar, `${BASE}/api/orders/${batch.id}/confirm`, j({}))).status).toBe(200);

    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true }));
    expect(r.status).toBe(202);
    const runId = (await json(r)).data.runId;
    let status: any = null;
    for (let i = 0; i < 120 && !status; i++) {
      await new Promise((res) => setTimeout(res, 1500));
      const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
      if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') status = st.data;
    }
    expect(status?.run.status).toBe('READY');

    // What the optimizer was asked.
    const job = await prisma.runJob.findFirstOrThrow({ where: { runId }, orderBy: { createdAt: 'desc' } });
    const req = job.requestJson as any;
    expect(req.config).toMatchObject({
      shift_start_min: 450, reload_min: 20, loading_min_per_case: 0.04, max_trips_per_truck: 3, strict_priorities: true,
    });
    for (const s of req.stops) expect(s.service_min).toBe(20 + Math.round(0.05 * s.demand_cases)); // 20 + 5

    // What came back: three loads, each leaving after the previous return + 20 min + 0.04 min per case.
    const plan = (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/plan`))).data;
    const loads = plan.loads.filter((l: any) => l.truckCode === 'T01').sort((a: any, b: any) => a.loadNo - b.loadNo);
    expect(loads.length).toBe(3);
    expect(loads[0].departMin).toBeGreaterThanOrEqual(450);
    for (const l of loads) for (const s of l.stops) expect(s.serviceMin).toBe(25); // shown as scheduled
    for (let i = 1; i < loads.length; i++) {
      expect(loads[i].departMin).toBeGreaterThanOrEqual(loads[i - 1].returnMin + 20 + 0.04 * loads[i].cases - 1);
    }
    expect(plan.reconciliation.ok).toBe(true);
  });
});
