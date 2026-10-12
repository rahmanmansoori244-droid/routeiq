/**
 * Cancel order, Undo cancel and Postpone order (owner request of the first live night, 12 Oct 2026):
 * the database side. The rules and the words are in ./order-cancel-rules.ts (pure, shared with the
 * screens and the load gate).
 *
 * Each action is ONE transaction under the locks every other order and plan mutator takes, in the lock
 * order of plan-locks.ts: the intake lock first (the optimize start, a confirmed file, a late order,
 * Bring forward and its Undo take it), then the day lock of the order's day (and, for a postpone, of
 * the day it goes to: date order), then (postpone) the outcome-day lock of the order's day, then the
 * row lock of that day's latest plan version. The order and its loads are read under them:
 * - an OPTIMIZE or RE-PLAN start (intake lock, then its plan row) either ran before - the plan is
 *   OPTIMIZING and the action is refused - or runs after and sees the order cancelled or moved (its
 *   start transaction refuses a request built with it: 409 ORDERS_CHANGED, start-optimize.ts);
 * - a LOCK, LOADING or DISPATCH of a load (plan row lock) either ran before - the load is LOCKED and
 *   the action is refused (unlock first) - or runs after and is refused (ORDERS_CANCELLED /
 *   ORDERS_CARRIED gates in plan-service.ts).
 * A lock held more than 5 s answers 409 PLAN_BUSY; the intake lock or the transaction timing out
 * answers 409 INTAKE_BUSY. Nothing is changed then.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { audit } from '../audit';
import { lockOutcomesDay } from '../delivery/locks';
import { PlanError } from './plan-errors';
import { isLockBusy, lockPlanDay, lockPlanRow, PlanBusyError, setLockTimeout } from './plan-locks';
import { currentPlan } from './plan-service';
import { INTAKE_BUSY, isTransactionTimeout, lockIntake } from './intake-server';
import { carryCopyData, confirmedKeysOn, copyIntakeKeys, isCarryConflict } from './carry-over';
import { customerKey, lineDupKey, normSalesOrder } from './order-intake';
import { shownTruckCode } from './hire';
import { DEFAULT_TZ, fmtDayMonth, isAfterCutoff, isoOf, todayIso } from './time';
import {
  cancelDoneText,
  invoicesText,
  orderActionReasonText,
  orderActionRefusal,
  plannedLoadsOf,
  postponeDateRefusal,
  postponeDoneText,
  postponeLateReason,
  undoCancelDayOver,
  undoCancelDoneText,
  type OrderPlacementNow,
  type PostponeReason,
} from './order-cancel-rules';

type Tx = Prisma.TransactionClient;

const ORDER_SELECT = {
  id: true,
  tenantId: true,
  depotId: true,
  customerId: true,
  deliveryDate: true,
  status: true,
  totalCases: true,
  carriedToOrderId: true,
  carriedFromOrderId: true,
  cancelledAt: true,
  cancelReason: true,
  cancelNote: true,
  carriedTo: { select: { deliveryDate: true } },
  customer: { select: { code: true, branchCode: true, branchKey: true, name: true, active: true } },
  lines: { select: { id: true, salesOrderNo: true, productId: true, cases: true, product: { select: { code: true } } }, orderBy: { id: 'asc' } },
} satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

const custLabel = (c: { name: string; code: string; branchCode: string | null }) => `${c.name} (${c.branchCode ? `${c.code}/${c.branchCode}` : c.code})`;

/** The order's invoices (sales-order numbers, each once, sorted) and its lines without one. */
export function orderInvoices(lines: readonly { salesOrderNo: string | null }[]): { salesOrders: string[]; withoutInvoice: number } {
  const salesOrders = [...new Set(lines.map((l) => l.salesOrderNo?.trim()).filter((s): s is string => !!s))].sort();
  return { salesOrders, withoutInvoice: lines.filter((l) => !l.salesOrderNo?.trim()).length };
}

/** Where the order is on a plan version: one row per load holding it (the version is the tenant's: currentPlan). */
async function placementsOn(tx: Tx, runId: string, orderId: string): Promise<OrderPlacementNow[]> {
  const rows = await tx.routeAssignment.findMany({
    where: { runId, orderId },
    select: { load: { select: { loadNo: true, status: true, truck: { select: { code: true, onlyOnDate: true } } } } },
  });
  return rows.flatMap((r) => (r.load ? [{ truckCode: shownTruckCode(null, r.load.truck), loadNo: r.load.loadNo, status: r.load.status }] : []));
}

/** The company's today (tenant timezone) and the settings a postpone needs. */
async function companyDay(tx: Tx, tenantId: string, now: Date) {
  const cfg = await tx.tenantConfig.findUniqueOrThrow({ where: { tenantId }, select: { timezone: true, planningCutoffMin: true } });
  const tz = cfg.timezone || DEFAULT_TZ;
  return { today: todayIso(tz, now), tz, cutoffMin: cfg.planningCutoffMin };
}

/**
 * The intake lock and the order's day lock, then the latest plan version of its day (row-locked) and
 * the order read again under them. 404 for an id of another company (or none).
 */
async function lockOrderDay(tx: Tx, tenantId: string, orderId: string, extraDay?: string) {
  await lockIntake(tx, tenantId);
  await setLockTimeout(tx);
  // Orders change only under the intake lock (held now): this read stays true.
  const first = await tx.order.findFirst({ where: { id: orderId, tenantId }, select: { depotId: true, deliveryDate: true } });
  if (!first) throw new PlanError('Order not found.', 404, { code: 'ORDER_NOT_FOUND' });
  const day = isoOf(first.deliveryDate);
  // Day locks in date order (a postpone's later day after the order's own day): never a later day first.
  for (const d of [...new Set([day, ...(extraDay ? [extraDay] : [])])].sort()) await lockPlanDay(tx, tenantId, first.depotId, d);
  return { depotId: first.depotId, day };
}

async function latestPlanLocked(tx: Tx, tenantId: string, depotId: string, day: string) {
  const plan = await currentPlan(tenantId, depotId, day, tx);
  if (plan) await lockPlanRow(tx, tenantId, plan.id);
  return plan;
}

async function readOrder(tx: Tx, tenantId: string, orderId: string): Promise<OrderRow> {
  const order = await tx.order.findFirst({ where: { id: orderId, tenantId }, select: ORDER_SELECT });
  if (!order) throw new PlanError('Order not found.', 404, { code: 'ORDER_NOT_FOUND' });
  return order;
}

function asBusy(e: unknown): unknown {
  if (isTransactionTimeout(e)) return new PlanError(INTAKE_BUSY.error, 409, { code: INTAKE_BUSY.code });
  if (isLockBusy(e)) return new PlanBusyError();
  return e;
}

// ---------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------

export interface CancelResult {
  orderId: string;
  /** It was cancelled already (by this or another dispatcher): nothing changed. */
  already: boolean;
  /** The order is still on PLANNED loads of the latest plan version: RE-PLAN the day to take it off. */
  replanNeeded: boolean;
  onPlannedLoads: string[];
  message: string;
}

/**
 * POST /api/dispatch/orders/:id/cancel: cancel one order (every invoice of it) with a reason. Allowed
 * when it is on no plan, only unserved, or on PLANNED loads of the latest plan version (those loads are
 * then refused Lock, Loading and Dispatch until the day is re-planned); refused on a locked or loading
 * load, after it left, for an order brought forward to a later day, and while the day is optimized.
 * Audited ORDER_CANCELLED.
 */
export async function cancelOrder(
  tenantId: string,
  orderId: string,
  input: { reason: PostponeReason; note: string | null },
  user: { id: string },
  opts: { ip?: string | null; now?: Date } = {},
): Promise<CancelResult> {
  const now = opts.now ?? new Date();
  try {
    return await prisma.$transaction(
      async (tx): Promise<CancelResult> => {
        const { depotId, day } = await lockOrderDay(tx, tenantId, orderId);
        const plan = await latestPlanLocked(tx, tenantId, depotId, day);
        const order = await readOrder(tx, tenantId, orderId);
        const who = custLabel(order.customer);
        if (order.cancelledAt) {
          return { orderId, already: true, replanNeeded: false, onPlannedLoads: [], message: `The order of ${who} is already cancelled: nothing changed.` };
        }
        const placements = plan ? await placementsOn(tx, plan.id, order.id) : [];
        const refusal = orderActionRefusal('CANCEL', {
          status: order.status,
          cancelled: false,
          carriedTo: order.carriedToOrderId ? (order.carriedTo ? isoOf(order.carriedTo.deliveryDate) : '') : null,
          placements,
          planStatus: plan?.status ?? null,
          date: day,
        });
        if (refusal) throw new PlanError(refusal.text, refusal.status, { code: refusal.code });
        const unserved = plan?.chosenScenarioId ? (await tx.unservedOrder.count({ where: { scenarioId: plan.chosenScenarioId, orderId: order.id } })) > 0 : false;
        const marked = await tx.order.updateMany({
          where: { id: order.id, tenantId, cancelledAt: null, carriedToOrderId: null },
          data: { cancelledAt: now, cancelledById: user.id, cancelReason: input.reason, cancelNote: input.note },
        });
        if (marked.count !== 1) throw new PlanError('The order changed meanwhile: nothing was cancelled. Reload the day and try again.', 409, { code: 'ORDER_CHANGED' });
        const inv = orderInvoices(order.lines);
        const onPlannedLoads = plannedLoadsOf(placements);
        await audit(
          {
            tenantId,
            userId: user.id,
            action: 'ORDER_CANCELLED',
            entity: 'Order',
            entityId: order.id,
            beforeJson: { cancelled: false, status: order.status } as never,
            afterJson: {
              cancelled: true,
              date: day,
              customer: order.customer.branchCode ? `${order.customer.code}/${order.customer.branchCode}` : order.customer.code,
              invoices: inv.salesOrders,
              linesWithoutInvoice: inv.withoutInvoice,
              cases: order.totalCases,
              reason: input.reason,
              note: input.note,
              planVersion: plan?.version ?? null,
              onPlannedLoads,
              unserved,
            } as never,
            ...(opts.ip ? { ip: opts.ip } : {}),
          },
          tx,
        );
        return {
          orderId: order.id,
          already: false,
          replanNeeded: onPlannedLoads.length > 0,
          onPlannedLoads,
          message: cancelDoneText({
            customer: who,
            invoices: invoicesText(inv.salesOrders, inv.withoutInvoice),
            cases: order.totalCases,
            onPlannedLoads,
            unserved,
            planned: !!plan?.chosenScenarioId,
          }),
        };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (e) {
    throw asBusy(e);
  }
}

// ---------------------------------------------------------------------------------------
// Undo cancel
// ---------------------------------------------------------------------------------------

export interface UndoCancelResult {
  orderId: string;
  /** The plan in use does not hold it on a load: RE-PLAN adds it (or tries it again when unserved). */
  replanNeeded: boolean;
  message: string;
}

/**
 * The same sales-order lines (customer, invoice, product) on another order that is open, planned or
 * delivered on another day (not cancelled, not moved on): undoing would deliver them twice.
 */
async function sameLinesElsewhere(tx: Tx, tenantId: string, order: OrderRow): Promise<{ date: string; salesOrder: string }[]> {
  const pairs = order.lines.flatMap((l) => {
    const so = normSalesOrder(l.salesOrderNo);
    return so ? [{ so, productId: l.productId }] : [];
  });
  if (!pairs.length) return [];
  const keys = await tx.intakeLineKey.findMany({
    where: {
      tenantId,
      customerId: order.customerId,
      salesOrderNorm: { in: [...new Set(pairs.map((p) => p.so))] },
      productId: { in: [...new Set(pairs.map((p) => p.productId))] },
      deliveryDate: { not: order.deliveryDate },
      orderLine: { is: { order: { cancelledAt: null, carriedToOrderId: null, id: { not: order.id } } } },
    },
    select: { salesOrderNorm: true, productId: true, deliveryDate: true },
  });
  const wanted = new Set(pairs.map((p) => `${p.so}|${p.productId}`));
  return keys.filter((k) => wanted.has(`${k.salesOrderNorm}|${k.productId}`)).map((k) => ({ date: isoOf(k.deliveryDate), salesOrder: k.salesOrderNorm }));
}

/**
 * POST /api/dispatch/orders/:id/uncancel: the order is open again while its day is not over (company's
 * today). Clears the four cancel columns; the next OPTIMIZE / RE-PLAN plans it (an order still on a
 * PLANNED load of the plan in use - cancelled and undone before a re-plan - stays there as planned).
 * Refused when one of its invoice lines was entered again on another day (SAME_LINE_ELSEWHERE: it would
 * be delivered twice). Audited ORDER_CANCEL_UNDONE.
 */
export async function undoCancelOrder(tenantId: string, orderId: string, user: { id: string }, opts: { ip?: string | null; now?: Date } = {}): Promise<UndoCancelResult> {
  const now = opts.now ?? new Date();
  try {
    return await prisma.$transaction(
      async (tx): Promise<UndoCancelResult> => {
        const { depotId, day } = await lockOrderDay(tx, tenantId, orderId);
        const plan = await latestPlanLocked(tx, tenantId, depotId, day);
        const order = await readOrder(tx, tenantId, orderId);
        if (!order.cancelledAt) throw new PlanError('This order is not cancelled (any more): nothing to undo. Reload the day.', 409, { code: 'NOT_CANCELLED' });
        const { today } = await companyDay(tx, tenantId, now);
        const over = undoCancelDayOver(day, today);
        if (over) throw new PlanError(over, 409, { code: 'DAY_OVER' });
        const elsewhere = await sameLinesElsewhere(tx, tenantId, order);
        if (elsewhere.length) {
          const first = elsewhere[0]!;
          throw new PlanError(
            `Sales order ${first.salesOrder} of this order was entered again for ${fmtDayMonth(first.date)}: undoing the cancel would deliver it twice. Cancel that order first if this one should be delivered instead.`,
            409,
            { code: 'SAME_LINE_ELSEWHERE', dates: [...new Set(elsewhere.map((x) => x.date))] },
          );
        }
        const cleared = await tx.order.updateMany({
          where: { id: order.id, tenantId, cancelledAt: { not: null } },
          data: { cancelledAt: null, cancelledById: null, cancelReason: null, cancelNote: null },
        });
        if (cleared.count !== 1) throw new PlanError('The order changed meanwhile: nothing was undone. Reload the day and try again.', 409, { code: 'ORDER_CHANGED' });
        const placements = plan ? await placementsOn(tx, plan.id, order.id) : [];
        const onPlannedLoads = plannedLoadsOf(placements);
        const unserved = plan?.chosenScenarioId ? (await tx.unservedOrder.count({ where: { scenarioId: plan.chosenScenarioId, orderId: order.id } })) > 0 : false;
        await audit(
          {
            tenantId,
            userId: user.id,
            action: 'ORDER_CANCEL_UNDONE',
            entity: 'Order',
            entityId: order.id,
            beforeJson: { cancelled: true, cancelledAt: order.cancelledAt.toISOString(), reason: order.cancelReason, note: order.cancelNote } as never,
            afterJson: {
              cancelled: false,
              date: day,
              customer: order.customer.branchCode ? `${order.customer.code}/${order.customer.branchCode}` : order.customer.code,
              invoices: orderInvoices(order.lines).salesOrders,
              cases: order.totalCases,
              planVersion: plan?.version ?? null,
              onPlannedLoads,
            } as never,
            ...(opts.ip ? { ip: opts.ip } : {}),
          },
          tx,
        );
        const planInUse = !!plan?.chosenScenarioId;
        return {
          orderId: order.id,
          replanNeeded: planInUse && !onPlannedLoads.length,
          message: undoCancelDoneText({ customer: custLabel(order.customer), cases: order.totalCases, onPlannedLoads, unserved, planInUse }),
        };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (e) {
    throw asBusy(e);
  }
}

// ---------------------------------------------------------------------------------------
// Postpone
// ---------------------------------------------------------------------------------------

export interface PostponeResult {
  orderId: string;
  copyId: string;
  fromDate: string;
  toDate: string;
  cases: number;
  /** The copy counts as late (D already has a plan in use, or its cutoff passed), like Bring forward. */
  late: boolean;
  /** The original is still on PLANNED loads of its day's latest plan version: RE-PLAN that day. */
  onPlannedLoads: string[];
  /** D has a plan in use, or is being optimized: RE-PLAN D adds the copy. */
  replanTo: boolean;
  message: string;
}

/**
 * POST /api/dispatch/orders/:id/postpone: move one order (all of it) to a later day D with a reason -
 * Bring forward's copy for a single order, also one of a future day. D is after the order's day, at
 * most 14 days after it and not before the company's today; the order's own day must not be over
 * (earlier days use Bring forward). The same load rules as Cancel; also refused for a deactivated
 * customer and when one of its invoice lines is already confirmed for D. The copy on D is marked
 * "Carried over from <day>" (carriedFromOrderId) with the late reason "Postponed from 13 Oct: <reason>";
 * the original is marked carriedTo and leaves its day (a PLANNED load still holding it is refused Lock
 * until that day is re-planned: ORDERS_CARRIED). Undo: Undo bring forward on D's screen while D is not
 * planned with it. Audited ORDER_POSTPONED.
 */
export async function postponeOrder(
  tenantId: string,
  orderId: string,
  input: { date: string; reason: PostponeReason; note: string | null },
  user: { id: string },
  opts: { ip?: string | null; now?: Date } = {},
): Promise<PostponeResult> {
  const now = opts.now ?? new Date();
  const toDate = input.date;
  try {
    return await prisma.$transaction(
      async (tx): Promise<PostponeResult> => {
        const { depotId, day } = await lockOrderDay(tx, tenantId, orderId, toDate);
        const { today, tz, cutoffMin } = await companyDay(tx, tenantId, now);
        const dateProblem = postponeDateRefusal(day, toDate, today);
        if (dateProblem) throw new PlanError(dateProblem.text, 409, { code: dateProblem.code });
        // Delivery results of the order's day change only under this lock (lib/delivery/locks.ts).
        await lockOutcomesDay(tx, tenantId, depotId, day);
        const plan = await latestPlanLocked(tx, tenantId, depotId, day);
        const order = await readOrder(tx, tenantId, orderId);
        const placements = plan ? await placementsOn(tx, plan.id, order.id) : [];
        const refusal = orderActionRefusal('POSTPONE', {
          status: order.status,
          cancelled: !!order.cancelledAt,
          carriedTo: order.carriedToOrderId ? (order.carriedTo ? isoOf(order.carriedTo.deliveryDate) : '') : null,
          placements,
          planStatus: plan?.status ?? null,
          date: day,
        });
        if (refusal) throw new PlanError(refusal.text, refusal.status, { code: refusal.code });
        const who = custLabel(order.customer);
        if (!order.customer.active) {
          throw new PlanError(`Customer ${who} is deactivated: reactivate it in Customers to postpone this order.`, 409, { code: 'CUSTOMER_INACTIVE' });
        }
        // A sales-order line already confirmed for D (entered again for that day): never twice.
        const onD = await confirmedKeysOn(tx, tenantId, toDate);
        const ck = customerKey(order.customer.code, order.customer.branchKey);
        const dup = order.lines.find((l) => normSalesOrder(l.salesOrderNo) && onD.has(lineDupKey(toDate, l.salesOrderNo!, ck, l.product.code)));
        if (dup) {
          throw new PlanError(
            `Sales order ${dup.salesOrderNo} (${dup.product.code}) is already confirmed for ${fmtDayMonth(toDate)}: not postponed, so it is not delivered twice. Check whether it was entered again for that day.`,
            409,
            { code: 'ALREADY_ON_DAY' },
          );
        }
        const dayPlan = await currentPlan(tenantId, depotId, toDate, tx);
        const late = isAfterCutoff(now, toDate, cutoffMin, tz) || !!dayPlan?.chosenScenarioId;
        const toOptimizing = dayPlan?.status === 'OPTIMIZING';
        const src = await tx.order.findFirstOrThrow({ where: { id: order.id, tenantId }, include: { lines: true } });
        const lines = order.lines.map((l) => ({ lineId: l.id, productCode: l.product.code, salesOrderNo: l.salesOrderNo, cases: l.cases, lineCases: l.cases }));
        const cases = lines.reduce((a, l) => a + l.cases, 0);
        const copy = await tx.order.create({
          data: {
            ...carryCopyData(src, { lines, cases, date: day, firstDate: src.carriedFromDate ? isoOf(src.carriedFromDate) : day }, { tenantId, depotId, date: toDate, late, userId: user.id, now }),
            lateReason: postponeLateReason(day, input.reason, input.note),
          },
          include: { lines: { select: { id: true, salesOrderNo: true, productId: true } } },
        });
        await copyIntakeKeys(tx, tenantId, toDate, src.customerId, copy.lines);
        const marked = await tx.order.updateMany({
          where: { id: order.id, tenantId, carriedToOrderId: null, cancelledAt: null },
          data: { carriedToOrderId: copy.id, carriedAt: now, carriedById: user.id },
        });
        if (marked.count !== 1) throw new PlanError('The order changed meanwhile: nothing was postponed. Reload the day and try again.', 409, { code: 'ORDER_CHANGED' });
        const onPlannedLoads = plannedLoadsOf(placements);
        const inv = orderInvoices(order.lines);
        await audit(
          {
            tenantId,
            userId: user.id,
            action: 'ORDER_POSTPONED',
            entity: 'Order',
            entityId: order.id,
            beforeJson: { date: day, carriedTo: null } as never,
            afterJson: {
              date: toDate,
              fromDate: day,
              copyId: copy.id,
              customer: order.customer.branchCode ? `${order.customer.code}/${order.customer.branchCode}` : order.customer.code,
              invoices: inv.salesOrders,
              linesWithoutInvoice: inv.withoutInvoice,
              cases,
              reason: input.reason,
              note: input.note,
              reasonText: orderActionReasonText(input.reason, input.note),
              late,
              planVersion: plan?.version ?? null,
              onPlannedLoads,
            } as never,
            ...(opts.ip ? { ip: opts.ip } : {}),
          },
          tx,
        );
        const toHasPlan = !!dayPlan?.chosenScenarioId;
        return {
          orderId: order.id,
          copyId: copy.id,
          fromDate: day,
          toDate,
          cases,
          late,
          onPlannedLoads,
          replanTo: toHasPlan || toOptimizing,
          message: postponeDoneText({ customer: who, cases, fromDate: day, toDate, onPlannedLoads, toHasPlan, toOptimizing }),
        };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (e) {
    if (isCarryConflict(e)) {
      throw new PlanError('The order was moved, or one of its invoice lines confirmed for that day, at the same time. Nothing was postponed: reload the day.', 409, { code: 'ORDER_CHANGED' });
    }
    throw asBusy(e);
  }
}
