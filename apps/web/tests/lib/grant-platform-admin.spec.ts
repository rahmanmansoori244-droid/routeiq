/**
 * Review F10: platform admin (SUPER_ADMIN) is granted only by the owner-run script
 * prisma/grant-platform-admin.ts, with an audit row, and needs SUPER_ADMIN_EMAILS as well.
 *
 * Review web-auth-security-2 (9 Oct 2026): the script promoted whatever account held the email,
 * also one an outsider registered through open public sign-up in a throwaway company of their own.
 * A grant now shows the account and its company, needs that company's slug confirmed (--tenant),
 * and refuses a company made through public sign-up unless --allow-self-signup is passed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeAccount, GrantRefused, parseArgs, setPlatformAdmin } from '@/prisma/grant-platform-admin';

interface T {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
}
interface U {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  tenantId: string | null;
  createdAt: Date;
}
const tenants = new Map<string, T>();
const users = new Map<string, U>();
/** SIGNUP audit rows (the company was made through public sign-up), by tenant id. */
const signups = new Map<string, { createdAt: Date; userId: string | null }>();
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
  user: {
    findUnique: vi.fn(async ({ where }: { where: { email: string } }) => {
      const u = users.get(where.email);
      if (!u) return null;
      const t = u.tenantId ? tenants.get(u.tenantId)! : null;
      return { ...u, tenant: t ? { slug: t.slug, name: t.name, createdAt: t.createdAt } : null };
    }),
  },
  auditLog: {
    create: tx.auditLog.create,
    findFirst: vi.fn(async ({ where }: { where: { tenantId: string; action: string; entity: string; entityId: string } }) => {
      const s = where.action === 'SIGNUP' && where.entity === 'Tenant' && where.entityId === where.tenantId ? signups.get(where.tenantId) : undefined;
      if (!s) return null;
      const by = [...users.values()].find((x) => x.id === s.userId);
      return { createdAt: s.createdAt, user: by ? { email: by.email } : null };
    }),
  },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
const env = (list = '') => ({ SUPER_ADMIN_EMAILS: list }) as unknown as NodeJS.ProcessEnv;
const day = (iso: string) => new Date(`${iso}T08:00:00Z`);

beforeEach(() => {
  tenants.clear();
  users.clear();
  signups.clear();
  audits.length = 0;
  db.$transaction.mockClear();
  // The owner's company, made by the seed (no SIGNUP row).
  tenants.set('t1', { id: 't1', slug: 'nmwc', name: 'National Mineral Water', createdAt: day('2026-05-11') });
  users.set('owner@routeiq.example', { id: 'u1', email: 'owner@routeiq.example', name: 'Owner', role: 'TENANT_ADMIN', active: true, tenantId: 't1', createdAt: day('2026-05-11') });
  users.set('ops@routeiq.example', { id: 'u2', email: 'ops@routeiq.example', name: 'Ops', role: 'SUPER_ADMIN', active: true, tenantId: null, createdAt: day('2026-05-12') });
  // An outsider registered the address the owner is about to allowlist, through public sign-up.
  tenants.set('t9', { id: 't9', slug: 'rvsa2-o', name: 'Throwaway', createdAt: day('2026-10-01') });
  users.set('planner@nmwc.example', { id: 'u9', email: 'planner@nmwc.example', name: 'Planner', role: 'TENANT_ADMIN', active: true, tenantId: 't9', createdAt: day('2026-10-01') });
  signups.set('t9', { createdAt: day('2026-10-01'), userId: 'u9' });
});

describe('setPlatformAdmin', () => {
  it('grants SUPER_ADMIN, writes PLATFORM_ADMIN_GRANTED in the user tenant, warns when not allowlisted', async () => {
    const r = await setPlatformAdmin(db as never, ' Owner@RouteIQ.example ', { tenant: 'nmwc', env: env() });
    expect(r.changed).toBe(true);
    expect(r.after.role).toBe('SUPER_ADMIN');
    expect(users.get('owner@routeiq.example')!.role).toBe('SUPER_ADMIN');
    expect(audits[0]).toMatchObject({ tenantId: 't1', userId: 'u1', action: 'PLATFORM_ADMIN_GRANTED' });
    expect(r.warnings.join(' ')).toMatch(/SUPER_ADMIN_EMAILS/);
    expect(r.facts).toMatchObject({ email: 'owner@routeiq.example', tenant: { slug: 'nmwc' }, signup: null });
  });

  it('no warning when the email is allowlisted; granting twice changes nothing', async () => {
    const first = await setPlatformAdmin(db as never, 'owner@routeiq.example', { tenant: 'nmwc', env: env('owner@routeiq.example') });
    expect(first.warnings).toEqual([]);
    const again = await setPlatformAdmin(db as never, 'owner@routeiq.example', { tenant: 'NMWC', env: env('owner@routeiq.example') });
    expect(again.changed).toBe(false);
    expect(audits).toHaveLength(1);
  });

  it('without --tenant a grant only shows the account and its company: nothing changes', async () => {
    const err = await setPlatformAdmin(db as never, 'owner@routeiq.example', { env: env('owner@routeiq.example') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrantRefused);
    const refused = err as GrantRefused;
    expect(refused.message).toMatch(/Nothing changed/);
    expect(refused.message).toMatch(/--tenant/);
    expect(refused.facts.tenant).toMatchObject({ slug: 'nmwc', name: 'National Mineral Water' });
    expect(refused.before).toEqual({ role: 'TENANT_ADMIN', active: true });
    expect(refused.after).toEqual({ role: 'SUPER_ADMIN', active: true });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(users.get('owner@routeiq.example')!.role).toBe('TENANT_ADMIN');
  });

  it("refuses the outsider's account when the owner names his own company (the address was registered elsewhere)", async () => {
    const err = await setPlatformAdmin(db as never, 'planner@nmwc.example', { tenant: 'nmwc', allowSelfSignup: true, env: env('planner@nmwc.example') }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GrantRefused);
    expect((err as Error).message).toMatch(/belongs to company "rvsa2-o" \("Throwaway"\), not to "nmwc"/);
    expect((err as GrantRefused).facts.signup).toEqual({ at: day('2026-10-01'), byEmail: 'planner@nmwc.example' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(users.get('planner@nmwc.example')!.role).toBe('TENANT_ADMIN');
    expect(audits).toHaveLength(0);
  });

  it('refuses a company made through public sign-up unless --allow-self-signup is passed', async () => {
    const err = await setPlatformAdmin(db as never, 'planner@nmwc.example', { tenant: 'rvsa2-o', env: env('planner@nmwc.example') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrantRefused);
    expect((err as Error).message).toMatch(/made through public sign-up on 2026-10-01 08:00 UTC by planner@nmwc\.example/);
    expect((err as Error).message).toMatch(/--allow-self-signup/);
    expect(db.$transaction).not.toHaveBeenCalled();

    const r = await setPlatformAdmin(db as never, 'planner@nmwc.example', { tenant: 'rvsa2-o', allowSelfSignup: true, env: env('planner@nmwc.example') });
    expect(r.changed).toBe(true);
    expect(audits[0]).toMatchObject({ tenantId: 't9', action: 'PLATFORM_ADMIN_GRANTED' });
  });

  it('also refuses an account invited into a company made through public sign-up (the invite squat)', async () => {
    users.set('sohar@nmwc.example', { id: 'u10', email: 'sohar@nmwc.example', name: 'Sohar', role: 'VIEWER', active: true, tenantId: 't9', createdAt: day('2026-10-02') });
    const err = await setPlatformAdmin(db as never, 'sohar@nmwc.example', { tenant: 'rvsa2-o', env: env() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrantRefused);
    expect((err as Error).message).toMatch(/by planner@nmwc\.example/);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('an account without a company is confirmed with --no-tenant, and a slug for it is refused', async () => {
    users.get('ops@routeiq.example')!.role = 'TENANT_ADMIN';
    await expect(setPlatformAdmin(db as never, 'ops@routeiq.example', { tenant: 'nmwc', env: env() })).rejects.toThrow(/belongs to no company, not to "nmwc"/);
    await expect(setPlatformAdmin(db as never, 'ops@routeiq.example', { env: env() })).rejects.toThrow(/--no-tenant/);
    await expect(setPlatformAdmin(db as never, 'owner@routeiq.example', { tenant: null, env: env() })).rejects.toThrow(/not to no company/);
    expect(db.$transaction).not.toHaveBeenCalled();
    const r = await setPlatformAdmin(db as never, 'ops@routeiq.example', { tenant: null, env: env('ops@routeiq.example') });
    expect(r.after).toEqual({ role: 'SUPER_ADMIN', active: true });
    expect(audits).toHaveLength(0); // no company, no audit log
  });

  it('revoke returns a tenant user to TENANT_ADMIN with a PLATFORM_ADMIN_REVOKED row (no confirmation needed)', async () => {
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

  it('refuses an unknown or malformed email, and never suggests sign-up to create the account', async () => {
    const unknown = (await setPlatformAdmin(db as never, 'nobody@routeiq.example', { tenant: 'nmwc', env: env() }).catch((e: unknown) => e)) as Error;
    expect(unknown).toBeInstanceOf(Error);
    expect(unknown.message).toMatch(/No user/);
    expect(unknown.message).toMatch(/Invite the person from your own company's Users screen/);
    expect(unknown.message).not.toMatch(/sign-up/i);
    await expect(setPlatformAdmin(db as never, 'not an email', { env: env() })).rejects.toThrow(/Not an email/);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('describeAccount', () => {
  it('names the company, when it was made and whether public sign-up made it', () => {
    const lines = describeAccount({
      email: 'planner@nmwc.example',
      name: 'Planner',
      createdAt: day('2026-10-01'),
      tenant: { slug: 'rvsa2-o', name: 'Throwaway', createdAt: day('2026-10-01') },
      signup: { at: day('2026-10-01'), byEmail: 'planner@nmwc.example' },
    }).join('\n');
    expect(lines).toMatch(/Account: planner@nmwc\.example \("Planner"\), created 2026-10-01 08:00 UTC/);
    expect(lines).toMatch(/Company: rvsa2-o \("Throwaway"\)/);
    expect(lines).toMatch(/made through public sign-up on 2026-10-01 08:00 UTC by planner@nmwc\.example/);
    const seeded = describeAccount({ email: 'a@b.c', name: 'A', createdAt: day('2026-05-11'), tenant: { slug: 'nmwc', name: 'N', createdAt: day('2026-05-11') }, signup: null });
    expect(seeded.join('\n')).toMatch(/not made through public sign-up/);
    expect(describeAccount({ email: 'a@b.c', name: 'A', createdAt: day('2026-05-11'), tenant: null, signup: null }).join('\n')).toMatch(/Company: none/);
  });
});

describe('parseArgs (the command line)', () => {
  it('reads the email, --tenant in both spellings, --no-tenant, --allow-self-signup and --revoke', () => {
    expect(parseArgs(['ops@x.example'])).toEqual({ email: 'ops@x.example', revoke: false, tenant: undefined, allowSelfSignup: false });
    expect(parseArgs(['ops@x.example', '--tenant', 'nmwc'])).toMatchObject({ tenant: 'nmwc' });
    expect(parseArgs(['--tenant=nmwc', 'ops@x.example', '--allow-self-signup'])).toMatchObject({ email: 'ops@x.example', tenant: 'nmwc', allowSelfSignup: true });
    expect(parseArgs(['ops@x.example', '--no-tenant'])).toMatchObject({ tenant: null });
    expect(parseArgs(['--', 'ops@x.example', '--revoke'])).toMatchObject({ revoke: true });
  });

  it('refuses a mistyped option instead of ignoring it (a mistyped --revoke used to grant)', () => {
    expect(() => parseArgs(['ops@x.example', '--revok'])).toThrow(/Unknown option --revok/);
    expect(() => parseArgs(['ops@x.example', '--tenant'])).toThrow(/--tenant needs the company slug/);
    expect(() => parseArgs(['ops@x.example', '--tenant', '--allow-self-signup'])).toThrow(/--tenant needs the company slug/);
    expect(() => parseArgs(['ops@x.example', '--tenant', 'a', '--no-tenant'])).toThrow(/once/);
    expect(() => parseArgs([])).toThrow(/Usage/);
    expect(() => parseArgs(['a@x.example', 'b@x.example'])).toThrow(/Usage/);
  });
});
