/**
 * Where the web finds the route optimizer (the solver service): `SOLVER_URL` and `SOLVER_TOKEN`,
 * read ONE way for every caller - the optimize call and the road-line call
 * (`lib/solver-client.ts`), the readiness check of `/api/health` (`lib/health.ts`) and the startup
 * log (`lib/startup-checks.ts`) - so `/api/health` checks exactly what an optimization sends.
 *
 * Review of audit PR4: the readiness check trimmed both values and dropped a trailing slash, while
 * the client sent them as they were. With `SOLVER_URL=http://solver:8000/` health said `ready`
 * while every optimization posted `//optimize-dispatch` and got 404 ("The route optimizer is being
 * updated"); with a newline after the token health said `ready` while every call failed before it
 * was sent (a newline cannot go in a header).
 *
 * - `SOLVER_URL`: spaces and line breaks around it and trailing slashes are dropped;
 * - `SOLVER_TOKEN`: spaces and line breaks around it are dropped (HTTP drops spaces around a header
 *   value anyway, and a line break cannot be sent at all);
 * - empty after that = not set (`null`).
 */
export interface SolverEnv {
  /** Base URL without a trailing slash: append `/optimize-dispatch`, `/route-geometry`, `/ready`. */
  url: string | null;
  /** The value sent as `X-Solver-Token`. */
  token: string | null;
}

export function solverEnv(env: NodeJS.ProcessEnv = process.env): SolverEnv {
  const url = (env.SOLVER_URL ?? '').trim().replace(/\/+$/, '');
  const token = (env.SOLVER_TOKEN ?? '').trim();
  return { url: url || null, token: token || null };
}
