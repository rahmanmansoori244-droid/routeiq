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
 * before the first departure) is built exactly as before.
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

/** A usable IANA timezone: the company's, or Asia/Muscat when it is empty or unknown to the runtime. */
function zoneOf(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/**
 * The start of a plan built at `now` for `runDateIso`, or null when nothing changes: the plan is
 * not for today in the company's timezone (a future day, or a past one), or now + preparation is
 * not later than the day's normal first departure.
 */
export function sameDayPlanFrom(input: PlanFromInput, now: Date): PlanFrom | null {
  const tz = zoneOf(input.timezone);
  if (localDateIso(now, tz) !== input.runDateIso) return null;
  const nowMin = localMinutes(now, tz);
  const prepMin = Math.max(0, Math.round(input.prepMin || 0));
  const fromMin = Math.min(DAY_MIN, nowMin + prepMin);
  if (fromMin <= input.firstDepartureMin) return null;
  return { nowMin, prepMin, fromMin };
}

/** 570 -> "09:30"; 1440 -> "24:00" (the end of the delivery day, not the next day). */
export function fmtPlanTime(min: number): string {
  return min >= DAY_MIN ? '24:00' : fmtHhmm(min);
}

/**
 * The plan warning of a same-day plan, e.g. "Planned from 09:30 (now 09:00 + 30 min preparation):
 * the plan is for today, so no new load leaves the depot before 09:30. ..." `depotCloseMin`: the
 * depot's closing time (null / 0 = open all day), to say plainly when nothing can leave any more.
 */
export function planFromWarning(p: PlanFrom, depotCloseMin?: number | null): string {
  const from = fmtPlanTime(p.fromMin);
  const close = depotCloseMin && depotCloseMin > 0 ? depotCloseMin : DAY_MIN;
  const tail =
    p.fromMin >= close
      ? ` The depot closes at ${fmtPlanTime(close)}, so no new load can leave today: open orders stay unserved.`
      : ' Locked, loading and dispatched loads keep their times; a truck still out leaves again only after it is back and turned around.';
  return `Planned from ${from} (now ${fmtHhmm(p.nowMin)} + ${p.prepMin} min preparation): the plan is for today, so no new load leaves the depot before ${from}.${tail}`;
}

/** The ASSUMPTIONS row of a same-day plan. */
export function planFromAssumption(p: PlanFrom): string {
  return `${fmtPlanTime(p.fromMin)} - planned on the delivery day at ${fmtHhmm(p.nowMin)}: no new load leaves before now + ${p.prepMin} min preparation (the turnaround between loads). Locked, loading and dispatched loads keep their times.`;
}
