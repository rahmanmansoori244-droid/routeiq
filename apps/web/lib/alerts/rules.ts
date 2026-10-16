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
 *
 * The rules with the adversarial review's fixes (critique of 16 Oct 2026):
 * - R1 UNLOAD_OVER: a stop being unloaded (arrived; no departure, no result, no later stop with
 *   activity) longer than its planned unloading + T, counted from the arrival or the window start when
 *   early. An arrival tapped far from the pin (UNLOAD_ARRIVAL_FAR_M with good accuracy) is not counted
 *   (M9). A stop that ended over the limit without a row becomes a history row (no toast, no e-mail); its
 *   unloading ends at the latest at the first tap of a later stop (a result recorded hours later is not
 *   the end). Not on a load the office completed (the 15 Oct 2026 replay).
 * - R2 LOADING_OVER: a LOADING load not marked Loaded, whose Loading press (statusChangedAt) is more than
 *   T ago and less than 12 h ago (H1: off by default; it means something only when the warehouse presses
 *   Loading as it starts each truck and Loaded when done).
 * - R3 ETA_LATE: the projected arrival at the next stop (projection.ts) more than T after its plan;
 *   closes 10 min under T (hysteresis). Not while DRIVER_SILENT is open for the load (held), nor after
 *   the planned return + 60 min (H3). Stops further on that may miss their window are named in its text
 *   (H5).
 * - R4 DEPART_LATE: today's Locked or Loading load (a Planned one only as a later trip of a truck whose
 *   earlier load is locked or further) not dispatched T after its planned departure; only the truck's
 *   first load not yet out, not while an earlier load of the truck is out and not back; no longer
 *   followed 4 h after the planned departure (M2). Found only after the Dispatch press: one history row.
 * - R5 DRIVER_SILENT: nothing from the driver's phone for T (a planned break inside the gap does not
 *   count), stops left, none being unloaded, and the next stop overdue by 30 min (M10). Tier 1 WARN.
 * - R6 AFTER_CLOSING: an observed arrival more than T after the stop's window end: an EVENT, HIGH. The
 *   next pending stop with a window projected more than T after it (the arrival under START, the end of
 *   unloading under FINISH): WARN, closes 10 min under T (H5).
 * - R7 PRIORITY_NOT_DELIVERED: the driver's Not delivered (HIGH) or Partly delivered (WARN) at a stop of
 *   priority T or better; a result the office recorded itself does not count (L8).
 * - R8 DELIVERED_WITH_NOTE: the driver's Delivered with a note (WARN, never a toast); a note that only
 *   confirms the delivery ("delivered", "received", "delivered at 11:25"; text.ts noteOnlyConfirms) is
 *   not news.
 * - R9 PROOF_FAR: a photo or result more than T from the customer's pin, only when the pin is verified and
 *   not on the "Pin may be wrong" list (M1); HIGH beyond 4T.
 * - R10 LOAD_NOT_CLOSED: a DISPATCHED load T after its planned return with no Back at depot or a stop
 *   without a result.
 * - R11 PAGE_NOT_OPENED: a dispatched truck-day whose driver page was not opened T after its first planned
 *   departure. R1, R3, R5, R6 (projected) and R10 follow the phone and are checked only on truck-days
 *   whose page was opened (H3): a truck without it raises this one WARN instead of a pile.
 */
import { actualMinutes, OUTCOME_LABEL, reasonLabel, sourceWord } from '../delivery/office-text';
import { arrivalIsObserved } from '../delivery/kpis';
import { fmtDayMonth, zonedDayStart } from '../dispatch/time';
import {
  ALERT_EVIDENCE_MAX_ACCURACY_M,
  ALERT_HYSTERESIS_MIN,
  ALERT_RULE_SPECS,
  ALERT_RULES,
  DEPART_LATE_EXPIRE_MIN,
  DEPART_LATE_HISTORY_MIN,
  LOADING_START_MAX_AGE_MIN,
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
import { projectLoad, type ProjectedStop, type Projection } from './projection';
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
  /** The warehouse's Loaded press (PlanLoad.loadedAt). */
  loadedAt: Date | null;
  /** The receiving-hours rule the load was planned with (a load planned before the echo: START). */
  windowRule: WindowRuleName;
  /** The planned driver break, minutes of the delivery day. */
  breakMin: { startMin: number; endMin: number } | null;
  /** The earliest Back at depot of the load. */
  backAt: Date | null;
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
  /** DISPATCHED loads only. */
  proj: Projection | null;
  /** DRIVER_SILENT is raised (or held open) for this load in this sweep. */
  silent: boolean;
  /** The stops of the load, in sequence, by index: a later stop has activity. */
  laterActivity: boolean[];
}

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;
const dateAt = (dayStart: Date, min: number) => new Date(dayStart.getTime() + min * 60_000);

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

/** The first arrival, departure or result at a stop after index `i` that came after `since` (null: none). */
function laterActivityAfter(stops: readonly FactStop[], i: number, since: Date): Date | null {
  let first: Date | null = null;
  for (const s of stops.slice(i + 1)) {
    for (const t of [s.visit?.arrivedAt, s.visit?.departedAt, s.visit?.outcomeAt]) {
      if (t && t > since && (!first || t < first)) first = t;
    }
  }
  return first;
}

// ---------------------------------------------------------------------------------------------
// R1 UNLOAD_OVER
// ---------------------------------------------------------------------------------------------

function unloadOver(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'UNLOAD_OVER';
  const T = out.on(rule);
  if (T === null) return;
  const tz = out.facts.tz;
  c.load.stops.forEach((s, i) => {
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
    // A load the office completed is not being unloaded any more (15 Oct 2026 replay: a stop of a load
    // completed at 12:18 stayed "unloading" for 12 h).
    if (noEnd && !later && c.load.status === 'COMPLETED') return out.end(rule, key, `${label}: no result or departure tapped; the load was completed.`);
    const live = noEnd && !later;
    const occurredAt = new Date(start.getTime() + (planned + T) * 60_000);
    if (live) {
      const elapsed = Math.max(0, minutesBetween(start, out.now));
      const over = elapsed - planned;
      const tier = tierAt(over, T);
      if (!tier) return out.end(rule, key, `${label}: unloading within the planned time + ${T} min.`);
      const since = `since arrival ${clockText(v.arrivedAt, c.load.date, tz)}${v.arrivalObserved ? '' : ' (arrival time not certain)'}${fromWindow ? `, counted from the window start ${planTime(winStart)}` : ''}`;
      return out.raise({
        ...stopBase(c, s),
        rule,
        kind: 'CONDITION',
        subjectKey: key,
        tier,
        value: over,
        threshold: T,
        text: `${label}: no result or departure tapped ${since} - ${fmtDuration(elapsed)} at the stop, planned ${fmtDuration(planned)} (${fmtDuration(over)} over).`,
        occurredAt,
        facts: { elapsedMin: Math.round(elapsed), plannedMin: planned, observed: v.arrivalObserved },
      });
    }
    if (later && !v.departedAt && !v.outcomeAt) {
      const next = c.load.stops.slice(i + 1).find((x) => x.visit?.arrivedAt || x.visit?.outcomeAt);
      const at = next?.visit?.arrivedAt ?? next?.visit?.outcomeAt ?? null;
      return out.end(rule, key, `${label}: no departure or result was tapped; the truck moved on to stop ${next?.sequence ?? '?'}${at ? ` at ${clockText(at, c.load.date, tz)}` : ''}.`);
    }
    const actual = actualMinutes(v);
    let took = actual.min;
    // The unloading ended at the latest when the truck showed up at a later stop: a result tapped hours
    // later (results recorded in a batch, a customer who sent the driver away and called him back) is not
    // the end of the unloading (15 Oct 2026 replay: "2 h 40 min" at a stop the truck had left after 52 min).
    const moved = !actual.auto && took !== null ? laterActivityAfter(c.load.stops, i, v.arrivedAt) : null;
    const capped = moved !== null && took !== null && minutesBetween(v.arrivedAt, moved) < took;
    if (capped) took = minutesBetween(v.arrivedAt, moved!);
    if (took === null) {
      const who = v.outcomeSource === 'DISPATCHER' ? 'the result was recorded by the office' : 'the unloading time is not known';
      return out.end(rule, key, `${label}: ${who}.`);
    }
    const over = took - planned;
    const until = capped ? ` (until the truck reached a later stop at ${clockText(moved!, c.load.date, tz)})` : '';
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
// R2 LOADING_OVER
// ---------------------------------------------------------------------------------------------

function loadingOver(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'LOADING_OVER';
  const T = out.on(rule);
  if (T === null) return;
  const l = c.load;
  const tz = out.facts.tz;
  const start = l.statusChangedAt;
  const when = (at: Date) => clockText(at, out.facts.today, tz);
  if (l.status === 'LOADING' && start && !l.loadedAt) {
    const elapsed = minutesBetween(start, out.now);
    if (elapsed > LOADING_START_MAX_AGE_MIN) return out.end(rule, c.key, `${c.label}: no Loaded press ${fmtDuration(LOADING_START_MAX_AGE_MIN)} after Loading at ${when(start)}: no longer followed.`);
    const tier = tierAt(elapsed, T);
    if (!tier) return out.end(rule, c.key, `${c.label}: loading within ${T} min.`);
    const dep = l.date === out.facts.today ? planTime(l.departMin) : `${fmtDayMonth(l.date)} ${planTime(l.departMin)}`;
    return out.raise({
      ...base(c),
      rule,
      kind: 'CONDITION',
      subjectKey: c.key,
      tier,
      value: elapsed,
      threshold: T,
      text: `${c.label}: loading for ${fmtDuration(elapsed)} (since ${when(start)}), limit ${T} min. Planned departure ${dep}.`,
      occurredAt: new Date(start.getTime() + T * 60_000),
      facts: { loadingSince: start.toISOString() },
    });
  }
  if (l.status === 'LOADING' && start && l.loadedAt) {
    return out.end(rule, c.key, `${c.label}: loaded in ${fmtDuration(minutesBetween(start, l.loadedAt))} (${when(start)}-${when(l.loadedAt)}).`);
  }
  if (ON_ROAD.has(l.status)) {
    return out.end(rule, c.key, l.status === 'DISPATCHED' && start ? `${c.label}: loading ended with Dispatch at ${when(start)}.` : `${c.label}: ${STATUS_WORD[l.status] ?? l.status}.`);
  }
  return out.end(rule, c.key, `${c.label}: loading stopped, the load is ${STATUS_WORD[l.status] ?? l.status}.`);
}

// ---------------------------------------------------------------------------------------------
// R3 ETA_LATE (with the window-risk note of the stops further on)
// ---------------------------------------------------------------------------------------------

/** The time a stop is judged against its window end under the load's rule: the arrival (START) or the end of unloading (FINISH). */
function windowJudgedMin(c: LoadCtx, p: { arrMin: number | null; depMin: number | null }): number | null {
  return c.load.windowRule === 'FINISH' ? p.depMin : p.arrMin;
}

/** The first pending stop with a delivery window (the one AFTER_CLOSING projects: H5). */
function nextWithWindowOf(c: LoadCtx): ProjectedStop | null {
  return c.proj?.stops.find((p) => p.state === 'PENDING' && has(windowEndOf(c.load.stops.find((s) => s.sequence === p.sequence)!))) ?? null;
}

function etaLate(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'ETA_LATE';
  const T = out.on(rule);
  if (T === null) return;
  const l = c.load;
  const tz = out.facts.tz;
  if (l.status !== 'DISPATCHED') return out.end(rule, c.key, `${c.label}: ${STATUS_WORD[l.status] ?? l.status}.`);
  if (l.backAt) return out.end(rule, c.key, `${c.label}: back at the depot at ${clockText(l.backAt, l.date, tz)}.`);
  if (!c.pageOpened) return out.end(rule, c.key, `${c.label}: the driver page was not opened, so the delay cannot be worked out.`);
  const proj = c.proj!;
  const next = proj.next;
  if (!next) return out.end(rule, c.key, `${c.label}: no stop left to reach.`);
  if (c.nowMin > l.returnMin + RETURN_GRACE_MIN) return out.end(rule, c.key, `${c.label}: past the planned return (${planTime(l.returnMin)}): see "Load not closed".`);
  if (c.silent) {
    if (out.isOpen(rule, c.key)) out.hold(rule, c.key);
    else out.end(rule, c.key, `${c.label}: the driver is silent, so the delay cannot be worked out.`);
    return;
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
  const occurredAt = next.clockBound && has(stop.etaMin) ? dateAt(c.dayStart, stop.etaMin + T) : out.now;
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

function departLate(out: Out, c: LoadCtx, truckDayLoads: readonly FactLoad[]): void {
  const rule: AlertRule = 'DEPART_LATE';
  const T = out.on(rule);
  if (T === null) return;
  const l = c.load;
  const tz = out.facts.tz;
  if (ON_ROAD.has(l.status)) {
    if (l.status !== 'DISPATCHED' || !l.statusChangedAt) return out.end(rule, c.key, `${c.label}: ${STATUS_WORD[l.status] ?? l.status}.`);
    const dispatchMin = minutesOnDate(l.statusChangedAt, l.date, tz);
    const lateBy = dispatchMin - l.departMin;
    const final = `${c.label} dispatched ${clockText(l.statusChangedAt, l.date, tz)}${lateBy > 0 ? `, ${fmtDuration(lateBy)} after the planned ${planTime(l.departMin)}` : ` (planned ${planTime(l.departMin)})`}.`;
    const tier = tierAt(lateBy, T);
    const recent = minutesBetween(l.statusChangedAt, out.now) <= DEPART_LATE_HISTORY_MIN;
    // Found only after the Dispatch press (pressed between two sweeps, or the sweep was not running): history.
    if (!out.isOpen(rule, c.key) && tier && recent && l.date === out.facts.today) {
      return out.raise({ ...base(c), rule, kind: 'CONDITION', subjectKey: c.key, tier, value: lateBy, threshold: T, text: final, occurredAt: l.statusChangedAt, history: true, facts: { dispatchMin } });
    }
    return out.end(rule, c.key, final);
  }
  if (l.date !== out.facts.today) return out.end(rule, c.key, `${c.label}: still ${STATUS_WORD[l.status] ?? l.status}, the day is over.`);
  if (!l.stopCount) return out.end(rule, c.key, `${c.label}: no stops.`);
  const earlier = truckDayLoads.filter((x) => x.loadNo < l.loadNo).sort((a, b) => a.loadNo - b.loadNo);
  if (l.status === 'PLANNED' && !earlier.some((x) => x.status !== 'PLANNED')) return out.end(rule, c.key, `${c.label}: Planned (not locked).`);
  const notOut = earlier.find((x) => !ON_ROAD.has(x.status));
  if (notOut) return out.end(rule, c.key, `${c.label}: Load ${notOut.loadNo} of this truck is not dispatched yet.`);
  const stillOut = earlier.find((x) => x.status === 'DISPATCHED' && !x.backAt);
  if (stillOut) return out.end(rule, c.key, `${c.label}: Load ${stillOut.loadNo} of this truck is still out.`);
  const late = c.nowMin - l.departMin;
  if (late > DEPART_LATE_EXPIRE_MIN) return out.end(rule, c.key, `${c.label}: still not dispatched ${fmtDuration(DEPART_LATE_EXPIRE_MIN)} after the planned departure ${planTime(l.departMin)}: no longer followed.`);
  const tier = tierAt(late, T);
  if (!tier) return out.end(rule, c.key, `${c.label}: not late.`);
  const seen = c.td?.linkSeenAt ? ` Driver page last open ${clockText(c.td.linkSeenAt, l.date, tz)}.` : '';
  return out.raise({
    ...base(c),
    rule,
    kind: 'CONDITION',
    subjectKey: c.key,
    tier,
    value: late,
    threshold: T,
    text: `${c.label} not dispatched: planned departure ${planTime(l.departMin)}, now ${clockText(out.now, l.date, tz)} (${fmtDuration(late)} late), load is ${STATUS_WORD[l.status] ?? l.status}.${seen} Dispatch it if it has left.`,
    occurredAt: dateAt(c.dayStart, l.departMin + T),
    facts: { departMin: l.departMin, status: l.status },
  });
}

// ---------------------------------------------------------------------------------------------
// R5 DRIVER_SILENT
// ---------------------------------------------------------------------------------------------

/** What the last signal was: "left stop 2 Shop Example D", "Back at depot". */
function signalText(sig: FactSignal, loads: readonly FactLoad[]): string {
  if (sig.kind === 'BACK_AT_DEPOT') return `Back at depot (L${sig.loadNo})`;
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
  if (l.backAt) return out.end(rule, c.key, `${c.label}: back at the depot at ${clockText(l.backAt, l.date, tz)}.`);
  if (!c.pageOpened) return out.end(rule, c.key, `${c.label}: the driver page was not opened.`);
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
          tier: 2,
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
    if (l.status !== 'DISPATCHED' || !p || p.state !== 'PENDING' || l.backAt) {
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
    if (c.nowMin > l.returnMin + RETURN_GRACE_MIN) {
      out.end(rule, key, `${label}: past the planned return (${planTime(l.returnMin)}).`);
      continue;
    }
    if (c.silent) {
      if (out.isOpen(rule, key)) out.hold(rule, key);
      else out.end(rule, key, `${label}: the driver is silent.`);
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
      occurredAt: out.now,
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

function proofFar(out: Out, c: LoadCtx): void {
  const rule: AlertRule = 'PROOF_FAR';
  const T = out.on(rule);
  if (T === null) return;
  const tz = out.facts.tz;
  for (const s of c.load.stops) {
    const key = stopKey(c, s);
    const label = `${c.label} ${stopLabel(s)}`;
    const v = s.visit;
    if (!s.pinVerified) {
      out.end(rule, key, `${label}: the customer's pin is not verified, so it is not checked.`);
      continue;
    }
    type Far = { m: number; at: Date; what: string };
    const far: Far[] = [];
    for (const ph of v?.photos ?? []) {
      if (ph.positionStatus === 'OK' && has(ph.distanceM) && ph.distanceM > T) {
        far.push({ m: ph.distanceM, at: ph.receivedAt, what: `delivery photo taken ${fmtDistance(ph.distanceM)} from the customer's pin (phone location${has(ph.accuracyM) ? `, accuracy ${Math.round(ph.accuracyM)} m` : ''}, ${clockText(ph.receivedAt, c.load.date, tz)})` });
      }
      if (has(ph.exifDistanceM) && ph.exifDistanceM > T) {
        far.push({ m: ph.exifDistanceM, at: ph.receivedAt, what: `delivery photo taken ${fmtDistance(ph.exifDistanceM)} from the customer's pin (the photo's own location, ${clockText(ph.receivedAt, c.load.date, tz)})` });
      }
    }
    if (v && (v.outcome === 'DELIVERED' || v.outcome === 'PARTLY_DELIVERED') && v.outcomeAt && has(v.outcomeDistanceM) && v.outcomeDistanceM > T && has(v.outcomeAccuracyM) && v.outcomeAccuracyM <= ALERT_EVIDENCE_MAX_ACCURACY_M) {
      far.push({ m: v.outcomeDistanceM, at: v.outcomeAt, what: `result recorded ${fmtDistance(v.outcomeDistanceM)} from the customer's pin (accuracy ${Math.round(v.outcomeAccuracyM)} m, ${clockText(v.outcomeAt, c.load.date, tz)})` });
    }
    if (!far.length) {
      out.end(rule, key, `${label}: no photo or result far from the pin.`);
      continue;
    }
    const worst = far.reduce((a, b) => (b.m > a.m ? b : a));
    out.raise({
      ...stopBase(c, s),
      rule,
      kind: 'EVENT',
      subjectKey: key,
      tier: worst.m > PROOF_FAR_HIGH_FACTOR * T ? 2 : 1,
      value: worst.m,
      threshold: T,
      text: `${label}: ${worst.what}. The pin or the place of the photo is wrong.`,
      occurredAt: worst.at,
      facts: { metres: Math.round(worst.m), items: far.length },
    });
  }
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
  if (l.backAt && missing === 0) return out.end(rule, c.key, `${c.label}: back at the depot with every result recorded: closing.`);
  const overdue = c.nowMin - l.returnMin;
  const tier = tierAt(overdue, T, ALERT_RULE_SPECS[rule].maxTier);
  if (!tier) return out.end(rule, c.key, `${c.label}: not overdue.`);
  const back = l.backAt ? `back at the depot ${clockText(l.backAt, l.date, tz)}` : 'no Back at depot';
  const results = missing ? `, ${missing} of ${stopsText(l.stops.length)} without a result` : '';
  return out.raise({
    ...base(c),
    rule,
    kind: 'CONDITION',
    subjectKey: c.key,
    tier,
    value: overdue,
    threshold: T,
    text: `${c.label} still not closed at ${clockText(out.now, l.date, tz)}: planned back ${planTime(l.returnMin)}, ${back}${results}. Record the results, then Completed.`,
    occurredAt: dateAt(c.dayStart, l.returnMin + T),
    facts: { returnMin: l.returnMin, missing, back: !!l.backAt },
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
    const dayStart = zonedDayStart(l.date, tz);
    const nowMin = minutesOnDate(now, l.date, tz);
    const stopsIn = l.stops.map((s) => {
      const v = s.visit;
      const endAt = v?.departedAt ?? (v?.outcomeAt && v.outcomeSource !== 'DISPATCHER' ? v.outcomeAt : null);
      return {
        sequence: s.sequence,
        etaMin: s.etaMin,
        serviceStartMin: s.serviceStartMin,
        departureMin: s.departureMin,
        plannedServiceMin: plannedServiceOf(s),
        windowStartMin: windowStartOf(s),
        arrivedMin: v?.arrivedAt ? minutesOnDate(v.arrivedAt, l.date, tz) : null,
        endMin: endAt ? minutesOnDate(endAt, l.date, tz) : null,
        hasOutcome: !!v?.outcome,
      };
    });
    const activity = stopsIn.map((s) => s.arrivedMin !== null || s.endMin !== null || s.hasOutcome);
    const laterActivity = activity.map((_, i) => activity.slice(i + 1).some(Boolean));
    const c: LoadCtx = {
      load: l,
      label: loadLabel(l.truckCode, l.loadNo),
      key: subjectKeyOf({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo }),
      dayStart,
      nowMin,
      td,
      pageOpened: !!td?.pageOpened,
      proj:
        l.status === 'DISPATCHED'
          ? projectLoad({
              departMin: l.departMin,
              returnMin: l.returnMin,
              dispatchMin: l.statusChangedAt ? minutesOnDate(l.statusChangedAt, l.date, tz) : null,
              nowMin,
              lateDispatchMin: lateDispatch,
              stops: stopsIn,
            })
          : null,
      silent: false,
      laterActivity,
    };
    const truckDayLoads = dayLoads.get(truckDayOf(l.date, l.truckId)) ?? [l];
    loadingOver(out, c);
    departLate(out, c, truckDayLoads);
    // DRIVER_SILENT first: ETA_LATE and the projected AFTER_CLOSING are held while it is raised.
    driverSilent(out, c, truckDayLoads);
    etaLate(out, c);
    loadNotClosed(out, c);
    if (ON_ROAD.has(l.status)) {
      unloadOver(out, c);
      afterClosing(out, c);
      priorityNotDelivered(out, c);
      deliveredWithNote(out, c);
      proofFar(out, c);
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
  for (const loads of perDepotDay.values()) pageNotOpened(out, loads, tdOf.get(truckDayOf(loads[0]!.date, loads[0]!.truckId)) ?? null);

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
  return { active: out.active, ended: out.ended, scopes, held: out.held };
}
