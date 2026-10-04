/**
 * The rules of a delivery result (owner request 4 Oct 2026, spec sections 8.2, 8.3, 9.4 and 13.3),
 * row by row. Synthetic stop: ACME, lines A:30 and B:10 of order O1.
 */
import { describe, expect, it } from 'vitest';
import {
  actionTime,
  carryChangeCheck,
  clockSkewMs,
  inCarryBasis,
  normalizeResult,
  notDeliveredOf,
  photoRule,
  photoTime,
  readCarryBasis,
  REFUSAL_TEXT,
  writeRule,
} from '@/lib/delivery/outcome-rules';

const PLANNED = [
  { orderId: 'O1', lineId: 'A', plannedCases: 30 },
  { orderId: 'O1', lineId: 'B', plannedCases: 10 },
];

describe('normalizeResult (spec section 8.2)', () => {
  it('Delivered: every line full, any lines sent are ignored, no reason', () => {
    const r = normalizeResult(PLANNED, { outcome: 'DELIVERED', reason: 'SHOP_CLOSED', lines: [{ lineId: 'A', delivered: 3 }] });
    expect(r).toMatchObject({ ok: true, outcome: 'DELIVERED', reason: null, casesDelivered: 40 });
  });

  it('Partly: unsent lines default to all; needs a reason; all full becomes Delivered; all zero is refused', () => {
    expect(normalizeResult(PLANNED, { outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', lines: [{ lineId: 'B', delivered: 4 }] })).toMatchObject({
      ok: true,
      outcome: 'PARTLY_DELIVERED',
      reason: 'DAMAGED_GOODS',
      casesDelivered: 34,
      lines: [
        { lineId: 'A', delivered: 30 },
        { lineId: 'B', delivered: 4 },
      ],
    });
    expect(normalizeResult(PLANNED, { outcome: 'PARTLY_DELIVERED', lines: [{ lineId: 'B', delivered: 4 }] })).toMatchObject({ ok: false, code: 'INVALID' });
    expect(normalizeResult(PLANNED, { outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', lines: [] })).toMatchObject({ ok: true, outcome: 'DELIVERED', coerced: true, reason: null });
    expect(
      normalizeResult(PLANNED, {
        outcome: 'PARTLY_DELIVERED',
        reason: 'DAMAGED_GOODS',
        lines: [
          { lineId: 'A', delivered: 0 },
          { lineId: 'B', delivered: 0 },
        ],
      }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/Not delivered/) });
  });

  it('Not delivered: every line 0 and a reason; Missing from the truck is a reason', () => {
    expect(normalizeResult(PLANNED, { outcome: 'NOT_DELIVERED', reason: 'NOT_ON_TRUCK' })).toMatchObject({ ok: true, casesDelivered: 0, reason: 'NOT_ON_TRUCK' });
    expect(normalizeResult(PLANNED, { outcome: 'NOT_DELIVERED' })).toMatchObject({ ok: false });
    expect(normalizeResult(PLANNED, { outcome: 'NOT_DELIVERED', reason: 'BAD_WEATHER' })).toMatchObject({ ok: false });
  });

  it('Other needs a note of 3 to 300 characters; any note is at most 300', () => {
    expect(normalizeResult(PLANNED, { outcome: 'NOT_DELIVERED', reason: 'OTHER', note: ' x ' })).toMatchObject({ ok: false });
    expect(normalizeResult(PLANNED, { outcome: 'NOT_DELIVERED', reason: 'OTHER', note: 'gate locked' })).toMatchObject({ ok: true, note: 'gate locked' });
    expect(normalizeResult(PLANNED, { outcome: 'DELIVERED', note: 'x'.repeat(301) })).toMatchObject({ ok: false });
  });

  it('lines must be the stop\'s, whole numbers in 0..planned, each once', () => {
    const bad = [[{ lineId: 'Z', delivered: 1 }], [{ lineId: 'A', delivered: 31 }], [{ lineId: 'A', delivered: 1.5 }], [{ lineId: 'A', delivered: -1 }], [{ lineId: 'A', delivered: 1 }, { lineId: 'A', delivered: 2 }]];
    for (const lines of bad) expect(normalizeResult(PLANNED, { outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', lines })).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('null clears the result', () => {
    expect(normalizeResult(PLANNED, { outcome: null })).toEqual({ ok: true, outcome: null });
  });
});

describe('photoRule', () => {
  const base = { required: true, byDriver: true, photoKeys: [] as string[], noPhotoReason: null };
  it('a driver\'s Delivered or Partly needs a photo key unless the camera failed', () => {
    expect(photoRule({ ...base, outcome: 'DELIVERED' })).toBe('PHOTO_REQUIRED');
    expect(photoRule({ ...base, outcome: 'PARTLY_DELIVERED' })).toBe('PHOTO_REQUIRED');
    expect(photoRule({ ...base, outcome: 'DELIVERED', photoKeys: ['k'] })).toBe('ok');
    expect(photoRule({ ...base, outcome: 'DELIVERED', noPhotoReason: 'CAMERA_FAILED' } as never)).toBe('ok');
  });
  it('not for Not delivered, the office, a cleared result, or with the setting off', () => {
    expect(photoRule({ ...base, outcome: 'NOT_DELIVERED' })).toBe('ok');
    expect(photoRule({ ...base, outcome: 'DELIVERED', byDriver: false })).toBe('ok');
    expect(photoRule({ ...base, outcome: null })).toBe('ok');
    expect(photoRule({ ...base, outcome: 'DELIVERED', required: false })).toBe('ok');
  });
});

describe('writeRule (spec section 8.3)', () => {
  const RECEIVED = new Date('2026-10-05T13:00:00Z');
  const EXPIRES = new Date('2026-10-06T08:00:00Z');
  const COMPLETED_AT = new Date('2026-10-05T13:00:00Z');
  const rule = (over: Partial<Parameters<typeof writeRule>[0]>) =>
    writeRule({ kind: 'OUTCOME', office: false, loadStatus: 'DISPATCHED', at: new Date('2026-10-05T07:00:00Z'), statusChangedAt: null, hadResultAtCompletion: false, receivedAt: RECEIVED, expiresAt: EXPIRES, ...over });

  it('DISPATCHED: yes; received in the upload grace: late', () => {
    expect(rule({})).toEqual({ ok: true, late: false });
    expect(rule({ receivedAt: new Date('2026-10-07T08:00:00Z') })).toEqual({ ok: true, late: true });
  });

  it('LOCKED / LOADING: arrivals and departures are kept on the phone (transient); results and Back at depot refused', () => {
    for (const s of ['LOCKED', 'LOADING']) {
      expect(rule({ loadStatus: s, kind: 'ARRIVE' })).toEqual({ ok: false, code: 'LOAD_NOT_DISPATCHED', transient: true });
      expect(rule({ loadStatus: s, kind: 'DEPART' })).toEqual({ ok: false, code: 'LOAD_NOT_DISPATCHED', transient: true });
      expect(rule({ loadStatus: s, kind: 'OUTCOME' })).toEqual({ ok: false, code: 'LOAD_NOT_DISPATCHED', transient: false });
      expect(rule({ loadStatus: s, kind: 'BACK_AT_DEPOT' })).toEqual({ ok: false, code: 'LOAD_NOT_DISPATCHED', transient: false });
    }
    expect(rule({ loadStatus: 'PLANNED', kind: 'ARRIVE' })).toEqual({ ok: false, code: 'LOAD_NOT_DISPATCHED', transient: false });
  });

  it('COMPLETED (E10): gap-filling only, always late', () => {
    const closed = { loadStatus: 'COMPLETED', statusChangedAt: COMPLETED_AT, receivedAt: new Date('2026-10-05T17:00:00Z') };
    // A stop that had a result at completion: refused whatever its time.
    expect(rule({ ...closed, at: new Date('2026-10-05T12:59:00Z'), hadResultAtCompletion: true })).toEqual({ ok: false, code: 'LOAD_COMPLETED', transient: false });
    // A gap-fill: accepted, late.
    expect(rule({ ...closed, at: new Date('2026-10-05T11:20:00Z') })).toEqual({ ok: true, late: true });
    // Anything dated after the completion: refused.
    expect(rule({ ...closed, kind: 'ARRIVE', at: new Date('2026-10-05T13:30:00Z') })).toEqual({ ok: false, code: 'LOAD_COMPLETED', transient: false });
    // Timing and proof before it: accepted, late.
    expect(rule({ ...closed, kind: 'PHOTO', at: new Date('2026-10-05T12:00:00Z'), hadResultAtCompletion: true })).toEqual({ ok: true, late: true });
  });

  it('the office on the driver page writes as the dispatcher: any time on DISPATCHED or COMPLETED, never late', () => {
    expect(rule({ office: true, loadStatus: 'COMPLETED', statusChangedAt: COMPLETED_AT, at: new Date('2026-10-05T14:00:00Z'), hadResultAtCompletion: true })).toEqual({ ok: true, late: false });
    expect(rule({ office: true, receivedAt: new Date('2026-10-07T08:00:00Z') })).toEqual({ ok: true, late: false });
  });

  it('every refusal has English and Arabic words', () => {
    for (const v of Object.values(REFUSAL_TEXT)) {
      expect(v.en.length).toBeGreaterThan(5);
      expect(v.ar).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('carryChangeCheck (spec section 9.4)', () => {
  const basis = readCarryBasis({ visits: [{ visitId: 'V1', lines: [{ lineId: 'B', notDelivered: 6 }] }, { bad: true }] });

  it('reads the basis defensively; a copy made before Part 3 has an empty basis', () => {
    expect(basis.visits).toHaveLength(1);
    expect(readCarryBasis(null)).toEqual({ visits: [] });
    expect(inCarryBasis(basis, 'V1')).toBe(true);
    expect(inCarryBasis(basis, 'V2')).toBe(false);
  });

  it('a visit outside the basis: stored; a larger or equal shortfall: stored; a smaller one or a cleared result: refused', () => {
    expect(carryChangeCheck(basis, 'V2', new Map([['B', 0]]))).toEqual({ ok: true });
    expect(carryChangeCheck(basis, 'V1', new Map([['B', 10]]))).toEqual({ ok: true });
    expect(carryChangeCheck(basis, 'V1', new Map([['B', 6]]))).toEqual({ ok: true });
    expect(carryChangeCheck(basis, 'V1', new Map([['B', 0]]))).toMatchObject({ ok: false, lines: [{ lineId: 'B', carried: 6, after: 0 }] });
    const cleared = notDeliveredOf([{ lineId: 'B', plannedCases: 10, deliveredCases: 4 }], false);
    expect(carryChangeCheck(basis, 'V1', cleared)).toMatchObject({ ok: false });
  });
});

describe('clocks (spec section 13.3)', () => {
  const RECEIVED = new Date('2026-10-05T06:00:00Z');
  const DAY = new Date('2026-10-04T20:00:00Z'); // 5 Oct 00:00 Asia/Muscat
  const EXPIRES = new Date('2026-10-06T08:00:00Z');
  const bounds = { receivedAt: RECEIVED, dayStart: DAY, expiresAt: EXPIRES };

  it('a skew under 2 minutes is not corrected; a phone clock 10 min fast is', () => {
    expect(clockSkewMs(RECEIVED, new Date(RECEIVED.getTime() - 60_000))).toBe(0);
    const fast = new Date(RECEIVED.getTime() + 10 * 60_000);
    const skew = clockSkewMs(RECEIVED, fast);
    expect(skew).toBe(-10 * 60_000);
    // The phone said 10:10 local for an arrival that happened at 10:00 local.
    expect(actionTime(new Date('2026-10-05T06:10:00Z'), skew, bounds)).toEqual(new Date('2026-10-05T06:00:00Z'));
    expect(clockSkewMs(RECEIVED, null)).toBe(0);
  });

  it('clamps to the receipt and refuses times outside [day start - 6 h, expiry]', () => {
    expect(actionTime(new Date('2026-10-05T07:00:00Z'), 0, bounds)).toEqual(RECEIVED);
    expect(actionTime(new Date('2026-10-04T13:00:00Z'), 0, bounds)).toBe('TIME_OUT_OF_RANGE');
    expect(actionTime(new Date('2026-10-04T15:00:00Z'), 0, bounds)).toEqual(new Date('2026-10-04T15:00:00Z'));
    expect(actionTime(new Date('nope'), 0, bounds)).toBe('TIME_OUT_OF_RANGE');
    expect(actionTime(new Date('2026-10-06T09:00:00Z'), 0, { ...bounds, receivedAt: new Date('2026-10-07T00:00:00Z') })).toBe('TIME_OUT_OF_RANGE');
  });

  it('a photo time is clamped, never refused', () => {
    expect(photoTime(new Date('2031-01-01T00:00:00Z'), 0, bounds)).toEqual(RECEIVED);
    expect(photoTime(new Date('2020-01-01T00:00:00Z'), 0, bounds)).toEqual(new Date(DAY.getTime() - 6 * 3600_000));
  });
});
