/**
 * Driver leave (owner request 6 Oct 2026: "our drivers change a lot, or one of them is on leave and
 * we bring another one, or they take a whole month of leave; it will be the dispatcher's job to
 * monitor those"). Pure: no database, no server imports (the Drivers page and the plan screen use it).
 *
 * A leave period is a driver, a FROM date and an UNTIL date (both included, YYYY-MM-DD in the
 * company's time zone), an optional note and an optional COVER driver. For a delivery date inside a
 * period:
 *  - RouteIQ never puts the driver on a load (planDrivers in load-state.ts: a new plan, a re-plan,
 *    "Use instead"); a driver the dispatcher picked by hand stays (the "picked by hand" rule), and a
 *    frozen load (locked, loading, out) never changes;
 *  - a truck whose usual (default) driver is on leave gets the cover driver, when one is set, is not
 *    on leave himself that day and drives no other truck that day; else no driver, and the load says
 *    "No driver: <name> is on leave until <date> - pick a driver" (rule 20 then keeps it from leaving);
 *  - the plan screen's Driver list shows him "(on leave until <date>)" and asks before he is chosen.
 * After the period he is used again by himself. Periods of one driver never overlap; a period that
 * has started keeps its start date and one that has ended is kept as it is, for the record.
 */
import { addDaysIso, fmtDayMonth } from './time';

export interface LeavePeriod {
  id: string;
  driverId: string;
  /** First day of leave (YYYY-MM-DD). */
  fromIso: string;
  /** Last day of leave, included (YYYY-MM-DD). */
  untilIso: string;
  note: string | null;
  /** Drives the driver's usual truck(s) while he is away; null = nobody named. */
  coverDriverId: string | null;
}

/** One driver's leave on one delivery day: until when, and who covers him. */
export interface DayLeave {
  untilIso: string;
  coverDriverId: string | null;
}

/** Driver id -> his leave on the day (absent: not on leave that day). */
export type LeaveOnDay = ReadonlyMap<string, DayLeave>;

/** The Drivers page lists the leave of today and of the coming 14 days. */
export const LEAVE_LIST_DAYS = 14;
/** The longest note a leave period keeps. */
export const LEAVE_NOTE_MAX = 200;

/** Is `dayIso` inside the period (both ends included)? */
export function isOnLeave(p: Pick<LeavePeriod, 'fromIso' | 'untilIso'>, dayIso: string): boolean {
  return p.fromIso <= dayIso && dayIso <= p.untilIso;
}

/** Who is on leave on `dayIso`, with until when and their cover (a planning day's view). */
export function leaveOnDay(periods: readonly LeavePeriod[], dayIso: string): Map<string, DayLeave> {
  const out = new Map<string, DayLeave>();
  for (const p of periods) {
    if (!isOnLeave(p, dayIso)) continue;
    const had = out.get(p.driverId);
    // Periods never overlap; should two do (written before the check), the later end wins.
    if (!had || had.untilIso < p.untilIso) out.set(p.driverId, { untilIso: p.untilIso, coverDriverId: p.coverDriverId });
  }
  return out;
}

/** Two periods share a day (both ends included). */
export function periodsOverlap(a: Pick<LeavePeriod, 'fromIso' | 'untilIso'>, b: Pick<LeavePeriod, 'fromIso' | 'untilIso'>): boolean {
  return a.fromIso <= b.untilIso && b.fromIso <= a.untilIso;
}

/** The driver's period that shares a day with `cand` (the one being edited, `ignoreId`, left out), or null. */
export function overlappingLeave(
  periods: readonly LeavePeriod[],
  cand: { driverId: string; fromIso: string; untilIso: string },
  ignoreId: string | null = null,
): LeavePeriod | null {
  return periods.find((p) => p.driverId === cand.driverId && p.id !== ignoreId && periodsOverlap(p, cand)) ?? null;
}

export type LeavePhase = 'ENDED' | 'NOW' | 'COMING';

/** ENDED: the last day is before today; COMING: the first day is after today; NOW otherwise. */
export function leavePhase(p: Pick<LeavePeriod, 'fromIso' | 'untilIso'>, todayIso: string): LeavePhase {
  if (p.untilIso < todayIso) return 'ENDED';
  if (p.fromIso > todayIso) return 'COMING';
  return 'NOW';
}

export type LeaveCheck = { ok: true } | { ok: false; status: number; code: string; reason: string };

const refuse = (status: number, code: string, reason: string): LeaveCheck => ({ ok: false, status, code, reason });
const OK: LeaveCheck = { ok: true };

/**
 * Shared by add and change: the dates in order, the cover not the driver himself and active. A cover
 * the period already had (`keptCover`) is not refused for being inactive: deactivated after the save,
 * he must not block ending the period early or changing its note (planDrivers never gives an inactive
 * cover anyway; the Drivers page says so).
 */
function checkShape(
  input: { driverId: string; fromIso: string; untilIso: string; coverDriverId: string | null },
  cover: { active: boolean; name: string } | null,
  keptCover: string | null = null,
): LeaveCheck {
  if (input.untilIso < input.fromIso) return refuse(400, 'LEAVE_DATES', 'Until must be the same day as From or later.');
  if (input.coverDriverId && input.coverDriverId === input.driverId) return refuse(400, 'LEAVE_COVER_SELF', 'A driver cannot cover his own leave: pick another cover driver, or none.');
  if (input.coverDriverId && !cover) return refuse(400, 'LEAVE_COVER_UNKNOWN', 'Cover driver not found.');
  if (input.coverDriverId && cover && !cover.active && input.coverDriverId !== keptCover) {
    return refuse(400, 'LEAVE_COVER_INACTIVE', `Cover driver ${cover.name} is inactive: reactivate him first, or pick another.`);
  }
  return OK;
}

/** The overlap refusal, naming the period already there. */
function overlapRefusal(p: LeavePeriod): LeaveCheck {
  return refuse(409, 'LEAVE_OVERLAP', `This driver is already on leave from ${fmtDayMonth(p.fromIso)} until ${fmtDayMonth(p.untilIso)}. Change that period instead: one driver's periods cannot overlap.`);
}

/**
 * A new period: its dates in order, ending today or later (leave is entered for today and the days
 * ahead; a period cannot be added in the past), no overlap with the driver's other periods, and the
 * cover another, active driver.
 */
export function checkNewLeave(
  input: { driverId: string; fromIso: string; untilIso: string; coverDriverId: string | null },
  existing: readonly LeavePeriod[],
  todayIso: string,
  cover: { active: boolean; name: string } | null,
): LeaveCheck {
  const shape = checkShape(input, cover);
  if (!shape.ok) return shape;
  if (input.untilIso < todayIso) return refuse(400, 'LEAVE_IN_PAST', 'This leave would have ended already: enter leave for today or the days ahead.');
  const clash = overlappingLeave(existing, input);
  return clash ? overlapRefusal(clash) : OK;
}

/**
 * A change of a period. An ended period is kept as it is (for the record). A period that has started
 * (its first day before today) keeps its first day; its last day can be brought forward down to
 * yesterday - "he came back early" - or moved later. A period not started yet may change freely,
 * but not into the past. Always: the dates in order, no overlap, the cover another driver - active
 * when he is chosen now (the period's own cover, deactivated since, is kept: it does not block the change).
 */
export function checkLeaveChange(
  before: LeavePeriod,
  after: { driverId: string; fromIso: string; untilIso: string; coverDriverId: string | null },
  existing: readonly LeavePeriod[],
  todayIso: string,
  cover: { active: boolean; name: string } | null,
): LeaveCheck {
  if (leavePhase(before, todayIso) === 'ENDED') return refuse(409, 'LEAVE_ENDED', 'This leave has ended: it is kept as it was, for the record.');
  const shape = checkShape(after, cover, before.coverDriverId);
  if (!shape.ok) return shape;
  const yesterday = addDaysIso(todayIso, -1);
  if (before.fromIso < todayIso) {
    if (after.fromIso !== before.fromIso) return refuse(409, 'LEAVE_STARTED', `This leave started on ${fmtDayMonth(before.fromIso)}: its first day stays. Change Until to end it early.`);
    if (after.untilIso < yesterday) return refuse(400, 'LEAVE_IN_PAST', `Until can be yesterday (${fmtDayMonth(yesterday)}) at the earliest: the days before are kept for the record.`);
  } else if (after.fromIso < todayIso) {
    return refuse(400, 'LEAVE_IN_PAST', 'From cannot be before today.');
  }
  const clash = overlappingLeave(existing, after, before.id);
  return clash ? overlapRefusal(clash) : OK;
}

/** Removing a period: only one that has not started yet (today included); others end early or stay. */
export function checkLeaveRemove(before: LeavePeriod, todayIso: string): LeaveCheck {
  const phase = leavePhase(before, todayIso);
  if (phase === 'ENDED') return refuse(409, 'LEAVE_ENDED', 'This leave has ended: it is kept as it was, for the record.');
  if (before.fromIso < todayIso) {
    return refuse(409, 'LEAVE_STARTED', `This leave started on ${fmtDayMonth(before.fromIso)} and is kept for the record. To end it early, change Until to yesterday (${fmtDayMonth(addDaysIso(todayIso, -1))}).`);
  }
  return OK;
}

/** The cover driver's own leave that shares a day with the period (he cannot cover those days), or null. */
export function coverAwayDuring(periods: readonly LeavePeriod[], period: { fromIso: string; untilIso: string; coverDriverId: string | null }): LeavePeriod | null {
  if (!period.coverDriverId) return null;
  return periods.find((p) => p.driverId === period.coverDriverId && periodsOverlap(p, period)) ?? null;
}

/** The warning saved with a period whose cover is away part of the time (the save still goes through). */
export function coverAwayWarning(coverName: string, away: LeavePeriod): string {
  return `${coverName} is on leave himself from ${fmtDayMonth(away.fromIso)} until ${fmtDayMonth(away.untilIso)}: on those days the truck gets no driver unless you pick one.`;
}

/** The periods that touch today or the coming `days` days, the soonest first ("Drivers on leave"). */
export function upcomingLeave<P extends Pick<LeavePeriod, 'fromIso' | 'untilIso'>>(periods: readonly P[], todayIso: string, days = LEAVE_LIST_DAYS): P[] {
  const last = addDaysIso(todayIso, days);
  return periods
    .filter((p) => periodsOverlap(p, { fromIso: todayIso, untilIso: last }))
    .sort((a, b) => (a.fromIso < b.fromIso ? -1 : a.fromIso > b.fromIso ? 1 : a.untilIso < b.untilIso ? -1 : a.untilIso > b.untilIso ? 1 : 0));
}

/** The cover planDrivers may give a truck whose usual driver is on leave that day (null: none named). */
export function coverFor(usualDriverId: string | null, leave: LeaveOnDay): string | null {
  if (!usualDriverId) return null;
  return leave.get(usualDriverId)?.coverDriverId ?? null;
}

/** "on leave until 12 Oct" (the Driver list's label and the Drivers page). */
export function onLeaveLabel(untilIso: string): string {
  return `on leave until ${fmtDayMonth(untilIso)}`;
}

/** The note on a load without a driver because its truck's usual driver is on leave. */
export function noDriverLeaveNote(name: string, untilIso: string): string {
  return `No driver: ${name} is on leave until ${fmtDayMonth(untilIso)} - pick a driver`;
}

/** The question before a driver on leave that day is put on a load by hand. */
export function pickOnLeaveConfirm(name: string, untilIso: string, trip: string): string {
  return `${name} is on leave until ${fmtDayMonth(untilIso)}. Put ${name} on ${trip} anyway?`;
}

/**
 * The driver note a load shows on the plan, for the leave of its delivery day (read live, so it
 * follows the Drivers page): a load that has left shows none.
 *  - no driver, and the truck's usual driver is on leave: "No driver: Ali is on leave until 12 Oct - pick a driver";
 *  - its driver is on leave that day (picked by hand, or planned before the leave was entered):
 *    "Ali is on leave until 12 Oct";
 *  - its driver covers the truck's usual driver: "Covers Ali (on leave until 12 Oct)"; when that cover
 *    also drives for another depot that day (`elsewhere`: plans are per depot, and the other depot,
 *    planned later, gave him his own truck), it says so: "... - but Bob also drives a truck of another
 *    depot that day: pick another driver".
 */
export function loadLeaveNote(
  load: { status: string; driverId: string | null },
  usualDriverId: string | null,
  leave: LeaveOnDay,
  nameOf: (driverId: string) => string,
  elsewhere: ReadonlySet<string> = new Set(),
): string | null {
  if (load.status === 'DISPATCHED' || load.status === 'COMPLETED') return null;
  const usualAway = usualDriverId ? leave.get(usualDriverId) : undefined;
  if (load.driverId === null) return usualAway ? noDriverLeaveNote(nameOf(usualDriverId!), usualAway.untilIso) : null;
  const ownAway = leave.get(load.driverId);
  if (ownAway) return `${nameOf(load.driverId)} is ${onLeaveLabel(ownAway.untilIso)}`;
  if (usualAway && usualDriverId !== load.driverId && usualAway.coverDriverId === load.driverId) {
    const covers = `Covers ${nameOf(usualDriverId!)} (${onLeaveLabel(usualAway.untilIso)})`;
    return elsewhere.has(load.driverId) ? `${covers} - but ${nameOf(load.driverId)} also drives a truck of another depot that day: pick another driver` : covers;
  }
  return null;
}

/**
 * The question asked before `driverId` is put on a load while he is on leave that day (`onLeave`:
 * driver id -> last day): by the Driver list, by Keep, and by the daily-driver quick add. Null: he is
 * not on leave that day (or no driver).
 */
export function leaveQuestion(driverId: string | null, onLeave: ReadonlyMap<string, string>, name: string, trip: string): string | null {
  const until = driverId ? onLeave.get(driverId) : undefined;
  return until ? pickOnLeaveConfirm(name, until, trip) : null;
}

/** The Keep link's title; with the driver's leave that day when he is on leave (Keep then asks first). */
export function keepTitle(name: string, leaveUntil: string | null): string {
  if (!leaveUntil) return `RouteIQ filled in ${name}. Keep makes ${name} your pick: a re-plan or Use instead then keeps ${name} on this truck and trip.`;
  return `RouteIQ filled in ${name}, who is ${onLeaveLabel(leaveUntil)}. Keep asks first, then makes ${name} your pick: a re-plan or Use instead then keeps ${name} on this truck and trip, leave or not.`;
}

/** A driver as the Leave dialog's cover list offers him. */
export interface CoverChoice {
  id: string;
  name: string;
  active: boolean;
  code?: string;
  casual?: boolean;
}

/**
 * The cover list of a period of `driverId`: the active drivers but him, plus the period's own cover
 * (`currentCoverId`) when he was deactivated since - or is not in the list at all - so the list always
 * shows the cover the form sends (a cover deactivated after the save is kept; checkLeaveChange).
 */
export function coverOptions(drivers: readonly CoverChoice[], driverId: string | null | undefined, currentCoverId: string | null, unknownName = 'Unknown driver'): CoverChoice[] {
  const out = drivers.filter((d) => d.id !== driverId && (d.active || d.id === currentCoverId));
  if (currentCoverId && !out.some((d) => d.id === currentCoverId)) out.unshift({ id: currentCoverId, name: unknownName, active: false });
  return out;
}

/** "Sam (daily)", "Bob (inactive)". */
export function coverOptionLabel(d: CoverChoice): string {
  return `${d.name}${d.casual ? ' (daily)' : ''}${d.active ? '' : ' (inactive)'}`;
}

const listOf = (codes: readonly string[]) => codes.join(', ');
const doesNotRun = (codes: readonly string[]) => `${listOf(codes)} ${codes.length === 1 ? 'does' : 'do'} not run`;

/**
 * Why a named cover will not drive the truck as planDrivers decides it (null: nothing in the way):
 * he is inactive, he is on leave himself (`away`: his period sharing the days in question), or he is
 * the usual driver of other active trucks (`ownTrucks`), which RouteIQ gives him first - he covers
 * only on days they do not run. The strongest reason only. The Drivers page shows it next to the cover.
 */
export function coverCaveat(
  cover: { name: string; active: boolean },
  opts: { away?: Pick<LeavePeriod, 'fromIso' | 'untilIso'> | null; ownTrucks?: readonly string[] },
): string | null {
  if (!cover.active) return 'inactive: he cannot cover';
  if (opts.away) return `on leave himself ${fmtDayMonth(opts.away.fromIso)} – ${fmtDayMonth(opts.away.untilIso)}: he cannot cover those days`;
  const own = opts.ownTrucks ?? [];
  if (own.length) return `usual driver of ${listOf(own)}: he covers only on days ${doesNotRun(own)}`;
  return null;
}

/** The warning saved with a period whose cover is the usual driver of other active trucks (the save goes through). */
export function coverOwnTruckWarning(coverName: string, truckCodes: readonly string[]): string | null {
  if (!truckCodes.length) return null;
  return `${coverName} is the usual driver of ${listOf(truckCodes)}: RouteIQ gives him ${listOf(truckCodes)} first, so he covers only on days ${doesNotRun(truckCodes)}. Name another cover, or pick the driver on the plan.`;
}
