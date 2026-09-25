/**
 * GET /api/auth/end-session - clear the session cookie and go to /login?reason=session.
 *
 * Pages send users here when the server no longer accepts their session (deactivated, demoted
 * out of their tenant, password reset, tenant suspended, or the 12 h lifetime is over) but the
 * browser still holds the cookie. Server components cannot clear cookies, and the edge middleware
 * would keep bouncing the stale cookie from /login back to '/'. This route sits under the
 * middleware's api/auth exclusion, so it always runs.
 */
import { isRedirectError } from 'next/dist/client/components/redirect';
import { signOut } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const TARGET = '/login?reason=session';

export async function GET() {
  try {
    // Clears the session cookie(s) and throws Next's redirect to TARGET.
    await signOut({ redirectTo: TARGET });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    console.error('[end-session] sign-out failed', (err as Error)?.message ?? err);
  }
  return new Response(null, { status: 303, headers: { Location: TARGET, 'Cache-Control': 'no-store' } });
}
