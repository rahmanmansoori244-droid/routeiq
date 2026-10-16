import { withTenantApi, ok } from '@/lib/api';
import { alertSummary, DISABLED_SUMMARY } from '@/lib/alerts/inbox';

export const dynamic = 'force-dynamic';

// GET /api/alerts/summary - the bell (owner request 16 Oct 2026): { enabled, open, high, latest[10],
// emailCapReached }. Open = not resolved and not acknowledged, of yesterday, today and tomorrow; the
// newest HIGH first. Every role. Alerts switched off: { enabled: false } and zeros, without reading any
// alert (the layout does not even show the bell then).
export const GET = withTenantApi(
  async (_req, { db, user }) => {
    const cfg = await db.tenantConfig.findFirst({ select: { alertsEnabled: true, timezone: true, alertEmails: true, alertEmailEveryMin: true } });
    if (!cfg) return ok(DISABLED_SUMMARY);
    return ok(await alertSummary(db, user.tenantId, cfg, new Date()));
  },
  { rateLimitKey: 'alerts' },
);
