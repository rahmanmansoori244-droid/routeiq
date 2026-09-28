import { z } from 'zod';
import { withTenantApi, ok, fail } from '@/lib/api';
import { resetStuckPlan } from '@/lib/dispatch/stuck-plan';
import { isOptimizing } from '@/lib/jobs/optimize-job';

interface Params { params: { id: string } }

const schema = z.object({ note: z.string().max(500).nullish() }).optional();

/**
 * POST /api/runs/:id/reset-stuck - "Reset stuck plan" (audit F09, owner decision 17: SUPERVISOR
 * and above, recorded as PLAN_RESET in the audit log). A plan version shown as optimizing whose
 * optimization has ended, or was lost when the server restarted, goes back to FAILED so it can be
 * optimized or re-planned again; a lost job is failed "Reset by a supervisor". A re-plan version
 * keeps the copy of the previous plan it holds. 409 when the plan is not stuck (NOT_STUCK), its
 * optimization is still running in this server (JOB_RUNNING) or started less than 2 minutes ago
 * (JOB_STARTING). See lib/dispatch/stuck-plan.ts.
 */
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
      const res = await resetStuckPlan(user.tenantId, params.id, user, ip, { isLive: isOptimizing, note: body?.note ?? null });
      if (res.status !== 200) return fail(res.body, res.status);
      return ok(res.body);
    },
    { role: 'SUPERVISOR' },
  )(req);
