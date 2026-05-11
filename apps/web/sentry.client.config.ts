// This file configures Sentry for the BROWSER bundle.
// CLAUDE.md §15: scrub passwords, tokens, emails (sensitive headers).
// When SENTRY_DSN is unset, Sentry.init is a no-op.
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
  beforeSend(event) {
    if (event.request?.headers) {
      for (const k of ['authorization', 'cookie', 'x-solver-token', 'x-janitor-token']) {
        if (event.request.headers[k]) event.request.headers[k] = '[redacted]';
      }
    }
    return event;
  },
});
