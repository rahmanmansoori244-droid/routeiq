import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { isoDateSchema } from '@/lib/schemas';
import { getOrCreatePlan, PlanError, planErrorBody } from '@/lib/dispatch/plan-service';
import { startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { startResponse } from '@/lib/dispatch/start-response';

const schema = z.object({
  date: isoDateSchema,
  depotId: z.string().min(1),
  optimize: z.boolean().optional(),
  allowMissingLocations: z.boolean().optional(),
  allowMissingWeights: z.boolean().optional(),
  /** The day and depot on the dispatcher's screen: must be the ones asked for (409 DAY_MISMATCH). */
  expect: z.object({ date: isoDateSchema, depotId: z.string().min(1) }).optional(),
});

// POST /api/dispatch/plan - get (or create version 1 of) the plan for a depot + date, and
// optionally start optimizing it straight away. Version 1 is created under the day lock
// (createInitialPlan): concurrent requests for one day get the same plan.
export const POST = withTenantApi(
  async (req, { user, ip }) => {
    const input = await parseBody(req, schema);
    if (input.expect && (input.expect.date !== input.date || input.expect.depotId !== input.depotId)) {
      return fail({ error: 'The date or depot changed on your screen. Reload the day and try again.', code: 'DAY_MISMATCH' }, 409);
    }
    let run;
    try {
      run = (await getOrCreatePlan(user.tenantId, input.depotId, input.date, user.id)).run;
    } catch (e) {
      if (e instanceof PlanError) return fail(planErrorBody(e), e.status);
      throw e;
    }
    if (!input.optimize) return ok({ runId: run.id, version: run.version, status: run.status });
    const res = await startDispatchOptimize(user.tenantId, run.id, user, ip, {
      allowMissingLocations: input.allowMissingLocations,
      allowMissingWeights: input.allowMissingWeights,
    });
    return startResponse(res, { runId: run.id, version: run.version }, { runId: run.id });
  },
  { role: 'PLANNER' },
);
