/**
 * Same-day planning starts from now (stabilization PR8; scenario finding S04 / N2).
 *
 * A plan made for the delivery day itself - a late order at 09:00, a re-plan after the morning
 * loads left - must not send a truck out at 06:00, before the order even existed. When the plan is
 * built on its own delivery day (the company's timezone, Asia/Muscat for NMWC), no NEW load leaves
 * the depot before "now + preparation". The preparation time is the company's turnaround between
 * loads (Settings, "Turnaround between loads"): the time a truck standing at the depot needs before
 * it can leave with a new load.
 *
 * It is sent to the optimizer as the earliest first departure of the day (config.shift_start_min),
 * which the optimizer already applies to every truck: a truck with a locked, loading or dispatched
 * load leaves again only after that load is back plus its turnaround (and loading time per case),
 * whichever is later. Those loads themselves keep their times. A plan for a future day (or one made
 * before the first departure) keeps the first departure setting.
 *
 * Loading starts now too (PR8 review). The loading minutes per case of a new load cannot have been
 * spent before the plan existed, so on the delivery day the web also sends the time the plan is made
 * (config.loading_from_min, `planDayNowMin`): every new load leaves no earlier than now + turnaround +
 * loading per case x ITS cases - on a truck standing at the depot exactly as on one coming back
 * (before, only a truck back at or after now had its loading counted). This also holds on a plan
 * made early on the delivery day, before the first departure (05:15 for 06:00: a full truck may
 * leave after 06:00). A plan for a later day still loads its first loads before the shift starts.
 *
 * A same-day THOROUGH search (search-mode.ts; review of the long-search PR) runs for up to its cap
 * (20 min) before the plan exists, so "now" is not when its loads can start: they count from the end
 * of the search at the latest - the job's real start (after any wait for a solver slot) + the cap
 * (`searchMin`). Loading starts then too. QUICK (seconds to a couple of minutes, inside the
 * preparation time) counts from now - the job's real start as well (ISSUE 6: a Quick queued at 09:05
 * that started at 09:20 let a load leave at 09:05; plan-service retimeAtStart).
 *
 * Pure: no database; `now` is a parameter so tests can fix the clock.
 */
import { DEFAULT_TZ, fmtHhmm, localDateIso, localMinutes } from './time';

const DAY_MIN = 24 * 60;

export interface PlanFrom {
  /** Local time the plan was built (minutes after midnight, company timezone). */
  nowMin: number;
  /** Preparation time added to now: the company's turnaround between loads. */
  prepMin: number;
  /** No new load leaves the depot before this: now (+ the search) + preparation, at most 24:00. */
  fromMin: number;
  /**
   * A same-day THOROUGH search of up to this many minutes runs before the plan exists: its loads
   * count from its end. Absent: none (QUICK, and every plan stored before it was kept).
   */
  searchMin?: number;
}

export interface PlanFromInput {
  /** The plan's delivery day (YYYY-MM-DD). */
  runDateIso: string;
  timezone: string | null | undefined;
  /** When new loads would leave otherwise: the later of the first departure setting and the depot opening. */
  firstDepartureMin: number;
  /** Settings' turnaround between loads (minutes). */
  prepMin: number;
}

/** The loading time of a same-day plan's new loads, for the plan's texts. */
export interface PlanLoading {
  /** Settings' loading minutes per case (0 = none: nothing to add). */
  perCase: number;
  /** A load size to give as an example (the largest truck's capacity); 0 = no example. */
  exampleCases?: number;
}

/** A usable IANA timezone: the company's, or Asia/Muscat when it is empty or unknown to the runtime. */
export function zoneOf(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/**
 * The time a plan is made (minutes after midnight, company timezone) when it is made on its own
 * delivery day; null for any other day. Loading of the plan's new loads cannot start before it:
 * sent to the optimizer as config.loading_from_min (PR8 review).
 */
export function planDayNowMin(runDateIso: string, timezone: string | null | undefined, now: Date): number | null {
  const tz = zoneOf(timezone);
  return localDateIso(now, tz) === runDateIso ? localMinutes(now, tz) : null;
}

/** Whole minutes of search counted before a same-day plan's loads (0 = none). */
const wholeMin = (m: number | null | undefined) => Math.max(0, Math.ceil(m || 0));

/**
 * The start of a plan built at `now` for `runDateIso`, or null when nothing changes: the plan is
 * not for today in the company's timezone (a future day, or a past one), or now (+ `searchMin`, a
 * same-day THOROUGH search) + preparation is not later than the day's normal first departure.
 */
export function sameDayPlanFrom(input: PlanFromInput, now: Date, searchMin = 0): PlanFrom | null {
  return planFromAt(input, planDayNowMin(input.runDateIso, input.timezone, now), searchMin);
}

function planFromAt(input: PlanFromInput, nowMin: number | null, searchMin: number): PlanFrom | null {
  if (nowMin === null) return null;
  const search = wholeMin(searchMin);
  const prepMin = Math.max(0, Math.round(input.prepMin || 0));
  const fromMin = Math.min(DAY_MIN, nowMin + search + prepMin);
  if (fromMin <= input.firstDepartureMin) return null;
  return search ? { nowMin, prepMin, fromMin, searchMin: search } : { nowMin, prepMin, fromMin };
}

/** What a plan's first departure and loading depend on, beyond the clock (buildDispatchRequest). */
export interface SameDayInput extends PlanFromInput {
  /** The depot's closing time (null / 0 = open all day), for the warning. */
  depotCloseMin?: number | null;
  loading: PlanLoading;
}

/** A plan's same-day times at one moment: what the request, the warning and the settings carry. */
export interface SameDayTiming {
  /** The first departure moved to now (+ search) + preparation, or null (not today, or not later). */
  planFrom: PlanFrom | null;
  /** loading_from_min: when loading of new loads can start on the delivery day (null: another day). */
  loadingFromMin: number | null;
  /** The minutes of search counted before the loads (0 unless a same-day THOROUGH). */
  searchMin: number;
  /** The plan warning about it (planFromWarning or loadingFromWarning), or null. */
  warning: string | null;
}

/**
 * The same-day times of a plan made at `now` (the one rule for the start and the job): the first
 * departure, loading_from_min and the warning, with `searchMin` minutes of THOROUGH search counted
 * before the loads. `wasSameDay`: the plan was already for today when its request was built, so a
 * job that only starts after the delivery day ended plans nothing more that day (24:00) - never from
 * 06:00 of a day that is over.
 */
export function sameDayTiming(input: SameDayInput, now: Date, searchMin = 0, opts: { wasSameDay?: boolean } = {}): SameDayTiming {
  let nowMin = planDayNowMin(input.runDateIso, input.timezone, now);
  if (nowMin === null && opts.wasSameDay && localDateIso(now, zoneOf(input.timezone)) > input.runDateIso) nowMin = DAY_MIN;
  if (nowMin === null) return { planFrom: null, loadingFromMin: null, searchMin: 0, warning: null };
  const search = wholeMin(searchMin);
  const planFrom = planFromAt(input, nowMin, search);
  const warning = planFrom
    ? planFromWarning(planFrom, input.depotCloseMin, input.loading)
    : loadingFromWarning(nowMin, input.prepMin, input.firstDepartureMin, input.loading, search);
  return { planFrom, loadingFromMin: Math.min(DAY_MIN, nowMin + search), searchMin: search, warning };
}

/** 570 -> "09:30"; 1440 -> "24:00" (the end of the delivery day, not the next day). */
export function fmtPlanTime(min: number): string {
  return min >= DAY_MIN ? '24:00' : fmtHhmm(min);
}

const exampleOf = (l: PlanLoading | undefined) => (l && l.perCase > 0 && (l.exampleCases ?? 0) > 0 ? Math.round(l.exampleCases!) : 0);

/**
 * The plan warning of a same-day plan, e.g. "Planned from 09:30 (now 09:00 + 30 min preparation):
 * the plan is for today, so no new load leaves the depot before 09:30. ..." `depotCloseMin`: the
 * depot's closing time (null / 0 = open all day), to say plainly when nothing can leave any more.
 * `loading`: the loading minutes per case, which count from now too (PR8 review).
 */
export function planFromWarning(p: PlanFrom, depotCloseMin?: number | null, loading?: PlanLoading): string {
  const from = fmtPlanTime(p.fromMin);
  const close = depotCloseMin && depotCloseMin > 0 ? depotCloseMin : DAY_MIN;
  const closed = p.fromMin >= close;
  const ex = exampleOf(loading);
  const search = p.searchMin ?? 0;
  const load =
    !closed && loading && loading.perCase > 0
      ? ` ${search ? 'Loading starts when the search ends' : 'Loading starts now too'}, so each new load also waits for its own loading time, ${loading.perCase} min per case` +
        (ex ? `: a full ${ex}-case truck leaves at ${fmtHhmm(p.fromMin + loading.perCase * ex)} at the earliest.` : '.')
      : '';
  const tail = closed
    ? ` The depot closes at ${fmtPlanTime(close)}, so no new load can leave today: open orders stay unserved.`
    : ' Locked, loading and dispatched loads keep their times; a truck still out leaves again only after it is back and turned around.';
  const why = search
    ? `(now ${fmtHhmm(p.nowMin)} + up to ${search} min Thorough search + ${p.prepMin} min preparation): the plan is for today and cannot be used before its search ends`
    : `(now ${fmtHhmm(p.nowMin)} + ${p.prepMin} min preparation): the plan is for today`;
  return `Planned from ${from} ${why}, so no new load leaves the depot before ${from}.${load}${tail}`;
}

/**
 * The plan warning of a plan made on its delivery day BEFORE its first departure (no "Planned
 * from"), when loading from now can still push a load past the first departure: e.g. at 05:15 with
 * a 06:00 first departure, 30 min turnaround and 0.04 min per case, a full 800-case truck leaves at
 * 06:17. Null when it cannot matter (no loading per case, or even the example load is ready in time).
 * `searchMin`: a same-day THOROUGH search, after which loading starts.
 */
export function loadingFromWarning(nowMin: number, prepMin: number, firstDepartureMin: number, loading: PlanLoading, searchMin = 0): string | null {
  const ex = exampleOf(loading);
  if (!(loading.perCase > 0) || !ex) return null;
  const search = wholeMin(searchMin);
  const ready = nowMin + search + prepMin + loading.perCase * ex;
  if (ready <= firstDepartureMin) return null;
  const when = search
    ? `Planned on the delivery day at ${fmtHhmm(nowMin)} with a Thorough search of up to ${search} min: loading starts when the search ends (${fmtHhmm(nowMin + search)} at the latest), so a new load leaves no earlier than then`
    : `Planned on the delivery day at ${fmtHhmm(nowMin)}: loading starts now, so a new load leaves no earlier than now`;
  return (
    `${when} + ${prepMin} min turnaround + ` +
    `${loading.perCase} min per case of its load - a full ${ex}-case truck at ${fmtHhmm(ready)}, although the first departure is ${fmtHhmm(firstDepartureMin)}.`
  );
}

/** The ASSUMPTIONS row of a same-day plan. `loadingMinPerCase`: counted from now too (PR8 review). */
export function planFromAssumption(p: PlanFrom, loadingMinPerCase = 0): string {
  const loading = loadingMinPerCase > 0 ? ` + ${loadingMinPerCase} min loading per case of that load` : '';
  const search = p.searchMin ?? 0;
  const made = search
    ? `planned on the delivery day at ${fmtHhmm(p.nowMin)} with a Thorough search of up to ${search} min: no new load leaves before the search ends`
    : `planned on the delivery day at ${fmtHhmm(p.nowMin)}: no new load leaves before now`;
  return `${fmtPlanTime(p.fromMin)} - ${made} + ${p.prepMin} min preparation (the turnaround between loads)${loading}. Locked, loading and dispatched loads keep their times.`;
}

/**
 * The ASSUMPTIONS row of a plan made on its delivery day before its first departure, with loading
 * per case. `loadingFromMin`: when loading starts; `searchMin`: the same-day THOROUGH search before
 * it (so the plan was made that much earlier).
 */
export function loadingFromAssumption(loadingFromMin: number, prepMin: number, loadingMinPerCase: number, searchMin = 0): string {
  const search = wholeMin(searchMin);
  const made = search
    ? `planned on the delivery day at ${fmtHhmm(loadingFromMin - search)} with a Thorough search of up to ${search} min: loading starts when the search ends, so no new load leaves before then`
    : 'planned on the delivery day: loading starts then, so no new load leaves before now';
  return `${fmtHhmm(loadingFromMin)} - ${made} + ${prepMin} min turnaround + ${loadingMinPerCase} min per case of that load (nor before the first departure).`;
}
