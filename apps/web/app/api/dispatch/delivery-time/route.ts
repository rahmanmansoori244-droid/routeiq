import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { currentPlan } from '@/lib/dispatch/plan-service';
import { asPlanBusy, lockPlanDay, lockPlanRow, setLockTimeout } from '@/lib/dispatch/plan-locks';
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

/** The same hours (start and end): what the stop is planned with. A reason or a note is not planned with. */
const sameHours = (a: OrderTime | null, b: OrderTime | null) => (a?.startMin ?? null) === (b?.startMin ?? null) && (a?.endMin ?? null) === (b?.endMin ?? null);

const ORDER_SELECT = {
  id: true, depotId: true, deliveryDate: true, carriedToOrderId: true,
  deliveryStartMin: true, deliveryEndMin: true, deliveryTimeReason: true, deliveryTimeNote: true,
  carriedTo: { select: { deliveryDate: true } },
  customer: { select: { code: true, branchCode: true, name: true } },
} satisfies Prisma.OrderSelect;

type Outcome =
  | { kind: 'fail'; status: number; error: string | Record<string, unknown> }
  | { kind: 'ok'; now: OrderTime | null; changed: 'NONE' | 'NOTE' | 'TIME'; planned: boolean; name: string };

// PUT /api/dispatch/delivery-time - a delivery time for ONE order (owner decision 1 Oct 2026, item 1):
// an urgent delivery or a time promised to the customer, with a reason (Urgent / Promised to customer /
// Other + note). It does not change the customer master; the next optimize / RE-PLAN plans the
// order's stop with it, and the plan, Excel, driver PDF and WhatsApp show "Promised 10:00–11:00".
// { clear: true } removes it. Refused for an order on a locked (or later) load of the plan in use -
// frozen loads never change - and for an order brought forward to a later day. Audited.
//
// Frozen loads never change, also under a race (data collection review): LOCK runs under the plan
// row lock (lockRunForWrite), so the check, the order update and its audit row run in ONE transaction
// under the day lock and then the plan row lock (the lock order used everywhere, plan-locks.ts), with
// the order and its loads read again under them. A LOCK committed meanwhile is seen and the save is
// refused; a LOCK after it waits and judges the order with its new time. A lock held more than 5 s
// (a plan being saved) is 409 PLAN_BUSY.
//
// Only a new time (start or end) is a new delivery time for the plan (`deliveryTimeSetAt`, which LOCK
// compares with the plan): the same time saved again changes nothing, and another reason or note only
// is saved (and audited) without making the plan out of date - the outputs show the time only.
export const PUT = withTenantApi(
  async (req, { db, user, ip }) => {
    const input = await parseBody(req, schema);
    let wanted: OrderTime | null = null;
    if (!input.clear) {
      const check = checkOrderTime(input);
      if (!check.ok) return fail(check.error, 400);
      wanted = check.time;
    }
    // The order's day and depot, for the day lock (read again under the locks below).
    const first = await db.order.findFirst({ where: { id: input.orderId }, select: { id: true, depotId: true, deliveryDate: true } });
    if (!first) return fail('Order not found', 404);
    const tenantId = user.tenantId;
    let outcome: Outcome;
    try {
      outcome = await prisma.$transaction(
        async (tx): Promise<Outcome> => {
          await setLockTimeout(tx);
          await lockPlanDay(tx, tenantId, first.depotId, first.deliveryDate);
          // The plan in use for the order's day and depot (the tenant's own: runId scopes the stops below).
          const plan = await currentPlan(tenantId, first.depotId, isoOf(first.deliveryDate), tx);
          if (plan) await lockPlanRow(tx, tenantId, plan.id);
          const order = await tx.order.findFirst({ where: { id: first.id, tenantId }, select: ORDER_SELECT });
          if (!order) return { kind: 'fail', status: 404, error: 'Order not found' };
          if (order.depotId !== first.depotId || isoOf(order.deliveryDate) !== isoOf(first.deliveryDate)) {
            return { kind: 'fail', status: 409, error: 'This order was moved to another day or depot meanwhile. Reload the day and try again.' };
          }
          if (order.carriedToOrderId) {
            const to = order.carriedTo ? fmtDayMonth(isoOf(order.carriedTo.deliveryDate)) : 'a later day';
            return { kind: 'fail', status: 409, error: { code: 'ORDER_CARRIED', message: `This order was brought forward to ${to}. Set its delivery time on that day.` } };
          }
          if (plan) {
            const stops = await tx.routeAssignment.findMany({
              where: { runId: plan.id, orderId: order.id },
              include: { load: { include: { truck: { select: { code: true } } } } },
            });
            const frozen = stops.map((a) => a.load).find((l) => l && l.status !== 'PLANNED');
            if (frozen) {
              return {
                kind: 'fail',
                status: 409,
                error: {
                  code: 'ORDER_ON_FROZEN_LOAD',
                  message: `This order is already on ${frozen.truck?.code ?? 'a truck'} load ${frozen.loadNo} (${frozen.status.toLowerCase()}): its delivery time cannot change. A locked load never changes; unlock it first if the time must change.`,
                },
              };
            }
          }
          const was = orderTimeOf(order);
          const planned = !!plan?.chosenScenarioId;
          const changed = !sameHours(was, wanted) ? 'TIME' : was?.reason !== wanted?.reason || (was?.note ?? null) !== (wanted?.note ?? null) ? 'NOTE' : 'NONE';
          if (changed === 'NONE') return { kind: 'ok', now: wanted, changed, planned, name: order.customer.name };
          await tx.order.update({
            where: { id: order.id },
            data: {
              deliveryStartMin: wanted?.startMin ?? null,
              deliveryEndMin: wanted?.endMin ?? null,
              deliveryTimeReason: wanted?.reason ?? null,
              deliveryTimeNote: wanted?.note ?? null,
              // Only a new time makes the plan out of date (LOCK compares it with the plan).
              ...(changed === 'TIME' ? { deliveryTimeSetAt: new Date(), deliveryTimeSetById: user.id } : {}),
            },
          });
          await audit(
            {
              tenantId,
              userId: user.id,
              action: wanted ? 'ORDER_DELIVERY_TIME_SET' : 'ORDER_DELIVERY_TIME_CLEARED',
              entity: 'Order',
              entityId: order.id,
              beforeJson: { deliveryTime: asJson(was), customer: order.customer.code, branchCode: order.customer.branchCode } as never,
              afterJson: { deliveryTime: asJson(wanted), customer: order.customer.code, branchCode: order.customer.branchCode } as never,
              ip,
            },
            tx,
          );
          return { kind: 'ok', now: wanted, changed, planned, name: order.customer.name };
        },
        { timeout: 30_000, maxWait: 5_000 },
      );
    } catch (e) {
      throw asPlanBusy(e);
    }
    if (outcome.kind === 'fail') return fail(outcome.error, outcome.status);
    const { now, changed, planned, name } = outcome;
    const what = now ? promisedText(now) : null;
    const message =
      changed === 'NONE'
        ? `${what ? `${what} for ${name}` : `No delivery time for ${name}`}: nothing changed.`
        : changed === 'NOTE'
          ? `${what} kept for ${name}: reason and note saved.`
          : `${what ? `${what} saved` : 'Delivery time removed'} for ${name}.${planned ? ' RE-PLAN to plan the order with it.' : ''}`;
    return ok({ orderId: first.id, deliveryTime: asJson(now), text: what, message });
  },
  { role: 'PLANNER' },
);
