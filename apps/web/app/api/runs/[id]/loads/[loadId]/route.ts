import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail, hasRole } from '@/lib/api';
import { PlanError, planErrorBody, updateLoad } from '@/lib/dispatch/plan-service';

interface Params { params: { id: string; loadId: string } }

const schema = z
  .object({
    status: z.enum(['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED']).optional(),
    driverId: z.string().min(1).nullable().optional(),
  })
  .refine((b) => b.status !== undefined || b.driverId !== undefined, { message: 'Send a status or a driverId.' });

// PATCH /api/runs/:id/loads/:loadId { status?, driverId? } - lock / unlock / loading / dispatch /
// complete, and assign the driver (null = none). Rules live in lib/dispatch/load-state.ts (loads
// go out in order; dispatched is immutable). With both, one transaction: the driver is set first
// (a load being dispatched can still get its driver in the same request), and a refused status
// change leaves the driver unchanged too.
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const { status, driverId } = await parseBody(r, schema);
      try {
        const load = await updateLoad(user.tenantId, params.id, params.loadId, { status, driverId }, user, (role) => hasRole(user.role, role));
        return ok(load);
      } catch (e) {
        if (e instanceof PlanError) return fail(planErrorBody(e), e.status);
        throw e;
      }
    },
    { role: 'PLANNER' },
  )(req);
