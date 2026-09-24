/**
 * SPLIT DELIVERIES - end-to-end against the running web app + solver: a customer whose day is
 * bigger than the largest truck is delivered in truck-sized parts, every part carries exact SKU
 * lines, cases reconcile per line, a locked part survives a re-plan (only the open lines are
 * planned again), the Excel workbook labels the parts, and the tenant toggle turns it off.
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';
let day1 = '';
let day2 = '';
let runV1 = '';
let runV2 = '';
let bigOrderId = '';

const BIG_CASES = 270; // 180 x TAN-500-24 (12.8 kg) + 90 x TAN-1500-6 (9.4 kg) = 3150 kg; trucks carry 120 cs / 2500 kg

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

async function upload(date: string, rows: string[][]) {
  const d = dmy(date);
  const head = ['SO No', 'SO Date', 'Req. Delivery Date', 'Customer Code', 'Branch', 'Customer Name', 'Item Code', 'Item Description', 'Qty (Cases)', 'Net Value', 'CM'];
  const csv = [head, ...rows.map(([so, code, name, item, qty, net, cm]) => [so, d, d, code, '', name, item, '', qty, net, cm])].map((r) => r.join(',')).join('\n');
  const fd = new FormData();
  fd.set('file', new Blob([csv], { type: 'text/csv' }), `split-${date}.csv`);
  fd.set('depotId', depotId);
  const r = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
  expect(r.status).toBe(200);
  expect((await json(r)).data.validation.errorRows).toBe(0);
  const batch = await prisma.uploadBatch.findFirstOrThrow({ where: { tenantId: t.tenantId }, orderBy: { uploadedAt: 'desc' } });
  const c = await fetchWith(t.cookieJar, `${BASE}/api/orders/${batch.id}/confirm`, j({}));
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

async function plan(runId: string) {
  const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/plan`);
  expect(r.status).toBe(200);
  return (await json(r)).data;
}

const bigStops = (p: any) => p.loads.flatMap((l: any) => l.stops.filter((s: any) => s.customerCode === 'BIG').map((s: any) => ({ ...s, load: l })));
const bigUnserved = (p: any) => p.unserved.filter((u: any) => u.customerCode === 'BIG');

beforeAll(async () => {
  t = await freshTenant('split');
  day1 = isoPlus(2);
  day2 = isoPlus(3);
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: {
      timezone: 'Asia/Muscat',
      planningCutoffMin: 18 * 60,
      shiftStartMin: 6 * 60,
      driverShiftMaxMinutes: 12 * 60,
      reloadMinutes: 30,
      maxTripsPerTruck: 3,
      distanceProvider: 'HAVERSINE',
      osrmUrl: null,
    },
  });
  const depot = await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } });
  depotId = depot.id;
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({
      data: { tenantId: t.tenantId, depotId, code, capacityCases: 120, capacityWeightKg: 2500, fixedCostPerDay: 20, costPerKm: 0.08, kmPerLitre: 6, tripCost: 2 },
    });
  }
  for (const [code, name, w] of [
    ['TAN-500-24', 'Tanuf 500ml x24', 12.8],
    ['TAN-1500-6', 'Tanuf 1.5L x6', 9.4],
  ] as const) {
    await prisma.product.create({ data: { tenantId: t.tenantId, code, name, weightPerCaseKg: w } });
  }
  for (const [code, name, lat, lng] of [
    ['BIG', 'Hyper Big', 23.588, 58.41],
    ['S1', 'Small One', 23.6, 58.372],
    ['S2', 'Small Two', 23.555, 58.335],
  ] as const) {
    await prisma.customer.create({
      data: {
        tenantId: t.tenantId, code, branchKey: '__MAIN__', name, lat, lng, geocodeConfidence: 'HIGH', locationVerified: true,
        priority: 2, priorityConfirmed: true, avgServiceTimeMin: 20, serviceTimeConfirmed: true,
      },
    });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('split deliveries', () => {
  it('plans a customer bigger than the largest truck in parts, reconciling every case', async () => {
    await upload(day1, [
      ['SO-B1', 'BIG', 'Hyper Big', 'TAN-500-24', '180', '360', '54'],
      ['SO-B1', 'BIG', 'Hyper Big', 'TAN-1500-6', '90', '180', '27'],
      ['SO-S1', 'S1', 'Small One', 'TAN-500-24', '20', '40', '6'],
      ['SO-S2', 'S2', 'Small Two', 'TAN-1500-6', '15', '30', '4'],
    ]);
    const big = await prisma.order.findFirstOrThrow({ where: { tenantId: t.tenantId, customer: { code: 'BIG' } } });
    bigOrderId = big.id;
    expect(big.totalCases).toBe(BIG_CASES);

    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day1, depotId, optimize: true }));
    expect(r.status).toBe(202);
    runV1 = (await json(r)).data.runId;
    expect((await waitForPlan(runV1)).run.status).toBe('READY');
    const p = await plan(runV1);

    expect(p.reconciliation.problems).toEqual([]);
    expect(p.reconciliation.ok).toBe(true);
    expect(p.reconciliation.uploadedCases).toBe(BIG_CASES + 35);
    expect(p.warnings.join(' ')).toMatch(/Split delivery .*BIG \(270 cases, 3150 kg\) in 3 parts/);

    // Every part fits one truck and says which part it is.
    const stops = bigStops(p);
    expect(stops.length).toBeGreaterThanOrEqual(2);
    for (const s of stops) {
      expect(s.split).toBeTruthy();
      expect(s.split.parts).toBe(stops.length);
      expect(s.cases).toBeLessThanOrEqual(120);
      expect(s.weightKg).toBeLessThanOrEqual(2500);
      expect(s.skus.reduce((a: number, k: { cases: number }) => a + k.cases, 0)).toBe(s.cases);
    }
    expect(stops.map((s: any) => s.split.part).sort()).toEqual(stops.map((_: any, i: number) => i + 1));
    const plannedBig = stops.reduce((a: number, s: any) => a + s.cases, 0);
    const unservedBig = bigUnserved(p).reduce((a: number, u: any) => a + u.cases, 0);
    expect(plannedBig + unservedBig).toBe(BIG_CASES);
    // Per SKU the parts add up to the order lines.
    const perSku: Record<string, number> = {};
    for (const s of stops) for (const k of s.skus) perSku[k.productCode] = (perSku[k.productCode] ?? 0) + k.cases;
    if (!unservedBig) expect(perSku).toEqual({ 'TAN-500-24': 180, 'TAN-1500-6': 90 });

    for (const l of p.loads) {
      expect(l.cases).toBeLessThanOrEqual(l.truckCapacityCases);
      expect(l.stops.reduce((a: number, s: { cases: number }) => a + s.cases, 0)).toBe(l.cases);
      expect(l.manifest.reduce((a: number, m: { cases: number }) => a + m.cases, 0)).toBe(l.cases);
    }
    // Stored rows carry the exact portion lines.
    const rows = await prisma.routeAssignment.findMany({ where: { runId: runV1, orderId: bigOrderId } });
    expect(rows.length).toBe(stops.length);
    for (const a of rows) expect(Array.isArray(a.portionLinesJson)).toBe(true);
    expect(rows.reduce((a, x) => a + (x.portionCases ?? 0), 0)).toBe(plannedBig);
    if (!unservedBig) {
      expect(p.summary.ordersServed).toBe(3);
      expect(p.summary.casesServed).toBe(BIG_CASES + 35);
    }
  });

  it('keeps a locked part on re-plan and plans only the rest of the order again', async () => {
    const p1 = await plan(runV1);
    // Lock loads in order (Load 1 before Load 2) until two loads carrying a BIG part are locked.
    let lockedCases = 0;
    let lockedParts = 0;
    const hasBig = (l: any) => l.stops.some((s: any) => s.customerCode === 'BIG');
    const byTruck: Record<string, any[]> = {};
    for (const l of p1.loads) (byTruck[l.truckCode] ??= []).push(l);
    for (const ls of Object.values(byTruck)) {
      ls.sort((a, b) => a.loadNo - b.loadNo);
      for (let i = 0; i < ls.length && lockedParts < 2 && ls.slice(i).some(hasBig); i++) {
        const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/loads/${ls[i].id}`, j({ status: 'LOCKED' }, 'PATCH'));
        expect(r.status).toBe(200);
        const part = ls[i].stops.find((s: any) => s.customerCode === 'BIG');
        if (part) {
          lockedCases += part.cases;
          lockedParts++;
        }
      }
    }
    expect(lockedParts).toBe(2);
    expect(lockedCases).toBeLessThan(BIG_CASES);

    const rp = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/replan`, j({ reason: 'REOPTIMIZE' }));
    expect(rp.status).toBe(202);
    runV2 = (await json(rp)).data.runId;
    await waitForPlan(runV2);
    const p2 = await plan(runV2);
    expect(p2.reconciliation.problems).toEqual([]);
    expect(p2.reconciliation.ok).toBe(true);
    const stops = bigStops(p2);
    const carried = stops.filter((s: any) => s.load.status === 'LOCKED');
    expect(carried.reduce((a: number, s: any) => a + s.cases, 0)).toBe(lockedCases);
    const planned = stops.reduce((a: number, s: any) => a + s.cases, 0);
    const unserved = bigUnserved(p2).reduce((a: number, u: any) => a + u.cases, 0);
    expect(planned + unserved).toBe(BIG_CASES); // never planned twice, never lost
    for (const s of stops) expect(s.split.parts).toBe(stops.length);

    // The optimizer saw the order as partly frozen: only its open lines were sent.
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runV2 } });
    const sc = await prisma.scenarioResult.findUniqueOrThrow({ where: { id: run.chosenScenarioId! } });
    const scope = (sc.detailsJson as any).scope;
    expect(scope.frozenLoadOrderIds).toContain(bigOrderId);
    expect(scope.frozenOrderIds).not.toContain(bigOrderId);
    const sent = Object.values(scope.portions as Record<string, { orderId: string; cases: number }>).filter((x) => x.orderId === bigOrderId);
    expect(sent.reduce((a, x) => a + x.cases, 0)).toBe(BIG_CASES - lockedCases);
  });

  it('refuses to apply another option after a carried split part was unlocked (loads are compared, not orders)', async () => {
    const p2 = await plan(runV2);
    const locked = p2.loads.filter((l: any) => l.status === 'LOCKED' && l.carried);
    const withBig = locked.filter((l: any) => l.stops.some((s: any) => s.customerCode === 'BIG'));
    expect(withBig.length).toBe(2);
    // The latest locked load of its truck can be unlocked; BIG stays on the other frozen load.
    const last = withBig.find((l: any) => !locked.some((x: any) => x.truckId === l.truckId && x.loadNo > l.loadNo))!;
    const un = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/loads/${last.id}`, j({ status: 'PLANNED' }, 'PATCH'));
    expect(un.status).toBe(200);
    const other = p2.scenarios.find((s: any) => !s.chosen)!;
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/choose-scenario`, j({ scenarioId: other.id }));
    expect(r.status).toBe(409);
    const relock = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/loads/${last.id}`, j({ status: 'LOCKED' }, 'PATCH'));
    expect(relock.status).toBe(200);
    expect((await plan(runV2)).reconciliation.ok).toBe(true);
  });

  it('dispatching one part does not mark the whole split order dispatched', async () => {
    const p2 = await plan(runV2);
    const first = p2.loads
      .filter((l: any) => l.status === 'LOCKED' && l.stops.some((s: any) => s.customerCode === 'BIG'))
      .sort((a: any, b: any) => a.loadNo - b.loadNo)[0];
    // Dispatch that truck's loads in order up to the BIG part.
    for (const l of p2.loads.filter((x: any) => x.truckId === first.truckId && x.loadNo <= first.loadNo).sort((a: any, b: any) => a.loadNo - b.loadNo)) {
      const d = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/loads/${l.id}`, j({ status: 'DISPATCHED' }, 'PATCH'));
      expect(d.status).toBe(200);
    }
    const o = await prisma.order.findUniqueOrThrow({ where: { id: bigOrderId } });
    expect(o.status).not.toBe('DISPATCHED');
    const small = await prisma.order.findMany({ where: { tenantId: t.tenantId, id: { in: first.stops.filter((s: any) => s.customerCode !== 'BIG').flatMap((s: any) => s.orderIds) } } });
    for (const x of small) expect(x.status).toBe('DISPATCHED');
  });

  it('labels the parts in the Excel workbook', async () => {
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/export/excel`);
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await r.arrayBuffer());
    const labels: string[] = [];
    wb.eachSheet((ws) =>
      ws.eachRow((row) =>
        row.eachCell((c) => {
          if (typeof c.value === 'string' && c.value.includes('SPLIT DELIVERY part')) labels.push(c.value);
        }),
      ),
    );
    expect(labels.length).toBeGreaterThanOrEqual(2);
    const rec = wb.getWorksheet('RECONCILIATION');
    if (rec) expect(rec.getCell(5, 6).value).toBe('OK');
  });

  it('with split deliveries turned off, the big customer stays whole (and unserved, with a reason)', async () => {
    const off = await fetchWith(t.cookieJar, `${BASE}/api/tenant/config`, j({ config: { splitDeliveries: false } }, 'PATCH'));
    expect(off.status).toBe(200);
    await upload(day2, [
      ['SO-B2', 'BIG', 'Hyper Big', 'TAN-500-24', '180', '360', '54'],
      ['SO-B2', 'BIG', 'Hyper Big', 'TAN-1500-6', '90', '180', '27'],
      ['SO-S3', 'S1', 'Small One', 'TAN-500-24', '10', '20', '3'],
    ]);
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day2, depotId, optimize: true }));
    expect(r.status).toBe(202);
    const runId = (await json(r)).data.runId;
    await waitForPlan(runId);
    const p = await plan(runId);
    expect(p.reconciliation.ok).toBe(true);
    expect(bigStops(p)).toEqual([]);
    const u = bigUnserved(p);
    expect(u.length).toBe(1);
    expect(u[0].cases).toBe(BIG_CASES);
    expect(u[0].partial).toBe(false);
    expect(u[0].reasonCode).toBeTruthy();
    await fetchWith(t.cookieJar, `${BASE}/api/tenant/config`, j({ config: { splitDeliveries: true } }, 'PATCH'));
  });
});
