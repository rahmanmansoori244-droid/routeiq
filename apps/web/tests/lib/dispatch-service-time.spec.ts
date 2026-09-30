/**
 * Unloading time sent to the optimizer: the customer's service time plus the tenant's
 * "unloading minutes per case"; every split-delivery part gets the FULL base (owner rule 29 Sep 2026).
 */
import { describe, expect, it } from 'vitest';
import { MAX_SERVICE_MIN, stopService, stopServiceMin } from '@/lib/dispatch/service-time';

describe('stopServiceMin', () => {
  it('is the plain service time when no per-case time is set (old behaviour)', () => {
    expect(stopServiceMin(10, 0, 1100)).toBe(10);
    expect(stopServiceMin(0, 0, 50)).toBe(0);
  });

  it('adds the unloading time per case and rounds to whole minutes', () => {
    expect(stopServiceMin(10, 0.05, 1100)).toBe(65); // 10 + 55
    expect(stopServiceMin(10, 0.05, 20)).toBe(11); // 10 + 1
    expect(stopServiceMin(12, 0.03, 45)).toBe(13); // 12 + 1.35
  });

  it('gives every split-delivery part the full base plus the per-case time of its own cases', () => {
    // 1,100-case customer with a 30 min base: a 935-case part and a 165-case part.
    expect(stopServiceMin(30, 0, 935)).toBe(30); // was round(30 x 935 / 1100) = 26
    expect(stopServiceMin(30, 0, 165)).toBe(30); // was 5
    expect(stopServiceMin(30, 0.05, 935)).toBe(Math.round(30 + 46.75));
    expect(stopServiceMin(30, 0.05, 165)).toBe(Math.round(30 + 8.25));
    // An explicit 0 min base stays 0 on every part (no 5 min minimum any more).
    expect(stopServiceMin(0, 0, 10)).toBe(0);
    expect(stopServiceMin(0, 0.05, 100)).toBe(5);
  });

  it('never exceeds what the optimizer accepts, and ignores nonsense inputs', () => {
    expect(stopServiceMin(60, 1, 5000)).toBe(MAX_SERVICE_MIN);
    expect(stopServiceMin(900, 0, 10)).toBe(MAX_SERVICE_MIN);
    expect(stopServiceMin(-5, -1, 100)).toBe(0);
  });
});

describe('stopService (cap reported)', () => {
  it('returns the minutes sent and whether the stop needed more than the optimizer accepts', () => {
    expect(stopService(30, 0.05, 100)).toEqual({ min: 35, capped: false, neededMin: 35 });
    expect(stopService(60, 1, 500)).toEqual({ min: MAX_SERVICE_MIN, capped: true, neededMin: 560 });
    expect(stopService(MAX_SERVICE_MIN, 0, 10)).toEqual({ min: MAX_SERVICE_MIN, capped: false, neededMin: MAX_SERVICE_MIN });
  });

  it('a split part gets the full base time, capped like any stop', () => {
    expect(stopService(600, 0, 50)).toEqual({ min: MAX_SERVICE_MIN, capped: true, neededMin: 600 });
    expect(stopService(35, 0, 200)).toEqual({ min: 35, capped: false, neededMin: 35 });
  });
});
