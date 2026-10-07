import { withTenantApi, ok, parseBody } from '@/lib/api';
import { hiredTruckPatchSchema } from '@/lib/schemas';
import { setHiredTruck } from '@/lib/dispatch/hired-truck';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// PATCH /api/dispatch/hired-trucks/:id { code?, defaultDriverId? } - a one-day hired truck (the hire
// suggestion's "Use this plan"): the dispatcher enters its real plate (the truck code) and may set its
// default driver. PLANNER and above; any other truck, or a day that is over, is refused (403
// NOT_ONE_DAY, 409 DAY_OVER); a code in use answers 409 CODE_TAKEN (an earlier day's hired truck with
// that plate is renamed instead). Audited HIRED_TRUCK_CHANGED.
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const input = await parseBody(r, hiredTruckPatchSchema);
      const after = await setHiredTruck(user.tenantId, params.id, input, user, ip);
      return ok({ id: after.id, code: after.code, defaultDriverId: after.defaultDriverId, onlyOnDate: after.onlyOnDate });
    },
    { role: 'PLANNER' },
  )(req);
