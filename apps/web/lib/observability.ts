/**
 * Tiny error-reporting shim. In production, set `SENTRY_DSN` and install
 * `@sentry/nextjs`; the runtime stub below imports lazily so the package is
 * optional in dev.
 *
 * Usage:
 *   import { captureError } from '@/lib/observability';
 *   try { ... } catch (err) { captureError(err, { route: '...' }); }
 *
 * The harness intentionally never throws — observability code MUST NOT crash
 * the request path.
 */
type Extra = Record<string, unknown> | undefined;

let sentry: {
  captureException: (err: unknown, ctx?: Extra) => void;
} | null = null;
let initialized = false;

async function initLazy(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    // Optional dep — only resolved when DSN is set AND package is installed.
    // Dynamic specifier prevents TS from trying to resolve the type at build time.
    const spec = '@sentry/nextjs';
    const mod: any = await import(/* webpackIgnore: true */ spec).catch(() => null);
    if (!mod) return;
    mod.init({
      dsn,
      tracesSampleRate: 0.1,
      environment: process.env.NODE_ENV,
      // Scrub passwords/tokens/credentials before they leave the box.
      beforeSend(event: { request?: { headers?: Record<string, string>; data?: unknown } }) {
        if (event.request?.headers) {
          for (const k of ['authorization', 'cookie', 'x-solver-token', 'x-janitor-token']) {
            if (event.request.headers[k]) event.request.headers[k] = '[redacted]';
          }
        }
        return event;
      },
    });
    sentry = mod;
  } catch {
    // Package missing or DSN invalid — silently fall back to console.
  }
}

export function captureError(err: unknown, extra?: Extra): void {
  console.error('[error]', err, extra ?? {});
  void initLazy().then(() => {
    try {
      sentry?.captureException(err, extra ? { extra } : undefined);
    } catch {
      // never throw from observability
    }
  });
}

export function captureMessage(message: string, extra?: Extra): void {
  console.warn('[message]', message, extra ?? {});
  void initLazy();
}
