/**
 * One physical stop of a load that left the depot, rebuilt from its events (owner request 4 Oct 2026,
 * spec section 8.4). Pure: event-service.ts stores the events, then calls deriveVisit and writes the
 * result onto the StopVisit row. The GPS trackers (Ayun, IVMS live link of 16 Oct 2026,
 * lib/ivms/stop-events.ts) write ARRIVED and DEPARTED events of source AYUN into the same table: they
 * only fill the gaps the driver and the office left (see "GPS (AYUN) events" below).
 *
 * - Result = the OUTCOME event with the latest `at` (ties: the latest received, then the dispatcher
 *   over the phone); an OUTCOME with outcome null clears it.
 * - Cycles = a run of phone (or Ayun) ARRIVED events closed by the first DEPARTED; the chosen cycle
 *   holds the result. The dispatcher's Arrived / Left (Record outcome) are not cycle members: the
 *   newest entry of each (latest received) replaces the phone's, so a correction always shows.
 * - Departure: the office's Left, else the cycle's, else (a phone result) the result time; a result
 *   the office entered later never ends the stop.
 * - Automatic timing only from OBSERVED automatic events: an arrival found when the page came back
 *   (observed false) or a departure after a gap never feeds measured times or the on-time KPI.
 *
 * GPS (AYUN) events (IVMS live link, design section 6.4 with the reviews' M1/M3 and the second review's
 * H-2): the visit is first rebuilt from the driver's and the office's events ONLY, exactly as with the
 * link off (tests/lib/ivms-visit-golden.spec.ts); the GPS events then only fill what is still empty.
 * - Arrival: the office's, else the phone's (any: a tap, a "when?" answer, an automatic arrival, even
 *   one found when the page came back); only a stop with none of these gets the GPS arrival (of the GPS
 *   stay holding the result: an observed arrival of it first, then the earliest).
 * - Departure: the office's Left, else the phone's; when nothing else ends the stop, or only the result
 *   time stands in for it (and the phone's automatic timing does not end there: "Auto to result" is
 *   never replaced), the GPS departure of the GPS stay that HOLDS the result (owner request 19 Oct 2026,
 *   GPS study of 18-19 Oct: begun at or before the result and not left before it; else the last stay
 *   begun before the result), of all the stays not left before the shown arrival - at a big customer the
 *   truck comes back to the pin, and the visit used to show the first stay's departure, up to 351 min too
 *   early. Without a result, the stay of the shown arrival (one that began at most 15 min after it), or
 *   none while the truck has come back to the pin and is there now (its last stay not left yet). A stay
 *   begun more than 15 min after the shown arrival is taken only when its events carry the detector's stay
 *   summary (ivms-v2; review of 19 Oct 2026): GPS events stored by the detector before (ivms-v1, 16-19 Oct)
 *   have no minutes away, so for them the stay of the shown arrival stays the rule, as before - a rebuild or
 *   the alerts replay of such a day never counts a leave-and-return as unloading. The
 *   15-minute rule after the result applies to a GPS departure too. A GPS arrival with a phone result and
 *   no departure ends at the result time, as any arrival.
 * - Time away (owner request 19 Oct 2026, the leave-and-return guard): a GPS stay that began after the
 *   truck had gone beyond 500 m of the pin, or stopped at another customer, since the stop's previous
 *   stay carries the minutes away in its payload (lib/ivms/stops.ts StaySummary.awayMin). The minutes of
 *   such absences between the shown arrival and the shown departure (or now, while the stop is in
 *   progress) are the visit's awayMinutes (null: none), which every unloading time and the UNLOAD_OVER
 *   alert take off: on site = departure - arrival - awayMinutes (lib/delivery/office-text.ts onSite).
 *   A stay that never came back has no time away to take off.
 * - Automatic timing (autoArrivedAt, autoBasis, autoMinutes, autoServiceMinutes) is the phone's only, as
 *   with the link off: GPS never feeds the measured unloading times used for planning or the "auto"
 *   label (review M3), and never removes the phone's (second review H-2). A GPS-timed stop shows its
 *   arrival to departure as a non-automatic timing.
 * - GPS never writes a result, so the result and the driver facts never come from it; the
 *   plausibility flags stay phone-only (a GPS position is never pin evidence).
 * - The operations alerts read the visit without its GPS times (withoutGpsTimes), until ivmsMode ALERTS.
 *
 * GPS times win over late phone times (owner decision 21 Oct 2026, "GPS arrival should win of course"; the
 * GPS timing study of 19-20 Oct 2026: Ayun's own detection was right, the times shown were wrong on about
 * 15% of the visits because of the rules above). The office's times still always win; the driver's taps stay
 * recorded (StopEvent, and the replaced times in the visit's own* fields, withOwnTimes):
 * - F1 GPS arrival wins: a phone arrival (a tap, a "when?" answer, an automatic one) made more than
 *   GPS_ARRIVAL_WINS_MIN after an observed GPS stay at the stop began, while the truck was still standing
 *   there (at most GPS_TAP_LOOKBACK_MIN after it began), shows the GPS arrival.
 * - F2 the GPS departure after the result: the GPS stay that holds the driver's own result gives its observed
 *   departure (not one after a gap) up to GPS_MAX_AFTER_RESULT_MIN after the result (else the 15-minute rule,
 *   as before), unless the driver worked at another stop of the truck-day in between
 *   (VisitContext.otherStopTimes). The minutes more than AFTER_RESULT_UNLOADING_MIN after the result are
 *   "after the result" (afterResultMinutes), never unloading: every unloading time still ends at the result.
 * - F4 a GPS departure replaces the phone's automatic departure (PHONE_AUTO) when it is observed and more than
 *   GPS_DEPARTURE_WINS_MIN away from it (without a result, only when the truck did not come back to the pin
 *   before the phone's departure); the automatic timing stays the phone's (M3, H-2).
 * - F5 late taps (lateTapVisit): the arrival and a result tapped within LATE_TAP_TOGETHER_MIN of each other,
 *   at least LATE_TAP_GAP_MIN after the last GPS stay at the stop ended and with none in progress: the taps
 *   were made after leaving, the visit shows that stay's arrival and departure.
 */
import { distanceM } from '../dispatch/snapshots';

export type EventKind = 'ARRIVED' | 'DEPARTED' | 'OUTCOME' | 'PHOTO' | 'BACK_AT_DEPOT' | 'CARRY_CONFLICT' | 'DEPOT_DEPART';
export type EventSource = 'PHONE_AUTO' | 'PHONE_MANUAL' | 'DISPATCHER' | 'AYUN' | 'SYSTEM';
export type OutcomeName = 'DELIVERED' | 'PARTLY_DELIVERED' | 'NOT_DELIVERED';

/** One planned line of a visit, with what was delivered (null = no result). The only shape of StopVisit.linesJson. */
export interface VisitLine {
  orderId: string;
  lineId: string;
  productCode: string;
  plannedCases: number;
  deliveredCases: number | null;
}

/** StopVisit.linesJson, read defensively: malformed entries are dropped, never a throw. */
export function readVisitLines(json: unknown): VisitLine[] {
  if (!Array.isArray(json)) return [];
  const out: VisitLine[] = [];
  for (const x of json) {
    if (!x || typeof x !== 'object') continue;
    const l = x as Record<string, unknown>;
    if (typeof l.orderId !== 'string' || typeof l.lineId !== 'string' || typeof l.plannedCases !== 'number' || !Number.isFinite(l.plannedCases)) continue;
    const d = l.deliveredCases;
    out.push({
      orderId: l.orderId,
      lineId: l.lineId,
      productCode: typeof l.productCode === 'string' ? l.productCode : '',
      plannedCases: l.plannedCases,
      deliveredCases: typeof d === 'number' && Number.isFinite(d) ? d : null,
    });
  }
  return out;
}

export interface VisitEvent {
  id?: string;
  kind: EventKind;
  source: EventSource;
  at: Date;
  receivedAt: Date;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  distanceM?: number | null;
  userId?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface VisitContext {
  /** zonedDayStart(deliveryDate, tz): local minutes of the plan are counted from here. */
  dayStart: Date;
  /** The promised start, else the hard receiving start (local minutes); null = any time. */
  windowStartMin: number | null;
  /** The load's planned driver break (PlanLoad.breakJson), local minutes; null = none. */
  breakMin: { startMin: number; endMin: number } | null;
  /** The planned lines (deliveredCases ignored). */
  lines: VisitLine[];
  /** The planned pin; null = none. */
  pin: { lat: number; lng: number } | null;
  radiusM: number;
  /** A departure later than the result + this is capped at the result (default 15). */
  maxAfterOutcomeMin?: number;
  /**
   * The times of the phone's ARRIVED and OUTCOME events (PHONE_MANUAL / PHONE_AUTO) at the truck-day's OTHER
   * visits (F2's neighbour guard, owner decision 21 Oct 2026): when one falls between this visit's result and
   * its GPS departure, the driver was already working elsewhere, so the GPS departure is not this visit's end
   * and the 15-minute rule applies. Absent: none known (the rebuild reads them only for a visit with GPS events).
   */
  otherStopTimes?: readonly Date[];
}

export interface VisitState {
  state: 'PENDING' | 'ARRIVED' | 'DONE';
  arrivedAt: Date | null;
  arrivalSource: EventSource | null;
  arrivalDistanceM: number | null;
  arrivalAccuracyM: number | null;
  arrivalObserved: boolean;
  departedAt: Date | null;
  departureSource: EventSource | null;
  departedAtOutcome: boolean;
  /** The departure was found after a gap (the page was away): not observed. */
  departureGap: boolean;
  autoArrivedAt: Date | null;
  autoDepartedAt: Date | null;
  autoBasis: 'DEPARTURE' | 'RESULT' | null;
  autoMinutes: number | null;
  autoServiceMinutes: number | null;
  timingSuspect: boolean;
  suspect: string[];
  outcome: OutcomeName | null;
  reason: string | null;
  reasonNote: string | null;
  outcomeAt: Date | null;
  outcomeSource: EventSource | null;
  outcomeById: string | null;
  outcomeLat: number | null;
  outcomeLng: number | null;
  outcomeAccuracyM: number | null;
  outcomeDistanceM: number | null;
  outcomeLate: boolean;
  noPhotoReason: string | null;
  photoKeys: string[];
  lines: VisitLine[];
  casesDelivered: number | null;
  /**
   * The driver's own last Delivered or Partly result (driverFacts): an office result (Record) never
   * changes it, so a result saved without a photo stays monitored after a correction.
   */
  driverResultAt: Date | null;
  driverResultOutcome: 'DELIVERED' | 'PARTLY_DELIVERED' | null;
  /** 'CAMERA_FAILED': that result was saved with "Camera not working". */
  driverNoPhotoReason: string | null;
  /** Photo keys named by the driver's Delivered and Partly results (proofPhotoKeys counts the same). */
  driverPhotoKeys: number;
  /**
   * Minutes the truck was away from the customer between the shown arrival and departure (owner request
   * 19 Oct 2026: a leave-and-return the GPS stays show; never unloading). Only a visit with GPS (AYUN)
   * events has the field (absent otherwise: the rebuild without GPS is unchanged); null: none.
   */
  awayMinutes?: number | null;
  /**
   * The driver's and the office's own times that a GPS time REPLACED (owner decision 21 Oct 2026, F1/F4/F5
   * and the result standing in for a departure: withOwnTimes), so the visit "without GPS" stays exact
   * (withoutGpsTimes) and the driver page, the photo check, the office's "Left" check and the KPI read the
   * driver's own arrival (ownArrivalOf). Set only when the shown arrival (departure) is AYUN and an own one
   * existed; null otherwise on a visit with GPS events; undefined on a visit without any (deriveOwnVisit:
   * the JSON of the golden rebuild is unchanged). The source is never AYUN.
   */
  ownArrivedAt: Date | null | undefined;
  ownArrivalSource: EventSource | null | undefined;
  ownArrivalDistanceM: number | null | undefined;
  ownArrivalAccuracyM: number | null | undefined;
  ownArrivalObserved: boolean | null | undefined;
  ownDepartedAt: Date | null | undefined;
  ownDepartureSource: EventSource | null | undefined;
  ownDepartedAtOutcome: boolean | null | undefined;
  /**
   * F2 (owner decision 21 Oct 2026): the minutes the truck still stood at the stop after the driver's result,
   * when the GPS departure shown is more than AFTER_RESULT_UNLOADING_MIN after it (the time away in that span
   * taken off). Never unloading: unloading = departure - arrival - awayMinutes - afterResultMinutes, which ends
   * at the result. Null: none; undefined on a visit without GPS events.
   */
  afterResultMinutes: number | null | undefined;
}

const AUTO: ReadonlySet<EventSource> = new Set(['PHONE_AUTO', 'AYUN']);
const PHONE: ReadonlySet<EventSource> = new Set(['PHONE_AUTO', 'PHONE_MANUAL']);
/** A GPS departure counts only for a GPS stay that began at most this long after the chosen arrival. */
export const GPS_DEPARTURE_MATCH_MIN = 15;
/** F1 (owner decision 21 Oct 2026): a phone arrival more than this after the observed GPS arrival of the stay it was made in shows the GPS one. */
export const GPS_ARRIVAL_WINS_MIN = 2;
/** F1 and F5: a GPS stay that began (F1) or ended (F5) more than this before the driver's tap is never used for it. */
export const GPS_TAP_LOOKBACK_MIN = 240;
/** F2: the GPS departure of the stay holding the driver's result is shown up to this long after the result. */
export const GPS_MAX_AFTER_RESULT_MIN = 60;
/** F2: the minutes of a GPS departure after the result beyond this are "after the result", never unloading (today's 15-minute rule). */
export const AFTER_RESULT_UNLOADING_MIN = 15;
/** F4: a GPS departure replaces the phone's automatic departure only when the two differ by more than this. */
export const GPS_DEPARTURE_WINS_MIN = 2;
/** F5: the arrival and the result tapped within this of each other ... */
export const LATE_TAP_TOGETHER_MIN = 3;
/** ... at least this long after a GPS stay at the stop ended ... */
export const LATE_TAP_GAP_MIN = 10;
/** ... a stay the truck stood still at for at least this long (the detector's stay summary; ivms-v1 events have none and pass). */
export const LATE_TAP_MIN_STAND_MIN = 3;

const t = (d: Date) => d.getTime();
const isObserved = (e: VisitEvent) => e.payload?.observed !== false;
/** A GPS event written with the detector's stay summary (payload.stay, ivms-v2: owner request 19 Oct 2026); ivms-v1 events have none. */
const hasStaySummary = (e: VisitEvent) => {
  const s = e.payload?.stay;
  return !!s && typeof s === 'object' && !Array.isArray(s);
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The result event: the latest `at`, then the latest received, then the dispatcher over the phone. */
export function resultEvent(events: readonly VisitEvent[]): VisitEvent | null {
  const outcomes = events.filter((e) => e.kind === 'OUTCOME');
  if (!outcomes.length) return null;
  return [...outcomes].sort((a, b) => t(b.at) - t(a.at) || t(b.receivedAt) - t(a.receivedAt) || (b.source === 'DISPATCHER' ? 1 : 0) - (a.source === 'DISPATCHER' ? 1 : 0))[0]!;
}

/**
 * The driver's own last word at a stop (owner decision 2 of 5 Oct 2026, "Camera not working" is
 * monitored): of the OUTCOME events NOT written by the office, the latest Delivered or Partly (the
 * latest `at`, then the latest received), and the photo keys all of them named. Only the driver can
 * change these: an office Record is ignored here, and a later Not delivered or Undo by the driver does
 * not remove a Delivered he saved without a photo either; a new Delivered or Partly with a photo does.
 * The migration 20261005100000 fills the same facts for visits stored before it (keep the two equal).
 */
export function driverFacts(events: readonly VisitEvent[]): Pick<VisitState, 'driverResultAt' | 'driverResultOutcome' | 'driverNoPhotoReason' | 'driverPhotoKeys'> {
  const delivered = events.filter((e) => e.kind === 'OUTCOME' && e.source !== 'DISPATCHER' && (e.payload?.outcome === 'DELIVERED' || e.payload?.outcome === 'PARTLY_DELIVERED'));
  const keys = new Set<string>();
  for (const e of delivered) {
    const named = e.payload?.photoKeys;
    if (Array.isArray(named)) for (const k of named) if (typeof k === 'string') keys.add(k);
  }
  const last = [...delivered].sort((a, b) => t(b.at) - t(a.at) || t(b.receivedAt) - t(a.receivedAt))[0];
  return {
    driverResultAt: last ? last.at : null,
    driverResultOutcome: last ? (last.payload!.outcome as 'DELIVERED' | 'PARTLY_DELIVERED') : null,
    driverNoPhotoReason: last ? str(last.payload?.noPhotoReason) : null,
    driverPhotoKeys: keys.size,
  };
}

/**
 * The delivered cases per line of a result: Delivered = every line full, Not delivered = 0, Partly =
 * the lines of its payload (a line missing from it: full, as normalizeResult defaults it).
 */
function deliveredOf(outcome: OutcomeName, payload: Record<string, unknown> | null | undefined, lines: VisitLine[]): Map<string, number> {
  const out = new Map<string, number>();
  if (outcome === 'PARTLY_DELIVERED') {
    const sent = Array.isArray(payload?.lines) ? (payload!.lines as unknown[]) : [];
    for (const x of sent) {
      const l = x as { lineId?: unknown; delivered?: unknown };
      if (typeof l?.lineId === 'string' && typeof l.delivered === 'number' && Number.isFinite(l.delivered)) out.set(l.lineId, l.delivered);
    }
  }
  for (const l of lines) if (!out.has(l.lineId)) out.set(l.lineId, outcome === 'NOT_DELIVERED' ? 0 : l.plannedCases);
  return out;
}

interface Cycle {
  arrivals: VisitEvent[];
  departure: VisitEvent | null;
  start: number;
}

/** ARRIVED and DEPARTED by time: a run of arrivals closed by the first departure; a departure with no open cycle is ignored. */
export function cyclesOf(events: readonly VisitEvent[]): Cycle[] {
  const timing = events
    .filter((e) => e.kind === 'ARRIVED' || e.kind === 'DEPARTED')
    .sort((a, b) => t(a.at) - t(b.at) || (a.kind === b.kind ? 0 : a.kind === 'ARRIVED' ? -1 : 1) || t(a.receivedAt) - t(b.receivedAt));
  const cycles: Cycle[] = [];
  let open: Cycle | null = null;
  for (const e of timing) {
    if (e.kind === 'ARRIVED') {
      if (!open) {
        open = { arrivals: [], departure: null, start: t(e.at) };
        cycles.push(open);
      }
      open.arrivals.push(e);
    } else if (open) {
      open.departure = e;
      open = null;
    }
  }
  return cycles;
}

function chooseCycle(cycles: Cycle[], outcomeAt: number | null): Cycle | null {
  if (!cycles.length) return null;
  if (outcomeAt === null) return cycles[cycles.length - 1]!;
  const holding = cycles.filter((c) => c.start <= outcomeAt && (!c.departure || t(c.departure.at) >= outcomeAt));
  if (holding.length) return holding[holding.length - 1]!;
  const before = cycles.filter((c) => c.start <= outcomeAt);
  return before.length ? before[before.length - 1]! : null;
}

/** The arrival of a phone cycle: a "when?" answer, else the earliest. */
function arrivalOf(c: Cycle): VisitEvent {
  const answered = c.arrivals.filter((e) => e.source === 'PHONE_MANUAL' && e.payload?.when === true);
  if (answered.length) return answered[answered.length - 1]!;
  return c.arrivals[0]!;
}

/** The arrival of a GPS cycle: an observed one first, then the earliest. */
function gpsArrivalOf(c: Cycle): VisitEvent {
  return [...c.arrivals].sort((a, b) => (isObserved(a) === isObserved(b) ? 0 : isObserved(a) ? -1 : 1) || t(a.at) - t(b.at))[0]!;
}

/** The newest entry (latest received, then latest time) of the dispatcher's events of a kind: a correction replaces the one before. */
function newestOffice(events: readonly VisitEvent[], kind: 'ARRIVED' | 'DEPARTED'): VisitEvent | null {
  const office = events.filter((e) => e.kind === kind && e.source === 'DISPATCHER');
  if (!office.length) return null;
  return [...office].sort((a, b) => t(b.receivedAt) - t(a.receivedAt) || t(b.at) - t(a.at))[0]!;
}

/**
 * Plausibility flags of phone-reported positions (spec section 8.3). Any flag sets timingSuspect: the
 * visit is left out of measured times, the on-time KPI and the pin check ("unverified timing").
 */
export function plausibility(events: readonly VisitEvent[], pin: { lat: number; lng: number } | null, radiusM: number): string[] {
  const flags = new Set<string>();
  const phone = events.filter((e) => PHONE.has(e.source) && num(e.lat) !== null && num(e.lng) !== null);
  const r6 = (v: number) => v.toFixed(6);
  if (pin && phone.some((e) => r6(e.lat!) === r6(pin.lat) && r6(e.lng!) === r6(pin.lng))) flags.add('POSITION_IS_PIN');
  if (phone.some((e) => num(e.accuracyM) !== null && e.accuracyM! <= 1)) flags.add('ACCURACY_TOO_GOOD');
  const auto = phone.filter((e) => e.source === 'PHONE_AUTO');
  const counts = new Map<number, number>();
  for (const e of auto) {
    const a = num(e.accuracyM);
    if (a !== null && !Number.isInteger(a)) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  if ([...counts.values()].some((n) => n >= 3)) flags.add('SAME_ACCURACY');
  const arr = auto.filter((e) => e.kind === 'ARRIVED');
  const dep = auto.filter((e) => e.kind === 'DEPARTED');
  if (arr.some((a) => dep.some((d) => r6(a.lat!) === r6(d.lat!) && r6(a.lng!) === r6(d.lng!)))) flags.add('SAME_ARRIVE_DEPART_POSITION');
  const proof = phone.filter((e) => e.kind === 'PHOTO' || e.kind === 'OUTCOME');
  if (arr.some((a) => proof.some((p) => distanceM({ lat: a.lat!, lng: a.lng! }, { lat: p.lat!, lng: p.lng! }) > 2 * radiusM))) flags.add('ARRIVAL_FAR_FROM_PROOF');
  return [...flags].sort();
}

const minutesBetween = (a: number, b: number) => (b - a) / 60_000;

/**
 * The visit rebuilt from all its events (spec section 8.4). Pure. The driver's and the office's events
 * make the visit exactly as with the IVMS link off (deriveOwnVisit: the golden rebuild); with GPS (AYUN)
 * events, the late-tap rule (lateTapVisit, F5) or withGps (fills the gaps, F1/F2/F4) then gives the times
 * shown, and the own times a GPS time replaced are kept on the visit (withOwnTimes).
 */
export function deriveVisit(events: readonly VisitEvent[], ctx: VisitContext): VisitState {
  const gps = events.filter((e) => e.source === 'AYUN' && (e.kind === 'ARRIVED' || e.kind === 'DEPARTED'));
  if (!gps.length) return deriveOwnVisit(events, ctx);
  const own = deriveOwnVisit(events.filter((e) => e.source !== 'AYUN'), ctx);
  const shown = lateTapVisit(own, gps, events) ?? withGps(own, gps, ctx);
  return withOwnTimes(shown, own);
}

/**
 * The shown visit with the own times the GPS replaced (owner decision 21 Oct 2026): the arrival the driver's
 * and the office's events alone gave when the shown arrival is AYUN (F1, F5; null for a stop that had none),
 * and their departure (a real one, or the result standing in for it) when the shown departure is AYUN (F2,
 * F4, F5). Never an AYUN source: `own` is rebuilt without the GPS events.
 */
function withOwnTimes(shown: VisitState, own: VisitState): VisitState {
  const arr = shown.arrivalSource === 'AYUN' && own.arrivedAt !== null;
  const dep = shown.departureSource === 'AYUN' && own.departedAt !== null;
  return {
    ...shown,
    ownArrivedAt: arr ? own.arrivedAt : null,
    ownArrivalSource: arr ? own.arrivalSource : null,
    ownArrivalDistanceM: arr ? own.arrivalDistanceM : null,
    ownArrivalAccuracyM: arr ? own.arrivalAccuracyM : null,
    ownArrivalObserved: arr ? own.arrivalObserved : null,
    ownDepartedAt: dep ? own.departedAt : null,
    ownDepartureSource: dep ? own.departureSource : null,
    ownDepartedAtOutcome: dep ? own.departedAtOutcome : null,
    afterResultMinutes: shown.afterResultMinutes ?? null,
  };
}

/** The shown arrival fields of a GPS arrival event. */
function gpsArrivalFields(a: VisitEvent): Pick<VisitState, 'arrivedAt' | 'arrivalSource' | 'arrivalDistanceM' | 'arrivalAccuracyM' | 'arrivalObserved'> {
  return { arrivedAt: a.at, arrivalSource: 'AYUN', arrivalDistanceM: num(a.distanceM) ?? null, arrivalAccuracyM: num(a.accuracyM) ?? null, arrivalObserved: isObserved(a) };
}

/**
 * F5, the late-tap rule (owner decision 21 Oct 2026; strict: the GPS timing study of 19-20 Oct 2026 found a
 * looser one wrong on a real visit). The driver tapped "I arrived" and saved a result together, after the
 * truck had already left the stop: the visit shows the GPS stay's arrival and departure. All of these hold:
 * 1. the own arrival is the phone's (a tap, a "when?" answer, an automatic one; never the office's), and the
 *    office entered no Left;
 * 2. no GPS stay at the stop is in progress at the tap (a minute either side): then F1 applies instead;
 * 3. the last GPS stay that ended before the tap ended at least LATE_TAP_GAP_MIN and at most
 *    GPS_TAP_LOOKBACK_MIN before it (review of 21 Oct 2026: a later stay that ended less than
 *    LATE_TAP_GAP_MIN before the tap is never skipped for an older one: no rule then);
 * 4. the truck stood still there at least LATE_TAP_MIN_STAND_MIN (its stay summary; ivms-v1 events, with
 *    none, pass);
 * 5. a phone result (any of them: a result corrected later does not undo the rule) within
 *    LATE_TAP_TOGETHER_MIN of the tap, and the visit has a result now (review of 21 Oct 2026: after the
 *    driver's Undo the stop is in progress again on his phone, as without GPS).
 * Only that last stay is shown (a big site with two unmerged stays before the taps: a known limit). The
 * result, the automatic timing and the flags stay the driver's; no minutes away or after the result.
 */
function lateTapVisit(own: VisitState, gpsEvents: readonly VisitEvent[], events: readonly VisitEvent[]): VisitState | null {
  if (!own.arrivedAt || !own.arrivalSource || !PHONE.has(own.arrivalSource) || own.departureSource === 'DISPATCHER' || !own.outcome) return null;
  const a = t(own.arrivedAt);
  const cycles = cyclesOf(gpsEvents);
  const tol = 60_000;
  if (cycles.some((c) => c.start <= a + tol && (!c.departure || t(c.departure.at) >= a - tol))) return null;
  // The stays do not overlap (cyclesOf): the last one left before the tap is the one that ended last.
  const ended = cycles.filter((c) => c.departure && t(c.departure.at) < a);
  const stay = ended[ended.length - 1];
  if (!stay?.departure) return null;
  const sinceLeft = a - t(stay.departure.at);
  if (sinceLeft <= LATE_TAP_GAP_MIN * 60_000 || sinceLeft > GPS_TAP_LOOKBACK_MIN * 60_000) return null;
  const standMin = num((stay.arrivals[0]?.payload?.stay as { standMin?: unknown } | null | undefined)?.standMin);
  if (standMin !== null && standMin < LATE_TAP_MIN_STAND_MIN) return null;
  const together = events.some((e) => e.kind === 'OUTCOME' && PHONE.has(e.source) && typeof e.payload?.outcome === 'string' && Math.abs(t(e.at) - a) <= LATE_TAP_TOGETHER_MIN * 60_000);
  if (!together) return null;
  const out: VisitState = {
    ...own,
    ...gpsArrivalFields(gpsArrivalOf(stay)),
    departedAt: stay.departure.at,
    departureSource: 'AYUN',
    departedAtOutcome: false,
    departureGap: stay.departure.payload?.gap === true,
    awayMinutes: null,
    afterResultMinutes: null,
  };
  out.state = 'DONE'; // the visit has a result (condition 5)
  return out;
}

/**
 * The GPS (AYUN) events fill what the driver and the office left empty (see the header): the arrival of a
 * stop that has none, the departure of a stop nothing else ends; and since 21 Oct 2026 (owner decision) they
 * replace a phone arrival made late in the GPS stay (F1), the phone's automatic departure (F4), and the result
 * standing in for the departure up to an hour after it (F2). The automatic timing stays the phone's.
 */
function withGps(v: VisitState, gpsEvents: readonly VisitEvent[], ctx: VisitContext): VisitState {
  const cycles = cyclesOf(gpsEvents);
  if (!cycles.length) return v;
  const maxAfter = (ctx.maxAfterOutcomeMin ?? 15) * 60_000;
  const match = GPS_DEPARTURE_MATCH_MIN * 60_000;
  const outcomeAt = v.outcome && v.outcomeAt ? t(v.outcomeAt) : null;
  const out: VisitState = { ...v };
  let arrivalAt = v.arrivedAt ? t(v.arrivedAt) : null;
  let stay: Cycle | null = null;
  if (arrivalAt === null) {
    const c = chooseCycle(cycles, outcomeAt);
    const a = c ? gpsArrivalOf(c) : null;
    // Never at or after a Left the office already entered.
    if (c && a && (v.departedAt === null || t(a.at) < t(v.departedAt))) {
      stay = c;
      arrivalAt = t(a.at);
      Object.assign(out, gpsArrivalFields(a));
    }
  } else {
    if (v.arrivalSource && PHONE.has(v.arrivalSource)) {
      // F1 (owner decision 21 Oct 2026): the truck was already standing at the stop when the driver tapped (or
      // the phone noticed): the GPS stay in progress at that time began more than GPS_ARRIVAL_WINS_MIN earlier,
      // and its arrival was observed. The office's arrival always wins; a tap before the stay (on the approach),
      // an unobserved GPS arrival (only an upper bound) or a stay begun hours before keep the tap.
      const a0 = arrivalAt;
      const cover = cycles.filter((c) => c.start <= a0 && (!c.departure || t(c.departure.at) >= a0));
      const c = cover[cover.length - 1];
      const ga = c ? gpsArrivalOf(c) : null;
      if (
        ga &&
        isObserved(ga) &&
        t(ga.at) < a0 - GPS_ARRIVAL_WINS_MIN * 60_000 &&
        a0 - t(ga.at) <= GPS_TAP_LOOKBACK_MIN * 60_000 &&
        (v.departedAt === null || t(ga.at) < t(v.departedAt))
      ) {
        arrivalAt = t(ga.at);
        Object.assign(out, gpsArrivalFields(ga), { arrivalAccuracyM: null });
      }
    }
    const at = arrivalAt;
    // The stays not left before the arrival shown, and those of them that began at most 15 min after it.
    const live = cycles.filter((c) => !c.departure || t(c.departure.at) > at);
    const near = live.filter((c) => c.start <= at + match);
    // As before 19 Oct 2026: the GPS stay of the arrival shown, there at that time or begun at most 15 min after it.
    const ofArrival = chooseCycle(near, outcomeAt) ?? near[0] ?? null;
    let later: Cycle | null = null;
    if (outcomeAt !== null) {
      // Owner request 19 Oct 2026: the GPS stay that holds the result, wherever it began (the truck came
      // back to the pin at a big customer), else the last one begun before the result.
      const holding = live.filter((c) => c.start <= outcomeAt && (!c.departure || t(c.departure.at) >= outcomeAt));
      const before = live.filter((c) => c.start <= outcomeAt);
      later = holding[holding.length - 1] ?? before[before.length - 1] ?? null;
    } else {
      // No result yet: a truck that came back to the pin and is there now (the last stay, not left yet) is at
      // the stop again: no departure (owner request 19 Oct 2026; the minutes it was away are not unloading).
      const last = live[live.length - 1];
      later = last && !last.departure ? last : null;
    }
    // Review of 19 Oct 2026: a stay begun more than 15 min after the arrival shown only when its events carry
    // the detector's stay summary (ivms-v2, from 19 Oct 2026): only then is the time the truck was away before
    // it known (awayMinutesOf), and taken off. Events of the detector before (ivms-v1, stored 16-19 Oct, also
    // what the alerts replay rebuilds) have none: the stay of the arrival shown, as before, so a leave-and-
    // return they hold is never counted as unloading.
    stay = later && (later.start <= at + match || later.arrivals.some(hasStaySummary)) ? later : ofArrival;
  }
  const dep = stay?.departure ?? null;
  // A GPS departure found after a gap in the trail is only an upper bound (lib/alerts/gps.ts principle 3).
  const depObserved = !!dep && dep.payload?.gap !== true;
  // F2 (owner decision 21 Oct 2026): the GPS stay that holds the driver's own result (begun at or before it,
  // not left before it) gives its OBSERVED departure up to GPS_MAX_AFTER_RESULT_MIN after the result, unless
  // the driver tapped at another stop of the truck-day in between (the neighbour guard: the truck stood here,
  // the driver worked elsewhere). An office result, any other stay or a departure after a gap (review of 21 Oct
  // 2026: it would end the unloading alert's measure, "not certain"): the 15-minute rule, as before.
  const holdsDriverResult =
    !!stay && outcomeAt !== null && v.outcomeSource !== 'DISPATCHER' && stay.start <= outcomeAt && (!stay.departure || t(stay.departure.at) >= outcomeAt);
  const neighbour = holdsDriverResult && !!dep && (ctx.otherStopTimes ?? []).some((d) => t(d) > outcomeAt! && t(d) < t(dep.at));
  const cap = holdsDriverResult && depObserved && !neighbour ? GPS_MAX_AFTER_RESULT_MIN * 60_000 : maxAfter;
  // F4 (owner decision 21 Oct 2026): the phone's automatic departure is replaced by an observed GPS one more
  // than GPS_DEPARTURE_WINS_MIN away from it (two measurements of the same moment are left alone). A manual
  // departure and the office's Left never are. Without a result (review of 21 Oct 2026), only when no other GPS
  // stay began between this stay and the phone's departure: the truck came back to the pin, and the phone's
  // departure is the later stay's, not this one's.
  const phoneDepAt = v.departureSource === 'PHONE_AUTO' && v.departedAt !== null ? t(v.departedAt) : null;
  const cameBack = outcomeAt === null && !!stay && phoneDepAt !== null && cycles.some((c) => c.start > stay!.start && c.start < phoneDepAt);
  const autoDiffers = phoneDepAt !== null && depObserved && !cameBack && Math.abs(t(dep!.at) - phoneDepAt) > GPS_DEPARTURE_WINS_MIN * 60_000;
  // The result time is only a stand-in for a departure nobody saw, unless the phone's automatic timing ends
  // there ("Auto to result"): that one is never replaced (second review H-2).
  const standIn = (v.departedAtOutcome && v.autoBasis !== 'RESULT') || autoDiffers;
  let afterResult: number | null = null;
  if ((out.departedAt === null || standIn) && arrivalAt !== null) {
    if (dep && t(dep.at) > arrivalAt && !(outcomeAt !== null && t(dep.at) > outcomeAt + cap)) {
      out.departedAt = dep.at;
      out.departureSource = 'AYUN';
      out.departureGap = dep.payload?.gap === true;
      out.departedAtOutcome = false;
      if (outcomeAt !== null && t(dep.at) > outcomeAt + AFTER_RESULT_UNLOADING_MIN * 60_000) {
        // F2: the minutes after the result are not unloading (the time away in them is taken off once, there).
        const span = minutesBetween(outcomeAt, t(dep.at)) - (awayMinutesOf(gpsEvents, outcomeAt, t(dep.at)) ?? 0);
        const r = Math.round(span * 10) / 10;
        afterResult = r > 0 ? r : null;
      }
    } else if (out.departedAt === null && out.arrivalSource === 'AYUN' && outcomeAt !== null && outcomeAt >= arrivalAt && v.outcomeSource !== 'DISPATCHER') {
      // A GPS arrival and the driver's result: the result ends the stop, as for any arrival.
      out.departedAt = new Date(outcomeAt);
      out.departureSource = v.outcomeSource;
      out.departedAtOutcome = true;
      out.departureGap = false;
    }
  }
  // Owner request 19 Oct 2026: the time the truck was away (a leave-and-return) inside the visit shown.
  out.awayMinutes = out.arrivedAt ? awayMinutesOf(gpsEvents, t(out.arrivedAt), out.departedAt ? t(out.departedAt) : null) : null;
  out.afterResultMinutes = afterResult;
  out.state = out.outcome ? 'DONE' : out.arrivedAt && out.departedAt === null ? 'ARRIVED' : 'PENDING';
  return out;
}

/**
 * The minutes the truck was away from the customer between `from` and `to` (null: still there), by its GPS
 * stays (owner request 19 Oct 2026): a stay that began after a leave-and-return carries the minutes away
 * since the stop's previous stay ended (payload.stay.awayMin, lib/ivms/stops.ts), i.e. the absence
 * [its start - awayMin, its start]; the parts inside [from, to] are summed. Null: none (0 minutes).
 */
export function awayMinutesOf(gps: readonly VisitEvent[], from: number, to: number | null): number | null {
  let total = 0;
  const seen = new Set<number>();
  for (const e of gps) {
    if (e.source !== 'AYUN' || e.kind !== 'ARRIVED') continue;
    const away = num((e.payload?.stay as { awayMin?: unknown } | null | undefined)?.awayMin);
    if (away === null || away <= 0) continue;
    const seg = typeof e.payload?.segmentStartAt === 'string' ? Date.parse(e.payload.segmentStartAt) : NaN;
    const start = Number.isFinite(seg) ? seg : t(e.at);
    if (seen.has(start)) continue;
    seen.add(start);
    const a = Math.max(from, start - away * 60_000);
    const b = Math.min(to ?? Infinity, start);
    if (b > a) total += (b - a) / 60_000;
  }
  const r = Math.round(total * 10) / 10;
  return r > 0 ? r : null;
}

/** The times withGps may fill, as a stored visit (StopVisit) or a rebuilt one (VisitState) carries them. */
export interface VisitTimes {
  arrivedAt: Date | null;
  arrivalSource: string | null;
  arrivalDistanceM: number | null;
  arrivalAccuracyM: number | null;
  arrivalObserved: boolean;
  departedAt: Date | null;
  departureSource: string | null;
  departedAtOutcome: boolean;
  outcome: string | null;
  outcomeAt: Date | null;
  outcomeSource: string | null;
  /** The minutes away the GPS stays showed inside the visit (owner request 19 Oct 2026); absent or null: none. */
  awayMinutes?: number | null;
  /**
   * The own times a GPS time replaced and the minutes after the result (owner decision 21 Oct 2026, VisitState).
   * Required keys (a value, null, or undefined on a visit rebuilt without GPS events), so a row read with a
   * `select` that forgot them does not compile: withoutGpsTimes could not restore the driver's times.
   */
  ownArrivedAt: Date | null | undefined;
  ownArrivalSource: string | null | undefined;
  ownArrivalDistanceM: number | null | undefined;
  ownArrivalAccuracyM: number | null | undefined;
  ownArrivalObserved: boolean | null | undefined;
  ownDepartedAt: Date | null | undefined;
  ownDepartureSource: string | null | undefined;
  ownDepartedAtOutcome: boolean | null | undefined;
  afterResultMinutes: number | null | undefined;
}

/** The keys of the own times and the minutes after the result (StopVisit columns of migration 20261022090000_gps_times_win). */
export const OWN_TIME_KEYS = [
  'ownArrivedAt',
  'ownArrivalSource',
  'ownArrivalDistanceM',
  'ownArrivalAccuracyM',
  'ownArrivalObserved',
  'ownDepartedAt',
  'ownDepartureSource',
  'ownDepartedAtOutcome',
  'afterResultMinutes',
] as const;

/** No own time replaced and no minutes after the result (a visit whose shown times are all the driver's and the office's). */
export const NO_OWN_TIMES: Readonly<Pick<VisitTimes, (typeof OWN_TIME_KEYS)[number]>> = Object.freeze(
  Object.fromEntries(OWN_TIME_KEYS.map((k) => [k, null])) as unknown as Pick<VisitTimes, (typeof OWN_TIME_KEYS)[number]>,
);

/** A Prisma `select` of the own times and the minutes after the result, for a row withoutGpsTimes or ownArrivalOf reads. */
export const OWN_TIMES_SELECT = Object.fromEntries(OWN_TIME_KEYS.map((k) => [k, true])) as { [K in (typeof OWN_TIME_KEYS)[number]]: true };

/**
 * The minutes after the result (F2) a stored visit holds, read only under the GPS departure they belong to: a row
 * an older version rebuilt after an app rollback may hold stale ones (the readers then ignore them, as the own
 * times). Null: none.
 */
export function afterResultOf(v: { departureSource: string | null; departedAtOutcome: boolean; afterResultMinutes?: number | null }): number | null {
  return v.departureSource === 'AYUN' && !v.departedAtOutcome && v.afterResultMinutes && v.afterResultMinutes > 0 ? v.afterResultMinutes : null;
}

/**
 * The driver's (or the office's) own arrival at a stop (owner decision 21 Oct 2026): the arrival a GPS one
 * replaced (ownArrivedAt), else the shown arrival when it is not GPS; null for a GPS-only arrival or none.
 * The driver page, the photo old-check, the office's "Left" check and the on-time KPI read this one: a
 * GPS time is never the driver's.
 */
export function ownArrivalOf(v: { arrivedAt: Date | null; arrivalSource: string | null; ownArrivedAt?: Date | null; ownArrivalSource?: string | null }): { at: Date; source: string } | null {
  if (v.arrivalSource === 'AYUN') return v.ownArrivedAt && v.ownArrivalSource ? { at: v.ownArrivedAt, source: v.ownArrivalSource } : null;
  return v.arrivedAt && v.arrivalSource ? { at: v.arrivedAt, source: v.arrivalSource } : null;
}

/**
 * A visit's times as the driver's and the office's events alone made them, i.e. as with the IVMS link off:
 * withGps undone, from the stored row alone (merge review of 17 Oct 2026, finding 1). The operations alerts
 * read visits through it (lib/alerts/facts.ts, and the load row's time at the depot in outcome-view.ts; the
 * replay leaves the AYUN events out): GPS times are not an alert input until the ivmsMode ALERTS step
 * (lib/ivms/types.ts), so an alert never says "since arrival 10:02" about a stop the driver's phone shows as
 * not arrived. Exact, because withGps only ever fills:
 * - a GPS arrival (arrivalSource AYUN): the stop had no arrival, so no result stood in for its departure;
 *   a departure the office or the phone gave stays, a GPS one or the result ending the GPS arrival goes;
 * - a GPS departure after the driver's or the office's arrival: the stop had none, or the result stood in
 *   for it (a result from the phone; one the office recorded never ends a stop).
 * - the minutes away (awayMinutes, owner request 19 Oct 2026): from the GPS stays only, so none.
 * Since GPS times also REPLACE late phone times (owner decision 21 Oct 2026: F1, F2, F4, F5), the replaced
 * own times are stored with the visit (ownArrivedAt ... ownDepartedAtOutcome) and restored from there:
 * - a GPS arrival with an own arrival stored: that own arrival;
 * - a GPS departure with an own departure stored (a real one or the result standing in for it): that one;
 *   without one, as above (the own departure was empty: a phone result would have stood in for it);
 * - the minutes after the result (afterResultMinutes) are GPS facts: none.
 * The own fields are read only under an AYUN source, so a row an older version rebuilt (own fields left
 * stale) is read as before. Everything else (the result, the automatic timing, the flags, the rest of the
 * row) is the driver's and the office's already. The same object back when GPS gave neither time nor
 * minutes away nor after the result.
 */
export function withoutGpsTimes<V extends VisitTimes>(v: V): V {
  const gpsArrival = v.arrivalSource === 'AYUN';
  const gpsDeparture = v.departureSource === 'AYUN';
  const away = v.awayMinutes !== undefined && v.awayMinutes !== null;
  const after = v.afterResultMinutes !== undefined && v.afterResultMinutes !== null;
  if (!gpsArrival && !gpsDeparture && !away && !after) return v;
  const out: V = { ...v };
  const o: VisitTimes = out;
  if (away) o.awayMinutes = null;
  const replacedArrival = gpsArrival && !!v.ownArrivedAt && !!v.ownArrivalSource;
  const replacedDeparture = gpsDeparture && !!v.ownDepartedAt && !!v.ownDepartureSource;
  for (const k of OWN_TIME_KEYS) (o as unknown as Record<string, unknown>)[k] = null;
  if (gpsArrival && !replacedArrival) {
    // A GPS-only arrival: the stop had none, so no result stood in for its departure; a departure the office
    // gave stays, a GPS one or the result ending the GPS arrival goes.
    o.arrivedAt = null;
    o.arrivalSource = null;
    o.arrivalDistanceM = null;
    o.arrivalAccuracyM = null;
    o.arrivalObserved = true;
    if (gpsDeparture || v.departedAtOutcome) {
      o.departedAt = null;
      o.departureSource = null;
      o.departedAtOutcome = false;
    }
    return out;
  }
  if (replacedArrival) {
    o.arrivedAt = v.ownArrivedAt!;
    o.arrivalSource = v.ownArrivalSource!;
    o.arrivalDistanceM = v.ownArrivalDistanceM ?? null;
    o.arrivalAccuracyM = v.ownArrivalAccuracyM ?? null;
    o.arrivalObserved = v.ownArrivalObserved ?? true;
  }
  if (gpsDeparture) {
    if (replacedDeparture) {
      o.departedAt = v.ownDepartedAt!;
      o.departureSource = v.ownDepartureSource!;
      o.departedAtOutcome = v.ownDepartedAtOutcome ?? false;
    } else {
      // The departure was empty before GPS filled it: only a phone result could have stood in for it.
      const standIn = v.outcome !== null && v.outcomeAt !== null && v.outcomeSource !== 'DISPATCHER';
      o.departedAt = standIn ? v.outcomeAt : null;
      o.departureSource = standIn ? v.outcomeSource : null;
      o.departedAtOutcome = standIn;
    }
  }
  return out;
}

/** The visit from the driver's and the office's events (spec section 8.4): the rebuild with the IVMS link off. */
function deriveOwnVisit(events: readonly VisitEvent[], ctx: VisitContext): VisitState {
  const maxAfter = (ctx.maxAfterOutcomeMin ?? 15) * 60_000;
  // Load-level events (Back at depot, Leaving for next load) never belong to a visit; ignored if given.
  const evs = events.filter((e) => e.kind !== 'CARRY_CONFLICT' && e.kind !== 'BACK_AT_DEPOT' && e.kind !== 'DEPOT_DEPART');
  // 1. Result.
  const res = resultEvent(evs);
  const rp = res?.payload ?? null;
  const outcome = res && typeof rp?.outcome === 'string' ? (rp.outcome as OutcomeName) : null;
  const outcomeAt = outcome && res ? t(res.at) : null;
  // 2-3. Cycles of the phone (and Ayun) events, and the chosen one. The dispatcher's Arrived / Left
  // (Record outcome) are corrections of the whole stop, not cycle members: the newest entry of each
  // replaces the phone's (an earlier office entry included).
  const cycle = chooseCycle(cyclesOf(evs.filter((e) => e.source !== 'DISPATCHER')), outcomeAt);
  const officeArrival = newestOffice(evs, 'ARRIVED');
  const officeDeparture = newestOffice(evs, 'DEPARTED');
  // 4. Arrival.
  const arrival = officeArrival ?? (cycle ? arrivalOf(cycle) : null);
  const arrivalObserved = arrival ? !(AUTO.has(arrival.source) && !isObserved(arrival)) : true;
  // 5. Departure: the office's Left, else the cycle's; never one at or before the arrival.
  let departedAt: number | null = null;
  let departureSource: EventSource | null = null;
  let departedAtOutcome = false;
  let departureGap = false;
  let dep = officeDeparture ?? cycle?.departure ?? null;
  if (dep && arrival && t(dep.at) <= t(arrival.at)) dep = null;
  if (dep && (dep.source === 'DISPATCHER' || !(outcomeAt !== null && t(dep.at) > outcomeAt + maxAfter))) {
    departedAt = t(dep.at);
    departureSource = dep.source;
    departureGap = dep.payload?.gap === true;
  } else if (outcomeAt !== null && arrival && res!.source !== 'DISPATCHER') {
    // A result entered by the office later (Record outcome) is not the end of the stop.
    departedAt = outcomeAt;
    departureSource = res!.source;
    departedAtOutcome = true;
  }
  // 6. Automatic timing, only from observed automatic events.
  const autoArrivedAt = arrival && AUTO.has(arrival.source) && isObserved(arrival) ? t(arrival.at) : null;
  const autoDepartedAt = dep && !departedAtOutcome && AUTO.has(dep.source) && dep.payload?.gap !== true ? t(dep.at) : null;
  let autoBasis: VisitState['autoBasis'] = null;
  let end: number | null = null;
  if (autoArrivedAt !== null) {
    if (autoDepartedAt !== null) {
      autoBasis = 'DEPARTURE';
      end = autoDepartedAt;
    } else if (outcomeAt !== null && res && PHONE.has(res.source) && rp?.late !== true) {
      autoBasis = 'RESULT';
      end = outcomeAt;
    }
  }
  let autoMinutes: number | null = null;
  let autoServiceMinutes: number | null = null;
  if (autoArrivedAt !== null && end !== null && end > autoArrivedAt) {
    autoMinutes = Math.round(minutesBetween(autoArrivedAt, end) * 10) / 10;
    const winStart = ctx.windowStartMin !== null ? t(ctx.dayStart) + ctx.windowStartMin * 60_000 : null;
    const start = winStart !== null ? Math.max(autoArrivedAt, winStart) : autoArrivedAt;
    const brk = ctx.breakMin ? { s: t(ctx.dayStart) + ctx.breakMin.startMin * 60_000, e: t(ctx.dayStart) + ctx.breakMin.endMin * 60_000 } : null;
    const overlapsBreak = !!brk && start < brk.e && end > brk.s;
    if (end > start && !overlapsBreak) autoServiceMinutes = Math.round(minutesBetween(start, end) * 10) / 10;
  } else {
    autoBasis = null; // nothing usable ended the automatic timing (or it ended before it started)
  }
  // 7. Lines, flags and the result's details.
  const delivered = outcome ? deliveredOf(outcome, rp, ctx.lines) : null;
  const lines = ctx.lines.map((l) => ({ ...l, deliveredCases: delivered ? Math.min(l.plannedCases, Math.max(0, delivered.get(l.lineId) ?? 0)) : null }));
  const casesDelivered = delivered ? lines.reduce((a, l) => a + (l.deliveredCases ?? 0), 0) : null;
  const suspect = plausibility(evs, ctx.pin, ctx.radiusM);
  const photoKeys = outcome && Array.isArray(rp?.photoKeys) ? (rp!.photoKeys as unknown[]).filter((k): k is string => typeof k === 'string') : [];
  const state: VisitState['state'] = outcome ? 'DONE' : arrival && departedAt === null ? 'ARRIVED' : 'PENDING';
  return {
    state,
    arrivedAt: arrival ? arrival.at : null,
    arrivalSource: arrival ? arrival.source : null,
    arrivalDistanceM: arrival ? (num(arrival.distanceM) ?? null) : null,
    arrivalAccuracyM: arrival ? (num(arrival.accuracyM) ?? null) : null,
    arrivalObserved,
    departedAt: departedAt !== null ? new Date(departedAt) : null,
    departureSource,
    departedAtOutcome,
    departureGap,
    autoArrivedAt: autoArrivedAt !== null ? new Date(autoArrivedAt) : null,
    autoDepartedAt: autoDepartedAt !== null ? new Date(autoDepartedAt) : null,
    autoBasis,
    autoMinutes,
    autoServiceMinutes,
    timingSuspect: suspect.length > 0,
    suspect,
    outcome,
    reason: outcome ? str(rp?.reason) : null,
    reasonNote: outcome ? str(rp?.note) : null,
    outcomeAt: outcomeAt !== null ? new Date(outcomeAt) : null,
    outcomeSource: outcome && res ? res.source : null,
    outcomeById: outcome && res ? (res.userId ?? null) : null,
    outcomeLat: outcome && res ? (num(res.lat) ?? null) : null,
    outcomeLng: outcome && res ? (num(res.lng) ?? null) : null,
    outcomeAccuracyM: outcome && res ? (num(res.accuracyM) ?? null) : null,
    outcomeDistanceM: outcome && res ? (num(res.distanceM) ?? null) : null,
    outcomeLate: !!outcome && rp?.late === true,
    noPhotoReason: outcome ? str(rp?.noPhotoReason) : null,
    photoKeys,
    lines,
    casesDelivered,
    ...driverFacts(evs),
    // Only a visit with GPS events has these (withOwnTimes); undefined keeps the golden rebuild's JSON unchanged.
    ownArrivedAt: undefined,
    ownArrivalSource: undefined,
    ownArrivalDistanceM: undefined,
    ownArrivalAccuracyM: undefined,
    ownArrivalObserved: undefined,
    ownDepartedAt: undefined,
    ownDepartureSource: undefined,
    ownDepartedAtOutcome: undefined,
    afterResultMinutes: undefined,
  };
}
