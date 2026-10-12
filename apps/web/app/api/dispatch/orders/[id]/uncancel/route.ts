import { withTenantApi, ok } from '@/lib/api';
import { undoCancelOrder } from '@/lib/dispatch/order-cancel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// POST /api/dispatch/orders/:id/uncancel - "Undo" in the day's Cancelled list (owner request 12 Oct
// 2026): the order is open again while its day is not over (409 DAY_OVER otherwise); the next OPTIMIZE
// or RE-PLAN plans it. Refused when one of its invoice lines was entered again on another day (409
// SAME_LINE_ELSEWHERE) and for an order that is not cancelled (409 NOT_CANCELLED). Another company's id
// answers 404. No body. Audited ORDER_CANCEL_UNDONE. PLANNER, like Cancel.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { user, ip }) => {
      return ok(await undoCancelOrder(user.tenantId, params.id, user, { ip }));
    },
    { role: 'PLANNER' },
  )(req);
