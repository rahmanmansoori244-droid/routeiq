/**
 * Example Sentry config files for production. Drop-in pattern:
 *
 * 1. `pnpm add @sentry/nextjs`
 * 2. Copy this file's contents into THREE files at apps/web/ root:
 *    - sentry.client.config.ts   (browser bundle)
 *    - sentry.server.config.ts   (Node runtime)
 *    - sentry.edge.config.ts     (edge runtime — used by middleware)
 *    Each calls `Sentry.init(...)` with the same config.
 * 3. Wrap next.config.js with `withSentryConfig` (the Sentry CLI scaffolds this).
 * 4. Set `SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT` env vars on Railway.
 *
 * The lib/observability.ts shim lazy-loads @sentry/nextjs at runtime, so
 * removing this file and reverting to the shim is also valid for v1.
 */

// import * as Sentry from '@sentry/nextjs';
//
// Sentry.init({
//   dsn: process.env.SENTRY_DSN,
//   tracesSampleRate: 0.1,
//   environment: process.env.NODE_ENV,
//   beforeSend(event) {
//     if (event.request?.headers) {
//       for (const k of ['authorization', 'cookie', 'x-solver-token', 'x-janitor-token']) {
//         if (event.request.headers[k]) event.request.headers[k] = '[redacted]';
//       }
//     }
//     return event;
//   },
// });

export {};
