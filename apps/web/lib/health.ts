/**
 * Health of the web service (audit F15, owner decision 5): liveness and dispatch readiness are
 * separate questions.
 *
 * - Liveness (`GET /api/health/live`): the web process answers. Nothing else is checked.
 * - Readiness (`GET /api/health`, Railway's deploy health check): the database answers AND the
 *   dispatch planner could accept an optimization. That second part is checked the way an optimize
 *   would use it, without running one: SOLVER_URL and SOLVER_TOKEN are set on the web, and the
 *   solver's authenticated `GET /ready` accepts the token (apps/solver/main.py). Both values are
 *   read by `solverEnv` (lib/solver-env.ts), the same function the optimize call uses, so the check
 *   asks the base URL and sends the token an optimization would (review of audit PR4).
 *
 * The three answers:
 * - `ready`: everything works (HTTP 200, `ok: true`);
 * - `degraded`: nothing is known to be wrong, but the solver could not be asked (unreachable, timed
 *   out, an older solver without /ready, a 5xx, a 403 from a proxy in front of it - the solver itself
 *   never answers 403 -, or a redirect), or the solver reports that its worker processes could not
 *   start recently (rule 22: it refused optimizations, SOLVER_WORKERS_FAILED). HTTP 200 so a deploy
 *   is not blocked, `ok: false` so monitoring alerts;
 * - `not_ready`: a definite fault - the database is down, or dispatch is misconfigured (a URL or a
 *   token missing on the web, a URL no call can use, a token that cannot be sent, the solver
 *   answers 401, or the solver has no token itself). HTTP 503: the deploy gate fails and the
 *   previous version keeps serving.
 *
 * Third review of audit PR4 - the check behaves like the optimize call in three more ways:
 * - a token outside plain ASCII is `misconfigured` before anything is sent (`tokenCanBeSent`);
 * - a redirect is not followed (the optimize call's node:http never follows one): `degraded`
 *   `SOLVER_URL_REDIRECTS`, never `ready`;
 * - the 4 s timeout covers the whole answer, body included (it used to stop at the headers, so a
 *   body that stopped half-way kept `/api/health` waiting for minutes).
 * Fourth review: a SOLVER_URL no call can use (no `http://`, a hidden character, a user name and
 * password; `solverUrlUsable`) is `misconfigured` `SOLVER_URL_INVALID` before anything is sent. It
 * used to fail inside `fetch` and read as `SOLVER_UNREACHABLE` (200, deploy allowed).
 *
 * Only reason codes and plain sentences are returned (the endpoint is public): never a URL, a token
 * or a solver response body.
 */
import { TOKEN_CANNOT_BE_SENT, URL_EXPECTED, URL_NOT_USABLE, solverEnv, solverUrlUsable, tokenCanBeSent } from './solver-env';

export type ReadinessStatus = 'ready' | 'degraded' | 'not_ready';

export type DispatchReason =
  | 'OK'
  | 'SOLVER_URL_MISSING'
  | 'SOLVER_URL_INVALID'
  | 'SOLVER_TOKEN_MISSING'
  | 'SOLVER_TOKEN_INVALID'
  | 'SOLVER_TOKEN_REJECTED'
  | 'SOLVER_NOT_CONFIGURED'
  | 'SOLVER_UNREACHABLE'
  | 'SOLVER_URL_REDIRECTS'
  | 'SOLVER_READY_UNSUPPORTED'
  | 'SOLVER_WORKERS_FAILED'
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
  SOLVER_URL_INVALID: `${URL_NOT_USABLE}: every optimization would fail. Set it to ${URL_EXPECTED} as plain text (http:// or https:// first, no spaces, no user name or password).`,
  SOLVER_TOKEN_MISSING: 'SOLVER_TOKEN is not set on the web service: every optimization would fail.',
  SOLVER_TOKEN_INVALID: `${TOKEN_CANNOT_BE_SENT}: every optimization would fail. Copy the token again as plain text, on web and solver.`,
  SOLVER_TOKEN_REJECTED: 'The route optimizer refused the web service token (401): set the same SOLVER_TOKEN on web and solver.',
  SOLVER_NOT_CONFIGURED: 'The route optimizer has no SOLVER_TOKEN set: it refuses every optimization.',
  SOLVER_UNREACHABLE: 'The route optimizer did not answer (unreachable or too slow). Plans cannot be optimized until it answers.',
  SOLVER_URL_REDIRECTS:
    "SOLVER_URL answers with a redirect, and an optimization does not follow one: plans cannot be optimized. Set SOLVER_URL to the solver's own address (on Railway, its private address).",
  SOLVER_READY_UNSUPPORTED: 'The route optimizer is an older version without the readiness check: the token could not be verified.',
  SOLVER_WORKERS_FAILED:
    'The route optimizer could not start its worker processes recently, so it refused optimizations ("The planner is busy or restarting"). It clears when a later optimization starts them. If it repeats, check the solver service\'s memory and process limits and restart it.',
  SOLVER_ERROR: 'The route optimizer, or a proxy in front of it, answered the readiness check with an error.',
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
  // Read exactly as the optimize call reads them (solverEnv, review of audit PR4): the check asks
  // the URL and sends the token an optimization would use.
  const { url, token } = solverEnv(env);
  if (!url) return answer('misconfigured', 'SOLVER_URL_MISSING');
  // A URL no call can use fails every optimization before anything is sent (fourth review of audit
  // PR4): a definite misconfiguration on the web, like a missing one - not "unreachable".
  if (!solverUrlUsable(url)) return answer('misconfigured', 'SOLVER_URL_INVALID');
  if (!token) return answer('misconfigured', 'SOLVER_TOKEN_MISSING');
  // A token the calls cannot send, or send differently from this check, fails every optimization
  // (third review of audit PR4): a definite misconfiguration on the web, like a missing one.
  if (!tokenCanBeSent(token)) return answer('misconfigured', 'SOLVER_TOKEN_INVALID');
  // One deadline for the whole answer, headers AND body (third review of audit PR4: the timer used
  // to stop at the headers, so a body that stopped half-way kept /api/health waiting for minutes).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  let body: { ok?: unknown; detail?: unknown; routing?: unknown; workers?: { status?: unknown } | null } | null;
  try {
    res = await fetchImpl(`${url}/ready`, {
      method: 'GET',
      headers: { 'X-Solver-Token': token },
      signal: ctrl.signal,
      cache: 'no-store',
      // The optimize call (node:http) never follows a redirect, so the check must not either: it
      // used to follow one and answer `ready` while every optimization failed with "HTTP 301". Not
      // following it also keeps the token away from the address the redirect names.
      redirect: 'manual',
    });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      void res.body?.cancel().catch(() => undefined);
      return answer('degraded', 'SOLVER_URL_REDIRECTS');
    }
    body = (await res.json().catch(() => null)) as typeof body;
  } catch {
    return answer('degraded', 'SOLVER_UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
  // The deadline passed while the body was being read: no complete answer, as if none came.
  if (ctrl.signal.aborted) return answer('degraded', 'SOLVER_UNREACHABLE');
  // Only the solver's own refusal is a definite misconfiguration: _check_token answers 401 and never
  // 403. A 403 comes from something in front of the solver (a proxy, a firewall, a wrong host): the
  // token was never checked, so it is only degraded like any other error (owner decision 5;
  // second review of audit PR4).
  if (res.status === 401) return answer('misconfigured', 'SOLVER_TOKEN_REJECTED');
  // The solver's own token is missing: _check_token answers 500 "Solver not configured".
  if (typeof body?.detail === 'string' && /not configured/i.test(body.detail)) return answer('misconfigured', 'SOLVER_NOT_CONFIGURED');
  // A solver deployed before /ready existed (web and solver deploy independently).
  if (res.status === 404 || res.status === 405) return answer('degraded', 'SOLVER_READY_UNSUPPORTED');
  // Rule 22: the solver refused an optimization recently because its worker processes could not
  // start. The token works, so it is not a misconfiguration: degraded (200, ok false), so
  // monitoring alerts an administrator without blocking a deploy.
  if (res.ok && body?.workers?.status === 'failed') return answer('degraded', 'SOLVER_WORKERS_FAILED', readRouting(body.routing));
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
