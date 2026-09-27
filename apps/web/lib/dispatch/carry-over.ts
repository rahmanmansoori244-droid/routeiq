/**
 * Bring forward (PR9): orders that were not delivered on their own day, carried to a later day.
 *
 * Before PR9 an order that was not delivered stayed on its own delivery date for good: the next
 * day's plan never saw it. Now the day screen of day D lists the orders of the same depot with a
 * delivery date in [D-7, D-1] whose cases were not delivered, and "Bring forward to D" carries the
 * selected ones:
 *
 * - what counts as NOT delivered, per order line: its cases minus the cases on loads of its day's
 *   live plan that left the depot (DISPATCHED or COMPLETED). So an order unserved in that plan, on
 *   a load that never left (PLANNED, LOCKED or LOADING), or of a day that was never planned is
 *   carried; a split order only with its open part. Orders on loads that left are delivered, and an
 *   order already DISPATCHED or DELIVERED is never carried;
 * - the copy on D is a new order: same customer, branch and sales-order lines (same product and
 *   recorded weight per case) with the open cases, linked to its original (carriedFromOrderId, and
 *   carriedFromDate: the date it was first due). The original is marked (carriedToOrderId,
 *   carriedAt, carriedById): from then on it is no longer open, unserved or pending on its own day
 *   (ordersInScopeWhere leaves it out), while that day's plan versions stay exactly as they were;
 * - it runs in ONE transaction under the intake lock (like confirm and the late order), with the
 *   live plans of the days it reads locked, so a load dispatched meanwhile is seen. An order is
 *   carried at most once (unique carriedFromOrderId / carriedToOrderId): running it twice, or twice
 *   at the same time, carries nothing new.
 *
 * Not carried, and listed with the reason: orders of a deactivated customer, a sales-order line
 * already confirmed for D (entered again), the older of two open orders with the same sales-order
 * line, and orders of a day whose plan is being optimized right now.
 *
 * Priority stays as the order had it (no automatic bump). On D the copies are ordinary orders: with
 * no plan yet, OPTIMIZE plans them; with a plan, they are pending like late orders and RE-PLAN adds
 * them (reason LATE_ORDER) around the locked, loading and dispatched loads.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { audit } from '../audit';
import { PlanError } from './plan-errors';
import { isLockBusy, PlanBusyError, setLockTimeout } from './plan-locks';
import { currentPlan, isDispatchDetails } from './plan-service';
import { INTAKE_BUSY, isTransactionTimeout, lockIntake } from './intake-server';
import { customerKey, lineDupKey, normSalesOrder } from './order-intake';
import { portionMoney, readPortionLines } from './split';
import { addDaysIso, dateOnly, fmtDayMonth, isAfterCutoff, isoOf } from './time';
import { orderUsesLineWeights } from './weights';

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/** How many days back "Bring forward" looks: [D-7, D-1]. */
export const CARRY_WINDOW_DAYS = 7;

/** Load statuses whose cases count as delivered (the load left the depot). */
const LEFT_DEPOT = new Set(['DISPATCHED', 'COMPLETED']);

export type CarryWhyKind = 'UNSERVED' | 'NOT_LEFT' | 'NEVER_PLANNED';
export interface CarryWhy {
  kind: CarryWhyKind;
  text: string;
  /** UNSERVED: the unserved reason code of the plan (labelled on screen). */
  reasonCode?: string;
}

export type CarryBlockCode = 'CUSTOMER_INACTIVE' | 'ALREADY_ON_DAY' | 'SAME_LINE_LATER' | 'DAY_OPTIMIZING';

export interface CarryLine {
  lineId: string;
  productCode: string;
  salesOrderNo: string | null;
  /** Open (not delivered) cases of the line: what is carried. */
  cases: number;
  /** The line's cases as confirmed. */
  lineCases: number;
}

export interface CarryCandidate {
  orderId: string;
  /** The order's own delivery date (YYYY-MM-DD). */
  date: string;
  /** The date the order was first due (its own date, or the first order's when it was carried before). */
  firstDate: string;
  customerId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  priority: number;
  /** Open cases: what "Bring forward" carries. */
  cases: number;
  /** The order's cases as confirmed. */
  orderCases: number;
  /** kg of the open cases (the weight per case recorded on the order). */
  weightKg: number;
  /** Only part of the order is open (the rest was delivered). */
  partial: boolean;
  salesOrders: string[];
  why: CarryWhy[];
  /** Listed but not carried, with the reason. */
  blocked: { code: CarryBlockCode; text: string } | null;
  lines: CarryLine[];
}

export interface CarryPreview {
  date: string;
  depotId: string;
  /** The window looked at: [from, to] = [D-7, D-1]. */
  from: string;
  to: string;
  /** Orders and cases that can be brought forward (not blocked). */
  orders: number;
  cases: number;
  /** Listed but not carried (deactivated customer, entered again, day being optimized). */
  blocked: number;
  candidates: CarryCandidate[];
}

// ---------------------------------------------------------------------------------------
// Candidates (pure)
// ---------------------------------------------------------------------------------------

export interface CarryOrderIn {
  id: string;
  /** YYYY-MM-DD */
  deliveryDate: string;
  status: string;
  carriedToOrderId: string | null;
  /** YYYY-MM-DD, set on an order that was itself carried from an earlier day. */
  carriedFromDate: string | null;
  priority: number;
  totalCases: number;
  totalWeightKg: number;
  customerId: string;
  customer: { code: string; branchCode: string | null; branchKey: string; name: string; active: boolean };
  lines: { id: string; cases: number; weightKg: number; salesOrderNo: string | null; productCode: string }[];
}

/** The live plan of one earlier day, as far as "was it delivered" needs it. */
export interface CarryPlanIn {
  version: number;
  status: string;
  /** The plan has an applied option (a chosen scenario). */
  chosen: boolean;
  /** The applied option's scope (orders it was made for); null without an applied dispatch plan. */
  scopeOrderIds: string[] | null;
  loads: { truckCode: string; loadNo: number; status: string; assignments: { orderId: string; portionLinesJson: unknown }[] }[];
  /** The applied option's unserved rows. */
  unserved: { orderId: string; reasonCode: string; reasonMessage: string | null; portionLinesJson: unknown }[];
}

export interface CarryTarget {
  /** Day D (YYYY-MM-DD): candidates are strictly earlier. */
  date: string;
  /** lineDupKey of every sales-order line already confirmed for D (the file intake's duplicate identity). */
  confirmedKeys: ReadonlySet<string>;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const label = (c: { code: string; branchCode: string | null }) => (c.branchCode ? `${c.code}/${c.branchCode}` : c.code);

function neverPlannedText(plan: CarryPlanIn | null, date: string, orderId: string): string {
  const day = fmtDayMonth(date);
  if (!plan) return `No plan was made for ${day}`;
  if (!plan.chosen) return `The ${day} plan (version ${plan.version}) was never optimized`;
  if (plan.scopeOrderIds && !plan.scopeOrderIds.includes(orderId)) return `Added after the ${day} plan (version ${plan.version}) was made: never planned`;
  return `Not on any load of the ${day} plan (version ${plan.version})`;
}

/**
 * The orders of earlier days whose cases were not delivered, per order with its open lines, why
 * (unserved / on a load that never left / never planned) and, when it cannot be carried, the reason.
 * `plans`: the live plan of each earlier day (null = no plan). Orders already carried, DISPATCHED or
 * DELIVERED, or with every case on a load that left, are not candidates.
 */
export function carryCandidates(orders: readonly CarryOrderIn[], plans: ReadonlyMap<string, CarryPlanIn | null>, target: CarryTarget): CarryCandidate[] {
  const out: CarryCandidate[] = [];
  for (const o of orders) {
    if (o.carriedToOrderId || o.status === 'DISPATCHED' || o.status === 'DELIVERED') continue;
    if (!(o.deliveryDate < target.date)) continue;
    const plan = plans.get(o.deliveryDate) ?? null;
    // Cases on loads that left the depot are delivered; loads that never left are listed.
    const delivered = new Map<string, number>();
    const notLeft: string[] = [];
    for (const l of plan?.loads ?? []) {
      for (const a of l.assignments) {
        if (a.orderId !== o.id) continue;
        if (LEFT_DEPOT.has(l.status)) {
          const part = readPortionLines(a.portionLinesJson) ?? o.lines.map((x) => ({ lineId: x.id, cases: x.cases }));
          for (const x of part) delivered.set(x.lineId, (delivered.get(x.lineId) ?? 0) + x.cases);
        } else {
          const where = `${l.truckCode} L${l.loadNo} (${l.status.toLowerCase()})`;
          if (!notLeft.includes(where)) notLeft.push(where);
        }
      }
    }
    const lines: CarryLine[] = o.lines
      .map((l) => ({ lineId: l.id, productCode: l.productCode, salesOrderNo: l.salesOrderNo, cases: Math.max(0, l.cases - (delivered.get(l.id) ?? 0)), lineCases: l.cases }))
      .filter((l) => l.cases > 0);
    const cases = lines.reduce((a, l) => a + l.cases, 0);
    if (cases === 0) continue;
    // kg of the open cases with the weight per case recorded on the order (never today's master):
    // the line's own kg, or the order's for older orders whose kg lives on the order only.
    const orderLevel = !orderUsesLineWeights(o);
    const byId = new Map(o.lines.map((l) => [l.id, l]));
    const weightKg = round(
      lines.reduce((a, l) => {
        const src = byId.get(l.lineId)!;
        const perCase = orderLevel ? (o.totalCases > 0 ? o.totalWeightKg / o.totalCases : 0) : src.cases > 0 ? src.weightKg / src.cases : 0;
        return a + perCase * l.cases;
      }, 0),
      1,
    );

    const why: CarryWhy[] = [];
    if (notLeft.length) why.push({ kind: 'NOT_LEFT', text: `On ${notLeft.join(', ')}: never left the depot` });
    for (const u of plan?.chosen ? plan.unserved.filter((x) => x.orderId === o.id) : []) {
      const part = readPortionLines(u.portionLinesJson);
      const n = part ? part.reduce((a, x) => a + x.cases, 0) : o.totalCases;
      why.push({ kind: 'UNSERVED', reasonCode: u.reasonCode, text: `Unserved${part ? ` (${n} cases)` : ''}: ${u.reasonMessage?.trim() || u.reasonCode}` });
    }
    if (!why.length) why.push({ kind: 'NEVER_PLANNED', text: neverPlannedText(plan, o.deliveryDate, o.id) });

    let blocked: CarryCandidate['blocked'] = null;
    if (plan?.status === 'OPTIMIZING') {
      blocked = { code: 'DAY_OPTIMIZING', text: `The ${fmtDayMonth(o.deliveryDate)} plan is being optimized right now: wait for it to finish, then look again.` };
    } else if (!o.customer.active) {
      blocked = { code: 'CUSTOMER_INACTIVE', text: `Customer ${label(o.customer)} is deactivated: reactivate it in Customers to bring this order forward.` };
    } else {
      const ck = customerKey(o.customer.code, o.customer.branchKey);
      const dup = lines.find((l) => l.salesOrderNo && normSalesOrder(l.salesOrderNo) && target.confirmedKeys.has(lineDupKey(target.date, l.salesOrderNo, ck, l.productCode)));
      if (dup) {
        blocked = {
          code: 'ALREADY_ON_DAY',
          text: `Sales order ${dup.salesOrderNo} (${dup.productCode}) is already confirmed for ${fmtDayMonth(target.date)}: not brought forward. Check whether it was entered again for that day.`,
        };
      }
    }
    out.push({
      orderId: o.id,
      date: o.deliveryDate,
      firstDate: o.carriedFromDate ?? o.deliveryDate,
      customerId: o.customerId,
      customerCode: o.customer.code,
      branchCode: o.customer.branchCode,
      customerName: o.customer.name,
      priority: o.priority,
      cases,
      orderCases: o.totalCases,
      weightKg,
      partial: cases < o.totalCases,
      salesOrders: [...new Set(lines.map((l) => l.salesOrderNo).filter((s): s is string => !!s))],
      why,
      blocked,
      lines,
    });
  }
  // The same sales-order line open on two earlier days (entered again for the next day, and not
  // delivered either time): only the latest is carried, or D would get the line twice.
  const custKeyOf = new Map(orders.map((o) => [o.id, customerKey(o.customer.code, o.customer.branchKey)]));
  const claimed = new Map<string, string>(); // line identity -> date of the order that carries it
  const newestFirst = [...out].sort((a, b) => b.date.localeCompare(a.date) || a.orderId.localeCompare(b.orderId));
  for (const c of newestFirst) {
    if (c.blocked) continue;
    const keys = c.lines.filter((l) => normSalesOrder(l.salesOrderNo)).map((l) => lineDupKey('', l.salesOrderNo!, custKeyOf.get(c.orderId)!, l.productCode));
    const taken = keys.find((k) => claimed.has(k));
    if (taken) {
      const line = c.lines.find((l) => normSalesOrder(l.salesOrderNo) && lineDupKey('', l.salesOrderNo!, custKeyOf.get(c.orderId)!, l.productCode) === taken)!;
      c.blocked = {
        code: 'SAME_LINE_LATER',
        text: `Sales order ${line.salesOrderNo} (${line.productCode}) is also open on ${fmtDayMonth(claimed.get(taken)!)}: only that order is brought forward.`,
      };
      continue;
    }
    for (const k of keys) claimed.set(k, c.date);
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || a.customerCode.localeCompare(b.customerCode) || (a.branchCode ?? '').localeCompare(b.branchCode ?? '') || a.orderId.localeCompare(b.orderId),
  );
}

/** One selected order: its id and the open cases the screen showed (the expected state). */
export interface CarrySelection {
  orderId: string;
  cases: number;
}

export interface SelectionCheck {
  carry: CarryCandidate[];
  /** Already brought forward (by this or another dispatcher): nothing to do, not an error. */
  skipped: { orderId: string; code: 'ALREADY_CARRIED'; text: string }[];
  /** No longer what the screen showed: nothing is carried until the list is reloaded. */
  changed: { orderId: string; text: string }[];
}

/**
 * The selection against the candidates as they are now. An order already carried is skipped (so a
 * second run carries nothing new); one that is no longer a candidate, is blocked now, or has other
 * open cases than the screen showed is "changed".
 */
export function checkSelection(candidates: readonly CarryCandidate[], selected: readonly CarrySelection[], alreadyCarried: ReadonlyMap<string, string>): SelectionCheck {
  const byId = new Map(candidates.map((c) => [c.orderId, c]));
  const res: SelectionCheck = { carry: [], skipped: [], changed: [] };
  for (const s of selected) {
    const to = alreadyCarried.get(s.orderId);
    if (to !== undefined) {
      res.skipped.push({ orderId: s.orderId, code: 'ALREADY_CARRIED', text: `Already brought forward to ${fmtDayMonth(to)}.` });
      continue;
    }
    const c = byId.get(s.orderId);
    if (!c) {
      res.changed.push({ orderId: s.orderId, text: 'No longer open on an earlier day (delivered, dispatched or removed since the list was shown).' });
    } else if (c.blocked) {
      res.changed.push({ orderId: s.orderId, text: `${label({ code: c.customerCode, branchCode: c.branchCode })} (${fmtDayMonth(c.date)}): ${c.blocked.text}` });
    } else if (c.cases !== s.cases) {
      res.changed.push({ orderId: s.orderId, text: `${label({ code: c.customerCode, branchCode: c.branchCode })} (${fmtDayMonth(c.date)}): ${c.cases} cases are open now, the list showed ${s.cases}.` });
    } else {
      res.carry.push(c);
    }
  }
  return res;
}

// ---------------------------------------------------------------------------------------
// The copy on day D (pure)
// ---------------------------------------------------------------------------------------

/** The original order as the copy needs it. */
export interface CarrySource {
  id: string;
  customerId: string;
  deliveryDate: Date;
  carriedFromDate: Date | null;
  totalCases: number;
  totalWeightKg: number;
  totalVolumeL: number;
  totalServiceTimeMin: number;
  paymentCollectionAmount: number;
  priority: number;
  priorityFromFile: boolean;
  notes: string | null;
  salesValue: number | null;
  marginValue: number | null;
  lines: {
    id: string;
    productId: string;
    cases: number;
    salesOrderNo: string | null;
    orderDate: Date | null;
    productDescription: string | null;
    weightKg: number;
    weightFromMaster: boolean;
    salesValue: number | null;
    marginValue: number | null;
    sourceRow: number | null;
    notes: string | null;
  }[];
}

export interface CopyOptions {
  tenantId: string;
  depotId: string;
  /** Day D (YYYY-MM-DD). */
  date: string;
  late: boolean;
  userId: string;
  now: Date;
}

/**
 * The order created on day D for a candidate: same customer (and so branch), priority and notes;
 * one line per open line with the same product, sales order and weight per case as recorded (a
 * line weighed from the product master stays so), money shared out by cases; linked to the
 * original. No upload batch: deleting the original's file can never delete the copy.
 */
export function carryCopyData(src: CarrySource, cand: Pick<CarryCandidate, 'lines' | 'cases' | 'date' | 'firstDate'>, opt: CopyOptions): Prisma.OrderUncheckedCreateInput {
  const byId = new Map(src.lines.map((l) => [l.id, l]));
  const orderLevel = !orderUsesLineWeights(src);
  const share = (v: number | null, part: number, whole: number) => (v === null ? null : whole > 0 ? round((v * part) / whole, 3) : v);
  const lines = cand.lines.map((cl) => {
    const l = byId.get(cl.lineId);
    if (!l) throw new Error(`carryCopyData: line ${cl.lineId} is not on order ${src.id}`);
    return {
      productId: l.productId,
      cases: cl.cases,
      salesOrderNo: l.salesOrderNo,
      orderDate: l.orderDate,
      productDescription: l.productDescription,
      weightKg: share(l.weightKg, cl.cases, l.cases) ?? 0,
      weightFromMaster: l.weightFromMaster,
      salesValue: share(l.salesValue, cl.cases, l.cases),
      marginValue: share(l.marginValue, cl.cases, l.cases),
      sourceRow: l.sourceRow,
      notes: l.notes,
    };
  });
  const cases = lines.reduce((a, l) => a + l.cases, 0);
  const portion = cand.lines.map((l) => ({ lineId: l.lineId, cases: l.cases }));
  const money = (field: 'salesValue' | 'marginValue') => {
    const v = portionMoney(src[field], src.totalCases, src.lines.map((l) => ({ id: l.id, cases: l.cases, value: l[field] })), portion);
    return v === null ? null : round(v, 3);
  };
  const totalWeightKg = orderLevel ? (share(src.totalWeightKg, cases, src.totalCases) ?? 0) : round(lines.reduce((a, l) => a + l.weightKg, 0), 3);
  return {
    tenantId: opt.tenantId,
    customerId: src.customerId,
    depotId: opt.depotId,
    deliveryDate: dateOnly(opt.date),
    totalCases: cases,
    totalWeightKg,
    totalVolumeL: share(src.totalVolumeL, cases, src.totalCases) ?? 0,
    totalServiceTimeMin: src.totalServiceTimeMin,
    paymentCollectionAmount: share(src.paymentCollectionAmount, cases, src.totalCases) ?? 0,
    priority: src.priority,
    priorityFromFile: src.priorityFromFile,
    notes: src.notes,
    status: 'VALIDATED',
    uploadBatchId: null,
    uploadedAt: opt.now,
    isLate: opt.late,
    lateReason: `Brought forward from ${fmtDayMonth(cand.date)}: not delivered on that day.`,
    lateRecordedById: opt.userId,
    salesValue: money('salesValue'),
    marginValue: money('marginValue'),
    carriedFromOrderId: src.id,
    carriedFromDate: src.carriedFromDate ?? src.deliveryDate,
    lines: { create: lines },
  };
}

// ---------------------------------------------------------------------------------------
// Database: preview and bring forward
// ---------------------------------------------------------------------------------------

async function windowOrders(db: Db, tenantId: string, depotId: string, date: string) {
  const from = addDaysIso(date, -CARRY_WINDOW_DAYS);
  const to = addDaysIso(date, -1);
  // The depot's orders, and orders without a depot when the tenant has one active depot
  // (the same scope as ordersInScopeWhere).
  const depots = await db.depot.count({ where: { tenantId, active: true } });
  const orders = await db.order.findMany({
    where: {
      tenantId,
      deliveryDate: { gte: dateOnly(from), lte: dateOnly(to) },
      OR: depots <= 1 ? [{ depotId }, { depotId: null }] : [{ depotId }],
      carriedToOrderId: null,
      status: { notIn: ['DISPATCHED', 'DELIVERED'] },
    },
    include: {
      customer: { select: { code: true, branchCode: true, branchKey: true, name: true, active: true } },
      lines: { include: { product: { select: { code: true } } }, orderBy: { id: 'asc' } },
    },
    orderBy: [{ deliveryDate: 'asc' }, { uploadedAt: 'asc' }, { id: 'asc' }],
  });
  return { from, to, orders };
}

/** The live plan of each day that has candidate orders (null = no plan that day). */
async function dayPlans(db: Db, tenantId: string, depotId: string, dates: string[]) {
  const plans = new Map<string, { id: string; plan: CarryPlanIn } | null>();
  for (const date of dates) {
    const run = await currentPlan(tenantId, depotId, date, db);
    if (!run) {
      plans.set(date, null);
      continue;
    }
    const loads = await db.planLoad.findMany({
      where: { runId: run.id, tenantId },
      select: { loadNo: true, status: true, truck: { select: { code: true } }, assignments: { select: { orderId: true, portionLinesJson: true } } },
      orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }],
    });
    const sc = run.chosenScenarioId
      ? await db.scenarioResult.findFirst({ where: { id: run.chosenScenarioId, runId: run.id }, include: { unservedOrders: true } })
      : null;
    const details = sc && isDispatchDetails(sc.detailsJson) ? sc.detailsJson : null;
    plans.set(date, {
      id: run.id,
      plan: {
        version: run.version,
        status: run.status,
        chosen: !!run.chosenScenarioId,
        scopeOrderIds: details ? [...details.scope.orderIds, ...details.scope.frozenOrderIds, ...(details.scope.frozenLoadOrderIds ?? [])] : null,
        loads: loads.map((l) => ({ truckCode: l.truck.code, loadNo: l.loadNo, status: l.status, assignments: l.assignments })),
        unserved: (sc?.unservedOrders ?? []).map((u) => ({ orderId: u.orderId, reasonCode: u.reasonCode, reasonMessage: u.reasonMessage, portionLinesJson: u.portionLinesJson })),
      },
    });
  }
  return plans;
}

/** lineDupKey of every sales-order line confirmed for `date` (any depot, like the file intake). */
async function confirmedKeysOn(db: Db, tenantId: string, date: string): Promise<Set<string>> {
  const rows = await db.orderLine.findMany({
    where: { salesOrderNo: { not: null }, order: { tenantId, deliveryDate: dateOnly(date) } },
    select: { salesOrderNo: true, product: { select: { code: true } }, order: { select: { customer: { select: { code: true, branchKey: true } } } } },
  });
  const keys = new Set<string>();
  for (const l of rows) {
    if (!normSalesOrder(l.salesOrderNo)) continue;
    keys.add(lineDupKey(date, l.salesOrderNo!, customerKey(l.order.customer.code, l.order.customer.branchKey), l.product.code));
  }
  return keys;
}

function toOrderIn(o: Awaited<ReturnType<typeof windowOrders>>['orders'][number]): CarryOrderIn {
  return {
    id: o.id,
    deliveryDate: isoOf(o.deliveryDate),
    status: o.status,
    carriedToOrderId: o.carriedToOrderId,
    carriedFromDate: o.carriedFromDate ? isoOf(o.carriedFromDate) : null,
    priority: o.priority,
    totalCases: o.totalCases,
    totalWeightKg: o.totalWeightKg,
    customerId: o.customerId,
    customer: o.customer,
    lines: o.lines.map((l) => ({ id: l.id, cases: l.cases, weightKg: l.weightKg, salesOrderNo: l.salesOrderNo, productCode: l.product.code })),
  };
}

async function readCandidates(db: Db, tenantId: string, depotId: string, date: string) {
  const { from, to, orders } = await windowOrders(db, tenantId, depotId, date);
  const dates = [...new Set(orders.map((o) => isoOf(o.deliveryDate)))];
  const plans = await dayPlans(db, tenantId, depotId, dates);
  const confirmedKeys = orders.length ? await confirmedKeysOn(db, tenantId, date) : new Set<string>();
  const candidates = carryCandidates(orders.map(toOrderIn), new Map([...plans].map(([d, p]) => [d, p?.plan ?? null])), { date, confirmedKeys });
  return { from, to, candidates, plans };
}

function previewOf(date: string, depotId: string, from: string, to: string, candidates: CarryCandidate[]): CarryPreview {
  const open = candidates.filter((c) => !c.blocked);
  return {
    date,
    depotId,
    from,
    to,
    orders: open.length,
    cases: open.reduce((a, c) => a + c.cases, 0),
    blocked: candidates.length - open.length,
    candidates,
  };
}

async function activeDepot(db: Db, tenantId: string, depotId: string) {
  const depot = await db.depot.findFirst({ where: { tenantId, id: depotId, active: true }, select: { id: true, code: true } });
  if (!depot) throw new PlanError('Depot not found or inactive.', 400, { code: 'DEPOT_NOT_FOUND' });
  return depot;
}

/** GET /api/dispatch/carry-over: what "Bring forward to D" would carry for this depot. */
export async function carryOverPreview(tenantId: string, depotId: string, date: string, db: Db = prisma): Promise<CarryPreview> {
  await activeDepot(db, tenantId, depotId);
  const { from, to, candidates } = await readCandidates(db, tenantId, depotId, date);
  return previewOf(date, depotId, from, to, candidates);
}

export interface CarriedOrder {
  fromOrderId: string;
  toOrderId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  /** The original's delivery date. */
  fromDate: string;
  firstDate: string;
  cases: number;
  partial: boolean;
}

export interface BringForwardResult {
  date: string;
  depotId: string;
  carried: CarriedOrder[];
  orders: number;
  cases: number;
  skipped: SelectionCheck['skipped'];
  /** The copies count as late (the day already has a plan in use, or the cutoff passed). */
  late: boolean;
  /** Day D has a plan in use: RE-PLAN adds the copies around its locked and dispatched loads. */
  replanNeeded: boolean;
  planId: string | null;
}

/**
 * "Bring forward to D": carry the selected orders (with the open cases the screen showed) to day D.
 * One transaction: the intake lock first (confirm, late order and batch delete take it too), then
 * the live plans of the earlier days that are read (row locks, in id order), then everything is
 * read again and checked. A selection that no longer matches (a load dispatched meanwhile, a
 * customer deactivated, ...) carries nothing: 409 CARRY_OVER_CHANGED. Orders already carried are
 * skipped, so a second run - also at the same time - carries nothing new.
 */
export async function bringForward(
  tenantId: string,
  depotId: string,
  date: string,
  selected: readonly CarrySelection[],
  user: { id: string },
  opts: { now?: Date; ip?: string | null } = {},
): Promise<BringForwardResult> {
  const now = opts.now ?? new Date();
  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockIntake(tx, tenantId);
        await setLockTimeout(tx);
        const depot = await activeDepot(tx, tenantId, depotId);
        // Lock the live plans of the days read, so a load dispatched (or a plan applied) meanwhile
        // is seen here, and a dispatch after this commits sees the carried orders (it is refused).
        const { orders } = await windowOrders(tx, tenantId, depotId, date);
        const dates = [...new Set(orders.map((o) => isoOf(o.deliveryDate)))];
        const runIds: string[] = [];
        for (const d of dates) {
          const run = await currentPlan(tenantId, depotId, d, tx);
          if (run) runIds.push(run.id);
        }
        for (const id of [...runIds].sort()) {
          await tx.$queryRaw`SELECT id FROM "RunPlan" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
        }
        const { candidates } = await readCandidates(tx, tenantId, depotId, date);
        const ids = selected.map((s) => s.orderId);
        const done = await tx.order.findMany({
          where: { tenantId, id: { in: ids }, carriedToOrderId: { not: null } },
          select: { id: true, carriedTo: { select: { deliveryDate: true } } },
        });
        const check = checkSelection(candidates, selected, new Map(done.map((o) => [o.id, o.carriedTo ? isoOf(o.carriedTo.deliveryDate) : '?'])));
        if (check.changed.length) {
          throw new PlanError(
            `The list changed since it was shown: ${check.changed.map((c) => c.text).slice(0, 5).join(' ')}${check.changed.length > 5 ? ` (and ${check.changed.length - 5} more)` : ''} Nothing was brought forward: look at the list again.`,
            409,
            { code: 'CARRY_OVER_CHANGED', changed: check.changed },
          );
        }
        const cfg = await tx.tenantConfig.findUniqueOrThrow({ where: { tenantId }, select: { planningCutoffMin: true, timezone: true } });
        const dayPlan = await currentPlan(tenantId, depotId, date, tx);
        // Like a late order: late after the cutoff, or when day D already has a plan in use.
        const late = isAfterCutoff(now, date, cfg.planningCutoffMin, cfg.timezone) || !!dayPlan?.chosenScenarioId;
        const sources = check.carry.length
          ? await tx.order.findMany({ where: { tenantId, id: { in: check.carry.map((c) => c.orderId) } }, include: { lines: true } })
          : [];
        const srcById = new Map(sources.map((s) => [s.id, s]));
        const carried: CarriedOrder[] = [];
        for (const c of check.carry) {
          const src = srcById.get(c.orderId)!;
          const copy = await tx.order.create({
            data: carryCopyData(src, c, { tenantId, depotId: depot.id, date, late, userId: user.id, now }),
            include: { lines: { select: { id: true, salesOrderNo: true, productId: true } } },
          });
          // The copy's sales-order lines are confirmed for D (IntakeLineKey), so a file or late order
          // for D with the same line is a duplicate. The original keeps its own keys on its day. A
          // line twice on one older order keeps one key, like the migration's backfill.
          const seen = new Set<string>();
          const keys = copy.lines.flatMap((l) => {
            const so = normSalesOrder(l.salesOrderNo);
            if (!so || seen.has(`${so}|${l.productId}`)) return [];
            seen.add(`${so}|${l.productId}`);
            return [{ tenantId, deliveryDate: dateOnly(date), salesOrderNorm: so, customerId: src.customerId, productId: l.productId, orderLineId: l.id, uploadBatchId: null }];
          });
          if (keys.length) await tx.intakeLineKey.createMany({ data: keys });
          const marked = await tx.order.updateMany({
            where: { id: src.id, tenantId, carriedToOrderId: null },
            data: { carriedToOrderId: copy.id, carriedAt: now, carriedById: user.id },
          });
          if (marked.count !== 1) throw new PlanError('An order was brought forward by someone else at the same time. Look at the list again.', 409, { code: 'CARRY_OVER_CHANGED' });
          carried.push({
            fromOrderId: src.id,
            toOrderId: copy.id,
            customerCode: c.customerCode,
            branchCode: c.branchCode,
            customerName: c.customerName,
            fromDate: c.date,
            firstDate: c.firstDate,
            cases: c.cases,
            partial: c.partial,
          });
        }
        const cases = carried.reduce((a, c) => a + c.cases, 0);
        if (carried.length) {
          await audit(
            {
              tenantId,
              userId: user.id,
              action: 'ORDERS_CARRIED_OVER',
              entity: 'Order',
              entityId: null,
              afterJson: {
                date,
                depot: depot.code,
                orders: carried.length,
                cases,
                late,
                carried: carried.map((c) => ({ from: c.fromOrderId, to: c.toOrderId, customer: c.branchCode ? `${c.customerCode}/${c.branchCode}` : c.customerCode, fromDate: c.fromDate, cases: c.cases, partial: c.partial })),
                ...(check.skipped.length ? { skipped: check.skipped.map((s) => s.orderId) } : {}),
              } as never,
              ...(opts.ip ? { ip: opts.ip } : {}),
            },
            tx,
          );
        }
        return {
          date,
          depotId: depot.id,
          carried,
          orders: carried.length,
          cases,
          skipped: check.skipped,
          late,
          replanNeeded: !!dayPlan?.chosenScenarioId && carried.length > 0,
          planId: dayPlan?.id ?? null,
        };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (e) {
    if (isTransactionTimeout(e)) throw new PlanError(INTAKE_BUSY.error, 409, { code: INTAKE_BUSY.code });
    if (isLockBusy(e)) throw new PlanBusyError();
    if (isCarryConflict(e)) {
      throw new PlanError('An order was brought forward, or a sales-order line confirmed, at the same time. Nothing was brought forward: look at the list again.', 409, { code: 'CARRY_OVER_CHANGED' });
    }
    throw e;
  }
}

/** A unique index of a carry (carriedFromOrderId / carriedToOrderId) or of an intake line key. */
export function isCarryConflict(e: unknown): boolean {
  const err = e as { code?: string; meta?: { target?: unknown; modelName?: string } } | null;
  if (!err || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return /carriedFromOrderId|carriedToOrderId|salesOrderNorm|orderLineId|IntakeLineKey/.test(text) || err.meta?.modelName === 'IntakeLineKey';
}
