/**
 * In-memory fixed-window rate limiter.
 *
 * The web app runs as exactly ONE replica (handbook 2.7), so process memory is a valid store.
 * Buckets are swept when they expire and the map has a hard size cap, so keys an attacker
 * controls (IP addresses, emails) cannot grow memory without bound.
 *
 * Bypass: `RATE_LIMITS_DISABLED=1` or `NODE_ENV=test` turn every limit off, for the integration
 * suite, which hammers the API from one IP. On Railway the flag is ignored (limits stay on) and
 * an error is logged; see `rateLimitBypass()`.
 */
type Bucket = { count: number; resetAt: number };

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

export interface LimiterOptions {
  /** Hard cap on live buckets; the oldest are evicted beyond it. */
  maxKeys?: number;
  /** Minimum gap between sweeps of expired buckets. */
  sweepEveryMs?: number;
  now?: () => number;
  /** True = every call passes and nothing is stored. Read on every call. */
  bypass?: () => boolean;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = 0;
  private readonly maxKeys: number;
  private readonly sweepEveryMs: number;
  private readonly now: () => number;
  private readonly bypass: () => boolean;

  constructor(opts: LimiterOptions = {}) {
    this.maxKeys = opts.maxKeys ?? 20_000;
    this.sweepEveryMs = opts.sweepEveryMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.bypass = opts.bypass ?? (() => false);
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Drop expired buckets. Returns how many were removed. */
  sweep(): number {
    const now = this.now();
    this.lastSweep = now;
    let removed = 0;
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) {
        this.buckets.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  private live(key: string): Bucket | undefined {
    const b = this.buckets.get(key);
    if (b && b.resetAt <= this.now()) {
      this.buckets.delete(key);
      return undefined;
    }
    return b;
  }

  private insert(key: string, bucket: Bucket) {
    const now = this.now();
    if (now - this.lastSweep >= this.sweepEveryMs) this.sweep();
    if (this.buckets.size >= this.maxKeys) this.sweep();
    // Still full: evict the oldest insertions (Map keeps insertion order).
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    this.buckets.set(key, bucket);
  }

  /** Check and count one request in the window. */
  consume(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = this.now();
    if (this.bypass()) return { ok: true, remaining: limit, resetAt: now + windowMs };
    const existing = this.live(key);
    if (!existing) {
      const resetAt = now + windowMs;
      this.insert(key, { count: 1, resetAt });
      return { ok: true, remaining: limit - 1, resetAt };
    }
    if (existing.count >= limit) return { ok: false, remaining: 0, resetAt: existing.resetAt };
    existing.count += 1;
    return { ok: true, remaining: limit - existing.count, resetAt: existing.resetAt };
  }

  /** Read-only: true when `key` has already used up `limit` in its current window. */
  isBlocked(key: string, limit: number): boolean {
    if (this.bypass()) return false;
    const b = this.live(key);
    return !!b && b.count >= limit;
  }

  /** Count one event (for example a failed sign-in) without checking. Returns the new count. */
  hit(key: string, windowMs: number): number {
    if (this.bypass()) return 0;
    const b = this.live(key);
    if (!b) {
      this.insert(key, { count: 1, resetAt: this.now() + windowMs });
      return 1;
    }
    b.count += 1;
    return b.count;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

function onRailway(env: NodeJS.ProcessEnv): boolean {
  return !!(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);
}

/**
 * Should the limiter be bypassed? `RATE_LIMITS_DISABLED=1` is for test servers only. On Railway
 * (the production platform) it is ignored so a leftover variable cannot silently remove all
 * throttling.
 */
export function rateLimitBypass(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'test') return true;
  if (env.RATE_LIMITS_DISABLED !== '1') return false;
  return !onRailway(env);
}

/**
 * Startup check (instrumentation.ts): an error line when RATE_LIMITS_DISABLED=1 is set on a
 * production server outside CI. Returns the message, or null when the configuration is fine.
 */
export function rateLimitConfigProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.RATE_LIMITS_DISABLED !== '1' || env.NODE_ENV !== 'production' || env.CI) return null;
  return onRailway(env)
    ? 'RATE_LIMITS_DISABLED=1 is set on Railway. It is ignored there (limits stay on); remove the variable.'
    : 'RATE_LIMITS_DISABLED=1 is set on a production server: every rate limit, sign-in throttling included, is OFF.';
}

const g = globalThis as unknown as { __routeiqLimiter?: RateLimiter };
/** The process-wide limiter (shared with the instrumentation bundle, like the Prisma client). */
export const limiter: RateLimiter = g.__routeiqLimiter ?? new RateLimiter({ bypass: () => rateLimitBypass() });
g.__routeiqLimiter = limiter;

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  return limiter.consume(key, limit, windowMs);
}

export const LIMITS = {
  auth: { limit: 5, windowMs: 60_000 },
  ordersUpload: { limit: 60, windowMs: 60 * 60_000 }, // daily loop: upload -> fix -> re-upload
  // Optimization starts are limited by the solve admission (lib/dispatch/solve-admission.ts), not here.
  /** Sign-in throttle (lib/auth-credentials.ts). Soft: it pauses attempts, it never locks an account. */
  loginIpEmailFailures: { limit: 5, windowMs: 15 * 60_000 },
  loginIpAttempts: { limit: 30, windowMs: 10 * 60_000 },
  loginEmailFailures: { limit: 20, windowMs: 60 * 60_000 },
} as const;
