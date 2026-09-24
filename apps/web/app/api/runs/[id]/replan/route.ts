import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { replan } from '@/lib/dispatch/start-optimize';

interface Params { params: { id: string } }

const schema = z.object({
  reason: z.enum(['LATE_ORDER', 'MANUAL_ADJUSTMENT', 'REOPTIMIZE']).default('REOPTIMIZE'),
  note: z.string().trim().max(500).optional(),
  allowMissingLocations: z.boolean().optional(),
});

// POST /api/runs/:id/replan - create plan version N+1 (locked/loading/dispatched loads are
// kept exactly) and optimize the remaining + new orders.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const input = await parseBody(r, schema);
      const res = await replan(user.tenantId, params.id, input.reason ?? 'REOPTIMIZE', input.note ?? null, user, ip, input.allowMissingLocations);
      if (res.status >= 400) return fail(res.body as Record<string, unknown>, res.status);
      return ok(res.body, res.status);
    },
    { role: 'PLANNER' },
  )(req);
