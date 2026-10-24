import { withTenantApi, ok, fail, parseBody } from '@/lib/api';
import { planEditCheckSchema } from '@/lib/schemas';
import { LIMITS } from '@/lib/rate-limit';
import { canApproveOverride } from '@/lib/rbac';
import { checkPlanEdit, planEditMode } from '@/lib/dispatch/plan-edit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// POST /api/runs/:id/edit/check { move } | { ops, skipBreak? }, expect? - moves by hand (PLAN_EDIT=check or on):
// re-times the trucks the change list touches with today's data (the solver's /retime-truck-days) and answers
// the preview (lib/dispatch/plan-edit-view.ts PlanEditPreview: before and after per truck, the rules it breaks
// with what can be allowed by hand, the soft warnings, what changed since planning, previewHash and the
// overrides hash). Writes nothing. Any planner may see what could be allowed by hand; only a SUPERVISOR or
// TENANT_ADMIN may save it (overrides.canSave). 404 FEATURE_OFF with PLAN_EDIT off; 409 LOAD_FROZEN /
// STOP_CHANGED / SUPERSEDED / OPTIMIZING / NOT_APPLIED / DAY_OVER / DAY_MISMATCH / NO_CHANGE /
// PALLET_FACTOR_REQUIRED / PALLET_FACTOR_CHANGED / TOO_MANY_TRUCKS / TOO_MANY_STOPS / NO_EXPLICIT_PLACE ...;
// 422 UNKNOWN_LOAD / UNKNOWN_STOP / ALREADY_REMOVED / BAD_ORDER / POSITION_ONE_STOP / SAME_LOAD / BEST_NOT_LAST;
// 503 SOLVER_OUTDATED / SOLVER_BUSY / SOLVER_FAILED. 30 checks a minute per user.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const mode = planEditMode();
      if (mode === 'OFF') return fail({ error: 'Moving stops by hand is not switched on.', code: 'FEATURE_OFF' }, 404);
      const input = await parseBody(r, planEditCheckSchema);
      const check = await checkPlanEdit(user.tenantId, params.id, { move: input.move, ops: input.ops, skipBreak: input.skipBreak, expect: input.expect, mode, canOverride: canApproveOverride(user.role) });
      return ok(check.preview);
    },
    { role: 'PLANNER', rateLimitKey: 'plan-edit-check', rateLimitLimit: LIMITS.planEditCheck.limit, rateLimitWindowMs: LIMITS.planEditCheck.windowMs },
  )(req);
