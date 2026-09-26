import { z } from 'zod';
import { withTenantApi, fail } from '@/lib/api';
import { startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { startResponse } from '@/lib/dispatch/start-response';

interface Params { params: { id: string } }

const schema = z.object({ allowMissingLocations: z.boolean().optional(), allowMissingWeights: z.boolean().optional() }).optional();

// POST /api/runs/:id/optimize - NMWC dispatch planner (OR-Tools). Returns 202 + job id; poll
// /api/runs/:id/status. A plan that is already applied is never re-optimized in place
// (409 NEW_VERSION_REQUIRED): use /api/runs/:id/replan so versions stay traceable.
// Quotas and the concurrency queue are the shared solve admission (lib/dispatch/solve-admission.ts,
// inside startDispatchOptimize): a refused or no-op request uses no quota.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      let body: z.infer<typeof schema>;
      try {
        const t = await r.text();
        body = t ? schema.parse(JSON.parse(t)) : undefined;
      } catch {
        return fail('Invalid JSON body', 400);
      }
      const res = await startDispatchOptimize(user.tenantId, params.id, user, ip, {
        allowMissingLocations: body?.allowMissingLocations,
        allowMissingWeights: body?.allowMissingWeights,
      });
      return startResponse(res);
    },
    { role: 'PLANNER' },
  )(req);
