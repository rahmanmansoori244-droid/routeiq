import { z } from 'zod';
import { withTenantApi, ok, parseBody } from '@/lib/api';
import { undoCarry } from '@/lib/dispatch/carry-over';

export const dynamic = 'force-dynamic';

const schema = z.object({ originalOrderId: z.string().min(1).max(64) }).strict();

// POST /api/dispatch/carry-over/undo { originalOrderId } - "Undo bring forward" (owner request 4 Oct
// 2026, spec section 9.4): removes the copy on the later day and the order is open again on its own
// day. Only while no plan version refers to the copy (409 COPY_PLANNED / COPY_ON_ROAD otherwise: a
// planned order cannot be removed in the app yet), not while the copy was itself brought forward again
// (409 COPY_CARRIED_AGAIN: undo that one first), and not while that day's plan is being optimized
// (409 PLAN_BUSY). One transaction under the intake, day and outcome-day locks; audited
// ORDERS_CARRY_UNDONE. PLANNER, like Bring forward.
export const POST = withTenantApi(
  async (req, { user, ip }) => {
    const { originalOrderId } = await parseBody(req, schema);
    return ok(await undoCarry(user.tenantId, originalOrderId, user, { ip }));
  },
  { role: 'PLANNER' },
);
