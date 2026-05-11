/**
 * Minimal in-memory rate limiter for Phase 0. Replace with Upstash Redis in prod.
 * See CLAUDE.md section 15 for required limits.
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  // Bypass for integration tests — they hammer endpoints from a single IP.
  // Set RATE_LIMITS_DISABLED=1 in test env OR run with NODE_ENV=test.
  if (process.env.RATE_LIMITS_DISABLED === '1' || process.env.NODE_ENV === 'test') {
    return { ok: true, remaining: limit, resetAt: Date.now() + windowMs };
  }
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt < now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { ok: true, remaining: limit - 1, resetAt };
  }
  if (existing.count >= limit) {
    return { ok: false, remaining: 0, resetAt: existing.resetAt };
  }
  existing.count += 1;
  return { ok: true, remaining: limit - existing.count, resetAt: existing.resetAt };
}

export const LIMITS = {
  auth: { limit: 5, windowMs: 60_000 },
  ordersUpload: { limit: 10, windowMs: 60 * 60_000 },
  optimize: { limit: 30, windowMs: 60 * 60_000 },
  defaultAuthed: { limit: 300, windowMs: 60_000 },
} as const;
