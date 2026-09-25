/**
 * Unloading time sent to the optimizer: the customer's service time plus the tenant's
 * "unloading minutes per case"; split-delivery parts get a proportional share of the base.
 */
import { describe, expect, it } from 'vitest';
import { MAX_SERVICE_MIN, stopServiceMin } from '@/lib/dispatch/service-time';

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

  it('keeps the proportional base (at least 5 min) for a split-delivery part plus its own cases', () => {
    // 1,100-case customer with a 30 min base: a 935-case part and a 165-case part.
    expect(stopServiceMin(30, 0, 935, 1100)).toBe(26); // round(30 x 935 / 1100) = 26 (old behaviour)
    expect(stopServiceMin(30, 0, 165, 1100)).toBe(5); // round(4.5) = 5, and never below 5
    expect(stopServiceMin(30, 0.05, 935, 1100)).toBe(Math.round(26 + 46.75));
    expect(stopServiceMin(30, 0.05, 165, 1100)).toBe(Math.round(5 + 8.25));
    expect(stopServiceMin(10, 0, 10, 1000)).toBe(5);
  });

  it('never exceeds what the optimizer accepts, and ignores nonsense inputs', () => {
    expect(stopServiceMin(60, 1, 5000)).toBe(MAX_SERVICE_MIN);
    expect(stopServiceMin(900, 0, 10)).toBe(MAX_SERVICE_MIN);
    expect(stopServiceMin(-5, -1, 100)).toBe(0);
    expect(stopServiceMin(20, 0.1, 30, 0)).toBe(23); // no total: the whole base
  });
});
