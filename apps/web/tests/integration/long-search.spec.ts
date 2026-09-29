/**
 * Long searches end to end (owner request 29 Sep 2026: "make sure the solver is giving an optimal
 * solution even if it runs for 20 mins"; decision "night plans long, day re-plans quick"), against
 * the running web app + solver:
 *
 *  the day offers THOROUGH for tomorrow -> OPTIMIZE (Thorough) -> the job RUNS with its mode, start
 *  and heartbeat, the janitor leaves it alone -> the plan is saved with how it was searched (mode,
 *  time, why it stopped) on the plan, the job message, the summary and the Excel ASSUMPTIONS ->
 *  a Thorough plan for today times its new loads from the end of its search (review of the
 *  long-search PR) -> a Quick re-plan searches the automatic time.
 *
 * Runs only when the web app's THOROUGH_MAX_SEC is small (CI sets 60 s): with the real 20 minutes
 * it would take 20 minutes. Requires RATE_LIMITS_DISABLED=1 like the other suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';
let deliveryDate = '';
let capSec = 1200;
let runId = '';

function isoPlus(days: number) {
  const d = new Date(Date.now() + 4 * 3600_000); // Muscat
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const dmy = (iso: string) => iso.split('-').reverse().join('/');
const j = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const json = async <T = any>(res: Response): Promise<T> => (await res.json()) as T;
const planOf = async (id: string) => (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${id}/plan`))).data;
const running = (p: any) => p.run.status === 'OPTIMIZING' || p.job?.status === 'RUNNING' || p.job?.status === 'QUEUED';

async function callJanitor() {
  const tok = process.env.JANITOR_TOKEN || process.env.SOLVER_TOKEN;
  const res = await fetch(`${BASE}/api/cron/janitor`, { method: 'POST', headers: { 'X-Janitor-Token': tok! } });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  t = await freshTenant('long-search');
  deliveryDate = isoPlus(1);
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 23 * 60 + 59, shiftStartMin: 6 * 60, driverShiftMaxMinutes: 12 * 60, reloadMinutes: 30, maxTripsPerTruck: 3, distanceProvider: 'HAVERSINE', osrmUrl: null },
  });
  const depot = await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } });
  depotId = depot.id;
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code, capacityCases: 120, capacityWeightKg: 2500, fixedCostPerDay: 20, costPerKm: 0.08, kmPerLitre: 6, tripCost: 2 } });
  }
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TAN-500-24', name: 'Tanuf 500ml x24', weightPerCaseKg: 12.8 } });
  const spots: [string, number, number][] = [
    ['C101', 23.589, 58.41],
    ['C102', 23.614, 58.476],
    ['C103', 23.6, 58.372],
    ['C104', 23.52, 58.497],
    ['C105', 23.598, 58.543],
    ['C106', 23.598, 58.34],
  ];
  for (const [code, lat, lng] of spots) {
    await prisma.customer.create({
      data: {
        tenantId: t.tenantId,
        code,
        branchKey: '__MAIN__',
        name: `Grocery ${code}`,
        lat,
        lng,
        geocodeConfidence: 'HIGH',
        locationVerified: true,
        customerType: 'GROCERY',
        priority: 3,
        priorityConfirmed: true,
        avgServiceTimeMin: 10,
        serviceTimeConfirmed: true,
      },
    });
  }
  const d = dmy(deliveryDate);
  const rows = [['SO No', 'SO Date', 'Req. Delivery Date', 'Customer Code', 'Branch', 'Customer Name', 'Item Code', 'Item Description', 'Qty (Cases)', 'Net Value', 'CM']];
  spots.forEach(([code], i) => rows.push([`SO-${i + 1}`, d, d, code, '', `Grocery ${code}`, 'TAN-500-24', '', String(20 + i * 5), '50', '8']));
  const fd = new FormData();
  fd.set('file', new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), 'orders.csv');
  fd.set('depotId', depotId);
  const up = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
  expect(up.status).toBe(200);
  const batch = await prisma.uploadBatch.findFirstOrThrow({ where: { tenantId: t.tenantId } });
  expect((await fetchWith(t.cookieJar, `${BASE}/api/orders/${batch.id}/confirm`, j({}))).status).toBe(200);
  const day = (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/day?date=${deliveryDate}&depotId=${depotId}`))).data;
  capSec = day.thoroughMaxSec;
}, 120_000);

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('long searches end to end', () => {
  it('offers Thorough for tomorrow (and states the cap)', async () => {
    const day = (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/day?date=${deliveryDate}&depotId=${depotId}`))).data;
    expect(day.searchModeDefault).toBe('THOROUGH');
    expect(day.thoroughMaxSec).toBeGreaterThanOrEqual(10);
    const today = (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/day?date=${day.today}&depotId=${depotId}`))).data;
    expect(today.searchModeDefault).toBe('QUICK');
  });

  it('THOROUGH: runs with its mode and heartbeat, is never reaped, and saves how it searched', async (ctx) => {
    if (capSec > 120) ctx.skip(); // the web app searches up to its real 20 minutes: not in a test
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: deliveryDate, depotId, optimize: true, searchMode: 'THOROUGH' }));
    expect(r.status).toBe(202);
    const started = (await json(r)).data;
    expect(started).toMatchObject({ searchMode: 'THOROUGH', maxSearchSec: capSec });
    runId = started.runId;

    let sawRunning = false;
    let p: any;
    const deadline = Date.now() + (capSec + 150) * 1000;
    for (;;) {
      p = await planOf(runId);
      if (!running(p)) break;
      if (p.job?.status === 'RUNNING' && !sawRunning) {
        sawRunning = true;
        expect(p.job.searchMode).toBe('THOROUGH');
        expect(p.job.startedAt).toBeTruthy();
        expect(p.job.message).toMatch(/Thorough: up to/);
        expect(p.stuck).toBeNull();
        // The janitor during the search: the job is alive (heartbeat), nothing is reaped.
        await callJanitor();
        const row = await prisma.runJob.findUniqueOrThrow({ where: { id: p.job.id } });
        expect(row.status).toBe('RUNNING');
        expect(row.heartbeatAt).not.toBeNull();
        expect(row.searchMode).toBe('THOROUGH');
      }
      if (Date.now() > deadline) throw new Error('the thorough search did not end within its cap');
      await new Promise((res) => setTimeout(res, 2000));
    }
    expect(sawRunning).toBe(true);
    expect(p.run.status).toBe('READY');
    expect(p.search).toMatchObject({ mode: 'THOROUGH', cap_sec: capSec });
    expect(['CONVERGED', 'CAP']).toContain(p.search.stop_reason);
    expect(p.search.used_sec).toBeLessThanOrEqual(capSec + 10);
    expect(p.search.best_over_time.length).toBeGreaterThan(0);
    expect(p.job.message).toMatch(/Thorough search: searched/);
    expect(p.job.message).not.toMatch(/\boptimal\b/i);
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    expect((run.summaryJson as any).solver.search).toMatchObject({ mode: 'THOROUGH' });
    const job = await prisma.runJob.findUniqueOrThrow({ where: { id: p.job.id } });
    expect((job.requestJson as any).config).toMatchObject({ search_mode: 'THOROUGH', max_search_sec: capSec });

    // The Excel ASSUMPTIONS sheet says how it searched, and what that means.
    const x = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/export/excel`);
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await x.arrayBuffer()) as never);
    const values: string[] = [];
    wb.getWorksheet('ASSUMPTIONS')!.eachRow((row) => values.push(row.values ? String((row.values as unknown[]).slice(1).join(' | ')) : ''));
    expect(values.some((v) => v.startsWith('Route search | Thorough search: searched'))).toBe(true);
    expect(values.some((v) => v.startsWith('Route search - what it means | ') && v.includes('not a proven best'))).toBe(true);
  }, 600_000);

  it('THOROUGH on the delivery day: no new load leaves before the plan exists + the turnaround (review of the long-search PR)', async (ctx) => {
    if (capSec > 120) ctx.skip(); // the web app searches up to its real 20 minutes: not in a test
    const FIRST_DEPARTURE_MIN = 6 * 60; // the tenant's shift start (06:00; the depot opens at 05:00)
    const muscatMin = (d: Date) => (d.getUTCHours() * 60 + d.getUTCMinutes() + 240) % 1440;
    // Late in the Muscat evening the depot (open 05:00-23:00) cannot send anything more today.
    if (muscatMin(new Date()) > 21 * 60) ctx.skip();
    const today = isoPlus(0);
    const d = dmy(today);
    const rows = [['SO No', 'SO Date', 'Req. Delivery Date', 'Customer Code', 'Branch', 'Customer Name', 'Item Code', 'Item Description', 'Qty (Cases)', 'Net Value', 'CM']];
    ['C101', 'C103', 'C105'].forEach((code, i) => rows.push([`SOT-${i + 1}`, d, d, code, '', `Grocery ${code}`, 'TAN-500-24', '', String(15 + i * 5), '40', '6']));
    const fd = new FormData();
    fd.set('file', new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), 'today.csv');
    fd.set('depotId', depotId);
    const up = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
    expect(up.status, await up.clone().text()).toBe(200);
    const batch = await prisma.uploadBatch.findFirstOrThrow({ where: { tenantId: t.tenantId, fileName: 'today.csv' } });
    // Orders for today are late (after the evening cutoff): the reason is asked for.
    const confirmed = await fetchWith(t.cookieJar, `${BASE}/api/orders/${batch.id}/confirm`, j({ lateReason: 'Test: same-day order' }));
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);

    const pressMin = muscatMin(new Date());
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: today, depotId, optimize: true, searchMode: 'THOROUGH' }));
    expect(r.status).toBe(202);
    const sameDayRun = (await json(r)).data.runId as string;
    // The request: new loads from the press + the cap (whole minutes) + the 30 min turnaround; loading from the end of the search.
    const lead = Math.ceil(capSec / 60);
    const first = await prisma.runJob.findFirstOrThrow({ where: { runId: sameDayRun }, orderBy: { attemptNo: 'desc' } });
    const sent = (first.requestJson as any).config;
    expect(sent.shift_start_min).toBeGreaterThanOrEqual(pressMin + lead + 30);
    expect(sent.loading_from_min).toBeGreaterThanOrEqual(pressMin + lead);

    let p: any;
    const deadline = Date.now() + (capSec + 150) * 1000;
    for (;;) {
      p = await planOf(sameDayRun);
      if (!running(p)) break;
      if (Date.now() > deadline) throw new Error('the same-day thorough search did not end within its cap');
      await new Promise((res) => setTimeout(res, 2000));
    }
    expect(p.run.status).toBe('READY');
    const job = await prisma.runJob.findUniqueOrThrow({ where: { id: first.id } });
    // What was sent is what is stored (the job times it again when it really starts).
    const stored = (job.requestJson as any).config;
    expect(stored.shift_start_min).toBeGreaterThanOrEqual(muscatMin(job.startedAt!) + lead + 30);
    const savedMin = muscatMin(job.finishedAt!);
    expect(p.loads.length).toBeGreaterThan(0);
    for (const l of p.loads) expect(l.departMin, `${l.truckCode} L${l.loadNo}`).toBeGreaterThanOrEqual(savedMin + 30 - 1);
    const plannedFrom = p.warnings.some((w: string) => /^Planned from \d\d:\d\d \(now \d\d:\d\d \+ up to \d+ min Thorough search \+ 30 min preparation\)/.test(w));
    if (stored.shift_start_min > FIRST_DEPARTURE_MIN) {
      // Planned from its start + the cap + the turnaround, and it says so.
      expect(stored.shift_start_min).toBeLessThanOrEqual(muscatMin(job.startedAt!) + lead + 30 + 1);
      expect(plannedFrom).toBe(true);
    } else {
      // Before about 05:30 in Muscat, now + the search + the turnaround is still before the 06:00 first
      // departure: the loads keep their usual start and no "Planned from" line is due, but the loading
      // still counts from the end of the search (skeptic review: this case failed every night from 00:00
      // to 05:29 Muscat, 20:00-01:29 UTC).
      expect(muscatMin(job.startedAt!) + lead + 30).toBeLessThanOrEqual(FIRST_DEPARTURE_MIN + 1);
      expect(stored.shift_start_min).toBe(FIRST_DEPARTURE_MIN);
      expect(stored.loading_from_min).toBeGreaterThanOrEqual(muscatMin(job.startedAt!) + lead);
      expect(p.warnings.some((w: string) => /^Planned from /.test(w))).toBe(false);
    }
  }, 600_000);

  it('QUICK: a re-plan searches the automatic time and says so', async (ctx) => {
    if (!runId) ctx.skip();
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/replan`, j({ reason: 'REOPTIMIZE', searchMode: 'QUICK' }));
    expect(r.status).toBe(202);
    const next = (await json(r)).data.runId;
    let p: any;
    for (let i = 0; i < 120; i++) {
      p = await planOf(next);
      if (!running(p)) break;
      await new Promise((res) => setTimeout(res, 1500));
    }
    expect(p.run.status).toBe('READY');
    expect(p.search).toMatchObject({ mode: 'QUICK', stop_reason: 'TIME_LIMIT' });
    expect(p.job.searchMode).toBe('QUICK');
  }, 300_000);
});
