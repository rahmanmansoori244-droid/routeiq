import { withTenantApi, ok } from '@/lib/api';
import { getDayOverview } from '@/lib/dispatch/day-overview';

// GET /api/dispatch/day?date=YYYY-MM-DD&depotId=... - orders, issues to resolve, plan state.
export const GET = withTenantApi(async (req, { user }) => {
  const url = new URL(req.url);
  const data = await getDayOverview(user.tenantId, { date: url.searchParams.get('date'), depotId: url.searchParams.get('depotId') });
  return ok(data);
});
