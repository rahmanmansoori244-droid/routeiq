/**
 * IVMS live link (16 Oct 2026): how long the trackers' data is kept (privacy; owner decision D-1 pending:
 * "a trail kept 2 days, only while a load is out, never exported"). Run by the in-process janitor at most
 * every 10 minutes and by the cron route (`force`), in its own try, per company:
 * - TruckTrailPoint (the history pulled from Ayun): deleted ivmsTrailDays (1-7, default 2) after the fix;
 * - TruckPosition (the map's latest position): deleted when the company's ivmsMode is OFF, and a day after
 *   it was read (the poller also deletes it as soon as the truck has no load out: M7);
 * - IvmsEvent (depot and zone moves): the position erased after ivmsTrailDays (the move and its time stay,
 *   for the day screen), the row deleted after locationRetentionDays (as the driver positions);
 * - IvmsTruckDay (how far the history was pulled, the "GPS suppressed" marker): deleted after
 *   locationRetentionDays.
 * Positions on GPS stop events (StopEvent source AYUN) are erased with every other source's by
 * lib/jobs/delivery-janitor.ts purgeOldLocations. Nothing at all is read beyond one EXISTS while no GPS data
 * exists (a company that never switched the link on). No audit row: these are not company records.
 *
 * The analysis dataset (owner request 19 Oct 2026, lib/analysis/*): purgeAnalysisFacts below deletes the
 * nightly facts (FactTruckDay, FactVisit, FactLeg, FactDepotTurn) older than analysisRetentionDays (730 by
 * default). The nightly job (lib/analysis/job.ts) calls it once a night per company, after its build: the
 * facts outlive the trail by design (they hold no position), so they are not part of purgeIvmsData.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { addDaysIso, dateOnly, DEFAULT_TZ, todayIso } from '../dispatch/time';
import { DEFAULT_LOCATION_RETENTION_DAYS, DEFAULT_PHOTO_RETENTION_DAYS } from '../settings-fields';
import { ANALYSIS_RETENTION_BOUNDS, DEFAULT_ANALYSIS_RETENTION_DAYS } from '../analysis/types';
import { ivmsModeOf } from './settings';

type Db = Prisma.TransactionClient | typeof prisma;

const DAY_MS = 24 * 3600_000;
export const IVMS_RETENTION_EVERY_MS = 10 * 60_000;
/** A live position not refreshed for this long is deleted whatever the mode. */
export const POSITION_MAX_AGE_MS = DAY_MS;

export interface IvmsRetentionResult {
  trailPoints: number;
  positions: number;
  eventsErased: number;
  eventsDeleted: number;
  truckDays: number;
}

/**
 * The trail retention's cutoff: a fix older than this is deleted (ivmsTrailDays, clamped to 1-7). One
 * expression for the sweep below and for the analysis job (lib/analysis/job.ts trailWhole), which must never
 * build a truck-day's GPS facts from a trail whose start this sweep has already deleted (review of 19 Oct 2026).
 */
export function trailCutoffOf(now: Date, ivmsTrailDays: number): Date {
  const trailDays = Math.min(7, Math.max(1, ivmsTrailDays));
  return new Date(now.getTime() - trailDays * DAY_MS);
}

/** Is there any GPS data at all? One statement: false for every company that never used the link. */
async function anyIvmsData(db: Db): Promise<boolean> {
  const rows = await db.$queryRaw<{ any: boolean }[]>`
    SELECT (EXISTS (SELECT 1 FROM "TruckPosition") OR EXISTS (SELECT 1 FROM "TruckTrailPoint")
         OR EXISTS (SELECT 1 FROM "IvmsEvent") OR EXISTS (SELECT 1 FROM "IvmsTruckDay")) AS "any"`;
  return !!rows[0]?.any;
}

/** The retention sweep (see the header). Null = no GPS data exists, nothing was looked at. */
export async function purgeIvmsData(now: Date = new Date(), db: Db = prisma): Promise<IvmsRetentionResult | null> {
  if (!(await anyIvmsData(db))) return null;
  const out: IvmsRetentionResult = { trailPoints: 0, positions: 0, eventsErased: 0, eventsDeleted: 0, truckDays: 0 };
  const configs = await db.tenantConfig.findMany({
    select: { tenantId: true, ivmsMode: true, ivmsTrailDays: true, locationRetentionDays: true, photoRetentionDays: true, timezone: true },
  });
  for (const c of configs) {
    const t = c.tenantId;
    // As the driver positions: never kept longer than the photos, at least 30 days (delivery-janitor.ts).
    const keepDays = Math.max(30, Math.min(c.locationRetentionDays ?? DEFAULT_LOCATION_RETENTION_DAYS, c.photoRetentionDays ?? DEFAULT_PHOTO_RETENTION_DAYS));
    const trailCutoff = trailCutoffOf(now, c.ivmsTrailDays);
    const keepCutoff = new Date(now.getTime() - keepDays * DAY_MS);
    out.trailPoints += (await db.truckTrailPoint.deleteMany({ where: { tenantId: t, fixAt: { lt: trailCutoff } } })).count;
    out.positions += (
      await db.truckPosition.deleteMany({
        where: ivmsModeOf(c) === 'OFF' ? { tenantId: t } : { tenantId: t, receivedAt: { lt: new Date(now.getTime() - POSITION_MAX_AGE_MS) } },
      })
    ).count;
    out.eventsErased += (
      await db.ivmsEvent.updateMany({ where: { tenantId: t, eventAt: { lt: trailCutoff }, OR: [{ lat: { not: null } }, { lng: { not: null } }] }, data: { lat: null, lng: null } })
    ).count;
    out.eventsDeleted += (await db.ivmsEvent.deleteMany({ where: { tenantId: t, eventAt: { lt: keepCutoff } } })).count;
    const firstKeptDay = addDaysIso(todayIso(c.timezone || DEFAULT_TZ, now), -keepDays);
    out.truckDays += (await db.ivmsTruckDay.deleteMany({ where: { tenantId: t, deliveryDate: { lt: dateOnly(firstKeptDay) } } })).count;
  }
  return out;
}

const g = globalThis as unknown as { __routeiqIvmsRetentionAt?: number };

/** At most every 10 minutes (the cron route: `force`, now). Null when it did not run or found no GPS data. */
export async function runIvmsRetention(now: Date = new Date(), opts: { force?: boolean } = {}): Promise<IvmsRetentionResult | null> {
  if (!opts.force && g.__routeiqIvmsRetentionAt && now.getTime() - g.__routeiqIvmsRetentionAt < IVMS_RETENTION_EVERY_MS) return null;
  g.__routeiqIvmsRetentionAt = now.getTime();
  return purgeIvmsData(now);
}

/** Did a retention sweep change anything? */
export function ivmsRetentionChanged(r: IvmsRetentionResult | null): boolean {
  return !!r && Object.values(r).some((n) => n > 0);
}

export interface AnalysisRetentionResult {
  truckDays: number;
  visits: number;
  legs: number;
  turns: number;
}

/**
 * The analysis dataset (owner request 19 Oct 2026, lib/analysis/*): the fact rows of a delivery date older
 * than TenantConfig.analysisRetentionDays (730 by default, 30-3650) before the company's today are deleted,
 * frozen or not. One company (the nightly job calls it once a night per company, after its build) or every
 * company. Four statements per company on the (tenantId, deliveryDate) indexes; nothing else is read. The
 * rows are derived data (no audit row), and they hold no position: the GPS trail itself keeps its own, much
 * shorter, ivmsTrailDays above.
 */
export async function purgeAnalysisFacts(now: Date = new Date(), db: Db = prisma, tenantId?: string): Promise<AnalysisRetentionResult> {
  const out: AnalysisRetentionResult = { truckDays: 0, visits: 0, legs: 0, turns: 0 };
  const configs = await db.tenantConfig.findMany({ where: tenantId ? { tenantId } : {}, select: { tenantId: true, timezone: true, analysisRetentionDays: true } });
  for (const c of configs) {
    const days = Math.min(ANALYSIS_RETENTION_BOUNDS.max, Math.max(ANALYSIS_RETENTION_BOUNDS.min, c.analysisRetentionDays ?? DEFAULT_ANALYSIS_RETENTION_DAYS));
    const where = { tenantId: c.tenantId, deliveryDate: { lt: dateOnly(addDaysIso(todayIso(c.timezone || DEFAULT_TZ, now), -days)) } };
    out.visits += (await db.factVisit.deleteMany({ where })).count;
    out.legs += (await db.factLeg.deleteMany({ where })).count;
    out.turns += (await db.factDepotTurn.deleteMany({ where })).count;
    out.truckDays += (await db.factTruckDay.deleteMany({ where })).count;
  }
  return out;
}
