import { withTenantApi, ok, HttpError } from '@/lib/api';
import { customerDeliveryStats, MAX_STATS_IDS } from '@/lib/delivery/customer-stats';

export const dynamic = 'force-dynamic';

// GET /api/customers/delivery-stats?ids=a,b,c - the measured unloading time next to the planned one
// for up to 200 customers (owner request 4 Oct 2026, spec section 11.1): the customer dialog on Daily
// dispatch and the Customers page. Readable by every role (it changes nothing; "Use measured time" is
// the ordinary customer edit, PLANNER+).
export const GET = withTenantApi(async (req, { user }) => {
  const raw = new URL(req.url).searchParams.get('ids') ?? '';
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (ids.length > MAX_STATS_IDS) throw new HttpError(`At most ${MAX_STATS_IDS} customers at a time.`, 400, { code: 'TOO_MANY' });
  if (ids.some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new HttpError('Unknown customer id.', 400, { code: 'INVALID_ID' });
  return ok(await customerDeliveryStats(user.tenantId, ids));
});
