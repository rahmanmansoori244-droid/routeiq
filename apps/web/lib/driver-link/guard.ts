/**
 * withDriverLink: the wrapper of every driver route under app/api/d (owner request 4 Oct 2026, spec
 * section 5). The token travels only in the header `Authorization: DriverLink <token>`; the API
 * paths carry none, so it is not written into server or proxy logs on every poll.
 *
 * 1. The token's shape is checked first (404, no database work).
 * 2. It is resolved (one unique-index lookup). A token that resolves, even to a 410, is never
 *    throttled by IP. Only an UNKNOWN hash counts against the IP (`dl-bad:<ip>`, 30 per 10 min),
 *    and never when the IP is unknown or internal (depot Wi-Fi, CGNAT, a proxy): over the limit,
 *    unknown tokens from that IP get 429; known tokens still pass.
 * 3. Per-link limits (LIMITS.driver*); every 429 carries Retry-After. The actions route counts one
 *    unit per action it carries (consumeMore); the write routes allow at most LIMITS.driverInFlight
 *    requests of one link in the handler at a time (maxInFlight).
 * 4. A signed-in RouteIQ session: of the link's company, the request is the office's (reads
 *    allowed; writes need PLANNER or above, else 403 SIGNED_IN_READ_ONLY); of another company,
 *    403 SIGNED_IN_OTHER_TENANT.
 * 5. Between the expiry and the end of the 72 h upload grace only routes that allow it (Part 2's
 *    POST actions and photos) reach the handler; a read answers 410 LINK_EXPIRED with uploadOnly.
 * 6. Every answer has Cache-Control no-store, Referrer-Policy no-referrer and X-Robots-Tag noindex.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import type { DriverLink } from '@prisma/client';
import { auth } from '../auth';
import { tenantDb, type TenantDb } from '../tenant';
import { clientIp, isInternalIp } from '../client-ip';
import { limiter, LIMITS } from '../rate-limit';
import { HttpError, httpErrorBody } from '../http-error';
import { resolveDriverLink, touchLink } from './service';
import { deviceHash, looksLikeToken } from './token';

export type DriverRouteLimit = 'manifest' | 'actions' | 'photo' | 'photoGet';

const LIMIT_OF: Record<DriverRouteLimit, { key: string; limit: number; windowMs: number }> = {
  manifest: { key: 'dl-get', ...LIMITS.driverManifest },
  actions: { key: 'dl-act', ...LIMITS.driverActions },
  photo: { key: 'dl-photo', ...LIMITS.driverPhotoBurst },
  photoGet: { key: 'dl-photo-get', ...LIMITS.driverPhotoGet },
};

export interface DriverLinkSession {
  userId: string;
  name: string;
  role: string;
}

export interface DriverLinkContext {
  link: DriverLink;
  mode: 'full' | 'uploadOnly';
  tenantId: string;
  truckId: string;
  /** The delivery date, YYYY-MM-DD. */
  date: string;
  expiresAt: Date;
  uploadUntil: Date;
  db: TenantDb;
  ip: string | null;
  /** The first 16 hex of SHA-256 of the page's per-browser id (X-Driver-Device), or null. */
  deviceId: string | null;
  /** A signed-in RouteIQ user of the link's company: the request is the office's. */
  session: DriverLinkSession | null;
  now: Date;
}

export interface DriverLinkOptions {
  limit: DriverRouteLimit;
  /** A write: a signed-in user below PLANNER is refused (403 SIGNED_IN_READ_ONLY). */
  write?: boolean;
  /** Reaches the handler in the upload-only grace (POST actions and photos, Part 2). */
  allowUploadOnly?: boolean;
  /**
   * At most this many requests of one link in the handler at the same moment (the writes: the phone
   * sends one at a time, so parallel requests are a flood holding pooled connections on the
   * outcome-day lock). Over it: 429 with Retry-After 2.
   */
  maxInFlight?: number;
}

/**
 * The request body as text, read through a reader that counts bytes and stops at `maxBytes`,
 * whatever the headers say (a chunked request has no Content-Length). Null = too large: the stream
 * is cancelled and nothing more is buffered.
 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Requests of each link in a write handler now (one web replica: process memory is the store). */
const inFlight = new Map<string, number>();

/** Counts `units` more against the route's per-link limit (the actions route: one unit per action). */
export function consumeMore(ctx: Pick<DriverLinkContext, 'link'>, limit: DriverRouteLimit, units: number): { ok: true } | { ok: false; response: NextResponse } {
  if (units <= 0) return { ok: true };
  const lim = LIMIT_OF[limit];
  const now = Date.now();
  const r = limiter.consume(`${lim.key}:${ctx.link.id}`, lim.limit, lim.windowMs, units);
  return r.ok ? { ok: true } : { ok: false, response: tooMany(r.resetAt, now) };
}

/** Headers on every driver answer (the token must not leak through Referer, caches or search engines). */
export const DRIVER_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

export function driverJson(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...DRIVER_HEADERS, ...extra } });
}

export function driverOk<T>(data: T, status = 200): NextResponse {
  return driverJson({ data, error: null }, status);
}

export function driverFail(error: string | Record<string, unknown>, status: number, extra: Record<string, string> = {}): NextResponse {
  return driverJson({ data: null, error }, status, extra);
}

/** The token of `Authorization: DriverLink <token>`, or null. */
export function tokenFromHeader(req: Request): string | null {
  const m = /^DriverLink\s+(\S+)\s*$/.exec(req.headers.get('authorization') ?? '');
  return m ? m[1]! : null;
}

/** The page's random per-browser id (32 hex), hashed; any other value is ignored. */
export function deviceFromHeader(req: Request): string | null {
  const raw = (req.headers.get('x-driver-device') ?? '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(raw) ? deviceHash(raw) : null;
}

function retryAfter(resetAt: number, now: number): Record<string, string> {
  return { 'Retry-After': String(Math.max(1, Math.ceil((resetAt - now) / 1000))) };
}

function tooMany(resetAt: number, now: number) {
  return driverFail({ code: 'RATE_LIMITED', message: 'Too many requests. It will be sent automatically.' }, 429, retryAfter(resetAt, now));
}

function mapError(err: unknown): NextResponse {
  if (err instanceof HttpError) return driverFail(httpErrorBody(err), err.status);
  if (err instanceof ZodError) return driverFail(err.flatten() as unknown as Record<string, unknown>, 400);
  console.error('[driver-link] route error', (err as Error)?.message ?? err);
  return driverFail('Internal server error', 500);
}

async function readSession(): Promise<{ userId: string; name: string; role: string; tenantId: string | null } | null> {
  try {
    const s = await auth();
    if (!s?.user?.id) return null;
    return { userId: s.user.id, name: s.user.name ?? '', role: s.user.role, tenantId: s.user.tenantId ?? null };
  } catch {
    return null;
  }
}

const RANK: Record<string, number> = { SUPER_ADMIN: 100, TENANT_ADMIN: 80, SUPERVISOR: 60, PLANNER: 50, VIEWER: 10 };

export function withDriverLink(handler: (req: Request, ctx: DriverLinkContext) => Promise<Response>, opts: DriverLinkOptions) {
  return async (req: Request): Promise<Response> => {
    try {
      const nowMs = Date.now();
      const token = tokenFromHeader(req);
      if (!looksLikeToken(token)) {
        return driverFail({ code: 'LINK_NOT_FOUND', message: 'This link does not work any more. Ask your dispatcher for a new one.' }, 404);
      }
      const ip = clientIp(req);
      const now = new Date(nowMs);
      const r = await resolveDriverLink(token, { now });
      if (!r.ok) {
        // Only an unknown hash counts, and only against a known public IP.
        if (!r.known && ip && !isInternalIp(ip)) {
          const b = limiter.consume(`dl-bad:${ip}`, LIMITS.driverBadToken.limit, LIMITS.driverBadToken.windowMs);
          if (!b.ok) return tooMany(b.resetAt, nowMs);
        }
        return driverFail({ code: r.code, message: r.message, ...(r.uploadOnly ? { uploadOnly: true } : {}), ...(r.date ? { date: r.date } : {}) }, r.status);
      }
      const { link } = r;
      if (r.mode === 'uploadOnly' && !opts.allowUploadOnly) {
        return driverFail({ code: 'LINK_EXPIRED', message: `This link was for ${r.date} and has expired.`, uploadOnly: true, date: r.date }, 410);
      }
      const lim = LIMIT_OF[opts.limit];
      const used = limiter.consume(`${lim.key}:${link.id}`, lim.limit, lim.windowMs);
      if (!used.ok) return tooMany(used.resetAt, nowMs);

      const s = await readSession();
      let session: DriverLinkSession | null = null;
      if (s) {
        if (s.tenantId !== link.tenantId) {
          return driverFail({ code: 'SIGNED_IN_OTHER_TENANT', message: 'You are signed in to RouteIQ for another company. Sign out to use this driver link.' }, 403);
        }
        if (opts.write && (RANK[s.role] ?? 0) < RANK.PLANNER) {
          return driverFail({ code: 'SIGNED_IN_READ_ONLY', message: 'You are signed in to RouteIQ with a role that can only read. Sign out to record as the driver.' }, 403);
        }
        session = { userId: s.userId, name: s.name, role: s.role };
      }
      const deviceId = deviceFromHeader(req);
      // The office looking at the page is not the driver's phone ("last opened", "used on N phones").
      if (!session) await touchLink(link, deviceId, now);
      const ctx: DriverLinkContext = {
        link,
        mode: r.mode,
        tenantId: link.tenantId,
        truckId: link.truckId,
        date: r.date,
        expiresAt: r.expiresAt,
        uploadUntil: r.uploadUntil,
        db: tenantDb(link.tenantId),
        ip,
        deviceId,
        session,
        now,
      };
      const max = opts.maxInFlight;
      if (max !== undefined && (inFlight.get(link.id) ?? 0) >= max) {
        return driverFail({ code: 'RATE_LIMITED', message: 'Too many requests. It will be sent automatically.' }, 429, { 'Retry-After': '2' });
      }
      if (max !== undefined) inFlight.set(link.id, (inFlight.get(link.id) ?? 0) + 1);
      try {
        const res = await handler(req, ctx);
        for (const [k, v] of Object.entries(DRIVER_HEADERS)) res.headers.set(k, v);
        return res;
      } finally {
        if (max !== undefined) {
          const n = (inFlight.get(link.id) ?? 1) - 1;
          if (n > 0) inFlight.set(link.id, n);
          else inFlight.delete(link.id);
        }
      }
    } catch (err) {
      return mapError(err);
    }
  };
}
