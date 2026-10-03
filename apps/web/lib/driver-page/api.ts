/**
 * The driver page's calls (owner request 4 Oct 2026, spec sections 4.1 and 5). The token is read
 * from the page's own URL (/d/<token>) and sent ONLY in the header `Authorization: DriverLink
 * <token>` to token-free paths (/api/d/...), so it reaches server logs once per page open, not on
 * every poll. Each browser sends its random id (X-Driver-Device) for "used on N phones".
 * Browser-safe.
 */
import type { DriverManifest, LinkStateCode } from '../driver-link/manifest-types';

/** The token of a /d/<token> path, or null. */
export function tokenFromPath(pathname: string): string | null {
  const m = /^\/d\/([A-Za-z0-9_-]{24})\/?$/.exec(pathname);
  return m ? m[1]! : null;
}

let memoryDevice: string | null = null;

function randomHex32(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** This browser's random id (32 hex), kept in localStorage when it works, else for this page view. */
export function deviceId(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeLocalStorage()): string {
  try {
    const kept = storage?.getItem('riq.d.device');
    if (kept && /^[0-9a-f]{32}$/.test(kept)) return kept;
    const id = randomHex32();
    storage?.setItem('riq.d.device', id);
    return id;
  } catch {
    memoryDevice ??= randomHex32();
    return memoryDevice;
  }
}

export function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function driverHeaders(token: string, device: string): Record<string, string> {
  return { Authorization: `DriverLink ${token}`, 'X-Driver-Device': device, Accept: 'application/json' };
}

export type ManifestAnswer =
  | { kind: 'ok'; manifest: DriverManifest }
  | { kind: 'link'; status: number; code: LinkStateCode; uploadOnly: boolean; date: string | null }
  | { kind: 'busy'; retryAfterSec: number | null }
  | { kind: 'error'; status: number };

/** How a manifest answer reads (pure: the page and the tests share it). */
export function readManifestAnswer(status: number, body: unknown, retryAfter: string | null): ManifestAnswer {
  const b = (body ?? {}) as { data?: unknown; error?: unknown };
  if (status === 200 && b.data && typeof b.data === 'object') return { kind: 'ok', manifest: b.data as DriverManifest };
  const err = (b.error && typeof b.error === 'object' ? b.error : {}) as { code?: unknown; uploadOnly?: unknown; date?: unknown };
  if ((status === 404 || status === 410 || status === 503) && typeof err.code === 'string') {
    return { kind: 'link', status, code: err.code as LinkStateCode, uploadOnly: err.uploadOnly === true, date: typeof err.date === 'string' ? err.date : null };
  }
  if (status === 429) {
    const s = Number(retryAfter);
    return { kind: 'busy', retryAfterSec: Number.isFinite(s) && s > 0 ? s : null };
  }
  return { kind: 'error', status };
}

/** GET /api/d/manifest with the token in the header. A network failure answers { kind: 'error', status: 0 }. */
export async function fetchManifest(token: string, device: string, fetchImpl: typeof fetch = fetch): Promise<ManifestAnswer> {
  try {
    const res = await fetchImpl('/api/d/manifest', { headers: driverHeaders(token, device), cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer' });
    const body = await res.json().catch(() => null);
    return readManifestAnswer(res.status, body, res.headers.get('retry-after'));
  } catch {
    return { kind: 'error', status: 0 };
  }
}
