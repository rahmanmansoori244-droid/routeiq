/**
 * The turnaround at the depot between two trips of a truck (owner decision of 16 Oct 2026: alert rule R2
 * "loading took more than 40 min" is measured from the driver's taps, not from a warehouse press). Pure
 * and browser-safe: the alert rules (lib/alerts/rules.ts), the plan screen's load row and the day screen
 * (lib/delivery/outcome-view.ts) read the same numbers.
 *
 * From the driver's Back at depot of trip N to the truck leaving the depot with trip N+1:
 * - the driver's "Leaving for next load" tap on trip N+1 (StopEvent DEPOT_DEPART, lib/delivery/event-service.ts);
 * - without the tap, a fallback, marked as such: the dispatcher's Dispatch press of trip N+1 or the first
 *   arrival at a stop of trip N+1, whichever came first, never one before Back at depot (Dispatch is
 *   sometimes pressed for every load in the morning: that is not the truck leaving);
 * - a tap after that first arrival (tapped late, at the customer): the arrival is when the truck had left.
 * Nothing without Back at depot (the "Load not closed" rule follows a trip without it) and nothing for the
 * truck-day's first trip (loaded the night before): previousTrip gives null.
 */

/** How the leave time is known: the driver's tap, or a fallback (the Dispatch press, the first arrival). */
export type LeftHow = 'TAP' | 'DISPATCH' | 'ARRIVAL';

export interface TurnaroundIn {
  /** Back at depot of the trip before (the earliest tap); null: not tapped. */
  backAt: Date | null;
  /** Leaving for next load of this trip (the earliest tap); null: not tapped. */
  leftTapAt: Date | null;
  /** This trip's Dispatch press, when known (a DISPATCHED load's status time); null otherwise. */
  dispatchAt: Date | null;
  /** The first arrival at a stop of this trip; null: none yet. */
  firstArrivalAt: Date | null;
  now: Date;
}

export interface Turnaround {
  backAt: Date;
  /** When the truck left with this trip; null: still at the depot. */
  leftAt: Date | null;
  how: LeftHow | null;
  /** The driver tapped Leaving only after the first arrival: the arrival is used (how ARRIVAL). */
  tapLate: boolean;
  /** Final minutes (left), or the minutes so far (waiting: now - Back at depot); never negative. */
  minutes: number;
  /** The truck left (the minutes are final). */
  final: boolean;
}

const after = (d: Date | null, from: Date): Date | null => (d && d.getTime() >= from.getTime() ? d : null);
const minutesBetween = (a: Date, b: Date) => Math.max(0, (b.getTime() - a.getTime()) / 60_000);

/** The turnaround of one trip from the facts above (null: no Back at depot of the trip before). */
export function turnaroundOf(i: TurnaroundIn): Turnaround | null {
  if (!i.backAt) return null;
  const back = i.backAt;
  const arrival = after(i.firstArrivalAt, back);
  const tap = i.leftTapAt;
  let leftAt: Date | null = null;
  let how: LeftHow | null = null;
  let tapLate = false;
  if (tap) {
    if (arrival && arrival.getTime() < tap.getTime()) {
      leftAt = arrival;
      how = 'ARRIVAL';
      tapLate = true;
    } else {
      // A tap before Back at depot (a clock off, or the office recorded Back at depot later) counts as 0 min.
      leftAt = tap.getTime() < back.getTime() ? back : tap;
      how = 'TAP';
    }
  } else {
    const dispatch = after(i.dispatchAt, back);
    if (dispatch && (!arrival || dispatch.getTime() <= arrival.getTime())) {
      leftAt = dispatch;
      how = 'DISPATCH';
    } else if (arrival) {
      leftAt = arrival;
      how = 'ARRIVAL';
    }
  }
  if (leftAt && leftAt.getTime() > i.now.getTime()) leftAt = null;
  if (!leftAt) return { backAt: back, leftAt: null, how: null, tapLate: false, minutes: minutesBetween(back, i.now), final: false };
  return { backAt: back, leftAt, how, tapLate, minutes: minutesBetween(back, leftAt), final: true };
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

/** How the leave time is known, in words: "Leaving tapped", "the Dispatch press (no Leaving tap)". */
export function leftHowText(t: Pick<Turnaround, 'how' | 'tapLate'>): string {
  if (t.how === 'TAP') return 'Leaving tapped';
  if (t.how === 'DISPATCH') return 'the Dispatch press (no Leaving tap)';
  if (t.how === 'ARRIVAL') return t.tapLate ? 'the first arrival (Leaving tapped later)' : 'the first arrival (no Leaving tap)';
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
 * The load row's line: "back 10:42, left 11:30, 48 min" (with "(Dispatch press)" / "(first arrival)"
 * for a fallback), or "back 10:42, not left yet, 25 min so far". `clock` formats an instant as hh:mm in
 * the company's time zone.
 */
export function turnaroundLine(t: Turnaround, clock: (d: Date) => string): string {
  if (!t.final || !t.leftAt) return `back ${clock(t.backAt)}, not left yet, ${turnaroundMinutesText(t.minutes)} so far`;
  const how = t.how === 'DISPATCH' ? ' (Dispatch press)' : t.how === 'ARRIVAL' ? ' (first arrival)' : '';
  return `back ${clock(t.backAt)}, left ${clock(t.leftAt)}${how}, ${turnaroundMinutesText(t.minutes)}`;
}
