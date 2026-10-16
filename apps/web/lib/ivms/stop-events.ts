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
 * Idempotent and first-write-wins (M2): an event's key is `ayun:<A|D>:<depot>:<date>:<truck>:<load>:<seq>:<ms>`
 * with the stay's first inside fix time (never a cycle index), so a rerun is a no-op; a stay whose start
 * moved (a delayed point arrived later) is recognised by an AYUN event of the same kind within 10 min of
 * it and never written twice. At most 4 AYUN events per stop, and none once the stop holds 36 of the 40
 * events shared with the driver and the office (event-service.ts MAX_EVENTS_PER_VISIT): the driver
 * always keeps room.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { dispatchedAt } from '../dispatch/dispatched-at';
import { isLockBusy, setLockTimeout } from '../dispatch/plan-locks';
import { readLoadOrigin, readTruckSnapshot } from '../dispatch/snapshots';
import { addDaysIso, dateOnly, DEFAULT_TZ, isoOf, todayIso, zonedDayStart } from '../dispatch/time';
import { stopsOfLoads } from '../delivery/day-results';
import { ensureVisit, MAX_EVENTS_PER_VISIT, rebuildVisit, type VisitKey } from '../delivery/event-service';
import { lockOutcomesDay } from '../delivery/locks';
import { plannedStopOf } from '../delivery/planned-stop';
import { truckDayLoads, type TruckDayLoad } from '../driver-link/service';
import { readIvmsEnv } from './env';
import { ivmsModeAtLeast, ivmsModeOf } from './settings';
import { detectTruckDay, detectorParams, type DetectorLoad, type DetectorOutput, type ZoneMove } from './stops';
import { DETECTOR_FIXED, type StopAmbiguity, type StopCandidate } from './types';

type Tx = Prisma.TransactionClient;

/** The detector's marker on every event it writes (payloadJson.detector). */
export const DETECTOR_VERSION = 'ivms-v1';
/** At most this many AYUN arrivals and departures per stop. */
export const MAX_AYUN_EVENTS_PER_VISIT = 4;
/** No GPS event once the stop holds this many arrivals, departures and results (of the shared 40). */
export const AYUN_ROOM_LIMIT = MAX_EVENTS_PER_VISIT - MAX_AYUN_EVENTS_PER_VISIT;
/** An AYUN event of the same kind this close (minutes) to a stay's start is that stay's (first write wins). */
export const SAME_STAY_MIN = 10;
/** The trail read for a truck-day: from 3 h before its local midnight to 3 h after the next. */
const WINDOW_BEFORE_H = 3;
const WINDOW_AFTER_H = 27;
/** The lock timeout of a GPS write (shorter than the driver's: GPS can wait for the next run). */
const GPS_LOCK_TIMEOUT_MS = 3_000;

export type GpsSkip = 'DISABLED' | 'MODE' | 'SUPPRESSED' | 'NO_LOAD' | 'NO_TRAIL';

export interface GpsTimesResult {
  truckId: string;
  date: string;
  skipped: GpsSkip | null;
  /** StopEvents written. */
  written: number;
  /** Candidates not written, by why: DUPLICATE (key or same stay), CAP, ROOM, NOT_ON_ROAD, NO_STOP, OFFICE. */
  kept: Record<string, number>;
  /** The truck was busy (lock timeout): the rest waits for the next run. */
  busy: boolean;
  trailMoves: number;
  facts: GpsFact[];
}

/** A fact for the office (IvmsTruckDay.gpsFactsJson): what GPS saw but did not write by itself. */
export type GpsFact =
  | { kind: 'SEVERAL_PINS' | 'NEAR_DEPOT' | 'OUT_OF_SEQUENCE_SHORT'; loadNo: number; sequences: number[]; from: string; to: string | null }
  | { kind: 'NO_DEPOT_BOUNDARY' };

/** The facts to store from a detector run (at most 40; the JSON stays under the column's 8 KB CHECK). */
export function gpsFactsOf(out: Pick<DetectorOutput, 'ambiguities' | 'notes'>): GpsFact[] {
  const facts: GpsFact[] = out.ambiguities.map((a: StopAmbiguity) => ({ kind: a.reason, loadNo: a.loadNo, sequences: a.sequences, from: a.from.toISOString(), to: a.to ? a.to.toISOString() : null }));
  if (out.notes.includes('NO_DEPOT_BOUNDARY')) facts.push({ kind: 'NO_DEPOT_BOUNDARY' });
  return facts.slice(0, 40);
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

const isUniqueViolation = (e: unknown) => (e instanceof Prisma.PrismaClientKnownRequestError ? e.code === 'P2002' : (e as { code?: unknown } | null)?.code === 'P2002');

interface CompanyGps {
  tz: string;
  radiusM: number;
  params: ReturnType<typeof detectorParams>;
}

/** The company's GPS settings, or why GPS times are off for it. */
async function companyGps(tenantId: string): Promise<CompanyGps | GpsSkip> {
  if (readIvmsEnv().disabled) return 'DISABLED';
  const cfg = await prisma.tenantConfig.findFirst({
    where: { tenantId },
    select: { timezone: true, geofenceRadiusM: true, ivmsMode: true, ivmsStopRadiusM: true, ivmsStopDwellMin: true, ivmsDepotRadiusM: true },
  });
  if (!cfg || !ivmsModeAtLeast(ivmsModeOf(cfg), 'TIMES')) return 'MODE';
  return {
    tz: cfg.timezone || DEFAULT_TZ,
    // The visit rebuild's radius, as the driver path's dayFacts clamps it.
    radiusM: Math.min(500, Math.max(50, cfg.geofenceRadiusM ?? 100)),
    params: detectorParams(cfg, DETECTOR_FIXED),
  };
}

/**
 * Run the detector over one truck-day's stored trail and write what it finds (TIMES only). Safe to run
 * any number of times; returns what was written and kept. Never throws for a busy plan.
 */
export async function processGpsTimes(tenantId: string, truckId: string, date: string, now: Date = new Date()): Promise<GpsTimesResult> {
  const res: GpsTimesResult = { truckId, date, skipped: null, written: 0, kept: {}, busy: false, trailMoves: 0, facts: [] };
  const company = await companyGps(tenantId);
  if (typeof company === 'string') return { ...res, skipped: company };
  const day = await prisma.ivmsTruckDay.findFirst({ where: { tenantId, truckId, deliveryDate: dateOnly(date) }, select: { id: true, suppressedAt: true } });
  if (day?.suppressedAt) return { ...res, skipped: 'SUPPRESSED' };
  const loads = (await truckDayLoads(prisma, tenantId, truckId, date)).filter((l) => l.status === 'DISPATCHED' || l.status === 'COMPLETED');
  if (!loads.length) return { ...res, skipped: 'NO_LOAD' };
  const dayStart = zonedDayStart(date, company.tz);
  const from = new Date(dayStart.getTime() - WINDOW_BEFORE_H * 3600_000);
  const to = new Date(dayStart.getTime() + WINDOW_AFTER_H * 3600_000);
  const points = await prisma.truckTrailPoint.findMany({ where: { tenantId, truckId, fixAt: { gte: from, lte: to } }, orderBy: { fixAt: 'asc' }, select: { fixAt: true, lat: true, lng: true, speedKmh: true, ignition: true } });
  if (!points.length) return { ...res, skipped: 'NO_TRAIL' };

  const input = await detectorInput(tenantId, truckId, date, dayStart, loads, company, from, to);
  const out = detectTruckDay({ ...input.detector, points });
  res.facts = gpsFactsOf(out);

  // Depot moves: the trail's (not confirmed by a provider zone move), and what the trail says of the zone moves.
  res.trailMoves = await writeTrailMoves(tenantId, truckId, out, now);
  for (const outcome of ['USED', 'UNCONFIRMED'] as const) {
    const ids = out.zoneOutcomes.filter((z) => z.outcome === outcome).map((z) => z.id);
    if (ids.length) await prisma.ivmsEvent.updateMany({ where: { tenantId, id: { in: ids }, OR: [{ outcome: null }, { outcome: { not: outcome } }] }, data: { outcome, processedAt: now } });
  }

  // The stop events, one transaction per visit.
  const byStop = new Map<string, DetectorOutput['candidates']>();
  for (const c of out.candidates) {
    const k = `${c.depotId}|${c.loadNo}|${c.sequence}`;
    byStop.set(k, [...(byStop.get(k) ?? []), c]);
  }
  for (const list of byStop.values()) {
    const load = input.loadOf(list[0]!.depotId, list[0]!.loadNo);
    if (!load) {
      bump(res.kept, 'NOT_ON_ROAD', list.length);
      continue;
    }
    try {
      const r = await writeStopCandidates(tenantId, truckId, date, dayStart, now, company.radiusM, load, list);
      res.written += r.written;
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

  await prisma.ivmsTruckDay.upsert({
    where: { tenantId_truckId_deliveryDate: { tenantId, truckId, deliveryDate: dateOnly(date) } },
    create: { tenantId, truckId, deliveryDate: dateOnly(date), processedAt: now, gpsFactsJson: res.facts as unknown as Prisma.InputJsonValue },
    update: { processedAt: now, gpsFactsJson: res.facts as unknown as Prisma.InputJsonValue },
  });
  return res;
}

function bump(m: Record<string, number>, k: string, n = 1) {
  m[k] = (m[k] ?? 0) + n;
}

/** What the detector needs about the truck-day: its loads in dispatch order with their stops, the depots, the zone moves. */
async function detectorInput(tenantId: string, truckId: string, date: string, dayStart: Date, loads: TruckDayLoad[], company: CompanyGps, from: Date, to: Date) {
  const rows = await prisma.planLoad.findMany({ where: { tenantId, id: { in: loads.map((l) => l.id) } }, select: { id: true, carriedFromLoadId: true, breakJson: true, truckSnapshotJson: true } });
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const [dispatched, stops, visits, depots, zone] = await Promise.all([
    dispatchedAt(prisma, tenantId, loads.map((l) => ({ id: l.id, carriedFromLoadId: rowOf.get(l.id)?.carriedFromLoadId ?? null }))),
    stopsOfLoads(prisma, loads.map((l) => ({ id: l.id, breakJson: rowOf.get(l.id)?.breakJson ?? null }))),
    prisma.stopVisit.findMany({ where: { tenantId, truckId, deliveryDate: dateOnly(date) }, select: { depotId: true, loadNo: true, sequence: true, outcomeAt: true, outcome: true, arrivalSource: true, plannedLat: true, plannedLng: true } }),
    prisma.depot.findMany({ where: { tenantId, id: { in: [...new Set(loads.map((l) => l.depotId))] } }, select: { id: true, lat: true, lng: true } }),
    prisma.ivmsEvent.findMany({
      where: { tenantId, truckId, kind: { in: ['DEPOT_IN', 'DEPOT_OUT'] }, origin: { in: ['WEBHOOK', 'BACKSTOP'] }, eventAt: { gte: from, lte: to } },
      select: { id: true, kind: true, eventAt: true, depotId: true },
    }),
  ]);
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
    stops: (stops.get(l.id) ?? []).map((s) => {
      const v = visits.find((x) => x.depotId === l.depotId && x.loadNo === l.loadNo && x.sequence === s.sequence);
      const pin = v && v.plannedLat !== null && v.plannedLng !== null ? { lat: v.plannedLat, lng: v.plannedLng } : s.pin;
      return { sequence: s.sequence, pin, resultAt: v?.outcome ? v.outcomeAt : null, officeArrival: v?.arrivalSource === 'DISPATCHER' };
    }),
  }));
  const zoneMoves: ZoneMove[] = zone.filter((z): z is typeof z & { kind: 'DEPOT_IN' | 'DEPOT_OUT' } => z.kind === 'DEPOT_IN' || z.kind === 'DEPOT_OUT').map((z) => ({ id: z.id, kind: z.kind, at: z.eventAt, depotId: z.depotId }));
  // By depot and number: a truck can have a Load 1 at two depots on one date.
  const loadOf = (depotId: string, loadNo: number) => loads.find((l) => l.depotId === depotId && l.loadNo === loadNo) ?? null;
  return { detector: { depots: [...pins.values()], zoneMoves, loads: detectorLoads, params: company.params }, loadOf };
}

/** Depot moves from the trail, stored once (origin TRAIL): never when any move of the same kind is within 10 min. */
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
        data: { tenantId, truckId, depotId: m.depotId, kind: m.kind, origin: 'TRAIL', eventAt: m.at, receivedAt: now, lat: m.lat, lng: m.lng, dedupeKey: trailMoveKey(truckId, m.kind, m.at), processedAt: now, outcome: 'USED' },
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
): Promise<{ written: number; kept: Record<string, number> }> {
  const kept: Record<string, number> = {};
  const sequence = list[0]!.sequence;
  return prisma.$transaction(async (tx: Tx) => {
    await setLockTimeout(tx, GPS_LOCK_TIMEOUT_MS);
    await lockOutcomesDay(tx, tenantId, dayLoad.depotId, date);
    const load = await tx.planLoad.findFirst({ where: { id: dayLoad.id, tenantId }, select: { id: true, status: true, breakJson: true } });
    // GPS never presses Dispatch: only a load on the road (or closed the same day) gets times.
    if (!load || (load.status !== 'DISPATCHED' && load.status !== 'COMPLETED')) {
      bump(kept, 'NOT_ON_ROAD', list.length);
      return { written: 0, kept };
    }
    const planned = await plannedStopOf(tx, load, sequence);
    if (!planned) {
      bump(kept, 'NO_STOP', list.length);
      return { written: 0, kept };
    }
    const vk: VisitKey = { tenantId, depotId: dayLoad.depotId, date, truckId, loadNo: dayLoad.loadNo, sequence };
    const visit = await ensureVisit(tx, vk, planned, dayLoad.id);
    // The office set the arrival: GPS adds nothing to that stop.
    if (visit.arrivalSource === 'DISPATCHER') {
      bump(kept, 'OFFICE', list.length);
      return { written: 0, kept };
    }
    const existing = await tx.stopEvent.findMany({ where: { tenantId, visitId: visit.id, kind: { in: ['ARRIVED', 'DEPARTED', 'OUTCOME'] } }, select: { kind: true, source: true, at: true, idempotencyKey: true, payloadJson: true } });
    let ayun = existing.filter((e) => e.source === 'AYUN').length;
    let total = existing.length;
    let written = 0;
    for (const c of [...list].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.kind === 'ARRIVED' ? -1 : 1))) {
      const key = gpsEventKey(c, dayLoad.depotId, date, truckId);
      const sameStay = existing.some((e) => e.source === 'AYUN' && e.kind === c.kind && (e.idempotencyKey === key || Math.abs(stayStartOf(e) - c.segmentStartAt.getTime()) <= SAME_STAY_MIN * 60_000));
      if (sameStay || (await tx.stopEvent.findFirst({ where: { tenantId, idempotencyKey: key }, select: { id: true } }))) {
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
      const payload: Record<string, unknown> = { observed: c.observed, ...(c.kind === 'DEPARTED' && !c.observed ? { gap: true } : {}), detector: DETECTOR_VERSION, segmentStartAt: c.segmentStartAt.toISOString() };
      await tx.stopEvent.create({
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
      existing.push({ kind: c.kind, source: 'AYUN', at, idempotencyKey: key, payloadJson: payload as Prisma.JsonValue });
      ayun++;
      total++;
      written++;
    }
    if (written) await rebuildVisit(tx, visit, { dayStart, radiusM, breakMin: planned.breakMin });
    return { written, kept };
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
export async function processGpsTimesForCompany(tenantId: string, now: Date = new Date()): Promise<{ truckDays: number; written: number; busy: number; failed: number; skipped: GpsSkip | null }> {
  const company = await companyGps(tenantId);
  if (typeof company === 'string') return { truckDays: 0, written: 0, busy: 0, failed: 0, skipped: company };
  const today = todayIso(company.tz, now);
  const trucks = await prisma.truck.findMany({ where: { tenantId, ivmsImei: { not: null } }, select: { id: true } });
  let truckDays = 0;
  let written = 0;
  let busy = 0;
  let failed = 0;
  for (const date of [addDaysIso(today, -1), today]) {
    const days = await prisma.ivmsTruckDay.findMany({ where: { tenantId, deliveryDate: dateOnly(date), truckId: { in: trucks.map((t) => t.id) } }, select: { truckId: true, lastPullAt: true, processedAt: true, suppressedAt: true } });
    for (const t of trucks) {
      const d = days.find((x) => x.truckId === t.id);
      if (!d || d.suppressedAt || !d.lastPullAt) continue;
      const loads = await truckDayLoads(prisma, tenantId, t.id, date);
      const changed = loads.some((l) => l.statusChangedAt && d.processedAt && l.statusChangedAt > d.processedAt);
      if (d.processedAt && d.lastPullAt <= d.processedAt && !changed) continue;
      if (!loads.some((l) => l.status === 'DISPATCHED' || l.status === 'COMPLETED')) continue;
      try {
        const r = await processGpsTimes(tenantId, t.id, date, now);
        truckDays++;
        written += r.written;
        if (r.busy) busy++;
      } catch (e) {
        failed++;
        // Never the provider's data or a key: counts and the error's message only.
        console.warn('[ivms] GPS times failed for a truck-day', (e as Error)?.message ?? e);
      }
    }
  }
  return { truckDays, written, busy, failed, skipped: null };
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
  const cfg = await prisma.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true, geofenceRadiusM: true } });
  const tz = cfg?.timezone || DEFAULT_TZ;
  const radiusM = Math.min(500, Math.max(50, cfg?.geofenceRadiusM ?? 100));
  for (const depotId of [...new Set(events.map((e) => e.depotId))]) {
    await prisma.$transaction(async (tx: Tx) => {
      await setLockTimeout(tx);
      await lockOutcomesDay(tx, tenantId, depotId, date);
      await tx.stopEvent.deleteMany({ where: { tenantId, truckId, depotId, deliveryDate: dateOnly(date), source: 'AYUN' } });
      for (const id of visitIds) {
        const v = await tx.stopVisit.findFirst({ where: { id, tenantId, depotId } });
        if (!v) continue;
        const load = v.firstLoadId ? await tx.planLoad.findFirst({ where: { id: v.firstLoadId, tenantId }, select: { breakJson: true } }) : null;
        const b = load?.breakJson as { v?: unknown; startMin?: unknown; endMin?: unknown } | null | undefined;
        const breakMin = b && b.v === 1 && typeof b.startMin === 'number' && typeof b.endMin === 'number' ? { startMin: b.startMin, endMin: b.endMin } : null;
        await rebuildVisit(tx, v, { dayStart: zonedDayStart(isoOf(v.deliveryDate), tz), radiusM, breakMin });
      }
    });
  }
  return { events: events.length, visits: visitIds.length, dryRun };
}
