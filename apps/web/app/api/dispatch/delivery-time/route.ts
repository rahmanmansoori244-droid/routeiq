import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { audit } from '@/lib/audit';
import { currentPlan } from '@/lib/dispatch/plan-service';
import { checkOrderTime, orderTimeOf, promisedText, type OrderTime } from '@/lib/dispatch/order-window';
import { fmtDayMonth, isoOf } from '@/lib/dispatch/time';

const schema = z.object({
  orderId: z.string().min(1),
  startMin: z.number().int().nullable().optional(),
  endMin: z.number().int().nullable().optional(),
  reason: z.string().max(32).optional(),
  note: z.string().max(500).nullable().optional(),
  /** true = remove the order's own delivery time (the customer's receiving hours apply again). */
  clear: z.boolean().optional(),
});

const asJson = (t: OrderTime | null) => (t ? { startMin: t.startMin, endMin: t.endMin, reason: t.reason, note: t.note } : null);

// PUT /api/dispatch/delivery-time - a delivery time for ONE order (owner decision 1 Oct 2026, item 1):
// an urgent delivery or a time promised to the customer, with a reason (Urgent / Promised to customer /
// Other + note). It does not change the customer master; the next optimize / RE-PLAN plans the
// order's stop with it, and the plan, Excel, driver PDF and WhatsApp show "Promised 10:00–11:00".
// { clear: true } removes it. Refused for an order on a locked (or later) load of the plan in use -
// frozen loads never change - and for an order brought forward to a later day. Audited.
export const PUT = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, schema);
    const order = await db.order.findFirst({
      where: { id: input.orderId },
      select: {
        id: true, depotId: true, deliveryDate: true, carriedToOrderId: true,
        deliveryStartMin: true, deliveryEndMin: true, deliveryTimeReason: true, deliveryTimeNote: true,
        carriedTo: { select: { deliveryDate: true } },
        customer: { select: { code: true, branchCode: true, name: true } },
      },
    });
    if (!order) return fail('Order not found', 404);
    if (order.carriedToOrderId) {
      const to = order.carriedTo ? fmtDayMonth(isoOf(order.carriedTo.deliveryDate)) : 'a later day';
      return fail({ code: 'ORDER_CARRIED', message: `This order was brought forward to ${to}. Set its delivery time on that day.` } as Record<string, unknown>, 409);
    }
    // The plan in use for the order's day and depot (the tenant's own: runId scopes the stops below).
    const plan = await currentPlan(user.tenantId, order.depotId, isoOf(order.deliveryDate));
    if (plan) {
      const stops = await db.routeAssignment.findMany({
        where: { runId: plan.id, orderId: order.id },
        include: { load: { include: { truck: { select: { code: true } } } } },
      });
      const frozen = stops.map((a) => a.load).find((l) => l && l.status !== 'PLANNED');
      if (frozen) {
        return fail(
          {
            code: 'ORDER_ON_FROZEN_LOAD',
            message: `This order is already on ${frozen.truck?.code ?? 'a truck'} load ${frozen.loadNo} (${frozen.status.toLowerCase()}): its delivery time cannot change. A locked load never changes; unlock it first if the time must change.`,
          } as Record<string, unknown>,
          409,
        );
      }
    }
    const was = orderTimeOf(order);
    let now: OrderTime | null = null;
    if (!input.clear) {
      const check = checkOrderTime(input);
      if (!check.ok) return fail(check.error, 400);
      now = check.time;
    }
    await db.order.update({
      where: { id: order.id },
      data: now
        ? {
            deliveryStartMin: now.startMin,
            deliveryEndMin: now.endMin,
            deliveryTimeReason: now.reason,
            deliveryTimeNote: now.note,
            deliveryTimeSetAt: new Date(),
            deliveryTimeSetById: user.id,
          }
        : { deliveryStartMin: null, deliveryEndMin: null, deliveryTimeReason: null, deliveryTimeNote: null, deliveryTimeSetAt: new Date(), deliveryTimeSetById: user.id },
    });
    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: now ? 'ORDER_DELIVERY_TIME_SET' : 'ORDER_DELIVERY_TIME_CLEARED',
      entity: 'Order',
      entityId: order.id,
      beforeJson: { deliveryTime: asJson(was), customer: order.customer.code, branchCode: order.customer.branchCode } as never,
      afterJson: { deliveryTime: asJson(now), customer: order.customer.code, branchCode: order.customer.branchCode } as never,
      ip,
    });
    const planned = !!plan?.chosenScenarioId;
    return ok({
      orderId: order.id,
      deliveryTime: asJson(now),
      text: now ? promisedText(now) : null,
      message: `${now ? `${promisedText(now)} saved` : 'Delivery time removed'} for ${order.customer.name}.${planned ? ' RE-PLAN to plan the order with it.' : ''}`,
    });
  },
  { role: 'PLANNER' },
);
