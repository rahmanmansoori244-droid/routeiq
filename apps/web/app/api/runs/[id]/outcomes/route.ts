import { withTenantApi, ok, fail } from '@/lib/api';
import { readOutcomeOverlay } from '@/lib/delivery/outcome-view';

export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// GET /api/runs/:id/outcomes - the delivery results of this plan version's loads that left
// (DISPATCHED / COMPLETED), read by the plan screen with the plan (owner request 4 Oct 2026, spec
// section 10.1): progress per load, per stop the result, arrival, departure, unloading minutes,
// photos (metadata only), the no-result list, and the brought-forward copies whose original result
// changed after the carry. Readable by every role, like the plan. Reads only.
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { user }) => {
    const overlay = await readOutcomeOverlay(user.tenantId, params.id);
    if (!overlay) return fail('Not found', 404);
    return ok(overlay);
  })(req);
