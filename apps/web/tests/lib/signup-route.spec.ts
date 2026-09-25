/**
 * Review F10 + owner decision (Sep 2026): public sign-up stays OPEN by default, but it always
 * creates a TENANT_ADMIN of the new company, never a platform admin, whatever SUPER_ADMIN_EMAILS
 * says. SIGNUP_MODE=closed turns it off (404, nothing created).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const created: { users: Array<Record<string, unknown>>; tenants: Array<Record<string, unknown>> } = { users: [], tenants: [] };
const tx = {
  tenant: {
    findUnique: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const t = { id: `t-${created.tenants.length + 1}`, ...data };
      created.tenants.push(t);
      return t;
    }),
  },
  user: {
    findUnique: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const u = { id: `u-${created.users.length + 1}`, ...data };
      created.users.push(u);
      return u;
    }),
  },
  auditLog: { create: vi.fn(async () => ({})) },
};
const $transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

vi.mock('@/lib/db', () => ({ prisma: { $transaction } }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn(async () => '$2a$12$not-a-real-hash'), auth: vi.fn() }));

const { POST } = await import('@/app/api/auth/signup/route');

const body = (email: string) => ({
  companyName: 'Test Water Co',
  slug: `tw${Math.floor(Math.random() * 1e6)}`,
  country: 'Oman',
  currency: 'OMR',
  primaryUnit: 'CASES',
  email,
  password: 'Password-12345',
  name: 'Test Admin',
});
const post = (email: string) =>
  POST(new Request('http://localhost/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(email)) }));

beforeEach(() => {
  created.users.length = 0;
  created.tenants.length = 0;
  $transaction.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/auth/signup', () => {
  it('is open by default and creates the tenant with its first TENANT_ADMIN', async () => {
    vi.stubEnv('SIGNUP_MODE', '');
    const res = await post('first@company.example');
    expect(res.status).toBe(201);
    expect(created.tenants).toHaveLength(1);
    expect(created.users[0]).toMatchObject({ email: 'first@company.example', role: 'TENANT_ADMIN' });
  });

  it('never grants SUPER_ADMIN, even for an email in SUPER_ADMIN_EMAILS', async () => {
    vi.stubEnv('SUPER_ADMIN_EMAILS', 'owner@routeiq.example');
    const res = await post('Owner@RouteIQ.example');
    expect(res.status).toBe(201);
    expect(created.users[0]).toMatchObject({ email: 'owner@routeiq.example', role: 'TENANT_ADMIN' });
  });

  it('SIGNUP_MODE=closed answers 404 and creates nothing', async () => {
    vi.stubEnv('SIGNUP_MODE', 'closed');
    const res = await post('late@company.example');
    expect(res.status).toBe(404);
    expect($transaction).not.toHaveBeenCalled();
    expect(created.tenants).toHaveLength(0);
  });

  it('SIGNUP_MODE=open answers 201', async () => {
    vi.stubEnv('SIGNUP_MODE', 'open');
    expect((await post('open@company.example')).status).toBe(201);
  });
});
