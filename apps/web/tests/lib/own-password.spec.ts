/**
 * "Change password" (owner request 24 Oct 2026: every user changes their password):
 * - the new-password rules (lib/password-rules.ts): 12 to 200 characters, not the current one (as
 *   bcrypt sees it: the first 72 bytes), not the email;
 * - changeOwnPassword (lib/own-password.ts) on a faked database with a real limiter: the throttle
 *   after wrong current passwords, one transaction under the user's credential lock in the admin
 *   reset's order (lock, the hash replaced only while it is still the checked one, reset links
 *   retired, the audit row without a hash), every session ended, a platform admin without a company;
 * - POST /api/account/password through withAccountApi: no session 401, every role and a platform
 *   admin without a company let in, only the session's own user, nothing cached.
 */
import bcrypt from 'bcryptjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BCRYPT_MAX_BYTES, newPasswordProblem, PASSWORD_MAX_CHARS, PASSWORD_MIN_CHARS, sameForBcrypt } from '@/lib/password-rules';
import { RateLimiter } from '@/lib/rate-limit';

type Role = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'SUPERVISOR' | 'PLANNER' | 'VIEWER';
const sessionState = vi.hoisted(() => ({ session: null as null | { user: { id: string; tenantId: string | null; role: Role; name: string; email: string } } }));
const auth = vi.fn(async () => sessionState.session);
const hashPassword = vi.fn(async (plain: string) => `NEW_HASH(${plain.length})`);
vi.mock('@/lib/auth', () => ({ auth, hashPassword }));

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

const invalidatePrincipal = vi.fn();
vi.mock('@/lib/session-principal', async (orig) => ({
  ...(await orig<typeof import('@/lib/session-principal')>()),
  invalidatePrincipal,
}));

const { changeOwnPassword, ownPasswordFailKey, OWN_PASSWORD_MESSAGES } = await import('@/lib/own-password');

const CURRENT = 'Current-Password-1';
const NEW = 'A-brand-new-password-24';
let CURRENT_HASH = '';
beforeAll(async () => {
  CURRENT_HASH = await bcrypt.hash(CURRENT, 4);
});

// ---------------------------------------------------------------------------------------------
describe('the new-password rules (lib/password-rules.ts)', () => {
  const ctx = { currentPassword: CURRENT, email: 'Planner.One@NMWC.example' };

  it(`at least ${PASSWORD_MIN_CHARS} characters as the user sees them, at most ${PASSWORD_MAX_CHARS} as the sign-in check counts them`, () => {
    expect(newPasswordProblem('a'.repeat(11), ctx)).toMatch(/at least 12 characters/);
    expect(newPasswordProblem('a'.repeat(12), ctx)).toBeNull();
    expect(newPasswordProblem('', ctx)).toMatch(/at least 12/);
    // 12 emoji are 12 characters to the user (24 UTF-16 units): accepted.
    expect(newPasswordProblem('\u{1F600}'.repeat(12), ctx)).toBeNull();
    // 11 emoji are 22 units but 11 characters: too short.
    expect(newPasswordProblem('\u{1F600}'.repeat(11), ctx)).toMatch(/at least 12/);
    expect(newPasswordProblem('b'.repeat(200), ctx)).toBeNull();
    expect(newPasswordProblem('b'.repeat(201), ctx)).toMatch(/at most 200 characters/);
    // 101 emoji are 202 units: the sign-in form (max 200) could never take it.
    expect(newPasswordProblem('\u{1F600}'.repeat(101), ctx)).toMatch(/at most 200/);
  });

  it('not the current password, also when they differ only after the 72 bytes bcrypt reads', () => {
    expect(newPasswordProblem(CURRENT, ctx)).toMatch(/different from your current/);
    expect(newPasswordProblem('Current-Password-1-longer', { ...ctx, currentPassword: 'Current-Password-1-longer' })).toMatch(/different from your current/);
    const head = 'x'.repeat(BCRYPT_MAX_BYTES);
    expect(newPasswordProblem(`${head}NEW-TAIL`, { ...ctx, currentPassword: `${head}old` })).toMatch(/different from your current/);
    // Exactly 72 bytes against a longer one with the same 72: the same password to bcrypt.
    expect(sameForBcrypt(head, `${head}tail`)).toBe(true);
    // A difference inside the first 72 bytes is a different password.
    expect(sameForBcrypt(`y${'x'.repeat(80)}`, `z${'x'.repeat(80)}`)).toBe(false);
    expect(sameForBcrypt('short-one-123', 'short-one-1234')).toBe(false);
    // Multi-byte characters: 36 x "é" (2 bytes each) is 72 bytes.
    const e72 = 'é'.repeat(36);
    expect(sameForBcrypt(`${e72}A`, `${e72}B`)).toBe(true);
  });

  it('not the email address, nor its part before "@" (any case, spaces around)', () => {
    expect(newPasswordProblem('planner.one@nmwc.example', ctx)).toMatch(/not be your email/);
    expect(newPasswordProblem('  PLANNER.ONE@NMWC.EXAMPLE ', ctx)).toMatch(/not be your email/);
    const longLocal = { ...ctx, email: 'dispatcher.muscat@nmwc.example' };
    expect(newPasswordProblem('Dispatcher.Muscat', longLocal)).toMatch(/not be your email/);
    expect(newPasswordProblem('Dispatcher.Muscat-2026', longLocal)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
interface FakeUser {
  id: string;
  email: string;
  tenantId: string | null;
  active: boolean;
  passwordHash: string;
}

/** A database for changeOwnPassword: the user read, and one transaction whose steps are recorded in `order`. */
function fakeDb(user: FakeUser | null, opts: { updated?: number; lockFinds?: boolean; activeAfter?: boolean } = {}) {
  const order: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push(`lock:${strings.join('?')}:${values.join(',')}`);
      return opts.lockFinds === false ? [] : [{ id: user?.id }];
    }),
    user: {
      updateMany: vi.fn(async (_a: unknown) => (order.push('user.updateMany'), { count: opts.updated ?? 1 })),
      findUnique: vi.fn(async (_a: unknown) => (order.push('user.findUnique'), { active: opts.activeAfter ?? true })),
    },
    passwordResetToken: { updateMany: vi.fn(async (_a: unknown) => (order.push('passwordResetToken.updateMany'), { count: 1 })) },
    auditLog: { create: vi.fn(async (_a: unknown) => (order.push('auditLog.create'), {})) },
  };
  const db = {
    user: { findUnique: vi.fn(async (_a: unknown) => user) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db, tx, order };
}

const planner = (over: Partial<FakeUser> = {}): FakeUser => ({ id: 'u-planner', email: 'planner@a.example', tenantId: 'tA', active: true, passwordHash: CURRENT_HASH, ...over });
const strictLimiter = () => new RateLimiter({ bypass: () => false });
const run = (db: ReturnType<typeof fakeDb>['db'], limiter: RateLimiter, over: Partial<{ currentPassword: string; newPassword: string; userId: string }> = {}) =>
  changeOwnPassword(
    { userId: over.userId ?? 'u-planner', currentPassword: over.currentPassword ?? CURRENT, newPassword: over.newPassword ?? NEW, ip: '203.0.113.7' },
    { db: db as never, limiter, hash: hashPassword },
  );

beforeEach(() => {
  invalidatePrincipal.mockReset();
  hashPassword.mockClear();
  auth.mockClear();
  sessionState.session = null;
  for (const k of Object.keys(prismaFake)) delete prismaFake[k];
});

describe('changeOwnPassword (lib/own-password.ts)', () => {
  it("replaces the hash in one transaction in the admin reset's order: lock, the checked hash only, links retired, audit row without a hash; every session ends", async () => {
    const { db, tx, order } = fakeDb(planner());
    const result = await run(db, strictLimiter());
    expect(result).toEqual({ ok: true, auditWritten: true });
    expect(hashPassword).toHaveBeenCalledWith(NEW);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Audit F10: the user's row lock (the same one a reset link and an admin reset take) comes first.
    expect(order[0]).toBe('lock:SELECT id FROM "User" WHERE id = ? FOR NO KEY UPDATE:u-planner');
    expect(order.slice(1)).toEqual(['user.updateMany', 'passwordResetToken.updateMany', 'auditLog.create']);
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u-planner', passwordHash: CURRENT_HASH, active: true },
      data: { passwordHash: `NEW_HASH(${NEW.length})` },
    });
    expect(tx.passwordResetToken.updateMany.mock.calls[0]?.[0]).toMatchObject({ where: { userId: 'u-planner', usedAt: null }, data: { usedAt: expect.any(Date) } });
    const row = (tx.auditLog.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(row).toMatchObject({ tenantId: 'tA', userId: 'u-planner', action: 'PASSWORD_CHANGED', entity: 'User', entityId: 'u-planner', afterJson: { email: 'planner@a.example' }, ip: '203.0.113.7' });
    const text = JSON.stringify(row);
    expect(text).not.toMatch(/\$2[aby]\$\d\d\$/);
    expect(text).not.toContain('NEW_HASH');
    expect(text).not.toContain(NEW);
    expect(text).not.toContain(CURRENT);
    expect(invalidatePrincipal).toHaveBeenCalledWith('u-planner');
    // The user is read by the session's id, with the columns it needs only.
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u-planner' }, select: { id: true, email: true, tenantId: true, active: true, passwordHash: true } });
  });

  it('a wrong current password: 400, nothing written; after 5 in 15 min the user is paused (429) before any read or bcrypt; a right one clears the count', async () => {
    const lim = strictLimiter();
    const { db, tx } = fakeDb(planner());
    for (let i = 0; i < 4; i++) {
      const r = await run(db, lim, { currentPassword: `wrong-${i}` });
      expect(r).toEqual({ ok: false, status: 400, code: 'WRONG_PASSWORD', message: OWN_PASSWORD_MESSAGES.WRONG_PASSWORD });
    }
    // A right one before the limit clears the count (like a successful sign-in).
    const { db: db2 } = fakeDb(planner());
    expect((await run(db2, lim)).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect((await run(db, lim, { currentPassword: `wrong-again-${i}` })).ok).toBe(false);
    db.user.findUnique.mockClear();
    const paused = await run(db, lim);
    expect(paused).toMatchObject({ ok: false, status: 429, code: 'THROTTLED' });
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(invalidatePrincipal).toHaveBeenCalledTimes(1); // the one success only
    // Another user is not paused by it.
    const other = fakeDb(planner({ id: 'u-other' }));
    expect((await run(other.db, lim, { userId: 'u-other' })).ok).toBe(true);
    expect(lim.isBlocked(ownPasswordFailKey('u-planner'), 5)).toBe(true);
  });

  it('a new password the rules refuse: 400 with the rule, no failure counted, no bcrypt hash, nothing written', async () => {
    const lim = strictLimiter();
    const { db } = fakeDb(planner());
    for (let i = 0; i < 8; i++) {
      const r = await run(db, lim, { newPassword: 'short' });
      expect(r).toMatchObject({ ok: false, status: 400, code: 'WEAK_PASSWORD', message: 'The new password must have at least 12 characters.' });
    }
    expect(await run(db, lim, { newPassword: CURRENT })).toMatchObject({ code: 'WEAK_PASSWORD', message: expect.stringMatching(/different from your current/) });
    expect(await run(db, lim, { newPassword: 'PLANNER@A.EXAMPLE' })).toMatchObject({ code: 'WEAK_PASSWORD', message: expect.stringMatching(/email/) });
    expect(hashPassword).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(lim.isBlocked(ownPasswordFailKey('u-planner'), 5)).toBe(false);
  });

  it('a user gone or inactive: 401, nothing written', async () => {
    for (const user of [null, planner({ active: false })]) {
      const { db } = fakeDb(user);
      expect(await run(db, strictLimiter())).toMatchObject({ ok: false, status: 401, code: 'NO_ACCOUNT' });
      expect(db.$transaction).not.toHaveBeenCalled();
    }
    // Deleted between the read and the lock.
    const { db, tx } = fakeDb(planner(), { lockFinds: false });
    expect(await run(db, strictLimiter())).toMatchObject({ status: 401, code: 'NO_ACCOUNT' });
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(invalidatePrincipal).not.toHaveBeenCalled();
  });

  it('the hash changed after the check (an admin reset or a reset link committed in between): 409, the newer password stays, nothing else written', async () => {
    const { db, tx } = fakeDb(planner(), { updated: 0 });
    expect(await run(db, strictLimiter())).toEqual({ ok: false, status: 409, code: 'CHANGED_MEANWHILE', message: OWN_PASSWORD_MESSAGES.CHANGED_MEANWHILE });
    expect(tx.passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(invalidatePrincipal).not.toHaveBeenCalled();
    // Deactivated in between: the session is over (401).
    const gone = fakeDb(planner(), { updated: 0, activeAfter: false });
    expect(await run(gone.db, strictLimiter())).toMatchObject({ status: 401, code: 'NO_ACCOUNT' });
  });

  it('a platform admin without a company: changed, links retired, no audit row (AuditLog needs a company), one log line without the email', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { db, tx, order } = fakeDb(planner({ id: 'u-root', email: 'root@platform.example', tenantId: null }));
    const result = await run(db, strictLimiter(), { userId: 'u-root' });
    expect(result).toEqual({ ok: true, auditWritten: false });
    expect(order.slice(1)).toEqual(['user.updateMany', 'passwordResetToken.updateMany']);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(invalidatePrincipal).toHaveBeenCalledWith('u-root');
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(info.mock.calls[0])).toContain('u-root');
    expect(JSON.stringify(info.mock.calls[0])).not.toContain('root@platform.example');
    info.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /api/account/password (withAccountApi)', () => {
  const send = (body: unknown) =>
    new Request('http://localhost/api/account/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const signIn = (role: Role, tenantId: string | null = 'tA', id = 'u-planner') => {
    sessionState.session = { user: { id, tenantId, role, name: 'Me', email: 'planner@a.example' } };
  };
  /** The unscoped client the route's default dependencies use. */
  function wireDb(user: FakeUser) {
    const { db, tx } = fakeDb(user);
    prismaFake.user = db.user;
    prismaFake.$transaction = db.$transaction;
    return { db, tx };
  }

  it('no session: 401 before any database read', async () => {
    const route = await import('@/app/api/account/password/route');
    const res = await route.POST(send({ currentPassword: CURRENT, newPassword: NEW }));
    expect(res.status).toBe(401);
    expect(prismaFake.user).toBeUndefined();
  });

  it('every role changes their own password (VIEWER included): 200, nothing cached', async () => {
    const route = await import('@/app/api/account/password/route');
    for (const role of ['TENANT_ADMIN', 'SUPERVISOR', 'PLANNER', 'VIEWER', 'SUPER_ADMIN'] as const) {
      signIn(role);
      const { tx } = wireDb(planner());
      const res = await route.POST(send({ currentPassword: CURRENT, newPassword: NEW }));
      expect(res.status, role).toBe(200);
      expect(res.headers.get('cache-control'), role).toBe('no-store');
      expect(await res.json(), role).toEqual({ data: { changed: true, signInAgain: true }, error: null });
      expect(tx.user.updateMany, role).toHaveBeenCalledTimes(1);
    }
  });

  it('a platform admin without a company is let in (withTenantApi would answer 403 "No tenant on session")', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const route = await import('@/app/api/account/password/route');
    signIn('SUPER_ADMIN', null, 'u-root');
    const { tx } = wireDb(planner({ id: 'u-root', tenantId: null, email: 'root@platform.example' }));
    const res = await route.POST(send({ currentPassword: CURRENT, newPassword: NEW }));
    expect(res.status).toBe(200);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(invalidatePrincipal).toHaveBeenCalledWith('u-root');
    info.mockRestore();
  });

  it("only the session's own user: an id in the body is ignored", async () => {
    const route = await import('@/app/api/account/password/route');
    signIn('VIEWER');
    const { db } = wireDb(planner());
    const res = await route.POST(send({ userId: 'u-boss', id: 'u-boss', currentPassword: CURRENT, newPassword: NEW }));
    expect(res.status).toBe(200);
    expect(db.user.findUnique.mock.calls[0]?.[0]).toMatchObject({ where: { id: 'u-planner' } });
  });

  it('refusals carry their code and message, never the passwords, and are not cached', async () => {
    const route = await import('@/app/api/account/password/route');
    signIn('PLANNER');
    wireDb(planner());
    const wrong = await route.POST(send({ currentPassword: 'not-my-password', newPassword: NEW }));
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get('cache-control')).toBe('no-store');
    expect(await wrong.json()).toEqual({ data: null, error: { error: OWN_PASSWORD_MESSAGES.WRONG_PASSWORD, code: 'WRONG_PASSWORD' } });

    const weak = await route.POST(send({ currentPassword: CURRENT, newPassword: 'short' }));
    expect(weak.status).toBe(400);
    expect((await weak.json()).error).toEqual({ error: 'The new password must have at least 12 characters.', code: 'WEAK_PASSWORD' });

    for (const bad of [{ currentPassword: CURRENT }, { newPassword: NEW }, { currentPassword: '', newPassword: NEW }, 'not json', { currentPassword: 7, newPassword: NEW }]) {
      const res = await route.POST(send(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(CURRENT);
      expect(text).not.toContain(NEW);
    }
    expect(invalidatePrincipal).not.toHaveBeenCalled();
  });
});
