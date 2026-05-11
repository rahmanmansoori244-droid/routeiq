import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

/**
 * Edge middleware. Lightweight — only enforces authentication on protected
 * routes. The DB-backed tenant-slug match happens server-side in
 * `getCurrentTenant()` (see lib/tenant.ts) for defense in depth.
 *
 * Cross-tenant mismatches return 404 (not 403) to avoid leaking tenant existence.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  const isProtected = pathname.startsWith('/t/') || pathname.startsWith('/admin');

  if (isProtected && !session?.user) {
    const url = new URL('/login', req.nextUrl);
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }

  // Bounce signed-in users away from login/signup screens.
  if ((pathname === '/login' || pathname === '/signup') && session?.user) {
    if (session.user.role === 'SUPER_ADMIN') {
      return NextResponse.redirect(new URL('/admin', req.nextUrl));
    }
    // Without a slug here we can't deep-link to the tenant home; let the root
    // page resolve it from the session.
    return NextResponse.redirect(new URL('/', req.nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    /*
     * Match everything except:
     * - api/auth/* (NextAuth handlers)
     * - api/health (must be public)
     * - _next/* (assets)
     * - favicon, robots, sitemap
     */
    '/((?!api/auth|api/health|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
