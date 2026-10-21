/**
 * A truck's day (owner request 18 Oct 2026: "if i want to go through a history of a vehicle with one
 * button ... i click on [a truck] it takes me to where the truck is and what it was doing, either redirects me
 * to ayun website or somewhere else"): the model of the page /t/[slug]/dispatch/truck/[truckId]?date=
 * and of GET /api/ivms/trucks/[id]/day. Pure and browser-safe: lib/ivms/truck-day-read.ts reads the rows
 * (every query names the company), buildTruckDay turns them into what the page shows, so every rule
 * below is unit-tested on invented data (tests/lib/ivms-truck-day.spec.ts).
 *
 * What it shows, all from RouteIQ's own data (never an IMEI, an Ayun object or zone name, or any other
 * provider field; the depot moves carry their kind, origin and time only):
 * - the truck's loads that date on the plans in use (the rule of the plan screen and the day results:
 *   lib/delivery/day-results.ts liveRunsInRange), their status and RouteIQ's own driver;
 * - the timeline, in the order things happened: the Dispatch press, depot OUT and IN (the driver's taps,
 *   the GPS trail, Ayun's webhook or event list), each stop with its plan, its actual arrival and
 *   departure and who recorded them (driver, dispatcher, GPS), the time on site against the planned
 *   unloading, a wait for the receiving window, the result with its reason and note, the photos; GPS
 *   stays at a customer that did not become the stop's times ("earlier GPS visit": a first visit refused
 *   and a return later); the operations alerts raised for the truck that day. What has not happened yet
 *   is placed at its planned time, never before what already happened on the same truck-day;
 * - the map: the depot, the stops numbered and coloured by result, the day's GPS trail (at most
 *   TRAIL_MAX_POINTS, evenly thinned; only for the days the retention keeps whole, today and yesterday
 *   with the default ivmsTrailDays of 2: trailKept), the live position;
 * - the live status (today or yesterday, only while a load of that date is out: Locked, Loading or On the
 *   road, as the live map; never a truck off duty): the last fix, moving or parked since, the speed, the
 *   straight-line distance to the depot, the next stop and its live ETA (the day screen's own rules:
 *   lib/ivms/live-map.ts liveVehicleOf and lib/ivms/eta.ts liveEta);
 * - the depot taps as the rest of RouteIQ counts them: the Leaving for next load tap rule R2 counts (the
 *   latest before the first stop), the earliest Back at depot; the other taps are named on that line.
 *
 * By the company's GPS tracking mode (TenantConfig.ivmsMode; the kill switch ROUTEIQ_DISABLE_IVMS counts
 * as OFF, the reader passes the mode in effect):
 * - OFF: the plan and the results, with each visit's times as the driver and the office made them
 *   (lib/delivery/visit.ts withoutGpsTimes); no position, no trail, no GPS move, no GPS visit, and a
 *   note that GPS tracking is off;
 * - MAP: the live position, but no trail and no GPS time (the visits as with OFF);
 * - TIMES: everything. A truck-day whose GPS is suppressed (an admin's undo, a tracker that did not match
 *   the driver's phone, a tracker changed: IvmsTruckDay.suppressedAt) shows no trail, no GPS move and no
 *   GPS visit, as its GPS times were removed.
 * Reads only: nothing here writes, calls Ayun, or changes what another screen shows. "Open Ayun" is a
 * plain link to the provider's site (AYUN_WEB_URL) in a new tab: Ayun has no link to one vehicle, and
 * RouteIQ never passes a key, a user name or a password to it.
 */
import { alertReviewFlags, alertReviewText, alertStateText, alertText, ruleLabel } from '../alerts/view';
import { SEVERITY_LABEL } from '../alerts/catalog';
import type { OpsAlertRow } from '../alerts/types';
import { afterResultText, awayText, countOf, GPS_WORD, OUTCOME_LABEL, reasonText, sourceWord } from '../delivery/office-text';
import { countedLeaveTap, firstSignOf } from '../delivery/turnaround';
import { afterResultOf, cyclesOf, GPS_DEPARTURE_MATCH_MIN, withoutGpsTimes, type VisitEvent, type VisitTimes } from '../delivery/visit';
import { distanceM } from '../dispatch/snapshots';
import { addDaysIso, fmtDayMonth, fmtHhmm, fmtWindow, localMinutes, todayIso, zonedDayStart } from '../dispatch/time';
import { AT_STOP_MARGIN_M, liveEta } from './eta';
import { gpsFactText, liveVehicleOf, type PositionRow } from './live-map';
import { ivmsModeAtLeast } from './settings';
import { MOVING_KMH, type IvmsEventOrigin, type IvmsMode } from './types';

// ---------------------------------------------------------------------------------------------------
// Limits

/** "Open Ayun": the provider's own site, opened in a new tab (no deep link to a vehicle exists). */
export const AYUN_WEB_URL = 'https://server.ayunts.com';
/** At most this many trail points reach the page (the map line); more are thinned evenly. */
export const TRAIL_MAX_POINTS = 2000;
/** At most this many trail points are read for one truck-day (a fix every 10 s for a whole day is 8,640). */
export const TRAIL_READ_MAX = 20_000;
/** The page's own request limit: 30 a minute per user (a 60 s refresh, some date changes and reloads). */
export const TRUCK_DAY_RATE = { limit: 30, windowMs: 60_000 } as const;
/** The date picker offers the dates with a load of the truck in this range around today. */
export const TRUCK_DAY_DATES_BACK = 62;
export const TRUCK_DAY_DATES_AHEAD = 14;
/** The page reads its day again this often while the truck can move on it (today, or a load still out). */
export const TRUCK_DAY_REFRESH_MS = 60_000;
/** The trail and the depot moves of a day run from its local midnight to 24 h later, or to its last activity + 15 min (at most 27 h). */
const TRAIL_AFTER_MIN = 15;
const TRAIL_MAX_AFTER_H = 27;
/** The stop events, the depot moves and the alerts read for one truck-day, at most. */
export const TRUCK_DAY_EVENTS_MAX = 2000;
export const TRUCK_DAY_MOVES_MAX = 200;
export const TRUCK_DAY_ALERTS_MAX = 200;

const MIN = 60_000;
const HOUR = 3_600_000;
const OUT_STATUSES = new Set(['LOCKED', 'LOADING', 'DISPATCHED']);
/** Which load out is "the" load of the live position: the one on the road first (as the day screen's live map). */
const OUT_RANK: Record<string, number> = { DISPATCHED: 3, LOADING: 2, LOCKED: 1 };

// ---------------------------------------------------------------------------------------------------
// What the reader gives

/** One planned stop of a load (lib/delivery/day-results.ts PlannedStopRow, the fields used here). */
export interface TruckDayStopInput {
  sequence: number;
  customerCode: string;
  customerName: string;
  /** Planned arrival, minutes from the delivery day's local midnight. */
  etaMin: number | null;
  plannedServiceMin: number | null;
  windowStartMin: number | null;
  windowEndMin: number | null;
  pin: { lat: number; lng: number } | null;
  casesPlanned: number;
}

/** One load of the truck on the plans in use of the date. */
export interface TruckDayLoadInput {
  id: string;
  runId: string;
  depotId: string;
  loadNo: number;
  status: string;
  departMin: number;
  returnMin: number;
  driverName: string | null;
  driverCasual: boolean;
  /** The Dispatch press (lib/dispatch/dispatched-at.ts), else null. */
  dispatchedAt: Date | null;
  statusChangedAt: Date | null;
  stops: TruckDayStopInput[];
}

/** A stored visit (StopVisit), as the driver, the office and (TIMES) GPS made it. */
export interface TruckDayVisitInput extends VisitTimes {
  depotId: string;
  loadNo: number;
  sequence: number;
  reason: string | null;
  reasonNote: string | null;
  casesPlanned: number;
  casesDelivered: number | null;
  photoCount: number;
  outcomeLate: boolean;
  /**
   * When the phone took its own photos of the visit (PHONE_AUTO / PHONE_MANUAL, not an old gallery photo):
   * a first sign of the truck at the stop, as rule R2 reads it (lib/delivery/turnaround.ts firstSignOf),
   * for which Leaving for next load tap counts. Absent: none.
   */
  phonePhotoTimes?: Date[];
}

/** A load-level tap (BACK_AT_DEPOT, DEPOT_DEPART) or a GPS arrival / departure (source AYUN) of the truck-day. */
export interface TruckDayEventInput {
  depotId: string;
  loadNo: number;
  sequence: number | null;
  kind: string;
  source: string;
  at: Date;
  receivedAt: Date;
  payload: Record<string, unknown> | null;
}

/** A depot move (IvmsEvent DEPOT_IN / DEPOT_OUT): its kind, origin, time, depot and what processing did with it. */
export interface TruckDayMoveInput {
  kind: string;
  origin: string;
  at: Date;
  depotId: string | null;
  outcome: string | null;
}

export interface TruckDayTrailInput {
  fixAt: Date;
  lat: number;
  lng: number;
  speedKmh: number | null;
}

export interface TruckDayInput {
  now: Date;
  tz: string;
  /** YYYY-MM-DD. */
  date: string;
  /** The mode in effect (the kill switch is OFF). */
  mode: IvmsMode;
  /** TenantConfig.ivmsTrailDays: how long the trail is kept (the note for an older day). */
  trailDays: number;
  truck: { id: string; code: string; description: string | null; hired: boolean; oneDay: boolean; depotId: string; hasTracker: boolean };
  depots: { id: string; code: string; name: string; lat: number; lng: number }[];
  loads: TruckDayLoadInput[];
  visits: TruckDayVisitInput[];
  events: TruckDayEventInput[];
  moves: TruckDayMoveInput[];
  trail: TruckDayTrailInput[];
  truckDay: { suppressedAt: Date | null; suppressReason: string | null; gpsFactsJson: unknown } | null;
  position: PositionRow | null;
  alerts: OpsAlertRow[];
  /** The dates with a load of this truck (the date picker), any order. */
  dates: string[];
  cfg: { avgSpeedKmh: number; distanceMultiplier: number; stopRadiusM: number };
}

// ---------------------------------------------------------------------------------------------------
// What the page gets

export type TruckDayResult = 'DELIVERED' | 'PARTLY_DELIVERED' | 'NOT_DELIVERED' | 'PENDING';

/** A stop's colour on the map and in the legend: by its result. */
export const RESULT_COLOR: Record<TruckDayResult, string> = {
  DELIVERED: '#16A34A',
  PARTLY_DELIVERED: '#D97706',
  NOT_DELIVERED: '#DC2626',
  PENDING: '#64748b',
};

/** One planned stop with what happened there (the map's numbered marker and the timeline's stop). */
export interface TruckDayStop {
  loadId: string;
  loadNo: number;
  depotId: string;
  sequence: number;
  customerCode: string;
  customerName: string;
  /** The planned pin, 5 decimals; null without one. */
  lat: number | null;
  lng: number | null;
  /** The map's colour: the result, else PENDING. */
  result: TruckDayResult;
  /** PENDING: nothing yet; AT_STOP: arrived, not left, no result; LEFT: left without a result; DONE: a result. */
  state: 'PENDING' | 'AT_STOP' | 'LEFT' | 'DONE';
  /** ISO times. */
  plannedAt: string | null;
  arrivedAt: string | null;
  /** "driver", "dispatcher", "GPS (Ayun)" (lib/delivery/office-text.ts sourceWord). */
  arrivalBy: string | null;
  arrivalObserved: boolean;
  departedAt: string | null;
  departureBy: string | null;
  /** No departure was seen: the result time ended the stop. */
  departedAtResult: boolean;
  /** Arrival minus the planned arrival, whole minutes (positive = late). */
  lateMin: number | null;
  /** Departure minus arrival less the minutes away, whole minutes (owner request 19 Oct 2026: the time on site). */
  onSiteMin: number | null;
  /** Minutes the GPS showed the truck away from the customer between the arrival and the departure (StopVisit.awayMinutes); null: none. */
  awayMin: number | null;
  /**
   * The driver's own arrival tap a GPS arrival replaced (owner decision 21 Oct 2026: GPS arrival wins; StopVisit.ownArrivedAt),
   * ISO: "driver tapped 10:15" beside the GPS time, for coaching late taps. Null: none replaced (or GPS times not shown).
   */
  arrivalTapAt: string | null;
  /** F2: whole minutes the truck still stood at the stop after the driver's result (StopVisit.afterResultMinutes, never unloading); null: none. */
  afterResultMin: number | null;
  plannedServiceMin: number | null;
  /** Arrived before the receiving window opened: about this many minutes of waiting. */
  waitedMin: number | null;
  window: string | null;
  resultAt: string | null;
  resultBy: string | null;
  /** "Delivered", "Partly delivered: Shop closed", "Not delivered: Other - gate locked". */
  resultText: string | null;
  casesPlanned: number;
  casesDelivered: number | null;
  photos: number;
}

export type TimelineKind = 'DISPATCHED' | 'DEPOT_OUT' | 'STOP' | 'GPS_VISIT' | 'DEPOT_IN' | 'COMPLETED' | 'ALERT';
export type TimelineTone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

/** One line of the timeline. */
export interface TimelineItem {
  key: string;
  kind: TimelineKind;
  /** When it happened (ISO); null: it has not happened (yet), `plannedAt` is the plan's time. */
  at: string | null;
  plannedAt: string | null;
  loadNo: number | null;
  sequence: number | null;
  title: string;
  /** Who or what recorded it: "driver", "dispatcher", "GPS (Ayun)", "GPS trail", "Ayun webhook". */
  source: string | null;
  lines: string[];
  tone: TimelineTone;
}

export interface TruckDayLive {
  fixAt: string;
  ageSec: number;
  /** Older than 5 min (or invalid): grey, no speed, never moving, no ETA (lib/ivms/live-map.ts fixStale). */
  stale: boolean;
  lat: number;
  lng: number;
  speedKmh: number | null;
  moving: boolean;
  /** The last moving fix, while parked (ISO); null while moving, stale or unknown. */
  parkedSince: string | null;
  parkedMin: number | null;
  /** Straight-line km to the depot of the load out (else the truck's depot), 1 decimal. */
  depotKm: number | null;
  loadNo: number | null;
  next: { loadNo: number; sequence: number; customerName: string; plannedAt: string | null; etaAt: string; delayMin: number | null; atStop: boolean } | null;
  /** The status line: "Updated 2 min ago (10:42) · moving, 42 km/h · 4.2 km from the depot · next: ...". */
  text: string;
}

export interface TruckDayLoad {
  id: string;
  runId: string;
  depotId: string;
  loadNo: number;
  status: string;
  /** ISO times of the planned departure and return. */
  departAt: string;
  returnAt: string;
  driverName: string | null;
  driverCasual: boolean;
  stops: number;
  /** Stops with a result. */
  done: number;
}

export interface TruckDayModel {
  truck: { id: string; code: string; description: string | null; hired: boolean; oneDay: boolean };
  date: string;
  today: string;
  tz: string;
  mode: IvmsMode;
  gps: {
    hasTracker: boolean;
    /** What GPS adds to this day: the trail line, GPS times and moves, the live position. */
    trail: boolean;
    times: boolean;
    live: boolean;
    /** Why something is missing, in words (GPS off, map only, suppressed, the trail no longer kept, ...). */
    notes: string[];
    /** What the stop detector saw but did not write by itself (lib/ivms/live-map.ts gpsFactText). */
    facts: string[];
  };
  /** The dates with a load of this truck, newest first (the date picker). */
  dates: string[];
  depots: { id: string; code: string; name: string; lat: number; lng: number }[];
  loads: TruckDayLoad[];
  drivers: string[];
  stops: TruckDayStop[];
  /** [lng, lat] at 5 decimals, in time order; `total` = points stored for the day before thinning. */
  trail: { points: [number, number][]; total: number; from: string | null; to: string | null };
  live: TruckDayLive | null;
  timeline: TimelineItem[];
  summary: { stops: number; delivered: number; partly: number; notDelivered: number; pending: number };
  ayunUrl: string;
}

// ---------------------------------------------------------------------------------------------------
// Small pure helpers (exported for the tests and the page)

/** A real calendar date written YYYY-MM-DD (the API's `date`, the page's `?date=`). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The page's own address for a truck and a date (the plan screen's truck link). */
export function truckDayHref(slug: string, truckId: string, date: string): string {
  return `/t/${encodeURIComponent(slug)}/dispatch/truck/${encodeURIComponent(truckId)}?date=${encodeURIComponent(date)}`;
}

/**
 * hh:mm of an instant on the delivery day's clock (the plan's minutes from its local midnight): "00:40 +1"
 * after that midnight (a late return), the plain local time before it.
 */
export function timeOnDay(at: Date | string, dayStart: Date, tz: string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const m = Math.floor((d.getTime() - dayStart.getTime()) / MIN);
  return m >= 0 ? fmtHhmm(m) : fmtHhmm(localMinutes(d, tz));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The date picker's words: "Sat 18 Oct (today)", "Fri 17 Oct (yesterday)", "Sun 19 Oct (tomorrow)", "Thu 16 Oct". */
export function dateLabel(date: string, today: string): string {
  const wd = WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()] ?? '';
  const rel = date === today ? ' (today)' : date === addDaysIso(today, -1) ? ' (yesterday)' : date === addDaysIso(today, 1) ? ' (tomorrow)' : '';
  return `${wd} ${fmtDayMonth(date)}${rel}`.trim();
}

/**
 * The date picker: the dates with a load of the truck, newest first, and the date shown even when it has
 * none (a bookmarked day whose loads moved); with the dates just before and after the one shown.
 */
export function datePicker(dates: readonly string[], date: string): { options: string[]; older: string | null; newer: string | null } {
  const options = [...new Set([...dates, date])].sort((a, b) => b.localeCompare(a));
  const at = options.indexOf(date);
  return { options, older: options[at + 1] ?? null, newer: at > 0 ? options[at - 1]! : null };
}

/** How often the page reads its day again: every minute while the truck can move on it, else never (null). */
export function truckDayRefreshMs(m: Pick<TruckDayModel, 'date' | 'today' | 'live'>): number | null {
  return m.date === m.today || m.live ? TRUCK_DAY_REFRESH_MS : null;
}

/** What the truck day page shows for the date picked (truckDayScreen). */
export interface TruckDayScreen {
  /**
   * DAY: the day read for the date picked; HELD: another date's day is still held (a date just picked,
   * or its read failed): only the truck and the date picker are shown from it, never its loads, summary,
   * live status, map or timeline under the date picked; NONE: nothing read yet.
   */
  show: 'DAY' | 'HELD' | 'NONE';
  /** "Loading...": a read of the date picked is in flight. Never left on once that read has failed. */
  loading: boolean;
  /** The error to show; null: none. */
  message: string | null;
  /** A "Try again" button next to the message: the read failed and none is in flight. */
  retry: boolean;
}

/**
 * The page's state from its reads (app/t/[slug]/dispatch/truck/[truckId]/use-truck-day.ts: `error` is the
 * failed read of the date picked only): review of 18 Oct 2026, a date whose read failed (a 429 after
 * clicking quickly through dates, a 500) left the page on the old date's loads with "Loading..." for good
 * and no way to read it again. Now the old day is never shown as the date picked, the loading stops when
 * the read has failed, and the error comes with "Try again".
 */
export function truckDayScreen(s: { data: { date: string } | null; error: string | null; loading: boolean }, date: string): TruckDayScreen {
  const show = !s.data ? 'NONE' : s.data.date === date ? 'DAY' : 'HELD';
  const failed = !!s.error && !s.loading;
  // The day of the date picked: a later read that failed (a refresh) says the day shown is the last read.
  if (show === 'DAY') return { show, loading: s.loading, message: s.error ? `${s.error} The day shown is from the last read.` : null, retry: failed };
  return { show, loading: !failed, message: failed ? s.error : null, retry: failed };
}

/**
 * The time range of a day's trail and depot moves: its local midnight to 24 h later, or to its last
 * activity (a late Back at depot, a result after midnight) + 15 min when that is later, never past 27 h.
 */
export function trailWindow(dayStart: Date, lastActivity: Date | null): { from: Date; to: Date } {
  const end = dayStart.getTime() + 24 * HOUR;
  const cap = dayStart.getTime() + TRAIL_MAX_AFTER_H * HOUR;
  const after = lastActivity ? lastActivity.getTime() + TRAIL_AFTER_MIN * MIN : end;
  return { from: dayStart, to: new Date(Math.min(cap, Math.max(end, after))) };
}

/**
 * Is a day's GPS trail shown? Only for the days the retention keeps whole (TenantConfig.ivmsTrailDays,
 * 1-7, default 2: today and yesterday), never a later day: an older day's trail is deleted, or half
 * deleted, and a part of a trail would mislead. The times and the depot moves of an older day stay.
 */
export function trailKept(date: string, today: string, trailDays: number): boolean {
  const kept = Math.min(7, Math.max(1, Math.floor(trailDays) || 1));
  return date <= today && date >= addDaysIso(today, -(kept - 1));
}

/** The latest moment something was recorded on the truck-day (a visit's times, a tap, a completion), or null. */
export function lastActivityOf(
  visits: readonly Pick<TruckDayVisitInput, 'arrivedAt' | 'departedAt' | 'outcomeAt'>[],
  events: readonly Pick<TruckDayEventInput, 'at'>[],
  loads: readonly Pick<TruckDayLoadInput, 'status' | 'statusChangedAt'>[] = [],
): Date | null {
  let best = -Infinity;
  for (const v of visits) for (const d of [v.arrivedAt, v.departedAt, v.outcomeAt]) if (d) best = Math.max(best, d.getTime());
  for (const e of events) best = Math.max(best, e.at.getTime());
  for (const l of loads) if (l.status === 'COMPLETED' && l.statusChangedAt) best = Math.max(best, l.statusChangedAt.getTime());
  return Number.isFinite(best) ? new Date(best) : null;
}

/**
 * At most `max` points of a trail, evenly spread over it: the first and the last are always kept, so the
 * line starts and ends where the truck did. Fewer points are returned as they are.
 */
export function downsampleTrail<T>(points: readonly T[], max: number = TRAIL_MAX_POINTS): T[] {
  const n = Math.max(2, Math.floor(max));
  if (points.length <= n) return [...points];
  const step = (points.length - 1) / (n - 1);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

/** A GPS stay at a stop that did not become the stop's times. */
export interface OtherGpsStay {
  from: Date;
  to: Date | null;
  /** Before or after the arrival shown; UNUSED when the stop has no arrival at all. */
  when: 'EARLIER' | 'LATER' | 'UNUSED';
}

/**
 * The GPS (AYUN) stays at a stop that are not the stop's own (lib/delivery/visit.ts): a stay there at the
 * arrival time, or begun at most GPS_DEPARTURE_MATCH_MIN after it, is its own; so is (owner request 19 Oct
 * 2026) every stay between the arrival and the departure shown - at a big customer the truck comes back
 * to the pin and the departure is taken from the stay that holds the result. A customer who refused at
 * 10:02 and received at 13:40: the 10:02 stay is an "earlier GPS visit".
 */
export function otherGpsStays(gps: readonly VisitEvent[], shown: { arrivedAt: Date | null; departedAt?: Date | null }): OtherGpsStay[] {
  const cycles = cyclesOf(gps.filter((e) => e.source === 'AYUN' && (e.kind === 'ARRIVED' || e.kind === 'DEPARTED')));
  const match = GPS_DEPARTURE_MATCH_MIN * MIN;
  const a = shown.arrivedAt ? shown.arrivedAt.getTime() : null;
  // The stop's own stays begin by 15 min after the arrival, or before the departure shown when that is later.
  const ownUntil = a === null ? null : Math.max(a + match, shown.departedAt ? shown.departedAt.getTime() - 1 : -Infinity);
  const out: OtherGpsStay[] = [];
  for (const c of cycles) {
    const dep = c.departure ? c.departure.at.getTime() : null;
    if (a !== null && ownUntil !== null && c.start <= ownUntil && (dep === null || dep > a)) continue;
    out.push({ from: new Date(c.start), to: dep === null ? null : new Date(dep), when: a === null ? 'UNUSED' : c.start < a ? 'EARLIER' : 'LATER' });
  }
  return out;
}

/** Where a depot move came from, in words. */
export const MOVE_ORIGIN_WORD: Record<IvmsEventOrigin, string> = { TRAIL: 'GPS trail', WEBHOOK: 'Ayun webhook', BACKSTOP: 'Ayun event list' };
/** Depot moves that are not shown: the same move from another origin, not a depot, or not used by the processing. */
const HIDDEN_MOVE_OUTCOMES = new Set(['DUPLICATE', 'NO_DEPOT', 'SUPPRESSED', 'STALE']);

const SUPPRESS_TEXT: Record<string, string> = {
  UNDO: 'a company admin undid them',
  MISMATCH: "the tracker's positions did not match the driver's phone",
  REMAP: "the truck's tracker was changed",
};

const LOAD_STATUS_WORD: Record<string, string> = { PLANNED: 'Planned', LOCKED: 'Locked', LOADING: 'Loading', DISPATCHED: 'On the road', COMPLETED: 'Completed' };
export function loadStatusWord(status: string): string {
  return LOAD_STATUS_WORD[status] ?? status;
}

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const minutesBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MIN);
const okPoint = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

function agoText(sec: number): string {
  if (sec < 90) return '1 min ago';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min ago`;
}

// ---------------------------------------------------------------------------------------------------
// The model

export function buildTruckDay(i: TruckDayInput): TruckDayModel {
  const tz = i.tz;
  const today = todayIso(tz, i.now);
  const dayStart = zonedDayStart(i.date, tz);
  const hhmm = (d: Date) => timeOnDay(d, dayStart, tz);
  const atMin = (m: number) => new Date(dayStart.getTime() + m * MIN);
  const suppressed = !!i.truckDay?.suppressedAt;
  // GPS times, depot moves, GPS visits, the trail and the facts: TIMES only, never on a suppressed truck-day.
  const gpsTimes = ivmsModeAtLeast(i.mode, 'TIMES') && !suppressed;
  const loads = [...i.loads].sort((a, b) => a.departMin - b.departMin || a.loadNo - b.loadNo);
  const anyOut = loads.some((l) => OUT_STATUSES.has(l.status));
  // The live position: today or yesterday, and only while the truck has a load of that date out (Locked,
  // Loading, On the road), the live map's own rule (lib/ivms/vehicles.ts readLiveVehicles, review M7: no
  // position of a truck off duty). A position row the poller has not cleared yet (a backoff, the
  // retention's delay) is never shown for a truck whose loads are all Completed or still Planned (review
  // of 18 Oct 2026). The reader reads it under the same rule (lib/ivms/truck-day-read.ts).
  const liveDay = anyOut && (i.date === today || i.date === addDaysIso(today, -1));
  const liveOn = ivmsModeAtLeast(i.mode, 'MAP') && liveDay;
  const depotOf = new Map(i.depots.map((d) => [d.id, d]));

  // The visits as this mode shows them: without GPS times unless TIMES (the alerts and the phone's own view).
  const visitKey = (depotId: string, loadNo: number, seq: number) => `${depotId}|${loadNo}|${seq}`;
  const visits = new Map(i.visits.map((v) => [visitKey(v.depotId, v.loadNo, v.sequence), gpsTimes ? v : withoutGpsTimes(v)]));
  const events = i.events.filter((e) => e.source !== 'AYUN' || gpsTimes);
  // The depot moves shown (TIMES only): not the same move from another origin, nor one processing did not use.
  const moves = gpsTimes ? i.moves.filter((m) => (m.kind === 'DEPOT_IN' || m.kind === 'DEPOT_OUT') && !HIDDEN_MOVE_OUTCOMES.has(m.outcome ?? '')) : [];
  // The trail (TIMES, not suppressed, a day the retention keeps whole).
  const kept = trailKept(i.date, today, i.trailDays);
  const trailPts = gpsTimes && kept ? i.trail.filter((p) => okPoint(p.lat, p.lng)).sort((a, b) => a.fixAt.getTime() - b.fixAt.getTime()) : [];
  // The day shows something GPS recorded: a trail, a depot move, a GPS stay or a GPS time of a stop.
  const gpsShown = trailPts.length > 0 || moves.length > 0 || events.some((e) => e.source === 'AYUN') || [...visits.values()].some((v) => v.arrivalSource === 'AYUN' || v.departureSource === 'AYUN');

  const notes: string[] = [];
  if (i.mode === 'OFF') notes.push("GPS tracking is off (Settings, company admin): this page shows the plan and the results the drivers and the office recorded. Ayun's own site still has the truck's history.");
  else if (i.mode === 'MAP') notes.push("GPS tracking is on for the live map only: the times are the drivers' and the office's, and no GPS trail is kept.");
  // No tracker set: `hasTracker` is the truck's tracker NOW. A day recorded while it had one keeps its
  // trail and GPS times (the reader still reads them), so the note never says "from the driver's phone
  // only" next to them (review of 18 Oct 2026: a tracker taken off this morning, yesterday opened).
  if (i.mode !== 'OFF' && !i.truck.hasTracker) {
    notes.push(
      gpsShown
        ? 'No GPS tracker is set on this truck now (Trucks page, company admin): the GPS times and the trail shown here were recorded while it had one.'
        : "This truck has no GPS tracker set (Trucks page, company admin): its times come from the driver's phone only.",
    );
  }
  if (ivmsModeAtLeast(i.mode, 'TIMES') && suppressed) {
    const why = SUPPRESS_TEXT[i.truckDay?.suppressReason ?? ''] ?? 'they were switched off';
    notes.push(`GPS times of this truck-day were removed (${why}): no GPS trail, depot move or GPS time is shown for it.`);
  }

  // ----- Stops
  const stops: TruckDayStop[] = [];
  const stopItems = new Map<string, TimelineItem>();
  const gpsVisitItems: TimelineItem[] = [];
  for (const l of loads) {
    for (const s of [...l.stops].sort((a, b) => a.sequence - b.sequence)) {
      const v = visits.get(visitKey(l.depotId, l.loadNo, s.sequence)) ?? null;
      const stop = stopOf(l, s, v, atMin, dayStart);
      stops.push(stop);
      stopItems.set(visitKey(l.depotId, l.loadNo, s.sequence), stopItem(stop, s, v, hhmm));
      if (gpsTimes) {
        const gps: VisitEvent[] = events
          .filter((e) => e.source === 'AYUN' && e.depotId === l.depotId && e.loadNo === l.loadNo && e.sequence === s.sequence && (e.kind === 'ARRIVED' || e.kind === 'DEPARTED'))
          .map((e) => ({ kind: e.kind as VisitEvent['kind'], source: 'AYUN', at: e.at, receivedAt: e.receivedAt, payload: e.payload }));
        for (const g of otherGpsStays(gps, { arrivedAt: v?.arrivedAt ?? null, departedAt: v?.departedAt ?? null })) {
          const word = g.when === 'EARLIER' ? 'Earlier' : g.when === 'LATER' ? 'Later' : 'Other';
          const dur = g.to ? ` (${minutesBetween(g.from, g.to)} min)` : '';
          gpsVisitItems.push({
            key: `gps:${l.depotId}:${l.loadNo}:${s.sequence}:${g.from.getTime()}`,
            kind: 'GPS_VISIT',
            at: g.from.toISOString(),
            plannedAt: null,
            loadNo: l.loadNo,
            sequence: s.sequence,
            title: `${word} GPS visit · stop ${s.sequence} · ${s.customerName}`,
            source: GPS_WORD,
            lines: [
              `At the customer ${hhmm(g.from)}-${g.to ? hhmm(g.to) : 'no departure seen'}${dur}`,
              v?.arrivedAt
                ? `Not the stop's times: the stop's arrival is ${hhmm(v.arrivedAt)} (${sourceWord(v.arrivalSource)})`
                : "The truck's tracker saw it at this customer; it did not become the stop's times",
            ],
            tone: 'info',
          });
        }
      }
    }
  }

  // ----- The timeline in plan order (each load: dispatch, leaving taps, stops, back, completed)
  const planOrder: TimelineItem[] = [];
  for (const l of loads) {
    const tag = `L${l.loadNo}`;
    const dispatched = l.dispatchedAt ?? (l.status === 'DISPATCHED' ? l.statusChangedAt : null);
    const onRoad = l.status === 'DISPATCHED' || l.status === 'COMPLETED';
    const depot = depotOf.get(l.depotId);
    const loadLines = [
      `Planned departure ${fmtHhmm(l.departMin)}, back ${fmtHhmm(l.returnMin)}; ${countOf(l.stops.length, 'stop')}`,
      `Driver: ${l.driverName ?? 'none'}${l.driverName && l.driverCasual ? ' (daily driver)' : ''}`,
      ...(depot ? [`Depot: ${depot.name}`] : []),
    ];
    planOrder.push(
      onRoad
        ? { key: `dispatch:${l.id}`, kind: 'DISPATCHED', at: iso(dispatched), plannedAt: iso(atMin(l.departMin)), loadNo: l.loadNo, sequence: null, title: `${tag} dispatched`, source: dispatched ? 'dispatcher (Dispatch)' : null, lines: dispatched ? loadLines : [...loadLines, 'The time of the Dispatch press is not recorded'], tone: 'ok' }
        : { key: `dispatch:${l.id}`, kind: 'DISPATCHED', at: null, plannedAt: iso(atMin(l.departMin)), loadNo: l.loadNo, sequence: null, title: `${tag} planned departure`, source: null, lines: [...loadLines, `Status: ${loadStatusWord(l.status)}`], tone: 'muted' },
    );
    const mine = (kind: string) => events.filter((e) => e.kind === kind && e.loadNo === l.loadNo && e.depotId === l.depotId).sort((a, b) => a.at.getTime() - b.at.getTime());
    const tapTimes = (list: readonly TruckDayEventInput[]) => `at ${list.map((e) => hhmm(e.at)).join(', ')}`;
    // The driver's taps as the rest of RouteIQ reads them (review of 18 Oct 2026): every tap is kept, but
    // one time counts, and the page shows that one, so it never says the truck left 35 min before it did
    // and agrees with the R2 alert listed on the same page. Leaving for next load: the tap rule R2 counts
    // (lib/delivery/turnaround.ts countedLeaveTap: the latest at or before the first sign at a stop, that
    // sign from the driver's and the office's times and the phone's own photos as R2 reads them, never
    // one on a Planned load); a tap made too early and tapped again, or one after the truck had reached a
    // stop, is named on its line. With no tap that counts, the taps are one muted line at their time.
    const lefts = mine('DEPOT_DEPART');
    if (lefts.length) {
      const own = i.visits.filter((v) => v.depotId === l.depotId && v.loadNo === l.loadNo);
      const sign = firstSignOf(own.map(withoutGpsTimes), own.flatMap((v) => v.phonePhotoTimes ?? []));
      const signSeen = sign && sign.getTime() <= i.now.getTime() ? sign : null;
      const counted = l.status === 'PLANNED' ? null : countedLeaveTap(lefts.map((e) => e.at), signSeen, i.now);
      const tapLine = `"Leaving for next load" (${tag})`;
      if (counted) {
        const earlier = lefts.filter((e) => e.at.getTime() < counted.getTime());
        const later = lefts.filter((e) => e.at.getTime() > counted.getTime());
        const tap = lefts.find((e) => e.at.getTime() === counted.getTime())!;
        const lines = [tapLine];
        if (earlier.length) lines.push(`Also tapped ${tapTimes(earlier)}: corrected by tapping again (the latest tap before the first stop counts)`);
        if (later.length) lines.push(`Tapped again ${tapTimes(later)}${signSeen ? ', after the truck had reached a stop' : ''}: not counted`);
        planOrder.push({ key: `tap:out:${l.id}`, kind: 'DEPOT_OUT', at: counted.toISOString(), plannedAt: null, loadNo: l.loadNo, sequence: null, title: 'Left the depot', source: sourceWord(tap.source), lines, tone: 'info' });
      } else {
        const why =
          l.status === 'PLANNED'
            ? 'The load is planned, not on the road: not counted as the truck leaving'
            : signSeen
              ? `Tapped after the truck had reached a stop (${hhmm(signSeen)}): not when it left the depot`
              : 'Not counted as the truck leaving';
        planOrder.push({ key: `tap:out:${l.id}`, kind: 'DEPOT_OUT', at: lefts[0]!.at.toISOString(), plannedAt: null, loadNo: l.loadNo, sequence: null, title: 'Leaving tapped (not counted)', source: sourceWord(lefts[0]!.source), lines: [`${tapLine} ${tapTimes(lefts)}`, why], tone: 'muted' });
      }
    }
    for (const s of [...l.stops].sort((a, b) => a.sequence - b.sequence)) planOrder.push(stopItems.get(visitKey(l.depotId, l.loadNo, s.sequence))!);
    // Back at depot: the EARLIEST tap counts (lib/delivery/day-results.ts backAtDepot, the alert replay);
    // a tap again later is named on its line.
    const backs = mine('BACK_AT_DEPOT');
    const back = backs[0];
    if (back) {
      const again = backs.filter((e) => e.at.getTime() > back.at.getTime());
      const lines = [`"Back at depot" (${tag})`, ...(again.length ? [`Tapped again ${tapTimes(again)}: the first tap counts`] : [])];
      planOrder.push({ key: `tap:in:${l.id}`, kind: 'DEPOT_IN', at: back.at.toISOString(), plannedAt: iso(atMin(l.returnMin)), loadNo: l.loadNo, sequence: null, title: 'Back at the depot', source: sourceWord(back.source), lines, tone: 'info' });
    }
    if (!back && l.status !== 'COMPLETED') {
      planOrder.push({ key: `return:${l.id}`, kind: 'DEPOT_IN', at: null, plannedAt: iso(atMin(l.returnMin)), loadNo: l.loadNo, sequence: null, title: 'Planned back at the depot', source: null, lines: [`${tag} planned return ${fmtHhmm(l.returnMin)}`], tone: 'muted' });
    }
    if (l.status === 'COMPLETED') {
      planOrder.push({ key: `done:${l.id}`, kind: 'COMPLETED', at: iso(l.statusChangedAt), plannedAt: null, loadNo: l.loadNo, sequence: null, title: `${tag} completed`, source: null, lines: ['The trip is closed'], tone: 'ok' });
    }
  }

  // ----- What happened at its own time: GPS depot moves, GPS visits, alerts
  const loose: TimelineItem[] = [...gpsVisitItems];
  for (const m of moves) {
    const depot = m.depotId ? depotOf.get(m.depotId) : undefined;
    const lines = [depot ? `Depot: ${depot.name}` : 'A depot of the company'];
    if (m.outcome === 'UNCONFIRMED') lines.push('Not confirmed by the GPS trail');
    if (m.outcome === 'NO_LOAD') lines.push('No load was out at that time');
    loose.push({
      key: `move:${m.kind}:${m.origin}:${m.at.getTime()}`,
      kind: m.kind === 'DEPOT_OUT' ? 'DEPOT_OUT' : 'DEPOT_IN',
      at: m.at.toISOString(),
      plannedAt: null,
      loadNo: null,
      sequence: null,
      title: m.kind === 'DEPOT_OUT' ? 'Left the depot' : 'Arrived at the depot',
      source: MOVE_ORIGIN_WORD[m.origin as IvmsEventOrigin] ?? GPS_WORD,
      lines,
      tone: m.outcome === 'UNCONFIRMED' ? 'muted' : 'info',
    });
  }
  for (const a of i.alerts) {
    loose.push({
      key: `alert:${a.id}`,
      kind: 'ALERT',
      at: a.occurredAt,
      plannedAt: null,
      loadNo: a.loadNo,
      sequence: a.sequence,
      title: `Alert: ${ruleLabel(a.rule)}`,
      source: null,
      lines: [
        alertText(a),
        `${SEVERITY_LABEL[a.severity] ?? a.severity} · ${alertStateText(a, tz)}`,
        // The cause & action the office recorded (owner request 20 Oct 2026): shown, never edited here.
        ...(a.review ? [alertReviewText(a, tz), ...(a.review.note ? [`Note: ${a.review.note}`] : []), ...alertReviewFlags(a).map((f) => `(${f})`)] : []),
      ],
      tone: a.state === 'RESOLVED' ? 'muted' : a.severity === 'HIGH' ? 'bad' : 'warn',
    });
  }

  // ----- One chronological list. What happened is at its time; what has not happened (yet) is at its
  // planned time, but never before what already happened earlier in the plan order of the truck-day.
  let running = -Infinity;
  const keyed: { item: TimelineItem; key: number; ord: number }[] = [];
  planOrder.forEach((item, ord) => {
    const at = item.at ? Date.parse(item.at) : null;
    if (at !== null) {
      running = Math.max(running, at);
      keyed.push({ item, key: at, ord });
      return;
    }
    const planned = item.plannedAt ? Date.parse(item.plannedAt) : null;
    const base = Number.isFinite(running) ? running : dayStart.getTime();
    keyed.push({ item, key: planned === null ? base : Math.max(planned, running), ord });
  });
  loose.forEach((item, n) => keyed.push({ item, key: Date.parse(item.at!), ord: planOrder.length + n }));
  keyed.sort((a, b) => a.key - b.key || a.ord - b.ord);

  // ----- The trail line (trailPts above), at most TRAIL_MAX_POINTS
  const thin = downsampleTrail(trailPts);
  if (gpsTimes && i.truck.hasTracker && !trailPts.length && loads.some((l) => l.status === 'DISPATCHED' || l.status === 'COMPLETED')) {
    const days = Math.min(7, Math.max(1, Math.floor(i.trailDays) || 1));
    notes.push(
      !kept && i.date < today
        ? `The GPS trail is kept ${countOf(days, 'day')} (Settings): this day's trail is no longer shown. The times and results stay.`
        : 'No GPS trail is stored for this day (yet): Ayun is read while a load is out.',
    );
  }

  // ----- Live
  const live = liveOn && i.position ? liveOf(i, loads, visits, depotOf, dayStart, hhmm) : null;
  // The next stop's line says the live ETA too (the header's status line, at the stop it is about).
  const nextLoad = live?.next ? loads.find((l) => l.loadNo === live.next!.loadNo && OUT_STATUSES.has(l.status)) : undefined;
  const nextItem = nextLoad ? stopItems.get(visitKey(nextLoad.depotId, nextLoad.loadNo, live!.next!.sequence)) : undefined;
  if (nextItem && live?.next) {
    const n = live.next;
    const delay = n.delayMin === null || n.delayMin === 0 ? '' : ` (${n.delayMin > 0 ? '+' : ''}${n.delayMin} min against the plan)`;
    nextItem.lines.push(n.atStop ? 'The truck is here now (GPS)' : `Live ETA about ${hhmm(new Date(n.etaAt))}${delay} (GPS)`);
  }
  // Today with a tracker and no live status: no position stored, or none shown as no load is out.
  if (ivmsModeAtLeast(i.mode, 'MAP') && i.date === today && i.truck.hasTracker && !live) {
    notes.push('No live position now: RouteIQ reads a truck\'s position only while it has a load out (locked, loading or on the road), within the GPS tracking hours.');
  }

  const facts = gpsTimes && Array.isArray(i.truckDay?.gpsFactsJson) ? (i.truckDay!.gpsFactsJson as unknown[]).map((f) => gpsFactText(f, tz)).filter((x): x is string => !!x).slice(0, 10) : [];
  const drivers = [...new Set(loads.map((l) => l.driverName).filter((x): x is string => !!x))];
  const count = (r: TruckDayResult) => stops.filter((s) => s.result === r).length;

  return {
    truck: { id: i.truck.id, code: i.truck.code, description: i.truck.description, hired: i.truck.hired, oneDay: i.truck.oneDay },
    date: i.date,
    today,
    tz,
    mode: i.mode,
    gps: { hasTracker: i.truck.hasTracker, trail: thin.length > 0, times: gpsTimes, live: !!live, notes, facts },
    dates: [...new Set(i.dates)].sort((a, b) => b.localeCompare(a)),
    // Field by field: never anything else of a depot row (its Ayun zone name above all).
    depots: [...new Set(loads.map((l) => l.depotId))]
      .map((id) => depotOf.get(id))
      .filter((d): d is NonNullable<typeof d> => !!d)
      .map((d) => ({ id: d.id, code: d.code, name: d.name, lat: d.lat, lng: d.lng })),
    loads: loads.map((l) => ({
      id: l.id,
      runId: l.runId,
      depotId: l.depotId,
      loadNo: l.loadNo,
      status: l.status,
      departAt: atMin(l.departMin).toISOString(),
      returnAt: atMin(l.returnMin).toISOString(),
      driverName: l.driverName,
      driverCasual: l.driverCasual,
      stops: l.stops.length,
      done: stops.filter((s) => s.loadId === l.id && s.state === 'DONE').length,
    })),
    drivers,
    stops,
    trail: {
      points: thin.map((p) => [r5(p.lng), r5(p.lat)] as [number, number]),
      total: trailPts.length,
      from: iso(trailPts[0]?.fixAt),
      to: iso(trailPts[trailPts.length - 1]?.fixAt),
    },
    live,
    timeline: keyed.map((k) => k.item),
    summary: { stops: stops.length, delivered: count('DELIVERED'), partly: count('PARTLY_DELIVERED'), notDelivered: count('NOT_DELIVERED'), pending: count('PENDING') },
    ayunUrl: AYUN_WEB_URL,
  };
}

function stopOf(l: TruckDayLoadInput, s: TruckDayStopInput, v: TruckDayVisitInput | null, atMin: (m: number) => Date, dayStart: Date): TruckDayStop {
  const plannedAt = s.etaMin === null ? null : atMin(s.etaMin);
  const arrived = v?.arrivedAt ?? null;
  const departed = v?.departedAt ?? null;
  // On site (owner request 19 Oct 2026): the minutes the GPS showed the truck away are not counted.
  const away = v?.awayMinutes && v.awayMinutes > 0 ? v.awayMinutes : null;
  const onSiteMin = arrived && departed && departed > arrived ? Math.max(0, Math.round(minutesBetween(arrived, departed) - (away ?? 0))) : null;
  let waitedMin: number | null = null;
  if (arrived && s.windowStartMin !== null && s.windowStartMin > 0) {
    const arrMin = (arrived.getTime() - dayStart.getTime()) / MIN;
    if (arrMin < s.windowStartMin) {
      const w = Math.round(Math.min(s.windowStartMin - arrMin, onSiteMin ?? Infinity));
      waitedMin = w > 0 ? w : null;
    }
  }
  const outcome = (v?.outcome ?? null) as Exclude<TruckDayResult, 'PENDING'> | null;
  // The reason (Other carries its note: "Other - gate locked"), and a note given with any other result
  // ("Delivered; note: ..." is what the DELIVERED_WITH_NOTE alert is about).
  const note = (v?.reasonNote ?? '').trim();
  const why = outcome && outcome !== 'DELIVERED' && v?.reason ? `: ${reasonText(v.reason, note)}` : '';
  const extra = note && v?.reason !== 'OTHER' ? `; note: ${note}` : '';
  const resultText = outcome ? `${OUTCOME_LABEL[outcome] ?? outcome}${why}${extra}` : null;
  return {
    loadId: l.id,
    loadNo: l.loadNo,
    depotId: l.depotId,
    sequence: s.sequence,
    customerCode: s.customerCode,
    customerName: s.customerName,
    lat: s.pin && okPoint(s.pin.lat, s.pin.lng) ? r5(s.pin.lat) : null,
    lng: s.pin && okPoint(s.pin.lat, s.pin.lng) ? r5(s.pin.lng) : null,
    result: outcome ?? 'PENDING',
    state: outcome ? 'DONE' : arrived && !departed ? 'AT_STOP' : departed ? 'LEFT' : 'PENDING',
    plannedAt: iso(plannedAt),
    arrivedAt: iso(arrived),
    arrivalBy: arrived ? sourceWord(v?.arrivalSource) : null,
    arrivalObserved: v?.arrivalObserved ?? true,
    departedAt: iso(departed),
    departureBy: departed ? sourceWord(v?.departureSource) : null,
    departedAtResult: !!v?.departedAtOutcome,
    lateMin: arrived && plannedAt ? minutesBetween(plannedAt, arrived) : null,
    onSiteMin,
    awayMin: away === null ? null : Math.round(away),
    arrivalTapAt: arrived && v?.arrivalSource === 'AYUN' && v.ownArrivedAt ? iso(v.ownArrivedAt) : null,
    afterResultMin: departed && v && afterResultOf(v) ? Math.max(1, Math.round(afterResultOf(v)!)) : null,
    plannedServiceMin: s.plannedServiceMin,
    waitedMin,
    // A window that is the whole day ("any time") is no window.
    window: (s.windowStartMin ?? 0) <= 0 && (s.windowEndMin ?? 1440) >= 1439 ? null : fmtWindow(s.windowStartMin, s.windowEndMin),
    resultAt: outcome ? iso(v?.outcomeAt) : null,
    resultBy: outcome ? sourceWord(v?.outcomeSource) : null,
    resultText,
    casesPlanned: s.casesPlanned,
    casesDelivered: v?.casesDelivered ?? null,
    photos: v?.photoCount ?? 0,
  };
}

/** The timeline line of a stop: its plan, what happened, who recorded it, the result. */
function stopItem(stop: TruckDayStop, s: TruckDayStopInput, v: TruckDayVisitInput | null, hhmm: (d: Date) => string): TimelineItem {
  const at = (x: string | null) => (x ? hhmm(new Date(x)) : '');
  const lines: string[] = [];
  const plan = [stop.plannedAt ? `Planned ${at(stop.plannedAt)}` : 'No planned time'];
  if (stop.window) plan.push(`window ${stop.window}`);
  if (s.plannedServiceMin !== null) plan.push(`unloading ${s.plannedServiceMin} min`);
  lines.push(plan.join(', '));
  if (stop.arrivedAt) {
    const late = stop.lateMin === null || stop.lateMin === 0 ? '' : stop.lateMin > 0 ? `, ${stop.lateMin} min late` : `, ${-stop.lateMin} min early`;
    // Owner decision 21 Oct 2026: a GPS arrival that replaced the driver's later tap names the tap (coaching).
    const tap = stop.arrivalTapAt ? `; driver tapped ${at(stop.arrivalTapAt)}` : '';
    lines.push(`Arrived ${at(stop.arrivedAt)} (${stop.arrivalBy}${tap})${late}${stop.arrivalObserved ? '' : '; not observed: the real arrival was earlier'}`);
  }
  const afterResult = afterResultText(stop.afterResultMin);
  if (stop.departedAt) {
    lines.push(stop.departedAtResult ? `Left: no departure seen, the result at ${at(stop.departedAt)} ended the stop` : `Left ${at(stop.departedAt)} (${stop.departureBy})${afterResult ? `, ${afterResult}` : ''}`);
  }
  if (stop.onSiteMin !== null) {
    const away = stop.awayMin ? `; ${awayText(stop.awayMin)} not counted (GPS: the truck left the customer and came back)` : '';
    const after = afterResult ? `; ${afterResult}, not unloading` : '';
    lines.push(`On site ${stop.onSiteMin} min${stop.plannedServiceMin !== null ? ` (planned unloading ${stop.plannedServiceMin} min${away}${after})` : away || after ? ` (${(away + after).slice(2)})` : ''}`);
  } else if (stop.awayMin) lines.push(`${awayText(stop.awayMin)} (GPS: the truck left the customer and came back)`);
  if (stop.waitedMin !== null) lines.push(`Waited about ${stop.waitedMin} min for the receiving window to open (${fmtHhmm(s.windowStartMin)})`);
  if (stop.resultText) {
    const cases = stop.casesDelivered !== null && stop.result !== 'NOT_DELIVERED' ? ` - ${stop.casesDelivered} of ${stop.casesPlanned} cases` : '';
    lines.push(`${stop.resultText}${cases} (${stop.resultBy}${stop.resultAt ? `, ${at(stop.resultAt)}` : ''})`);
  } else if (stop.state === 'LEFT') {
    lines.push('Left without a result');
  }
  if (stop.photos) lines.push(countOf(stop.photos, 'photo'));
  if (v?.outcomeLate) lines.push('Result recorded after the trip closed');
  const tone: TimelineTone =
    stop.result === 'DELIVERED' ? 'ok' : stop.result === 'PARTLY_DELIVERED' ? 'warn' : stop.result === 'NOT_DELIVERED' ? 'bad' : stop.state === 'PENDING' ? 'muted' : 'info';
  return {
    key: `stop:${stop.depotId}:${stop.loadNo}:${stop.sequence}`,
    kind: 'STOP',
    at: stop.arrivedAt ?? stop.resultAt ?? stop.departedAt,
    plannedAt: stop.plannedAt,
    loadNo: stop.loadNo,
    sequence: stop.sequence,
    title: `Stop ${stop.sequence} · ${stop.customerName}${stop.customerCode ? ` (${stop.customerCode})` : ''}`,
    source: stop.arrivalBy,
    lines,
    tone,
  };
}

/** The live status (the day screen's rules: liveVehicleOf for the fix, liveEta for the next stop). */
function liveOf(
  i: TruckDayInput,
  loads: TruckDayLoadInput[],
  visits: Map<string, TruckDayVisitInput>,
  depotOf: Map<string, TruckDayInput['depots'][number]>,
  dayStart: Date,
  hhmm: (d: Date) => string,
): TruckDayLive | null {
  const p = i.position!;
  if (!okPoint(p.lat, p.lng)) return null;
  let load: TruckDayLoadInput | null = null;
  for (const l of loads) {
    if (!OUT_STATUSES.has(l.status)) continue;
    if (!load || (OUT_RANK[l.status] ?? 0) > (OUT_RANK[load.status] ?? 0) || ((OUT_RANK[l.status] ?? 0) === (OUT_RANK[load.status] ?? 0) && l.loadNo > load.loadNo)) load = l;
  }
  const v = liveVehicleOf(p, i.truck.code, load?.loadNo ?? null, i.now);
  const moving = !v.stale && (v.speedKmh ?? 0) >= MOVING_KMH;
  const depot = depotOf.get(load?.depotId ?? i.truck.depotId) ?? null;
  const depotKm = depot && okPoint(depot.lat, depot.lng) ? Math.round(distanceM(p, depot) / 100) / 10 : null;
  let next: TruckDayLive['next'] = null;
  if (load && load.status === 'DISPATCHED' && !v.stale) {
    const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
    const etas = liveEta({
      now: i.now,
      fix: { fixAt: p.fixAt, lat: p.lat, lng: p.lng, flags: v.flags },
      dayStart,
      departMin: load.departMin,
      depot: depot ? { lat: depot.lat, lng: depot.lng } : null,
      stops: stops.map((s) => {
        const vis = visits.get(`${load!.depotId}|${load!.loadNo}|${s.sequence}`);
        return {
          sequence: s.sequence,
          pin: s.pin,
          etaMin: s.etaMin,
          plannedServiceMin: s.plannedServiceMin,
          done: !!vis && (!!vis.outcome || !!vis.departedAt),
          arrivedAt: vis && !vis.outcome && !vis.departedAt ? vis.arrivedAt : null,
        };
      }),
      avgSpeedKmh: i.cfg.avgSpeedKmh,
      distanceMultiplier: i.cfg.distanceMultiplier,
      atStopRadiusM: i.cfg.stopRadiusM + AT_STOP_MARGIN_M,
    });
    const first = etas[0];
    if (first) {
      const s = stops.find((x) => x.sequence === first.sequence);
      next = { loadNo: load.loadNo, sequence: first.sequence, customerName: s?.customerName ?? '', plannedAt: iso(first.plannedAt), etaAt: first.etaAt.toISOString(), delayMin: first.delayMin, atStop: first.atStop };
    }
  }
  const parkedSince = !v.stale && !moving && p.movedAt ? p.movedAt.toISOString() : null;
  const parts: string[] = [];
  if (v.stale) parts.push(`No GPS position for ${agoText(v.ageSec).replace(' ago', '')} (last ${hhmm(p.fixAt)})`);
  else {
    parts.push(`Updated ${agoText(v.ageSec)} (${hhmm(p.fixAt)})`);
    if (moving) parts.push(`moving, ${Math.round(v.speedKmh ?? 0)} km/h`);
    else parts.push(parkedSince ? `parked since ${hhmm(new Date(parkedSince))}${v.parkedMin !== null ? ` (${v.parkedMin} min)` : ''}` : 'parked');
  }
  if (depotKm !== null) parts.push(`${depotKm} km from the depot (straight line)`);
  if (next) {
    const delay = next.delayMin === null || next.delayMin === 0 ? '' : ` (${next.delayMin > 0 ? '+' : ''}${next.delayMin} min)`;
    parts.push(next.atStop ? `at L${next.loadNo} stop ${next.sequence}, ${next.customerName}` : `next: L${next.loadNo} stop ${next.sequence}, ${next.customerName}, about ${hhmm(new Date(next.etaAt))}${delay}`);
  }
  return {
    fixAt: v.fixAt,
    ageSec: v.ageSec,
    stale: v.stale,
    lat: v.lat,
    lng: v.lng,
    speedKmh: v.speedKmh,
    moving,
    parkedSince,
    parkedMin: moving ? null : v.parkedMin,
    depotKm,
    loadNo: load?.loadNo ?? null,
    next,
    text: parts.join(' · '),
  };
}
