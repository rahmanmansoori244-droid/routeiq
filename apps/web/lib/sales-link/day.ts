/**
 * The salesman link's day (owner request 19 Oct 2026): every route's deliveries of one company and date, as
 * a salesman should be told them. Pure (no database, no clock: `now` is an input): day-read.ts reads the
 * input once per company and date (memoised 30 s, one build at a time) and the API picks the routes asked for.
 *
 * This is the DETAILED day (twelve statuses, the expected time and where it comes from, the printed window): it
 * never leaves the server. The API sends each result through simple-view.ts (owner feedback of 20 Oct 2026: one
 * status and one time per customer, no truck, no trip, no reason, no position).
 *
 * WHICH DELIVERIES BELONG TO ROUTE R: per order LINE (OrderLine.salesRoute), as the printed Salesman ETA
 * (lib/exports/salesman-eta.ts salesmanEtaModel; a parity test keeps them together): one delivery = one stop
 * of one trip carrying a line of R that is neither cancelled nor moved to another day; its invoices and cases
 * are R's only. A customer with several deliveries (a split delivery, two trips) has each here; the page gets one
 * row per customer and status (simple-view.ts). Lines without a route are on no route's page.
 *
 * WHICH DELIVERIES BELONG TO TRUCK T (owner decision of 20 Oct 2026: a lookup by truck code): every stop of every
 * trip of T on the day's plans in use (every depot), with all its lines that are neither cancelled nor moved to
 * another day (every route, and lines without one); a stop with none left is no delivery. The statuses and
 * expected times follow the same rules. Its "orders not on a truck" are the orders taken off its trips: cancelled,
 * or moved to another day. The truck is found by the code its plan shows (a day-hired truck: its plate,
 * lib/dispatch/hire.ts shownTruckCode); the answer names it only in the heading the salesman typed.
 *
 * THE STATUS of a delivery (stop S of trip L; the first rule that holds; D = the delivery date):
 *  1. a result is recorded: DELIVERED / PARTLY_DELIVERED / NOT_DELIVERED from R's own lines of the visit
 *     (a stop partly delivered overall can be fully delivered for R);
 *  2. L is COMPLETED, or the driver tapped Back at depot: NO_RESULT (never "Delivered");
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
 *   plan moved by the driver's taps and photos; never earlier than now: "due now" instead (DUE_NOW, no
 *   time) when the clock pushed it or the phone was heard since (critique 4). The stops after such a stop, or
 *   after a stop whose unloading the clock is stretching, get a lower bound only (NO_UPDATES with
 *   `notBeforeMin`): it grows with the clock, so it is never LATE by itself;
 * - a trip that has not left: the projection from the later of its planned departure (moved by how late the
 *   truck's trip before it will be back: critique 6 - with GPS from the last stop's GPS arrival + its
 *   unloading + the planned drive back; never before now + the work left when the next stop waits on the
 *   clock or on a phone heard since) and now; more than 30 min past that departure (not marked as left) no
 *   time (NO_UPDATES, critique 14);
 * - a trip with no live source at all (no sign from the phone, no GPS: critique 4): no time (NO_UPDATES);
 * - late is judged against the printed window (critique 5), not the planned minute.
 *
 * ORDERS NOT ON A TRUCK: cancelled (every order of D with a cancel, whatever its plan state), moved to another
 * day, left out of the plan, the rest of a split delivery, received after the plan, and not planned yet (every
 * order of D of a depot without a plan in use with an applied option: critique 7).
 */
import type { DetailLoad, DetailStop, PlanDetail } from '../dispatch/plan-detail';
import { compareSalesRoutes } from '../dispatch/sales-route';
import { carriedLoadShows } from '../dispatch/carry-view';
import { todayIso, zonedDayStart } from '../dispatch/time';
import { etaSlot, hhmmRange, stopWindow, type SalesmanEtaFacts } from '../exports/salesman-eta';
import { readVisitLines } from '../delivery/visit';
import { projectLoad, type ProjectedStop, type Projection, type ProjectionStopIn } from '../alerts/projection';
import { RETURN_GRACE_MIN, thresholdsOf, type AlertConfig } from '../alerts/catalog';
import { clockText, minutesOnDate } from '../alerts/text';
import { firstInAfter, gpsBackOf, gpsLiveOf, gpsTruckDayFactOf, type AlertGpsSettings } from '../alerts/gps';
import { firstPhotoAt, liveEtaAllowed, loadLiveEtas, projectionInputOf, projectionStopsOf, type EtaFactPhoto, type EtaFactStop, type EtaGps } from '../alerts/load-eta';
import type { GpsTruckDayFact } from '../ivms/types';
import type { StopEta } from '../ivms/eta';
import { truckQuery, type DayTruckRef } from './route-code';
import { ceil5, round5 } from './text';
import type { SalesViewKind } from './view-types';

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
  /** The driver's own arrival tap a GPS arrival replaced (owner decision 21 Oct 2026); absent or null: none. The live ETA follows such a stop as a tapped one. */
  ownArrivedAt?: Date | null;
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

/** The GPS the day may read for its expected times (GPS tracking MAP or higher, the link not switched off); null: none. */
export interface SalesGpsIn {
  settings: AlertGpsSettings;
  positions: ReadonlyMap<string, SalesPositionIn>;
  /** How far each truck's GPS history has been turned into stop times on D (facts.ts trailToOf). */
  trailTo: ReadonlyMap<string, Date | null>;
  /** Trail-confirmed depot moves per truck around D (GPS tracking TIMES and up). */
  moves: ReadonlyMap<string, readonly { kind: 'DEPOT_IN' | 'DEPOT_OUT'; at: Date; observed: boolean; depotId: string | null }[]>;
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

// ---------------------------------------------------------------------------------------------
// The output (server only: the API sends simple-view.ts salesRouteView of it)
// ---------------------------------------------------------------------------------------------

/** What happened, or will happen, at one delivery (one stop of one trip) of the route. */
export type DeliveryStatus =
  | 'DELIVERED'
  | 'PARTLY_DELIVERED'
  | 'NOT_DELIVERED'
  /** The trip is over (or probably over) and the driver recorded no result for this stop. */
  | 'NO_RESULT'
  /** The truck was there (arrival or departure known) but the result is not in yet. */
  | 'VISITED'
  | 'AT_CUSTOMER'
  | 'NEXT'
  | 'ON_THE_WAY'
  /** Not visited yet while later stops were: still due, the driver serves other customers first. */
  | 'PASSED'
  | 'LOADING'
  | 'PLANNED'
  /** An earlier day's trip that never left. */
  | 'TRUCK_DID_NOT_GO';

/** Orders of the route that are not on a truck of the day. */
export type OffTruckKind = 'CANCELLED' | 'MOVED' | 'NOT_PLANNED' | 'PART_NOT_PLANNED' | 'ADDED_AFTER_PLAN' | 'NOT_PLANNED_YET';

/** Where an expected time comes from: the truck's GPS, the trip so far (the plan moved by the driver's updates), or the plan. */
export type EtaSource = 'GPS' | 'TRIP' | 'PLAN';

/**
 * The expected time against the window printed on the Salesman ETA: inside it, after it, "due now" (the plan says
 * the truck should be there and nothing says it is: no time), or no live time to give (no live updates from this
 * truck at all, a trip not marked as left, or a stop after one the clock decides: a lower bound at most).
 */
export type EtaTiming = 'ON_TIME' | 'LATE' | 'DUE_NOW' | 'NO_UPDATES';

/** The expected arrival of a delivery still to come (minutes of the delivery day). */
export interface DayEta {
  /** Rounded to 5, never before now; null: DUE_NOW or NO_UPDATES. */
  min: number | null;
  /** NO_UPDATES after a stop the clock decides: its projected arrival while it is still ahead, a lower bound (rounded to 5); else null. */
  notBeforeMin: number | null;
  source: EtaSource | null;
  timing: EtaTiming;
}

/** One delivery (one stop of one trip) of a route, or of a truck. */
export interface DayDelivery {
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  /** The route's cases on this delivery (a truck's: the stop's). */
  cases: number;
  /** The truck and trip (never sent: the order of deliveries at the same time, and the tests). */
  truckCode: string;
  loadNo: number;
  status: DeliveryStatus;
  /** The window printed on the Salesman ETA ("07:45-09:00") and its minutes; null when the plan has no time for the stop. */
  window: string | null;
  slot: { from: number; to: number } | null;
  /** The planned arrival (minutes of D); null = not planned. */
  plannedMin: number | null;
  /** The result's time (DELIVERED / PARTLY / NOT_DELIVERED): "10:31" and its minutes of D; else null. */
  at: string | null;
  atMin: number | null;
  /** The route's delivered cases of the route's cases (results only). */
  delivered: { cases: number; of: number } | null;
  /** The expected arrival (deliveries still to come on the delivery day, or a trip still out after midnight); else null. */
  eta: DayEta | null;
}

/** An order of the route (or taken off the truck) that is not on a truck of the day. */
export interface DayOffTruck {
  kind: OffTruckKind;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  cases: number;
  /** MOVED: the day it was moved to (YYYY-MM-DD); else null. */
  movedTo: string | null;
}

/** One route's day (kind ROUTE) or one truck's (kind TRUCK). */
export interface DayView {
  kind: SalesViewKind;
  /** The route code as stored, or the truck code as the plan shows it. */
  code: string;
  /** What the page asks for to refresh it: the route code, or "Truck <code>". */
  query: string;
  /** In expected order (the planned arrival, then truck, trip, stop). */
  deliveries: DayDelivery[];
  offTruck: DayOffTruck[];
}

export interface SalesDay {
  builtAt: Date;
  date: string;
  /** Every route of the day with a delivery or an order not on a truck, by its code. */
  routes: ReadonlyMap<string, DayView>;
  /** Every truck with a delivery on a plan in use of the day (all its trips, every route), by its truck id (never sent). */
  trucks: ReadonlyMap<string, DayView>;
  /** The day's trucks as a lookup reads them (route-code.ts matchLookup): the id and the code the plan shows. */
  truckRefs: readonly DayTruckRef[];
}

// ---------------------------------------------------------------------------------------------
// Live state of each trip
// ---------------------------------------------------------------------------------------------

/** The delivery date against the company's today (critique item 2): before it (a link still open after midnight), on it, after it. */
export type DayRel = 'PAST' | 'TODAY' | 'FUTURE';

export function dayRelOf(date: string, tz: string, now: Date): DayRel {
  const today = todayIso(tz, now);
  return date < today ? 'PAST' : date === today ? 'TODAY' : 'FUTURE';
}

/** Where a trip's live times come from (critique 4); OVER: probably finished. */
type LiveClass = 'GPS' | 'PHONE' | 'NONE' | 'OVER';

type StopKind = 'RESULT' | 'NO_RESULT' | 'AT_CUSTOMER' | 'VISITED' | 'PASSED' | 'NEXT' | 'ON_THE_WAY' | 'LOADING' | 'PLANNED' | 'TRUCK_DID_NOT_GO';

interface StopLive {
  kind: StopKind;
  /** The expected arrival (minutes of D) when it is a real time; null otherwise. */
  expectedMin: number | null;
  source: EtaSource | null;
  /** The clock pushed it or the phone was heard since: "due now", no time. */
  dueNow: boolean;
  /** No live time for this stop: none for the trip at all, a trip not marked as left, or after a stop the clock decides. */
  noLive: boolean;
  /** After a stop the clock pushed (or a phone heard since held): its projected arrival, a lower bound only. */
  notBefore: number | null;
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
  stop: Map<number, StopLive>;
}

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const backKeyOf = (depotId: string, date: string, truckId: string, loadNo: number) => `${depotId}|${date}|${truckId}|${loadNo}`;
const visitKeyOf = (depotId: string, date: string, truckId: string, loadNo: number, sequence: number) => `${depotId}|${date}|${truckId}|${loadNo}|${sequence}`;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
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
/** An expected time this much after the window's end is "late". */
export const LATE_TOLERANCE_MIN = 3;

function signTimes(v: SalesVisitIn | null): Date[] {
  if (!v) return [];
  return [v.arrivedAt, v.departedAt, v.outcomeSource !== 'DISPATCHER' ? v.outcomeAt : null, firstPhotoAt(v)].filter((t): t is Date => !!t);
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
      const live: LoadLive = { rec, stop: new Map() };
      out.set(L.id, live);
      const etaGps: EtaGps | null = input.gps && fact ? { fact, settings: input.gps.settings } : null;
      if (L.status === 'COMPLETED') {
        for (const [i, s] of rec.stops.entries()) live.stop.set(s.sequence, finishedStop(rec.visits[i]!));
        const backMin = rec.back ? minutesOnDate(rec.back, date, tz) : null;
        lateBy = backMin !== null ? Math.max(0, backMin - L.returnMin) : 0;
        continue;
      }
      if (L.status === 'DISPATCHED') {
        if (rec.back) {
          // Back at depot tapped, the trip not closed (a stop without a result): finished, never "on the road".
          for (const [i, s] of rec.stops.entries()) live.stop.set(s.sequence, finishedStop(rec.visits[i]!));
          lateBy = Math.max(0, minutesOnDate(rec.back, date, tz) - L.returnMin);
          continue;
        }
        lateBy = dispatchedLive(live, { input, nowMin, dayStart, lateDispatchMin, phoneSeenAt, later: list.slice(n + 1), etaGps, fact });
        continue;
      }
      // Not left: PLANNED, LOCKED, LOADING.
      if (rel === 'PAST') {
        for (const s of rec.stops) live.stop.set(s.sequence, plain('TRUCK_DID_NOT_GO'));
        lateBy = 0;
        continue;
      }
      const kind: StopKind = L.status === 'LOADING' ? 'LOADING' : 'PLANNED';
      if (rel === 'FUTURE') {
        for (const s of rec.stops) live.stop.set(s.sequence, plain(kind));
        continue;
      }
      // Today: from the later of now and the (moved) planned departure.
      const leaveMin = L.departMin + lateBy;
      if (nowMin > leaveMin + NOT_LEFT_AFTER_MIN) {
        // Should have left by now and not marked as left: no time to give (critique 14).
        for (const s of rec.stops) live.stop.set(s.sequence, { ...plain(kind), noLive: true });
        lateBy = Math.max(0, nowMin - L.departMin);
        continue;
      }
      const stopsIn = projectionStopsOf(rec.etaStops, { date, tz, now });
      const proj = projectLoad({ departMin: L.departMin, returnMin: L.returnMin, dispatchMin: Math.max(nowMin, leaveMin), nowMin, lateDispatchMin: null, phoneSeenMin: null, stops: stopsIn });
      for (const p of proj.stops) {
        const s = rec.stops.find((x) => x.sequence === p.sequence);
        const expected = p.arrMin;
        const source: EtaSource = expected !== null && s?.etaMin !== null && s?.etaMin !== undefined && expected === s.etaMin ? 'PLAN' : 'TRIP';
        live.stop.set(p.sequence, { ...plain(kind), expectedMin: expected, source: expected === null ? null : source });
      }
      lateBy = Math.max(0, proj.returnMin - L.returnMin);
    }
  }
  return out;
}

function plain(kind: StopKind): StopLive {
  return { kind, expectedMin: null, source: null, dueNow: false, noLive: false, notBefore: null };
}

/** A stop of a trip that is over: its result, else no result recorded. */
function finishedStop(v: SalesVisitIn | null): StopLive {
  return plain(v?.outcome ? 'RESULT' : 'NO_RESULT');
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

  if (cls === 'OVER') {
    for (const [i, s] of rec.stops.entries()) live.stop.set(s.sequence, finishedStop(rec.visits[i]!));
    const backMove = gpsBack ?? backIn;
    return backMove ? Math.max(0, minutesOnDate(backMove.at, date, tz) - L.returnMin) : 0;
  }

  // The first stop whose time the clock decides (critique 4): a pending stop the clock pushed or a phone heard since
  // held, or a stop being unloaded past its planned end (it ends "now"). The projected times after it are lower
  // bounds only (with GPS the live ETA gives them).
  const pushed =
    cls === 'GPS'
      ? null
      : (proj.stops.find((p, i) => (p.state === 'PENDING' && (p.clockBound || p.phoneHeld)) || (p.state === 'IN_PROGRESS' && has(p.startMin) && p.depMin === o.nowMin && o.nowMin > p.startMin + serviceOf(stopsIn[i]!))) ?? null);
  const afterPushed = (seq: number) => !!pushed && seq > pushed.sequence;

  const atStopSeq = liveEtas[0]?.atStop ? liveEtas[0].sequence : null;
  const gpsNext = liveEtas.find((e) => !e.atStop)?.sequence ?? null;
  const nextSeq = gpsGate ? gpsNext : (proj.next?.sequence ?? null);

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

  // Still-due stops (PASSED) come after the stops still ahead (critique 13): from the last one's projected end.
  const pendingEnds = proj.stops.filter((p) => p.state === 'PENDING' || p.state === 'IN_PROGRESS').map((p) => p.depMin).filter(has);
  const gpsEnds = liveEtas.map((e) => minutesOnDate(e.etaAt, date, tz));
  let passedFrom = Math.max(o.nowMin, ...pendingEnds, ...gpsEnds);
  let passedPrevPlanDep: number | null = null;

  for (const [i, s] of rec.stops.entries()) {
    const kind = kinds.get(s.sequence)!;
    const p: ProjectedStop | undefined = projOf.get(s.sequence);
    if (kind === 'RESULT' || kind === 'AT_CUSTOMER' || kind === 'VISITED') {
      live.stop.set(s.sequence, plain(kind));
      continue;
    }
    if (cls === 'NONE') {
      // No live source at all (critique 4): no time.
      live.stop.set(s.sequence, { ...plain(kind), noLive: true });
      continue;
    }
    if (kind === 'PASSED') {
      const service = (has(s.departureMin) && has(s.serviceStartMin) ? s.departureMin - s.serviceStartMin : s.serviceMin) || 0;
      const prevPlan = passedPrevPlanDep ?? planDepBefore(rec.stops, i, L.departMin);
      const leg = has(s.etaMin) ? Math.max(0, s.etaMin - prevPlan) : 0;
      const arr = passedFrom + leg;
      passedFrom = arr + service;
      passedPrevPlanDep = has(s.etaMin) ? s.etaMin + service : passedPrevPlanDep;
      // After the stops the clock decides: a lower bound only.
      if (pushed) live.stop.set(s.sequence, { ...plain('PASSED'), source: 'TRIP', notBefore: arr, noLive: true });
      else live.stop.set(s.sequence, { ...plain('PASSED'), expectedMin: arr, source: 'TRIP' });
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
        live.stop.set(s.sequence, { ...plain(kind), source, notBefore: expectedMin, noLive: true });
        continue;
      }
    }
    live.stop.set(s.sequence, { ...plain(kind), expectedMin, source, dueNow });
  }
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

/**
 * The expected arrival of a delivery still to come (null: nothing to say): the real time rounded to 5 and never
 * before now, LATE when it is after the printed window (critique 5); DUE_NOW when the clock pushed it (or the phone
 * was heard since) or it is behind the clock; NO_UPDATES without a live time, with the lower bound while it is still
 * ahead (never LATE by itself: it grows with the clock).
 */
export function etaView(l: Pick<StopLive, 'expectedMin' | 'source' | 'dueNow' | 'noLive' | 'notBefore'>, slot: { from: number; to: number } | null, nowMin: number): DayEta | null {
  if (l.noLive) {
    const notBeforeMin = has(l.notBefore) && l.notBefore > nowMin ? Math.max(round5(l.notBefore), ceil5(nowMin)) : null;
    return { min: null, notBeforeMin, source: null, timing: 'NO_UPDATES' };
  }
  if (l.dueNow || (has(l.expectedMin) && l.expectedMin < nowMin)) return { min: null, notBeforeMin: null, source: l.source, timing: 'DUE_NOW' };
  if (!has(l.expectedMin) || !l.source) return null;
  const e = l.expectedMin;
  const late = !!slot && e - slot.to >= LATE_TOLERANCE_MIN;
  return { min: Math.max(round5(e), ceil5(nowMin)), notBeforeMin: null, source: l.source, timing: late ? 'LATE' : 'ON_TIME' };
}

// ---------------------------------------------------------------------------------------------
// Per route
// ---------------------------------------------------------------------------------------------

interface DeliveryAcc {
  rec: LoadRec;
  stopIndex: number;
  stop: DetailStop;
  lineIds: Set<string>;
  cases: number;
}

interface OffAcc {
  kind: OffTruckKind;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  cases: number;
  movedTo: string | null;
}

const OFF_ORDER: Record<OffTruckKind, number> = { CANCELLED: 0, NOT_PLANNED: 1, PART_NOT_PLANNED: 2, ADDED_AFTER_PLAN: 3, NOT_PLANNED_YET: 4, MOVED: 5 };
const PENDING: ReadonlySet<DeliveryStatus> = new Set(['AT_CUSTOMER', 'NEXT', 'ON_THE_WAY', 'PASSED']);

/** Every route's and every truck's view of the day (see the file comment). */
export function buildSalesDay(input: SalesDayInput): SalesDay {
  const { date, tz, now } = input;
  const rel = dayRelOf(date, tz, now);
  const nowMin = minutesOnDate(now, date, tz);

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
  const leftOrders = new Set<string>();
  const movedOrders = new Set<string>();
  const onStopOrders = new Set<string>();
  const unservedOrders = new Set<string>();
  const offAdd = (
    m: Map<string, OffAcc>,
    kind: OffTruckKind,
    orderId: string,
    who: { customerCode: string; branchCode: string | null; customerName: string },
    ln: { cases: number },
    movedTo: string | null = null,
  ) => {
    const key = `${kind}|${orderId}|${movedTo ?? ''}`;
    const e = m.get(key) ?? { kind, customerCode: who.customerCode, branchCode: who.branchCode, customerName: who.customerName, cases: 0, movedTo };
    e.cases += ln.cases;
    m.set(key, e);
  };
  const listOff = (
    kind: OffTruckKind,
    orderId: string,
    who: { customerCode: string; branchCode: string | null; customerName: string },
    lines: readonly { salesRoute: string | null; cases: number }[],
    movedTo: string | null = null,
  ) => {
    for (const ln of lines) {
      if (!ln.salesRoute) continue;
      let m = off.get(ln.salesRoute);
      if (!m) off.set(ln.salesRoute, (m = new Map()));
      offAdd(m, kind, orderId, who, ln, movedTo);
    }
  };
  const addTo = (a: DeliveryAcc, ln: { lineId: string; cases: number }) => {
    a.lineIds.add(ln.lineId);
    a.cases += ln.cases;
  };
  // Each truck's deliveries (one per stop: all its lines left) and the orders taken off its trips.
  const truckDeliveries = new Map<string, DeliveryAcc[]>();
  const truckOff = new Map<string, Map<string, OffAcc>>();
  const truckOffOf = (truckId: string) => {
    let m = truckOff.get(truckId);
    if (!m) truckOff.set(truckId, (m = new Map()));
    return m;
  };

  for (const rec of recs) {
    const { facts } = rec.plan;
    const truckId = rec.load.truckId;
    for (const [i, stop] of rec.stops.entries()) {
      const cancelled = new Set(stop.cancelledOrderIds ?? []);
      const byRoute = new Map<string, DeliveryAcc>();
      const whole: DeliveryAcc = { rec, stopIndex: i, stop, lineIds: new Set(), cases: 0 };
      const moved = new Map<string, { salesRoute: string | null; cases: number }[]>();
      for (const ln of stop.orderLines) {
        onStopOrders.add(ln.orderId);
        const order = facts.orders.get(ln.orderId);
        // Cancelled as the plan read it, or since; only a trip that never left can hold one (listed from the day's cancelled orders).
        if (cancelled.has(ln.orderId) || (order?.cancelled && carriedLoadShows(rec.load.status))) {
          // The truck's list: taken off it (when the order is cancelled now).
          if (extraOf.get(ln.orderId)?.cancelled) offAdd(truckOffOf(truckId), 'CANCELLED', ln.orderId, stop, ln);
          continue;
        }
        const route = facts.lines.get(ln.lineId)?.salesRoute ?? null;
        if (order?.carriedTo && carriedLoadShows(rec.load.status)) {
          moved.set(ln.orderId, [...(moved.get(ln.orderId) ?? []), { salesRoute: route, cases: ln.cases }]);
          continue;
        }
        if (!carriedLoadShows(rec.load.status)) leftOrders.add(ln.orderId);
        addTo(whole, ln);
        if (!route) continue;
        let a = byRoute.get(route);
        if (!a) byRoute.set(route, (a = { rec, stopIndex: i, stop, lineIds: new Set(), cases: 0 }));
        addTo(a, ln);
      }
      for (const [route, a] of byRoute) {
        const list = deliveries.get(route);
        if (list) list.push(a);
        else deliveries.set(route, [a]);
      }
      if (whole.lineIds.size) {
        const list = truckDeliveries.get(truckId);
        if (list) list.push(whole);
        else truckDeliveries.set(truckId, [whole]);
      }
      for (const [orderId, lines] of moved) {
        movedOrders.add(orderId);
        const to = facts.orders.get(orderId)!.carriedTo!;
        listOff('MOVED', orderId, stop, lines, to);
        for (const ln of lines) offAdd(truckOffOf(truckId), 'MOVED', orderId, stop, ln, to);
      }
    }
  }

  // Left out of a plan (unserved), and received after it (pending), per plan.
  for (const plan of input.plans) {
    const d = plan.detail;
    const { facts } = plan;
    const linesByOrder = new Map<string, { lineId: string; salesRoute: string | null; cases: number }[]>();
    for (const [lineId, l] of facts.lines) {
      const list = linesByOrder.get(l.orderId);
      const x = { lineId, salesRoute: l.salesRoute, cases: l.cases };
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
          listOff('MOVED', u.orderId, u, lines, carriedTo);
        } else listOff('NOT_PLANNED', u.orderId, u, lines);
        continue;
      }
      const rest = lines.map((ln) => ({ ...ln, cases: ln.cases - (onTruck.get(ln.lineId) ?? 0) })).filter((ln) => ln.cases > 0);
      if (carriedTo) {
        movedOrders.add(u.orderId);
        listOff('MOVED', u.orderId, u, rest, carriedTo);
      } else listOff('PART_NOT_PLANNED', u.orderId, u, rest);
    }
    for (const p of facts.pending) {
      if (facts.orders.get(p.orderId)?.cancelled || extraOf.get(p.orderId)?.cancelled) continue;
      listOff('ADDED_AFTER_PLAN', p.orderId, p, linesByOrder.get(p.orderId) ?? []);
    }
  }

  // The day's cancelled orders (whatever their plan state), moved orders on no plan, and orders of depots not planned yet.
  const plannedDepots = new Set(input.plans.map((p) => p.detail.run.depot.id));
  for (const o of input.extraOrders) {
    if (o.cancelled) {
      if (!leftOrders.has(o.id)) listOff('CANCELLED', o.id, o, o.lines);
      continue;
    }
    if (o.carriedTo) {
      if (!movedOrders.has(o.id) && !onStopOrders.has(o.id) && !unservedOrders.has(o.id)) {
        movedOrders.add(o.id);
        listOff('MOVED', o.id, o, o.lines, o.carriedTo);
      }
      continue;
    }
    if (!plannedDepots.has(o.depotId)) listOff('NOT_PLANNED_YET', o.id, o, o.lines);
  }

  const ctx: RouteCtx = { input, lives, rel, nowMin };
  const routes = new Map<string, DayView>();
  const codes = [...new Set([...deliveries.keys(), ...off.keys()])].sort(compareSalesRoutes);
  for (const route of codes) {
    routes.set(route, dayView('ROUTE', route, deliveries.get(route) ?? [], [...(off.get(route)?.values() ?? [])], ctx));
  }
  // Each truck by the code of its first trip of the day (the plan's shownTruckCode: a day-hired truck's plate).
  const trucks = new Map<string, DayView>();
  const truckRefs: DayTruckRef[] = [];
  for (const [truckId, accs] of truckDeliveries) {
    const first = [...accs].sort((x, y) => x.rec.load.departMin - y.rec.load.departMin || x.rec.load.loadNo - y.rec.load.loadNo)[0]!;
    const code = first.rec.load.truckCode;
    truckRefs.push({ id: truckId, code });
    trucks.set(truckId, dayView('TRUCK', code, accs, [...(truckOff.get(truckId)?.values() ?? [])], ctx));
  }
  return { builtAt: now, date, routes, trucks, truckRefs };
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
          ...(v.arrivalSource === 'AYUN' && v.ownArrivedAt ? { ownArrivedAt: v.ownArrivedAt } : {}),
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
  rel: DayRel;
  nowMin: number;
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

/** One route's day (kind ROUTE: its deliveries and orders not on a truck) or one truck's (kind TRUCK: its stops, the orders taken off it). */
function dayView(kind: SalesViewKind, code: string, accs: DeliveryAcc[], offs: OffAcc[], c: RouteCtx): DayView {
  const { input, lives, rel, nowMin } = c;
  const { date, tz } = input;
  accs.sort(
    (x, y) =>
      (x.stop.etaMin ?? Number.POSITIVE_INFINITY) - (y.stop.etaMin ?? Number.POSITIVE_INFINITY) ||
      byText(x.rec.load.truckCode, y.rec.load.truckCode) ||
      x.rec.load.loadNo - y.rec.load.loadNo ||
      x.stop.sequence - y.stop.sequence,
  );
  const deliveries: DayDelivery[] = accs.map((a) => {
    const L = a.rec.load;
    const sl = lives.get(L.id)!.stop.get(a.stop.sequence) ?? plain('PLANNED');
    const v = a.rec.visits[a.stopIndex] ?? null;
    const slot = has(a.stop.etaMin) ? etaSlot(a.stop.etaMin, stopWindow(a.stop)) : null;

    let status: DeliveryStatus;
    let at: string | null = null;
    let atMin: number | null = null;
    let delivered: DayDelivery['delivered'] = null;
    if (sl.kind === 'RESULT' && v) {
      const r = routeResult(a, v);
      status = r.status;
      delivered = r.delivered;
      const when = v.outcomeAt ?? v.departedAt;
      if (when) {
        at = clockText(when, date, tz);
        atMin = minutesOnDate(when, date, tz);
      }
    } else status = sl.kind === 'RESULT' ? 'NO_RESULT' : (sl.kind as DeliveryStatus);

    // A live time only on the delivery day (or a trip still out after midnight): before it, the plan.
    const pending = rel !== 'FUTURE' && (PENDING.has(status) || ((status === 'PLANNED' || status === 'LOADING') && rel === 'TODAY'));
    return {
      customerName: a.stop.customerName,
      customerCode: a.stop.customerCode,
      branchCode: a.stop.branchCode,
      cases: a.cases,
      truckCode: L.truckCode,
      loadNo: L.loadNo,
      status,
      window: slot ? hhmmRange(slot.from, slot.to) : null,
      slot,
      plannedMin: has(a.stop.etaMin) ? a.stop.etaMin : null,
      at,
      atMin,
      delivered,
      eta: pending ? etaView(sl, slot, nowMin) : null,
    };
  });
  const offTruck: DayOffTruck[] = offs
    .sort((x, y) => OFF_ORDER[x.kind] - OFF_ORDER[y.kind] || byText(x.customerCode, y.customerCode) || byText(x.branchCode ?? '', y.branchCode ?? '') || byText(x.movedTo ?? '', y.movedTo ?? ''))
    .map((o) => ({ kind: o.kind, customerName: o.customerName, customerCode: o.customerCode, branchCode: o.branchCode, cases: o.cases, movedTo: o.movedTo }));
  return { kind, code, query: kind === 'TRUCK' ? truckQuery(code) : code, deliveries, offTruck };
}
