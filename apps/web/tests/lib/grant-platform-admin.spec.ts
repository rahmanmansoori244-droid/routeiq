/**
 * Review F10: platform admin (SUPER_ADMIN) is granted only by the owner-run script
 * prisma/grant-platform-admin.ts, with an audit row, and needs SUPER_ADMIN_EMAILS as well.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatformAdmin } from '@/prisma/grant-platform-admin';

interface U {
  id: string;
  email: string;
  role: string;
  active: boolean;
  tenantId: string | null;
}
const users = new Map<string, U>();
const audits: Array<Record<string, unknown>> = [];
const tx = {
  user: {
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<U> }) => {
      const u = [...users.values()].find((x) => x.id === where.id)!;
      Object.assign(u, data);
      return u;
    }),
  },
  auditLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      audits.push(data);
      return data;
    }),
  },
};
const db = {
  user: { findUnique: vi.fn(async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null) },
  auditLog: tx.auditLog,
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
const env = (list = '') => ({ SUPER_ADMIN_EMAILS: list }) as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  users.clear();
  audits.length = 0;
  db.$transaction.mockClear();
  users.set('owner@routeiq.example', { id: 'u1', email: 'owner@routeiq.example', role: 'TENANT_ADMIN', active: true, tenantId: 't1' });
  users.set('ops@routeiq.example', { id: 'u2', email: 'ops@routeiq.example', role: 'SUPER_ADMIN', active: true, tenantId: null });
});

describe('setPlatformAdmin', () => {
  it('grants SUPER_ADMIN, writes PLATFORM_ADMIN_GRANTED in the user tenant, warns when not allowlisted', async () => {
    const r = await setPlatformAdmin(db as never, ' Owner@RouteIQ.example ', { env: env() });
    expect(r.changed).toBe(true);
    expect(r.after.role).toBe('SUPER_ADMIN');
    expect(users.get('owner@routeiq.example')!.role).toBe('SUPER_ADMIN');
    expect(audits[0]).toMatchObject({ tenantId: 't1', userId: 'u1', action: 'PLATFORM_ADMIN_GRANTED' });
    expect(r.warnings.join(' ')).toMatch(/SUPER_ADMIN_EMAILS/);
  });

  it('no warning when the email is allowlisted; granting twice changes nothing', async () => {
    const first = await setPlatformAdmin(db as never, 'owner@routeiq.example', { env: env('owner@routeiq.example') });
    expect(first.warnings).toEqual([]);
    const again = await setPlatformAdmin(db as never, 'owner@routeiq.example', { env: env('owner@routeiq.example') });
    expect(again.changed).toBe(false);
    expect(audits).toHaveLength(1);
  });

  it('revoke returns a tenant user to TENANT_ADMIN with a PLATFORM_ADMIN_REVOKED row', async () => {
    users.get('owner@routeiq.example')!.role = 'SUPER_ADMIN';
    const r = await setPlatformAdmin(db as never, 'owner@routeiq.example', { revoke: true, env: env() });
    expect(r.after).toEqual({ role: 'TENANT_ADMIN', active: true });
    expect(audits[0]).toMatchObject({ action: 'PLATFORM_ADMIN_REVOKED' });
  });

  it('revoke deactivates a platform admin without a tenant (no audit log to write to)', async () => {
    const r = await setPlatformAdmin(db as never, 'ops@routeiq.example', { revoke: true, env: env('ops@routeiq.example') });
    expect(r.after).toEqual({ role: 'SUPER_ADMIN', active: false });
    expect(audits).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/remove .* from SUPER_ADMIN_EMAILS/);
  });

  it('refuses an unknown or malformed email', async () => {
    await expect(setPlatformAdmin(db as never, 'nobody@routeiq.example', { env: env() })).rejects.toThrow(/No user/);
    await expect(setPlatformAdmin(db as never, 'not an email', { env: env() })).rejects.toThrow(/Not an email/);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
