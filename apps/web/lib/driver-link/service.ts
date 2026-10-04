/**
 * Driver links (owner request 4 Oct 2026, spec section 4): one link (QR) per truck and delivery
 * date opens the driver's phone page. No account, no PIN, no app: casual drivers and drivers of
 * hired trucks just scan. Server only.
 *
 * - ensureLink: get or create the truck-day's link (PLANNER+: the plan screen's Link dialog, its
 *   WhatsApp, the PDF). Under an advisory lock, so two callers never race into a unique-key error
 *   inside one transaction; a P2002 that still happens is answered from a fresh read OUTSIDE the
 *   aborted transaction, never retried inside it. A revoked link stays revoked (no token). A link
 *   made with an older server key gets its new hash here.
 * - reissueLink: a new generation and salt (the old token answers 410 LINK_REPLACED, the one before
 *   it 404). revokeLink: no token works until a reissue.
 * - resolveDriverLink: the only lookup that is not tenant-scoped (a unique SHA-256 cannot cross
 *   tenants); used only by withDriverLink (guard.ts).
 *
 * The token is never stored, logged or audited: audit rows carry the generation, the truck and the
 * driver's name only (`salt`, `tokenHash` and `prevTokenHash` are also redacted by lib/audit.ts).
 */
import { Prisma, type DriverLink } from '@prisma/client';
import { prisma } from '../db';
import { audit } from '../audit';
import { HttpError } from '../http-error';
import { qrPath } from '../dispatch/qr';
import { asPlanBusy, setLockTimeout } from '../dispatch/plan-locks';
import { DEFAULT_TZ, dateOnly, isoOf } from '../dispatch/time';
import {
  deriveToken,
  driverLinkBaseUrl,
  driverLinkKey,
  driverLinkUrl,
  linkExpiry,
  linkUploadUntil,
  looksLikeToken,
  newLinkId,
  newSalt,
  sha256Hex,
  tokenHash,
  type DriverLinkKey,
} from './token';
import { earliestOpenLoad } from './reissue-prompt';
import type { DriverLinkView, LinkStateCode, LoadStatusName } from './manifest-types';

type Db = Prisma.TransactionClient | typeof prisma;

/** lastSeenAt and the device list are written at most this often (plus once per new phone, up to 5). */
export const TOUCH_EVERY_MS = 5 * 60 * 1000;
export const MAX_DEVICES = 5;

export class DriverLinkError extends HttpError {
  constructor(message: string, status: number, code: string, extra: Record<string, unknown> = {}) {
    super(message, status, { code, ...extra });
    this.name = 'DriverLinkError';
  }
}

function serverKey(env: NodeJS.ProcessEnv): DriverLinkKey {
  const key = driverLinkKey(env);
  if (!key) {
    throw new DriverLinkError('Driver links are off: the server has no secret to make them (DRIVER_LINK_SECRET or NEXTAUTH_SECRET).', 503, 'DRIVER_LINKS_OFF');
  }
  return key;
}

// ---------------------------------------------------------------------------------------
// The truck-day: which loads one link covers
// ---------------------------------------------------------------------------------------

export interface TruckDayLoad {
  id: string;
  runId: string;
  depotId: string;
  truckId: string;
  loadNo: number;
  status: LoadStatusName;
  departMin: number;
  returnMin: number;
  driverId: string | null;
  driverName: string | null;
  driverPhone: string | null;
  driverCasual: boolean;
  statusChangedAt: Date | null;
}

/**
 * The plan in use per depot for a date: the currentPlan rule (not SUPERSEDED or ARCHIVED,
 * supersededAt null, the newest version per depot). While a re-plan runs that is the OPTIMIZING
 * version, whose loads are copies, so the driver page keeps working.
 */
export async function liveRuns(db: Db, tenantId: string, dateIso: string): Promise<{ id: string; depotId: string }[]> {
  const runs = await db.runPlan.findMany({
    where: { tenantId, runDate: dateOnly(dateIso), status: { notIn: ['SUPERSEDED', 'ARCHIVED'] }, supersededAt: null },
    orderBy: [{ version: 'desc' }, { chosenScenarioId: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, depotId: true },
  });
  const perDepot = new Map<string, { id: string; depotId: string }>();
  for (const r of runs) if (!perDepot.has(r.depotId)) perDepot.set(r.depotId, r);
  return [...perDepot.values()];
}

/** Every load of the truck on the plans in use of that date (normally one depot), by departure. */
export async function truckDayLoads(db: Db, tenantId: string, truckId: string, dateIso: string): Promise<TruckDayLoad[]> {
  return (await truckDayLoadsMany(db, tenantId, [truckId], dateIso)).get(truckId) ?? [];
}

/** truckDayLoads of several trucks of one date in three queries (the plan's links, the PDF), never one round per truck. */
export async function truckDayLoadsMany(db: Db, tenantId: string, truckIds: readonly string[], dateIso: string): Promise<Map<string, TruckDayLoad[]>> {
  const out = new Map<string, TruckDayLoad[]>(truckIds.map((id) => [id, []]));
  if (!truckIds.length) return out;
  const runs = await liveRuns(db, tenantId, dateIso);
  if (!runs.length) return out;
  const depotOf = new Map(runs.map((r) => [r.id, r.depotId]));
  const loads = await db.planLoad.findMany({
    where: { tenantId, truckId: truckIds.length === 1 ? truckIds[0]! : { in: [...truckIds] }, runId: { in: runs.map((r) => r.id) } },
    orderBy: [{ departMin: 'asc' }, { loadNo: 'asc' }],
    select: { id: true, runId: true, truckId: true, loadNo: true, status: true, departMin: true, returnMin: true, driverId: true, statusChangedAt: true },
  });
  const driverIds = [...new Set(loads.map((l) => l.driverId).filter((x): x is string => !!x))];
  const drivers = driverIds.length
    ? await db.driver.findMany({ where: { tenantId, id: { in: driverIds } }, select: { id: true, name: true, phone: true, casual: true } })
    : [];
  const byId = new Map(drivers.map((d) => [d.id, d]));
  const rows = loads
    .map((l) => {
      const d = l.driverId ? byId.get(l.driverId) : undefined;
      return {
        id: l.id,
        runId: l.runId,
        depotId: depotOf.get(l.runId) ?? '',
        truckId: l.truckId,
        loadNo: l.loadNo,
        status: l.status as LoadStatusName,
        departMin: l.departMin,
        returnMin: l.returnMin,
        driverId: l.driverId,
        driverName: d?.name ?? null,
        driverPhone: d?.phone ?? null,
        driverCasual: !!d?.casual,
        statusChangedAt: l.statusChangedAt ?? null,
      };
    })
    .sort((a, b) => a.departMin - b.departMin || a.loadNo - b.loadNo);
  for (const r of rows) {
    const list = out.get(r.truckId);
    if (list) list.push(r);
  }
  return out;
}

async function tenantTz(db: Db, tenantId: string): Promise<string> {
  const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true } });
  return cfg?.timezone || DEFAULT_TZ;
}

// ---------------------------------------------------------------------------------------
// Devices: "used on N phones"
// ---------------------------------------------------------------------------------------

export interface DeviceSeen {
  /** First 8 hex of SHA-256 of the page's per-browser id. */
  device: string;
  first: string;
  last: string;
}

export function readDevices(json: unknown): DeviceSeen[] {
  if (!Array.isArray(json)) return [];
  return json.filter(
    (x): x is DeviceSeen => !!x && typeof x === 'object' && typeof (x as DeviceSeen).device === 'string' && typeof (x as DeviceSeen).first === 'string' && typeof (x as DeviceSeen).last === 'string',
  );
}

/**
 * What a driver request writes about the link: nothing when it was written less than 5 minutes ago
 * and the phone is known (or the list is full); else lastSeenAt and the device list (at most 5: a
 * new phone over the cap replaces the one seen longest ago). Pure.
 */
export function touchUpdate(
  link: { lastSeenAt: Date | null; devicesJson: unknown },
  device: string | null,
  now: Date,
): { lastSeenAt: Date; devices: DeviceSeen[] } | null {
  const list = readDevices(link.devicesJson);
  const known = device ? list.find((d) => d.device === device) : undefined;
  const due = !link.lastSeenAt || now.getTime() - link.lastSeenAt.getTime() >= TOUCH_EVERY_MS;
  const newPhone = !!device && !known;
  if (!due && !(newPhone && list.length < MAX_DEVICES)) return null;
  const at = now.toISOString();
  let devices = list.map((d) => (d.device === device ? { ...d, last: at } : d));
  if (newPhone) {
    devices.push({ device: device!, first: at, last: at });
    if (devices.length > MAX_DEVICES) devices = [...devices].sort((a, b) => b.last.localeCompare(a.last)).slice(0, MAX_DEVICES);
  }
  return { lastSeenAt: now, devices };
}

// ---------------------------------------------------------------------------------------
// The dialog's view of a link
// ---------------------------------------------------------------------------------------

interface ViewContext {
  key: DriverLinkKey;
  base: string | null;
  now: Date;
  truckCode: string;
  hired: boolean;
  loads: TruckDayLoad[];
  nameAtIssue: string | null;
}

export function linkView(link: DriverLink, ctx: ViewContext): DriverLinkView {
  const expired = link.expiresAt.getTime() <= ctx.now.getTime();
  const revoked = !!link.revokedAt;
  const keyChanged = link.keyId !== ctx.key.keyId;
  const token = deriveToken(ctx.key.key, link.id, link.generation, link.salt);
  const usable = !expired && !revoked && !keyChanged && tokenHash(token) === link.tokenHash && !!ctx.base;
  const url = usable ? driverLinkUrl(ctx.base!, token) : null;
  const devices = readDevices(link.devicesJson);
  const lastAt = devices.map((d) => d.last).sort().at(-1) ?? null;
  return {
    linkId: link.id,
    truckId: link.truckId,
    truckCode: ctx.truckCode,
    hired: ctx.hired,
    date: isoOf(link.deliveryDate),
    url,
    qr: url ? qrPath(url, 'M') : null,
    expiresAt: link.expiresAt.toISOString(),
    uploadUntil: linkUploadUntil(link.expiresAt).toISOString(),
    generation: link.generation,
    revoked,
    expired,
    keyChanged,
    driverIdAtIssue: link.driverIdAtIssue,
    driverNameAtIssue: ctx.nameAtIssue,
    devices: { n: devices.length, lastAt },
    lastSeenAt: link.lastSeenAt?.toISOString() ?? null,
    driversOnTruck: ctx.loads.map((l) => ({
      loadId: l.id,
      loadNo: l.loadNo,
      status: l.status,
      departMin: l.departMin,
      driverId: l.driverId,
      driverName: l.driverName,
      driverPhone: l.driverPhone,
      casual: l.driverCasual,
    })),
  };
}

async function nameOf(db: Db, tenantId: string, driverId: string | null, loads: TruckDayLoad[]): Promise<string | null> {
  if (!driverId) return null;
  const onLoad = loads.find((l) => l.driverId === driverId)?.driverName;
  if (onLoad) return onLoad;
  const d = await db.driver.findFirst({ where: { tenantId, id: driverId }, select: { name: true } });
  return d?.name ?? null;
}

/**
 * One short transaction under the truck-day's lock (reissue, revoke). A lock or transaction timeout
 * answers 409 PLAN_BUSY ("retry in a moment") instead of a 500.
 */
async function inLinkTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await setLockTimeout(tx);
        return fn(tx);
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
  } catch (e) {
    throw asPlanBusy(e);
  }
}

/** The advisory lock of one truck-day's link (ensure, reissue and revoke serialize on it). */
async function lockTruckDay(tx: Prisma.TransactionClient, tenantId: string, truckId: string, dateIso: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`driver-link:${tenantId}|${truckId}|${dateIso}`}, 0))`;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError ? e.code === 'P2002' : (e as { code?: unknown } | null)?.code === 'P2002';
}

export interface LinkCallOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** The request's origin: the link's base when AUTH_URL / NEXTAUTH_URL is not set. */
  origin?: string | null;
}

/** The truck and date of a plan's truck, checked: the run is this tenant's and the truck has a load on it. */
async function planTruck(tenantId: string, runId: string, truckId: string) {
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId }, select: { id: true, runDate: true } });
  if (!run) throw new DriverLinkError('Plan not found.', 404, 'NOT_FOUND');
  const truck = await prisma.truck.findFirst({ where: { id: truckId, tenantId }, select: { id: true, code: true, hired: true } });
  const onPlan = truck ? await prisma.planLoad.count({ where: { tenantId, runId, truckId } }) : 0;
  if (!truck || !onPlan) throw new DriverLinkError('This truck has no load in this plan.', 404, 'NOT_FOUND');
  return { date: isoOf(run.runDate), truck };
}

/**
 * Get or create the truck-day's link (POST /api/dispatch/driver-links, the PDF, the dialog's
 * WhatsApp). Refused with 409 LINK_DAY_OVER once its expiry has passed, and with 409 NO_LIVE_LOAD
 * when the truck has no load on the plan in use of that date. A link made before any driver was
 * chosen takes the truck-day's first open driver now (driverIdAtIssue, the silent case of the
 * reissue prompt).
 */
export async function ensureLink(tenantId: string, runId: string, truckId: string, userId: string | null, opts: LinkCallOptions = {}): Promise<DriverLinkView & { created: boolean }> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const key = serverKey(env);
  const { date, truck } = await planTruck(tenantId, runId, truckId);
  const tz = await tenantTz(prisma, tenantId);
  const expiresAt = linkExpiry(date, tz);
  if (expiresAt.getTime() <= now.getTime()) {
    throw new DriverLinkError(`The driver link for ${truck.code} on ${date} is over: it worked until 12:00 the next day.`, 409, 'LINK_DAY_OVER');
  }
  let created = false;
  let link: DriverLink;
  let loads: TruckDayLoad[];
  try {
    ({ link, loads } = await prisma.$transaction(
      async (tx) => {
        await setLockTimeout(tx);
        await lockTruckDay(tx, tenantId, truckId, date);
        const dayLoads = await truckDayLoads(tx, tenantId, truckId, date);
        if (!dayLoads.length) {
          throw new DriverLinkError(`${truck.code} has no load on the plan in use for ${date}.`, 409, 'NO_LIVE_LOAD');
        }
        const firstDriver = earliestOpenLoad(dayLoads)?.driverId ?? null;
        const existing = await tx.driverLink.findFirst({ where: { tenantId, truckId, deliveryDate: dateOnly(date) } });
        if (!existing) {
          const id = newLinkId();
          const salt = newSalt();
          const row = await tx.driverLink.create({
            data: {
              id,
              tenantId,
              truckId,
              deliveryDate: dateOnly(date),
              generation: 1,
              salt,
              keyId: key.keyId,
              tokenHash: tokenHash(deriveToken(key.key, id, 1, salt)),
              expiresAt,
              issuedById: userId,
              driverIdAtIssue: firstDriver,
            },
          });
          created = true;
          await audit(
            {
              tenantId,
              userId,
              action: 'DRIVER_LINK_ISSUED',
              entity: 'DriverLink',
              entityId: row.id,
              afterJson: {
                truckId,
                truckCode: truck.code,
                date,
                generation: 1,
                expiresAt: expiresAt.toISOString(),
                driverName: dayLoads.find((l) => l.driverId === firstDriver)?.driverName ?? null,
              },
            },
            tx,
          );
          return { link: row, loads: dayLoads };
        }
        const patch: Prisma.DriverLinkUpdateInput = {};
        // A rotated server key: the link works again with a new token (every old one stopped).
        if (!existing.revokedAt && existing.keyId !== key.keyId) {
          patch.tokenHash = tokenHash(deriveToken(key.key, existing.id, existing.generation, existing.salt));
          patch.keyId = key.keyId;
        }
        if (existing.driverIdAtIssue === null && firstDriver) patch.driverIdAtIssue = firstDriver;
        const row = Object.keys(patch).length ? await tx.driverLink.update({ where: { id: existing.id }, data: patch }) : existing;
        return { link: row, loads: dayLoads };
      },
      { timeout: 15_000, maxWait: 5_000 },
    ));
  } catch (e) {
    if (!isUniqueViolation(e)) throw asPlanBusy(e);
    // PostgreSQL aborted that transaction at the error: answer from a fresh read, never retry inside it.
    const fresh = await prisma.driverLink.findFirst({ where: { tenantId, truckId, deliveryDate: dateOnly(date) } });
    if (!fresh) throw e;
    link = fresh;
    loads = await truckDayLoads(prisma, tenantId, truckId, date);
    created = false;
  }
  const view = linkView(link, {
    key,
    base: driverLinkBaseUrl(env, opts.origin ?? null),
    now,
    truckCode: truck.code,
    hired: truck.hired,
    loads,
    nameAtIssue: await nameOf(prisma, tenantId, link.driverIdAtIssue, loads),
  });
  return { ...view, created };
}

/**
 * The plan's truck-day links (GET /api/dispatch/driver-links?runId=): existing links only, for the
 * trucks with a load on this plan version. Never creates a link and writes no audit row.
 */
export async function listLinks(tenantId: string, runId: string, opts: LinkCallOptions = {}): Promise<DriverLinkView[]> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const key = driverLinkKey(env);
  if (!key) return [];
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId }, select: { runDate: true } });
  if (!run) throw new DriverLinkError('Plan not found.', 404, 'NOT_FOUND');
  const date = isoOf(run.runDate);
  const truckIds = [...new Set((await prisma.planLoad.findMany({ where: { tenantId, runId }, select: { truckId: true } })).map((l) => l.truckId))];
  if (!truckIds.length) return [];
  const links = await prisma.driverLink.findMany({ where: { tenantId, deliveryDate: dateOnly(date), truckId: { in: truckIds } } });
  if (!links.length) return [];
  const trucks = await prisma.truck.findMany({ where: { tenantId, id: { in: links.map((l) => l.truckId) } }, select: { id: true, code: true, hired: true } });
  const truckOf = new Map(trucks.map((t) => [t.id, t]));
  const base = driverLinkBaseUrl(env, opts.origin ?? null);
  // Every truck's loads at once, and the names of drivers no longer on a load in one query.
  const loadsOf = await truckDayLoadsMany(prisma, tenantId, links.map((l) => l.truckId), date);
  const onLoads = new Map([...loadsOf.values()].flat().flatMap((l) => (l.driverId && l.driverName ? [[l.driverId, l.driverName] as const] : [])));
  const missing = [...new Set(links.map((l) => l.driverIdAtIssue).filter((id): id is string => !!id && !onLoads.has(id)))];
  const others = missing.length ? await prisma.driver.findMany({ where: { tenantId, id: { in: missing } }, select: { id: true, name: true } }) : [];
  const names = new Map([...onLoads, ...others.map((d) => [d.id, d.name] as const)]);
  const out: DriverLinkView[] = [];
  for (const link of links) {
    const loads = loadsOf.get(link.truckId) ?? [];
    const t = truckOf.get(link.truckId);
    const nameAtIssue = link.driverIdAtIssue ? (loads.find((l) => l.driverId === link.driverIdAtIssue)?.driverName ?? names.get(link.driverIdAtIssue) ?? null) : null;
    out.push(linkView(link, { key, base, now, truckCode: t?.code ?? link.truckId, hired: !!t?.hired, loads, nameAtIssue }));
  }
  return out;
}

async function linkForChange(tenantId: string, linkId: string) {
  const link = await prisma.driverLink.findFirst({ where: { id: linkId, tenantId } });
  if (!link) throw new DriverLinkError('Driver link not found.', 404, 'NOT_FOUND');
  const truck = await prisma.truck.findFirst({ where: { id: link.truckId, tenantId }, select: { code: true, hired: true } });
  return { link, truck: truck ?? { code: link.truckId, hired: false } };
}

/**
 * "Reissue link": a new generation and salt. The old token answers 410 LINK_REPLACED at once; the
 * one before it 404. The expiry is kept (a reissue never extends a day). The link is made for the
 * driver of the truck-day's earliest load not COMPLETED, and its phone list starts again.
 */
export async function reissueLink(tenantId: string, linkId: string, userId: string | null, reason: string | null, opts: LinkCallOptions = {}): Promise<DriverLinkView> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const key = serverKey(env);
  const { link: before, truck } = await linkForChange(tenantId, linkId);
  const date = isoOf(before.deliveryDate);
  if (before.expiresAt.getTime() <= now.getTime()) {
    throw new DriverLinkError(`The driver link for ${truck.code} on ${date} is over: it cannot be reissued.`, 409, 'LINK_DAY_OVER');
  }
  const { link, loads } = await inLinkTx(async (tx) => {
    await lockTruckDay(tx, tenantId, before.truckId, date);
    const cur = await tx.driverLink.findFirst({ where: { id: linkId, tenantId } });
    if (!cur) throw new DriverLinkError('Driver link not found.', 404, 'NOT_FOUND');
    const dayLoads = await truckDayLoads(tx, tenantId, cur.truckId, date);
    const generation = cur.generation + 1;
    const salt = newSalt();
    const driverIdAtIssue = earliestOpenLoad(dayLoads)?.driverId ?? null;
    const row = await tx.driverLink.update({
      where: { id: cur.id },
      data: {
        prevTokenHash: cur.tokenHash,
        generation,
        salt,
        keyId: key.keyId,
        tokenHash: tokenHash(deriveToken(key.key, cur.id, generation, salt)),
        revokedAt: null,
        revokedById: null,
        driverIdAtIssue,
        devicesJson: Prisma.DbNull,
        lastSeenAt: null,
        issuedAt: now,
        issuedById: userId,
      },
    });
    await audit(
      {
        tenantId,
        userId,
        action: 'DRIVER_LINK_REISSUED',
        entity: 'DriverLink',
        entityId: cur.id,
        beforeJson: { generation: cur.generation, revoked: !!cur.revokedAt },
        afterJson: {
          truckId: cur.truckId,
          truckCode: truck.code,
          date,
          generation,
          reason: reason ?? null,
          driverName: dayLoads.find((l) => l.driverId === driverIdAtIssue)?.driverName ?? null,
        },
      },
      tx,
    );
    return { link: row, loads: dayLoads };
  });
  return linkView(link, {
    key,
    base: driverLinkBaseUrl(env, opts.origin ?? null),
    now,
    truckCode: truck.code,
    hired: truck.hired,
    loads,
    nameAtIssue: await nameOf(prisma, tenantId, link.driverIdAtIssue, loads),
  });
}

/** "Revoke": no token of this link works until a reissue. Never asks; idempotent. */
export async function revokeLink(tenantId: string, linkId: string, userId: string | null, reason: string | null, opts: LinkCallOptions = {}): Promise<DriverLinkView> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const key = serverKey(env);
  const { link: before, truck } = await linkForChange(tenantId, linkId);
  const date = isoOf(before.deliveryDate);
  const { link, loads } = await inLinkTx(async (tx) => {
    await lockTruckDay(tx, tenantId, before.truckId, date);
    const cur = await tx.driverLink.findFirst({ where: { id: linkId, tenantId } });
    if (!cur) throw new DriverLinkError('Driver link not found.', 404, 'NOT_FOUND');
    const dayLoads = await truckDayLoads(tx, tenantId, cur.truckId, date);
    if (cur.revokedAt) return { link: cur, loads: dayLoads };
    const row = await tx.driverLink.update({ where: { id: cur.id }, data: { revokedAt: now, revokedById: userId } });
    await audit(
      {
        tenantId,
        userId,
        action: 'DRIVER_LINK_REVOKED',
        entity: 'DriverLink',
        entityId: cur.id,
        afterJson: { truckId: cur.truckId, truckCode: truck.code, date, generation: cur.generation, reason: reason ?? null },
      },
      tx,
    );
    return { link: row, loads: dayLoads };
  });
  return linkView(link, {
    key,
    base: driverLinkBaseUrl(env, opts.origin ?? null),
    now,
    truckCode: truck.code,
    hired: truck.hired,
    loads,
    nameAtIssue: await nameOf(prisma, tenantId, link.driverIdAtIssue, loads),
  });
}

// ---------------------------------------------------------------------------------------
// Resolve (every driver request, through withDriverLink)
// ---------------------------------------------------------------------------------------

export type ResolvedLink =
  | { ok: true; link: DriverLink; mode: 'full' | 'uploadOnly'; date: string; expiresAt: Date; uploadUntil: Date }
  | { ok: false; status: 404 | 410 | 503; code: LinkStateCode; message: string; known: boolean; uploadOnly?: boolean; date?: string };

const STATE_TEXT: Record<LinkStateCode, string> = {
  LINK_NOT_FOUND: 'This link does not work any more. Ask your dispatcher for a new one.',
  LINK_REPLACED: 'This link was replaced by a new one. Ask your dispatcher for it.',
  LINK_REVOKED: 'This link does not work any more. Ask your dispatcher for a new one.',
  LINK_EXPIRED: 'This link has expired.',
  UPLOAD_CLOSED: 'This link has expired.',
  DRIVER_LINKS_OFF: 'Driver links are not available on this server. Ask your dispatcher.',
  // Answered by withDriverLink (403), never by resolve: a RouteIQ session of another company.
  SIGNED_IN_OTHER_TENANT: 'You are signed in to RouteIQ for another company. Sign out to use this driver link.',
};

function refused(status: 404 | 410 | 503, code: LinkStateCode, known: boolean, extra: { uploadOnly?: boolean; date?: string } = {}): ResolvedLink {
  return { ok: false, status, code, message: STATE_TEXT[code], known, ...extra };
}

/**
 * The link of a token, and what it may do now:
 * - 404 LINK_NOT_FOUND: not a token shape, an unknown hash (the only case the guard counts against
 *   the IP: `known: false`), or the company is inactive;
 * - 410 LINK_REPLACED: the hash of the generation before the last reissue, or a link made with an
 *   older server key (never counted as a bad token);
 * - 410 LINK_REVOKED; 410 UPLOAD_CLOSED after the 72 h upload grace;
 * - ok with mode `uploadOnly` between the expiry and the end of the grace (the guard answers a
 *   read with 410 LINK_EXPIRED + uploadOnly), else mode `full`.
 */
export async function resolveDriverLink(token: string | null | undefined, opts: { now?: Date; env?: NodeJS.ProcessEnv } = {}): Promise<ResolvedLink> {
  if (!looksLikeToken(token)) return refused(404, 'LINK_NOT_FOUND', false);
  const key = driverLinkKey(opts.env ?? process.env);
  if (!key) return refused(503, 'DRIVER_LINKS_OFF', true);
  const now = opts.now ?? new Date();
  const h = sha256Hex(token);
  const link = await prisma.driverLink.findFirst({ where: { OR: [{ tokenHash: h }, { prevTokenHash: h }] } });
  if (!link) return refused(404, 'LINK_NOT_FOUND', false);
  const tenant = await prisma.tenant.findFirst({ where: { id: link.tenantId }, select: { active: true } });
  if (!tenant?.active) return refused(404, 'LINK_NOT_FOUND', true);
  const date = isoOf(link.deliveryDate);
  if (link.prevTokenHash === h && link.tokenHash !== h) return refused(410, 'LINK_REPLACED', true, { date });
  if (link.keyId !== key.keyId) return refused(410, 'LINK_REPLACED', true, { date });
  if (link.revokedAt) return refused(410, 'LINK_REVOKED', true, { date });
  const uploadUntil = linkUploadUntil(link.expiresAt);
  if (now.getTime() >= uploadUntil.getTime()) return refused(410, 'UPLOAD_CLOSED', true, { date });
  const mode = now.getTime() >= link.expiresAt.getTime() ? 'uploadOnly' : 'full';
  return { ok: true, link, mode, date, expiresAt: link.expiresAt, uploadUntil };
}

/**
 * Best effort: lastSeenAt and the device list, at most every 5 minutes (touchUpdate). Never fails a
 * request. `deviceHash16`: the first 16 hex of SHA-256 of the page's browser id (guard.ts); the list
 * keeps its first 8.
 */
export async function touchLink(link: Pick<DriverLink, 'id' | 'tenantId' | 'lastSeenAt' | 'devicesJson' | 'generation'>, deviceHash16: string | null, now: Date = new Date()): Promise<void> {
  const device = deviceHash16 ? deviceHash16.slice(0, 8) : null;
  const next = touchUpdate(link, device, now);
  if (!next) return;
  try {
    // Only while this generation is current: a reissue in between starts a new list.
    await prisma.driverLink.updateMany({
      where: { id: link.id, tenantId: link.tenantId, generation: link.generation },
      data: { lastSeenAt: next.lastSeenAt, devicesJson: next.devices as unknown as Prisma.InputJsonValue },
    });
  } catch (e) {
    console.warn('[driver-link] lastSeenAt not written', (e as Error)?.message ?? e);
  }
}
