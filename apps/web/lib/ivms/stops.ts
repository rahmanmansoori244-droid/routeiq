/**
 * GPS stop detector of the IVMS live link (16 Oct 2026, design section 6.1 with the binding review's
 * H3/H4/M2/M11/M12). Pure and deterministic over the stored trail of ONE truck-day: no database, no
 * clock, no provider call. lib/ivms/stop-events.ts feeds it and writes what it proposes.
 *
 * The trail (TruckTrailPoint) comes only from the provider's history pulls (OBJECT_GET_ROUTE): every
 * device point, never the live map's positions (H5). The detector:
 *
 * 1. Depot moves from the trail: the first point inside the depot radius (or past it + 50 m for an
 *    exit: hysteresis, so a truck at the zone edge does not flap) held for depotDwellMin. A depot zone
 *    move from Ayun (webhook or backstop) is used only when the trail confirms it (a trail move of the
 *    same kind within 10 min): its time then replaces the trail's. An unconfirmed zone move is never a
 *    trip boundary (a forged or misplaced webhook cannot cut trips: review M6).
 * 2. Trips: from a depot OUT to the next depot IN (a trail that starts outside the depot opens a trip
 *    at its first point). Trips are matched to the truck-day's DISPATCHED / COMPLETED loads in dispatch
 *    order (the LOAD_DISPATCHED audit time, never a COMPLETED load's statusChangedAt): an
 *    order-preserving assignment that prefers the trip during which (or right after which) the load
 *    was dispatched and the trip that passes the load's own pins; a fuel run is simply left without a
 *    load (H3). With several loads and no trip boundary at all, nothing is matched.
 * 3. Stays: per pin of the trip's load, a run of points from the first point inside stopRadiusM (the
 *    arrival: never the detection time) to the first of two consecutive points beyond radius + 50 m, or
 *    the first point beyond the radius at 10 km/h or more (the departure). A single drifting point does
 *    not end it, nor does a long silence of a parked truck (M11). It needs a slow point (under 5 km/h,
 *    or the ignition off) and the dwell: dwellMin for the next pending stop in sequence,
 *    outOfSequenceDwellMin for any other (H4).
 * 4. Never automatic (H4): a pin within depotRadiusM of the depot (the truck waiting at the depot is not
 *    at that customer), or two pending pins with stays at the same time (the phone asks "Which
 *    customer?"; GPS writes nothing and leaves a fact for the office). A stop that is not pending (a
 *    result recorded before the stay, an office arrival) gets nothing.
 * 5. At most 2 stays per stop (leaving to park and coming back), each an ARRIVED and, once the truck
 *    left, a DEPARTED. An arrival is `observed` only when the point before it is at most
 *    observedMaxGapSec earlier, a departure only when the last point inside is (else its time is an
 *    upper bound and never feeds measured times or the on-time KPI). Each candidate carries its stay's
 *    first inside fix time (segmentStartAt): the writer keys it by that, never by a cycle index (M2).
 */
import { distanceM } from '../dispatch/snapshots';
import type { DetectorParams, GpsTrip, StopAmbiguity, StopCandidate, TrailPoint } from './types';

/** A depot zone move from the provider (IvmsEvent WEBHOOK / BACKSTOP, kind DEPOT_IN / DEPOT_OUT). */
export interface ZoneMove {
  id: string;
  kind: 'DEPOT_IN' | 'DEPOT_OUT';
  at: Date;
  depotId: string | null;
}

export interface DetectorStop {
  sequence: number;
  /** The planned pin (the visit's, else the plan's); null = none (never matched). */
  pin: { lat: number; lng: number } | null;
  /** The stop's result time from any source (null = no result): it is pending only before it. */
  resultAt: Date | null;
  /** The office entered an arrival: GPS proposes nothing for the stop. */
  officeArrival: boolean;
}

export interface DetectorLoad {
  depotId: string;
  loadNo: number;
  /** Only DISPATCHED and COMPLETED loads get stays (GPS never presses Dispatch). */
  status: string;
  /** When Dispatch was pressed (the audit row), else the best known time (the caller's choice). */
  dispatchedAt: Date | null;
  /** The planned departure from the depot: the order when the dispatch time is unknown. */
  plannedDepartAt: Date;
  stops: DetectorStop[];
}

export interface DetectorInput {
  /** The truck-day's trail, any order (sorted here). */
  points: readonly TrailPoint[];
  /** The pins of the depots of the truck-day's loads. */
  depots: readonly { depotId: string; lat: number; lng: number }[];
  zoneMoves: readonly ZoneMove[];
  loads: readonly DetectorLoad[];
  params: DetectorParams;
}

/** A depot move derived from the trail (stored as IvmsEvent origin TRAIL when no zone move confirms it). */
export interface TrailMove {
  kind: 'DEPOT_IN' | 'DEPOT_OUT';
  at: Date;
  depotId: string;
  lat: number;
  lng: number;
}

export interface DetectedTrip extends GpsTrip {
  depotId: string | null;
  /** The trail started outside the depot: outAt is its first point, not a seen departure. */
  openStart: boolean;
}

export interface DetectorOutput {
  trips: DetectedTrip[];
  /** Trail moves not confirmed by a provider zone move (to store as origin TRAIL). */
  trailMoves: TrailMove[];
  /** What the trail says about each provider zone move inside its time span (others stay undecided). */
  zoneOutcomes: { id: string; outcome: 'USED' | 'UNCONFIRMED' }[];
  /** With the load's depot: a truck can have a Load 1 at two depots on one date. */
  candidates: (StopCandidate & { depotId: string })[];
  ambiguities: StopAmbiguity[];
  /** Why nothing was matched, when that is the case: NO_TRAIL, NO_TRIP, NO_DEPOT_BOUNDARY. */
  notes: string[];
}

/** A provider zone move and a trail move of the same kind this close (minutes) are the same move. */
export const ZONE_CONFIRM_MIN = 10;
/** A point beyond the radius at this speed (km/h) or more ends a stay at once. */
export const EXIT_FAST_KMH = 10;
/** At most this many stays per stop. */
export const MAX_STAYS_PER_STOP = 2;
/** Trip to load matching: the cost (minutes) of a load left without a trip; anything costlier is never chosen. */
const UNMATCHED_COST = 240;
/** A load dispatched after its trip came back (a very late press) costs this much more. */
const AFTER_RETURN_COST = 60;
/** A trip that passes all of a load's pins is worth this many minutes of timing slack. */
const PIN_EVIDENCE_MIN = 60;

const ms = (d: Date) => d.getTime();
const MIN = 60_000;

function sortPoints(points: readonly TrailPoint[]): TrailPoint[] {
  return [...points].filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(ms(p.fixAt))).sort((a, b) => ms(a.fixAt) - ms(b.fixAt));
}

const slow = (p: TrailPoint, movingKmh: number) => p.ignition === false || (p.speedKmh ?? 0) < movingKmh;

// ---------------------------------------------------------------------------------------------------
// 1. Depot moves from the trail

function nearestDepot(p: { lat: number; lng: number }, depots: DetectorInput['depots']): { depotId: string; d: number } | null {
  let best: { depotId: string; d: number } | null = null;
  for (const dp of depots) {
    const d = distanceM(p, dp);
    if (!best || d < best.d) best = { depotId: dp.depotId, d };
  }
  return best;
}

/**
 * The depot moves of a sorted trail: runs of IN (within the radius) and OUT (beyond radius + exitExtra;
 * points in between keep the state before), and a move at the first point of each run held at least
 * depotDwellMin (to the next run's first point, else to its own last point). A short run is noise.
 */
export function trailDepotMoves(points: readonly TrailPoint[], depots: DetectorInput['depots'], p: DetectorParams): { moves: TrailMove[]; startsInside: boolean | null } {
  if (!points.length || !depots.length) return { moves: [], startsInside: null };
  type Run = { inside: boolean; first: TrailPoint; last: TrailPoint; depotId: string };
  const runs: Run[] = [];
  let state: boolean | null = null;
  for (const pt of points) {
    const near = nearestDepot(pt, depots)!;
    const now: boolean | null = near.d <= p.depotRadiusM ? true : near.d > p.depotRadiusM + p.exitExtraM ? false : state;
    if (now === null) continue; // the first points in the band: no state yet
    const cur = runs[runs.length - 1];
    if (cur && cur.inside === now) cur.last = pt;
    else runs.push({ inside: now, first: pt, last: pt, depotId: near.depotId });
    state = now;
  }
  const held = runs.filter((r, i) => {
    const end = runs[i + 1]?.first.fixAt ?? r.last.fixAt;
    return ms(end) - ms(r.first.fixAt) >= p.depotDwellMin * MIN;
  });
  const moves: TrailMove[] = [];
  let prev: boolean | null = held[0]?.inside ?? null;
  for (const r of held.slice(1)) {
    if (r.inside === prev) continue;
    moves.push({ kind: r.inside ? 'DEPOT_IN' : 'DEPOT_OUT', at: r.first.fixAt, depotId: r.depotId, lat: r.first.lat, lng: r.first.lng });
    prev = r.inside;
  }
  return { moves, startsInside: held[0]?.inside ?? null };
}

// ---------------------------------------------------------------------------------------------------
// 2. Trips and their loads

interface Boundary {
  kind: 'DEPOT_IN' | 'DEPOT_OUT';
  at: Date;
  depotId: string | null;
}

/** The trips between the boundaries (OUT ... IN); a trail starting outside opens a trip at its first point. */
export function tripsOf(boundaries: readonly Boundary[], startsInside: boolean | null, firstAt: Date | null): DetectedTrip[] {
  const sorted = [...boundaries].sort((a, b) => ms(a.at) - ms(b.at));
  const trips: DetectedTrip[] = [];
  let open: DetectedTrip | null = null;
  if (startsInside === false && firstAt) {
    open = { outAt: firstAt, inAt: null, loadNo: null, depotId: null, openStart: true };
    trips.push(open);
  }
  for (const b of sorted) {
    if (b.kind === 'DEPOT_OUT') {
      if (open) continue; // already out
      open = { outAt: b.at, inAt: null, loadNo: null, depotId: b.depotId, openStart: false };
      trips.push(open);
    } else if (open) {
      open.inAt = b.at;
      open = null;
    }
  }
  return trips;
}

/** The minutes a load's dispatch time is away from a trip (0 = dispatched during it); null = too far. */
function timeCost(d: Date, trip: DetectedTrip): number | null {
  const out = ms(trip.outAt);
  const back = trip.inAt ? ms(trip.inAt) : Infinity;
  const t = ms(d);
  let c: number;
  if (t >= out && t <= back) c = 0;
  else if (t < out) c = (out - t) / MIN;
  else c = (t - back) / MIN + AFTER_RETURN_COST;
  return c > UNMATCHED_COST ? null : c;
}

/** The share (0..1) of a load's usable pins that the trail passes within the stop radius during a trip. */
function pinEvidence(load: DetectorLoad, trip: DetectedTrip, points: readonly TrailPoint[], p: DetectorParams, nearDepot: (pin: { lat: number; lng: number }) => boolean): number {
  const pins = load.stops.map((s) => s.pin).filter((x): x is { lat: number; lng: number } => !!x && !nearDepot(x));
  if (!pins.length) return 0;
  const inTrip = points.filter((pt) => inside(trip, pt.fixAt));
  const hit = pins.filter((pin) => inTrip.some((pt) => distanceM(pt, pin) <= p.stopRadiusM)).length;
  return hit / pins.length;
}

function inside(trip: GpsTrip, at: Date): boolean {
  return ms(at) >= ms(trip.outAt) && (trip.inAt === null || ms(at) <= ms(trip.inAt));
}

/**
 * Loads to trips, in dispatch order and order-preserving (a later-dispatched load never takes an earlier
 * trip than an earlier-dispatched one), at the least total cost: timeCost minus the pin evidence; a load
 * with no affordable trip stays unmatched. Returns the trip index per load (null = none).
 */
export function matchTripsToLoads(trips: readonly DetectedTrip[], loads: readonly DetectorLoad[], cost: (load: DetectorLoad, trip: DetectedTrip) => number | null): (number | null)[] {
  const L = loads.length;
  const T = trips.length;
  // dp[k][i]: the least cost of the first k loads using only the first i trips; how it was reached.
  type Step = 'TAKE' | 'SKIP_TRIP' | 'UNMATCHED';
  const dp: number[][] = Array.from({ length: L + 1 }, () => new Array<number>(T + 1).fill(Infinity));
  const how: (Step | null)[][] = Array.from({ length: L + 1 }, () => new Array<Step | null>(T + 1).fill(null));
  for (let i = 0; i <= T; i++) dp[0]![i] = 0;
  for (let k = 1; k <= L; k++) {
    dp[k]![0] = dp[k - 1]![0]! + UNMATCHED_COST;
    how[k]![0] = 'UNMATCHED';
    for (let i = 1; i <= T; i++) {
      const c = cost(loads[k - 1]!, trips[i - 1]!);
      const options: [number, Step][] = [
        [c === null ? Infinity : dp[k - 1]![i - 1]! + c, 'TAKE'],
        [dp[k]![i - 1]!, 'SKIP_TRIP'],
        [dp[k - 1]![i]! + UNMATCHED_COST, 'UNMATCHED'],
      ];
      let best = options[0]!;
      for (const o of options.slice(1)) if (o[0] < best[0]) best = o; // ties: TAKE, then SKIP_TRIP
      dp[k]![i] = best[0];
      how[k]![i] = best[1];
    }
  }
  const out: (number | null)[] = new Array<number | null>(L).fill(null);
  let k = L;
  let i = T;
  while (k > 0) {
    const step = how[k]![i];
    if (step === 'TAKE') {
      out[k - 1] = i - 1;
      k--;
      i--;
    } else if (step === 'SKIP_TRIP') i--;
    else k--;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// 3. Stays at a pin

export interface Stay {
  sequence: number;
  /** The first point inside (the arrival) and the gap before it. */
  first: TrailPoint;
  gapBeforeSec: number | null;
  lastIn: TrailPoint;
  /** The departure point (null: still there at the end of the trail or trip). */
  exit: TrailPoint | null;
  gapBeforeExitSec: number | null;
  hasSlowPoint: boolean;
}

/** The stays of a sorted trail (one trip's window) at one pin. */
export function staysAt(points: readonly TrailPoint[], all: readonly TrailPoint[], pin: { lat: number; lng: number }, sequence: number, p: DetectorParams): Stay[] {
  const stays: Stay[] = [];
  const idxInAll = new Map(all.map((pt, i) => [pt, i] as const));
  const prevOf = (pt: TrailPoint) => {
    const i = idxInAll.get(pt);
    return i !== undefined && i > 0 ? all[i - 1]! : null;
  };
  let cur: Stay | null = null;
  let pendingExit: TrailPoint | null = null;
  for (const pt of points) {
    const d = distanceM(pt, pin);
    const isIn = d <= p.stopRadiusM;
    if (!cur) {
      if (!isIn) continue;
      const prev = prevOf(pt);
      cur = { sequence, first: pt, gapBeforeSec: prev ? (ms(pt.fixAt) - ms(prev.fixAt)) / 1000 : null, lastIn: pt, exit: null, gapBeforeExitSec: null, hasSlowPoint: slow(pt, p.movingKmh) };
      pendingExit = null;
      continue;
    }
    if (isIn) {
      cur.lastIn = pt;
      if (slow(pt, p.movingKmh)) cur.hasSlowPoint = true;
      pendingExit = null;
      continue;
    }
    const far = d > p.stopRadiusM + p.exitExtraM;
    const fast = (pt.speedKmh ?? 0) >= EXIT_FAST_KMH;
    if (fast || (far && pendingExit)) {
      const exit = fast && !pendingExit ? pt : (pendingExit ?? pt);
      const before = prevOf(exit);
      cur.exit = exit;
      cur.gapBeforeExitSec = before ? (ms(exit.fixAt) - ms(before.fixAt)) / 1000 : null;
      stays.push(cur);
      cur = null;
      pendingExit = null;
      continue;
    }
    pendingExit = far ? pt : null;
  }
  if (cur) stays.push(cur);
  return stays;
}

const stayEnd = (s: Stay) => (s.exit ?? s.lastIn).fixAt;
const dwellMinOf = (s: Stay) => (ms(stayEnd(s)) - ms(s.first.fixAt)) / MIN;

// ---------------------------------------------------------------------------------------------------
// The truck-day

export function detectTruckDay(input: DetectorInput): DetectorOutput {
  const p = input.params;
  const points = sortPoints(input.points);
  const out: DetectorOutput = { trips: [], trailMoves: [], zoneOutcomes: [], candidates: [], ambiguities: [], notes: [] };
  if (!points.length) {
    out.notes.push('NO_TRAIL');
    return out;
  }
  const nearDepot = (pin: { lat: number; lng: number }) => input.depots.some((dp) => distanceM(pin, dp) <= p.depotRadiusM);

  // 1. Depot moves: the trail's, confirmed provider zone moves replacing them.
  const { moves, startsInside } = trailDepotMoves(points, input.depots, p);
  const span = { from: ms(points[0]!.fixAt), to: ms(points[points.length - 1]!.fixAt) };
  const usedTrail = new Set<TrailMove>();
  const boundaries: Boundary[] = [];
  for (const z of [...input.zoneMoves].sort((a, b) => ms(a.at) - ms(b.at))) {
    if (ms(z.at) < span.from - ZONE_CONFIRM_MIN * MIN || ms(z.at) > span.to + ZONE_CONFIRM_MIN * MIN) continue; // not decided yet
    const match = moves.find((m) => !usedTrail.has(m) && m.kind === z.kind && Math.abs(ms(m.at) - ms(z.at)) <= ZONE_CONFIRM_MIN * MIN);
    if (match) {
      usedTrail.add(match);
      boundaries.push({ kind: z.kind, at: z.at, depotId: z.depotId ?? match.depotId });
      out.zoneOutcomes.push({ id: z.id, outcome: 'USED' });
    } else {
      out.zoneOutcomes.push({ id: z.id, outcome: 'UNCONFIRMED' });
    }
  }
  for (const m of moves) {
    if (usedTrail.has(m)) continue;
    boundaries.push({ kind: m.kind, at: m.at, depotId: m.depotId });
    out.trailMoves.push(m);
  }

  // 2. Trips, and their loads.
  const trips = tripsOf(boundaries, startsInside === null ? false : startsInside, points[0]!.fixAt);
  out.trips = trips;
  const loads = input.loads
    .filter((l) => l.status === 'DISPATCHED' || l.status === 'COMPLETED')
    .sort((a, b) => ms(a.dispatchedAt ?? a.plannedDepartAt) - ms(b.dispatchedAt ?? b.plannedDepartAt) || a.loadNo - b.loadNo || a.depotId.localeCompare(b.depotId));
  if (!trips.length) {
    out.notes.push('NO_TRIP');
    return out;
  }
  if (loads.length > 1 && boundaries.length === 0) {
    // One open trip and several loads: which stay belongs to which load cannot be told (H3).
    out.notes.push('NO_DEPOT_BOUNDARY');
    return out;
  }
  const tripOfLoad = matchTripsToLoads(trips, loads, (l, t) => {
    const c = timeCost(l.dispatchedAt ?? l.plannedDepartAt, t);
    return c === null ? null : c - PIN_EVIDENCE_MIN * pinEvidence(l, t, points, p, nearDepot);
  });
  loads.forEach((l, k) => {
    const i = tripOfLoad[k];
    if (i !== null && i !== undefined) trips[i]!.loadNo = l.loadNo;
  });

  // 3-5. Stays of each matched load's pins inside its own trip only.
  loads.forEach((load, k) => {
    const ti = tripOfLoad[k];
    if (ti === null || ti === undefined) return;
    const trip = trips[ti]!;
    const tripPoints = points.filter((pt) => inside(trip, pt.fixAt));
    const pending = (s: DetectorStop, at: Date) => !s.officeArrival && (s.resultAt === null || ms(s.resultAt) >= ms(at));
    type Found = { stop: DetectorStop; stay: Stay };
    const found: Found[] = [];
    for (const s of load.stops) {
      if (!s.pin) continue;
      for (const stay of staysAt(tripPoints, points, s.pin, s.sequence, p)) {
        if (!stay.hasSlowPoint || dwellMinOf(stay) < p.dwellMin) continue;
        if (!pending(s, stay.first.fixAt)) continue;
        if (nearDepot(s.pin)) {
          out.ambiguities.push({ reason: 'NEAR_DEPOT', loadNo: load.loadNo, sequences: [s.sequence], from: stay.first.fixAt, to: stay.exit?.fixAt ?? null });
          continue;
        }
        found.push({ stop: s, stay });
      }
    }
    // Two pending pins with stays at the same time: nothing automatic for either (H4).
    const overlapping = new Set<Found>();
    for (const a of found) {
      for (const b of found) {
        if (a === b || a.stop.sequence === b.stop.sequence) continue;
        if (ms(a.stay.first.fixAt) <= ms(stayEnd(b.stay)) && ms(b.stay.first.fixAt) <= ms(stayEnd(a.stay))) {
          overlapping.add(a);
          overlapping.add(b);
        }
      }
    }
    const groups = new Map<string, Found[]>();
    for (const f of overlapping) {
      const others = [...overlapping].filter((g) => ms(g.stay.first.fixAt) <= ms(stayEnd(f.stay)) && ms(f.stay.first.fixAt) <= ms(stayEnd(g.stay)));
      const seqs = [...new Set(others.map((g) => g.stop.sequence))].sort((x, y) => x - y);
      const key = seqs.join(',');
      if (!groups.has(key)) groups.set(key, others);
    }
    for (const [key, g] of groups) {
      const from = new Date(Math.min(...g.map((x) => ms(x.stay.first.fixAt))));
      const open = g.some((x) => !x.stay.exit);
      out.ambiguities.push({ reason: 'SEVERAL_PINS', loadNo: load.loadNo, sequences: key.split(',').map(Number), from, to: open ? null : new Date(Math.max(...g.map((x) => ms(stayEnd(x.stay))))) });
    }
    // In time order: the dwell a stay needs depends on whether its stop is the next pending one.
    const matched = new Set<number>();
    const staysOfStop = new Map<number, number>();
    for (const f of found.filter((x) => !overlapping.has(x)).sort((a, b) => ms(a.stay.first.fixAt) - ms(b.stay.first.fixAt) || a.stop.sequence - b.stop.sequence)) {
      const at = f.stay.first.fixAt;
      const next = load.stops
        .filter((s) => s.pin && !nearDepot(s.pin) && !matched.has(s.sequence) && pending(s, at))
        .sort((a, b) => a.sequence - b.sequence)[0];
      const inSequence = matched.has(f.stop.sequence) || next?.sequence === f.stop.sequence;
      if (!inSequence && dwellMinOf(f.stay) < p.outOfSequenceDwellMin) {
        out.ambiguities.push({ reason: 'OUT_OF_SEQUENCE_SHORT', loadNo: load.loadNo, sequences: [f.stop.sequence], from: at, to: f.stay.exit?.fixAt ?? null });
        continue;
      }
      const n = staysOfStop.get(f.stop.sequence) ?? 0;
      if (n >= MAX_STAYS_PER_STOP) continue;
      staysOfStop.set(f.stop.sequence, n + 1);
      matched.add(f.stop.sequence);
      const pin = f.stop.pin!;
      out.candidates.push({
        depotId: load.depotId,
        loadNo: load.loadNo,
        sequence: f.stop.sequence,
        kind: 'ARRIVED',
        at,
        observed: f.stay.gapBeforeSec !== null && f.stay.gapBeforeSec <= p.observedMaxGapSec,
        segmentStartAt: at,
        lat: f.stay.first.lat,
        lng: f.stay.first.lng,
        distanceM: Math.round(distanceM(f.stay.first, pin) * 10) / 10,
      });
      if (f.stay.exit) {
        out.candidates.push({
          depotId: load.depotId,
          loadNo: load.loadNo,
          sequence: f.stop.sequence,
          kind: 'DEPARTED',
          at: f.stay.exit.fixAt,
          observed: f.stay.gapBeforeExitSec !== null && f.stay.gapBeforeExitSec <= p.observedMaxGapSec,
          segmentStartAt: at,
          lat: f.stay.exit.lat,
          lng: f.stay.exit.lng,
          distanceM: Math.round(distanceM(f.stay.exit, pin) * 10) / 10,
        });
      }
    }
  });
  out.candidates.sort((a, b) => ms(a.at) - ms(b.at) || a.loadNo - b.loadNo || a.sequence - b.sequence || (a.kind === b.kind ? 0 : a.kind === 'ARRIVED' ? -1 : 1));
  return out;
}

/** A phone position of the truck-day (a driver's arrival, departure or result with its fix). */
export interface PhoneFix {
  at: Date;
  lat: number;
  lng: number;
}

/** Tracker and phone more than this far apart at the same moment disagree. */
export const MISMATCH_DISTANCE_M = 1000;
/** A phone fix is compared with the trail point at most this far from it in time. */
export const MISMATCH_PAIR_SEC = 120;
/** Disagreements over at least this many minutes (and more than the agreements) = the tracker is not on this truck. */
export const MISMATCH_SPAN_MIN = 10;

/**
 * Is the mapped tracker on another truck (review M8: a swapped or moved tracker)? The driver's phone and
 * the trail disagree by more than 1 km at the same moment, at least 3 times over 10 minutes or more, and
 * more often than they agree. Pure; the writer then suppresses the truck-day's GPS times (MISMATCH).
 */
export function trackerMismatch(phone: readonly PhoneFix[], trail: readonly TrailPoint[]): boolean {
  const pts = sortPoints(trail);
  if (!pts.length) return false;
  const disagree: number[] = [];
  let agree = 0;
  for (const f of phone) {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) continue;
    let best: TrailPoint | null = null;
    for (const pt of pts) {
      const dt = Math.abs(ms(pt.fixAt) - ms(f.at));
      if (dt <= MISMATCH_PAIR_SEC * 1000 && (!best || dt < Math.abs(ms(best.fixAt) - ms(f.at)))) best = pt;
    }
    if (!best) continue;
    if (distanceM(best, f) > MISMATCH_DISTANCE_M) disagree.push(ms(f.at));
    else agree++;
  }
  if (disagree.length < 3 || disagree.length <= agree) return false;
  return Math.max(...disagree) - Math.min(...disagree) >= MISMATCH_SPAN_MIN * MIN;
}

/** The detector's parameters from the company's settings (lib/ivms/settings.ts) and the fixed rules. */
export function detectorParams(cfg: { ivmsStopRadiusM: number; ivmsStopDwellMin: number; ivmsDepotRadiusM: number }, fixed: Pick<DetectorParams, 'exitExtraM' | 'outOfSequenceDwellMin' | 'movingKmh' | 'observedMaxGapSec' | 'depotDwellMin'>): DetectorParams {
  return { stopRadiusM: cfg.ivmsStopRadiusM, dwellMin: cfg.ivmsStopDwellMin, depotRadiusM: cfg.ivmsDepotRadiusM, ...fixed };
}
