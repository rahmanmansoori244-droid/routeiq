import { withTenantApi, ok, parseBody } from '@/lib/api';
import { driverLeaveSchema } from '@/lib/schemas';
import { changeDriverLeave, removeDriverLeave } from '@/lib/dispatch/driver-leave-service';

export const dynamic = 'force-dynamic';

interface Params { params: { id: string; leaveId: string } }

/**
 * PATCH { from, until, note?, coverDriverId? }: change one leave period of this driver (the whole
 * period is sent). An ended period is kept as it is (409 LEAVE_ENDED); one that has started keeps its
 * first day (409 LEAVE_STARTED) and can end early down to yesterday. PLANNER and up. Audited
 * DRIVER_LEAVE_CHANGED with the period before and after.
 */
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const input = await parseBody(r, driverLeaveSchema);
      return ok(await changeDriverLeave(user.tenantId, params.id, params.leaveId, input, user));
    },
    { role: 'PLANNER' },
  )(req);

/**
 * DELETE: remove a period that has not started yet (today included). One that has started or ended
 * is kept for the record (409 LEAVE_STARTED / LEAVE_ENDED: end it early instead). PLANNER and up.
 * Audited DRIVER_LEAVE_REMOVED with the period removed.
 */
export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { user }) => {
      return ok(await removeDriverLeave(user.tenantId, params.id, params.leaveId, user));
    },
    { role: 'PLANNER' },
  )(req);
