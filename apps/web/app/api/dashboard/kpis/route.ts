import { withTenantApi, ok } from '@/lib/api';
import { getDashboardData } from '@/lib/dashboard';

export const dynamic = 'force-dynamic';

export const GET = withTenantApi(async (_req, { user }) => {
  const data = await getDashboardData(user.tenantId);
  return ok(data);
});
