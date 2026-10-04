/**
 * Delivery outcome KPIs (owner request 4 Oct 2026, spec section 11.4, D9d). Pure: the day screen's
 * Deliveries card, the dashboard's Deliveries tile and the actuals Excel's Summary sheet compute them
 * from the same rows, so they never disagree.
 *
 * - In scope: deliveries after the local date of TenantConfig.outcomesSince (the migration time for an
 *   existing company), or of a truck-day that has a driver link or a visit. On the deploy day the
 *   no-result counts are therefore not 2,000 old stops.
 * - A stop is a dispatched stop (a stop of a DISPATCHED or COMPLETED load of the plan in use); a stop
 *   without a result counts as delivered elsewhere (Bring forward) but is "no result" here.
 * - On time: only arrivals that were OBSERVED (an automatic arrival the page saw, a manual or office
 *   arrival, Ayun later) and not flagged as unverified timing, at a stop with a window; an early
 *   arrival that waits for the window counts as inside; an open end is unbounded.
 */
import { eligibleForMeasured, type MeasuredVisit } from './measured';
import { countOf } from './office-text';

export interface KpiVisit extends MeasuredVisit {
  reason: string | null;
  casesPlanned: number;
  arrivedAt: Date | string | null;
  arrivalSource: string | null;
  arrivalObserved: boolean;
  windowStartMin: number | null;
  windowEndMin: number | null;
  noPhotoReason: string | null;
  /** zonedDayStart of the delivery date (local minutes of an arrival are counted from it). */
  dayStart: Date | string;
}

export interface KpiReasonRow {
  reason: string;
  stops: number;
  cases: number;
}

export interface DeliveryKpis {
  /** Dispatched stops in scope. */
  stops: number;
  withResult: number;
  delivered: number;
  partly: number;
  notDelivered: number;
  noResult: number;
  /** Delivered in full / with a result, percent (1 decimal); null without results. */
  deliveredInFullPct: number | null;
  casesPlanned: number;
  casesDelivered: number;
  casesDeliveredPct: number | null;
  /** Not delivered (NOT_DELIVERED and the missing cases of PARTLY) per reason, most cases first. */
  byReason: KpiReasonRow[];
  /** Observed, verified arrivals at stops with a window. */
  timedArrivals: number;
  insideWindow: number;
  insideWindowPct: number | null;
  /** Mean of (measured - planned) unloading over the visits that feed measured times; null without any. */
  avgUnloadDeltaMin: number | null;
  unloadSample: number;
  /** Delivered / partly saved without a photo because the camera failed (driver). */
  cameraFailed: number;
  /** Results recorded after the trip closed. */
  late: number;
}

/** Spec section 9.1 item 7 / 11.4: a delivery day of a truck counts from the feature's start. */
export function inOutcomeScope(dateIso: string, sinceLocalDate: string | null, truckDayHasLinkOrVisit: boolean): boolean {
  return truckDayHasLinkOrVisit || sinceLocalDate === null || dateIso > sinceLocalDate;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/** Arrival source kinds whose time the office can trust as "when the truck was there". */
export function arrivalIsObserved(v: Pick<KpiVisit, 'arrivedAt' | 'arrivalSource' | 'arrivalObserved' | 'timingSuspect'>): boolean {
  if (!v.arrivedAt || !v.arrivalSource || v.timingSuspect) return false;
  if (v.arrivalSource === 'PHONE_AUTO' || v.arrivalSource === 'AYUN') return v.arrivalObserved;
  return v.arrivalSource === 'PHONE_MANUAL' || v.arrivalSource === 'DISPATCHER';
}

/** Minutes after the delivery day's local midnight of an instant. */
export function minutesFromDayStart(at: Date | string, dayStart: Date | string): number {
  return Math.floor((new Date(at).getTime() - new Date(dayStart).getTime()) / 60_000);
}

/** Inside the window: at or before its end (an early arrival waits; an open end is unbounded). Null: no window or no usable arrival. */
export function arrivedInsideWindow(v: KpiVisit): boolean | null {
  if (v.windowStartMin === null && v.windowEndMin === null) return null;
  if (!arrivalIsObserved(v)) return null;
  if (v.windowEndMin === null) return true;
  return minutesFromDayStart(v.arrivedAt!, v.dayStart) <= v.windowEndMin;
}

/** The KPIs of a set of dispatched stops in scope (null = no visit or no result yet). */
export function deliveryKpis(stops: readonly (KpiVisit | null)[]): DeliveryKpis {
  const out: DeliveryKpis = {
    stops: stops.length,
    withResult: 0,
    delivered: 0,
    partly: 0,
    notDelivered: 0,
    noResult: 0,
    deliveredInFullPct: null,
    casesPlanned: 0,
    casesDelivered: 0,
    casesDeliveredPct: null,
    byReason: [],
    timedArrivals: 0,
    insideWindow: 0,
    insideWindowPct: null,
    avgUnloadDeltaMin: null,
    unloadSample: 0,
    cameraFailed: 0,
    late: 0,
  };
  const reasons = new Map<string, KpiReasonRow>();
  let deltaSum = 0;
  for (const v of stops) {
    if (v) {
      const inside = arrivedInsideWindow(v);
      if (inside !== null) {
        out.timedArrivals++;
        if (inside) out.insideWindow++;
      }
    }
    if (!v || !v.outcome) {
      out.noResult++;
      continue;
    }
    out.withResult++;
    if (v.outcome === 'DELIVERED') out.delivered++;
    else if (v.outcome === 'PARTLY_DELIVERED') out.partly++;
    else out.notDelivered++;
    const delivered = Math.max(0, Math.min(v.casesPlanned, v.casesDelivered ?? 0));
    out.casesPlanned += v.casesPlanned;
    out.casesDelivered += delivered;
    const missing = v.casesPlanned - delivered;
    if (v.outcome !== 'DELIVERED' && missing > 0) {
      const key = v.reason ?? 'UNKNOWN';
      const r = reasons.get(key) ?? { reason: key, stops: 0, cases: 0 };
      r.stops++;
      r.cases += missing;
      reasons.set(key, r);
    }
    if (v.noPhotoReason === 'CAMERA_FAILED') out.cameraFailed++;
    if (v.outcomeLate) out.late++;
    if (eligibleForMeasured(v) && v.plannedServiceMin !== null) {
      deltaSum += v.autoServiceMinutes! - v.plannedServiceMin;
      out.unloadSample++;
    }
  }
  out.deliveredInFullPct = pct(out.delivered, out.withResult);
  out.casesDeliveredPct = pct(out.casesDelivered, out.casesPlanned);
  out.insideWindowPct = pct(out.insideWindow, out.timedArrivals);
  out.avgUnloadDeltaMin = out.unloadSample ? Math.round((deltaSum / out.unloadSample) * 10) / 10 : null;
  out.byReason = [...reasons.values()].sort((a, b) => b.cases - a.cases || b.stops - a.stops || a.reason.localeCompare(b.reason));
  return out;
}

/** The Deliveries card's first line: "212 of 300 stops have a result · 196 delivered in full · 9 partly · 7 not delivered · 88 no result yet". */
export function kpiHeadline(k: DeliveryKpis): string {
  if (!k.stops) return 'No dispatched stops yet.';
  return `${k.withResult} of ${countOf(k.stops, 'stop')} ${k.stops === 1 ? 'has' : 'have'} a result · ${k.delivered} delivered in full · ${k.partly} partly · ${k.notDelivered} not delivered · ${k.noResult} no result yet`;
}

/** "Arrived inside the window 91 % (of 140 observed arrivals)", or null without an observed arrival. */
export function kpiOnTimeText(k: DeliveryKpis): string | null {
  return k.timedArrivals ? `Arrived inside the window ${k.insideWindowPct} % (of ${countOf(k.timedArrivals, 'observed arrival')})` : null;
}
