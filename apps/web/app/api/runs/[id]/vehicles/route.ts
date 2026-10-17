import { withTenantApi, ok, fail } from '@/lib/api';
import { readLiveVehicles, VEHICLES_RATE } from '@/lib/ivms/vehicles';

export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// GET /api/runs/:id/vehicles - the day screen's live trucks (IVMS live link, 16 Oct 2026): the latest GPS
// position of each truck with a load out on this plan, its next stop's live ETA and the GPS facts for
// the office. PLANNER and up (positions of people at work; VIEWER 403). While the company's GPS
// tracking is OFF the answer is mode OFF with no vehicle. Never an IMEI or any provider field. Reads only.
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { user }) => {
      const data = await readLiveVehicles(user.tenantId, params.id);
      if (!data) return fail('Not found', 404);
      return ok(data);
    },
    { role: 'PLANNER', rateLimitKey: 'ivms-vehicles', rateLimitLimit: VEHICLES_RATE.limit, rateLimitWindowMs: VEHICLES_RATE.windowMs },
  )(req);
