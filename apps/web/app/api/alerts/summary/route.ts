import { withTenantApi, ok } from '@/lib/api';
import { alertSummary, DISABLED_SUMMARY } from '@/lib/alerts/inbox';
import { alertSweepStatus } from '@/lib/alerts/sweep';

export const dynamic = 'force-dynamic';

// GET /api/alerts/summary - the bell (owner request 16 Oct 2026): { enabled, today, open, high, latest[10],
// emailCapReached, checkedAt, checkStale, checkFailed }. Open = not resolved and not acknowledged, of today
// and tomorrow (owner request 19 Oct 2026: yesterday's no longer; `today` is the company's, so the bell
// shows the day of a row that is not today's); the newest HIGH first. "Checked": the company's last good
// sweep in this server process (review M2). Every role. Alerts switched off: { enabled: false } and zeros,
// without reading any alert (the layout does not even show the bell then).
export const GET = withTenantApi(
  async (_req, { db, user }) => {
    const cfg = await db.tenantConfig.findFirst({ select: { alertsEnabled: true, alertsEnabledAt: true, timezone: true, alertEmails: true, alertEmailEveryMin: true } });
    if (!cfg) return ok(DISABLED_SUMMARY);
    const now = new Date();
    const st = alertSweepStatus(user.tenantId, now, cfg.alertsEnabledAt);
    return ok(await alertSummary(db, user.tenantId, cfg, now, { checkedAt: st.checkedAt, checkStale: st.stale, checkFailed: st.failed }));
  },
  { rateLimitKey: 'alerts' },
);
