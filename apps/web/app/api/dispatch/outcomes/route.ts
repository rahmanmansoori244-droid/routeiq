import { withTenantApi, ok, parseBody } from '@/lib/api';
import { officeOutcomeSchema, recordOfficeOutcome } from '@/lib/delivery/office-service';

export const dynamic = 'force-dynamic';

// POST /api/dispatch/outcomes - the dispatcher records or corrects a delivery result on the plan
// screen ("Record outcome", owner request 4 Oct 2026, spec sections 8.3 and 10.2): any stop of a load
// that left (DISPATCHED or COMPLETED), at any time, with optional Arrived / Left times; stored as the
// office (source DISPATCHER, the user's id) and audited with before and after. 404 STOP_NOT_FOUND,
// 409 LOAD_NOT_DISPATCHED, 422 INVALID, 409 OUTCOME_CARRIED { copyId, copyDate, undoable } when the
// change would shrink cases already brought forward (with `undoCarry: true` the copy - on no plan
// yet - is removed and the result recorded in one transaction), 409 PLAN_BUSY.
export const POST = withTenantApi(
  async (req, { user, ip }) => {
    const input = await parseBody(req, officeOutcomeSchema);
    return ok(await recordOfficeOutcome(user.tenantId, { id: user.id, name: user.name }, input, { ip }));
  },
  { role: 'PLANNER' },
);
