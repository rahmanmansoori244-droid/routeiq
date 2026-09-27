/**
 * Runtime checks of the PR1 API guards through the real route handlers, with the session, the
 * tenant-scoped client and Prisma faked:
 * - F15/F23 role gates (users, audit, tenant config, job debug) and the runs GET projection;
 * - L16: a job of another run is 404, not 500;
 * - F13: Driver reads/writes project their columns; audit rows are redacted on read;
 * - new issue: a TENANT_ADMIN cannot change a SUPER_ADMIN; user changes invalidate the session cache;
 * - admin password reset (the reset path without email): TENANT_ADMIN only, never a platform admin
 *   or yourself, one transaction (hash, reset links retired, audit row without a hash), sessions end;
 * - new issue: deleting a driver used on a load deactivates it instead (PlanLoad.driverId kept);
 * - DISABLE: the retired driver-app routes answer 410 without touching the database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'SUPERVISOR' | 'PLANNER' | 'VIEWER';
let sessionRole: Role = 'TENANT_ADMIN';
const auth = vi.fn(async () => ({
  user: { id: 'me', tenantId: 'tA', role: sessionRole, name: 'Me', email: 'me@a.example' },
}));
vi.mock('@/lib/auth', () => ({ auth, hashPassword: vi.fn(async () => 'h') }));

// Any access to the unscoped client that a test did not set up fails loudly.
const prismaFake: Record<string, unknown> = {};
vi.mock('@/lib/db', () => ({
  prisma: new Proxy(prismaFake, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      throw new Error(`unexpected prisma.${prop}`);
    },
  }),
}));

const db = {
  auditLog: { findMany: vi.fn(), create: vi.fn(async () => ({})) },
  runJob: { findFirst: vi.fn() },
  runPlan: { findUnique: vi.fn() },
  driver: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  planLoad: { count: vi.fn() },
  driverShift: { count: vi.fn() },
};
vi.mock('@/lib/tenant', () => ({ tenantDb: () => db }));

const invalidatePrincipal = vi.fn();
vi.mock('@/lib/session-principal', async (orig) => ({
  ...(await orig<typeof import('@/lib/session-principal')>()),
  invalidatePrincipal,
}));

function resetAll() {
  for (const k of Object.keys(prismaFake)) delete prismaFake[k];
  for (const model of Object.values(db)) for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset();
  db.auditLog.create.mockResolvedValue({});
  // audit() without a transaction writes through the unscoped client.
  prismaFake.auditLog = { create: vi.fn(async () => ({})) };
  invalidatePrincipal.mockReset();
  auth.mockClear();
}
beforeEach(() => {
  sessionRole = 'TENANT_ADMIN';
  resetAll();
});

const get = (url: string) => new Request(`http://localhost${url}`);
const send = (url: string, method: string, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('role gates (F15, F23)', () => {
  it('GET /api/users, /api/audit, /api/tenant/config: 403 below TENANT_ADMIN', async () => {
    const users = await import('@/app/api/users/route');
    const auditRoute = await import('@/app/api/audit/route');
    const config = await import('@/app/api/tenant/config/route');
    for (const role of ['SUPERVISOR', 'PLANNER', 'VIEWER'] as const) {
      sessionRole = role;
      expect((await users.GET(get('/api/users'))).status, role).toBe(403);
      expect((await auditRoute.GET(get('/api/audit'))).status, role).toBe(403);
      expect((await config.GET(get('/api/tenant/config'))).status, role).toBe(403);
    }
  });

  it('GET /api/users works for TENANT_ADMIN', async () => {
    prismaFake.user = { findMany: vi.fn(async () => [{ id: 'u1', email: 'a@b.c' }]) };
    const users = await import('@/app/api/users/route');
    expect((await users.GET(get('/api/users'))).status).toBe(200);
  });

  it('GET /api/audit redacts credential hashes in stored rows', async () => {
    db.auditLog.findMany.mockResolvedValue([
      { id: 'a1', action: 'UPDATE', entity: 'Driver', beforeJson: { code: 'D1', accessPinHash: '$2a$12$abc' }, afterJson: { code: 'D1', accessPinHash: '$2a$12$def' }, user: null },
    ]);
    const auditRoute = await import('@/app/api/audit/route');
    const res = await auditRoute.GET(get('/api/audit?entity=Driver'));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('accessPinHash');
    expect(text).not.toMatch(/\$2[aby]\$\d\d\$/);
  });

  it('job debug: 403 below SUPERVISOR; a job of another run is 404 (L16)', async () => {
    const debug = await import('@/app/api/runs/[id]/jobs/[jobId]/debug/route');
    const ctx = { params: { id: 'run-1', jobId: 'job-of-run-2' } };
    sessionRole = 'PLANNER';
    expect((await debug.GET(get('/x'), ctx)).status).toBe(403);
    sessionRole = 'SUPERVISOR';
    db.runJob.findFirst.mockResolvedValue(null);
    const res = await debug.GET(get('/x'), ctx);
    expect(res.status).toBe(404);
    expect(db.runJob.findFirst.mock.calls[0]?.[0]).toMatchObject({ where: { id: 'job-of-run-2', runId: 'run-1' } });
  });

  it('GET /api/runs/[id] never selects the solver request/response JSON', async () => {
    sessionRole = 'VIEWER';
    db.runPlan.findUnique.mockResolvedValue({ id: 'run-1', jobs: [] });
    const run = await import('@/app/api/runs/[id]/route');
    expect((await run.GET(get('/api/runs/run-1'), { params: { id: 'run-1' } })).status).toBe(200);
    const jobs = (db.runPlan.findUnique.mock.calls[0]?.[0] as { include: { jobs: { select: Record<string, boolean> } } }).include.jobs;
    expect(jobs.select).toBeDefined();
    expect(jobs.select).not.toHaveProperty('requestJson');
    expect(jobs.select).not.toHaveProperty('responseJson');
    expect(jobs.select).not.toHaveProperty('errorJson');
  });
});

describe('users: platform admins are protected; changes reach open sessions', () => {
  /** PATCH /api/users/:id runs in one transaction (audit F11); `order` records its steps. */
  function usersTx(user: Record<string, unknown>) {
    const order: string[] = [];
    const tx = {
      $executeRawUnsafe: vi.fn(async (sql: string) => (order.push(sql), 0)),
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => (order.push(strings.join('?')), [{ id: 'tA' }])),
      user: Object.fromEntries(Object.entries(user).map(([k, fn]) => [k, vi.fn(async (a: unknown) => (order.push(`user.${k}`), (fn as (a: unknown) => unknown)(a)))])),
      auditLog: { create: vi.fn(async (_a: unknown) => (order.push('auditLog.create'), {})) },
    };
    prismaFake.$transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    return { tx, order };
  }

  it('a TENANT_ADMIN cannot deactivate or demote a SUPER_ADMIN of the tenant', async () => {
    const { tx } = usersTx({ findFirst: () => ({ id: 'boss', email: 'o@x', name: 'O', role: 'SUPER_ADMIN', active: true }) });
    const route = await import('@/app/api/users/[id]/route');
    const res = await route.PATCH(send('/api/users/boss', 'PATCH', { active: false }), { params: { id: 'boss' } });
    expect(res.status).toBe(403);
    expect(tx.user.updateMany).toBeUndefined();
    expect(invalidatePrincipal).not.toHaveBeenCalled();
  });

  it('a normal role change invalidates the cached principal of that user', async () => {
    usersTx({
      findFirst: () => ({ id: 'u2', email: 'p@x', name: 'P', role: 'PLANNER', active: true }),
      count: () => 1,
      updateMany: () => ({ count: 1 }),
      findUniqueOrThrow: () => ({ id: 'u2', email: 'p@x', name: 'P', role: 'VIEWER', active: true }),
    });
    const route = await import('@/app/api/users/[id]/route');
    const res = await route.PATCH(send('/api/users/u2', 'PATCH', { role: 'VIEWER' }), { params: { id: 'u2' } });
    expect(res.status).toBe(200);
    expect(invalidatePrincipal).toHaveBeenCalledWith('u2');
  });

  it('audit F11: the company lock is taken first, then the user is read, the last-admin check counted, the change and its audit row written - one transaction', async () => {
    const { tx, order } = usersTx({
      findFirst: () => ({ id: 'a2', email: 'a2@x', name: 'A2', role: 'TENANT_ADMIN', active: true }),
      count: () => 1,
      updateMany: () => ({ count: 1 }),
      findUniqueOrThrow: () => ({ id: 'a2', email: 'a2@x', name: 'A2', role: 'TENANT_ADMIN', active: false }),
    });
    const route = await import('@/app/api/users/[id]/route');
    const res = await route.PATCH(send('/api/users/a2', 'PATCH', { active: false }), { params: { id: 'a2' } });
    expect(res.status).toBe(200);
    expect(order[0]).toMatch(/lock_timeout/);
    expect(order[1]).toContain('FROM "Tenant" WHERE id = ? FOR NO KEY UPDATE');
    expect(order.slice(2)).toEqual(['user.findFirst', 'user.count', 'user.updateMany', 'user.findUniqueOrThrow', 'auditLog.create']);
    expect(tx.$queryRaw.mock.calls[0]?.slice(1)).toEqual(['tA']);
    // The last-admin check ran inside the transaction, never on the unscoped client.
    expect(prismaFake.user).toBeUndefined();
  });

  it('audit F11: the last active admin cannot be deactivated or demoted, by themselves or another admin (400, nothing written)', async () => {
    const { tx } = usersTx({ findFirst: () => ({ id: 'a2', email: 'a2@x', name: 'A2', role: 'TENANT_ADMIN', active: true }), count: () => 0 });
    const route = await import('@/app/api/users/[id]/route');
    const res = await route.PATCH(send('/api/users/a2', 'PATCH', { role: 'PLANNER' }), { params: { id: 'a2' } });
    expect(res.status).toBe(400);
    expect(tx.user.updateMany).toBeUndefined();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('admin password reset (POST /api/users/[id]/reset-password)', () => {
  const ctx = (id: string) => ({ params: { id } });
  function fakeTx() {
    const tx = {
      // Audit F10: the user's row is locked first (lockUserCredentials).
      $queryRaw: vi.fn(async (_s: TemplateStringsArray, ..._v: unknown[]) => [{ id: 'u2' }]),
      user: { updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })) },
      passwordResetToken: { updateMany: vi.fn(async (_args: unknown) => ({ count: 2 })) },
      auditLog: { create: vi.fn(async (_args: unknown) => ({})) },
    };
    prismaFake.$transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    return tx;
  }
  const target = (over: Record<string, unknown> = {}) => ({ id: 'u2', email: 'planner@a.example', role: 'PLANNER', ...over });

  it('403 below TENANT_ADMIN, before any database read', async () => {
    const route = await import('@/app/api/users/[id]/reset-password/route');
    for (const role of ['SUPERVISOR', 'PLANNER', 'VIEWER'] as const) {
      sessionRole = role;
      expect((await route.POST(send('/api/users/u2/reset-password', 'POST'), ctx('u2'))).status, role).toBe(403);
    }
  });

  it('a TENANT_ADMIN cannot reset a platform admin; nobody resets their own password here', async () => {
    const tx = fakeTx();
    const route = await import('@/app/api/users/[id]/reset-password/route');
    prismaFake.user = { findFirst: vi.fn(async () => target({ id: 'boss', role: 'SUPER_ADMIN' })) };
    expect((await route.POST(send('/x', 'POST'), ctx('boss'))).status).toBe(403);
    prismaFake.user = { findFirst: vi.fn(async () => target({ id: 'me', role: 'TENANT_ADMIN' })) };
    expect((await route.POST(send('/x', 'POST'), ctx('me'))).status).toBe(400);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(invalidatePrincipal).not.toHaveBeenCalled();
  });

  it('a user of another tenant (or none) is 404', async () => {
    fakeTx();
    const findFirst = vi.fn(async (_args: unknown) => null);
    prismaFake.user = { findFirst };
    const route = await import('@/app/api/users/[id]/reset-password/route');
    expect((await route.POST(send('/x', 'POST'), ctx('other-tenant-user'))).status).toBe(404);
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({ where: { id: 'other-tenant-user', tenantId: 'tA' } });
  });

  it('sets a new one-time password in one transaction, retires reset links, audits without a hash, ends sessions', async () => {
    const tx = fakeTx();
    prismaFake.user = { findFirst: vi.fn(async () => target()) };
    const route = await import('@/app/api/users/[id]/reset-password/route');
    const res = await route.POST(send('/api/users/u2/reset-password', 'POST'), ctx('u2'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { data: { user: { id: string; email: string }; tempPassword: string } };
    expect(body.data.user).toEqual({ id: 'u2', email: 'planner@a.example' });
    expect(body.data.tempPassword).toMatch(/^[A-Za-z0-9]{18}$/);
    expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: 'u2', tenantId: 'tA' }, data: { passwordHash: 'h' } });
    // Audit F10: the user's row lock (the same one a reset link takes) comes before any write.
    expect(tx.$queryRaw.mock.calls[0]?.[0].join('?')).toContain('FROM "User" WHERE id = ? FOR NO KEY UPDATE');
    expect(tx.$queryRaw.mock.calls[0]?.slice(1)).toEqual(['u2']);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.user.updateMany.mock.invocationCallOrder[0]!);
    expect(tx.passwordResetToken.updateMany.mock.calls[0]?.[0]).toMatchObject({ where: { userId: 'u2', usedAt: null } });
    const row = (tx.auditLog.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(row).toMatchObject({ tenantId: 'tA', userId: 'me', action: 'PASSWORD_RESET_BY_ADMIN', entity: 'User', entityId: 'u2' });
    expect(JSON.stringify(row)).not.toMatch(/passwordHash|"h"|tempPassword/);
    expect(JSON.stringify(row)).not.toContain(body.data.tempPassword);
    expect(invalidatePrincipal).toHaveBeenCalledWith('u2');
  });
});

describe('drivers (F13 and the dispatched-load driver)', () => {
  const PUBLIC = { id: true, tenantId: true, code: true, name: true, phone: true, active: true };

  it('PATCH reads and writes with the public column set only', async () => {
    db.driver.findUnique.mockResolvedValue({ id: 'd1', code: 'D1' });
    db.driver.update.mockResolvedValue({ id: 'd1', code: 'D1', name: 'New' });
    const route = await import('@/app/api/drivers/[id]/route');
    const res = await route.PATCH(send('/api/drivers/d1', 'PATCH', { name: 'New' }), { params: { id: 'd1' } });
    expect(res.status).toBe(200);
    expect(db.driver.findUnique.mock.calls[0]?.[0]).toMatchObject({ select: PUBLIC });
    expect(db.driver.update.mock.calls[0]?.[0]).toMatchObject({ select: PUBLIC });
  });

  it('DELETE of a driver used on any load deactivates it and keeps the loads untouched', async () => {
    db.driver.findUnique.mockResolvedValue({ id: 'd1', code: 'D1', active: true });
    db.planLoad.count.mockResolvedValue(3);
    db.driverShift.count.mockResolvedValue(0);
    db.driver.update.mockResolvedValue({ id: 'd1', code: 'D1', active: false });
    const route = await import('@/app/api/drivers/[id]/route');
    const res = await route.DELETE(send('/api/drivers/d1', 'DELETE'), { params: { id: 'd1' } });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ softDeleted: true });
    expect(db.driver.delete).not.toHaveBeenCalled();
    expect(db.driver.update.mock.calls[0]?.[0]).toMatchObject({ data: { active: false } });
  });

  it('DELETE of a driver never used anywhere really deletes it', async () => {
    db.driver.findUnique.mockResolvedValue({ id: 'd2', code: 'D2', active: true });
    db.planLoad.count.mockResolvedValue(0);
    db.driverShift.count.mockResolvedValue(0);
    db.driver.delete.mockResolvedValue({});
    const route = await import('@/app/api/drivers/[id]/route');
    const res = await route.DELETE(send('/api/drivers/d2', 'DELETE'), { params: { id: 'd2' } });
    expect((await res.json()).data).toEqual({ deleted: true });
    expect(db.driver.delete).toHaveBeenCalled();
  });
});

describe('retired driver app (owner decision: DISABLE)', () => {
  const routes: Array<[string, () => Promise<Record<string, unknown>>, string]> = [
    ['/api/driver/login', () => import('@/app/api/driver/login/route'), 'POST'],
    ['/api/driver/manifest', () => import('@/app/api/driver/manifest/route'), 'GET'],
    ['/api/driver/ping', () => import('@/app/api/driver/ping/route'), 'POST'],
    ['/api/driver/stop', () => import('@/app/api/driver/stop/route'), 'POST'],
    ['/api/driver/shift/end', () => import('@/app/api/driver/shift/end/route'), 'POST'],
    ['/api/drivers/[id]/pin', () => import('@/app/api/drivers/[id]/pin/route'), 'POST'],
    ['/api/runs/[id]/live', () => import('@/app/api/runs/[id]/live/route'), 'GET'],
  ];
  it.each(routes)('%s answers 410 with no-store and never touches the database or the session', async (_p, load, method) => {
    const mod = await load();
    const handler = mod[method] as () => Promise<Response>;
    const res = await handler();
    expect(res.status).toBe(410);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).error).toMatch(/retired/);
    expect(auth).not.toHaveBeenCalled();
  });
});
