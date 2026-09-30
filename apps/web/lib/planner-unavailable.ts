/**
 * Rule 22 (owner decision, audit policy 22): the route optimizer could not start its worker
 * processes, or they stopped working during the search (out of memory, the process limit). It
 * never searches inside its own API process instead (it used to, with no deadline, freezing the
 * planner for the whole search) and answers 503 with this code within seconds
 * (apps/solver/main.py). The web shows the dispatcher the plain message below, fails the
 * job (previous plan kept, OPTIMIZE_FAILED audited with the code) and logs an ALERT line for an
 * administrator (dispatch-job.ts failJob). /api/health says SOLVER_WORKERS_FAILED (degraded) while
 * the solver's /ready reports the failed start (lib/health.ts).
 *
 * Its own module (not solver-client.ts) so tests that fake the solver client keep these values.
 */
export const WORKERS_UNAVAILABLE = 'WORKERS_UNAVAILABLE';

/** What the dispatcher reads (the job message; the plan screen adds "previous plan kept" when there is one). */
export const PLANNER_UNAVAILABLE_MESSAGE = 'The planner is busy or restarting - try again in a minute. Nothing was changed.';

/** The administrator's log line (web side), with the same code as the solver's ERROR line. */
export function plannerUnavailableAlert(runId: string, runJobId: string): string {
  return `ALERT ${WORKERS_UNAVAILABLE}: the route optimizer's worker processes could not start or stopped working, so it refused plan ${runId} (job ${runJobId}). The previous plan is kept; the dispatcher can try again in a minute. If this repeats, check the solver service's memory and process limits and restart it.`;
}
