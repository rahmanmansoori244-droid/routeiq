/**
 * Salesman links (owner request 19 Oct 2026): ONE no-login, read-only link per company and delivery date for
 * the salesmen's WhatsApp group (app/s/[token]). Each salesman types his route code - a filter, not a password:
 * anyone holding the link can look up any route of that day (the owner's choice; an accepted risk in
 * docs/SECURITY.md, with its mitigations: today or tomorrow only, dead at 06:00 company time the day after,
 * revoke / replace at any time, no phones, money, notes or ids on the page, rate limits). Server only.
 *
 * - ensureSalesLink: get or create the date's link (PLANNER+: the plan screen's "Salesman link" dialog). Only
 *   the company's today or tomorrow (critique item 11). A revoked link stays revoked (no URL) until replaced;
 *   a link made with an older server key gets its new hash (the old token then answers "replaced").
 * - reissueSalesLink ("Make a new link"): a new generation and salt; the old token answers 410 LINK_REPLACED at
 *   once, the one before it 404; the expiry is kept (never extended), the phone and route lists start again.
 * - revokeSalesLink ("Turn off"): idempotent; no token of the link works until a reissue.
 * - listSalesLinks / getSalesLink: existing links only, never created, no audit row.
 * - resolveSalesLink: the ONLY lookup that is not tenant-scoped (a unique SHA-256 cannot cross companies);
 *   used only by withSalesLink (guard.ts).
 * - touchSalesLink: "opened on N phones", "routes looked up" and lastSeenAt, appended atomically in SQL (critique
 *   item 17: 30 phones opening the WhatsApp post at once lose nothing), best effort, after the answer is built.
 *
 * The token is never stored, logged or audited: audit rows carry the date, the generation and the reason only
 * (`salt`, `tokenHash` and `prevTokenHash` are also redacted by lib/audit.ts).
 */
import { Prisma, type SalesLink } from '@prisma/client';
import { prisma } from '../db';
import { audit } from '../audit';
import { HttpError } from '../http-error';
import { addDaysIso, dateOnly, DEFAULT_TZ, isoOf, todayIso } from '../dispatch/time';
import { compareSalesRoutes } from '../dispatch/sales-route';
import { whatsappUrl } from '../dispatch/driver-links';
import { driverLinkBaseUrl } from '../driver-link/token';
import {
  deriveToken,
  looksLikeSalesToken,
  newSalesLinkId,
  newSalt,
  SALES_LINK_END_HOUR,
  salesLinkExpiry,
  salesLinkKey,
  salesLinkUrl,
  sha256Hex,
  tokenHash,
  type SalesLinkKey,
} from './token';
import { expiryText, salesLinkMessage, shortDayText } from './text';
import type { SalesLinkStateCode, SalesLinkView } from './view-types';

export type { SalesLinkView };

type Db = Prisma.TransactionClient | typeof prisma;

/** lastSeenAt is written at most this often (a new phone or route is written at once). */
export const SALES_TOUCH_EVERY_MS = 5 * 60 * 1000;
/** The most phones and routes a link keeps (the counts stop growing beyond). */
export const MAX_SALES_DEVICES = 200;
export const MAX_SALES_ROUTES = 200;

export class SalesLinkError extends HttpError {
  constructor(message: string, status: number, code: string, extra: Record<string, unknown> = {}) {
    super(message, status, { code, ...extra });
    this.name = 'SalesLinkError';
  }
}

function serverKey(env: NodeJS.ProcessEnv): SalesLinkKey {
  const key = salesLinkKey(env);
  if (!key) throw new SalesLinkError('Salesman links are off: the server has no secret to make them (SALES_LINK_SECRET or NEXTAUTH_SECRET).', 503, 'SALES_LINKS_OFF');
  return key;
}

async function tenantInfo(db: Db, tenantId: string): Promise<{ tz: string; name: string }> {
  const [cfg, tenant] = await Promise.all([
    db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } }),
    db.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
  ]);
  return { tz: cfg?.timezone || DEFAULT_TZ, name: tenant?.name ?? '' };
}

/** The dates a link can be made for: the company's today and tomorrow (critique item 11). */
export function salesLinkDates(tz: string, now: Date): [string, string] {
  const today = todayIso(tz, now);
  return [today, addDaysIso(today, 1)];
}

/** Why a date cannot have a link now (null: it can): not today or tomorrow, or its link's time is over. */
export function salesLinkDateProblem(date: string, tz: string, now: Date): { status: number; code: string; message: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: 400, code: 'DATE_OUT_OF_RANGE', message: 'Choose a delivery date (YYYY-MM-DD).' };
  const [today, tomorrow] = salesLinkDates(tz, now);
  if (date !== today && date !== tomorrow) {
    return { status: 400, code: 'DATE_OUT_OF_RANGE', message: `A salesman link can be made for today (${shortDayText(today)}) or tomorrow (${shortDayText(tomorrow)}) only.` };
  }
  if (salesLinkExpiry(date, tz).getTime() <= now.getTime()) return { status: 409, code: 'LINK_DAY_OVER', message: `The salesman link for ${shortDayText(date)} is over.` };
  return null;
}

// ---------------------------------------------------------------------------------------
// The office's view of a link
// ---------------------------------------------------------------------------------------


/** A JSON array of strings (anything else: none). */
export function readStrings(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((x): x is string => typeof x === 'string') : [];
}

export function salesLinkView(link: SalesLink, ctx: { key: SalesLinkKey; base: string | null; now: Date; tz: string; company: string }): SalesLinkView {
  const date = isoOf(link.deliveryDate);
  const expired = link.expiresAt.getTime() <= ctx.now.getTime();
  const revoked = !!link.revokedAt;
  const keyChanged = link.keyId !== ctx.key.keyId;
  const token = deriveToken(ctx.key.key, link.id, link.generation, link.salt);
  const usable = !expired && !revoked && !keyChanged && tokenHash(token) === link.tokenHash && !!ctx.base;
  const url = usable ? salesLinkUrl(ctx.base!, token) : null;
  const dayShort = shortDayText(date);
  const until = expiryText(date, addDaysIso(date, 1), SALES_LINK_END_HOUR);
  const message = url ? salesLinkMessage({ dayShort, company: ctx.company, url, expiryText: until }) : null;
  return {
    id: link.id,
    date,
    dayShort,
    url,
    expiresAt: link.expiresAt.toISOString(),
    expiryText: until,
    generation: link.generation,
    revoked,
    expired,
    keyChanged,
    issuedAt: link.issuedAt.toISOString(),
    lastSeenAt: link.lastSeenAt?.toISOString() ?? null,
    phones: readStrings(link.devicesJson).length,
    routesSeen: [...new Set(readStrings(link.routesJson))].sort(compareSalesRoutes),
    message,
    whatsappUrl: message ? whatsappUrl(null, message) : null,
  };
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError ? e.code === 'P2002' : (e as { code?: unknown } | null)?.code === 'P2002';
}

export interface SalesLinkCallOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** The request's origin: the link's base when AUTH_URL / NEXTAUTH_URL is not set. */
  origin?: string | null;
}

/**
 * Get or create the date's link (POST /api/dispatch/sales-links). Refused: 400 DATE_OUT_OF_RANGE (not the
 * company's today or tomorrow), 409 LINK_DAY_OVER, 503 SALES_LINKS_OFF. Audited SALES_LINK_ISSUED on creation only.
 */
export async function ensureSalesLink(tenantId: string, userId: string | null, date: string, opts: SalesLinkCallOptions = {}): Promise<SalesLinkView & { created: boolean }> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const key = serverKey(env);
  const { tz, name } = await tenantInfo(prisma, tenantId);
  const problem = salesLinkDateProblem(date, tz, now);
  if (problem) throw new SalesLinkError(problem.message, problem.status, problem.code);
  const expiresAt = salesLinkExpiry(date, tz);
  let created = false;
  let link: SalesLink;
  try {
    link = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.salesLink.findFirst({ where: { tenantId, deliveryDate: dateOnly(date) } });
        if (existing) {
          // A rotated server key: the link works again with a new token (the old one answers "replaced").
          if (!existing.revokedAt && existing.keyId !== key.keyId) {
            const fresh = tokenHash(deriveToken(key.key, existing.id, existing.generation, existing.salt));
            return tx.salesLink.update({ where: { id: existing.id }, data: { tokenHash: fresh, prevTokenHash: existing.tokenHash, keyId: key.keyId } });
          }
          return existing;
        }
        const id = newSalesLinkId();
        const salt = newSalt();
        const row = await tx.salesLink.create({
          data: { id, tenantId, deliveryDate: dateOnly(date), generation: 1, salt, keyId: key.keyId, tokenHash: tokenHash(deriveToken(key.key, id, 1, salt)), expiresAt, issuedAt: now, issuedById: userId },
        });
        created = true;
        await audit({ tenantId, userId, action: 'SALES_LINK_ISSUED', entity: 'SalesLink', entityId: row.id, afterJson: { date, generation: 1, expiresAt: expiresAt.toISOString() } }, tx);
        return row;
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // PostgreSQL aborted that transaction at the error: answer from a fresh read, never retry inside it.
    const fresh = await prisma.salesLink.findFirst({ where: { tenantId, deliveryDate: dateOnly(date) } });
    if (!fresh) throw e;
    link = fresh;
    created = false;
  }
  return { ...salesLinkView(link, { key, base: driverLinkBaseUrl(env, opts.origin ?? null), now, tz, company: name }), created };
}

/** The date's link, or null (GET /api/dispatch/sales-links?date=). Never creates one; no audit row. */
export async function getSalesLink(tenantId: string, date: string, opts: SalesLinkCallOptions = {}): Promise<SalesLinkView | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SalesLinkError('Choose a delivery date (YYYY-MM-DD).', 400, 'DATE_OUT_OF_RANGE');
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const key = salesLinkKey(env);
  if (!key) return null;
  const link = await prisma.salesLink.findFirst({ where: { tenantId, deliveryDate: dateOnly(date) } });
  if (!link) return null;
  const { tz, name } = await tenantInfo(prisma, tenantId);
  return salesLinkView(link, { key, base: driverLinkBaseUrl(env, opts.origin ?? null), now, tz, company: name });
}

/** The links of the company's today and tomorrow (GET /api/dispatch/sales-links without a date). */
export async function listSalesLinks(tenantId: string, opts: SalesLinkCallOptions = {}): Promise<{ dates: [string, string]; links: SalesLinkView[] }> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const { tz, name } = await tenantInfo(prisma, tenantId);
  const dates = salesLinkDates(tz, now);
  const key = salesLinkKey(env);
  if (!key) return { dates, links: [] };
  const rows = await prisma.salesLink.findMany({ where: { tenantId, deliveryDate: { in: dates.map(dateOnly) } }, orderBy: [{ deliveryDate: 'asc' }] });
  const base = driverLinkBaseUrl(env, opts.origin ?? null);
  return { dates, links: rows.map((l) => salesLinkView(l, { key, base, now, tz, company: name })) };
}

async function linkForChange(tenantId: string, id: string): Promise<SalesLink> {
  const link = await prisma.salesLink.findFirst({ where: { id, tenantId } });
  if (!link) throw new SalesLinkError('Salesman link not found.', 404, 'NOT_FOUND');
  return link;
}

/**
 * "Make a new link": a new generation and salt (the old token answers 410 LINK_REPLACED at once; the one before
 * it 404). The expiry is kept; the phone and route lists start again. Refused once the link's day is over.
 */
export async function reissueSalesLink(tenantId: string, id: string, userId: string | null, reason: string | null, opts: SalesLinkCallOptions = {}): Promise<SalesLinkView> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const key = serverKey(env);
  const cur = await linkForChange(tenantId, id);
  const date = isoOf(cur.deliveryDate);
  if (cur.expiresAt.getTime() <= now.getTime()) throw new SalesLinkError(`The salesman link for ${shortDayText(date)} is over: it cannot be replaced.`, 409, 'LINK_DAY_OVER');
  const generation = cur.generation + 1;
  const salt = newSalt();
  const row = await prisma.$transaction(async (tx) => {
    // Only from the generation read (two presses at once: one wins, the other is asked to try again).
    const n = await tx.salesLink.updateMany({
      where: { id: cur.id, tenantId, generation: cur.generation },
      data: {
        prevTokenHash: cur.tokenHash,
        generation,
        salt,
        keyId: key.keyId,
        tokenHash: tokenHash(deriveToken(key.key, cur.id, generation, salt)),
        revokedAt: null,
        revokedById: null,
        devicesJson: Prisma.DbNull,
        routesJson: Prisma.DbNull,
        lastSeenAt: null,
        issuedAt: now,
        issuedById: userId,
      },
    });
    if (n.count !== 1) throw new SalesLinkError('The link was changed at the same moment. Try again.', 409, 'LINK_CHANGED');
    await audit(
      {
        tenantId,
        userId,
        action: 'SALES_LINK_REISSUED',
        entity: 'SalesLink',
        entityId: cur.id,
        beforeJson: { generation: cur.generation, revoked: !!cur.revokedAt },
        afterJson: { date, generation, reason: reason ?? null },
      },
      tx,
    );
    return tx.salesLink.findFirstOrThrow({ where: { id: cur.id, tenantId } });
  });
  const { tz, name } = await tenantInfo(prisma, tenantId);
  return salesLinkView(row, { key, base: driverLinkBaseUrl(env, opts.origin ?? null), now, tz, company: name });
}

/** "Turn off": no token of this link works until a reissue. Idempotent (a second press writes nothing). */
export async function revokeSalesLink(tenantId: string, id: string, userId: string | null, reason: string | null, opts: SalesLinkCallOptions = {}): Promise<SalesLinkView> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const key = serverKey(env);
  const cur = await linkForChange(tenantId, id);
  let row = cur;
  if (!cur.revokedAt) {
    row = await prisma.$transaction(async (tx) => {
      const n = await tx.salesLink.updateMany({ where: { id: cur.id, tenantId, revokedAt: null }, data: { revokedAt: now, revokedById: userId } });
      if (n.count === 1) {
        await audit({ tenantId, userId, action: 'SALES_LINK_REVOKED', entity: 'SalesLink', entityId: cur.id, afterJson: { date: isoOf(cur.deliveryDate), generation: cur.generation, reason: reason ?? null } }, tx);
      }
      return tx.salesLink.findFirstOrThrow({ where: { id: cur.id, tenantId } });
    });
  }
  const { tz, name } = await tenantInfo(prisma, tenantId);
  return salesLinkView(row, { key, base: driverLinkBaseUrl(env, opts.origin ?? null), now, tz, company: name });
}

// ---------------------------------------------------------------------------------------
// Resolve (every salesman request, through withSalesLink)
// ---------------------------------------------------------------------------------------

export type ResolvedSalesLink =
  | { ok: true; link: SalesLink; date: string; expiresAt: Date }
  | { ok: false; status: 404 | 410 | 503; code: SalesLinkStateCode; message: string; known: boolean; date?: string };

export const SALES_STATE_TEXT: Record<SalesLinkStateCode, string> = {
  LINK_NOT_FOUND: 'This link does not work. Ask the office for the link of the day.',
  LINK_REPLACED: 'This link was replaced by a newer one. Use the newest link in your group, or ask the office.',
  LINK_REVOKED: 'This link was turned off by the office. Ask the office for a new one.',
  LINK_EXPIRED: "This link has expired. Ask the office for today's link.",
  SALES_LINKS_OFF: 'Salesman links are not available on this server. Ask the office.',
  // Answered by withSalesLink (403), never by resolve: a RouteIQ session of another company.
  SIGNED_IN_OTHER_TENANT: 'You are signed in to RouteIQ for another company. Sign out to use this link.',
};

function refused(status: 404 | 410 | 503, code: SalesLinkStateCode, known: boolean, date?: string): ResolvedSalesLink {
  return { ok: false, status, code, message: SALES_STATE_TEXT[code], known, ...(date ? { date } : {}) };
}

/**
 * The link of a token:
 * - 404 LINK_NOT_FOUND: not a token shape, an unknown hash (the only case the guard counts against the IP:
 *   `known: false`), or the company is inactive;
 * - 503 SALES_LINKS_OFF: no server secret;
 * - 410 LINK_REPLACED: the generation before the last reissue, or a link made with an older server key;
 * - 410 LINK_REVOKED; 410 LINK_EXPIRED from 06:00 the day after the delivery date (no grace: the page only reads).
 */
export async function resolveSalesLink(token: string | null | undefined, opts: { now?: Date; env?: NodeJS.ProcessEnv } = {}): Promise<ResolvedSalesLink> {
  if (!looksLikeSalesToken(token)) return refused(404, 'LINK_NOT_FOUND', false);
  const key = salesLinkKey(opts.env ?? process.env);
  if (!key) return refused(503, 'SALES_LINKS_OFF', true);
  const now = opts.now ?? new Date();
  const h = sha256Hex(token);
  const link = await prisma.salesLink.findFirst({ where: { OR: [{ tokenHash: h }, { prevTokenHash: h }] } });
  if (!link) return refused(404, 'LINK_NOT_FOUND', false);
  const tenant = await prisma.tenant.findFirst({ where: { id: link.tenantId }, select: { active: true } });
  if (!tenant?.active) return refused(404, 'LINK_NOT_FOUND', true);
  const date = isoOf(link.deliveryDate);
  if (link.prevTokenHash === h && link.tokenHash !== h) return refused(410, 'LINK_REPLACED', true, date);
  if (link.keyId !== key.keyId) return refused(410, 'LINK_REPLACED', true, date);
  if (link.revokedAt) return refused(410, 'LINK_REVOKED', true, date);
  if (now.getTime() >= link.expiresAt.getTime()) return refused(410, 'LINK_EXPIRED', true, date);
  return { ok: true, link, date, expiresAt: link.expiresAt };
}

/**
 * What a salesman request adds to the link (pure): the phone when new (8 hex), the routes found that are new,
 * and whether lastSeenAt is due (at most every 5 minutes). Null: nothing to write.
 */
export function salesTouchPlan(
  link: Pick<SalesLink, 'lastSeenAt' | 'devicesJson' | 'routesJson'>,
  device: string | null,
  routes: readonly string[],
  now: Date,
): { device: string | null; routes: string[]; seen: boolean } | null {
  const devices = readStrings(link.devicesJson);
  const known = readStrings(link.routesJson);
  const newDevice = device && !devices.includes(device) && devices.length < MAX_SALES_DEVICES ? device : null;
  const newRoutes = [...new Set(routes)].filter((r) => !known.includes(r)).slice(0, Math.max(0, MAX_SALES_ROUTES - known.length));
  const seen = !link.lastSeenAt || now.getTime() - link.lastSeenAt.getTime() >= SALES_TOUCH_EVERY_MS;
  if (!newDevice && !newRoutes.length && !seen) return null;
  return { device: newDevice, routes: newRoutes, seen };
}

/**
 * Best effort, never fails a request: the phone (first 8 hex of the hash of the page's random id), the routes
 * that had deliveries, lastSeenAt. Each list grows by an atomic jsonb append that skips an entry already there
 * and stops at the cap, only while this generation is current (a reissue in between starts new lists).
 */
export async function touchSalesLink(
  link: Pick<SalesLink, 'id' | 'tenantId' | 'generation' | 'lastSeenAt' | 'devicesJson' | 'routesJson'>,
  device: string | null,
  routes: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  const plan = salesTouchPlan(link, device, routes, now);
  if (!plan) return;
  try {
    if (plan.device) {
      await prisma.$executeRaw`
        UPDATE "SalesLink"
        SET "devicesJson" = COALESCE("devicesJson", '[]'::jsonb) || jsonb_build_array(${plan.device}::text), "lastSeenAt" = ${now}
        WHERE "id" = ${link.id} AND "tenantId" = ${link.tenantId} AND "generation" = ${link.generation}
          AND NOT (COALESCE("devicesJson", '[]'::jsonb) @> jsonb_build_array(${plan.device}::text))
          AND jsonb_array_length(COALESCE("devicesJson", '[]'::jsonb)) < ${MAX_SALES_DEVICES}::int`;
    } else if (plan.seen) {
      await prisma.salesLink.updateMany({
        where: { id: link.id, tenantId: link.tenantId, generation: link.generation, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(now.getTime() - SALES_TOUCH_EVERY_MS) } }] },
        data: { lastSeenAt: now },
      });
    }
    for (const r of plan.routes) {
      await prisma.$executeRaw`
        UPDATE "SalesLink"
        SET "routesJson" = COALESCE("routesJson", '[]'::jsonb) || jsonb_build_array(${r}::text)
        WHERE "id" = ${link.id} AND "tenantId" = ${link.tenantId} AND "generation" = ${link.generation}
          AND NOT (COALESCE("routesJson", '[]'::jsonb) @> jsonb_build_array(${r}::text))
          AND jsonb_array_length(COALESCE("routesJson", '[]'::jsonb)) < ${MAX_SALES_ROUTES}::int`;
    }
  } catch (e) {
    console.warn('[sales-link] use not recorded', (e as Error)?.message ?? e);
  }
}

/**
 * The location retention (lib/jobs/delivery-janitor.ts): the phones a link of a date older than the cutoff was
 * opened on, each turned into "" in one statement (the count stays for the office). A link expires the day after
 * its date, so no phone can add one afterwards.
 */
export async function eraseSalesLinkDevices(db: Db, tenantId: string, cutoffDayIso: string): Promise<number> {
  return db.$executeRaw`
    UPDATE "SalesLink"
    SET "devicesJson" = (SELECT jsonb_agg('""'::jsonb) FROM jsonb_array_elements("devicesJson") AS e)
    WHERE "tenantId" = ${tenantId} AND "deliveryDate" < ${cutoffDayIso}::date
      AND jsonb_typeof("devicesJson") = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements("devicesJson") AS e WHERE e <> '""'::jsonb)`;
}
