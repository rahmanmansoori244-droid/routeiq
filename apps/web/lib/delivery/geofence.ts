/**
 * The automatic stop timer (owner request 4 Oct 2026, spec section 7): pure, browser-safe, unit-tested
 * with synthetic tracks (tests/lib/geofence.spec.ts). The driver page feeds it every position it gets
 * (watchPosition), a 5-second tick and every visibility change; it answers with arrival and departure
 * events and the prompts to show. Its only import is distanceM (pure).
 *
 * Why it is careful: a browser delivers positions only while the page is visible. The driver leaves
 * the page for Maps and the camera, and the screen locks between stops. So the tracker tells an
 * arrival it SAW (the truck was seen outside, then inside: `observed`) from one it only FOUND when the
 * page came back (the first fix was already inside: `observed: false`, the "Arrived when?" prompt).
 * Only observed arrivals and departures feed measured unloading times and the on-time KPI.
 *
 * Privacy: fixes live only in this state (the latest one, the candidate starts and the "seen outside"
 * times). Nothing here is stored or sent except the one position attached to an event.
 */
import { distanceM } from '../dispatch/snapshots';

export interface GeofenceParams {
  /** TenantConfig.geofenceRadiusM (default 100, clamped 50..500). */
  radiusM: number;
  /** A departure needs radius + 50 m. */
  exitExtraM: number;
  /** Dwell for the expected stop (the first stop of the current trip without a result, in sequence). */
  arriveDwellMs: number;
  /** Dwell for any other pending stop: a wait at a roundabout is not an arrival. */
  otherDwellMs: number;
  departDwellMs: number;
  /** After a gap, an outside fix is confirmed by another one at least this much later (a departure not seen). */
  gapConfirmMs: number;
  /** A worse fix is ignored. */
  maxAccuracyM: number;
  /** An older fix cannot confirm anything; a longer silence is a gap. */
  maxFixAgeMs: number;
  /** 2.5 m/s (9 km/h): a faster fix is never "at the stop". */
  movingMps: number;
  /** At the depot this long after the trip's stops: suggest "Back at depot". */
  depotDwellMs: number;
}

export function geofenceParams(radiusM = 100): GeofenceParams {
  const r = Number.isFinite(radiusM) ? Math.min(500, Math.max(50, Math.round(radiusM))) : 100;
  return {
    radiusM: r,
    exitExtraM: 50,
    arriveDwellMs: 20_000,
    otherDwellMs: 90_000,
    departDwellMs: 60_000,
    gapConfirmMs: 20_000,
    maxAccuracyM: 250,
    maxFixAgeMs: 30_000,
    movingMps: 2.5,
    depotDwellMs: 120_000,
  };
}

export interface Fix {
  /** Date.now() read inside the watchPosition callback: the device clock (spec section 13.3). */
  at: number;
  /** position.timestamp: diagnostics only, never read by a rule (some phones fill it from the GNSS clock). */
  gpsAt: number | null;
  lat: number;
  lng: number;
  accuracyM: number;
  speedMps: number | null;
}

export interface TrackStop {
  /** `${loadNo}:${sequence}` */
  key: string;
  loadNo: number;
  sequence: number;
  lat: number;
  lng: number;
  /** The result time (server, or a result still queued on the phone); null = no result. */
  doneAt: number | null;
  /** The first stop of the current trip without a result, in sequence. */
  expected: boolean;
  /** Pin within radius + exitExtra of the depot pin: manual arrival only. */
  nearDepot: boolean;
  /** The stop has an arrival or a result (the "Back at depot?" suggestion needs one on the trip). */
  visited?: boolean;
}

export interface TrackInput {
  now: number;
  fix: Fix | null;
  visible: boolean;
  stops: TrackStop[];
  depot: { lat: number; lng: number } | null;
}

export type Zone = 'IN' | 'OUT' | 'NEAR' | 'IGNORED';

/**
 * The zone of one fix for one pin (spec section 7.2), accuracy-aware: IN with an allowance bounded at
 * half the radius (a coarse fix never makes an arrival), and OUT only when the whole error circle is
 * past radius + 50 m (no bound: a coarse fix whose circle covers the pin is never OUT, it is NEAR). A
 * moving truck is never IN.
 */
export function zoneOf(fix: Pick<Fix, 'lat' | 'lng' | 'accuracyM' | 'speedMps'>, pin: { lat: number; lng: number }, p: GeofenceParams): Zone {
  if (!Number.isFinite(fix.accuracyM) || fix.accuracyM > p.maxAccuracyM || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return 'IGNORED';
  const accuracy = Math.max(0, fix.accuracyM);
  const allowance = Math.min(accuracy, p.radiusM / 2);
  const d = distanceM(fix, pin);
  if (d <= p.radiusM + allowance && !(fix.speedMps != null && fix.speedMps > p.movingMps)) return 'IN';
  if (d - accuracy > p.radiusM + p.exitExtraM) return 'OUT';
  return 'NEAR';
}

/**
 * A fix that shows the truck was outside a stop (the "seen outside" an observed arrival needs): OUT,
 * or NEAR with an accuracy of half the radius or better. A coarse NEAR fix proves nothing.
 */
function seenOutsideBy(z: Zone, fix: Pick<Fix, 'accuracyM'>, p: GeofenceParams): boolean {
  return z === 'OUT' || (z === 'NEAR' && fix.accuracyM <= p.radiusM / 2);
}

interface Cand {
  key: string;
  since: number;
  observed: boolean;
  fix: Fix;
}

interface Common {
  lastFixAt: number | null;
  /** In a gap now (the page was hidden, or no usable fix for maxFixAgeMs). */
  gap: boolean;
  /** When the latest gap began (an arrival is observed only without a gap since its stop was seen outside). */
  gapAt: number | null;
  /** The last usable fix time at which each pending stop of the trip was NOT inside. */
  seenOutside: Record<string, number>;
  /** Inside the depot zone since (the "Back at depot?" suggestion). */
  depotSince: number | null;
  depotPrompted: boolean;
}

export interface SeekingState extends Common {
  phase: 'SEEKING';
  cand: Cand | null;
  /** Two or more pending stops inside together: the driver chooses (the "Which customer?" prompt). */
  ambiguous: { keys: string[]; since: number; fix: Fix; observed: Record<string, boolean>; prompted: boolean } | null;
}

export interface AtStopState extends Common {
  phase: 'AT_STOP';
  key: string;
  arrivedAt: number;
  observed: boolean;
  /** The last fix inside this stop (a departure seen only after a gap is dated here: a lower bound). */
  lastInAt: number | null;
  lastInFix: Fix | null;
  leaving: { since: number; fix: Fix } | null;
  /** Neighbour shops: the next stop inside while this one is done and the truck did not move. */
  next: { key: string; since: number } | null;
  /** Fixes continuous (no gap) since then; null right after a gap. */
  cleanSince: number | null;
  /** An OUT fix for this stop after its result. */
  outSinceDone: boolean;
  /** Another pending stop inside while leaving this one (two shops close together): its arrival keeps its time. */
  ahead: Cand | null;
  /** Rebuilt after a reload (restoreTracker): it may leave without having been seen inside. */
  restored: boolean;
  /**
   * After a gap: the first outside fix, waiting for a second one gapConfirmMs later in the same
   * visible period (null = none; every new gap clears it).
   */
  gapOut: number | null;
}

export type TrackerState = SeekingState | AtStopState;

export type TrackEvent =
  | { type: 'ARRIVED'; key: string; at: number; observed: boolean; resumed?: boolean; chained?: boolean; chosen?: boolean; from?: string; fix: Fix | null }
  | { type: 'DEPARTED'; key: string; at: number; reason: 'LEFT' | 'NEXT_STOP'; gap?: boolean; fix: Fix | null };

export type TrackPrompt = { kind: 'WHICH_CUSTOMER'; keys: string[] } | { kind: 'ARRIVED_WHEN'; key: string } | { kind: 'BACK_AT_DEPOT' };

export interface StepResult {
  state: TrackerState;
  events: TrackEvent[];
  prompts: TrackPrompt[];
}

function common(): Common {
  return { lastFixAt: null, gap: false, gapAt: null, seenOutside: {}, depotSince: null, depotPrompted: false };
}

export function initialTracker(): TrackerState {
  return { phase: 'SEEKING', ...common(), cand: null, ambiguous: null };
}

function commonOf(s: TrackerState): Common {
  return { lastFixAt: s.lastFixAt, gap: s.gap, gapAt: s.gapAt, seenOutside: { ...s.seenOutside }, depotSince: s.depotSince, depotPrompted: s.depotPrompted };
}

function seeking(c: Common, cand: Cand | null = null): SeekingState {
  return { phase: 'SEEKING', ...c, cand, ambiguous: null };
}

function atStop(c: Common, key: string, arrivedAt: number, observed: boolean, fix: Fix | null, clean: number | null, restored = false): AtStopState {
  return {
    phase: 'AT_STOP',
    ...c,
    key,
    arrivedAt,
    observed,
    lastInAt: fix ? fix.at : null,
    lastInFix: fix,
    leaving: null,
    next: null,
    cleanSince: clean,
    outSinceDone: false,
    ahead: null,
    restored,
    gapOut: null,
  };
}

/** Seen outside recently enough, and with no gap since, for an arrival at `t` to count as seen. */
function observedAt(c: Common, key: string, t: number, p: GeofenceParams): boolean {
  const out = c.seenOutside[key];
  if (out === undefined) return false;
  if (t - out > p.maxFixAgeMs) return false;
  return !(c.gapAt !== null && c.gapAt >= out);
}

function candidates(stops: TrackStop[]): TrackStop[] {
  return stops.filter((s) => s.doneAt === null && !s.nearDepot);
}

/** The SEEKING rules on one usable fix. Mutates `st` (a fresh copy) and pushes events and prompts. */
function seekOnFix(st: SeekingState, input: TrackInput & { fix: Fix }, p: GeofenceParams, events: TrackEvent[], prompts: TrackPrompt[]): TrackerState {
  const { fix, now } = input;
  const cands = candidates(input.stops);
  const zones = new Map(cands.map((s) => [s.key, zoneOf(fix, s, p)]));
  for (const s of cands) {
    if (seenOutsideBy(zones.get(s.key)!, fix, p)) st.seenOutside[s.key] = fix.at;
  }
  const inside = cands.filter((s) => zones.get(s.key) === 'IN');
  if (inside.length >= 2) {
    const keys = inside.map((s) => s.key).sort();
    if (!st.ambiguous || st.ambiguous.keys.join('|') !== keys.join('|')) {
      const observed: Record<string, boolean> = {};
      for (const k of keys) observed[k] = observedAt(st, k, fix.at, p);
      st.ambiguous = { keys, since: fix.at, fix, observed, prompted: false };
    }
    st.cand = null;
    if (!st.ambiguous.prompted && now - st.ambiguous.since >= p.arriveDwellMs) {
      st.ambiguous = { ...st.ambiguous, prompted: true };
      prompts.push({ kind: 'WHICH_CUSTOMER', keys: st.ambiguous.keys });
    }
    return st;
  }
  st.ambiguous = null;
  const s1 = inside[0] ?? null;
  if (!s1) {
    st.cand = null;
    return st;
  }
  if (st.cand?.key !== s1.key) st.cand = { key: s1.key, since: fix.at, observed: observedAt(st, s1.key, fix.at, p), fix };
  const dwell = s1.expected ? p.arriveDwellMs : p.otherDwellMs;
  if (st.cand && now - st.cand.since >= dwell) {
    const c = st.cand;
    events.push({ type: 'ARRIVED', key: c.key, at: c.since, observed: c.observed, ...(c.observed ? {} : { resumed: true }), fix: c.fix });
    if (!c.observed && input.visible) prompts.push({ kind: 'ARRIVED_WHEN', key: c.key });
    const next = atStop(commonOf(st), c.key, c.since, c.observed, fix, fix.at);
    return next;
  }
  return st;
}

function nearestIn(stops: TrackStop[], fix: Fix): TrackStop | null {
  let best: TrackStop | null = null;
  let bestD = Infinity;
  for (const s of stops) {
    const d = distanceM(fix, s);
    if (d < bestD || (d === bestD && s.expected)) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** The AT_STOP rules on one usable fix. */
function atStopOnFix(st: AtStopState, input: TrackInput & { fix: Fix }, p: GeofenceParams, events: TrackEvent[], prompts: TrackPrompt[]): TrackerState {
  const { fix, now } = input;
  const stop = input.stops.find((s) => s.key === st.key);
  if (!stop) return seekOnFix(seeking(commonOf(st)), input, p, events, prompts); // the trip moved on
  const others = candidates(input.stops).filter((s) => s.key !== st.key);
  const otherZones = new Map(others.map((s) => [s.key, zoneOf(fix, s, p)]));
  for (const s of others) {
    if (seenOutsideBy(otherZones.get(s.key)!, fix, p)) st.seenOutside[s.key] = fix.at;
  }
  const z = zoneOf(fix, stop, p);
  if (z === 'IN') {
    st.leaving = null;
    st.lastInAt = fix.at;
    st.lastInFix = fix;
    st.ahead = null;
  }
  if (z === 'OUT' && stop.doneAt !== null && fix.at > stop.doneAt) st.outSinceDone = true;
  if (z !== 'IN' && z !== 'IGNORED') {
    const inside = others.filter((s) => otherZones.get(s.key) === 'IN');
    const b = inside.length === 1 ? inside[0]! : null;
    st.ahead = b ? (st.ahead?.key === b.key ? st.ahead : { key: b.key, since: fix.at, observed: observedAt(st, b.key, fix.at, p), fix }) : null;
  }
  if (st.cleanSince === null) {
    if (z === 'OUT') {
      // After a gap (the camera, Maps, a locked screen) the first fix is often coarse or stale: one
      // outside fix proves nothing. A second outside fix gapConfirmMs later, with no fix inside or
      // near and no other gap between, confirms the truck left.
      st.gapOut ??= fix.at;
      if (fix.at - st.gapOut < p.gapConfirmMs) return st;
      // Confirmed. Seen inside before the gap: the departure was not seen, it is dated at the last
      // inside fix (a lower bound).
      if (st.lastInAt !== null) {
        events.push({ type: 'DEPARTED', key: st.key, at: st.lastInAt, reason: 'LEFT', gap: true, fix: st.lastInFix });
        return seekOnFix(seeking(commonOf(st), st.ahead), input, p, events, prompts);
      }
      // Never seen inside (a manual arrival, or a stop restored after a reload): nothing to date a
      // departure with. The tracker moves on silently (the result time ends the stop) once it has a
      // result, or at once for a restored stop.
      if (stop.doneAt !== null || st.restored) return seekOnFix(seeking(commonOf(st), st.ahead), input, p, events, prompts);
    } else if (z !== 'IGNORED') {
      st.gapOut = null;
    }
  }
  if (st.cleanSince === null) st.cleanSince = fix.at;
  if (z === 'OUT') st.leaving ??= { since: fix.at, fix };
  if (st.leaving && now - st.leaving.since >= p.departDwellMs && z !== 'IN') {
    // A manual arrival never seen inside leaves only after its result (a wrong pin must not end it),
    // silently: the result time ends it. A restored stop leaves silently too.
    if (st.lastInAt !== null || stop.doneAt !== null || st.restored) {
      if (st.lastInAt !== null) events.push({ type: 'DEPARTED', key: st.key, at: st.leaving.since, reason: 'LEFT', fix: st.leaving.fix });
      const departedAt = st.leaving.since;
      const ahead = st.ahead ? { ...st.ahead, since: Math.max(st.ahead.since, departedAt) } : null;
      return seekOnFix(seeking(commonOf(st), ahead), input, p, events, prompts);
    }
  }
  // Neighbour shops (a mall): only when the truck demonstrably did not move since the result.
  if (stop.doneAt !== null && z !== 'OUT' && !st.outSinceDone && st.cleanSince !== null && st.cleanSince <= stop.doneAt) {
    const near = others.filter((s) => otherZones.get(s.key) === 'IN' && distanceM(s, stop) <= p.radiusM + p.exitExtraM);
    const b = nearestIn(near, fix);
    st.next = b ? (st.next?.key === b.key ? st.next : { key: b.key, since: fix.at }) : null;
    if (st.next && now - st.next.since >= p.arriveDwellMs) {
      const at = stop.doneAt;
      events.push({ type: 'DEPARTED', key: st.key, at, reason: 'NEXT_STOP', fix });
      events.push({ type: 'ARRIVED', key: st.next.key, at, observed: true, chained: true, from: st.key, fix });
      return atStop(commonOf(st), st.next.key, at, true, fix, fix.at);
    }
  } else {
    st.next = null;
  }
  return st;
}

function copy(state: TrackerState): TrackerState {
  return state.phase === 'SEEKING'
    ? { ...state, seenOutside: { ...state.seenOutside }, cand: state.cand ? { ...state.cand } : null, ambiguous: state.ambiguous ? { ...state.ambiguous } : null }
    : { ...state, seenOutside: { ...state.seenOutside }, leaving: state.leaving ? { ...state.leaving } : null, next: state.next ? { ...state.next } : null, ahead: state.ahead ? { ...state.ahead } : null };
}

/**
 * One step of the tracker (spec section 7.3). The hook calls it on every fix, on a 5-second tick and
 * on every visibility change. A fix is used only when it is fresh (maxFixAgeMs), accurate enough
 * (maxAccuracyM) and newer than the latest gap; without one no transition happens and the gap is
 * recorded.
 */
export function step(state: TrackerState, input: TrackInput, p: GeofenceParams): StepResult {
  let st = copy(state);
  const events: TrackEvent[] = [];
  const prompts: TrackPrompt[] = [];
  const { fix, now } = input;
  const fresh = !!fix && now - fix.at <= p.maxFixAgeMs && fix.accuracyM <= p.maxAccuracyM && Number.isFinite(fix.lat) && Number.isFinite(fix.lng);
  const afterGap = !!fix && !(st.gap && st.gapAt !== null && fix.at <= st.gapAt);
  const usable = input.visible && fresh && afterGap;
  if (!input.visible || (!usable && st.lastFixAt !== null && now - st.lastFixAt > p.maxFixAgeMs)) {
    if (!st.gap) {
      st.gap = true;
      st.gapAt = now;
    }
    if (st.phase === 'AT_STOP') {
      st.cleanSince = null;
      // Both outside fixes that confirm a departure must fall in the same visible period: a single
      // bad fix after the camera, then another after Retake, is not a departure.
      st.gapOut = null;
    }
    st.depotSince = null;
    return { state: st, events, prompts };
  }
  if (!usable || !fix) return { state: st, events, prompts };
  const withFix = { ...input, fix };
  st = st.phase === 'SEEKING' ? seekOnFix(st, withFix, p, events, prompts) : atStopOnFix(st, withFix, p, events, prompts);
  st.gap = false;
  st.lastFixAt = fix.at;
  // "Back at depot?": inside the depot zone for depotDwellMs after the trip's stops. Nothing is recorded.
  if (input.depot && input.stops.some((s) => s.visited || s.doneAt !== null) && zoneOf(fix, input.depot, p) === 'IN') {
    st.depotSince ??= fix.at;
    if (!st.depotPrompted && now - st.depotSince >= p.depotDwellMs) {
      st.depotPrompted = true;
      prompts.push({ kind: 'BACK_AT_DEPOT' });
    }
  } else {
    st.depotSince = null;
    st.depotPrompted = false;
  }
  return { state: st, events, prompts };
}

/** The driver's answer to "Which customer?": the chosen stop gets the time of the first common inside fix. */
export function chooseCustomer(state: TrackerState, key: string): StepResult {
  if (state.phase !== 'SEEKING' || !state.ambiguous || !state.ambiguous.keys.includes(key)) return { state, events: [], prompts: [] };
  const a = state.ambiguous;
  const observed = a.observed[key] ?? false;
  const ev: TrackEvent = { type: 'ARRIVED', key, at: a.since, observed, chosen: true, ...(observed ? {} : { resumed: true }), fix: a.fix };
  return { state: atStop(commonOf(state), key, a.since, observed, a.fix, state.gap ? null : a.since), events: [ev], prompts: [] };
}

/**
 * "I have arrived": AT_STOP at `now`, observed (the driver says so). Departure is still detected
 * automatically once the truck was seen inside, or after the stop's result.
 */
export function manualArrive(state: TrackerState, key: string, now: number): TrackerState {
  const c = commonOf(state);
  const clean = !c.gap && c.lastFixAt !== null ? now : null;
  return atStop(c, key, now, true, null, clean);
}

/** The tracker after a reload (spec section 7.3): a stop in progress comes back with its original arrival. */
export function restoreTracker(inProgress: { key: string; arrivedAt: number; observed: boolean } | null): TrackerState {
  if (!inProgress) return initialTracker();
  return atStop({ ...common(), gap: true, gapAt: inProgress.arrivedAt }, inProgress.key, inProgress.arrivedAt, inProgress.observed, null, null, true);
}

// ---------------------------------------------------------------------------------------
// The current trip and its stops (spec section 7.3)
// ---------------------------------------------------------------------------------------

export interface TripLoad {
  loadNo: number;
  status: string;
  departMin: number;
  /** Back at depot reported (on the server or still queued on the phone). */
  back: boolean;
}

/**
 * The trip the tracker watches: the DISPATCHED load with the HIGHEST load number that is not back at
 * the depot; else, once the driver tapped Start deliveries, the earliest LOCKED or LOADING load whose
 * planned departure is at most 30 min away or past (its events are HELD on the phone until it is
 * dispatched); else none.
 */
export function currentTrip(loads: readonly TripLoad[], local: { started: boolean; nowMin: number }): { loadNo: number; held: boolean } | null {
  const out = loads.filter((l) => l.status === 'DISPATCHED' && !l.back).sort((a, b) => b.loadNo - a.loadNo)[0];
  if (out) return { loadNo: out.loadNo, held: false };
  if (!local.started) return null;
  const waiting = loads
    .filter((l) => (l.status === 'LOCKED' || l.status === 'LOADING') && l.departMin - 30 <= local.nowMin)
    .sort((a, b) => a.departMin - b.departMin || a.loadNo - b.loadNo)[0];
  return waiting ? { loadNo: waiting.loadNo, held: true } : null;
}

/**
 * What the phone does with the position watch (and the screen wake lock) after the loads changed.
 * - STOP: the timer is on but there is no trip left to time (the last trip is back at the depot, or
 *   the one waited for is gone): the watch ends and the page shows the timer as off, so the phone
 *   does not keep the GPS running all day. `autoStopped` is then remembered.
 * - RESTART: the timer was stopped like that and a trip is on the road again (DISPATCHED, not held):
 *   the watch starts again without a tap (location is already allowed).
 * - NONE: nothing changes. A timer the driver stopped by hand (`autoStopped` false) is never restarted
 *   by itself, and nothing happens before the loads are known (`loadsKnown` false).
 */
export type TimerStep = 'STOP' | 'RESTART' | 'NONE';

export function timerStep(s: { on: boolean; trip: { held: boolean } | null; autoStopped: boolean; loadsKnown: boolean }): TimerStep {
  if (!s.loadsKnown) return 'NONE';
  if (s.on) return s.trip ? 'NONE' : 'STOP';
  return s.autoStopped && s.trip && !s.trip.held ? 'RESTART' : 'NONE';
}

export interface TripStopIn {
  key: string;
  sequence: number;
  lat: number | null;
  lng: number | null;
  doneAt: number | null;
  visited: boolean;
}

/** The tracker's stops of one trip: pins only; the expected stop; stops near the depot (manual only). */
export function trackStops(loadNo: number, stops: readonly TripStopIn[], depot: { lat: number; lng: number } | null, p: GeofenceParams): TrackStop[] {
  const sorted = [...stops].sort((a, b) => a.sequence - b.sequence);
  const expectedKey = sorted.find((s) => s.doneAt === null)?.key ?? null;
  return sorted
    .filter((s): s is TripStopIn & { lat: number; lng: number } => s.lat !== null && s.lng !== null && Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map((s) => ({
      key: s.key,
      loadNo,
      sequence: s.sequence,
      lat: s.lat,
      lng: s.lng,
      doneAt: s.doneAt,
      expected: s.key === expectedKey,
      nearDepot: !!depot && distanceM(s, depot) <= p.radiusM + p.exitExtraM,
      visited: s.visited,
    }));
}
