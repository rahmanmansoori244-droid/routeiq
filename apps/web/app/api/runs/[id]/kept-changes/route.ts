import { withTenantApi, ok, notFoundIfNull } from '@/lib/api';
import { prisma } from '@/lib/db';
import { keptChangesOf } from '@/lib/dispatch/kept-changes-server';

export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// GET /api/runs/:id/kept-changes - the locked and loading loads of this plan version planned with older
// customer data (lib/dispatch/kept-changes.ts): what changed, whether the planned times still keep the
// rules, and the loads to unlock first. Read fresh by the RE-PLAN buttons right before their dialog (a
// READY plan does not poll). Any role, like the plan; another company's version is 404. `data` is null
// when there is nothing to say: KEPT_CHANGES=off, a superseded or optimizing version, one without an
// applied plan, or a day that is over. Reads only.
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { user, db }) => {
    notFoundIfNull(await db.runPlan.findUnique({ where: { id: params.id }, select: { id: true } }));
    return ok(await keptChangesOf(prisma, user.tenantId, params.id));
  })(req);
