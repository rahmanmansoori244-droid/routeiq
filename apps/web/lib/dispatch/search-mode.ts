/**
 * Quick or Thorough search (owner request 29 Sep 2026: "make sure the solver is giving an optimal
 * solution even if it runs for 20 mins"; owner decision "night plans long, day re-plans quick").
 *
 * - THOROUGH: the optimizer searches up to 20 minutes (THOROUGH_MAX_SEC) and stops early once the
 *   plan stops improving (apps/solver dispatch_solver.StallRule). The default for a plan made BEFORE
 *   its delivery day - the evening plan for tomorrow.
 * - QUICK: the automatic search time by the size of the day, exactly as before. The default on the
 *   delivery day itself (late orders, re-plans), so trucks are not held.
 *
 * The day rule is the company timezone's, the same one same-day planning uses (plan-from.ts). The
 * dispatcher can choose either on any OPTIMIZE / RE-PLAN: the confirmation pre-selects the day's
 * default, and a start that names no mode (a script, an older screen) searches QUICK, exactly as
 * before search modes. Honest wording everywhere: never
 * "optimal" - "searched for up to N min; stopped when it stopped improving". No bound is computed,
 * so no gap is ever stated.
 *
 * Pure: shared by the server (start, job, stuck-plan texts) and the browser (the choice dialog, the
 * progress line, the result line). `now` and `env` are parameters so tests can fix them.
 */
import type { SearchMode, SearchReport } from '@routeiq/shared-types';
import { autoTimeLimitSec } from '../planner-bounds';
import { zoneOf } from './plan-from';
import { localDateIso } from './time';

export type { SearchMode, SearchReport };

/** THOROUGH's default cap: 20 minutes for the whole optimization. */
export const THOROUGH_MAX_SEC_DEFAULT = 1200;

/**
 * The THOROUGH cap the web asks for: env THOROUGH_MAX_SEC (10 s to 60 min; default 20 min). Sent as
 * config.max_search_sec; the solver's own THOROUGH_MAX_SEC is the ceiling (it never searches longer
 * than either). Set both to the same value.
 */
export function thoroughMaxSec(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.THOROUGH_MAX_SEC ?? '', 10);
  return Number.isFinite(n) && n >= 10 && n <= 3600 ? n : THOROUGH_MAX_SEC_DEFAULT;
}

/**
 * The web waits this long for the optimizer's answer. QUICK: 600 s, as before (the solver's request
 * budget is 540 s). THOROUGH: the cap + 2 minutes (the solver answers within the cap; the margin
 * covers sending the plan back). Never cut short by Node's fetch defaults: solver-client.ts uses
 * node:http with its own timer.
 */
export const QUICK_SOLVER_WAIT_MS = 600_000;
export const THOROUGH_WAIT_MARGIN_SEC = 120;

export function solverWaitMs(mode: SearchMode | null | undefined, capSec: number | null | undefined): number {
  if (mode !== 'THOROUGH') return QUICK_SOLVER_WAIT_MS;
  return ((capSec && capSec > 0 ? capSec : THOROUGH_MAX_SEC_DEFAULT) + THOROUGH_WAIT_MARGIN_SEC) * 1000;
}

/**
 * THOROUGH's cap in whole minutes: how long a same-day THOROUGH plan may not exist yet after its
 * search started, so its new loads count from then + this (plan-service retimeSameDay; review of the
 * long-search PR). The solver answers within the cap, everything included.
 */
export function searchLeadMin(capSec: number | null | undefined): number {
  return Math.ceil((capSec && capSec > 0 ? capSec : THOROUGH_MAX_SEC_DEFAULT) / 60);
}

/** The longest a job of this mode can take, in whole minutes (for the texts that promise it). */
export function jobMaxMinutes(mode: SearchMode | null | undefined, capSec: number | null | undefined = null): number {
  return Math.ceil(solverWaitMs(mode, capSec) / 60_000);
}

/**
 * The default for a plan of `runDateIso` made at `now`: THOROUGH when the delivery day is still
 * ahead in the company's timezone (a plan made the evening before); QUICK on the delivery day
 * itself - and for a past day. The day and plan data carry it (searchModeDefault) and the
 * OPTIMIZE / RE-PLAN confirmation pre-selects it; a start without a mode searches QUICK
 * (start-optimize.ts, requestedSearchMode).
 */
export function defaultSearchMode(runDateIso: string, timezone: string | null | undefined, now: Date): SearchMode {
  return defaultModeForDay(runDateIso, localDateIso(now, zoneOf(timezone)));
}

/** The same rule from the company's today (YYYY-MM-DD) as the screens have it (day and plan data). */
export function defaultModeForDay(runDateIso: string, todayIso: string): SearchMode {
  return runDateIso > todayIso ? 'THOROUGH' : 'QUICK';
}

/**
 * The OPTIMIZE / RE-PLAN confirmation's default and its "the plan is for today" flag, from the clock
 * when the dispatcher presses the button - never from when the screen loaded. A day or plan screen
 * left open across midnight does not reload by itself when nothing runs: from the loaded data it
 * suggested Thorough on the delivery day, said the plan was for a later day and left out the "for
 * today" warning (skeptic review of the long-search PR). `zone.timezone`: the company's (the day and
 * plan data carry it); without it (older data) the loaded `today`, as before.
 */
export function searchModeNow(
  runDateIso: string,
  zone: { timezone?: string | null; today?: string | null },
  now: Date,
): { defaultMode: SearchMode; deliveryDay: boolean } {
  const today = zone.timezone ? localDateIso(now, zoneOf(zone.timezone)) : (zone.today ?? runDateIso);
  return { defaultMode: defaultModeForDay(runDateIso, today), deliveryDay: runDateIso === today };
}

/**
 * About how long a QUICK optimization of `nStops` stops takes in all: the recommended plan's
 * automatic search, the alternatives (half of it, in parallel) and the load re-check.
 */
export function quickExpectedSec(nStops: number): number {
  return Math.round(autoTimeLimitSec(Math.max(1, nStops)) * 1.5 + 30);
}

/** "45 s", "1 min", "6 min", "1 h 5 min" - whole minutes from a minute on. */
export function fmtSearchTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export interface SearchChoice {
  mode: SearchMode;
  label: string;
  detail: string;
  /** This mode is the default for the plan's day. */
  recommended: boolean;
}

/**
 * The OPTIMIZE / RE-PLAN confirmation: both modes with the expected time. `stops`: the stops (or
 * open orders) of the day, for QUICK's estimate; null when unknown. `deliveryDay`: the plan is for
 * today in the company's timezone - a Thorough plan then cannot be used before its search ends, and
 * its new loads are timed from then (review of the long-search PR): the choice says so.
 */
export function searchChoices(defaultMode: SearchMode, stops: number | null, capSec: number = THOROUGH_MAX_SEC_DEFAULT, deliveryDay = false): SearchChoice[] {
  const quick = stops && stops > 0 ? `usually about ${fmtSearchTime(quickExpectedSec(stops))}` : 'usually a minute or two';
  const today = deliveryDay
    ? ` This plan is for today: it cannot be used before the search ends, so its new loads leave no earlier than now + up to ${fmtSearchTime(capSec)} of search + the turnaround, and the plan's loads cannot be locked or dispatched until then.`
    : '';
  return [
    {
      mode: 'THOROUGH',
      label: `Thorough - up to ${fmtSearchTime(capSec)}`,
      detail: `Searches up to ${fmtSearchTime(capSec)} for a better plan and stops early once the plan stops improving. Best for a plan made before its delivery day (the evening plan for tomorrow).${today}`,
      recommended: defaultMode === 'THOROUGH',
    },
    {
      mode: 'QUICK',
      label: `Quick - ${quick}`,
      detail: 'The automatic search time for a day of this size. Best on the delivery day itself, so trucks are not held.',
      recommended: defaultMode === 'QUICK',
    },
  ];
}

/** Why the default is what it is, for the confirmation. */
export function defaultModeReason(defaultMode: SearchMode): string {
  return defaultMode === 'THOROUGH'
    ? 'This plan is for a later day, so Thorough is suggested.'
    : 'This plan is for today, so Quick is suggested: the trucks are waiting.';
}

/**
 * The plan screen's line while a job runs, e.g. "Searching for the best plan - up to 20 min, stops
 * early when it stops improving - 6 min so far". The screen ticks it every few seconds itself.
 * `startedAt`: when the job got a solver slot (null while it waits).
 */
export function searchProgressText(
  job: { status: string; searchMode?: string | null; startedAt?: string | Date | null },
  now: Date,
  capSec: number = THOROUGH_MAX_SEC_DEFAULT,
): string | null {
  if (job.status !== 'RUNNING' || !job.startedAt) return null;
  const since = fmtSearchTime((now.getTime() - new Date(job.startedAt).getTime()) / 1000);
  return job.searchMode === 'THOROUGH'
    ? `Searching for the best plan - up to ${fmtSearchTime(capSec)}, stops early when it stops improving - ${since} so far`
    : `Searching for the best plan (Quick) - ${since} so far`;
}

/**
 * How often a screen reloads while a job runs: `baseMs` (2.5-3 s), or every 10 s once a THOROUGH
 * search has run a minute (it takes up to 20 minutes; the progress line ticks on the screen itself).
 */
export function searchPollMs(
  job: { status?: string | null; searchMode?: string | null; startedAt?: string | Date | null } | null | undefined,
  baseMs: number,
  now: Date,
): number {
  if (job?.searchMode !== 'THOROUGH' || job.status !== 'RUNNING' || !job.startedAt) return baseMs;
  return now.getTime() - new Date(job.startedAt).getTime() > 60_000 ? Math.max(baseMs, 10_000) : baseMs;
}

/**
 * The option in use when it is not the recommended plan (MIN_TRUCKS, MIN_DISTANCE). The search report
 * stored with every option is the RECOMMENDED search's (the optimizer reports that one only). An
 * alternative is searched after it, for its own goal, up to its own time limit (the option's
 * time_limit_sec) and with no early stop - so the recommended plan's "searched 12 min, stopped when
 * it stopped improving" is never its own (skeptic review of the long-search PR).
 */
export interface SearchOption {
  name: string;
  /** Its own search's time limit in seconds; null when not stored. */
  limitSec?: number | null;
}

/** The option in use as a SearchOption; null for RECOMMENDED (its search is the report itself). */
export function searchOptionOf(name: string | null | undefined, limitSec: number | null | undefined): SearchOption | null {
  return name && name !== 'RECOMMENDED' ? { name, limitSec: limitSec ?? null } : null;
}

/** What an alternative searches for, in plain words. */
const OPTION_GOAL: Record<string, string> = { MIN_TRUCKS: 'the fewest trucks', MIN_DISTANCE: 'the fewest km' };

/** The recommended plan's search in a few words, for an alternative's line. */
function recommendedSearchBrief(r: SearchReport): string {
  const searched = fmtSearchTime(r.search_sec);
  if (r.stop_reason === 'NO_PLAN') return `${modeName(r.mode)}: ${searched}, no plan found`;
  if (r.mode !== 'THOROUGH') return `Quick: ${searched}, the automatic time for a day of this size`;
  switch (r.stop_reason) {
    case 'CONVERGED':
      return `Thorough: ${searched} of up to ${fmtSearchTime(r.cap_sec)}; stopped when it stopped improving`;
    case 'CAP':
      return `Thorough: ${searched}, all the time allowed`;
    case 'STOPPED':
      return `Thorough: stopped early after ${searched} by a supervisor`;
    default:
      return `Thorough: ${searched}`;
  }
}

/**
 * One line on how the applied plan was searched, for the plan screen, the Excel SUMMARY and the
 * ASSUMPTIONS sheet. Honest: how long it searched and why it stopped; never "optimal", no gap
 * (none is known). `option`: the alternative in use (searchOptionOf) - its own search, after the
 * recommended plan's.
 */
export function searchResultText(r: SearchReport | null | undefined, option?: SearchOption | null): string | null {
  if (!r) return null;
  const searched = fmtSearchTime(r.search_sec);
  // Either mode: nothing was searched, or the search found no plan (skeptic review of the long-search PR).
  if (r.stop_reason === 'NOT_SEARCHED') {
    return `${modeName(r.mode)} search not run: no order could be planned with these trucks and hours, so there was nothing to search (see the unserved orders for why).`;
  }
  if (option) {
    const goal = OPTION_GOAL[option.name] ? ` (${OPTION_GOAL[option.name]})` : '';
    const upTo = option.limitSec && option.limitSec > 0 ? ` for up to ${fmtSearchTime(option.limitSec)}` : '';
    return `The ${option.name.replace('_', ' ')} option is in use. It searched${upTo} for its own goal${goal}, after the recommended plan's search (${recommendedSearchBrief(r)}).`;
  }
  if (r.stop_reason === 'NO_PLAN') {
    const allowed = r.mode === 'THOROUGH' ? ` (up to ${fmtSearchTime(r.cap_sec)} allowed)` : '';
    return `${modeName(r.mode)} search: searched ${searched}${allowed} and found no plan with these trucks and limits.`;
  }
  if (r.mode !== 'THOROUGH') return `Quick search: ${searched}, the automatic time for a day of this size.`;
  const last = r.last_improvement_sec != null ? ` The best plan was last improved after ${fmtSearchTime(r.last_improvement_sec)}.` : '';
  switch (r.stop_reason) {
    case 'CONVERGED':
      return `Thorough search: searched ${searched} (up to ${fmtSearchTime(r.cap_sec)} allowed); stopped when it stopped improving${
        r.stall_sec ? ` (no better plan for ${fmtSearchTime(r.stall_sec)})` : ''
      }.${last}`;
    case 'CAP': {
      // "Still improving" only when the last better plan came in the last tenth of the search.
      const late = r.last_improvement_sec != null && r.search_sec - r.last_improvement_sec <= 0.1 * r.search_sec;
      return `Thorough search: searched ${searched}, all the time allowed (${fmtSearchTime(r.cap_sec)} in all)${late ? '; it was still finding small improvements near the end' : ''}.${last}`;
    }
    case 'STOPPED':
      return `Thorough search stopped early after ${searched} by a supervisor: the best plan found so far is used.${last}`;
    default:
      return `Thorough search: searched ${searched}.${last}`;
  }
}

/**
 * The ASSUMPTIONS rows of how the plan was searched (the workbook). `option`: the alternative in use
 * - its line, and no progress row (the points are the recommended plan's search).
 */
export function searchAssumptions(r: SearchReport | null | undefined, option?: SearchOption | null): Record<string, string> {
  const line = searchResultText(r, option);
  if (!r || !line) return {};
  // No plan was searched or found: "the best one the search found" would not be true. An alternative
  // in use has a plan of its own (searched after a recommended search that found none).
  if (r.stop_reason === 'NOT_SEARCHED' || (r.stop_reason === 'NO_PLAN' && !option)) return { 'Route search': line };
  const out: Record<string, string> = {
    'Route search': line,
    'Route search - what it means':
      'The plan is the best one the search found in that time, not a proven best: no lower bound is computed, so how far it could still be from the best possible plan is not known.',
  };
  const pts = r.best_over_time ?? [];
  if (r.mode === 'THOROUGH' && pts.length > 1 && !option) {
    // The search's own score, not money: it holds a large penalty for each stop the plan had not
    // planned yet (1,000 OMR or more), so a short day's first points are in the thousands (skeptic
    // review of the long-search PR). The optimizer counts those stops with each point.
    out['Route search - progress'] =
      pts.map(([t, v, left]) => `${fmtSearchTime(t)}: ${v.toFixed(0)}${left ? ` (${left} stop${left === 1 ? '' : 's'} not planned yet)` : ''}`).join('; ') +
      " - the search's own score of the best plan so far, not money: the plan's cost and preferences plus a large penalty for every stop not planned yet, before the final load re-check.";
  }
  return out;
}

/** What an OPTIMIZE / RE-PLAN start answered (its 202 body), as far as the toast needs it. */
export interface StartedAnswer {
  /** Waiting for a solver slot. */
  queued?: boolean;
  /** The mode the job searches with - the job's own when one was already running. */
  searchMode?: SearchMode | string | null;
  /** A job was already running for the plan (another dispatcher's start): nothing new started. */
  alreadyRunning?: boolean;
}

const modeName = (m: SearchMode | string | null | undefined) => (m === 'THOROUGH' ? 'Thorough' : 'Quick');

/**
 * The toast after OPTIMIZE: from the server's answer, never from the local choice alone - a job
 * already running for the plan (another dispatcher pressed first) keeps its own mode, and the
 * dispatcher is told that their choice was not applied (review of the long-search PR).
 */
export function optimizeStartedText(a: StartedAnswer | null | undefined, chosen: SearchMode, capSec: number, stops: number | null): string {
  if (a?.alreadyRunning) {
    const running = a.searchMode === 'THOROUGH' ? 'THOROUGH' : 'QUICK';
    return running === chosen
      ? `An optimization (${modeName(running)}) is already running for this plan; nothing new was started. The plan is saved when it ends.`
      : `An optimization (${modeName(running)}) was already running for this plan, so your choice (${modeName(chosen)}) was not applied. When it ends, re-plan with ${modeName(chosen)} if needed.`;
  }
  if (a?.queued) return 'Queued: other optimizations are running. This plan starts as soon as one finishes.';
  return (a?.searchMode ?? chosen) === 'THOROUGH'
    ? `Optimizing (Thorough): up to ${fmtSearchTime(capSec)}, stops early when the plan stops improving. You can leave this page; the plan is saved when the search ends.`
    : `Optimizing (Quick): ${stops ? `usually about ${fmtSearchTime(quickExpectedSec(stops))}` : 'usually a minute or two'} for this day.`;
}

/** "Waiting ... (Thorough: up to 20 min)" - the job message a start writes. */
export function queuedMessage(mode: SearchMode, capSec: number, ahead: number | null): string {
  const how = mode === 'THOROUGH' ? `Thorough search: up to ${fmtSearchTime(capSec)}, stops early when it stops improving` : 'Quick search';
  return ahead ? `Waiting: ${ahead} optimization(s) ahead. ${how}.` : `Queued. ${how}.`;
}
