/**
 * Keeps driver-link tokens out of Sentry (owner request 4 Oct 2026, spec section 16.1). The QR
 * landing page has the token in its path (/d/<token>); the driver API takes it in the
 * Authorization header. All four Sentry inits (sentry.client/server/edge.config.ts and
 * lib/observability.ts) use these hooks:
 * - tracesSampler: 0 for /d/... and /api/d/... (no transaction, no fetch span), the configured rate
 *   otherwise;
 * - beforeSend / beforeSendTransaction / beforeBreadcrumb: /d/<anything> becomes /d/[token] in URLs,
 *   transaction names and breadcrumbs, and the Authorization header (and the other credentials) are
 *   dropped.
 * Pure and browser-safe (no lookbehind in the patterns: older iOS Safari would fail to parse them).
 */

/** /d/<token> -> /d/[token]; /api/d/... is left alone (those paths carry no token). */
export function scrubDriverToken(text: string): string {
  if (typeof text !== 'string' || !text.includes('/d/')) return text;
  return text.replace(/(\/api)?\/d\/([A-Za-z0-9_-]+)/g, (m: string, api: string | undefined) => (api ? m : '/d/[token]'));
}

/** The path of a URL, a "GET /d/x" transaction name or a bare path. */
function pathOf(s: string): string {
  let t = s.trim().replace(/^[A-Z]+\s+/, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    try {
      t = new URL(t).pathname;
    } catch {
      return '';
    }
  }
  return t.split(/[?#]/)[0] ?? '';
}

/** A driver page or driver API path: /d, /d/..., /api/d, /api/d/... */
export function isDriverPath(s: string | null | undefined): boolean {
  if (!s) return false;
  return /^\/(api\/)?d(\/|$)/.test(pathOf(s));
}

type Ctx = Record<string, unknown> & {
  name?: unknown;
  transactionContext?: { name?: unknown };
  request?: { url?: unknown };
  normalizedRequest?: { url?: unknown };
  attributes?: Record<string, unknown>;
  location?: { pathname?: unknown; href?: unknown };
};

/**
 * Sentry's tracesSampler: 0 for the driver page and the driver API, `rate` for everything else.
 * In a browser the page's own path counts too (a fetch from the driver page is never traced).
 */
export function driverTracesSampler(rate: number) {
  return (raw?: unknown): number => {
    const ctx = (raw && typeof raw === 'object' ? raw : {}) as Ctx;
    const attrs = ctx.attributes ?? {};
    const candidates = [
      ctx.name,
      ctx.transactionContext?.name,
      ctx.request?.url,
      ctx.normalizedRequest?.url,
      attrs['http.target'],
      attrs['url.path'],
      attrs['http.url'],
      attrs['url.full'],
      ctx.location?.pathname,
      (globalThis as { location?: { pathname?: string } }).location?.pathname,
    ];
    return candidates.some((c) => typeof c === 'string' && isDriverPath(c)) ? 0 : rate;
  };
}

const SECRET_HEADERS = ['authorization', 'cookie', 'x-solver-token', 'x-janitor-token'];

function scrubHeaders(headers: unknown): void {
  if (!headers || typeof headers !== 'object') return;
  const h = headers as Record<string, unknown>;
  for (const k of Object.keys(h)) {
    const lower = k.toLowerCase();
    if (lower === 'authorization') delete h[k];
    else if (SECRET_HEADERS.includes(lower)) h[k] = '[redacted]';
    else if (typeof h[k] === 'string') h[k] = scrubDriverToken(h[k] as string);
  }
}

/** Every string of a value with /d/<token> rewritten (in place for objects and arrays). */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubDriverToken(value);
  if (!value || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubDeep(value[i], depth + 1);
    return value;
  }
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o)) o[k] = scrubDeep(o[k], depth + 1);
  return o;
}

type SentryEventLike = Record<string, unknown> & { request?: Record<string, unknown> & { headers?: unknown } };

/** beforeSend / beforeSendTransaction: no driver token, no Authorization header, no credentials. */
export function scrubSentryEvent<E>(event: E): E {
  if (!event || typeof event !== 'object') return event;
  const e = event as unknown as SentryEventLike;
  if (e.request) scrubHeaders(e.request.headers);
  scrubDeep(e);
  return event;
}

/** beforeBreadcrumb: navigation and fetch breadcrumbs keep the path, never the token. */
export function scrubBreadcrumb<B>(breadcrumb: B): B {
  if (!breadcrumb || typeof breadcrumb !== 'object') return breadcrumb;
  scrubDeep(breadcrumb);
  return breadcrumb;
}

/** The hooks every Sentry init uses (with its own trace sample rate). */
export function sentryScrubOptions(rate: number) {
  return {
    tracesSampler: driverTracesSampler(rate),
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
