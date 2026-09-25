/**
 * Stabilization PR3 - solve admission (review F16), with a fake clock: hourly quotas per user and
 * per company (only real starts count), the concurrency caps with a first-in-first-out queue, and
 * a released reservation that costs nothing.
 */
import { describe, expect, it } from 'vitest';
import { defaultAdmissionLimits, SolveAdmission, type AdmissionLimits, type SolveTicket } from '@/lib/dispatch/solve-admission';

const LIMITS: AdmissionLimits = { userPerHour: 3, tenantPerHour: 5, tenantConcurrent: 2, globalConcurrent: 3, maxQueue: 2, tenantQueue: 2, windowMs: 60 * 60_000 };

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
  it('15 per user and 30 per company per hour; SOLVER_MAX_CONCURRENT in total and one less per company; 10 waiting, 2 per company', () => {
    expect(defaultAdmissionLimits({} as NodeJS.ProcessEnv)).toEqual({ userPerHour: 15, tenantPerHour: 30, tenantConcurrent: 1, globalConcurrent: 2, maxQueue: 10, tenantQueue: 2, windowMs: 3_600_000 });
    const env = (v: string) => ({ SOLVER_MAX_CONCURRENT: v }) as unknown as NodeJS.ProcessEnv;
    expect(defaultAdmissionLimits(env('3'))).toMatchObject({ globalConcurrent: 3, tenantConcurrent: 2 });
    expect(defaultAdmissionLimits(env('1'))).toMatchObject({ globalConcurrent: 1, tenantConcurrent: 1 });
    expect(defaultAdmissionLimits(env('zero'))).toMatchObject({ globalConcurrent: 2, tenantConcurrent: 1 });
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

describe('fairness across companies (review: one company must not take every slot and the whole queue)', () => {
  /** The reviewer's case on the shipped defaults, quotas on: 12 starts by one sign-up company. */
  function flood(globalEnv?: string) {
    let now = 1_000_000;
    const limits = defaultAdmissionLimits((globalEnv ? { SOLVER_MAX_CONCURRENT: globalEnv } : {}) as unknown as NodeJS.ProcessEnv);
    const a = new SolveAdmission(limits, () => now, () => false);
    const other = Array.from({ length: 12 }, () => a.reserve('signup', 'u1'));
    for (const r of other) if (r.ok) r.ticket.commit();
    return { a, other, advance: (ms: number) => (now += ms) };
  }
  const state = (r: ReturnType<SolveAdmission['reserve']>) => (r.ok ? (r.ticket.waiting ? 'queued' : 'running') : r.code);

  it('defaults (2 in total): the other company runs 1 and queues 2, the rest get 429 for that company only; NMWC runs at once', () => {
    const { a, other } = flood();
    expect(other.map(state)).toEqual(['running', 'queued', 'queued', ...Array(9).fill('SOLVE_QUEUE_TENANT')]);
    const refused = other[3]!;
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.status).toBe(429);
      expect(refused.retryAfterSec).toBeGreaterThan(0);
    }
    expect(a.snapshot()).toMatchObject({ running: 1, waiting: 2, runningByTenant: { signup: 1 }, waitingByTenant: { signup: 2 } });
    const nmwc = a.reserve('nmwc', 'd1');
    expect(state(nmwc)).toBe('running');
    expect(a.snapshot().runningByTenant).toEqual({ signup: 1, nmwc: 1 });
  });

  it('1 in total: NMWC is first in the queue ahead of the other company, and gets the next free slot', () => {
    const { a, other } = flood('1');
    expect(other.map(state).slice(0, 4)).toEqual(['running', 'queued', 'queued', 'SOLVE_QUEUE_TENANT']);
    const nmwc = ok(a.reserve('nmwc', 'd1'));
    expect(nmwc.waiting).toBe(true);
    expect(nmwc.position()).toBe(1);
    // The other company's running solve ends: the slot goes to NMWC, not to its older waiting solves.
    (other[0] as { ticket: SolveTicket }).ticket.release();
    expect(nmwc.waiting).toBe(false);
    expect(a.snapshot()).toMatchObject({ runningByTenant: { nmwc: 1 }, waitingByTenant: { signup: 2 } });
  });

  it('a freed slot goes to the company with the fewest solves running, first come first served within a company', () => {
    const { a } = gate({ globalConcurrent: 2, tenantConcurrent: 2, maxQueue: 10 });
    const a1 = ok(a.reserve('tA', 'u1'));
    const a2 = ok(a.reserve('tA', 'u1'));
    const a3 = ok(a.reserve('tA', 'u2'));
    const b1 = ok(a.reserve('tB', 'v1'));
    const a4 = ok(a.reserve('tA', 'u3'));
    expect([a3.waiting, b1.waiting, a4.waiting]).toEqual([true, true, true]);
    expect([b1.position(), a3.position(), a4.position()]).toEqual([1, 2, 3]);
    a1.release(); // tA 1 running, tB 0: B goes first although A's waiting solve is older
    expect(b1.waiting).toBe(false);
    expect([a3.waiting, a4.waiting]).toEqual([true, true]);
    a2.release(); // tA 0, tB 1: A's oldest waiting solve
    expect(a3.waiting).toBe(false);
    expect(a4.waiting).toBe(true);
    expect(a4.position()).toBe(1);
  });

  it('the per-company queue cap is counted per company, and frees up when a waiting solve starts or is released', () => {
    const { a } = gate({ globalConcurrent: 1, tenantConcurrent: 1, maxQueue: 10, tenantQueue: 1 });
    const t1 = ok(a.reserve('tA', 'u1'));
    const w1 = ok(a.reserve('tA', 'u1'));
    expect(a.reserve('tA', 'u2')).toMatchObject({ ok: false, status: 429, code: 'SOLVE_QUEUE_TENANT' });
    expect(ok(a.reserve('tB', 'v1')).waiting).toBe(true); // another company still queues
    w1.release();
    expect(ok(a.reserve('tA', 'u2')).waiting).toBe(true);
    t1.release();
    expect(a.snapshot()).toMatchObject({ running: 1, runningByTenant: { tB: 1 }, waitingByTenant: { tA: 1 } });
  });
});
