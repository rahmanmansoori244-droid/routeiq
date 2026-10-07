import { withTenantApi, ok, parseBody } from '@/lib/api';
import { casualDriverSchema } from '@/lib/schemas';
import { addCasualDriver } from '@/lib/dispatch/casual-driver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/dispatch/casual-driver { runId, loadId, name, phone?, useExisting?, leaveConfirmed? } - add
// a daily (casual) driver from a load and put them on it, in one transaction (owner rule 20: a load
// never leaves without a driver). 409 PHONE_BELONGS_TO { driverId, name, leaveUntil? } when the phone
// is another driver's (the dialog asks "Use <name>?" and posts again with useExisting); 409
// DRIVER_ON_LEAVE { driverId, name, until }: the driver used again is on leave that day (the dialog
// asks, then posts again with leaveConfirmed); 409 CODE_TAKEN: try again; 409 DRIVER_INACTIVE:
// useExisting names a regular driver switched off (only a daily driver is reactivated here). PLANNER,
// like the Driver list. Audited CASUAL_DRIVER_ADDED + LOAD_DRIVER_SET.
// A truck rented for the day: also on its other planned loads (LOAD_DRIVER_SET each) and as its default
// driver (HIRED_TRUCK_CHANGED) - one day-rate driver for the whole day; `alsoOn` lists those loads.
export const POST = withTenantApi(
  async (req, { user }) => {
    const input = await parseBody(req, casualDriverSchema);
    const result = await addCasualDriver(
      user.tenantId,
      { runId: input.runId, loadId: input.loadId, name: input.name, phone: input.phone ?? null, useExisting: input.useExisting, leaveConfirmed: input.leaveConfirmed },
      user,
    );
    return ok(result, result.reused ? 200 : 201);
  },
  { role: 'PLANNER' },
);
