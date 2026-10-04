/**
 * DRIVER LINK AND DRIVER PAGE (owner request 4 Oct 2026), end-to-end against the running web app +
 * solver. One file grown across the three build parts; Part 1:
 * - the dispatcher makes the truck-day's link (POST /api/dispatch/driver-links);
 * - GET /d/<token> is a shell: 200 with X-Robots-Tag noindex and Referrer-Policy no-referrer, and
 *   its HTML holds no customer of the plan;
 * - GET /api/d/manifest with `Authorization: DriverLink <token>` gives that truck's loads only;
 *   without the header 404; a signed-in user of the company is the office;
 * - another company's session cannot read, make or change this plan's links (404);
 * - after a reissue the old token answers 410 LINK_REPLACED;
 * - owner rule 20: dispatch without a driver is 409 DRIVER_REQUIRED; a daily driver added from the
 *   load, then dispatch: 200; the same phone with another name: 409 PHONE_BELONGS_TO.
 * Part 2 (the plan and its links move to today first: the phone's times must lie inside the day):
 * - an arrival on a LOADING load is transient LOAD_NOT_DISPATCHED, then accepted after Dispatch;
 * - Delivered with a photo key, then the photo: stored without its EXIF; replays answer duplicate;
 *   the photo is served to its own truck-day's link only;
 * - an automatic arrival 2 km from the pin is stored as a manual one (downgraded);
 * - a result on every stop + Back at depot complete the load (audited with the driver link);
 * - after the dispatcher completes a load: a backdated change is LOAD_COMPLETED, a gap-fill is late.
 * Part 3 (the office side):
 * - GET /api/runs/:id/outcomes shows the results of the loads that left; another company 404;
 * - Record outcome (POST /api/dispatch/outcomes) corrects a stop of a completed load as the office,
 *   once per key, audited with before and after; another company 404;
 * - GET /api/delivery-photos/:id serves the photo to the company only;
 * - the "Delivery actuals" Excel downloads (31 days at most).
 * Bring forward from results (E1, E6, E10) runs on the real database in carry-over.spec.ts.
 * Synthetic data only.
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let other: TenantHandle;
let depotId = '';
let day = '';
let runId = '';
const trucks: Record<string, string> = {};
let token = '';
let linkId = '';

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
const driverGet = (path: string, tok: string | null, jar?: TenantHandle['cookieJar']) =>
  fetchWith(jar, `${BASE}${path}`, { headers: tok ? { authorization: `DriverLink ${tok}` } : {} });

async function waitForPlan(id: string, max = 120) {
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${id}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') return st.data;
  }
  throw new Error('optimization did not finish');
}

async function plan() {
  const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/plan`);
  expect(r.status).toBe(200);
  return (await json(r)).data;
}

const patchLoad = (loadId: string, body: unknown) => fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/loads/${loadId}`, j(body, 'PATCH'));

beforeAll(async () => {
  t = await freshTenant('drvlink');
  other = await freshTenant('drvlink-x');
  day = isoPlus(1);
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, shiftStartMin: 6 * 60, driverShiftMaxMinutes: 12 * 60, reloadMinutes: 30, maxTripsPerTruck: 3, distanceProvider: 'HAVERSINE', osrmUrl: null },
  });
  const depot = await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } });
  depotId = depot.id;
  const salim = await prisma.driver.create({ data: { tenantId: t.tenantId, code: 'D1', name: 'Salim', phone: '+968 9000 0001' } });
  for (const [code, hired, defaultDriverId] of [
    ['T01', false, salim.id],
    ['T02', true, null],
  ] as const) {
    const tr = await prisma.truck.create({
      data: { tenantId: t.tenantId, depotId, code, hired, defaultDriverId, capacityCases: 120, capacityWeightKg: 2500, fixedCostPerDay: 20, costPerKm: 0.08, kmPerLitre: 6, tripCost: 2 },
    });
    trucks[code] = tr.id;
  }
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'P-500', name: 'Water 500ml x24', weightPerCaseKg: 12.8 } });
  const customers: [string, string, number, number][] = [
    ['C1', 'Alpha Store', 23.588, 58.41],
    ['C2', 'Beta Market', 23.6, 58.372],
    ['C3', 'Gamma Trading', 23.62, 58.3],
    ['C4', 'Delta Shop', 23.64, 58.25],
    ['C5', 'Epsilon Mart', 23.59, 58.54],
    ['C6', 'Zeta Store', 23.52, 58.5],
  ];
  for (const [code, name, lat, lng] of customers) {
    await prisma.customer.create({
      data: { tenantId: t.tenantId, code, branchKey: '__MAIN__', name, lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 2, priorityConfirmed: true, avgServiceTimeMin: 15, serviceTimeConfirmed: true },
    });
  }
  const d = dmy(day);
  const head = ['SO No', 'SO Date', 'Req. Delivery Date', 'Customer Code', 'Branch', 'Customer Name', 'Item Code', 'Item Description', 'Qty (Cases)', 'Net Value', 'CM'];
  const rows = customers.map(([code, name], i) => [`SO-${i + 1}`, d, d, code, '', name, 'P-500', '', String(40 + i * 5), '100', '20']);
  const fd = new FormData();
  fd.set('file', new Blob([[head, ...rows].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `driver-link-${day}.csv`);
  fd.set('depotId', depotId);
  expect((await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd })).status).toBe(200);
  const batch = await prisma.uploadBatch.findFirstOrThrow({ where: { tenantId: t.tenantId }, orderBy: { uploadedAt: 'desc' } });
  expect((await fetchWith(t.cookieJar, `${BASE}/api/orders/${batch.id}/confirm`, j({}))).status).toBe(200);
  const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true }));
  expect(r.status).toBe(202);
  runId = (await json(r)).data.runId;
  expect((await waitForPlan(runId)).run.status).toBe('READY');
}, 300_000);

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  if (other) await cleanupTenant(other.slug);
  await prisma.$disconnect();
});

describe('Part 1: the driver link and the read-only driver page', () => {
  it('the dispatcher makes the truck-day link; only its hash is stored', async () => {
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/driver-links`, j({ runId, truckId: trucks.T01 }));
    expect(r.status).toBe(201);
    const v = (await json(r)).data;
    expect(v.url).toMatch(/\/d\/[A-Za-z0-9_-]{24}$/);
    expect(v.qr.d).toMatch(/^M\d/);
    token = v.url.split('/d/')[1];
    linkId = v.linkId;
    const row = await prisma.driverLink.findUniqueOrThrow({ where: { id: linkId } });
    expect(JSON.stringify(row)).not.toContain(token);
    // Listed with the plan; never made by the list.
    const list = (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/driver-links?runId=${runId}`))).data;
    expect(list.map((x: any) => x.truckId)).toEqual([trucks.T01]);
    const audit = await prisma.auditLog.findMany({ where: { tenantId: t.tenantId, action: 'DRIVER_LINK_ISSUED' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('GET /d/<token> is a data-free shell with noindex and no-referrer', async () => {
    const r = await fetch(`${BASE}/d/${token}`, { redirect: 'manual' });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-robots-tag')).toMatch(/noindex/);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    const html = await r.text();
    for (const name of ['Alpha Store', 'Beta Market', 'Gamma Trading', 'Delta Shop', 'Epsilon Mart', 'Zeta Store', 'Salim']) expect(html).not.toContain(name);
  });

  it('GET /api/d/manifest with the token in a header: that truck only; without it 404; signed in = the office', async () => {
    const r = await driverGet('/api/d/manifest', token);
    expect(r.status).toBe(200);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const m = (await json(r)).data;
    const p = await plan();
    const t01Loads = p.loads.filter((l: any) => l.truckId === trucks.T01);
    expect(m.truck).toMatchObject({ id: trucks.T01, code: 'T01', hired: false });
    expect(m.loads.map((l: any) => l.loadNo).sort()).toEqual(t01Loads.map((l: any) => l.loadNo).sort());
    expect(m.office).toBeNull();
    expect(JSON.stringify(m)).not.toMatch(/operatingCost|fuelCost|salesValue|margin/);
    expect((await driverGet('/api/d/manifest', null)).status).toBe(404);
    expect((await driverGet('/api/d/manifest', 'A'.repeat(24))).status).toBe(404);
    const office = (await json(await driverGet('/api/d/manifest', token, t.cookieJar))).data;
    expect(office.office).toEqual({ userName: 'Integration Admin' });
    // Another company's session on this link: refused.
    expect((await driverGet('/api/d/manifest', token, other.cookieJar)).status).toBe(403);
  });

  it("another company's session cannot read, make or change this plan's links", async () => {
    expect((await fetchWith(other.cookieJar, `${BASE}/api/dispatch/driver-links?runId=${runId}`)).status).toBe(404);
    expect((await fetchWith(other.cookieJar, `${BASE}/api/dispatch/driver-links`, j({ runId, truckId: trucks.T01 }))).status).toBe(404);
    expect((await fetchWith(other.cookieJar, `${BASE}/api/dispatch/driver-links/${linkId}`, j({ action: 'REVOKE' }, 'PATCH'))).status).toBe(404);
    expect((await prisma.driverLink.findUniqueOrThrow({ where: { id: linkId } })).revokedAt).toBeNull();
  });

  it('after a reissue the old token answers 410 LINK_REPLACED and the new one works', async () => {
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/driver-links/${linkId}`, j({ action: 'REISSUE', reason: 'test' }, 'PATCH'));
    expect(r.status).toBe(200);
    const v = (await json(r)).data;
    expect(v.generation).toBe(2);
    const old = await driverGet('/api/d/manifest', token);
    expect(old.status).toBe(410);
    expect((await json(old)).error).toMatchObject({ code: 'LINK_REPLACED' });
    token = v.url.split('/d/')[1];
    expect((await driverGet('/api/d/manifest', token)).status).toBe(200);
  });

  it('owner rule 20: dispatch without a driver is refused; a daily driver added from the load, then dispatch', async () => {
    const p = await plan();
    const t02 = p.loads.filter((l: any) => l.truckId === trucks.T02).sort((a: any, b: any) => a.loadNo - b.loadNo);
    expect(t02.length).toBeGreaterThanOrEqual(1);
    expect(t02[0].hired).toBe(true);
    const first = t02[0];
    expect(first.driverId).toBeNull();
    expect((await patchLoad(first.id, { status: 'LOCKED' })).status).toBe(200);
    const refused = await patchLoad(first.id, { status: 'DISPATCHED' });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatchObject({ code: 'DRIVER_REQUIRED' });
    const add = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/casual-driver`, j({ runId, loadId: first.id, name: 'Khalid', phone: '+968 9000 1111' }));
    expect(add.status).toBe(201);
    const added = (await json(add)).data;
    expect(added.driver).toMatchObject({ name: 'Khalid', casual: true });
    expect(added.driver.code).toMatch(/^DAY-\d{6}-1$/);
    expect((await patchLoad(first.id, { status: 'DISPATCHED' })).status).toBe(200);
    const actions = (await prisma.auditLog.findMany({ where: { tenantId: t.tenantId, action: { in: ['CASUAL_DRIVER_ADDED', 'LOAD_DRIVER_SET'] } } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['CASUAL_DRIVER_ADDED', 'LOAD_DRIVER_SET']));
  });

  it('the same phone with another name: 409 PHONE_BELONGS_TO, nothing saved', async () => {
    const p = await plan();
    const open = p.loads.find((l: any) => l.status === 'PLANNED' || l.status === 'LOCKED');
    expect(open).toBeTruthy();
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/casual-driver`, j({ runId, loadId: open.id, name: 'Hamad', phone: '9000 1111' }));
    expect(r.status).toBe(409);
    expect((await json(r)).error).toMatchObject({ code: 'PHONE_BELONGS_TO', name: 'Khalid' });
    expect(await prisma.driver.count({ where: { tenantId: t.tenantId, casual: true } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
// Part 2: field actions
// ---------------------------------------------------------------------------------------

const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** A tiny JPEG (structure only) with an EXIF block that must not be stored. */
function tinyJpeg(): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...ascii('Exif'), 0, 0, ...ascii('II'), 42, 0, 8, 0, 0, 0, 0, 0, ...ascii('EXIFSECRET')]),
    ...seg(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    ...seg(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]),
    ...seg(0xc4, [0, 1, ...Array.from({ length: 15 }, () => 0), 0]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    1,
    2,
    3,
    0xff,
    0xd9,
  ]);
}

describe('Part 2: results, photos and Back at depot from the driver page', () => {
  let t02Token = '';
  let t01LoadId = '';
  let t01LoadNo = 0;
  let stops: { key: string; lat: number; lng: number }[] = [];
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const uuid = () => crypto.randomUUID();
  const post = async (tok: string, actions: unknown[]) => {
    const r = await fetch(`${BASE}/api/d/actions`, {
      method: 'POST',
      headers: { authorization: `DriverLink ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientNow: new Date().toISOString(), actions }),
    });
    expect(r.status).toBe(200);
    return (await json(r)).data as { results: { key: string; status: string; code?: string; transient?: boolean }[] };
  };
  const manifest = async (tok: string) => (await json(await driverGet('/api/d/manifest', tok))).data;
  const arrival = (stop: { key: string; lat: number; lng: number }, key = uuid(), northM = 15) => ({
    key,
    type: 'ARRIVE',
    stop: stop.key,
    at: ago(20),
    mode: 'AUTO',
    pos: { lat: stop.lat + northM / 111_320, lng: stop.lng, accuracyM: 10, at: ago(20) },
  });

  beforeAll(async () => {
    // Every load change while the plan is still dated tomorrow (as in Part 1), then the plan and its
    // links move to today: the phone's times must lie inside the delivery day.
    const p = await plan();
    const t01 = p.loads.filter((l: any) => l.truckId === trucks.T01).sort((a: any, b: any) => a.loadNo - b.loadNo);
    t01LoadId = t01[0].id;
    t01LoadNo = t01[0].loadNo;
    const salim = await prisma.driver.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'D1' } });
    expect((await patchLoad(t01LoadId, { driverId: salim.id, status: 'LOCKED' })).status).toBe(200);
    expect((await patchLoad(t01LoadId, { status: 'LOADING' })).status).toBe(200);
    const r2 = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/driver-links`, j({ runId, truckId: trucks.T02 }));
    expect([200, 201]).toContain(r2.status);
    const v2 = (await json(r2)).data;
    t02Token = v2.url.split('/d/')[1];
    const today = isoPlus(0);
    await prisma.runPlan.update({ where: { id: runId }, data: { runDate: new Date(`${today}T00:00:00Z`) } });
    for (const id of [linkId, v2.linkId]) {
      await prisma.driverLink.update({ where: { id }, data: { deliveryDate: new Date(`${today}T00:00:00Z`), expiresAt: new Date(`${isoPlus(1)}T08:00:00Z`) } });
    }
    const m = await manifest(token);
    const load = m.loads.find((l: any) => l.loadNo === t01LoadNo);
    stops = load.stops.map((s: any) => ({ key: s.key, lat: s.lat, lng: s.lng }));
    expect(stops.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('an arrival on a LOADING load is kept on the phone (transient) and accepted once the load is dispatched', async () => {
    const a = arrival(stops[0]!);
    const first = await post(token, [a]);
    expect(first.results[0]).toMatchObject({ status: 'refused', code: 'LOAD_NOT_DISPATCHED', transient: true });
    expect((await patchLoad(t01LoadId, { status: 'DISPATCHED' })).status).toBe(200);
    expect((await post(token, [a])).results[0]).toMatchObject({ status: 'ok' });
    const ev = await prisma.stopEvent.findFirstOrThrow({ where: { tenantId: t.tenantId, idempotencyKey: `dl:${a.key}` } });
    expect(ev).toMatchObject({ kind: 'ARRIVED', source: 'PHONE_AUTO' });
  });

  it('Delivered with a photo key, then the photo (stored without its EXIF); the same batch again answers duplicate', async () => {
    const photoKey = uuid();
    const a = arrival(stops[0]!);
    const o = { key: uuid(), type: 'OUTCOME', stop: stops[0]!.key, at: ago(5), outcome: 'DELIVERED', photoKeys: [photoKey] };
    expect((await post(token, [a, o])).results.map((r) => r.status)).toEqual(['ok', 'ok']);
    const form = new FormData();
    form.append(
      'meta',
      JSON.stringify({ key: photoKey, stop: stops[0]!.key, takenAt: ago(5), clientNow: new Date().toISOString(), positionStatus: 'OK', pos: { lat: stops[0]!.lat, lng: stops[0]!.lng + 0.0002, accuracyM: 12, at: ago(5) } }),
    );
    form.append('file', new Blob([tinyJpeg() as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), 'p.jpg');
    const body = new Response(form);
    const bytes = new Uint8Array(await body.arrayBuffer());
    const up = await fetch(`${BASE}/api/d/photos`, {
      method: 'POST',
      headers: { authorization: `DriverLink ${token}`, 'content-type': body.headers.get('content-type')!, 'content-length': String(bytes.length) },
      body: bytes,
    });
    expect(up.status).toBe(200);
    const photo = (await json(up)).data;
    expect(photo.status).toBe('ok');
    const row = await prisma.deliveryPhoto.findUniqueOrThrow({ where: { id: photo.photoId } });
    expect(Buffer.from(row.bytes!).toString('latin1')).not.toContain('EXIFSECRET');
    const before = await prisma.stopEvent.count({ where: { tenantId: t.tenantId } });
    expect((await post(token, [a, o])).results.map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(await prisma.stopEvent.count({ where: { tenantId: t.tenantId } })).toBe(before);
    const visit = await prisma.stopVisit.findFirstOrThrow({ where: { tenantId: t.tenantId, truckId: trucks.T01, loadNo: t01LoadNo, sequence: Number(stops[0]!.key.split(':')[1]) } });
    expect(visit).toMatchObject({ outcome: 'DELIVERED', photoCount: 1 });
    // The photo of this truck-day is served to its link only.
    expect((await driverGet(`/api/d/photos/${photo.photoId}`, token)).status).toBe(200);
    expect((await driverGet(`/api/d/photos/${photo.photoId}`, t02Token)).status).toBe(404);
  });

  it('an automatic arrival 2 km from the pin is stored as a manual one (downgraded)', async () => {
    const stop = stops[1] ?? stops[0]!;
    const far = arrival(stop, uuid(), 2_000);
    expect((await post(token, [far])).results[0]).toMatchObject({ status: 'ok' });
    const ev = await prisma.stopEvent.findFirstOrThrow({ where: { tenantId: t.tenantId, idempotencyKey: `dl:${far.key}` } });
    expect(ev.source).toBe('PHONE_MANUAL');
    expect(ev.payloadJson).toMatchObject({ downgraded: true });
  });

  it('T02: a result on every stop and Back at depot complete the load, audited with the driver link', async () => {
    const m = await manifest(t02Token);
    const load = m.loads.find((l: any) => l.status === 'DISPATCHED');
    expect(load).toBeTruthy();
    const actions: unknown[] = load.stops.map((s: any) => ({ key: uuid(), type: 'OUTCOME', stop: s.key, at: ago(30), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [] }));
    actions.push({ key: uuid(), type: 'BACK_AT_DEPOT', load: load.loadNo, at: ago(10) });
    expect((await post(t02Token, actions)).results.every((r) => r.status === 'ok')).toBe(true);
    const row = await prisma.planLoad.findFirstOrThrow({ where: { runId, truckId: trucks.T02, loadNo: load.loadNo } });
    expect(row.status).toBe('COMPLETED');
    const a = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: t.tenantId, action: 'LOAD_COMPLETED', entityId: row.id } });
    expect(a.userId).toBeNull();
    expect(a.afterJson).toMatchObject({ actor: expect.stringMatching(/^Driver link: Khalid \(T02, back at depot\)$/) });
    expect(await prisma.auditLog.count({ where: { tenantId: t.tenantId, action: 'DRIVER_BACK_AT_DEPOT' } })).toBe(1);
  });

  it('after the dispatcher completes T01 L1: a backdated change of a stop that had a result is refused; a stop without one is filled in, late', async () => {
    expect((await patchLoad(t01LoadId, { status: 'COMPLETED' })).status).toBe(200);
    const changed = await post(token, [{ key: uuid(), type: 'OUTCOME', stop: stops[0]!.key, at: ago(3), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [] }]);
    expect(changed.results[0]).toMatchObject({ status: 'refused', code: 'LOAD_COMPLETED' });
    if (stops[1]) {
      const fill = await post(token, [{ key: uuid(), type: 'OUTCOME', stop: stops[1].key, at: ago(4), outcome: 'NOT_DELIVERED', reason: 'NO_ONE_TO_RECEIVE', photoKeys: [] }]);
      expect(fill.results[0]).toMatchObject({ status: 'ok' });
      const v = await prisma.stopVisit.findFirstOrThrow({ where: { tenantId: t.tenantId, truckId: trucks.T01, loadNo: t01LoadNo, sequence: Number(stops[1].key.split(':')[1]) } });
      expect(v).toMatchObject({ outcome: 'NOT_DELIVERED', outcomeLate: true });
    }
  });
});

// ---------------------------------------------------------------------------------------
// Part 3: the office side (Bring forward from results, E1 / E6 / E10, is covered on the real
// database in tests/integration/carry-over.spec.ts)
// ---------------------------------------------------------------------------------------

describe('Part 3: results on the plan, Record outcome, photos and the actuals Excel', () => {
  it('GET /api/runs/:id/outcomes shows the results of the loads that left; another company 404', async () => {
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/outcomes`);
    expect(r.status).toBe(200);
    const o = (await json(r)).data;
    const p = await plan();
    const t02 = p.loads.find((l: any) => l.truckId === trucks.T02 && l.status === 'COMPLETED');
    expect(t02).toBeTruthy();
    expect(o.loads[t02.id]).toMatchObject({ total: t02.stops.length, done: t02.stops.length, notDelivered: t02.stops.length });
    expect(o.stops[`${t02.id}:${t02.stops[0].sequence}`]).toMatchObject({ outcome: 'NOT_DELIVERED', reasonText: 'Shop closed', source: 'driver' });
    expect((await fetchWith(other.cookieJar, `${BASE}/api/runs/${runId}/outcomes`)).status).toBe(404);
  });

  it('Record outcome: the office corrects a stop of a completed load; audited as the user with before and after', async () => {
    const p = await plan();
    const t02 = p.loads.find((l: any) => l.truckId === trucks.T02 && l.status === 'COMPLETED');
    const seq = t02.stops[0].sequence;
    const body = { key: crypto.randomUUID(), depotId, date: isoPlus(0), truckId: trucks.T02, loadNo: t02.loadNo, sequence: seq, outcome: 'DELIVERED', arrivedAt: null, departedAt: null };
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/outcomes`, j(body));
    expect(r.status).toBe(200);
    expect((await json(r)).data).toMatchObject({ result: 'ok' });
    // A double click: recorded once.
    expect((await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/outcomes`, j(body)))).data).toMatchObject({ result: 'duplicate' });
    const v = await prisma.stopVisit.findFirstOrThrow({ where: { tenantId: t.tenantId, truckId: trucks.T02, loadNo: t02.loadNo, sequence: seq } });
    expect(v).toMatchObject({ outcome: 'DELIVERED', outcomeSource: 'DISPATCHER' });
    const a = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: t.tenantId, action: 'DELIVERY_OUTCOME_SET', entityId: v.id, userId: { not: null } } });
    expect(a.beforeJson).toMatchObject({ outcome: 'NOT_DELIVERED' });
    expect(a.afterJson).toMatchObject({ source: 'DISPATCHER', outcome: 'DELIVERED', correction: true });
    // Another company cannot record on it.
    expect((await fetchWith(other.cookieJar, `${BASE}/api/dispatch/outcomes`, j({ ...body, key: crypto.randomUUID() }))).status).toBe(404);
  });

  it('GET /api/delivery-photos/:id: the company photo for a signed-in user, 404 for another company', async () => {
    const photo = await prisma.deliveryPhoto.findFirstOrThrow({ where: { tenantId: t.tenantId } });
    const r = await fetchWith(t.cookieJar, `${BASE}/api/delivery-photos/${photo.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetchWith(other.cookieJar, `${BASE}/api/delivery-photos/${photo.id}`)).status).toBe(404);
  });

  it('the "Delivery actuals" Excel downloads for the day', async () => {
    const today = isoPlus(0);
    const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/delivery-actuals?from=${today}&to=${today}&depotId=${depotId}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/spreadsheetml/);
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect((await fetchWith(t.cookieJar, `${BASE}/api/dispatch/delivery-actuals?from=2026-01-01&to=2026-03-01`)).status).toBe(400);
  });
});
