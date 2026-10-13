/**
 * Cancel order and Postpone order (owner request of the first live night, 12 Oct 2026): the rules
 * and the words. Pure and browser-safe: the routes (lib/dispatch/order-cancel.ts), the day screen's
 * dialogs, the plan screen's badge and the load gate (plan-service.ts) all read these, so the rules
 * and the messages never drift apart.
 *
 * The unit is one RouteIQ order: every invoice (OrderLine.salesOrderNo) of one customer for one
 * delivery date in one file. Cancelling one invoice of several is a later step.
 *
 * - Cancel is soft (Order.cancelledAt / cancelledById / cancelReason / cancelNote). A cancelled order
 *   is left out everywhere an order is planned, counted or offered (NOT_CANCELLED below), and stays
 *   on its day for the record ("Cancelled" list with Undo). Its intake keys stay, so the same invoice
 *   re-sent for the same day is skipped with a message that says it was cancelled.
 * - Undo cancel clears the four columns while the order's day is not over (company's today).
 * - Postpone to a later day D reuses Bring forward's copy (carry-over.ts carryCopyData): the copy on D
 *   is marked "Carried over from <day>", the original leaves its day. D is after the order's day, at
 *   most POSTPONE_MAX_DAYS after it, and not before the company's today. Undo = Undo bring forward.
 * - Both judge the order on the LATEST plan version of its day and depot (orderActionRefusal): not
 *   planned or only unserved = allowed; on a PLANNED load = allowed, and that load is refused Lock,
 *   Loading and Dispatch until the day is re-planned (409 ORDERS_CANCELLED, or ORDERS_CARRIED after a
 *   postpone); on a LOCKED or LOADING load = refused (unlock first, like a delivery time); on a load
 *   that left, or DISPATCHED / DELIVERED = refused (the driver records the result); the day's plan
 *   being optimized = refused (try again when it finishes).
 */
import type { Prisma } from '@prisma/client';
import { addDaysIso, fmtDayMonth } from './time';

/** The where-fragment of every order read that plans, counts or offers orders: not cancelled. */
export const NOT_CANCELLED = { cancelledAt: null } as const satisfies Prisma.OrderWhereInput;

export const CANCEL_REASONS = ['CUSTOMER_CANCELLED', 'WRONG_OR_DUPLICATE', 'NO_ACCESS_SMALL_TRUCK', 'OTHER'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/** Postpone: the cancel reasons, and "Postponed by sales/customer" (offered first on the dialog). */
export const POSTPONE_REASONS = ['POSTPONED_BY_SALES', ...CANCEL_REASONS] as const;
export type PostponeReason = (typeof POSTPONE_REASONS)[number];

export const ORDER_ACTION_REASON_TEXT: Record<PostponeReason, string> = {
  POSTPONED_BY_SALES: 'Postponed by sales/customer',
  CUSTOMER_CANCELLED: 'Customer cancelled',
  WRONG_OR_DUPLICATE: 'Wrong or duplicate order',
  NO_ACCESS_SMALL_TRUCK: 'Truck cannot reach the customer (small truck only)',
  OTHER: 'Other',
};

/** The longest note (required for Other). */
export const ORDER_ACTION_NOTE_MAX = 200;

/** How far a postpone may go: at most this many days after the order's own day. */
export const POSTPONE_MAX_DAYS = 14;

/** The words of a reason code, with its note: "Other: shop closed for Eid", "Customer cancelled". */
export function orderActionReasonText(reason: string | null | undefined, note?: string | null): string {
  const label = reason && reason in ORDER_ACTION_REASON_TEXT ? ORDER_ACTION_REASON_TEXT[reason as PostponeReason] : (reason ?? 'No reason');
  const n = note?.trim();
  return n ? `${label}: ${n}` : label;
}

/** A reason and note as sent: the reason is one of the list, Other needs a note, a note is at most 200 characters. */
export function checkOrderActionReason(
  kind: 'CANCEL' | 'POSTPONE',
  reason: string | null | undefined,
  note: string | null | undefined,
): { ok: true; reason: PostponeReason; note: string | null } | { ok: false; error: string } {
  const list: readonly string[] = kind === 'CANCEL' ? CANCEL_REASONS : POSTPONE_REASONS;
  if (!reason || !list.includes(reason)) return { ok: false, error: `Choose a reason: ${list.map((r) => ORDER_ACTION_REASON_TEXT[r as PostponeReason]).join(', ')}.` };
  const n = note?.trim() || null;
  if (n && n.length > ORDER_ACTION_NOTE_MAX) return { ok: false, error: `The note is at most ${ORDER_ACTION_NOTE_MAX} characters.` };
  if (reason === 'OTHER' && !n) return { ok: false, error: 'Other needs a note: say why.' };
  return { ok: true, reason: reason as PostponeReason, note: n };
}

// ---------------------------------------------------------------------------------------
// The order as it is now, on the latest plan version of its day
// ---------------------------------------------------------------------------------------

/** Where an order is on the latest plan version of its day (one row per load holding it). */
export interface OrderPlacementNow {
  truckCode: string;
  loadNo: number;
  /** PlanLoad status: PLANNED, LOCKED, LOADING, DISPATCHED, COMPLETED. */
  status: string;
}

export interface OrderStateNow {
  /** Order status (DISPATCHED / DELIVERED: it left). */
  status: string;
  /** Cancelled (cancelledAt set). */
  cancelled: boolean;
  /** Brought forward (or postponed) to a later day: that day (YYYY-MM-DD), '' when not known; null = not. */
  carriedTo: string | null;
  /** Its loads on the latest plan version of its day. */
  placements: readonly OrderPlacementNow[];
  /** The latest plan version's status (null = no plan for the day). */
  planStatus: string | null;
  /** The order's day (YYYY-MM-DD), for the words. */
  date: string;
}

export type OrderActionRefusalCode = 'ORDER_CANCELLED' | 'ORDER_CARRIED' | 'ORDER_LEFT' | 'ORDER_ON_LOCKED_LOAD' | 'PLAN_OPTIMIZING';

export interface OrderActionRefusal {
  status: number;
  code: OrderActionRefusalCode;
  text: string;
}

const LEFT = new Set(['DISPATCHED', 'COMPLETED']);
const where = (p: OrderPlacementNow) => `${p.truckCode} load ${p.loadNo}`;

/**
 * Why this order cannot be cancelled (or postponed) now, or null when it can. In this order: already
 * cancelled (postpone only: cancel answers "already cancelled" itself), brought forward to a later
 * day, left the depot, on a locked or loading load, the day's plan being optimized.
 */
export function orderActionRefusal(action: 'CANCEL' | 'POSTPONE', o: OrderStateNow): OrderActionRefusal | null {
  const verb = action === 'CANCEL' ? 'cancel' : 'postpone';
  if (o.cancelled && action === 'POSTPONE') {
    return { status: 409, code: 'ORDER_CANCELLED', text: 'This order is cancelled: undo the cancel first (Cancelled orders, Step 1 of the day), then postpone it.' };
  }
  if (o.carriedTo !== null) {
    const to = o.carriedTo ? fmtDayMonth(o.carriedTo) : 'a later day';
    return { status: 409, code: 'ORDER_CARRIED', text: `This order was already moved to ${to} (brought forward or postponed): ${verb} it on that day.` };
  }
  const left = o.placements.find((p) => LEFT.has(p.status));
  if (left || o.status === 'DISPATCHED' || o.status === 'DELIVERED') {
    const on = left ? ` on ${where(left)}` : '';
    return {
      status: 409,
      code: 'ORDER_LEFT',
      text: `This order has already left the depot${on}: it cannot be ${verb === 'cancel' ? 'cancelled' : 'postponed'} in RouteIQ. The driver records the result (Not delivered, with the reason) instead.`,
    };
  }
  const frozen = o.placements.find((p) => p.status === 'LOCKED' || p.status === 'LOADING');
  if (frozen) {
    return {
      status: 409,
      code: 'ORDER_ON_LOCKED_LOAD',
      text: `This order is on ${where(frozen)} (${frozen.status.toLowerCase()}). A locked load never changes: unlock the load first (a loading load goes Back to locked first), then ${verb} the order and re-plan the day. Unload its cases if they are already on the truck.`,
    };
  }
  if (o.planStatus === 'OPTIMIZING') return { status: 409, code: 'PLAN_OPTIMIZING', text: planOptimizingText(o.date) };
  return null;
}

/**
 * The refusal while the day's plan is being optimized (Cancel, Postpone and Undo cancel): the running
 * job was built from the orders as they were and replaces the PLANNED loads when it finishes, so a
 * change now would be answered for a plan that is about to be replaced.
 */
export function planOptimizingText(date: string): string {
  return `The ${fmtDayMonth(date)} plan is being optimized right now: try again when it finishes.`;
}

/** The PLANNED loads of the latest plan version still holding the order ("T05 L2"), each once. */
export function plannedLoadsOf(placements: readonly OrderPlacementNow[]): string[] {
  return [...new Set(placements.filter((p) => p.status === 'PLANNED').map((p) => `${p.truckCode} L${p.loadNo}`))];
}

// ---------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------

/**
 * The days an order of `orderDate` may be postponed to: [max(next day, today), orderDate + 14]; null =
 * none. An order of a day that is over (before today) has none: Bring forward moves it (the server
 * answers ORDER_DAY_OVER, postponeDateRefusal), so the dialog never offers dates it would refuse.
 */
export function postponeRange(orderDate: string, today: string): { from: string; to: string } | null {
  if (orderDate < today) return null;
  const next = addDaysIso(orderDate, 1);
  const from = next < today ? today : next;
  const to = addDaysIso(orderDate, POSTPONE_MAX_DAYS);
  return from <= to ? { from, to } : null;
}

/**
 * Why the order cannot be postponed to `toDate`, or null. The order's own day is over (before today):
 * use Bring forward on today's screen. D must be after the order's day, at most 14 days after it, and
 * not before today.
 */
export function postponeDateRefusal(orderDate: string, toDate: string, today: string): { code: 'ORDER_DAY_OVER' | 'POSTPONE_DATE'; text: string } | null {
  if (orderDate < today) {
    return {
      code: 'ORDER_DAY_OVER',
      text: `This order was for ${fmtDayMonth(orderDate)}, which is over (today is ${fmtDayMonth(today)}). Use Bring forward on today's or a later day's screen to move it.`,
    };
  }
  const range = postponeRange(orderDate, today)!;
  if (toDate < range.from || toDate > range.to) {
    return {
      code: 'POSTPONE_DATE',
      text: `Postpone to a day from ${fmtDayMonth(range.from)} to ${fmtDayMonth(range.to)}: after the order's day (${fmtDayMonth(orderDate)}), at most ${POSTPONE_MAX_DAYS} days later, and not before today.`,
    };
  }
  return null;
}

/** Undo cancel is allowed while the order's day is not over (today or later, company's today). */
export function undoCancelDayOver(orderDate: string, today: string): string | null {
  return orderDate < today
    ? `This order was for ${fmtDayMonth(orderDate)}, which is over (today is ${fmtDayMonth(today)}): its cancel cannot be undone. Record a late order for a later day if it must still be delivered.`
    : null;
}

// ---------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------

/** The order's invoices for the dialog and the messages: "SO 4711, 4712", "SO 4711 and 1 line with no invoice no.", "no invoice no.". */
export function invoicesText(salesOrders: readonly string[], linesWithoutInvoice = 0): string {
  const so = salesOrders.length ? `SO ${salesOrders.join(', ')}` : '';
  if (!linesWithoutInvoice) return so || 'no invoice no.';
  const none = `${linesWithoutInvoice} line(s) with no invoice no.`;
  return so ? `${so} and ${none}` : none;
}

/** The dialog's warning when one order holds several invoices: all of them are cancelled together. */
export function severalInvoicesNote(salesOrders: readonly string[], action: 'CANCEL' | 'POSTPONE'): string | null {
  if (salesOrders.length < 2) return null;
  const verb = action === 'CANCEL' ? 'cancels' : 'postpones';
  return `This ${verb} all ${salesOrders.length} invoices of this order together. Cancelling or postponing one invoice of several is not possible yet (a later step).`;
}

/**
 * The PLANNED loads still holding the order that now hold nothing else of the day (every other order on
 * them cancelled or moved to another day): " T02 L1 holds nothing else now: leave it as it is ...".
 * Such a load is not work for a re-plan (carry-view holdsOnlyGone; the server answers NOTHING_TO_PLAN
 * when nothing else is open), so the answer never says RE-PLAN because of it.
 */
function idleLoadsText(idle: readonly string[]): string {
  if (!idle.length) return '';
  const one = idle.length === 1;
  return ` ${idle.join(', ')} ${one ? 'holds' : 'hold'} nothing else now: leave ${one ? 'it' : 'them'} as ${one ? 'it is' : 'they are'} (never loaded, kept in the plan for the record).`;
}

/**
 * The answer after a cancel. `onPlannedLoads`: the PLANNED loads still holding it that also hold an
 * order still of the day (RE-PLAN takes it off them); `idleLoads`: those holding nothing else now.
 */
export function cancelDoneText(r: {
  customer: string;
  invoices: string;
  cases: number;
  onPlannedLoads: readonly string[];
  idleLoads?: readonly string[];
  unserved: boolean;
  planned: boolean;
}): string {
  const what = `Order of ${r.customer} (${r.invoices}; ${r.cases} cases) cancelled.`;
  const idle = idleLoadsText(r.idleLoads ?? []);
  if (r.onPlannedLoads.length) {
    return `${what} It is still on ${r.onPlannedLoads.join(', ')} (planned): RE-PLAN the day to take it off. Until then ${r.onPlannedLoads.length > 1 ? 'those loads' : 'that load'} cannot be locked, loaded or dispatched.${idle}`;
  }
  if (idle) return `${what}${idle} Nothing else to do.`;
  if (r.unserved) return `${what} It was on the unserved list: nothing else to do.`;
  return `${what} ${r.planned ? 'It is not on any load of the plan in use' : 'It was not planned yet'}: nothing else to do.`;
}

/** The answer after an undo of a cancel. */
export function undoCancelDoneText(r: { customer: string; cases: number; onPlannedLoads: readonly string[]; unserved: boolean; planInUse: boolean }): string {
  const what = `Cancel undone: the order of ${r.customer} (${r.cases} cases) is open again.`;
  if (r.onPlannedLoads.length) return `${what} It is still on ${r.onPlannedLoads.join(', ')} as planned: nothing else to do.`;
  if (r.unserved) return `${what} It is on the unserved list of the plan in use: RE-PLAN tries it again.`;
  return `${what} ${r.planInUse ? 'RE-PLAN adds it to the plan.' : 'OPTIMIZE plans it with the other orders.'}`;
}

/** The answer after a postpone. */
export function postponeDoneText(r: {
  customer: string;
  cases: number;
  fromDate: string;
  toDate: string;
  onPlannedLoads: readonly string[];
  idleLoads?: readonly string[];
  toHasPlan: boolean;
  toOptimizing: boolean;
}): string {
  const to = fmtDayMonth(r.toDate);
  const what = `Order of ${r.customer} (${r.cases} cases) postponed from ${fmtDayMonth(r.fromDate)} to ${to}.`;
  const here =
    (r.onPlannedLoads.length
      ? ` It is still on ${r.onPlannedLoads.join(', ')} of ${fmtDayMonth(r.fromDate)} (planned): RE-PLAN ${fmtDayMonth(r.fromDate)} to take it off; until then that load cannot be locked.`
      : '') + idleLoadsText(r.idleLoads ?? []);
  const there = r.toOptimizing
    ? ` The ${to} plan is being optimized without it: when it finishes, RE-PLAN ${to} to add it.`
    : r.toHasPlan
      ? ` RE-PLAN ${to} to add it to that day's plan.`
      : ` OPTIMIZE plans it with the other orders of ${to}.`;
  return `${what}${here}${there} Undo: on ${to}'s screen, Step 1 (Bring forward, Undo), while ${to} is not planned with it.`;
}

/** The late reason of a postponed copy: "Postponed from 13 Oct: Customer cancelled (shop closed)." */
export function postponeLateReason(fromDate: string, reason: string, note: string | null): string {
  return `Postponed from ${fmtDayMonth(fromDate)}: ${orderActionReasonText(reason, note)}.`;
}

/**
 * The 409 ORDERS_CANCELLED answer of Lock, Loading and Dispatch of a load holding a cancelled order
 * (plan-service cancelledOrdersGate) and the plan screen's badge title. `onlyCancelled`: the load holds
 * nothing else.
 */
export function cancelledLoadText(where: string, names: readonly string[], onlyCancelled: boolean): string {
  const list = `${names.slice(0, 8).join(', ')}${names.length > 8 ? ', ...' : ''}`;
  const head = `${where} holds ${names.length} cancelled order(s): ${list}. It must not be loaded with them, so it cannot be locked, loaded or dispatched.`;
  return onlyCancelled
    ? `${head} It holds nothing else: leave it as it is (it stays in this plan for the record and is never loaded); RE-PLAN the day if its other orders need trucks.`
    : `${head} Re-plan the day: the cancelled order is taken off.`;
}

/** The plan screen's badge on a load or stop holding a cancelled order. */
export const CANCELLED_BADGE = 'CANCELLED - re-plan';

/** The mark of a cancelled order on the driver sheet, the warehouse sheet and the Excel load sheet. */
export const CANCELLED_STOP_TEXT = 'CANCELLED - do not load or deliver (re-plan the day)';

/**
 * The mark of a stop holding a cancelled order (plan-detail DetailStop). A stop is one customer's
 * visit and can hold several orders (a file order and a late order, say): when only some of them are
 * cancelled, the mark names those and says the rest is delivered - never "do not deliver" for the
 * whole stop. Every order cancelled (or no per-order facts): CANCELLED_STOP_TEXT.
 */
export function stopCancelledText(s: {
  orderIds?: readonly string[];
  cancelledOrderIds?: readonly string[];
  orderLines?: readonly { orderId: string; salesOrderNo: string | null }[];
}): string {
  const all = new Set(s.orderIds ?? []);
  const gone = new Set(s.cancelledOrderIds ?? []);
  if (!gone.size || gone.size >= all.size) return CANCELLED_STOP_TEXT;
  const lines = (s.orderLines ?? []).filter((l) => gone.has(l.orderId));
  const sos = [...new Set(lines.map((l) => l.salesOrderNo?.trim()).filter((x): x is string => !!x))].sort();
  const what = invoicesText(sos, lines.filter((l) => !l.salesOrderNo?.trim()).length);
  return `${gone.size} of ${all.size} orders CANCELLED (${what}) - do not load or deliver ${gone.size > 1 ? 'those' : 'it'}; the rest of this stop is delivered (re-plan the day)`;
}
