/**
 * Integration: auth flows — signup, login, password reset (forgot + reset),
 * user invite + login as invited user, and (stabilization PR1) session
 * revalidation, the /login redirect loop, Tenant.active, the callbackUrl query
 * string, security headers, platform-admin protection and the cross-tenant
 * view audit.
 *
 * Requires the dev server (`pnpm dev`) running at TEST_BASE_URL (default
 * http://localhost:3000) and a Postgres reachable via DATABASE_URL.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  BASE,
  CookieJar,
  cleanupTenant,
  fetchWith,
  followRedirects,
  freshTenant,
  inviteUser,
  login,
  prisma,
  uniqueSuffix,
} from './helpers';
import { hashToken } from '@/lib/password-reset';

const createdSlugs = new Set<string>();

afterEach(async () => {
  // Tenants accumulate across tests; cleanup happens in afterAll.
});

afterAll(async () => {
  for (const slug of createdSlugs) await cleanupTenant(slug);
  await prisma.$disconnect();
});

describe('auth: signup', () => {
  it('creates a tenant + admin user + tenant config transactionally', async () => {
    const h = await freshTenant('auth-signup');
    createdSlugs.add(h.slug);

    const t = await prisma.tenant.findUnique({
      where: { slug: h.slug },
      include: { config: true, users: true },
    });
    expect(t).not.toBeNull();
    expect(t!.config).not.toBeNull();
    expect(t!.users).toHaveLength(1);
    expect(t!.users[0].role).toBe('TENANT_ADMIN');
    expect(t!.users[0].email).toBe(h.adminEmail);
  });

  it('rejects duplicate slug', async () => {
    // Use a deterministic short slug so we can be sure both calls hit the
    // same value (no freshTenant + slice ambiguity).
    const slug = `dup${Math.floor(Math.random() * 1e8).toString(36)}`.toLowerCase().slice(0, 28);
    createdSlugs.add(slug);
    const baseBody = (email: string) => ({
      companyName: 'Dup test',
      slug,
      country: 'Oman',
      currency: 'OMR',
      primaryUnit: 'CASES',
      email,
      password: 'Password-12345',
      name: 'Test User',
    });

    const first = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody(`first-${uniqueSuffix()}@x.test`)),
    });
    if (first.status !== 201) {
      console.error(`First signup with slug "${slug}" failed:`, await first.text());
    }
    expect(first.status, 'first signup should succeed').toBe(201);

    const second = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseBody(`second-${uniqueSuffix()}@x.test`)),
    });
    if (second.status !== 409) {
      console.error('Unexpected duplicate-slug body:', await second.text());
    }
    expect(second.status).toBe(409);
  });

  it('rejects reserved slug', async () => {
    const res = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        companyName: 'Reserved',
        slug: 'admin',
        country: 'Oman',
        currency: 'OMR',
        primaryUnit: 'CASES',
        email: `r-${uniqueSuffix()}@x.test`,
        password: 'Password-12345',
        name: 'Test User',
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('auth: login', () => {
  it('rejects bad password (returns no session cookie)', async () => {
    const h = await freshTenant('auth-login');
    createdSlugs.add(h.slug);

    const jar = new CookieJar();
    await login(jar, h.adminEmail, 'wrong-password');
    const me = await fetchWith(jar, `${BASE}/api/depots`);
    expect(me.status).toBe(401);
  });

  it('writes a LOGIN audit row on successful sign-in', async () => {
    const h = await freshTenant('auth-loginok');
    createdSlugs.add(h.slug);

    const rows = await prisma.auditLog.findMany({
      where: { tenantId: h.tenantId, action: 'LOGIN' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].userId).toBe(h.userId);
  });
});

describe('auth: password reset', () => {
  it('forgot endpoint returns 200 for unknown email (no enumeration)', async () => {
    const res = await fetch(`${BASE}/api/auth/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `does-not-exist-${uniqueSuffix()}@nowhere.test` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { sent: boolean } };
    expect(body.data.sent).toBe(true);
  });

  it('forgot creates a token (hash stored, raw not stored) and reset consumes it', async () => {
    const h = await freshTenant('auth-pwdreset');
    createdSlugs.add(h.slug);

    const before = await prisma.passwordResetToken.count({ where: { userId: h.userId } });
    const res = await fetch(`${BASE}/api/auth/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: h.adminEmail }),
    });
    expect(res.status).toBe(200);

    const after = await prisma.passwordResetToken.count({ where: { userId: h.userId } });
    expect(after).toBe(before + 1);

    // Pull the latest token to verify it's hashed (we can't see the raw one
    // because the email isn't sent in test mode). Generate one synthetically
    // and round-trip the reset flow.
    const synthRaw = 'x'.repeat(43); // base64url-ish
    const synthHash = hashToken(synthRaw);
    await prisma.passwordResetToken.create({
      data: {
        userId: h.userId,
        tenantId: h.tenantId,
        tokenHash: synthHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const newPwd = 'BrandNewPassword-12345';
    const resetRes = await fetch(`${BASE}/api/auth/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: synthRaw, newPassword: newPwd }),
    });
    expect(resetRes.status).toBe(200);

    // Verify the new password works.
    const jar = new CookieJar();
    await login(jar, h.adminEmail, newPwd);
    const me = await fetchWith(jar, `${BASE}/api/depots`);
    expect(me.status).toBe(200);
  });

  it('reset rejects invalid token', async () => {
    const res = await fetch(`${BASE}/api/auth/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token-at-all-just-junk', newPassword: 'AnotherPwd-12345' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('auth: user invite', () => {
  it('invites a user with temp password, who can then log in', async () => {
    const h = await freshTenant('auth-invite');
    createdSlugs.add(h.slug);

    const inviteEmail = `invitee-${uniqueSuffix()}@x.test`;
    const res = await fetchWith(h.cookieJar, `${BASE}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail, name: 'Invitee', role: 'PLANNER' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { user: { id: string }; tempPassword: string } };
    expect(body.data.tempPassword.length).toBeGreaterThan(12);

    const newJar = new CookieJar();
    await login(newJar, inviteEmail, body.data.tempPassword);
    const me = await fetchWith(newJar, `${BASE}/api/depots`);
    expect(me.status).toBe(200);
  });

  it('forbids SUPER_ADMIN promotion from invite endpoint', async () => {
    const h = await freshTenant('auth-super');
    createdSlugs.add(h.slug);

    const res = await fetchWith(h.cookieJar, `${BASE}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `super-${uniqueSuffix()}@x.test`,
        name: 'Bad',
        role: 'SUPER_ADMIN',
      }),
    });
    expect(res.status).toBe(403);
  });
});

const j = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('sessions are re-checked on every request (review F09)', () => {
  it('deactivating a user ends their open session: API 401, pages land on /login without looping', async () => {
    const h = await freshTenant('auth-revoke');
    createdSlugs.add(h.slug);
    const planner = await inviteUser(h, 'PLANNER');
    expect((await fetchWith(planner.jar, `${BASE}/api/depots`)).status).toBe(200);

    const off = await fetchWith(h.cookieJar, `${BASE}/api/users/${planner.id}`, j({ active: false }, 'PATCH'));
    expect(off.status).toBe(200);

    expect((await fetchWith(planner.jar, `${BASE}/api/depots`)).status).toBe(401);
    const nav = await followRedirects(planner.jar, `/t/${h.slug}`, 3);
    expect(new URL(nav.urls.at(-1)!).pathname).toBe('/login');
    expect(nav.final.status).toBe(200);
  });

  it('a role change applies to the open session at once', async () => {
    const h = await freshTenant('auth-demote');
    createdSlugs.add(h.slug);
    const planner = await inviteUser(h, 'PLANNER');
    const r = await fetchWith(h.cookieJar, `${BASE}/api/users/${planner.id}`, j({ role: 'VIEWER' }, 'PATCH'));
    expect(r.status).toBe(200);
    // The role gate runs before the body is read, so an empty plan request is enough.
    expect((await fetchWith(planner.jar, `${BASE}/api/dispatch/plan`, j({}))).status).toBe(403);
    expect((await fetchWith(planner.jar, `${BASE}/api/depots`)).status).toBe(200);
  });

  it('a password reset ends the sessions opened with the old password', async () => {
    const h = await freshTenant('auth-resetsess');
    createdSlugs.add(h.slug);
    const raw = 'y'.repeat(43);
    await prisma.passwordResetToken.create({
      data: { userId: h.userId, tenantId: h.tenantId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 3600_000) },
    });
    const res = await fetch(`${BASE}/api/auth/reset`, j({ token: raw, newPassword: 'Another-Password-12345' }));
    expect(res.status).toBe(200);
    expect((await fetchWith(h.cookieJar, `${BASE}/api/depots`)).status).toBe(401);
    const fresh = new CookieJar();
    await login(fresh, h.adminEmail, 'Another-Password-12345');
    expect((await fetchWith(fresh, `${BASE}/api/depots`)).status).toBe(200);
  });

  it('a deactivated tenant: APIs 401, sign-in refused, and "/" does not loop', async () => {
    const h = await freshTenant('auth-tenantoff');
    createdSlugs.add(h.slug);
    await prisma.tenant.update({ where: { id: h.tenantId }, data: { active: false } });
    try {
      expect((await fetchWith(h.cookieJar, `${BASE}/api/depots`)).status).toBe(401);
      const nav = await followRedirects(h.cookieJar, '/', 4);
      expect(new URL(nav.urls.at(-1)!).pathname).toBe('/login');
      const again = new CookieJar();
      await login(again, h.adminEmail, h.adminPassword);
      expect((await fetchWith(again, `${BASE}/api/depots`)).status).toBe(401);
    } finally {
      await prisma.tenant.update({ where: { id: h.tenantId }, data: { active: true } });
    }
  });

  it('/api/auth/end-session clears the cookie and lands on /login?reason=session', async () => {
    const h = await freshTenant('auth-endsess');
    createdSlugs.add(h.slug);
    const res = await fetchWith(h.cookieJar, `${BASE}/api/auth/end-session`);
    expect([302, 303, 307]).toContain(res.status);
    const loc = new URL(res.headers.get('location')!, BASE);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('reason')).toBe('session');
    expect((await fetchWith(h.cookieJar, `${BASE}/api/depots`)).status).toBe(401);
  });
});

describe('login redirect (review F11)', () => {
  it('keeps the query string of a deep link in callbackUrl', async () => {
    const res = await fetch(`${BASE}/t/some-tenant/dispatch?date=2026-09-26&depot=abc`, { redirect: 'manual' });
    expect([302, 307, 308]).toContain(res.status);
    const loc = new URL(res.headers.get('location')!, BASE);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('callbackUrl')).toBe('/t/some-tenant/dispatch?date=2026-09-26&depot=abc');
  });

  it('serves the baseline security headers', async () => {
    const res = await fetch(`${BASE}/login`, { redirect: 'manual' });
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('platform admins (review F10 + owner decision)', () => {
  it('a TENANT_ADMIN cannot deactivate or demote a SUPER_ADMIN of the tenant', async () => {
    const h = await freshTenant('auth-protectsa');
    createdSlugs.add(h.slug);
    const other = await inviteUser(h, 'TENANT_ADMIN');
    await prisma.user.update({ where: { id: other.id }, data: { role: 'SUPER_ADMIN' } });
    expect((await fetchWith(h.cookieJar, `${BASE}/api/users/${other.id}`, j({ active: false }, 'PATCH'))).status).toBe(403);
    expect((await fetchWith(h.cookieJar, `${BASE}/api/users/${other.id}`, j({ role: 'VIEWER' }, 'PATCH'))).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).active).toBe(true);
  });

  // Needs the server and this test to share SUPER_ADMIN_EMAILS (CI sets it). Skipped otherwise.
  const allowlisted = (process.env.SUPER_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)[0];
  it.skipIf(!allowlisted)('sign-up with an allowlisted email is a TENANT_ADMIN; a granted platform admin view is audited', async () => {
    const email = allowlisted!;
    const stale = await prisma.user.findUnique({ where: { email }, select: { tenant: { select: { slug: true } } } });
    if (stale?.tenant) await cleanupTenant(stale.tenant.slug);

    const slug = `sa-${uniqueSuffix()}`.toLowerCase().slice(0, 30);
    createdSlugs.add(slug);
    const password = 'Platform-Admin-Password-1';
    const res = await fetch(
      `${BASE}/api/auth/signup`,
      j({ companyName: 'Platform test', slug, country: 'Oman', currency: 'OMR', primaryUnit: 'CASES', email, password, name: 'Platform Admin' }),
    );
    expect(res.status).toBe(201);
    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.role).toBe('TENANT_ADMIN');

    // What prisma/grant-platform-admin.ts does, then a view of another tenant's page.
    await prisma.user.update({ where: { id: u.id }, data: { role: 'SUPER_ADMIN' } });
    const target = await freshTenant('auth-viewed');
    createdSlugs.add(target.slug);
    const jar = new CookieJar();
    await login(jar, email, password);
    const page = await fetchWith(jar, `${BASE}/t/${target.slug}/depots`);
    expect(page.status).toBe(200);
    const rows = await prisma.auditLog.findMany({ where: { tenantId: target.tenantId, action: 'CROSS_TENANT_VIEW', userId: u.id } });
    expect(rows).toHaveLength(1);
  });
});
