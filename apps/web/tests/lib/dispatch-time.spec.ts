/**
 * Tenant-local time helpers. Every Date here is an explicit UTC instant, so results must not
 * depend on the machine timezone (Muscat is UTC+4, no DST).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  addDaysIso,
  dateOnly,
  daysBetween,
  fmtHhmm,
  fmtWindow,
  isAfterCutoff,
  isoOf,
  localDateIso,
  localMinutes,
  parseHhmm,
  todayIso,
  tomorrowIso,
} from '@/lib/dispatch/time';

const CUTOFF = 18 * 60; // 18:00 local, day before delivery
const DELIVERY = '2026-09-25';
const utc = (s: string) => new Date(`${s}Z`);

describe('isAfterCutoff (cutoff 18:00 Asia/Muscat, delivery 2026-09-25)', () => {
  it('day before at 17:59 local is on time', () => {
    expect(isAfterCutoff(utc('2026-09-24T13:59:00'), DELIVERY, CUTOFF, 'Asia/Muscat')).toBe(false);
  });

  it('day before at exactly 18:00 local is still on time', () => {
    expect(isAfterCutoff(utc('2026-09-24T14:00:00'), DELIVERY, CUTOFF, 'Asia/Muscat')).toBe(false);
  });

  it('day before at 18:01 local is late', () => {
    expect(isAfterCutoff(utc('2026-09-24T14:01:00'), DELIVERY, CUTOFF, 'Asia/Muscat')).toBe(true);
  });

  it('received on the delivery day itself is always late', () => {
    expect(isAfterCutoff(utc('2026-09-25T02:00:00'), DELIVERY, CUTOFF, 'Asia/Muscat')).toBe(true); // 06:00 local
    // 00:30 local on the delivery day is still the previous day in UTC.
    expect(isAfterCutoff(utc('2026-09-24T20:30:00'), DELIVERY, CUTOFF, 'Asia/Muscat')).toBe(true);
  });

  it('received after the delivery day is late', () => {
    expect(isAfterCutoff(utc('2026-09-26T05:00:00'), DELIVERY, CUTOFF, 'Asia/Muscat')).toBe(true);
  });

  it('two days before (even late evening) is on time', () => {
    expect(isAfterCutoff(utc('2026-09-23T19:00:00'), DELIVERY, CUTOFF, 'Asia/Muscat')).toBe(false); // 23:00 local
    expect(isAfterCutoff(utc('2026-09-22T12:00:00'), DELIVERY, CUTOFF, 'Asia/Muscat')).toBe(false);
  });

  it('uses the tenant timezone, not UTC: 15:00Z is 19:00 in Muscat', () => {
    const t = utc('2026-09-24T15:00:00');
    expect(isAfterCutoff(t, DELIVERY, CUTOFF, 'Asia/Muscat')).toBe(true);
    expect(isAfterCutoff(t, DELIVERY, CUTOFF, 'UTC')).toBe(false);
    // Default timezone is Asia/Muscat.
    expect(isAfterCutoff(t, DELIVERY, CUTOFF)).toBe(true);
  });

  it('cutoff across a month boundary', () => {
    // Delivery 1 Oct -> cutoff day 30 Sep.
    expect(isAfterCutoff(utc('2026-09-30T13:00:00'), '2026-10-01', CUTOFF)).toBe(false);
    expect(isAfterCutoff(utc('2026-09-30T15:00:00'), '2026-10-01', CUTOFF)).toBe(true);
  });
});

describe('machine timezone independence', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('gives the same answers when the process runs in another zone', () => {
    for (const tz of ['America/New_York', 'Pacific/Kiritimati', 'UTC']) {
      process.env.TZ = tz;
      expect(isAfterCutoff(utc('2026-09-24T13:59:00'), DELIVERY, CUTOFF), tz).toBe(false);
      expect(isAfterCutoff(utc('2026-09-24T14:01:00'), DELIVERY, CUTOFF), tz).toBe(true);
      expect(localDateIso(utc('2026-09-24T20:30:00')), tz).toBe('2026-09-25');
      expect(tomorrowIso('Asia/Muscat', utc('2026-09-24T20:30:00')), tz).toBe('2026-09-26');
    }
  });
});

describe('localDateIso / localMinutes / todayIso / tomorrowIso', () => {
  it('crosses midnight in Muscat before it does in UTC', () => {
    const t = utc('2026-09-24T20:30:00'); // 00:30 on the 25th in Muscat
    expect(localDateIso(t, 'Asia/Muscat')).toBe('2026-09-25');
    expect(localDateIso(t, 'UTC')).toBe('2026-09-24');
    expect(localMinutes(t, 'Asia/Muscat')).toBe(30);
    expect(localMinutes(t, 'UTC')).toBe(20 * 60 + 30);
  });

  it('just before local midnight stays on the same day', () => {
    const t = utc('2026-09-24T19:59:00'); // 23:59 Muscat
    expect(localDateIso(t)).toBe('2026-09-24');
    expect(localMinutes(t)).toBe(23 * 60 + 59);
  });

  it('local midnight is 0 minutes (h23, not 24:00)', () => {
    expect(localMinutes(utc('2026-09-24T20:00:00'))).toBe(0);
  });

  it('todayIso / tomorrowIso use the tenant timezone', () => {
    const t = utc('2026-09-24T20:30:00');
    expect(todayIso('Asia/Muscat', t)).toBe('2026-09-25');
    expect(tomorrowIso('Asia/Muscat', t)).toBe('2026-09-26');
    expect(tomorrowIso('UTC', t)).toBe('2026-09-25');
    // New year's eve in Muscat.
    expect(tomorrowIso('Asia/Muscat', utc('2026-12-31T10:00:00'))).toBe('2027-01-01');
  });
});

describe('addDaysIso / daysBetween', () => {
  it('handles month and year boundaries', () => {
    expect(addDaysIso('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysIso('2028-03-01', -1)).toBe('2028-02-29'); // leap year
    expect(addDaysIso('2026-09-25', 0)).toBe('2026-09-25');
    expect(addDaysIso('2026-09-25', 30)).toBe('2026-10-25');
  });

  it('daysBetween is b - a in whole days', () => {
    expect(daysBetween('2026-09-24', '2026-09-25')).toBe(1);
    expect(daysBetween('2026-09-25', '2026-09-24')).toBe(-1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-09-25', '2026-09-25')).toBe(0);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('fmtHhmm', () => {
  it('formats minutes from midnight', () => {
    expect(fmtHhmm(390)).toBe('06:30');
    expect(fmtHhmm(0)).toBe('00:00');
    expect(fmtHhmm(1439)).toBe('23:59');
    expect(fmtHhmm(389.6)).toBe('06:30');
  });

  it('marks next-day times with +1', () => {
    expect(fmtHhmm(1440)).toBe('00:00 +1');
    expect(fmtHhmm(1530)).toBe('01:30 +1');
    expect(fmtHhmm(1439.6)).toBe('00:00 +1'); // rounds up into the next day
  });

  it('renders a dash for missing values', () => {
    expect(fmtHhmm(null)).toBe('—');
    expect(fmtHhmm(undefined)).toBe('—');
    expect(fmtHhmm(Number.NaN)).toBe('—');
  });
});

describe('parseHhmm', () => {
  it('accepts HH:MM, H:MM and HHMM', () => {
    expect(parseHhmm('06:30')).toBe(390);
    expect(parseHhmm('6:30')).toBe(390);
    expect(parseHhmm('0630')).toBe(390);
    expect(parseHhmm(' 18:00 ')).toBe(1080);
    expect(parseHhmm('00:00')).toBe(0);
    expect(parseHhmm('24:00')).toBe(1440);
  });

  it('returns null for blank', () => {
    expect(parseHhmm('')).toBeNull();
    expect(parseHhmm('   ')).toBeNull();
    expect(parseHhmm(null)).toBeNull();
    expect(parseHhmm(undefined)).toBeNull();
  });

  it('throws on garbage and impossible times', () => {
    for (const s of ['abc', '6', '6pm', '12:60', '25:00', '24:30', '6:3', '12:345']) {
      expect(() => parseHhmm(s), s).toThrow(/Invalid time/);
    }
  });
});

describe('fmtWindow', () => {
  it('formats open and closed windows', () => {
    expect(fmtWindow(null, null)).toBe('Any time');
    expect(fmtWindow(undefined, undefined)).toBe('Any time');
    expect(fmtWindow(360, 720)).toBe('06:00–12:00');
    expect(fmtWindow(null, 720)).toBe('00:00–12:00');
    expect(fmtWindow(360, null)).toBe('06:00–24:00');
  });
});

describe('dateOnly / isoOf', () => {
  it('round-trips a YYYY-MM-DD through a UTC-midnight Date', () => {
    const d = dateOnly('2026-09-25');
    expect(d.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(isoOf(d)).toBe('2026-09-25');
  });
});
