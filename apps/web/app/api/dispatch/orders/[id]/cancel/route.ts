import { z } from 'zod';
import { withTenantApi, ok, parseBody, HttpError } from '@/lib/api';
import { cancelOrder } from '@/lib/dispatch/order-cancel';
import { CANCEL_REASONS, checkOrderActionReason, ORDER_ACTION_NOTE_MAX } from '@/lib/dispatch/order-cancel-rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

const schema = z
  .object({
    reason: z.enum(CANCEL_REASONS),
    /** Required for OTHER (checkOrderActionReason). */
    note: z.string().max(ORDER_ACTION_NOTE_MAX).nullable().optional(),
  })
  .strict();

// POST /api/dispatch/orders/:id/cancel { reason, note? } - "Cancel order" (owner request 12 Oct 2026):
// one order (every invoice of it) leaves planning, the counts, Bring forward and the data to collect,
// and stays on its day in the "Cancelled" list (Undo: /uncancel). Allowed when it is on no plan, only
// unserved, or on a PLANNED load of the latest plan version of its day (that load is then refused
// Lock / Loading / Dispatch with 409 ORDERS_CANCELLED until the day is re-planned); refused (409) on a
// locked or loading load (ORDER_ON_LOCKED_LOAD: unlock first), after it left (ORDER_LEFT), when it was
// brought forward (ORDER_CARRIED) and while the day is optimized (PLAN_OPTIMIZING). Another company's
// id answers 404. Cancelling it again changes nothing (`already`). One transaction under the intake,
// day and plan row locks (lib/dispatch/order-cancel.ts); audited ORDER_CANCELLED. PLANNER, like Bring
// forward and late orders.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const input = await parseBody(r, schema);
      const reason = checkOrderActionReason('CANCEL', input.reason, input.note);
      if (!reason.ok) throw new HttpError(reason.error, 400, { code: 'REASON_REQUIRED' });
      return ok(await cancelOrder(user.tenantId, params.id, { reason: reason.reason, note: reason.note }, user, { ip }));
    },
    { role: 'PLANNER' },
  )(req);
