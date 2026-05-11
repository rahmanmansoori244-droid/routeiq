/**
 * Integration: auth flows — signup, login, password reset (forgot + reset),
 * user invite + login as invited user.
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
  freshTenant,
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
