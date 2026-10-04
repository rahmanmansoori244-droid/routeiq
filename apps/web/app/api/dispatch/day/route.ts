import { withTenantApi, ok } from '@/lib/api';
import { getDayOverview } from '@/lib/dispatch/day-overview';

// GET /api/dispatch/day?date=YYYY-MM-DD&depotId=...[&deliveries=1] - orders, issues to resolve, plan
// state. deliveries=1 (a load after a recorded result): the delivery results even while a search runs.
export const GET = withTenantApi(async (req, { user }) => {
  const url = new URL(req.url);
  const data = await getDayOverview(user.tenantId, { date: url.searchParams.get('date'), depotId: url.searchParams.get('depotId'), deliveries: url.searchParams.get('deliveries') === '1' });
  return ok(data);
});
