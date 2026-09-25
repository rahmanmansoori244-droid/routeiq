/**
 * Who may call /api/cron/janitor.
 *
 * In production only `JANITOR_TOKEN` is accepted: without it every call is refused, so the public
 * endpoint never accepts the solver's service secret. Outside production (local dev) it falls back
 * to SOLVER_TOKEN to keep config minimal.
 */
import { constantTimeEqual } from './crypto';

/** The token the janitor endpoint accepts, or '' (refuse everything). */
export function expectedJanitorToken(env: NodeJS.ProcessEnv = process.env): string {
  const own = env.JANITOR_TOKEN?.trim() ?? '';
  if (own) return own;
  if (env.NODE_ENV === 'production') return '';
  return env.SOLVER_TOKEN?.trim() ?? '';
}

export function janitorAuthorized(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = expectedJanitorToken(env);
  if (!expected) return false;
  const got = req.headers.get('x-janitor-token') ?? req.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';
  if (!got) return false;
  return constantTimeEqual(got, expected);
}
