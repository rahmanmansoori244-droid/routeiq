/**
 * The IVMS live link's joins between the ingest and the GPS times / live map (integration of 16 Oct
 * 2026), each on fakes (never a database, never a real call):
 * - the poller runs the processing step (TIMES only): right after a tick that pulled history, else at
 *   most every PROCESS_EVERY_MS; also when another container holds the lease; a processing failure never
 *   fails the tick; MAP never processes;
 * - the admin's tracker picker: one USER_GET_OBJECTS counted in the ADMIN share first (no lease), never
 *   while OFF, for another company or with the kill switch; a used-up share answers LIMIT without a call;
 *   a wrong key pauses the background calls; the key never leaves the client;
 * - the live map's interval in effect (the allowance stretches the setting) and its caption;
 * - an unobserved GPS time is corrected by a better trail, an observed one never moves;
 * - the Settings card for GPS tracking (company admin only).
 * Invented data only (the vendor documentation's dummy IMEIs, made-up codes).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';
import { company, fakeAyun, IMEI_A, ivmsTestEnv, KEY, MemoryIvmsStore } from './ivms-fakes';
import type { FleetTruck } from '@/lib/ivms/store';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));

const { _resetIvmsProcessState, runIvmsTick, PROCESS_EVERY_MS } = await import('@/lib/ivms/poll');
const { ayunTrackerListCall } = await import('@/lib/ivms/admin-call');
const { trackerSuggestions } = await import('@/lib/ivms/tracker-admin');
const { mapIntervalInEffect, classShares } = await import('@/lib/ivms/budget');
const { liveMapCaption } = await import('@/lib/ivms/live-map');
const { correctGpsEvent } = await import('@/lib/ivms/stop-events');
const { readLiveVehicles } = await import('@/lib/ivms/vehicles');
const { SettingsForm } = await import('@/app/t/[slug]/settings/settings-form');

const DAY = '2026-10-16';
const muscat = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+04:00`);
const ENV_NO_HOOK = ivmsTestEnv({ AYUN_WEBHOOK_SECRET: undefined });
const TEN = 'tA';
const fleetOut = (status: 'DISPATCHED' | 'COMPLETED' | 'LOADING' = 'DISPATCHED'): FleetTruck[] => [
  { truckId: 't1', imei: IMEI_A, depotId: 'd1', days: [{ date: DAY, loads: [{ loadNo: 1, status, statusChangedAt: status === 'COMPLETED' ? muscat('08:00') : null }] }] },
];

let logs: string[] = [];
const ENV_KEYS = ['AYUN_BASE_URL', 'AYUN_API_KEY', 'AYUN_TENANT_SLUG', 'AYUN_WEBHOOK_SECRET', 'ROUTEIQ_DISABLE_IVMS'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  _resetIvmsProcessState();
  resetDb();
  logs = [];
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetIvmsProcessState();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function poller(mode: 'MAP' | 'TIMES', fleet = fleetOut()) {
  const store = new MemoryIvmsStore(company({ mode, dailyBudget: 3000, routePullMin: 30 }));
  store.fleetOf = () => fleet;
  let clock = muscat('09:00');
  const ayun = fakeAyun(() => clock);
  const tick = (now: Date, opts: { force?: boolean } = {}, owner = 'me') => {
    clock = now;
    return runIvmsTick(now, opts, { store, env: ENV_NO_HOOK, fetchImpl: ayun.fetch, owner, random: () => 0.5 });
  };
  return { store, ayun, tick };
}

describe('the poller runs the processing step (TIMES)', () => {
  it('right after a history pull, then at most every 5 minutes without one; its counts are in the tick result', async () => {
    const { store, ayun, tick } = poller('TIMES');
    store.processImpl = async () => ({ truckDays: 1, written: 2, corrected: 0, busy: 0, failed: 0, skipped: null });
    const r = await tick(muscat('09:00'));
    expect(ayun.calls.map((c) => c.cmd)).toEqual(['OBJECT_GET_LOCATIONS', 'OBJECT_GET_ROUTE']);
    expect(store.processed).toEqual([muscat('09:00')]);
    expect(r?.times).toEqual({ truckDays: 1, written: 2, corrected: 0, busy: 0, failed: 0 });
    // No pull at 09:02 and 09:04 (every 30 min): no processing either.
    await tick(muscat('09:02'));
    await tick(muscat('09:04'));
    expect(store.processed).toHaveLength(1);
    // 5 minutes later: a run for a late Dispatch press or a completion, without a new pull.
    await tick(new Date(muscat('09:00').getTime() + PROCESS_EVERY_MS));
    expect(store.processed).toHaveLength(2);
    expect(ayun.calls.filter((c) => c.cmd === 'OBJECT_GET_ROUTE')).toHaveLength(1);
  });

  it('nothing to process says nothing: the result has no `times` when no truck-day was run', async () => {
    const { tick } = poller('TIMES');
    expect((await tick(muscat('09:00')))?.times).toBeUndefined();
  });

  it('MAP never processes; a truck-day not on the road yet (LOADING) is not processed', async () => {
    const map = poller('MAP');
    await map.tick(muscat('09:00'));
    expect(map.store.processed).toEqual([]);
    const loading = poller('TIMES', fleetOut('LOADING'));
    await loading.tick(muscat('09:00'));
    expect(loading.store.processed).toEqual([]);
  });

  it('runs also while another container holds the lease (the trail already pulled), never calling Ayun for it', async () => {
    const { store, ayun, tick } = poller('TIMES');
    store.setSkew(5, muscat('08:58')); // the other container's last live-position answer
    await store.acquireLease(TEN, 'other', muscat('09:00'), 30_000);
    const r = await tick(muscat('09:00'));
    expect(r?.skipped).toBe('LEASE_OR_BACKOFF');
    expect(r?.clock).toBe('OK');
    expect(ayun.calls).toEqual([]);
    expect(store.processed).toEqual([muscat('09:00')]);
  });

  it('... but not while the provider clock is wrong or unknown (first review H-1)', async () => {
    const { store, tick } = poller('TIMES');
    await store.acquireLease(TEN, 'other', muscat('09:00'), 30_000);
    expect((await tick(muscat('09:00')))?.clock).toBe('UNKNOWN');
    store.setSkew(4 * 3600, muscat('08:58'));
    await store.acquireLease(TEN, 'other', muscat('09:01'), 30_000);
    expect((await tick(muscat('09:01')))?.clock).toBe('AHEAD');
    expect(store.processed).toEqual([]);
  });


  it('a processing failure never fails the tick: its code only in the log and the result', async () => {
    const { store, tick } = poller('TIMES');
    store.processImpl = async () => {
      throw Object.assign(new Error(`statement with ${IMEI_A}`), { code: 'P2034' });
    };
    const r = await tick(muscat('09:00'));
    expect(r?.times).toEqual({ truckDays: 0, written: 0, corrected: 0, busy: 0, failed: 0, error: 'P2034' });
    expect(r?.route?.pulls).toBe(1);
    expect(logs).toEqual(['ivms: GPS times not processed P2034']);
    // The next pass retries at once (the failed run counted as a run only for its 5-minute pace).
    await tick(new Date(muscat('09:00').getTime() + PROCESS_EVERY_MS));
    expect(store.processed).toHaveLength(2);
  });

  it('the final pull of a truck-day is processed right away (the clock as measured while the load was out)', async () => {
    const fleet = fleetOut('COMPLETED');
    const { store, ayun, tick } = poller('TIMES', fleet);
    store.setSkew(-20, muscat('07:55'));
    await tick(muscat('08:10'));
    expect(ayun.calls.map((c) => c.cmd)).toEqual(['OBJECT_GET_ROUTE']);
    expect(store.processed).toEqual([muscat('08:10')]);
  });
});

describe('a wrong provider clock never writes GPS times (first review H-1)', () => {
  const run = async (opts: { offsetMin?: number; providerShiftMin?: number }) => {
    const store = new MemoryIvmsStore(company({ mode: 'TIMES', dailyBudget: 3000, routePullMin: 30 }));
    store.fleetOf = () => fleetOut();
    let clock = muscat('09:00');
    const ayun = fakeAyun(() => clock, undefined, { providerShiftMin: opts.providerShiftMin });
    const env = ivmsTestEnv({ AYUN_WEBHOOK_SECRET: undefined, ...(opts.offsetMin !== undefined ? { AYUN_API_TIME_OFFSET_MIN: String(opts.offsetMin) } : {}) });
    store.processImpl = async () => ({ truckDays: 1, written: 1, corrected: 0, busy: 0, failed: 0, skipped: null });
    const results = [];
    for (const t of ['09:00', '09:31', '10:02']) {
      clock = muscat(t);
      results.push(await runIvmsTick(clock, {}, { store, env, fetchImpl: ayun.fetch, owner: 'me', random: () => 0.5 }));
    }
    return { store, ayun, results };
  };

  it('Ayun in UTC and the offset right (0): history pulled and processed', async () => {
    const { ayun, store, results } = await run({});
    expect(results.map((r) => r?.clock)).toEqual(['OK', 'OK', 'OK']);
    expect(ayun.calls.filter((c) => c.cmd === 'OBJECT_GET_ROUTE').length).toBeGreaterThan(0);
    expect(store.processed.length).toBeGreaterThan(0);
  });

  it('Ayun in Muscat local time with the offset left at 0: the map still asks, no history pull, no GPS time', async () => {
    const { ayun, store, results } = await run({ providerShiftMin: 240 });
    expect(results.map((r) => r?.clock)).toEqual(['AHEAD', 'AHEAD', 'AHEAD']);
    expect(ayun.calls.map((c) => c.cmd).every((c) => c === 'OBJECT_GET_LOCATIONS')).toBe(true);
    expect(store.trail.size).toBe(0);
    expect(store.processed).toEqual([]);
    // The skew is kept for the Settings card: about +4 h (set the offset to -240).
    expect(store.state?.providerSkewSec).toBeGreaterThan(4 * 3600 - 60);
  });

  it('Ayun in UTC with the offset set to -240 by mistake: no history pull, no GPS time', async () => {
    const { ayun, store, results } = await run({ offsetMin: -240 });
    expect(results.map((r) => r?.clock)).toEqual(['BEHIND', 'BEHIND', 'BEHIND']);
    expect(ayun.calls.some((c) => c.cmd === 'OBJECT_GET_ROUTE')).toBe(false);
    expect(store.processed).toEqual([]);
  });

  it('Ayun in local time and the offset set right (-240): pulled and processed', async () => {
    const { ayun, store, results } = await run({ offsetMin: -240, providerShiftMin: 240 });
    expect(results.map((r) => r?.clock)).toEqual(['OK', 'OK', 'OK']);
    expect(ayun.calls.some((c) => c.cmd === 'OBJECT_GET_ROUTE')).toBe(true);
    expect(store.processed.length).toBeGreaterThan(0);
  });

  it('a skew measured with another offset (the variable was just changed) is unknown until the next live-position answer', async () => {
    const { clockCheck } = await import('@/lib/ivms/budget');
    const at = muscat('09:00');
    expect(clockCheck({ skewSec: 3, skewAt: at, skewOffsetMin: 0 }, 0, at)).toBe('OK');
    expect(clockCheck({ skewSec: 3, skewAt: at, skewOffsetMin: 0 }, -240, at)).toBe('UNKNOWN');
    expect(clockCheck({ skewSec: 3, skewAt: at, skewOffsetMin: 0 }, 0, new Date(at.getTime() + 13 * 3600_000))).toBe('UNKNOWN');
    expect(clockCheck(null, 0, at)).toBe('UNKNOWN');
    // A fleet parked with the ignition off for an hour is not a clock problem; 4 h is.
    expect(clockCheck({ skewSec: -3600, skewAt: at, skewOffsetMin: 0 }, 0, at)).toBe('OK');
    expect(clockCheck({ skewSec: -4 * 3600, skewAt: at, skewOffsetMin: 0 }, 0, at)).toBe('BEHIND');
    expect(clockCheck({ skewSec: 11 * 60, skewAt: at, skewOffsetMin: 0 }, 0, at)).toBe('AHEAD');
  });
});


describe("the admin's tracker picker: one call in the ADMIN share", () => {
  const seedCompany = (mode = 'MAP', budget = 100) => {
    tables.tenant = [{ id: TEN, slug: 'example-co', name: 'Synthetic Water Co', active: true }];
    tables.tenantConfig = [{ id: 'cfg', tenantId: TEN, timezone: 'Asia/Muscat', ivmsMode: mode, ivmsDailyCallBudget: budget }];
    tables.truck = [{ id: 't5', tenantId: TEN, code: '1234 AB', active: true, onlyOnDate: null, ivmsImei: null }];
  };
  const objects = () =>
    fakeAyun(
      () => muscat('09:00'),
      (cmd) => (cmd === 'USER_GET_OBJECTS' ? { body: JSON.stringify([{ imei: IMEI_A, name: 'Example object with a driver name', plate_number: '1234 AB' }]) } : undefined),
    );

  it('claims the ADMIN share first (no lease), then asks only USER_GET_OBJECTS; the answer has IMEIs and match kinds, never a name', async () => {
    seedCompany();
    const store = new MemoryIvmsStore(company());
    await store.acquireLease(TEN, 'poller', muscat('09:00'), 30_000); // the poller's lease never blocks the admin (M13)
    const ayun = objects();
    const r = await ayunTrackerListCall(TEN, muscat('09:00'), { env: ivmsTestEnv(), store, fetchImpl: ayun.fetch });
    expect(r.ok).toBe(true);
    expect(ayun.calls.map((c) => c.cmd)).toEqual(['USER_GET_OBJECTS']);
    expect(store.state).toMatchObject({ adminCalls: 1, mapCalls: 0 });
    expect(JSON.stringify(r)).not.toContain(KEY);
    // Through the suggestions: matched by plate on the server, no provider name or plate out.
    process.env.AYUN_BASE_URL = 'https://provider.example';
    process.env.AYUN_API_KEY = KEY;
    process.env.AYUN_TENANT_SLUG = 'example-co';
    delete process.env.ROUTEIQ_DISABLE_IVMS;
    const s = await trackerSuggestions(TEN, (t, now) => ayunTrackerListCall(t, now, { store, fetchImpl: ayun.fetch }), muscat('09:00'));
    expect(s).toMatchObject({ ok: true, suggestions: [{ truckId: 't5', imei: IMEI_A, match: 'EXACT' }] });
    expect(JSON.stringify(s)).not.toMatch(/Example object|driver name/);
    expect(store.state?.adminCalls).toBe(2);
  });

  it('the ADMIN share used up: LIMIT without a call (the map and the history keep theirs)', async () => {
    seedCompany('MAP', 100);
    const store = new MemoryIvmsStore(company());
    const ayun = objects();
    const share = classShares(100, 'MAP', false).ADMIN;
    for (let i = 0; i < share; i++) expect((await ayunTrackerListCall(TEN, muscat('09:00'), { env: ivmsTestEnv(), store, fetchImpl: ayun.fetch })).ok).toBe(true);
    expect(await ayunTrackerListCall(TEN, muscat('09:00'), { env: ivmsTestEnv(), store, fetchImpl: ayun.fetch })).toEqual({ ok: false, kind: 'LIMIT' });
    expect(ayun.calls).toHaveLength(share);
  });

  it('never while OFF, for another company, without the variables or with the kill switch', async () => {
    const ayun = objects();
    const store = new MemoryIvmsStore(company());
    seedCompany('OFF');
    expect(await ayunTrackerListCall(TEN, muscat('09:00'), { env: ivmsTestEnv(), store, fetchImpl: ayun.fetch })).toEqual({ ok: false, kind: 'NOT_CONFIGURED' });
    seedCompany('MAP');
    expect(await ayunTrackerListCall(TEN, muscat('09:00'), { env: ivmsTestEnv({ AYUN_TENANT_SLUG: 'other-co' }), store, fetchImpl: ayun.fetch })).toEqual({ ok: false, kind: 'NOT_CONFIGURED' });
    expect(await ayunTrackerListCall(TEN, muscat('09:00'), { env: ivmsTestEnv({ AYUN_API_KEY: undefined }), store, fetchImpl: ayun.fetch })).toEqual({ ok: false, kind: 'NOT_CONFIGURED' });
    expect(await ayunTrackerListCall(TEN, muscat('09:00'), { env: ivmsTestEnv({ ROUTEIQ_DISABLE_IVMS: '1' }), store, fetchImpl: ayun.fetch })).toEqual({ ok: false, kind: 'DISABLED' });
    expect(ayun.calls).toEqual([]);
    expect(store.state).toBeNull();
  });

  it('a wrong key (AUTH) pauses the background calls an hour; another failure is only recorded', async () => {
    seedCompany();
    const store = new MemoryIvmsStore(company());
    const auth = fakeAyun(() => muscat('09:00'), () => ({ body: 'ERROR: wrong API key' }));
    expect(await ayunTrackerListCall(TEN, muscat('09:00'), { env: ivmsTestEnv(), store, fetchImpl: auth.fetch })).toEqual({ ok: false, kind: 'AUTH' });
    expect(store.state).toMatchObject({ lastError: 'AUTH', nextTryAt: muscat('10:00') });
    const store2 = new MemoryIvmsStore(company());
    const bad = fakeAyun(() => muscat('09:00'), () => ({ body: '<html>proxy</html>' }));
    expect(await ayunTrackerListCall(TEN, muscat('09:00'), { env: ivmsTestEnv(), store: store2, fetchImpl: bad.fetch })).toEqual({ ok: false, kind: 'PARSE' });
    expect(store2.state).toMatchObject({ lastError: 'PARSE', nextTryAt: null });
    expect(logs).toEqual([]);
  });
});

describe('the live map: the interval in effect and the caption', () => {
  const hours = { timezone: 'Asia/Muscat', fromMin: 300, toMin: 1380 };
  it("today's 100 a day stretches 60 s to about 19 min in TIMES (11 min in MAP); 3,000 a day keeps 60 s; nothing left = null", () => {
    const at = (mode: 'MAP' | 'TIMES', budget: number, used = 0) => mapIntervalInEffect({ budget, mode, webhookSecretSet: true, pollSec: 60, hours, mapCallsToday: used, now: muscat('05:00') });
    expect(Math.round(at('TIMES', 100)! / 60)).toBe(19);
    expect(Math.round(at('MAP', 100)! / 60)).toBe(11);
    expect(at('TIMES', 3000)).toBe(60);
    expect(at('TIMES', 100, classShares(100, 'TIMES', false).MAP)).toBeNull();
  });

  it('the caption says how often positions come; a read late by more than two intervals warns', () => {
    const now = muscat('09:00');
    const base = { mode: 'TIMES' as const, vehicles: [], intervalSec: 1100 };
    expect(liveMapCaption({ ...base, updatedAt: muscat('08:45').toISOString() }, now, 'Asia/Muscat')).toEqual({
      text: "Live trucks (GPS): positions of 08:45, 0 trucks. Positions about every 18 min (Ayun's daily allowance).",
      warn: false,
    });
    expect(liveMapCaption({ ...base, updatedAt: muscat('08:20').toISOString() }, now, 'Asia/Muscat')?.warn).toBe(true);
    // At 60 s nothing about the pace, and late after 10 minutes as before.
    expect(liveMapCaption({ ...base, intervalSec: 60, updatedAt: muscat('08:55').toISOString() }, now, 'Asia/Muscat')?.text).toBe('Live trucks (GPS): positions of 08:55, 0 trucks.');
    expect(liveMapCaption({ ...base, intervalSec: 60, updatedAt: muscat('08:45').toISOString() }, now, 'Asia/Muscat')?.warn).toBe(true);
  });

  it('the vehicles endpoint answers the interval in effect and when a position was last received (never a history pull)', async () => {
    delete process.env.ROUTEIQ_DISABLE_IVMS;
    const now = new Date();
    const today = new Date(new Date(now.getTime() + 4 * 3600_000).toISOString().slice(0, 10) + 'T00:00:00.000Z');
    tables.tenantConfig = [{ id: 'cfg', tenantId: TEN, timezone: 'Asia/Muscat', ivmsMode: 'TIMES', ivmsPollSec: 60, ivmsDailyCallBudget: 3000, ivmsFromMin: 0, ivmsToMin: 1440 }];
    tables.runPlan = [{ id: 'R1', tenantId: TEN, depotId: 'D1', runDate: today, status: 'DISPATCHED', version: 1 }];
    tables.planLoad = [{ id: 'L1', tenantId: TEN, runId: 'R1', truckId: 't1', loadNo: 1, status: 'LOADING', departMin: 420, breakJson: null, truckSnapshotJson: null }];
    tables.truck = [{ id: 't1', tenantId: TEN, code: 'T01', onlyOnDate: null }];
    tables.ivmsState = [{ tenantId: TEN, usageDay: new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`), mapCalls: 5, lastOkAt: now }];
    tables.ivmsTruckDay = [];
    const received = new Date(now.getTime() - 90_000);
    tables.truckPosition = [{ id: 'p1', tenantId: TEN, truckId: 't1', fixAt: new Date(now.getTime() - 100_000), receivedAt: received, lat: 10.5, lng: 20.5, speedKmh: 0, heading: null, flags: [], movedAt: null }];
    const r = await readLiveVehicles(TEN, 'R1', now);
    expect(r).toMatchObject({ mode: 'TIMES', intervalSec: 60, updatedAt: received.toISOString() });
    expect(r!.vehicles.map((v) => v.truckCode)).toEqual(['T01']);
  });
});

describe('an unobserved GPS time is corrected by a better trail; an observed one never moves', () => {
  const ev = (observed: boolean, at: string) => ({ at: muscat(at), payloadJson: { observed } });
  it('the rule', () => {
    expect(correctGpsEvent(ev(false, '07:52'), { at: muscat('07:44'), observed: true })).toBe(true);
    expect(correctGpsEvent(ev(false, '07:52'), { at: muscat('07:50'), observed: false })).toBe(true);
    expect(correctGpsEvent(ev(false, '07:52'), { at: new Date(muscat('07:52').getTime() - 30_000), observed: false })).toBe(false);
    expect(correctGpsEvent(ev(true, '07:52'), { at: muscat('07:44'), observed: true })).toBe(false);
    expect(correctGpsEvent({ at: muscat('07:52'), payloadJson: null }, { at: muscat('07:44'), observed: true })).toBe(false);
  });
});

describe('Settings: the GPS tracking card (company admin only)', () => {
  // The other cards' fields as in settings-form-scope.spec.ts.
  const base = {
    shiftStartMin: 420, driverShiftMaxMinutes: 660, overtimeAfterMin: 540, driverBreakMinutes: 60, driverBreakFromMin: 720,
    driverBreakToMin: 840, reloadMinutes: 30, loadingMinPerCase: 0, serviceMinPerCase: 0, defaultServiceTimeMin: 10,
    maxTripsPerTruck: 3, splitDeliveries: true, planningCutoffMin: 1080, dateOrder: 'DMY', fuelPricePerLitre: 0,
    driverCostPerHour: 2, overtimeCostPerHour: 1, prefWindowPenaltyPerMin: 0.05, distanceProvider: 'HAVERSINE',
    roadTimeFactor: 1.25, distanceMultiplier: 1.3, avgSpeedKmh: 40,
  };
  const config = { ivmsMode: 'TIMES', ivmsPollSec: 60, ivmsRoutePullMin: 60, ivmsFromMin: 300, ivmsToMin: 1380, ivmsDailyCallBudget: 100, ivmsStopRadiusM: 100, ivmsStopDwellMin: 3, ivmsDepotRadiusM: 300, ivmsTrailDays: 2 };
  const render = (scope: 'ADMIN' | 'DISPATCHER', extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(SettingsForm, {
        initial: { tenant: { name: 'T', country: 'Oman', currency: 'OMR', primaryUnit: 'CASES' }, config: { ...base, ...config, ...extra } } as never,
        effective: [],
        profiles: [],
        scope,
      }),
    );

  it('the admin sees the mode, the allowance and what it means; every IVMS setting has its input', () => {
    const html = render('ADMIN');
    expect(html).toContain('data-testid="gps-tracking-settings"');
    for (const k of Object.keys(config)) expect(html, k).toContain(k === 'ivmsMode' ? 'name="ivmsMode"' : `id="${k}"`);
    expect(html).toMatch(/At 100 calls a day: live positions about every 19 min while a truck has a load out; 38 history pulls a day/);
    expect(render('ADMIN', { ivmsMode: 'OFF' })).not.toContain('data-testid="gps-pace"');
  });

  it('GPS alerts (owner request 18 Oct 2026): the fourth mode is offered with its plain description, and pulls history as TIMES', () => {
    const html = render('ADMIN', { ivmsMode: 'ALERTS' });
    expect(html).toContain('value="ALERTS"');
    expect(html).toContain('Live map, GPS times and GPS alerts');
    expect(html).toContain('Map + GPS times + alerts use GPS times');
    expect(html).toMatch(/At 100 calls a day: live positions about every 19 min while a truck has a load out; 38 history pulls a day/);
  });

  it('the dispatcher never sees it', () => {
    const html = render('DISPATCHER');
    expect(html).not.toContain('gps-tracking-settings');
    expect(html).not.toContain('ivmsMode');
  });
});
