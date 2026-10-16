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
 * GPS (AYUN) events (IVMS live link, design section 6.4 with the review's M1/M3): they build their OWN
 * cycles, never mixed into the phone's, so a visit without AYUN events is rebuilt exactly as before
 * (tests/lib/ivms-visit-golden.spec.ts).
 * - Arrival: the office's newest entry; else the driver's "Arrived when?" answer or tap (the phone
 *   cycle's arrival when it is not automatic); else, of the phone's automatic arrival and the GPS
 *   cycle's, the OBSERVED one first, then the earlier; else the GPS arrival.
 * - Departure: the office's Left; else the phone cycle's; else the GPS cycle's (only when that GPS
 *   stay began at most 15 min after the chosen arrival); else (a phone result) the result time. The
 *   15-minute rule after the result applies to a GPS departure too.
 * - The GPS cycle is the one overlapping the chosen phone cycle (the one holding the result among
 *   them), or with no phone cycle the GPS cycle holding the result.
 * - GPS never writes a result, so the result and the driver facts never come from it; the
 *   plausibility flags stay phone-only (a GPS position is never pin evidence).
 * - A visit timed by GPS (its arrival, or its automatic end, is an AYUN event) gets no
 *   autoServiceMinutes: GPS times never feed the measured unloading times used for planning until
 *   replays have validated them (review M3). autoMinutes still shows the stay.
 */
import { distanceM } from '../dispatch/snapshots';

export type EventKind = 'ARRIVED' | 'DEPARTED' | 'OUTCOME' | 'PHOTO' | 'BACK_AT_DEPOT' | 'CARRY_CONFLICT';
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
}

const AUTO: ReadonlySet<EventSource> = new Set(['PHONE_AUTO', 'AYUN']);
const PHONE: ReadonlySet<EventSource> = new Set(['PHONE_AUTO', 'PHONE_MANUAL']);
/** A GPS departure counts only for a GPS stay that began at most this long after the chosen arrival. */
export const GPS_DEPARTURE_MATCH_MIN = 15;

const t = (d: Date) => d.getTime();
const isObserved = (e: VisitEvent) => e.payload?.observed !== false;
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

/**
 * The GPS cycle of the stay: of the GPS (AYUN) cycles overlapping the chosen phone cycle, the one
 * holding the result; with no phone cycle, the GPS cycle holding the result.
 */
function gpsCycleFor(gpsCycles: Cycle[], phone: Cycle | null, outcomeAt: number | null): Cycle | null {
  if (!gpsCycles.length) return null;
  if (!phone) return chooseCycle(gpsCycles, outcomeAt);
  const end = (c: Cycle) => (c.departure ? t(c.departure.at) : Infinity);
  const overlapping = gpsCycles.filter((g) => g.start <= end(phone) && end(g) >= phone.start);
  return overlapping.length ? (chooseCycle(overlapping, outcomeAt) ?? overlapping[0]!) : null;
}

/** The arrival of a GPS cycle: an observed one first, then the earliest. */
function gpsArrivalOf(c: Cycle): VisitEvent {
  return [...c.arrivals].sort((a, b) => (isObserved(a) === isObserved(b) ? 0 : isObserved(a) ? -1 : 1) || t(a.at) - t(b.at))[0]!;
}

/**
 * The arrival of the stay when the office entered none: the phone cycle's (arrivalOf) when it is the
 * driver's (a tap or a "when?" answer); of two automatic arrivals (the phone's and the GPS cycle's),
 * the observed one, then the earlier; else whichever exists. Without a GPS cycle: arrivalOf, as before.
 */
function chooseArrival(phone: Cycle | null, gps: Cycle | null): VisitEvent | null {
  const p = phone ? arrivalOf(phone) : null;
  const g = gps ? gpsArrivalOf(gps) : null;
  if (!g) return p;
  if (!p) return g;
  if (p.source !== 'PHONE_AUTO') return p;
  if (isObserved(p) !== isObserved(g)) return isObserved(p) ? p : g;
  return t(g.at) < t(p.at) ? g : p;
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

/** The visit rebuilt from all its events (spec section 8.4). Pure. */
export function deriveVisit(events: readonly VisitEvent[], ctx: VisitContext): VisitState {
  const maxAfter = (ctx.maxAfterOutcomeMin ?? 15) * 60_000;
  const evs = events.filter((e) => e.kind !== 'CARRY_CONFLICT' && e.kind !== 'BACK_AT_DEPOT');
  // 1. Result.
  const res = resultEvent(evs);
  const rp = res?.payload ?? null;
  const outcome = res && typeof rp?.outcome === 'string' ? (rp.outcome as OutcomeName) : null;
  const outcomeAt = outcome && res ? t(res.at) : null;
  // 2-3. Cycles of the phone events, and the chosen one. The dispatcher's Arrived / Left (Record
  // outcome) are corrections of the whole stop, not cycle members: the newest entry of each replaces
  // the phone's (an earlier office entry included). The GPS (AYUN) events have their own cycles.
  const cycle = chooseCycle(cyclesOf(evs.filter((e) => e.source !== 'DISPATCHER' && e.source !== 'AYUN')), outcomeAt);
  const gps = gpsCycleFor(cyclesOf(evs.filter((e) => e.source === 'AYUN')), cycle, outcomeAt);
  const officeArrival = newestOffice(evs, 'ARRIVED');
  const officeDeparture = newestOffice(evs, 'DEPARTED');
  // 4. Arrival.
  const arrival = officeArrival ?? chooseArrival(cycle, gps);
  const arrivalObserved = arrival ? !(AUTO.has(arrival.source) && !isObserved(arrival)) : true;
  // 5. Departure: the office's Left, else the cycle's, else the GPS stay's (one that began near the
  // arrival); never one at or before the arrival.
  let departedAt: number | null = null;
  let departureSource: EventSource | null = null;
  let departedAtOutcome = false;
  let departureGap = false;
  const gpsDeparture = gps?.departure && !(arrival && gps.start > t(arrival.at) + GPS_DEPARTURE_MATCH_MIN * 60_000) ? gps.departure : null;
  let dep = officeDeparture ?? cycle?.departure ?? gpsDeparture ?? null;
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
  // Timed by GPS (the arrival, or the automatic end, is an AYUN event): never a measured time (M3).
  const gpsTimed = arrival?.source === 'AYUN' || (autoBasis === 'DEPARTURE' && dep?.source === 'AYUN');
  if (autoArrivedAt !== null && end !== null && end > autoArrivedAt) {
    autoMinutes = Math.round(minutesBetween(autoArrivedAt, end) * 10) / 10;
    const winStart = ctx.windowStartMin !== null ? t(ctx.dayStart) + ctx.windowStartMin * 60_000 : null;
    const start = winStart !== null ? Math.max(autoArrivedAt, winStart) : autoArrivedAt;
    const brk = ctx.breakMin ? { s: t(ctx.dayStart) + ctx.breakMin.startMin * 60_000, e: t(ctx.dayStart) + ctx.breakMin.endMin * 60_000 } : null;
    const overlapsBreak = !!brk && start < brk.e && end > brk.s;
    if (end > start && !overlapsBreak && !gpsTimed) autoServiceMinutes = Math.round(minutesBetween(start, end) * 10) / 10;
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
  };
}
