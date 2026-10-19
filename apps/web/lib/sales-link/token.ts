/**
 * The salesman link's token (owner request 19 Oct 2026). Server only (node:crypto).
 *
 * The driver link's scheme (lib/driver-link/token.ts) with its own key, so a driver token can never pass
 * as a salesman token, nor the reverse (and the salesman link can only read):
 * - Server key: K = HKDF-SHA256(ikm, salt "routeiq-sales-link", info "v1", 32 bytes), where ikm is
 *   SALES_LINK_SECRET, else the driver link's secret (DRIVER_LINK_SECRET, NEXTAUTH_SECRET, AUTH_SECRET).
 *   SALES_LINK_SECRET alone rotates every salesman link without touching the drivers'. Without any secret
 *   the routes answer 503 SALES_LINKS_OFF. keyId = the first 8 hex of SHA-256(K).
 * - Token: base64url(HMAC-SHA256(K, "<id>.<generation>.<salt>")), first 24 characters = 144 bits
 *   (deriveToken of the driver link: it takes any key).
 * - Stored: only tokenHash = SHA-256 hex of the token, the salt, the generation and the keyId. The token is
 *   derived again for the office dialog; it is never stored, logged or audited.
 * - Expiry: 06:00 company time on the day after the delivery date (a link sent the evening before works
 *   through the night's last trips and is dead before the next day's link is sent). A reissue never extends it.
 */
import { hkdfSync, randomBytes } from 'node:crypto';
import { addDaysIso, zonedDayStart } from '../dispatch/time';
import { deriveToken, driverLinkIkm, sha256Hex, tokenHash, newSalt } from '../driver-link/token';

export { deriveToken, tokenHash, newSalt, sha256Hex };

/** 24 URL-safe characters: the only shape a token can have (checked before any database work). */
export const SALES_LINK_TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

/** The link stops working at this hour (company time) on the day after the delivery date. */
export const SALES_LINK_END_HOUR = 6;

export interface SalesLinkKey {
  key: Buffer;
  keyId: string;
}

/** The secret the server key is derived from: SALES_LINK_SECRET, else the driver link's (DRIVER_LINK_SECRET, NEXTAUTH_SECRET, AUTH_SECRET). */
export function salesLinkIkm(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = env.SALES_LINK_SECRET?.trim();
  return own ? own : driverLinkIkm(env);
}

/** The server key and its id, or null when no secret is configured (salesman links are then off). */
export function salesLinkKey(env: NodeJS.ProcessEnv = process.env): SalesLinkKey | null {
  const ikm = salesLinkIkm(env);
  if (!ikm) return null;
  const key = Buffer.from(hkdfSync('sha256', ikm, 'routeiq-sales-link', 'v1', 32));
  return { key, keyId: sha256Hex(key).slice(0, 8) };
}

/** A fresh row id for a new link (the token is derived from it, so it is chosen before the insert). */
export function newSalesLinkId(): string {
  return `sl${randomBytes(12).toString('hex')}`;
}

export function looksLikeSalesToken(t: string | null | undefined): t is string {
  return typeof t === 'string' && SALES_LINK_TOKEN_RE.test(t);
}

/** When a link stops working: 06:00 company time on the day after the delivery date (Asia/Muscat: 02:00 UTC of D+1). */
export function salesLinkExpiry(dateIso: string, tz: string): Date {
  return new Date(zonedDayStart(addDaysIso(dateIso, 1), tz).getTime() + SALES_LINK_END_HOUR * 60 * 60 * 1000);
}

/** The page's address: <base>/s/<token>. */
export function salesLinkUrl(base: string, token: string): string {
  return `${base}/s/${token}`;
}

/** The first 8 hex of SHA-256 of the page's random per-browser id (32 hex): what "opened on N phones" keeps. */
export function salesDeviceHash(deviceId: string): string {
  return sha256Hex(deviceId).slice(0, 8);
}
