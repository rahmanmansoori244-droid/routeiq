/**
 * A truck loading at two depots on one date (fix of 7 Oct 2026). One driver link covers every load of
 * the truck that day, and each depot's plan can give it a Load 1. The driver protocol named a stop by
 * "load number : stop" only, so both depots' first stop had the key `1:1`: a Delivered entered for the
 * second depot's 12-case customer was recorded as 40 cases delivered to the first depot's customer.
 * Keys now carry the depot (`<depotId>:<loadNo>:<sequence>`, lib/driver-link/stop-key.ts).
 *
 * Through the route handlers on the in-memory database (fake-plan-db.ts), as driver-routes.spec.ts:
 * results, arrivals, Back at depot and the load's completion, photos (upload and serving), the answers'
 * results; keys of the old form still queued on phones are accepted when one stop fits them and
 * refused (STOP_AMBIGUOUS, nothing stored) when two do. Pure: the key module, the resolver's safety
 * rule, the manifest projection and the phone's offline queue and overlay with the new keys.
 * Synthetic data only: truck T05, driver Salim, customers ACME, BETA (North depot) and DELTA (South depot).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';
import { fixture } from './plan-detail-fixture';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>, tx?: typeof m.fakePrisma) => (tx ?? m.fakePrisma).auditLog.create({ data: { ...input } })) };
});
const { completeLoad } = vi.hoisted(() => ({ completeLoad: vi.fn(async () => ({ completed: true })) }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/rate-limit', async (orig) => {
  const m = await orig<typeof import('@/lib/rate-limit')>();
  return { ...m, limiter: new m.RateLimiter() };
});
vi.mock('@/lib/dispatch/plan-service', async (orig) => ({ ...(await orig<typeof import('@/lib/dispatch/plan-service')>()), completeLoadAsDriver: completeLoad }));

import { POST as actionsPOST } from '@/app/api/d/actions/route';
import { POST as photosPOST } from '@/app/api/d/photos/route';
import { GET as photoGET } from '@/app/api/d/photos/[photoId]/route';
import { resolveTarget } from '@/lib/delivery/event-service';
import { mergeResults, projectManifest, type ManifestInput } from '@/lib/driver-link/manifest';
import { isLegacyStopKey, loadKeyOf, loadKeyOfStop, parseLoadKey, parseStopKey, stopKeyOf } from '@/lib/driver-link/stop-key';
import type { TruckDayLoad } from '@/lib/driver-link/service';
import type { DriverAction, ManifestStop } from '@/lib/driver-link/manifest-types';
import { deriveToken, driverLinkKey, linkExpiry, tokenHash } from '@/lib/driver-link/token';
import { dateOnly, todayIso } from '@/lib/dispatch/time';
import { applyQueued, keyedManifest, manifestStopKey, unsentList } from '@/lib/driver-page/overlay';
import { actionItem, itemLoadKey, releaseHeld, type QueueItem } from '@/lib/driver-page/queue';
import { memoryStore } from '@/lib/driver-page/store';

const T = 'tA';
const TZ = 'Asia/Muscat';
const D = todayIso(TZ);
const ACME = { lat: 23.6, lng: 58.4 };
const BETA = { lat: 23.61, lng: 58.41 };
const DELTA = { lat: 23.4, lng: 58.6 };
const SECRET = 'driver-two-depots-test-secret';
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

function makeLink(truckId: string): string {
  const key = driverLinkKey()!;
  const token = deriveToken(key.key, 'dl1', 1, 'salt1');
  tables.driverLink.push({
    id: 'dl1',
    tenantId: T,
    truckId,
    deliveryDate: dateOnly(D),
    generation: 1,
    salt: 'salt1',
    keyId: key.keyId,
    tokenHash: tokenHash(token),
    prevTokenHash: null,
    expiresAt: linkExpiry(D, TZ),
    issuedAt: new Date(),
    revokedAt: null,
    driverIdAtIssue: 'salim',
    lastSeenAt: null,
    devicesJson: null,
  });
  return token;
}

/**
 * T05 today: North depot (N) Load 1 = ACME (40 cases: 30 + 10) then BETA (20); South depot (S) Load 1
 * = DELTA (12 cases), after it. `twoDepots` false: the South plan is not there (one Load 1 that day).
 */
function seed(twoDepots = true) {
  resetDb();
  completeLoad.mockClear();
  tables.tenant = [{ id: T, name: 'Synthetic Water Co', active: true }];
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: TZ, geofenceRadiusM: 100, photoProofRequired: true }];
  tables.depot = [
    { id: 'N', tenantId: T, code: 'NORTH', name: 'North depot', lat: 23.55, lng: 58.35 },
    { id: 'S', tenantId: T, code: 'SOUTH', name: 'South depot', lat: 23.35, lng: 58.55 },
  ];
  tables.truck = [{ id: 't5', tenantId: T, code: 'T05', hired: false }];
  tables.driver = [{ id: 'salim', tenantId: T, code: 'D1', name: 'Salim', phone: null, casual: false, active: true }];
  const run = (id: string, depotId: string) => ({ id, tenantId: T, depotId, runDate: dateOnly(D), status: 'DISPATCHED', version: 1, supersededAt: null, chosenScenarioId: 'sc', createdAt: new Date() });
  tables.runPlan = [run('RN', 'N'), ...(twoDepots ? [run('RS', 'S')] : [])];
  const load = (id: string, runId: string, departMin: number) => ({
    id,
    tenantId: T,
    runId,
    truckId: 't5',
    loadNo: 1,
    status: 'DISPATCHED',
    departMin,
    returnMin: departMin + 180,
    driverId: 'salim',
    statusChangedAt: new Date(Date.now() - 3 * 3600_000),
    breakJson: null,
    truckSnapshotJson: null,
  });
  tables.planLoad = [load('LN', 'RN', 430), ...(twoDepots ? [load('LS', 'RS', 700)] : [])];
  const line = (id: string, cases: number) => ({ id, cases, weightKg: cases * 10, product: { code: 'WATER' } });
  tables.order = [
    { id: 'O1', tenantId: T, customerId: 'C-ACME', carriedToOrderId: null, lines: [line('LA', 30), line('LB', 10)] },
    { id: 'O2', tenantId: T, customerId: 'C-BETA', carriedToOrderId: null, lines: [line('LC', 20)] },
    { id: 'O7', tenantId: T, customerId: 'C-DELTA', carriedToOrderId: null, lines: [line('LD', 12)] },
  ];
  const ra = (id: string, runId: string, loadId: string, orderId: string, sequence: number, snap: unknown) => ({
    id,
    runId,
    loadId,
    truckId: 't5',
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
  tables.routeAssignment = [
    ra('A1', 'RN', 'LN', 'O1', 1, snapshot('ACME', ACME)),
    ra('A2', 'RN', 'LN', 'O2', 2, snapshot('BETA', BETA)),
    ...(twoDepots ? [ra('A7', 'RS', 'LS', 'O7', 1, snapshot('DELTA', DELTA))] : []),
  ];
  tables.driverLink = [];
  tables.stopVisit = [];
  tables.stopEvent = [];
  tables.deliveryPhoto = [];
  tables.auditLog = [];
}
beforeEach(() => seed());

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function act(token: string, actions: unknown[]) {
  const res = await actionsPOST(
    new Request('https://routeiq.test/api/d/actions', {
      method: 'POST',
      headers: { authorization: `DriverLink ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientNow: new Date().toISOString(), actions }),
    }),
  );
  const body = (await res.json()) as {
    data: { results: { key: string; status: string; code?: string; message?: { en: string; ar: string } }[]; stops: Record<string, { outcome: string | null; casesDelivered: number | null }>; back: Record<string, string> } | null;
  };
  return { status: res.status, data: body.data! };
}

const delivered = (stop: string, over: Record<string, unknown> = {}) => ({ key: randomUUID(), type: 'OUTCOME', stop, at: iso(5 * 60_000), outcome: 'DELIVERED', photoKeys: [randomUUID()], ...over });
const notDelivered = (stop: string) => ({ key: randomUUID(), type: 'OUTCOME', stop, at: iso(5 * 60_000), outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', photoKeys: [] });
const back = (over: Record<string, unknown> = {}) => ({ key: randomUUID(), type: 'BACK_AT_DEPOT', load: 1, at: iso(60_000), ...over });

/** A minimal JPEG (structure only). */
const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
function jpeg(): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
    ...seg(0xc0, [8, 0, 120, 0, 160, 1, 1, 0x11, 0]),
    ...seg(0xc4, [0, 1, ...Array.from({ length: 15 }, () => 0), 0]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    1,
    2,
    3,
    0xff,
    0xd9,
  ]);
}
async function sendPhoto(token: string, stop: string) {
  const form = new FormData();
  form.append('meta', JSON.stringify({ key: randomUUID(), stop, takenAt: iso(10 * 60_000), clientNow: new Date().toISOString(), positionStatus: 'OK', pos: { lat: DELTA.lat, lng: DELTA.lng, accuracyM: 12, at: iso(10 * 60_000) } }));
  form.append('file', new Blob([jpeg() as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), 'p.jpg');
  const r = new Response(form);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const res = await photosPOST(
    new Request('https://routeiq.test/api/d/photos', {
      method: 'POST',
      headers: { authorization: `DriverLink ${token}`, 'content-type': r.headers.get('content-type')!, 'content-length': String(bytes.length) },
      body: bytes,
    }),
  );
  return (await res.json()) as { data: { photoId: string | null; status: string; code?: string; message?: { en: string } } };
}

describe('the stop key (lib/driver-link/stop-key.ts)', () => {
  it('a stop and a load carry the depot; the old form reads with no depot', () => {
    expect(stopKeyOf('cm1abc', 1, 3)).toBe('cm1abc:1:3');
    expect(loadKeyOf('cm1abc', 2)).toBe('cm1abc:2');
    expect(parseStopKey('cm1abc:1:3')).toEqual({ depotId: 'cm1abc', loadNo: 1, sequence: 3 });
    expect(parseStopKey('1:3')).toEqual({ depotId: null, loadNo: 1, sequence: 3 });
    expect(isLegacyStopKey('1:3')).toBe(true);
    expect(isLegacyStopKey('N:1:3')).toBe(false);
    expect(loadKeyOfStop('N:1:3')).toBe('N:1');
    expect(loadKeyOfStop('1:3')).toBe('1');
    expect(parseLoadKey('N:2')).toEqual({ depotId: 'N', loadNo: 2 });
    for (const bad of ['', '1', 'a:b:c', 'N:1:3:4', 'N:x:3', 'bad depot:1:2', '1:12345']) expect(parseStopKey(bad)).toBeNull();
  });
});

describe('two depots give T05 a Load 1 on the same date (through the route handlers)', () => {
  it('the bug: Delivered for the second depot\'s 12-case customer is recorded against that customer, 12 cases, never 40 cases at the first depot', async () => {
    const token = makeLink('t5');
    const r = await act(token, [delivered('S:1:1')]);
    expect(r.data.results).toEqual([expect.objectContaining({ status: 'ok' })]);
    expect(tables.stopVisit).toHaveLength(1);
    expect(tables.stopVisit[0]).toMatchObject({ depotId: 'S', loadNo: 1, sequence: 1, customerId: 'C-DELTA', outcome: 'DELIVERED', casesPlanned: 12, casesDelivered: 12, firstLoadId: 'LS' });
    expect(tables.stopEvent[0]).toMatchObject({ depotId: 'S', loadNo: 1, sequence: 1, kind: 'OUTCOME' });
    // The answer's results: each depot's Load 1 apart; the first depot's ACME has no result.
    expect(r.data.stops['S:1:1']).toMatchObject({ outcome: 'DELIVERED', casesDelivered: 12 });
    expect(r.data.stops['N:1:1']).toBeUndefined();
    expect(r.data.stops['1:1']).toBeUndefined();
    const a = tables.auditLog.find((x) => x.action === 'DELIVERY_OUTCOME_SET');
    expect(a!.afterJson).toMatchObject({ depotId: 'S', loadNo: 1, sequence: 1, customerCode: 'DELTA', casesDelivered: 12 });
    // And the first depot's stop on its own key.
    const n = await act(token, [notDelivered('N:1:1')]);
    expect(n.data.results[0]).toMatchObject({ status: 'ok' });
    expect(tables.stopVisit.find((v) => v.depotId === 'N')).toMatchObject({ customerId: 'C-ACME', outcome: 'NOT_DELIVERED', casesPlanned: 40, casesDelivered: 0 });
    expect(tables.stopVisit.find((v) => v.depotId === 'S')).toMatchObject({ outcome: 'DELIVERED', casesDelivered: 12 });
  });

  it('an old key that fits two stops (1:1 is Load 1 stop 1 at both depots) is refused with a clear message; nothing is stored', async () => {
    const token = makeLink('t5');
    const old = delivered('1:1');
    const r = await act(token, [old]);
    expect(r.data.results).toEqual([{ key: old.key, status: 'refused', code: 'STOP_AMBIGUOUS', message: expect.objectContaining({ en: expect.stringMatching(/^Not recorded: .* two trips with the same number .* Call your dispatcher/) }) }]);
    expect(tables.stopEvent).toEqual([]);
    expect(tables.stopVisit).toEqual([]);
    expect(tables.auditLog.filter((x) => x.action === 'DELIVERY_OUTCOME_SET')).toEqual([]);
    // An arrival on that old key too.
    const arr = { key: randomUUID(), type: 'ARRIVE', stop: '1:1', at: iso(20 * 60_000), mode: 'MANUAL' };
    expect((await act(token, [arr])).data.results[0]).toMatchObject({ status: 'refused', code: 'STOP_AMBIGUOUS' });
    expect(tables.stopEvent).toEqual([]);
  });

  it('an old key that fits one stop only (1:2: only the North Load 1 has a stop 2) is accepted, against that stop', async () => {
    const token = makeLink('t5');
    const r = await act(token, [notDelivered('1:2')]);
    expect(r.data.results[0]).toMatchObject({ status: 'ok' });
    expect(tables.stopVisit).toEqual([expect.objectContaining({ depotId: 'N', sequence: 2, customerId: 'C-BETA', outcome: 'NOT_DELIVERED' })]);
    expect(r.data.stops['N:1:2']).toMatchObject({ outcome: 'NOT_DELIVERED' });
  });

  it('a chained arrival from the other depot\'s stop is not chained (another load)', async () => {
    const token = makeLink('t5');
    const a = { key: randomUUID(), type: 'ARRIVE', stop: 'S:1:1', at: iso(20 * 60_000), mode: 'AUTO', chained: true, from: 'N:1:1', pos: { lat: DELTA.lat, lng: DELTA.lng, accuracyM: 8, at: iso(20 * 60_000) } };
    expect((await act(token, [a])).data.results[0]).toMatchObject({ status: 'ok' });
    expect(tables.stopEvent[0]).toMatchObject({ depotId: 'S', kind: 'ARRIVED' });
    expect(tables.stopEvent[0].payloadJson).not.toHaveProperty('chained');
  });

  it('Back at depot names its depot: the old form (load 1 only) is refused; the South load is back and completes with its last result, never the North one', async () => {
    const token = makeLink('t5');
    const old = back();
    expect((await act(token, [old])).data.results[0]).toMatchObject({ key: old.key, status: 'refused', code: 'STOP_AMBIGUOUS' });
    expect(tables.stopEvent).toEqual([]);
    const r = await act(token, [back({ depot: 'S' })]);
    expect(r.data.results[0]).toMatchObject({ status: 'ok' });
    expect(tables.stopEvent[0]).toMatchObject({ kind: 'BACK_AT_DEPOT', depotId: 'S', loadNo: 1 });
    expect(r.data.back).toEqual({ 'S:1': expect.any(String) });
    expect(tables.auditLog.find((x) => x.action === 'DRIVER_BACK_AT_DEPOT')).toMatchObject({ entityId: 'LS', afterJson: expect.objectContaining({ depotId: 'S' }) });
    completeLoad.mockClear();
    await act(token, [delivered('S:1:1')]);
    expect(completeLoad).toHaveBeenCalledTimes(1);
    expect(completeLoad).toHaveBeenCalledWith(T, { runId: 'RS', loadId: 'LS', depotId: 'S', date: D }, { userId: null, label: 'Driver link: Salim (T05, back at depot)' });
    // The North Load 1 is not back: results there complete nothing.
    completeLoad.mockClear();
    await act(token, [delivered('N:1:1'), delivered('N:1:2')]);
    expect(completeLoad).not.toHaveBeenCalled();
  });

  it('photos: stored on the visit of the stop the key names; an old key that fits two stops is refused and nothing is stored; the photo is served to the link', async () => {
    const token = makeLink('t5');
    const ok = await sendPhoto(token, 'S:1:1');
    expect(ok.data).toMatchObject({ status: 'ok' });
    expect(tables.stopVisit).toEqual([expect.objectContaining({ depotId: 'S', sequence: 1, customerId: 'C-DELTA', photoCount: 1 })]);
    expect(tables.stopEvent.find((e) => e.kind === 'PHOTO')).toMatchObject({ depotId: 'S' });
    const old = await sendPhoto(token, '1:1');
    expect(old.data).toMatchObject({ status: 'refused', code: 'STOP_AMBIGUOUS', message: expect.objectContaining({ en: expect.stringMatching(/^Not recorded/) }) });
    expect(tables.deliveryPhoto).toHaveLength(1);
    const res = await photoGET(new Request(`https://routeiq.test/api/d/photos/${ok.data.photoId}`, { headers: { authorization: `DriverLink ${token}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('with one Load 1 that day (the South plan not there) the old keys of a phone that saved before the update are accepted', async () => {
    seed(false);
    const token = makeLink('t5');
    const r = await act(token, [delivered('1:1'), back()]);
    expect(r.data.results.map((x) => x.status)).toEqual(['ok', 'ok']);
    expect(tables.stopVisit).toEqual([expect.objectContaining({ depotId: 'N', sequence: 1, customerId: 'C-ACME', casesDelivered: 40 })]);
    expect(r.data.stops['N:1:1']).toMatchObject({ outcome: 'DELIVERED' });
    expect(r.data.back).toEqual({ 'N:1': expect.any(String) });
    expect((await sendPhoto(token, '1:1')).data).toMatchObject({ status: 'ok' });
  });
});

describe('the resolver never guesses (safety rule)', () => {
  const l = (id: string, depotId: string, loadNo: number): TruckDayLoad => ({
    id,
    runId: `R${depotId}`,
    depotId,
    truckId: 't5',
    loadNo,
    status: 'DISPATCHED',
    departMin: 430,
    returnMin: 600,
    driverId: null,
    driverName: null,
    driverPhone: null,
    driverCasual: false,
    statusChangedAt: null,
  });
  const has = (ids: string[]) => async (loadIds: string[]) => new Set(loadIds.filter((x) => ids.includes(x)));

  it('a key that matches more than one stop is refused, whatever its form; one match is taken; none is STOP_NOT_FOUND', async () => {
    const loads = [l('a', 'N', 1), l('b', 'S', 1), l('c', 'N', 2)];
    expect(await resolveTarget(loads, { depotId: 'S', loadNo: 1, sequence: 1 }, has(['a', 'b']))).toEqual({ ok: true, load: loads[1] });
    expect(await resolveTarget(loads, { depotId: null, loadNo: 1, sequence: 1 }, has(['a', 'b']))).toEqual({ ok: false, code: 'STOP_AMBIGUOUS' });
    expect(await resolveTarget(loads, { depotId: null, loadNo: 1, sequence: 3 }, has(['a']))).toEqual({ ok: true, load: loads[0] });
    expect(await resolveTarget(loads, { depotId: null, loadNo: 1, sequence: 9 }, has([]))).toEqual({ ok: false, code: 'STOP_NOT_FOUND' });
    expect(await resolveTarget(loads, { depotId: null, loadNo: 1, sequence: null }, has(['a', 'b']))).toEqual({ ok: false, code: 'STOP_AMBIGUOUS' });
    expect(await resolveTarget(loads, { depotId: null, loadNo: 2, sequence: null }, has([]))).toEqual({ ok: true, load: loads[2] });
    // Two live loads of one depot with one number (never made by the planner): refused, even with the depot.
    const twice = [l('a', 'N', 1), l('d', 'N', 1)];
    expect(await resolveTarget(twice, { depotId: 'N', loadNo: 1, sequence: 1 }, has(['a', 'd']))).toEqual({ ok: false, code: 'STOP_AMBIGUOUS' });
    expect(await resolveTarget(twice, { depotId: 'N', loadNo: 1, sequence: null }, has([]))).toEqual({ ok: false, code: 'STOP_AMBIGUOUS' });
  });
});

describe('the manifest of a truck-day with two depots', () => {
  const input: ManifestInput = {
    truckId: 't1',
    date: '2026-09-25',
    tz: 'Asia/Muscat',
    serverNow: new Date('2026-09-25T04:00:00Z'),
    tenantName: 'Synthetic Water Co',
    link: { expiresAt: new Date('2026-09-26T08:00:00Z'), uploadUntil: new Date('2026-09-29T08:00:00Z'), generation: 1 },
    truck: { code: 'T01', hired: false },
    casualOf: new Map(),
    settings: { radiusM: 100, photoRequired: true, locationRetentionDays: 90, photoRetentionDays: 90, dispatcherPhone: null },
    office: null,
  };

  it('each depot\'s Load 1 has its own load key and stop keys; results and Back at depot land on their own depot\'s load', () => {
    const north = fixture();
    const south = fixture();
    south.run = { ...south.run, depot: { ...south.run.depot, id: 'd2', code: 'SOH', name: 'Sohar Depot' } };
    south.loads = south.loads.filter((x) => x.truckId === 't1' && x.loadNo === 1).map((x) => ({ ...x, departMin: x.departMin + 600 }));
    const m = projectManifest([north, south], input);
    const ones = m.loads.filter((x) => x.loadNo === 1);
    expect(ones.map((x) => x.key)).toEqual(['d1:1', 'd2:1']);
    expect(ones.map((x) => x.depotId)).toEqual(['d1', 'd2']);
    expect(ones[1]!.stops[0]!.key).toBe('d2:1:1');
    const keys = m.loads.flatMap((x) => x.stops.map((s) => s.key));
    expect(new Set(keys).size).toBe(keys.length);
    const result = { state: 'DONE' as const, arrivedAt: null, arrivalObserved: true, departedAt: null, minutes: null, outcome: 'DELIVERED' as const, reason: null, note: null, outcomeAt: null, by: 'DRIVER' as const, casesDelivered: 12, lines: null, photoIds: [], proofPhotos: 0, noPhotoReason: null, late: false, editable: true, carriedTo: null };
    const merged = mergeResults(m, { stops: { 'd2:1:1': result }, back: { 'd2:1': '2026-09-25T12:00:00.000Z' } });
    const [n1, s1] = merged.loads.filter((x) => x.loadNo === 1);
    expect(n1!.stops[0]!.result).toBeNull();
    expect(n1!.backAtDepotAt).toBeNull();
    expect(s1!.stops[0]!.result).toMatchObject({ outcome: 'DELIVERED', casesDelivered: 12 });
    expect(s1!.backAtDepotAt).toBe('2026-09-25T12:00:00.000Z');
  });
});

describe('the phone: offline queue and overlay with the new keys', () => {
  const NS = 't5|2026-10-05';
  const T0 = Date.parse('2026-10-05T06:00:00Z');
  const stop = (depot: string, seq: number, name: string): ManifestStop => ({
    key: stopKeyOf(depot, 1, seq),
    sequence: seq,
    customerName: name,
    customerCode: name,
    branchCode: null,
    address: null,
    lat: 23.6,
    lng: 58.4,
    navUrl: null,
    etaMin: 480,
    untilMin: 500,
    hours: null,
    promised: null,
    cases: name === 'DELTA' ? 12 : 40,
    orders: [],
    notes: [],
    accessNotes: null,
    split: null,
    carriedFrom: null,
    changeNotes: [],
    result: null,
  });
  const load = (depot: string, stops: ManifestStop[], departMin: number) => ({
    key: loadKeyOf(depot, 1),
    depotId: depot,
    loadNo: 1,
    trips: 2,
    status: 'DISPATCHED' as const,
    actionable: true,
    departMin,
    returnMin: departMin + 180,
    driverName: 'Salim',
    cases: 52,
    backAtDepotAt: null,
    stops,
  });
  const m = { loads: [load('N', [stop('N', 1, 'ACME'), stop('N', 2, 'BETA')], 430), load('S', [stop('S', 1, 'DELTA')], 700)] };
  const result = (s: string): DriverAction => ({ key: randomUUID(), type: 'OUTCOME', stop: s, at: new Date(T0).toISOString(), outcome: 'DELIVERED', photoKeys: [] });

  it('a result queued with the new key shows on its own depot\'s stop only; an old key shows where one stop fits it, on none where two do', () => {
    const items = [actionItem(NS, result('S:1:1'), T0), actionItem(NS, result('1:2'), T0 + 1), actionItem(NS, result('1:1'), T0 + 2)];
    const [n, s] = applyQueued(m, items);
    expect(s!.stops[0]!.view).toMatchObject({ outcome: 'DELIVERED', pending: true });
    expect(n!.stops[0]!.view).toMatchObject({ outcome: null, pending: false });
    expect(n!.stops[1]!.view).toMatchObject({ outcome: 'DELIVERED', pending: true });
    expect(manifestStopKey(m.loads, '1:2')).toBe('N:1:2');
    expect(manifestStopKey(m.loads, '1:1')).toBeNull();
    // The "link replaced" list names a stop only where the key fits one.
    expect(unsentList([n!, s!], items).map((u) => u.customer)).toEqual(['DELTA', 'BETA', '1:1']);
  });

  it('Back at depot with its depot closes that trip only; the item knows its load; held items go out when their own load is dispatched', () => {
    const b = actionItem(NS, { key: randomUUID(), type: 'BACK_AT_DEPOT', load: 1, depot: 'S', at: new Date(T0).toISOString() }, T0);
    expect(itemLoadKey(b)).toBe('S:1');
    const [n, s] = applyQueued(m, [b]);
    expect(s).toMatchObject({ back: true, backPending: true });
    expect(n).toMatchObject({ back: false });
    // Held arrivals (trips not dispatched yet): each waits for its own load.
    const hn = actionItem(NS, { key: randomUUID(), type: 'ARRIVE', stop: 'N:1:1', at: new Date(T0).toISOString(), mode: 'AUTO' }, T0, true);
    const hs = actionItem(NS, { key: randomUUID(), type: 'ARRIVE', stop: 'S:1:1', at: new Date(T0).toISOString(), mode: 'AUTO' }, T0, true);
    expect([hn.loadKey, hs.loadKey]).toEqual(['N:1', 'S:1']);
    expect(releaseHeld([hn, hs], new Set(['S:1', '1']), T0 + 5).map((i) => i.key)).toEqual([hs.key]);
    // An item saved before the update (no load key, an old stop key) goes out with its load number.
    const old: QueueItem = { ...actionItem(NS, { key: randomUUID(), type: 'ARRIVE', stop: '1:2', at: new Date(T0).toISOString(), mode: 'AUTO' }, T0, true), loadKey: undefined };
    expect(itemLoadKey(old)).toBe('1');
    expect(releaseHeld([old], new Set(['N:1', '1']), T0 + 5)).toHaveLength(1);
  });

  it('the IndexedDB adapter\'s drafts and Save work per new stop key: the other depot\'s Load 1 stop 1 keeps its own draft', async () => {
    const store = memoryStore();
    const photo = (stopKey: string): QueueItem => ({ key: randomUUID(), ns: NS, kind: 'photo', state: 'draft', createdAt: T0, attempts: 0, nextAt: T0, stopKey, loadNo: 1, loadKey: loadKeyOfStop(stopKey), body: { key: 'k', stop: stopKey, takenAt: '', positionStatus: 'OK' } });
    const pn = photo('N:1:1');
    const ps = photo('S:1:1');
    await store.put([pn, ps]);
    const draft = { outcome: 'DELIVERED' as const, reason: null, note: '', lines: {}, photoKeys: [ps.key], pendingPhotoKey: null, noPhoto: false, savedAt: T0 };
    await store.putDraft(NS, 'S:1:1', draft);
    await store.putDraft(NS, 'N:1:1', { ...draft, photoKeys: [pn.key] });
    await store.commit(NS, 'S:1:1', [ps.key], actionItem(NS, { ...result('S:1:1'), photoKeys: [ps.key] } as DriverAction, T0 + 10));
    const items = await store.items(NS);
    expect(items.find((i) => i.key === ps.key)).toMatchObject({ state: 'ready', stopKey: 'S:1:1' });
    expect(items.find((i) => i.key === pn.key)).toMatchObject({ state: 'draft', stopKey: 'N:1:1' });
    expect(await store.getDraft(NS, 'S:1:1')).toBeNull();
    expect(await store.getDraft(NS, 'N:1:1')).toMatchObject({ photoKeys: [pn.key] });
  });

  it('a manifest the page kept before the update (no load keys) still reads: each load takes its number as the key', () => {
    const before = { loads: m.loads.map(({ key: _k, depotId: _d, ...rest }) => ({ ...rest, stops: rest.stops.map((x) => ({ ...x, key: `1:${x.sequence}` })) })) };
    const k = keyedManifest(before as never) as typeof m;
    expect(k.loads.map((x) => [x.key, x.depotId])).toEqual([
      ['1', ''],
      ['1', ''],
    ]);
    expect(keyedManifest(m)).toBe(m);
  });
});
