/**
 * Review F09: the pure session decision and the 30 s principal cache (lib/session-principal.ts).
 * No database: a fake `user.findUnique` is passed in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_STALE_IF_ERROR_MS,
  PRINCIPAL_TTL_MS,
  SESSION_ABSOLUTE_MS,
  _resetPrincipalCache,
  effectiveRole,
  evaluatePrincipal,
  invalidatePrincipal,
  invalidateTenant,
  loadPrincipal,
  passwordFingerprint,
  refreshSessionClaims,
  withinAbsoluteLifetime,
  type Principal,
} from '@/lib/session-principal';

const NOW = 1_800_000_000_000;

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: 'u1',
    email: 'u1@example.test',
    active: true,
    role: 'PLANNER',
    tenantId: 'tA',
    tenantActive: true,
    pwf: 'abcdef0123456789',
    ...over,
  };
}
const claims = (over: Record<string, unknown> = {}) => ({
  userId: 'u1',
  tenantId: 'tA',
  role: 'PLANNER',
  pwf: 'abcdef0123456789',
  authTime: NOW - 1000,
  ...over,
});
const NO_ADMINS = { SUPER_ADMIN_EMAILS: '' } as unknown as NodeJS.ProcessEnv;

describe('absolute lifetime (DB-free, also on the edge)', () => {
  it('accepts a session younger than 12 h', () => {
    expect(withinAbsoluteLifetime({ authTime: NOW - SESSION_ABSOLUTE_MS + 1 }, NOW)).toBe(true);
  });
  it('rejects a session older than 12 h', () => {
    expect(withinAbsoluteLifetime({ authTime: NOW - SESSION_ABSOLUTE_MS - 1 }, NOW)).toBe(false);
  });
  it('rejects a missing or malformed authTime (cookies from before this release)', () => {
    expect(withinAbsoluteLifetime({}, NOW)).toBe(false);
    expect(withinAbsoluteLifetime({ authTime: 'yesterday' }, NOW)).toBe(false);
    expect(withinAbsoluteLifetime({ authTime: Number.NaN }, NOW)).toBe(false);
  });
  it('rejects an authTime in the future', () => {
    expect(withinAbsoluteLifetime({ authTime: NOW + 10 * 60_000 }, NOW)).toBe(false);
  });
});

describe('evaluatePrincipal', () => {
  it('keeps a valid session and takes role and tenant from the database', () => {
    expect(evaluatePrincipal(claims({ role: 'TENANT_ADMIN' }), principal({ role: 'VIEWER' }), NO_ADMINS)).toEqual({
      role: 'VIEWER',
      tenantId: 'tA',
    });
  });
  it('ends the session: user missing or inactive', () => {
    expect(evaluatePrincipal(claims(), null, NO_ADMINS)).toBeNull();
    expect(evaluatePrincipal(claims(), principal({ active: false }), NO_ADMINS)).toBeNull();
  });
  it('ends the session: tenant inactive', () => {
    expect(evaluatePrincipal(claims(), principal({ tenantActive: false }), NO_ADMINS)).toBeNull();
  });
  it('ends the session: tenant changed', () => {
    expect(evaluatePrincipal(claims({ tenantId: 'tB' }), principal(), NO_ADMINS)).toBeNull();
  });
  it('ends the session: password changed (fingerprint mismatch) or no fingerprint claim', () => {
    expect(evaluatePrincipal(claims({ pwf: 'different0000000' }), principal(), NO_ADMINS)).toBeNull();
    expect(evaluatePrincipal(claims({ pwf: undefined }), principal(), NO_ADMINS)).toBeNull();
  });
  it('ends the session: no tenant and not a platform admin', () => {
    expect(evaluatePrincipal(claims({ tenantId: null }), principal({ tenantId: null, tenantActive: null }), NO_ADMINS)).toBeNull();
  });
  it('SUPER_ADMIN needs the SUPER_ADMIN_EMAILS allowlist too', () => {
    const p = principal({ role: 'SUPER_ADMIN' });
    expect(evaluatePrincipal(claims(), p, NO_ADMINS)?.role).toBe('TENANT_ADMIN');
    expect(evaluatePrincipal(claims(), p, { SUPER_ADMIN_EMAILS: ' U1@example.test ,x@y.z' } as unknown as NodeJS.ProcessEnv)?.role).toBe(
      'SUPER_ADMIN',
    );
    const tenantless = principal({ role: 'SUPER_ADMIN', tenantId: null, tenantActive: null });
    expect(evaluatePrincipal(claims({ tenantId: null }), tenantless, NO_ADMINS)).toBeNull();
    expect(
      evaluatePrincipal(claims({ tenantId: null }), tenantless, { SUPER_ADMIN_EMAILS: 'u1@example.test' } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ role: 'SUPER_ADMIN', tenantId: null });
  });
  it('effectiveRole leaves every other role alone', () => {
    for (const r of ['TENANT_ADMIN', 'SUPERVISOR', 'PLANNER', 'VIEWER'] as const) {
      expect(effectiveRole(r, 'a@b.c', 'tA', NO_ADMINS)).toBe(r);
    }
  });
});

describe('passwordFingerprint', () => {
  it('is 16 hex chars, stable, and changes with the hash', async () => {
    const a = await passwordFingerprint('$2a$12$one');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await passwordFingerprint('$2a$12$one')).toBe(a);
    expect(await passwordFingerprint('$2a$12$two')).not.toBe(a);
  });
});

describe('loadPrincipal cache', () => {
  const row = (id: string, tenantId = 'tA') => ({
    id,
    email: `${id}@example.test`,
    active: true,
    role: 'PLANNER' as const,
    tenantId,
    passwordHash: `$2a$12$${id}`,
    tenant: { active: true },
  });
  const makeFind = () => vi.fn(async ({ where }: { where: { id: string } }) => row(where.id, where.id.startsWith('b') ? 'tB' : 'tA'));
  let findUnique: ReturnType<typeof makeFind>;
  let db: { user: { findUnique: ReturnType<typeof makeFind> } };

  beforeEach(() => {
    _resetPrincipalCache();
    findUnique = makeFind();
    db = { user: { findUnique } };
  });
  const load = (id: string, now: number) => loadPrincipal(id, { now, db: db as never });

  it('reads the database at most once per TTL', async () => {
    await load('a1', NOW);
    await load('a1', NOW + PRINCIPAL_TTL_MS - 1);
    expect(findUnique).toHaveBeenCalledTimes(1);
    await load('a1', NOW + PRINCIPAL_TTL_MS + 1);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('invalidatePrincipal forces a fresh read', async () => {
    await load('a1', NOW);
    invalidatePrincipal('a1');
    await load('a1', NOW + 1);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('invalidateTenant drops only the users of that tenant', async () => {
    await load('a1', NOW);
    await load('b1', NOW);
    invalidateTenant('tB');
    await load('a1', NOW + 1);
    await load('b1', NOW + 1);
    expect(findUnique.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id)).toEqual(['a1', 'b1', 'b1']);
  });

  it('on a database error uses a recent reading, and fails closed after that', async () => {
    const first = await load('a1', NOW);
    findUnique.mockRejectedValue(new Error('db down'));
    expect(await load('a1', NOW + PRINCIPAL_TTL_MS + 1)).toEqual(first);
    await expect(load('a1', NOW + PRINCIPAL_STALE_IF_ERROR_MS + 1)).rejects.toThrow('db down');
  });
});

describe('refreshSessionClaims (the jwt-callback step)', () => {
  beforeEach(() => _resetPrincipalCache());

  it('returns refreshed claims for a valid session', async () => {
    const pwf = await passwordFingerprint('$2a$12$u1');
    const db = {
      user: {
        findUnique: vi.fn(async () => ({
          id: 'u1',
          email: 'u1@example.test',
          active: true,
          role: 'SUPERVISOR',
          tenantId: 'tA',
          passwordHash: '$2a$12$u1',
          tenant: { active: true },
        })),
      },
    };
    const out = await refreshSessionClaims(claims({ pwf }), { now: NOW, db: db as never, env: NO_ADMINS });
    expect(out).toMatchObject({ userId: 'u1', role: 'SUPERVISOR', tenantId: 'tA', pwf });
  });

  it('ends an expired session without reading the database', async () => {
    const db = { user: { findUnique: vi.fn() } };
    expect(await refreshSessionClaims(claims({ authTime: NOW - SESSION_ABSOLUTE_MS - 1 }), { now: NOW, db: db as never })).toBeNull();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('ends the session when there is no user id or the database fails with nothing cached', async () => {
    const db = { user: { findUnique: vi.fn().mockRejectedValue(new Error('db down')) } };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await refreshSessionClaims(claims({ userId: undefined }), { now: NOW, db: db as never })).toBeNull();
    expect(await refreshSessionClaims(claims(), { now: NOW, db: db as never })).toBeNull();
    quiet.mockRestore();
  });
});
