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
import { carryCopyData, copyIntakeKeys, isCarryConflict } from './carry-over';
import { customerKey, lineDupKey, normSalesOrder } from './order-intake';
import { shownTruckCode } from './hire';
import { cancelHireChecksOfDay } from './hire-whatif';
import { DEFAULT_TZ, dateOnly, fmtDayMonth, isAfterCutoff, isoOf, localDateIso, todayIso } from './time';
import {
  cancelDoneText,
  invoicesText,
  orderActionReasonText,
  orderActionRefusal,
  planOptimizingText,
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

type Placement = OrderPlacementNow & { loadId: string };

/** Where the order is on a plan version: one row per load holding it (the version is the tenant's: currentPlan). */
async function placementsOn(tx: Tx, runId: string, orderId: string): Promise<Placement[]> {
  const rows = await tx.routeAssignment.findMany({
    where: { runId, orderId },
    select: { load: { select: { id: true, loadNo: true, status: true, truck: { select: { code: true, onlyOnDate: true } } } } },
  });
  return rows.flatMap((r) => (r.load ? [{ loadId: r.load.id, truckCode: shownTruckCode(null, r.load.truck), loadNo: r.load.loadNo, status: r.load.status }] : []));
}

/**
 * The PLANNED loads holding the order, split by whether they also hold an order still of the day (not
 * cancelled, not moved to another day): `replan` - RE-PLAN takes the order off them (they cannot be
 * locked until then); `idle` - they hold nothing else now, so they are no work for a re-plan (carry-view
 * holdsOnlyGone, the day screen's cancelledOnPlan): left as they are, never loaded.
 */
async function plannedLoadsSplit(tx: Tx, runId: string, orderId: string, placements: readonly Placement[]): Promise<{ replan: string[]; idle: string[] }> {
  const planned = placements.filter((p) => p.status === 'PLANNED');
  if (!planned.length) return { replan: [], idle: [] };
  const busy = await tx.routeAssignment.findMany({
    where: { runId, loadId: { in: planned.map((p) => p.loadId) }, orderId: { not: orderId }, order: { cancelledAt: null, carriedToOrderId: null } },
    select: { loadId: true },
  });
  const withOthers = new Set(busy.map((b) => b.loadId));
  return {
    replan: plannedLoadsOf(planned.filter((p) => withOthers.has(p.loadId))),
    idle: plannedLoadsOf(planned.filter((p) => !withOthers.has(p.loadId))),
  };
}

/**
 * A cancel, an undo or a postpone changed the orders of these days: a hire check still waiting or
 * running for one of them was computed with the orders as they were (its answer would rent trucks for
 * them). Called after the commit, never failing the action. A finished suggestion is checked again when
 * it is used (hire-use: refused when nothing it was for is left to plan).
 */
function stopHireChecks(tenantId: string, depotId: string, days: readonly string[]): void {
  for (const d of new Set(days)) {
    void cancelHireChecksOfDay(
      tenantId,
      depotId,
      dateOnly(d),
      `Stopped: an order of ${fmtDayMonth(d)} was cancelled, restored or postponed, so this check was for orders no longer as they are. Check hire options again.`,
    );
  }
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

/**
 * The latest plan version of the day, row-locked, and read AGAIN under that lock: a job that finished
 * (READY, with its loads) or a "Use instead" committed while this waited for the row is what is judged,
 * never the status or the option in use read before the wait. Another version live meanwhile = busy (as
 * bringForward does): nothing is changed.
 */
async function latestPlanLocked(tx: Tx, tenantId: string, depotId: string, day: string) {
  const plan = await currentPlan(tenantId, depotId, day, tx);
  if (!plan) return null;
  await lockPlanRow(tx, tenantId, plan.id);
  const again = await currentPlan(tenantId, depotId, day, tx);
  if (again?.id !== plan.id) {
    throw new PlanBusyError(`The ${fmtDayMonth(day)} plan changed while this was waiting. Nothing was changed: reload the day and try again.`);
  }
  return again;
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
  /** The order is still on PLANNED loads of the latest plan version that hold other orders of the day: RE-PLAN the day to take it off. */
  replanNeeded: boolean;
  onPlannedLoads: string[];
  /** PLANNED loads still holding it that hold nothing else of the day now: left as they are (never loaded). */
  idleLoads: string[];
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
    const out = await prisma.$transaction(
      async (tx): Promise<CancelResult & { depotId: string; day: string }> => {
        const { depotId, day } = await lockOrderDay(tx, tenantId, orderId);
        const plan = await latestPlanLocked(tx, tenantId, depotId, day);
        const order = await readOrder(tx, tenantId, orderId);
        const who = custLabel(order.customer);
        if (order.cancelledAt) {
          return { orderId, already: true, replanNeeded: false, onPlannedLoads: [], idleLoads: [], message: `The order of ${who} is already cancelled: nothing changed.`, depotId, day };
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
        const loads = plan ? await plannedLoadsSplit(tx, plan.id, order.id, placements) : { replan: [], idle: [] };
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
          replanNeeded: loads.replan.length > 0,
          onPlannedLoads: loads.replan,
          idleLoads: loads.idle,
          message: cancelDoneText({
            customer: who,
            invoices: invoicesText(inv.salesOrders, inv.withoutInvoice),
            cases: order.totalCases,
            onPlannedLoads: loads.replan,
            idleLoads: loads.idle,
            unserved,
            planned: !!plan?.chosenScenarioId,
          }),
          depotId,
          day,
        };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const { depotId, day, ...res } = out;
    if (!res.already) stopHireChecks(tenantId, depotId, [day]);
    return res;
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
 * delivered on another day (not cancelled, not moved on): undoing would deliver them twice. `after`:
 * only days after it (Postpone: the line entered again for a later day, Bring forward's SAME_LINE_LATER).
 */
async function sameLinesElsewhere(tx: Tx, tenantId: string, order: OrderRow, opts: { after?: Date } = {}): Promise<{ date: string; salesOrder: string }[]> {
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
      deliveryDate: opts.after ? { gt: opts.after } : { not: order.deliveryDate },
      orderLine: { is: { order: { cancelledAt: null, carriedToOrderId: null, id: { not: order.id } } } },
    },
    select: { salesOrderNorm: true, productId: true, deliveryDate: true },
    orderBy: { deliveryDate: 'asc' },
  });
  const wanted = new Set(pairs.map((p) => `${p.so}|${p.productId}`));
  return keys.filter((k) => wanted.has(`${k.salesOrderNorm}|${k.productId}`)).map((k) => ({ date: isoOf(k.deliveryDate), salesOrder: k.salesOrderNorm }));
}

/**
 * POST /api/dispatch/orders/:id/uncancel: the order is open again while its day is not over (company's
 * today). Clears the four cancel columns; the next OPTIMIZE / RE-PLAN plans it (an order still on a
 * PLANNED load of the plan in use - cancelled and undone before a re-plan - stays there as planned).
 * Refused when one of its invoice lines was entered again on another day (SAME_LINE_ELSEWHERE: it would
 * be delivered twice), and while the day's plan is being optimized (PLAN_OPTIMIZING, as Cancel and
 * Postpone: the running job was built without the order and replaces the PLANNED loads, so "still on
 * T02 L1 as planned" would be wrong a moment later). Audited ORDER_CANCEL_UNDONE.
 */
export async function undoCancelOrder(tenantId: string, orderId: string, user: { id: string }, opts: { ip?: string | null; now?: Date } = {}): Promise<UndoCancelResult> {
  const now = opts.now ?? new Date();
  try {
    const out = await prisma.$transaction(
      async (tx): Promise<UndoCancelResult & { depotId: string; day: string }> => {
        const { depotId, day } = await lockOrderDay(tx, tenantId, orderId);
        const plan = await latestPlanLocked(tx, tenantId, depotId, day);
        const order = await readOrder(tx, tenantId, orderId);
        if (!order.cancelledAt) throw new PlanError('This order is not cancelled (any more): nothing to undo. Reload the day.', 409, { code: 'NOT_CANCELLED' });
        if (plan?.status === 'OPTIMIZING') throw new PlanError(planOptimizingText(day), 409, { code: 'PLAN_OPTIMIZING' });
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
          depotId,
          day,
        };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const { depotId, day, ...res } = out;
    stopHireChecks(tenantId, depotId, [day]);
    return res;
  } catch (e) {
    throw asBusy(e);
  }
}

// ---------------------------------------------------------------------------------------
// Postpone
// ---------------------------------------------------------------------------------------

/**
 * Every sales-order line confirmed for `date` (any depot, like the file intake and Bring forward's
 * confirmedKeysOn), by lineDupKey, with its order's cancel when that order is cancelled (its intake key
 * stays, so the line can never be confirmed for that day again) - null = open. An open line wins over a
 * cancelled one with the same key.
 */
async function confirmedLinesOn(tx: Tx, tenantId: string, date: string): Promise<Map<string, { at: Date; by: string | null } | null>> {
  const rows = await tx.orderLine.findMany({
    where: { salesOrderNo: { not: null }, order: { tenantId, deliveryDate: dateOnly(date) } },
    select: {
      salesOrderNo: true,
      product: { select: { code: true } },
      order: { select: { cancelledAt: true, cancelledBy: { select: { name: true } }, customer: { select: { code: true, branchKey: true } } } },
    },
  });
  const out = new Map<string, { at: Date; by: string | null } | null>();
  for (const l of rows) {
    if (!normSalesOrder(l.salesOrderNo)) continue;
    const k = lineDupKey(date, l.salesOrderNo!, customerKey(l.order.customer.code, l.order.customer.branchKey), l.product.code);
    const cancel = l.order.cancelledAt ? { at: l.order.cancelledAt, by: l.order.cancelledBy?.name ?? null } : null;
    if (!out.has(k) || cancel === null) out.set(k, cancel);
  }
  return out;
}

export interface PostponeResult {
  orderId: string;
  copyId: string;
  fromDate: string;
  toDate: string;
  cases: number;
  /** The copy counts as late (D already has a plan in use, or its cutoff passed), like Bring forward. */
  late: boolean;
  /** The original is still on PLANNED loads of its day's latest plan version that hold other orders of that day: RE-PLAN that day. */
  onPlannedLoads: string[];
  /** PLANNED loads still holding the original that hold nothing else of its day now: left as they are (never loaded). */
  idleLoads: string[];
  /** D has a plan in use, or is being optimized: RE-PLAN D adds the copy. */
  replanTo: boolean;
  message: string;
}

/**
 * POST /api/dispatch/orders/:id/postpone: move one order (all of it) to a later day D with a reason -
 * Bring forward's copy for a single order, also one of a future day. D is after the order's day, at
 * most 14 days after it and not before the company's today; the order's own day must not be over
 * (earlier days use Bring forward). The same load rules as Cancel; also refused for a deactivated
 * customer, when one of its invoice lines is already confirmed for D (ALREADY_ON_DAY; on a cancelled
 * order of D: ALREADY_ON_DAY_CANCELLED) and when one of them was entered again for a later day than the
 * order's own (SAME_LINE_LATER, as Bring forward: the customer would get it twice). The copy on D is marked
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
    const out = await prisma.$transaction(
      async (tx): Promise<PostponeResult & { depotId: string }> => {
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
        // A sales-order line already confirmed for D (entered again for that day): never twice. On a
        // cancelled order of D (its intake key stays) the way out is that day's Undo, so the answer says so.
        const onD = await confirmedLinesOn(tx, tenantId, toDate);
        const ck = customerKey(order.customer.code, order.customer.branchKey);
        const keyOf = (l: OrderRow['lines'][number]) => lineDupKey(toDate, l.salesOrderNo!, ck, l.product.code);
        const dups = order.lines.filter((l) => normSalesOrder(l.salesOrderNo) && onD.has(keyOf(l)));
        const dup = dups.find((l) => onD.get(keyOf(l)) === null) ?? dups[0];
        if (dup) {
          const so = `Sales order ${dup.salesOrderNo} (${dup.product.code})`;
          const cancel = onD.get(keyOf(dup));
          if (cancel) {
            throw new PlanError(
              `${so} is on an order of ${fmtDayMonth(toDate)} that was cancelled on ${fmtDayMonth(localDateIso(cancel.at, tz))}${cancel.by ? ` by ${cancel.by}` : ''}: not postponed, so it is never on two orders of that day. To deliver it on ${fmtDayMonth(toDate)}, undo that cancel on the ${fmtDayMonth(toDate)} screen (Cancelled orders, Step 1) and cancel this order instead.`,
              409,
              { code: 'ALREADY_ON_DAY_CANCELLED' },
            );
          }
          throw new PlanError(
            `${so} is already confirmed for ${fmtDayMonth(toDate)}: not postponed, so it is not delivered twice. Check whether it was entered again for that day.`,
            409,
            { code: 'ALREADY_ON_DAY' },
          );
        }
        // Entered again for a later day than the order's own (open, planned, delivered, or moved on: its
        // copy counts), as Bring forward's SAME_LINE_LATER: only the newest order holds the line.
        const later = await sameLinesElsewhere(tx, tenantId, order, { after: order.deliveryDate });
        if (later.length) {
          const first = later[0]!;
          throw new PlanError(
            `Sales order ${first.salesOrder} of this order was entered again for ${fmtDayMonth(first.date)}: not postponed, so it is not delivered twice. Keep that order (cancel this one), or cancel that order first.`,
            409,
            { code: 'SAME_LINE_LATER', dates: [...new Set(later.map((x) => x.date))] },
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
        const loads = plan ? await plannedLoadsSplit(tx, plan.id, order.id, placements) : { replan: [], idle: [] };
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
          onPlannedLoads: loads.replan,
          idleLoads: loads.idle,
          replanTo: toHasPlan || toOptimizing,
          message: postponeDoneText({ customer: who, cases, fromDate: day, toDate, onPlannedLoads: loads.replan, idleLoads: loads.idle, toHasPlan, toOptimizing }),
          depotId,
        };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const { depotId, ...res } = out;
    stopHireChecks(tenantId, depotId, [res.fromDate, res.toDate]);
    return res;
  } catch (e) {
    if (isCarryConflict(e)) {
      throw new PlanError('The order was moved, or one of its invoice lines confirmed for that day, at the same time. Nothing was postponed: reload the day.', 409, { code: 'ORDER_CHANGED' });
    }
    throw asBusy(e);
  }
}
