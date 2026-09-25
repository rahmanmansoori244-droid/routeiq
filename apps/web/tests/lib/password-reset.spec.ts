/**
 * Password-reset token machinery — CLAUDE.md §15 contract:
 *   - 32-byte random, base64url
 *   - SHA-256 hashed in DB, never raw
 *   - 24h lifetime, single-use, max 3 per email per hour
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import {
  RESET_TOKEN_BYTES,
  RESET_TOKEN_TTL_MS,
  RESET_THROTTLE_MAX,
  createResetTokenForEmail,
  consumeResetToken,
  deliverResetEmail,
  generateRawToken,
  hashToken,
  resetBaseUrl,
  resetPasswordWithToken,
  resetTokenUsable,
} from '@/lib/password-reset';

const prisma = new PrismaClient();

const SUFFIX = `pwd-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SLUG = `test-pwd-${SUFFIX}`;
const EMAIL = `pwd-${SUFFIX}@isolation.test`;

let tenantId: string;
let userId: string;

beforeAll(async () => {
  const hash = await bcrypt.hash('initial-password-1234', 12);
  const t = await prisma.tenant.create({
    data: {
      slug: SLUG,
      name: `Pwd reset test ${SUFFIX}`,
      country: 'Testland',
      currency: 'OMR',
      config: { create: {} },
      users: { create: { email: EMAIL, passwordHash: hash, name: 'Pwd Test', role: 'TENANT_ADMIN' } },
    },
    include: { users: true },
  });
  tenantId = t.id;
  userId = t.users[0].id;
});

afterEach(async () => {
  // Wipe any tokens between tests so the throttle test is deterministic.
  await prisma.passwordResetToken.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } });
  await prisma.$disconnect();
});

describe('token primitives', () => {
  it('generateRawToken produces a 32-byte base64url token', () => {
    const token = generateRawToken();
    // base64url of 32 bytes is 43 chars (no padding).
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token.length).toBeLessThanOrEqual(44);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  it('hashToken is deterministic and produces 64-char hex SHA-256', () => {
    const a = hashToken('xyz');
    const b = hashToken('xyz');
    expect(a).toBe(b);
    expect(a.length).toBe(64);
    expect(/^[a-f0-9]+$/.test(a)).toBe(true);
  });

  it('RESET_TOKEN_BYTES is 32', () => {
    expect(RESET_TOKEN_BYTES).toBe(32);
  });

  it('RESET_TOKEN_TTL_MS is 24 hours', () => {
    expect(RESET_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('createResetTokenForEmail', () => {
  it('returns "unknown_email" for missing user (no enumeration)', async () => {
    const r = await createResetTokenForEmail('does-not-exist@nowhere.test');
    expect(r.status).toBe('unknown_email');
    expect(r.rawToken).toBeNull();
  });

  it('creates a token for a known user', async () => {
    const r = await createResetTokenForEmail(EMAIL);
    expect(r.status).toBe('created');
    expect(r.rawToken).not.toBeNull();
  });

  it('stores only the hash in DB, never the raw token', async () => {
    const r = await createResetTokenForEmail(EMAIL);
    expect(r.rawToken).not.toBeNull();
    const dbRow = await prisma.passwordResetToken.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(dbRow).not.toBeNull();
    expect(dbRow!.tokenHash).toBe(hashToken(r.rawToken!));
    expect(dbRow!.tokenHash).not.toBe(r.rawToken);
  });

  it(`throttles after ${RESET_THROTTLE_MAX} requests in an hour`, async () => {
    for (let i = 0; i < RESET_THROTTLE_MAX; i++) {
      const r = await createResetTokenForEmail(EMAIL);
      expect(r.status).toBe('created');
    }
    const throttled = await createResetTokenForEmail(EMAIL);
    expect(throttled.status).toBe('throttled');
    expect(throttled.rawToken).toBeNull();
  });
});

describe('consumeResetToken', () => {
  it('rejects invalid token', async () => {
    const r = await consumeResetToken('definitely-not-a-real-token-just-junk');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('rejects too-short token outright', async () => {
    const r = await consumeResetToken('short');
    expect(r.ok).toBe(false);
  });

  it('accepts valid token and marks single-use', async () => {
    const issued = await createResetTokenForEmail(EMAIL);
    expect(issued.rawToken).not.toBeNull();

    const first = await consumeResetToken(issued.rawToken!);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.userId).toBe(userId);

    // Second use of the same token must fail (deleted-on-consume).
    const second = await consumeResetToken(issued.rawToken!);
    expect(second.ok).toBe(false);
  });

  it('rejects expired token', async () => {
    const raw = generateRawToken();
    await prisma.passwordResetToken.create({
      data: {
        userId,
        tenantId,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() - 1000), // already expired
      },
    });
    const r = await consumeResetToken(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
  });
});

describe('one live link per user (review new issue: reset token revocation)', () => {
  it('issuing a new link retires the older unused one', async () => {
    const first = await createResetTokenForEmail(EMAIL);
    const second = await createResetTokenForEmail(EMAIL);
    expect(await resetTokenUsable(first.rawToken!)).toBe(false);
    expect(await resetTokenUsable(second.rawToken!)).toBe(true);
    const r = await consumeResetToken(first.rawToken!);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('used');
  });

  it('resetPasswordWithToken sets the password and retires every other link, in one transaction', async () => {
    const other = generateRawToken();
    await prisma.passwordResetToken.create({
      data: { userId, tenantId, tokenHash: hashToken(other), expiresAt: new Date(Date.now() + 3600_000) },
    });
    const issued = await createResetTokenForEmail(EMAIL); // retires `other` already
    await prisma.passwordResetToken.update({ where: { tokenHash: hashToken(other) }, data: { usedAt: null } }); // simulate an older live link
    const newHash = await bcrypt.hash('brand-new-password-1', 4);
    const r = await resetPasswordWithToken(issued.rawToken!, newHash);
    expect(r.ok).toBe(true);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.passwordHash).toBe(newHash);
    expect(await resetTokenUsable(other)).toBe(false);
    expect(await resetTokenUsable(issued.rawToken!)).toBe(false);
    // Second use fails and changes nothing.
    const again = await resetPasswordWithToken(issued.rawToken!, 'x');
    expect(again.ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash).toBe(newHash);
  });

  it('a failed password update leaves the token unconsumed', async () => {
    const issued = await createResetTokenForEmail(EMAIL);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await consumeResetToken(issued.rawToken!, async () => {
      throw new Error('simulated failure');
    });
    quiet.mockRestore();
    expect(r.ok).toBe(false);
    expect(await resetTokenUsable(issued.rawToken!)).toBe(true);
  });
});

describe('reset link delivery never leaks the link in production (review L8)', () => {
  const TOKEN = 'tok_' + 'q'.repeat(40);
  const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

  function captureConsole() {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );
    return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
  }

  it('production without RESEND_API_KEY: nothing sent, only the user id is logged', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const c = captureConsole();
    await deliverResetEmail('victim@nmwc.example', TOKEN, 'user-123', env({ NODE_ENV: 'production', AUTH_URL: 'https://routeiq.example' }));
    c.restore();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const all = c.lines.join('\n');
    expect(all).toContain('user-123');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('victim@nmwc.example');
    expect(all).not.toContain('/reset?token=');
  });

  it('production without AUTH_URL / NEXTAUTH_URL: refuses to build a link', async () => {
    expect(resetBaseUrl(env({ NODE_ENV: 'production' }))).toBeNull();
    const c = captureConsole();
    await deliverResetEmail('victim@nmwc.example', TOKEN, 'user-123', env({ NODE_ENV: 'production', RESEND_API_KEY: 're_x' }));
    c.restore();
    expect(c.lines.join('\n')).not.toContain(TOKEN);
    expect(c.lines.join('\n')).toContain('NOT sent');
  });

  it('AUTH_URL wins over NEXTAUTH_URL; development falls back to localhost', () => {
    expect(resetBaseUrl(env({ AUTH_URL: 'https://a.example/', NEXTAUTH_URL: 'https://b.example' }))).toBe('https://a.example');
    expect(resetBaseUrl(env({ NEXTAUTH_URL: 'https://b.example' }))).toBe('https://b.example');
    expect(resetBaseUrl(env({ NODE_ENV: 'development' }))).toBe('http://localhost:3000');
  });

  it('development without a key logs the link for local testing', async () => {
    const c = captureConsole();
    await deliverResetEmail('dev@local.test', TOKEN, 'user-1', env({ NODE_ENV: 'development' }));
    c.restore();
    expect(c.lines.join('\n')).toContain(`/reset?token=${TOKEN}`);
  });

  it('a Resend rejection logs the status only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`bad ${TOKEN}`, { status: 422 }));
    const c = captureConsole();
    await deliverResetEmail('victim@nmwc.example', TOKEN, 'user-9', env({ NODE_ENV: 'production', AUTH_URL: 'https://r.example', RESEND_API_KEY: 're_x' }));
    c.restore();
    fetchSpy.mockRestore();
    const all = c.lines.join('\n');
    expect(all).toContain('422');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('victim@nmwc.example');
  });
});
