import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { prisma } from '@/lib/db';
import { applyScenario, PlanError } from '@/lib/dispatch/plan-service';

interface Params { params: { id: string } }

const bodySchema = z.object({ scenarioId: z.string().min(1) });

// POST /api/runs/:id/choose-scenario - the RECOMMENDED plan is applied automatically after
// optimizing; this lets the dispatcher explicitly switch to an alternative (MIN_TRUCKS /
// MIN_DISTANCE) they have seen. Frozen loads are never touched.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user }) => {
      const { scenarioId } = await parseBody(r, bodySchema);
      const run = await db.runPlan.findUnique({ where: { id: params.id } });
      if (!run) return fail('Not found', 404);
      if (run.status === 'OPTIMIZING') return fail('Wait for the optimization to finish.', 409);
      if (run.status === 'SUPERSEDED') return fail('This plan version was superseded.', 409);
      const frozenNew = await db.planLoad.count({ where: { runId: run.id, status: { not: 'PLANNED' }, carriedFromLoadId: null } });
      if (frozenNew > 0) {
        return fail('Loads of this version are already locked. Unlock them (or re-plan) before switching scenario.', 409);
      }
      try {
        await prisma.$transaction((tx) => applyScenario(tx, user.tenantId, run.id, scenarioId, user.id), { timeout: 60_000, maxWait: 10_000 });
      } catch (e) {
        if (e instanceof PlanError) return fail(e.message, e.status);
        throw e;
      }
      return ok({ runId: run.id, scenarioId });
    },
    { role: 'PLANNER' },
  )(req);
