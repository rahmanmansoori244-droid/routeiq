import { withTenantApi, ok, parseBody } from '@/lib/api';
import { driverLeaveSchema } from '@/lib/schemas';
import { addDriverLeave, listDriverLeave } from '@/lib/dispatch/driver-leave-service';

export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

/**
 * Driver leave (owner request 6 Oct 2026; rules in lib/dispatch/driver-leave.ts).
 * GET: the driver's leave periods, the latest first, ended ones included (kept for the record);
 * every role reads them, like the Drivers page.
 */
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { user }) => {
    return ok(await listDriverLeave(user.tenantId, params.id));
  })(req);

/**
 * POST { from, until, note?, coverDriverId? }: a new period for this driver (both dates included).
 * The dispatcher (PLANNER) and up; VIEWER 403. 400 LEAVE_DATES / LEAVE_IN_PAST / LEAVE_COVER_*, 409
 * LEAVE_OVERLAP (one driver's periods never overlap). `warnings`: the cover is on leave himself part
 * of the time, or the driver is still on loads planned on those days. Audited DRIVER_LEAVE_ADDED.
 */
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const input = await parseBody(r, driverLeaveSchema);
      return ok(await addDriverLeave(user.tenantId, params.id, input, user), 201);
    },
    { role: 'PLANNER' },
  )(req);
