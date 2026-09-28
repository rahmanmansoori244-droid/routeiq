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
 * - empty after that = not set (`null`);
 * - a token that is set but not plain ASCII is a misconfiguration of its own (`tokenCanBeSent`).
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

/**
 * Can every solver call send this token, byte for byte the same? Only plain ASCII can: letters,
 * digits, punctuation, and a space or a tab inside it (third review of audit PR4).
 *
 * Anything else is sent differently by the two HTTP clients, or not at all, and the solver compares
 * bytes (`_check_token` in apps/solver/main.py):
 * - fetch (the readiness check, the road-line call) refuses a line break, a control character or a
 *   character above U+00FF, and sends U+0080-U+00FF as one byte;
 * - node:http (the optimize call, `postJsonLong`) refuses the same characters, but sends
 *   U+0080-U+00FF as two bytes (UTF-8, written with the request body).
 * So a zero-width space or curly quotes pasted with the token, or a line break inside it, left the
 * check "unreachable" (degraded, deploy allowed) while no optimization could be sent; a
 * non-breaking space left it "ready" while every optimization got 401.
 */
export function tokenCanBeSent(token: string): boolean {
  return /^[\t\x20-\x7e]*$/.test(token);
}

/** The first half of every message about such a token (health, startup log, optimize). */
export const TOKEN_CANNOT_BE_SENT =
  'SOLVER_TOKEN on the web service has a character that cannot be sent (for example a hidden space or a curly quote)';
