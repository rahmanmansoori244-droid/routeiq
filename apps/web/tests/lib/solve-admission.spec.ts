/**
 * Stabilization PR3 - solve admission (review F16), with a fake clock: hourly quotas per user and
 * per company (only real starts count), the concurrency caps with a first-in-first-out queue, and
 * a released reservation that costs nothing.
 */
import { describe, expect, it } from 'vitest';
import { defaultAdmissionLimits, SolveAdmission, type AdmissionLimits, type SolveTicket } from '@/lib/dispatch/solve-admission';

const LIMITS: AdmissionLimits = { userPerHour: 3, tenantPerHour: 5, tenantConcurrent: 2, globalConcurrent: 3, maxQueue: 2, windowMs: 60 * 60_000 };

function gate(limits: Partial<AdmissionLimits> = {}, opts: { quotasOff?: boolean } = {}) {
  let now = 1_000_000;
  const a = new SolveAdmission({ ...LIMITS, ...limits }, () => now, () => !!opts.quotasOff);
  return { a, advance: (ms: number) => (now += ms) };
}

function ok(r: ReturnType<SolveAdmission['reserve']>): SolveTicket {
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return r.ticket;
}

/** Start and finish one solve (a committed start). */
function solve(a: SolveAdmission, tenant: string, user: string) {
  const t = ok(a.reserve(tenant, user));
  t.commit();
  t.release();
}

describe('defaults', () => {
  it('15 per user and 30 per company per hour, 2 per company at once, SOLVER_MAX_CONCURRENT in total, 10 waiting', () => {
    expect(defaultAdmissionLimits({} as NodeJS.ProcessEnv)).toEqual({ userPerHour: 15, tenantPerHour: 30, tenantConcurrent: 2, globalConcurrent: 2, maxQueue: 10, windowMs: 3_600_000 });
    expect(defaultAdmissionLimits({ SOLVER_MAX_CONCURRENT: '3' } as unknown as NodeJS.ProcessEnv).globalConcurrent).toBe(3);
    expect(defaultAdmissionLimits({ SOLVER_MAX_CONCURRENT: 'zero' } as unknown as NodeJS.ProcessEnv).globalConcurrent).toBe(2);
  });
});

describe('hourly quotas', () => {
  it('refuses the user over quota with 429 and Retry-After until the oldest start leaves the hour', () => {
    const { a, advance } = gate();
    for (let i = 0; i < 3; i++) {
      solve(a, 'tA', 'u1');
      advance(60_000);
    }
    const r = a.reserve('tA', 'u1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(429);
    expect(r.code).toBe('SOLVE_QUOTA_USER');
    expect(r.retryAfterSec).toBe(57 * 60); // oldest start + 1 h - now
    // Another user of the same company still may.
    expect(a.reserve('tA', 'u2').ok).toBe(true);
    advance(57 * 60_000 + 1);
    expect(a.reserve('tA', 'u1').ok).toBe(true);
  });

  it('refuses the company over its quota whoever asks', () => {
    const { a } = gate({ userPerHour: 100 });
    for (let i = 0; i < 5; i++) solve(a, 'tA', `u${i}`);
    const r = a.reserve('tA', 'u9');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SOLVE_QUOTA_TENANT');
    expect(a.reserve('tB', 'x').ok).toBe(true); // another company is not affected
  });

  it('a released reservation (a refused or no-op start) uses no quota', () => {
    const { a } = gate();
    for (let i = 0; i < 10; i++) ok(a.reserve('tA', 'u1')).release();
    solve(a, 'tA', 'u1');
    solve(a, 'tA', 'u1');
    solve(a, 'tA', 'u1');
    expect(a.reserve('tA', 'u1').ok).toBe(false);
  });

  it('open reservations count, so two concurrent requests cannot both take the last start', () => {
    const { a } = gate({ userPerHour: 1 });
    const first = ok(a.reserve('tA', 'u1'));
    expect(a.reserve('tA', 'u1').ok).toBe(false);
    first.release();
    expect(a.reserve('tA', 'u1').ok).toBe(true);
  });

  it('quotas are off where every rate limit is off (tests, RATE_LIMITS_DISABLED off Railway); the caps still apply', () => {
    const { a } = gate({ userPerHour: 1, globalConcurrent: 1 }, { quotasOff: true });
    const t1 = ok(a.reserve('tA', 'u1'));
    t1.commit();
    const t2 = ok(a.reserve('tA', 'u1'));
    expect(t2.waiting).toBe(true);
    t1.release();
    expect(t2.waiting).toBe(false);
  });
});

describe('concurrency: 2 per company, a global cap, a FIFO queue', () => {
  it('a third solve of one company waits, and starts when one of the first two ends', async () => {
    const { a } = gate();
    const t1 = ok(a.reserve('tA', 'u1'));
    const t2 = ok(a.reserve('tA', 'u2'));
    const t3 = ok(a.reserve('tA', 'u3'));
    expect([t1.waiting, t2.waiting, t3.waiting]).toEqual([false, false, true]);
    expect(t3.position()).toBe(1);
    let started = false;
    const p = t3.ready().then(() => (started = true));
    await Promise.resolve();
    expect(started).toBe(false);
    t1.release();
    await p;
    expect(started).toBe(true);
    expect(a.snapshot()).toMatchObject({ running: 2, waiting: 0, runningByTenant: { tA: 2 } });
  });

  it('another company runs while one company waits at its own cap (global cap permitting)', () => {
    const { a } = gate();
    ok(a.reserve('tA', 'u1'));
    ok(a.reserve('tA', 'u2'));
    const aWait = ok(a.reserve('tA', 'u3'));
    const b = ok(a.reserve('tB', 'v1'));
    expect(aWait.waiting).toBe(true);
    expect(b.waiting).toBe(false);
    expect(a.snapshot().running).toBe(3);
  });

  it('first come, first served across companies at the global cap', () => {
    const { a } = gate({ globalConcurrent: 1 });
    const t1 = ok(a.reserve('tA', 'u1'));
    const t2 = ok(a.reserve('tB', 'v1'));
    const t3 = ok(a.reserve('tC', 'w1'));
    expect([t2.position(), t3.position()]).toEqual([1, 2]);
    t1.release();
    expect(t2.waiting).toBe(false);
    expect(t3.waiting).toBe(true);
  });

  it('a full queue answers 503 SOLVER_BUSY', () => {
    const { a } = gate({ globalConcurrent: 1, maxQueue: 2 });
    ok(a.reserve('tA', 'u1'));
    ok(a.reserve('tB', 'u1'));
    ok(a.reserve('tC', 'u1'));
    const r = a.reserve('tD', 'u1');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.code).toBe('SOLVER_BUSY');
      expect(r.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('releasing a waiting ticket removes it from the queue; release is idempotent', () => {
    const { a } = gate({ globalConcurrent: 1 });
    const t1 = ok(a.reserve('tA', 'u1'));
    const t2 = ok(a.reserve('tB', 'u1'));
    t2.release();
    t2.release();
    expect(a.snapshot()).toMatchObject({ running: 1, waiting: 0 });
    t1.release();
    t1.release();
    expect(a.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });
});
