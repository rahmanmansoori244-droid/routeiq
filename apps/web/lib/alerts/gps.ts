/**
 * GPS alerts (owner request 18 Oct 2026: "build GPS alerts"; the owner believed GPS tracking TIMES already
 * fed the alerts): what the operations alerts read from the IVMS live link in ivmsMode ALERTS, and how.
 * Pure and browser-safe: the rules (rules.ts) call these helpers; facts.ts (the database) and replay.ts (a
 * saved day) build their input. Nothing here runs below ALERTS: with GPS tracking OFF, MAP or TIMES the
 * facts carry no GPS (AlertFacts.gps absent, every visit read through lib/delivery/visit.ts withoutGpsTimes)
 * and every rule behaves exactly as before (tests/lib/alert-gps.spec.ts, "golden").
 *
 * The principles, decided conservatively:
 * 1. GPS fills gaps, never contradicts a driver or office time and never creates a result. The visit's
 *    times are the visit rebuild's (lib/delivery/visit.ts withGps: the driver's and the office's times
 *    first, a GPS arrival or departure only where they left a gap, the result never from GPS); a GPS depot
 *    move only stands in for a tap that is missing (Back at depot, Leaving for next load).
 * 2. The GPS times the trail gave (the visits' AYUN arrivals and departures, the trail-confirmed depot
 *    moves: lib/ivms/types.ts GpsTruckDayFact) are facts: read for every truck-day whose GPS is not
 *    suppressed (IvmsTruckDay.suppressedAt; a suppressed truck-day has its AYUN events removed and is read
 *    exactly as with the link off), whether its live fix is fresh or not, so a row raised from them never
 *    flips when the live feed pauses.
 * 3. Only OBSERVED GPS times measure a duration (the unloading, the time at the depot, how late a truck
 *    left): an unobserved one (a gap in the trail before it) is only an upper bound, so a duration alert is
 *    never raised on it - the rule says "not measured" instead.
 * 4. What rests on where the truck is NOW (still at the stop, away from the depot, the live ETA) reads the
 *    live position only while it is fresh (GpsTruckDayFact.tracked: STALE_FIX_SEC, review H5): gpsLiveOf
 *    'LIVE'. Between two reads (the last fix younger than GPS_WAIT_MIN; at Ayun's 100 calls a day positions
 *    come about every 20 min, so most reads are stale) such a rule WAITS: an open row stays as it is and
 *    nothing new is raised from the phone alone, so a row never closes and opens again with every read.
 *    No fix for longer (or none at all): the phone-based rule, as before.
 * 5. Every alert text that used a GPS time or the live position says "(GPS)", so the office knows the
 *    source. The position itself is never in a text, the row's facts or a log.
 */
import { distanceM } from '../dispatch/snapshots';
import { AT_STOP_MARGIN_M, fixUsable, liveEta, type EtaStop, type StopEta } from '../ivms/eta';
import { ivmsModeOf } from '../ivms/settings';
import { ANCHOR_EARLY_MIN, tripsOf } from '../ivms/stops';
import { DETECTOR_FIXED, MOVING_KMH, type FixFlag, type GpsDepotMove, type GpsTruckDayFact } from '../ivms/types';

/** Between two GPS reads (the last fix at most this old, but not fresh) the rules that read the live position wait. */
export const GPS_WAIT_MIN = 30;
/**
 * R4: a trail-confirmed depot OUT counts as the truck's first load leaving from this long before its
 * planned departure (the stop detector's anchor for a load pressed long before it left: lib/ivms/stops.ts).
 */
export const GPS_LEAVE_EARLY_MIN = ANCHOR_EARLY_MIN;
/** "At the depot" by the live position: within the depot radius plus this margin of the depot pin. */
export const AT_DEPOT_MARGIN_M = 150;

/** The settings the GPS is read with (the company's ivms* and planning settings; ALERTS only). */
export interface AlertGpsSettings {
  /** "At a stop" by the live position: within this distance of its pin (ivmsStopRadiusM + lib/ivms/eta.ts AT_STOP_MARGIN_M, as the live map). */
  atStopRadiusM: number;
  /** "At the depot" by the live position: within this distance of the depot pin (ivmsDepotRadiusM + AT_DEPOT_MARGIN_M). */
  atDepotRadiusM: number;
  /** The live ETA's straight-line floor (TenantConfig.avgSpeedKmh, distanceMultiplier), as the live map. */
  avgSpeedKmh: number;
  distanceMultiplier: number;
  /** The pins of the loads' depots, by depot id (empty in the replay: no live position is saved). */
  depots: ReadonlyMap<string, { lat: number; lng: number }>;
}

/** The settings facts.ts reads the depots for (AlertGpsSettings without the depot pins). */
export type AlertGpsConfig = Omit<AlertGpsSettings, 'depots'>;

/**
 * The GPS the alerts read for a company (the sweep, lib/alerts/sweep.ts): only in GPS tracking ALERTS and
 * while the link is not switched off (ROUTEIQ_DISABLE_IVMS=1, `ivmsDisabled`); null otherwise - the alerts
 * then read no GPS at all, as below ALERTS.
 */
export function gpsAlertConfigOf(
  cfg: { ivmsMode?: string | null; ivmsStopRadiusM?: number | null; ivmsDepotRadiusM?: number | null; avgSpeedKmh?: number | null; distanceMultiplier?: number | null } | null | undefined,
  ivmsDisabled: boolean,
): AlertGpsConfig | null {
  if (ivmsDisabled || ivmsModeOf(cfg) !== 'ALERTS') return null;
  const num = (v: number | null | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    atStopRadiusM: num(cfg!.ivmsStopRadiusM, 100) + AT_STOP_MARGIN_M,
    atDepotRadiusM: num(cfg!.ivmsDepotRadiusM, 300) + AT_DEPOT_MARGIN_M,
    avgSpeedKmh: num(cfg!.avgSpeedKmh, 40),
    distanceMultiplier: num(cfg!.distanceMultiplier, 1.3),
  };
}

/** A trail-confirmed depot move as facts.ts reads it (IvmsEvent outcome USED). */
export interface ConfirmedMove {
  kind: 'DEPOT_IN' | 'DEPOT_OUT';
  at: Date;
  /** WEBHOOK / BACKSTOP: the device's own zone event; TRAIL: a move the stop detector derived from the trail. */
  origin: string;
}

/**
 * Is a confirmed depot move's time exact (lib/ivms/types.ts GpsDepotMove.observed)? A zone move is the
 * device's own event; a trail move only when a trail point lies at most observedMaxGapSec before it
 * (`pointsBefore`: the truck's trail points just before the move).
 */
export function moveObserved(m: ConfirmedMove, pointsBefore: readonly Date[]): boolean {
  if (m.origin !== 'TRAIL') return true;
  const gapMs = DETECTOR_FIXED.observedMaxGapSec * 1000;
  return pointsBefore.some((p) => p.getTime() < m.at.getTime() && m.at.getTime() - p.getTime() <= gapMs);
}

/** One truck-day's GpsTruckDayFact (lib/ivms/types.ts) from its latest live fix, its confirmed depot moves and its history pull. */
export function gpsTruckDayFactOf(i: {
  position: { fixAt: Date; lat: number; lng: number; speedKmh: number | null; flags: readonly string[]; movedAt: Date | null } | null;
  moves: readonly { kind: 'DEPOT_IN' | 'DEPOT_OUT'; at: Date; observed: boolean }[];
  trailTo: Date | null;
  now: Date;
}): GpsTruckDayFact {
  const p = i.position;
  const tracked = !!p && fixUsable({ fixAt: p.fixAt, lat: p.lat, lng: p.lng, flags: p.flags as FixFlag[] }, i.now);
  const moving = !!p && (p.speedKmh ?? 0) >= MOVING_KMH;
  const sorted = [...i.moves].sort((a, b) => a.at.getTime() - b.at.getTime());
  const trips = tripsOf(
    sorted.map((m) => ({ kind: m.kind, at: m.at, depotId: null })),
    null,
    null,
  ).map((tr) => ({ outAt: tr.outAt, inAt: tr.inAt, loadNo: null }));
  return {
    tracked,
    fixAt: p?.fixAt ?? null,
    speedKmh: p?.speedKmh ?? null,
    parkedSinceMin: p && !moving && p.movedAt ? Math.max(0, Math.floor((p.fixAt.getTime() - p.movedAt.getTime()) / 60_000)) : null,
    position: tracked ? { lat: p!.lat, lng: p!.lng } : null,
    depotOut: sorted.filter((m) => m.kind === 'DEPOT_OUT').map((m) => ({ at: m.at, observed: m.observed })),
    depotIn: sorted.filter((m) => m.kind === 'DEPOT_IN').map((m) => ({ at: m.at, observed: m.observed })),
    trips,
    trailTo: i.trailTo,
  };
}

/**
 * How a rule may read the truck-day's live position now: LIVE (a fresh fix: read it), WAIT (GPS follows the
 * truck but the last fix is not fresh, at most GPS_WAIT_MIN old: wait for the next read), or null (no GPS
 * for the truck-day, or no fix for longer: the phone-based rule).
 */
export type GpsLive = 'LIVE' | 'WAIT' | null;

export function gpsLiveOf(g: GpsTruckDayFact | null | undefined, now: Date): GpsLive {
  if (!g) return null;
  if (g.tracked && g.position) return 'LIVE';
  if (!g.fixAt) return null;
  const age = now.getTime() - g.fixAt.getTime();
  return age >= -120_000 && age <= GPS_WAIT_MIN * 60_000 ? 'WAIT' : null;
}

/** Is the truck at `pin` by its fresh live fix? AT, AWAY, or null (not LIVE, or no pin). */
export function liveAt(g: GpsTruckDayFact | null | undefined, pin: { lat: number; lng: number } | null | undefined, radiusM: number, now: Date): 'AT' | 'AWAY' | null {
  if (!pin || gpsLiveOf(g, now) !== 'LIVE') return null;
  return distanceM(g!.position!, pin) <= radiusM ? 'AT' : 'AWAY';
}

const t = (d: Date) => d.getTime();

/** The first trail-confirmed depot IN after `after`, not after `now` (null: none). */
export function firstInAfter(g: GpsTruckDayFact | null | undefined, after: Date, now: Date): GpsDepotMove | null {
  return (g?.depotIn ?? []).filter((m) => t(m.at) > t(after) && t(m.at) <= t(now)).sort((a, b) => t(a.at) - t(b.at))[0] ?? null;
}

/**
 * The trail-confirmed depot OUT the truck has been out since at `until`: the latest OUT in [from, until]
 * with no confirmed IN after it and before `until` (a fuel run that came back is not a departure). Null:
 * the trail shows the truck at the depot (or knows nothing) at `until`.
 */
export function outSince(g: GpsTruckDayFact | null | undefined, from: Date, until: Date): GpsDepotMove | null {
  const outs = (g?.depotOut ?? []).filter((m) => t(m.at) >= t(from) && t(m.at) <= t(until)).sort((a, b) => t(b.at) - t(a.at));
  const last = outs[0];
  if (!last) return null;
  const backIn = (g?.depotIn ?? []).some((m) => t(m.at) > t(last.at) && t(m.at) <= t(until));
  return backIn ? null : last;
}

/**
 * The truck came back to the depot from a load, by GPS: the first trail-confirmed depot IN after the load's
 * last sign at a stop and after its Dispatch press, not after now - only once every stop of the load has a
 * result or a sign (`allStopsDone`): a depot IN while stops are still pending may be a run back for missing
 * goods or a break at the depot, not the end of the load. Null: not known to be back by GPS.
 */
export function gpsBackOf(
  g: GpsTruckDayFact | null | undefined,
  load: { lastSignAt: Date | null; dispatchAt: Date | null; allStopsDone: boolean },
  now: Date,
): GpsDepotMove | null {
  if (!g || !load.allStopsDone || !load.lastSignAt) return null;
  const after = load.dispatchAt && t(load.dispatchAt) > t(load.lastSignAt) ? load.dispatchAt : load.lastSignAt;
  return firstInAfter(g, after, now);
}

/**
 * The live ETA of the stops still ahead from the truck's fresh fix: the same as the live map's (lib/ivms/eta.ts
 * liveEta, lib/ivms/vehicles.ts), from the plan's own legs. [] when the truck-day is not LIVE.
 */
export function liveEtasOf(
  g: GpsTruckDayFact | null | undefined,
  s: AlertGpsSettings,
  load: { depotId: string; departMin: number; dayStart: Date; stops: readonly EtaStop[] },
  now: Date,
): StopEta[] {
  if (gpsLiveOf(g, now) !== 'LIVE' || !g!.fixAt) return [];
  return liveEta({
    now,
    // `tracked` already left out an invalid fix and a clock ahead.
    fix: { fixAt: g!.fixAt, lat: g!.position!.lat, lng: g!.position!.lng },
    dayStart: load.dayStart,
    departMin: load.departMin,
    depot: s.depots.get(load.depotId) ?? null,
    stops: load.stops,
    avgSpeedKmh: s.avgSpeedKmh,
    distanceMultiplier: s.distanceMultiplier,
    atStopRadiusM: s.atStopRadiusM,
  });
}

/**
 * Where the projection (projection.ts) ends a stop with an arrival and nothing that ends it, when GPS knows
 * better than the clock (null: as before, the stop is in progress):
 * - the fresh fix is at the stop: in progress (null);
 * - the fresh fix is away from it: the truck left by then - at the arrival + the planned unloading, never
 *   after that fix (never before the arrival);
 * - a GPS arrival without a fresh fix: the trail saw the truck there until its last pull (`trailTo`), so
 *   the stop ends at the later of the arrival + the planned unloading and that pull, once that has passed
 *   (the clock never pushes a stop the trail lost sight of: positions and history come in steps).
 * Only for the projection (the expected times of R3, R5 and the projected R6): never a time shown or measured.
 */
export function openStayEnd(
  v: { arrivedAt: Date; gpsArrival: boolean; plannedServiceMin: number | null },
  where: 'AT' | 'AWAY' | null,
  g: GpsTruckDayFact | null | undefined,
  now: Date,
): Date | null {
  if (where === 'AT') return null;
  const planned = new Date(t(v.arrivedAt) + Math.max(0, v.plannedServiceMin ?? 0) * 60_000);
  if (where === 'AWAY') {
    const fix = g?.fixAt ?? now;
    return new Date(Math.max(t(v.arrivedAt), Math.min(t(planned), t(fix))));
  }
  if (!v.gpsArrival) return null;
  const end = new Date(Math.max(t(planned), g?.trailTo ? t(g.trailTo) : t(v.arrivedAt)));
  return t(end) <= t(now) ? end : null;
}

/** "moving, 42 km/h" / "parked 25 min" / "standing" for the live position's words (never the place). */
export function motionWords(g: GpsTruckDayFact): string {
  if (g.speedKmh !== null && g.speedKmh >= MOVING_KMH) return `moving, ${Math.round(g.speedKmh)} km/h`;
  if (g.parkedSinceMin !== null) return `parked ${g.parkedSinceMin} min`;
  return 'standing';
}
