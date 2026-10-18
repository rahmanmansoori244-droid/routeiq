/**
 * IVMS live link (16 Oct 2026): the daily allowance's shares and pacing (lib/ivms/budget.ts). Critique H2:
 * one share per call class (no class starves another), the shares add up to the allowance, the backstop
 * only at 1,000 a day or more with a webhook secret, pacing until the end of the operating hours or the
 * provider's midnight, `force` never spends a low allowance early, and the backoff schedule (LIMIT waits
 * for the provider's midnight, 04:00 in Muscat; AUTH an hour; anything else doubling to 15 min).
 */
import { describe, expect, it } from 'vitest';
import {
  backoffUntil,
  BACKOFF_MAX_SEC,
  callDue,
  classShares,
  eventsBackstopOn,
  horizonSec,
  hoursEndAt,
  inOperatingHours,
  mapIntervalSec,
  nextOpsStartOf,
  nextUtcMidnight,
  opsStartOf,
  routePullEveryMin,
  transientKind,
  utcDay,
} from '@/lib/ivms/budget';
import { IVMS_CALL_CLASSES } from '@/lib/ivms/types';

const HOURS = { timezone: 'Asia/Muscat', fromMin: 300, toMin: 1380 };
/** Local Muscat time (UTC+4) on 16 Oct 2026 as an instant. */
const muscat = (hhmm: string, day = '2026-10-16') => new Date(`${day}T${hhmm}:00+04:00`);

describe('the shares of the allowance (H2)', () => {
  it('add up to the allowance for every budget and mode, and every class has its own', () => {
    for (const b of [10, 50, 100, 999, 1000, 3000, 100_000]) {
      for (const mode of ['MAP', 'TIMES', 'ALERTS'] as const) {
        for (const on of [false, true]) {
          const s = classShares(b, mode, on);
          expect(IVMS_CALL_CLASSES.reduce((n, c) => n + s[c], 0), `${b} ${mode} ${on}`).toBe(b);
          for (const c of IVMS_CALL_CLASSES) expect(s[c]).toBeGreaterThanOrEqual(0);
          expect(s.ADMIN).toBeGreaterThanOrEqual(Math.min(3, b));
          expect(s.MAP).toBeGreaterThan(0);
        }
      }
    }
  });

  it('today\'s 100 a day: admin 5, no backstop, history 38 (TIMES), the map the rest', () => {
    expect(classShares(100, 'TIMES', true)).toEqual({ ADMIN: 5, EVENTS: 0, ROUTE: 38, MAP: 57 });
    expect(classShares(100, 'MAP', true)).toEqual({ ADMIN: 5, EVENTS: 0, ROUTE: 0, MAP: 95 });
    // GPS alerts (owner request 18 Oct 2026): ALERTS pulls the history as TIMES does.
    expect(classShares(100, 'ALERTS', true)).toEqual(classShares(100, 'TIMES', true));
  });

  it('the backstop only from 1,000 a day and with a webhook secret, at most 96 (every 15 min)', () => {
    expect(eventsBackstopOn(999, true)).toBe(false);
    expect(eventsBackstopOn(1000, false)).toBe(false);
    expect(eventsBackstopOn(1000, true)).toBe(true);
    expect(classShares(1000, 'TIMES', true)).toEqual({ ADMIN: 20, EVENTS: 50, ROUTE: 372, MAP: 558 });
    expect(classShares(3000, 'TIMES', true)).toEqual({ ADMIN: 20, EVENTS: 96, ROUTE: 1153, MAP: 1731 });
    expect(classShares(3000, 'TIMES', false).EVENTS).toBe(0);
  });
});

describe('days and hours', () => {
  it('the provider\'s day is the UTC date; it resets at 04:00 in Muscat', () => {
    expect(utcDay(muscat('03:59'))).toBe('2026-10-15');
    expect(utcDay(muscat('04:00'))).toBe('2026-10-16');
    expect(nextUtcMidnight(muscat('10:00')).toISOString()).toBe('2026-10-17T00:00:00.000Z');
  });

  it('operating hours [from, to) in the company\'s time zone', () => {
    expect(inOperatingHours(muscat('04:59'), HOURS)).toBe(false);
    expect(inOperatingHours(muscat('05:00'), HOURS)).toBe(true);
    expect(inOperatingHours(muscat('22:59'), HOURS)).toBe(true);
    expect(inOperatingHours(muscat('23:00'), HOURS)).toBe(false);
    expect(hoursEndAt(muscat('10:00'), HOURS).toISOString()).toBe(muscat('23:00').toISOString());
    expect(opsStartOf('2026-10-16', HOURS).toISOString()).toBe(muscat('05:00').toISOString());
    expect(nextOpsStartOf('2026-10-16', HOURS).toISOString()).toBe(muscat('05:00', '2026-10-17').toISOString());
  });

  it('the horizon: to the end of the hours (19:00 UTC) or the provider\'s midnight, whichever is first; at least 60 s', () => {
    expect(horizonSec(muscat('10:00'), HOURS)).toBe(13 * 3600);
    expect(horizonSec(muscat('23:30'), HOURS)).toBe(4.5 * 3600); // after hours (a load still out): to 04:00
    expect(horizonSec(muscat('22:59'), HOURS)).toBe(60);
    // A company whose hours run past the provider's midnight spends today's share by that midnight.
    const late = { timezone: 'Asia/Muscat', fromMin: 0, toMin: 1440 };
    expect(horizonSec(muscat('03:00'), late)).toBe(3600);
  });
});

describe('pacing', () => {
  it('the map: the setting while the share lasts, stretched when it would not, null when used up', () => {
    expect(mapIntervalSec({ pollSec: 60, share: 1731, used: 0, horizonSec: 18 * 3600 })).toBe(60);
    // Today's allowance: about one position every 19 min over the 18 hours.
    expect(mapIntervalSec({ pollSec: 60, share: 57, used: 0, horizonSec: 18 * 3600 })).toBe(1137);
    expect(mapIntervalSec({ pollSec: 60, share: 57, used: 56, horizonSec: 3600 })).toBe(3600);
    expect(mapIntervalSec({ pollSec: 60, share: 57, used: 57, horizonSec: 3600 })).toBeNull();
  });

  it('`force` (the cron route) skips the wait only while the setting\'s own interval is in effect (H2)', () => {
    const now = new Date('2026-10-16T06:00:00Z');
    const lastAt = new Date(now.getTime() - 30_000);
    expect(callDue({ lastAt, intervalSec: 60, settingSec: 60, now })).toBe(false);
    expect(callDue({ lastAt, intervalSec: 60, settingSec: 60, now, force: true })).toBe(true);
    expect(callDue({ lastAt, intervalSec: 1137, settingSec: 60, now, force: true })).toBe(false);
    expect(callDue({ lastAt: null, intervalSec: 1137, settingSec: 60, now })).toBe(true);
    expect(callDue({ lastAt: new Date(now.getTime() - 1137_000), intervalSec: 1137, settingSec: 60, now })).toBe(true);
  });

  it('history pulls: the setting while the share lasts, one final pull kept per truck out, null when only finals are left', () => {
    expect(routePullEveryMin({ pullMin: 60, share: 1153, used: 0, trucksOut: 9, horizonSec: 18 * 3600 })).toBe(60);
    // 100 a day: 38 for history, 9 kept for the finals, 29 regular pulls for 9 trucks over 18 h.
    expect(routePullEveryMin({ pullMin: 60, share: 38, used: 0, trucksOut: 9, horizonSec: 18 * 3600 })).toBe(336);
    expect(routePullEveryMin({ pullMin: 60, share: 38, used: 29, trucksOut: 9, horizonSec: 3600 })).toBeNull();
    expect(routePullEveryMin({ pullMin: 30, share: 38, used: 0, trucksOut: 0, horizonSec: 3600 })).toBe(30);
  });
});

describe('backoff', () => {
  const now = new Date('2026-10-16T06:00:00Z');
  it('LIMIT waits for the provider\'s midnight (04:01 in Muscat); AUTH an hour', () => {
    expect(backoffUntil('LIMIT', 1, now, 60).toISOString()).toBe('2026-10-17T00:01:00.000Z');
    expect(backoffUntil('AUTH', 1, now, 60).toISOString()).toBe('2026-10-16T07:00:00.000Z');
  });

  it('anything else doubles from the interval in effect up to 15 min, +-20 %', () => {
    const mid = () => 0.5;
    const secs = [1, 2, 3, 4, 5, 6].map((f) => (backoffUntil('TIMEOUT', f, now, 60, mid).getTime() - now.getTime()) / 1000);
    expect(secs).toEqual([60, 120, 240, 480, 900, 900]);
    expect((backoffUntil('NETWORK', 1, now, 60, () => 0).getTime() - now.getTime()) / 1000).toBe(48);
    expect((backoffUntil('NETWORK', 1, now, 60, () => 1).getTime() - now.getTime()) / 1000).toBe(72);
    expect((backoffUntil('PARSE', 9, now, 1137, mid).getTime() - now.getTime()) / 1000).toBe(BACKOFF_MAX_SEC);
  });

  it('transient kinds are retried; the account\'s problems are not "transient"', () => {
    expect(['TIMEOUT', 'NETWORK', 'HTTP_ERROR', 'REDIRECT', 'TOO_LARGE', 'EMPTY', 'PARSE', 'PROVIDER_ERROR'].every((k) => transientKind(k as never))).toBe(true);
    expect(['AUTH', 'LIMIT', 'NO_PERMISSION', 'DISABLED', 'NOT_CONFIGURED'].some((k) => transientKind(k as never))).toBe(false);
  });
});
