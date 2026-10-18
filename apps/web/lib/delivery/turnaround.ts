/**
 * The turnaround at the depot between two trips of a truck (owner decision of 16 Oct 2026: alert rule R2
 * "loading took more than 40 min" is measured from the driver's taps, not from a warehouse press). Pure
 * and browser-safe: the alert rules (lib/alerts/rules.ts), the plan screen's load row
 * (lib/delivery/outcome-view.ts) and the replay read the same numbers.
 *
 * From the driver's Back at depot of trip N (or, for a trip planned after it - added by a late order or
 * planned again by a re-plan - from when it was planned: no loading before there is a load) to the
 * truck leaving the depot with trip N+1:
 * - the driver's "Leaving for next load" tap on trip N+1 (StopEvent DEPOT_DEPART, lib/delivery/event-service.ts):
 *   the LATEST tap before the truck reached a stop of the trip, so a tap made too early is corrected by
 *   tapping again (second review of 16 Oct 2026, finding 2);
 * - without the tap, a fallback, marked as such: the dispatcher's Dispatch press of trip N+1 (whatever its
 *   status now: completing the load does not lose it), never one before Back at depot (Dispatch is
 *   sometimes pressed for every load in the morning: that is not the truck leaving); else the first sign
 *   of the truck at a stop of trip N+1 (arrival, departure, the phone's result or photo) less the planned
 *   drive from the depot to the first stop ("left by");
 * - a tap only after that first sign (tapped late, at the customer): the sign is used.
 * GPS tracking ALERTS (owner request 18 Oct 2026, lib/alerts/gps.ts; only the alert rule R2 passes it, never
 * the load row): the trail's observed depot OUT after Back at depot (`gpsLeftAt`) stands in for a missing
 * Leaving tap ahead of the fallbacks (the Dispatch press, the first stop reached): it is when the truck
 * really left. The rule may also pass the trail's depot IN as `backAt` when Back at depot was not tapped.
 * Not measured (no number, never "still at the depot"): trip N+1 had started before Back at depot of trip N
 * was tapped (Back at depot tapped late: BACK_LATE); a Completed load with nothing that says when it left
 * (NO_LEAVE). Nothing without Back at depot (the "Load not closed" rule follows a trip without it) and
 * nothing for the truck-day's first trip (loaded the night before): previousTrip gives null.
 */

/** A truck still not left this long after Back at depot is no longer followed (R2) / shown as "no leave recorded". */
export const TURNAROUND_MAX_MIN = 4 * 60;

/** How the leave time is known: the driver's tap, the trail's depot OUT (GPS alerts), or a fallback (the Dispatch press, the first stop reached). */
export type LeftHow = 'TAP' | 'GPS' | 'DISPATCH' | 'ARRIVAL';

/** BACK_LATE: Back at depot of the trip before was tapped after this trip had started; NO_LEAVE: Completed, nothing says when it left. */
export type NotMeasured = 'BACK_LATE' | 'NO_LEAVE';

export interface TurnaroundIn {
  /** Back at depot of the trip before (the earliest tap); null: not tapped. */
  backAt: Date | null;
  /** The driver's Leaving for next load taps on this trip, any order ([]: none). */
  leftTaps: readonly Date[];
  /** This trip's Dispatch press, whatever its status now; null: not pressed (or not known). */
  dispatchAt: Date | null;
  /** The first sign of the truck at a stop of this trip (firstSignOf); null: none yet. */
  firstSignAt: Date | null;
  /** The planned drive from the depot to the trip's first stop, minutes (plannedDriveOf); null: not known. */
  plannedDriveMin?: number | null;
  /** When this load was planned (the first plan version it was copied from: day-results.ts loadOrigins); null: not known. */
  existedAt?: Date | null;
  /** The load is Completed: never "still at the depot". */
  completed?: boolean;
  /** GPS tracking ALERTS: the trail's observed depot OUT the truck left with after Back at depot; absent or null: none. */
  gpsLeftAt?: Date | null;
  now: Date;
}

export interface Turnaround {
  /** Back at depot of the trip before. */
  backAt: Date;
  /** Where the count starts: Back at depot, or when this trip was planned if that came later. */
  startAt: Date;
  /** The trip was planned (added, or planned again by a re-plan) after Back at depot of the trip before: counted from then. */
  addedLater: boolean;
  /** When the truck left with this trip; null: still at the depot (or not measured). */
  leftAt: Date | null;
  how: LeftHow | null;
  /** ARRIVAL with Leaving taps that all came after the first sign at a stop (tapped late, at the customer). */
  tapLate: boolean;
  /** ARRIVAL: the first sign at a stop, from which the planned drive (driveMin) was taken off. */
  signAt: Date | null;
  driveMin: number;
  /** Final minutes (left), or the minutes so far (waiting: now - startAt); 0 when not measured; never negative. */
  minutes: number;
  /**
   * While waiting with the Dispatch press already behind (pressed before Back at depot), no Leaving tap and
   * no stop reached: the truck may be on the road without a sign, so a live alert allows this planned
   * drive to the first stop first (second review of 16 Oct 2026, M1). 0 otherwise.
   */
  graceMin: number;
  /** The truck left (the minutes are final). */
  final: boolean;
  notMeasured: NotMeasured | null;
}

const minutesBetween = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 60_000);
const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/**
 * The driver's Leaving for next load tap that says when the truck left: the LATEST tap up to `now` made at
 * or before the first sign of the truck at a stop of the trip (every tap up to `now` when there is no sign
 * yet). A tap made too early is corrected by tapping again; a tap only after the first sign (tapped late,
 * at the customer) is not the leave. Null: no such tap. Shared by turnaroundOf (rule R2, the load row) and
 * the truck day page's timeline (lib/ivms/truck-day.ts; review of 18 Oct 2026), so both name one time.
 */
export function countedLeaveTap(leftTaps: readonly Date[], firstSignAt: Date | null, now: Date): Date | null {
  const sign = firstSignAt && firstSignAt.getTime() <= now.getTime() ? firstSignAt : null;
  let best: Date | null = null;
  for (const t of leftTaps) {
    if (t.getTime() > now.getTime() || (sign && t.getTime() > sign.getTime())) continue;
    if (!best || t.getTime() > best.getTime()) best = t;
  }
  return best;
}

/** The turnaround of one trip from the facts above (null: no Back at depot of the trip before). */
export function turnaroundOf(i: TurnaroundIn): Turnaround | null {
  if (!i.backAt) return null;
  const back = i.backAt;
  const now = i.now.getTime();
  const existed = i.existedAt && i.existedAt.getTime() > back.getTime() ? i.existedAt : null;
  const start = existed ?? back;
  const drive = i.plannedDriveMin && i.plannedDriveMin > 0 ? Math.round(i.plannedDriveMin) : 0;
  const sign = i.firstSignAt && i.firstSignAt.getTime() <= now ? i.firstSignAt : null;
  const taps = i.leftTaps.filter((t) => t.getTime() <= now).sort((a, b) => a.getTime() - b.getTime());
  const base: Turnaround = { backAt: back, startAt: start, addedLater: !!existed, leftAt: null, how: null, tapLate: false, signAt: null, driveMin: 0, minutes: 0, graceMin: 0, final: false, notMeasured: null };
  const notMeasured = (why: NotMeasured): Turnaround => ({ ...base, notMeasured: why });
  // Trip N+1 had started before Back at depot of trip N was tapped: Back at depot came late, no number.
  if (sign && sign.getTime() < back.getTime()) return notMeasured('BACK_LATE');
  // The latest tap before the truck reached a stop (a tap made too early is corrected by tapping again).
  const tap = countedLeaveTap(taps, sign, i.now);
  if (tap && tap.getTime() < back.getTime()) return notMeasured('BACK_LATE');
  const left = (at: Date, how: LeftHow, extra: Partial<Turnaround> = {}): Turnaround => {
    const leftAt = later(at, start);
    return { ...base, ...extra, leftAt, how, minutes: minutesBetween(start, leftAt), final: true };
  };
  if (tap) return left(tap, 'TAP');
  // GPS (ALERTS): the trail's depot OUT, after the count starts and before the first stop reached.
  const gps = i.gpsLeftAt && i.gpsLeftAt.getTime() >= start.getTime() && i.gpsLeftAt.getTime() <= now && (!sign || i.gpsLeftAt.getTime() <= sign.getTime()) ? i.gpsLeftAt : null;
  if (gps) return left(gps, 'GPS');
  const dispatch = i.dispatchAt && i.dispatchAt.getTime() >= start.getTime() && i.dispatchAt.getTime() <= now ? i.dispatchAt : null;
  if (dispatch && (!sign || dispatch.getTime() <= sign.getTime())) return left(dispatch, 'DISPATCH');
  if (sign) return left(new Date(sign.getTime() - drive * 60_000), 'ARRIVAL', { signAt: sign, driveMin: drive, tapLate: taps.length > 0 });
  if (i.completed) return notMeasured('NO_LEAVE');
  // Still at the depot, as far as anything says. Pressed before Back at depot: the truck may be on the road.
  const pressedBefore = !!i.dispatchAt && !dispatch && i.dispatchAt.getTime() <= now;
  return { ...base, minutes: minutesBetween(start, i.now), graceMin: pressedBefore ? drive : 0 };
}

/**
 * The trip the truck came back from before `id`: the truck-day's load before it in departure order
 * (planned departure, then load number), or null for the first trip of the day.
 */
export function previousTrip<L extends { id: string; departMin: number; loadNo: number }>(dayLoads: readonly L[], id: string): L | null {
  const sorted = [...dayLoads].sort((a, b) => a.departMin - b.departMin || a.loadNo - b.loadNo);
  const i = sorted.findIndex((l) => l.id === id);
  return i > 0 ? sorted[i - 1]! : null;
}

/** A stop's visit as the turnaround reads it. */
export interface SignVisit {
  arrivedAt: Date | null;
  departedAt: Date | null;
  outcomeAt: Date | null;
  outcomeSource: string | null;
}

/**
 * The first sign of the truck at one of a trip's stops: an arrival or a departure (the office's Arrived /
 * Left are times it entered for the stop), a result from the phone, a photo the phone took there
 * (`phonePhotoTimes`: the caller leaves out office uploads and old gallery photos). A result the office
 * recorded is not one (its time is when it was typed). Null: none.
 */
export function firstSignOf(visits: readonly (SignVisit | null | undefined)[], phonePhotoTimes: readonly Date[] = []): Date | null {
  let first: Date | null = null;
  const take = (d: Date | null | undefined) => {
    if (d && (!first || d.getTime() < first.getTime())) first = d;
  };
  for (const v of visits) {
    if (!v) continue;
    take(v.arrivedAt);
    take(v.departedAt);
    if (v.outcomeSource !== 'DISPATCHER') take(v.outcomeAt);
  }
  for (const p of phonePhotoTimes) take(p);
  return first;
}

/** The planned drive from the depot to the trip's first stop (its ETA - the planned departure); null: not known. */
export function plannedDriveOf(departMin: number, stops: readonly { sequence: number; etaMin: number | null }[]): number | null {
  const first = [...stops].sort((a, b) => a.sequence - b.sequence).find((s) => s.etaMin !== null && Number.isFinite(s.etaMin));
  if (!first || first.etaMin === null) return null;
  const d = first.etaMin - departMin;
  return d >= 0 ? d : null;
}

/** How the leave time is known, in words: "Leaving tapped", "the Dispatch press (no Leaving tap)". `clock`: hh:mm in the company's time. */
export function leftHowText(t: Pick<Turnaround, 'how' | 'tapLate' | 'signAt' | 'driveMin'>, clock: (d: Date) => string): string {
  if (t.how === 'TAP') return 'Leaving tapped';
  if (t.how === 'GPS') return 'the GPS depot exit (no Leaving tap)';
  if (t.how === 'DISPATCH') return 'the Dispatch press (no Leaving tap)';
  if (t.how === 'ARRIVAL') {
    const sign = t.signAt ? ` at ${clock(t.signAt)}` : '';
    const drive = t.driveMin ? ` less the planned ${t.driveMin} min drive` : '';
    return `the first stop reached${sign}${drive} (${t.tapLate ? 'Leaving tapped later' : 'no Leaving tap'})`;
  }
  return '';
}

/** "48 min", "1 h 05 min", "2 h" (the alert texts' fmtDuration). */
export function turnaroundMinutesText(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')} min` : `${h} h`;
}

/**
 * The load row's line: "back 10:42, left 11:30, 48 min" (with "(Dispatch press)", or "left by 11:15 (first
 * stop reached 11:30, less the planned 15 min drive)" for a fallback), "back 10:42, not left yet, 25 min so
 * far"; "no leave recorded" once that is over TURNAROUND_MAX_MIN, on a day that is over (`dayOver`) or on a
 * Completed load without a leave; "tapped after this trip had started: not measured" (BACK_LATE). A trip
 * planned after Back at depot names when ("trip planned 15:00"). `clock` formats an instant as hh:mm in
 * the company's time zone.
 */
export function turnaroundLine(t: Turnaround, clock: (d: Date) => string, opts: { dayOver?: boolean } = {}): string {
  const back = `back ${clock(t.backAt)}${t.addedLater ? `, trip planned ${clock(t.startAt)}` : ''}`;
  if (t.notMeasured === 'BACK_LATE') return `back ${clock(t.backAt)}, tapped after this trip had started: not measured`;
  if (t.notMeasured === 'NO_LEAVE') return `${back}, no leave recorded`;
  if (!t.final || !t.leftAt) {
    if (opts.dayOver || t.minutes > TURNAROUND_MAX_MIN) return `${back}, no leave recorded`;
    return `${back}, not left yet, ${turnaroundMinutesText(t.minutes)} so far`;
  }
  if (t.how === 'ARRIVAL') {
    const how = t.signAt ? ` (first stop reached ${clock(t.signAt)}${t.driveMin ? `, less the planned ${t.driveMin} min drive` : ''})` : ' (first stop reached)';
    return `${back}, left by ${clock(t.leftAt)}${how}, ${turnaroundMinutesText(t.minutes)}`;
  }
  const how = t.how === 'DISPATCH' ? ' (Dispatch press)' : t.how === 'GPS' ? ' (GPS)' : '';
  return `${back}, left ${clock(t.leftAt)}${how}, ${turnaroundMinutesText(t.minutes)}`;
}
