/**
 * The analysis dataset's nightly job (owner request 19 Oct 2026: "build on more data for our analysis later
 * and improvement"). Run by the in-process janitor (lib/jobs/janitor-loop.ts, at most every 10 min, in its
 * own try) and by the cron route (/api/cron/janitor, after every other step), never by a request. Server only.
 *
 * Per company, in its own time zone, with the "effective day" E = the local date 3 h ago (so from 03:00 E is
 * today, before 03:00 it is still yesterday):
 * 1. BUILD the day before E in full, while its trail still exists (at 03:00 the day's fixes are at most 27 h
 *    old, inside the default 2-day trail): every truck with a load that left (DISPATCHED or COMPLETED) on the
 *    company's plan in use. A night the job did not run (a deploy, a restart) is built later, up to 7 days
 *    back. Its GPS columns are built only from a WHOLE trail (review of 19 Oct 2026): when the GPS retention
 *    (ivmsTrailDays, lib/ivms/retention.ts trailCutoffOf) has already deleted the start of the truck-day's
 *    trail (its operating hours' start, where its pulls begin), the GPS columns stay empty with the note
 *    PARTIAL_TRAIL. A deploy at 14:00 with the 2-day trail would otherwise build the day 2 days back from the
 *    afternoon's points only: every morning stop "not seen", the time out and km of the afternoon - and freeze them;
 * 2. REFRESH the dates 2 to 4 days before E once a night: every column that does not come from the trail is
 *    built again (a result saved late, an office correction, a load completed the next morning); the trail's
 *    columns and the settings are copied from the rows stored at the build. When the truck-day's trail was
 *    pulled again after its GPS columns were built (IvmsTruckDay.lastPullAt: the poller's final pull over the
 *    whole day comes 10 min after the last load is completed, so a load the office completes the next morning
 *    is pulled after the 03:00 build) and is still whole, the GPS columns are computed again from it, with the
 *    settings of the build (review of 19 Oct 2026);
 * 3. FREEZE: the refresh of the 4th day sets frozenAt; a frozen row is never written again (a date older than
 *    that and still not frozen - a missed night - is refreshed and frozen at once);
 * 4. PURGE the company's rows older than its analysisRetentionDays (lib/ivms/retention.ts purgeAnalysisFacts).
 *
 * Idempotent: each truck-day is written in one transaction that deletes the truck-day's rows that are not
 * frozen and inserts the new ones (natural keys, so a second process during a deploy gets a unique-key error
 * and that truck-day is simply skipped); a truck-day already built this night is not built again (its rows
 * say when). Bounded: at most ANALYSIS_BUDGET_MS of work per run (the rest continues at the next run, 10 min
 * later), the event loop given back between truck-days, at most 7 dates per company. A date is read again at
 * the next run unless every truck-day of it was done this night (review of 19 Oct 2026: after a time-budget
 * cut, a truck that had no row yet waited a night, with its trail a day older). Tenant-scoped: every query
 * names the company. Never blocks other janitor work: the janitor calls it in its own try, and a failing
 * truck-day is logged by its code only (never a message: a Prisma message can quote positions). It is tried
 * again at the next run the same night - the company is not marked done while a truck-day failed (review of
 * 19 Oct 2026: a deadlock at 03:00 waited a night, and with ivmsTrailDays 1 lost its GPS for good) - up to
 * ANALYSIS_MAX_TRIES times a night, then left for the next night. ROUTEIQ_DISABLE_ANALYSIS=1 stops it. No
 * call to Ayun, no audit row (derived data).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { findInParts } from '../in-parts';
import { effectiveServiceTime } from '../dispatch/customer-attrs';
import { addDaysIso, dateOnly, DEFAULT_TZ, localDateIso, zonedDayStart } from '../dispatch/time';
import { dispatchedAt } from '../dispatch/dispatched-at';
import { readLoadOrigin, readTruckSnapshot } from '../dispatch/snapshots';
import { liveRunsInRange, loadsOfRuns, stopsOfLoads, type RoadLoad } from '../delivery/day-results';
import { opsStartOf } from '../ivms/budget';
import { IVMS_SETTING_DEFAULTS } from '../ivms/settings';
import { detectorParams } from '../ivms/stops';
import { DETECTOR_FIXED, DETECTOR_VERSION, type TrailPoint } from '../ivms/types';
import { purgeAnalysisFacts, trailCutoffOf, type AnalysisRetentionResult } from '../ivms/retention';
import { buildTruckDayFacts, type AnalysisSettings, type EventIn, type GpsSource, type LoadIn, type TruckDayFacts, type TruckDayIn, type VisitIn } from './build';
import { ANALYSIS_BUILD_AT_MIN, ANALYSIS_CATCHUP_DAYS, ANALYSIS_REFRESH_DAYS } from './types';

type Db = typeof prisma;
/**
 * One truck-day as the job reads it: the builder's input, when the tracker was mapped to the truck
 * (IvmsTruckDay.trailFrom: no point before it) and when its trail was last pulled (IvmsTruckDay.lastPullAt).
 */
export type DayInput = TruckDayIn & { trailFrom: Date | null; lastPullAt?: Date | null };
/** What the job reads about a date, per truck (readDay below). */
export type DayReader = (db: Db, tenantId: string, date: string) => Promise<Map<string, DayInput>>;

/** The janitor runs the job at most this often (the cron route: `force`). */
export const ANALYSIS_EVERY_MS = 10 * 60_000;
/** At most this much work per run; the rest waits for the next run. */
export const ANALYSIS_BUDGET_MS = 20_000;
/** A truck-day that fails is tried at most this many times a night (then at the next night's run). */
export const ANALYSIS_MAX_TRIES = 3;
/** The trail read for a truck-day: from 3 h before its local midnight to 3 h after the next (as the GPS times). */
const TRAIL_BEFORE_H = 3;
const TRAIL_AFTER_H = 27;
const MIN = 60_000;

/** The effective day: the company's local date 3 h ago (the night's work belongs to the day that starts at 03:00). */
export function effectiveDay(now: Date, tz: string): string {
  return localDateIso(new Date(now.getTime() - ANALYSIS_BUILD_AT_MIN * MIN), tz);
}

/** When this night's work began (03:00 of the effective day): a row refreshed before it is due again. */
export function cycleStartOf(effective: string, tz: string): Date {
  return new Date(zonedDayStart(effective, tz).getTime() + ANALYSIS_BUILD_AT_MIN * MIN);
}

/** What to do with a truck-day of `date` tonight (pure: the schedule of the header). */
export function truckDayAction(
  date: string,
  effective: string,
  row: { refreshedAt: Date; frozenAt: Date | null } | null,
  cycleStart: Date,
): 'BUILD' | 'REFRESH' | 'SKIP' {
  if (date >= effective) return 'SKIP';
  if (!row) return 'BUILD';
  if (row.frozenAt) return 'SKIP';
  if (date === addDaysIso(effective, -1)) return 'SKIP'; // built tonight; refreshed from tomorrow night
  return row.refreshedAt.getTime() < cycleStart.getTime() || date <= addDaysIso(effective, -ANALYSIS_REFRESH_DAYS) ? 'REFRESH' : 'SKIP';
}

/** Is a truck-day of `date` frozen by tonight's write (its last refresh, or a build of a date already that old)? */
export const freezesTonight = (date: string, effective: string) => date <= addDaysIso(effective, -ANALYSIS_REFRESH_DAYS);

export interface AnalysisJobResult {
  tenants: number;
  built: number;
  refreshed: number;
  frozen: number;
  /** Truck-days whose rows were removed (no load that left any more), not frozen. */
  removed: number;
  /** Truck-days that failed (logged by code; retried at the next run). */
  failed: number;
  /** The time budget ran out: the rest continues at the next run. */
  unfinished: boolean;
  purged: AnalysisRetentionResult;
  ms: number;
}

/** Did a run change anything (the cron route adds `analysis` only then)? */
export function analysisChanged(r: AnalysisJobResult | null): boolean {
  return !!r && (r.built + r.refreshed + r.frozen + r.removed + r.failed > 0 || r.unfinished || Object.values(r.purged).some((n) => n > 0));
}

/** What this process did for a company tonight: the dates done in full, and the failures per truck-day. */
interface NightState {
  effective: string;
  dates: Set<string>;
  tries: Map<string, number>;
}

const g = globalThis as unknown as {
  __routeiqAnalysisAt?: number;
  __routeiqAnalysisRunning?: boolean;
  __routeiqAnalysisDone?: Map<string, string>;
  __routeiqAnalysisNight?: Map<string, NightState>;
};
const doneOf = () => (g.__routeiqAnalysisDone ??= new Map<string, string>());
/** The company's state for this night (a new night forgets the last one's). */
function nightOf(tenantId: string, effective: string): NightState {
  const all = (g.__routeiqAnalysisNight ??= new Map<string, NightState>());
  let s = all.get(tenantId);
  if (!s || s.effective !== effective) {
    s = { effective, dates: new Set(), tries: new Map() };
    all.set(tenantId, s);
  }
  return s;
}

/** Tests: forget the throttle and what was finished. */
export function _resetAnalysisJobState(): void {
  g.__routeiqAnalysisAt = undefined;
  g.__routeiqAnalysisRunning = false;
  g.__routeiqAnalysisDone = new Map();
  g.__routeiqAnalysisNight = new Map();
}

type ConfigRow = {
  tenantId: string;
  timezone: string;
  overtimeAfterMin: number;
  serviceMinPerCase: number;
  reloadMinutes: number;
  loadingMinPerCase: number;
  distanceMultiplier: number;
  avgSpeedKmh: number;
  roadTimeFactor: number;
  ivmsStopRadiusM: number;
  ivmsStopDwellMin: number;
  ivmsDepotRadiusM: number;
  /** The GPS retention and the operating hours (where a truck-day's pulls begin): is a trail still whole? */
  ivmsTrailDays?: number | null;
  ivmsFromMin?: number | null;
  ivmsToMin?: number | null;
};

/**
 * Is a truck-day's trail still whole at `now`? Its pulls begin at the operating hours' start of the date
 * (lib/ivms/poll.ts routeWindow), or when the tracker was mapped to the truck if later; the GPS retention
 * deletes every fix older than trailCutoffOf (lib/ivms/retention.ts, the same expression). Whole when that
 * start is not older than the cutoff (review of 19 Oct 2026: a catch-up must never build from the rest).
 */
export function trailWhole(date: string, trailFrom: Date | null, c: Pick<ConfigRow, 'timezone' | 'ivmsTrailDays' | 'ivmsFromMin' | 'ivmsToMin'>, now: Date): boolean {
  const hours = { timezone: c.timezone || DEFAULT_TZ, fromMin: c.ivmsFromMin ?? IVMS_SETTING_DEFAULTS.ivmsFromMin, toMin: c.ivmsToMin ?? IVMS_SETTING_DEFAULTS.ivmsToMin };
  const start = Math.max(opsStartOf(date, hours).getTime(), trailFrom?.getTime() ?? -Infinity);
  return start >= trailCutoffOf(now, c.ivmsTrailDays ?? IVMS_SETTING_DEFAULTS.ivmsTrailDays).getTime();
}

export function settingsOf(c: ConfigRow): AnalysisSettings {
  return {
    tz: c.timezone || DEFAULT_TZ,
    overtimeAfterMin: c.overtimeAfterMin,
    serviceMinPerCase: c.serviceMinPerCase,
    reloadMinutes: c.reloadMinutes,
    loadingMinPerCase: c.loadingMinPerCase,
    distanceMultiplier: c.distanceMultiplier,
    avgSpeedKmh: c.avgSpeedKmh,
    roadTimeFactor: c.roadTimeFactor,
    params: detectorParams(c, DETECTOR_FIXED),
    detectorVersion: DETECTOR_VERSION,
  };
}

/**
 * The nightly job (see the header). Null when it did not run (the kill switch, the 10-minute throttle, a run
 * already under way in this process). `force` (the cron route) skips the throttle and what this process
 * finished already; the schedule itself (built once, refreshed once a night, frozen) is the same.
 */
export async function runAnalysisJob(
  now: Date = new Date(),
  opts: {
    force?: boolean;
    budgetMs?: number;
    db?: Db;
    /** Tests feed the day: the plan, visits and events per truck (default readDay). */
    read?: DayReader;
    /** Only these companies (an integration test on a shared database); absent: every company. */
    tenantIds?: readonly string[];
    /** Tests: the clock the time budget is measured with (default Date.now). */
    clock?: () => number;
  } = {},
): Promise<AnalysisJobResult | null> {
  if (process.env.ROUTEIQ_DISABLE_ANALYSIS === '1') return null;
  if (g.__routeiqAnalysisRunning) return null;
  if (!opts.force && g.__routeiqAnalysisAt && now.getTime() - g.__routeiqAnalysisAt < ANALYSIS_EVERY_MS) return null;
  g.__routeiqAnalysisAt = now.getTime();
  g.__routeiqAnalysisRunning = true;
  const db = opts.db ?? prisma;
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const budget = opts.budgetMs ?? ANALYSIS_BUDGET_MS;
  const out: AnalysisJobResult = { tenants: 0, built: 0, refreshed: 0, frozen: 0, removed: 0, failed: 0, unfinished: false, purged: { truckDays: 0, visits: 0, legs: 0, turns: 0 }, ms: 0 };
  try {
    const configs = (await db.tenantConfig.findMany({
      ...(opts.tenantIds ? { where: { tenantId: { in: [...opts.tenantIds] } } } : {}),
      select: {
        tenantId: true, timezone: true, overtimeAfterMin: true, serviceMinPerCase: true, reloadMinutes: true, loadingMinPerCase: true, distanceMultiplier: true,
        avgSpeedKmh: true, roadTimeFactor: true, ivmsStopRadiusM: true, ivmsStopDwellMin: true, ivmsDepotRadiusM: true, ivmsTrailDays: true, ivmsFromMin: true, ivmsToMin: true,
      },
    })) as ConfigRow[];
    for (const c of configs) {
      const tz = c.timezone || DEFAULT_TZ;
      const effective = effectiveDay(now, tz);
      if (!opts.force && doneOf().get(c.tenantId) === effective) continue;
      out.tenants++;
      const state = await runCompany(db, c, effective, now, () => clock() - started > budget, out, opts.read ?? readDay, !!opts.force);
      if (state === 'UNFINISHED') {
        out.unfinished = true;
        break;
      }
      const purged = await purgeAnalysisFacts(now, db, c.tenantId);
      for (const k of Object.keys(purged) as (keyof AnalysisRetentionResult)[]) out.purged[k] += purged[k];
      // Done for tonight only without a truck-day left to try again (a failure: the next run, 10 min later).
      if (state === 'COMPLETE') doneOf().set(c.tenantId, effective);
    }
  } finally {
    g.__routeiqAnalysisRunning = false;
    out.ms = clock() - started;
  }
  return out;
}

/**
 * One company's night: COMPLETE, FAILED (a truck-day failed and may be tried again tonight: the company is
 * not done) or UNFINISHED (the budget ran out: the rest continues at the next run).
 */
async function runCompany(
  db: Db,
  c: ConfigRow,
  effective: string,
  now: Date,
  overBudget: () => boolean,
  out: AnalysisJobResult,
  read: DayReader,
  force: boolean,
): Promise<'COMPLETE' | 'FAILED' | 'UNFINISHED'> {
  const settings = settingsOf(c);
  const cycleStart = cycleStartOf(effective, settings.tz);
  const night = nightOf(c.tenantId, effective);
  let retry = false;
  // The newest date first: its trail is the most complete and the first to matter.
  for (let back = 1; back <= ANALYSIS_CATCHUP_DAYS; back++) {
    const date = addDaysIso(effective, -back);
    // A date whose every truck-day was done tonight is not read again (a forced run still reads the day
    // before: a load marked as left late). Any other date is read in full: a truck with no row yet is found
    // only by the read, never by the rows already written (review of 19 Oct 2026).
    if (night.dates.has(date) && !(force && back === 1)) continue;
    const rows = await db.factTruckDay.findMany({ where: { tenantId: c.tenantId, deliveryDate: dateOnly(date) }, select: { truckId: true, refreshedAt: true, frozenAt: true } });
    const rowOf = new Map(rows.map((r) => [r.truckId, r]));
    const inputs = await read(db, c.tenantId, date);
    const trucks = new Set([...inputs.keys(), ...rows.filter((r) => !r.frozenAt).map((r) => r.truckId)]);
    let dateDone = true;
    for (const truckId of trucks) {
      const action = truckDayAction(date, effective, rowOf.get(truckId) ?? null, cycleStart);
      if (action === 'SKIP') continue;
      const key = `${date}|${truckId}`;
      if ((night.tries.get(key) ?? 0) >= ANALYSIS_MAX_TRIES) continue; // given up tonight: the next night's run
      if (overBudget()) return 'UNFINISHED';
      // The detector is synchronous work on the one web process: give the event loop back between truck-days.
      await new Promise<void>((r) => setImmediate(r));
      try {
        const input = inputs.get(truckId);
        const freeze = freezesTonight(date, effective);
        if (!input) {
          // No load of this truck left on that date any more: its rows go (never frozen ones).
          if (await replaceTruckDay(db, c.tenantId, date, truckId, null)) out.removed++;
          continue;
        }
        let gps: GpsSource;
        let previous: TruckDayFacts | undefined;
        if (action === 'BUILD') gps = await gpsSourceOf(db, c, input, now);
        else {
          previous = await storedRows(db, c.tenantId, date, truckId);
          // The trail pulled again after the GPS columns were built (the final pull of a load completed the next
          // morning) and still whole: the GPS columns are computed again; otherwise copied as they are.
          const t = previous.truckDay;
          const again = !!input.lastPullAt && input.lastPullAt.getTime() > (t.gpsBuiltAt ?? t.builtAt).getTime();
          const fresh = again ? await gpsSourceOf(db, c, input, now) : null;
          gps = fresh?.kind === 'TRAIL' ? fresh : { kind: 'STORED', rows: previous };
        }
        const facts = buildTruckDayFacts(input, settings, gps, { now, freeze, previous });
        if (await replaceTruckDay(db, c.tenantId, date, truckId, facts)) {
          if (action === 'BUILD') out.built++;
          else out.refreshed++;
          if (freeze) out.frozen++;
        }
      } catch (e) {
        out.failed++;
        const tries = (night.tries.get(key) ?? 0) + 1;
        night.tries.set(key, tries);
        if (tries < ANALYSIS_MAX_TRIES) dateDone = false;
        console.warn('[analysis] truck-day not built', String((e as { code?: string; name?: string } | null)?.code ?? (e as Error)?.name ?? 'error').slice(0, 40));
      }
    }
    if (dateDone) night.dates.add(date);
    else retry = true;
  }
  // A date older than the refresh window that was never frozen (a missed night beyond the catch-up): frozen as it is.
  const old = { tenantId: c.tenantId, deliveryDate: { lt: dateOnly(addDaysIso(effective, -ANALYSIS_REFRESH_DAYS)) }, frozenAt: null };
  const frozen = (await db.factTruckDay.updateMany({ where: old, data: { frozenAt: now } })).count;
  await db.factVisit.updateMany({ where: old, data: { frozenAt: now } });
  await db.factLeg.updateMany({ where: old, data: { frozenAt: now } });
  await db.factDepotTurn.updateMany({ where: old, data: { frozenAt: now } });
  out.frozen += frozen;
  return retry ? 'FAILED' : 'COMPLETE';
}

const jsonOrNull = (v: Prisma.JsonValue | null | undefined) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue));

/**
 * Write one truck-day in one transaction: its rows that are not frozen are deleted, the new ones inserted
 * (null `facts`: only deleted). Nothing when a frozen row of the truck-day exists. False when nothing was
 * written (frozen, or another process wrote it at the same moment: a unique key).
 */
export async function replaceTruckDay(db: Db, tenantId: string, date: string, truckId: string, facts: TruckDayFacts | null): Promise<boolean> {
  const key = { tenantId, deliveryDate: dateOnly(date), truckId };
  try {
    return await db.$transaction(async (tx) => {
      if (await tx.factTruckDay.findFirst({ where: { ...key, frozenAt: { not: null } }, select: { id: true } })) return false;
      const unfrozen = { ...key, frozenAt: null };
      await tx.factVisit.deleteMany({ where: unfrozen });
      await tx.factLeg.deleteMany({ where: unfrozen });
      await tx.factDepotTurn.deleteMany({ where: unfrozen });
      const gone = (await tx.factTruckDay.deleteMany({ where: unfrozen })).count;
      if (!facts) return gone > 0;
      await tx.factTruckDay.create({ data: { ...facts.truckDay, tenantId } });
      if (facts.visits.length) {
        await tx.factVisit.createMany({ data: facts.visits.map((v) => ({ ...v, tenantId, awayJson: jsonOrNull(v.awayJson), substaysJson: jsonOrNull(v.substaysJson) })) });
      }
      if (facts.legs.length) await tx.factLeg.createMany({ data: facts.legs.map((l) => ({ ...l, tenantId })) });
      if (facts.turns.length) await tx.factDepotTurn.createMany({ data: facts.turns.map((t) => ({ ...t, tenantId })) });
      return true;
    });
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === 'P2002') return false;
    throw e;
  }
}

/** The rows stored for a truck-day (a refresh copies their trail columns and settings). */
async function storedRows(db: Db, tenantId: string, date: string, truckId: string): Promise<TruckDayFacts> {
  const key = { tenantId, deliveryDate: dateOnly(date), truckId };
  const [truckDay, visits, legs, turns] = await Promise.all([
    db.factTruckDay.findFirst({ where: key }),
    db.factVisit.findMany({ where: key }),
    db.factLeg.findMany({ where: key }),
    db.factDepotTurn.findMany({ where: key }),
  ]);
  if (!truckDay) throw Object.assign(new Error('no stored truck-day'), { code: 'NO_ROW' });
  const strip = <T extends { id: string; tenantId: string }>(r: T) => {
    const { id: _id, tenantId: _t, ...rest } = r;
    void _id;
    void _t;
    return rest;
  };
  return { truckDay: strip(truckDay), visits: visits.map(strip), legs: legs.map(strip), turns: turns.map(strip) };
}

/**
 * The trail of a truck-day and its tracker's depot moves (BUILD, or a refresh after a later pull), or why
 * there is none: a trail whose start the GPS retention already deleted is never used (PARTIAL_TRAIL).
 */
async function gpsSourceOf(db: Db, c: ConfigRow, input: DayInput, now: Date): Promise<GpsSource> {
  if (input.suppressed || !input.tracked) return { kind: 'NONE' };
  if (!trailWhole(input.date, input.trailFrom, c, now)) return { kind: 'NONE', note: 'PARTIAL_TRAIL' };
  const tenantId = c.tenantId;
  const dayStart = zonedDayStart(input.date, c.timezone || DEFAULT_TZ);
  const from = new Date(dayStart.getTime() - TRAIL_BEFORE_H * 60 * MIN);
  const to = new Date(dayStart.getTime() + TRAIL_AFTER_H * 60 * MIN);
  // Never a point from before the tracker was mapped to this truck (as the GPS times: second review M-1).
  const since = input.trailFrom && input.trailFrom > from ? input.trailFrom : from;
  const points: TrailPoint[] = await db.truckTrailPoint.findMany({
    where: { tenantId, truckId: input.truckId, fixAt: { gte: since, lte: to } },
    orderBy: { fixAt: 'asc' },
    select: { fixAt: true, lat: true, lng: true, speedKmh: true, ignition: true },
  });
  if (!points.length) return { kind: 'NONE' };
  const moves = await db.ivmsEvent.findMany({
    where: { tenantId, truckId: input.truckId, kind: { in: ['DEPOT_IN', 'DEPOT_OUT'] }, origin: { in: ['WEBHOOK', 'BACKSTOP'] }, eventAt: { gte: from, lte: to } },
    select: { id: true, kind: true, eventAt: true, depotId: true },
  });
  return {
    kind: 'TRAIL',
    points,
    zoneMoves: moves.map((m) => ({ id: m.id, kind: m.kind as 'DEPOT_IN' | 'DEPOT_OUT', at: m.eventAt, depotId: m.depotId })),
    // The tracker's own depot IN closes a trip whose trail ended before the truck came back.
    deviceIn: moves.filter((m) => m.kind === 'DEPOT_IN').map((m) => m.eventAt),
  };
}

/**
 * The base unloading minutes the planner gives a customer's stop before the per-case time
 * (FactVisit.baseServiceMin): the planner's own rule, lib/dispatch/customer-attrs.ts effectiveServiceTime -
 * the customer's confirmed time, else its customer type's, else the company default. Never the stored time
 * alone: an unconfirmed customer holds the column default (10 min) while the plan used the company default
 * (the first facts, 17-18 Oct 2026, stored 10 where the plan used 15). The stop snapshot cannot give it: its
 * serviceMin is the base plus the per-case time, rounded and capped at 480. Null: the customer is not found.
 */
export function baseServiceOf(
  c: { avgServiceTimeMin: number; serviceTimeConfirmed: boolean; customerType: string | null } | undefined,
  profiles: Map<string, { serviceTimeMin: number | null }>,
  defaultServiceTimeMin: number,
): number | null {
  return c ? effectiveServiceTime(c, profiles, { serviceTimeMin: defaultServiceTimeMin }).serviceMin : null;
}

/**
 * Everything the builder needs about a date, per truck: the loads that left on the company's plans in use,
 * their stops (with the plan rows' departure and km), the visits, the stop events, the depots, whether the
 * truck had a tracker (never the IMEI itself) and whether its GPS was suppressed. A handful of queries for
 * the whole date, each naming the company.
 */
export async function readDay(db: Db, tenantId: string, date: string): Promise<Map<string, DayInput>> {
  const out = new Map<string, DayInput>();
  const runs = await liveRunsInRange(db, tenantId, date, date);
  const loads = await loadsOfRuns(db, tenantId, runs);
  if (!loads.length) return out;
  const ids = loads.map((l) => l.id);
  const [extra, stopsBy, plan, visits, events, ivmsDays] = await Promise.all([
    findInParts(ids, (part) => db.planLoad.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, distanceKm: true, returnLegKm: true, cases: true, carriedFromLoadId: true, truckSnapshotJson: true } })),
    stopsOfLoads(db, loads),
    findInParts(ids, (part) => db.routeAssignment.findMany({ where: { loadId: { in: part } }, select: { loadId: true, sequenceInTruck: true, orderInStop: true, departureMin: true, plannedDistanceFromPrevKm: true } })),
    db.stopVisit.findMany({
      where: { tenantId, deliveryDate: dateOnly(date) },
      select: {
        id: true, depotId: true, truckId: true, loadNo: true, sequence: true, arrivedAt: true, arrivalSource: true, arrivalDistanceM: true, arrivalAccuracyM: true, arrivalObserved: true,
        departedAt: true, departureSource: true, departedAtOutcome: true, outcome: true, reason: true, outcomeAt: true, outcomeSource: true, casesDelivered: true, plannedLat: true, plannedLng: true,
      },
    }),
    db.stopEvent.findMany({
      where: { tenantId, deliveryDate: dateOnly(date), kind: { in: ['ARRIVED', 'DEPARTED', 'OUTCOME', 'PHOTO', 'BACK_AT_DEPOT', 'DEPOT_DEPART'] } },
      select: { depotId: true, truckId: true, loadNo: true, sequence: true, kind: true, source: true, at: true, receivedAt: true, distanceM: true, payloadJson: true },
    }),
    db.ivmsTruckDay.findMany({ where: { tenantId, deliveryDate: dateOnly(date) }, select: { truckId: true, suppressedAt: true, trailFrom: true, lastPullAt: true } }),
  ]);
  const extraOf = new Map(extra.map((x) => [x.id, x]));
  const customerIds = [...new Set([...stopsBy.values()].flat().map((s) => s.customerId))];
  const truckIds = [...new Set(loads.map((l) => l.truckId))];
  const [customers, profiles, cfg, trucks, depots, dispatched] = await Promise.all([
    findInParts(customerIds, (part) => db.customer.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, customerType: true, avgServiceTimeMin: true, serviceTimeConfirmed: true } })),
    db.customerTypeProfile.findMany({ where: { tenantId }, select: { customerType: true, serviceTimeMin: true } }),
    db.tenantConfig.findFirst({ where: { tenantId }, select: { defaultServiceTimeMin: true } }),
    // Whether the truck has a tracker: the IMEI is read only to say yes or no, never kept.
    db.truck.findMany({ where: { tenantId, id: { in: truckIds } }, select: { id: true, ivmsImei: true } }),
    db.depot.findMany({ where: { tenantId, id: { in: [...new Set(loads.map((l) => l.depotId))] } }, select: { id: true, lat: true, lng: true } }),
    dispatchedAt(db, tenantId, loads.map((l) => ({ id: l.id, carriedFromLoadId: extraOf.get(l.id)?.carriedFromLoadId ?? null }))),
  ]);
  const custOf = new Map(customers.map((c) => [c.id, c]));
  const profileOf = new Map(profiles.map((p) => [p.customerType, p]));
  const defaultServiceMin = cfg?.defaultServiceTimeMin ?? 10;
  const firstRow = new Map<string, (typeof plan)[number]>();
  for (const r of plan) {
    const k = `${r.loadId}|${r.sequenceInTruck}`;
    const cur = firstRow.get(k);
    if (!cur || r.orderInStop < cur.orderInStop) firstRow.set(k, r);
  }
  const depotOf = new Map(depots.map((d) => [d.id, d]));
  const byTruck = new Map<string, RoadLoad[]>();
  for (const l of loads) byTruck.set(l.truckId, [...(byTruck.get(l.truckId) ?? []), l]);
  for (const [truckId, own] of byTruck) {
    const loadsIn: LoadIn[] = own.map((l) => {
      const x = extraOf.get(l.id);
      const origin = readLoadOrigin(readTruckSnapshot(x?.truckSnapshotJson ?? null));
      const depot = depotOf.get(l.depotId);
      return {
        depotId: l.depotId,
        loadNo: l.loadNo,
        status: l.status,
        departMin: l.departMin,
        returnMin: l.returnMin,
        distanceKm: x?.distanceKm ?? null,
        returnLegKm: x?.returnLegKm ?? null,
        cases: x?.cases ?? 0,
        dispatchedAt: dispatched.get(l.id) ?? (l.status === 'DISPATCHED' ? l.statusChangedAt : null),
        origin: origin ? { lat: origin.lat, lng: origin.lng } : depot ? { lat: depot.lat, lng: depot.lng } : null,
        stops: (stopsBy.get(l.id) ?? []).map((s) => {
          const r = firstRow.get(`${l.id}|${s.sequence}`);
          const cu = custOf.get(s.customerId);
          return {
            sequence: s.sequence,
            customerId: s.customerId,
            customerCode: s.customerCode,
            customerType: cu?.customerType ?? null,
            baseServiceMin: baseServiceOf(cu, profileOf, defaultServiceMin),
            etaMin: s.etaMin,
            departureMin: r?.departureMin ?? null,
            plannedServiceMin: s.plannedServiceMin,
            windowStartMin: s.windowStartMin,
            windowEndMin: s.windowEndMin,
            plannedKmFromPrev: r?.plannedDistanceFromPrevKm ?? null,
            casesPlanned: s.casesPlanned,
            pin: s.pin,
          };
        }),
      };
    });
    const day = ivmsDays.find((d) => d.truckId === truckId);
    const loadDepots = new Set(own.map((l) => l.depotId));
    // The depot pins: the depots' own and the origins the loads were planned from (a depot moved since).
    const pins = new Map<string, { depotId: string; lat: number; lng: number }>();
    for (const d of depots) if (loadDepots.has(d.id)) pins.set(`${d.id}|${d.lat}|${d.lng}`, { depotId: d.id, lat: d.lat, lng: d.lng });
    for (const l of own) {
      const o = readLoadOrigin(readTruckSnapshot(extraOf.get(l.id)?.truckSnapshotJson ?? null));
      if (o) pins.set(`${o.depotId}|${o.lat}|${o.lng}`, { depotId: o.depotId, lat: o.lat, lng: o.lng });
    }
    out.set(truckId, {
      date,
      truckId,
      truckCode: own[0]!.truckCode,
      tracked: !!trucks.find((t) => t.id === truckId)?.ivmsImei,
      suppressed: !!day?.suppressedAt,
      trailFrom: day?.trailFrom ?? null,
      lastPullAt: day?.lastPullAt ?? null,
      depots: [...pins.values()],
      loads: loadsIn,
      visits: visits.filter((v) => v.truckId === truckId).map((v): VisitIn => ({ ...v, arrivalSource: v.arrivalSource, departureSource: v.departureSource, outcomeSource: v.outcomeSource, outcome: v.outcome, reason: v.reason })),
      events: events
        .filter((e) => e.truckId === truckId)
        .map((e): EventIn => ({
          depotId: e.depotId,
          loadNo: e.loadNo,
          sequence: e.sequence,
          kind: e.kind,
          source: e.source,
          at: e.at,
          receivedAt: e.receivedAt,
          distanceM: e.distanceM,
          payload: e.payloadJson && typeof e.payloadJson === 'object' && !Array.isArray(e.payloadJson) ? (e.payloadJson as Record<string, unknown>) : null,
        })),
    });
  }
  return out;
}
