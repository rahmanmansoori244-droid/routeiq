/**
 * Stabilization PR3 - solve admission (review F16), with a fake clock: hourly quotas per user and
 * per company (only real starts count), the concurrency caps with a first-in-first-out queue, and
 * a released reservation that costs nothing.
 */
import { describe, expect, it } from 'vitest';
import { defaultAdmissionLimits, SolveAdmission, type AdmissionLimits, type SolveTicket } from '@/lib/dispatch/solve-admission';

const LIMITS: AdmissionLimits = { userPerHour: 3, tenantPerHour: 5, tenantConcurrent: 2, globalConcurrent: 3, maxQueue: 2, queueHardCap: 200, tenantQueue: 2, windowMs: 60 * 60_000 };

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
  it('15 per user and 30 per company per hour; SOLVER_MAX_CONCURRENT in total and one less per company; a shared queue of 10 (200 at most), 2 per company', () => {
    expect(defaultAdmissionLimits({} as NodeJS.ProcessEnv)).toEqual({ userPerHour: 15, tenantPerHour: 30, tenantConcurrent: 1, globalConcurrent: 2, maxQueue: 10, queueHardCap: 200, tenantQueue: 2, windowMs: 3_600_000 });
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

  it('a full shared queue answers 503 SOLVER_BUSY to a company that already has a solve waiting', () => {
    const { a } = gate({ globalConcurrent: 1, maxQueue: 2 });
    ok(a.reserve('tA', 'u1'));
    ok(a.reserve('tB', 'u1'));
    ok(a.reserve('tC', 'u1'));
    const r = a.reserve('tB', 'u2'); // tB has one waiting already
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.code).toBe('SOLVER_BUSY');
      expect(r.retryAfterSec).toBeGreaterThan(0);
    }
    // A company with nothing waiting is still queued (review of PR3: others must not lock it out).
    expect(ok(a.reserve('tD', 'u1')).waiting).toBe(true);
  });

  it('only the absolute cap (process memory) refuses a company with nothing waiting', () => {
    const { a } = gate({ globalConcurrent: 1, maxQueue: 2, queueHardCap: 3 });
    ok(a.reserve('tA', 'u1'));
    for (const t of ['tB', 'tC', 'tD']) expect(ok(a.reserve(t, 'u1')).waiting).toBe(true);
    expect(a.reserve('tE', 'u1')).toMatchObject({ ok: false, status: 503, code: 'SOLVER_BUSY' });
    expect(a.snapshot()).toMatchObject({ running: 1, waiting: 3 });
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

  it('1 in total: NMWC waits only for the solves queued before it, first come first served', () => {
    const { a, other } = flood('1');
    expect(other.map(state).slice(0, 4)).toEqual(['running', 'queued', 'queued', 'SOLVE_QUEUE_TENANT']);
    const nmwc = ok(a.reserve('nmwc', 'd1'));
    expect(nmwc.waiting).toBe(true);
    expect(nmwc.position()).toBe(3); // behind the other company's 2 solves that were waiting already
    const tickets = other.filter((r) => r.ok).map((r) => (r as { ticket: SolveTicket }).ticket);
    tickets[0]!.release(); // its running solve ends: its oldest waiting solve (queued before NMWC) starts
    expect([tickets[1]!.waiting, nmwc.waiting]).toEqual([false, true]);
    // It presses again: that solve is queued after NMWC, so it starts after NMWC.
    const again = ok(a.reserve('signup', 'u1'));
    expect([nmwc.position(), again.position()]).toEqual([2, 3]);
    tickets[1]!.release();
    tickets[2]!.release();
    expect(nmwc.waiting).toBe(false);
    expect(again.waiting).toBe(true);
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

  describe('several companies fill the shared queue (review of PR3: NMWC got 503 SOLVER_BUSY)', () => {
    /** Five sign-up companies press OPTIMIZE 3 times each on the shipped defaults, quotas on. */
    function attack() {
      const a = new SolveAdmission(defaultAdmissionLimits({} as NodeJS.ProcessEnv), () => 1_000_000, () => false);
      const presses: Record<string, ReturnType<SolveAdmission['reserve']>[]> = {};
      for (const s of ['S1', 'S2', 'S3', 'S4', 'S5']) {
        presses[s] = Array.from({ length: 3 }, () => a.reserve(s, 'u1'));
        for (const r of presses[s]!) if (r.ok) r.ticket.commit();
      }
      const ticket = (s: string, i: number) => (presses[s]![i] as { ticket: SolveTicket }).ticket;
      return { a, presses, ticket };
    }

    it('5 companies x 2 waiting fill the queue of 10; NMWC, with nothing waiting, is queued - not refused', () => {
      const { a, presses } = attack();
      expect(presses.S1!.map(state)).toEqual(['running', 'queued', 'queued']);
      expect(presses.S2!.map(state)).toEqual(['running', 'queued', 'queued']);
      for (const s of ['S3', 'S4', 'S5']) expect(presses[s]!.map(state)).toEqual(['queued', 'queued', 'SOLVE_QUEUE_TENANT']);
      expect(a.snapshot()).toMatchObject({ running: 2, waiting: 10 });
      const nmwc = a.reserve('nmwc', 'd1');
      expect(state(nmwc)).toBe('queued');
      // The queue is full: a company that already has a solve waiting gets 503 until there is room.
      expect(state(a.reserve('nmwc', 'd2'))).toBe('SOLVER_BUSY');
      expect(a.snapshot()).toMatchObject({ waiting: 11, waitingByTenant: { nmwc: 1 } });
    });

    it('NMWC starts before every solve queued after it; fresh sign-ups arriving later do not jump ahead', () => {
      const { a, presses, ticket } = attack();
      const nmwc = ok(a.reserve('nmwc', 'd1'));
      // A stream of brand-new companies (none of them ever ran a solve) after NMWC.
      const fresh = ['F1', 'F2', 'F3'].map((f) => ok(a.reserve(f, 'u1')));
      expect(fresh.every((t) => t.waiting)).toBe(true);
      // 9 of the 10 solves waiting before it; the tenth (S5's second) belongs to a company that is
      // running one by then, so NMWC (nothing running) goes first.
      expect(nmwc.position()).toBe(10);
      expect(fresh.map((t) => t.position())).toEqual([12, 13, 14]);

      // Drive the queue: the running solves end oldest first, and each attacker presses again at once.
      const label = new Map<SolveTicket, string>();
      for (const s of ['S1', 'S2', 'S3', 'S4', 'S5']) {
        for (const r of presses[s]!) if (r.ok && r.ticket.waiting) label.set(r.ticket, 'queued before');
      }
      expect(label.size).toBe(10);
      label.set(nmwc, 'nmwc');
      for (const t of fresh) label.set(t, 'fresh sign-up');
      const running = [ticket('S1', 0), ticket('S2', 0)];
      const started = new Set<SolveTicket>();
      const kinds: string[] = [];
      for (let i = 0; i < 50 && nmwc.waiting; i++) {
        const ended = running.shift()!;
        ended.release();
        for (const [t, what] of label) {
          if (t.waiting || started.has(t)) continue;
          started.add(t);
          running.push(t);
          kinds.push(what);
        }
        const again = a.reserve(ended.tenantId, 'u1');
        if (again.ok) label.set(again.ticket, 'queued after');
      }
      expect(kinds).toEqual([...Array(9).fill('queued before'), 'nmwc']); // as position() said
      expect(fresh.every((t) => t.waiting)).toBe(true);
    });

    it('what is not guaranteed (third review of PR3: the docs promised it): a company running a solve is overtaken by later solves', () => {
      // Defaults: 2 in total, 1 per company. NMWC runs one solve and queues a second (another depot).
      const a = new SolveAdmission(defaultAdmissionLimits({} as NodeJS.ProcessEnv), () => 1_000_000, () => false);
      const nmwc1 = ok(a.reserve('nmwc', 'd1'));
      const s1 = ok(a.reserve('S1', 'u1'));
      const nmwc2 = ok(a.reserve('nmwc', 'd1'));
      const f1 = ok(a.reserve('F1', 'u1')); // queued after NMWC's second solve
      expect([nmwc1.waiting, s1.waiting, nmwc2.waiting, f1.waiting]).toEqual([false, false, true, true]);
      s1.release(); // S1's solve ends first; NMWC is at its own cap: the later sign-up gets the slot
      expect([f1.waiting, nmwc2.waiting]).toEqual([false, true]);
      nmwc1.release(); // its own solve ends: now its second one starts
      expect(nmwc2.waiting).toBe(false);
    });
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
