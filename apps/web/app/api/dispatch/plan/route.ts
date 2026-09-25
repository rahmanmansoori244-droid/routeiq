import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { isoDateSchema } from '@/lib/schemas';
import { getOrCreatePlan, PlanError } from '@/lib/dispatch/plan-service';
import { startDispatchOptimize } from '@/lib/dispatch/start-optimize';

const schema = z.object({
  date: isoDateSchema,
  depotId: z.string().min(1),
  optimize: z.boolean().optional(),
  allowMissingLocations: z.boolean().optional(),
  allowMissingWeights: z.boolean().optional(),
});

// POST /api/dispatch/plan - get (or create version 1 of) the plan for a depot + date, and
// optionally start optimizing it straight away.
export const POST = withTenantApi(
  async (req, { user, ip }) => {
    const input = await parseBody(req, schema);
    let run;
    try {
      run = (await getOrCreatePlan(user.tenantId, input.depotId, input.date, user.id)).run;
    } catch (e) {
      if (e instanceof PlanError) return fail(e.message, e.status);
      throw e;
    }
    if (!input.optimize) return ok({ runId: run.id, version: run.version, status: run.status });
    const res = await startDispatchOptimize(user.tenantId, run.id, user, ip, {
      allowMissingLocations: input.allowMissingLocations,
      allowMissingWeights: input.allowMissingWeights,
    });
    if (res.status >= 400) return fail({ ...res.body, runId: run.id } as Record<string, unknown>, res.status);
    return ok({ ...res.body, runId: run.id, version: run.version }, res.status);
  },
  { role: 'PLANNER' },
);
