/**
 * IVMS live link (16 Oct 2026): the background calls to Ayun (lib/ivms/poll.ts) on the in-memory store and
 * a fake Ayun (tests/lib/ivms-fakes.ts): never a real call, never a database.
 * - OFF (or no variables, or the kill switch): nothing is called or written, and the timer is not started;
 * - only trucks with a tracker and a load out are asked about (M7); positions of the others are deleted;
 *   after the operating hours only a DISPATCHED load counts;
 * - MAP: live positions for the map only; a fix running ahead never moves the latest position; positions
 *   never reach the trail, the only source of GPS times (H5);
 * - TIMES: history pulls per truck-day from the hours' start, every ivmsRoutePullMin while a load is out
 *   (overlapping 10 min), and once over the whole day after the last load was completed;
 * - the allowance (H2): a simulated day at 100, 1,000 and 3,000 calls with the backstop on - never over
 *   the allowance or a class's share, no class starved (the map keeps moving until the trucks are back,
 *   every truck-day gets its final pull), the backstop only from 1,000 a day;
 * - `force` never spends a low allowance early; the lease lets one tick call at a time; LIMIT waits for
 *   the provider's midnight, AUTH an hour, anything else backs off; NO_PERMISSION asks once for `*`;
 * - the shutdown aborts a call in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classShares } from '@/lib/ivms/budget';
import { _resetIvmsProcessState, planTick, routeWindow, runIvmsTick, startIvmsTimer, stopIvms, type RouteDay } from '@/lib/ivms/poll';
import type { FleetTruck } from '@/lib/ivms/store';
import { company, fakeAyun, IMEI_A, IMEI_B, imeiOf, ivmsTestEnv, MemoryIvmsStore, ORIGIN, providerTime } from './ivms-fakes';

const DAY = '2026-10-16';
/** Local Muscat time (UTC+4) on the scenario day as an instant. */
const muscat = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00+04:00`);
const ENV = ivmsTestEnv();
/** Most cases: no webhook secret, so no backstop call joins the ones under test. */
const ENV_NO_HOOK = ivmsTestEnv({ AYUN_WEBHOOK_SECRET: undefined });

type Status = FleetTruck['days'][number]['loads'][number]['status'];
const truck = (i: number, statuses: Status[], opts: { imei?: string; date?: string; completedAt?: Date } = {}): FleetTruck => ({
  truckId: `t${i}`,
  imei: opts.imei ?? imeiOf(i),
  depotId: 'd1',
  days: [{ date: opts.date ?? DAY, loads: statuses.map((s, n) => ({ loadNo: n + 1, status: s, statusChangedAt: s === 'COMPLETED' ? (opts.completedAt ?? null) : null })) }],
});

let logs: string[] = [];
beforeEach(() => {
  _resetIvmsProcessState();
  logs = [];
  for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetIvmsProcessState();
});

function setup(c = company(), fleet: FleetTruck[] = [truck(1, ['DISPATCHED'], { imei: IMEI_A })], override?: Parameters<typeof fakeAyun>[1], env = ENV_NO_HOOK) {
  const store = new MemoryIvmsStore(c);
  store.fleetOf = () => fleet;
  let clock = muscat('10:00');
  const ayun = fakeAyun(() => clock, override);
  const tick = (now: Date, opts: { force?: boolean } = {}, owner = 'me') => {
    clock = now;
    return runIvmsTick(now, opts, { store, env, fetchImpl: ayun.fetch, owner, random: () => 0.5 });
  };
  return { store, ayun, tick };
}

describe('OFF: nothing changes', () => {
  it('ivmsMode OFF: null, only the setting was read, no call, no write', async () => {
    const { store, ayun, tick } = setup(company({ mode: 'OFF' }));
    expect(await tick(muscat('10:00'))).toBeNull();
    expect(store.touched).toEqual(['company']);
    expect(ayun.calls).toEqual([]);
  });

  it('no variables, an unusable one, or the kill switch: null without even reading the setting', async () => {
    const store = new MemoryIvmsStore(company({ mode: 'TIMES' }));
    const ayun = fakeAyun(() => muscat('10:00'));
    for (const env of [ivmsTestEnv({ AYUN_API_KEY: undefined, AYUN_BASE_URL: undefined, AYUN_TENANT_SLUG: undefined }), ivmsTestEnv({ ROUTEIQ_DISABLE_IVMS: '1' }), ivmsTestEnv({ AYUN_BASE_URL: 'http://provider.example' })]) {
      expect(await runIvmsTick(muscat('10:00'), {}, { store, env, fetchImpl: ayun.fetch })).toBeNull();
    }
    expect(store.touched).toEqual([]);
    expect(ayun.calls).toEqual([]);
  });

  it('a company other than AYUN_TENANT_SLUG is never polled', async () => {
    const { store, ayun, tick } = setup(company({ slug: 'other-co' }));
    expect(await tick(muscat('10:00'))).toBeNull();
    expect(ayun.calls).toEqual([]);
    expect(store.state).toBeNull();
  });

  it('the timer is not started without the variables or with the kill switch', () => {
    expect(startIvmsTimer(ivmsTestEnv({ AYUN_API_KEY: undefined }))).toBe(false);
    expect(startIvmsTimer(ivmsTestEnv({ ROUTEIQ_DISABLE_IVMS: '1' }))).toBe(false);
    expect(startIvmsTimer(ENV)).toBe(true);
    expect(startIvmsTimer(ENV)).toBe(false); // once per process
    stopIvms();
  });
});

describe('who is asked about (M7)', () => {
  it('only trucks with a load out; after the hours only a DISPATCHED one; history only once a load left', () => {
    const fleet = [truck(1, ['LOCKED']), truck(2, ['DISPATCHED']), truck(3, ['PLANNED']), truck(4, ['COMPLETED', 'LOADING']), truck(5, ['COMPLETED'])];
    const day = planTick(company({ mode: 'TIMES' }), fleet, muscat('10:00'));
    expect(day.mapTrucks.map((t) => t.truckId)).toEqual(['t1', 't2', 't4']);
    expect(day.routeDays.map((d) => [d.truckId, d.kind])).toEqual([
      ['t2', 'REGULAR'],
      ['t4', 'REGULAR'],
      ['t5', 'FINAL'],
    ]);
    const night = planTick(company({ mode: 'TIMES' }), fleet, muscat('23:30'));
    expect(night.mapTrucks.map((t) => t.truckId)).toEqual(['t2']);
    expect(night.routeDays.map((d) => d.truckId)).toEqual(['t2']);
    expect(planTick(company({ mode: 'MAP' }), fleet, muscat('10:00')).routeDays).toEqual([]);
    // GPS alerts (owner request 18 Oct 2026): ALERTS does all TIMES does.
    expect(planTick(company({ mode: 'ALERTS' }), fleet, muscat('10:00'))).toEqual(day);
  });

  it('asks for the IMEIs of the trucks out only, and deletes the positions of trucks no longer out', async () => {
    const fleet = [truck(1, ['DISPATCHED'], { imei: IMEI_A }), truck(2, ['PLANNED'], { imei: IMEI_B })];
    const { store, ayun, tick } = setup(company({ dailyBudget: 3000 }), fleet);
    store.positions.set('t2', { fix: { imei: IMEI_B, fixAt: muscat('08:00'), serverAt: null, lat: 10.5, lng: 20.5, speedKmh: 0, heading: 0, ignition: null, flags: [] }, receivedAt: muscat('08:00'), movedAt: null });
    const r = await tick(muscat('10:00'));
    expect(r?.map).toMatchObject({ trucks: 1, called: true, written: 1, notReturned: 0 });
    expect(ayun.calls.map((c) => [c.cmd, c.args[0]])).toEqual([['OBJECT_GET_LOCATIONS', IMEI_A]]);
    expect([...store.positions.keys()]).toEqual(['t1']);
    // Nothing out any more: no call, every position deleted.
    fleet[0]!.days[0]!.loads[0]!.status = 'COMPLETED';
    const done = await tick(muscat('10:05'));
    expect(done?.skipped).toBe('NOTHING_OUT');
    expect(ayun.calls).toHaveLength(1);
    expect(store.positions.size).toBe(0);
  });

  it("yesterday's load nobody closed never keeps a truck on the map: LOCKED or LOADING not at all, DISPATCHED only in the hours (first review LOW)", () => {
    const YDAY = '2026-10-15';
    const fleet = [truck(1, ['LOCKED'], { date: YDAY }), truck(2, ['LOADING'], { date: YDAY }), truck(3, ['DISPATCHED'], { date: YDAY }), truck(4, ['DISPATCHED'])];
    expect(planTick(company({ mode: 'MAP' }), fleet, muscat('10:00')).mapTrucks.map((t) => t.truckId)).toEqual(['t3', 't4']);
    // After the hours: only today's loads on the road.
    expect(planTick(company({ mode: 'MAP' }), fleet, muscat('23:30')).mapTrucks.map((t) => t.truckId)).toEqual(['t4']);
    expect(planTick(company({ mode: 'MAP' }), fleet, muscat('02:00', '2026-10-17')).mapTrucks).toEqual([]);
  });

  it('a parked truck asked about again keeps its fix, and its "read" time moves (second review L-5: no false "positions delayed")', async () => {
    const { store, tick } = setup(company({ dailyBudget: 3000 }), [truck(1, ['DISPATCHED'], { imei: IMEI_A })], (cmd) =>
      cmd === 'OBJECT_GET_LOCATIONS'
        ? { body: JSON.stringify({ [IMEI_A]: { dt_server: providerTime(muscat('09:50')), dt_tracker: providerTime(muscat('09:50')), lat: '10.5', lng: '20.5', speed: '0', loc_valid: '1' } }) }
        : undefined,
    );
    await tick(muscat('10:00'));
    await tick(muscat('10:05'));
    expect(store.positions.get('t1')).toMatchObject({ receivedAt: muscat('10:05') });
    expect(store.positions.get('t1')!.fix.fixAt).toEqual(muscat('09:50'));
  });
});

describe('MAP: positions for the map only', () => {
  it('a fix running ahead of the clock never moves the latest position; an older fix never replaces a newer one', async () => {
    let fixAt = muscat('10:00');
    const { store, tick } = setup(company({ dailyBudget: 3000 }), [truck(1, ['DISPATCHED'], { imei: IMEI_A })], (cmd) =>
      cmd === 'OBJECT_GET_LOCATIONS'
        ? { body: JSON.stringify({ [IMEI_A]: { dt_tracker: providerTime(fixAt), dt_server: providerTime(fixAt), lat: '10.5', lng: '20.5', speed: '30', angle: '0', loc_valid: '1' } }) }
        : undefined,
    );
    await tick(muscat('10:00'));
    expect(store.positions.get('t1')?.fix.fixAt).toEqual(muscat('10:00'));
    fixAt = muscat('10:30'); // 29 min ahead of the clock below
    await tick(muscat('10:01'));
    expect(store.positions.get('t1')?.fix.fixAt).toEqual(muscat('10:00'));
    fixAt = muscat('09:00');
    await tick(muscat('10:02'));
    expect(store.positions.get('t1')?.fix.fixAt).toEqual(muscat('10:00'));
    expect(store.trail.size).toBe(0); // live positions never reach the trail (H5)
  });

  it('records the provider\'s clock skew (a provider sending local time shows about +4 h)', async () => {
    const { store, tick } = setup(company({ dailyBudget: 3000 }), [truck(1, ['DISPATCHED'], { imei: IMEI_A })], (cmd) =>
      cmd === 'OBJECT_GET_LOCATIONS'
        ? { body: JSON.stringify({ [IMEI_A]: { dt_tracker: '2026-10-16 09:59:50', dt_server: '2026-10-16 10:00:00', lat: '10.5', lng: '20.5', speed: '0', angle: '0' } }) }
        : undefined,
    );
    await tick(muscat('10:00'));
    expect(store.state?.providerSkewSec).toBe(14400);
    expect(store.positions.size).toBe(0); // every fix CLOCK_AHEAD: the map keeps nothing until the offset is set
  });

  it('NO_PERMISSION: the next call asks once for `*` and keeps the mapped trackers only', async () => {
    let n = 0;
    const { store, ayun, tick } = setup(company({ dailyBudget: 3000 }), [truck(1, ['DISPATCHED'], { imei: IMEI_A })], (cmd, args) => {
      if (cmd !== 'OBJECT_GET_LOCATIONS') return undefined;
      n++;
      if (n === 1) return { body: 'ERROR: no permission to access this IMEI' };
      expect(args[0]).toBe('*');
      const fix = { dt_tracker: providerTime(muscat('10:01')), dt_server: providerTime(muscat('10:01')), lat: '10.5', lng: '20.5', speed: '0', angle: '0', name: 'Example object B' };
      return { body: JSON.stringify({ [IMEI_A]: fix, [IMEI_B]: fix }) };
    });
    expect((await tick(muscat('10:00')))?.map?.error).toBe('NO_PERMISSION');
    expect(store.state?.nextTryAt).toBeNull(); // no backoff for one tracker's permission
    await tick(muscat('10:01'));
    expect(ayun.calls.map((c) => c.args[0])).toEqual([IMEI_A, '*']);
    expect([...store.positions.keys()]).toEqual(['t1']);
    await tick(muscat('10:02'));
    expect(ayun.calls[2]!.args[0]).toBe(IMEI_A); // `*` only once
  });
});

describe('failures', () => {
  it('LIMIT: no call until the provider\'s midnight (04:01 in Muscat), and the failed call counted', async () => {
    const { store, ayun, tick } = setup(company({ dailyBudget: 3000 }), undefined, () => ({ body: 'ERROR: API call limit exceeded' }));
    expect((await tick(muscat('10:00')))?.map?.error).toBe('LIMIT');
    expect(store.state).toMatchObject({ mapCalls: 1, lastError: 'LIMIT', failures: 1 });
    expect(store.state?.nextTryAt?.toISOString()).toBe('2026-10-17T00:01:00.000Z');
    expect((await tick(muscat('22:00')))?.skipped).toBe('LEASE_OR_BACKOFF');
    expect(ayun.calls).toHaveLength(1);
    expect(logs).toEqual(['ivms: MAP call failed (LIMIT)']);
  });

  it('AUTH pauses an hour; a timeout backs off and stops the tick (no history pull after a failed map call)', async () => {
    const auth = setup(company({ dailyBudget: 3000 }), undefined, () => ({ body: 'ERROR: wrong API key' }));
    await auth.tick(muscat('10:00'));
    expect(auth.store.state?.nextTryAt).toEqual(muscat('11:00'));
    const net = setup(company({ dailyBudget: 3000, mode: 'TIMES' }), undefined, () => ({ status: 503, body: 'x' }));
    const r = await net.tick(muscat('10:00'));
    expect(r?.map?.error).toBe('HTTP_ERROR');
    expect(r?.route).toBeUndefined();
    expect(net.ayun.calls).toHaveLength(1);
    expect(net.store.state?.nextTryAt).toEqual(new Date(muscat('10:00').getTime() + 60_000));
    // After the backoff the next success clears it.
    const ok = setup(company({ dailyBudget: 3000 }));
    ok.store.state = { ...net.store.state!, leaseOwner: null, leaseUntil: null };
    await ok.tick(muscat('10:02'));
    expect(ok.store.state).toMatchObject({ failures: 0, nextTryAt: null });
  });

  it('never logs a URL, the key or an answer', async () => {
    const { tick } = setup(company({ dailyBudget: 3000, mode: 'TIMES' }), undefined, () => ({ status: 500, body: 'secret answer' }));
    await tick(muscat('10:00'));
    expect(logs.join('\n')).not.toMatch(/provider\.example|api\.php|key=|secret answer|test-key/);
  });
});

describe('the lease and `force`', () => {
  it('two ticks at the same moment (a deploy overlap): one call', async () => {
    const { ayun, store } = setup(company({ dailyBudget: 3000 }));
    const go = (owner: string) => runIvmsTick(muscat('10:00'), {}, { store, env: ENV_NO_HOOK, fetchImpl: ayun.fetch, owner });
    const held = await store.acquireLease('tA', 'other', muscat('10:00'), 30_000);
    expect(held).not.toBeNull();
    expect((await go('me'))?.skipped).toBe('LEASE_OR_BACKOFF');
    await store.releaseLease('tA', 'other');
    await Promise.all([go('a'), go('b')]);
    expect(ayun.calls.filter((c) => c.cmd === 'OBJECT_GET_LOCATIONS')).toHaveLength(1);
    expect((store.state as { leaseOwner: string | null } | null)?.leaseOwner).toBeNull(); // released after the tick (M13)
  });

  it('`force` calls now while the allowance is ample, never while it is stretched (H2)', async () => {
    const ample = setup(company({ dailyBudget: 3000 }));
    await ample.tick(muscat('10:00'));
    await ample.tick(new Date(muscat('10:00').getTime() + 20_000), { force: true });
    expect(ample.ayun.calls).toHaveLength(2);
    const low = setup(company({ dailyBudget: 100 }));
    await low.tick(muscat('10:00'));
    await low.tick(new Date(muscat('10:00').getTime() + 20_000), { force: true });
    await low.tick(new Date(muscat('10:00').getTime() + 300_000), { force: true });
    expect(low.ayun.calls).toHaveLength(1);
  });

  it('the shutdown aborts a call in flight (TIMEOUT, backoff), and no new tick starts', async () => {
    const store = new MemoryIvmsStore(company({ dailyBudget: 3000 }));
    store.fleetOf = () => [truck(1, ['DISPATCHED'], { imei: IMEI_A })];
    const hang = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const p = runIvmsTick(muscat('10:00'), {}, { store, env: ENV_NO_HOOK, fetchImpl: hang, owner: 'me' });
    await new Promise((r) => setTimeout(r, 20));
    stopIvms();
    const r = await p;
    expect(r?.map?.error).toBe('TIMEOUT');
    expect(store.state?.leaseOwner).toBeNull();
  });
});

describe('TIMES: history pulls (H5)', () => {
  const HOURS = { timezone: 'Asia/Muscat', fromMin: 300, toMin: 1380 };
  const rd = (kind: RouteDay['kind'], lastCompletedAt: Date | null = null): RouteDay => ({ truckId: 't1', imei: IMEI_A, date: DAY, kind, lastCompletedAt });

  it('the window: from the hours\' start of the delivery date; then overlapping the last pull by 10 min; the final pull the whole day', () => {
    expect(routeWindow(rd('REGULAR'), undefined, HOURS, muscat('09:00'))).toEqual({ from: muscat('05:00'), to: muscat('09:00') });
    const row = { truckId: 't1', date: DAY, pulledTo: muscat('09:00'), lastPullAt: muscat('09:00'), pulls: 1, finalPullAt: null, suppressedAt: null, trailFrom: null };
    expect(routeWindow(rd('REGULAR'), row, HOURS, muscat('10:00'))).toEqual({ from: muscat('08:50'), to: muscat('10:00') });
    expect(routeWindow(rd('FINAL', muscat('17:00')), row, HOURS, muscat('20:00'))).toEqual({ from: muscat('05:00'), to: muscat('17:30') });
    // A load never closed: nothing after the next day's start.
    const stuck = { ...row, pulledTo: muscat('05:00', '2026-10-17') };
    expect(routeWindow(rd('REGULAR'), stuck, HOURS, muscat('09:00', '2026-10-17'))).toBeNull();
  });

  it('never from before the tracker was mapped to the truck (second review M-1: a tracker moved from another truck)', () => {
    const fresh = { truckId: 't1', date: DAY, pulledTo: null, lastPullAt: null, pulls: 0, finalPullAt: null, suppressedAt: null, trailFrom: muscat('11:30') };
    expect(routeWindow(rd('REGULAR'), fresh, HOURS, muscat('12:00'))).toEqual({ from: muscat('11:30'), to: muscat('12:00') });
    expect(routeWindow(rd('FINAL', muscat('17:00')), fresh, HOURS, muscat('20:00'))).toEqual({ from: muscat('11:30'), to: muscat('17:30') });
    // Mapped after the truck-day's end: nothing to ask for.
    expect(routeWindow(rd('REGULAR'), { ...fresh, trailFrom: muscat('06:00', '2026-10-17') }, HOURS, muscat('06:30', '2026-10-17'))).toBeNull();
  });

  it('pulls while out, final 10 min after the last completion, then nothing; the trail holds the history points only', async () => {
    const fleet = [truck(1, ['DISPATCHED'], { imei: IMEI_A })];
    const { store, ayun, tick } = setup(company({ mode: 'TIMES', dailyBudget: 3000, routePullMin: 30 }), fleet);
    await tick(muscat('09:00'));
    const routes = () => ayun.calls.filter((c) => c.cmd === 'OBJECT_GET_ROUTE');
    expect(routes().map((c) => c.args)).toEqual([[IMEI_A, '20261016010000', '20261016050000', '60']]);
    await tick(muscat('09:20'));
    expect(routes()).toHaveLength(1);
    await tick(muscat('09:31'));
    expect(routes()[1]!.args.slice(1, 3)).toEqual(['20261016045000', '20261016053100']);
    // Completed at 11:00: the final pull at 11:10, over the whole day.
    fleet[0]!.days[0]!.loads[0] = { loadNo: 1, status: 'COMPLETED', statusChangedAt: muscat('11:00') };
    await tick(muscat('11:05'));
    expect(routes()).toHaveLength(2);
    await tick(muscat('11:10'));
    expect(routes()[2]!.args.slice(1, 3)).toEqual(['20261016010000', '20261016071000']);
    expect(store.days.get(`t1|${DAY}`)?.finalPullAt).toEqual(muscat('11:10'));
    await tick(muscat('12:00'));
    expect(routes()).toHaveLength(3);
    const pts = [...store.trail.get('t1')!.values()];
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.every((p) => p.lng === ORIGIN.lng)).toBe(true);
  });

  it('a suppressed truck-day (undo, mismatch) is not pulled', async () => {
    const { store, ayun, tick } = setup(company({ mode: 'TIMES', dailyBudget: 3000 }));
    store.days.set(`t1|${DAY}`, { truckId: 't1', date: DAY, pulledTo: null, lastPullAt: null, pulls: 0, finalPullAt: null, suppressedAt: muscat('08:00'), trailFrom: null });
    await tick(muscat('09:00'));
    expect(ayun.calls.map((c) => c.cmd)).toEqual(['OBJECT_GET_LOCATIONS']);
  });

  it('MAP mode never pulls history', async () => {
    const { ayun, tick } = setup(company({ mode: 'MAP', dailyBudget: 3000 }));
    await tick(muscat('09:00'));
    expect(ayun.calls.map((c) => c.cmd)).toEqual(['OBJECT_GET_LOCATIONS']);
  });
});

describe('the backstop for missed depot webhooks', () => {
  it('only from 1,000 a day with a webhook secret: every 15 min, the webhook\'s rows and keys, repeats not stored twice', async () => {
    const events = JSON.stringify([
      ['zone_in', 'Depot IN (Example depot zone)', IMEI_A, 'Example object A', '2026-10-16 05:55:00', '10.5001', '20.5001', '0', '0', '5', []],
      ['zone_out', 'Fuel OUT (Example fuel zone)', IMEI_A, 'Example object A', '2026-10-16 05:58:00', '10.6', '20.6', '0', '0', '5', []],
    ]);
    const { store, ayun, tick } = setup(company({ dailyBudget: 1000 }), undefined, (cmd) => (cmd === 'OBJECT_GET_LAST_EVENTS' ? { body: events } : undefined), ENV);
    store.depots = [{ depotId: 'd1', zoneName: 'example DEPOT zone', lat: 10.5, lng: 20.5 }];
    await tick(muscat('10:00'));
    expect(store.events.map((e) => [e.kind, e.origin, e.depotId, e.outcome])).toEqual([
      ['DEPOT_IN', 'BACKSTOP', 'd1', null],
      ['ZONE_OUT', 'BACKSTOP', null, 'NO_DEPOT'],
    ]);
    await tick(muscat('10:10'));
    await tick(muscat('10:15'));
    expect(ayun.calls.filter((c) => c.cmd === 'OBJECT_GET_LAST_EVENTS')).toHaveLength(2);
    expect(store.events).toHaveLength(2);
    expect(JSON.stringify(store.events)).not.toContain('Example object');
    const none = setup(company({ dailyBudget: 999 }), undefined, undefined, ENV);
    await none.tick(muscat('10:00'));
    expect(none.ayun.calls.map((c) => c.cmd)).toEqual(['OBJECT_GET_LOCATIONS']);
    const noSecret = setup(company({ dailyBudget: 3000 }));
    await runIvmsTick(muscat('10:00'), {}, { store: noSecret.store, env: ivmsTestEnv({ AYUN_WEBHOOK_SECRET: undefined }), fetchImpl: noSecret.ayun.fetch });
    expect(noSecret.ayun.calls.map((c) => c.cmd)).toEqual(['OBJECT_GET_LOCATIONS']);
  });
});

describe('a simulated day with the backstop on (H2: no class starved, never over the allowance)', () => {
  /** 9 trucks: Load 1 locked 05:00, out 06:00-12:00; Load 2 locked 12:00, out 13:00-22:00 (local). */
  function dayFleet(now: Date): FleetTruck[] {
    const at = (h: string) => muscat(h).getTime();
    const t = now.getTime();
    const st = (lock: string, out: string, back: string): FleetTruck['days'][number]['loads'][number] =>
      t < at(lock) ? { loadNo: 0, status: 'PLANNED', statusChangedAt: null } : t < at(out) ? { loadNo: 0, status: 'LOCKED', statusChangedAt: null } : t < at(back) ? { loadNo: 0, status: 'DISPATCHED', statusChangedAt: null } : { loadNo: 0, status: 'COMPLETED', statusChangedAt: new Date(at(back)) };
    return Array.from({ length: 9 }, (_, i) => ({
      truckId: `t${i}`,
      imei: imeiOf(i),
      depotId: 'd1',
      days: [{ date: DAY, loads: [{ ...st('05:00', '06:00', '12:00'), loadNo: 1 }, { ...st('12:00', '13:00', '22:00'), loadNo: 2 }] }],
    }));
  }

  for (const [budget, maxGapSec] of [
    [100, 30 * 60],
    [1000, 3 * 60],
    [3000, 75],
  ] as const) {
    it(`${budget} a day`, async () => {
      const c = company({ mode: 'TIMES', dailyBudget: budget });
      const store = new MemoryIvmsStore(c);
      store.fleetOf = dayFleet;
      let clock = new Date(0);
      const ayun = fakeAyun(() => clock);
      const start = Date.parse(`${DAY}T00:00:00Z`);
      for (let t = start; t < start + 24 * 3600_000; t += 15_000) {
        clock = new Date(t);
        await runIvmsTick(clock, {}, { store, env: ENV, fetchImpl: ayun.fetch, owner: 'sim', random: () => 0.5 });
      }
      const shares = classShares(budget, 'TIMES', true);
      const count = (cls: string) => store.claims.filter((x) => x.cls === cls).length;
      // Every call was counted first, and the counts stay inside the allowance and each share.
      expect(ayun.calls).toHaveLength(store.claims.length);
      expect(store.claims.length).toBeLessThanOrEqual(budget);
      for (const cls of ['MAP', 'ROUTE', 'EVENTS'] as const) expect(count(cls), cls).toBeLessThanOrEqual(shares[cls]);
      // Nothing before the hours (05:00) and nothing once every truck is back (22:00) but the final pulls.
      expect(store.claims[0]!.at.getTime()).toBeGreaterThanOrEqual(muscat('05:00').getTime());
      const maps = store.claims.filter((x) => x.cls === 'MAP').map((x) => x.at.getTime());
      expect(Math.max(...maps)).toBeLessThan(muscat('22:00').getTime());
      // The map keeps moving all day: no gap longer than the pacing allows, still moving in the last hour.
      const gaps = maps.slice(1).map((m, i) => (m - maps[i]!) / 1000);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(maxGapSec);
      expect(Math.max(...maps)).toBeGreaterThan(muscat('21:00').getTime());
      // Every truck-day got its final pull over the whole day, and history points in the trail.
      for (let i = 0; i < 9; i++) {
        expect(store.days.get(`t${i}|${DAY}`)?.finalPullAt, `t${i}`).toBeTruthy();
        expect(store.trail.get(`t${i}`)?.size ?? 0, `t${i}`).toBeGreaterThan(0);
      }
      // The backstop only from 1,000 a day; never more often than every 15 min.
      const ev = store.claims.filter((x) => x.cls === 'EVENTS').map((x) => x.at.getTime());
      if (budget < 1000) expect(ev).toEqual([]);
      else {
        expect(ev.length).toBeGreaterThan(10);
        expect(Math.min(...ev.slice(1).map((e, i) => e - ev[i]!))).toBeGreaterThanOrEqual(15 * 60_000);
      }
      if (budget === 3000) expect(count('ROUTE')).toBeGreaterThanOrEqual(9 * 14);
      // Nobody is out at the end: no live position is kept.
      expect(store.positions.size).toBe(0);
    }, 60_000);
  }
});
