import { z } from 'zod';
import { withTenantApi, ok, fail } from '@/lib/api';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { startDispatchOptimize } from '@/lib/dispatch/start-optimize';

interface Params { params: { id: string } }

const schema = z.object({ allowMissingLocations: z.boolean().optional() }).optional();

// POST /api/runs/:id/optimize - NMWC dispatch planner (OR-Tools). Returns 202 + job id; poll
// /api/runs/:id/status. A plan that is already applied is never re-optimized in place
// (409 NEW_VERSION_REQUIRED): use /api/runs/:id/replan so versions stay traceable.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const limit = rateLimit(`optimize:${user.tenantId}`, LIMITS.optimize.limit, LIMITS.optimize.windowMs);
      if (!limit.ok) return fail('Too many optimize requests for this tenant.', 429);
      let body: z.infer<typeof schema>;
      try {
        const t = await r.text();
        body = t ? schema.parse(JSON.parse(t)) : undefined;
      } catch {
        return fail('Invalid JSON body', 400);
      }
      const res = await startDispatchOptimize(user.tenantId, params.id, user, ip, { allowMissingLocations: body?.allowMissingLocations });
      if (res.status >= 400) return fail(res.body as Record<string, unknown>, res.status);
      return ok(res.body, res.status);
    },
    { role: 'PLANNER' },
  )(req);
