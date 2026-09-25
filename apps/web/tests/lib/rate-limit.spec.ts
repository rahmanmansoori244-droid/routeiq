/**
 * lib/rate-limit.ts hygiene (review F16 / new issues): expired buckets are swept, the map has a
 * hard cap, and RATE_LIMITS_DISABLED cannot switch limits off on Railway. Every limiter here gets
 * its clock and bypass passed in explicitly (NODE_ENV=test bypasses the shared one).
 */
import { describe, expect, it } from 'vitest';
import { RateLimiter, rateLimitBypass, rateLimitConfigProblem } from '@/lib/rate-limit';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('RateLimiter', () => {
  it('counts within the window and resets after it', () => {
    const c = clock();
    const l = new RateLimiter({ now: c.now });
    expect(l.consume('k', 2, 1000).ok).toBe(true);
    expect(l.consume('k', 2, 1000).ok).toBe(true);
    expect(l.consume('k', 2, 1000).ok).toBe(false);
    c.advance(1001);
    expect(l.consume('k', 2, 1000).ok).toBe(true);
  });

  it('sweeps expired buckets', () => {
    const c = clock();
    const l = new RateLimiter({ now: c.now, sweepEveryMs: 10 });
    for (let i = 0; i < 50; i++) l.consume(`ip:${i}`, 5, 100);
    expect(l.size).toBe(50);
    c.advance(200);
    l.consume('fresh', 5, 100); // an insert triggers the periodic sweep
    expect(l.size).toBe(1);
  });

  it('never holds more than maxKeys buckets (oldest evicted)', () => {
    const c = clock();
    const l = new RateLimiter({ now: c.now, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) l.consume(`spoofed:${i}`, 5, 60_000);
    expect(l.size).toBeLessThanOrEqual(100);
    expect(l.isBlocked('spoofed:999', 1)).toBe(true); // the newest is kept
  });

  it('hit / isBlocked / reset for failure counters', () => {
    const c = clock();
    const l = new RateLimiter({ now: c.now });
    for (let i = 0; i < 4; i++) l.hit('f', 1000);
    expect(l.isBlocked('f', 5)).toBe(false);
    expect(l.hit('f', 1000)).toBe(5);
    expect(l.isBlocked('f', 5)).toBe(true);
    l.reset('f');
    expect(l.isBlocked('f', 5)).toBe(false);
    l.hit('f', 1000);
    c.advance(1001);
    expect(l.isBlocked('f', 1)).toBe(false);
  });

  it('bypass passes everything and stores nothing', () => {
    const l = new RateLimiter({ bypass: () => true });
    for (let i = 0; i < 10; i++) expect(l.consume('k', 1, 1000).ok).toBe(true);
    expect(l.hit('k', 1000)).toBe(0);
    expect(l.size).toBe(0);
  });
});

describe('RATE_LIMITS_DISABLED guard', () => {
  const e = (x: Record<string, string>) => x as NodeJS.ProcessEnv;
  it('bypasses for unit tests, CI and local test servers', () => {
    expect(rateLimitBypass(e({ NODE_ENV: 'test' }))).toBe(true);
    expect(rateLimitBypass(e({ NODE_ENV: 'production', RATE_LIMITS_DISABLED: '1', CI: 'true' }))).toBe(true);
    expect(rateLimitBypass(e({ NODE_ENV: 'development', RATE_LIMITS_DISABLED: '1' }))).toBe(true);
  });
  it('limits stay on without the flag', () => {
    expect(rateLimitBypass(e({ NODE_ENV: 'production' }))).toBe(false);
  });
  it('is ignored on Railway (limits stay on)', () => {
    expect(rateLimitBypass(e({ NODE_ENV: 'production', RATE_LIMITS_DISABLED: '1', RAILWAY_ENVIRONMENT_ID: 'x' }))).toBe(false);
    expect(rateLimitBypass(e({ NODE_ENV: 'production', RATE_LIMITS_DISABLED: '1', RAILWAY_PROJECT_ID: 'x' }))).toBe(false);
  });
  it('reports a production server outside CI with the flag set', () => {
    expect(rateLimitConfigProblem(e({ NODE_ENV: 'production', RATE_LIMITS_DISABLED: '1' }))).toMatch(/OFF/);
    expect(rateLimitConfigProblem(e({ NODE_ENV: 'production', RATE_LIMITS_DISABLED: '1', RAILWAY_PROJECT_ID: 'x' }))).toMatch(/ignored/);
    expect(rateLimitConfigProblem(e({ NODE_ENV: 'production', RATE_LIMITS_DISABLED: '1', CI: 'true' }))).toBeNull();
    expect(rateLimitConfigProblem(e({ NODE_ENV: 'development', RATE_LIMITS_DISABLED: '1' }))).toBeNull();
    expect(rateLimitConfigProblem(e({ NODE_ENV: 'production' }))).toBeNull();
  });
});
