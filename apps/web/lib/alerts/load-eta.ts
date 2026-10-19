/**
 * The input of a dispatched load's expected times, in ONE place (salesman link, owner request 19 Oct 2026;
 * critique item 8: a third ETA engine would drift from the alerts'). Pure and browser-safe. Two readers:
 * - the operations alerts (rules.ts evaluate: R3 ETA_LATE, R5, R6 and everything that reads LoadCtx.proj);
 * - the salesman link's day (lib/sales-link/day.ts): what a salesman is told about his customers.
 * Both therefore read the plan, the driver's taps, the photos and the GPS the same way:
 * - the visit's own copy of the plan first (its unloading and window start, as copied at its first write),
 *   else the stop's: plannedServiceOf / windowStartOf;
 * - a delivery photo of the driver's phone is the truck being at the stop when no arrival was recorded
 *   (M3: firstPhotoAt);
 * - a stop ends at its departure, else at the driver's result (an office result is typed later: never the end);
 * - with GPS (`gps`), a stop with an arrival and nothing that ends it ends where the GPS knows better than
 *   the clock (gps.ts openStayEnd);
 * - the projection starts from the Dispatch press (statusChangedAt of a DISPATCHED load) and the phone's last
 *   sign (`phoneSeenAt`: the newest driver event or phone photo, by receipt time);
 * - the live GPS ETA of the stops ahead only while the history covers the fresh fix (gps.ts historyCoversFix,
 *   review of 18 Oct 2026 finding 1) - else a stop served since the last pull still looks ahead.
 * Moved here from rules.ts without a change of behaviour (tests/lib/alert-*.spec.ts unchanged).
 */
import type { EtaStop, StopEta } from '../ivms/eta';
import type { GpsTruckDayFact } from '../ivms/types';
import { atStopRadiusOf, gpsLiveOf, historyCoversFix, liveAt, liveEtasOf, openStayEnd, type AlertGpsSettings } from './gps';
import type { ProjectionIn, ProjectionStopIn } from './projection';
import { minutesOnDate } from './text';

/** A delivery photo, as far as the expected times read it. */
export interface EtaFactPhoto {
  /** PHONE_AUTO / PHONE_MANUAL (the driver's phone) or DISPATCHER (added in the office); absent (an older export): the phone. */
  source?: string;
  /** A gallery photo (its own time well before the arrival or the Dispatch). */
  oldPhoto?: boolean;
  takenAt?: Date;
  receivedAt: Date;
}

/** A stop's visit, as far as the expected times read it (rules.ts FactVisit has these fields). */
export interface EtaFactVisit {
  arrivedAt: Date | null;
  arrivalSource: string | null;
  departedAt: Date | null;
  outcome: string | null;
  outcomeAt: Date | null;
  outcomeSource: string | null;
  /** The plan as the visit copied it at its first write (null: take the stop's). */
  plannedServiceMin: number | null;
  windowStartMin: number | null;
  photos: readonly EtaFactPhoto[];
}

/** A planned stop with its visit (rules.ts FactStop has these fields). */
export interface EtaFactStop {
  sequence: number;
  etaMin: number | null;
  serviceStartMin: number | null;
  departureMin: number | null;
  plannedServiceMin: number | null;
  windowStartMin: number | null;
  /** The planned pin, for GPS ("at the stop", the live ETA); never shown. */
  pin?: { lat: number; lng: number } | null;
  /** The customer's GPS site radius (Customer.siteRadiusM). */
  siteRadiusM?: number | null;
  visit: EtaFactVisit | null;
}

const PHONE_SOURCES = new Set(['PHONE_AUTO', 'PHONE_MANUAL']);

/** The window start the stop is judged by: the visit's copy, else the stop's. */
export const windowStartOf = (s: Pick<EtaFactStop, 'windowStartMin' | 'visit'>) => (s.visit?.windowStartMin ?? null) ?? s.windowStartMin;
/** The planned unloading: the visit's copy, else the stop's. */
export const plannedServiceOf = (s: Pick<EtaFactStop, 'plannedServiceMin' | 'visit'>) => (s.visit?.plannedServiceMin ?? null) ?? s.plannedServiceMin;

/** A photo of the driver's phone taken there and then (an office upload or an old gallery photo is no sign of the truck). */
export const phonePhoto = (p: EtaFactPhoto) => (p.source === undefined || PHONE_SOURCES.has(p.source)) && !p.oldPhoto;

/** The first delivery photo the driver's phone took at the stop (null: none). */
export function firstPhotoAt(v: Pick<EtaFactVisit, 'photos'> | null | undefined): Date | null {
  let first: Date | null = null;
  for (const p of v?.photos ?? []) {
    if (!phonePhoto(p)) continue;
    const t = p.takenAt ?? p.receivedAt;
    if (!first || t < first) first = t;
  }
  return first;
}

/** A time the GPS tracker gave (StopVisit arrivalSource / departureSource AYUN). */
const isGps = (source: string | null | undefined) => source === 'AYUN';

/** The GPS the expected times may read: the truck-day's fact and the settings (null: none, the phone and the plan only). */
export interface EtaGps {
  fact: GpsTruckDayFact | null;
  settings: AlertGpsSettings;
}

/**
 * The projection's stops of a load (projection.ts), from its planned stops and their visits. The end of a
 * stop: its departure, else the driver's result; with GPS, an open arrival ends where the GPS knows better
 * (openStayEnd). An arrival: the recorded one, else the first phone photo.
 */
export function projectionStopsOf(stops: readonly EtaFactStop[], o: { date: string; tz: string; now: Date; gps?: EtaGps | null }): ProjectionStopIn[] {
  const gps = o.gps?.fact ?? null;
  return stops.map((s) => {
    const v = s.visit;
    let endAt = v?.departedAt ?? (v?.outcomeAt && v.outcomeSource !== 'DISPATCHER' ? v.outcomeAt : null);
    // GPS: a stop with an arrival and nothing that ends it, where the GPS knows better than the clock
    // (the truck away from it, or a GPS stay the trail lost sight of): its projected end (gps.ts openStayEnd).
    if (gps && o.gps && v?.arrivedAt && !v.departedAt && !v.outcome) {
      endAt = openStayEnd({ arrivedAt: v.arrivedAt, gpsArrival: isGps(v.arrivalSource), plannedServiceMin: plannedServiceOf(s) }, liveAt(gps, s.pin, atStopRadiusOf(o.gps.settings, s.siteRadiusM), o.now), gps, o.now);
    }
    // M3: a delivery photo of the driver's phone is the truck being there, when no arrival was recorded.
    const arrAt = v?.arrivedAt ?? firstPhotoAt(v);
    return {
      sequence: s.sequence,
      etaMin: s.etaMin,
      serviceStartMin: s.serviceStartMin,
      departureMin: s.departureMin,
      plannedServiceMin: plannedServiceOf(s),
      windowStartMin: windowStartOf(s),
      arrivedMin: arrAt ? minutesOnDate(arrAt, o.date, o.tz) : null,
      endMin: endAt ? minutesOnDate(endAt, o.date, o.tz) : null,
      hasOutcome: !!v?.outcome,
    };
  });
}

/** The load the projection input is made for. */
export interface EtaLoad {
  status: string;
  /** YYYY-MM-DD */
  date: string;
  departMin: number;
  returnMin: number;
  /** The latest status move (a DISPATCHED load: the Dispatch press). */
  statusChangedAt: Date | null;
}

/**
 * The projection input of a DISPATCHED load (null for any other status): the planned departure and return,
 * the Dispatch press, now, the late-dispatch threshold (M3), when the phone was last heard, and its stops.
 */
export function projectionInputOf(
  load: EtaLoad,
  stopsIn: ProjectionStopIn[],
  o: { tz: string; now: Date; lateDispatchMin: number | null; phoneSeenAt: Date | null },
): ProjectionIn | null {
  if (load.status !== 'DISPATCHED') return null;
  return {
    departMin: load.departMin,
    returnMin: load.returnMin,
    dispatchMin: load.statusChangedAt ? minutesOnDate(load.statusChangedAt, load.date, o.tz) : null,
    nowMin: minutesOnDate(o.now, load.date, o.tz),
    lateDispatchMin: o.lateDispatchMin,
    phoneSeenMin: o.phoneSeenAt ? minutesOnDate(o.phoneSeenAt, load.date, o.tz) : null,
    stops: stopsIn,
  };
}

/** The stops as the live GPS ETA reads them (lib/ivms/eta.ts): behind once a result or a departure; at the stop on an open arrival. */
export function liveEtaStopsOf(stops: readonly EtaFactStop[], settings: Pick<AlertGpsSettings, 'atStopRadiusM'>): EtaStop[] {
  return stops.map((s) => ({
    sequence: s.sequence,
    pin: s.pin ?? null,
    etaMin: s.etaMin,
    plannedServiceMin: plannedServiceOf(s),
    done: !!s.visit?.outcome || !!s.visit?.departedAt,
    arrivedAt: s.visit && !s.visit.outcome && !s.visit.departedAt ? s.visit.arrivedAt : null,
    // A big customer's site radius (owner request 19 Oct 2026): at the stop that far from its pin.
    ...(s.siteRadiusM ? { atStopRadiusM: atStopRadiusOf(settings, s.siteRadiusM) } : {}),
  }));
}

/** May the live GPS ETA judge the load's stops now? A fresh fix (LIVE) and the GPS history caught up with it. */
export function liveEtaAllowed(g: GpsTruckDayFact | null | undefined, now: Date): boolean {
  return gpsLiveOf(g, now) === 'LIVE' && historyCoversFix(g);
}

/**
 * The live GPS ETA of a DISPATCHED load's stops ahead (the live map's: lib/ivms/eta.ts through gps.ts
 * liveEtasOf), only while liveEtaAllowed; [] otherwise (the projection then gives the times).
 */
export function loadLiveEtas(
  gps: EtaGps | null | undefined,
  load: { status: string; depotId: string; departMin: number; dayStart: Date; stops: readonly EtaFactStop[] },
  now: Date,
): StopEta[] {
  if (!gps || load.status !== 'DISPATCHED' || !liveEtaAllowed(gps.fact, now)) return [];
  return liveEtasOf(gps.fact, gps.settings, { depotId: load.depotId, departMin: load.departMin, dayStart: load.dayStart, stops: liveEtaStopsOf(load.stops, gps.settings) }, now);
}
