/**
 * Sign-in check (review F16 + account enumeration): soft ip+email throttle, per-IP cap, an alert
 * (never a lock) on many failures for one account, a bcrypt compare even for unknown emails, the
 * inactive tenant/user checks, and one generic message. Fake database, real bcrypt (cost 4 for the
 * test users), a private limiter with the bypass off.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_FAILED_MESSAGE, LoginThrottled, verifyCredentials } from '@/lib/auth-credentials';
import { RateLimiter } from '@/lib/rate-limit';
import { passwordFingerprint } from '@/lib/session-principal';

interface Row {
  id: string;
  email: string;
  name: string;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'PLANNER';
  active: boolean;
  tenantId: string | null;
  passwordHash: string;
  tenant: { active: boolean } | null;
}

const PASSWORD = 'correct-horse-battery';
let hash = '';
const users = new Map<string, Row>();
const db = { user: { findUnique: vi.fn(async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null) } };
const audit = vi.fn(async (_input: unknown) => ({}));
let limiter: RateLimiter;
const env = { SUPER_ADMIN_EMAILS: '' } as unknown as NodeJS.ProcessEnv;

function add(email: string, over: Partial<Row> = {}) {
  users.set(email, {
    id: `id-${email}`,
    email,
    name: 'User',
    role: 'PLANNER',
    active: true,
    tenantId: 'tA',
    passwordHash: hash,
    tenant: { active: true },
    ...over,
  });
}
const reqFrom = (ip: string) => new Request('http://localhost/api/auth/callback/credentials', { headers: { 'x-forwarded-for': ip } });
const attempt = (email: string, password: string, ip = '203.0.113.1', e: NodeJS.ProcessEnv = env) =>
  verifyCredentials({ email, password }, reqFrom(ip), { db: db as never, limiter, audit: audit as never, env: e });

beforeAll(async () => {
  hash = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(() => {
  users.clear();
  audit.mockClear();
  db.user.findUnique.mockClear();
  limiter = new RateLimiter();
  add('dispatcher@nmwc.example');
});

describe('verifyCredentials', () => {
  it('signs in with the right password and returns role, tenant and the password fingerprint', async () => {
    const u = await attempt('Dispatcher@NMWC.example', PASSWORD);
    expect(u).toMatchObject({ id: 'id-dispatcher@nmwc.example', role: 'PLANNER', tenantId: 'tA' });
    expect(u?.pwf).toBe(await passwordFingerprint(hash));
  });

  it('the 6th failure for one IP + email is throttled, even with the right password', async () => {
    for (let i = 0; i < 5; i++) expect(await attempt('dispatcher@nmwc.example', 'wrong-password')).toBeNull();
    const compare = vi.spyOn(bcrypt, 'compare');
    await expect(attempt('dispatcher@nmwc.example', PASSWORD)).rejects.toBeInstanceOf(LoginThrottled);
    expect(compare).not.toHaveBeenCalled(); // throttled attempts cost no bcrypt
    compare.mockRestore();
    // Another IP is not affected (no account lock).
    expect(await attempt('dispatcher@nmwc.example', PASSWORD, '198.51.100.2')).not.toBeNull();
  });

  it('a success resets the ip + email counter', async () => {
    for (let i = 0; i < 4; i++) await attempt('dispatcher@nmwc.example', 'wrong-password');
    expect(await attempt('dispatcher@nmwc.example', PASSWORD)).not.toBeNull();
    for (let i = 0; i < 4; i++) expect(await attempt('dispatcher@nmwc.example', 'wrong-password')).toBeNull();
    expect(await attempt('dispatcher@nmwc.example', PASSWORD)).not.toBeNull();
  });

  it('caps attempts per IP (30 in 10 minutes) across emails', async () => {
    for (let i = 0; i < 30; i++) add(`user${i}@example.test`); // cost-4 hashes keep the test fast
    for (let i = 0; i < 30; i++) await attempt(`user${i}@example.test`, 'wrong-password', '192.0.2.50');
    await expect(attempt('dispatcher@nmwc.example', PASSWORD, '192.0.2.50')).rejects.toBeInstanceOf(LoginThrottled);
  });

  it('an unknown email still costs one bcrypt compare (no timing oracle)', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    expect(await attempt('ghost@example.test', 'whatever-password')).toBeNull();
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockRestore();
  });

  it('an inactive user or an inactive tenant is refused after the real compare', async () => {
    add('left@nmwc.example', { active: false });
    add('suspended@other.example', { tenant: { active: false } });
    const compare = vi.spyOn(bcrypt, 'compare');
    expect(await attempt('left@nmwc.example', PASSWORD)).toBeNull();
    expect(await attempt('suspended@other.example', PASSWORD)).toBeNull();
    expect(compare).toHaveBeenCalledTimes(2);
    compare.mockRestore();
  });

  it('20 failures in an hour for one account write one LOGIN_THROTTLED audit row but do not lock it', async () => {
    for (let i = 0; i < 25; i++) {
      await attempt('dispatcher@nmwc.example', 'wrong-password', `198.51.100.${i + 10}`);
    }
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ tenantId: 'tA', action: 'LOGIN_THROTTLED', entity: 'User' });
    expect(await attempt('dispatcher@nmwc.example', PASSWORD, '203.0.113.200')).not.toBeNull();
  });

  it('SUPER_ADMIN: needs SUPER_ADMIN_EMAILS; otherwise TENANT_ADMIN of the tenant, or refused without one', async () => {
    add('owner@example.test', { role: 'SUPER_ADMIN' });
    add('platform@example.test', { role: 'SUPER_ADMIN', tenantId: null, tenant: null });
    expect((await attempt('owner@example.test', PASSWORD))?.role).toBe('TENANT_ADMIN');
    expect(await attempt('platform@example.test', PASSWORD)).toBeNull();
    const allow = { SUPER_ADMIN_EMAILS: 'owner@example.test, platform@example.test' } as unknown as NodeJS.ProcessEnv;
    expect((await attempt('owner@example.test', PASSWORD, '203.0.113.1', allow))?.role).toBe('SUPER_ADMIN');
    expect((await attempt('platform@example.test', PASSWORD, '203.0.113.1', allow))?.role).toBe('SUPER_ADMIN');
  });

  it('keys the throttle on the proxy-appended IP, not the spoofable left-most one', async () => {
    const spoof = (i: number) =>
      verifyCredentials(
        { email: 'dispatcher@nmwc.example', password: 'wrong-password' },
        new Request('http://localhost/x', { headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.77` } }),
        { db: db as never, limiter, audit: audit as never, env },
      );
    for (let i = 0; i < 5; i++) await spoof(i);
    await expect(spoof(99)).rejects.toBeInstanceOf(LoginThrottled);
  });

  it('rejects malformed input without a lookup', async () => {
    expect(await attempt('not-an-email', PASSWORD)).toBeNull();
    expect(await attempt('dispatcher@nmwc.example', 'short')).toBeNull();
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('the login form shows the same single message for every failure', () => {
    const form = readFileSync(path.join(__dirname, '../../app/login/login-form.tsx'), 'utf8');
    expect(form).toContain(`'${LOGIN_FAILED_MESSAGE}'`);
    expect(form.match(/toast\.error\(/g)).toHaveLength(1);
  });
});
