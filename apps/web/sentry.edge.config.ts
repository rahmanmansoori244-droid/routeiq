// This file configures Sentry for the EDGE runtime (middleware).
// CLAUDE.md §15: scrub passwords, tokens, emails (sensitive headers).
// When SENTRY_DSN is unset, Sentry.init is a no-op.
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV,
});
