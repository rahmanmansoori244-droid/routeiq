/**
 * withSalesLink: the wrapper of every route under app/api/s (owner request 19 Oct 2026). The token travels only
 * in the header `Authorization: SalesLink <token>`: the API paths carry none, so it is not written into server or
 * proxy logs on every poll. Read-only: there is no write option.
 *
 * 1. The token's shape is checked first (404, no database work).
 * 2. It is resolved (one unique-index lookup). Only a bad shape or an UNKNOWN hash counts against the client IP
 *    (`sl-bad:<ip>`, 30 per 10 min), and only a known public IP (lib/client-ip.ts isInternalIp: never depot Wi-Fi
 *    behind a proxy, CGNAT or an unknown address): over the limit, unknown tokens from that IP get 429.
 * 3. Per link AND public client IP (critique item 9): the requests (`sl-view:<link>:<ip>`); the handler counts the
 *    route codes with no deliveries (`sl-miss:<link>:<ip>`, salesMissKey). Never keyed on a header the page
 *    chooses, and no limit for the whole link (one holder cannot lock the group out). Every 429 has Retry-After.
 * 4. A signed-in RouteIQ session of another company: 403 SIGNED_IN_OTHER_TENANT; of the link's company: the
 *    office looking, allowed, never counted in the link's use ("opened on N phones").
 * 5. Every answer: Cache-Control no-store, Referrer-Policy no-referrer (critique item 16; strict-origin while the page
 *    had a map, until 20 Oct 2026), X-Robots-Tag noindex. A 500 logs the message only.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import type { SalesLink } from '@prisma/client';
import { auth } from '../auth';
import { clientIp, isInternalIp } from '../client-ip';
import { limiter, LIMITS } from '../rate-limit';
import { HttpError, httpErrorBody } from '../http-error';
import { resolveSalesLink } from './service';
import { looksLikeSalesToken, salesDeviceHash } from './token';

export interface SalesLinkSession {
  userId: string;
  role: string;
}

export interface SalesLinkContext {
  link: SalesLink;
  tenantId: string;
  /** The delivery date, YYYY-MM-DD. */
  date: string;
  expiresAt: Date;
  ip: string | null;
  /** The first 8 hex of SHA-256 of the page's random per-browser id (X-Sales-Device), or null: "opened on N phones" only. */
  deviceId: string | null;
  /** A signed-in RouteIQ user of the link's company (the office looking): never counted as a salesman's phone. */
  session: SalesLinkSession | null;
  now: Date;
}

/** Headers on every salesman answer (the token must not leak through Referer, caches or search engines). */
export const SALES_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

export function salesJson(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...SALES_HEADERS, ...extra } });
}

export function salesOk<T>(data: T, status = 200): NextResponse {
  return salesJson({ data, error: null }, status);
}

export function salesFail(error: { code: string; message: string } & Record<string, unknown>, status: number, extra: Record<string, string> = {}): NextResponse {
  return salesJson({ data: null, error }, status, extra);
}

/** The token of `Authorization: SalesLink <token>`, or null. */
export function salesTokenFromHeader(req: Request): string | null {
  const m = /^SalesLink\s+(\S+)\s*$/.exec(req.headers.get('authorization') ?? '');
  return m ? m[1]! : null;
}

/** The page's random per-browser id (32 hex), hashed to 8 hex; anything else is ignored. */
export function salesDeviceFromHeader(req: Request): string | null {
  const raw = (req.headers.get('x-sales-device') ?? '').trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(raw) ? salesDeviceHash(raw) : null;
}

/**
 * The limiter's key part for the client: its public IP, or "shared" for an unknown or internal address (a proxy:
 * every user would share it), which has its own, larger limits.
 */
export function salesIpKey(ip: string | null | undefined): string {
  return ip && !isInternalIp(ip) ? ip : 'shared';
}

/** The request limit of a link and client (critique item 9: the link AND the public IP; never a header). */
export function salesViewLimit(linkId: string, ip: string | null | undefined): { key: string; limit: number; windowMs: number } {
  const who = salesIpKey(ip);
  const lim = who === 'shared' ? LIMITS.salesViewShared : LIMITS.salesView;
  return { key: `sl-view:${linkId}:${who}`, ...lim };
}

/** The limit of route codes with no deliveries, per link and client. */
export function salesMissLimit(linkId: string, ip: string | null | undefined): { key: string; limit: number; windowMs: number } {
  const who = salesIpKey(ip);
  const lim = who === 'shared' ? LIMITS.salesRouteMissShared : LIMITS.salesRouteMiss;
  return { key: `sl-miss:${linkId}:${who}`, ...lim };
}

/** The unknown-token counter's key, or null when the IP is not counted (unknown or internal). */
export function salesBadTokenKey(ip: string | null | undefined): string | null {
  return ip && !isInternalIp(ip) ? `sl-bad:${ip}` : null;
}

function retryAfter(resetAt: number, now: number): Record<string, string> {
  return { 'Retry-After': String(Math.max(1, Math.ceil((resetAt - now) / 1000))) };
}

/** 429 RATE_LIMITED with Retry-After. */
export function salesTooMany(resetAt: number, now: number = Date.now()): NextResponse {
  return salesFail({ code: 'RATE_LIMITED', message: 'Too many requests. Wait a moment, the page tries again by itself.' }, 429, retryAfter(resetAt, now));
}

/** Counts `units` route codes with no deliveries against the link and client; a 429 when over. */
export function consumeMisses(ctx: Pick<SalesLinkContext, 'link' | 'ip'>, units: number): { ok: true } | { ok: false; response: NextResponse } {
  if (units <= 0) return { ok: true };
  const lim = salesMissLimit(ctx.link.id, ctx.ip);
  const now = Date.now();
  const r = limiter.consume(lim.key, lim.limit, lim.windowMs, units);
  return r.ok ? { ok: true } : { ok: false, response: salesTooMany(r.resetAt, now) };
}

function mapError(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    const body = httpErrorBody(err);
    return salesFail(typeof body === 'string' ? { code: 'ERROR', message: body } : { code: String(body.code ?? 'ERROR'), message: String(body.error ?? 'Error'), ...body }, err.status);
  }
  if (err instanceof ZodError) return salesFail({ code: 'BAD_REQUEST', message: 'The request was not understood.' }, 400);
  console.error('[sales-link] route error', (err as Error)?.message ?? err);
  return salesFail({ code: 'ERROR', message: 'Something went wrong. The page tries again by itself.' }, 500);
}

async function readSession(): Promise<{ userId: string; role: string; tenantId: string | null } | null> {
  try {
    const s = await auth();
    if (!s?.user?.id) return null;
    return { userId: s.user.id, role: s.user.role, tenantId: s.user.tenantId ?? null };
  } catch {
    return null;
  }
}

export function withSalesLink(handler: (req: Request, ctx: SalesLinkContext) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      const nowMs = Date.now();
      const now = new Date(nowMs);
      const ip = clientIp(req);
      const token = salesTokenFromHeader(req);
      const r = looksLikeSalesToken(token) ? await resolveSalesLink(token, { now }) : null;
      if (!r || !r.ok) {
        // Only a bad shape or an unknown hash counts, and only against a known public IP.
        const badKey = !r || !r.known ? salesBadTokenKey(ip) : null;
        if (badKey) {
          const b = limiter.consume(badKey, LIMITS.salesBadToken.limit, LIMITS.salesBadToken.windowMs);
          if (!b.ok) return salesTooMany(b.resetAt, nowMs);
        }
        if (!r) return salesFail({ code: 'LINK_NOT_FOUND', message: 'This link does not work. Ask the office for the link of the day.' }, 404);
        return salesFail({ code: r.code, message: r.message, ...(r.date ? { date: r.date } : {}) }, r.status);
      }
      const { link } = r;
      const lim = salesViewLimit(link.id, ip);
      const used = limiter.consume(lim.key, lim.limit, lim.windowMs);
      if (!used.ok) return salesTooMany(used.resetAt, nowMs);

      const s = await readSession();
      let session: SalesLinkSession | null = null;
      if (s) {
        if (s.tenantId !== link.tenantId) {
          return salesFail({ code: 'SIGNED_IN_OTHER_TENANT', message: 'You are signed in to RouteIQ for another company. Sign out to use this link.' }, 403);
        }
        session = { userId: s.userId, role: s.role };
      }
      const ctx: SalesLinkContext = { link, tenantId: link.tenantId, date: r.date, expiresAt: r.expiresAt, ip, deviceId: salesDeviceFromHeader(req), session, now };
      const res = await handler(req, ctx);
      for (const [k, v] of Object.entries(SALES_HEADERS)) res.headers.set(k, v);
      return res;
    } catch (err) {
      return mapError(err);
    }
  };
}
