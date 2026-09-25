import { z } from 'zod';
import { withTenantApi, parseBody } from '@/lib/api';
import { isoDateSchema } from '@/lib/schemas';
import { replan } from '@/lib/dispatch/start-optimize';
import { startResponse } from '@/lib/dispatch/start-response';

interface Params { params: { id: string } }

const schema = z.object({
  reason: z.enum(['LATE_ORDER', 'MANUAL_ADJUSTMENT', 'REOPTIMIZE']).default('REOPTIMIZE'),
  note: z.string().trim().max(500).optional(),
  allowMissingLocations: z.boolean().optional(),
  allowMissingWeights: z.boolean().optional(),
  /** The day and depot on the dispatcher's screen: a plan of another day answers 409 DAY_MISMATCH. */
  expect: z.object({ date: isoDateSchema, depotId: z.string().min(1) }).optional(),
});

// POST /api/runs/:id/replan - create plan version N+1 (a usable copy of this plan: locked,
// loading and dispatched loads are kept exactly) and optimize the remaining + new orders.
// Refused before any version is created: nothing to plan (409 NOTHING_TO_PLAN), no truck (400),
// missing locations / weights (409), a job running (409), solve quota or queue (429 / 503).
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const input = await parseBody(r, schema);
      const res = await replan(
        user.tenantId,
        params.id,
        input.reason ?? 'REOPTIMIZE',
        input.note ?? null,
        user,
        ip,
        { allowMissingLocations: input.allowMissingLocations, allowMissingWeights: input.allowMissingWeights },
        input.expect,
      );
      return startResponse(res);
    },
    { role: 'PLANNER' },
  )(req);
