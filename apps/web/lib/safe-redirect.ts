/**
 * Where to go after sign-in (review F11).
 *
 * `/login?callbackUrl=...` is attacker-controllable: the login form hands the value to
 * `router.replace`, and Next's router performs a full `location.replace` for any URL whose origin
 * differs, which includes `javascript:` and `data:` URLs (origin "null") and protocol-relative
 * `//host` or `/\host` values. So the value is reduced to a same-origin relative path under one of
 * the app's page areas, or the fallback.
 */

/**
 * A placeholder origin for checks made on the server, where the browser origin is unknown: only
 * relative values resolve to it, anything absolute for a real host falls back.
 */
export const RELATIVE_ONLY_ORIGIN = 'http://routeiq.internal';

/** Clears a session the server no longer accepts, then shows the sign-in page (app/api/auth/end-session). */
export const END_SESSION_PATH = '/api/auth/end-session';

const SESSION_ENDED_LOGIN = '/login?reason=session';

const MAX_LENGTH = 2048;
const BACKSLASH = String.fromCharCode(92);

function allowedPath(path: string): boolean {
  return path === '/' || path.startsWith('/t/') || path === '/admin' || path.startsWith('/admin/');
}

/**
 * Returns a same-origin relative path (`/t/...`, `/admin...` or `/`, with its query string and
 * hash), or `fallback`. Never returns anything the router would treat as an external navigation.
 */
export function safeCallbackUrl(raw: string | null | undefined, origin: string, fallback = '/'): string {
  if (!raw || raw.length > MAX_LENGTH) return fallback;
  // Control characters, spaces and backslashes are never legitimate here, and the URL parser
  // silently strips tabs/newlines and maps "\" to "/", which is how "java\tscript:" and "/\host"
  // tricks work.
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c <= 0x20 || c === 0x7f || ch === BACKSLASH) return fallback;
  }
  let base: URL;
  let url: URL;
  try {
    base = new URL(origin);
    url = new URL(raw, base);
  } catch {
    return fallback;
  }
  // javascript:/data: URLs have origin "null"; //host, userinfo tricks and http downgrades differ.
  if (url.origin !== base.origin) return fallback;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
  if (url.username || url.password) return fallback;
  if (!allowedPath(url.pathname)) return fallback;
  return url.pathname + url.search + url.hash;
}

/**
 * The end-session URL for a browser on `here` (path + query string): after signing in again the
 * user comes back to that page, e.g. the dispatch screen with its ?date=&depot=.
 */
export function endSessionUrl(here: string): string {
  return `${END_SESSION_PATH}?next=${encodeURIComponent(here)}`;
}

/**
 * The sign-in page after the server ended a session ("Your session has ended"), with `next` as its
 * callbackUrl when `next` is a safe same-origin page path (safeCallbackUrl); otherwise without one.
 */
export function sessionEndedLoginUrl(next: string | null | undefined): string {
  const back = safeCallbackUrl(next, RELATIVE_ONLY_ORIGIN);
  return back === '/' ? SESSION_ENDED_LOGIN : `${SESSION_ENDED_LOGIN}&callbackUrl=${encodeURIComponent(back)}`;
}
