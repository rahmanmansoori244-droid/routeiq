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
 *    same kind within 10 min), and the boundary keeps the TRAIL's time (the device's own points; a
 *    forged or late zone move can never shift a trip: second review, LOW). An unconfirmed zone move is
 *    never a trip boundary (a forged or misplaced webhook cannot cut trips: review M6). A trail move's
 *    time is exact (`observed`) only when the point before it is at most observedMaxGapSec earlier; the
 *    move is stored with that flag (GPS alerts, review of 18 Oct 2026, finding 6).
 * 2. Trips: from a depot OUT to the next depot IN (a trail that starts outside the depot opens a trip
 *    at its first point). Trips are matched to the truck-day's DISPATCHED / COMPLETED loads in dispatch
 *    order (the LOAD_DISPATCHED audit time, never a COMPLETED load's statusChangedAt): an
 *    order-preserving assignment in which an EARLIER-dispatched load always comes first (a load is left
 *    without a trip only when no affordable trip is left for it, never while a later load takes that
 *    trip: second review H-1), then the cheapest: the trip during which (or right after which) the
 *    load's anchor falls - its Dispatch press, or for a load pressed long before it left its planned
 *    departure less ANCHOR_EARLY_MIN - and the trip with STAYS at the load's own pins (a drive-by is no
 *    evidence). A trip that left more than BACK_SLACK_MIN after the load's Back at depot (the driver's or
 *    the office's) is never that load's: a load whose own trip is missing from the trail (a tracker gap)
 *    cannot take the next load's. A fuel run is simply left without a load (H3). A load also keeps the
 *    following (or preceding) trips without a load that stay at its pins before the next load's anchor
 *    and its Back at depot: a break at the depot or a run back for missing goods splits one load into
 *    several trips (second review M-3). With several loads and no trip boundary at all, nothing is
 *    matched.
 * 3. Stays: per pin of the trip's load, a run of points from the first point inside stopRadiusM (the
 *    arrival: never the detection time) to the first of two consecutive points beyond radius + 50 m, or
 *    the first point beyond the radius at 10 km/h or more (the departure). A single drifting point does
 *    not end it, nor does a long silence of a parked truck (M11). It needs a slow point (under 5 km/h,
 *    or the ignition off) and the dwell: dwellMin for the next pending stop in sequence,
 *    outOfSequenceDwellMin for any other (H4).
 * 4. Never automatic (H4): a pin within depotRadiusM of the depot (the truck waiting at the depot is not
 *    at that customer), or two pending pins with stays at the same time (the phone asks "Which
 *    customer?"; GPS writes nothing and leaves a fact for the office). A stop that is not pending (a
 *    result recorded before the stay, an office arrival) gets nothing. Nor does a stay that began more
 *    than LATE_PRESS_MAX_MIN before its load's Dispatch press or after `now` (a trail shifted by a wrong
 *    time offset; first review H-1), or one that began at the first point of a trail that started
 *    outside the depot (when the truck got there is unknown: second review L-4).
 * 5. At most 2 stays per stop (leaving to park and coming back), each an ARRIVED and, once the truck
 *    left, a DEPARTED. An arrival is `observed` only when the point before it is at most
 *    observedMaxGapSec earlier, a departure only when the last point inside is (else its time is an
 *    upper bound and never feeds measured times or the on-time KPI). Each candidate carries its stay's
 *    first inside fix time (segmentStartAt): the writer keys it by that, never by a cycle index (M2).
 *
 * Big sites (owner request 19 Oct 2026: "at big customers the truck moves between drop points and the
 * model thinks it left"; the GPS study of 18-19 Oct 2026, 76 driver-tapped visits, found 3 site moves - a
 * second drop point 353-378 m from the pin, a 2-minute loop out to 397 m, a truck standing about 294 m off
 * the pin - each ended by one exit point 107-149 m out at 14-32 km/h, and 2 real leave-and-returns):
 * 6. GPS cleaning first (cleanTrail): a frozen run - the tracker repeating its last coordinates for
 *    FROZEN_RUN_SEC or more while its speed says it moves (11 runs in the study; one hid a departure
 *    that was then written as exact) - is a gap: its repeated points are dropped, and the event at the
 *    first point after it is not observed. No speed filter: the study's "jumps" over 150 km/h were mostly
 *    timestamp jitter (12 of 19 on one truck at 82-88 km/h, 1-16 s apart), and a plain filter would
 *    delete good points.
 * 7. A customer's site radius (Customer.siteRadiusM, 100-500 m; lib/ivms/site-radius.ts): the stay still
 *    begins within the company's stop radius, but ends only beyond the site radius. Empty: as before.
 *    Review of 19 Oct 2026 (real data, a big customer 235 m from its neighbour): the site radius takes over
 *    only once the truck stood within the stop radius (a slow point there), so a drive-by on the way to the
 *    neighbour never opens a site stay; and a site stay ends where the truck reaches another open stop's pin
 *    (exit rule OTHER_STOP), so the neighbour's visit is never swallowed (staysAt).
 * 8. Consecutive stays of one stop at its pin are one stay (mergeStays) when the next began less than
 *    MERGE_GAP_MIN after the last one ended, every trail point in between stayed within SITE_MAX_M of the
 *    pin, both are stops themselves (a slow point and the dwell: a drive-by never stretches a visit), and
 *    no other open stop of the load (still without a result) had a stay in between or at the same time
 *    (that is the SEVERAL_PINS case, never decided by GPS). The merged stay keeps the first arrival and
 *    the last departure. A departure is FINAL only once the truck has been away HOLD_DEPARTED_MIN, gone
 *    beyond SITE_MAX_M or reached the depot: until then the writer holds it back (stop-events.ts), so a
 *    move between drop points never writes a departure (an observed GPS time is never moved once written).
 *    "Away HOLD_DEPARTED_MIN" is a later trail point, or (review of 19 Oct 2026) a trail known complete that
 *    long past the exit (DetectorInput.trailComplete: the tracker went quiet); after the truck-day's final
 *    pull every departure is final.
 * 9. A later stay of the same stop after the truck went beyond SITE_MAX_M, or stood at another customer's
 *    pin, in between is a leave-and-return (a 6.3 km trip to another customer and a 94-minute park 1.2 km
 *    away in the study): its summary carries the minutes the truck was away like that (StaySummary.awayMin;
 *    a short turn beyond 500 m counts only its own minutes), which the visit rebuild never counts as
 *    unloading (lib/delivery/visit.ts awayMinutesOf).
 * 10. Every candidate carries a summary of its stay (StaySummary: exit rule, speed and distance, minutes
 *    standing, furthest distance, points, frozen runs, merged stays, minutes away), stored in the event's
 *    payload; a pending stop's stay with a slow point but shorter than the dwell is kept as a fact
 *    (SHORT_DWELL), as SEVERAL_PINS, NEAR_DEPOT and OUT_OF_SEQUENCE_SHORT are.
 * The dwell setting stays (3 min): the study found 6 no better, and crawling alone never made a stop
 * (0 of 71). Without a frozen run, a site radius, a return within 10 minutes or a held departure, every
 * time is exactly as before (tests/lib/ivms-stops.spec.ts, ivms-detector-golden.spec.ts: 160 seeded truck-days
 * against the detector before the change; the new rules: ivms-gps-quality.spec.ts).
 */
import { distanceM } from '../dispatch/snapshots';
import { validSiteRadius } from './site-radius';
import type { DetectorParams, GpsTrip, StaySummary, StopAmbiguity, StopCandidate, TrailPoint } from './types';

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
  /** The customer's site radius (Customer.siteRadiusM, 100-500 m): its stays end beyond it. Absent or null: the company's stop radius. */
  siteRadiusM?: number | null;
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
  /**
   * The driver's or the office's latest Back at depot of the load (never a GPS one), or null: a trip that
   * leaves the depot more than BACK_SLACK_MIN after it is never this load's (absent: no bound).
   */
  backAt?: Date | null;
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
  /** The processing time: a stay that begins after it is never proposed (absent: no upper bound). */
  now?: Date;
  /**
   * How far the trail is complete (review of 19 Oct 2026, a held departure never written when the tracker
   * went quiet near the customer): `to` - no trail point up to this time is still to come (lib/ivms/
   * stop-events.ts: the truck-day's history pulled, less the next pull's overlap); `final` - none at all any
   * more (the truck-day's final pull is done). A held departure is final once `to` is HOLD_DEPARTED_MIN past
   * its exit and no stay at the pin began since, and every departure is final once `final`. Absent: only
   * later trail points make a departure final.
   */
  trailComplete?: { to: Date; final: boolean } | null;
}

/** A depot move derived from the trail (stored as IvmsEvent origin TRAIL when no zone move confirms it). */
export interface TrailMove {
  kind: 'DEPOT_IN' | 'DEPOT_OUT';
  at: Date;
  depotId: string;
  lat: number;
  lng: number;
  /**
   * Its time is exact: the trail point before it is at most observedMaxGapSec earlier (else the truck
   * crossed the radius during a gap and `at` is only an upper bound). Stored with the move
   * (IvmsEvent.observed: review of 18 Oct 2026, finding 6), so the alerts never work it out again from
   * trail points the retention may have deleted.
   */
  observed: boolean;
}

export interface DetectedTrip extends GpsTrip {
  depotId: string | null;
  /** The depot of the load the trip is (loadNo), or null: a truck can have a Load 1 at two depots. */
  loadDepotId: string | null;
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
/** Trip to load matching: a trip further than this (minutes) from the load's anchor is never its trip. */
export const MAX_TRIP_COST_MIN = 240;
/** A load dispatched after its trip came back (a very late press) costs this much more. */
const AFTER_RETURN_COST = 60;
/** A trip with stays at all of a load's pins is worth this many minutes of timing slack. */
const PIN_EVIDENCE_MIN = 60;
/**
 * A load pressed long before it left (the office presses Dispatch for the day's loads in the morning) is
 * anchored at its planned departure less this much, when that is later than the press (second review H-1).
 */
export const ANCHOR_EARLY_MIN = 120;
/**
 * Dispatch pressed late: the stays of a load may begin at most this long before the press (the design's
 * late-press allowance). Anything earlier is another trip, or a trail shifted by a wrong time offset.
 */
export const LATE_PRESS_MAX_MIN = 60;
/**
 * A load the driver or the office reported Back at depot never takes a trip that left more than this
 * after it: with an earlier load first (H-1), a load whose own trip is missing from the trail (a tracker
 * gap, a tracker mapped later) must not take the next load's trip instead.
 */
export const BACK_SLACK_MIN = 10;
/**
 * Owner request 19 Oct 2026 (GPS study of 18-19 Oct): a frozen run is the same coordinates repeated for
 * at least this long (seconds) while the speed is MOVING (>= movingKmh): the tracker sends its last
 * position again while the truck drives (then a jump of 0.8-6 km). Treated as a gap (cleanTrail).
 */
export const FROZEN_RUN_SEC = 60;
/** Two stays of one stop at its pin are one when the next began less than this (minutes) after the last ended (mergeStays). */
export const MERGE_GAP_MIN = 10;
/**
 * The site: within this distance (m) of the pin the truck is still at the customer's site (a move between
 * drop points: the study's furthest was 397 m). A merge needs every point in between within it; a
 * departure is final once the truck is beyond it; a later stay after the truck went beyond it is a
 * leave-and-return. Also the largest site radius (lib/ivms/site-radius.ts SITE_RADIUS_MAX_M).
 */
export const SITE_MAX_M = 500;
/** A departure is held back until the truck has been away this long (minutes), unless it went beyond SITE_MAX_M or reached the depot first. */
export const HOLD_DEPARTED_MIN = 10;

const ms = (d: Date) => d.getTime();
const MIN = 60_000;
const round1 = (x: number) => Math.round(x * 10) / 10;

function sortPoints(points: readonly TrailPoint[]): TrailPoint[] {
  return [...points].filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(ms(p.fixAt))).sort((a, b) => ms(a.fixAt) - ms(b.fixAt));
}

const slow = (p: TrailPoint, movingKmh: number) => p.ignition === false || (p.speedKmh ?? 0) < movingKmh;

// ---------------------------------------------------------------------------------------------------
// 0. GPS cleaning (owner request 19 Oct 2026)

export interface CleanTrail {
  /** The sorted trail without the repeated points of frozen runs (each run keeps its first fix: the last real position). */
  points: TrailPoint[];
  /** The first point after each frozen run: the run is a gap, so an event at this point is not observed. */
  afterGap: ReadonlySet<TrailPoint>;
  /** The frozen runs, as times (ms): from the last real fix to the last repeat. */
  frozen: { from: number; to: number }[];
}

/**
 * A sorted trail with its frozen runs treated as gaps: a point whose coordinates are exactly those of the
 * point before, at a moving speed (>= movingKmh), repeats a stale position. A run of such repeats spanning
 * FROZEN_RUN_SEC or more (from the fix it repeats) is dropped, and the point after it is marked as after a
 * gap; a shorter run is kept as it is. Points are never dropped for their speed: the study's "jumps" were
 * mostly timestamp jitter. A trail without a frozen run comes back unchanged (the same points, in order).
 */
export function cleanTrail(sorted: readonly TrailPoint[], movingKmh: number): CleanTrail {
  const points: TrailPoint[] = [];
  const afterGap = new Set<TrailPoint>();
  const frozen: { from: number; to: number }[] = [];
  let i = 0;
  while (i < sorted.length) {
    const a = sorted[i]!;
    points.push(a);
    let j = i + 1;
    while (j < sorted.length && sorted[j]!.lat === a.lat && sorted[j]!.lng === a.lng && (sorted[j]!.speedKmh ?? 0) >= movingKmh) j++;
    const last = sorted[j - 1]!;
    if (j - 1 > i && ms(last.fixAt) - ms(a.fixAt) >= FROZEN_RUN_SEC * 1000) {
      frozen.push({ from: ms(a.fixAt), to: ms(last.fixAt) });
      if (j < sorted.length) afterGap.add(sorted[j]!);
    } else {
      for (let k = i + 1; k < j; k++) points.push(sorted[k]!);
    }
    i = j;
  }
  return { points, afterGap, frozen };
}

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
export function trailDepotMoves(points: readonly TrailPoint[], depots: DetectorInput['depots'], p: DetectorParams, afterGap?: ReadonlySet<TrailPoint>): { moves: TrailMove[]; startsInside: boolean | null } {
  if (!points.length || !depots.length) return { moves: [], startsInside: null };
  type Run = { inside: boolean; first: TrailPoint; last: TrailPoint; depotId: string; firstIdx: number };
  const runs: Run[] = [];
  let state: boolean | null = null;
  points.forEach((pt, idx) => {
    const near = nearestDepot(pt, depots)!;
    const now: boolean | null = near.d <= p.depotRadiusM ? true : near.d > p.depotRadiusM + p.exitExtraM ? false : state;
    if (now === null) return; // the first points in the band: no state yet
    const cur = runs[runs.length - 1];
    if (cur && cur.inside === now) cur.last = pt;
    else runs.push({ inside: now, first: pt, last: pt, depotId: near.depotId, firstIdx: idx });
    state = now;
  });
  // Exact: the point before the move's first point (any point of the trail) at most observedMaxGapSec earlier,
  // and the move's point not the first after a frozen run (owner request 19 Oct 2026: the run is a gap).
  const observedAt = (r: Run) => {
    const before = points[r.firstIdx - 1];
    return !!before && ms(r.first.fixAt) - ms(before.fixAt) <= p.observedMaxGapSec * 1000 && !afterGap?.has(r.first);
  };
  const held = runs.filter((r, i) => {
    const end = runs[i + 1]?.first.fixAt ?? r.last.fixAt;
    return ms(end) - ms(r.first.fixAt) >= p.depotDwellMin * MIN;
  });
  const moves: TrailMove[] = [];
  let prev: boolean | null = held[0]?.inside ?? null;
  for (const r of held.slice(1)) {
    if (r.inside === prev) continue;
    moves.push({ kind: r.inside ? 'DEPOT_IN' : 'DEPOT_OUT', at: r.first.fixAt, depotId: r.depotId, lat: r.first.lat, lng: r.first.lng, observed: observedAt(r) });
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
    open = { outAt: firstAt, inAt: null, loadNo: null, loadDepotId: null, depotId: null, openStart: true };
    trips.push(open);
  }
  for (const b of sorted) {
    if (b.kind === 'DEPOT_OUT') {
      if (open) continue; // already out
      open = { outAt: b.at, inAt: null, loadNo: null, loadDepotId: null, depotId: b.depotId, openStart: false };
      trips.push(open);
    } else if (open) {
      open.inAt = b.at;
      open = null;
    }
  }
  return trips;
}

/**
 * Where a load is expected to leave (second review H-1): its Dispatch press, or - pressed long before it
 * left - its planned departure less ANCHOR_EARLY_MIN when that is later. Unknown press: the plan.
 */
export function loadAnchor(l: Pick<DetectorLoad, 'dispatchedAt' | 'plannedDepartAt'>): Date {
  if (!l.dispatchedAt) return l.plannedDepartAt;
  return new Date(Math.max(ms(l.dispatchedAt), ms(l.plannedDepartAt) - ANCHOR_EARLY_MIN * MIN));
}

/** The minutes a load's anchor is away from a trip (0 = during it); null = too far (never its trip). */
function timeCost(d: Date, trip: DetectedTrip): number | null {
  const out = ms(trip.outAt);
  const back = trip.inAt ? ms(trip.inAt) : Infinity;
  const t = ms(d);
  let c: number;
  if (t >= out && t <= back) c = 0;
  else if (t < out) c = (out - t) / MIN;
  else c = (t - back) / MIN + AFTER_RETURN_COST;
  return c > MAX_TRIP_COST_MIN ? null : c;
}

/** Is a stay long and slow enough to be a stop (the in-sequence dwell)? */
const isStop = (s: Stay, p: DetectorParams) => s.hasSlowPoint && dwellMinOf(s) >= p.dwellMin;

/**
 * The share (0..1) of a load's usable pins with a STAY (a slow point and the dwell) during a trip: a
 * truck driving past a pin is no evidence (second review H-1).
 */
function pinEvidence(load: DetectorLoad, tripPoints: readonly TrailPoint[], prevIdx: PrevIndex, p: DetectorParams, nearDepot: (pin: { lat: number; lng: number }) => boolean): number {
  const pins = load.stops.filter((s) => !!s.pin && !nearDepot(s.pin));
  if (!pins.length || !tripPoints.length) return 0;
  const hit = pins.filter((s) => staysAt(tripPoints, tripPoints, s.pin!, s.sequence, p, prevIdx, siteRadiusOf(s)).some((st) => isStop(st, p))).length;
  return hit / pins.length;
}

/** The radius a stop's stays end with: its customer's site radius when it has a valid one (owner request 19 Oct 2026), else none (the stop radius). */
const siteRadiusOf = (s: Pick<DetectorStop, 'siteRadiusM'>): number | undefined => validSiteRadius(s.siteRadiusM) ?? undefined;

function inside(trip: GpsTrip, at: Date): boolean {
  return ms(at) >= ms(trip.outAt) && (trip.inAt === null || ms(at) <= ms(trip.inAt));
}

/**
 * Loads to trips, in dispatch order and order-preserving (a later-dispatched load never takes an earlier
 * trip than an earlier-dispatched one). An earlier load always comes first (second review H-1): of all
 * assignments, the one that leaves the EARLIEST loads matched wins (lexicographic: matching load 1 is
 * worth more than matching every later load), so a load is left unmatched only when no affordable trip
 * is left for it, never while a later load takes a trip it could have. Among those, the least total
 * cost (timeCost minus the pin evidence). Returns the trip index per load (null = none).
 */
export function matchTripsToLoads(trips: readonly DetectedTrip[], loads: readonly DetectorLoad[], cost: (load: DetectorLoad, trip: DetectedTrip) => number | null): (number | null)[] {
  const L = loads.length;
  const T = trips.length;
  // dp[k][i]: the best [unmatched weight, cost] of the first k loads using only the first i trips. Leaving
  // load k (1-based) unmatched weighs 2^(L-k): more than all later loads together (exact for L <= 52).
  type Step = 'TAKE' | 'SKIP_TRIP' | 'UNMATCHED';
  type Val = [number, number];
  const weight = (k: number) => Math.pow(2, Math.min(52, L - k));
  const less = (a: Val, b: Val) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1] - 1e-9);
  const dp: Val[][] = Array.from({ length: L + 1 }, () => Array.from({ length: T + 1 }, (): Val => [Infinity, Infinity]));
  const how: (Step | null)[][] = Array.from({ length: L + 1 }, () => new Array<Step | null>(T + 1).fill(null));
  for (let i = 0; i <= T; i++) dp[0]![i] = [0, 0];
  for (let k = 1; k <= L; k++) {
    const w = weight(k);
    dp[k]![0] = [dp[k - 1]![0]![0] + w, dp[k - 1]![0]![1]];
    how[k]![0] = 'UNMATCHED';
    for (let i = 1; i <= T; i++) {
      const c = cost(loads[k - 1]!, trips[i - 1]!);
      const take = dp[k - 1]![i - 1]!;
      const unmatched = dp[k - 1]![i]!;
      const options: [Val, Step][] = [
        [c === null ? [Infinity, Infinity] : [take[0], take[1] + c], 'TAKE'],
        [dp[k]![i - 1]!, 'SKIP_TRIP'],
        [[unmatched[0] + w, unmatched[1]], 'UNMATCHED'],
      ];
      let best = options[0]!;
      for (const o of options.slice(1)) if (less(o[0], best[0])) best = o; // ties: TAKE, then SKIP_TRIP
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
  /** The last point inside the radius the stay ends with (the site radius when the customer has one). */
  lastIn: TrailPoint;
  /** The departure point (null: still there at the end of the trail or trip). */
  exit: TrailPoint | null;
  gapBeforeExitSec: number | null;
  hasSlowPoint: boolean;
  /**
   * FAST: the exit point is beyond the radius at EXIT_FAST_KMH or more; TWO_FAR: the first of two points
   * beyond radius + exitExtraM; OTHER_STOP: a site-radius stay whose next point reached another open stop's
   * pin (the exit is the stay's last point before it); null: no exit.
   */
  exitRule: 'FAST' | 'TWO_FAR' | 'OTHER_STOP' | null;
  /**
   * The radius the stay ends with (m): the stop radius, or the customer's site radius when larger - the
   * latter only once the truck stood within the stop radius (review of 19 Oct 2026: a drive-by never
   * opens a site-radius stay).
   */
  radiusM: number;
  /** The furthest point from the pin (m), from the arrival to the exit (merged gaps included). */
  maxDistM: number;
  /** Trail points from the arrival to the exit (merged gaps included). */
  points: number;
  /** Milliseconds standing: from each slow point to the next point (merged gaps included). */
  standMs: number;
  /** Stays merged into this one (mergeStays). */
  merged: number;
}

/** The point before each point of the whole sorted trail (built once per truck-day, not per pin). */
export type PrevIndex = ReadonlyMap<TrailPoint, TrailPoint | null>;

export function prevIndexOf(all: readonly TrailPoint[]): PrevIndex {
  return new Map(all.map((pt, i) => [pt, i > 0 ? all[i - 1]! : null] as const));
}

/**
 * Another stop's pin for a site-radius stay (review of 19 Oct 2026): the stay ends where the truck reaches
 * it while that stop is open (still without a result: `openUntil` its result time in ms, null none yet).
 */
export interface OtherPin {
  lat: number;
  lng: number;
  openUntil: number | null;
}

/**
 * The stays of a sorted trail (one trip's window) at one pin; `prevIdx` from prevIndexOf(all) (built here
 * when absent). A stay begins at the first point within the stop radius; `exitRadiusM` (a customer's site
 * radius, owner request 19 Oct 2026) only moves where it ends: the points within it keep the stay going.
 * Absent (or not larger than the stop radius): the stop radius, as before.
 *
 * Review of 19 Oct 2026 (real data: a truck passing 103-155 m from a big customer's pin at 10-26 km/h on its
 * way to the neighbouring customer 235 m away opened a 400 m stay there that ran through both visits, so
 * SEVERAL_PINS left both without GPS times): the site radius takes over only once the stay has a slow point
 * within the stop radius (the truck stood at the pin); until then the stop radius ends it, exactly as
 * without a site radius, so a drive-by never opens a site stay. And a site stay ends (OTHER_STOP) at its last
 * point before the truck reaches the stop radius of another open stop's pin (`others`: the load's other
 * stops, open until their result), so a neighbouring customer inside the site radius is never swallowed.
 * Without a site radius neither rule changes anything.
 */
export function staysAt(
  points: readonly TrailPoint[],
  all: readonly TrailPoint[],
  pin: { lat: number; lng: number },
  sequence: number,
  p: DetectorParams,
  prevIdx?: PrevIndex,
  exitRadiusM?: number,
  others: readonly OtherPin[] = [],
): Stay[] {
  const stays: Stay[] = [];
  const idx = prevIdx ?? prevIndexOf(all);
  const prevOf = (pt: TrailPoint) => idx.get(pt) ?? null;
  const siteR = Math.max(p.stopRadiusM, exitRadiusM ?? p.stopRadiusM);
  // Only pins further than the stop radius from this one (a pin inside it is this stop's place too).
  const near = siteR > p.stopRadiusM ? others.filter((o) => distanceM(o, pin) > p.stopRadiusM) : [];
  const atOtherPin = (pt: TrailPoint) => near.some((o) => (o.openUntil === null || o.openUntil >= ms(pt.fixAt)) && distanceM(pt, o) <= p.stopRadiusM);
  let cur: Stay | null = null;
  let pendingExit: TrailPoint | null = null;
  // The stay's previous point and whether it stood there (for the minutes standing).
  let lastPt: TrailPoint | null = null;
  let lastSlow = false;
  const take = (s: Stay, pt: TrailPoint, d: number) => {
    if (lastPt && lastSlow) s.standMs += ms(pt.fixAt) - ms(lastPt.fixAt);
    s.points++;
    s.maxDistM = Math.max(s.maxDistM, d);
    lastPt = pt;
  };
  /** The truck stood within the stop radius (a slow point): from then on the site radius ends the stay. */
  const anchor = (s: Stay, pt: TrailPoint, d: number) => {
    if (d <= p.stopRadiusM && slow(pt, p.movingKmh)) s.radiusM = siteR;
  };
  for (const pt of points) {
    const d = distanceM(pt, pin);
    if (!cur) {
      if (d > p.stopRadiusM) continue;
      const prev = prevOf(pt);
      cur = {
        sequence,
        first: pt,
        gapBeforeSec: prev ? (ms(pt.fixAt) - ms(prev.fixAt)) / 1000 : null,
        lastIn: pt,
        exit: null,
        gapBeforeExitSec: null,
        hasSlowPoint: slow(pt, p.movingKmh),
        exitRule: null,
        radiusM: p.stopRadiusM,
        maxDistM: d,
        points: 1,
        standMs: 0,
        merged: 0,
      };
      anchor(cur, pt, d);
      pendingExit = null;
      lastPt = pt;
      lastSlow = slow(pt, p.movingKmh);
      continue;
    }
    // The radius the stay ends with now: the site radius once anchored, else the stop radius.
    const exitR = cur.radiusM;
    if (exitR > p.stopRadiusM && d > p.stopRadiusM && lastPt && atOtherPin(pt)) {
      // A site stay reaching another open stop's pin: it ends at its last point before it (that point's
      // time, never the other stop's arrival, so the two stays never overlap).
      const exit: TrailPoint = lastPt;
      const before = prevOf(exit);
      cur.exit = exit;
      cur.exitRule = 'OTHER_STOP';
      cur.gapBeforeExitSec = before ? (ms(exit.fixAt) - ms(before.fixAt)) / 1000 : null;
      stays.push(cur);
      cur = null;
      pendingExit = null;
      lastPt = null;
      lastSlow = false;
      // The point itself may begin this pin's next stay only within the stop radius: it is not (d > stop radius).
      continue;
    }
    if (d <= exitR) {
      take(cur, pt, d);
      cur.lastIn = pt;
      lastSlow = slow(pt, p.movingKmh);
      if (lastSlow) cur.hasSlowPoint = true;
      anchor(cur, pt, d);
      pendingExit = null;
      continue;
    }
    const far = d > exitR + p.exitExtraM;
    const fast = (pt.speedKmh ?? 0) >= EXIT_FAST_KMH;
    if (fast || (far && pendingExit)) {
      const exit = fast && !pendingExit ? pt : (pendingExit ?? pt);
      if (exit === pt) take(cur, pt, d);
      const before = prevOf(exit);
      cur.exit = exit;
      cur.exitRule = exit === pt && fast ? 'FAST' : 'TWO_FAR';
      cur.gapBeforeExitSec = before ? (ms(exit.fixAt) - ms(before.fixAt)) / 1000 : null;
      stays.push(cur);
      cur = null;
      pendingExit = null;
      lastPt = null;
      lastSlow = false;
      continue;
    }
    // A point beyond the radius that does not end the stay (yet): part of it.
    take(cur, pt, d);
    lastSlow = false;
    pendingExit = far ? pt : null;
  }
  if (cur) stays.push(cur);
  return stays;
}

const stayEnd = (s: Stay) => (s.exit ?? s.lastIn).fixAt;
const dwellMinOf = (s: Stay) => (ms(stayEnd(s)) - ms(s.first.fixAt)) / MIN;
const overlaps = (s: Stay, from: number, to: number) => ms(s.first.fixAt) <= to && from <= ms(stayEnd(s));

/** The points of a sorted trail strictly between two times (ms), by binary search. */
function pointsBetween(sorted: readonly TrailPoint[], from: number, to: number): TrailPoint[] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ms(sorted[mid]!.fixAt) <= from) lo = mid + 1;
    else hi = mid;
  }
  const out: TrailPoint[] = [];
  for (let i = lo; i < sorted.length && ms(sorted[i]!.fixAt) < to; i++) out.push(sorted[i]!);
  return out;
}

/**
 * One stop's consecutive stays (time order, stops only: a slow point and the dwell) as the visits they
 * are (owner request 19 Oct 2026, "the truck moves between drop points"): the next stay is merged into
 * the one before when it began less than MERGE_GAP_MIN after that one's exit, every point of the whole
 * trail in between stayed within SITE_MAX_M of the pin, and neither it, the one before nor the time in
 * between overlaps a stay of `others` (the stays of the load's other open stops: never merged across
 * another customer, nor in the SEVERAL_PINS case). The merged stay keeps the first arrival and the last
 * departure; its summary counts the time and the points in between.
 */
export function mergeStays(stays: readonly Stay[], all: readonly TrailPoint[], pin: { lat: number; lng: number }, others: readonly Stay[], p: Pick<DetectorParams, 'movingKmh'>): Stay[] {
  const shared = (s: Stay) => others.some((o) => overlaps(o, ms(s.first.fixAt), ms(stayEnd(s))));
  const out: { stay: Stay; shared: boolean }[] = [];
  for (const s of stays) {
    const a = out[out.length - 1];
    const sShared = shared(s);
    if (a && a.stay.exit && !a.shared && !sShared) {
      const exitAt = ms(a.stay.exit.fixAt);
      const nextAt = ms(s.first.fixAt);
      if (nextAt - exitAt < MERGE_GAP_MIN * MIN && !others.some((o) => overlaps(o, exitAt, nextAt))) {
        const gap = pointsBetween(all, ms(a.stay.lastIn.fixAt), nextAt);
        if (gap.every((q) => distanceM(q, pin) <= SITE_MAX_M)) {
          const m = a.stay;
          // The points after the exit (counted already) up to the next arrival: part of the merged stay.
          const after = gap.filter((q) => ms(q.fixAt) > exitAt);
          let standMs = 0;
          let prev = m.exit!;
          for (const q of [...after, s.first]) {
            if (slow(prev, p.movingKmh)) standMs += ms(q.fixAt) - ms(prev.fixAt);
            prev = q;
          }
          a.stay = {
            ...m,
            lastIn: s.lastIn,
            exit: s.exit,
            exitRule: s.exitRule,
            gapBeforeExitSec: s.gapBeforeExitSec,
            hasSlowPoint: m.hasSlowPoint || s.hasSlowPoint,
            maxDistM: Math.max(m.maxDistM, s.maxDistM, ...after.map((q) => distanceM(q, pin))),
            points: m.points + after.length + s.points,
            standMs: m.standMs + standMs + s.standMs,
            merged: m.merged + s.merged + 1,
          };
          continue;
        }
      }
    }
    out.push({ stay: s, shared: sShared });
  }
  return out.map((x) => x.stay);
}

// ---------------------------------------------------------------------------------------------------
// The truck-day

export function detectTruckDay(input: DetectorInput): DetectorOutput {
  const p = input.params;
  // 0. GPS cleaning (owner request 19 Oct 2026): frozen runs are gaps; nothing else is dropped.
  const clean = cleanTrail(sortPoints(input.points), p.movingKmh);
  const points = clean.points;
  const out: DetectorOutput = { trips: [], trailMoves: [], zoneOutcomes: [], candidates: [], ambiguities: [], notes: [] };
  if (!points.length) {
    out.notes.push('NO_TRAIL');
    return out;
  }
  const nearDepot = (pin: { lat: number; lng: number }) => input.depots.some((dp) => distanceM(pin, dp) <= p.depotRadiusM);
  /** A time is exact: at most observedMaxGapSec after the point before it, and not the first point after a frozen run. */
  const observedAt = (pt: TrailPoint, gapSec: number | null) => gapSec !== null && gapSec <= p.observedMaxGapSec && !clean.afterGap.has(pt);

  // 1. Depot moves: the trail's, confirmed provider zone moves replacing them.
  const { moves, startsInside } = trailDepotMoves(points, input.depots, p, clean.afterGap);
  const span = { from: ms(points[0]!.fixAt), to: ms(points[points.length - 1]!.fixAt) };
  const usedTrail = new Set<TrailMove>();
  const boundaries: Boundary[] = [];
  for (const z of [...input.zoneMoves].sort((a, b) => ms(a.at) - ms(b.at))) {
    if (ms(z.at) < span.from - ZONE_CONFIRM_MIN * MIN || ms(z.at) > span.to + ZONE_CONFIRM_MIN * MIN) continue; // not decided yet
    const match = moves.find((m) => !usedTrail.has(m) && m.kind === z.kind && Math.abs(ms(m.at) - ms(z.at)) <= ZONE_CONFIRM_MIN * MIN);
    if (match) {
      usedTrail.add(match);
      // The trail's own time: the zone move only confirms the boundary, it never moves it.
      boundaries.push({ kind: z.kind, at: match.at, depotId: z.depotId ?? match.depotId });
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
  const prevIdx = prevIndexOf(points);
  const pointsOf = trips.map((t) => points.filter((pt) => inside(t, pt.fixAt)));
  // Pin evidence per (load, trip), computed once (the matching asks for each pair more than once).
  const evidence = new Map<string, number>();
  const evidenceOf = (k: number, i: number) => {
    const key = `${k}|${i}`;
    if (!evidence.has(key)) evidence.set(key, pinEvidence(loads[k]!, pointsOf[i]!, prevIdx, p, nearDepot));
    return evidence.get(key)!;
  };
  const anchors = loads.map(loadAnchor);
  // A trip that left after the load was reported Back at depot (the driver's or the office's) is never its.
  const afterBack = (k: number, t: DetectedTrip) => {
    const b = loads[k]!.backAt;
    return !!b && ms(t.outAt) > ms(b) + BACK_SLACK_MIN * MIN;
  };
  const tripOfLoad = matchTripsToLoads(trips, loads, (l, t) => {
    const k = loads.indexOf(l);
    if (afterBack(k, t)) return null;
    const c = timeCost(anchors[k]!, t);
    return c === null ? null : c - PIN_EVIDENCE_MIN * evidenceOf(k, trips.indexOf(t));
  });
  // A load keeps the trips without a load next to its own that stay at its pins, inside its window: from
  // its anchor (less the late-press allowance) to the next load's, never after its Back at depot (second
  // review M-3: a break at the depot, a run back for missing goods).
  const matchedTrips = new Set(tripOfLoad.filter((i): i is number => i !== null));
  const tripsOfLoad: number[][] = loads.map((_, k) => {
    const own = tripOfLoad[k];
    if (own === null || own === undefined) return [];
    const from = ms(anchors[k]!) - LATE_PRESS_MAX_MIN * MIN;
    const to = k + 1 < loads.length ? ms(anchors[k + 1]!) : Infinity;
    const list = [own];
    for (const dir of [-1, 1]) {
      for (let i = own + dir; i >= 0 && i < trips.length && !matchedTrips.has(i); i += dir) {
        const at = ms(trips[i]!.outAt);
        if (at < from || at >= to || afterBack(k, trips[i]!)) break;
        if (evidenceOf(k, i) > 0) list.push(i); // a fuel run in between stays without a load
      }
    }
    for (const i of list) matchedTrips.add(i);
    return list.sort((a, b) => a - b);
  });
  loads.forEach((l, k) => {
    for (const i of tripsOfLoad[k]!) Object.assign(trips[i]!, { loadNo: l.loadNo, loadDepotId: l.depotId });
  });

  // Every pin of the truck-day's loads (the leave-and-return guard: a stop at another customer in between).
  const allPins = [...new Map(input.loads.flatMap((l) => l.stops.filter((s) => s.pin).map((s) => [`${s.pin!.lat}|${s.pin!.lng}`, s.pin!] as const))).values()];
  const indexOf = new Map(points.map((pt, i) => [pt, i] as const));
  const frozenIn = (from: number, to: number) => clean.frozen.filter((f) => f.from <= to && f.to >= from).length;

  // 3-5. Stays of each matched load's pins inside its own trips only.
  loads.forEach((load, k) => {
    const own = tripsOfLoad[k]!;
    if (!own.length) return;
    const tripPoints = points.filter((pt) => own.some((i) => inside(trips[i]!, pt.fixAt)));
    // A trail that started outside the depot: when the truck got to its first point is unknown (L-4).
    const unknownStart = new Set(own.filter((i) => trips[i]!.openStart).map((i) => ms(trips[i]!.outAt)));
    // A stay before the Dispatch press less the late-press allowance, or after now, is never this load's (H-1).
    const notBefore = load.dispatchedAt ? ms(load.dispatchedAt) - LATE_PRESS_MAX_MIN * MIN : -Infinity;
    const notAfter = input.now ? ms(input.now) : Infinity;
    const pending = (s: DetectorStop, at: Date) => !s.officeArrival && (s.resultAt === null || ms(s.resultAt) >= ms(at));
    /** A stay this load may time: inside its window, not at an unknown start, its stop still pending then. */
    const usable = (s: DetectorStop, stay: Stay) => {
      const start = ms(stay.first.fixAt);
      return start >= notBefore && start <= notAfter && !unknownStart.has(start) && pending(s, stay.first.fixAt);
    };
    // Each pin's stays, and the stops among them (a slow point and the dwell). A site stay ends at the pin of
    // another open stop of the load (review of 19 Oct 2026; open: no office arrival, no result yet).
    const otherPinsOf = (s: DetectorStop): OtherPin[] =>
      load.stops.filter((o) => o.sequence !== s.sequence && !!o.pin && !o.officeArrival).map((o) => ({ lat: o.pin!.lat, lng: o.pin!.lng, openUntil: o.resultAt ? ms(o.resultAt) : null }));
    const perStop = load.stops
      .filter((s) => !!s.pin)
      .map((s) => {
        const all = staysAt(tripPoints, points, s.pin!, s.sequence, p, prevIdx, siteRadiusOf(s), otherPinsOf(s));
        return { stop: s, all, stops: all.filter((x) => isStop(x, p)), merged: [] as Stay[] };
      });
    // Owner request 19 Oct 2026: consecutive stays at one pin that are one visit of a big site are merged,
    // never across (or together with) a stay at another stop of the load that was still open then.
    for (const r of perStop) {
      const others = perStop.filter((o) => o.stop.sequence !== r.stop.sequence).flatMap((o) => o.stops.filter((x) => pending(o.stop, x.first.fixAt)));
      r.merged = mergeStays(r.stops, points, r.stop.pin!, others, p);
    }
    type Found = { stop: DetectorStop; stay: Stay };
    const found: Found[] = [];
    const shortDwell: StopAmbiguity[] = [];
    for (const r of perStop) {
      const s = r.stop;
      for (const stay of r.merged) {
        if (!usable(s, stay)) continue;
        if (nearDepot(s.pin!)) {
          out.ambiguities.push({ reason: 'NEAR_DEPOT', loadNo: load.loadNo, sequences: [s.sequence], from: stay.first.fixAt, to: stay.exit?.fixAt ?? null });
          continue;
        }
        found.push({ stop: s, stay });
      }
      // A rejected candidate kept as a fact: the truck stood at a pending stop's pin, and left before the dwell.
      for (const stay of r.all) {
        if (!stay.exit || !stay.hasSlowPoint || dwellMinOf(stay) >= p.dwellMin || !usable(s, stay) || nearDepot(s.pin!)) continue;
        if (r.merged.some((m) => overlaps(m, ms(stay.first.fixAt), ms(stayEnd(stay))))) continue;
        shortDwell.push({ reason: 'SHORT_DWELL', loadNo: load.loadNo, sequences: [s.sequence], from: stay.first.fixAt, to: stay.exit.fixAt });
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

    /**
     * The minutes away between two stays of one stop (owner request 19 Oct 2026, the leave-and-return
     * guard): of the time from the first one's exit to the next one's arrival, the part the truck was beyond
     * SITE_MAX_M of the pin or standing at another customer's pin (a stay there with a slow point and the
     * dwell) - each trail interval counted by the point it starts at. 0 when it stayed on the site (the GPS
     * study's truck standing 294 m from a pin that was 294 m off is on site, its one-minute turn out to 610 m
     * is not). A silence is counted by the point before it; no point at all in between: 0.
     */
    const awayBetween = (prev: Stay, next: Stay, pin: { lat: number; lng: number }): number => {
      const from = ms(stayEnd(prev));
      const to = ms(next.first.fixAt);
      if (to <= from) return 0;
      const gap = pointsBetween(points, ms(prev.lastIn.fixAt), to);
      const elsewhere = allPins.filter((o) => distanceM(o, pin) > p.stopRadiusM).flatMap((o) => staysAt(gap, points, o, 0, p, prevIdx).filter((x) => isStop(x, p)));
      const atOther = (t: number) => elsewhere.some((x) => ms(x.first.fixAt) <= t && t <= ms(stayEnd(x)));
      const seq = [...gap, next.first];
      let away = 0;
      for (let i = 0; i + 1 < seq.length; i++) {
        const q = seq[i]!;
        const t0 = Math.max(from, ms(q.fixAt));
        const t1 = ms(seq[i + 1]!.fixAt);
        if (t1 > t0 && (distanceM(q, pin) > SITE_MAX_M || atOther(ms(q.fixAt)))) away += t1 - t0;
      }
      return round1(away / MIN);
    };
    /**
     * A departure is final (owner request 19 Oct 2026, the hold-back) once no later stay can be merged into
     * its stay any more: the truck reached the depot (its trip ended); or, before it came back to the pin as
     * a stop, it went beyond SITE_MAX_M or the trail followed it HOLD_DEPARTED_MIN (= MERGE_GAP_MIN). A
     * return to the pin that is a stop and was not merged (another open stop in between) leaves it final
     * too; one still in progress and not a stop yet keeps it held (it may become one). `stays`: every stay
     * of the stop's pin (stopping or not), in time order.
     * Review of 19 Oct 2026: a trail that is complete (input.trailComplete) HOLD_DEPARTED_MIN past the exit
     * with no point in it counts as followed too (the tracker went quiet with the truck parked near the site,
     * ignition never being sent), and after the truck-day's final pull every departure is final (no point
     * will ever come to merge it), so a held departure is never left unwritten for good.
     */
    const departureFinal = (exit: TrailPoint, pin: { lat: number; lng: number }, stays: readonly Stay[]): boolean => {
      const trip = own.map((i) => trips[i]!).find((t) => inside(t, exit.fixAt));
      if (trip?.inAt) return true;
      if (input.trailComplete?.final) return true;
      const e = ms(exit.fixAt);
      let farAt = Infinity;
      let covered = false;
      for (let i = (indexOf.get(exit) ?? points.length) + 1; i < points.length; i++) {
        const q = points[i]!;
        if (ms(q.fixAt) - e >= HOLD_DEPARTED_MIN * MIN) {
          covered = true;
          break;
        }
        if (distanceM(q, pin) > SITE_MAX_M) {
          farAt = ms(q.fixAt);
          break;
        }
      }
      const limit = Math.min(e + HOLD_DEPARTED_MIN * MIN, farAt);
      for (const c of stays) {
        const start = ms(c.first.fixAt);
        if (start <= e || start >= limit) continue;
        if (isStop(c, p)) return true;
        if (!c.exit) return false;
      }
      const quiet = !!input.trailComplete && ms(input.trailComplete.to) - e >= HOLD_DEPARTED_MIN * MIN;
      return covered || farAt < Infinity || quiet;
    };
    const summaryOf = (stay: Stay, pin: { lat: number; lng: number }, awayMin: number | null): StaySummary => ({
      exitRule: stay.exit ? stay.exitRule : null,
      exitKmh: stay.exit && stay.exit.speedKmh !== null && Number.isFinite(stay.exit.speedKmh) ? round1(stay.exit.speedKmh) : null,
      exitDistM: stay.exit ? Math.round(distanceM(stay.exit, pin)) : null,
      standMin: round1(stay.standMs / MIN),
      maxDistM: Math.round(stay.maxDistM),
      points: stay.points,
      frozenRuns: frozenIn(ms(stay.first.fixAt), ms(stayEnd(stay))),
      merged: stay.merged,
      awayMin,
      radiusM: stay.radiusM,
    });

    // In time order: the dwell a stay needs depends on whether its stop is the next pending one.
    const matched = new Set<number>();
    const staysOfStop = new Map<number, number>();
    const lastStay = new Map<number, Stay>();
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
      const before = lastStay.get(f.stop.sequence);
      lastStay.set(f.stop.sequence, f.stay);
      const stay = summaryOf(f.stay, pin, before ? awayBetween(before, f.stay, pin) : null);
      out.candidates.push({
        depotId: load.depotId,
        loadNo: load.loadNo,
        sequence: f.stop.sequence,
        kind: 'ARRIVED',
        at,
        observed: observedAt(f.stay.first, f.stay.gapBeforeSec),
        segmentStartAt: at,
        lat: f.stay.first.lat,
        lng: f.stay.first.lng,
        distanceM: Math.round(distanceM(f.stay.first, pin) * 10) / 10,
        stay,
      });
      if (f.stay.exit) {
        out.candidates.push({
          depotId: load.depotId,
          loadNo: load.loadNo,
          sequence: f.stop.sequence,
          kind: 'DEPARTED',
          at: f.stay.exit.fixAt,
          observed: observedAt(f.stay.exit, f.stay.gapBeforeExitSec),
          segmentStartAt: at,
          lat: f.stay.exit.lat,
          lng: f.stay.exit.lng,
          distanceM: Math.round(distanceM(f.stay.exit, pin) * 10) / 10,
          final: departureFinal(f.stay.exit, pin, perStop.find((r) => r.stop.sequence === f.stop.sequence)?.all ?? []),
          stay,
        });
      }
    }
    // The short stays last: a fact for later analysis, the first to go when the facts are cut (stop-events.ts gpsFactsOf).
    out.ambiguities.push(...shortDwell);
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
