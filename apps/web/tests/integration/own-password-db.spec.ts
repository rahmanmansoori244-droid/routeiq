/**
 * "CHANGE PASSWORD" ON REAL POSTGRESQL (owner request 24 Oct 2026: every user changes
 * their password; library level: POST /api/account/password, the admin reset route and the reset-link
 * helpers are called in the test process with next-auth's session faked; the web server and the solver
 * are not used). Needs DATABASE_URL (migrated). Invented data only: companies "own-pw-...", users
 * "...@own-pw.test". Rate limits are off in tests (NODE_ENV=test): the throttle is covered by
 * tests/lib/own-password.spec.ts.
 *
 *  1. A dispatcher (PLANNER) changes their own password: the new one verifies with bcrypt and the old
 *     one no longer does; an outstanding reset link is retired; one PASSWORD_CHANGED row in the company
 *     names the user and holds no hash or password; a session signed in before the change is no longer
 *     accepted (its password fingerprint is stale), one signed in with the new password is.
 *  2. A wrong current password (400) and a new password the rules refuse (400) change nothing and
 *     write no audit row.
 *  3. A VIEWER changes theirs too; a platform admin WITHOUT a company changes theirs (no audit row: the
 *     audit log needs a company), and their old session ends as well.
 *  4. Races, forced with a barrier on the application's client (as recovery-races-db.spec.ts; Postgres
 *     does the locking): an admin reset that commits after the change read the user wins (409, the
 *     admin's password stays); a reset link used while the change holds the user's lock waits for it and
 *     is then refused (the changed password stays); two changes with the same current password at once:
 *     one 200, the other 409, never both.
 */
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

// next-auth's session (per call) and the bcrypt cost (4 here, so the test is quick; the app uses 12).
const m = vi.hoisted(() => ({ auth: vi.fn(), hashPassword: vi.fn() }));
vi.mock('@/lib/auth', () => m);

// ---------------------------------------------------------------------------------------------
// The application's client with barriers (lib/db.ts honours globalThis.__prisma).

type Hook = { before?: () => Promise<void>; after?: () => Promise<void> };
const hooks = new Map<string, Hook>();
const appBase = new PrismaClient();
const appClient = appBase.$extends({
  name: 'ownPasswordBarrier',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const h = hooks.get(`${model}.${operation}`);
        if (h?.before) await h.before();
        const r = await query(args);
        if (h?.after) await h.after();
        return r;
      },
    },
  },
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
/** Pause the next `model.operation` once, before or after it runs, until released. */
function barrier(key: string, when: 'before' | 'after') {
  const reached = deferred();
  const release = deferred();
  hooks.set(key, {
    [when]: async () => {
      hooks.delete(key);
      reached.resolve();
      await release.promise;
    },
  });
  return { reached: reached.promise, release: () => release.resolve() };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once a backend of this database waits on a row lock of the user tables (up to `ms`). */
async function someoneWaitsOnLock(ms = 3000): Promise<boolean> {
  for (let t = 0; t < ms; t += 25) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND (query LIKE '%"User"%' OR query LIKE '%"PasswordResetToken"%')`;
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await sleep(25);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Modules under test, imported after the barrier client is installed.

let ownRoute: typeof import('@/app/api/account/password/route');
let resetRoute: typeof import('@/app/api/users/[id]/reset-password/route');
let pr: typeof import('@/lib/password-reset');
let sp: typeof import('@/lib/session-principal');

const g = globalThis as unknown as { __prisma?: unknown };
const previousClient = g.__prisma;
const slugs: string[] = [];
const loneUsers: string[] = [];

beforeAll(async () => {
  m.hashPassword.mockImplementation((plain: string) => bcrypt.hash(plain, 4));
  g.__prisma = appClient;
  ownRoute = await import('@/app/api/account/password/route');
  resetRoute = await import('@/app/api/users/[id]/reset-password/route');
  pr = await import('@/lib/password-reset');
  sp = await import('@/lib/session-principal');
});

afterAll(async () => {
  hooks.clear();
  for (const s of slugs) await cleanupTenant(s);
  for (const id of loneUsers) await prisma.user.deleteMany({ where: { id } }).catch(() => undefined);
  if (previousClient === undefined) delete g.__prisma;
  else g.__prisma = previousClient;
  await appBase.$disconnect();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------------
// Seeding and calls.

type Role = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'SUPERVISOR' | 'PLANNER' | 'VIEWER';
type U = { id: string; tenantId: string | null; role: Role; name: string; email: string; password: string };

const CURRENT = 'Old-Password-Of-The-User-1';
let seq = 0;

async function mkTenant(label: string) {
  const slug = `own-pw-${label}-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
  slugs.push(slug);
  const t = await prisma.tenant.create({ data: { slug, name: `Own pw ${label}`, country: 'Oman' } });
  await prisma.tenantConfig.create({ data: { tenantId: t.id, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  return t;
}
async function mkUser(tenantId: string | null, role: Role, label: string, password = CURRENT): Promise<U> {
  const u = await prisma.user.create({
    data: { tenantId, role, name: label, email: `${label}-${Date.now().toString(36)}-${seq++}@own-pw.test`.toLowerCase(), passwordHash: await bcrypt.hash(password, 4) },
    select: { id: true, tenantId: true, role: true, name: true, email: true },
  });
  if (!tenantId) loneUsers.push(u.id);
  return { ...u, role: u.role as Role, password };
}
const sessionOf = (u: U) => ({ user: { id: u.id, tenantId: u.tenantId, role: u.role, name: u.name, email: u.email } });
const send = (url: string, method: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

async function changeOwn(u: U, currentPassword: string, newPassword: string) {
  m.auth.mockResolvedValueOnce(sessionOf(u));
  const res = await ownRoute.POST(send('/api/account/password', 'POST', { currentPassword, newPassword }));
  const body = (await res.json()) as { data: unknown; error: null | { code?: string } };
  return { status: res.status, code: body.error?.code ?? null };
}
async function adminReset(admin: U, targetId: string) {
  m.auth.mockResolvedValueOnce(sessionOf(admin));
  const res = await resetRoute.POST(send(`/api/users/${targetId}/reset-password`, 'POST'), { params: { id: targetId } });
  const body = (await res.json()) as { data?: { tempPassword?: string } };
  return { status: res.status, tempPassword: body.data?.tempPassword ?? null };
}
const hashOf = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;
const verifies = async (id: string, password: string) => bcrypt.compare(password, await hashOf(id));
/** The claims of a session signed in now with the user's current password (lib/auth.ts jwt callback at sign-in). */
async function signedInClaims(u: U) {
  return { userId: u.id, tenantId: u.tenantId, role: u.role, pwf: await sp.passwordFingerprint(await hashOf(u.id)), authTime: Date.now() };
}
/** Does the server still accept these claims, on a fresh reading of the user (no 30 s cache)? */
async function accepted(claims: Awaited<ReturnType<typeof signedInClaims>>, env: NodeJS.ProcessEnv = process.env) {
  sp.invalidatePrincipal(String(claims.userId));
  return (await sp.refreshSessionClaims({ ...claims }, { env })) !== null;
}

// =============================================================================================
describe('a signed-in user changes their own password (real PostgreSQL)', () => {
  it('a dispatcher: new password works, old does not; the reset link retired; one audit row without a hash; the old session ends', async () => {
    const t = await mkTenant('plan');
    const u = await mkUser(t.id, 'PLANNER', 'planner');
    const before = await signedInClaims(u);
    expect(await accepted(before)).toBe(true);
    const link = await pr.createResetTokenForEmail(u.email);
    expect(link.status).toBe('created');

    const NEW = 'Chosen-By-The-User-24';
    expect(await changeOwn(u, CURRENT, NEW)).toEqual({ status: 200, code: null });

    expect(await verifies(u.id, NEW)).toBe(true);
    expect(await verifies(u.id, CURRENT)).toBe(false);
    expect(await pr.resetTokenUsable(link.rawToken!)).toBe(false);
    expect(await pr.resetPasswordWithToken(link.rawToken!, 'LINK_HASH')).toEqual({ ok: false, reason: 'used' });
    expect(await verifies(u.id, NEW)).toBe(true);

    const rows = await prisma.auditLog.findMany({ where: { tenantId: t.id, action: 'PASSWORD_CHANGED' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: u.id, entity: 'User', entityId: u.id, afterJson: { email: u.email } });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toMatch(/\$2[aby]\$\d\d\$/);
    expect(text).not.toContain(NEW);
    expect(text).not.toContain(CURRENT);

    // The session signed in before the change is no longer accepted; one signed in with the new password is.
    expect(await accepted(before)).toBe(false);
    expect(await accepted(await signedInClaims(u))).toBe(true);
  });

  it('a wrong current password or a refused new one: 400, nothing changes, no audit row', async () => {
    const t = await mkTenant('wrong');
    const u = await mkUser(t.id, 'SUPERVISOR', 'supervisor');
    const hash = await hashOf(u.id);
    expect(await changeOwn(u, 'Not-The-Password-1', 'Chosen-By-The-User-24')).toEqual({ status: 400, code: 'WRONG_PASSWORD' });
    expect(await changeOwn(u, CURRENT, 'short')).toEqual({ status: 400, code: 'WEAK_PASSWORD' });
    expect(await changeOwn(u, CURRENT, CURRENT)).toEqual({ status: 400, code: 'WEAK_PASSWORD' });
    expect(await changeOwn(u, CURRENT, u.email.toUpperCase())).toEqual({ status: 400, code: 'WEAK_PASSWORD' });
    expect(await hashOf(u.id)).toBe(hash);
    expect(await prisma.auditLog.count({ where: { tenantId: t.id, action: 'PASSWORD_CHANGED' } })).toBe(0);
  });

  it('a VIEWER changes theirs; a platform admin without a company changes theirs (no audit row) and their old session ends', async () => {
    const t = await mkTenant('roles');
    const viewer = await mkUser(t.id, 'VIEWER', 'viewer');
    expect(await changeOwn(viewer, CURRENT, 'Viewer-Chosen-Password-1')).toEqual({ status: 200, code: null });
    expect(await verifies(viewer.id, 'Viewer-Chosen-Password-1')).toBe(true);
    expect(await prisma.auditLog.count({ where: { tenantId: t.id, action: 'PASSWORD_CHANGED', userId: viewer.id } })).toBe(1);

    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const root = await mkUser(null, 'SUPER_ADMIN', 'root');
    // A platform admin's session is honoured only while the email is in SUPER_ADMIN_EMAILS.
    const env = { ...process.env, SUPER_ADMIN_EMAILS: root.email };
    const before = await signedInClaims(root);
    expect(await accepted(before, env)).toBe(true);
    expect(await changeOwn(root, CURRENT, 'Platform-Admin-Chosen-1')).toEqual({ status: 200, code: null });
    info.mockRestore();
    expect(await verifies(root.id, 'Platform-Admin-Chosen-1')).toBe(true);
    expect(await prisma.auditLog.count({ where: { userId: root.id } })).toBe(0);
    expect(await accepted(before, env)).toBe(false);
    expect(await accepted(await signedInClaims(root), env)).toBe(true);
  });
});

// =============================================================================================
describe('Change password racing an admin reset, a reset link or itself (real PostgreSQL)', () => {
  it('an admin reset commits after the change read the user: the change is refused (409), the admin password stays', async () => {
    const t = await mkTenant('race-admin');
    const admin = await mkUser(t.id, 'TENANT_ADMIN', 'admin');
    const u = await mkUser(t.id, 'PLANNER', 'target');
    const b = barrier('User.findUnique', 'after'); // the change has read the user (and its hash)
    const change$ = changeOwn(u, CURRENT, 'Chosen-By-The-User-24');
    await b.reached;
    const a = await adminReset(admin, u.id); // commits: a new temporary password
    expect(a.status).toBe(200);
    b.release();
    expect(await change$).toEqual({ status: 409, code: 'CHANGED_MEANWHILE' });
    expect(await verifies(u.id, a.tempPassword!)).toBe(true);
    expect(await prisma.auditLog.count({ where: { tenantId: t.id, action: 'PASSWORD_CHANGED' } })).toBe(0);
  });

  it("a reset link used while the change holds the user's lock waits for it, then is refused; the changed password stays", async () => {
    const t = await mkTenant('race-link');
    const u = await mkUser(t.id, 'PLANNER', 'linked');
    const link = await pr.createResetTokenForEmail(u.email);
    expect(link.status).toBe('created');
    const b = barrier('AuditLog.create', 'before'); // the change has written the hash and retired the links
    const change$ = changeOwn(u, CURRENT, 'Chosen-By-The-User-24');
    await b.reached;
    const consuming = pr.resetPasswordWithToken(link.rawToken!, 'LINK_HASH');
    expect(await someoneWaitsOnLock()).toBe(true); // the link waits behind the change's lock
    b.release();
    expect(await change$).toEqual({ status: 200, code: null });
    expect(await consuming).toEqual({ ok: false, reason: 'used' });
    expect(await verifies(u.id, 'Chosen-By-The-User-24')).toBe(true);
  });

  it('two changes with the same current password at once (two sessions): one 200, the other 409, never both', async () => {
    const t = await mkTenant('race-twice');
    const u = await mkUser(t.id, 'TENANT_ADMIN', 'twice');
    const b = barrier('User.updateMany', 'before'); // the first holds the user's lock, before writing
    const first$ = changeOwn(u, CURRENT, 'First-Chosen-Password-1');
    await b.reached;
    const second$ = changeOwn(u, CURRENT, 'Second-Chosen-Password-2'); // reads the old hash, then waits for the lock
    expect(await someoneWaitsOnLock()).toBe(true);
    b.release();
    expect(await first$).toEqual({ status: 200, code: null });
    expect(await second$).toEqual({ status: 409, code: 'CHANGED_MEANWHILE' });
    expect(await verifies(u.id, 'First-Chosen-Password-1')).toBe(true);
    expect(await verifies(u.id, 'Second-Chosen-Password-2')).toBe(false);
    expect(await prisma.auditLog.count({ where: { tenantId: t.id, action: 'PASSWORD_CHANGED' } })).toBe(1);
  });
});
