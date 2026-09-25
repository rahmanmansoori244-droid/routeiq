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

/**
 * The dispatcher set this load's driver: PlanLoad.driverSetById / driverSetAt (who, when), written
 * by every driver change in the Driver list - "No driver" included - and by Keep (setDriverTx).
 * Either column counts: the user id is cleared when that user is deleted, the time stays. A driver
 * note on this trip then ends (driverChangeWarnings). Neither: RouteIQ filled the trip in.
 */
export function driverSetByDispatcher(l: { driverSetById?: string | null; driverSetAt?: Date | null }): boolean {
  return l.driverSetAt != null || l.driverSetById != null;
}

/**
 * The dispatcher chose this load's driver by hand: a driver, and the dispatcher set it
 * (driverSetByDispatcher). A re-plan or "Use instead" carries it, with the marker, to the same
 * truck and trip (planDrivers, pass 1). "No driver" is never hand-set: there is no driver to keep.
 */
export function isHandSetDriver(l: { driverId: string | null; driverSetById?: string | null; driverSetAt?: Date | null }): boolean {
  return l.driverId !== null && driverSetByDispatcher(l);
}

/** A load's driver and planned time away from the depot (minutes from midnight). */
export interface DriverTime {
  truckId: string;
  driverId: string | null;
  departMin: number;
  returnMin: number;
}

/** Two planned times that really overlap (a trip back at 10:00 and one out at 10:00 do not). */
export function timesOverlap(a: Pick<DriverTime, 'departMin' | 'returnMin'>, b: Pick<DriverTime, 'departMin' | 'returnMin'>): boolean {
  return a.departMin < b.returnMin && b.departMin < a.returnMin;
}

/** Loads of two different trucks whose planned times overlap: one driver cannot drive both (the yellow warning). */
export function timesClash(a: Omit<DriverTime, 'driverId'>, b: Omit<DriverTime, 'driverId'>): boolean {
  return a.truckId !== b.truckId && timesOverlap(a, b);
}

/**
 * A load of the version a plan is applied to, as it is right before the apply: the evidence for the
 * new plan's drivers. For "Use instead" on a version, its loads; for the re-plan job on a new
 * version, the copies createNextVersion made of the previous version's loads. Frozen loads (any
 * status but PLANNED) stay in the plan as they are.
 */
export interface EvidenceLoad extends DriverTime {
  loadNo: number;
  status: string;
  driverSetById: string | null;
  driverSetAt: Date | null;
}

/** A trip (truck and load number) of the plan being applied. */
export interface PlanTrip {
  /** Any id unique among the plan's trips (the result is keyed by it). */
  key: string;
  truckId: string;
  loadNo: number;
  departMin: number;
  returnMin: number;
  /** The truck's default driver. */
  defaultDriverId: string | null;
}

/** The driver a plan gives a trip, and the hand-set marker it carries (both null: RouteIQ's pick). */
export interface TripDriver {
  driverId: string | null;
  driverSetById: string | null;
  driverSetAt: Date | null;
}

/**
 * Why a trip lost or changed the driver its evidence load had:
 * - CLASH: another trip of the plan got that driver at an overlapping time;
 * - INACTIVE: that driver is no longer active;
 * - TRIP_GONE: the dispatcher picked that driver by hand for a trip the plan does not have.
 */
export type DriverNoteReason = 'CLASH' | 'INACTIVE' | 'TRIP_GONE';

/** A driver note: a trip that lost or changed its driver (never a trip that only got one). */
export interface DriverNote {
  /** The plan trip's key; null for TRIP_GONE (no such trip in the plan). */
  key: string | null;
  truckId: string;
  loadNo: number;
  /** The trip's times: in the plan, or before it (TRIP_GONE). */
  departMin: number;
  returnMin: number;
  /** The driver the evidence load had. */
  fromDriverId: string;
  /** The driver the plan gave the trip (null: none, for the dispatcher to fill; TRIP_GONE: no trip). */
  toDriverId: string | null;
  reason: DriverNoteReason;
  /** CLASH: the trip that got `fromDriverId`. */
  other: { truckId: string; loadNo: number } | null;
}

const tripKey = (l: { truckId: string; loadNo: number }) => `${l.truckId}:${l.loadNo}`;
const NO_DRIVER: TripDriver = { driverId: null, driverSetById: null, driverSetAt: null };

/**
 * Drivers for the trips of a plan being applied (an optimize, a re-plan or "Use instead"), and the
 * driver notes. `evidence` = the loads of the version the plan is applied to, as they are right
 * before the apply (EvidenceLoad); a trip's evidence load is the one on the same truck and trip.
 * `usable` = the active drivers of the tenant.
 *
 * Pass 0: the frozen evidence loads stay as they are, with their drivers, whose times they take.
 * Pass 1: a trip whose evidence load has a hand-set driver (isHandSetDriver) keeps that driver and
 *   the marker, even when the new times overlap another trip of that driver (the yellow clash
 *   warning shows it). A driver no longer active is not kept: the trip goes to pass 2, with a note.
 * Pass 2: every other trip, the one that moved least first (|new departure - evidence departure|;
 *   trips without an evidence load last; stable: a tie keeps the order of `trips`, which is the
 *   optimizer's - truck code, then trip), gets the first of these that is active and not on
 *   an overlapping trip already given out (frozen, hand-set, or earlier in pass 2):
 *   (a) its evidence load's driver, (b) the driver of the truck's nearest trip in time in the plan
 *   (frozen or given a driver already), (c) the truck's default driver. None of them: no driver.
 * The first optimization of a day has no evidence: pass 2 with (b) and (c).
 *
 * Notes: a trip whose driver is not its evidence load's driver any more (CLASH, INACTIVE), and a
 * hand-set driver whose trip the plan does not have (TRIP_GONE: nothing brings it back later).
 * Filling a trip that had no driver is not a note.
 */
export function planDrivers(trips: readonly PlanTrip[], evidence: readonly EvidenceLoad[], usable: ReadonlySet<string>): { drivers: Map<string, TripDriver>; notes: DriverNote[] } {
  const before = new Map(evidence.map((e) => [tripKey(e), e]));
  const drivers = new Map(trips.map((t) => [t.key, NO_DRIVER]));
  // The trips of the plan that have a driver, so far: the frozen loads first.
  const given: (DriverTime & { loadNo: number })[] = evidence.filter((e) => e.status !== 'PLANNED' && e.driverId !== null).map((e) => ({ ...e }));
  const give = (t: PlanTrip, d: TripDriver) => {
    drivers.set(t.key, d);
    given.push({ truckId: t.truckId, loadNo: t.loadNo, driverId: d.driverId, departMin: t.departMin, returnMin: t.returnMin });
  };
  const busyWith = (driverId: string, t: PlanTrip) => given.find((g) => g.driverId === driverId && timesOverlap(g, t));
  const notes: DriverNote[] = [];

  // Pass 1: the dispatcher's own choices.
  const filledIn: PlanTrip[] = [];
  for (const t of trips) {
    const e = before.get(tripKey(t));
    if (e && isHandSetDriver(e) && usable.has(e.driverId!)) give(t, { driverId: e.driverId, driverSetById: e.driverSetById, driverSetAt: e.driverSetAt });
    else filledIn.push(t);
  }

  // Pass 2: RouteIQ's picks, the trip that moved least first.
  const moved = (t: PlanTrip) => {
    const e = before.get(tripKey(t));
    return e ? Math.abs(t.departMin - e.departMin) : Number.POSITIVE_INFINITY;
  };
  const gap = (a: Pick<DriverTime, 'departMin' | 'returnMin'>, b: Pick<DriverTime, 'departMin' | 'returnMin'>) => Math.max(0, a.departMin - b.returnMin, b.departMin - a.returnMin);
  const nearestTripDriver = (t: PlanTrip) =>
    given
      .filter((g) => g.truckId === t.truckId)
      .sort((a, b) => gap(a, t) - gap(b, t) || a.departMin - b.departMin || a.loadNo - b.loadNo)[0]?.driverId ?? null;
  const order = filledIn.map((t) => ({ t, m: moved(t) })).sort((a, b) => (a.m === b.m ? 0 : a.m < b.m ? -1 : 1));
  for (const { t } of order) {
    const from = before.get(tripKey(t))?.driverId ?? null;
    const free = (d: string | null): d is string => d !== null && usable.has(d) && !busyWith(d, t);
    const driverId = [from, nearestTripDriver(t), t.defaultDriverId].find(free) ?? null;
    if (driverId) give(t, { ...NO_DRIVER, driverId });
    if (from === null || from === driverId) continue;
    const other = usable.has(from) ? busyWith(from, t) : undefined;
    notes.push({
      key: t.key,
      truckId: t.truckId,
      loadNo: t.loadNo,
      departMin: t.departMin,
      returnMin: t.returnMin,
      fromDriverId: from,
      toDriverId: driverId,
      reason: other ? 'CLASH' : 'INACTIVE',
      other: other ? { truckId: other.truckId, loadNo: other.loadNo } : null,
    });
  }

  // Hand-set drivers whose trip the plan does not have (frozen loads stay in it).
  const inPlan = new Set(trips.map(tripKey));
  for (const e of evidence) {
    if (e.status !== 'PLANNED' || !isHandSetDriver(e) || inPlan.has(tripKey(e))) continue;
    notes.push({ key: null, truckId: e.truckId, loadNo: e.loadNo, departMin: e.departMin, returnMin: e.returnMin, fromDriverId: e.driverId!, toDriverId: null, reason: 'TRIP_GONE', other: null });
  }
  const rank = (n: DriverNote) => (n.reason === 'TRIP_GONE' ? 1 : 0);
  notes.sort((a, b) => rank(a) - rank(b) || (a.truckId < b.truckId ? -1 : a.truckId > b.truckId ? 1 : a.loadNo - b.loadNo));
  return { drivers, notes };
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
 * "Keep": the dispatcher re-sends the driver a load already has, RouteIQ filled it in (not hand-set)
 * and the load has not left. setDriverTx then marks it as the dispatcher's choice, so a re-plan or
 * "Use instead" keeps it on that truck and trip (planDrivers, pass 1), and a driver note on that trip
 * ends. The plan screen's Keep link sends it (its Driver list cannot: choosing the driver already
 * selected fires nothing). Any other re-send changes nothing.
 */
export function isDriverKeep(
  load: { status: LoadStatusName; driverId: string | null; driverSetById?: string | null; driverSetAt?: Date | null },
  driverId: string | null,
): boolean {
  return driverId !== null && load.driverId === driverId && !isHandSetDriver(load) && !ON_ROAD.has(load.status);
}

/**
 * What the plan screen shows next to a load's driver (LoadDriver in plan-view.tsx):
 * - 'HAND_SET' ("picked by hand"): the dispatcher chose this driver (DetailLoad.driverHandSet);
 * - 'KEEP' (the Keep link, which re-sends the driver): RouteIQ filled it in, the server takes the
 *   re-sent driver as a Keep (isDriverKeep), and the dispatcher can change this load (`editable`)
 *   to that driver (`driverActive`: an inactive driver can no longer be picked);
 * - null: no driver, or the load has left the depot.
 */
export function driverPickLink(
  l: { status: string; driverId: string | null; driverHandSet: boolean },
  opts: { editable: boolean; driverActive: boolean },
): 'HAND_SET' | 'KEEP' | null {
  const status = l.status as LoadStatusName;
  if (l.driverId === null || ON_ROAD.has(status)) return null;
  if (l.driverHandSet) return 'HAND_SET';
  return opts.editable && opts.driverActive && isDriverKeep({ status, driverId: l.driverId }, l.driverId) ? 'KEEP' : null;
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
