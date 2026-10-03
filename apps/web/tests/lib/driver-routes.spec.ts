/**
 * The driver API through its route handlers (owner request 4 Oct 2026, spec sections 5, 8, 12, 13 and
 * 16) on the in-memory database (fake-plan-db.ts): the guard (header, unknown tokens per IP, replaced,
 * revoked, the upload grace, a signed-in browser), the actions (idempotency, refusals, downgrades, gap
 * filling after a trip closed, Back at depot) and the photos (limits, type, stripping, keys, serving).
 * Synthetic data only: truck T05, driver Salim, customers ACME and BETA.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({
  audit: vi.fn(async (input: Record<string, unknown>, tx?: typeof fakePrisma) => (tx ?? fakePrisma).auditLog.create({ data: { ...input } })),
}));
const { session, completeLoad } = vi.hoisted(() => ({
  session: { value: null as null | { user: { id: string; name: string; role: string; tenantId: string } } },
  completeLoad: vi.fn(async () => ({ completed: true })),
}));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => session.value) }));
// A real limiter (the test environment bypasses the shared one).
vi.mock('@/lib/rate-limit', async (orig) => {
  const m = await orig<typeof import('@/lib/rate-limit')>();
  return { ...m, limiter: new m.RateLimiter() };
});
vi.mock('@/lib/dispatch/plan-service', async (orig) => ({ ...(await orig<typeof import('@/lib/dispatch/plan-service')>()), completeLoadAsDriver: completeLoad }));

import { POST as actionsPOST } from '@/app/api/d/actions/route';
import { POST as photosPOST } from '@/app/api/d/photos/route';
import { GET as photoGET } from '@/app/api/d/photos/[photoId]/route';
import { GET as manifestGET } from '@/app/api/d/manifest/route';
import { deriveToken, driverLinkKey, linkExpiry, tokenHash } from '@/lib/driver-link/token';
import { dateOnly, todayIso } from '@/lib/dispatch/time';

const T = 'tA';
const TZ = 'Asia/Muscat';
const D = todayIso(TZ);
const ACME = { lat: 23.6, lng: 58.4 };
const BETA = { lat: 23.61, lng: 58.41 };
const SECRET = 'driver-routes-test-secret';
let prevSecret: string | undefined;

beforeAll(() => {
  prevSecret = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET = SECRET;
});
afterAll(() => {
  process.env.NEXTAUTH_SECRET = prevSecret;
});

const snapshot = (code: string, pin: { lat: number; lng: number }) => ({
  v: 1,
  customerId: `C-${code}`,
  code,
  branchCode: null,
  name: code,
  customerType: null,
  lat: pin.lat,
  lng: pin.lng,
  address: null,
  accessNotes: null,
  serviceMin: 20,
  priority: 3,
  hardStartMin: 0,
  hardEndMin: 1439,
  prefStartMin: null,
  prefEndMin: null,
  source: 'PLAN',
  capturedAt: new Date().toISOString(),
});

let linkSeq = 0;
/** A link row for a truck-day and its token (derived like the service does). */
function makeLink(truckId: string, over: Record<string, unknown> = {}): string {
  const key = driverLinkKey()!;
  const id = `dl${++linkSeq}`;
  const salt = `salt${linkSeq}`;
  const token = deriveToken(key.key, id, 1, salt);
  tables.driverLink.push({
    id,
    tenantId: T,
    truckId,
    deliveryDate: dateOnly(D),
    generation: 1,
    salt,
    keyId: key.keyId,
    tokenHash: tokenHash(token),
    prevTokenHash: null,
    expiresAt: linkExpiry(D, TZ),
    issuedAt: new Date(),
    revokedAt: null,
    driverIdAtIssue: 'salim',
    lastSeenAt: null,
    devicesJson: null,
    ...over,
  });
  return token;
}

function seed() {
  resetDb();
  completeLoad.mockClear();
  session.value = null;
  tables.tenant = [{ id: T, name: 'Synthetic Water Co', active: true }];
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: TZ, geofenceRadiusM: 100, photoProofRequired: true }];
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', lat: 23.55, lng: 58.35 }];
  tables.truck = [
    { id: 't5', tenantId: T, code: 'T05', hired: false },
    { id: 't6', tenantId: T, code: 'T06', hired: false },
  ];
  tables.driver = [{ id: 'salim', tenantId: T, code: 'D1', name: 'Salim', phone: null, casual: false, active: true }];
  tables.runPlan = [{ id: 'R1', tenantId: T, depotId: 'D1', runDate: dateOnly(D), status: 'DISPATCHED', version: 1, supersededAt: null, chosenScenarioId: 'sc', createdAt: new Date() }];
  tables.planLoad = [
    { id: 'L1', tenantId: T, runId: 'R1', truckId: 't5', loadNo: 1, status: 'DISPATCHED', departMin: 430, returnMin: 900, driverId: 'salim', statusChangedAt: new Date(Date.now() - 3 * 3600_000), breakJson: null, truckSnapshotJson: null },
    { id: 'L6', tenantId: T, runId: 'R1', truckId: 't6', loadNo: 1, status: 'DISPATCHED', departMin: 430, returnMin: 900, driverId: null, statusChangedAt: new Date(Date.now() - 3 * 3600_000), breakJson: null, truckSnapshotJson: null },
  ];
  const line = (id: string, cases: number, code: string) => ({ id, cases, weightKg: cases * 10, product: { code } });
  tables.order = [
    { id: 'O1', tenantId: T, customerId: 'C-ACME', carriedToOrderId: null, lines: [line('LA', 30, 'WATER-A'), line('LB', 10, 'WATER-B')] },
    { id: 'O2', tenantId: T, customerId: 'C-BETA', carriedToOrderId: null, lines: [line('LC', 20, 'WATER-A')] },
    { id: 'O6', tenantId: T, customerId: 'C-GAMMA', carriedToOrderId: null, lines: [line('LG', 5, 'WATER-A')] },
  ];
  const ra = (id: string, loadId: string, truckId: string, orderId: string, sequence: number, snap: unknown) => ({
    id,
    runId: 'R1',
    loadId,
    truckId,
    orderId,
    loadNo: 1,
    sequenceInTruck: sequence,
    orderInStop: 0,
    etaMin: 480 + sequence * 30,
    serviceStartMin: 480 + sequence * 30,
    departureMin: 500 + sequence * 30,
    portionLinesJson: null,
    stopSnapshotJson: snap,
  });
  tables.routeAssignment = [ra('A1', 'L1', 't5', 'O1', 1, snapshot('ACME', ACME)), ra('A2', 'L1', 't5', 'O2', 2, snapshot('BETA', BETA)), ra('A6', 'L6', 't6', 'O6', 1, snapshot('GAMMA', ACME))];
  tables.driverLink = [];
  tables.stopVisit = [];
  tables.stopEvent = [];
  tables.deliveryPhoto = [];
  tables.auditLog = [];
}
beforeEach(seed);

function req(path: string, o: { method?: string; token?: string | null; body?: string; ip?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...(o.token ? { authorization: `DriverLink ${o.token}` } : {}), ...(o.ip ? { 'x-forwarded-for': o.ip } : {}), ...(o.headers ?? {}) };
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://routeiq.test${path}`, { method: o.method ?? 'GET', headers, body: o.body });
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function act(token: string, actions: unknown[], o: { ip?: string } = {}) {
  const res = await actionsPOST(req('/api/d/actions', { method: 'POST', token, ip: o.ip, body: JSON.stringify({ clientNow: new Date().toISOString(), actions }) }));
  const body = (await res.json()) as { data: { results: { key: string; status: string; code?: string; transient?: boolean }[]; stops: Record<string, { outcome: string | null; editable: boolean }> } | null; error: unknown };
  return { status: res.status, body, res };
}

const arrive = (stop: string, over: Record<string, unknown> = {}) => ({
  key: randomUUID(),
  type: 'ARRIVE',
  stop,
  at: iso(20 * 60_000),
  mode: 'AUTO',
  pos: { lat: ACME.lat + 0.0002, lng: ACME.lng, accuracyM: 8, at: iso(20 * 60_000) },
  ...over,
});
const outcome = (stop: string, over: Record<string, unknown> = {}) => ({ key: randomUUID(), type: 'OUTCOME', stop, at: iso(5 * 60_000), outcome: 'DELIVERED', photoKeys: [randomUUID()], ...over });

// ---------------------------------------------------------------------------------------
// A minimal JPEG (structure only) with an EXIF block, to check the stored copy is stripped.
// ---------------------------------------------------------------------------------------
const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
function jpeg(extra: number[] = [], scan: number[] = [1, 2, 3, 4]): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...ascii('Exif'), 0, 0, ...ascii('II'), 42, 0, 8, 0, 0, 0, 0, 0, ...ascii('SECRET-GPS')]),
    ...extra,
    ...seg(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    ...seg(0xc0, [8, 0, 120, 0, 160, 1, 1, 0x11, 0]),
    ...seg(0xc4, [0, 1, ...Array.from({ length: 15 }, () => 0), 0]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    ...scan,
    0xff,
    0xd9,
  ]);
}

async function photoReq(token: string, meta: Record<string, unknown>, bytes: Uint8Array, o: { noLength?: boolean; length?: number } = {}): Promise<Request> {
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), 'p.jpg');
  const r = new Response(form);
  const body = new Uint8Array(await r.arrayBuffer());
  const headers: Record<string, string> = { authorization: `DriverLink ${token}`, 'content-type': r.headers.get('content-type')! };
  if (!o.noLength) headers['content-length'] = String(o.length ?? body.length);
  return new Request('https://routeiq.test/api/d/photos', { method: 'POST', headers, body });
}
const photoMeta = (stop: string, key = randomUUID()) => ({
  key,
  stop,
  takenAt: iso(10 * 60_000),
  clientNow: new Date().toISOString(),
  positionStatus: 'OK',
  pos: { lat: ACME.lat + 0.0003, lng: ACME.lng, accuracyM: 12, at: iso(10 * 60_000) },
});
async function sendPhoto(token: string, meta: Record<string, unknown>, bytes = jpeg()) {
  const res = await photosPOST(await photoReq(token, meta, bytes));
  return { status: res.status, body: (await res.json()) as { data: { photoId: string | null; status: string; code?: string } | null; error: { code?: string } | null } };
}

describe('the guard (spec section 5)', () => {
  it('no header or a wrong shape answers 404 without any database work', async () => {
    const spy = vi.spyOn(fakePrisma.driverLink, 'findFirst');
    for (const token of [null, 'short', 'x'.repeat(25), 'bad token with spaces!!!']) {
      const res = await actionsPOST(req('/api/d/actions', { method: 'POST', token, body: '{}' }));
      expect(res.status).toBe(404);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('unknown tokens count per public IP (30 / 10 min); never for an internal or unknown IP; a known token is never blocked by its IP', async () => {
    const known = makeLink('t5');
    const unknown = () => 'U'.repeat(23) + String.fromCharCode(65 + Math.floor(Math.random() * 26));
    for (let i = 0; i < 30; i++) expect((await act(unknown(), [], { ip: '203.0.113.9' })).status).toBe(404);
    const blocked = await act(unknown(), [], { ip: '203.0.113.9' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await act(known, [], { ip: '203.0.113.9' })).status).toBe(200);
    for (let i = 0; i < 40; i++) expect((await act(unknown(), [], { ip: '10.0.0.9' })).status).toBe(404);
    for (let i = 0; i < 40; i++) expect((await act(unknown(), [])).status).toBe(404);
  });

  it('the token before a reissue answers 410 LINK_REPLACED and is never counted; a revoked link 410 LINK_REVOKED', async () => {
    const old = 'O'.repeat(24);
    makeLink('t5', { prevTokenHash: tokenHash(old) });
    for (let i = 0; i < 35; i++) {
      const r = await act(old, [], { ip: '198.51.100.4' });
      expect(r.status).toBe(410);
      expect(r.body.error).toMatchObject({ code: 'LINK_REPLACED' });
    }
    expect((await act('Z'.repeat(24), [], { ip: '198.51.100.4' })).status).toBe(404);
    const revoked = makeLink('t6', { revokedAt: new Date() });
    expect((await act(revoked, [])).body.error).toMatchObject({ code: 'LINK_REVOKED' });
  });

  it('upload grace: reading answers 410 with uploadOnly; results dated before the expiry are accepted and flagged late; later ones are refused', async () => {
    const expiresAt = new Date(Date.now() - 60 * 60_000);
    const token = makeLink('t5', { expiresAt });
    const m = await manifestGET(req('/api/d/manifest', { token }));
    expect(m.status).toBe(410);
    expect((await m.json()).error).toMatchObject({ code: 'LINK_EXPIRED', uploadOnly: true });
    const before = outcome('1:1', { at: new Date(expiresAt.getTime() - 10 * 60_000).toISOString(), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [] });
    const after = outcome('1:2', { at: iso(60_000), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [] });
    const r = await act(token, [before, after]);
    expect(r.body.data!.results).toEqual([
      { key: before.key, status: 'ok' },
      expect.objectContaining({ key: after.key, status: 'refused', code: 'TIME_OUT_OF_RANGE' }),
    ]);
    expect(tables.stopEvent.find((e) => e.idempotencyKey === `dl:${before.key}`)!.payloadJson).toMatchObject({ late: true });
    expect(tables.stopVisit.find((v) => v.sequence === 1)).toMatchObject({ outcome: 'NOT_DELIVERED', outcomeLate: true });
  });

  it('a signed-in browser is the office: a planner records as DISPATCHER with the user id; a viewer is refused 403; another company 403', async () => {
    const token = makeLink('t5');
    session.value = { user: { id: 'u-viewer', name: 'Vera', role: 'VIEWER', tenantId: T } };
    expect((await act(token, [outcome('1:1')])).body.error).toMatchObject({ code: 'SIGNED_IN_READ_ONLY' });
    session.value = { user: { id: 'u-x', name: 'Xavi', role: 'PLANNER', tenantId: 'other' } };
    expect((await act(token, [outcome('1:1')])).body.error).toMatchObject({ code: 'SIGNED_IN_OTHER_TENANT' });
    session.value = { user: { id: 'u-ali', name: 'Ali', role: 'PLANNER', tenantId: T } };
    const r = await act(token, [outcome('1:1', { photoKeys: [] })]);
    expect(r.body.data!.results[0]).toMatchObject({ status: 'ok' });
    expect(tables.stopEvent.find((e) => e.kind === 'OUTCOME')).toMatchObject({ source: 'DISPATCHER', userId: 'u-ali' });
    const a = tables.auditLog.find((x) => x.action === 'DELIVERY_OUTCOME_SET');
    expect(a).toMatchObject({ userId: 'u-ali', afterJson: expect.objectContaining({ via: 'driver page' }) });
    // The office looking at the page is not "used on N phones".
    expect(row('driverLink', tables.driverLink[0].id).lastSeenAt).toBeNull();
  });
});

describe('POST /api/d/actions (spec section 8)', () => {
  it('an automatic arrival at the pin and a result with a photo key; the same batch again answers duplicate and stores nothing more', async () => {
    const token = makeLink('t5');
    const batch = [arrive('1:1'), outcome('1:1')];
    const first = await act(token, batch);
    expect(first.status).toBe(200);
    expect(first.body.data!.results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(tables.stopEvent.map((e) => e.idempotencyKey).sort()).toEqual(batch.map((a) => `dl:${a.key}`).sort());
    const v = tables.stopVisit[0];
    expect(v).toMatchObject({ sequence: 1, arrivalSource: 'PHONE_AUTO', outcome: 'DELIVERED', casesDelivered: 40, casesPlanned: 40, autoBasis: 'RESULT' });
    expect(first.body.data!.stops['1:1']).toMatchObject({ outcome: 'DELIVERED', editable: true });
    const again = await act(token, batch);
    expect(again.body.data!.results.map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(tables.stopEvent).toHaveLength(2);
    const a = tables.auditLog.filter((x) => x.action === 'DELIVERY_OUTCOME_SET');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ userId: null, afterJson: expect.objectContaining({ actor: expect.stringMatching(/^Driver link: Salim \(T05, .*\) · link #1$/) }) });
    // Automatic arrivals are not audited (the stop events are their record).
    expect(tables.auditLog.some((x) => x.action === 'STOP_ARRIVAL_MANUAL')).toBe(false);
  });

  it('refuses a key that is not a lowercase UUID (ayun:1000 too), another link\'s key, another truck-day\'s stop, a result without its photo, a time outside the day', async () => {
    const token = makeLink('t5');
    const other = makeLink('t6');
    const shared = randomUUID();
    expect((await act(other, [arrive('1:1', { key: shared })])).body.data!.results[0]).toMatchObject({ status: 'ok' });
    const r = await act(token, [
      arrive('1:1', { key: 'ayun:1000' }),
      arrive('1:1', { key: shared.toUpperCase() }),
      arrive('1:1', { key: shared }),
      arrive('9:1'),
      outcome('1:2', { photoKeys: [] }),
      outcome('1:2', { at: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
    ]);
    expect(r.body.data!.results.map((x) => x.code)).toEqual(['INVALID', 'INVALID', 'INVALID', 'STOP_NOT_FOUND', 'PHOTO_REQUIRED', 'TIME_OUT_OF_RANGE']);
    // Nothing about the other link's event is echoed, and nothing was stored for this link.
    expect(JSON.stringify(r.body.data!.results[2])).not.toContain('t6');
    expect(tables.stopEvent.filter((e) => e.driverLinkId === tables.driverLink[0].id)).toEqual([]);
    // "Camera not working" saves without a photo.
    const cam = await act(token, [outcome('1:2', { photoKeys: [], noPhotoReason: 'CAMERA_FAILED' })]);
    expect(cam.body.data!.results[0]).toMatchObject({ status: 'ok' });
    expect(tables.stopVisit.find((v) => v.sequence === 2)).toMatchObject({ noPhotoReason: 'CAMERA_FAILED' });
  });

  it('an automatic arrival 2 km from the pin is stored as a manual one (downgraded); a manual arrival is audited', async () => {
    const token = makeLink('t5');
    const far = arrive('1:1', { pos: { lat: ACME.lat + 0.018, lng: ACME.lng, accuracyM: 10, at: iso(20 * 60_000) } });
    await act(token, [far, arrive('1:2', { mode: 'MANUAL', pos: undefined })]);
    expect(tables.stopEvent.find((e) => e.idempotencyKey === `dl:${far.key}`)).toMatchObject({ source: 'PHONE_MANUAL', payloadJson: expect.objectContaining({ downgraded: true }) });
    expect(tables.auditLog.filter((x) => x.action === 'STOP_ARRIVAL_MANUAL')).toHaveLength(1);
  });

  it('a LOADING load: arrivals are kept on the phone (transient LOAD_NOT_DISPATCHED); results are refused', async () => {
    row('planLoad', 'L1').status = 'LOADING';
    const token = makeLink('t5');
    const r = await act(token, [arrive('1:1'), outcome('1:1')]);
    expect(r.body.data!.results).toEqual([
      expect.objectContaining({ status: 'refused', code: 'LOAD_NOT_DISPATCHED', transient: true }),
      expect.objectContaining({ status: 'refused', code: 'LOAD_NOT_DISPATCHED' }),
    ]);
    expect(r.body.data!.results[1]!.transient).toBeUndefined();
    expect(tables.stopVisit).toEqual([]);
    row('planLoad', 'L1').status = 'DISPATCHED';
    expect((await act(token, [arrive('1:1')])).body.data!.results[0]).toMatchObject({ status: 'ok' });
  });

  it('E10: after the trip closed, a backdated change of a stop that had a result is refused; a stop without one is filled in, late', async () => {
    const token = makeLink('t5');
    await act(token, [outcome('1:1', { at: iso(90 * 60_000) })]);
    // Completed after stop 1's result was received; stop 2 had none.
    Object.assign(row('planLoad', 'L1'), { status: 'COMPLETED', statusChangedAt: new Date(Date.now() - 1) });
    const r = await act(token, [
      outcome('1:1', { at: iso(40 * 60_000), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [] }),
      outcome('1:2', { at: iso(45 * 60_000), outcome: 'NOT_DELIVERED', reason: 'NO_ONE_TO_RECEIVE', photoKeys: [] }),
      arrive('1:2', { at: new Date(Date.now() + 1000).toISOString() }), // dated after the completion
    ]);
    expect(r.body.data!.results.map((x) => x.code ?? x.status)).toEqual(['LOAD_COMPLETED', 'ok', 'LOAD_COMPLETED']);
    expect(tables.stopVisit.find((v) => v.sequence === 1)).toMatchObject({ outcome: 'DELIVERED' });
    expect(tables.stopVisit.find((v) => v.sequence === 2)).toMatchObject({ outcome: 'NOT_DELIVERED', outcomeLate: true });
    expect(r.body.data!.stops['1:2']).toMatchObject({ editable: false });
  });

  it('Back at depot, then the last result: the load is completed by the driver link', async () => {
    const token = makeLink('t5');
    await act(token, [outcome('1:1'), { key: randomUUID(), type: 'BACK_AT_DEPOT', load: 1, at: iso(60_000), pos: { lat: 23.55, lng: 58.35, accuracyM: 15, at: iso(60_000) } }]);
    expect(tables.stopEvent.find((e) => e.kind === 'BACK_AT_DEPOT')).toMatchObject({ sequence: null, visitId: null, distanceM: 0 });
    expect(tables.auditLog.some((a) => a.action === 'DRIVER_BACK_AT_DEPOT' && a.entityId === 'L1')).toBe(true);
    completeLoad.mockClear();
    await act(token, [outcome('1:2', { outcome: 'NOT_DELIVERED', reason: 'CUSTOMER_REFUSED', photoKeys: [] })]);
    expect(completeLoad).toHaveBeenCalledWith(T, { runId: 'R1', loadId: 'L1', depotId: 'D1', date: D }, { label: 'Driver link: Salim (T05, back at depot)' });
  });

  it('a body that cannot be read answers 400; more than 50 actions 400', async () => {
    const token = makeLink('t5');
    expect((await actionsPOST(req('/api/d/actions', { method: 'POST', token, body: 'not json' }))).status).toBe(400);
    const many = Array.from({ length: 51 }, () => arrive('1:1'));
    expect((await act(token, many)).status).toBe(400);
  });
});

describe('POST /api/d/photos and GET /api/d/photos/<id> (spec section 12)', () => {
  it('411 without Content-Length, 413 over 1.6 MB, 415 for a file that is not a JPEG', async () => {
    const token = makeLink('t5');
    expect((await photosPOST(await photoReq(token, photoMeta('1:1'), jpeg(), { noLength: true }))).status).toBe(411);
    expect((await photosPOST(await photoReq(token, photoMeta('1:1'), jpeg(), { length: 1_700_000 }))).status).toBe(413);
    const html = Uint8Array.from(ascii('<!doctype html><script>alert(1)</script>'));
    const r = await photosPOST(await photoReq(token, photoMeta('1:1'), html));
    expect(r.status).toBe(415);
    expect(tables.deliveryPhoto).toEqual([]);
  });

  it('stores the photo stripped of its metadata; the same key and bytes answer duplicate; other bytes 409 KEY_REUSED; a photo key equal to an action key is a different key', async () => {
    const token = makeLink('t5');
    const key = randomUUID();
    const ok = await sendPhoto(token, photoMeta('1:1', key));
    expect(ok.body.data).toMatchObject({ status: 'ok' });
    const p = tables.deliveryPhoto[0];
    expect(p).toMatchObject({ idempotencyKey: `dlphoto:${key}`, positionStatus: 'OK', width: 160, height: 120 });
    expect(String.fromCharCode(...new Uint8Array(p.bytes))).not.toContain('SECRET-GPS');
    expect(p.distanceM).toBeLessThan(100);
    expect(tables.stopEvent.find((e) => e.kind === 'PHOTO')).toMatchObject({ idempotencyKey: `dlphoto:${key}` });
    expect(tables.stopVisit[0]).toMatchObject({ photoCount: 1 });
    expect((await sendPhoto(token, photoMeta('1:1', key))).body.data).toMatchObject({ status: 'duplicate', photoId: p.id });
    const reused = await sendPhoto(token, photoMeta('1:1', key), jpeg([], [9, 9, 9]));
    expect(reused.status).toBe(409);
    expect(reused.body.error).toMatchObject({ code: 'KEY_REUSED' });
    // The same UUID as an action key: both are stored (dl: and dlphoto: never collide).
    expect((await act(token, [arrive('1:1', { key })])).body.data!.results[0]).toMatchObject({ status: 'ok' });
  });

  it('at most 3 driver photos per stop, and 3 x the truck-day\'s stops + 10 per link', async () => {
    const token = makeLink('t5');
    for (let i = 0; i < 3; i++) expect((await sendPhoto(token, photoMeta('1:1'), jpeg([], [i + 1]))).body.data).toMatchObject({ status: 'ok' });
    const fourth = await sendPhoto(token, photoMeta('1:1'), jpeg([], [7]));
    expect(fourth.status).toBe(409);
    expect(fourth.body.error).toMatchObject({ code: 'PHOTO_LIMIT' });
    const linkId = tables.driverLink[0].id;
    for (let i = 0; i < 13; i++) tables.deliveryPhoto.push({ id: `old${i}`, tenantId: T, visitId: 'elsewhere', driverLinkId: linkId, source: 'PHONE_MANUAL', takenAt: new Date() });
    const daily = await sendPhoto(token, photoMeta('1:2'), jpeg([], [8]));
    expect(daily.status).toBe(409);
    expect(daily.body.error).toMatchObject({ code: 'PHOTO_LIMIT', daily: true });
  });

  it('serves a photo of this truck-day only, as an inline JPEG with nosniff and a sandbox CSP; a purged one is 404 PHOTO_PURGED', async () => {
    const token = makeLink('t5');
    const other = makeLink('t6');
    const sent = await sendPhoto(token, photoMeta('1:1'));
    const id = sent.body.data!.photoId!;
    const res = await photoGET(req(`/api/d/photos/${id}`, { token }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="T05-L1-stop1-1.jpg"');
    expect((await photoGET(req(`/api/d/photos/${id}`, { token: other }))).status).toBe(404);
    Object.assign(tables.deliveryPhoto[0], { bytes: null, purgedAt: new Date() });
    const purged = await photoGET(req(`/api/d/photos/${id}`, { token }));
    expect(purged.status).toBe(404);
    expect((await purged.json()).error).toMatchObject({ code: 'PHOTO_PURGED' });
  });
});
