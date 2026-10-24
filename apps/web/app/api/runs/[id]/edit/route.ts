import { withTenantApi, ok, fail, parseBody } from '@/lib/api';
import { planEditSaveSchema } from '@/lib/schemas';
import { planEditMode } from '@/lib/dispatch/plan-edit';
import { savePlanEdit } from '@/lib/dispatch/plan-edit-apply';
import { EDIT_ERROR_TEXT } from '@/lib/dispatch/plan-edit-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// POST /api/runs/:id/edit { move } | { ops, skipBreak? }, expect?, previewHash, builtAt, overrides? - moves by
// hand (PLAN_EDIT=on): saves a checked change as the next plan version (MANUAL_ADJUSTMENT; only the edited
// trucks' PLANNED loads are made again, every other load stays exactly as it is). `overrides` present (even
// empty): save with the issues allowed by hand (`previewHash` = the overrides hash); every override is checked
// again here (the role, the kinds, the 120 % cap, every needed issue confirmed or carried). 200 { runId,
// version, reprint, gone, trucks, allowed?, carried? }. 404 FEATURE_OFF with PLAN_EDIT off; 409 CHECK_ONLY with
// PLAN_EDIT=check (with overrides too); 409 PREVIEW_OLD / PREVIEW_CHANGED (with the new preview) / MOVE_REFUSED
// / ROADS_DOWN / DAY_CHANGED / SUPERSEDED / PLAN_BUSY / EDIT_CHECK_FAILED / OVERRIDES_OFF / OVERRIDES_CHANGED /
// OVERRIDE_NOT_ALLOWED; 403 OVERRIDE_ROLE (new confirmations below SUPERVISOR); and the check's own refusals.
// Audited ROUTE_MANUALLY_CHANGED, PLAN_VERSION_CREATED and RULE_ALLOWED_BY_HAND.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip, db }) => {
      const mode = planEditMode();
      if (mode === 'OFF') return fail({ error: 'Moving stops by hand is not switched on.', code: 'FEATURE_OFF' }, 404);
      // Another company's plan (or none) is a 404 in every mode, before anything else is said about it.
      if (!(await db.runPlan.findFirst({ where: { id: params.id }, select: { id: true } }))) return fail({ error: 'Plan not found.', code: 'NOT_FOUND' }, 404);
      if (mode === 'CHECK') return fail({ error: EDIT_ERROR_TEXT.CHECK_ONLY, code: 'CHECK_ONLY' }, 409);
      const input = await parseBody(r, planEditSaveSchema);
      const saved = await savePlanEdit(user.tenantId, params.id, input, { id: user.id, name: user.name, role: user.role }, ip);
      return ok(saved);
    },
    { role: 'PLANNER' },
  )(req);
