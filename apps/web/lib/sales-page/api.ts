/**
 * The salesman link page's calls (owner request 19 Oct 2026). Browser-safe: no database, no server code of the
 * link (tests/lib/repo-guards.spec.ts). The token is read from the page's own URL (/s/<token>) and sent ONLY in the
 * header `Authorization: SalesLink <token>` to a token-free path (GET /api/s/view), so it reaches server logs once
 * per page open, not on every refresh. Each browser sends a random id (X-Sales-Device) that the office only counts
 * ("opened on N phones"): the server never keys a limit on it.
 *
 * What the browser keeps (localStorage, when it works: WhatsApp's in-app browser may not keep it, so a route can
 * also come in the link's #fragment, "/s/<token>#R1"):
 * - `riq.s.route`: the route codes last found ("R1" or "R1, R2X");
 * - `riq.s.device`: the random id. Never the driver page's `riq.d.*` keys.
 */
import type { SalesLinkStateCode, SalesQueryErrorCode, SalesViewAnswer } from '../sales-link/view-types';
import { MAX_QUERY_CHARS } from '../sales-link/route-code';

export const ROUTE_KEY = 'riq.s.route';
export const DEVICE_KEY = 'riq.s.device';

/** How long one request may take on a weak signal before it counts as failed (the page keeps what it shows). */
export const VIEW_TIMEOUT_MS = 20_000;

export type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The token of a /s/<token> path, or null. */
export function tokenFromPath(pathname: string): string | null {
  const m = /^\/s\/([A-Za-z0-9_-]{24})\/?$/.exec(pathname);
  return m ? m[1]! : null;
}

/**
 * The route codes of the link's fragment ("#R1", "#R1,%20R2X", "#r%201"), or null: decoded, trimmed, at most
 * as long as a lookup may be. The server normalises them (the same rule as a typed code).
 */
export function routeFromHash(hash: string | null | undefined): string | null {
  let raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return null;
  try {
    raw = decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    // A broken escape: read it as it is.
  }
  const text = raw.trim();
  if (!text || text.length > MAX_QUERY_CHARS) return null;
  return text;
}

export function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function randomHex32(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let memoryDevice: string | null = null;

/** This browser's random id (32 hex), kept in localStorage when it works, else for this page view. */
export function deviceId(storage: KeyStore | null = safeLocalStorage()): string {
  try {
    const kept = storage?.getItem(DEVICE_KEY);
    if (kept && /^[0-9a-f]{32}$/.test(kept)) return kept;
    const id = randomHex32();
    if (!storage) throw new Error('no storage');
    storage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    memoryDevice ??= randomHex32();
    return memoryDevice;
  }
}

/** The route codes this browser last found, or null. */
export function savedRoute(storage: KeyStore | null = safeLocalStorage()): string | null {
  try {
    const v = storage?.getItem(ROUTE_KEY)?.trim();
    return v && v.length <= MAX_QUERY_CHARS ? v : null;
  } catch {
    return null;
  }
}

export function saveRoute(codes: string, storage: KeyStore | null = safeLocalStorage()): void {
  try {
    storage?.setItem(ROUTE_KEY, codes);
  } catch {
    // Private mode or blocked storage: the route lasts for this page view only.
  }
}

export function forgetRoute(storage: KeyStore | null = safeLocalStorage()): void {
  try {
    storage?.removeItem(ROUTE_KEY);
  } catch {
    // nothing kept
  }
}

export function salesHeaders(token: string, device: string): Record<string, string> {
  return { Authorization: `SalesLink ${token}`, 'X-Sales-Device': device, Accept: 'application/json' };
}

/** GET /api/s/view, or with the codes typed: GET /api/s/view?route=R1%2C%20R2X. The token is never in it. */
export function viewUrl(route: string | null): string {
  return route ? `/api/s/view?route=${encodeURIComponent(route)}` : '/api/s/view';
}

const LINK_CODES: ReadonlySet<string> = new Set<SalesLinkStateCode>(['LINK_NOT_FOUND', 'LINK_REPLACED', 'LINK_REVOKED', 'LINK_EXPIRED', 'SALES_LINKS_OFF', 'SIGNED_IN_OTHER_TENANT']);
const CODE_ERRORS: ReadonlySet<string> = new Set<SalesQueryErrorCode>(['ROUTE_CODE_MISSING', 'ROUTE_CODE_TOO_LONG', 'TOO_MANY_CODES']);

export type SalesAnswer =
  | { kind: 'ok'; answer: SalesViewAnswer }
  /** The link does not work (404 / 410 / 503 / 403): shown full-page, the page stops asking. */
  | { kind: 'link'; status: number; code: SalesLinkStateCode; date: string | null }
  /** The codes were refused (400): shown on the route form. */
  | { kind: 'badCode'; code: 'ROUTE_CODE_MISSING' | 'ROUTE_CODE_TOO_LONG' | 'TOO_MANY_CODES'; message: string }
  /** 429: wait Retry-After seconds. */
  | { kind: 'busy'; retryAfterSec: number | null }
  /** Anything else; status 0 = no answer (no signal, a timeout). */
  | { kind: 'error'; status: number };

/** How an answer of GET /api/s/view reads (pure: the page and the tests share it). */
export function readSalesAnswer(status: number, body: unknown, retryAfter: string | null): SalesAnswer {
  const b = (body ?? {}) as { data?: unknown; error?: unknown };
  if (status === 200 && b.data && typeof b.data === 'object' && (b.data as { meta?: unknown }).meta) return { kind: 'ok', answer: b.data as SalesViewAnswer };
  const err = (b.error && typeof b.error === 'object' ? b.error : {}) as { code?: unknown; message?: unknown; date?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  const date = typeof err.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(err.date) ? err.date : null;
  if (status === 403 && code === 'SIGNED_IN_OTHER_TENANT') return { kind: 'link', status, code, date: null };
  if (status === 404 || status === 410 || status === 503) {
    // A 404 / 410 / 503 is always about the link (an unknown token answers LINK_NOT_FOUND).
    const known = LINK_CODES.has(code) ? (code as SalesLinkStateCode) : status === 503 ? 'SALES_LINKS_OFF' : 'LINK_NOT_FOUND';
    return { kind: 'link', status, code: known, date };
  }
  if (status === 400 && CODE_ERRORS.has(code)) {
    return { kind: 'badCode', code: code as 'ROUTE_CODE_MISSING' | 'ROUTE_CODE_TOO_LONG' | 'TOO_MANY_CODES', message: typeof err.message === 'string' && err.message ? err.message : 'Check the route code.' };
  }
  if (status === 429) {
    const s = Number(retryAfter);
    return { kind: 'busy', retryAfterSec: Number.isFinite(s) && s > 0 ? Math.ceil(s) : null };
  }
  return { kind: 'error', status };
}

/**
 * A request with a time limit, the answer's body included: AbortController plus a timer (older iPhones have no
 * AbortSignal.timeout), and the timer alone ends it when a fetch ignores the abort.
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

/** GET /api/s/view with the token in the header. A network failure or a timeout answers { kind: 'error', status: 0 }. */
export async function fetchSalesView(token: string, device: string, route: string | null, fetchImpl: typeof fetch = fetch, timeoutMs = VIEW_TIMEOUT_MS): Promise<SalesAnswer> {
  try {
    return await timed(timeoutMs, async (signal) => {
      const res = await fetchImpl(viewUrl(route), { headers: salesHeaders(token, device), cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer', signal });
      const body = await res.json().catch(() => null);
      return readSalesAnswer(res.status, body, res.headers.get('retry-after'));
    });
  } catch {
    return { kind: 'error', status: 0 };
  }
}
