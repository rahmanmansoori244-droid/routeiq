import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { chooseScenario, PlanError, planErrorBody } from '@/lib/dispatch/plan-service';

interface Params { params: { id: string } }

const bodySchema = z.object({ scenarioId: z.string().min(1) });

// POST /api/runs/:id/choose-scenario - the RECOMMENDED plan is applied automatically after
// optimizing; this lets the dispatcher explicitly switch to an alternative (MIN_TRUCKS /
// MIN_DISTANCE) they have seen. Frozen loads are never touched. Every check runs under the plan's
// row lock (chooseScenario): a version superseded or optimizing meanwhile answers 409, and so does
// an option that found no plan (NO_SOLUTION). `driversChanged`: how many trips got another driver
// than they had (the plan lists them as warnings, so a changed driver is never silent).
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const { scenarioId } = await parseBody(r, bodySchema);
      let driversChanged = 0;
      try {
        driversChanged = (await chooseScenario(user.tenantId, params.id, scenarioId, user.id)).driverChanges.length;
      } catch (e) {
        if (e instanceof PlanError) return fail(planErrorBody(e), e.status);
        throw e;
      }
      return ok({ runId: params.id, scenarioId, driversChanged });
    },
    { role: 'PLANNER' },
  )(req);
