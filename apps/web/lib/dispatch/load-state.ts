/**
 * Load lifecycle rules. Physical reality drives them: the warehouse loads a truck's Load 1
 * before Load 2, and nothing on the road can be re-planned (no trustworthy live position).
 *
 *   PLANNED  -> LOCKED        planner; all earlier loads of the truck must already be frozen
 *   LOCKED   -> PLANNED       planner (unlock); later loads of the truck must still be PLANNED
 *   LOCKED   -> LOADING       planner
 *   LOADING  -> LOCKED        planner (loading paused/cancelled)
 *   LOCKED | LOADING -> DISPATCHED   planner; earlier loads must be DISPATCHED/COMPLETED
 *   DISPATCHED -> COMPLETED   planner
 *   DISPATCHED / COMPLETED    immutable otherwise
 *
 * "Frozen" = anything but PLANNED: a re-plan keeps frozen loads exactly as they are.
 *
 * Owner decision 4 (5 Oct 2026): "the dispatcher is the planner" - every move is the PLANNER's
 * (Dispatch and Completed needed a SUPERVISOR before). VIEWER is refused by the route.
 */
import { coverFor, type LeaveOnDay } from './driver-leave';
import { fmtDayMonth } from './time';

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
  | { ok: true; role: 'PLANNER' }
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
  return { ok: true, role: 'PLANNER' };
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
 * The question the plan screen asks before a move that can never be undone (review of 8 Oct 2026,
 * ui-dispatch-3): DISPATCHED (nothing leads back from it: no unlock, no re-plan, no other driver)
 * and COMPLETED (the trip is closed: the driver's phone can no longer change its results). Both were
 * one click on small buttons next to Loading and Unlock, so a mis-click froze a load for good.
 * Lock, Loading and the ways back are not asked: each can be undone. Null = no question.
 * `day` (YYYY-MM-DD): a load of a later day than the company's today says so - it would leave the
 * evening before its delivery day.
 */
export function oneWayMoveQuestion(
  l: { truckCode: string; loadNo: number; driverName: string | null; stops: number; cases: number },
  to: string,
  day?: { runDate: string; today: string | null },
): string | null {
  const who = l.driverName ?? 'no driver';
  const later = day?.today && day.runDate.slice(0, 10) > day.today ? ` This load is for ${fmtDayMonth(day.runDate)}, not today.` : '';
  if (to === 'DISPATCHED') {
    return (
      `Dispatch ${l.truckCode} L${l.loadNo} (${who}, ${l.stops} stop(s), ${l.cases} cases)?${later}\n\n` +
      'This cannot be undone: a dispatched load can never be unlocked, re-planned or given another driver. Press OK only when the truck has left.'
    );
  }
  if (to === 'COMPLETED') {
    return (
      `Mark ${l.truckCode} L${l.loadNo} (${who}, ${l.stops} stop(s)) as Completed?\n\n` +
      "This cannot be undone: the trip is closed and the driver's phone can no longer change its results (a stop with no result can still be recorded with Record)."
    );
  }
  return null;
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
  /** PlanLoad.driverIsCover: RouteIQ gave this driver as the cover of the truck's usual driver on leave (pass 3). */
  driverIsCover?: boolean;
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
  /** True: given as the cover of the truck's usual driver on leave (pass 3); stored as PlanLoad.driverIsCover. */
  driverIsCover?: boolean;
}

/**
 * Why a trip lost or changed the driver its evidence load had:
 * - CLASH: another trip of the plan got that driver at an overlapping time;
 * - INACTIVE: that driver is no longer active;
 * - ON_LEAVE: that driver is on leave on the delivery day (driver-leave.ts; owner request 6 Oct 2026);
 * - COVER: that driver drove the trip as the cover of the truck's usual driver (review of 6 Oct 2026)
 *   and a re-plan does not give it to him again - `cover` says why (DriverCoverWhy);
 * - TRIP_GONE: the dispatcher picked that driver by hand for a trip the plan does not have.
 */
export type DriverNoteReason = 'CLASH' | 'INACTIVE' | 'ON_LEAVE' | 'COVER' | 'TRIP_GONE';

/**
 * A COVER note's why:
 * - ENDED: he is not the cover of the truck's usual driver that day any more (the leave ended early or
 *   was removed, another cover was named, or the truck has another usual driver);
 * - OTHER_TRUCK: he is still the cover but drives another truck of the plan that day (`other`);
 * - OTHER_DEPOT: he is still the cover but drives a truck of another depot that day;
 * - TRUCK_DRIVER: the driver of the truck's other trip that day drives this one too.
 */
export type DriverCoverWhy = 'ENDED' | 'OTHER_TRUCK' | 'OTHER_DEPOT' | 'TRUCK_DRIVER';

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
  /** ON_LEAVE only: the last day of that driver's leave (YYYY-MM-DD). */
  leaveUntil?: string;
  /** COVER only: why the cover does not drive the trip again. */
  cover?: DriverCoverWhy;
}

const tripKey = (l: { truckId: string; loadNo: number }) => `${l.truckId}:${l.loadNo}`;
const NO_DRIVER: TripDriver = { driverId: null, driverSetById: null, driverSetAt: null };
const NO_LEAVE: LeaveOnDay = new Map();
const NO_ONE: ReadonlySet<string> = new Set();

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
 * Leave (owner request 6 Oct 2026; `leave` = who is on leave on the delivery day, driver-leave.ts):
 * pass 2 never gives a driver on leave. Pass 3: a trip still without a driver whose truck's default
 * driver is on leave gets his cover driver, when one is named, is active, is not on leave himself
 * that day, has no overlapping trip and drives no OTHER truck that day - of the plan (frozen,
 * hand-set or given in pass 2 or earlier in pass 3, in pass 2's order) or of another depot
 * (`elsewhere`: the drivers on the loads of the other depots' live plans of that day; plans are per
 * depot, drivers are the company's). Else the trip has no driver: the plan screen says why
 * (loadLeaveNote) and rule 20 keeps it from leaving until the dispatcher picks one. The cover's trip
 * is marked (TripDriver.driverIsCover, stored as PlanLoad.driverIsCover). Pass 1 is unchanged: a
 * driver picked by hand stays even on leave (the dispatcher's choice).
 * A cover is never kept as "the driver the trip already had": pass 2 offers neither (a) when it was
 * the cover (the marker, or the current cover of the truck's usual driver on leave) nor (b) when it
 * is the current cover. He comes again only through pass 3 and its rules, so a re-plan gives what a
 * new plan of the same trips gives: the usual driver when his leave ended early, the new cover when
 * another was named, and the cover's own truck first when it runs that day (review of 6 Oct 2026).
 *
 * Notes: a trip whose driver is not its evidence load's driver any more (CLASH, INACTIVE, ON_LEAVE,
 * COVER), and a hand-set driver whose trip the plan does not have (TRIP_GONE: nothing brings it back
 * later). Filling a trip that had no driver is not a note.
 */
export function planDrivers(
  trips: readonly PlanTrip[],
  evidence: readonly EvidenceLoad[],
  usable: ReadonlySet<string>,
  leave: LeaveOnDay = NO_LEAVE,
  elsewhere: ReadonlySet<string> = NO_ONE,
): { drivers: Map<string, TripDriver>; notes: DriverNote[] } {
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

  // Pass 2: RouteIQ's picks, the trip that moved least first. Never a driver on leave that day.
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
  const free = (d: string | null, t: PlanTrip): d is string => d !== null && usable.has(d) && !leave.has(d) && !busyWith(d, t);
  // The cover of the trip's truck that day (its usual driver on leave), and "the trip's driver was the cover".
  const coverNow = (t: PlanTrip) => coverFor(t.defaultDriverId, leave);
  const wasCover = (t: PlanTrip, e: EvidenceLoad | undefined) =>
    !!e && e.driverId !== null && e.driverId !== t.defaultDriverId && (e.driverIsCover === true || e.driverId === coverNow(t));
  for (const { t } of order) {
    const e = before.get(tripKey(t));
    const from = wasCover(t, e) ? null : (e?.driverId ?? null);
    const nearest = nearestTripDriver(t);
    const driverId = [from, nearest === coverNow(t) ? null : nearest, t.defaultDriverId].find((d): d is string => free(d, t)) ?? null;
    if (driverId) give(t, { ...NO_DRIVER, driverId });
  }

  // Pass 3: the cover driver of a truck whose default driver is on leave that day.
  const otherTruckOf = (driverId: string, t: PlanTrip) => given.find((g) => g.driverId === driverId && g.truckId !== t.truckId);
  for (const { t } of order) {
    if (drivers.get(t.key)!.driverId !== null) continue;
    const cover = coverNow(t);
    if (cover && free(cover, t) && !otherTruckOf(cover, t) && !elsewhere.has(cover)) give(t, { ...NO_DRIVER, driverId: cover, driverIsCover: true });
  }

  // The notes: a trip that lost or changed the driver its evidence load had.
  for (const { t } of order) {
    const e = before.get(tripKey(t));
    const from = e?.driverId ?? null;
    const driverId = drivers.get(t.key)!.driverId;
    if (from === null || from === driverId) continue;
    const away = usable.has(from) ? leave.get(from) : undefined;
    const clash = usable.has(from) && !away ? busyWith(from, t) : undefined;
    const cover: DriverCoverWhy | null =
      !usable.has(from) || away || clash || !wasCover(t, e)
        ? null
        : coverNow(t) !== from
          ? 'ENDED'
          : otherTruckOf(from, t)
            ? 'OTHER_TRUCK'
            : elsewhere.has(from)
              ? 'OTHER_DEPOT'
              : 'TRUCK_DRIVER';
    const other = clash ?? (cover === 'OTHER_TRUCK' ? otherTruckOf(from, t) : undefined);
    notes.push({
      key: t.key,
      truckId: t.truckId,
      loadNo: t.loadNo,
      departMin: t.departMin,
      returnMin: t.returnMin,
      fromDriverId: from,
      toDriverId: driverId,
      reason: away ? 'ON_LEAVE' : clash ? 'CLASH' : cover ? 'COVER' : 'INACTIVE',
      other: other ? { truckId: other.truckId, loadNo: other.loadNo } : null,
      ...(away ? { leaveUntil: away.untilIso } : {}),
      ...(cover ? { cover } : {}),
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
