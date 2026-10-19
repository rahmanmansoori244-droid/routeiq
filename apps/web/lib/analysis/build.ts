/**
 * The analysis dataset's builder (owner request 19 Oct 2026: "build on more data for our analysis later and
 * improvement"): one truck-day of plan, visits, the driver's and the office's events and (while it exists)
 * the GPS trail in, the rows of the four fact tables out (prisma/schema.prisma FactTruckDay, FactVisit,
 * FactLeg, FactDepotTurn). Pure and deterministic: no database, no clock (the caller passes `now`).
 * lib/analysis/job.ts reads the inputs and writes the rows.
 *
 * Ported from the GPS study's prototype (d-dataset/build_dataset.py, 19 Oct 2026; its outputs in d-dataset/out)
 * with the study check's corrections:
 * - trips and which load each trip is come from the live stop detector (lib/ivms/stops.ts detectTruckDay:
 *   depot moves, trips, the dispatch-order matching), the same function that wrote the GPS times; a load it
 *   leaves without a trip gets the trip holding most of its arrivals (the prototype's rule). A trip whose
 *   trail ended before the truck came back is closed by the tracker's own depot IN (IvmsEvent DEPOT_IN), as
 *   the study's plan item 8 asked; the truck-day says so (lastInFrom DEVICE_EVENT);
 * - each visit's window runs from leaving the stop before (its GPS site end, else its arrival or departure)
 *   to the next arrival, inside the load's trip; the customer site, the sub-stays, the time away and the
 *   standing spot are lib/analysis/gps.ts siteOf;
 * - unloading is counted three ways, each clipped at the window on BOTH sides (the prototype clipped only
 *   the start, so a stop served before its window opened got a negative "RouteIQ now" unloading: -49.6 min
 *   for one study customer): on site by GPS (unloadSiteMin, the time away left out), from the arrival to
 *   the departure RouteIQ holds (unloadVisitMin), and from the driver's and the office's own times
 *   (unloadTapMin: lib/delivery/visit.ts withoutGpsTimes, the visit as with GPS off). A stop whose site ended
 *   before its window opened was served early: its unloading counts from its arrival and its wait is 0;
 * - nothing measured is ever "bridged": two stays at one customer with a trip away in between keep the trip
 *   away out of the unloading (the check's guard), with its count and minutes beside it;
 * - the truck's distance from the pin at the driver's result tap (more than 500 m: a late result tap) and a
 *   standing spot 120-500 m from the pin (a pin offset) are kept for the office's lists. A pin offset needs
 *   the truck to have stood longer 120 m or more from the pin than within 120 m of it on that visit (review of
 *   19 Oct 2026: at a big site the first drop point is at the pin and the result is saved at a second one
 *   350 m away, the study's pattern; that pin is right, and moving it would make the live detector miss the
 *   main drop point. A 2-min halt at the gate near a wrong pin does not make it right: another study
 *   customer's, a pin to fix).
 *
 * The truck-day (review of 19 Oct 2026, owner request 19 Oct 2026): the trail is read from 21:00 the evening
 * before, only so the detector knows where the truck stood at midnight. A trip that left before the delivery
 * date's midnight is the day before's (a late return after 21:00 counted 10 h out and 55 min of overtime): it
 * is left out of the day's trips and totals, unless the detector gave it a load of this day (the truck stood
 * outside the depot overnight), and then it counts from the truck's first move after midnight. The trail's
 * quality columns describe the date's own trail (from its midnight); a trail with no point on the date is no
 * trail (NO_TRAIL).
 *
 * Refresh (`gps.kind === 'STORED'`): the columns that do not come from the trail are built again from the
 * plan, the visits and the events, the trail's columns are copied from the rows already stored (the trail
 * is gone by then), and so are the settings the rows were first built with. A refresh may instead pass the
 * trail again with `opts.previous` (the job does when the trail was pulled again after the GPS columns were
 * built and is still whole: a late final pull): the GPS columns are then computed again, with the settings
 * and `builtAt` of the stored rows.
 *
 * GPS_NOT_SEEN says the visit's window was searched on the trail and the truck was not seen on site. A stop
 * with no arrival and no result when the facts were built has no window and is never searched: it is not
 * flagged, at the build or at a refresh after a result saved late (review of 19 Oct 2026).
 */
import type { FactDepotTurn, FactLeg, FactTruckDay, FactVisit, Prisma } from '@prisma/client';
import { distanceM } from '../dispatch/snapshots';
import { dateOnly, localMinutes, zonedDayStart } from '../dispatch/time';
import { countedLeaveTap } from '../delivery/turnaround';
import { withoutGpsTimes } from '../delivery/visit';
import { detectTruckDay, prevIndexOf, type DetectedTrip, type DetectorLoad, type ZoneMove } from '../ivms/stops';
import type { DetectorParams, TrailPoint } from '../ivms/types';
import { closestOf, dayTrailFacts, distanceAt, firstMoveOf, frozenRunsOf, kmBetween, overlapMin, siteOf, spikesOf, type AwayPeriod } from './gps';
import { ANALYSIS_VERSION, FACT_JSON_KEEP_BYTES, SITE_RULES, type AwayJson, type FactVisitFlag, type GpsNote, type LastInFrom, type SubstayJson, type UnloadSource } from './types';

type LatLng = { lat: number; lng: number };
const MIN = 60_000;
const ms = (d: Date) => d.getTime();
const minutes = (a: Date, b: Date) => (ms(b) - ms(a)) / MIN;
const r1 = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r0 = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x));
const nonNeg = (x: number | null) => (x === null ? null : Math.max(0, x));
const minDate = (...xs: (Date | null | undefined)[]) => xs.filter((x): x is Date => !!x).reduce<Date | null>((a, b) => (!a || ms(b) < ms(a) ? b : a), null);
const maxDate = (...xs: (Date | null | undefined)[]) => xs.filter((x): x is Date => !!x).reduce<Date | null>((a, b) => (!a || ms(b) > ms(a) ? b : a), null);

/** The rows as stored (the database fills id and tenantId). */
export type FactTruckDayRow = Omit<FactTruckDay, 'id' | 'tenantId'>;
export type FactVisitRow = Omit<FactVisit, 'id' | 'tenantId'>;
export type FactLegRow = Omit<FactLeg, 'id' | 'tenantId'>;
export type FactDepotTurnRow = Omit<FactDepotTurn, 'id' | 'tenantId'>;

export interface TruckDayFacts {
  truckDay: FactTruckDayRow;
  visits: FactVisitRow[];
  legs: FactLegRow[];
  turns: FactDepotTurnRow[];
}

/** The company's settings in force (TenantConfig), with the stop detector's parameters. */
export interface AnalysisSettings {
  tz: string;
  overtimeAfterMin: number;
  serviceMinPerCase: number;
  reloadMinutes: number;
  loadingMinPerCase: number;
  distanceMultiplier: number;
  avgSpeedKmh: number;
  roadTimeFactor: number;
  params: DetectorParams;
  detectorVersion: string;
}

/** One planned stop (the plan rows and the stop snapshot: lib/delivery/day-results.ts stopsOfLoads). */
export interface StopIn {
  sequence: number;
  customerId: string;
  customerCode: string;
  customerType: string | null;
  /** The base unloading the planner gives the stop before the per-case time (lib/analysis/job.ts baseServiceOf); null: not known. */
  baseServiceMin: number | null;
  etaMin: number | null;
  /** RouteAssignment.departureMin: the planned departure from the stop (local minutes). */
  departureMin: number | null;
  plannedServiceMin: number | null;
  windowStartMin: number | null;
  windowEndMin: number | null;
  plannedKmFromPrev: number | null;
  casesPlanned: number;
  pin: LatLng | null;
}

/** One load of the truck-day that left (DISPATCHED or COMPLETED). */
export interface LoadIn {
  depotId: string;
  loadNo: number;
  status: string;
  departMin: number;
  returnMin: number;
  distanceKm: number | null;
  returnLegKm: number | null;
  cases: number;
  /** The Dispatch press (the LOAD_DISPATCHED audit row), else null. */
  dispatchedAt: Date | null;
  /** The depot pin the load was planned from (its snapshot), else the depot's. */
  origin: LatLng | null;
  stops: StopIn[];
}

/** The stored visit (StopVisit), as rebuilt from its events. */
export interface VisitIn {
  id: string;
  depotId: string;
  loadNo: number;
  sequence: number;
  arrivedAt: Date | null;
  arrivalSource: string | null;
  arrivalDistanceM: number | null;
  arrivalAccuracyM: number | null;
  arrivalObserved: boolean;
  departedAt: Date | null;
  departureSource: string | null;
  departedAtOutcome: boolean;
  outcome: string | null;
  reason: string | null;
  outcomeAt: Date | null;
  outcomeSource: string | null;
  casesDelivered: number | null;
  /** The pin the visit was planned with (copied at its first write). */
  plannedLat: number | null;
  plannedLng: number | null;
}

/** A stop event of the truck-day (StopEvent: sequence null = load level). */
export interface EventIn {
  depotId: string;
  loadNo: number;
  sequence: number | null;
  kind: string;
  source: string;
  at: Date;
  receivedAt: Date;
  distanceM: number | null;
  payload: Record<string, unknown> | null;
}

export interface TruckDayIn {
  /** YYYY-MM-DD */
  date: string;
  truckId: string;
  truckCode: string;
  /** The truck had a tracker (Truck.ivmsImei) when built. */
  tracked: boolean;
  /** The truck-day's GPS is suppressed (IvmsTruckDay.suppressedAt: undo, a tracker on another truck, a remap). */
  suppressed: boolean;
  depots: { depotId: string; lat: number; lng: number }[];
  loads: LoadIn[];
  visits: VisitIn[];
  events: EventIn[];
}

/** Where the GPS columns come from. */
export type GpsSource =
  | { kind: 'TRAIL'; points: readonly TrailPoint[]; zoneMoves: readonly ZoneMove[]; deviceIn: readonly Date[] }
  | { kind: 'STORED'; rows: TruckDayFacts }
  /** No usable trail; `note` says why when the job knows better than the builder (PARTIAL_TRAIL). */
  | { kind: 'NONE'; note?: GpsNote };

export interface BuildOptions {
  now: Date;
  /** Set on the last refresh: the rows are frozen (never written again). */
  freeze?: boolean;
  /**
   * The rows already stored, when a refresh computes the GPS columns again from the trail (`gps.kind`
   * TRAIL): their settings and `builtAt` are kept. A STORED source implies its own rows.
   */
  previous?: TruckDayFacts;
}

// ---------------------------------------------------------------------------------------------------
// GPS primitives per visit, leg, turn and day (computed from the trail, or copied from stored rows)

interface VisitGps {
  siteStartAt: Date | null;
  siteEndAt: Date | null;
  away: AwayPeriod[];
  substays: { startAt: Date; endAt: Date; minutes: number; distM: number; bearingDeg: number }[];
  substayCount: number | null;
  dropPoints: number | null;
  maxDistM: number | null;
  closestM: number | null;
  standDistM: number | null;
  standBearingDeg: number | null;
  detectorStays: number | null;
  resultTapAt: Date | null;
  truckDistAtResultM: number | null;
  /** The visit's window was searched on the trail (only then can GPS_NOT_SEEN be said). */
  searched: boolean;
}

interface LegGps {
  leftAt: Date | null;
  arrivedAt: Date | null;
  driveMin: number | null;
  kmGps: number | null;
  note: string | null;
}

type DayGps = Pick<
  FactTruckDayRow,
  'firstOutAt' | 'lastInAt' | 'lastInFrom' | 'outMin' | 'overtimeMin' | 'kmGps' | 'movingMin' | 'atSitesMin' | 'idleStops' | 'idleMin' | 'gpsTrips' | 'trailPoints' | 'trailFrom' | 'trailTo' | 'maxGapMin' | 'gapMinOver5' | 'frozenRuns' | 'frozenMin' | 'spikes' | 'ignitionSeen'
>;

const NO_DAY_GPS: DayGps = {
  firstOutAt: null, lastInAt: null, lastInFrom: null, outMin: null, overtimeMin: null, kmGps: null, movingMin: null, atSitesMin: null, idleStops: null, idleMin: null,
  gpsTrips: null, trailPoints: 0, trailFrom: null, trailTo: null, maxGapMin: null, gapMinOver5: null, frozenRuns: null, frozenMin: null, spikes: null, ignitionSeen: null,
};

const stopKey = (depotId: string, loadNo: number, sequence: number) => `${depotId}|${loadNo}|${sequence}`;
const legKey = (depotId: string, loadNo: number, fromSeq: number | null, toSeq: number | null) => `${depotId}|${loadNo}|${fromSeq ?? 'D'}|${toSeq ?? 'D'}`;
const turnKey = (depotId: string, afterLoadNo: number) => `${depotId}|${afterLoadNo}`;
const PHONE = new Set(['PHONE_AUTO', 'PHONE_MANUAL']);
const DONE = new Set(['DELIVERED', 'PARTLY_DELIVERED']);

/** A JSON array kept under FACT_JSON_KEEP_BYTES (the column's CHECK is 8 KB): the last entries go first. */
function capJson<T>(list: T[]): T[] {
  const kept = [...list];
  while (kept.length && Buffer.byteLength(JSON.stringify(kept), 'utf8') > FACT_JSON_KEEP_BYTES) kept.pop();
  return kept;
}

/** Unloading from `a` to `b`, clipped at the window start on both sides: served before the window counts from `a`. */
export function clippedMinutes(a: Date | null, b: Date | null, windowStartAt: Date | null): number | null {
  if (!a || !b || ms(b) <= ms(a)) return null;
  const before = !!windowStartAt && ms(b) <= ms(windowStartAt);
  const start = before || !windowStartAt ? a : maxDate(a, windowStartAt)!;
  return minutes(start, b);
}

/**
 * Minutes the truck stood on site within 120 m of the pin and 120 m or more from it (the sub-stays, rounded as
 * substaysJson keeps them, so a refresh decides a pin offset exactly as the build did).
 */
export function standingSplit(subs: readonly { distM: number; minutes: number }[]): { nearMin: number; farMin: number } {
  let nearMin = 0;
  let farMin = 0;
  for (const s of subs) {
    const m = Math.round(s.minutes * 10) / 10;
    if (Math.round(s.distM) < SITE_RULES.pinOffsetMinM) nearMin += m;
    else farMin += m;
  }
  return { nearMin, farMin };
}

/** The driver's result tap of a stop: the latest phone OUTCOME event that saved a result (not an undo). */
function resultTapOf(events: readonly EventIn[]): Date | null {
  const taps = events.filter((e) => e.kind === 'OUTCOME' && PHONE.has(e.source) && typeof e.payload?.outcome === 'string');
  return maxDate(...taps.map((e) => e.at));
}

/** The order the truck really drove a load's stops: by the arrival RouteIQ holds (else the result time), then the plan. */
function actualOrderOf(stops: readonly StopIn[], visitOf: (s: StopIn) => VisitIn | null): { stop: StopIn; visit: VisitIn | null; anchor: Date | null }[] {
  return stops
    .map((stop) => {
      const visit = visitOf(stop);
      const anchor = visit?.arrivedAt ?? (visit?.outcome ? visit.outcomeAt : null) ?? null;
      return { stop, visit, anchor };
    })
    .sort((a, b) => (a.anchor ? ms(a.anchor) : Infinity) - (b.anchor ? ms(b.anchor) : Infinity) || a.stop.sequence - b.stop.sequence);
}

/** The settings the stored rows were built with (a refresh never changes them). */
function storedSettings(row: FactTruckDayRow, base: AnalysisSettings): AnalysisSettings {
  return {
    ...base,
    overtimeAfterMin: row.overtimeAfterMin,
    serviceMinPerCase: row.serviceMinPerCase,
    reloadMinutes: row.reloadMinutes,
    loadingMinPerCase: row.loadingMinPerCase,
    distanceMultiplier: row.distanceMultiplier,
    avgSpeedKmh: row.avgSpeedKmh,
    roadTimeFactor: row.roadTimeFactor,
    params: { ...base.params, stopRadiusM: row.stopRadiusM, dwellMin: row.dwellMin },
    detectorVersion: row.detectorVersion,
  };
}

/** A stored visit row's GPS primitives (refresh). */
function visitGpsOfRow(v: FactVisitRow): VisitGps {
  const start = v.siteStartAt;
  const at = (offsetSec: number) => new Date(ms(start!) + offsetSec * 1000);
  const away = start && Array.isArray(v.awayJson) ? (v.awayJson as unknown as AwayJson[]).map((a) => ({ startAt: at(a.startOffsetSec), endAt: new Date(ms(at(a.startOffsetSec)) + a.minutes * MIN), maxDistM: a.maxDistM })) : [];
  const subs =
    start && Array.isArray(v.substaysJson)
      ? (v.substaysJson as unknown as SubstayJson[]).map((s) => ({ startAt: at(s.startOffsetSec), endAt: new Date(ms(at(s.startOffsetSec)) + s.minutes * MIN), minutes: s.minutes, distM: s.distM, bearingDeg: s.bearingDeg }))
      : [];
  return {
    siteStartAt: v.siteStartAt,
    siteEndAt: v.siteEndAt,
    away,
    substays: subs,
    substayCount: v.substays,
    dropPoints: v.dropPoints,
    maxDistM: v.maxDistM,
    closestM: v.closestM,
    standDistM: v.standDistM,
    standBearingDeg: v.standBearingDeg,
    detectorStays: v.detectorStays,
    resultTapAt: v.resultTapAt,
    truckDistAtResultM: v.truckDistAtResultM,
    // Built with a trail, a stop with an arrival or a result then had its window searched (its actual order).
    searched: v.actualOrder !== null,
  };
}

interface Trip {
  outAt: Date;
  inAt: Date | null;
  /** inAt is the tracker's own depot IN (the trail ended before the truck came back). */
  inFromDevice: boolean;
}

/** The trips of the trail (the live detector), each load's own, with open trips closed by the tracker's depot IN. */
function tripsOf(input: TruckDayIn, settings: AnalysisSettings, points: readonly TrailPoint[], zoneMoves: readonly ZoneMove[], deviceIn: readonly Date[], dayStart: Date) {
  const backOf = (l: LoadIn) =>
    minDate(...input.events.filter((e) => e.kind === 'BACK_AT_DEPOT' && (e.source === 'PHONE_MANUAL' || e.source === 'DISPATCHER') && e.depotId === l.depotId && e.loadNo === l.loadNo).map((e) => e.at));
  const visitOf = (l: LoadIn, seq: number) => input.visits.find((v) => v.depotId === l.depotId && v.loadNo === l.loadNo && v.sequence === seq) ?? null;
  const loads: DetectorLoad[] = input.loads.map((l) => ({
    depotId: l.depotId,
    loadNo: l.loadNo,
    status: l.status,
    dispatchedAt: l.dispatchedAt,
    plannedDepartAt: new Date(ms(dayStart) + l.departMin * MIN),
    backAt: backOf(l),
    stops: l.stops.map((s) => {
      const v = visitOf(l, s.sequence);
      const pin = v && v.plannedLat !== null && v.plannedLng !== null ? { lat: v.plannedLat, lng: v.plannedLng } : s.pin;
      return { sequence: s.sequence, pin, resultAt: v?.outcome ? v.outcomeAt : null, officeArrival: v?.arrivalSource === 'DISPATCHER' };
    }),
  }));
  const det = detectTruckDay({ points, depots: input.depots, zoneMoves, loads, params: settings.params });
  // Only the trips of the delivery date. The trail is read from 3 h before its midnight so the detector knows
  // where the truck stood then; a trip that left before the midnight is the day before's (its late return:
  // review of 19 Oct 2026, a trip from 21:00 counted 595 min out and 55 min of overtime for a 65-min day), and
  // is left out - unless the detector gave it a load of this day (the truck stood outside the depot
  // overnight): then it counts from the truck's first move after the midnight, never from the evening before.
  const day0 = ms(dayStart);
  const dayEnd = day0 + 24 * 60 * MIN;
  const ownsLoad = (t: DetectedTrip) => t.loadNo !== null && input.loads.some((l) => l.loadNo === t.loadNo && (t.loadDepotId === null || t.loadDepotId === l.depotId));
  const outOf = new Map<DetectedTrip, Date>();
  for (const t of det.trips) {
    if (ms(t.outAt) >= dayEnd) continue;
    if (ms(t.outAt) >= day0) {
      outOf.set(t, t.outAt);
      continue;
    }
    if (!ownsLoad(t) || (t.inAt && ms(t.inAt) <= day0)) continue;
    const moved = firstMoveOf(points.filter((pt) => ms(pt.fixAt) >= day0 && (!t.inAt || ms(pt.fixAt) <= ms(t.inAt))), settings.params.movingKmh);
    outOf.set(t, moved ?? dayStart);
  }
  const all = [...outOf.keys()].sort((a, b) => ms(outOf.get(a)!) - ms(outOf.get(b)!));
  const trips = new Map<DetectedTrip, Trip>();
  all.forEach((t, i) => {
    let inAt = t.inAt;
    let inFromDevice = false;
    if (!inAt) {
      const nextOut = all[i + 1] ? ms(outOf.get(all[i + 1]!)!) : dayEnd + 6 * 60 * MIN;
      const dev = deviceIn.filter((d) => ms(d) > ms(outOf.get(t)!) && ms(d) < nextOut).sort((a, b) => ms(a) - ms(b))[0];
      if (dev) {
        inAt = dev;
        inFromDevice = true;
      }
    }
    trips.set(t, { outAt: outOf.get(t)!, inAt, inFromDevice });
  });
  const byLoad = new Map<string, Trip[]>();
  const owned = new Set<DetectedTrip>();
  for (const l of input.loads) {
    const mine = all.filter((t) => t.loadNo === l.loadNo && (t.loadDepotId === null || t.loadDepotId === l.depotId));
    mine.forEach((t) => owned.add(t));
    byLoad.set(`${l.depotId}|${l.loadNo}`, mine.map((t) => trips.get(t)!));
  }
  // A load the detector left without a trip: the trip without a load holding most of its arrivals.
  for (const l of input.loads) {
    const k = `${l.depotId}|${l.loadNo}`;
    if (byLoad.get(k)!.length) continue;
    const anchors = l.stops.map((s) => visitOf(l, s.sequence)?.arrivedAt).filter((x): x is Date => !!x);
    let best: DetectedTrip | null = null;
    let hits = 0;
    for (const t of all) {
      if (owned.has(t)) continue;
      const tr = trips.get(t)!;
      const n = anchors.filter((a) => ms(a) >= ms(tr.outAt) && (tr.inAt === null || ms(a) <= ms(tr.inAt))).length;
      if (n > hits) {
        best = t;
        hits = n;
      }
    }
    if (best) {
      owned.add(best);
      byLoad.set(k, [trips.get(best)!]);
    }
  }
  return { all: all.map((t) => trips.get(t)!), byLoad };
}

// ---------------------------------------------------------------------------------------------------
// The builder

export function buildTruckDayFacts(input: TruckDayIn, baseSettings: AnalysisSettings, gps: GpsSource, opts: BuildOptions): TruckDayFacts {
  const now = opts.now;
  const stored = gps.kind === 'STORED' ? gps.rows : (opts.previous ?? null);
  const settings = stored ? storedSettings(stored.truckDay, baseSettings) : baseSettings;
  const p = settings.params;
  const tz = settings.tz;
  const dayStart = zonedDayStart(input.date, tz);
  const deliveryDate = dateOnly(input.date);
  // The trail, sorted; none when no point falls on the delivery date itself (only the evening before).
  const sortedTrail = gps.kind === 'TRAIL' && gps.points.length ? [...gps.points].sort((a, b) => ms(a.fixAt) - ms(b.fixAt)) : null;
  const trail = sortedTrail && ms(sortedTrail[sortedTrail.length - 1]!.fixAt) >= ms(dayStart) ? sortedTrail : null;
  // Without a usable trail now, the stored GPS columns are copied; a refresh of a truck-day built without a
  // usable trail rebuilds it like one without GPS.
  const storedGps = !trail && stored && stored.truckDay.gpsBuiltAt ? stored : null;
  const builtAt = stored?.truckDay.builtAt ?? now;
  const gpsBuiltAt: Date | null = trail ? now : storedGps ? storedGps.truckDay.gpsBuiltAt : null;
  const frozenAt = opts.freeze ? now : null;
  const common = {
    deliveryDate,
    truckId: input.truckId,
    serviceMinPerCase: settings.serviceMinPerCase,
    reloadMinutes: settings.reloadMinutes,
    stopRadiusM: p.stopRadiusM,
    dwellMin: p.dwellMin,
    detectorVersion: settings.detectorVersion,
    analysisVersion: ANALYSIS_VERSION,
    builtAt,
    gpsBuiltAt,
    refreshedAt: now,
    frozenAt,
  };

  const loads = [...input.loads].sort((a, b) => a.departMin - b.departMin || a.loadNo - b.loadNo || a.depotId.localeCompare(b.depotId));
  const visitOf = (l: LoadIn, seq: number) => input.visits.find((v) => v.depotId === l.depotId && v.loadNo === l.loadNo && v.sequence === seq) ?? null;
  const eventsOf = (l: LoadIn, seq: number | null) => input.events.filter((e) => e.depotId === l.depotId && e.loadNo === l.loadNo && e.sequence === seq);
  const pinOf = (l: LoadIn, s: StopIn): LatLng | null => {
    const v = visitOf(l, s.sequence);
    return v && v.plannedLat !== null && v.plannedLng !== null ? { lat: v.plannedLat, lng: v.plannedLng } : s.pin;
  };
  const allStopPins: { key: string; pin: LatLng }[] = [];
  for (const l of loads) for (const s of l.stops) {
    const pin = pinOf(l, s);
    if (pin) allStopPins.push({ key: stopKey(l.depotId, l.loadNo, s.sequence), pin });
  }
  const depotPins = input.depots.map((d) => ({ lat: d.lat, lng: d.lng }));

  // --- GPS primitives
  const visitGps = new Map<string, VisitGps>();
  const legGps = new Map<string, LegGps>();
  const tripByLoad = new Map<string, { outAt: Date | null; inAt: Date | null }>();
  let dayGps: DayGps = NO_DAY_GPS;
  let gpsNote: GpsNote | null = null;
  const sites: { start: Date; end: Date }[] = [];
  if (trail && gps.kind === 'TRAIL') {
    const spikes = spikesOf(trail);
    // The customer sites are found on the trail without its single-point spikes (a spike 5 km away in the
    // middle of an unloading is no trip away); the trips stay the live detector's, on the trail as stored.
    const clean = spikes.size ? trail.filter((_, i) => !spikes.has(i)) : trail;
    const prevIdx = prevIndexOf(clean);
    // The truck's first move on the delivery date (never the evening before, read only for the detector).
    const firstMove = firstMoveOf(clean.filter((pt) => ms(pt.fixAt) >= ms(dayStart)), p.movingKmh);
    const trips = tripsOf(input, settings, trail, gps.zoneMoves, gps.deviceIn, dayStart);
    for (const l of loads) {
      const own = trips.byLoad.get(`${l.depotId}|${l.loadNo}`) ?? [];
      const tripOut = minDate(...own.map((t) => t.outAt));
      const tripIn = own.some((t) => !t.inAt) ? null : maxDate(...own.map((t) => t.inAt));
      tripByLoad.set(`${l.depotId}|${l.loadNo}`, { outAt: tripOut, inAt: tripIn });
      const order = actualOrderOf(l.stops, (s) => visitOf(l, s.sequence));
      let prevEnd: Date | null = null;
      order.forEach((o, k) => {
        const key = stopKey(l.depotId, l.loadNo, o.stop.sequence);
        const pin = pinOf(l, o.stop);
        const resultTapAt = resultTapOf(eventsOf(l, o.stop.sequence));
        const base: VisitGps = {
          siteStartAt: null, siteEndAt: null, away: [], substays: [], substayCount: null, dropPoints: null, maxDistM: null, closestM: null,
          standDistM: null, standBearingDeg: null, detectorStays: null, resultTapAt, truckDistAtResultM: null, searched: false,
        };
        if (!pin) {
          visitGps.set(key, base);
          return;
        }
        base.truckDistAtResultM = resultTapAt ? r0(distanceAt(clean, resultTapAt, pin)) : null;
        // No arrival and no result yet: no window to search (never GPS_NOT_SEEN, even after a late result).
        if (!o.anchor) {
          visitGps.set(key, base);
          return;
        }
        let w0: Date | null = k > 0 ? prevEnd : tripOut;
        if (k === 0 && w0 && ms(o.anchor) < ms(w0)) w0 = new Date(ms(o.anchor) - 60 * MIN); // served before the depot OUT
        if (firstMove && (!w0 || ms(w0) < ms(firstMove))) w0 = firstMove;
        const next = order[k + 1]?.anchor ?? null;
        const w1 = next ?? tripIn;
        const window = clean.filter((pt) => (!w0 || ms(pt.fixAt) > ms(w0)) && (!w1 || ms(pt.fixAt) < ms(w1)));
        const others = [...allStopPins.filter((x) => x.key !== key).map((x) => x.pin), ...depotPins].filter((o2) => distanceM(o2, pin) >= SITE_RULES.siteRadiusM);
        const site = siteOf({ window, pin, sequence: o.stop.sequence, others, resultTapAt, params: p, all: clean, prevIdx });
        const g: VisitGps = { ...base, closestM: r0(closestOf(window, pin)), searched: true };
        if (site) {
          Object.assign(g, {
            siteStartAt: site.siteStartAt,
            siteEndAt: site.siteEndAt,
            away: site.away,
            substays: site.substays,
            substayCount: site.substays.length,
            dropPoints: site.dropPoints,
            maxDistM: r0(site.maxDistM),
            standDistM: r0(site.standDistM),
            standBearingDeg: r0(site.standBearingDeg),
            detectorStays: site.detectorStays,
          });
          sites.push({ start: site.siteStartAt, end: site.siteEndAt });
        }
        visitGps.set(key, g);
        prevEnd = site?.siteEndAt ?? maxDate(o.visit?.arrivedAt, o.visit?.departedAt, o.anchor);
      });
      // The legs in the order driven (the prototype's rules: GPS site and trip times, the visit's where missing).
      const chain = order.filter((o) => o.anchor);
      const lastPointAt = trail[trail.length - 1]!.fixAt;
      let prev: (typeof chain)[number] | null = null;
      for (const f of [...chain, null]) {
        if (!f && !prev) break;
        const pg = prev ? visitGps.get(stopKey(l.depotId, l.loadNo, prev.stop.sequence)) : null;
        const fg = f ? visitGps.get(stopKey(l.depotId, l.loadNo, f.stop.sequence)) : null;
        let leftAt: Date | null = prev ? (pg?.siteEndAt ?? prev.visit?.departedAt ?? null) : tripOut;
        if (!prev && f && leftAt) {
          const reached = minDate(f.visit?.arrivedAt, fg?.siteStartAt);
          if (reached && ms(reached) < ms(leftAt)) leftAt = firstMove; // the first stop reached before the depot OUT
        }
        const arrivedAt: Date | null = f ? (minDate(fg?.siteStartAt, f.visit?.arrivedAt) ?? null) : tripIn;
        let driveMin = leftAt && arrivedAt ? minutes(leftAt, arrivedAt) : null;
        const notes: string[] = [];
        if (driveMin !== null && driveMin < 0) {
          driveMin = 0;
          notes.push('SHARED_SITE');
        }
        if (!leftAt || !arrivedAt || ms(arrivedAt) > ms(lastPointAt)) notes.push('TRAIL_ENDED');
        const kmGps = !notes.includes('TRAIL_ENDED') ? kmBetweenSafe(trail, leftAt, arrivedAt, spikes) : null;
        legGps.set(legKey(l.depotId, l.loadNo, prev?.stop.sequence ?? null, f?.stop.sequence ?? null), { leftAt, arrivedAt, driveMin, kmGps, note: notes.join(' ') || null });
        prev = f;
      }
    }
    // The truck-day: the first depot OUT to the last depot IN (the tracker's own when the trail ended first),
    // over the trips of the delivery date only (tripsOf: the evening before is the day before's).
    const dayTrips = trips.all;
    const firstOut = dayTrips[0]?.outAt ?? null;
    const lastTrip = [...dayTrips].reverse().find((t) => t.inAt);
    const lastIn = lastTrip?.inAt ?? null;
    const lastInFrom: LastInFrom | null = lastTrip ? (lastTrip.inFromDevice ? 'DEVICE_EVENT' : 'TRAIL') : null;
    // The date's own trail (from its midnight): the quality columns, and the span when no trip was seen.
    const own = trail.filter((pt) => ms(pt.fixAt) >= ms(dayStart));
    const ownFrom = trail.length - own.length;
    const spanFrom = firstOut ?? own[0]!.fixAt;
    const spanTo = lastIn ?? trail[trail.length - 1]!.fixAt;
    const facts = dayTrailFacts(trail, spanFrom, spanTo, sites, depotPins, p, spikes);
    const frozen = frozenRunsOf(own);
    const outMin = firstOut && lastIn && ms(lastIn) > ms(firstOut) ? minutes(firstOut, lastIn) : null;
    dayGps = {
      firstOutAt: firstOut,
      lastInAt: lastIn,
      lastInFrom,
      outMin: r1(outMin),
      overtimeMin: outMin === null ? null : r1(Math.max(0, outMin - settings.overtimeAfterMin)),
      kmGps: r2(facts.kmGps),
      movingMin: r1(facts.movingMin),
      atSitesMin: r1(facts.atSitesMin),
      idleStops: facts.idleStops,
      idleMin: r1(facts.idleMin),
      gpsTrips: dayTrips.length,
      trailPoints: own.length,
      trailFrom: own[0]!.fixAt,
      trailTo: own[own.length - 1]!.fixAt,
      maxGapMin: r1(facts.maxGapMin),
      gapMinOver5: r1(facts.gapMinOver5),
      frozenRuns: frozen.runs,
      frozenMin: r1(frozen.minutes),
      spikes: [...spikes].filter((i) => i >= ownFrom).length,
      ignitionSeen: own.some((pt) => pt.ignition !== null),
    };
  } else if (storedGps) {
    for (const v of storedGps.visits) visitGps.set(stopKey(v.depotId, v.loadNo, v.sequence), visitGpsOfRow(v));
    for (const lg of storedGps.legs) legGps.set(legKey(lg.depotId, lg.loadNo, lg.fromSeq, lg.toSeq), { leftAt: lg.leftAt, arrivedAt: lg.arrivedAt, driveMin: lg.driveMin, kmGps: lg.kmGps, note: lg.note });
    const t = storedGps.truckDay;
    dayGps = {
      firstOutAt: t.firstOutAt, lastInAt: t.lastInAt, lastInFrom: t.lastInFrom, outMin: t.outMin, overtimeMin: t.overtimeMin, kmGps: t.kmGps, movingMin: t.movingMin,
      atSitesMin: t.atSitesMin, idleStops: t.idleStops, idleMin: t.idleMin, gpsTrips: t.gpsTrips, trailPoints: t.trailPoints, trailFrom: t.trailFrom, trailTo: t.trailTo,
      maxGapMin: t.maxGapMin, gapMinOver5: t.gapMinOver5, frozenRuns: t.frozenRuns, frozenMin: t.frozenMin, spikes: t.spikes, ignitionSeen: t.ignitionSeen,
    };
  } else {
    // Why there is no GPS; a trail found partly deleted at the build stays PARTIAL_TRAIL on every refresh.
    const partial = (gps.kind === 'NONE' && gps.note === 'PARTIAL_TRAIL') || stored?.truckDay.gpsNote === 'PARTIAL_TRAIL';
    gpsNote = stored?.truckDay.gpsNote === 'SUPPRESSED' || input.suppressed ? 'SUPPRESSED' : !input.tracked ? 'NO_TRACKER' : partial ? 'PARTIAL_TRAIL' : 'NO_TRAIL';
  }
  const hasGps = !!trail || !!storedGps;

  // --- Visits
  const visits: FactVisitRow[] = [];
  const legs: FactLegRow[] = [];
  for (const l of loads) {
    const order = actualOrderOf(l.stops, (s) => visitOf(l, s.sequence));
    const rank = new Map(order.filter((o) => o.anchor).map((o, i) => [o.stop.sequence, i + 1]));
    for (const s of l.stops) {
      const key = stopKey(l.depotId, l.loadNo, s.sequence);
      const v = visitOf(l, s.sequence);
      const evs = eventsOf(l, s.sequence);
      const pin = pinOf(l, s);
      const g = visitGps.get(key) ?? null;
      const winStartAt = s.windowStartMin !== null ? new Date(ms(dayStart) + s.windowStartMin * MIN) : null;
      // The result and its changes (the first saved, by time, then by receipt).
      const outcomes = evs.filter((e) => e.kind === 'OUTCOME').sort((a, b) => ms(a.at) - ms(b.at) || ms(a.receivedAt) - ms(b.receivedAt));
      const first = outcomes[0] ?? null;
      const firstName = first ? (typeof first.payload?.outcome === 'string' ? (first.payload.outcome as string) : 'CLEARED') : null;
      const finalName = v?.outcome ?? (outcomes.length ? 'CLEARED' : null);
      const resultChanged = !!first && firstName !== finalName;
      // The driver's result tap, and the truck's distance from the pin at it (only the tap it was measured at).
      const tapNow = resultTapOf(evs);
      const tapKept = g && g.resultTapAt && tapNow && ms(g.resultTapAt) === ms(tapNow) ? g : null;
      const distAtResult = tapKept ? tapKept.truckDistAtResultM : null;
      // Unloading.
      const own = v ? withoutGpsTimes({ ...v }) : null;
      const unloadVisit = v ? clippedMinutes(v.arrivedAt, v.departedAt, winStartAt) : null;
      const unloadTap = own ? clippedMinutes(own.arrivedAt, own.departedAt, winStartAt) : null;
      let unloadSite: number | null = null;
      let onSite: number | null = null;
      let wait: number | null = null;
      let before: boolean | null = null;
      if (g?.siteStartAt && g.siteEndAt) {
        const s0 = g.siteStartAt;
        const e0 = g.siteEndAt;
        before = !!winStartAt && ms(e0) <= ms(winStartAt);
        const effStart = before || !winStartAt ? s0 : maxDate(s0, winStartAt)!;
        wait = minutes(s0, effStart) - overlapMin(g.away, s0, effStart);
        unloadSite = minutes(effStart, e0) - overlapMin(g.away, effStart, e0);
        onSite = minutes(s0, e0) - overlapMin(g.away, s0, e0);
      } else if (v?.arrivedAt && winStartAt) {
        const end = v.departedAt;
        before = !!end && ms(end) <= ms(winStartAt);
        wait = before ? 0 : Math.max(0, minutes(v.arrivedAt, winStartAt));
      }
      const unloadMin = unloadSite ?? unloadVisit;
      const unloadSource: UnloadSource | null = unloadSite !== null ? 'GPS_SITE' : unloadVisit !== null ? 'VISIT' : null;
      // Flags.
      const flags = new Set<FactVisitFlag>();
      if (distAtResult !== null && distAtResult > SITE_RULES.lateResultM) flags.add('LATE_RESULT_TAP');
      // A pin offset: the truck stood 120-500 m from the pin to unload, and stood there longer than within 120 m
      // of the pin (its main standing was away from the pin). Review of 19 Oct 2026: a big site's first drop at
      // the pin and a second drop point further on is no wrong pin (one study customer: 38 min within 54 m, then
      // 35 min at 171-378 m); listed in "Pins to review", the office would move a right pin there and the live
      // detector would miss the main drop point. A short halt at the gate near the pin before unloading 200 m
      // away still is one (another study customer, a pin to fix in the study's check: 2 min at 29 m, then
      // 117 min at 201-281 m), so "never within 120 m" is not the rule.
      const split = g ? standingSplit(g.substays) : null;
      const pinOffset =
        g?.standDistM !== null && g?.standDistM !== undefined
          ? g.standDistM >= SITE_RULES.pinOffsetMinM && g.standDistM <= SITE_RULES.pinOffsetMaxM && split!.nearMin < split!.farMin
          : null;
      if (pinOffset) flags.add('PIN_OFFSET');
      if ((g?.dropPoints ?? 0) > 1) flags.add('MULTI_DROP');
      if (g?.away.length) flags.add('LEFT_AND_RETURNED');
      if (v?.departureSource === 'AYUN' && v.departedAt && g?.siteEndAt && minutes(v.departedAt, g.siteEndAt) > SITE_RULES.prematureDepMin) flags.add('PREMATURE_DEP');
      if ((g?.detectorStays ?? 0) > 1) flags.add('SPLIT_STAYS');
      if (pin && allStopPins.some((x) => x.key !== key && distanceM(x.pin, pin) < SITE_RULES.siteRadiusM)) flags.add('SHARED_SITE');
      if (pin && depotPins.some((d) => distanceM(d, pin) <= p.depotRadiusM + p.exitExtraM)) flags.add('NEAR_DEPOT');
      if (resultChanged) flags.add('RESULT_CHANGED');
      if (evs.some((e) => e.kind === 'PHOTO' && e.distanceM !== null && e.distanceM > SITE_RULES.leaveRadiusM)) flags.add('PHOTO_FAR');
      if (!hasGps) flags.add('NO_GPS');
      // Not seen: its window was searched on the trail (an arrival or a result when the GPS columns were built).
      else if (pin && rank.has(s.sequence) && g?.searched && !g.siteStartAt) flags.add('GPS_NOT_SEEN');
      const cases = v?.outcome && DONE.has(v.outcome) ? v.casesDelivered : null;
      const base = s.baseServiceMin;
      const usable = !!(v?.outcome && DONE.has(v.outcome) && cases && cases > 0 && unloadMin !== null && unloadMin > 0 && base !== null && !resultChanged && !flags.has('SHARED_SITE') && !flags.has('PHOTO_FAR'));
      // The per-case rate the plan's "unloading minutes per case" stands for: the base the stop was planned with
      // is taken off first (the plan is base + per case x cases). Unloaded in less than the base: 0, never negative
      // (CHECK), so a median over the visits stays where it is.
      const minPerCase = usable ? r2(Math.max(0, unloadMin! - base!) / cases!) : null;
      const site0 = g?.siteStartAt ?? null;
      const substaysJson: SubstayJson[] | null = site0 && g
        ? capJson(g.substays.map((x) => ({ startOffsetSec: Math.round((ms(x.startAt) - ms(site0)) / 1000), minutes: r1(x.minutes)!, distM: r0(x.distM)!, bearingDeg: r0(x.bearingDeg)! })))
        : null;
      const awayJson: AwayJson[] | null = site0 && g ? capJson(g.away.map((a) => ({ startOffsetSec: Math.round((ms(a.startAt) - ms(site0)) / 1000), minutes: r1(minutes(a.startAt, a.endAt))!, maxDistM: r0(a.maxDistM)! }))) : null;
      const awayMin = g?.siteStartAt ? g.away.reduce((a, x) => a + minutes(x.startAt, x.endAt), 0) : null;
      visits.push({
        ...common,
        depotId: l.depotId,
        loadNo: l.loadNo,
        sequence: s.sequence,
        customerId: s.customerId,
        visitId: v?.id ?? null,
        truckCode: input.truckCode,
        customerCode: s.customerCode,
        customerType: s.customerType,
        baseServiceMin: base,
        plannedEtaMin: s.etaMin,
        plannedServiceMin: s.plannedServiceMin,
        windowStartMin: s.windowStartMin,
        windowEndMin: s.windowEndMin,
        plannedKmFromPrev: r2(s.plannedKmFromPrev),
        casesPlanned: s.casesPlanned,
        actualOrder: rank.get(s.sequence) ?? null,
        arrivedAt: v?.arrivedAt ?? null,
        arrivalSource: v?.arrivalSource ?? null,
        departedAt: v?.departedAt ?? null,
        departureSource: v?.departureSource ?? null,
        departedAtOutcome: !!v?.departedAtOutcome,
        arrivalVsEtaMin: v?.arrivedAt && s.etaMin !== null ? r1(minutes(dayStart, v.arrivedAt) - s.etaMin) : null,
        outcome: v?.outcome ?? null,
        reason: v?.outcome ? v.reason : null,
        outcomeAt: v?.outcome ? v.outcomeAt : null,
        outcomeSource: v?.outcome ? v.outcomeSource : null,
        firstOutcome: firstName,
        firstOutcomeAt: first?.at ?? null,
        outcomeEvents: outcomes.length,
        resultChanged,
        casesDelivered: v?.outcome ? v.casesDelivered : null,
        resultTapAt: tapNow,
        truckDistAtResultM: distAtResult,
        lateResultTap: distAtResult === null ? null : distAtResult > SITE_RULES.lateResultM,
        siteStartAt: g?.siteStartAt ?? null,
        siteEndAt: g?.siteEndAt ?? null,
        onSiteMin: r1(nonNeg(onSite)),
        awayCount: g?.siteStartAt ? g.away.length : null,
        awayMin: r1(awayMin),
        awayJson: awayJson as unknown as Prisma.JsonValue,
        substays: g?.siteStartAt ? (g.substayCount ?? g.substays.length) : null,
        substaysJson: substaysJson as unknown as Prisma.JsonValue,
        dropPoints: g?.siteStartAt ? g.dropPoints : null,
        maxDistM: g?.maxDistM ?? null,
        closestM: g?.closestM ?? null,
        standDistM: g?.standDistM ?? null,
        standBearingDeg: g?.standBearingDeg ?? null,
        pinOffset,
        detectorStays: g?.siteStartAt ? g.detectorStays : null,
        servedBeforeWindow: before,
        waitMin: r1(nonNeg(wait)),
        unloadSiteMin: r1(nonNeg(unloadSite)),
        unloadVisitMin: r1(nonNeg(unloadVisit)),
        unloadTapMin: r1(nonNeg(unloadTap)),
        unloadMin: r1(nonNeg(unloadMin)),
        unloadSource,
        usableForRate: usable,
        minPerCase,
        flags: [...flags].sort(),
      });
    }

    // --- Legs, in the order driven.
    const chain = order.filter((o) => o.anchor);
    const firstSeq = Math.min(...l.stops.map((s) => s.sequence));
    const lastSeq = Math.max(...l.stops.map((s) => s.sequence));
    const origin = l.origin ?? depotPins[0] ?? null;
    let prev: (typeof chain)[number] | null = null;
    let legNo = 0;
    for (const f of [...chain, null]) {
      if (!f && !prev) break;
      const fromSeq = prev?.stop.sequence ?? null;
      const toSeq = f?.stop.sequence ?? null;
      const stored1 = legGps.get(legKey(l.depotId, l.loadNo, fromSeq, toSeq));
      // Without GPS: the visit's own times (the departure before, the arrival after).
      const leftAt = stored1 ? stored1.leftAt : (prev?.visit?.departedAt ?? null);
      const arrivedAt = stored1 ? stored1.arrivedAt : (f?.visit?.arrivedAt ?? null);
      let driveMin = stored1 ? stored1.driveMin : leftAt && arrivedAt ? minutes(leftAt, arrivedAt) : null;
      const notes = new Set((stored1?.note ?? '').split(' ').filter(Boolean));
      if (!stored1) notes.add('NO_GPS');
      if (driveMin !== null && driveMin < 0) {
        driveMin = 0;
        notes.add('SHARED_SITE');
      }
      const visitDrive = prev?.visit?.departedAt && f?.visit?.arrivedAt ? minutes(prev.visit.departedAt, f.visit.arrivedAt) : null;
      const inPlanOrder = prev && f ? f.stop.sequence === prev.stop.sequence + 1 : null;
      let plannedDrive: number | null = null;
      let plannedKm: number | null = null;
      if (prev && f && inPlanOrder) {
        if (f.stop.etaMin !== null && prev.stop.departureMin !== null) plannedDrive = f.stop.etaMin - prev.stop.departureMin;
        plannedKm = f.stop.plannedKmFromPrev;
      } else if (!prev && f && f.stop.sequence === firstSeq) {
        if (f.stop.etaMin !== null) plannedDrive = f.stop.etaMin - l.departMin;
        plannedKm = f.stop.plannedKmFromPrev;
      } else if (prev && !f && prev.stop.sequence === lastSeq) {
        if (prev.stop.departureMin !== null) plannedDrive = l.returnMin - prev.stop.departureMin;
        plannedKm = l.returnLegKm;
      }
      const a = prev ? pinOf(l, prev.stop) : origin;
      const b = f ? pinOf(l, f.stop) : origin;
      const straight = a && b ? distanceM(a, b) / 1000 : null;
      if (straight !== null && plannedDrive && plannedDrive > 0 && (straight / plannedDrive) * 60 < SITE_RULES.planIdleKmh && !notes.has('SHARED_SITE')) notes.add('PLAN_HAS_IDLE');
      const leftMin = leftAt ? Math.round(minutes(dayStart, leftAt)) : null;
      legNo++;
      legs.push({
        ...common,
        depotId: l.depotId,
        truckCode: input.truckCode,
        loadNo: l.loadNo,
        legNo,
        fromSeq,
        toSeq,
        inPlanOrder,
        leftAt,
        arrivedAt,
        leftMin,
        hourOfDay: leftAt ? Math.floor(localMinutes(leftAt, tz) / 60) : null,
        driveMin: r1(driveMin),
        driveMinVisit: r1(visitDrive),
        plannedDriveMin: plannedDrive,
        kmGps: stored1 ? r2(stored1.kmGps) : null,
        plannedKm: r2(plannedKm),
        kmStraight: r2(straight),
        note: [...notes].join(' ') || null,
        distanceMultiplier: settings.distanceMultiplier,
        avgSpeedKmh: settings.avgSpeedKmh,
        roadTimeFactor: settings.roadTimeFactor,
      });
      prev = f;
    }
  }

  // --- Depot turns: between two loads of the truck-day (in departure order).
  const turns: FactDepotTurnRow[] = [];
  const storedTurns = new Map((storedGps?.turns ?? []).map((t) => [turnKey(t.depotId, t.afterLoadNo), t]));
  for (let k = 0; k + 1 < loads.length; k++) {
    const before0 = loads[k]!;
    const next = loads[k + 1]!;
    const back = minDate(...eventsOf(before0, null).filter((e) => e.kind === 'BACK_AT_DEPOT' && (e.source === 'PHONE_MANUAL' || e.source === 'DISPATCHER')).map((e) => e.at));
    // The first sign of the truck at a stop of the next load (the driver's and the office's own events).
    const sign = minDate(...input.events.filter((e) => e.depotId === next.depotId && e.loadNo === next.loadNo && e.sequence !== null && e.source !== 'AYUN' && ['ARRIVED', 'DEPARTED', 'OUTCOME', 'PHOTO'].includes(e.kind)).map((e) => e.at));
    const leaveTaps = eventsOf(next, null).filter((e) => e.kind === 'DEPOT_DEPART').map((e) => e.at);
    const leave = countedLeaveTap(leaveTaps, sign, now);
    const tb = tripByLoad.get(`${before0.depotId}|${before0.loadNo}`);
    const tn = tripByLoad.get(`${next.depotId}|${next.loadNo}`);
    const st = storedTurns.get(turnKey(next.depotId, before0.loadNo));
    const backGps = trail ? (tb?.inAt ?? null) : (st?.backGpsAt ?? null);
    const leaveGps = trail ? (tn?.outAt ?? null) : (st?.leaveGpsAt ?? null);
    const turnGps = backGps && leaveGps && ms(leaveGps) >= ms(backGps) ? minutes(backGps, leaveGps) : null;
    const turnTaps = back && leave && ms(leave) >= ms(back) ? minutes(back, leave) : null;
    const turn = turnGps ?? turnTaps;
    turns.push({
      ...common,
      depotId: next.depotId,
      truckCode: input.truckCode,
      afterLoadNo: before0.loadNo,
      nextLoadNo: next.loadNo,
      backGpsAt: backGps,
      leaveGpsAt: leaveGps,
      turnMinGps: r1(turnGps),
      backTapAt: back,
      leaveTapAt: leave,
      turnMinTaps: r1(turnTaps),
      casesLoaded: next.cases,
      plannedTurnMin: next.departMin - before0.returnMin,
      minPerCaseLoading: turn !== null && next.cases > 0 ? r2(turn / next.cases) : null,
      loadingMinPerCase: settings.loadingMinPerCase,
    });
  }

  // --- The truck-day.
  const stopsAll = loads.flatMap((l) => l.stops.map((s) => ({ l, s, v: visitOf(l, s.sequence) })));
  const withResult = stopsAll.filter((x) => x.v?.outcome);
  const truckDay: FactTruckDayRow = {
    ...common,
    depotId: loads[0]?.depotId ?? input.depots[0]?.depotId ?? '',
    truckCode: input.truckCode,
    tracked: input.tracked,
    loads: loads.length,
    stopsPlanned: stopsAll.length,
    stopsWithResult: withResult.length,
    delivered: withResult.filter((x) => x.v!.outcome === 'DELIVERED').length,
    partlyDelivered: withResult.filter((x) => x.v!.outcome === 'PARTLY_DELIVERED').length,
    notDelivered: withResult.filter((x) => x.v!.outcome === 'NOT_DELIVERED').length,
    casesPlanned: stopsAll.reduce((a, x) => a + x.s.casesPlanned, 0),
    casesDelivered: withResult.reduce((a, x) => a + (DONE.has(x.v!.outcome!) ? (x.v!.casesDelivered ?? 0) : 0), 0),
    plannedDepartMin: loads.length ? Math.min(...loads.map((l) => l.departMin)) : null,
    plannedReturnMin: loads.length ? Math.max(...loads.map((l) => l.returnMin)) : null,
    plannedOutMin: loads.length ? Math.max(...loads.map((l) => l.returnMin)) - Math.min(...loads.map((l) => l.departMin)) : null,
    plannedKm: loads.some((l) => l.distanceKm !== null) ? r2(loads.reduce((a, l) => a + (l.distanceKm ?? 0), 0)) : null,
    ...dayGps,
    gpsNote,
    overtimeAfterMin: settings.overtimeAfterMin,
    loadingMinPerCase: settings.loadingMinPerCase,
    distanceMultiplier: settings.distanceMultiplier,
    avgSpeedKmh: settings.avgSpeedKmh,
    roadTimeFactor: settings.roadTimeFactor,
  };
  return { truckDay, visits, legs, turns };
}

/** Km between two instants; null when either end is missing (the leg's km stays empty). */
function kmBetweenSafe(points: readonly TrailPoint[], from: Date | null, to: Date | null, spikes: ReadonlySet<number>): number | null {
  return from && to ? kmBetween(points, from, to, spikes) : null;
}
