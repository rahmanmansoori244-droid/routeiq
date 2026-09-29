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
 * open orders) of the day, for QUICK's estimate; null when unknown.
 */
export function searchChoices(defaultMode: SearchMode, stops: number | null, capSec: number = THOROUGH_MAX_SEC_DEFAULT): SearchChoice[] {
  const quick = stops && stops > 0 ? `usually about ${fmtSearchTime(quickExpectedSec(stops))}` : 'usually a minute or two';
  return [
    {
      mode: 'THOROUGH',
      label: `Thorough - up to ${fmtSearchTime(capSec)}`,
      detail: `Searches up to ${fmtSearchTime(capSec)} for a better plan and stops early once the plan stops improving. Best for a plan made before its delivery day (the evening plan for tomorrow).`,
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
 * One line on how the applied plan was searched, for the plan screen, the Excel SUMMARY and the
 * ASSUMPTIONS sheet. Honest: how long it searched and why it stopped; never "optimal", no gap
 * (none is known).
 */
export function searchResultText(r: SearchReport | null | undefined): string | null {
  if (!r) return null;
  const searched = fmtSearchTime(r.search_sec);
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

/** The ASSUMPTIONS rows of how the plan was searched (the workbook). */
export function searchAssumptions(r: SearchReport | null | undefined): Record<string, string> {
  const line = searchResultText(r);
  if (!r || !line) return {};
  const out: Record<string, string> = {
    'Route search': line,
    'Route search - what it means':
      'The plan is the best one the search found in that time, not a proven best: no lower bound is computed, so how far it could still be from the best possible plan is not known.',
  };
  const pts = r.best_over_time ?? [];
  if (r.mode === 'THOROUGH' && pts.length > 1) {
    out['Route search - progress'] =
      pts.map(([t, v]) => `${fmtSearchTime(t)}: ${v.toFixed(0)}`).join('; ') +
      " (search score of the best plan so far, in the currency: the optimizer's own cost, before the final load re-check)";
  }
  return out;
}

/** "Waiting ... (Thorough: up to 20 min)" - the job message a start writes. */
export function queuedMessage(mode: SearchMode, capSec: number, ahead: number | null): string {
  const how = mode === 'THOROUGH' ? `Thorough search: up to ${fmtSearchTime(capSec)}, stops early when it stops improving` : 'Quick search';
  return ahead ? `Waiting: ${ahead} optimization(s) ahead. ${how}.` : `Queued. ${how}.`;
}
