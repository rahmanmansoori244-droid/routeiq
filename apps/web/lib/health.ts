/**
 * Health of the web service (audit F15, owner decision 5): liveness and dispatch readiness are
 * separate questions.
 *
 * - Liveness (`GET /api/health/live`): the web process answers. Nothing else is checked.
 * - Readiness (`GET /api/health`, Railway's deploy health check): the database answers AND the
 *   dispatch planner could accept an optimization. That second part is checked the way an optimize
 *   would use it, without running one: SOLVER_URL and SOLVER_TOKEN are set on the web, and the
 *   solver's authenticated `GET /ready` accepts the token (apps/solver/main.py).
 *
 * The three answers:
 * - `ready`: everything works (HTTP 200, `ok: true`);
 * - `degraded`: nothing is known to be wrong, but the solver could not be asked (unreachable, timed
 *   out, an older solver without /ready, a 5xx). HTTP 200 so a deploy is not blocked, `ok: false` so
 *   monitoring alerts;
 * - `not_ready`: a definite fault - the database is down, or dispatch is misconfigured (a token
 *   missing on the web, the solver answers 401, or the solver has no token itself). HTTP 503: the
 *   deploy gate fails and the previous version keeps serving.
 *
 * Only reason codes and plain sentences are returned (the endpoint is public): never a URL, a token
 * or a solver response body.
 */
export type ReadinessStatus = 'ready' | 'degraded' | 'not_ready';

export type DispatchReason =
  | 'OK'
  | 'SOLVER_URL_MISSING'
  | 'SOLVER_TOKEN_MISSING'
  | 'SOLVER_TOKEN_REJECTED'
  | 'SOLVER_NOT_CONFIGURED'
  | 'SOLVER_UNREACHABLE'
  | 'SOLVER_READY_UNSUPPORTED'
  | 'SOLVER_ERROR';

export type Routing = { provider: string; status: 'up' | 'down' | 'not_configured' } | null;

export interface DispatchReadiness {
  /** ready: an optimize would be accepted; misconfigured: it would certainly fail; degraded: unknown. */
  status: 'ready' | 'degraded' | 'misconfigured';
  reason: DispatchReason;
  message: string;
  /** Road routing as the solver reports it (never affects the status). */
  routing: Routing;
}

/** Web -> solver readiness probe; short, like the old /health probe. */
export const READY_TIMEOUT_MS = 4000;

const MESSAGES: Record<DispatchReason, string> = {
  OK: 'The route optimizer accepts this web service.',
  SOLVER_URL_MISSING: 'SOLVER_URL is not set on the web service: no plan can be optimized.',
  SOLVER_TOKEN_MISSING: 'SOLVER_TOKEN is not set on the web service: every optimization would fail.',
  SOLVER_TOKEN_REJECTED: 'The route optimizer refused the web service token (401): set the same SOLVER_TOKEN on web and solver.',
  SOLVER_NOT_CONFIGURED: 'The route optimizer has no SOLVER_TOKEN set: it refuses every optimization.',
  SOLVER_UNREACHABLE: 'The route optimizer did not answer (unreachable or too slow). Plans cannot be optimized until it answers.',
  SOLVER_READY_UNSUPPORTED: 'The route optimizer is an older version without the readiness check: the token could not be verified.',
  SOLVER_ERROR: 'The route optimizer answered with an error to the readiness check.',
};

function answer(status: DispatchReadiness['status'], reason: DispatchReason, routing: Routing = null): DispatchReadiness {
  return { status, reason, message: MESSAGES[reason], routing };
}

function readRouting(v: unknown): Routing {
  const r = v as { provider?: unknown; status?: unknown } | null | undefined;
  if (!r || typeof r.provider !== 'string') return null;
  const status = r.status === 'up' || r.status === 'down' || r.status === 'not_configured' ? r.status : 'down';
  return { provider: r.provider, status };
}

/**
 * Could an optimization start right now? Never optimizes: one authenticated GET of the solver's
 * `/ready`, which runs the same token check as `/optimize-dispatch` and nothing else.
 */
export async function checkDispatchReadiness(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<DispatchReadiness> {
  const url = env.SOLVER_URL?.trim();
  if (!url) return answer('misconfigured', 'SOLVER_URL_MISSING');
  const token = env.SOLVER_TOKEN?.trim();
  if (!token) return answer('misconfigured', 'SOLVER_TOKEN_MISSING');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${url.replace(/\/+$/, '')}/ready`, {
      method: 'GET',
      headers: { 'X-Solver-Token': token },
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch {
    return answer('degraded', 'SOLVER_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => null)) as { ok?: unknown; detail?: unknown; routing?: unknown } | null;
  if (res.status === 401 || res.status === 403) return answer('misconfigured', 'SOLVER_TOKEN_REJECTED');
  // The solver's own token is missing: _check_token answers 500 "Solver not configured".
  if (typeof body?.detail === 'string' && /not configured/i.test(body.detail)) return answer('misconfigured', 'SOLVER_NOT_CONFIGURED');
  // A solver deployed before /ready existed (web and solver deploy independently).
  if (res.status === 404 || res.status === 405) return answer('degraded', 'SOLVER_READY_UNSUPPORTED');
  if (res.ok && body?.ok === true) return answer('ready', 'OK', readRouting(body.routing));
  return answer('degraded', 'SOLVER_ERROR');
}

/** The overall answer from the database and the dispatch readiness. */
export function overallReadiness(db: 'up' | 'down', dispatch: DispatchReadiness): { status: ReadinessStatus; httpStatus: 200 | 503 } {
  if (db === 'down' || dispatch.status === 'misconfigured') return { status: 'not_ready', httpStatus: 503 };
  if (dispatch.status === 'degraded') return { status: 'degraded', httpStatus: 200 };
  return { status: 'ready', httpStatus: 200 };
}

/** The `solver` field kept from the earlier health answer (monitoring reads it). */
export function solverField(dispatch: DispatchReadiness): 'up' | 'down' | 'misconfigured' {
  if (dispatch.status === 'ready') return 'up';
  return dispatch.status === 'misconfigured' ? 'misconfigured' : 'down';
}
