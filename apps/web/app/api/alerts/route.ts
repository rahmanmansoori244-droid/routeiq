import { withTenantApi, ok, fail } from '@/lib/api';
import { DEFAULT_TZ, todayIso } from '@/lib/dispatch/time';
import { listAlerts, readAlertListQuery } from '@/lib/alerts/inbox';
import { alertSweepStatus } from '@/lib/alerts/sweep';

export const dynamic = 'force-dynamic';

// GET /api/alerts?from=YYYY-MM-DD&to=YYYY-MM-DD (or date=)&depotId=&state=open|acked|resolved|all&rule= -
// the operations alerts (owner request 16 Oct 2026) of the Alerts page and the day screen's Alerts card:
// today by default, at most 31 days, every state by default; open rows first, HIGH before WARN, at most
// 500 rows (`truncated`). Every role reads them, like the plan. `enabled`: alerts are switched on;
// checkedAt / checkStale / checkFailed: the company's last good sweep (review M2).
export const GET = withTenantApi(
  async (req, { db, user }) => {
    const cfg = await db.tenantConfig.findFirst({ select: { timezone: true, alertsEnabled: true, alertsEnabledAt: true } });
    const today = todayIso(cfg?.timezone ?? DEFAULT_TZ);
    const q = readAlertListQuery(new URL(req.url).searchParams, today);
    if (!q.ok) return fail(q.error, 400);
    const { rows, truncated } = await listAlerts(db, q.query);
    const st = cfg?.alertsEnabled ? alertSweepStatus(user.tenantId, new Date(), cfg.alertsEnabledAt) : null;
    return ok({ enabled: !!cfg?.alertsEnabled, today, ...q.query, rows, truncated, checkedAt: st?.checkedAt ?? null, checkStale: st?.stale ?? false, checkFailed: st?.failed ?? false });
  },
  { rateLimitKey: 'alerts' },
);
