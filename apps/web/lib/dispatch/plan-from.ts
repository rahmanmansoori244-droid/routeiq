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
 * Pure: no database; `now` is a parameter so tests can fix the clock.
 */
import { DEFAULT_TZ, fmtHhmm, localDateIso, localMinutes } from './time';

const DAY_MIN = 24 * 60;

export interface PlanFrom {
  /** Local time the plan was built (minutes after midnight, company timezone). */
  nowMin: number;
  /** Preparation time added to now: the company's turnaround between loads. */
  prepMin: number;
  /** No new load leaves the depot before this: now + preparation, at most 24:00. */
  fromMin: number;
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

/**
 * The start of a plan built at `now` for `runDateIso`, or null when nothing changes: the plan is
 * not for today in the company's timezone (a future day, or a past one), or now + preparation is
 * not later than the day's normal first departure.
 */
export function sameDayPlanFrom(input: PlanFromInput, now: Date): PlanFrom | null {
  const nowMin = planDayNowMin(input.runDateIso, input.timezone, now);
  if (nowMin === null) return null;
  const prepMin = Math.max(0, Math.round(input.prepMin || 0));
  const fromMin = Math.min(DAY_MIN, nowMin + prepMin);
  if (fromMin <= input.firstDepartureMin) return null;
  return { nowMin, prepMin, fromMin };
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
  const load =
    !closed && loading && loading.perCase > 0
      ? ` Loading starts now too, so each new load also waits for its own loading time, ${loading.perCase} min per case` +
        (ex ? `: a full ${ex}-case truck leaves at ${fmtHhmm(p.fromMin + loading.perCase * ex)} at the earliest.` : '.')
      : '';
  const tail = closed
    ? ` The depot closes at ${fmtPlanTime(close)}, so no new load can leave today: open orders stay unserved.`
    : ' Locked, loading and dispatched loads keep their times; a truck still out leaves again only after it is back and turned around.';
  return `Planned from ${from} (now ${fmtHhmm(p.nowMin)} + ${p.prepMin} min preparation): the plan is for today, so no new load leaves the depot before ${from}.${load}${tail}`;
}

/**
 * The plan warning of a plan made on its delivery day BEFORE its first departure (no "Planned
 * from"), when loading from now can still push a load past the first departure: e.g. at 05:15 with
 * a 06:00 first departure, 30 min turnaround and 0.04 min per case, a full 800-case truck leaves at
 * 06:17. Null when it cannot matter (no loading per case, or even the example load is ready in time).
 */
export function loadingFromWarning(nowMin: number, prepMin: number, firstDepartureMin: number, loading: PlanLoading): string | null {
  const ex = exampleOf(loading);
  if (!(loading.perCase > 0) || !ex) return null;
  const ready = nowMin + prepMin + loading.perCase * ex;
  if (ready <= firstDepartureMin) return null;
  return (
    `Planned on the delivery day at ${fmtHhmm(nowMin)}: loading starts now, so a new load leaves no earlier than now + ${prepMin} min turnaround + ` +
    `${loading.perCase} min per case of its load - a full ${ex}-case truck at ${fmtHhmm(ready)}, although the first departure is ${fmtHhmm(firstDepartureMin)}.`
  );
}

/** The ASSUMPTIONS row of a same-day plan. `loadingMinPerCase`: counted from now too (PR8 review). */
export function planFromAssumption(p: PlanFrom, loadingMinPerCase = 0): string {
  const loading = loadingMinPerCase > 0 ? ` + ${loadingMinPerCase} min loading per case of that load` : '';
  return `${fmtPlanTime(p.fromMin)} - planned on the delivery day at ${fmtHhmm(p.nowMin)}: no new load leaves before now + ${p.prepMin} min preparation (the turnaround between loads)${loading}. Locked, loading and dispatched loads keep their times.`;
}

/** The ASSUMPTIONS row of a plan made on its delivery day before its first departure, with loading per case. */
export function loadingFromAssumption(nowMin: number, prepMin: number, loadingMinPerCase: number): string {
  return `${fmtHhmm(nowMin)} - planned on the delivery day: loading starts then, so no new load leaves before now + ${prepMin} min turnaround + ${loadingMinPerCase} min per case of that load (nor before the first departure).`;
}
