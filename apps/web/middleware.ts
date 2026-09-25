import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

/**
 * Edge middleware. Lightweight — only enforces authentication on protected
 * routes. It checks the session JWT and its 12 h absolute lifetime, but cannot
 * reach the database: the user/tenant re-check (lib/session-principal.ts) and
 * the tenant-slug match (`getCurrentTenant()`, lib/tenant.ts) run server-side.
 *
 * Cross-tenant mismatches return 404 (not 403) to avoid leaking tenant existence.
 */
export default auth((req) => {
  const { pathname, search } = req.nextUrl;
  const session = req.auth;

  const isProtected = pathname.startsWith('/t/') || pathname.startsWith('/admin');

  if (isProtected && !session?.user) {
    const url = new URL('/login', req.nextUrl);
    // Keep the query string so dispatch deep links (?date=&depot=) survive sign-in. The login
    // page only follows it after lib/safe-redirect.ts has reduced it to a same-origin path.
    url.searchParams.set('callbackUrl', pathname + search);
    return NextResponse.redirect(url);
  }

  // Bounce signed-in users away from login/signup screens. The root page decides where they go
  // from the database (the role in this JWT can be stale), and clears a session the server no
  // longer accepts instead of bouncing it back here.
  if ((pathname === '/login' || pathname === '/signup') && session?.user) {
    return NextResponse.redirect(new URL('/', req.nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    /*
     * Match everything except:
     * - api/auth/* (NextAuth handlers, /api/auth/end-session)
     * - api/health (must be public)
     * - _next/* (assets)
     * - favicon, robots, sitemap
     */
    '/((?!api/auth|api/health|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
