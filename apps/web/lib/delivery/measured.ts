/**
 * Measured unloading time per customer (owner request 4 Oct 2026, spec section 11.1, D9a). Pure and
 * browser-safe: the customer dialog on Daily dispatch and the Customers page show it next to the
 * planned time, and "Use measured time" puts it in the unloading-time field (the dispatcher saves it:
 * nothing changes by itself).
 *
 * Only visits the page SAW count: an observed automatic arrival (or Ayun later) to an observed
 * departure, else to the driver's result tapped at the stop (autoServiceMinutes, rebuilt in visit.ts).
 * It is measured from the service start (max of the arrival and the window start), so a truck waiting
 * for the shop to open is not unloading; a visit across the planned break, an unverified timing
 * (timingSuspect), a result recorded after the trip closed (late) and outliers (under 1 min, or above
 * min(240, planned + 60)) are left out. The per-case part of the planned time is taken off, so the
 * figure is the customer's BASE time, the same base as Customer.avgServiceTimeMin (every visit of a
 * split delivery takes the full base time plus its own cases: rule of 29 Sep), and split visits count.
 */
import { fmtDayMonth } from '../dispatch/time';

/** At most this many recent visits are used; fewer than MIN_VISITS gives no measured time. */
export const MEASURED_LAST = 10;
export const MEASURED_MIN_VISITS = 3;
/** A measured unloading above this is never a normal visit. */
export const MEASURED_MAX_MIN = 240;
/** Nor more than this above the planned unloading of the visit. */
export const MEASURED_OVER_PLAN_MIN = 60;

export interface MeasuredVisit {
  outcome: string | null;
  autoServiceMinutes: number | null;
  timingSuspect: boolean;
  outcomeLate: boolean;
  /** The visit's planned unloading (departure - service start), minutes. */
  plannedServiceMin: number | null;
  casesDelivered: number | null;
  autoArrivedAt: Date | string | null;
  /** YYYY-MM-DD */
  deliveryDate: string;
}

export interface MeasuredUnloading {
  /** The customer's measured base unloading time, whole minutes. */
  minutes: number;
  /** Timed visits used (3 to 10). */
  n: number;
  /** The delivery dates of the oldest and newest visit used (YYYY-MM-DD). */
  from: string;
  to: string;
}

/** A visit that may feed the measured time (spec section 11.1). */
export function eligibleForMeasured(v: MeasuredVisit): boolean {
  if (v.outcome !== 'DELIVERED' && v.outcome !== 'PARTLY_DELIVERED') return false;
  if (v.autoServiceMinutes === null || !Number.isFinite(v.autoServiceMinutes)) return false;
  if (v.timingSuspect || v.outcomeLate) return false;
  const cap = Math.min(MEASURED_MAX_MIN, v.plannedServiceMin !== null ? v.plannedServiceMin + MEASURED_OVER_PLAN_MIN : MEASURED_MAX_MIN);
  return v.autoServiceMinutes >= 1 && v.autoServiceMinutes <= cap;
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const time = (v: MeasuredVisit) => (v.autoArrivedAt ? new Date(v.autoArrivedAt).getTime() : 0);

/**
 * The customer's measured base unloading time: the median of base = max(0, autoServiceMinutes -
 * serviceMinPerCase x casesDelivered) over its last 10 eligible visits (newest arrival first); null
 * with fewer than 3.
 */
export function measuredUnloading(visits: readonly MeasuredVisit[], serviceMinPerCase: number): MeasuredUnloading | null {
  const used = visits
    .filter(eligibleForMeasured)
    .sort((a, b) => time(b) - time(a))
    .slice(0, MEASURED_LAST);
  if (used.length < MEASURED_MIN_VISITS) return null;
  const perCase = Math.max(0, serviceMinPerCase || 0);
  const bases = used.map((v) => Math.max(0, v.autoServiceMinutes! - perCase * Math.max(0, v.casesDelivered ?? 0)));
  const dates = used.map((v) => v.deliveryDate).sort();
  return { minutes: Math.round(median(bases)), n: used.length, from: dates[0]!, to: dates[dates.length - 1]! };
}

/** What "Use measured time" sends: avgServiceTimeMin, clamped to 1..480 like the field. */
export function measuredServiceValue(m: MeasuredUnloading): number {
  return Math.min(480, Math.max(1, Math.round(m.minutes)));
}

/**
 * "Unloading: 20 min planned · measured 34 min (median of 7 timed visits, 12 Sep - 3 Oct)", or the
 * planned time alone with why nothing is measured yet.
 */
export function measuredText(plannedMin: number, m: MeasuredUnloading | null): string {
  if (!m) return `Unloading: ${plannedMin} min planned · not measured yet (needs ${MEASURED_MIN_VISITS} timed visits)`;
  const range = m.from === m.to ? fmtDayMonth(m.from) : `${fmtDayMonth(m.from)} - ${fmtDayMonth(m.to)}`;
  return `Unloading: ${plannedMin} min planned · measured ${m.minutes} min (median of ${m.n} timed visits, ${range})`;
}
