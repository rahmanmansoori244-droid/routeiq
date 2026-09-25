/**
 * Review F09 through the REAL lib/auth.ts NextAuth handlers: session cookies minted here are sent
 * to GET /api/auth/session, and the database is a fake. A session is refreshed from the database
 * (role, tenant) or ended (null body + a cookie-clearing Set-Cookie) when the user, the tenant or
 * the password changed, or when it is older than the 12 h absolute lifetime. The edge runtime
 * never touches the database but still enforces the lifetime.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'unit-test-only-secret-unit-test-only-secret-0000';
process.env.AUTH_SECRET = SECRET;
process.env.NEXTAUTH_SECRET = SECRET;
process.env.AUTH_URL = 'http://localhost:3000';
process.env.NEXTAUTH_URL = 'http://localhost:3000';

interface Row {
  id: string;
  email: string;
  active: boolean;
  role: string;
  tenantId: string | null;
  passwordHash: string;
  tenant: { active: boolean } | null;
}
const rows = new Map<string, Row>();
const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null);

vi.mock('@/lib/db', () => ({ prisma: { user: { findUnique } } }));

const SALT = 'authjs.session-token';
let jwt: typeof import('next-auth/jwt');
let handlers: typeof import('@/lib/auth')['handlers'];
let NextRequest: typeof import('next/server')['NextRequest'];
let fp: (h: string) => Promise<string>;
let resetCache: () => void;

beforeAll(async () => {
  jwt = await import('next-auth/jwt');
  ({ handlers } = await import('@/lib/auth'));
  ({ NextRequest } = await import('next/server'));
  const sp = await import('@/lib/session-principal');
  fp = sp.passwordFingerprint;
  resetCache = sp._resetPrincipalCache;
});

beforeEach(() => {
  rows.clear();
  findUnique.mockClear();
  resetCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function user(id: string, over: Partial<Row> = {}): Row {
  const r: Row = {
    id,
    email: `${id}@example.test`,
    active: true,
    role: 'TENANT_ADMIN',
    tenantId: 'tenant-A',
    passwordHash: `$2a$12$hash-of-${id}`,
    tenant: { active: true },
    ...over,
  };
  rows.set(id, r);
  return r;
}

async function session(claims: Record<string, unknown>) {
  const token = await jwt.encode({ salt: SALT, secret: SECRET, token: { sub: String(claims.userId), ...claims } });
  const res = await handlers.GET(
    new NextRequest('http://localhost:3000/api/auth/session', { headers: { cookie: `${SALT}=${token}` } }),
  );
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SALT}=`)) ?? '';
  const cleared = /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(setCookie);
  return { body: (await res.json()) as { user?: { role?: string; tenantId?: string | null } } | null, setCookie, cleared };
}

async function claimsFor(r: Row, over: Record<string, unknown> = {}) {
  return { userId: r.id, tenantId: r.tenantId, role: r.role, pwf: await fp(r.passwordHash), authTime: Date.now() - 60_000, ...over };
}

describe('session revalidation (Node runtime)', () => {
  it('keeps a valid session and refreshes the role from the database', async () => {
    const r = user('u-demoted', { role: 'VIEWER' });
    const s = await session(await claimsFor(r, { role: 'TENANT_ADMIN' }));
    expect(s.body?.user?.role).toBe('VIEWER');
    expect(s.cleared).toBe(false);
    expect(s.setCookie).not.toBe('');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('ends the session of a deactivated user (null body + cookie cleared)', async () => {
    const r = user('u-off', { active: false });
    const s = await session(await claimsFor(r));
    expect(s.body).toBeNull();
    expect(s.cleared).toBe(true);
  });

  it('ends the session when the tenant is inactive', async () => {
    const r = user('u-suspended', { tenant: { active: false } });
    const s = await session(await claimsFor(r));
    expect(s.body).toBeNull();
    expect(s.cleared).toBe(true);
  });

  it('ends the session after a password change (fingerprint mismatch)', async () => {
    const r = user('u-reset');
    const claims = await claimsFor(r);
    r.passwordHash = '$2a$12$a-new-password-hash';
    const s = await session(claims);
    expect(s.body).toBeNull();
    expect(s.cleared).toBe(true);
  });

  it('ends the session when the user moved to another tenant', async () => {
    const r = user('u-moved');
    const claims = await claimsFor(r, { tenantId: 'tenant-OLD' });
    expect((await session(claims)).body).toBeNull();
  });

  it('treats a cookie from before this release (no authTime / pwf) as signed out', async () => {
    const r = user('u-old');
    const s = await session({ userId: r.id, tenantId: r.tenantId, role: r.role });
    expect(s.body).toBeNull();
    expect(s.cleared).toBe(true);
  });

  it('ends a session older than 12 h even while it is in use, without a database read', async () => {
    const r = user('u-long');
    const s = await session(await claimsFor(r, { authTime: Date.now() - 12 * 3600_000 - 1000 }));
    expect(s.body).toBeNull();
    expect(s.cleared).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('a platform admin not in SUPER_ADMIN_EMAILS acts as TENANT_ADMIN of their tenant', async () => {
    vi.stubEnv('SUPER_ADMIN_EMAILS', 'someone-else@example.test');
    const r = user('u-super', { role: 'SUPER_ADMIN' });
    const s = await session(await claimsFor(r));
    expect(s.body?.user?.role).toBe('TENANT_ADMIN');
    vi.stubEnv('SUPER_ADMIN_EMAILS', `${r.email}`);
    resetCache();
    expect((await session(await claimsFor(r))).body?.user?.role).toBe('SUPER_ADMIN');
  });
});

describe('session in the edge runtime (middleware)', () => {
  it('never reads the database but still enforces the absolute lifetime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const r = user('u-edge', { active: false }); // the edge cannot know; the Node side will
    const ok = await session(await claimsFor(r));
    expect(ok.body?.user?.role).toBe('TENANT_ADMIN');
    const expired = await session(await claimsFor(r, { authTime: Date.now() - 13 * 3600_000 }));
    expect(expired.body).toBeNull();
    expect(expired.cleared).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
