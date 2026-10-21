/**
 * GPS stop times of the IVMS live link (16 Oct 2026, design section 6.2 with the binding review's
 * H1/H3/H4/M2/M10/M11): runs the stop detector (stops.ts) over a truck-day's stored trail and writes
 * what it proposes as StopEvents of source AYUN. Server only. Only in ivmsMode TIMES, never while
 * ROUTEIQ_DISABLE_IVMS=1, never for a truck-day whose GPS is suppressed (undo, mismatch, remap).
 *
 * What it never does:
 * - write a result (OUTCOME), a Back at depot, or a photo; complete a load (the driver's or the office's
 *   Back at depot does that: event-service.ts COMPLETING_BACK_SOURCES), or press Dispatch;
 * - override the driver or the office: their events are kept, and the visit rebuild (visit.ts) lets
 *   them win; GPS only fills the gaps (a stop with an office arrival gets nothing at all);
 * - go through the driver path (applyAction, writeRule): no driver link, no link expiry, no audit row
 *   (automatic stop events are never audited, as the phone's).
 *
 * How it writes, per visit, in ONE short transaction, in the driver path's lock order: the lock
 * timeout, the outcome-day lock (lib/delivery/locks.ts), the load read again under it (DISPATCHED or
 * COMPLETED only), the planned stop, the visit (created with its planned facts if new), the events, the
 * visit rebuilt (event-service.ts rebuildVisit). A busy lock skips the truck until the next run.
 *
 * Idempotent (M2): an event's key is `ayun:<A|D>:<depot>:<date>:<truck>:<load>:<seq>:<ms>` with the stay's
 * first inside fix time (never a cycle index), so a rerun is a no-op; a stay whose start moved (a delayed
 * point arrived later) is recognised by an AYUN event of the same kind within 10 min of it and never
 * written twice - unless the detector still sees that event's own stay as well (two stays at one stop:
 * leaving to park and coming back within 10 min keeps both, second review L-1). Within its stay the
 * first write wins, with one exception: an event that was NOT observed (a gap in the points before it, so
 * its time is only an upper bound) is corrected in place when a later pull brings the missing points (the
 * poller's final pull of the day re-reads the whole day, buffered points included) and the same stay is
 * now observed, or still unobserved but earlier (correctGpsEvent). An observed GPS time is never moved
 * within its stay. At most 8 AYUN events per stop (4 until 21 Oct 2026, owner decision F3: up to 4 stays,
 * stops.ts MAX_STAYS_PER_STOP), and none once the stop holds 32 of the 40 events shared with the driver and
 * the office (event-service.ts MAX_EVENTS_PER_VISIT): the driver always keeps room.
 *
 * Big sites (owner request 19 Oct 2026, "at big customers the truck moves between drop points and the
 * model thinks it left"; the GPS study of 18-19 Oct 2026): the detector merges the stays of one site and
 * says whether each departure is final (stops.ts: the truck has been away HOLD_DEPARTED_MIN, is beyond
 * SITE_MAX_M of the pin, or reached the depot). A departure that is not final yet is HELD back here (kept
 * as HELD, written by a later run): an observed GPS time is never moved once written (correctGpsEvent
 * moves only an unobserved one, and only earlier), so a departure written at a move between drop points
 * would stay wrong once the stays merge. A real departure is still written within about 10 minutes, also
 * when the tracker goes quiet near the customer (review of 19 Oct 2026: the pulled history then says the trail
 * is complete 10 min past the exit, trailCompleteOf; after the truck-day's final pull every departure is). Each
 * event's payload carries its stay's summary (`stay`: lib/ivms/types.ts StaySummary, distances and minutes
 * only), and each stop's customer's site radius (Customer.siteRadiusM) reaches the detector. The short
 * stays the detector rejected (SHORT_DWELL) are kept in the facts with the other rejected candidates,
 * after them (the first cut when the facts are too long).
 *
 * Re-derived when the trip changes hands (second review H-1): an AYUN event whose stay lies in a trip the
 * detector now gives to ANOTHER load (a later Dispatch press, a trip that appeared later) is deleted and
 * its visit rebuilt; the new load's stays are then written as usual. Nothing is deleted on a mere absence
 * of evidence (a trail point purged, a trip without a load). A tracker found on another truck (MISMATCH),
 * a tracker changed after the day's trail was pulled (REMAP, lib/ivms/tracker-admin.ts) and the admin's
 * undo (POST /api/ivms/trucks/[id]/gps-times) suppress the truck-day AND delete its AYUN events, with
 * the visits rebuilt (second review M-1, first review M-3); an AYUN event still on a suppressed truck-day
 * (a removal that failed, a run that had started before the suppression) is removed by the next run. No
 * trail point from before the tracker was mapped to the truck (IvmsTruckDay.trailFrom) is ever read.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { dispatchedAt } from '../dispatch/dispatched-at';
import { isLockBusy, setLockTimeout } from '../dispatch/plan-locks';
import { readLoadOrigin, readTruckSnapshot } from '../dispatch/snapshots';
import { addDaysIso, dateOnly, DEFAULT_TZ, isoOf, todayIso, zonedDayStart } from '../dispatch/time';
import { stopsOfLoads } from '../delivery/day-results';
import { COMPLETING_BACK_SOURCES, ensureVisit, MAX_EVENTS_PER_VISIT, rebuildVisit, type VisitKey } from '../delivery/event-service';
import { lockOutcomesDay } from '../delivery/locks';
import { plannedStopOf } from '../delivery/planned-stop';
import { truckDayLoads, type TruckDayLoad } from '../driver-link/service';
import { nextOpsStartOf } from './budget';
import { readIvmsEnv } from './env';
import { ROUTE_OVERLAP_MS } from './poll';
import { IVMS_SETTING_DEFAULTS, ivmsModeAtLeast, ivmsModeOf } from './settings';
import { detectTruckDay, detectorParams, trackerMismatch, type DetectorLoad, type DetectorOutput, type ZoneMove } from './stops';
import { DETECTOR_FIXED, DETECTOR_VERSION, type StopAmbiguity, type StopCandidate } from './types';

type Tx = Prisma.TransactionClient;

/**
 * The detector's marker on every event it writes (payloadJson.detector): lib/ivms/types.ts, shared with the analysis facts.
 * ivms-v2 (owner request 19 Oct 2026): frozen runs as gaps, the customer's site radius, merged stays, held departures
 * and the stay summary in the payload; ivms-v1 events (16-19 Oct 2026) have no summary. ivms-v3 (owner decision
 * 21 Oct 2026): up to 4 stays per stop and 8 events per visit, the payload unchanged.
 */
export { DETECTOR_VERSION };
/** At most this many AYUN arrivals and departures per stop (4 until 21 Oct 2026: owner decision F3, 4 stays per stop). */
export const MAX_AYUN_EVENTS_PER_VISIT = 8;
/** No GPS event once the stop holds this many arrivals, departures and results (of the shared 40). */
export const AYUN_ROOM_LIMIT = MAX_EVENTS_PER_VISIT - MAX_AYUN_EVENTS_PER_VISIT;
/** An AYUN event of the same kind this close (minutes) to a stay's start is that stay's (first write wins). */
export const SAME_STAY_MIN = 10;
/** The trail read for a truck-day: from 3 h before its local midnight to 3 h after the next. */
const WINDOW_BEFORE_H = 3;
const WINDOW_AFTER_H = 27;
/** The lock timeout of a GPS write (shorter than the driver's: GPS can wait for the next run). */
const GPS_LOCK_TIMEOUT_MS = 3_000;

export type GpsSkip = 'DISABLED' | 'MODE' | 'SUPPRESSED' | 'NO_LOAD' | 'NO_TRAIL' | 'MISMATCH';

export interface GpsTimesResult {
  truckId: string;
  date: string;
  skipped: GpsSkip | null;
  /** StopEvents written. */
  written: number;
  /** Unobserved GPS events of a stay corrected in place by a better trail (correctGpsEvent). */
  corrected: number;
  /** GPS events deleted because their trip is now another load's (second review H-1). */
  removed: number;
  /**
   * Candidates not written, by why: DUPLICATE (key or same stay), CAP, ROOM, NOT_ON_ROAD, NO_STOP, OFFICE,
   * HELD (a departure that is not final yet: owner request 19 Oct 2026, written by a later run).
   */
  kept: Record<string, number>;
  /** The truck was busy (lock timeout): the rest waits for the next run. */
  busy: boolean;
  trailMoves: number;
  facts: GpsFact[];
}

/**
 * A fact for the office (IvmsTruckDay.gpsFactsJson): what GPS saw but did not write by itself. SHORT_DWELL
 * (owner request 19 Oct 2026): a stay at a pending stop's pin shorter than the dwell, kept for later
 * analysis and not shown on the screens (lib/ivms/live-map.ts gpsFactText leaves it out).
 */
export type GpsFact =
  | { kind: 'SEVERAL_PINS' | 'NEAR_DEPOT' | 'OUT_OF_SEQUENCE_SHORT' | 'SHORT_DWELL'; loadNo: number; sequences: number[]; from: string; to: string | null }
  | { kind: 'NO_DEPOT_BOUNDARY' };

/** At most this many facts, this many stop numbers per fact, and this many bytes of JSON (the column's CHECK is 8 KB). */
export const MAX_GPS_FACTS = 40;
export const MAX_FACT_SEQUENCES = 12;
export const MAX_FACTS_BYTES = 7000;

/**
 * The facts to store from a detector run: at most 40, at most 12 stop numbers each, and never more than
 * 7,000 bytes of JSON, so the column's 8 KB CHECK can never refuse the truck-day (which would leave it
 * unprocessed and retried every 5 minutes: first review LOW). The short stays (SHORT_DWELL) come last, so
 * they are the first cut and never push out a fact the office reads.
 */
export function gpsFactsOf(out: Pick<DetectorOutput, 'ambiguities' | 'notes'>): GpsFact[] {
  const ordered = [...out.ambiguities.filter((a) => a.reason !== 'SHORT_DWELL'), ...out.ambiguities.filter((a) => a.reason === 'SHORT_DWELL')];
  const facts: GpsFact[] = ordered.map((a: StopAmbiguity) => ({ kind: a.reason, loadNo: a.loadNo, sequences: a.sequences.slice(0, MAX_FACT_SEQUENCES), from: a.from.toISOString(), to: a.to ? a.to.toISOString() : null }));
  if (out.notes.includes('NO_DEPOT_BOUNDARY')) facts.unshift({ kind: 'NO_DEPOT_BOUNDARY' });
  const kept = facts.slice(0, MAX_GPS_FACTS);
  while (kept.length && Buffer.byteLength(JSON.stringify(kept), 'utf8') > MAX_FACTS_BYTES) kept.pop();
  return kept;
}

/** The StopEvent key of a GPS candidate (natural: the stop and the stay's first inside fix time). */
export function gpsEventKey(c: Pick<StopCandidate, 'kind' | 'loadNo' | 'sequence' | 'segmentStartAt'>, depotId: string, date: string, truckId: string): string {
  return `ayun:${c.kind === 'ARRIVED' ? 'A' : 'D'}:${depotId}:${date}:${truckId}:${c.loadNo}:${c.sequence}:${c.segmentStartAt.getTime()}`;
}

/** The IvmsEvent key of a depot move derived from the trail (origin TRAIL). */
export function trailMoveKey(truckId: string, kind: 'DEPOT_IN' | 'DEPOT_OUT', at: Date): string {
  return `ayun:t:${truckId}:${kind === 'DEPOT_IN' ? 'I' : 'O'}:${at.getTime()}`;
}

/** An event's time, clamped as the driver path does: never before the day minus 2 h, never in the future. */
export function clampEventAt(at: Date, dayStart: Date, now: Date): Date {
  const min = dayStart.getTime() - 2 * 3600_000;
  const max = now.getTime() + 60_000;
  return new Date(Math.min(max, Math.max(min, at.getTime())));
}

/**
 * Should a candidate replace the AYUN event already written for the same stay? Only an event whose time
 * is an upper bound (not observed): by an observed time, or by an earlier unobserved one (the points
 * that arrived late narrowed the gap). An observed event is never moved (first write wins).
 */
export function correctGpsEvent(old: { at: Date; payloadJson: unknown }, c: Pick<StopCandidate, 'at' | 'observed'>): boolean {
  const oldObserved = (old.payloadJson as { observed?: unknown } | null)?.observed !== false;
  if (oldObserved) return false;
  return c.observed || c.at.getTime() < old.at.getTime() - 60_000;
}

const isUniqueViolation = (e: unknown) => (e instanceof Prisma.PrismaClientKnownRequestError ? e.code === 'P2002' : (e as { code?: unknown } | null)?.code === 'P2002');

interface CompanyGps {
  tz: string;
  radiusM: number;
  params: ReturnType<typeof detectorParams>;
  /** The operating hours' start (local minutes): a truck-day's trail ends at the next day's start, as its pulls. */
  fromMin: number;
  toMin: number;
}

/** The company's GPS settings, or why GPS times are off for it. */
async function companyGps(tenantId: string): Promise<CompanyGps | GpsSkip> {
  if (readIvmsEnv().disabled) return 'DISABLED';
  const cfg = await prisma.tenantConfig.findFirst({
    where: { tenantId },
    select: { timezone: true, geofenceRadiusM: true, ivmsMode: true, ivmsStopRadiusM: true, ivmsStopDwellMin: true, ivmsDepotRadiusM: true, ivmsFromMin: true, ivmsToMin: true },
  });
  if (!cfg || !ivmsModeAtLeast(ivmsModeOf(cfg), 'TIMES')) return 'MODE';
  return {
    tz: cfg.timezone || DEFAULT_TZ,
    // The visit rebuild's radius, as the driver path's dayFacts clamps it.
    radiusM: Math.min(500, Math.max(50, cfg.geofenceRadiusM ?? 100)),
    params: detectorParams(cfg, DETECTOR_FIXED),
    fromMin: cfg.ivmsFromMin ?? IVMS_SETTING_DEFAULTS.ivmsFromMin,
    toMin: cfg.ivmsToMin ?? IVMS_SETTING_DEFAULTS.ivmsToMin,
  };
}

/**
 * Run the detector over one truck-day's stored trail and write what it finds (TIMES only). Safe to run
 * any number of times; returns what was written and kept. Never throws for a busy plan.
 */
export async function processGpsTimes(tenantId: string, truckId: string, date: string, now: Date = new Date()): Promise<GpsTimesResult> {
  const res: GpsTimesResult = { truckId, date, skipped: null, written: 0, corrected: 0, removed: 0, kept: {}, busy: false, trailMoves: 0, facts: [] };
  const company = await companyGps(tenantId);
  if (typeof company === 'string') return { ...res, skipped: company };
  const day = await prisma.ivmsTruckDay.findFirst({ where: { tenantId, truckId, deliveryDate: dateOnly(date) }, select: { id: true, suppressedAt: true, trailFrom: true, pulledTo: true, finalPullAt: true } });
  if (day?.suppressedAt) return { ...res, skipped: 'SUPPRESSED' };
  const loads = (await truckDayLoads(prisma, tenantId, truckId, date)).filter((l) => l.status === 'DISPATCHED' || l.status === 'COMPLETED');
  if (!loads.length) return { ...res, skipped: 'NO_LOAD' };
  const dayStart = zonedDayStart(date, company.tz);
  const from = new Date(dayStart.getTime() - WINDOW_BEFORE_H * 3600_000);
  // To the next day's operating hours, where the truck-day's pulls end too (second review L-8: a late trip
  // that ends between 03:00 and 05:00 keeps its depot IN).
  const to = new Date(Math.max(dayStart.getTime() + WINDOW_AFTER_H * 3600_000, nextOpsStartOf(date, { timezone: company.tz, fromMin: company.fromMin, toMin: company.toMin }).getTime()));
  // Never a point from before the tracker was mapped to this truck (second review M-1).
  const since = day?.trailFrom && day.trailFrom > from ? day.trailFrom : from;
  const points = await prisma.truckTrailPoint.findMany({ where: { tenantId, truckId, fixAt: { gte: since, lte: to } }, orderBy: { fixAt: 'asc' }, select: { fixAt: true, lat: true, lng: true, speedKmh: true, ignition: true } });
  if (!points.length) return { ...res, skipped: 'NO_TRAIL' };
  // The tracker is not on this truck (swapped or moved, review M8): the driver's own positions and the
  // trail disagree. Nothing is written for the truck-day, now or later (suppressed MISMATCH).
  const phone = await prisma.stopEvent.findMany({
    where: { tenantId, truckId, deliveryDate: dateOnly(date), source: { in: ['PHONE_AUTO', 'PHONE_MANUAL'] }, lat: { not: null }, lng: { not: null } },
    select: { at: true, lat: true, lng: true },
  });
  if (trackerMismatch(phone.map((e) => ({ at: e.at, lat: e.lat!, lng: e.lng! })), points)) {
    // The times GPS already wrote for the truck-day are another truck's too: deleted, the visits rebuilt (M-1).
    const undone = await suppressGpsTimes(tenantId, truckId, date, 'MISMATCH', { dryRun: false, now });
    await prisma.ivmsTruckDay.update({ where: { tenantId_truckId_deliveryDate: { tenantId, truckId, deliveryDate: dateOnly(date) } }, data: { processedAt: now } });
    return { ...res, skipped: 'MISMATCH', removed: undone.events };
  }

  const input = await detectorInput(tenantId, truckId, date, dayStart, loads, company, from, to);
  const out = detectTruckDay({ ...input.detector, points, now, trailComplete: trailCompleteOf(day) });
  res.facts = gpsFactsOf(out);

  // Depot moves: the trail's (not confirmed by a provider zone move), and what the trail says of the zone moves.
  res.trailMoves = await writeTrailMoves(tenantId, truckId, out, now);
  for (const outcome of ['USED', 'UNCONFIRMED'] as const) {
    const ids = out.zoneOutcomes.filter((z) => z.outcome === outcome).map((z) => z.id);
    if (ids.length) await prisma.ivmsEvent.updateMany({ where: { tenantId, id: { in: ids }, OR: [{ outcome: null }, { outcome: { not: outcome } }] }, data: { outcome, processedAt: now } });
  }
  // A trail move stored before the provider's zone move of it arrived (a late webhook): the zone move is
  // the move from now on, the trail's is kept as a DUPLICATE (review M12).
  for (const z of out.zoneOutcomes.filter((x) => x.outcome === 'USED')) {
    const zm = input.detector.zoneMoves.find((m) => m.id === z.id);
    if (!zm) continue;
    await prisma.ivmsEvent.updateMany({
      where: { tenantId, truckId, origin: 'TRAIL', kind: zm.kind, outcome: 'USED', eventAt: { gte: new Date(zm.at.getTime() - 10 * 60_000), lte: new Date(zm.at.getTime() + 10 * 60_000) } },
      data: { outcome: 'DUPLICATE', processedAt: now },
    });
  }

  // GPS events whose trip is now another load's (a later press, a trip that appeared later): deleted first,
  // their visits rebuilt, so the stays below are written for the right load (second review H-1).
  try {
    res.removed = await removeStaleGpsEvents(tenantId, truckId, date, out);
  } catch (e) {
    if (!isLockBusy(e)) throw e;
    res.busy = true;
  }

  // The stop events, one transaction per visit.
  const byStop = new Map<string, DetectorOutput['candidates']>();
  for (const c of out.candidates) {
    const k = `${c.depotId}|${c.loadNo}|${c.sequence}`;
    byStop.set(k, [...(byStop.get(k) ?? []), c]);
  }
  for (const list of res.busy ? [] : byStop.values()) {
    const load = input.loadOf(list[0]!.depotId, list[0]!.loadNo);
    if (!load) {
      bump(res.kept, 'NOT_ON_ROAD', list.length);
      continue;
    }
    try {
      const r = await writeStopCandidates(tenantId, truckId, date, dayStart, now, company.radiusM, load, list);
      res.written += r.written;
      res.corrected += r.corrected;
      for (const [k, n] of Object.entries(r.kept)) bump(res.kept, k, n);
    } catch (e) {
      if (isLockBusy(e)) {
        res.busy = true;
        break;
      }
      if (isUniqueViolation(e)) {
        bump(res.kept, 'DUPLICATE', list.length);
        continue;
      }
      throw e;
    }
  }

  // A busy truck (lock timeout) is not marked processed: the poller's next pass (lib/ivms/poll.ts
  // PROCESS_EVERY_MS) runs it again instead of waiting for the next history pull.
  const processedAt = res.busy ? undefined : now;
  await prisma.ivmsTruckDay.upsert({
    where: { tenantId_truckId_deliveryDate: { tenantId, truckId, deliveryDate: dateOnly(date) } },
    create: { tenantId, truckId, deliveryDate: dateOnly(date), processedAt: processedAt ?? null, gpsFactsJson: res.facts as unknown as Prisma.InputJsonValue },
    update: { ...(processedAt ? { processedAt } : {}), gpsFactsJson: res.facts as unknown as Prisma.InputJsonValue },
  });
  return res;
}

function bump(m: Record<string, number>, k: string, n = 1) {
  m[k] = (m[k] ?? 0) + n;
}

/**
 * How far a truck-day's trail is complete, for the detector's held departures (review of 19 Oct 2026: a
 * departure held while the truck stood within 500 m of the pin was never written when the tracker then went
 * quiet - ignition is never sent - or the trail window ended). The history pulled up to `pulledTo` (provider
 * time), less the overlap the next pull reads again (lib/ivms/poll.ts ROUTE_OVERLAP_MS: points the provider
 * received late), holds every point it will ever hold; after the truck-day's final pull (finalPullAt, cleared
 * again by a later regular pull) no point comes at all. Never pulled: null (only later points finalize).
 */
export function trailCompleteOf(day: { pulledTo?: Date | null; finalPullAt?: Date | null } | null | undefined): { to: Date; final: boolean } | null {
  if (!day?.pulledTo) return null;
  return { to: new Date(day.pulledTo.getTime() - ROUTE_OVERLAP_MS), final: !!day.finalPullAt };
}

/** What the detector needs about the truck-day: its loads in dispatch order with their stops, the depots, the zone moves. */
async function detectorInput(tenantId: string, truckId: string, date: string, dayStart: Date, loads: TruckDayLoad[], company: CompanyGps, from: Date, to: Date) {
  const rows = await prisma.planLoad.findMany({ where: { tenantId, id: { in: loads.map((l) => l.id) } }, select: { id: true, carriedFromLoadId: true, breakJson: true, truckSnapshotJson: true } });
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const [dispatched, stops, visits, depots, zone, backs] = await Promise.all([
    dispatchedAt(prisma, tenantId, loads.map((l) => ({ id: l.id, carriedFromLoadId: rowOf.get(l.id)?.carriedFromLoadId ?? null }))),
    stopsOfLoads(prisma, loads.map((l) => ({ id: l.id, breakJson: rowOf.get(l.id)?.breakJson ?? null }))),
    prisma.stopVisit.findMany({ where: { tenantId, truckId, deliveryDate: dateOnly(date) }, select: { depotId: true, loadNo: true, sequence: true, outcomeAt: true, outcome: true, arrivalSource: true, plannedLat: true, plannedLng: true } }),
    prisma.depot.findMany({ where: { tenantId, id: { in: [...new Set(loads.map((l) => l.depotId))] } }, select: { id: true, lat: true, lng: true } }),
    prisma.ivmsEvent.findMany({
      where: { tenantId, truckId, kind: { in: ['DEPOT_IN', 'DEPOT_OUT'] }, origin: { in: ['WEBHOOK', 'BACKSTOP'] }, eventAt: { gte: from, lte: to } },
      select: { id: true, kind: true, eventAt: true, depotId: true },
    }),
    // The driver's and the office's Back at depot (never a GPS one): a trip after it is never that load's.
    prisma.stopEvent.findMany({
      where: { tenantId, truckId, deliveryDate: dateOnly(date), kind: 'BACK_AT_DEPOT', source: { in: [...COMPLETING_BACK_SOURCES] } },
      select: { depotId: true, loadNo: true, at: true },
    }),
  ]);
  // The customers' site radius (owner request 19 Oct 2026, Customer.siteRadiusM): read live, as the pins are.
  const customerIds = [...new Set([...stops.values()].flat().map((s) => s.customerId))];
  const sites = customerIds.length ? await prisma.customer.findMany({ where: { tenantId, id: { in: customerIds } }, select: { id: true, siteRadiusM: true } }) : [];
  const siteOf = new Map(sites.map((c) => [c.id, c.siteRadiusM ?? null]));
  const backAtOf = (depotId: string, loadNo: number): Date | null => {
    const mine = backs.filter((b) => b.depotId === depotId && b.loadNo === loadNo).map((b) => b.at.getTime());
    return mine.length ? new Date(Math.max(...mine)) : null;
  };
  // The depot pins: the depots' own, and the origin each load was planned from (a depot moved since).
  const pins = new Map<string, { depotId: string; lat: number; lng: number }>();
  for (const d of depots) if (Number.isFinite(d.lat) && Number.isFinite(d.lng)) pins.set(`${d.id}|${d.lat}|${d.lng}`, { depotId: d.id, lat: d.lat, lng: d.lng });
  for (const l of loads) {
    const o = readLoadOrigin(readTruckSnapshot(rowOf.get(l.id)?.truckSnapshotJson));
    if (o) pins.set(`${o.depotId}|${o.lat}|${o.lng}`, { depotId: o.depotId, lat: o.lat, lng: o.lng });
  }
  const detectorLoads: DetectorLoad[] = loads.map((l) => ({
    depotId: l.depotId,
    loadNo: l.loadNo,
    status: l.status,
    // The Dispatch press (audit row); a DISPATCHED load's status time is the press too; never a COMPLETED load's (H3).
    dispatchedAt: dispatched.get(l.id) ?? (l.status === 'DISPATCHED' ? l.statusChangedAt : null),
    plannedDepartAt: new Date(dayStart.getTime() + l.departMin * 60_000),
    backAt: backAtOf(l.depotId, l.loadNo),
    stops: (stops.get(l.id) ?? []).map((s) => {
      const v = visits.find((x) => x.depotId === l.depotId && x.loadNo === l.loadNo && x.sequence === s.sequence);
      const pin = v && v.plannedLat !== null && v.plannedLng !== null ? { lat: v.plannedLat, lng: v.plannedLng } : s.pin;
      return { sequence: s.sequence, pin, resultAt: v?.outcome ? v.outcomeAt : null, officeArrival: v?.arrivalSource === 'DISPATCHER', siteRadiusM: siteOf.get(s.customerId) ?? null };
    }),
  }));
  const zoneMoves: ZoneMove[] = zone.filter((z): z is typeof z & { kind: 'DEPOT_IN' | 'DEPOT_OUT' } => z.kind === 'DEPOT_IN' || z.kind === 'DEPOT_OUT').map((z) => ({ id: z.id, kind: z.kind, at: z.eventAt, depotId: z.depotId }));
  // By depot and number: a truck can have a Load 1 at two depots on one date.
  const loadOf = (depotId: string, loadNo: number) => loads.find((l) => l.depotId === depotId && l.loadNo === loadNo) ?? null;
  return { detector: { depots: [...pins.values()], zoneMoves, loads: detectorLoads, params: company.params }, loadOf };
}

/**
 * The truck-day's AYUN events whose stay lies in a trip the detector now gives to another load: deleted,
 * the visits rebuilt (second review H-1). Only on positive evidence: an event in no trip, or in a trip
 * without a load, is kept. Returns how many were deleted.
 */
async function removeStaleGpsEvents(tenantId: string, truckId: string, date: string, out: DetectorOutput): Promise<number> {
  const owned = out.trips.filter((t) => t.loadNo !== null);
  if (!owned.length) return 0;
  const events = await prisma.stopEvent.findMany({
    where: { tenantId, truckId, deliveryDate: dateOnly(date), source: 'AYUN', kind: { in: ['ARRIVED', 'DEPARTED'] } },
    select: { id: true, visitId: true, depotId: true, loadNo: true, at: true, payloadJson: true },
  });
  const stale = events.filter((e) => {
    const start = stayStartOf(e);
    const trip = owned.find((t) => start >= t.outAt.getTime() && (t.inAt === null || start <= t.inAt.getTime()));
    return !!trip && (trip.loadNo !== e.loadNo || (trip.loadDepotId !== null && trip.loadDepotId !== e.depotId));
  });
  return removeGpsEvents(tenantId, date, stale, GPS_LOCK_TIMEOUT_MS);
}

/**
 * Delete AYUN stop events and rebuild the visits they were on, one short transaction per depot in the
 * driver path's lock order (the lock timeout, the outcome-day lock). `all`: every AYUN event of the
 * truck-day at that depot (an undo: also one written meanwhile), else exactly these ids.
 */
async function removeGpsEvents(
  tenantId: string,
  date: string,
  events: readonly { id: string; visitId: string | null; depotId: string }[],
  lockTimeoutMs?: number,
  all?: { truckId: string },
): Promise<number> {
  if (!events.length) return 0;
  const cfg = await prisma.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true, geofenceRadiusM: true } });
  const tz = cfg?.timezone || DEFAULT_TZ;
  const radiusM = Math.min(500, Math.max(50, cfg?.geofenceRadiusM ?? 100));
  let n = 0;
  for (const depotId of [...new Set(events.map((e) => e.depotId))]) {
    const mine = events.filter((e) => e.depotId === depotId);
    const visitIds = [...new Set(mine.map((e) => e.visitId).filter((x): x is string => !!x))];
    n += await prisma.$transaction(async (tx: Tx) => {
      await setLockTimeout(tx, lockTimeoutMs);
      await lockOutcomesDay(tx, tenantId, depotId, date);
      const where = all
        ? { tenantId, truckId: all.truckId, depotId, deliveryDate: dateOnly(date), source: 'AYUN' as const }
        : { tenantId, depotId, source: 'AYUN' as const, id: { in: mine.map((e) => e.id) } };
      const deleted = (await tx.stopEvent.deleteMany({ where })).count;
      for (const id of visitIds) {
        const v = await tx.stopVisit.findFirst({ where: { id, tenantId, depotId } });
        if (!v) continue;
        const load = v.firstLoadId ? await tx.planLoad.findFirst({ where: { id: v.firstLoadId, tenantId }, select: { breakJson: true } }) : null;
        const b = load?.breakJson as { v?: unknown; startMin?: unknown; endMin?: unknown } | null | undefined;
        const breakMin = b && b.v === 1 && typeof b.startMin === 'number' && typeof b.endMin === 'number' ? { startMin: b.startMin, endMin: b.endMin } : null;
        await rebuildVisit(tx, v, { dayStart: zonedDayStart(isoOf(v.deliveryDate), tz), radiusM, breakMin });
      }
      return deleted;
    });
  }
  return n;
}

/** The AYUN arrivals and departures still on a suppressed truck-day, deleted (the visits rebuilt); the number deleted. */
async function clearSuppressedDay(tenantId: string, truckId: string, date: string): Promise<number> {
  const left = await prisma.stopEvent.findMany({ where: { tenantId, truckId, deliveryDate: dateOnly(date), source: 'AYUN' }, select: { id: true, visitId: true, depotId: true } });
  return removeGpsEvents(tenantId, date, left, GPS_LOCK_TIMEOUT_MS, { truckId });
}

/**
 * Depot moves from the trail, stored once (origin TRAIL): never when any move of the same kind is within
 * 10 min. Each with whether its time is exact (IvmsEvent.observed, the detector's flag: GPS alerts, review
 * of 18 Oct 2026, finding 6): the alerts and the replay export read it from the row, so it stays what it
 * was when the trail points are deleted after ivmsTrailDays. First write wins, as for the move's time.
 */
async function writeTrailMoves(tenantId: string, truckId: string, out: DetectorOutput, now: Date): Promise<number> {
  let n = 0;
  for (const m of out.trailMoves) {
    const near = await prisma.ivmsEvent.findFirst({
      where: { tenantId, truckId, kind: m.kind, eventAt: { gte: new Date(m.at.getTime() - 10 * 60_000), lte: new Date(m.at.getTime() + 10 * 60_000) } },
      select: { id: true },
    });
    if (near) continue;
    try {
      await prisma.ivmsEvent.create({
        data: { tenantId, truckId, depotId: m.depotId, kind: m.kind, origin: 'TRAIL', eventAt: m.at, receivedAt: now, lat: m.lat, lng: m.lng, dedupeKey: trailMoveKey(truckId, m.kind, m.at), processedAt: now, outcome: 'USED', observed: m.observed },
      });
      n++;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return n;
}

/** One stop's candidates in one transaction (the driver path's lock order). */
async function writeStopCandidates(
  tenantId: string,
  truckId: string,
  date: string,
  dayStart: Date,
  now: Date,
  radiusM: number,
  dayLoad: TruckDayLoad,
  list: StopCandidate[],
): Promise<{ written: number; corrected: number; kept: Record<string, number> }> {
  const kept: Record<string, number> = {};
  const sequence = list[0]!.sequence;
  return prisma.$transaction(async (tx: Tx) => {
    await setLockTimeout(tx, GPS_LOCK_TIMEOUT_MS);
    await lockOutcomesDay(tx, tenantId, dayLoad.depotId, date);
    const load = await tx.planLoad.findFirst({ where: { id: dayLoad.id, tenantId }, select: { id: true, status: true, breakJson: true } });
    // GPS never presses Dispatch: only a load on the road (or closed the same day) gets times.
    if (!load || (load.status !== 'DISPATCHED' && load.status !== 'COMPLETED')) {
      bump(kept, 'NOT_ON_ROAD', list.length);
      return { written: 0, corrected: 0, kept };
    }
    const planned = await plannedStopOf(tx, load, sequence);
    if (!planned) {
      bump(kept, 'NO_STOP', list.length);
      return { written: 0, corrected: 0, kept };
    }
    const vk: VisitKey = { tenantId, depotId: dayLoad.depotId, date, truckId, loadNo: dayLoad.loadNo, sequence };
    const visit = await ensureVisit(tx, vk, planned, dayLoad.id);
    // The office set the arrival: GPS adds nothing to that stop.
    if (visit.arrivalSource === 'DISPATCHER') {
      bump(kept, 'OFFICE', list.length);
      return { written: 0, corrected: 0, kept };
    }
    const existing: { id: string; kind: string; source: string; at: Date; idempotencyKey: string | null; payloadJson: Prisma.JsonValue }[] = await tx.stopEvent.findMany({
      where: { tenantId, visitId: visit.id, kind: { in: ['ARRIVED', 'DEPARTED', 'OUTCOME'] } },
      select: { id: true, kind: true, source: true, at: true, idempotencyKey: true, payloadJson: true },
    });
    let ayun = existing.filter((e) => e.source === 'AYUN').length;
    let total = existing.length;
    let written = 0;
    let corrected = 0;
    // The stays the detector sees now at this stop: an event of one of them is never another stay's (L-1).
    const seen = new Set(list.map((c) => `${c.kind}|${c.segmentStartAt.getTime()}`));
    for (const c of [...list].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.kind === 'ARRIVED' ? -1 : 1))) {
      // Owner request 19 Oct 2026: a departure that is not final yet (the truck may be moving between drop
      // points of the site and come back) is held back; a later run writes it once it is final.
      if (c.kind === 'DEPARTED' && c.final === false) {
        bump(kept, 'HELD');
        continue;
      }
      const key = gpsEventKey(c, dayLoad.depotId, date, truckId);
      const payloadOf = (): Record<string, unknown> => ({
        observed: c.observed,
        ...(c.kind === 'DEPARTED' && !c.observed ? { gap: true } : {}),
        detector: DETECTOR_VERSION,
        segmentStartAt: c.segmentStartAt.toISOString(),
        // The stay's summary (distances and minutes only, never a position): kept after the trail is deleted.
        ...(c.stay ? { stay: c.stay } : {}),
      });
      const same = existing.find(
        (e) =>
          e.source === 'AYUN' &&
          e.kind === c.kind &&
          (e.idempotencyKey === key ||
            stayStartOf(e) === c.segmentStartAt.getTime() ||
            (Math.abs(stayStartOf(e) - c.segmentStartAt.getTime()) <= SAME_STAY_MIN * 60_000 && !seen.has(`${e.kind}|${stayStartOf(e)}`))),
      );
      if (same) {
        // The same stay: kept as written, unless its time was only an upper bound and the trail now knows better.
        if (correctGpsEvent(same, c)) {
          const at = clampEventAt(c.at, dayStart, now);
          const payload = { ...payloadOf(), correctedAt: now.toISOString() };
          await tx.stopEvent.update({ where: { id: same.id }, data: { at, lat: c.lat, lng: c.lng, distanceM: c.distanceM, payloadJson: payload as Prisma.InputJsonValue } });
          Object.assign(same, { at, payloadJson: payload });
          corrected++;
        } else bump(kept, 'DUPLICATE');
        continue;
      }
      if (await tx.stopEvent.findFirst({ where: { tenantId, idempotencyKey: key }, select: { id: true } })) {
        bump(kept, 'DUPLICATE');
        continue;
      }
      if (ayun >= MAX_AYUN_EVENTS_PER_VISIT) {
        bump(kept, 'CAP');
        continue;
      }
      if (total >= AYUN_ROOM_LIMIT) {
        bump(kept, 'ROOM');
        continue;
      }
      const at = clampEventAt(c.at, dayStart, now);
      const payload = payloadOf();
      const row = await tx.stopEvent.create({
        data: {
          tenantId,
          depotId: dayLoad.depotId,
          deliveryDate: dateOnly(date),
          truckId,
          loadNo: dayLoad.loadNo,
          sequence,
          visitId: visit.id,
          kind: c.kind,
          source: 'AYUN',
          at,
          receivedAt: now,
          // The truck's own fix: erased with the driver positions after locationRetentionDays (delivery-janitor).
          lat: c.lat,
          lng: c.lng,
          accuracyM: null,
          distanceM: c.distanceM,
          idempotencyKey: key,
          payloadJson: payload as Prisma.InputJsonValue,
        },
      });
      existing.push({ id: row.id, kind: c.kind, source: 'AYUN', at, idempotencyKey: key, payloadJson: payload as Prisma.JsonValue });
      ayun++;
      total++;
      written++;
    }
    if (written || corrected) await rebuildVisit(tx, visit, { dayStart, radiusM, breakMin: planned.breakMin });
    return { written, corrected, kept };
  });
}

/** The stay start an AYUN event was written for (payload.segmentStartAt), else its own time. */
function stayStartOf(e: { at: Date; payloadJson: unknown }): number {
  const s = (e.payloadJson as { segmentStartAt?: unknown } | null)?.segmentStartAt;
  const t = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : e.at.getTime();
}

/**
 * Every truck-day of a company to (re)run: trucks with a tracker and a DISPATCHED or COMPLETED load today
 * or yesterday whose history was pulled since the last run, or whose loads changed status since then
 * (a late Dispatch press, a completion). The processing hook the poller calls after its history pulls
 * (lib/ivms/poll.ts). Each truck-day in its own try: one failure never stops the others.
 */
export interface GpsTimesSummary {
  /** Truck-days processed. */
  truckDays: number;
  /** StopEvents written. */
  written: number;
  /** Unobserved GPS events corrected by a better trail. */
  corrected: number;
  /** GPS events deleted because their trip is now another load's, or the tracker is another truck's. */
  removed?: number;
  /** Truck-days left for the next run (a lock was busy). */
  busy: number;
  /** Truck-days that failed (logged; retried by the next run). */
  failed: number;
  skipped: GpsSkip | null;
}

export async function processGpsTimesForCompany(tenantId: string, now: Date = new Date()): Promise<GpsTimesSummary> {
  const company = await companyGps(tenantId);
  if (typeof company === 'string') return { truckDays: 0, written: 0, corrected: 0, busy: 0, failed: 0, skipped: company };
  const today = todayIso(company.tz, now);
  const trucks = await prisma.truck.findMany({ where: { tenantId, ivmsImei: { not: null } }, select: { id: true } });
  let truckDays = 0;
  let written = 0;
  let corrected = 0;
  let busy = 0;
  let failed = 0;
  let removed = 0;
  for (const date of [addDaysIso(today, -1), today]) {
    const days = await prisma.ivmsTruckDay.findMany({ where: { tenantId, deliveryDate: dateOnly(date), truckId: { in: trucks.map((t) => t.id) } }, select: { truckId: true, lastPullAt: true, processedAt: true, suppressedAt: true } });
    for (const t of trucks) {
      const d = days.find((x) => x.truckId === t.id);
      if (d?.suppressedAt) {
        // A suppressed truck-day keeps no GPS time: one left by a removal that failed, or written by a run
        // that had started before the suppression, is removed now (the visits rebuilt).
        try {
          removed += await clearSuppressedDay(tenantId, t.id, date);
        } catch (e) {
          if (isLockBusy(e)) busy++;
          else {
            failed++;
            console.warn('[ivms] GPS times of a suppressed truck-day not removed', (e as { code?: string; name?: string } | null)?.code ?? (e as Error)?.name ?? 'error');
          }
        }
        continue;
      }
      if (!d || !d.lastPullAt) continue;
      const loads = await truckDayLoads(prisma, tenantId, t.id, date);
      const changed = loads.some((l) => l.statusChangedAt && d.processedAt && l.statusChangedAt > d.processedAt);
      if (d.processedAt && d.lastPullAt <= d.processedAt && !changed) continue;
      if (!loads.some((l) => l.status === 'DISPATCHED' || l.status === 'COMPLETED')) continue;
      // The detector is synchronous work on the one web process: give the event loop back between truck-days.
      if (truckDays + failed > 0) await new Promise<void>((r) => setImmediate(r));
      try {
        const r = await processGpsTimes(tenantId, t.id, date, now);
        truckDays++;
        written += r.written;
        corrected += r.corrected;
        removed += r.removed;
        if (r.busy) busy++;
      } catch (e) {
        failed++;
        // Its code only: a Prisma message can quote the statement, truck positions included (first review LOW).
        console.warn('[ivms] GPS times failed for a truck-day', (e as { code?: string; name?: string } | null)?.code ?? (e as Error)?.name ?? 'error');
      }
    }
  }
  return { truckDays, written, corrected, removed, busy, failed, skipped: null };
}

/**
 * Undo a truck-day's GPS times (M10; the runbook: set ivmsMode below TIMES first, then undo, then revert
 * the app if needed): marks the truck-day suppressed (the next run writes nothing again), deletes its
 * AYUN stop events and rebuilds the visits they were on. Never touches a driver or office event, never
 * reopens a load (GPS never completed one). `dryRun` (the default) only counts.
 */
export async function suppressGpsTimes(
  tenantId: string,
  truckId: string,
  date: string,
  reason: 'UNDO' | 'MISMATCH' | 'REMAP',
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<{ events: number; visits: number; dryRun: boolean }> {
  const dryRun = opts.dryRun !== false;
  const now = opts.now ?? new Date();
  const events = await prisma.stopEvent.findMany({ where: { tenantId, truckId, deliveryDate: dateOnly(date), source: 'AYUN' }, select: { id: true, visitId: true, depotId: true } });
  const visitIds = [...new Set(events.map((e) => e.visitId).filter((x): x is string => !!x))];
  if (dryRun) return { events: events.length, visits: visitIds.length, dryRun };
  await prisma.ivmsTruckDay.upsert({
    where: { tenantId_truckId_deliveryDate: { tenantId, truckId, deliveryDate: dateOnly(date) } },
    create: { tenantId, truckId, deliveryDate: dateOnly(date), suppressedAt: now, suppressReason: reason },
    update: { suppressedAt: now, suppressReason: reason },
  });
  const deleted = await removeGpsEvents(tenantId, date, events, undefined, { truckId });
  return { events: deleted, visits: visitIds.length, dryRun };
}
