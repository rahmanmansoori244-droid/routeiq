/**
 * The driver link's token (owner request 4 Oct 2026, spec section 4.1). Server only (node:crypto).
 *
 * - Server key: K = HKDF-SHA256(ikm, salt "routeiq-driver-link", info "v1", 32 bytes), where ikm is
 *   DRIVER_LINK_SECRET, else NEXTAUTH_SECRET, else AUTH_SECRET. Without any of them the driver link
 *   routes answer 503 DRIVER_LINKS_OFF. keyId = the first 8 hex of SHA-256(K).
 * - Token: base64url(HMAC-SHA256(K, "<id>.<generation>.<salt>")), first 24 characters = 144 bits.
 *   The salt is 16 random bytes, new on every issue and reissue.
 * - Stored: only tokenHash = SHA-256 hex of the token, with the salt, the generation and the keyId.
 *   The token itself is never stored, logged or audited; the server derives it again to print the
 *   same link on every PDF and in the dialog (a hash alone could not be shown twice).
 * - Rotating the secret changes keyId: every old link then answers 410 LINK_REPLACED until the
 *   dispatcher reopens the link dialog or prints again (ensureLink writes the new hash).
 */
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { addDaysIso, zonedDayStart } from '../dispatch/time';

/** 24 URL-safe characters: the only shape a token can have (checked before any database work). */
export const DRIVER_LINK_TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

/** Results recorded before the link expired may still be uploaded for this long after it. */
export const UPLOAD_GRACE_MS = 72 * 60 * 60 * 1000;

export interface DriverLinkKey {
  key: Buffer;
  keyId: string;
}

/** The secret the server key is derived from: DRIVER_LINK_SECRET, else NEXTAUTH_SECRET, else AUTH_SECRET. */
export function driverLinkIkm(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of ['DRIVER_LINK_SECRET', 'NEXTAUTH_SECRET', 'AUTH_SECRET'] as const) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return null;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The server key and its id, or null when no secret is configured (driver links are then off). */
export function driverLinkKey(env: NodeJS.ProcessEnv = process.env): DriverLinkKey | null {
  const ikm = driverLinkIkm(env);
  if (!ikm) return null;
  const key = Buffer.from(hkdfSync('sha256', ikm, 'routeiq-driver-link', 'v1', 32));
  return { key, keyId: sha256Hex(key).slice(0, 8) };
}

/** The token of one generation of one link (deterministic: the same inputs give the same token). */
export function deriveToken(key: Buffer, id: string, generation: number, salt: string): string {
  return createHmac('sha256', key).update(`${id}.${generation}.${salt}`).digest('base64url').slice(0, 24);
}

/** What the database keeps of a token: its SHA-256, hex. */
export function tokenHash(token: string): string {
  return sha256Hex(token);
}

/** 16 random bytes, base64url: new on every issue and reissue. */
export function newSalt(): string {
  return randomBytes(16).toString('base64url');
}

/** A fresh row id for a new link (the token is derived from it, so it is chosen before the insert). */
export function newLinkId(): string {
  return `dl${randomBytes(12).toString('hex')}`;
}

export function looksLikeToken(t: string | null | undefined): t is string {
  return typeof t === 'string' && DRIVER_LINK_TOKEN_RE.test(t);
}

/**
 * When a link stops working for reading and new results: 12:00 company time on the day after the
 * delivery date (Asia/Muscat: 08:00 UTC of D+1).
 */
export function linkExpiry(dateIso: string, tz: string): Date {
  return new Date(zonedDayStart(addDaysIso(dateIso, 1), tz).getTime() + 12 * 60 * 60 * 1000);
}

/** Until when results recorded before the expiry may still be uploaded: expiry + 72 h. */
export function linkUploadUntil(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + UPLOAD_GRACE_MS);
}

/**
 * The public base of driver links: AUTH_URL (next-auth v5) or NEXTAUTH_URL, else the origin of the
 * request (the dispatcher's own host).
 */
export function driverLinkBaseUrl(env: NodeJS.ProcessEnv = process.env, requestOrigin: string | null = null): string | null {
  const raw = (env.AUTH_URL ?? env.NEXTAUTH_URL ?? '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  return requestOrigin ? requestOrigin.replace(/\/+$/, '') : null;
}

export function driverLinkUrl(base: string, token: string): string {
  return `${base}/d/${token}`;
}

/** The first 16 hex of SHA-256 of the page's per-browser id (what a stop event keeps). */
export function deviceHash(deviceId: string): string {
  return sha256Hex(deviceId).slice(0, 16);
}
