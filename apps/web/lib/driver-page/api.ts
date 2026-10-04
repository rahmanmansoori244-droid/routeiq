/**
 * The driver page's calls (owner request 4 Oct 2026, spec sections 4.1 and 5). The token is read
 * from the page's own URL (/d/<token>) and sent ONLY in the header `Authorization: DriverLink
 * <token>` to token-free paths (/api/d/...), so it reaches server logs once per page open, not on
 * every poll. Each browser sends its random id (X-Driver-Device) for "used on N phones".
 * Browser-safe.
 */
import type { DriverAction, DriverManifest, LinkStateCode } from '../driver-link/manifest-types';

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
  // A RouteIQ session of another company in this browser: the link cannot be used here until it signs out.
  if (status === 403 && err.code === 'SIGNED_IN_OTHER_TENANT') return { kind: 'link', status, code: 'SIGNED_IN_OTHER_TENANT', uploadOnly: false, date: null };
  if (status === 429) {
    const s = Number(retryAfter);
    return { kind: 'busy', retryAfterSec: Number.isFinite(s) && s > 0 ? s : null };
  }
  return { kind: 'error', status };
}

export interface RawAnswer {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

async function raw(res: Response): Promise<RawAnswer> {
  return { status: res.status, body: await res.json().catch(() => null), retryAfter: res.headers.get('retry-after') };
}

/** How long one request may take on a weak signal before it counts as failed (status 0: the queue backs off and retries). */
export const ACTIONS_TIMEOUT_MS = 30_000;
export const MANIFEST_TIMEOUT_MS = 30_000;
export const PHOTO_TIMEOUT_MS = 90_000;

/**
 * A request with a time limit, the answer's body included: AbortController plus a timer (older
 * iPhones have no AbortSignal.timeout), and the timer alone ends it when a fetch ignores the abort.
 * Without it one stalled upload (the truck left coverage mid-request) held every later send until
 * the page was reloaded.
 */
async function timed<T>(ms: number, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl?.abort();
      reject(new Error('timeout'));
    }, ms);
  });
  try {
    return await Promise.race([run(ctrl?.signal), limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/d/actions (Part 2): the queued actions with the phone's clock. A network failure or a timeout answers status 0. */
export async function postActions(token: string, device: string, actions: DriverAction[], fetchImpl: typeof fetch = fetch, timeoutMs = ACTIONS_TIMEOUT_MS): Promise<RawAnswer> {
  try {
    return await timed(timeoutMs, async (signal) =>
      raw(
        await fetchImpl('/api/d/actions', {
          method: 'POST',
          headers: { ...driverHeaders(token, device), 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientNow: new Date().toISOString(), actions }),
          cache: 'no-store',
          credentials: 'same-origin',
          referrerPolicy: 'no-referrer',
          signal,
        }),
      ),
    );
  } catch {
    return { status: 0, body: null, retryAfter: null };
  }
}

/** POST /api/d/photos (Part 2): one photo as multipart (`meta` JSON + `file`). A network failure or a timeout answers status 0. */
export async function postPhoto(token: string, device: string, meta: Record<string, unknown>, file: Blob, fetchImpl: typeof fetch = fetch, timeoutMs = PHOTO_TIMEOUT_MS): Promise<RawAnswer> {
  try {
    const form = new FormData();
    form.append('meta', JSON.stringify({ ...meta, clientNow: new Date().toISOString() }));
    form.append('file', file, 'photo.jpg');
    return await timed(timeoutMs, async (signal) =>
      raw(await fetchImpl('/api/d/photos', { method: 'POST', headers: driverHeaders(token, device), body: form, cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer', signal })),
    );
  } catch {
    return { status: 0, body: null, retryAfter: null };
  }
}

/** A photo of the truck-day as a blob URL (the token stays in the header, never in an image URL), or null. */
export async function photoUrl(token: string, device: string, photoId: string, fetchImpl: typeof fetch = fetch, timeoutMs = PHOTO_TIMEOUT_MS): Promise<string | null> {
  try {
    return await timed(timeoutMs, async (signal) => {
      const res = await fetchImpl(`/api/d/photos/${encodeURIComponent(photoId)}`, { headers: { ...driverHeaders(token, device), Accept: 'image/jpeg' }, cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer', signal });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    });
  } catch {
    return null;
  }
}

/** GET /api/d/manifest with the token in the header. A network failure or a timeout answers { kind: 'error', status: 0 }. */
export async function fetchManifest(token: string, device: string, fetchImpl: typeof fetch = fetch, timeoutMs = MANIFEST_TIMEOUT_MS): Promise<ManifestAnswer> {
  try {
    return await timed(timeoutMs, async (signal) => {
      const res = await fetchImpl('/api/d/manifest', { headers: driverHeaders(token, device), cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer', signal });
      const body = await res.json().catch(() => null);
      return readManifestAnswer(res.status, body, res.headers.get('retry-after'));
    });
  } catch {
    return { kind: 'error', status: 0 };
  }
}
