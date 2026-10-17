/**
 * The admin's GPS tracker mapping of the IVMS live link (lib/ivms/match.ts, lib/ivms/tracker-admin.ts,
 * PUT /api/ivms/trucks/[id]/tracker, POST /api/ivms/objects; design section 8.1 with review M5/M8/M13/L7/L10):
 * IMEIs only (plates only suggest), Arabic digits, never on a one-day truck or on two trucks, the live
 * position cleared on a change, today's GPS times suppressed when a tracker is replaced after a pull,
 * the audit row with the last 4 digits only, and suggestions that never call Ayun while OFF and never
 * return a provider name or plate. IMEIs are the vendor documentation dummies; everything else is invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';
import { asciiDigits, imeiTail, normalizeImei, plateKey, suggestTrackers, trackerRowsOf } from '@/lib/ivms/match';
import { todayIso } from '@/lib/dispatch/time';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({
  audit: vi.fn(async (input: Record<string, unknown>) => (await import('./fake-plan-db')).fakePrisma.auditLog.create({ data: { ...input } })),
}));
const { session } = vi.hoisted(() => ({ session: { value: null as null | { user: { id: string; name: string; role: string; tenantId: string; email: string } } } }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => session.value) }));

const { setTruckTracker, trackerSuggestions } = await import('@/lib/ivms/tracker-admin');
const { PUT } = await import('@/app/api/ivms/trucks/[id]/tracker/route');
const { POST } = await import('@/app/api/ivms/objects/route');
const { POST: UNDO } = await import('@/app/api/ivms/trucks/[id]/gps-times/route');

const IMEI_A = '111111111111111';
const IMEI_B = '222222222222222';
/** More invented trackers, written so no IMEI-like digit run is in the file (ivms-contract guard). */
const IMEI_C = '3'.repeat(15);
const IMEI_D = '4'.repeat(15);
const IMEI_E = '5'.repeat(15);
const IMEI_F = '6'.repeat(15);
const TEN = 'tA';

describe('IMEIs and plates', () => {
  it('an IMEI is 10-20 digits; Arabic-Indic digits, spaces and dashes are accepted while typing', () => {
    expect(normalizeImei(' 1111-1111 1111 111 ')).toBe(IMEI_A);
    expect(normalizeImei('١'.repeat(15))).toBe(IMEI_A);
    expect(normalizeImei('۲'.repeat(15))).toBe(IMEI_B);
    expect(normalizeImei('12345')).toBeNull();
    expect(normalizeImei('1'.repeat(22))).toBeNull();
    expect(normalizeImei(`${'1'.repeat(14)}A`)).toBeNull();
    expect(asciiDigits('٠٩')).toBe('09');
    expect(imeiTail(IMEI_A)).toBe('ends 1111');
    expect(imeiTail(null)).toBe('none');
  });

  it('plate keys: digits in order and letters as a multiset; fewer than 3 digits is no key', () => {
    expect(plateKey('1234 AB')).toEqual({ digits: '1234', letters: 'AB' });
    expect(plateKey('AB-1234')).toEqual(plateKey('1234 AB'));
    expect(plateKey('1234BA')).toEqual(plateKey('1234 AB'));
    expect(plateKey('١٢٣٤ AB')).toEqual(plateKey('1234 AB'));
    expect(plateKey('T05')).toBeNull();
  });

  it("the provider's object list: both shapes and '[]'; names and plates never come out", () => {
    const now = new Date('2026-10-20T06:00:00Z');
    const list = [
      { imei: IMEI_A, name: 'Driver Example 1234 AB', plate_number: '1234 AB', dt_tracker: '2026-10-20 05:50:00' },
      { imei: 'not-an-imei', name: 'x' },
    ];
    const rows = trackerRowsOf(list, now)!;
    expect(rows).toEqual([{ imei: IMEI_A, key: { digits: '1234', letters: 'AB' }, fixAgeMin: 10 }]);
    expect(JSON.stringify(rows)).not.toMatch(/Driver|Example/);
    expect(trackerRowsOf({ [IMEI_B]: { name: '5678 CD' } }, now)).toEqual([{ imei: IMEI_B, key: { digits: '5678', letters: 'CD' }, fixAgeMin: null }]);
    expect(trackerRowsOf([], now)).toEqual([]);
    expect(trackerRowsOf('ERROR: nope', now)).toBeNull();
  });

  it('suggestions: EXACT, DIGITS, AMBIGUOUS; mapped trackers and trucks are left out; unmatched counted', () => {
    const t = (imei: string, plate: string) => ({ imei, key: plateKey(plate), fixAgeMin: 5 });
    const trucks = [
      { id: 'a', code: '1234 AB', ivmsImei: null },
      { id: 'b', code: '5678 CD', ivmsImei: null },
      { id: 'c', code: '9012 EF', ivmsImei: null },
      { id: 'd', code: '3456 GH', ivmsImei: IMEI_C },
    ];
    const r = suggestTrackers(trucks, [t(IMEI_A, 'AB 1234'), t(IMEI_B, '5678'), t(IMEI_D, '9012 XY'), t(IMEI_E, '9012 EF'), t(IMEI_C, '3456 GH'), t(IMEI_F, '7777')]);
    expect(r.suggestions.map((s) => `${s.truckId} ${s.imei.slice(0, 1)} ${s.match}`)).toEqual(['a 1 EXACT', 'b 2 DIGITS', 'c 4 AMBIGUOUS', 'c 5 AMBIGUOUS']);
    expect(r).toMatchObject({ unmatchedTrackers: 1, trackers: 6 });
  });
});

function seed() {
  resetDb();
  session.value = { user: { id: 'admin', name: 'Admin', role: 'TENANT_ADMIN', tenantId: TEN, email: 'admin@example.test' } };
  tables.tenant = [{ id: TEN, slug: 'example-co', name: 'Synthetic Water Co', active: true }];
  tables.tenantConfig = [{ id: 'cfg', tenantId: TEN, timezone: 'Asia/Muscat', ivmsMode: 'OFF' }];
  tables.truck = [
    { id: 't5', tenantId: TEN, code: '1234 AB', onlyOnDate: null, ivmsImei: null, active: true },
    { id: 't6', tenantId: TEN, code: '5678 CD', onlyOnDate: null, ivmsImei: IMEI_B, active: true },
    { id: 'h1', tenantId: TEN, code: '9999 ZZ', onlyOnDate: new Date('2026-10-20T00:00:00Z'), ivmsImei: null, active: true },
  ];
  tables.truckPosition = [{ id: 'p6', tenantId: TEN, truckId: 't6', fixAt: new Date() }];
  tables.ivmsTruckDay = [];
  tables.auditLog = [];
}

const put = async (truckId: string, imei: string | null) => {
  const res = await PUT(new Request(`https://routeiq.test/api/ivms/trucks/${truckId}/tracker`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ imei }) }), { params: { id: truckId } });
  return { status: res.status, body: (await res.json()) as { data: { imei: string | null; changed: boolean; suppressedToday: boolean } | null; error?: { code?: string; message?: string } } };
};

let envBackup: Record<string, string | undefined> = {};
const ENV = ['ROUTEIQ_DISABLE_IVMS', 'AYUN_BASE_URL', 'AYUN_API_KEY', 'AYUN_TENANT_SLUG'];
beforeEach(() => {
  envBackup = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  seed();
});
afterEach(() => {
  for (const k of ENV) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

describe('PUT /api/ivms/trucks/[id]/tracker (company admin)', () => {
  it('sets an IMEI (typed with spaces), audits the last 4 digits only; the same again changes nothing', async () => {
    const r = await put('t5', '1111 1111 1111 111');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ imei: IMEI_A, changed: true });
    expect(tables.truck!.find((t) => t.id === 't5')!.ivmsImei).toBe(IMEI_A);
    expect(tables.auditLog).toHaveLength(1);
    expect(tables.auditLog![0]).toMatchObject({ action: 'UPDATE', entity: 'Truck', entityId: 't5', beforeJson: { truck: '1234 AB', gpsTracker: 'none' }, afterJson: { truck: '1234 AB', gpsTracker: 'ends 1111' } });
    expect(JSON.stringify(tables.auditLog)).not.toContain(IMEI_A);
    expect((await put('t5', IMEI_A)).body.data).toMatchObject({ changed: false });
    expect(tables.auditLog).toHaveLength(1);
  });

  it('refuses a bad IMEI (400), a tracker on another truck (409), a one-day truck (422), another company (404)', async () => {
    expect((await put('t5', '12ab')).status).toBe(400);
    const taken = await put('t5', IMEI_B);
    expect(taken.status).toBe(409);
    expect(taken.body.error?.message).toMatch(/already on truck 5678 CD/);
    expect((await put('h1', IMEI_A)).status).toBe(422);
    tables.truck!.find((t) => t.id === 't5')!.tenantId = 'tB';
    expect((await put('t5', IMEI_A)).status).toBe(404);
  });

  it('clearing or replacing removes the live position; after today\'s pull it suppresses today\'s GPS times (M8)', async () => {
    const today = todayIso('Asia/Muscat');
    tables.ivmsTruckDay!.push({ id: 'td', tenantId: TEN, truckId: 't6', deliveryDate: new Date(`${today}T00:00:00Z`), lastPullAt: new Date(), suppressedAt: null, suppressReason: null });
    const r = await put('t6', null);
    expect(r.body.data).toMatchObject({ imei: null, changed: true });
    expect(tables.truckPosition).toEqual([]);
    expect(tables.auditLog![0]!.afterJson).toMatchObject({ gpsTracker: 'none' });
    // The tracker of the day was replaced: its trail may be another truck's.
    expect(r.body.data!.suppressedToday).toBe(true);
    expect(tables.ivmsTruckDay![0]).toMatchObject({ suppressReason: 'REMAP' });
    expect(tables.ivmsTruckDay![0]!.suppressedAt).toBeInstanceOf(Date);
  });

  it("replacing a tracker after today's pull also deletes the GPS times already written for the truck today (second review M-1)", async () => {
    const today = todayIso('Asia/Muscat');
    const d = new Date(`${today}T00:00:00Z`);
    tables.ivmsTruckDay!.push({ id: 'td', tenantId: TEN, truckId: 't6', deliveryDate: d, lastPullAt: new Date(), suppressedAt: null, suppressReason: null });
    tables.stopVisit = [{ id: 'v1', tenantId: TEN, depotId: 'D1', deliveryDate: d, truckId: 't6', loadNo: 1, sequence: 1, firstLoadId: null, linesJson: [], casesPlanned: 10, arrivalSource: 'AYUN', arrivedAt: new Date(), locationPurgedAt: null }];
    const ev = (id: string, source: string) => ({ id, tenantId: TEN, depotId: 'D1', deliveryDate: d, truckId: 't6', loadNo: 1, sequence: 1, visitId: 'v1', kind: 'ARRIVED', source, at: new Date(), receivedAt: new Date(), idempotencyKey: `k:${id}`, payloadJson: {} });
    tables.stopEvent = [ev('gps', 'AYUN'), ev('tap', 'PHONE_MANUAL')];
    const r = await put('t6', IMEI_C);
    expect(r.body.data).toMatchObject({ changed: true, suppressedToday: true });
    expect(tables.stopEvent.map((e) => e.id)).toEqual(['tap']);
    expect(tables.stopVisit[0]).toMatchObject({ arrivalSource: 'PHONE_MANUAL' });
  });

  it('a tracker set on a truck records when: nothing from before it is pulled for today or yesterday (second review M-1)', async () => {
    tables.tenantConfig![0]!.ivmsMode = 'MAP';
    const before = Date.now();
    await put('t5', IMEI_A);
    const rows = tables.ivmsTruckDay!.filter((x) => x.truckId === 't5');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect((row.trailFrom as Date).getTime()).toBeGreaterThanOrEqual(before);
    // Clearing it records nothing new.
    tables.ivmsTruckDay = [];
    await put('t5', null);
    expect(tables.ivmsTruckDay.filter((x) => x.truckId === 't5' && x.trailFrom)).toEqual([]);
  });

  it('with GPS tracking OFF, setting a tracker creates no GPS row (OFF outputs unchanged); an existing truck-day is still marked', async () => {
    expect(tables.tenantConfig![0]!.ivmsMode).toBe('OFF');
    tables.ivmsTruckDay = [];
    await put('t5', IMEI_A);
    expect(tables.ivmsTruckDay).toEqual([]);
    await put('t5', null);
    const today = todayIso('Asia/Muscat');
    tables.ivmsTruckDay.push({ id: 'td-old', tenantId: TEN, truckId: 't5', deliveryDate: new Date(`${today}T00:00:00Z`), lastPullAt: null, suppressedAt: null, trailFrom: null });
    const before = Date.now();
    await put('t5', IMEI_A);
    expect(tables.ivmsTruckDay).toHaveLength(1);
    expect((tables.ivmsTruckDay[0]!.trailFrom as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('VIEWER, PLANNER and SUPERVISOR are refused (403); nothing changes', async () => {
    for (const role of ['VIEWER', 'PLANNER', 'SUPERVISOR']) {
      session.value!.user.role = role;
      expect((await put('t5', IMEI_A)).status).toBe(403);
    }
    expect(tables.truck!.find((t) => t.id === 't5')!.ivmsImei).toBeNull();
  });
});

describe('suggestions from Ayun', () => {
  const call = vi.fn(async () => ({ ok: true as const, data: [{ imei: IMEI_A, name: 'Driver Example', plate_number: '1234 AB' }] }));
  afterEach(() => {
    call.mockClear();
  });

  it('never call Ayun while GPS tracking is OFF, while the kill switch is set, or without the server variables', async () => {
    expect(await trackerSuggestions(TEN, call)).toMatchObject({ ok: false, reason: 'MODE_OFF' });
    tables.tenantConfig![0]!.ivmsMode = 'MAP';
    expect(await trackerSuggestions(TEN, call)).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED' });
    process.env.ROUTEIQ_DISABLE_IVMS = '1';
    expect(await trackerSuggestions(TEN, call)).toMatchObject({ ok: false, reason: 'DISABLED' });
    expect(call).not.toHaveBeenCalled();
  });

  it("never for another company than the Ayun account's; with the account: suggestions without names", async () => {
    tables.tenantConfig![0]!.ivmsMode = 'MAP';
    process.env.AYUN_BASE_URL = 'https://provider.example.test';
    process.env.AYUN_API_KEY = 'test-key-not-real';
    process.env.AYUN_TENANT_SLUG = 'other-co';
    expect(await trackerSuggestions(TEN, call)).toMatchObject({ ok: false, reason: 'OTHER_COMPANY' });
    expect(call).not.toHaveBeenCalled();
    process.env.AYUN_TENANT_SLUG = 'example-co';
    const r = await trackerSuggestions(TEN, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, trackers: 1, unmatchedTrackers: 0, suggestions: [{ truckId: 't5', truckCode: '1234 AB', imei: IMEI_A, match: 'EXACT' }] });
    expect(JSON.stringify(r)).not.toMatch(/Driver|Example/);
  });

  it('the route is company admin only and, without the server variables, answers NOT_CONFIGURED (409) without a call', async () => {
    tables.tenantConfig![0]!.ivmsMode = 'MAP';
    session.value!.user.role = 'PLANNER';
    expect((await POST(new Request('https://routeiq.test/api/ivms/objects', { method: 'POST' }))).status).toBe(403);
    session.value!.user.role = 'TENANT_ADMIN';
    const res = await POST(new Request('https://routeiq.test/api/ivms/objects', { method: 'POST' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_CONFIGURED');
  });

  it('a direct setTruckTracker refuses a one-day truck even with a valid IMEI', async () => {
    expect(await setTruckTracker(TEN, 'h1', IMEI_A, { userId: 'admin', ip: null })).toMatchObject({ ok: false, status: 422, code: 'ONE_DAY_TRUCK' });
  });
});

describe('POST /api/ivms/trucks/[id]/gps-times: the undo of a truck-day (first review M-3)', () => {
  const today = () => todayIso('Asia/Muscat');
  const seedGps = () => {
    const d = new Date(`${today()}T00:00:00Z`);
    tables.stopVisit = [{ id: 'v1', tenantId: TEN, depotId: 'D1', deliveryDate: d, truckId: 't6', loadNo: 1, sequence: 1, firstLoadId: null, linesJson: [], casesPlanned: 10, arrivalSource: 'AYUN', arrivedAt: new Date(), locationPurgedAt: null }];
    const ev = (id: string, source: string, kind = 'ARRIVED') => ({ id, tenantId: TEN, depotId: 'D1', deliveryDate: d, truckId: 't6', loadNo: 1, sequence: 1, visitId: 'v1', kind, source, at: new Date(), receivedAt: new Date(), idempotencyKey: `k:${id}`, payloadJson: {} });
    tables.stopEvent = [ev('g1', 'AYUN'), ev('g2', 'AYUN', 'DEPARTED'), ev('r1', 'PHONE_MANUAL', 'OUTCOME')];
  };
  const post = async (truckId: string, body: Record<string, unknown>) => {
    const res = await UNDO(new Request(`https://routeiq.test/api/ivms/trucks/${truckId}/gps-times`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: { id: truckId } });
    return { status: res.status, body: (await res.json()) as { data: { events: number; visits: number; dryRun: boolean } | null; error?: { code?: string } } };
  };

  it('a dry run by default: counts only, nothing changes, no audit row', async () => {
    seedGps();
    const r = await post('t6', { date: today() });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ dryRun: true, events: 2, visits: 1 });
    expect(tables.stopEvent!.map((e) => e.id)).toEqual(['g1', 'g2', 'r1']);
    expect(tables.auditLog).toEqual([]);
  });

  it('dryRun false: the GPS events go, the visit is rebuilt, the day is suppressed, one audit row with counts only', async () => {
    seedGps();
    const r = await post('t6', { date: today(), dryRun: false });
    expect(r.body.data).toMatchObject({ dryRun: false, events: 2, visits: 1 });
    expect(tables.stopEvent!.map((e) => e.id)).toEqual(['r1']);
    expect(tables.stopVisit![0]).toMatchObject({ arrivalSource: null, arrivedAt: null });
    expect(tables.ivmsTruckDay![0]).toMatchObject({ truckId: 't6', suppressReason: 'UNDO' });
    expect(tables.auditLog).toHaveLength(1);
    expect(tables.auditLog![0]).toMatchObject({ action: 'GPS_TIMES_UNDONE', entity: 'Truck', entityId: 't6', afterJson: { truck: '5678 CD', date: today(), gpsTimesRemoved: 2, visitsRebuilt: 1 } });
    expect(JSON.stringify(tables.auditLog)).not.toContain(IMEI_B);
  });

  it('works with GPS tracking OFF (the runbook switches it off first); refuses another company (404), a future date (422), lower roles (403)', async () => {
    seedGps();
    expect(tables.tenantConfig![0]!.ivmsMode).toBe('OFF');
    expect((await post('t6', { date: '2999-01-01' })).status).toBe(422);
    expect((await post('t6', { date: 'yesterday' })).status).toBe(422);
    tables.truck!.find((t) => t.id === 't6')!.tenantId = 'tB';
    expect((await post('t6', { date: today() })).status).toBe(404);
    tables.truck!.find((t) => t.id === 't6')!.tenantId = TEN;
    for (const role of ['VIEWER', 'PLANNER', 'SUPERVISOR']) {
      session.value!.user.role = role;
      expect((await post('t6', { date: today(), dryRun: false })).status).toBe(403);
    }
    expect(tables.stopEvent).toHaveLength(3);
  });
});
