/**
 * Operations alerts (owner request 16 Oct 2026): the rules. Pure: `evaluate(facts, now, thresholds)`
 * turns what the database holds (facts.ts reads it; the replay builds it from a saved day) into an
 * Evaluation - the subjects whose rule is true now (Candidate), the subjects checked whose condition
 * ended or whose event was corrected (Ended, with the final words), the subjects whose open row stays as
 * it is (held) and the depot-days read in full (SweepScope). The store (store.ts) applies it.
 *
 * Every rule checks every subject of its kind it finds in the facts and answers for each one, so a row
 * whose subject is still in the plan is closed with its own words; a row whose subject is gone closes as
 * NOT_IN_PLAN (store.ts). A rule that is off (threshold null) is not checked: its rows close as RULE_OFF.
 * A rule that throws on a load holds its open rows of that load (Evaluation.failures); the others answer.
 *
 * "Back" (LoadCtx.back): Back at depot was tapped, or the truck is out on a later load of the day (a stop
 * of it has activity, or its Dispatch press came no earlier than an hour before this load's planned
 * return: a press of every load in the morning is not the truck leaving again). "Past the return": the
 * planned return + RETURN_GRACE_MIN has passed, or the load is of an earlier day. Every condition is
 * dated to when it began (occurredAt), so a switch-on never raises what was already true (no backlog).
 * A rule that stops following a subject still true (past the planned return, too old) closes its row as
 * NOT_FOLLOWED (Out.unfollow), never as "over".
 *
 * The rules with the adversarial review's fixes (critique of 16 Oct 2026) and the two reviews of the
 * branch (16 Oct 2026, "H"/"M"/"L" below are theirs):
 * - R1 UNLOAD_OVER: a stop being unloaded (arrived; no departure, no result, no later stop with
 *   activity) longer than its planned unloading + T, counted from the arrival or the window start when
 *   early. An arrival tapped far from the pin (UNLOAD_ARRIVAL_FAR_M with good accuracy) is not counted
 *   (M9). It ends when the truck is back (H1); past the planned return + 60 min it is no longer followed
 *   (NOT_FOLLOWED: "Load not closed" follows the load). A stop that ended over the limit without a row becomes
 *   a history row (no toast, no e-mail); its unloading ends at the latest at the first tap of a later
 *   stop, the truck being back or the planned return + 60 min (a result recorded hours later is not the
 *   end). Not on a load the office completed. While it is raised, R3 and the projected R6 of the load
 *   are held (M2: one long unloading is one alert; its text names the next stop's new time).
 * - R2 LOADING_OVER (owner decision of 16 Oct 2026: measured from the driver's taps): a trip after the
 *   truck's first of the day whose truck is back at the depot (Back at depot of the trip before; a trip
 *   planned later - a late order, a re-plan - counts from then) and has not left with it more than T
 *   later. The leave is the driver's latest "Leaving for next load" before the truck reached a stop;
 *   without it the Dispatch press of the trip (from the audit: completing the load keeps it) or the
 *   first sign at one of its stops less the planned drive (marked as such in the text;
 *   lib/delivery/turnaround.ts). Live while
 *   waiting (dispatched before Back at depot and no tap: the planned drive to the first stop is allowed
 *   first), final once left (history when it ended over T before a sweep saw it); not without Back at
 *   depot (R10 follows that trip), never for the first trip (loaded the night before), not across two
 *   depots, never live on a Completed load, not when the trip had started before Back at depot was
 *   tapped; no longer followed TURNAROUND_MAX_MIN after Back at depot.
 * - R3 ETA_LATE: the projected arrival at the next stop (projection.ts) more than T after its plan;
 *   closes 10 min under T (hysteresis). A delivery photo counts as being at its stop, and the clock pushes
 *   a stop not reached only while the phone has been silent since before it was expected (M3). Not while
 *   DRIVER_SILENT is open for the load or R1 is raised (held), not once the truck is back, nor after the
 *   planned return + 60 min (H3). Stops further on that may miss their window are named in its text (H5).
 * - R4 DEPART_LATE: today's Locked or Loading load (a Planned one only as a later trip of a truck whose
 *   earlier load is locked or further) not dispatched T after its planned departure; only the truck's
 *   first load not yet out. A later trip waits for the previous load to be back (a tap, Completed, or
 *   its planned return + 60 min without a tap) and is counted from the later of its planned departure and
 *   that return + the planned turnaround (M6: a late return is not this load's lateness). No longer
 *   followed 4 h after that (M2). Found only after the Dispatch press: one history row.
 * - R5 DRIVER_SILENT: nothing from the driver's phone for T (a planned break inside the gap does not
 *   count), stops left, none being unloaded, and the next stop overdue by 30 min (M10). Tier 1 WARN. Not
 *   once the truck is back, nor past the planned return (M1: "Load not closed" follows it then).
 * - R6 AFTER_CLOSING: an observed arrival more than T after the stop's window end: an EVENT, WARN, HIGH
 *   beyond 2T (M4). The next pending stop with a window projected more than T after it (the arrival under
 *   START, the end of unloading under FINISH): WARN, closes 10 min under T (H5).
 * - R7 PRIORITY_NOT_DELIVERED: the driver's Not delivered (HIGH) or Partly delivered (WARN) at a stop of
 *   priority T or better; a result the office recorded itself does not count (L8).
 * - R8 DELIVERED_WITH_NOTE: the driver's Delivered with a note (WARN, never a toast); a note that only
 *   confirms the delivery ("delivered", "received", "delivered at 11:25"; text.ts noteOnlyConfirms) is
 *   not news; a note with any other number ("18/20", "50%") is (M5).
 * - R9 PROOF_FAR: read like "Pin may be wrong" (lib/delivery/pin-check.ts, H3): the median distance of the
 *   driver's delivery photos (each by the phone's position when it is good, else the photo's own
 *   location; old photos and photos the office added left out), else the driver's own result position
 *   when no later stop had activity before it; more than T from the customer's pin, only when the pin is
 *   verified, not on the "Pin may be wrong" list (M1) and not moved since the visit was planned. HIGH
 *   beyond 4T.
 * - R10 LOAD_NOT_CLOSED: a DISPATCHED load T after its planned return with no Back at depot or a stop
 *   without a result; the truck out on its next load counts as back; a WARN only when every result is in
 *   (M8: paperwork).
 * - R11 PAGE_NOT_OPENED: a dispatched truck-day whose driver page was not opened T after its first planned
 *   departure. R1, R3, R5, R6 (projected) and R10 follow the phone and are checked only on truck-days
 *   whose page was opened (H3): a truck without it raises this one WARN instead of a pile.
 */
import { actualMinutes, OUTCOME_LABEL, reasonLabel, sourceWord } from '../delivery/office-text';
import { arrivalIsObserved } from '../delivery/kpis';
import { zonedDayStart } from '../dispatch/time';
import {
  ALERT_EVIDENCE_MAX_ACCURACY_M,
  ALERT_HYSTERESIS_MIN,
  ALERT_RULE_SPECS,
  ALERT_RULES,
  DEPART_LATE_EXPIRE_MIN,
  DEPART_LATE_HISTORY_MIN,
  TURNAROUND_MAX_MIN,
  PROOF_FAR_HIGH_FACTOR,
  RETURN_GRACE_MIN,
  SILENT_AFTER_NEXT_ETA_MIN,
  UNLOAD_ARRIVAL_FAR_M,
  subjectKeyOf,
  tierAt,
  type AlertKind,
  type AlertRule,
  type AlertTier,
} from './catalog';
import { firstSignOf, leftHowText, plannedDriveOf, previousTrip, turnaroundOf, type TurnaroundIn } from '../delivery/turnaround';
import { projectLoad, type ProjectedStop, type Projection, type ProjectionIn } from './projection';
import {
  clockText,
  fmtDistance,
  fmtDuration,
  loadLabel,
  minutesOnDate,
  noteOnlyConfirms,
  noteText,
  planTime,
  sequencesText,
  shortNote,
  stopLabel,
  stopsText,
} from './text';
import type { Candidate, Ended, Evaluation, SweepScope } from './types';

// ---------------------------------------------------------------------------------------------
// The facts the rules read (facts.ts from the database, replay.ts from a saved day). Plain data.
// ---------------------------------------------------------------------------------------------

export type WindowRuleName = 'START' | 'FINISH';

export interface FactPhoto {
  positionStatus: string;
  distanceM: number | null;
  accuracyM: number | null;
  exifDistanceM: number | null;
  receivedAt: Date;
  /** PHONE_AUTO / PHONE_MANUAL (the driver's phone) or DISPATCHER (added in the office); absent (an older export): the phone. */
  source?: string;
  /** Its own time is more than 15 min before the arrival or the Dispatch (DeliveryPhoto.oldPhoto): a gallery photo. */
  oldPhoto?: boolean;
  /** When it was taken (skew-corrected; absent in an older export: receivedAt is used). */
  takenAt?: Date;
}

/** A stop's StopVisit (only the fields the rules read). */
export interface FactVisit {
  arrivedAt: Date | null;
  arrivalSource: string | null;
  arrivalObserved: boolean;
  arrivalDistanceM: number | null;
  arrivalAccuracyM: number | null;
  timingSuspect: boolean;
  departedAt: Date | null;
  departedAtOutcome: boolean;
  autoMinutes: number | null;
  autoServiceMinutes: number | null;
  outcome: string | null;
  reason: string | null;
  reasonNote: string | null;
  outcomeAt: Date | null;
  outcomeSource: string | null;
  outcomeDistanceM: number | null;
  outcomeAccuracyM: number | null;
  casesPlanned: number;
  casesDelivered: number | null;
  /** The plan as the visit copied it at its first write (null: take the stop's). */
  plannedServiceMin: number | null;
  windowStartMin: number | null;
  windowEndMin: number | null;
  photos: FactPhoto[];
}

/** One planned stop of a load that left (DISPATCHED or COMPLETED), with its visit. */
export interface FactStop {
  sequence: number;
  customerId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  etaMin: number | null;
  serviceStartMin: number | null;
  departureMin: number | null;
  plannedServiceMin: number | null;
  windowStartMin: number | null;
  windowEndMin: number | null;
  /** The best (lowest) priority of the stop's orders; null = unknown. */
  priority: number | null;
  /** The customer's pin is verified and not on the "Pin may be wrong" list (R9). */
  pinVerified: boolean;
  /** The visit was planned at a pin more than PIN_MOVED_M from the customer's pin now (corrected since: R9 leaves it out). */
  pinMoved?: boolean;
  visit: FactVisit | null;
}

/** One load of the plan in use of a depot and date (every status). */
export interface FactLoad {
  id: string;
  depotId: string;
  /** YYYY-MM-DD */
  date: string;
  truckId: string;
  /** As shown (a hired truck's plate). */
  truckCode: string;
  loadNo: number;
  status: string;
  departMin: number;
  returnMin: number;
  /** The latest status move (a DISPATCHED load: the Dispatch press; LOADING: the Loading press). */
  statusChangedAt: Date | null;
  /** The receiving-hours rule the load was planned with (a load planned before the echo: START). */
  windowRule: WindowRuleName;
  /** The planned driver break, minutes of the delivery day. */
  breakMin: { startMin: number; endMin: number } | null;
  /** The earliest Back at depot of the load. */
  backAt: Date | null;
  /** The driver's "Leaving for next load" for this load: the truck left the depot with it (the LATEST DEPOT_DEPART: a tap made too early is corrected by tapping again). */
  leftTapAt: Date | null;
  /** Every Leaving for next load tap of this load; absent (an older replay file): leftTapAt alone. */
  leftTaps?: Date[];
  /**
   * The Dispatch press of this load whatever its status now (the LOAD_DISPATCHED audit row of the load
   * or of the load it was copied from: completing the load overwrites statusChangedAt); absent or null:
   * a DISPATCHED load's statusChangedAt.
   */
  dispatchedAt?: Date | null;
  /** When this load first existed on the truck's plan (the first plan version it was copied from); absent or null: not known. */
  existedAt?: Date | null;
  stopCount: number;
  /** The planned stops with their visits: loads that left only (DISPATCHED / COMPLETED); [] otherwise. */
  stops: FactStop[];
}

/** The last thing the driver's phone sent for a truck-day. */
export interface FactSignal {
  /** Received by the server (receivedAt): the phone holds events while it is offline. */
  at: Date;
  kind: string;
  depotId: string;
  loadNo: number;
  sequence: number | null;
}

/** One truck and delivery date (one driver link). */
export interface FactTruckDay {
  date: string;
  truckId: string;
  /** DriverLink.lastSeenAt (any driver request; the office excluded). */
  linkSeenAt: Date | null;
  /** The driver page was opened (a lastSeenAt, or anything from the phone). */
  pageOpened: boolean;
  lastSignal: FactSignal | null;
}

/** A row open now (resolvedAt null), acknowledged or not. */
export interface OpenRowInfo {
  kind: AlertKind;
  tier: number;
  depotId: string;
  deliveryDate: string;
}

export interface AlertFacts {
  tz: string;
  /** The company's today (its time zone). */
  today: string;
  /** The dates read in full (yesterday, today, tomorrow). */
  dates: string[];
  loads: FactLoad[];
  truckDays: FactTruckDay[];
  /** The rows open now by openKey(rule, subjectKey). */
  open: ReadonlyMap<string, OpenRowInfo>;
}

export const openKey = (rule: string, subjectKey: string) => `${rule}|${subjectKey}`;
export const truckDayOf = (date: string, truckId: string) => `${date}|${truckId}`;

const ON_ROAD = new Set(['DISPATCHED', 'COMPLETED']);
const STATUS_WORD: Record<string, string> = { PLANNED: 'Planned', LOCKED: 'Locked', LOADING: 'Loading', DISPATCHED: 'Dispatched', COMPLETED: 'Completed' };
const PHONE_SOURCES = new Set(['PHONE_AUTO', 'PHONE_MANUAL']);

// ---------------------------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------------------------

type Thresholds = Readonly<Record<AlertRule, number | null>>;

class Out {
  readonly active: Candidate[] = [];
  readonly ended: Ended[] = [];
  readonly held: { rule: AlertRule; subjectKey: string }[] = [];
  readonly failures: { rule: AlertRule; message: string }[] = [];
  constructor(
    readonly facts: AlertFacts,
    readonly now: Date,
    private readonly t: Thresholds,
  ) {}

  on(rule: AlertRule): number | null {
    const v = this.t[rule];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  isOpen(rule: AlertRule, subjectKey: string): boolean {
    return this.facts.open.has(openKey(rule, subjectKey));
  }

  raise(c: Candidate): void {
    // Never in the future: the no-backlog check compares it with the switch-on time.
    const occurredAt = c.occurredAt.getTime() > this.now.getTime() ? this.now : c.occurredAt;
    this.active.push({ ...c, value: Math.round(c.value), occurredAt });
  }

  end(rule: AlertRule, subjectKey: string, text: string): void {
    const open = this.facts.open.get(openKey(rule, subjectKey));
    this.ended.push({ rule, subjectKey, reason: open?.kind === 'EVENT' ? 'CORRECTED' : 'ENDED', text });
  }

  hold(rule: AlertRule, subjectKey: string): void {
    this.held.push({ rule, subjectKey });
  }

  /** No longer followed while still true (past the planned return, too old): the row closes as NOT_FOLLOWED, never "over". */
  unfollow(rule: AlertRule, subjectKey: string, text: string): void {
    this.ended.push({ rule, subjectKey, reason: 'NOT_FOLLOWED', text });
  }

  /** The open row stays as it is when there is one; else nothing is raised (the words say why). */
  holdOrEnd(rule: AlertRule, subjectKey: string, text: string): void {
    if (this.isOpen(rule, subjectKey)) this.hold(rule, subjectKey);
    else this.end(rule, subjectKey, text);
  }

  /** A rule threw on a load: every open row of the rule for that load (or a stop of it) stays as it is. */
  failed(rule: AlertRule, loadKey: string, err: unknown): void {
    this.failures.push({ rule, message: ((err as Error)?.message ?? String(err)).slice(0, 200) });
    const prefix = openKey(rule, loadKey);
    for (const k of this.facts.open.keys()) {
      if (k === prefix || k.startsWith(`${prefix}|`)) this.hold(rule, k.slice(rule.length + 1));
    }
  }
}

/** When the truck left: the time and the words ("back at the depot at 16:00", "out on L2 since 13:10"). */
interface Left {
  at: Date;
  text: string;
}

/** What every rule of one load reads. */
interface LoadCtx {
  load: FactLoad;
  label: string;
  key: string;
  dayStart: Date;
  nowMin: number;
  td: FactTruckDay | null;
  pageOpened: boolean;
  /** DISPATCHED loads only, and the input it was worked out from (the occurredAt search re-runs it). */
  proj: Projection | null;
  projIn: ProjectionIn | null;
  /** DRIVER_SILENT is raised (or held open) for this load in this sweep. */
  silent: boolean;
  /** UNLOAD_OVER is raised for this stop of the load in this sweep (M2: R3 and the projected R6 wait). */
  unloadingSeq: number | null;
  /** The stops of the load, in sequence, by index: a later stop has activity. */
  laterActivity: boolean[];
  /** The truck is back: Back at depot, or out on a later load of the day (null: not known to be back). */
  back: Left | null;
  /** Past the planned return + RETURN_GRACE_MIN, or a load of an earlier day. */
  pastReturn: boolean;
}

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;
const dateAt = (dayStart: Date, min: number) => new Date(dayStart.getTime() + min * 60_000);
const earliest = <T extends { at: Date }>(list: readonly (T | null | undefined)[]): T | null =>
  list.reduce<T | null>((a, b) => (b && (!a || b.at < a.at) ? b : a), null);

function base(c: LoadCtx): Pick<Candidate, 'depotId' | 'deliveryDate' | 'truckId' | 'truckCode' | 'loadNo' | 'sequence' | 'customerId'> {
  return { depotId: c.load.depotId, deliveryDate: c.load.date, truckId: c.load.truckId, truckCode: c.load.truckCode, loadNo: c.load.loadNo, sequence: null, customerId: null };
}

function stopKey(c: LoadCtx, s: FactStop): string {
  return subjectKeyOf({ depotId: c.load.depotId, date: c.load.date, truckId: c.load.truckId, loadNo: c.load.loadNo, sequence: s.sequence });
}

function stopBase(c: LoadCtx, s: FactStop) {
  return { ...base(c), sequence: s.sequence, customerId: s.customerId };
}

/** An arrival tapped far from the pin with good accuracy (a tap at the depot is not unloading: M9). */
function farArrival(v: FactVisit): boolean {
  return has(v.arrivalDistanceM) && v.arrivalDistanceM > UNLOAD_ARRIVAL_FAR_M && has(v.arrivalAccuracyM) && v.arrivalAccuracyM <= ALERT_EVIDENCE_MAX_ACCURACY_M;
}

const windowEndOf = (s: FactStop) => (s.visit?.windowEndMin ?? null) ?? s.windowEndMin;
const windowStartOf = (s: FactStop) => (s.visit?.windowStartMin ?? null) ?? s.windowStartMin;
const plannedServiceOf = (s: FactStop) => (s.visit?.plannedServiceMin ?? null) ?? s.plannedServiceMin;
const stopsWithoutResult = (l: FactLoad) => l.stops.filter((s) => !s.visit?.outcome).length;

/** A photo of the driver's phone taken there and then (an office upload or an old gallery photo is no sign of the truck). */
const phonePhoto = (p: FactPhoto) => (p.source === undefined || PHONE_SOURCES.has(p.source)) && !p.oldPhoto;
/** The first delivery photo the driver's phone took at the stop (null: none). */
function firstPhotoAt(v: FactVisit | null | undefined): Date | null {
  let first: Date | null = null;
  for (const p of v?.photos ?? []) {
    if (!phonePhoto(p)) continue;
    const t = p.takenAt ?? p.receivedAt;
    if (!first || t < first) first = t;
  }
  return first;
}

/** The times a stop shows activity: arrival, departure, result, the first phone photo. */
const activityTimes = (s: FactStop): Date[] => [s.visit?.arrivedAt, s.visit?.departedAt, s.visit?.outcomeAt, firstPhotoAt(s.visit)].filter((t): t is Date => !!t);

/** The first activity at a stop after index `i` that came after `since` (null: none). */
function laterActivityAfter(stops: readonly FactStop[], i: number, since: Date): Date | null {
  let first: Date | null = null;
  for (const s of stops.slice(i + 1)) {
    for (const t of activityTimes(s)) if (t > since && (!first || t < first)) first = t;
  }
  return first;
}

/** A stop after index `i` had activity before `t`. */
const laterActivityBefore = (stops: readonly FactStop[], i: number, t: Date) => stops.slice(i + 1).some((s) => activityTimes(s).some((x) => x < t));

/**
 * The truck is back from this load (null: not known): Back at depot, or out on a later load of the
 * day - a stop of it has activity, or its Dispatch press came no earlier than RETURN_GRACE_MIN before
 * this load's planned return (Dispatch may be pressed for every load in the morning). Never after now.
 */
function backOf(l: FactLoad, truckDayLoads: readonly FactLoad[], now: Date, tz: string): Left | null {
  const found: Left[] = [];
  if (l.backAt && l.backAt <= now) found.push({ at: l.backAt, text: `back at the depot at ${clockText(l.backAt, l.date, tz)}` });
  for (const x of truckDayLoads) {
    if (x.loadNo <= l.loadNo || !ON_ROAD.has(x.status)) continue;
    const times = x.stops.flatMap(activityTimes);
    if (x.status === 'DISPATCHED' && x.statusChangedAt && minutesOnDate(x.statusChangedAt, l.date, tz) >= l.returnMin - RETURN_GRACE_MIN) times.push(x.statusChangedAt);
    const at = times.filter((t) => t <= now).reduce<Date | null>((a, b) => (!a || b < a ? b : a), null);
    if (at) found.push({ at, text: `the truck is out on L${x.loadNo} since ${clockText(at, l.date, tz)}` });
  }
  return earliest(found);
}

/**
 * The first minute from `fromMin` to `toMin` at which `value(m)` reaches `threshold` (null: never): every
 * condition is dated to when it began, also when the projection made it so (L2 of the review: a truck
 * already late at a switch-on is backlog, whatever made it late). `value` only grows with the minute.
 */
function firstMinuteAt(value: (m: number) => number | null, threshold: number, fromMin: number, toMin: number): number | null {
  const reached = (m: number) => {
    const v = value(m);
    return v !== null && v >= threshold;
  };
  if (toMin < fromMin || !reached(toMin)) return null;
  if (reached(fromMin)) return fromMin;
  let lo = fromMin;
  let hi = toMin;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (reached(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The last minute any fact the projection read happened (the occurredAt search starts there). */
function lastFactMin(p: ProjectionIn): number {
  const all = [p.dispatchMin, p.phoneSeenMin, ...p.stops.flatMap((s) => [s.arrivedMin, s.endMin])].filter(has);
  return Math.min(p.nowMin, all.length ? Math.max(...all) : p.departMin);
}

/** When a projected value (R3's delay, R6's margin) of the load reached `threshold`: its instant, else now. */
function projectedSince(c: LoadCtx, now: Date, threshold: number, value: (p: Projection) => number | null): Date {
  const pin = c.projIn;
  if (!pin) return now;
  const m = firstMinuteAt((nowMin) => value(projectLoad({ ...pin, nowMin })), threshold, lastFactMin(pin), pin.nowMin);
  return m === null ? now : dateAt(c.dayStart, m);
}

// ---------------------------------------------------------------------------------------------
// R1 UNLOAD_OVER
// ---------------------------------------------------------------------------------------------

/** The first time after `since` the truck had certainly left stop `i`: a later stop's first tap, the truck back. */
function stopLeftBy(c: LoadCtx, i: number, since: Date, tz: string): Left | null {
  const moved = laterActivityAfter(c.load.stops, i, since);
  return earliest<Left>([moved ? { at: moved, text: `the truck reached a later stop at ${clockText(moved, c.load.date, tz)}` } : null, c.back && c.back.at > since ? c.back : null]);
}

function unloadOver(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'UNLOAD_OVER';
  const T = out.on(rule);
  if (T === null) return;
  const tz = out.facts.tz;
  const l = c.load;
  l.stops.forEach((s, i) => {
    const key = stopKey(c, s);
    const label = `${c.label} ${stopLabel(s)}`;
    const v = s.visit;
    if (!v?.arrivedAt) return out.end(rule, key, `${label}: no arrival recorded any more.`);
    if (!c.pageOpened) return out.end(rule, key, `${label}: the driver page was not opened, so the unloading is not followed.`);
    if (farArrival(v)) return out.end(rule, key, `${label}: the arrival was tapped ${fmtDistance(v.arrivalDistanceM!)} from the customer, so it is not counted as unloading.`);
    const planned = plannedServiceOf(s);
    if (!has(planned)) return out.end(rule, key, `${label}: no planned unloading time.`);
    const winStart = windowStartOf(s);
    const winStartAt = has(winStart) ? dateAt(c.dayStart, winStart) : null;
    const start = winStartAt && winStartAt > v.arrivedAt ? winStartAt : v.arrivedAt;
    const fromWindow = start !== v.arrivedAt;
    const later = c.laterActivity[i] ?? false;
    const noEnd = !v.departedAt && !v.outcomeAt;
    const occurredAt = new Date(start.getTime() + (planned + T) * 60_000);
    if (noEnd) {
      // A load the office completed is not being unloaded any more (15 Oct 2026 replay: a stop of a load
      // completed at 12:18 stayed "unloading" for 12 h).
      if (!later && l.status === 'COMPLETED') return out.end(rule, key, `${label}: no result or departure tapped; the load was completed.`);
      if (later) {
        const next = l.stops.slice(i + 1).find((x) => activityTimes(x).length);
        const at = next ? activityTimes(next).reduce((a, b) => (b < a ? b : a)) : null;
        return out.end(rule, key, `${label}: no departure or result was tapped; the truck moved on to stop ${next?.sequence ?? '?'}${at ? ` at ${clockText(at, l.date, tz)}` : ''}.`);
      }
      // H1: the truck is back (Back at depot, or out on its next load) - it is not unloading here any more.
      const left = c.back && c.back.at > v.arrivedAt ? c.back : null;
      if (left) return out.end(rule, key, `${label}: no departure or result was tapped; ${left.text}.`);
      // Past the planned return + 60 min: no longer followed ("Load not closed" follows the load).
      if (c.pastReturn) return out.unfollow(rule, key, `${label}: no departure or result tapped; past the planned return ${planTime(l.returnMin)} + ${RETURN_GRACE_MIN} min it is no longer followed (see "Load not closed").`);
      const elapsed = Math.max(0, minutesBetween(start, out.now));
      const over = elapsed - planned;
      const tier = tierAt(over, T);
      if (!tier) return out.end(rule, key, `${label}: unloading within the planned time + ${T} min.`);
      c.unloadingSeq = s.sequence;
      const since = `since arrival ${clockText(v.arrivedAt, l.date, tz)}${v.arrivalObserved ? '' : ' (arrival time not certain)'}${fromWindow ? `, counted from the window start ${planTime(winStart)}` : ''}`;
      // M2: the knock-on delay is told here (R3 and the projected R6 wait while this is raised).
      const nx = c.proj?.next ?? null;
      const nextStop = nx ? l.stops.find((x) => x.sequence === nx.sequence) : null;
      const knock = nx && nextStop && has(nx.delayMin) && nx.delayMin > 0 && has(nx.arrMin) ? ` Next: ${stopLabel(nextStop)} now expected about ${planTime(nx.arrMin)} (planned ${planTime(nextStop.etaMin)}).` : '';
      return out.raise({
        ...stopBase(c, s),
        rule,
        kind: 'CONDITION',
        subjectKey: key,
        tier,
        value: over,
        threshold: T,
        text: `${label}: no result or departure tapped ${since} - ${fmtDuration(elapsed)} at the stop, planned ${fmtDuration(planned)} (${fmtDuration(over)} over).${knock}`,
        occurredAt,
        facts: { elapsedMin: Math.round(elapsed), plannedMin: planned, observed: v.arrivalObserved },
      });
    }
    const actual = actualMinutes(v);
    let took = actual.min;
    // The unloading ended at the latest when the truck showed up at a later stop, was back, or at the
    // planned return + 60 min: a result tapped hours later (results recorded in a batch, a customer who
    // sent the driver away and called him back) is not the end of the unloading (15 Oct 2026 replay:
    // "2 h 40 min" at a stop the truck had left after 52 min; review L4: the last stop).
    let until = '';
    if (!actual.auto && took !== null) {
      const retAt = dateAt(c.dayStart, l.returnMin + RETURN_GRACE_MIN);
      const cap = earliest<Left>([stopLeftBy(c, i, v.arrivedAt, tz), retAt > v.arrivedAt ? { at: retAt, text: `the planned return ${planTime(l.returnMin)} + ${RETURN_GRACE_MIN} min` } : null]);
      if (cap && minutesBetween(v.arrivedAt, cap.at) < took) {
        took = minutesBetween(v.arrivedAt, cap.at);
        until = ` (until ${cap.text})`;
      }
    }
    if (took === null) {
      const who = v.outcomeSource === 'DISPATCHER' ? 'the result was recorded by the office' : 'the unloading time is not known';
      return out.end(rule, key, `${label}: ${who}.`);
    }
    const over = took - planned;
    const final = `${label}: unloading took ${fmtDuration(took)}${until}, planned ${fmtDuration(planned)}${over > 0 ? ` (${fmtDuration(over)} over)` : ''}.`;
    const tier = tierAt(over, T);
    // A stop that ended over the limit before any sweep saw it live: kept as history (no toast, no e-mail).
    if (!out.isOpen(rule, key) && tier) {
      return out.raise({ ...stopBase(c, s), rule, kind: 'CONDITION', subjectKey: key, tier, value: over, threshold: T, text: final, occurredAt, history: true, facts: { tookMin: Math.round(took), plannedMin: planned } });
    }
    return out.end(rule, key, final);
  });
}

// ---------------------------------------------------------------------------------------------
// R2 LOADING_OVER: the turnaround at the depot between two trips (owner decision of 16 Oct 2026)
// ---------------------------------------------------------------------------------------------

/** The first sign of the truck at a stop of a load that left (lib/delivery/turnaround.ts firstSignOf; a load not out has no stops here). */
function firstSignOfLoad(l: FactLoad): Date | null {
  return firstSignOf(
    l.stops.map((s) => s.visit),
    l.stops.flatMap((s) => (s.visit?.photos ?? []).filter(phonePhoto).map((p) => p.takenAt ?? p.receivedAt)),
  );
}

/** The inputs of turnaroundOf for a load after a trip whose Back at depot is `prevBackAt`. */
function turnaroundInOf(l: FactLoad, prevBackAt: Date | null, now: Date): TurnaroundIn {
  return {
    backAt: prevBackAt,
    leftTaps: l.leftTaps ?? (l.leftTapAt ? [l.leftTapAt] : []),
    dispatchAt: l.dispatchedAt ?? (l.status === 'DISPATCHED' ? l.statusChangedAt : null),
    firstSignAt: firstSignOfLoad(l),
    plannedDriveMin: plannedDriveOf(l.departMin, l.stops),
    existedAt: l.existedAt ?? null,
    completed: l.status === 'COMPLETED',
    now,
  };
}

/**
 * R2: one row per trip after the first (subject: the load the truck leaves with). Measured from the
 * driver's Back at depot of the trip before (or from when the trip was planned, if later) to
 * his Leaving for next load (or a fallback: the Dispatch press, the first stop reached less the planned
 * drive) by lib/delivery/turnaround.ts. Live while the truck is still at the depot (now - Back at depot;
 * with the Dispatch press already behind and no tap the planned drive to the first stop is allowed
 * first: the truck may be on the road), final once it left; a turnaround that ended over the limit before
 * any sweep saw it live is kept as history. Not for the first trip of the day (loaded the night before),
 * not without Back at depot ("Load not closed" follows that trip), not across two depots, not for a load
 * without stops, never "still at the depot" on a Completed load, and not when this trip had started
 * before Back at depot of the trip before was tapped (the second review of 16 Oct 2026, H1-H3, M1).
 */
function loadingOver(out: Out, c: LoadCtx, truckDayLoads: readonly FactLoad[]): void {
  const rule: AlertRule = 'LOADING_OVER';
  const T = out.on(rule);
  if (T === null) return;
  const l = c.load;
  const when = (at: Date) => clockText(at, l.date, out.facts.tz);
  const prev = previousTrip(truckDayLoads, l.id);
  if (!prev) return out.end(rule, c.key, `${c.label}: the first trip of the day (loaded before it): not measured.`);
  if (prev.depotId !== l.depotId) return out.end(rule, c.key, `${c.label}: the trip before (L${prev.loadNo}) was at another depot: not measured.`);
  if (!l.stopCount) return out.end(rule, c.key, `${c.label}: no stops.`);
  const t = turnaroundOf(turnaroundInOf(l, prev.backAt, out.now));
  if (!t) return out.end(rule, c.key, `${c.label}: no Back at depot tapped for L${prev.loadNo}: the time at the depot is not known (see "Load not closed").`);
  if (t.notMeasured === 'BACK_LATE') {
    return out.end(rule, c.key, `${c.label}: Back at depot of L${prev.loadNo} was tapped at ${when(t.backAt)}, after L${l.loadNo} had already started: the time at the depot is not known.`);
  }
  if (t.notMeasured === 'NO_LEAVE') {
    return out.end(rule, c.key, `${c.label}: completed with no Leaving tap, Dispatch press or stop reached after Back at depot of L${prev.loadNo} at ${when(t.backAt)}: not measured.`);
  }
  const from = t.addedLater ? `L${l.loadNo} was planned at ${when(t.startAt)} (after Back at depot of L${prev.loadNo} at ${when(t.backAt)})` : `Back at depot of L${prev.loadNo} at ${when(t.backAt)}`;
  const occurredAt = new Date(t.startAt.getTime() + (T + t.graceMin) * 60_000);
  const facts = { afterLoadNo: prev.loadNo, backAt: t.backAt.toISOString(), startAt: t.startAt.toISOString(), leftAt: t.leftAt?.toISOString() ?? null, how: t.how, minutes: Math.round(t.minutes) };
  if (t.final && t.leftAt) {
    const span = t.addedLater ? `back ${when(t.backAt)}, L${l.loadNo} planned ${when(t.startAt)}` : `back ${when(t.backAt)}`;
    const left = t.how === 'ARRIVAL' ? `left by ${when(t.leftAt)}` : `left ${when(t.leftAt)}`;
    const final = `${c.label}: ${fmtDuration(t.minutes)} at the depot between L${prev.loadNo} and L${l.loadNo} (${span}, ${left}, by ${leftHowText(t, when)}), limit ${T} min.`;
    const tier = tierAt(t.minutes, T);
    // Over the limit before any sweep saw it live (a tap sent late, the sweep not running): history.
    if (!out.isOpen(rule, c.key) && tier) return out.raise({ ...base(c), rule, kind: 'CONDITION', subjectKey: c.key, tier, value: t.minutes, threshold: T, text: final, occurredAt, history: true, facts });
    return out.end(rule, c.key, final);
  }
  if (t.minutes > TURNAROUND_MAX_MIN) {
    return out.unfollow(rule, c.key, `${c.label}: no Leaving tap, Dispatch or stop reached ${fmtDuration(TURNAROUND_MAX_MIN)} after ${from}: no longer followed.`);
  }
  // Dispatched before Back at depot and no tap: the truck may be on its way to the first stop already.
  const counted = t.minutes - t.graceMin;
  const grace = t.graceMin ? `; the planned ${t.graceMin} min drive to the first stop allowed, as the load was dispatched before and no stop is reached yet` : '';
  const tier = tierAt(counted, T);
  if (!tier) return out.end(rule, c.key, `${c.label}: at the depot ${fmtDuration(t.minutes)} since ${from}, within ${T} min${grace}.`);
  return out.raise({
    ...base(c),
    rule,
    kind: 'CONDITION',
    subjectKey: c.key,
    tier,
    value: counted,
    threshold: T,
    text: `${c.label}: at the depot for ${fmtDuration(t.minutes)} since ${from}, not left with L${l.loadNo} yet (limit ${T} min${grace}). Planned departure ${planTime(l.departMin)}, load is ${STATUS_WORD[l.status] ?? l.status}.`,
    occurredAt,
    facts: { ...facts, graceMin: t.graceMin },
  });
}

// ---------------------------------------------------------------------------------------------
// R3 ETA_LATE (with the window-risk note of the stops further on)
// ---------------------------------------------------------------------------------------------

/** The time a stop is judged against its window end under the load's rule: the arrival (START) or the end of unloading (FINISH). */
function windowJudgedMin(c: LoadCtx, p: { arrMin: number | null; depMin: number | null }): number | null {
  return c.load.windowRule === 'FINISH' ? p.depMin : p.arrMin;
}

/** The first pending stop with a delivery window (the one AFTER_CLOSING projects: H5). */
function nextWithWindowOf(c: LoadCtx, proj: Projection | null = c.proj): ProjectedStop | null {
  return proj?.stops.find((p) => p.state === 'PENDING' && has(windowEndOf(c.load.stops.find((s) => s.sequence === p.sequence)!))) ?? null;
}

function etaLate(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'ETA_LATE';
  const T = out.on(rule);
  if (T === null) return;
  const l = c.load;
  if (l.status !== 'DISPATCHED') return out.end(rule, c.key, `${c.label}: ${STATUS_WORD[l.status] ?? l.status}.`);
  if (c.back) return out.end(rule, c.key, `${c.label}: ${c.back.text}.`);
  if (!c.pageOpened) return out.end(rule, c.key, `${c.label}: the driver page was not opened, so the delay cannot be worked out.`);
  const proj = c.proj!;
  const next = proj.next;
  if (!next) return out.end(rule, c.key, `${c.label}: no stop left to reach.`);
  if (c.pastReturn) return out.unfollow(rule, c.key, `${c.label}: past the planned return (${planTime(l.returnMin)}): no longer followed, see "Load not closed".`);
  if (c.silent) return out.holdOrEnd(rule, c.key, `${c.label}: the driver is silent, so the delay cannot be worked out.`);
  if (c.unloadingSeq !== null) {
    const at = l.stops.find((s) => s.sequence === c.unloadingSeq)!;
    return out.holdOrEnd(rule, c.key, `${c.label}: unloading at ${stopLabel(at)} takes longer than planned (see "Unloading longer than planned").`);
  }
  const delay = next.delayMin;
  if (!has(delay)) return out.end(rule, c.key, `${c.label}: the next stop has no planned time.`);
  let tier: number = tierAt(delay, T);
  // Hysteresis: an open row closes only when the delay is back under T - 10 min.
  if (!tier && out.isOpen(rule, c.key) && delay > T - ALERT_HYSTERESIS_MIN) tier = 1;
  const stop = l.stops.find((s) => s.sequence === next.sequence)!;
  if (!tier) return out.end(rule, c.key, `${c.label}: back on time (about ${fmtDuration(Math.max(0, delay))} late at the next stop, ${stopLabel(stop)}).`);
  const about = proj.approximate ? 'roughly' : 'about';
  const nextText = next.clockBound
    ? `next ${stopLabel(stop)} not reached yet (planned ${planTime(stop.etaMin)})`
    : next.phoneHeld
      ? `no arrival recorded yet at the next ${stopLabel(stop)} (expected ${about} ${planTime(next.arrMin)}, planned ${planTime(stop.etaMin)})`
      : `next ${stopLabel(stop)} expected ${about} ${planTime(next.arrMin)} (planned ${planTime(stop.etaMin)})`;
  // The stops left that may miss their window (H5: folded in here, one alert per truck), except the one
  // AFTER_CLOSING follows itself when it is on (the next pending stop with a window).
  const t6 = out.on('AFTER_CLOSING');
  const own = t6 !== null ? nextWithWindowOf(c) : null;
  const atRisk = proj.stops
    .filter((p) => p.state === 'PENDING' && p.sequence !== own?.sequence)
    .filter((p) => {
      const s = l.stops.find((x) => x.sequence === p.sequence);
      const end = s ? windowEndOf(s) : null;
      const judged = windowJudgedMin(c, p);
      return has(end) && has(judged) && judged > end + (t6 ?? 0);
    })
    .map((p) => p.sequence);
  const risk = atRisk.length ? ` ${sequencesText(atRisk).replace(/^s/, 'S')} may miss ${atRisk.length === 1 ? 'its' : 'their'} delivery window.` : '';
  // Dated to when the delay reached T (L2: a truck already late at the switch-on is backlog either way).
  const occurredAt = projectedSince(c, out.now, T, (p) => (p.next?.sequence === next.sequence ? p.next.delayMin : null));
  return out.raise({
    ...base(c),
    rule,
    kind: 'CONDITION',
    subjectKey: c.key,
    tier: tier as AlertTier,
    value: delay,
    threshold: T,
    text: `${c.label} is running ${about} ${fmtDuration(delay)} late: ${nextText}; ${stopsText(stopsWithoutResult(l))} left, back ${about} ${planTime(proj.returnMin)} (planned ${planTime(l.returnMin)}).${risk}`,
    occurredAt,
    facts: { nextSequence: next.sequence, delayMin: Math.round(delay), returnMin: proj.returnMin, atRisk },
  });
}

// ---------------------------------------------------------------------------------------------
// R4 DEPART_LATE
// ---------------------------------------------------------------------------------------------

/**
 * When a later trip is counted from (M6): the later of its planned departure and the previous load's
 * return + the planned turnaround (this trip's planned departure - that load's planned return). The
 * return: Back at depot; else the Completed press when it came before the planned return +
 * RETURN_GRACE_MIN; else, once that has passed (or the load was completed later), the planned return +
 * RETURN_GRACE_MIN (lib/delivery/day-results.ts loadIsBack). `out`: the previous load is still out.
 */
function departRef(c: LoadCtx, prev: FactLoad | undefined, tz: string): { ref: number; text: string } | { out: FactLoad } {
  const l = c.load;
  if (!prev) return { ref: l.departMin, text: '' };
  const turnaround = Math.max(0, l.departMin - prev.returnMin);
  let backMin: number;
  let how: string;
  if (prev.backAt) {
    backMin = minutesOnDate(prev.backAt, l.date, tz);
    how = `L${prev.loadNo} back ${clockText(prev.backAt, l.date, tz)}`;
  } else if (prev.status === 'COMPLETED' && prev.statusChangedAt && minutesOnDate(prev.statusChangedAt, l.date, tz) < prev.returnMin + RETURN_GRACE_MIN) {
    // Completed by the office before its planned return + 60 min: the truck was back by then.
    backMin = minutesOnDate(prev.statusChangedAt, l.date, tz);
    how = `L${prev.loadNo} completed ${clockText(prev.statusChangedAt, l.date, tz)}`;
  } else if (prev.status === 'COMPLETED' || c.nowMin >= prev.returnMin + RETURN_GRACE_MIN) {
    backMin = prev.returnMin + RETURN_GRACE_MIN;
    how = `L${prev.loadNo} taken as back at ${planTime(backMin)} (no Back at depot)`;
  } else return { out: prev };
  const from = backMin + turnaround;
  if (from <= l.departMin) return { ref: l.departMin, text: '' };
  return { ref: from, text: ` (${how}, + the planned ${fmtDuration(turnaround)} turnaround: counted from ${planTime(from)})` };
}

function departLate(out: Out, c: LoadCtx, truckDayLoads: readonly FactLoad[]): void {
  const rule: AlertRule = 'DEPART_LATE';
  const T = out.on(rule);
  if (T === null) return;
  const l = c.load;
  const tz = out.facts.tz;
  const earlier = truckDayLoads.filter((x) => x.loadNo < l.loadNo).sort((a, b) => a.loadNo - b.loadNo);
  const prev = earlier[earlier.length - 1];
  if (ON_ROAD.has(l.status)) {
    if (l.status !== 'DISPATCHED' || !l.statusChangedAt) return out.end(rule, c.key, `${c.label}: ${STATUS_WORD[l.status] ?? l.status}.`);
    const dispatchMin = minutesOnDate(l.statusChangedAt, l.date, tz);
    // After the press only a tapped return of the previous load moves the reference (the truck left again, so it was back).
    const ref = prev?.backAt ? Math.max(l.departMin, minutesOnDate(prev.backAt, l.date, tz) + Math.max(0, l.departMin - prev.returnMin)) : l.departMin;
    const lateBy = dispatchMin - ref;
    const behind = dispatchMin - l.departMin;
    const counted = ref > l.departMin ? ` (counted from ${planTime(ref)}: L${prev!.loadNo} came back late)` : '';
    const final = `${c.label} dispatched ${clockText(l.statusChangedAt, l.date, tz)}${behind > 0 ? `, ${fmtDuration(behind)} after the planned ${planTime(l.departMin)}${counted}` : ` (planned ${planTime(l.departMin)})`}.`;
    const tier = tierAt(lateBy, T);
    const recent = minutesBetween(l.statusChangedAt, out.now) <= DEPART_LATE_HISTORY_MIN;
    // Found only after the Dispatch press (pressed between two sweeps, or the sweep was not running): history.
    if (!out.isOpen(rule, c.key) && tier && recent && l.date === out.facts.today) {
      return out.raise({ ...base(c), rule, kind: 'CONDITION', subjectKey: c.key, tier, value: lateBy, threshold: T, text: final, occurredAt: l.statusChangedAt, history: true, facts: { dispatchMin, refMin: ref } });
    }
    return out.end(rule, c.key, final);
  }
  if (l.date !== out.facts.today) return out.end(rule, c.key, `${c.label}: still ${STATUS_WORD[l.status] ?? l.status}, the day is over.`);
  if (!l.stopCount) return out.end(rule, c.key, `${c.label}: no stops.`);
  if (l.status === 'PLANNED' && !earlier.some((x) => x.status !== 'PLANNED')) return out.end(rule, c.key, `${c.label}: Planned (not locked).`);
  const notOut = earlier.find((x) => !ON_ROAD.has(x.status));
  if (notOut) return out.end(rule, c.key, `${c.label}: Load ${notOut.loadNo} of this truck is not dispatched yet.`);
  const r = departRef(c, prev, tz);
  if ('out' in r) return out.end(rule, c.key, `${c.label}: Load ${r.out.loadNo} of this truck is still out.`);
  const late = c.nowMin - r.ref;
  if (late > DEPART_LATE_EXPIRE_MIN) return out.unfollow(rule, c.key, `${c.label}: still not dispatched ${fmtDuration(DEPART_LATE_EXPIRE_MIN)} after ${planTime(r.ref)}: no longer followed.`);
  const tier = tierAt(late, T);
  if (!tier) return out.end(rule, c.key, `${c.label}: not late.`);
  const seen = c.td?.linkSeenAt ? ` Driver page last open ${clockText(c.td.linkSeenAt, l.date, tz)}.` : '';
  const left = l.leftTapAt ? ` The driver tapped Leaving for next load at ${clockText(l.leftTapAt, l.date, tz)}.` : '';
  return out.raise({
    ...base(c),
    rule,
    kind: 'CONDITION',
    subjectKey: c.key,
    tier,
    value: late,
    threshold: T,
    text: `${c.label} not dispatched: planned departure ${planTime(l.departMin)}${r.text}, now ${clockText(out.now, l.date, tz)} (${fmtDuration(late)} late), load is ${STATUS_WORD[l.status] ?? l.status}.${seen}${left} Dispatch it if it has left.`,
    occurredAt: dateAt(c.dayStart, r.ref + T),
    facts: { departMin: l.departMin, refMin: r.ref, status: l.status },
  });
}

// ---------------------------------------------------------------------------------------------
// R5 DRIVER_SILENT
// ---------------------------------------------------------------------------------------------

/** What the last signal was: "left stop 2 Shop Example D", "Back at depot". */
function signalText(sig: FactSignal, loads: readonly FactLoad[]): string {
  if (sig.kind === 'BACK_AT_DEPOT') return `Back at depot (L${sig.loadNo})`;
  if (sig.kind === 'DEPOT_DEPART') return `Leaving for next load (L${sig.loadNo})`;
  const s = loads.find((l) => l.depotId === sig.depotId && l.loadNo === sig.loadNo)?.stops.find((x) => x.sequence === sig.sequence);
  const stop = s ? stopLabel(s) : sig.sequence !== null ? `stop ${sig.sequence}` : 'a stop';
  const prefix = loads.some((l) => l.loadNo !== sig.loadNo) ? `L${sig.loadNo} ` : '';
  switch (sig.kind) {
    case 'ARRIVED':
      return `arrived at ${prefix}${stop}`;
    case 'DEPARTED':
      return `left ${prefix}${stop}`;
    case 'OUTCOME':
      return `result at ${prefix}${stop}`;
    case 'PHOTO':
      return `photo at ${prefix}${stop}`;
    default:
      return `${sig.kind.toLowerCase()} at ${prefix}${stop}`;
  }
}

function driverSilent(out: Out, c: LoadCtx, truckDayLoads: readonly FactLoad[]): void {
  const rule: AlertRule = 'DRIVER_SILENT';
  const T = out.on(rule);
  if (T === null) return;
  const l = c.load;
  const tz = out.facts.tz;
  if (l.status !== 'DISPATCHED') return out.end(rule, c.key, `${c.label}: ${STATUS_WORD[l.status] ?? l.status}.`);
  if (c.back) return out.end(rule, c.key, `${c.label}: ${c.back.text}.`);
  if (!c.pageOpened) return out.end(rule, c.key, `${c.label}: the driver page was not opened.`);
  // M1: past the planned return + 60 min (or a load of an earlier day) "Load not closed" follows it.
  if (c.pastReturn) return out.unfollow(rule, c.key, `${c.label}: past the planned return (${planTime(l.returnMin)}): no longer followed, see "Load not closed".`);
  const proj = c.proj!;
  if (!proj.next) return out.end(rule, c.key, `${c.label}: no stop left to reach.`);
  const inProgress = proj.inProgress ? l.stops.find((s) => s.sequence === proj.inProgress!.sequence) : null;
  if (inProgress && !(inProgress.visit && farArrival(inProgress.visit))) return out.end(rule, c.key, `${c.label}: unloading at ${stopLabel(inProgress)}.`);
  const sig = c.td?.lastSignal ?? null;
  const dispatchAt = l.statusChangedAt;
  const last = sig && (!dispatchAt || sig.at > dispatchAt) ? sig.at : dispatchAt;
  if (!last) return out.end(rule, c.key, `${c.label}: no Dispatch time.`);
  const lastMin = minutesOnDate(last, l.date, tz);
  const silence = minutesBetween(last, out.now);
  // A planned break inside the silent gap is not silence (M10).
  const brk = l.breakMin;
  const overlap = brk ? Math.max(0, Math.min(c.nowMin, brk.endMin) - Math.max(lastMin, brk.startMin)) : 0;
  const counted = silence - overlap;
  const expected = proj.next.expectedArrMin;
  const overdue = has(expected) && c.nowMin > expected + SILENT_AFTER_NEXT_ETA_MIN;
  const tier = tierAt(counted, T, ALERT_RULE_SPECS[rule].maxTier);
  if (!tier || !overdue) {
    const resumed = sig && dispatchAt && sig.at > dispatchAt ? ` The driver's phone sent at ${clockText(sig.at, l.date, tz)}.` : '';
    return out.end(rule, c.key, `${c.label}: not silent.${resumed}`);
  }
  c.silent = true;
  const what = sig && last === sig.at ? `last: ${signalText(sig, truckDayLoads)} at ${clockText(sig.at, l.date, tz)}` : `nothing since Dispatch at ${clockText(last, l.date, tz)}`;
  const seen = c.td?.linkSeenAt ? ` Driver page last open ${clockText(c.td.linkSeenAt, l.date, tz)}.` : '';
  const nextStop = l.stops.find((s) => s.sequence === proj.next!.sequence)!;
  const brkText = overlap > 0 ? ` (the planned break of ${fmtDuration(overlap)} not counted)` : '';
  return out.raise({
    ...base(c),
    rule,
    kind: 'CONDITION',
    subjectKey: c.key,
    tier,
    value: counted,
    threshold: T,
    text: `${c.label}: nothing from the driver's phone for ${fmtDuration(counted)}${brkText} (${what}).${seen} ${stopsText(stopsWithoutResult(l))} left; ${stopLabel(nextStop)} was expected about ${planTime(expected)}.`,
    occurredAt: new Date(last.getTime() + (T + overlap) * 60_000),
    facts: { silentMin: Math.round(counted), breakMin: overlap, nextSequence: nextStop.sequence },
  });
}

// ---------------------------------------------------------------------------------------------
// R6 AFTER_CLOSING
// ---------------------------------------------------------------------------------------------

function afterClosing(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'AFTER_CLOSING';
  const T = out.on(rule);
  if (T === null) return;
  const l = c.load;
  const tz = out.facts.tz;
  const proj = c.proj;
  // Only the next pending stop with a window is projected (H5); the others are folded into ETA_LATE.
  const nextWithWindow = nextWithWindowOf(c);
  for (const s of l.stops) {
    const key = stopKey(c, s);
    const label = `${c.label} ${stopLabel(s)}`;
    const end = windowEndOf(s);
    if (!has(end)) {
      out.end(rule, key, `${label}: no delivery window.`);
      continue;
    }
    const v = s.visit;
    if (v?.arrivedAt) {
      if (!arrivalIsObserved(v)) {
        out.end(rule, key, `${label}: arrived (the arrival time is not certain).`);
        continue;
      }
      const arr = minutesOnDate(v.arrivedAt, l.date, tz);
      const over = arr - end;
      if (over > T) {
        out.raise({
          ...stopBase(c, s),
          rule,
          kind: 'EVENT',
          subjectKey: key,
          // M4: a warning, high beyond 2T (16 min after a 15-min margin is not a page).
          tier: tierAt(over, T, ALERT_RULE_SPECS[rule].maxTier) as AlertTier,
          value: over,
          threshold: T,
          text: `${label}: arrived ${clockText(v.arrivedAt, l.date, tz)}, after its delivery window ended at ${planTime(end)} (${fmtDuration(over)} late).`,
          occurredAt: v.arrivedAt,
          facts: { arrivedMin: arr, windowEndMin: end },
        });
      } else out.end(rule, key, `${label}: arrived ${clockText(v.arrivedAt, l.date, tz)}, inside its delivery window (ends ${planTime(end)}).`);
      continue;
    }
    const p = proj?.stops.find((x) => x.sequence === s.sequence) ?? null;
    if (l.status !== 'DISPATCHED' || !p || p.state !== 'PENDING' || c.back) {
      out.end(rule, key, `${label}: not expected any more.`);
      continue;
    }
    if (!c.pageOpened) {
      out.end(rule, key, `${label}: the driver page was not opened, so the arrival cannot be worked out.`);
      continue;
    }
    if (nextWithWindow?.sequence !== s.sequence) {
      out.end(rule, key, `${label}: another stop comes first.`);
      continue;
    }
    if (c.pastReturn) {
      out.unfollow(rule, key, `${label}: past the planned return (${planTime(l.returnMin)}): no longer followed.`);
      continue;
    }
    if (c.silent) {
      out.holdOrEnd(rule, key, `${label}: the driver is silent.`);
      continue;
    }
    if (c.unloadingSeq !== null) {
      out.holdOrEnd(rule, key, `${label}: the unloading at stop ${c.unloadingSeq} takes longer than planned.`);
      continue;
    }
    const judged = windowJudgedMin(c, p);
    if (!has(judged)) {
      out.end(rule, key, `${label}: no planned time.`);
      continue;
    }
    const over = judged - end;
    let tier: number = over > T ? 1 : 0;
    if (!tier && out.isOpen(rule, key) && over > T - ALERT_HYSTERESIS_MIN) tier = 1;
    const what = l.windowRule === 'FINISH' ? `unloading expected to finish about ${planTime(p.depMin)}` : `expected about ${planTime(p.arrMin)}`;
    if (!tier) {
      out.end(rule, key, `${label}: ${what}, inside its delivery window (ends ${planTime(end)}).`);
      continue;
    }
    const must = l.windowRule === 'FINISH' ? 'unloading must be finished by then' : 'the latest arrival';
    out.raise({
      ...stopBase(c, s),
      rule,
      kind: 'CONDITION',
      subjectKey: key,
      tier: 1,
      value: over,
      threshold: T,
      text: `${label}: ${what}, after its delivery window ends at ${planTime(end)} (${must}).`,
      // Dated to when the projection first put it past the margin (L2).
      occurredAt: projectedSince(c, out.now, T, (pr) => {
        const q = nextWithWindowOf(c, pr);
        const j = q?.sequence === s.sequence ? windowJudgedMin(c, q) : null;
        return has(j) ? j - end : null;
      }),
      facts: { projectedMin: judged, windowEndMin: end, windowRule: l.windowRule },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// R7 PRIORITY_NOT_DELIVERED, R8 DELIVERED_WITH_NOTE, R9 PROOF_FAR (events)
// ---------------------------------------------------------------------------------------------

function resultWords(v: FactVisit | null, tz: string, date: string): string {
  if (!v?.outcome) return 'result removed';
  const at = v.outcomeAt ? ` ${clockText(v.outcomeAt, date, tz)}` : '';
  return `${OUTCOME_LABEL[v.outcome] ?? v.outcome} (${sourceWord(v.outcomeSource)}${at})`;
}

function priorityNotDelivered(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'PRIORITY_NOT_DELIVERED';
  const T = out.on(rule);
  if (T === null) return;
  const tz = out.facts.tz;
  for (const s of c.load.stops) {
    const key = stopKey(c, s);
    const label = `${c.label} ${stopLabel(s)}`;
    const v = s.visit;
    const bad = v?.outcome === 'NOT_DELIVERED' || v?.outcome === 'PARTLY_DELIVERED';
    const fromDriver = !!v?.outcomeSource && v.outcomeSource !== 'DISPATCHER';
    if (!(bad && fromDriver && has(s.priority) && s.priority <= T && v?.outcomeAt)) {
      out.end(rule, key, `${label}: now ${resultWords(v, tz, c.load.date)}.`);
      continue;
    }
    const partly = v!.outcome === 'PARTLY_DELIVERED';
    const cases = partly && has(v!.casesDelivered) ? ` (${v!.casesDelivered} of ${v!.casesPlanned} cases)` : '';
    out.raise({
      ...stopBase(c, s),
      rule,
      kind: 'EVENT',
      subjectKey: key,
      tier: partly ? 1 : 2,
      value: s.priority!,
      threshold: T,
      text: `${label}, priority ${s.priority}: ${partly ? 'PARTLY DELIVERED' : 'NOT DELIVERED'}${cases} - ${reasonLabel(v!.reason)} (${sourceWord(v!.outcomeSource)}, ${clockText(v!.outcomeAt!, c.load.date, tz)}).${noteText(v!.reasonNote)}`,
      occurredAt: v!.outcomeAt!,
      facts: { outcome: v!.outcome, reason: v!.reason },
    });
  }
}

function deliveredWithNote(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'DELIVERED_WITH_NOTE';
  if (out.on(rule) === null) return;
  const tz = out.facts.tz;
  for (const s of c.load.stops) {
    const key = stopKey(c, s);
    const label = `${c.label} ${stopLabel(s)}`;
    const v = s.visit;
    const note = shortNote(v?.reasonNote);
    if (!(v?.outcome === 'DELIVERED' && v.outcomeSource && PHONE_SOURCES.has(v.outcomeSource) && note && v.outcomeAt)) {
      out.end(rule, key, `${label}: the note was removed or the result changed (now ${resultWords(v, tz, c.load.date)}).`);
      continue;
    }
    // "Delivered", "received", "delivered at 11:25": the note only confirms the delivery, nothing to check.
    if (noteOnlyConfirms(v.reasonNote)) {
      out.end(rule, key, `${label}: the note only confirms the delivery ("${note}").`);
      continue;
    }
    out.raise({
      ...stopBase(c, s),
      rule,
      kind: 'EVENT',
      subjectKey: key,
      tier: 1,
      value: 0,
      threshold: 0,
      text: `${label} marked DELIVERED with a note: "${note}" (driver, ${clockText(v.outcomeAt, c.load.date, tz)}). Check everything was delivered.`,
      occurredAt: v.outcomeAt,
    });
  }
}

const median = (xs: readonly number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
};

function proofFar(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'PROOF_FAR';
  const T = out.on(rule);
  if (T === null) return;
  const tz = out.facts.tz;
  const l = c.load;
  l.stops.forEach((s, i) => {
    const key = stopKey(c, s);
    const label = `${c.label} ${stopLabel(s)}`;
    const v = s.visit;
    if (!s.pinVerified) return out.end(rule, key, `${label}: the customer's pin is not verified, so it is not checked.`);
    // Planned at an older pin: the distances were measured to it, and the pin was corrected since (pin-check PIN_MOVED_M).
    if (s.pinMoved) return out.end(rule, key, `${label}: the customer's pin was moved after this delivery was planned, so it is not checked.`);
    // H3, as "Pin may be wrong" reads a visit: the driver's own photos, each by the phone's position when
    // it is good, else by the photo's own location; their median distance. Without them, the driver's
    // result position, unless the truck was already at a later stop before it (a result entered later).
    const points = (v?.photos ?? []).filter(phonePhoto).flatMap((ph) => {
      if (ph.positionStatus === 'OK' && has(ph.distanceM) && has(ph.accuracyM) && ph.accuracyM <= ALERT_EVIDENCE_MAX_ACCURACY_M) {
        return [{ m: ph.distanceM, at: ph.receivedAt, what: `phone location, accuracy ${Math.round(ph.accuracyM)} m` }];
      }
      if (has(ph.exifDistanceM)) return [{ m: ph.exifDistanceM, at: ph.receivedAt, what: "the photo's own location" }];
      return [];
    });
    let m: number | null = null;
    let at: Date | null = null;
    let what = '';
    if (points.length) {
      m = median(points.map((p) => p.m));
      at = points.reduce((a, b) => (b.at > a ? b.at : a), points[0]!.at);
      what =
        points.length === 1
          ? `delivery photo taken ${fmtDistance(m)} from the customer's pin (${points[0]!.what}, ${clockText(at, l.date, tz)})`
          : `${points.length} delivery photos taken about ${fmtDistance(m)} from the customer's pin (the middle of their distances; the last at ${clockText(at, l.date, tz)})`;
    } else if (
      v &&
      (v.outcome === 'DELIVERED' || v.outcome === 'PARTLY_DELIVERED') &&
      v.outcomeAt &&
      v.outcomeSource &&
      PHONE_SOURCES.has(v.outcomeSource) &&
      has(v.outcomeDistanceM) &&
      has(v.outcomeAccuracyM) &&
      v.outcomeAccuracyM <= ALERT_EVIDENCE_MAX_ACCURACY_M &&
      !laterActivityBefore(l.stops, i, v.outcomeAt)
    ) {
      m = v.outcomeDistanceM;
      at = v.outcomeAt;
      what = `result recorded ${fmtDistance(m)} from the customer's pin (accuracy ${Math.round(v.outcomeAccuracyM)} m, ${clockText(at, l.date, tz)})`;
    }
    if (m === null || at === null || !(m > T)) return out.end(rule, key, `${label}: no photo or result far from the pin.`);
    out.raise({
      ...stopBase(c, s),
      rule,
      kind: 'EVENT',
      subjectKey: key,
      tier: m > PROOF_FAR_HIGH_FACTOR * T ? 2 : 1,
      value: m,
      threshold: T,
      text: `${label}: ${what}. The pin or the place of the photo is wrong.`,
      occurredAt: at,
      facts: { metres: Math.round(m), photos: points.length },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// R10 LOAD_NOT_CLOSED
// ---------------------------------------------------------------------------------------------

function loadNotClosed(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'LOAD_NOT_CLOSED';
  const T = out.on(rule);
  if (T === null) return;
  const l = c.load;
  const tz = out.facts.tz;
  if (l.status !== 'DISPATCHED') {
    const at = l.status === 'COMPLETED' && l.statusChangedAt ? ` at ${clockText(l.statusChangedAt, l.date, tz)}` : '';
    return out.end(rule, c.key, `${c.label}: ${STATUS_WORD[l.status] ?? l.status}${at}.`);
  }
  if (!c.pageOpened) return out.end(rule, c.key, `${c.label}: the driver page was not opened (see "Driver page not opened").`);
  const missing = stopsWithoutResult(l);
  if (c.back && missing === 0) return out.end(rule, c.key, `${c.label}: ${c.back.text} with every result recorded: closing.`);
  const overdue = c.nowMin - l.returnMin;
  // M8: with every result in, only Back at depot or the Completed press is missing: paperwork, a warning.
  const tier = tierAt(overdue, T, missing ? ALERT_RULE_SPECS[rule].maxTier : 1);
  if (!tier) return out.end(rule, c.key, `${c.label}: not overdue.`);
  const back = c.back ? c.back.text : 'no Back at depot';
  const results = missing ? `, ${missing} of ${stopsText(l.stops.length)} without a result` : ', every result recorded';
  return out.raise({
    ...base(c),
    rule,
    kind: 'CONDITION',
    subjectKey: c.key,
    tier,
    value: overdue,
    threshold: T,
    text: `${c.label} still not closed at ${clockText(out.now, l.date, tz)}: planned back ${planTime(l.returnMin)}, ${back}${results}. ${missing ? 'Record the results, then Completed.' : 'Press Completed.'}`,
    occurredAt: dateAt(c.dayStart, l.returnMin + T),
    facts: { returnMin: l.returnMin, missing, back: !!c.back },
  });
}

// ---------------------------------------------------------------------------------------------
// R11 PAGE_NOT_OPENED (one per depot, date and truck)
// ---------------------------------------------------------------------------------------------

function pageNotOpened(out: Out, loads: readonly FactLoad[], td: FactTruckDay | null): void {
  const rule: AlertRule = 'PAGE_NOT_OPENED';
  const T = out.on(rule);
  if (T === null || !loads.length) return;
  const first = loads[0]!;
  const tz = out.facts.tz;
  const key = subjectKeyOf({ depotId: first.depotId, date: first.date, truckId: first.truckId });
  const truck = first.truckCode;
  const outLoads = loads.filter((l) => l.status === 'DISPATCHED').sort((a, b) => a.departMin - b.departMin);
  if (!outLoads.length) return out.end(rule, key, `${truck}: no load out any more.`);
  if (td?.pageOpened) {
    const at = td.linkSeenAt ?? td.lastSignal?.at ?? null;
    return out.end(rule, key, `${truck}: driver page opened${at ? ` (last open ${clockText(at, first.date, tz)})` : ''}.`);
  }
  const dayStart = zonedDayStart(first.date, tz);
  const since = minutesOnDate(out.now, first.date, tz) - outLoads[0]!.departMin;
  const tier = tierAt(since, T, ALERT_RULE_SPECS[rule].maxTier);
  if (!tier) return out.end(rule, key, `${truck}: not yet ${T} min after the planned departure.`);
  const which = outLoads.map((l) => `L${l.loadNo}`).join(', ');
  return out.raise({
    depotId: first.depotId,
    deliveryDate: first.date,
    truckId: first.truckId,
    truckCode: truck,
    loadNo: null,
    sequence: null,
    customerId: null,
    rule,
    kind: 'CONDITION',
    subjectKey: key,
    tier,
    value: since,
    threshold: T,
    text: `${truck}: dispatched (${which}, planned departure ${planTime(outLoads[0]!.departMin)}) but the driver page has not been opened. RouteIQ cannot follow this truck: give the driver the link or QR code, or record the results in the office.`,
    occurredAt: new Date(dayStart.getTime() + (outLoads[0]!.departMin + T) * 60_000),
    facts: { loads: outLoads.map((l) => l.loadNo) },
  });
}

// ---------------------------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------------------------

/**
 * The rules over the facts at `now`, with each rule's threshold (catalog.ts thresholdsOf: null = off).
 * Deterministic for the same input; never reads the clock or the database.
 */
export function evaluate(facts: AlertFacts, now: Date, thresholds: Thresholds): Evaluation {
  const out = new Out(facts, now, thresholds);
  const tz = facts.tz;
  const tdOf = new Map(facts.truckDays.map((t) => [truckDayOf(t.date, t.truckId), t]));
  const dayLoads = new Map<string, FactLoad[]>();
  for (const l of facts.loads) {
    const k = truckDayOf(l.date, l.truckId);
    const list = dayLoads.get(k);
    if (list) list.push(l);
    else dayLoads.set(k, [l]);
  }
  const lateDispatch = out.on('ETA_LATE');
  for (const l of facts.loads) {
    const td = tdOf.get(truckDayOf(l.date, l.truckId)) ?? null;
    const truckDayLoads = dayLoads.get(truckDayOf(l.date, l.truckId)) ?? [l];
    const dayStart = zonedDayStart(l.date, tz);
    const nowMin = minutesOnDate(now, l.date, tz);
    const stopsIn = l.stops.map((s) => {
      const v = s.visit;
      const endAt = v?.departedAt ?? (v?.outcomeAt && v.outcomeSource !== 'DISPATCHER' ? v.outcomeAt : null);
      // M3: a delivery photo of the driver's phone is the truck being there, when no arrival was recorded.
      const arrAt = v?.arrivedAt ?? firstPhotoAt(v);
      return {
        sequence: s.sequence,
        etaMin: s.etaMin,
        serviceStartMin: s.serviceStartMin,
        departureMin: s.departureMin,
        plannedServiceMin: plannedServiceOf(s),
        windowStartMin: windowStartOf(s),
        arrivedMin: arrAt ? minutesOnDate(arrAt, l.date, tz) : null,
        endMin: endAt ? minutesOnDate(endAt, l.date, tz) : null,
        hasOutcome: !!v?.outcome,
      };
    });
    const activity = stopsIn.map((s) => s.arrivedMin !== null || s.endMin !== null || s.hasOutcome);
    const laterActivity = activity.map((_, i) => activity.slice(i + 1).some(Boolean));
    const projIn: ProjectionIn | null =
      l.status === 'DISPATCHED'
        ? {
            departMin: l.departMin,
            returnMin: l.returnMin,
            dispatchMin: l.statusChangedAt ? minutesOnDate(l.statusChangedAt, l.date, tz) : null,
            nowMin,
            lateDispatchMin: lateDispatch,
            phoneSeenMin: td?.lastSignal ? minutesOnDate(td.lastSignal.at, l.date, tz) : null,
            stops: stopsIn,
          }
        : null;
    const c: LoadCtx = {
      load: l,
      label: loadLabel(l.truckCode, l.loadNo),
      key: subjectKeyOf({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo }),
      dayStart,
      nowMin,
      td,
      pageOpened: !!td?.pageOpened,
      proj: projIn ? projectLoad(projIn) : null,
      projIn,
      silent: false,
      unloadingSeq: null,
      laterActivity,
      back: backOf(l, truckDayLoads, now, tz),
      pastReturn: l.date < facts.today || nowMin > l.returnMin + RETURN_GRACE_MIN,
    };
    const run = (rule: AlertRule, fn: () => void) => {
      if (out.on(rule) === null) return;
      try {
        fn();
      } catch (err) {
        out.failed(rule, c.key, err);
      }
    };
    run('LOADING_OVER', () => loadingOver(out, c, truckDayLoads));
    run('DEPART_LATE', () => departLate(out, c, truckDayLoads));
    // DRIVER_SILENT and UNLOAD_OVER first: ETA_LATE and the projected AFTER_CLOSING are held while either is raised.
    run('DRIVER_SILENT', () => driverSilent(out, c, truckDayLoads));
    if (ON_ROAD.has(l.status)) run('UNLOAD_OVER', () => unloadOver(out, c));
    run('ETA_LATE', () => etaLate(out, c));
    run('LOAD_NOT_CLOSED', () => loadNotClosed(out, c));
    if (ON_ROAD.has(l.status)) {
      run('AFTER_CLOSING', () => afterClosing(out, c));
      run('PRIORITY_NOT_DELIVERED', () => priorityNotDelivered(out, c));
      run('DELIVERED_WITH_NOTE', () => deliveredWithNote(out, c));
      run('PROOF_FAR', () => proofFar(out, c));
    }
  }
  // PAGE_NOT_OPENED per depot, date and truck.
  const perDepotDay = new Map<string, FactLoad[]>();
  for (const l of facts.loads) {
    const k = `${l.depotId}|${l.date}|${l.truckId}`;
    const list = perDepotDay.get(k);
    if (list) list.push(l);
    else perDepotDay.set(k, [l]);
  }
  for (const loads of perDepotDay.values()) {
    const first = loads[0]!;
    try {
      pageNotOpened(out, loads, tdOf.get(truckDayOf(first.date, first.truckId)) ?? null);
    } catch (err) {
      out.failed('PAGE_NOT_OPENED', subjectKeyOf({ depotId: first.depotId, date: first.date, truckId: first.truckId }), err);
    }
  }

  // The depot-days read in full: every depot of the dates with a load or an open row.
  const rules = ALERT_RULES.filter((r) => out.on(r) !== null);
  const scopes: SweepScope[] = [];
  const dates = new Set(facts.dates);
  const seen = new Set<string>();
  const add = (depotId: string, date: string) => {
    const k = `${depotId}|${date}`;
    if (!dates.has(date) || seen.has(k)) return;
    seen.add(k);
    scopes.push({ depotId, deliveryDate: date, rulesOn: rules });
  };
  for (const l of facts.loads) add(l.depotId, l.date);
  for (const r of facts.open.values()) add(r.depotId, r.deliveryDate);
  return { active: out.active, ended: out.ended, scopes, held: out.held, failures: out.failures };
}
