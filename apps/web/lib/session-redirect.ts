/**
 * Server-component helpers for "no usable session" (review F09 + the /login redirect loop).
 *
 * The edge middleware only checks the JWT (no database), while the Node side also re-checks the
 * user (lib/session-principal.ts). When the Node side rejects a cookie the middleware still
 * accepts, a plain redirect('/login') loops: /login bounces signed-in users back to '/'. The fix
 * is to clear the cookie first, through /api/auth/end-session, which then lands on /login.
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export const END_SESSION_PATH = '/api/auth/end-session';

const SESSION_COOKIE = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;

export function hasSessionCookie(): boolean {
  try {
    return cookies()
      .getAll()
      .some((c) => SESSION_COOKIE.test(c.name));
  } catch {
    return false;
  }
}

/** Send a visitor without a usable session to sign in, clearing a stale session cookie first. */
export function redirectToSignIn(): never {
  redirect(hasSessionCookie() ? END_SESSION_PATH : '/login');
}
