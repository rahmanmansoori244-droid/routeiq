import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail, hasRole } from '@/lib/api';
import { changeLoadStatus, PlanError, setLoadDriver } from '@/lib/dispatch/plan-service';

interface Params { params: { id: string; loadId: string } }

const schema = z
  .object({
    status: z.enum(['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED']).optional(),
    driverId: z.string().min(1).nullable().optional(),
  })
  .refine((b) => b.status !== undefined || b.driverId !== undefined, { message: 'Send a status or a driverId.' });

// PATCH /api/runs/:id/loads/:loadId { status?, driverId? } - lock / unlock / loading / dispatch /
// complete, and assign the driver (null = none). Rules live in lib/dispatch/load-state.ts (loads
// go out in order; dispatched is immutable). With both, the driver is set first: a load being
// dispatched can still get its driver in the same request.
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const { status, driverId } = await parseBody(r, schema);
      try {
        let load: unknown = null;
        if (driverId !== undefined) load = await setLoadDriver(user.tenantId, params.id, params.loadId, driverId, user);
        if (status) load = await changeLoadStatus(user.tenantId, params.id, params.loadId, status, user, (role) => hasRole(user.role, role));
        return ok(load);
      } catch (e) {
        if (e instanceof PlanError) return fail(e.message, e.status);
        throw e;
      }
    },
    { role: 'PLANNER' },
  )(req);
