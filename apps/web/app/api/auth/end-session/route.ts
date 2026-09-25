/**
 * GET /api/auth/end-session[?next=<page>] - clear a session the server no longer accepts and go to
 * /login?reason=session ("Your session has ended"), with `next` as the callbackUrl.
 *
 * Pages send users here when the server no longer accepts their session (deactivated, demoted
 * out of their tenant, password reset, tenant suspended, or the 12 h lifetime is over) but the
 * browser still holds the cookie. Server components cannot clear cookies, and the edge middleware
 * would keep bouncing the stale cookie from /login back to '/'. This route sits under the
 * middleware's api/auth exclusion, so it always runs.
 *
 * - It never signs out a session the server still accepts. It is a plain GET that any site can
 *   trigger (a link, a redirect), so without this check anyone could sign a dispatcher out in the
 *   middle of planning. A session that is still valid goes to '/' instead. The check re-reads the
 *   user from the database (not the 30 s cache), so it agrees with the page or API call that just
 *   rejected the session.
 * - `next` (the page the user was on, sent by the dispatch screen on a 401) goes through
 *   safeCallbackUrl() and comes back as the sign-in page's callbackUrl, so the dispatcher returns
 *   to the same day and depot.
 */
import { isRedirectError } from 'next/dist/client/components/redirect';
import { auth, signOut } from '@/lib/auth';
import { refreshPrincipal } from '@/lib/session-principal';
import { sessionEndedLoginUrl } from '@/lib/safe-redirect';

export const dynamic = 'force-dynamic';

const SESSION_COOKIE = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;

/** Does the server still accept this request's session, on a fresh reading of the user? */
async function sessionStillAccepted(): Promise<boolean> {
  try {
    const cached = await auth();
    if (!cached?.user?.id) return false;
    await refreshPrincipal(cached.user.id);
    const fresh = await auth();
    return !!fresh?.user;
  } catch {
    return false;
  }
}

function sessionCookieNames(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(';')
    .map((part) => part.split('=')[0]!.trim())
    .filter((name) => SESSION_COOKIE.test(name));
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

export async function GET(req: Request) {
  if (await sessionStillAccepted()) return seeOther('/');

  const target = sessionEndedLoginUrl(new URL(req.url).searchParams.get('next'));
  try {
    // Clears the session cookie(s) and throws Next's redirect to the target.
    await signOut({ redirectTo: target });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    console.error('[end-session] sign-out failed', (err as Error)?.message ?? err);
  }
  // signOut did not redirect: expire the session cookie(s) here, so /login does not bounce back.
  const res = seeOther(target);
  for (const name of sessionCookieNames(req.headers.get('cookie'))) {
    res.headers.append('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${name.startsWith('__Secure-') ? '; Secure' : ''}`);
  }
  return res;
}
