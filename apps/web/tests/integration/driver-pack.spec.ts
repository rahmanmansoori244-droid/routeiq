/**
 * DRIVER SHEETS + DRIVER PER LOAD - end-to-end against the running web app + solver: the trucks
 * API keeps a default driver per truck (same tenant, active), a new plan puts it on the truck's
 * loads, the dispatcher changes the driver per load (shown in /plan, refused after dispatch and
 * on a replaced version; driver + status in one request succeed or fail together), a re-plan
 * keeps each truck's and each trip's driver, and the PDF export returns the driver sheets (whole
 * plan, one load, one truck; 404 for unknown ids).
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let otherSlug = '';
let otherDriverId = '';
let depotId = '';
let day = '';
let runV1 = '';
let runV2 = '';
const trucks: Record<string, string> = {};
const drivers: Record<string, string> = {};
let chosenTruck = ''; // the truck whose loads get driver D2 by hand

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
const pageCount = (buf: ArrayBuffer) => (Buffer.from(buf).toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

async function upload(date: string, rows: string[][]) {
  const d = dmy(date);
  const head = ['SO No', 'SO Date', 'Req. Delivery Date', 'Customer Code', 'Branch', 'Customer Name', 'Item Code', 'Item Description', 'Qty (Cases)', 'Net Value', 'CM'];
  const csv = [head, ...rows.map(([so, code, name, item, qty]) => [so, d, d, code, '', name, item, '', qty, '100', '20'])].map((r) => r.join(',')).join('\n');
  const fd = new FormData();
  fd.set('file', new Blob([csv], { type: 'text/csv' }), `drivers-${date}.csv`);
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

const patchLoad = (runId: string, loadId: string, body: unknown) => fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/loads/${loadId}`, j(body, 'PATCH'));

beforeAll(async () => {
  t = await freshTenant('drvpack');
  day = isoPlus(2);
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
    const tr = await prisma.truck.create({
      data: { tenantId: t.tenantId, depotId, code, capacityCases: 120, capacityWeightKg: 2500, fixedCostPerDay: 20, costPerKm: 0.08, kmPerLitre: 6, tripCost: 2 },
    });
    trucks[code] = tr.id;
  }
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TAN-500-24', name: 'Tanuf 500ml x24', weightPerCaseKg: 12.8 } });
  const customers: [string, string, number, number, string, string | null][] = [
    ['C1', 'Lulu Bausher', 23.588, 58.41, 'Bausher, Sultan Qaboos St', 'Back gate; forklift until 14:00'],
    ['C2', 'Al Fair Qurum', 23.6, 58.372, 'Qurum, Al Qurum St', null],
    ['C3', 'Seeb Trading', 23.62, 58.3, 'Seeb souq', null],
    ['C4', 'Nesto Mabela', 23.64, 58.25, 'Mabela South', 'Call the manager before arrival'],
    ['C5', 'Ruwi Mart', 23.59, 58.54, 'Ruwi High St', null],
    ['C6', 'Amerat Store', 23.52, 58.5, 'Amerat roundabout', null],
  ];
  for (const [code, name, lat, lng, address, accessNotes] of customers) {
    await prisma.customer.create({
      data: {
        tenantId: t.tenantId, code, branchKey: '__MAIN__', name, lat, lng, address, accessNotes, geocodeConfidence: 'HIGH', locationVerified: true,
        priority: 2, priorityConfirmed: true, avgServiceTimeMin: 15, serviceTimeConfirmed: true,
      },
    });
  }
  for (const [code, name, phone, active] of [
    ['D1', 'Salim Al Harthy', '+968 9123 4567', true],
    ['D2', 'Rashid Al Balushi', '+968 9555 0102', true],
    ['D3', 'Old Driver', '+968 9000 0000', false],
  ] as const) {
    const r = await fetchWith(t.cookieJar, `${BASE}/api/drivers`, j({ code, name, phone, active }));
    expect(r.status).toBe(201);
    drivers[code] = (await json(r)).data.id;
  }
  // A driver of another tenant: never assignable here.
  const other = await freshTenant('drvpack-x');
  otherSlug = other.slug;
  otherDriverId = (await prisma.driver.create({ data: { tenantId: other.tenantId, code: 'X1', name: 'Other Tenant Driver' } })).id;
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  if (otherSlug) await cleanupTenant(otherSlug);
  await prisma.$disconnect();
});

describe('driver sheets and drivers per load', () => {
  it('keeps a default driver per truck through the trucks API (same tenant, active only)', async () => {
    const set = await fetchWith(t.cookieJar, `${BASE}/api/trucks/${trucks.T01}`, j({ defaultDriverId: drivers.D1 }, 'PATCH'));
    expect(set.status).toBe(200);
    expect((await json(set)).data.defaultDriverId).toBe(drivers.D1);
    const get = await fetchWith(t.cookieJar, `${BASE}/api/trucks/${trucks.T01}`);
    expect((await json(get)).data.defaultDriverId).toBe(drivers.D1);

    expect((await fetchWith(t.cookieJar, `${BASE}/api/trucks/${trucks.T02}`, j({ defaultDriverId: otherDriverId }, 'PATCH'))).status).toBe(400);
    expect((await fetchWith(t.cookieJar, `${BASE}/api/trucks/${trucks.T02}`, j({ defaultDriverId: drivers.D3 }, 'PATCH'))).status).toBe(400);
    const clear = await fetchWith(t.cookieJar, `${BASE}/api/trucks/${trucks.T02}`, j({ defaultDriverId: null }, 'PATCH'));
    expect(clear.status).toBe(200);
    expect((await json(clear)).data.defaultDriverId).toBeNull();

    // Created with a default driver (inactive truck, so the planner never uses it).
    const created = await fetchWith(
      t.cookieJar,
      `${BASE}/api/trucks`,
      j({ code: 'T09', depotId, capacityCases: 100, capacityWeightKg: 2000, capacityVolumeL: 0, fixedCostPerDay: 0, costPerKm: 0, defaultDriverId: drivers.D2, active: false }),
    );
    expect(created.status).toBe(201);
    expect((await json(created)).data.defaultDriverId).toBe(drivers.D2);
    const list = (await json(await fetchWith(t.cookieJar, `${BASE}/api/trucks`))).data as { code: string; defaultDriverId: string | null }[];
    expect(list.find((x) => x.code === 'T09')?.defaultDriverId).toBe(drivers.D2);
    expect(
      (await fetchWith(t.cookieJar, `${BASE}/api/trucks`, j({ code: 'T10', depotId, capacityCases: 100, capacityWeightKg: 2000, capacityVolumeL: 0, fixedCostPerDay: 0, costPerKm: 0, defaultDriverId: otherDriverId }))).status,
    ).toBe(400);

    // The drivers list never carries the PIN hash.
    const ds = (await json(await fetchWith(t.cookieJar, `${BASE}/api/drivers`))).data as Record<string, unknown>[];
    expect(ds.length).toBe(3);
    for (const d of ds) expect(d).not.toHaveProperty('accessPinHash');
  });

  it('a new plan puts each truck default driver on its loads', async () => {
    await upload(day, [
      ['SO-1', 'C1', 'Lulu Bausher', 'TAN-500-24', '60'],
      ['SO-2', 'C2', 'Al Fair Qurum', 'TAN-500-24', '50'],
      ['SO-3', 'C3', 'Seeb Trading', 'TAN-500-24', '55'],
      ['SO-4', 'C4', 'Nesto Mabela', 'TAN-500-24', '45'],
      ['SO-5', 'C5', 'Ruwi Mart', 'TAN-500-24', '40'],
      ['SO-6', 'C6', 'Amerat Store', 'TAN-500-24', '35'],
    ]);
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true }));
    expect(r.status).toBe(202);
    runV1 = (await json(r)).data.runId;
    expect((await waitForPlan(runV1)).run.status).toBe('READY');
    const p = await plan(runV1);
    expect(p.loads.length).toBeGreaterThanOrEqual(2);
    for (const l of p.loads) {
      if (l.truckId === trucks.T01) expect(l).toMatchObject({ driverId: drivers.D1, driverName: 'Salim Al Harthy', driverPhone: '+968 9123 4567' });
      else expect(l.driverId).toBeNull();
    }
    const stops = p.loads.flatMap((l: any) => l.stops);
    expect(stops.find((s: any) => s.customerCode === 'C1')).toMatchObject({ address: 'Bausher, Sultan Qaboos St', accessNotes: 'Back gate; forklift until 14:00' });
  });

  it('exports the driver sheets as PDF: whole plan, one load, one truck', async () => {
    const p = await plan(runV1);
    const all = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/export/pdf`);
    expect(all.status).toBe(200);
    expect(all.headers.get('content-type')).toBe('application/pdf');
    expect(all.headers.get('content-disposition')).toContain(`driver-sheets-${day}-v1.pdf`);
    const buf = await all.arrayBuffer();
    expect(Buffer.from(buf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageCount(buf)).toBeGreaterThanOrEqual(p.loads.length);

    const first = p.loads[0];
    const one = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/export/pdf?load=${first.id}`);
    expect(one.status).toBe(200);
    expect(one.headers.get('content-type')).toBe('application/pdf');
    expect(one.headers.get('content-disposition')).toContain(`driver-sheets-${day}-v1-${first.truckCode}-trip${first.loadNo}.pdf`);
    const oneBuf = await one.arrayBuffer();
    expect(pageCount(oneBuf)).toBeGreaterThanOrEqual(1);
    expect(pageCount(oneBuf)).toBeLessThan(pageCount(buf));

    const byTruck = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/export/pdf?truck=${first.truckId}`);
    expect(byTruck.status).toBe(200);
    expect(byTruck.headers.get('content-disposition')).toContain(`driver-sheets-${day}-v1-${first.truckCode}.pdf`);
    expect(pageCount(await byTruck.arrayBuffer())).toBeGreaterThanOrEqual(p.loads.filter((l: any) => l.truckId === first.truckId).length);

    expect((await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/export/pdf?load=nope`)).status).toBe(404);
    expect((await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/export/pdf?truck=nope`)).status).toBe(404);
    // The dispatcher's Excel workbook is unchanged.
    expect((await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/export/excel`)).status).toBe(200);
  });

  it('the dispatcher sets the driver per load and /plan shows it', async () => {
    const p = await plan(runV1);
    chosenTruck = p.loads[0].truckId;
    const mine = p.loads.filter((l: any) => l.truckId === chosenTruck);
    for (const l of mine) {
      const r = await patchLoad(runV1, l.id, { driverId: drivers.D2 });
      expect(r.status).toBe(200);
    }
    const p2 = await plan(runV1);
    for (const l of p2.loads.filter((x: any) => x.truckId === chosenTruck)) {
      expect(l).toMatchObject({ driverId: drivers.D2, driverName: 'Rashid Al Balushi', driverPhone: '+968 9555 0102' });
    }
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: t.tenantId, action: 'LOAD_DRIVER_SET', entityId: mine[0].id }, orderBy: { createdAt: 'desc' } });
    expect((audit?.afterJson as any)?.driverId).toBe(drivers.D2);
    expect((audit?.beforeJson as any)?.driverId).toBe(mine[0].driverId);

    const l = mine[0];
    expect((await patchLoad(runV1, l.id, { driverId: otherDriverId })).status).toBe(400); // another tenant's driver
    expect((await patchLoad(runV1, l.id, { driverId: drivers.D3 })).status).toBe(400); // inactive
    expect((await patchLoad(runV1, l.id, {})).status).toBe(400); // nothing to change
    expect((await patchLoad(runV1, 'no-such-load', { driverId: drivers.D1 })).status).toBe(404);
    const cleared = await patchLoad(runV1, l.id, { driverId: null });
    expect(cleared.status).toBe(200);
    expect((await plan(runV1)).loads.find((x: any) => x.id === l.id).driverId).toBeNull();
    expect((await patchLoad(runV1, l.id, { driverId: drivers.D2 })).status).toBe(200);
  });

  it('a re-plan keeps the driver of each truck (plan version before the truck default)', async () => {
    const p1 = await plan(runV1);
    const v1Driver = new Map<string, string | null>();
    for (const l of p1.loads) v1Driver.set(l.truckId, l.driverId);
    const rp = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/replan`, j({ reason: 'REOPTIMIZE' }));
    expect(rp.status).toBe(202);
    runV2 = (await json(rp)).data.runId;
    await waitForPlan(runV2);
    const p2 = await plan(runV2);
    expect(p2.loads.length).toBeGreaterThan(0);
    for (const l of p2.loads) {
      // chosenTruck: D2 set by hand in v1 wins over T01's default D1; the other truck keeps v1's.
      expect(l.driverId).toBe(l.truckId === chosenTruck ? drivers.D2 : (v1Driver.get(l.truckId) ?? (l.truckId === trucks.T01 ? drivers.D1 : null)));
    }
    // The replaced version is read-only: its drivers cannot change any more.
    const old = await patchLoad(runV1, p1.loads[0].id, { driverId: drivers.D1 });
    expect(old.status).toBe(409);
  });

  it('sets driver and status together, and refuses a driver change after dispatch', async () => {
    const p = await plan(runV2);
    const first = p.loads.filter((l: any) => l.loadNo === 1).sort((a: any, b: any) => a.truckCode.localeCompare(b.truckCode))[0];
    const both = await patchLoad(runV2, first.id, { status: 'LOCKED', driverId: drivers.D1 });
    expect(both.status).toBe(200);
    const locked = (await plan(runV2)).loads.find((l: any) => l.id === first.id);
    expect(locked).toMatchObject({ status: 'LOCKED', driverId: drivers.D1 });

    // Driver + status in one request is one transaction: a refused status change keeps the old driver.
    const other = (await plan(runV2)).loads.find((l: any) => l.id !== first.id && l.status === 'PLANNED');
    expect(other).toBeTruthy();
    const otherDriver = other.driverId === drivers.D2 ? drivers.D1 : drivers.D2;
    const driverAudits = () => prisma.auditLog.count({ where: { tenantId: t.tenantId, action: 'LOAD_DRIVER_SET', entityId: other.id } });
    const auditsBefore = await driverAudits();
    const badStatus = await patchLoad(runV2, other.id, { driverId: otherDriver, status: 'LOADING' }); // PLANNED cannot go straight to LOADING
    expect(badStatus.status).toBe(409);
    expect((await plan(runV2)).loads.find((l: any) => l.id === other.id)).toMatchObject({ status: 'PLANNED', driverId: other.driverId });
    expect(await driverAudits()).toBe(auditsBefore);

    const out = await patchLoad(runV2, first.id, { status: 'DISPATCHED' });
    expect(out.status).toBe(200);
    const refused = await patchLoad(runV2, first.id, { driverId: drivers.D2 });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toBe('Driver cannot change after dispatch.');
    expect((await plan(runV2)).loads.find((l: any) => l.id === first.id).driverId).toBe(drivers.D1);
    // Its sheet can still be printed.
    const pdf = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/export/pdf?load=${first.id}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-disposition')).toContain(`driver-sheets-${day}-v2-`);

    // Re-sending the load's own driver along with a status change is not a driver change.
    const done = await patchLoad(runV2, first.id, { status: 'COMPLETED', driverId: drivers.D1 });
    expect(done.status).toBe(200);
    expect((await plan(runV2)).loads.find((l: any) => l.id === first.id)).toMatchObject({ status: 'COMPLETED', driverId: drivers.D1 });
  });

  it('a re-plan keeps each trip its own driver: the same trip in the previous version beats the carried trip 1', async () => {
    // One more driver, so each truck has its own and no guess is refused for a clash.
    const r4 = await fetchWith(t.cookieJar, `${BASE}/api/drivers`, j({ code: 'D4', name: 'Khalid Al Amri', phone: '+968 9777 0104', active: true }));
    expect(r4.status).toBe(201);
    drivers.D4 = (await json(r4)).data.id;

    const p = await plan(runV2);
    const byTruck = new Map<string, any[]>();
    for (const l of p.loads) byTruck.set(l.truckId, [...(byTruck.get(l.truckId) ?? []), l]);
    // A truck with 2+ trips (285 cases do not fit in one trip of each 120-case truck).
    const x = [...byTruck.entries()].find(([, ls]) => ls.length >= 2)?.[0];
    expect(x).toBeTruthy();
    const xLoads = byTruck.get(x!)!.sort((a: any, b: any) => a.loadNo - b.loadNo);
    // Trip 1 frozen with D1 (so it is carried); the dispatcher gives the later trips to D2.
    if (xLoads[0].status === 'PLANNED') expect((await patchLoad(runV2, xLoads[0].id, { status: 'LOCKED', driverId: drivers.D1 })).status).toBe(200);
    for (const l of xLoads.slice(1)) expect((await patchLoad(runV2, l.id, { driverId: drivers.D2 })).status).toBe(200);
    for (const l of p.loads) if (l.truckId !== x && l.status === 'PLANNED') expect((await patchLoad(runV2, l.id, { driverId: drivers.D4 })).status).toBe(200);
    const v2Driver = new Map<string, string | null>((await plan(runV2)).loads.map((l: any) => [`${l.truckId}:${l.loadNo}`, l.driverId]));
    expect(v2Driver.get(`${x}:1`)).toBe(drivers.D1);

    const rp = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV2}/replan`, j({ reason: 'REOPTIMIZE' }));
    expect(rp.status).toBe(202);
    const runV3 = (await json(rp)).data.runId as string;
    await waitForPlan(runV3);
    const p3 = await plan(runV3);
    expect(p3.loads.length).toBeGreaterThan(0);
    for (const l of p3.loads) {
      const key = `${l.truckId}:${l.loadNo}`;
      if (l.carried) expect(l.driverId, key).toBe(v2Driver.get(key));
      // Every new trip of X is numbered after the carried trip 1: D2 as in v2, never trip 1's D1.
      else if (l.truckId === x) expect(l.driverId, key).toBe(drivers.D2);
      else if (v2Driver.has(key)) expect(l.driverId, key).toBe(v2Driver.get(key));
    }
  });
});
