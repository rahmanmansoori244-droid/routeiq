/**
 * The driver link's token (owner request 4 Oct 2026, spec section 4.1-4.2): derived, never stored;
 * 144 bits; the secret order; the expiry at 12:00 company time on the next day and the 72 h upload
 * grace. Pure (no database).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveToken,
  deviceHash,
  DRIVER_LINK_TOKEN_RE,
  driverLinkBaseUrl,
  driverLinkIkm,
  driverLinkKey,
  driverLinkUrl,
  linkExpiry,
  linkUploadUntil,
  looksLikeToken,
  newLinkId,
  newSalt,
  tokenHash,
} from '@/lib/driver-link/token';

const env = (over: Record<string, string | undefined>) => ({ NODE_ENV: 'test', ...over }) as unknown as NodeJS.ProcessEnv;

describe('the server key', () => {
  it('takes DRIVER_LINK_SECRET over NEXTAUTH_SECRET over AUTH_SECRET, and none = links off', () => {
    expect(driverLinkIkm(env({ DRIVER_LINK_SECRET: 'd', NEXTAUTH_SECRET: 'n', AUTH_SECRET: 'a' }))).toBe('d');
    expect(driverLinkIkm(env({ NEXTAUTH_SECRET: 'n', AUTH_SECRET: 'a' }))).toBe('n');
    expect(driverLinkIkm(env({ AUTH_SECRET: 'a' }))).toBe('a');
    expect(driverLinkIkm(env({ DRIVER_LINK_SECRET: '  ', NEXTAUTH_SECRET: 'n' }))).toBe('n');
    expect(driverLinkIkm(env({}))).toBeNull();
    expect(driverLinkKey(env({}))).toBeNull();
  });

  it('keyId changes with the key and is the first 8 hex of its SHA-256', () => {
    const a = driverLinkKey(env({ NEXTAUTH_SECRET: 'secret-one' }))!;
    const b = driverLinkKey(env({ NEXTAUTH_SECRET: 'secret-two' }))!;
    expect(a.key).toHaveLength(32);
    expect(a.keyId).toMatch(/^[0-9a-f]{8}$/);
    expect(a.keyId).toBe(createHash('sha256').update(a.key).digest('hex').slice(0, 8));
    expect(a.keyId).not.toBe(b.keyId);
    // Same secret, same key: stable across restarts.
    expect(driverLinkKey(env({ NEXTAUTH_SECRET: 'secret-one' }))!.keyId).toBe(a.keyId);
  });
});

describe('the token', () => {
  const k = driverLinkKey(env({ NEXTAUTH_SECRET: 'test-secret' }))!.key;

  it('is deterministic: the same link, generation and salt give the same token', () => {
    expect(deriveToken(k, 'dl1', 1, 'saltA')).toBe(deriveToken(k, 'dl1', 1, 'saltA'));
  });

  it('a new generation, a new salt or another link gives a new token', () => {
    const t = deriveToken(k, 'dl1', 1, 'saltA');
    expect(deriveToken(k, 'dl1', 2, 'saltA')).not.toBe(t);
    expect(deriveToken(k, 'dl1', 1, 'saltB')).not.toBe(t);
    expect(deriveToken(k, 'dl2', 1, 'saltA')).not.toBe(t);
    const other = driverLinkKey(env({ NEXTAUTH_SECRET: 'rotated' }))!.key;
    expect(deriveToken(other, 'dl1', 1, 'saltA')).not.toBe(t);
  });

  it('is 24 URL-safe characters (144 bits) and only that shape passes the check', () => {
    for (let i = 0; i < 50; i++) {
      const t = deriveToken(k, newLinkId(), i + 1, newSalt());
      expect(t).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(looksLikeToken(t)).toBe(true);
    }
    expect(DRIVER_LINK_TOKEN_RE.source).toBe('^[A-Za-z0-9_-]{24}$');
    expect(looksLikeToken('short')).toBe(false);
    expect(looksLikeToken('a'.repeat(25))).toBe(false);
    expect(looksLikeToken('abc/def+ghi=jklmnopqrstu')).toBe(false);
    expect(looksLikeToken(null)).toBe(false);
  });

  it('is stored only as its SHA-256 hex', () => {
    const t = deriveToken(k, 'dl1', 1, 'saltA');
    expect(tokenHash(t)).toBe(createHash('sha256').update(t).digest('hex'));
    expect(tokenHash(t)).not.toContain(t);
  });

  it('salts are 16 random bytes and link ids are fresh', () => {
    const s = newSalt();
    expect(Buffer.from(s, 'base64url')).toHaveLength(16);
    expect(newSalt()).not.toBe(s);
    expect(newLinkId()).not.toBe(newLinkId());
  });

  it('a device id is kept as the first 16 hex of its SHA-256', () => {
    expect(deviceHash('0123456789abcdef0123456789abcdef')).toBe(createHash('sha256').update('0123456789abcdef0123456789abcdef').digest('hex').slice(0, 16));
  });
});

describe('expiry and the upload grace', () => {
  it('works until 12:00 Asia/Muscat on the day after the delivery date (08:00 UTC)', () => {
    expect(linkExpiry('2026-10-05', 'Asia/Muscat').toISOString()).toBe('2026-10-06T08:00:00.000Z');
    // Across a month end.
    expect(linkExpiry('2026-10-31', 'Asia/Muscat').toISOString()).toBe('2026-11-01T08:00:00.000Z');
    // Across a year end, and in UTC.
    expect(linkExpiry('2026-12-31', 'UTC').toISOString()).toBe('2027-01-01T12:00:00.000Z');
  });

  it('uploads are accepted 72 h after the expiry', () => {
    const e = linkExpiry('2026-10-05', 'Asia/Muscat');
    expect(linkUploadUntil(e).toISOString()).toBe('2026-10-09T08:00:00.000Z');
  });
});

describe('the link', () => {
  it('uses AUTH_URL or NEXTAUTH_URL, else the request origin', () => {
    expect(driverLinkBaseUrl(env({ AUTH_URL: 'https://routeiq.example/' }), 'http://x')).toBe('https://routeiq.example');
    expect(driverLinkBaseUrl(env({ NEXTAUTH_URL: 'https://n.example' }), 'http://x')).toBe('https://n.example');
    expect(driverLinkBaseUrl(env({}), 'https://dispatch.example')).toBe('https://dispatch.example');
    expect(driverLinkBaseUrl(env({}), null)).toBeNull();
    expect(driverLinkUrl('https://routeiq.example', 'A'.repeat(24))).toBe(`https://routeiq.example/d/${'A'.repeat(24)}`);
  });
});
