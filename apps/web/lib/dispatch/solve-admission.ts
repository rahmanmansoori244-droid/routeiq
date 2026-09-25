/**
 * Solve admission (review F16): one shared gate in front of every optimization start - the day
 * screen's OPTIMIZE (POST /api/dispatch/plan), Re-plan (POST /api/runs/:id/replan) and the legacy
 * POST /api/runs/:id/optimize all go through startDispatchOptimize, which reserves here.
 *
 * - Hourly quotas: 15 optimization starts per user and 30 per company in any rolling hour.
 *   Over quota the start is refused with 429 and Retry-After. Only starts that really began a
 *   job count: a refused or no-op start (location or weight question, nothing to plan, already
 *   running, ...) releases its reservation without using quota.
 * - Concurrency: at most 2 solves per company and SOLVER_MAX_CONCURRENT (default 2, sized to the
 *   solver's CPUs) in total run at the same time. A start beyond that is not refused: its job is
 *   created and waits in a first-in-first-out queue (at most 10 waiting) until a slot frees; only
 *   a full queue answers 503 "optimizer busy".
 * - The slot is held from the reservation until the job ends (success, failure or stale result).
 *
 * Process memory is a valid store: the web runs as one replica (handbook 2.7). During a deploy
 * overlap two processes can each admit their own solves, so the solver also refuses more than
 * MAX_CONCURRENT_DISPATCH concurrent solves itself (503, apps/solver/main.py).
 *
 * The quotas are off where every rate limit is off (NODE_ENV=test, or RATE_LIMITS_DISABLED=1 off
 * Railway - see rateLimitBypass); the concurrency caps always apply.
 */
import { rateLimitBypass } from '../rate-limit';

export interface AdmissionLimits {
  userPerHour: number;
  tenantPerHour: number;
  tenantConcurrent: number;
  globalConcurrent: number;
  maxQueue: number;
  windowMs: number;
}

function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultAdmissionLimits(env: NodeJS.ProcessEnv = process.env): AdmissionLimits {
  return {
    userPerHour: 15,
    tenantPerHour: 30,
    tenantConcurrent: 2,
    globalConcurrent: envInt('SOLVER_MAX_CONCURRENT', 2, env),
    maxQueue: 10,
    windowMs: 60 * 60_000,
  };
}

export type AdmissionCode = 'SOLVE_QUOTA_USER' | 'SOLVE_QUOTA_TENANT' | 'SOLVER_BUSY';

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
  /** Solves ahead of this one in the queue (0 when it holds a slot). */
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
  resolve: () => void;
  promise: Promise<void>;
}

export class SolveAdmission {
  private readonly starts = new Map<string, number[]>(); // quota key -> start times in the window
  private readonly pending = new Map<string, number>(); // quota key -> reserved, not yet committed
  private readonly running = new Set<TicketState>();
  private readonly queue: TicketState[] = [];

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
    if (!fits && this.queue.length >= this.limits.maxQueue) {
      return this.deny(503, 'SOLVER_BUSY', 'The route optimizer is busy with other plans. Try again in a few minutes.', 120);
    }
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    const st: TicketState = { tenantId, userId, committed: false, released: false, running: false, resolve, promise };
    if (!this.quotasOff()) {
      this.pending.set(userKey, (this.pending.get(userKey) ?? 0) + 1);
      this.pending.set(tenantKey, (this.pending.get(tenantKey) ?? 0) + 1);
    }
    if (fits) this.start(st);
    else this.queue.push(st);
    return { ok: true, ticket: this.ticketOf(st, userKey, tenantKey) };
  }

  /** For tests and diagnostics. */
  snapshot(): { running: number; waiting: number; runningByTenant: Record<string, number> } {
    const byTenant: Record<string, number> = {};
    for (const s of this.running) byTenant[s.tenantId] = (byTenant[s.tenantId] ?? 0) + 1;
    return { running: this.running.size, waiting: this.queue.length, runningByTenant: byTenant };
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
      position: () => (st.running ? 0 : Math.max(0, self.queue.indexOf(st)) + 1),
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

  private fits(tenantId: string): boolean {
    if (this.running.size >= this.limits.globalConcurrent) return false;
    let mine = 0;
    for (const s of this.running) if (s.tenantId === tenantId) mine++;
    return mine < this.limits.tenantConcurrent;
  }

  private start(st: TicketState) {
    st.running = true;
    this.running.add(st);
    st.resolve();
  }

  /** Give free slots to waiting tickets, oldest first (skipping companies at their own cap). */
  private pump() {
    for (let i = 0; i < this.queue.length; ) {
      const st = this.queue[i]!;
      if (this.fits(st.tenantId)) {
        this.queue.splice(i, 1);
        this.start(st);
      } else {
        i++;
      }
      if (this.running.size >= this.limits.globalConcurrent) break;
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
