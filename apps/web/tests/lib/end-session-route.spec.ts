/**
 * GET /api/auth/end-session through the real route handler, with the session and sign-out faked:
 * - a session the server still accepts is never signed out (a cross-site GET cannot force a
 *   logout); it goes to '/';
 * - the decision uses a fresh reading of the user, not the 30 s cache;
 * - a rejected session is signed out and lands on /login?reason=session with the page it came
 *   from (`next`, reduced by safeCallbackUrl) as the callbackUrl;
 * - if sign-out fails without redirecting, the session cookies are expired by the route itself.
 */
import { redirect } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SessionLike = { user: { id: string } } | null;
const sessions: SessionLike[] = [];
const auth = vi.fn(async (): Promise<SessionLike> => (sessions.length ? sessions.shift()! : null));
const signOut = vi.fn(async (_opts: { redirectTo: string }): Promise<void> => undefined);
vi.mock('@/lib/auth', () => ({ auth, signOut }));

const refreshPrincipal = vi.fn(async (_userId: string) => undefined);
vi.mock('@/lib/session-principal', () => ({ refreshPrincipal }));

const get = (query = '', cookie?: string) =>
  new Request(`http://localhost:3000/api/auth/end-session${query}`, cookie ? { headers: { cookie } } : undefined);

beforeEach(() => {
  sessions.length = 0;
  auth.mockClear();
  signOut.mockReset();
  signOut.mockImplementation(async ({ redirectTo }) => {
    redirect(redirectTo);
  });
  refreshPrincipal.mockClear();
});

async function run(req: Request): Promise<{ status: number; location: string | null; res: Response | null; redirectTo: string | null }> {
  const { GET } = await import('@/app/api/auth/end-session/route');
  try {
    const res = await GET(req);
    return { status: res.status, location: res.headers.get('location'), res, redirectTo: null };
  } catch (err) {
    // Next's redirect() throws; the digest carries the target.
    const digest = String((err as { digest?: string }).digest ?? '');
    expect(digest.startsWith('NEXT_REDIRECT')).toBe(true);
    return { status: 307, location: digest.split(';')[2] ?? null, res: null, redirectTo: signOut.mock.calls[0]?.[0].redirectTo ?? null };
  }
}

describe('GET /api/auth/end-session', () => {
  it('a session the server still accepts is NOT signed out (no forced logout from a cross-site GET)', async () => {
    sessions.push({ user: { id: 'u1' } }, { user: { id: 'u1' } });
    const out = await run(get('?next=%2Ft%2Fnmwc%2Fdispatch'));
    expect(out.status).toBe(303);
    expect(out.location).toBe('/');
    expect(out.res?.headers.get('set-cookie')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
    expect(refreshPrincipal).toHaveBeenCalledWith('u1');
  });

  it('decides on a fresh reading: accepted by the cache but rejected after the re-read is signed out', async () => {
    sessions.push({ user: { id: 'u2' } }, null);
    const out = await run(get());
    expect(refreshPrincipal).toHaveBeenCalledWith('u2');
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(out.location).toBe('/login?reason=session');
  });

  it('a rejected session lands on sign-in with the dispatch page (day and depot) as callbackUrl', async () => {
    const page = '/t/nmwc/dispatch?date=2026-09-26&depot=dep-1';
    const out = await run(get(`?next=${encodeURIComponent(page)}`));
    expect(signOut).toHaveBeenCalledTimes(1);
    const loc = new URL(out.location!, 'http://localhost:3000');
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('reason')).toBe('session');
    expect(loc.searchParams.get('callbackUrl')).toBe(page);
  });

  it('a hostile next never becomes the callbackUrl', async () => {
    for (const next of ['//evil.example/x', 'https://evil.example/', 'javascript:alert(1)', '/api/users']) {
      signOut.mockClear();
      const out = await run(get(`?next=${encodeURIComponent(next)}`));
      expect(out.location, next).toBe('/login?reason=session');
    }
  });

  it('when sign-out fails without redirecting, the route expires the session cookies itself', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    signOut.mockImplementation(async () => {
      throw new Error('boom');
    });
    const out = await run(get('', 'authjs.session-token.0=a; authjs.session-token.1=b; other=c; __Secure-authjs.session-token=d'));
    expect(out.status).toBe(303);
    expect(out.location).toBe('/login?reason=session');
    const cleared = out.res!.headers.getSetCookie();
    expect(cleared.map((c) => c.split('=')[0])).toEqual([
      'authjs.session-token.0',
      'authjs.session-token.1',
      '__Secure-authjs.session-token',
    ]);
    expect(cleared.every((c) => /Max-Age=0/.test(c))).toBe(true);
    expect(cleared[2]).toMatch(/; Secure/);
    err.mockRestore();
  });
});
