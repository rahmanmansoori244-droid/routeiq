/**
 * The salesman link's day (owner request 19 Oct 2026): every route's deliveries of one company and date, as
 * a salesman should be told them. Pure (no database, no clock: `now` is an input): day-read.ts reads the
 * input once per company and date (memoised 30 s, one build at a time) and the API picks the routes asked for.
 *
 * WHICH DELIVERIES BELONG TO ROUTE R: per order LINE (OrderLine.salesRoute), as the printed Salesman ETA
 * (lib/exports/salesman-eta.ts salesmanEtaModel; a parity test keeps them together): one delivery = one stop
 * of one trip carrying a line of R that is neither cancelled nor moved to another day; its invoices and cases
 * are R's only. A customer with several deliveries gets "part i of n". Lines without a route are on no page.
 *
 * THE STATUS of a delivery (stop S of trip L; the first rule that holds; D = the delivery date):
 *  1. a result is recorded: DELIVERED / PARTLY_DELIVERED / NOT_DELIVERED from R's own lines of the visit
 *     (a stop partly delivered overall can be fully delivered for R); the reason's label with who said it;
 *  2. L is COMPLETED, or the driver tapped Back at depot: NO_RESULT ("Truck stopped there 10:31-10:52 -
 *     result not recorded" when GPS or the phone saw the truck there; never "Delivered");
 *  3. L is DISPATCHED (also an earlier day's trip still out after midnight: now is then past 1440):
 *     - Back at depot tapped (the trip is not closed): rule 2;
 *     - "probably over" (critique 4): GPS saw the truck back at its depot after its last stop; or a later
 *       trip of the truck has left (Completed, Back at depot tapped, a sign at one of its stops, or Dispatched
 *       with its planned departure passed); or the planned return + 60 min has passed and the truck gave no
 *       sign for this trip for an hour (its stops' times and photos; the phone only while no later trip was
 *       dispatched), or GPS saw it come back to its depot since its last sign: NO_RESULT ("probably
 *       finished"). A fresh GPS fix alone never keeps a trip going: a truck left Dispatched and driven home in
 *       the evening is not followed (review of 19 Oct 2026);
 *     - AT_CUSTOMER: arrived (or a delivery photo), no departure, no result, no later stop with activity -
 *       and, while the GPS may judge the stops (a fresh fix and the history caught up: critique 3), the GPS
 *       has the truck at that stop;
 *     - VISITED: arrived or left, no result yet;
 *     - PASSED: not reached while later stops were (critique 13: "still due", with a time after the stops
 *       still ahead), or the GPS has the truck past it;
 *     - NEXT: the first stop ahead (the GPS's, else the projection's); ON_THE_WAY: the others;
 *  4. L never left and D is an earlier day: TRUCK_DID_NOT_GO;
 *  5. L is LOADING (any day: tomorrow's trucks are loaded the evening before): LOADING;
 *  6. L is PLANNED or LOCKED: PLANNED ("Not locked yet" on PLANNED).
 *
 * THE EXPECTED TIME of a delivery still to come, today (lib/alerts/load-eta.ts: one input with the alerts):
 * - a trip on the road: the live GPS ETA while it may be used, else the projection (projection.ts) of the
 *   plan moved by the driver's taps and photos; never earlier than now: "Due now - no update yet" instead,
 *   with no minutes when the clock pushed it or the phone was heard since (critique 4). The stops after such
 *   a stop, or after a stop whose unloading the clock is stretching, get "not before HH:MM" only: their
 *   projected times are lower bounds that grow with the clock - never late, never counted as delayed, never
 *   the truck's "behind plan";
 * - a trip that has not left: the projection from the later of its planned departure (moved by how late the
 *   truck's trip before it will be back: critique 6 - with GPS from the last stop's GPS arrival + its
 *   unloading + the planned drive back; never before now + the work left when the next stop waits on the
 *   clock or on a phone heard since) and now; more than 30 min past that departure it says
 *   "should have left - not marked as left yet" and gives no time (critique 14);
 * - a trip with no live source at all (no sign from the phone, no GPS: critique 4): no time, "No live
 *   updates from this truck", the printed window;
 * - delayed / early is judged against the printed window (critique 5), not the planned minute.
 *
 * ORDERS NOT ON A TRUCK: cancelled (every order of D with a cancel, whatever its plan state; the reason's
 * label, never the office's note), moved to another day, left out of the plan (the reason in a salesman's
 * words), the rest of a split delivery, received after the plan, and not planned yet (every order of D of a
 * depot without a plan in use with an applied option: critique 7).
 */
import type { DetailLoad, DetailStop, PlanDetail } from '../dispatch/plan-detail';
import { compareSalesRoutes } from '../dispatch/sales-route';
import { carriedLoadShows } from '../dispatch/carry-view';
import { localMinutes, todayIso, zonedDayStart } from '../dispatch/time';
import { etaSlot, FIXED_STATUSES, hhmmRange, invoiceText, longDayText, stopWindow, type SalesmanEtaFacts } from '../exports/salesman-eta';
import { readVisitLines } from '../delivery/visit';
import { projectLoad, type ProjectedStop, type Projection, type ProjectionStopIn } from '../alerts/projection';
import { RETURN_GRACE_MIN, thresholdsOf, type AlertConfig } from '../alerts/catalog';
import { clockText, minutesOnDate } from '../alerts/text';
import { firstInAfter, gpsBackOf, gpsLiveOf, gpsTruckDayFactOf, type AlertGpsSettings } from '../alerts/gps';
import { firstPhotoAt, liveEtaAllowed, loadLiveEtas, projectionInputOf, projectionStopsOf, type EtaFactPhoto, type EtaFactStop, type EtaGps } from '../alerts/load-eta';
import { fixStale } from '../ivms/live-map';
import { MOVING_KMH, type GpsTruckDayFact } from '../ivms/types';
import type { StopEta } from '../ivms/eta';
import {
  ADDED_AFTER_PLAN_WHY,
  cancelledWhy,
  ceil5,
  GPS_NONE_TEXT,
  hhmm,
  movedHereNote,
  movedWhy,
  NO_LIVE_TEXT,
  NOT_LOCKED_NOTE,
  NOT_PLANNED_WHY,
  NOT_PLANNED_YET_WHY,
  OFF_KIND_TEXT,
  PART_NOT_PLANNED_WHY,
  REST_NOT_PLANNED_NOTE,
  restMovedNote,
  resultReason,
  round5,
  shareTextOf,
  shortDayText,
  SOURCE_TEXT,
  STATUS_TEXT,
  STILL_DUE_NOTE,
} from './text';
import type {
  DeliveryStatus,
  EtaSource,
  OffTruckKind,
  SalesCounts,
  SalesDelivery,
  SalesEta,
  SalesOffTruck,
  SalesRouteView,
  SalesTruck,
  SalesTruckPosition,
  TripStatus,
} from './view-types';

// ---------------------------------------------------------------------------------------------
// The input (day-read.ts reads it; the unit tests build it)
// ---------------------------------------------------------------------------------------------

/** One depot's plan in use with an applied option, and the facts its detail does not carry. */
export interface SalesPlanIn {
  detail: PlanDetail;
  facts: SalesmanEtaFacts;
}

/** A visit of the date (StopVisit), already without GPS times below GPS tracking TIMES (visit.ts withoutGpsTimes). */
export interface SalesVisitIn {
  depotId: string;
  /** YYYY-MM-DD */
  date: string;
  truckId: string;
  loadNo: number;
  sequence: number;
  arrivedAt: Date | null;
  arrivalSource: string | null;
  departedAt: Date | null;
  departureSource: string | null;
  outcome: string | null;
  reason: string | null;
  outcomeAt: Date | null;
  outcomeSource: string | null;
  casesPlanned: number;
  casesDelivered: number | null;
  linesJson: unknown;
  plannedServiceMin: number | null;
  windowStartMin: number | null;
  photos: EtaFactPhoto[];
}

/** An order of the date the plans do not show as it is now: cancelled, moved, a copy, or of a depot without a plan. */
export interface SalesExtraOrderIn {
  id: string;
  depotId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  cancelled: boolean;
  cancelReason: string | null;
  /** A copy brought forward or postponed: the day it was first due (YYYY-MM-DD). */
  carriedFromDate: string | null;
  /** Moved to another day: the copy's date (YYYY-MM-DD). */
  carriedTo: string | null;
  lines: { id: string; salesRoute: string | null; salesOrderNo: string | null; cases: number }[];
}

/** A truck's latest GPS position (TruckPosition). */
export interface SalesPositionIn {
  fixAt: Date;
  lat: number;
  lng: number;
  speedKmh: number | null;
  flags: string[];
  movedAt: Date | null;
}

/** The GPS the day may read (GPS tracking MAP or higher, the link not switched off); null: none. */
export interface SalesGpsIn {
  settings: AlertGpsSettings;
  positions: ReadonlyMap<string, SalesPositionIn>;
  /** How far each truck's GPS history has been turned into stop times on D (facts.ts trailToOf). */
  trailTo: ReadonlyMap<string, Date | null>;
  /** Trail-confirmed depot moves per truck around D (GPS tracking TIMES and up). */
  moves: ReadonlyMap<string, readonly { kind: 'DEPOT_IN' | 'DEPOT_OUT'; at: Date; observed: boolean; depotId: string | null }[]>;
  /** The trucks with a tracker. */
  tracked: ReadonlySet<string>;
}

export interface SalesDayInput {
  /** YYYY-MM-DD */
  date: string;
  tz: string;
  now: Date;
  plans: readonly SalesPlanIn[];
  extraOrders: readonly SalesExtraOrderIn[];
  visits: readonly SalesVisitIn[];
  /** PlanLoad.statusChangedAt by load id (DetailLoad does not carry it): a DISPATCHED load's Dispatch press. */
  loadTimes: ReadonlyMap<string, Date | null>;
  /** Back at depot taps: `${depotId}|${date}|${truckId}|${loadNo}` -> the earliest. */
  backAt: ReadonlyMap<string, Date>;
  /** The last thing each truck's driver phone sent that day (events and phone photos, by receipt). */
  phoneSeen: ReadonlyMap<string, Date>;
  gps: SalesGpsIn | null;
  /** Customers' GPS site radius (big customers). */
  siteRadius: ReadonlyMap<string, number>;
  /** The late Dispatch press threshold of the projection, as the alerts read it (rules.ts: the company's ETA_LATE threshold, null while that rule is off); unset: DEFAULT_LATE_DISPATCH_MIN. */
  lateDispatchMin?: number | null;
}

export interface SalesDay {
  builtAt: Date;
  date: string;
  /** Every route of the day with a delivery or an order not on a truck, by its code. */
  routes: ReadonlyMap<string, SalesRouteView>;
}

// ---------------------------------------------------------------------------------------------
// Live state of each trip
// ---------------------------------------------------------------------------------------------

type DayRel = 'PAST' | 'TODAY' | 'FUTURE';
/** Where a trip's live times come from (critique 4); OVER: probably finished; BACK: Back at depot tapped, not closed. */
type LiveClass = 'GPS' | 'PHONE' | 'NONE' | 'OVER' | 'BACK';
/** The trip is finished or probably finished (not on the road any more). */
const isOver = (c: LiveClass | null) => c === 'OVER' || c === 'BACK';

type StopKind = 'RESULT' | 'NO_RESULT' | 'AT_CUSTOMER' | 'VISITED' | 'PASSED' | 'NEXT' | 'ON_THE_WAY' | 'LOADING' | 'PLANNED' | 'TRUCK_DID_NOT_GO';

interface StopLive {
  kind: StopKind;
  detail: string | null;
  /** The expected arrival (minutes of D) when it is a real time; null otherwise. */
  expectedMin: number | null;
  source: EtaSource | null;
  /** The clock pushed it or the phone was heard since: "due now", no minutes. */
  dueNow: boolean;
  /** No live time for this stop: none for the trip at all, a trip not marked as left, or after a stop with no update. */
  noLive: string | null;
  /** After a stop the clock pushed (or a phone heard since held): its projected arrival, a lower bound only. */
  notBefore: number | null;
  stopsBefore: number | null;
}

interface LoadRec {
  plan: SalesPlanIn;
  depotId: string;
  load: DetailLoad;
  stops: DetailStop[];
  etaStops: EtaFactStop[];
  visits: (SalesVisitIn | null)[];
  statusChangedAt: Date | null;
  back: Date | null;
}

interface LoadLive {
  rec: LoadRec;
  liveClass: LiveClass | null;
  /** The trip's own departure moved by the trip before (not-left trips of today). */
  shiftMin: number;
  /** Today's trip not left more than 30 min after its (moved) departure. */
  notMarkedLeft: boolean;
  stop: Map<number, StopLive>;
  /** The next stop ahead's delay against its planned minute (a trip on the road, real times only). */
  behindMin: number | null;
}

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const backKeyOf = (depotId: string, date: string, truckId: string, loadNo: number) => `${depotId}|${date}|${truckId}|${loadNo}`;
const visitKeyOf = (depotId: string, date: string, truckId: string, loadNo: number, sequence: number) => `${depotId}|${date}|${truckId}|${loadNo}|${sequence}`;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const r3 = (x: number) => Math.round(x * 1e3) / 1e3;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
/** A load whose not-left time counts as "should have left" this long after its (moved) departure (critique 14). */
export const NOT_LEFT_AFTER_MIN = 30;
/** The late Dispatch press threshold without an alert setting (the ETA_LATE alert's default). */
export const DEFAULT_LATE_DISPATCH_MIN = 30;

/**
 * The late Dispatch press threshold of the projection, the same as the alerts' (critique 8: one input): while the
 * company's alerts are on, its Running late threshold (rules.ts evaluate: thresholdsOf(cfg).ETA_LATE; null when
 * that rule is off: no late-press rule); while they are off, the default.
 */
export function salesLateDispatchMin(cfg: Partial<AlertConfig> | null | undefined): number | null {
  return cfg?.alertsEnabled ? thresholdsOf(cfg).ETA_LATE : DEFAULT_LATE_DISPATCH_MIN;
}
/** A trip with no sign of the truck for this long, past its planned return + RETURN_GRACE_MIN, is "probably over". */
export const SILENT_OVER_MIN = 60;
/** A truck's position is shown at most this old. */
export const POSITION_MAX_AGE_MIN = 60;
/** An expected time this much after the window's end is "late" (whole minutes, then rounded to 5). */
export const LATE_TOLERANCE_MIN = 3;
/** A GPS time this much before the window's start is "earlier than the window". */
export const EARLY_MIN = 10;
/** A truck running this much behind its plan says so on its card. */
export const BEHIND_SHOWN_MIN = 15;

function signTimes(v: SalesVisitIn | null): Date[] {
  if (!v) return [];
  return [v.arrivedAt, v.departedAt, v.outcomeSource !== 'DISPATCHER' ? v.outcomeAt : null, firstPhotoAt(v)].filter((t): t is Date => !!t);
}

/** "Truck stopped there 10:31-10:52", "Truck was there at 10:31"; null without an arrival or departure. */
function thereText(v: SalesVisitIn | null, date: string, tz: string, lead: string): string | null {
  if (!v) return null;
  const arr = v.arrivedAt ?? firstPhotoAt(v);
  const dep = v.departedAt;
  if (arr && dep) return `${lead} ${clockText(arr, date, tz)}-${clockText(dep, date, tz)}`;
  if (arr) return `${lead} at ${clockText(arr, date, tz)}`;
  if (dep) return `${lead} until ${clockText(dep, date, tz)}`;
  return null;
}

/**
 * The live state of every trip of every truck, trip by trip in departure order: a later trip leaves no
 * earlier than the trip before it is back (critique 6: lateBy = the trip's end - its planned return).
 */
function liveOfLoads(recs: readonly LoadRec[], input: SalesDayInput, rel: DayRel): Map<string, LoadLive> {
  const { date, tz, now } = input;
  const nowMin = minutesOnDate(now, date, tz);
  const dayStart = zonedDayStart(date, tz);
  // As the alerts (rules.ts): the company's Running late threshold, null while that rule is off; unset: the default.
  const lateDispatchMin = input.lateDispatchMin === undefined ? DEFAULT_LATE_DISPATCH_MIN : input.lateDispatchMin;
  const out = new Map<string, LoadLive>();
  const byTruck = new Map<string, LoadRec[]>();
  for (const r of recs) {
    const list = byTruck.get(r.load.truckId);
    if (list) list.push(r);
    else byTruck.set(r.load.truckId, [r]);
  }
  const gpsFacts = new Map<string, GpsTruckDayFact>();
  if (input.gps) {
    for (const truckId of byTruck.keys()) {
      const p = input.gps.positions.get(truckId) ?? null;
      const moves = input.gps.moves.get(truckId) ?? [];
      const trailTo = input.gps.trailTo.get(truckId) ?? null;
      if (!p && !moves.length && !trailTo) continue;
      gpsFacts.set(truckId, gpsTruckDayFactOf({ position: p ? { fixAt: p.fixAt, lat: p.lat, lng: p.lng, speedKmh: p.speedKmh, flags: p.flags, movedAt: p.movedAt } : null, moves, trailTo, now }));
    }
  }
  for (const [truckId, list] of byTruck) {
    list.sort((a, b) => a.load.departMin - b.load.departMin || a.load.loadNo - b.load.loadNo);
    const phoneSeenAt = input.phoneSeen.get(truckId) ?? null;
    const fact = gpsFacts.get(truckId) ?? null;
    let lateBy = 0;
    for (const [n, rec] of list.entries()) {
      const L = rec.load;
      const live: LoadLive = { rec, liveClass: null, shiftMin: 0, notMarkedLeft: false, stop: new Map(), behindMin: null };
      out.set(L.id, live);
      const etaGps: EtaGps | null = input.gps && fact ? { fact, settings: input.gps.settings } : null;
      if (L.status === 'COMPLETED') {
        for (const [i, s] of rec.stops.entries()) live.stop.set(s.sequence, finishedStop(rec.visits[i]!, date, tz, false));
        const backMin = rec.back ? minutesOnDate(rec.back, date, tz) : null;
        lateBy = backMin !== null ? Math.max(0, backMin - L.returnMin) : 0;
        continue;
      }
      if (L.status === 'DISPATCHED') {
        if (rec.back) {
          // Back at depot tapped, the trip not closed (a stop without a result): finished, never "on the road".
          live.liveClass = 'BACK';
          for (const [i, s] of rec.stops.entries()) live.stop.set(s.sequence, finishedStop(rec.visits[i]!, date, tz, false));
          lateBy = Math.max(0, minutesOnDate(rec.back, date, tz) - L.returnMin);
          continue;
        }
        lateBy = dispatchedLive(live, { input, nowMin, dayStart, lateDispatchMin, phoneSeenAt, later: list.slice(n + 1), etaGps, fact });
        continue;
      }
      // Not left: PLANNED, LOCKED, LOADING.
      if (rel === 'PAST') {
        for (const s of rec.stops) live.stop.set(s.sequence, plain('TRUCK_DID_NOT_GO', 'The truck did not go out with this trip'));
        lateBy = 0;
        continue;
      }
      const kind: StopKind = L.status === 'LOADING' ? 'LOADING' : 'PLANNED';
      if (rel === 'FUTURE') {
        for (const s of rec.stops) live.stop.set(s.sequence, plain(kind, null));
        continue;
      }
      // Today: from the later of now and the (moved) planned departure.
      live.shiftMin = lateBy;
      const leaveMin = L.departMin + lateBy;
      if (nowMin > leaveMin + NOT_LEFT_AFTER_MIN) {
        live.notMarkedLeft = true;
        const why = `Trip should have left at ${hhmm(leaveMin)} - not marked as left yet`;
        for (const s of rec.stops) live.stop.set(s.sequence, { ...plain(kind, null), noLive: why });
        lateBy = Math.max(0, nowMin - L.departMin);
        continue;
      }
      const stopsIn = projectionStopsOf(rec.etaStops, { date, tz, now });
      const proj = projectLoad({ departMin: L.departMin, returnMin: L.returnMin, dispatchMin: Math.max(nowMin, leaveMin), nowMin, lateDispatchMin: null, phoneSeenMin: null, stops: stopsIn });
      for (const p of proj.stops) {
        const s = rec.stops.find((x) => x.sequence === p.sequence);
        const expected = p.arrMin;
        const source: EtaSource = expected !== null && s?.etaMin !== null && s?.etaMin !== undefined && expected === s.etaMin ? 'PLAN' : 'TRIP';
        live.stop.set(p.sequence, { ...plain(kind, null), expectedMin: expected, source: expected === null ? null : source });
      }
      lateBy = Math.max(0, proj.returnMin - L.returnMin);
    }
  }
  return out;
}

function plain(kind: StopKind, detail: string | null): StopLive {
  return { kind, detail, expectedMin: null, source: null, dueNow: false, noLive: null, notBefore: null, stopsBefore: null };
}

/** A stop of a trip that is over: its result, else "no result recorded" (with the times the truck was seen there). */
function finishedStop(v: SalesVisitIn | null, date: string, tz: string, probably: boolean): StopLive {
  if (v?.outcome) return plain('RESULT', null);
  const seen = thereText(v, date, tz, 'Truck stopped there');
  const detail = seen ? `${seen} - result not recorded` : probably ? 'Trip probably finished - result not recorded' : 'Trip finished - no result recorded';
  return plain('NO_RESULT', detail);
}

/** The live GPS ETA's stop with a delivery photo of the driver's phone as its arrival when none was recorded (M3, as the projection reads it). */
function withPhotoArrival(s: EtaFactStop): EtaFactStop {
  const v = s.visit;
  if (!v || v.arrivedAt || v.departedAt || v.outcome) return s;
  const photo = firstPhotoAt(v);
  return photo ? { ...s, visit: { ...v, arrivedAt: photo } } : s;
}

/**
 * A later trip of the same truck has left, so the truck is done with this one: it is Completed, has a Back at
 * depot tap or a sign at one of its stops, or it is Dispatched and its planned departure has passed - unless this
 * trip had a sign after that Dispatch press (a press made early for both trips).
 */
function laterTripLeft(later: LoadRec, lastSign: Date | null, nowMin: number): boolean {
  if (later.load.status === 'COMPLETED' || later.back) return true;
  if (later.visits.some((v) => signTimes(v).length > 0 || !!v?.outcome)) return true;
  if (later.load.status !== 'DISPATCHED' || nowMin < later.load.departMin) return false;
  return !(lastSign && later.statusChangedAt && lastSign.getTime() > later.statusChangedAt.getTime());
}

/** The planned unloading the projection uses for a stop (projection.ts). */
const serviceOf = (s: ProjectionStopIn) => (has(s.plannedServiceMin) ? Math.max(0, s.plannedServiceMin) : has(s.departureMin) && has(s.serviceStartMin) ? Math.max(0, s.departureMin - s.serviceStartMin) : 0);

/** The live state of a DISPATCHED trip's stops; returns how late the truck will be back (lateBy for its next trip). */
function dispatchedLive(
  live: LoadLive,
  o: {
    input: SalesDayInput;
    nowMin: number;
    dayStart: Date;
    lateDispatchMin: number | null;
    /** When the truck's phone last sent anything (any trip of the day). */
    phoneSeenAt: Date | null;
    /** The truck's later trips that day, in departure order. */
    later: readonly LoadRec[];
    etaGps: EtaGps | null;
    fact: GpsTruckDayFact | null;
  },
): number {
  const { rec } = live;
  const L = rec.load;
  const { date, tz, now } = o.input;
  const stopsIn = projectionStopsOf(rec.etaStops, { date, tz, now, gps: o.etaGps });
  const projIn = projectionInputOf({ status: L.status, date, departMin: L.departMin, returnMin: L.returnMin, statusChangedAt: rec.statusChangedAt }, stopsIn, {
    tz,
    now,
    lateDispatchMin: o.lateDispatchMin,
    phoneSeenAt: o.phoneSeenAt,
  })!;
  const proj: Projection = projectLoad(projIn);
  const projOf = new Map(proj.stops.map((p) => [p.sequence, p]));
  const liveEtas: StopEta[] = loadLiveEtas(o.etaGps, { status: L.status, depotId: rec.depotId, departMin: L.departMin, dayStart: o.dayStart, stops: rec.etaStops.map(withPhotoArrival) }, now);
  const gpsGate = !!o.etaGps && liveEtaAllowed(o.fact, now);
  const etaOfSeq = new Map(liveEtas.map((e) => [e.sequence, e]));

  // Signs of the truck on THIS trip: its stops' times and photos, and the phone (truck-wide) only while no later
  // trip was dispatched. A fresh GPS fix is no sign: a tracker keeps reporting from a truck driven home.
  const signs = rec.visits.flatMap(signTimes);
  const lastSign = signs.length ? new Date(Math.max(...signs.map((d) => d.getTime()))) : null;
  const allStopsDone = rec.stops.length > 0 && rec.visits.every((v) => !!v && (!!v.outcome || !!v.arrivedAt || !!v.departedAt));
  const gpsBack = o.fact ? gpsBackOf(o.fact, { lastSignAt: lastSign, dispatchAt: rec.statusChangedAt, allStopsDone, depotId: rec.depotId }, now) : null;
  const laterDispatched = o.later.some((r) => r.load.status === 'DISPATCHED' || r.load.status === 'COMPLETED' || !!r.back);
  const phoneSign = laterDispatched ? null : o.phoneSeenAt;
  const recent = [lastSign, phoneSign].filter((d): d is Date => !!d).some((d) => now.getTime() - d.getTime() <= SILENT_OVER_MIN * 60_000);
  const pastReturn = o.nowMin > L.returnMin + RETURN_GRACE_MIN;
  // Past the return: a GPS depot IN since the trip's last sign (some stops untouched) ends it too.
  const since = lastSign && rec.statusChangedAt ? (lastSign > rec.statusChangedAt ? lastSign : rec.statusChangedAt) : (lastSign ?? rec.statusChangedAt);
  const backIn = pastReturn && o.fact && since ? firstInAfter(o.fact, since, now, rec.depotId) : null;
  const laterLeft = o.later.some((r) => laterTripLeft(r, lastSign, o.nowMin));
  const anyActivity = signs.length > 0 || rec.visits.some((v) => !!v?.outcome);
  const gpsFollows = gpsLiveOf(o.fact, now) !== null;

  let cls: LiveClass;
  if (gpsBack || laterLeft || (pastReturn && (!recent || backIn))) cls = 'OVER';
  else if (!anyActivity && !o.phoneSeenAt && !gpsFollows) cls = 'NONE';
  else cls = liveEtas.length ? 'GPS' : 'PHONE';
  live.liveClass = cls;

  if (cls === 'OVER') {
    for (const [i, s] of rec.stops.entries()) live.stop.set(s.sequence, finishedStop(rec.visits[i]!, date, tz, true));
    const backMove = gpsBack ?? backIn;
    return backMove ? Math.max(0, minutesOnDate(backMove.at, date, tz) - L.returnMin) : 0;
  }

  // The first stop whose time the clock decides (critique 4): a pending stop the clock pushed or a phone heard since
  // held, or a stop being unloaded past its planned end (it ends "now"). The projected times after it only say
  // "not before" (with GPS the live ETA gives them).
  const pushed =
    cls === 'GPS'
      ? null
      : (proj.stops.find((p, i) => (p.state === 'PENDING' && (p.clockBound || p.phoneHeld)) || (p.state === 'IN_PROGRESS' && has(p.startMin) && p.depMin === o.nowMin && o.nowMin > p.startMin + serviceOf(stopsIn[i]!))) ?? null);
  const afterPushed = (seq: number) => !!pushed && seq > pushed.sequence;

  const atStopSeq = liveEtas[0]?.atStop ? liveEtas[0].sequence : null;
  const gpsNext = liveEtas.find((e) => !e.atStop)?.sequence ?? null;
  const nextSeq = gpsGate ? gpsNext : (proj.next?.sequence ?? null);
  const phoneText = o.phoneSeenAt ? ` (last update ${clockText(o.phoneSeenAt, date, tz)})` : '';

  const kinds = new Map<number, StopKind>();
  for (const [i, s] of rec.stops.entries()) {
    const v = rec.visits[i]!;
    const p = projOf.get(s.sequence);
    if (v?.outcome) {
      kinds.set(s.sequence, 'RESULT');
      continue;
    }
    const arrived = !!(v?.arrivedAt ?? firstPhotoAt(v));
    if (p?.state === 'IN_PROGRESS' && !v?.departedAt && arrived && (!gpsGate || atStopSeq === s.sequence)) {
      kinds.set(s.sequence, 'AT_CUSTOMER');
      continue;
    }
    if (v && (arrived || v.departedAt)) {
      kinds.set(s.sequence, 'VISITED');
      continue;
    }
    if (p?.state === 'SKIPPED' || (gpsGate && !etaOfSeq.has(s.sequence))) {
      kinds.set(s.sequence, 'PASSED');
      continue;
    }
    kinds.set(s.sequence, s.sequence === nextSeq ? 'NEXT' : 'ON_THE_WAY');
  }
  const ahead = (seq: number) => rec.stops.filter((x) => x.sequence < seq && ['AT_CUSTOMER', 'NEXT', 'ON_THE_WAY'].includes(kinds.get(x.sequence)!)).length;
  const pendingAll = rec.stops.filter((x) => ['AT_CUSTOMER', 'NEXT', 'ON_THE_WAY'].includes(kinds.get(x.sequence)!)).length;

  // Still-due stops (PASSED) come after the stops still ahead (critique 13): from the last one's projected end.
  const pendingEnds = proj.stops.filter((p) => p.state === 'PENDING' || p.state === 'IN_PROGRESS').map((p) => p.depMin).filter(has);
  const gpsEnds = liveEtas.map((e) => minutesOnDate(e.etaAt, date, tz));
  let passedFrom = Math.max(o.nowMin, ...pendingEnds, ...gpsEnds);
  let passedPrevPlanDep: number | null = null;

  for (const [i, s] of rec.stops.entries()) {
    const kind = kinds.get(s.sequence)!;
    const v = rec.visits[i]!;
    const p: ProjectedStop | undefined = projOf.get(s.sequence);
    if (kind === 'RESULT') {
      live.stop.set(s.sequence, plain('RESULT', null));
      continue;
    }
    if (kind === 'AT_CUSTOMER') {
      const arr = v?.arrivedAt ?? firstPhotoAt(v);
      live.stop.set(s.sequence, plain('AT_CUSTOMER', arr ? `Truck there since ${clockText(arr, date, tz)}${v?.arrivedAt ? '' : ' (delivery photo)'}` : null));
      continue;
    }
    if (kind === 'VISITED') {
      const seen = thereText(v, date, tz, 'Truck was there');
      live.stop.set(s.sequence, plain('VISITED', seen ? `${seen} - result not sent yet` : 'Result not sent yet'));
      continue;
    }
    if (cls === 'NONE') {
      live.stop.set(s.sequence, { ...plain(kind, null), noLive: NO_LIVE_TEXT, stopsBefore: kind === 'PASSED' ? pendingAll : ahead(s.sequence) });
      continue;
    }
    if (kind === 'PASSED') {
      const service = (has(s.departureMin) && has(s.serviceStartMin) ? s.departureMin - s.serviceStartMin : s.serviceMin) || 0;
      const prevPlan = passedPrevPlanDep ?? planDepBefore(rec.stops, i, L.departMin);
      const leg = has(s.etaMin) ? Math.max(0, s.etaMin - prevPlan) : 0;
      const arr = passedFrom + leg;
      passedFrom = arr + service;
      passedPrevPlanDep = has(s.etaMin) ? s.etaMin + service : passedPrevPlanDep;
      const stopsBefore = pendingAll + rec.stops.filter((x) => x.sequence < s.sequence && kinds.get(x.sequence) === 'PASSED').length;
      // After the stops the clock decides: a lower bound only.
      if (pushed) live.stop.set(s.sequence, { ...plain('PASSED', null), source: 'TRIP', notBefore: arr, noLive: notBeforeText(arr, o.nowMin, phoneText), stopsBefore });
      else live.stop.set(s.sequence, { ...plain('PASSED', null), expectedMin: arr, source: 'TRIP', stopsBefore });
      continue;
    }
    // NEXT / ON_THE_WAY.
    const e = etaOfSeq.get(s.sequence);
    let expectedMin: number | null;
    let source: EtaSource;
    let dueNow = false;
    if (e) {
      expectedMin = minutesOnDate(e.etaAt, date, tz);
      source = 'GPS';
    } else {
      expectedMin = p?.arrMin ?? null;
      source = 'TRIP';
      dueNow = !!p && (p.clockBound || p.phoneHeld);
      if (!dueNow && afterPushed(s.sequence) && has(expectedMin)) {
        live.stop.set(s.sequence, { ...plain(kind, null), source, notBefore: expectedMin, noLive: notBeforeText(expectedMin, o.nowMin, phoneText), stopsBefore: ahead(s.sequence) });
        continue;
      }
    }
    live.stop.set(s.sequence, { ...plain(kind, null), expectedMin, source, dueNow, detail: dueNow ? `Due now - no update from the truck yet${phoneText}` : null, stopsBefore: ahead(s.sequence) });
  }

  // How far behind its plan the trip is now (its next stop ahead, real times only: never one the clock decides).
  const first = rec.stops.find((s) => ['NEXT', 'ON_THE_WAY'].includes(kinds.get(s.sequence)!) && !live.stop.get(s.sequence)!.dueNow);
  const fl = first ? live.stop.get(first.sequence)! : null;
  if (first && fl && has(fl.expectedMin) && has(first.etaMin)) live.behindMin = fl.expectedMin - first.etaMin;
  if (cls === 'NONE') return 0;

  // How late the truck will be back (critique 6): the projected return, ...
  let end = proj.returnMin;
  // ... never before now + the work left when its next stop keeps an expected arrival in the past (a phone heard since);
  const held = proj.stops.find((p) => p.state === 'PENDING' && (p.clockBound || p.phoneHeld));
  if (held && has(held.arrMin) && held.arrMin < o.nowMin) end = Math.max(end, o.nowMin + (proj.returnMin - held.arrMin));
  // ... with GPS, the last stop ahead's GPS arrival + its unloading + the planned drive back (not its arrival alone).
  if (cls === 'GPS' && liveEtas.length) {
    const last = liveEtas.reduce((a, b) => (b.sequence > a.sequence ? b : a));
    const i = rec.stops.findIndex((x) => x.sequence === last.sequence);
    const s = rec.stops[i]!;
    const service = serviceOf(stopsIn[i]!);
    const planDep = has(s.departureMin) ? s.departureMin : has(s.etaMin) ? s.etaMin + service : null;
    const arr = minutesOnDate(last.etaAt, date, tz);
    const dep = last.atStop ? Math.max(o.nowMin, arr + service) : arr + service;
    end = Math.max(end, dep + (planDep !== null ? Math.max(0, L.returnMin - planDep) : 0));
  }
  return Math.max(0, end - L.returnMin);
}

/** A stop after one the clock decides: "Not before 11:00 - no update from the truck yet (last update 08:25)". */
function notBeforeText(min: number, nowMin: number, phoneText: string): string {
  return min > nowMin ? `Not before ${hhmm(round5(min))} - no update from the truck yet${phoneText}` : `No update from the truck yet${phoneText}`;
}

/** The planned departure of the stop before index i (its departure, else arrival + unloading), else the trip's. */
function planDepBefore(stops: readonly DetailStop[], i: number, departMin: number): number {
  for (let j = i - 1; j >= 0; j--) {
    const s = stops[j]!;
    if (has(s.departureMin)) return s.departureMin;
    if (has(s.etaMin)) return s.etaMin + (s.serviceMin ?? 0);
  }
  return departMin;
}

// ---------------------------------------------------------------------------------------------
// The expected time against the printed window
// ---------------------------------------------------------------------------------------------

/** The live expected time of a delivery still to come (null: done, or nothing live to say). */
export function etaView(
  l: Pick<StopLive, 'expectedMin' | 'source' | 'dueNow' | 'noLive' | 'detail'>,
  slot: { from: number; to: number } | null,
  nowMin: number,
): SalesEta | null {
  const win = slot ? hhmmRange(slot.from, slot.to) : null;
  if (l.noLive) return { expected: null, source: null, timing: 'NO_UPDATES', lateMin: null, earlyMin: null, text: win ? `${l.noLive} - window ${win}` : l.noLive };
  if (l.dueNow || (has(l.expectedMin) && l.expectedMin < nowMin)) {
    return { expected: null, source: l.source, timing: 'DUE_NOW', lateMin: null, earlyMin: null, text: l.detail ?? 'Due now - no update from the truck yet' };
  }
  if (!has(l.expectedMin) || !l.source) return null;
  const e = l.expectedMin;
  const shown = Math.max(round5(e), ceil5(nowMin));
  const expected = hhmm(shown);
  const src = l.source === 'GPS' ? ' (GPS)' : l.source === 'PLAN' ? ' (as planned)' : '';
  if (slot && e - slot.to >= LATE_TOLERANCE_MIN) {
    const late = Math.max(5, round5(e - slot.to));
    return { expected, source: l.source, timing: 'LATE', lateMin: late, earlyMin: null, text: `Expected about ${expected}${src} - about ${late} min after the window ${win}` };
  }
  if (slot && l.source === 'GPS' && slot.from - e >= EARLY_MIN) {
    const early = Math.max(5, round5(slot.from - e));
    return { expected, source: l.source, timing: 'EARLY', lateMin: null, earlyMin: early, text: `Expected about ${expected}${src} - earlier than the window ${win}` };
  }
  return { expected, source: l.source, timing: 'ON_TIME', lateMin: null, earlyMin: null, text: win ? `Expected about ${expected}${src} - within ${win}` : `Expected about ${expected}${src}` };
}

// ---------------------------------------------------------------------------------------------
// Per route
// ---------------------------------------------------------------------------------------------

interface DeliveryAcc {
  route: string;
  rec: LoadRec;
  stopIndex: number;
  stop: DetailStop;
  lineIds: Set<string>;
  orderIds: Set<string>;
  invoices: string[];
  cases: number;
}

interface OffAcc {
  kind: OffTruckKind;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  invoices: string[];
  cases: number;
  why: string;
}

const OFF_ORDER: Record<OffTruckKind, number> = { CANCELLED: 0, NOT_PLANNED: 1, PART_NOT_PLANNED: 2, ADDED_AFTER_PLAN: 3, NOT_PLANNED_YET: 4, MOVED: 5 };
const PENDING: ReadonlySet<DeliveryStatus> = new Set(['AT_CUSTOMER', 'NEXT', 'ON_THE_WAY', 'PASSED']);
const DONE: ReadonlySet<DeliveryStatus> = new Set(['DELIVERED', 'PARTLY_DELIVERED', 'NOT_DELIVERED', 'NO_RESULT', 'VISITED']);

/** Every route's view of the day (see the file comment). */
export function buildSalesDay(input: SalesDayInput): SalesDay {
  const { date, tz, now } = input;
  const today = todayIso(tz, now);
  const rel: DayRel = date < today ? 'PAST' : date === today ? 'TODAY' : 'FUTURE';
  const nowMin = minutesOnDate(now, date, tz);
  const dayShort = shortDayText(date);

  const visitOf = new Map(input.visits.map((v) => [visitKeyOf(v.depotId, v.date, v.truckId, v.loadNo, v.sequence), v]));
  const extraOf = new Map(input.extraOrders.map((o) => [o.id, o]));

  // The trips of every plan in use, with their stops in order and their visits.
  const recs: LoadRec[] = [];
  for (const plan of input.plans) {
    const depotId = plan.detail.run.depot.id;
    for (const load of plan.detail.loads) {
      if (!load.stops.length) continue;
      const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
      const visits = stops.map((s) => visitOf.get(visitKeyOf(depotId, date, load.truckId, load.loadNo, s.sequence)) ?? null);
      recs.push({
        plan,
        depotId,
        load,
        stops,
        visits,
        etaStops: stops.map((s, i) => etaStopOf(s, visits[i]!, input.siteRadius)),
        statusChangedAt: input.loadTimes.get(load.id) ?? null,
        back: input.backAt.get(backKeyOf(depotId, date, load.truckId, load.loadNo)) ?? null,
      });
    }
  }
  const lives = liveOfLoads(recs, input, rel);

  // Gather each route's deliveries and orders not on a truck.
  const deliveries = new Map<string, DeliveryAcc[]>();
  const off = new Map<string, Map<string, OffAcc>>();
  const restKeys = new Set<string>();
  const leftOrders = new Set<string>();
  const movedOrders = new Set<string>();
  const onStopOrders = new Set<string>();
  const unservedOrders = new Set<string>();
  const listOff = (
    kind: OffTruckKind,
    orderId: string,
    who: { customerCode: string; branchCode: string | null; customerName: string },
    lines: readonly { salesRoute: string | null; salesOrderNo: string | null; cases: number }[],
    why: string,
  ) => {
    for (const ln of lines) {
      if (!ln.salesRoute) continue;
      let m = off.get(ln.salesRoute);
      if (!m) off.set(ln.salesRoute, (m = new Map()));
      const key = `${kind}|${orderId}|${why}`;
      const e = m.get(key) ?? { kind, customerCode: who.customerCode, branchCode: who.branchCode, customerName: who.customerName, invoices: [], cases: 0, why };
      const inv = invoiceText(ln.salesOrderNo);
      if (!e.invoices.includes(inv)) e.invoices.push(inv);
      e.cases += ln.cases;
      m.set(key, e);
    }
  };

  for (const rec of recs) {
    const { facts } = rec.plan;
    for (const [i, stop] of rec.stops.entries()) {
      const cancelled = new Set(stop.cancelledOrderIds ?? []);
      const byRoute = new Map<string, DeliveryAcc>();
      const moved = new Map<string, { salesRoute: string | null; salesOrderNo: string | null; cases: number }[]>();
      for (const ln of stop.orderLines) {
        onStopOrders.add(ln.orderId);
        const order = facts.orders.get(ln.orderId);
        // Cancelled as the plan read it, or since; only a trip that never left can hold one (listed from the day's cancelled orders).
        if (cancelled.has(ln.orderId) || (order?.cancelled && carriedLoadShows(rec.load.status))) continue;
        const route = facts.lines.get(ln.lineId)?.salesRoute ?? null;
        if (order?.carriedTo && carriedLoadShows(rec.load.status)) {
          moved.set(ln.orderId, [...(moved.get(ln.orderId) ?? []), { salesRoute: route, salesOrderNo: ln.salesOrderNo, cases: ln.cases }]);
          continue;
        }
        if (!carriedLoadShows(rec.load.status)) leftOrders.add(ln.orderId);
        if (!route) continue;
        let a = byRoute.get(route);
        if (!a) byRoute.set(route, (a = { route, rec, stopIndex: i, stop, lineIds: new Set(), orderIds: new Set(), invoices: [], cases: 0 }));
        a.lineIds.add(ln.lineId);
        a.orderIds.add(ln.orderId);
        const inv = invoiceText(ln.salesOrderNo);
        if (!a.invoices.includes(inv)) a.invoices.push(inv);
        a.cases += ln.cases;
      }
      for (const a of byRoute.values()) {
        const list = deliveries.get(a.route);
        if (list) list.push(a);
        else deliveries.set(a.route, [a]);
      }
      for (const [orderId, lines] of moved) {
        movedOrders.add(orderId);
        listOff('MOVED', orderId, stop, lines, movedWhy(facts.orders.get(orderId)!.carriedTo!));
      }
    }
  }

  // Left out of a plan (unserved), and received after it (pending), per plan.
  for (const plan of input.plans) {
    const d = plan.detail;
    const { facts } = plan;
    const linesByOrder = new Map<string, { lineId: string; salesRoute: string | null; salesOrderNo: string | null; cases: number }[]>();
    for (const [lineId, l] of facts.lines) {
      const list = linesByOrder.get(l.orderId);
      const x = { lineId, salesRoute: l.salesRoute, salesOrderNo: l.salesOrderNo, cases: l.cases };
      if (list) list.push(x);
      else linesByOrder.set(l.orderId, [x]);
    }
    const stopOrders = new Set(d.loads.flatMap((l) => l.stops.flatMap((s) => s.orderIds)));
    const onTruck = new Map<string, number>();
    for (const l of d.loads) for (const s of l.stops) for (const ln of s.orderLines) onTruck.set(ln.lineId, (onTruck.get(ln.lineId) ?? 0) + ln.cases);
    const seen = new Set<string>();
    for (const u of d.unserved) {
      if (seen.has(u.orderId)) continue;
      seen.add(u.orderId);
      unservedOrders.add(u.orderId);
      if (u.cancelled || facts.orders.get(u.orderId)?.cancelled || extraOf.get(u.orderId)?.cancelled) continue;
      const carriedTo = u.carriedTo ?? facts.orders.get(u.orderId)?.carriedTo ?? null;
      const lines = linesByOrder.get(u.orderId) ?? [];
      if (!stopOrders.has(u.orderId)) {
        if (carriedTo) {
          movedOrders.add(u.orderId);
          listOff('MOVED', u.orderId, u, lines, movedWhy(carriedTo));
        } else listOff('NOT_PLANNED', u.orderId, u, lines, NOT_PLANNED_WHY(u.reasonCode));
        continue;
      }
      const rest = lines.map((ln) => ({ ...ln, cases: ln.cases - (onTruck.get(ln.lineId) ?? 0) })).filter((ln) => ln.cases > 0);
      if (carriedTo) {
        movedOrders.add(u.orderId);
        listOff('MOVED', u.orderId, u, rest, movedWhy(carriedTo));
      } else listOff('PART_NOT_PLANNED', u.orderId, u, rest, PART_NOT_PLANNED_WHY);
      for (const ln of rest) if (ln.salesRoute) restKeys.add(`${u.customerId}|${ln.salesRoute}`);
    }
    for (const p of facts.pending) {
      if (facts.orders.get(p.orderId)?.cancelled || extraOf.get(p.orderId)?.cancelled) continue;
      listOff('ADDED_AFTER_PLAN', p.orderId, p, linesByOrder.get(p.orderId) ?? [], ADDED_AFTER_PLAN_WHY);
    }
  }

  // The day's cancelled orders (whatever their plan state), moved orders on no plan, and orders of depots not planned yet.
  const plannedDepots = new Set(input.plans.map((p) => p.detail.run.depot.id));
  for (const o of input.extraOrders) {
    if (o.cancelled) {
      if (!leftOrders.has(o.id)) listOff('CANCELLED', o.id, o, o.lines, cancelledWhy(o.cancelReason));
      continue;
    }
    if (o.carriedTo) {
      if (!movedOrders.has(o.id) && !onStopOrders.has(o.id) && !unservedOrders.has(o.id)) {
        movedOrders.add(o.id);
        listOff('MOVED', o.id, o, o.lines, movedWhy(o.carriedTo));
      }
      continue;
    }
    if (!plannedDepots.has(o.depotId)) listOff('NOT_PLANNED_YET', o.id, o, o.lines, NOT_PLANNED_YET_WHY);
  }

  const routes = new Map<string, SalesRouteView>();
  const codes = [...new Set([...deliveries.keys(), ...off.keys()])].sort(compareSalesRoutes);
  for (const route of codes) {
    routes.set(route, routeView(route, deliveries.get(route) ?? [], [...(off.get(route)?.values() ?? [])], { input, lives, extraOf, restKeys, rel, nowMin, dayShort }));
  }
  return { builtAt: now, date, routes };
}

/** A planned stop as the shared ETA input reads it (lib/alerts/load-eta.ts), with its visit. */
function etaStopOf(s: DetailStop, v: SalesVisitIn | null, siteRadius: ReadonlyMap<string, number>): EtaFactStop {
  const site = siteRadius.get(s.customerId) ?? null;
  return {
    sequence: s.sequence,
    etaMin: s.etaMin,
    serviceStartMin: s.serviceStartMin,
    departureMin: s.departureMin,
    // As the alerts' planned stop (lib/delivery/planned-stop.ts): the scheduled unloading; the order's own time first for the window.
    plannedServiceMin: has(s.departureMin) && has(s.serviceStartMin) ? s.departureMin - s.serviceStartMin : null,
    windowStartMin: s.promisedWindow ? s.promisedWindow.startMin : (s.plannedHours?.hardStart ?? null),
    pin: s.lat !== null && s.lng !== null ? { lat: s.lat, lng: s.lng } : null,
    ...(site ? { siteRadiusM: site } : {}),
    visit: v
      ? {
          arrivedAt: v.arrivedAt,
          arrivalSource: v.arrivalSource,
          departedAt: v.departedAt,
          outcome: v.outcome,
          outcomeAt: v.outcomeAt,
          outcomeSource: v.outcomeSource,
          plannedServiceMin: v.plannedServiceMin,
          windowStartMin: v.windowStartMin,
          photos: v.photos,
        }
      : null,
  };
}

interface RouteCtx {
  input: SalesDayInput;
  lives: Map<string, LoadLive>;
  extraOf: Map<string, SalesExtraOrderIn>;
  restKeys: Set<string>;
  rel: DayRel;
  nowMin: number;
  dayShort: string;
}

/** Route R's result at a stop from its own lines of the visit (the deliveredOf rule of lib/delivery/visit.ts). */
function routeResult(a: DeliveryAcc, v: SalesVisitIn): { status: DeliveryStatus; delivered: { cases: number; of: number } | null } {
  const mine = readVisitLines(v.linesJson).filter((l) => a.lineIds.has(l.lineId));
  if (!mine.length) {
    // A visit without R's lines (written before its lines were known): the stop's result and R's cases.
    if (v.outcome === 'DELIVERED') return { status: 'DELIVERED', delivered: { cases: a.cases, of: a.cases } };
    if (v.outcome === 'NOT_DELIVERED') return { status: 'NOT_DELIVERED', delivered: { cases: 0, of: a.cases } };
    return { status: 'PARTLY_DELIVERED', delivered: null };
  }
  const of = mine.reduce((t, l) => t + l.plannedCases, 0);
  const cases = mine.reduce((t, l) => t + (l.deliveredCases ?? (v.outcome === 'NOT_DELIVERED' ? 0 : l.plannedCases)), 0);
  const status: DeliveryStatus = cases >= of ? 'DELIVERED' : cases <= 0 ? 'NOT_DELIVERED' : 'PARTLY_DELIVERED';
  return { status, delivered: { cases, of } };
}

function routeView(route: string, accs: DeliveryAcc[], offs: OffAcc[], c: RouteCtx): SalesRouteView {
  const { input, lives, rel, nowMin } = c;
  const { date, tz, now } = input;
  accs.sort(
    (x, y) =>
      (x.stop.etaMin ?? Number.POSITIVE_INFINITY) - (y.stop.etaMin ?? Number.POSITIVE_INFINITY) ||
      byText(x.rec.load.truckCode, y.rec.load.truckCode) ||
      x.rec.load.loadNo - y.rec.load.loadNo ||
      x.stop.sequence - y.stop.sequence,
  );
  // "part i of n" per customer, in that order.
  const partsOf = new Map<string, number>();
  for (const a of accs) partsOf.set(a.stop.customerId, (partsOf.get(a.stop.customerId) ?? 0) + 1);
  const partNo = new Map<string, number>();
  const truckKeys = new Map<string, string>();
  const deliveries: SalesDelivery[] = [];
  for (const [n, a] of accs.entries()) {
    const L = a.rec.load;
    const live = lives.get(L.id)!;
    const sl = live.stop.get(a.stop.sequence) ?? plain('PLANNED', null);
    const v = a.rec.visits[a.stopIndex] ?? null;
    if (!truckKeys.has(L.truckId)) truckKeys.set(L.truckId, `t${truckKeys.size + 1}`);
    const k = (partNo.get(a.stop.customerId) ?? 0) + 1;
    partNo.set(a.stop.customerId, k);
    const parts = partsOf.get(a.stop.customerId)!;
    const slot = has(a.stop.etaMin) ? etaSlot(a.stop.etaMin, stopWindow(a.stop)) : null;
    const window = slot ? hhmmRange(slot.from, slot.to) : null;

    let status: DeliveryStatus;
    let detailText: string | null = sl.detail;
    let at: string | null = null;
    let delivered: SalesDelivery['delivered'] = null;
    let reason: string | null = null;
    if (sl.kind === 'RESULT' && v) {
      const r = routeResult(a, v);
      status = r.status;
      delivered = r.delivered;
      const when = v.outcomeAt ?? v.departedAt;
      at = when ? clockText(when, date, tz) : null;
      if (status !== 'DELIVERED') reason = resultReason(v.reason, v.outcomeSource);
      detailText =
        status === 'DELIVERED'
          ? `Delivered${at ? ` ${at}` : ''}`
          : status === 'PARTLY_DELIVERED'
            ? `${delivered ? `Delivered ${delivered.cases} of ${delivered.of} cases` : 'Partly delivered'}${at ? ` at ${at}` : ''}`
            : `Not delivered${at ? ` (${at})` : ''}`;
    } else status = sl.kind === 'RESULT' ? 'NO_RESULT' : (sl.kind as DeliveryStatus);

    // A live time only on the delivery day (or a trip still out after midnight): before it, the printed window.
    const pending = rel !== 'FUTURE' && (PENDING.has(status) || ((status === 'PLANNED' || status === 'LOADING') && rel === 'TODAY'));
    const eta = pending ? etaView(sl, slot, nowMin) : null;
    if (eta && !sl.detail && !sl.noLive) detailText = eta.text;
    else if (eta && sl.noLive) detailText = eta.text;
    // Still due (critique 13): its expected time first (as Send to customer and the truck card say it), then why.
    if (status === 'PASSED') detailText = eta ? `${eta.text} · ${STILL_DUE_NOTE}` : `Still due - ${STILL_DUE_NOTE}`;
    if (eta && sl.stopsBefore && (status === 'NEXT' || status === 'ON_THE_WAY' || status === 'PASSED')) detailText = `${detailText ?? eta.text} · ${sl.stopsBefore} stop${sl.stopsBefore === 1 ? '' : 's'} before`;
    else if (!eta && sl.noLive && sl.stopsBefore) detailText = `${sl.noLive} · ${sl.stopsBefore} stop${sl.stopsBefore === 1 ? '' : 's'} before`;
    // May arrive after the customer's receiving hours (the live time is never clipped).
    const closes = a.stop.promisedWindow?.endMin ?? a.stop.plannedHours?.hardEnd ?? null;
    const arrivesBy = !eta ? null : eta.timing === 'DUE_NOW' ? nowMin : has(sl.notBefore) ? sl.notBefore : has(sl.expectedMin) && eta.timing !== 'NO_UPDATES' ? sl.expectedMin : null;
    // The customer's text never gives a window that is over (or that the truck can no longer make) as the time.
    const windowOver = !!slot && (nowMin > slot.to || (has(sl.notBefore) && sl.notBefore - slot.to >= LATE_TOLERANCE_MIN));
    const afterHours = has(closes) && has(arrivesBy) && arrivesBy > closes ? `May arrive after the customer's receiving hours (until ${hhmm(closes)})` : null;

    const notes: string[] = [];
    if (L.status === 'PLANNED') notes.push(NOT_LOCKED_NOTE);
    if (c.restKeys.has(`${a.stop.customerId}|${route}`)) notes.push(REST_NOT_PLANNED_NOTE);
    const from = [...a.orderIds].map((id) => c.extraOf.get(id)?.carriedFromDate).filter((x): x is string => !!x).sort()[0];
    if (from) notes.push(movedHereNote(from));
    if (!carriedLoadShows(L.status)) {
      const to = [...a.orderIds].map((id) => a.rec.plan.facts.orders.get(id)?.carriedTo).filter((x): x is string => !!x).sort().at(-1);
      if (to) notes.push(restMovedNote(to));
    }
    const hard = a.stop.plannedHours && (a.stop.plannedHours.hardStart !== null || a.stop.plannedHours.hardEnd !== null) ? hhmmRange(a.stop.plannedHours.hardStart, a.stop.plannedHours.hardEnd) : null;
    const promised = a.stop.promisedWindow && (a.stop.promisedWindow.startMin !== null || a.stop.promisedWindow.endMin !== null) ? hhmmRange(a.stop.promisedWindow.startMin, a.stop.promisedWindow.endMin) : null;
    const stopNo = a.rec.stops.findIndex((s) => s.sequence === a.stop.sequence) + 1;
    deliveries.push({
      no: n + 1,
      key: `d${n + 1}`,
      customerName: a.stop.customerName,
      customerCode: a.stop.customerCode,
      branchCode: a.stop.branchCode,
      invoices: a.invoices,
      cases: a.cases,
      truckKey: truckKeys.get(L.truckId)!,
      truckCode: L.truckCode,
      loadNo: L.loadNo,
      stopNo,
      stopsOnTrip: a.rec.stops.length,
      part: parts > 1 ? `part ${k} of ${parts}` : null,
      status,
      statusText: STATUS_TEXT[status],
      detailText,
      window,
      planned: has(a.stop.etaMin) ? hhmm(a.stop.etaMin) : null,
      eta,
      stopsBefore: PENDING.has(status) ? sl.stopsBefore : null,
      afterHours,
      at,
      delivered,
      reason,
      hours: hard && hard !== promised ? hard : promised ? null : 'any time',
      orderTime: promised ? `this order: ${promised}` : null,
      notes,
      pin: a.stop.lat !== null && a.stop.lng !== null && Number.isFinite(a.stop.lat) && Number.isFinite(a.stop.lng) ? { lat: r4(a.stop.lat), lng: r4(a.stop.lng) } : null,
      shareText: shareTextOf({
        customerName: a.stop.customerName,
        invoices: a.invoices,
        status,
        dayShort: c.dayShort,
        window,
        expected: eta?.expected ?? null,
        windowOver,
        seen: !!thereText(v, date, tz, 'seen'),
        at,
        delivered,
      }),
    });
  }

  const trucks = [...truckKeys.entries()].map(([truckId, key]) => truckView(truckId, key, deliveries, accs, c));
  const offTruck: SalesOffTruck[] = offs
    .sort((x, y) => OFF_ORDER[x.kind] - OFF_ORDER[y.kind] || byText(x.customerCode, y.customerCode) || byText(x.branchCode ?? '', y.branchCode ?? '') || byText(x.why, y.why))
    .map((o) => ({ kind: o.kind, kindText: OFF_KIND_TEXT[o.kind], customerName: o.customerName, customerCode: o.customerCode, branchCode: o.branchCode, invoices: o.invoices, cases: o.cases, why: o.why }));
  const count = (...s: DeliveryStatus[]) => deliveries.filter((d) => s.includes(d.status)).length;
  const offCount = (...k: OffTruckKind[]) => offTruck.filter((o) => k.includes(o.kind)).length;
  const counts: SalesCounts = {
    delivered: count('DELIVERED'),
    partly: count('PARTLY_DELIVERED'),
    notDelivered: count('NOT_DELIVERED'),
    noResult: count('NO_RESULT'),
    now: count('AT_CUSTOMER', 'NEXT'),
    onTheWay: count('ON_THE_WAY', 'VISITED', 'PASSED'),
    planned: count('PLANNED', 'LOADING'),
    didNotGo: count('TRUCK_DID_NOT_GO'),
    delayed: deliveries.filter((d) => !DONE.has(d.status) && d.eta?.timing === 'LATE').length,
    cancelled: offCount('CANCELLED'),
    moved: offCount('MOVED'),
    notPlanned: offCount('NOT_PLANNED', 'PART_NOT_PLANNED', 'ADDED_AFTER_PLAN', 'NOT_PLANNED_YET'),
  };
  const updatedText = `Updated ${hhmm(localMinutes(now, tz))}`;
  return {
    route,
    heading: `Route ${route} · ${longDayText(date)}`,
    updatedAt: now.toISOString(),
    updatedText,
    notLocked: accs.some((a) => !FIXED_STATUSES.has(a.rec.load.status)),
    counts,
    summaryText: summaryOf(counts),
    trucks,
    deliveries,
    offTruck,
  };
}

function summaryOf(c: SalesCounts): string {
  const parts: [number, string][] = [
    [c.delivered, 'delivered'],
    [c.partly, 'partly delivered'],
    [c.notDelivered, 'not delivered'],
    [c.noResult, 'no result'],
    [c.now, 'at the customer or next'],
    [c.onTheWay, 'on the way'],
    [c.planned, 'planned'],
    [c.didNotGo, 'truck did not go'],
    [c.delayed, 'delayed'],
    [c.cancelled, 'cancelled'],
    [c.moved, 'moved'],
    [c.notPlanned, 'not on a truck'],
  ];
  const text = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(' · ');
  return text || 'Nothing for this route yet';
}

const TRIP_STATUSES: ReadonlySet<string> = new Set(['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED']);

/** One truck of the route's deliveries (`deliveries[i]` is `accs[i]`'s). */
function truckView(truckId: string, key: string, deliveries: SalesDelivery[], accs: DeliveryAcc[], c: RouteCtx): SalesTruck {
  const { input, lives, rel } = c;
  const { date, tz, now } = input;
  // Every trip of the truck that day (the card says where the truck is, whichever route the trip carries).
  const trips = [...lives.values()].filter((l) => l.rec.load.truckId === truckId).sort((a, b) => a.rec.load.departMin - b.rec.load.departMin || a.rec.load.loadNo - b.rec.load.loadNo);
  const mine = accs.filter((a) => a.rec.load.truckId === truckId);
  const truckCode = mine[0]?.rec.load.truckCode ?? '';
  // The trip on the road: the first Dispatched trip that is not over (Back at depot tapped, or probably finished - a
  // later trip that left ends it), so a trip pressed early with the one before is not "on the road" before it.
  const onRoad = trips.find((t) => t.rec.load.status === 'DISPATCHED' && !isOver(t.liveClass)) ?? null;
  // Else the next trip that has not left (the one being loaded first), else the latest trip (over).
  const current =
    onRoad ??
    trips.find((t) => t.rec.load.status === 'LOADING') ??
    trips.find((t) => t.rec.load.status === 'PLANNED' || t.rec.load.status === 'LOCKED') ??
    trips.at(-1) ??
    null;
  let trip: SalesTruck['trip'] = null;
  if (current) {
    const L = current.rec.load;
    const status = (TRIP_STATUSES.has(L.status) ? L.status : 'PLANNED') as TripStatus;
    let text: string;
    if (L.status === 'DISPATCHED') {
      const since = current.rec.statusChangedAt ? ` since ${clockText(current.rec.statusChangedAt, date, tz)}` : '';
      text =
        current.liveClass === 'BACK'
          ? `Trip ${L.loadNo} back at the depot`
          : current.liveClass === 'OVER'
            ? `Trip ${L.loadNo} probably finished - not closed yet`
            : `On the road (trip ${L.loadNo})${since}${current.liveClass === 'NONE' ? ` - ${NO_LIVE_TEXT.toLowerCase()}` : ''}`;
    } else if (L.status === 'COMPLETED') text = 'All trips finished';
    else if (rel === 'PAST') text = `Trip ${L.loadNo} did not go out`;
    else if (current.notMarkedLeft) text = `Trip ${L.loadNo} should have left at ${hhmm(L.departMin + current.shiftMin)} - not marked as left yet`;
    else if (L.status === 'LOADING') text = `Being loaded (trip ${L.loadNo}), planned to leave ${hhmm(L.departMin)}`;
    else text = `Trip ${L.loadNo} planned to leave ${hhmm(L.departMin)}`;
    trip = { loadNo: L.loadNo, status, text };
  }
  const behind = onRoad?.behindMin ?? null;
  const lateText = onRoad && has(behind) && behind >= BEHIND_SHOWN_MIN ? `Running about ${round5(behind)} min behind plan` : null;

  // The route's next customer on this truck: on the trip on the road first, else the next trip.
  const ours = deliveries.filter((d) => d.truckKey === key);
  const nextD =
    ours.find((d) => d.status === 'AT_CUSTOMER') ??
    ours.filter((d) => d.status === 'NEXT' || d.status === 'ON_THE_WAY' || d.status === 'PASSED').sort((a, b) => (a.stopsBefore ?? 0) - (b.stopsBefore ?? 0) || a.no - b.no)[0] ??
    ours.find((d) => d.status === 'PLANNED' || d.status === 'LOADING') ??
    null;
  let nextYours: string | null = null;
  if (nextD) {
    const when = nextD.status === 'AT_CUSTOMER' ? 'truck there now' : nextD.eta?.expected ? `about ${nextD.eta.expected}` : nextD.window ? `window ${nextD.window}` : null;
    const before = nextD.stopsBefore ? `${nextD.stopsBefore} stop${nextD.stopsBefore === 1 ? '' : 's'} before it` : null;
    nextYours = [nextD.customerName, when, before].filter(Boolean).join(' · ');
  }

  // The position: only on the delivery day itself, while the trip on the road (never one over) still has this
  // route's deliveries to make (critique 10).
  let position: SalesTruckPosition | null = null;
  let gpsText: string | null = null;
  const gps = input.gps;
  if (gps) {
    const p = gps.positions.get(truckId) ?? null;
    if (!gps.tracked.has(truckId)) gpsText = GPS_NONE_TEXT;
    // A truck not on the road: nothing to say about its GPS (no position is shown before it leaves).
    else if (!onRoad) gpsText = null;
    else if (!p) gpsText = 'GPS: no position yet';
    else {
      const ageMin = Math.max(0, Math.floor((now.getTime() - p.fixAt.getTime()) / 60_000));
      const stale = fixStale({ fixAt: p.fixAt, flags: p.flags }, now);
      const at = hhmm(localMinutes(p.fixAt, tz));
      const updatedText = stale ? `Last GPS position ${at} (${ageMin} min ago)` : `Updated ${at}`;
      gpsText = stale ? `GPS: last position ${at}` : `GPS: updated ${at}`;
      const pendingOnRoad = !!onRoad && accs.some((a, i) => a.rec.load.id === onRoad.rec.load.id && PENDING.has(deliveries[i]!.status));
      if (pendingOnRoad && ageMin <= POSITION_MAX_AGE_MIN && rel === 'TODAY' && Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
        position = { lat: r3(p.lat), lng: r3(p.lng), fixAt: p.fixAt.toISOString(), updatedText, ageMin, stale, moving: !stale && (p.speedKmh ?? 0) >= MOVING_KMH };
      }
    }
  }
  return {
    key,
    truckCode,
    trip,
    trips: new Set(mine.map((a) => a.rec.load.id)).size,
    lateText,
    nextYours,
    position,
    gpsText,
  };
}
