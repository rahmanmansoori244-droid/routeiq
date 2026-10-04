import { withTenantApi, ok } from '@/lib/api';
import { pinCheckList } from '@/lib/delivery/customer-stats';

export const dynamic = 'force-dynamic';

// GET /api/customers/pin-check - "Pin may be wrong" (owner request 4 Oct 2026, spec section 11.2):
// customers whose delivery photos (or manual arrivals / results) were more than 150 m from the pin on
// at least 2 of their last 3 visits, or where the driver said "wrong location", with a suggested
// point. Company admin only: the location lock stays (only an admin changes a saved pin, with Set
// location). Reads only; no pin is ever moved automatically.
export const GET = withTenantApi(
  async (_req, { user }) => {
    return ok(await pinCheckList(user.tenantId));
  },
  { role: 'TENANT_ADMIN' },
);
