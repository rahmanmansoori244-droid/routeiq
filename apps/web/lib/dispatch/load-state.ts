/**
 * Load lifecycle rules. Physical reality drives them: the warehouse loads a truck's Load 1
 * before Load 2, and nothing on the road can be re-planned (no trustworthy live position).
 *
 *   PLANNED  -> LOCKED        planner; all earlier loads of the truck must already be frozen
 *   LOCKED   -> PLANNED       planner (unlock); later loads of the truck must still be PLANNED
 *   LOCKED   -> LOADING       planner
 *   LOADING  -> LOCKED        planner (loading paused/cancelled)
 *   LOCKED | LOADING -> DISPATCHED   supervisor; earlier loads must be DISPATCHED/COMPLETED
 *   DISPATCHED -> COMPLETED   supervisor
 *   DISPATCHED / COMPLETED    immutable otherwise
 *
 * "Frozen" = anything but PLANNED: a re-plan keeps frozen loads exactly as they are.
 */
export type LoadStatusName = 'PLANNED' | 'LOCKED' | 'LOADING' | 'DISPATCHED' | 'COMPLETED';

export const FROZEN: ReadonlySet<LoadStatusName> = new Set(['LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED']);
export const ON_ROAD: ReadonlySet<LoadStatusName> = new Set(['DISPATCHED', 'COMPLETED']);

export function isFrozen(s: LoadStatusName) {
  return FROZEN.has(s);
}

export interface LoadRef {
  id: string;
  loadNo: number;
  status: LoadStatusName;
}

export type TransitionCheck =
  | { ok: true; role: 'PLANNER' | 'SUPERVISOR' }
  | { ok: false; reason: string };

const ALLOWED: Record<LoadStatusName, LoadStatusName[]> = {
  PLANNED: ['LOCKED'],
  LOCKED: ['PLANNED', 'LOADING', 'DISPATCHED'],
  LOADING: ['LOCKED', 'DISPATCHED'],
  DISPATCHED: ['COMPLETED'],
  COMPLETED: [],
};

export function checkTransition(load: LoadRef, sameTruckLoads: LoadRef[], to: LoadStatusName): TransitionCheck {
  if (load.status === to) return { ok: false, reason: `Load is already ${to}.` };
  if (!ALLOWED[load.status].includes(to)) {
    if (ON_ROAD.has(load.status)) {
      return { ok: false, reason: `Load ${load.loadNo} is ${load.status} and can no longer be changed.` };
    }
    return { ok: false, reason: `A ${load.status} load cannot move to ${to}.` };
  }
  const earlier = sameTruckLoads.filter((l) => l.id !== load.id && l.loadNo < load.loadNo);
  const later = sameTruckLoads.filter((l) => l.id !== load.id && l.loadNo > load.loadNo);
  if (to === 'LOCKED' && load.status === 'PLANNED') {
    const open = earlier.filter((l) => !isFrozen(l.status));
    if (open.length) {
      return { ok: false, reason: `Lock Load ${open.map((l) => l.loadNo).join(', ')} of this truck first - loads are loaded in order.` };
    }
  }
  if (to === 'PLANNED') {
    const frozenLater = later.filter((l) => isFrozen(l.status));
    if (frozenLater.length) {
      return { ok: false, reason: `Unlock Load ${frozenLater.map((l) => l.loadNo).join(', ')} of this truck first.` };
    }
  }
  if (to === 'DISPATCHED') {
    const notOut = earlier.filter((l) => !ON_ROAD.has(l.status));
    if (notOut.length) {
      return { ok: false, reason: `Dispatch Load ${notOut.map((l) => l.loadNo).join(', ')} of this truck first.` };
    }
  }
  const role = to === 'DISPATCHED' || to === 'COMPLETED' ? 'SUPERVISOR' : 'PLANNER';
  return { ok: true, role };
}

/**
 * Load changes allowed on a plan version that has no applied plan (no chosen option): the way
 * back - unlock (LOCKED -> PLANNED) and back to locked (LOADING -> LOCKED) - so the day can be
 * optimized again, and marking a load that is already out COMPLETED (DISPATCHED -> COMPLETED:
 * it changes no plan facts and needs no reconciliation). Such a version has no summary or
 * reconciliation, so nothing can be locked, loaded or dispatched from it. Review F03.
 */
export function scenariolessTransitionAllowed(from: LoadStatusName, to: LoadStatusName): boolean {
  return (from === 'LOCKED' && to === 'PLANNED') || (from === 'LOADING' && to === 'LOCKED') || (from === 'DISPATCHED' && to === 'COMPLETED');
}

/**
 * A load kept unchanged from the previous plan version: carried over by a re-plan AND frozen
 * (locked, loading or out). A re-plan also copies the PLANNED loads (copy-forward), so a failed
 * or running re-plan still has a usable plan; those copies are not "kept" - the next optimization
 * replaces them. Drives the "kept" labels (plan screen, driver sheets, workbook) and the change
 * summary's "locked/dispatched loads preserved".
 */
export function isCarriedFrozen(l: { status: string; carriedFromLoadId: string | null }): boolean {
  return l.carriedFromLoadId !== null && l.status !== 'PLANNED';
}

/** Loads that can still be unlocked (LOCKED) or put back to locked (LOADING): the way back to a re-plan. */
export function canStepBack(statuses: readonly string[]): boolean {
  return statuses.some((s) => s === 'LOCKED' || s === 'LOADING');
}

export interface DriverOnLoad {
  truckId: string;
  loadNo: number;
  driverId: string | null;
  /** The trip's planned time away in that version (minutes from midnight), when known. */
  departMin?: number;
  returnMin?: number;
  /**
   * Who chose this driver by hand, and when (PlanLoad.driverSetById / driverSetAt): set by the
   * dispatcher's driver change (setDriverTx), carried by a re-plan's copies and by applyScenario to
   * the same truck and trip. Null or absent: RouteIQ filled the driver in. `driverSetAt` is the
   * marker (the user id is cleared when that user is deleted).
   */
  driverSetById?: string | null;
  driverSetAt?: Date | null;
}

/** The dispatcher chose this load's driver by hand (or it was carried from such a choice for the same truck and trip). */
export function isHandSetDriver(l: Pick<DriverOnLoad, 'driverId' | 'driverSetAt'>): boolean {
  return l.driverId !== null && l.driverSetAt != null;
}

/**
 * Driver for a (re-)planned load of `truckId`, taken from existing loads: the same trip if it
 * had a driver, else (unless `exactOnly`) the nearest trip of that truck (the earlier one on a
 * tie - the driver who did Load 1 usually takes Load 2). Only drivers in `usable` (active, this
 * tenant) count. A load set to "No driver" gives nothing: the next source decides.
 */
export function pickLoadDriver(
  loads: DriverOnLoad[],
  truckId: string,
  loadNo: number,
  usable: ReadonlySet<string>,
  opts: { exactOnly?: boolean } = {},
): string | null {
  const withDriver = loads.filter(
    (l) => l.truckId === truckId && l.driverId !== null && usable.has(l.driverId) && (!opts.exactOnly || l.loadNo === loadNo),
  );
  withDriver.sort((a, b) => Math.abs(a.loadNo - loadNo) - Math.abs(b.loadNo - loadNo) || a.loadNo - b.loadNo);
  return withDriver[0]?.driverId ?? null;
}

/** A load of a version as the re-plan driver rules read it. */
export interface VersionLoadDriver extends DriverOnLoad {
  status: string;
  /** The parent version's load this one was copied from by a re-plan (copy-forward), or null. */
  carriedFromLoadId: string | null;
}

const sameInstant = (a: Date | null | undefined, b: Date | null | undefined) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * This version's own driver evidence for its re-plan (the `now` of planReplanDrivers, step 1):
 * its loads, except the PLANNED copies that the re-plan carried from the parent (copy-forward)
 * untouched - the parent load's driver and hand-set marker unchanged. Nobody decided those drivers
 * on this version, so they stay parent evidence (step 2) - as before copy-forward, when a new
 * version held only its frozen copies - and the re-plan job and "Use instead" read the same
 * evidence the same way. A driver the dispatcher set on a copy (after a failed re-plan) is this
 * version's own choice and counts. Frozen loads always count.
 */
export function ownDriverEvidence<L extends VersionLoadDriver>(now: readonly L[], parent: readonly (DriverOnLoad & { id: string })[]): L[] {
  const parentLoad = new Map(parent.map((p) => [p.id, p]));
  return now.filter((l) => {
    const p = l.status === 'PLANNED' && l.carriedFromLoadId !== null ? parentLoad.get(l.carriedFromLoadId) : undefined;
    return !(p && p.driverId === l.driverId && sameInstant(p.driverSetAt, l.driverSetAt));
  });
}

/** A load's driver and planned time away from the depot (minutes from midnight). */
export interface DriverTime {
  truckId: string;
  driverId: string | null;
  departMin: number;
  returnMin: number;
}

/** Loads of two different trucks whose planned times overlap: one driver cannot drive both. */
export function timesClash(a: Omit<DriverTime, 'driverId'>, b: Omit<DriverTime, 'driverId'>): boolean {
  return a.truckId !== b.truckId && a.departMin < b.returnMin && b.departMin < a.returnMin;
}

export interface ReplanLoad extends Omit<DriverTime, 'driverId'> {
  /** Any id unique among the new loads (the result is keyed by it). */
  key: string;
  loadNo: number;
  defaultDriverId: string | null;
}

/** The driver a re-plan gives a new load, and the hand-set marker it carries (null: RouteIQ's pick). */
export interface ReplanDriver {
  driverId: string | null;
  driverSetById: string | null;
  driverSetAt: Date | null;
}

/**
 * Why a trip's driver differs from its evidence (the same truck and trip before this plan):
 * - FILLED: the trip had no driver;
 * - INACTIVE: that driver is no longer active (or no longer of this tenant);
 * - KEPT_LOAD: that driver is on a kept (locked, loading or dispatched) load at the new time;
 * - OTHER_TRIP: that driver is on another trip of this plan at the new time;
 * - TRIP_GONE: the dispatcher chose that driver by hand for a truck and trip this plan does not
 *   have (planReplanDrivers' `parked`); the choice stays with the version and comes back with
 *   the trip.
 */
export type DriverChangeReason = 'FILLED' | 'INACTIVE' | 'KEPT_LOAD' | 'OTHER_TRIP' | 'TRIP_GONE';

/** A new load whose driver is not the one its truck and trip had before this plan. */
export interface ReplanDriverChange {
  key: string;
  truckId: string;
  loadNo: number;
  fromDriverId: string | null;
  toDriverId: string | null;
  reason: DriverChangeReason;
  /** The overlapping load of `fromDriverId` (KEPT_LOAD, OTHER_TRIP). */
  other: { truckId: string; loadNo: number | null } | null;
}

/**
 * Drivers for the new loads of a (re-)plan, and the trips whose driver changed. `now` = the loads
 * of this version before its PLANNED loads are replaced, without untouched copy-forward copies
 * (ownDriverEvidence), `parent` = the loads of the version it was re-planned from, `kept` = the
 * frozen loads that stay in this version (their drivers do not change), `parked` = the hand-set
 * choices kept with this version for a truck and trip its plan did not have (the `parked` this
 * function returned when that plan was applied; a re-plan's version starts with its parent's).
 *
 * A trip's evidence is the same truck and trip before this plan: in this version, else parked with
 * it, else in the parent. Hand-set first: when that trip's driver was chosen by the dispatcher
 * (isHandSetDriver) and is still usable, the new load keeps it, with the marker, whatever it now
 * overlaps - another trip of that driver, or one of their kept loads; the overlap shows as the
 * yellow plan warning (driverClashes). The dispatcher decided; RouteIQ never drops that choice:
 * a hand-set choice whose truck and trip is in neither the new loads nor the kept loads is
 * returned in `parked`, for the caller to keep with the version and tell the dispatcher about
 * (TRIP_GONE); an option or re-plan that has that trip again gives it back, with the marker (or,
 * when that driver is no longer active, RouteIQ's pick and an INACTIVE change).
 *
 * Every other driver is RouteIQ's own pick, from the strongest evidence first:
 *   1. this version, same truck and trip   - the driver the dispatcher saw on that trip
 *   2. parent version, same truck and trip - e.g. trip 2 given to another driver before a late order
 *   3. the nearest trip of the truck in either version (this version's load wins for one trip)
 *   4. the truck's default driver
 * Each step runs over ALL new loads before the next one, so a weak guess on one truck (say its
 * default driver) never takes a driver that stronger evidence puts on another truck, and each step
 * takes the trips that moved least first, measured from the trip it reads (step 1: this version's
 * trip, step 2: the parent's, steps 3 and 4: the trip's evidence), stable, trips it cannot measure
 * last. So of two trips that now overlap with the same driver, the one that moved loses the driver
 * and goes to the next step, or stays without one for the dispatcher to fill - whatever order the
 * optimizer lists them in, and the same for the re-plan job (evidence from the parent) as for
 * "Use instead" (evidence from this version).
 *
 * A pick of RouteIQ's never overlaps a kept load of that driver (a kept load cannot move), nor
 * another trip RouteIQ gave that driver in this plan. The one overlap it keeps: the trip's own
 * driver (steps 1 and 2) next to a trip where the dispatcher chose the same driver by hand - the
 * clash that choice causes shows as the warning instead of RouteIQ dropping a driver by itself.
 * Steps 3 and 4 are guesses and never overlap any trip given out. Only drivers in `usable` (active,
 * this tenant) are ever picked. A truck's own trips never clash with each other (timesClash).
 */
export function planReplanDrivers(
  newLoads: ReplanLoad[],
  now: DriverOnLoad[],
  parent: DriverOnLoad[],
  kept: (DriverTime & { loadNo?: number })[],
  usable: ReadonlySet<string>,
  parked: DriverOnLoad[] = [],
): { drivers: Map<string, ReplanDriver>; changes: ReplanDriverChange[]; parked: DriverOnLoad[] } {
  const none = (): ReplanDriver => ({ driverId: null, driverSetById: null, driverSetAt: null });
  const out = new Map<string, ReplanDriver>(newLoads.map((l) => [l.key, none()]));
  const tripKey = (l: { truckId: string; loadNo: number }) => `${l.truckId}:${l.loadNo}`;
  const byTrip = (list: DriverOnLoad[]) => {
    const m = new Map<string, DriverOnLoad>();
    for (const l of list) if (!m.has(tripKey(l))) m.set(tripKey(l), l);
    return m;
  };
  const index = (list: DriverOnLoad[]) => {
    const m = byTrip(list);
    return (l: { truckId: string; loadNo: number }) => m.get(tripKey(l));
  };
  // Both versions' trips of each truck; a trip in this version replaces the parent's same trip.
  const inNow = new Set(now.map(tripKey));
  const either = [...now, ...parent.filter((l) => !inNow.has(tripKey(l)))];
  const nowTrip = index(now);
  const parentTrip = index(parent);
  // A trip's evidence (the same truck and trip before this plan): this version, then the hand-set
  // choices parked with it, then the parent.
  const beforeTrips = byTrip([...now, ...parked.filter((l) => isHandSetDriver(l)), ...parent]);
  const evidence = (l: { truckId: string; loadNo: number }) => beforeTrips.get(tripKey(l));
  // How far a trip moved from the trip `src` reads (unknown: last), and the trips by that, stable.
  const byMoved = (src: (l: ReplanLoad) => DriverOnLoad | undefined) => {
    const moved = (l: ReplanLoad) => {
      const b = src(l);
      return b && b.departMin !== undefined && b.returnMin !== undefined ? Math.abs(l.departMin - b.departMin) + Math.abs(l.returnMin - b.returnMin) : Number.POSITIVE_INFINITY;
    };
    return [...newLoads].sort((a, b) => {
      const x = moved(a);
      const y = moved(b);
      return x === y ? 0 : x < y ? -1 : 1;
    });
  };
  const frozen = kept.filter((k) => k.driverId !== null);
  // Loads given a driver in this plan; handSet = the dispatcher's choice (kept whatever it overlaps).
  const given: (DriverTime & { loadNo: number; handSet: boolean })[] = [];

  // Hand-set: the dispatcher's choice for the truck and trip stays on it.
  for (const l of newLoads) {
    const e = evidence(l);
    if (!e || !isHandSetDriver(e) || !usable.has(e.driverId!)) continue;
    out.set(l.key, { driverId: e.driverId, driverSetById: e.driverSetById ?? null, driverSetAt: e.driverSetAt ?? null });
    given.push({ truckId: l.truckId, loadNo: l.loadNo, driverId: e.driverId, departMin: l.departMin, returnMin: l.returnMin, handSet: true });
  }

  const steps: { sameTrip: boolean; src: (l: ReplanLoad) => DriverOnLoad | undefined; pick: (l: ReplanLoad) => string | null }[] = [
    { sameTrip: true, src: nowTrip, pick: (l) => pickLoadDriver(now, l.truckId, l.loadNo, usable, { exactOnly: true }) },
    { sameTrip: true, src: parentTrip, pick: (l) => pickLoadDriver(parent, l.truckId, l.loadNo, usable, { exactOnly: true }) },
    { sameTrip: false, src: evidence, pick: (l) => pickLoadDriver(either, l.truckId, l.loadNo, usable) },
    { sameTrip: false, src: evidence, pick: (l) => (l.defaultDriverId && usable.has(l.defaultDriverId) ? l.defaultDriverId : null) },
  ];
  for (const step of steps) {
    for (const l of byMoved(step.src)) {
      if (out.get(l.key)!.driverId !== null) continue;
      const driverId = step.pick(l);
      if (!driverId) continue;
      // Kept loads never move: a clash with one is a double booking.
      if (frozen.some((b) => b.driverId === driverId && timesClash(b, l))) continue;
      // Nor another trip RouteIQ gave that driver; the trip's own driver may stay next to a trip
      // the dispatcher gave that driver by hand (that clash is the dispatcher's, shown as a warning).
      if (given.some((b) => b.driverId === driverId && timesClash(b, l) && !(step.sameTrip && b.handSet))) continue;
      out.set(l.key, { ...none(), driverId });
      given.push({ truckId: l.truckId, loadNo: l.loadNo, driverId, departMin: l.departMin, returnMin: l.returnMin, handSet: false });
    }
  }

  // The trips whose driver is not the one they had before this plan, and why.
  const changes: ReplanDriverChange[] = [];
  for (const l of newLoads) {
    const e = evidence(l);
    if (!e) continue; // a new trip: nothing to compare with
    const from = e.driverId;
    const to = out.get(l.key)!.driverId;
    if (from === to) continue;
    let reason: DriverChangeReason = 'OTHER_TRIP';
    let other: ReplanDriverChange['other'] = null;
    if (from === null) reason = 'FILLED';
    else if (!usable.has(from)) reason = 'INACTIVE';
    else {
      const k = frozen.find((b) => b.driverId === from && timesClash(b, l));
      const g = k ? undefined : given.find((b) => b.driverId === from && timesClash(b, l));
      if (k) {
        reason = 'KEPT_LOAD';
        other = { truckId: k.truckId, loadNo: k.loadNo ?? null };
      } else if (g) other = { truckId: g.truckId, loadNo: g.loadNo };
    }
    changes.push({ key: l.key, truckId: l.truckId, loadNo: l.loadNo, fromDriverId: from, toDriverId: to, reason, other });
  }

  // Hand-set choices whose truck and trip this plan does not have (a kept load is still there):
  // parked with the version, never dropped.
  const inPlan = new Set([...newLoads.map(tripKey), ...kept.flatMap((k) => (k.loadNo === undefined ? [] : [tripKey({ truckId: k.truckId, loadNo: k.loadNo })]))]);
  const stillParked = [...beforeTrips.values()]
    .filter((e) => isHandSetDriver(e) && !inPlan.has(tripKey(e)))
    .map((e) => ({ truckId: e.truckId, loadNo: e.loadNo, driverId: e.driverId, departMin: e.departMin, returnMin: e.returnMin, driverSetById: e.driverSetById ?? null, driverSetAt: e.driverSetAt ?? null }))
    .sort((a, b) => (a.truckId < b.truckId ? -1 : a.truckId > b.truckId ? 1 : a.loadNo - b.loadNo));
  return { drivers: out, changes, parked: stillParked };
}

/** The drivers of planReplanDrivers only (new load key -> driver id). */
export function assignReplanDrivers(
  newLoads: ReplanLoad[],
  now: DriverOnLoad[],
  parent: DriverOnLoad[],
  kept: (DriverTime & { loadNo?: number })[],
  usable: ReadonlySet<string>,
  parked: DriverOnLoad[] = [],
): Map<string, string | null> {
  return new Map([...planReplanDrivers(newLoads, now, parent, kept, usable, parked).drivers].map(([k, v]) => [k, v.driverId]));
}

/** Pairs of loads of different trucks that name the same driver at overlapping times. */
export function driverClashes<L extends DriverTime & { id: string }>(loads: L[]): { driverId: string; a: L; b: L }[] {
  const out: { driverId: string; a: L; b: L }[] = [];
  const withDriver = loads.filter((l) => l.driverId !== null);
  withDriver.forEach((a, i) => {
    for (const b of withDriver.slice(i + 1)) {
      if (a.driverId === b.driverId && timesClash(a, b)) out.push({ driverId: a.driverId!, a, b });
    }
  });
  return out;
}

export type DriverChangeCheck = { ok: true; unchanged: boolean } | { ok: false; reason: string };

/**
 * "Keep": the dispatcher re-sends the driver a load already has, RouteIQ filled it in (no hand-set
 * marker) and the load has not left. setDriverTx then marks it as the dispatcher's choice, so a
 * re-plan or "Use instead" keeps it on that truck and trip (planReplanDrivers). The plan screen's
 * Keep button sends it (its Driver list cannot: choosing the driver already selected fires
 * nothing). Any other re-send changes nothing.
 */
export function isDriverKeep(load: { status: LoadStatusName; driverId: string | null; driverSetAt?: Date | null }, driverId: string | null): boolean {
  return driverId !== null && load.driverId === driverId && load.driverSetAt == null && !ON_ROAD.has(load.status);
}

/**
 * Can this load's driver be set to `driverId`? Re-sending the driver it already has is never an
 * error (a client may send it along with a status change, also on a dispatched load); a real
 * change is refused once the load has left the depot.
 */
export function checkDriverChange(load: { status: LoadStatusName; driverId: string | null }, driverId: string | null): DriverChangeCheck {
  if (load.driverId === driverId) return { ok: true, unchanged: true };
  if (ON_ROAD.has(load.status)) return { ok: false, reason: 'Driver cannot change after dispatch.' };
  return { ok: true, unchanged: false };
}
