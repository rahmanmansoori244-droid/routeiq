import { z } from 'zod';
import { withTenantApi, ok, parseBody, HttpError } from '@/lib/api';
import { isoDateSchema } from '@/lib/schemas';
import { postponeOrder } from '@/lib/dispatch/order-cancel';
import { checkOrderActionReason, ORDER_ACTION_NOTE_MAX, POSTPONE_REASONS } from '@/lib/dispatch/order-cancel-rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

const schema = z
  .object({
    /** The day it goes to (YYYY-MM-DD): after the order's day, at most 14 days later, not before today. */
    date: isoDateSchema,
    reason: z.enum(POSTPONE_REASONS),
    /** Required for OTHER (checkOrderActionReason). */
    note: z.string().max(ORDER_ACTION_NOTE_MAX).nullable().optional(),
  })
  .strict();

// POST /api/dispatch/orders/:id/postpone { date, reason, note? } - "Postpone order" (owner request 12
// Oct 2026): the whole order is moved to a later day as Bring forward does it (a copy on that day,
// marked "Carried over from <day>"; the original leaves its day), also for an order of a future day.
// The same load rules as Cancel (409 ORDER_ON_LOCKED_LOAD, ORDER_LEFT, ORDER_CARRIED, PLAN_OPTIMIZING,
// ORDER_CANCELLED); a day outside the range answers 409 POSTPONE_DATE, an order of a day that is over
// 409 ORDER_DAY_OVER (use Bring forward), a deactivated customer 409 CUSTOMER_INACTIVE, an invoice line
// already confirmed for that day 409 ALREADY_ON_DAY. Another company's id answers 404. Undo: Undo bring
// forward (POST /api/dispatch/carry-over/undo) on that day's screen. Audited ORDER_POSTPONED. PLANNER.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const input = await parseBody(r, schema);
      const reason = checkOrderActionReason('POSTPONE', input.reason, input.note);
      if (!reason.ok) throw new HttpError(reason.error, 400, { code: 'REASON_REQUIRED' });
      const res = await postponeOrder(user.tenantId, params.id, { date: input.date, reason: reason.reason, note: reason.note }, user, { ip });
      return ok(res, 201);
    },
    { role: 'PLANNER' },
  )(req);
