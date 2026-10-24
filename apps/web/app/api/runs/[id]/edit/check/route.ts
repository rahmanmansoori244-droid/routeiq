import { withTenantApi, ok, fail, parseBody } from '@/lib/api';
import { planEditCheckSchema } from '@/lib/schemas';
import { LIMITS } from '@/lib/rate-limit';
import { checkPlanEdit, planEditMode } from '@/lib/dispatch/plan-edit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// POST /api/runs/:id/edit/check { move, expect? } - moves by hand (PLAN_EDIT=check or on): re-times the
// trucks the change touches with today's data (the solver's /retime-truck-days) and answers the preview
// (lib/dispatch/plan-edit-view.ts PlanEditPreview: before and after per truck, the rules it breaks, the
// soft warnings, what changed since planning, previewHash). Writes nothing. 404 FEATURE_OFF with
// PLAN_EDIT off; 409 LOAD_FROZEN / STOP_CHANGED / SUPERSEDED / OPTIMIZING / NOT_APPLIED / DAY_OVER /
// DAY_MISMATCH / NO_CHANGE ...; 503 SOLVER_OUTDATED / SOLVER_BUSY / SOLVER_FAILED. 30 checks a minute per user.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const mode = planEditMode();
      if (mode === 'OFF') return fail({ error: 'Moving stops by hand is not switched on.', code: 'FEATURE_OFF' }, 404);
      const input = await parseBody(r, planEditCheckSchema);
      const check = await checkPlanEdit(user.tenantId, params.id, { move: input.move, expect: input.expect, mode });
      return ok(check.preview);
    },
    { role: 'PLANNER', rateLimitKey: 'plan-edit-check', rateLimitLimit: LIMITS.planEditCheck.limit, rateLimitWindowMs: LIMITS.planEditCheck.windowMs },
  )(req);
