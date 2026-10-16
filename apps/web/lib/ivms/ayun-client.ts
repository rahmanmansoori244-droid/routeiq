/**
 * IVMS live link (16 Oct 2026): the ONLY code that calls Ayun (a GPS-Server.net tracking platform, user
 * API 1.x: GET <AYUN_BASE_URL>/api/api.php?api=user&key=<KEY>&cmd=<COMMAND>,<p1>,...). Server only (the
 * key's module lib/ivms/env.ts is never imported by a 'use client' file: tests/lib/ivms-contract.spec.ts).
 * In the style of lib/solver-client.ts and lib/health.ts.
 *
 * - Never throws: every call answers { ok: true, data } or { ok: false, kind } (types.ts AYUN_ERROR_KINDS).
 * - One deadline (8 s) for the whole answer, body included; the body is read in a stream and cut at a cap
 *   (TOO_LARGE), so a stalled or endless answer never holds a poll.
 * - The host is fixed: the origin comes only from AYUN_BASE_URL (https), the path is fixed, redirects are
 *   never followed (REDIRECT), and the command comes from a fixed allow-list (types.ts AYUN_COMMANDS) with
 *   parameters that are digits only (IMEIs, times, minutes) or the literal `*`. Nothing from a request, a
 *   webhook or the database can shape the URL, so the call cannot be pointed anywhere else (SSRF-safe).
 * - The key travels in the query string (the provider's API has no other way), so the URL is never logged,
 *   never put in an error, a result or a thrown message, and this module logs nothing at all. Sentry's own
 *   fetch breadcrumbs and spans are scrubbed (lib/observability-scrub.ts: `key=` of any api.php address).
 * - The provider answers its errors as plain text "ERROR: ..." with HTTP 200, so the text is classified
 *   before any JSON parse: AUTH (wrong key, no API access), LIMIT (daily allowance used up),
 *   NO_PERMISSION (an IMEI the key may not see), PROVIDER_ERROR (anything else). An empty body is EMPTY.
 */
import { AYUN_API_PATH, ivmsApiReady, type IvmsEnv } from './env';
import { formatProviderTime, isImei } from './parse';
import { AYUN_COMMANDS, type AyunErrorKind, type AyunResult } from './types';

/** The deadline for one call, headers and body together. */
export const AYUN_TIMEOUT_MS = 8_000;
/** The largest answer read (bytes); a history answer may be larger (a day of points). */
export const AYUN_MAX_BYTES = 2 * 1024 * 1024;
export const AYUN_ROUTE_MAX_BYTES = 6 * 1024 * 1024;
/** At most this many IMEIs in one OBJECT_GET_LOCATIONS (a larger fleet asks for `*`). */
export const AYUN_MAX_IMEIS_PER_CALL = 100;
/** The provider's documented minimum-stop values for OBJECT_GET_ROUTE (minutes). */
export const ROUTE_MIN_STOP_VALUES = [1, 2, 5, 10, 20, 30, 60, 120, 300] as const;
/** History windows longer than this are refused (a truck-day is at most one day). */
export const ROUTE_MAX_WINDOW_MS = 26 * 3600_000;

/** What RouteIQ may ask the provider: the allow-list, with typed parameters. */
export type AyunRequest =
  | { cmd: 'OBJECT_GET_LOCATIONS'; imeis: readonly string[] | '*' }
  | { cmd: 'OBJECT_GET_ROUTE'; imei: string; from: Date; to: Date; minStopMin: (typeof ROUTE_MIN_STOP_VALUES)[number] }
  | { cmd: 'OBJECT_GET_LAST_EVENTS' }
  | { cmd: 'USER_GET_OBJECTS' }
  | { cmd: 'USER_GET_ZONES' };

/**
 * The `cmd` parameter for a request, or null when the request is refused (it is then never sent): an IMEI
 * that is not 10-20 digits, an empty or too long list, a history window that is empty, reversed or longer
 * than a day, a minimum stop the provider does not document.
 */
export function ayunCommandText(req: AyunRequest, apiTimeOffsetMin = 0): string | null {
  if (!(req.cmd in AYUN_COMMANDS)) return null;
  switch (req.cmd) {
    case 'OBJECT_GET_LOCATIONS': {
      if (req.imeis === '*') return 'OBJECT_GET_LOCATIONS,*';
      const imeis = [...new Set(req.imeis)].sort();
      if (!imeis.length || imeis.length > AYUN_MAX_IMEIS_PER_CALL || !imeis.every(isImei)) return null;
      return `OBJECT_GET_LOCATIONS,${imeis.join(';')}`;
    }
    case 'OBJECT_GET_ROUTE': {
      const span = req.to.getTime() - req.from.getTime();
      if (!isImei(req.imei) || !Number.isFinite(span) || span <= 0 || span > ROUTE_MAX_WINDOW_MS) return null;
      if (!(ROUTE_MIN_STOP_VALUES as readonly number[]).includes(req.minStopMin)) return null;
      return `OBJECT_GET_ROUTE,${req.imei},${formatProviderTime(req.from, apiTimeOffsetMin)},${formatProviderTime(req.to, apiTimeOffsetMin)},${req.minStopMin}`;
    }
    case 'OBJECT_GET_LAST_EVENTS':
    case 'USER_GET_OBJECTS':
    case 'USER_GET_ZONES':
      return req.cmd;
    default:
      return null;
  }
}

/**
 * The address of one call. Module-private on purpose: it holds the key, and only `fetch` ever sees it.
 * new URL with the fixed path, so the origin is the only part that comes from configuration.
 */
function ayunUrl(origin: string, key: string, cmd: string): string {
  const u = new URL(AYUN_API_PATH, origin);
  u.searchParams.set('api', 'user');
  u.searchParams.set('key', key);
  u.searchParams.set('cmd', cmd);
  return u.toString();
}

/**
 * The provider's plain-text error, classified by its words (the messages of the vendor's code: "wrong
 * API key", "API call limit exceeded", "no permission to access this IMEI", "missing command
 * parameters", "unknown command", ...). The text itself is never kept.
 */
export function classifyAyunError(text: string): AyunErrorKind {
  const t = text.toLowerCase();
  if (/limit (is )?(exceeded|reached)|call limit/.test(t)) return 'LIMIT';
  if (/wrong api key|invalid api key|api key (is )?not valid|no api access|api access (is )?(disabled|denied)|not allowed to use api|user (is )?(not active|blocked|expired)/.test(t)) return 'AUTH';
  if (/no permission/.test(t)) return 'NO_PERMISSION';
  return 'PROVIDER_ERROR';
}

/** A body read in full: the provider's text answer classified, or its JSON. Pure. */
export function classifyAyunBody(text: string): AyunResult<unknown> {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return { ok: false, kind: 'EMPTY' };
  if (/^error\s*:/i.test(t)) return { ok: false, kind: classifyAyunError(t) };
  // An HTML page (a proxy's error page, a login page) is not an answer.
  if (t.startsWith('<')) return { ok: false, kind: 'PARSE' };
  try {
    const data: unknown = JSON.parse(t);
    if (data === null || typeof data !== 'object') return { ok: false, kind: 'PARSE' };
    return { ok: true, data };
  } catch {
    return { ok: false, kind: 'PARSE' };
  }
}

export interface AyunCallOptions {
  /** Tests: a fake provider. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Aborts the call (the shutdown handler): answered as TIMEOUT. */
  signal?: AbortSignal;
}

/** Reads the body up to `max` bytes; null = too large (the stream is cancelled). Throws on an abort. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}

/**
 * One call to Ayun. Refused before anything is sent (NOT_CONFIGURED, DISABLED, PROVIDER_ERROR for a
 * request outside the allow-list) or answered as above. Counting the call against the daily allowance is
 * the caller's job, BEFORE it calls (lib/ivms/state.ts): the provider counts failed calls too.
 */
export async function callAyun(env: IvmsEnv, req: AyunRequest, opts: AyunCallOptions = {}): Promise<AyunResult<unknown>> {
  if (env.disabled) return { ok: false, kind: 'DISABLED' };
  if (!ivmsApiReady(env) || !env.origin || !env.apiKey) return { ok: false, kind: 'NOT_CONFIGURED' };
  const cmd = ayunCommandText(req, env.apiTimeOffsetMin);
  if (!cmd) return { ok: false, kind: 'PROVIDER_ERROR' };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const max = opts.maxBytes ?? (req.cmd === 'OBJECT_GET_ROUTE' ? AYUN_ROUTE_MAX_BYTES : AYUN_MAX_BYTES);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? AYUN_TIMEOUT_MS);
  const onOuterAbort = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  else opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  // The deadline holds even against a fetch (or a body) that ignores its signal.
  const aborted = new Promise<never>((_, reject) => {
    if (ctrl.signal.aborted) reject(new Error('aborted'));
    else ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  aborted.catch(() => undefined);
  try {
    const res = await Promise.race([
      fetchImpl(ayunUrl(env.origin, env.apiKey, cmd), {
        method: 'GET',
        headers: { Accept: 'application/json, text/plain' },
        redirect: 'manual',
        cache: 'no-store',
        signal: ctrl.signal,
      }),
      aborted,
    ]);
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, kind: 'REDIRECT', status: res.status || undefined };
    }
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, kind: 'HTTP_ERROR', status: res.status };
    }
    const text = await Promise.race([readCapped(res, max), aborted]);
    if (text === null) return { ok: false, kind: 'TOO_LARGE' };
    return classifyAyunBody(text);
  } catch {
    // Never the error itself: a fetch error may name the address, and the address holds the key.
    return { ok: false, kind: timedOut || ctrl.signal.aborted ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}
