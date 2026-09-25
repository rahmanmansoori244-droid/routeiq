/**
 * Solve admission (review F16): one shared gate in front of every optimization start - the day
 * screen's OPTIMIZE (POST /api/dispatch/plan), Re-plan (POST /api/runs/:id/replan) and the legacy
 * POST /api/runs/:id/optimize all go through startDispatchOptimize, which reserves here.
 *
 * - Hourly quotas: 15 optimization starts per user and 30 per company in any rolling hour.
 *   Over quota the start is refused with 429 and Retry-After. Only starts that really began a
 *   job count: a refused or no-op start (location or weight question, nothing to plan, already
 *   running, ...) releases its reservation without using quota.
 * - Concurrency: SOLVER_MAX_CONCURRENT (default 2, sized to the solver's CPUs) solves in total,
 *   and per company one less than that (at least 1). So one company can never hold every solver
 *   slot: another company's OPTIMIZE gets the next free one. A start beyond the caps is not
 *   refused: its job is created and waits in the queue until a slot frees.
 * - Fair queue: a company may have at most 2 solves waiting. One more is refused with 429 and
 *   Retry-After, for that company only. The shared queue holds 10: once it is full, a company that
 *   already has a solve waiting is refused with 503 "optimizer busy" until there is room, but a
 *   company with nothing waiting is always queued - other companies filling the queue never lock it
 *   out (review of PR3: five sign-up companies with 2 waiting each got NMWC a 503). Only an
 *   absolute cap of 200 waiting (process memory) refuses every start that would wait.
 * - Slot order: a freed slot goes to the waiting solve of the company with the fewest solves
 *   running; among those, first come first served - the solve queued first, whether or not its
 *   company ever ran one (a new company never jumps ahead of one already waiting); so FIFO within
 *   a company. A company at its own concurrency cap keeps waiting.
 * - The slot is held from the reservation until the job ends (success, failure or stale result).
 *
 * Process memory is a valid store: the web runs as one replica (handbook 2.7). During a deploy
 * overlap two processes can each admit their own solves, so the solver also refuses more than
 * MAX_CONCURRENT_DISPATCH concurrent solves itself (503, apps/solver/main.py).
 *
 * The quotas are off where every rate limit is off (NODE_ENV=test, or RATE_LIMITS_DISABLED=1 off
 * Railway - see rateLimitBypass); the concurrency caps and the queue caps always apply.
 */
import { rateLimitBypass } from '../rate-limit';

export interface AdmissionLimits {
  userPerHour: number;
  tenantPerHour: number;
  /** Solves of one company running at the same time. */
  tenantConcurrent: number;
  /** Solves running at the same time over all companies. */
  globalConcurrent: number;
  /**
   * The shared queue: once this many solves wait (over all companies), a company that already has
   * one waiting is refused (503). A company with nothing waiting is still queued.
   */
  maxQueue: number;
  /** Absolute cap on waiting solves (process memory): past it every start that would wait gets 503. */
  queueHardCap: number;
  /** Solves of one company waiting for a slot. */
  tenantQueue: number;
  windowMs: number;
}

function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Per company one slot less than in total (at least 1), so a company can never hold every slot:
 * with the default SOLVER_MAX_CONCURRENT=2 one solve per company runs at a time and a second one
 * waits; SOLVER_MAX_CONCURRENT=3 (with the solver's MAX_CONCURRENT_DISPATCH=3) allows 2.
 */
export function defaultAdmissionLimits(env: NodeJS.ProcessEnv = process.env): AdmissionLimits {
  const globalConcurrent = envInt('SOLVER_MAX_CONCURRENT', 2, env);
  return {
    userPerHour: 15,
    tenantPerHour: 30,
    tenantConcurrent: Math.max(1, globalConcurrent - 1),
    globalConcurrent,
    maxQueue: 10,
    queueHardCap: 200,
    tenantQueue: 2,
    windowMs: 60 * 60_000,
  };
}

export type AdmissionCode = 'SOLVE_QUOTA_USER' | 'SOLVE_QUOTA_TENANT' | 'SOLVE_QUEUE_TENANT' | 'SOLVER_BUSY';

export interface AdmissionDenied {
  ok: false;
  status: 429 | 503;
  code: AdmissionCode;
  error: string;
  retryAfterSec: number;
}

export interface SolveTicket {
  readonly tenantId: string;
  readonly userId: string;
  /** True while the ticket waits for a free solver slot. */
  readonly waiting: boolean;
  /** Resolves when the ticket holds a solver slot (immediately when one was free). */
  ready(): Promise<void>;
  /**
   * Place in the queue: 1 = starts next; 0 when it holds a slot. An estimate: it assumes the
   * running solves end in the order they started.
   */
  position(): number;
  /** The job was created: the start counts against the hourly quotas. Idempotent. */
  commit(): void;
  /** Give the slot (or queue place) back. Idempotent; an uncommitted ticket uses no quota. */
  release(): void;
}

export type AdmissionResult = { ok: true; ticket: SolveTicket } | AdmissionDenied;

interface TicketState {
  tenantId: string;
  userId: string;
  committed: boolean;
  released: boolean;
  running: boolean;
  /** Order of reservation (first come, first served). */
  seq: number;
  resolve: () => void;
  promise: Promise<void>;
}

export class SolveAdmission {
  private readonly starts = new Map<string, number[]>(); // quota key -> start times in the window
  private readonly pending = new Map<string, number>(); // quota key -> reserved, not yet committed
  /** Solves holding a slot, in the order they started. */
  private readonly running = new Set<TicketState>();
  /** Solves waiting for a slot, in the order they were queued. */
  private readonly queue: TicketState[] = [];
  private seq = 0;

  constructor(
    private readonly limits: AdmissionLimits = defaultAdmissionLimits(),
    private readonly now: () => number = Date.now,
    private readonly quotasOff: () => boolean = () => rateLimitBypass(),
  ) {}

  /** Reserve a solve for this user. Synchronous, so two requests cannot both take the last slot. */
  reserve(tenantId: string, userId: string): AdmissionResult {
    const userKey = `u:${tenantId}:${userId}`;
    const tenantKey = `t:${tenantId}`;
    if (!this.quotasOff()) {
      const over = this.overQuota(userKey, this.limits.userPerHour) ?? null;
      if (over !== null) {
        return this.deny(429, 'SOLVE_QUOTA_USER', `You started ${this.limits.userPerHour} optimizations in the last hour, the most allowed. Try again in ${minutes(over)}.`, over);
      }
      const overT = this.overQuota(tenantKey, this.limits.tenantPerHour);
      if (overT !== null) {
        return this.deny(429, 'SOLVE_QUOTA_TENANT', `Your company started ${this.limits.tenantPerHour} optimizations in the last hour, the most allowed. Try again in ${minutes(overT)}.`, overT);
      }
    }
    const fits = this.fits(tenantId);
    if (!fits) {
      // Past its own queue cap a company is refused alone: the shared queue stays open to others.
      const mineWaiting = this.queue.filter((q) => q.tenantId === tenantId).length;
      if (mineWaiting >= this.limits.tenantQueue) {
        return this.deny(
          429,
          'SOLVE_QUEUE_TENANT',
          `Your company already has ${mineWaiting} optimization(s) waiting for the route optimizer. Try again once one of them has started.`,
          120,
        );
      }
      // A full shared queue refuses only a company that already has a solve waiting: one with
      // nothing waiting is queued, so other companies filling the queue never lock it out. The
      // queue grows by at most one solve per company past maxQueue; queueHardCap bounds memory.
      if ((mineWaiting > 0 && this.queue.length >= this.limits.maxQueue) || this.queue.length >= this.limits.queueHardCap) {
        return this.deny(503, 'SOLVER_BUSY', 'The route optimizer is busy with other plans. Try again in a few minutes.', 120);
      }
    }
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    const st: TicketState = { tenantId, userId, committed: false, released: false, running: false, seq: ++this.seq, resolve, promise };
    if (!this.quotasOff()) {
      this.pending.set(userKey, (this.pending.get(userKey) ?? 0) + 1);
      this.pending.set(tenantKey, (this.pending.get(tenantKey) ?? 0) + 1);
    }
    if (fits) this.start(st);
    else this.queue.push(st);
    return { ok: true, ticket: this.ticketOf(st, userKey, tenantKey) };
  }

  /** For tests and diagnostics. */
  snapshot(): { running: number; waiting: number; runningByTenant: Record<string, number>; waitingByTenant: Record<string, number> } {
    const count = (list: Iterable<TicketState>) => {
      const out: Record<string, number> = {};
      for (const s of list) out[s.tenantId] = (out[s.tenantId] ?? 0) + 1;
      return out;
    };
    return { running: this.running.size, waiting: this.queue.length, runningByTenant: count(this.running), waitingByTenant: count(this.queue) };
  }

  private ticketOf(st: TicketState, userKey: string, tenantKey: string): SolveTicket {
    const self = this;
    const counted = !this.quotasOff();
    const unpend = () => {
      if (!counted) return;
      for (const k of [userKey, tenantKey]) {
        const n = (self.pending.get(k) ?? 1) - 1;
        if (n > 0) self.pending.set(k, n);
        else self.pending.delete(k);
      }
    };
    return {
      tenantId: st.tenantId,
      userId: st.userId,
      get waiting() {
        return !st.running && !st.released;
      },
      ready: () => st.promise,
      position: () => (st.running || st.released ? 0 : self.startOrder().indexOf(st) + 1),
      commit: () => {
        if (st.committed || st.released) return;
        st.committed = true;
        unpend();
        if (counted) {
          const t = self.now();
          for (const k of [userKey, tenantKey]) self.starts.set(k, [...self.window(k), t]);
        }
      },
      release: () => {
        if (st.released) return;
        st.released = true;
        if (!st.committed) unpend();
        if (st.running) {
          self.running.delete(st);
        } else {
          const i = self.queue.indexOf(st);
          if (i >= 0) self.queue.splice(i, 1);
        }
        // A released waiting ticket must not keep its caller waiting forever.
        st.resolve();
        self.pump();
      },
    };
  }

  /** Start times of `key` inside the rolling window (older ones are dropped). */
  private window(key: string): number[] {
    const from = this.now() - this.limits.windowMs;
    const list = (this.starts.get(key) ?? []).filter((t) => t > from);
    if (list.length) this.starts.set(key, list);
    else this.starts.delete(key);
    return list;
  }

  /** Seconds until `key` may start again, or null when it is under `limit`. */
  private overQuota(key: string, limit: number): number | null {
    const used = this.window(key);
    const pending = this.pending.get(key) ?? 0;
    if (used.length + pending < limit) return null;
    // The oldest start leaves the window first; with only reservations pending, try in a minute.
    const oldest = used[0];
    return oldest === undefined ? 60 : Math.max(1, Math.ceil((oldest + this.limits.windowMs - this.now()) / 1000));
  }

  /** Solves running per company. */
  private runningCounts(): Map<string, number> {
    const n = new Map<string, number>();
    for (const s of this.running) n.set(s.tenantId, (n.get(s.tenantId) ?? 0) + 1);
    return n;
  }

  private fits(tenantId: string): boolean {
    if (this.running.size >= this.limits.globalConcurrent) return false;
    return (this.runningCounts().get(tenantId) ?? 0) < this.limits.tenantConcurrent;
  }

  /**
   * Index in `queue` of the ticket that gets the next free slot: the company with the fewest solves
   * running (`counts`), then the ticket queued first - first come, first served, whether or not
   * its company ever ran a solve (a new company never jumps ahead of one already waiting), so FIFO
   * within a company. With `capped`, companies at their own concurrency cap are skipped (-1 when
   * every waiting company is).
   */
  private nextIndex(queue: readonly TicketState[], counts: ReadonlyMap<string, number>, capped: boolean): number {
    let best = -1;
    let bestRunning = Number.POSITIVE_INFINITY;
    let bestSeq = Number.POSITIVE_INFINITY;
    queue.forEach((st, i) => {
      const n = counts.get(st.tenantId) ?? 0;
      if (capped && n >= this.limits.tenantConcurrent) return;
      if (n < bestRunning || (n === bestRunning && st.seq < bestSeq)) {
        best = i;
        bestRunning = n;
        bestSeq = st.seq;
      }
    });
    return best;
  }

  /**
   * The waiting tickets in the order they would start (for position()): the running solves are
   * assumed to end in the order they started, and each freed slot is given as pump() gives it.
   */
  private startOrder(): TicketState[] {
    const running = [...this.running];
    const counts = this.runningCounts();
    const rest = [...this.queue];
    const order: TicketState[] = [];
    const fill = () => {
      while (running.length < this.limits.globalConcurrent && rest.length) {
        const i = this.nextIndex(rest, counts, true);
        if (i < 0) return;
        const [st] = rest.splice(i, 1);
        order.push(st!);
        running.push(st!);
        counts.set(st!.tenantId, (counts.get(st!.tenantId) ?? 0) + 1);
      }
    };
    fill();
    while (rest.length) {
      const ended = running.shift();
      if (!ended) {
        order.push(...rest); // cannot happen (with nothing running every company fits); FIFO as a fallback
        break;
      }
      counts.set(ended.tenantId, (counts.get(ended.tenantId) ?? 1) - 1);
      fill();
    }
    return order;
  }

  private start(st: TicketState) {
    st.running = true;
    this.running.add(st);
    st.resolve();
  }

  /**
   * Give free slots to waiting tickets: each to the company with the fewest solves running, then
   * to the solve queued first (companies at their own cap keep waiting) - review F16.
   */
  private pump() {
    while (this.running.size < this.limits.globalConcurrent && this.queue.length) {
      const i = this.nextIndex(this.queue, this.runningCounts(), true);
      if (i < 0) break;
      const [st] = this.queue.splice(i, 1);
      this.start(st!);
    }
  }

  private deny(status: 429 | 503, code: AdmissionCode, error: string, retryAfterSec: number): AdmissionDenied {
    return { ok: false, status, code, error, retryAfterSec: Math.max(1, Math.round(retryAfterSec)) };
  }
}

function minutes(sec: number): string {
  const m = Math.ceil(sec / 60);
  return m <= 1 ? 'a minute' : `${m} minutes`;
}

const g = globalThis as unknown as { __routeiqSolveAdmission?: SolveAdmission };
/** The process-wide admission gate (shared with the instrumentation bundle, like the limiter). */
export const solveAdmission: SolveAdmission = g.__routeiqSolveAdmission ?? new SolveAdmission();
g.__routeiqSolveAdmission = solveAdmission;
