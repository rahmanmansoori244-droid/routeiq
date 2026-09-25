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

/**
 * This version's own driver evidence for its re-plan (the `now` of assignReplanDrivers, step 1,
 * which is never checked for time clashes): its loads, except the PLANNED copies that the re-plan
 * carried from the parent (copy-forward) with the parent load's driver unchanged. Nobody decided
 * those drivers on this version, so they stay parent evidence (step 2, clash-checked) - as before
 * copy-forward, when a new version held only its frozen copies. A driver the dispatcher changed on
 * a copy (after a failed re-plan) is this version's own choice and counts. Frozen loads always count.
 */
export function ownDriverEvidence<L extends VersionLoadDriver>(now: readonly L[], parent: readonly (DriverOnLoad & { id: string })[]): L[] {
  const parentDriver = new Map(parent.map((p) => [p.id, p.driverId]));
  return now.filter(
    (l) => !(l.status === 'PLANNED' && l.carriedFromLoadId !== null && parentDriver.has(l.carriedFromLoadId) && parentDriver.get(l.carriedFromLoadId) === l.driverId),
  );
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

/**
 * Drivers for the new loads of a (re-)plan. `now` = the loads of this version before its PLANNED
 * loads are replaced, without untouched copy-forward copies (ownDriverEvidence), `parent` = the
 * loads of the version it was re-planned from,
 * `kept` = the frozen loads that stay in this version (their drivers do not change).
 *
 * Evidence, strongest first:
 *   1. this version, same truck and trip   - the driver the dispatcher saw or set on that trip
 *   2. parent version, same truck and trip - e.g. trip 2 given to another driver before a late order
 *   3. the nearest trip of the truck in either version (this version's load wins for one trip)
 *   4. the truck's default driver
 * Each step runs over ALL new loads before the next one, so a weak guess on one truck (say its
 * default driver) never takes a driver that stronger evidence puts on another truck. No step ever
 * puts a driver on a load that overlaps one of the driver's kept loads on another truck: a kept
 * (frozen) load cannot move, so that would always be a second sheet for the same hours - also in
 * step 1, when "Use instead" re-times a trip onto a locked load's hours (review of PR3). Steps 2-4
 * are guesses: they also never overlap loads already given out. Such a load is left without a
 * driver (the next step may still find one) for the dispatcher to fill. Between two new loads,
 * step 1 keeps this version's choice even if the trips now overlap: that clash shows as a plan
 * warning (driverClashes). Only drivers in `usable` (active, this tenant) are ever picked.
 */
export function assignReplanDrivers(
  newLoads: ReplanLoad[],
  now: DriverOnLoad[],
  parent: DriverOnLoad[],
  kept: DriverTime[],
  usable: ReadonlySet<string>,
): Map<string, string | null> {
  const out = new Map<string, string | null>(newLoads.map((l) => [l.key, null]));
  const frozen: DriverTime[] = kept.filter((k) => k.driverId !== null);
  const busy: DriverTime[] = [...frozen];
  // Both versions' trips of each truck; a trip in this version replaces the parent's same trip.
  const inNow = new Set(now.map((l) => `${l.truckId}:${l.loadNo}`));
  const either = [...now, ...parent.filter((l) => !inNow.has(`${l.truckId}:${l.loadNo}`))];
  const steps: { guess: boolean; pick: (l: ReplanLoad) => string | null }[] = [
    { guess: false, pick: (l) => pickLoadDriver(now, l.truckId, l.loadNo, usable, { exactOnly: true }) },
    { guess: true, pick: (l) => pickLoadDriver(parent, l.truckId, l.loadNo, usable, { exactOnly: true }) },
    { guess: true, pick: (l) => pickLoadDriver(either, l.truckId, l.loadNo, usable) },
    { guess: true, pick: (l) => (l.defaultDriverId && usable.has(l.defaultDriverId) ? l.defaultDriverId : null) },
  ];
  for (const step of steps) {
    for (const l of newLoads) {
      if (out.get(l.key) !== null) continue;
      const driverId = step.pick(l);
      if (!driverId) continue;
      // Kept loads never move: a clash with one is a double booking, whatever the evidence.
      if ((step.guess ? busy : frozen).some((b) => b.driverId === driverId && timesClash(b, l))) continue;
      out.set(l.key, driverId);
      busy.push({ truckId: l.truckId, driverId, departMin: l.departMin, returnMin: l.returnMin });
    }
  }
  return out;
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
 * Can this load's driver be set to `driverId`? Re-sending the driver it already has is never an
 * error (a client may send it along with a status change, also on a dispatched load); a real
 * change is refused once the load has left the depot.
 */
export function checkDriverChange(load: { status: LoadStatusName; driverId: string | null }, driverId: string | null): DriverChangeCheck {
  if (load.driverId === driverId) return { ok: true, unchanged: true };
  if (ON_ROAD.has(load.status)) return { ok: false, reason: 'Driver cannot change after dispatch.' };
  return { ok: true, unchanged: false };
}
