/**
 * Live ETA from a truck's GPS position to the stops of its load still ahead (IVMS live link, 16 Oct 2026,
 * design section 8.3 with the binding review's H5). Pure and browser-safe; no outbound call.
 *
 * The road time is the plan's own: each leg is the planned minutes from the previous stop's planned
 * departure to the stop's planned arrival, which came from the planner's road matrix (OSRM, else the
 * straight-line estimate) with the company's road time factor already in it. For the next stop the
 * planned leg is scaled by how much of it is left (straight-line distance from the truck to the pin over
 * the leg's straight-line length, capped at 1.2), and never below the straight-line drive at the
 * company's average speed and distance multiplier. Later stops follow from the plan: arrival + planned
 * unloading + planned leg.
 *
 * Stale handling (H5): no ETA at all from a fix older than STALE_FIX_SEC, an invalid fix or a device
 * clock ahead ("-" on the screen): an old position must never pass for a live one.
 *
 * Which stop is next (second review M-2): the truck is "at" a stop with an open arrival only while its
 * fresh fix is within atStopRadiusM of that stop's pin (an arrival whose result or departure is not in
 * yet, while the truck is 10 km on, is behind it); a stop before the latest stop the truck has been at
 * (arrived or done) was skipped and is not "next".
 */
import { distanceM } from '../dispatch/snapshots';
import { STALE_FIX_SEC, type FixFlag } from './types';

export interface EtaStop {
  sequence: number;
  pin: { lat: number; lng: number } | null;
  /** Planned arrival, minutes from the delivery day's local midnight; null = none. */
  etaMin: number | null;
  /** Planned unloading (departure - service start), minutes. */
  plannedServiceMin: number | null;
  /** A result or a departure is recorded: the stop is behind the truck. */
  done: boolean;
  /** Arrived (phone, office or GPS) and not left: the truck is there now. */
  arrivedAt: Date | null;
}

export interface EtaInput {
  now: Date;
  fix: { fixAt: Date; lat: number; lng: number; flags?: readonly FixFlag[] } | null;
  /** zonedDayStart of the delivery date. */
  dayStart: Date;
  /** The load's planned departure from the depot, local minutes. */
  departMin: number;
  depot: { lat: number; lng: number } | null;
  stops: readonly EtaStop[];
  avgSpeedKmh: number;
  distanceMultiplier: number;
  /** "At the stop" only within this distance (m) of its pin: the stop radius plus a margin (default 250). */
  atStopRadiusM?: number;
}

/** The margin over the GPS stop radius within which a truck with an open arrival is at that stop. */
export const AT_STOP_MARGIN_M = 150;

export interface StopEta {
  sequence: number;
  etaAt: Date;
  plannedAt: Date | null;
  /** etaAt - plannedAt in whole minutes (positive = late); null without a planned time. */
  delayMin: number | null;
  /** The truck is at this stop now (etaAt is its arrival). */
  atStop: boolean;
}

/** A remaining-leg share above this is a truck going the wrong way: capped. */
export const ETA_MAX_LEG_SHARE = 1.2;

/** Is a live fix usable for an ETA? Fresh (STALE_FIX_SEC), valid, clock not ahead. */
export function fixUsable(fix: EtaInput['fix'], now: Date): boolean {
  if (!fix) return false;
  if (fix.flags?.some((f) => f === 'INVALID_FIX' || f === 'CLOCK_AHEAD')) return false;
  const age = (now.getTime() - fix.fixAt.getTime()) / 1000;
  return age >= -120 && age <= STALE_FIX_SEC;
}

/** Straight-line driving minutes between two points at the company's speed and multiplier. */
export function straightMin(a: { lat: number; lng: number }, b: { lat: number; lng: number }, avgSpeedKmh: number, distanceMultiplier: number): number {
  const speed = avgSpeedKmh > 0 ? avgSpeedKmh : 40;
  const mult = distanceMultiplier > 0 ? distanceMultiplier : 1.3;
  return ((distanceM(a, b) / 1000) * mult * 60) / speed;
}

/** The planned leg (minutes) into `cur`: from the previous stop's planned departure, else the load's. */
function plannedLeg(prev: EtaStop | null, cur: EtaStop, departMin: number): number | null {
  if (cur.etaMin === null) return null;
  const from = prev ? (prev.etaMin !== null ? prev.etaMin + (prev.plannedServiceMin ?? 0) : null) : departMin;
  return from === null ? null : Math.max(0, cur.etaMin - from);
}

const MIN = 60_000;

/** ETAs of the stops still ahead, in sequence (the first is the next stop); none without a usable fix. */
export function liveEta(i: EtaInput): StopEta[] {
  if (!fixUsable(i.fix, i.now)) return [];
  const fix = i.fix!;
  const sorted = [...i.stops].sort((a, b) => a.sequence - b.sequence);
  // A stop before the latest one the truck has been at (arrived or done) was skipped: not "next".
  const touched = sorted.filter((s) => s.done || s.arrivedAt).map((s) => s.sequence);
  const latest = touched.length ? Math.max(...touched) : -Infinity;
  let ahead = sorted.filter((s) => !s.done && s.sequence >= latest);
  // An open arrival while the fresh fix is away from that stop's pin: the truck left it (the result or the
  // departure is not in yet), it is behind the truck.
  const radius = i.atStopRadiusM ?? 100 + AT_STOP_MARGIN_M;
  if (ahead[0]?.arrivedAt && ahead[0].pin && distanceM(fix, ahead[0].pin) > radius) ahead = ahead.slice(1);
  if (!ahead.length) return [];
  const plannedAt = (s: EtaStop) => (s.etaMin === null ? null : new Date(i.dayStart.getTime() + s.etaMin * MIN));
  const out: StopEta[] = [];
  const push = (s: EtaStop, etaAt: Date, atStop = false) => {
    const p = plannedAt(s);
    out.push({ sequence: s.sequence, etaAt, plannedAt: p, delayMin: p ? Math.round((etaAt.getTime() - p.getTime()) / MIN) : null, atStop });
  };
  const start = Math.max(i.now.getTime(), fix.fixAt.getTime());
  const first = ahead[0]!;
  let departAt: number;
  if (first.arrivedAt) {
    // At the stop now: it leaves after its planned unloading (not before now).
    push(first, first.arrivedAt, true);
    departAt = Math.max(i.now.getTime(), first.arrivedAt.getTime() + (first.plannedServiceMin ?? 0) * MIN);
  } else {
    const prev = [...sorted].reverse().find((s) => s.sequence < first.sequence && (s.done || s.arrivedAt)) ?? null;
    const prevPin = prev?.pin ?? (prev ? null : i.depot);
    const leg = plannedLeg(prev, first, i.departMin);
    let driveMin: number;
    if (first.pin) {
      const direct = straightMin(fix, first.pin, i.avgSpeedKmh, i.distanceMultiplier);
      const legLen = prevPin ? distanceM(prevPin, first.pin) : 0;
      const share = legLen > 0 ? Math.min(ETA_MAX_LEG_SHARE, Math.max(0, distanceM(fix, first.pin) / legLen)) : 1;
      driveMin = Math.max((leg ?? direct) * share, direct);
    } else {
      driveMin = leg ?? 0;
    }
    const etaAt = new Date(start + driveMin * MIN);
    push(first, etaAt);
    departAt = etaAt.getTime() + (first.plannedServiceMin ?? 0) * MIN;
  }
  let prev = first;
  for (const s of ahead.slice(1)) {
    const leg = plannedLeg(prev, s, i.departMin) ?? (prev.pin && s.pin ? straightMin(prev.pin, s.pin, i.avgSpeedKmh, i.distanceMultiplier) : 0);
    const etaAt = new Date(departAt + leg * MIN);
    push(s, etaAt);
    departAt = etaAt.getTime() + (s.plannedServiceMin ?? 0) * MIN;
    prev = s;
  }
  return out;
}
