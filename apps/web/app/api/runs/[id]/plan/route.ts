import { withTenantApi, ok, fail } from '@/lib/api';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';

interface Params { params: { id: string } }

// GET /api/runs/:id/plan - loads, manifests, delivery sequence, unserved, reconciliation, and the
// locked and loading loads planned with older customer data (`kept`, the plan screen's box).
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { user }) => {
    const d = await getPlanDetail(user.tenantId, params.id, {}, { kept: true });
    if (!d) return fail('Not found', 404);
    return ok(d);
  })(req);
