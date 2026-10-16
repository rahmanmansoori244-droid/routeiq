/**
 * IVMS live link (16 Oct 2026): the provider's answers read into RouteIQ's shapes (lib/ivms/parse.ts) and
 * the idempotency key of a zone event (lib/ivms/dedupe.ts), on hand-written fake answers
 * (tests/fixtures/ivms/). Checked: every value may be a string; `[]` is an empty answer; UTC times plus
 * the channel's offset; invalid, (0, 0), clock-ahead and delayed fixes; unmapped IMEIs dropped unread;
 * the provider's object name, plate, driver and the like never in a result; zone names from the webhook or
 * the description; the time window of a zone event; the same key from the webhook and the backstop.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanZoneName,
  EVENT_MAX_AGE_SEC,
  formatProviderTime,
  headingOf,
  ignitionOf,
  isImei,
  num,
  parseLastEvents,
  parseLocations,
  parseObjects,
  parseProviderTime,
  parseRoute,
  providerSkewSec,
  speedOf,
  suggestedOffsetMin,
  validLatLng,
  zoneEventOf,
  zoneFromDesc,
  zoneKey,
} from '@/lib/ivms/parse';
import { zoneEventDedupeKey } from '@/lib/ivms/dedupe';
import { IMEI_A, IMEI_B } from './ivms-fakes';

const FIX = path.resolve(__dirname, '../fixtures/ivms');
const json = (f: string): unknown => JSON.parse(readFileSync(path.join(FIX, f), 'utf8'));
const NOW = new Date('2026-10-16T06:05:00Z');

describe('times', () => {
  it('reads "YYYY-MM-DD HH:MM:SS" as UTC, and adds the channel offset (Muscat local time: -240)', () => {
    expect(parseProviderTime('2026-10-16 06:04:45')?.toISOString()).toBe('2026-10-16T06:04:45.000Z');
    expect(parseProviderTime('2026-10-16T06:04:45')?.toISOString()).toBe('2026-10-16T06:04:45.000Z');
    expect(parseProviderTime(' 2026-10-16 10:04:45 ', -240)?.toISOString()).toBe('2026-10-16T06:04:45.000Z');
  });

  it('refuses anything else: PHP empty dates, impossible dates, other shapes, non-strings', () => {
    for (const v of ['0000-00-00 00:00:00', '2026-02-30 10:00:00', '2026-10-16 24:00:00', '2026-10-16', String(1.6e9), '', null, 1.6e9, undefined]) {
      expect(parseProviderTime(v), String(v)).toBeNull();
    }
  });

  it('writes a request time as digits only, the offset taken off (the inverse)', () => {
    const t = new Date('2026-10-16T06:04:45Z');
    expect(formatProviderTime(t)).toBe('20261016060445');
    expect(formatProviderTime(t, -240)).toBe('20261016100445');
    expect(parseProviderTime('2026-10-16 10:04:45', -240)?.getTime()).toBe(t.getTime());
  });
});

describe('values', () => {
  it('numbers from numbers or plain decimal strings only', () => {
    expect([num('23.5'), num('-0.25'), num(' 12 '), num(7), num('.5')]).toEqual([23.5, -0.25, 12, 7, 0.5]);
    for (const v of ['1e3', 'NaN', 'Infinity', '12abc', '', null, {}, Number.NaN]) expect(num(v), String(v)).toBeNull();
  });

  it('positions inside the ranges and never (0, 0); speed 0-250; heading 0-359; ignition from params.acc', () => {
    expect(validLatLng(10.5, 20.5)).toBe(true);
    expect([validLatLng(0, 0), validLatLng(91, 1), validLatLng(1, -181), validLatLng(null, 1)]).toEqual([false, false, false, false]);
    expect([speedOf('42'), speedOf('-1'), speedOf('251'), speedOf('x')]).toEqual([42, null, null, null]);
    expect([headingOf('360'), headingOf('93.4'), headingOf('-1'), headingOf('361')]).toEqual([0, 93, null, null]);
    expect([ignitionOf({ acc: '1' }), ignitionOf({ acc: '0' }), ignitionOf({ acc: 1 }), ignitionOf([]), ignitionOf({}), ignitionOf(null)]).toEqual([true, false, true, null, null, null]);
    expect([isImei(IMEI_A), isImei('123456789'), isImei(`${IMEI_A}x`), isImei(Number(IMEI_A))]).toEqual([true, false, false, false]);
  });
});

describe('OBJECT_GET_LOCATIONS', () => {
  it('reads the mapped trackers of the answer; the provider name and every other field never reach the result', () => {
    const r = parseLocations(json('locations.json'), new Set([IMEI_A]), NOW)!;
    expect(r.unmapped).toBe(1); // IMEI_B: not mapped, dropped unread
    expect(r.invalid).toBe(0);
    expect(r.fixes).toEqual([
      {
        imei: IMEI_A,
        fixAt: new Date('2026-10-16T06:04:45Z'),
        serverAt: new Date('2026-10-16T06:04:50Z'),
        lat: 10.512345,
        lng: 20.523456,
        speedKmh: 42,
        heading: 93,
        ignition: true,
        flags: [],
      },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/Example object|name|gsmlev|odo|altitude/);
  });

  it('flags an invalid fix (loc_valid 0) and a delayed one (received 10+ min after the fix); `params: []` is no ignition', () => {
    const r = parseLocations(json('locations.json'), new Set([IMEI_A, IMEI_B]), NOW)!;
    const b = r.fixes.find((f) => f.imei === IMEI_B)!;
    expect(b.flags).toEqual(['INVALID_FIX', 'DELAYED']);
    expect(b.ignition).toBeNull();
    expect(b.heading).toBe(0);
  });

  it('flags a fix whose clock runs more than 2 min ahead (and the skew shows a provider not in UTC)', () => {
    const local = { [IMEI_A]: { dt_tracker: '2026-10-16 10:04:45', dt_server: '2026-10-16 10:04:50', lat: '10.5', lng: '20.5', speed: '0', angle: '0', loc_valid: '1' } };
    const wrong = parseLocations(local, new Set([IMEI_A]), NOW)!;
    expect(wrong.fixes[0]!.flags).toEqual(['CLOCK_AHEAD']);
    const skew = providerSkewSec(wrong.fixes, NOW);
    expect(skew).toBe(14390);
    expect(suggestedOffsetMin(skew)).toBe(-240);
    const right = parseLocations(local, new Set([IMEI_A]), NOW, -240)!;
    expect(right.fixes[0]!.flags).toEqual([]);
    expect(suggestedOffsetMin(providerSkewSec(right.fixes, NOW), -240)).toBeNull();
    // An offset set for a provider that does send UTC shifts every time 4 h back: the suggestion is 0 again.
    const utc = parseLocations({ [IMEI_A]: { ...local[IMEI_A], dt_tracker: '2026-10-16 06:04:45', dt_server: '2026-10-16 06:04:50' } }, new Set([IMEI_A]), NOW, -240)!;
    expect(providerSkewSec(utc.fixes, NOW)).toBe(-14410);
    expect(suggestedOffsetMin(providerSkewSec(utc.fixes, NOW), -240)).toBe(0);
  });

  it('[] and {} are "nothing"; a fix without a usable position or time is dropped; other shapes are not answers', () => {
    expect(parseLocations([], new Set([IMEI_A]), NOW)).toEqual({ fixes: [], unmapped: 0, invalid: 0 });
    expect(parseLocations({}, new Set([IMEI_A]), NOW)).toEqual({ fixes: [], unmapped: 0, invalid: 0 });
    const bad = { [IMEI_A]: { dt_tracker: '2026-10-16 06:00:00', lat: '0', lng: '0' } };
    expect(parseLocations(bad, new Set([IMEI_A]), NOW)).toEqual({ fixes: [], unmapped: 0, invalid: 1 });
    expect(parseLocations({ [IMEI_A]: { dt_tracker: '0000-00-00 00:00:00', lat: '10.5', lng: '20.5' } }, new Set([IMEI_A]), NOW)!.invalid).toBe(1);
    expect(parseLocations({ [IMEI_A]: 'x' }, new Set([IMEI_A]), NOW)!.invalid).toBe(1);
    for (const v of ['x', 3, null, [1]]) expect(parseLocations(v, new Set([IMEI_A]), NOW), String(v)).toBeNull();
  });
});

describe('OBJECT_GET_ROUTE', () => {
  it('reads the points of `route` only: valid, unique per time, sorted; (0, 0), empty dates and repeats are dropped', () => {
    const r = parseRoute(json('route.json'), NOW)!;
    expect(r.points.map((p) => p.fixAt.toISOString().slice(11, 16))).toEqual(['05:00', '05:01', '05:02', '05:04', '05:05']);
    expect(r.dropped).toBe(3);
    expect(r.points[1]).toEqual({ fixAt: new Date('2026-10-16T05:01:00Z'), lat: 10.501, lng: 20.501, speedKmh: 35, ignition: true });
    expect(r.points[3]!.ignition).toBe(false);
  });

  it('keeps only the window asked for, never a point ahead of the clock; the offset applies', () => {
    const w = { from: new Date('2026-10-16T05:01:00Z'), to: new Date('2026-10-16T05:04:00Z') };
    expect(parseRoute(json('route.json'), NOW, 0, w)!.points.map((p) => p.fixAt.toISOString().slice(11, 16))).toEqual(['05:01', '05:02', '05:04']);
    const early = new Date('2026-10-16T05:01:30Z');
    expect(parseRoute(json('route.json'), early)!.points.map((p) => p.fixAt.toISOString().slice(11, 16))).toEqual(['05:00', '05:01', '05:02']);
    const local = { route: [['2026-10-16 09:00:00', '10.5', '20.5', '0', '0', '0', []]] };
    expect(parseRoute(local, NOW, -240)!.points[0]!.fixAt.toISOString()).toBe('2026-10-16T05:00:00.000Z');
  });

  it('accepts points as objects, [] and an answer without points; refuses other shapes', () => {
    expect(parseRoute({ route: [{ dt_tracker: '2026-10-16 05:00:00', lat: 10.5, lng: 20.5, speed: 3, params: { acc: '0' } }] }, NOW)!.points).toHaveLength(1);
    expect(parseRoute([], NOW)).toEqual({ points: [], dropped: 0 });
    expect(parseRoute({ stops: [] }, NOW)).toEqual({ points: [], dropped: 0 });
    expect(parseRoute({ route: 'x' }, NOW)).toBeNull();
    expect(parseRoute('x', NOW)).toBeNull();
  });
});

describe('zone events (webhook and backstop)', () => {
  it('the zone name: the webhook field, else the description\'s last parentheses; cleaned, at most 80 characters', () => {
    expect(zoneFromDesc('Depot IN (Example depot zone)')).toBe('Example depot zone');
    expect(zoneFromDesc('Depot IN (North) (Example  depot\tzone) ')).toBe('Example depot zone');
    expect(zoneFromDesc('Long stop')).toBeNull();
    expect(cleanZoneName('  A\u0000 B  ')).toBe('A B');
    expect(cleanZoneName('x'.repeat(100))).toHaveLength(80);
    expect(zoneKey(' Example DEPOT zone ')).toBe('example depot zone');
  });

  it('keeps zone_in / zone_out of a valid IMEI within [now - 26 h, now + 2 min]; says why anything else is not kept', () => {
    const f = { imei: IMEI_A, type: 'zone_in', desc: 'Depot IN (Example depot zone)', dt_tracker: '2026-10-16 06:00:00', dt_server: '2026-10-16 06:00:20', lat: '10.50005', lng: '20.50005' };
    const ok = zoneEventOf(f, NOW);
    expect(ok).toEqual({
      ok: true,
      event: { imei: IMEI_A, type: 'zone_in', eventAt: new Date('2026-10-16T06:00:00Z'), serverAt: new Date('2026-10-16T06:00:20Z'), zoneName: 'Example depot zone', lat: 10.50005, lng: 20.50005 },
    });
    expect(zoneEventOf({ ...f, imei: '12345' }, NOW)).toEqual({ ok: false, problem: 'IMEI' });
    expect(zoneEventOf({ ...f, type: 'stopped' }, NOW)).toEqual({ ok: false, problem: 'TYPE' });
    expect(zoneEventOf({ ...f, dt_tracker: '2026-10-16 10:00:00' }, NOW)).toEqual({ ok: false, problem: 'TIME' }); // local time sent, no offset set
    expect(zoneEventOf({ ...f, dt_tracker: '2026-10-16 10:00:00' }, NOW, -240).ok).toBe(true);
    const old = new Date(NOW.getTime() - (EVENT_MAX_AGE_SEC + 60) * 1000);
    expect(zoneEventOf({ ...f, dt_tracker: old.toISOString().replace('T', ' ').slice(0, 19) }, NOW)).toEqual({ ok: false, problem: 'TIME' });
    expect(zoneEventOf({ ...f, lat: '0', lng: '0' }, NOW)).toMatchObject({ ok: true, event: { lat: null, lng: null } });
  });

  it('OBJECT_GET_LAST_EVENTS: zone events of mapped trackers only, the object name never read', () => {
    const r = parseLastEvents(json('last-events.json'), new Set([IMEI_A]), NOW)!;
    expect(r.unmapped).toBe(1);
    expect(r.ignored).toBe(1); // the long stop
    expect(r.events.map((e) => [e.type, e.eventAt.toISOString().slice(11, 16), e.zoneName])).toEqual([
      ['zone_out', '05:30', 'Example depot zone'],
      ['zone_in', '06:00', 'Example depot zone'],
    ]);
    expect(JSON.stringify(r)).not.toContain('Example object');
    expect(parseLastEvents([], new Set([IMEI_A]), NOW)).toEqual({ events: [], unmapped: 0, ignored: 0 });
    expect(parseLastEvents({ a: 1 }, new Set([IMEI_A]), NOW)).toBeNull();
  });

  it('the webhook and the backstop row of the same event get the same key; another event another key', () => {
    const backstop = parseLastEvents(json('last-events.json'), new Set([IMEI_A]), NOW)!.events[1]!;
    const query = new URLSearchParams(readFileSync(path.join(FIX, 'webhook-depot-in.txt'), 'utf8'));
    const hook = zoneEventOf(Object.fromEntries(query), NOW);
    if (!hook.ok) throw new Error('webhook fixture not accepted');
    expect(zoneEventDedupeKey(hook.event)).toBe(zoneEventDedupeKey(backstop));
    expect(zoneEventDedupeKey(hook.event)).toMatch(/^ayun:[0-9a-f]{32}$/);
    expect(zoneEventDedupeKey({ ...hook.event, zoneName: ' EXAMPLE depot zone' })).toBe(zoneEventDedupeKey(backstop));
    expect(zoneEventDedupeKey({ ...hook.event, eventAt: new Date(hook.event.eventAt.getTime() + 1000) })).not.toBe(zoneEventDedupeKey(backstop));
    expect(zoneEventDedupeKey({ ...hook.event, type: 'zone_out' })).not.toBe(zoneEventDedupeKey(backstop));
    expect(zoneEventDedupeKey(hook.event)).not.toContain(IMEI_A);
  });
});

describe('USER_GET_OBJECTS (the admin picker, never stored)', () => {
  it('IMEI, plate, group and last fix only: never the object name, SIM or driver', () => {
    const r = parseObjects(json('objects.json'))!;
    expect(r).toEqual([
      { imei: IMEI_A, plate: '0001 EX', group: 'Example group', fixAt: new Date('2026-10-16T06:04:45Z') },
      { imei: IMEI_B, plate: null, group: null, fixAt: null },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/Example object|Example driver|sim/);
    expect(parseObjects([])).toEqual([]);
    expect(parseObjects('x')).toBeNull();
  });
});
