/**
 * Operations alerts (owner request 16 Oct 2026, rule R3 "a driver's ETA changes to more than 30 min
 * late"): where a dispatched load is now, worked out from the plan and the driver's taps. Pure. There is
 * no GPS trail in RouteIQ (map-lifecycle §0): the projection walks the stops in sequence and moves the
 * plan by what really happened.
 *
 * Every time is a whole minute from local midnight of the load's delivery date (it may pass 1440).
 *
 * - The start: the planned departure, or the Dispatch press when it came later (a press before the
 *   planned departure does not mean the truck left early). A press more than `lateDispatchMin` after the
 *   planned departure while no stop has any activity yet starts from the planned departure instead: the
 *   phone holds its taps until Dispatch (outcome-rules.ts) and they arrive in a burst afterwards, so the
 *   late press says little about when the truck left (critique M3). Real lateness then shows through the
 *   clock: a stop not reached is never expected before now.
 * - A DONE stop (it has a departure, a result, or a later stop has activity): its actual end. A stop
 *   with no activity while a later one has some is SKIPPED (out of order: the result is approximate).
 * - The stop IN PROGRESS (arrived, no end, nothing later): it ends at max(now, unloading start + the
 *   planned unloading), the unloading starting at max(arrival, window start).
 * - A PENDING stop: the planned leg from the previous stop (etaMin - the previous planned departure; a
 *   road break planned on the way is inside it) added to the previous projected departure, never before
 *   now; it waits for its planned unloading start when the plan waited (serviceStartMin > etaMin: the
 *   receiving window); delay = projected arrival - planned arrival.
 * - The return: the last projected departure + the planned way back.
 */

export interface ProjectionStopIn {
  sequence: number;
  /** The plan: arrival, unloading start and end (RouteAssignment). */
  etaMin: number | null;
  serviceStartMin: number | null;
  departureMin: number | null;
  /** The planned unloading (the visit's copy, else departureMin - serviceStartMin). */
  plannedServiceMin: number | null;
  windowStartMin: number | null;
  /** What happened, as minutes of the delivery day; null = not known. */
  arrivedMin: number | null;
  /** The end of the stop: the departure, else the driver's result time (an office result recorded later is not the end). */
  endMin: number | null;
  /** A result is recorded (by the driver or the office). */
  hasOutcome: boolean;
}

export interface ProjectionIn {
  departMin: number;
  returnMin: number;
  /** When Dispatch was pressed (statusChangedAt of a DISPATCHED load), minutes of the delivery day. */
  dispatchMin: number | null;
  nowMin: number;
  /** A Dispatch press later than the planned departure by more than this, before any stop activity, starts from the planned departure (M3). */
  lateDispatchMin?: number | null;
  /** In sequence. */
  stops: readonly ProjectionStopIn[];
}

export type ProjectedState = 'DONE' | 'SKIPPED' | 'IN_PROGRESS' | 'PENDING';

export interface ProjectedStop {
  sequence: number;
  state: ProjectedState;
  /** PENDING: the arrival the planned legs give, not held back by the clock (DRIVER_SILENT reads it). */
  expectedArrMin: number | null;
  /** PENDING: max(expected, now). DONE / IN_PROGRESS: the actual arrival. SKIPPED: null. */
  arrMin: number | null;
  /** When unloading starts (PENDING: projected) and when the stop ends (projected unless DONE). */
  startMin: number | null;
  depMin: number | null;
  /** arrMin - etaMin; null without both. */
  delayMin: number | null;
  /** PENDING: the clock holds the arrival back (the truck has not arrived although the plan says it should have). */
  clockBound: boolean;
}

export interface Projection {
  stops: ProjectedStop[];
  /** The first PENDING stop (R3 and the next stop's window check), or null. */
  next: ProjectedStop | null;
  /** The stop being unloaded now, or null. */
  inProgress: ProjectedStop | null;
  /** The projected return to the depot. */
  returnMin: number;
  /** A stop was skipped (out of order): the times are rough ("about"). */
  approximate: boolean;
  /** M3: the projection starts from the planned departure, not the late Dispatch press. */
  fromPlannedDeparture: boolean;
}

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** The projection of one dispatched load (see the file comment). */
export function projectLoad(input: ProjectionIn): Projection {
  const { departMin, returnMin, nowMin } = input;
  const stops = input.stops;
  const activity = stops.map((s) => has(s.arrivedMin) || has(s.endMin) || s.hasOutcome);
  // laterActivity[i]: a stop after i has activity.
  const laterActivity = new Array<boolean>(stops.length).fill(false);
  for (let i = stops.length - 2; i >= 0; i--) laterActivity[i] = laterActivity[i + 1]! || activity[i + 1]!;
  const noActivity = !activity.some(Boolean);

  let fromPlannedDeparture = false;
  let prevProjDep: number;
  if (!has(input.dispatchMin)) prevProjDep = Math.max(nowMin, departMin);
  else if (noActivity && has(input.lateDispatchMin) && input.dispatchMin - departMin > input.lateDispatchMin) {
    prevProjDep = departMin;
    fromPlannedDeparture = true;
  } else prevProjDep = Math.max(input.dispatchMin, departMin);
  let prevPlanDep = departMin;

  const out: ProjectedStop[] = [];
  let approximate = false;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i]!;
    const service = has(s.plannedServiceMin) ? Math.max(0, s.plannedServiceMin) : has(s.departureMin) && has(s.serviceStartMin) ? Math.max(0, s.departureMin - s.serviceStartMin) : 0;
    const leg = has(s.etaMin) ? Math.max(0, s.etaMin - prevPlanDep) : 0;
    const done = has(s.endMin) || s.hasOutcome || (has(s.arrivedMin) && laterActivity[i]!);
    let p: ProjectedStop;
    if (done) {
      const arr = has(s.arrivedMin) ? s.arrivedMin : null;
      // The end: the departure or result; else (moved on without one) the arrival + the planned unloading;
      // else (an office result alone) as planned from the previous stop.
      const dep = has(s.endMin) ? s.endMin : arr !== null ? arr + service : prevProjDep + leg + service;
      p = { sequence: s.sequence, state: 'DONE', expectedArrMin: null, arrMin: arr, startMin: arr, depMin: dep, delayMin: arr !== null && has(s.etaMin) ? arr - s.etaMin : null, clockBound: false };
    } else if (!activity[i] && laterActivity[i]) {
      approximate = true;
      p = { sequence: s.sequence, state: 'SKIPPED', expectedArrMin: null, arrMin: null, startMin: null, depMin: prevProjDep, delayMin: null, clockBound: false };
    } else if (has(s.arrivedMin)) {
      const start = has(s.windowStartMin) ? Math.max(s.arrivedMin, s.windowStartMin) : s.arrivedMin;
      p = {
        sequence: s.sequence,
        state: 'IN_PROGRESS',
        expectedArrMin: null,
        arrMin: s.arrivedMin,
        startMin: start,
        depMin: Math.max(nowMin, start + service),
        delayMin: has(s.etaMin) ? s.arrivedMin - s.etaMin : null,
        clockBound: false,
      };
    } else {
      const expected = prevProjDep + leg;
      const arr = Math.max(expected, nowMin);
      const plannedWait = has(s.serviceStartMin) && has(s.etaMin) && s.serviceStartMin > s.etaMin ? s.serviceStartMin : null;
      const start = plannedWait !== null ? Math.max(arr, plannedWait) : arr;
      p = {
        sequence: s.sequence,
        state: 'PENDING',
        expectedArrMin: expected,
        arrMin: arr,
        startMin: start,
        depMin: start + service,
        delayMin: has(s.etaMin) ? arr - s.etaMin : null,
        clockBound: nowMin > expected,
      };
    }
    out.push(p);
    if (has(s.departureMin)) prevPlanDep = s.departureMin;
    else if (has(s.etaMin)) prevPlanDep = s.etaMin + service;
    if (p.depMin !== null) prevProjDep = p.depMin;
  }
  const back = Math.max(0, returnMin - prevPlanDep);
  return {
    stops: out,
    next: out.find((p) => p.state === 'PENDING') ?? null,
    inProgress: out.find((p) => p.state === 'IN_PROGRESS') ?? null,
    returnMin: prevProjDep + back,
    approximate,
    fromPlannedDeparture,
  };
}
