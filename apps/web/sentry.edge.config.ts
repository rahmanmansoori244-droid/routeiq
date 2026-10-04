// This file configures Sentry for the EDGE runtime (middleware).
// CLAUDE.md §15: scrub passwords, tokens, emails (sensitive headers).
// When SENTRY_DSN is unset, Sentry.init is a no-op.
// Driver links (owner request 4 Oct 2026): no trace of /d/ or /api/d/, and /d/<token> is rewritten
// to /d/[token] in every event and breadcrumb (lib/observability-scrub.ts).
import * as Sentry from '@sentry/nextjs';
import { sentryScrubOptions } from './lib/observability-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  ...sentryScrubOptions(0.1),
});
