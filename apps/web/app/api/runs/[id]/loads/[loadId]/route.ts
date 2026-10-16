import { z } from 'zod';
import { withTenantApi, ok, parseBody, hasRole } from '@/lib/api';
import { updateLoad } from '@/lib/dispatch/plan-service';
import { loadHelperIdsSchema } from '@/lib/schemas';

interface Params { params: { id: string; loadId: string } }

const schema = z
  .object({
    status: z.enum(['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED']).optional(),
    driverId: z.string().min(1).nullable().optional(),
    // The load's helpers in order, 0 to 3 ([] = none): owner request 13 Oct 2026.
    helperIds: loadHelperIdsSchema.optional(),
    // The dispatcher's answer about a driver on leave that day (409 DRIVER_ON_LEAVE otherwise).
    leaveConfirmed: z.boolean().optional(),
  })
  .refine((b) => b.status !== undefined || b.driverId !== undefined || b.helperIds !== undefined, { message: 'Send a status, a driverId or helperIds.' });

// PATCH /api/runs/:id/loads/:loadId { status?, driverId?, helperIds?, leaveConfirmed? } - lock / unlock /
// loading / dispatch / complete, assign the driver (null = none) and the helpers (0-3, [] = none; the
// same states as the driver, audited LOAD_HELPERS_CHANGED: lib/dispatch/load-helpers.ts). Rules live in lib/dispatch/load-state.ts
// (loads go out in order; dispatched is immutable). With both, one transaction: the driver is set
// first (a load being dispatched can still get its driver in the same request), and a refused status
// change leaves the driver unchanged too. Lock, Loading and Dispatch of a load whose driver is on
// leave that day answer 409 DRIVER_ON_LEAVE { driverId, name, day, until } unless `leaveConfirmed`
// (the plan screen asks, then sends it; audited with the status change).
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const { status, driverId, helperIds, leaveConfirmed } = await parseBody(r, schema);
      // A refusal is a PlanError (an HttpError): it answers with its status and code (review L16).
      const load = await updateLoad(user.tenantId, params.id, params.loadId, { status, driverId, helperIds, leaveConfirmed }, user, (role) => hasRole(user.role, role));
      return ok(load);
    },
    { role: 'PLANNER' },
  )(req);
