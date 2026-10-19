/**
 * The dispatcher's starting point for one depot + delivery date: what was uploaded, what must
 * be fixed before optimizing (LOCATION REQUIRED ...), and the state of the plan.
 */
import { prisma } from '../db';
import { tenantDb } from '../tenant';
import {
  coordStatus,
  customerIssues,
  describeWindows,
  effectiveAttrs,
  inactiveCustomerIssue,
  locationBlocksDelivery,
  parseServiceArea,
  type CustomerIssue,
  type TypeProfileLike,
  windowLabel,
} from './customer-attrs';
import { allCasesOn, leftOutWhole, orderTimeOf, plannedVisitOrders, promisedText, stopWindowFor, type OrderPlacement, type OrderTime } from './order-window';
import { currentPlan, ordersInScopeWhere, type ScenarioDetails } from './plan-service';
import { trucksOfDayWhere } from './hire';
import { dateOnly, fmtHhmm, isoOf, todayIso, tomorrowIso } from './time';
import { defaultSearchMode, planSearching, readResultsNow, thoroughMaxSec } from './search-mode';
import { isRealIsoDate } from '../schemas';
import { lineWeightStatus, orderUsesLineWeights, plannedKgDiffers, planningKgPerCase } from './weights';
import { PALLET_FILL_DEFAULT, palletRoomUnits, validPalletFactor } from './pallets';
import { caseHeavierThanAnyTruck, maxCasePayloadKg, portionPlannedKgPerCase, readPortionLines, rowPalletUnitsNow, type FleetTruck } from './split';
import { plannedLoadsMasterChanged, readPlanInputs, readStopSnapshot, truckOutOfService } from './snapshots';
import { replanCouldPlace, unservedNowPlannable } from './left-out-note';
import { dataGaps, type DataGap } from './data-collection';
import { isSmallTruck, smallTruckMaxBaysOf } from './small-truck';
import type { ServiceArea } from './location-input';
import { dayDeliveries, type DayDeliveries } from '../delivery/day-results';
import { shownTruckCode } from './hire';
import { orderActionReasonText } from './order-cancel-rules';

export interface IssueCustomer {
  customerId: string;
  code: string;
  branchCode: string | null;
  name: string;
  customerType: string | null;
  priority: number;
  prioritySource: string;
  serviceMin: number;
  /** Where serviceMin comes from: CUSTOMER = its own confirmed time; TYPE / DEFAULT = a default (audit F07: the Details dialog shows it as a default, not as the customer's own). */
  serviceSource: string;
  window: string;
  hardWindowStartMin: number | null;
  hardWindowEndMin: number | null;
  prefWindowStartMin: number | null;
  prefWindowEndMin: number | null;
  lat: number | null;
  lng: number | null;
  locationVerified: boolean;
  /** How exact the saved point is (HIGH / MEDIUM / LOW / MISSING): ADD LOCATION saves it again as it is only when exact (audit PR A5). */
  geocodeConfidence: string | null;
  orders: number;
  cases: number;
  issues: CustomerIssue[];
  blocking: boolean;
  /** Deactivated after its orders were confirmed: its open orders are left unserved. */
  inactive: boolean;
  /** The receiving hours in use with where they come from: "hard 06:00–10:00 (confirmed)", "... (default - not confirmed)". */
  windowLabel: string;
  /** CUSTOMER / TYPE / DEFAULT: where the hours in use come from. */
  windowSource: string;
  /** An own confirmed window (owner decision 1 Oct 2026): entered or confirmed by a dispatcher or admin. */
  windowConfirmed: boolean;
  windowConfirmedAt: string | null;
  windowConfirmedBy: string | null;
  /** The customer's phone for the driver (owner request 12 Oct 2026), as the Details dialog opens with it; null = none. */
  phone: string | null;
  /** Small trucks only (owner request 13 Oct 2026), as the Details dialog opens with it. */
  smallTruckOnly: boolean;
  /** The warehouse's loading instruction (owner request 16 Oct 2026), as the Details dialog opens with it; absent = none. */
  loadingInstruction?: string;
  /** The GPS site radius in metres (owner request 19 Oct 2026), as the Details dialog opens with it; absent = none. */
  siteRadiusM?: number;
  /** The hours in use (own, else customer type, else none): what an order's delivery time starts from. */
  effWindow: { hardStart: number | null; hardEnd: number | null; prefStart: number | null; prefEnd: number | null };
  /** Each order of the customer on this day, with its own delivery time (urgent / promised) if it has one. */
  orderTimes: DayOrderTime[];
}

/** One order of the day and its delivery time (owner decision 1 Oct 2026, item 1). */
export interface DayOrderTime {
  orderId: string;
  cases: number;
  salesOrders: string[];
  /** The order's own delivery time; null = the customer's receiving hours apply. */
  time: OrderTime | null;
  /** "Promised 10:00–11:00" when it has one. */
  text: string | null;
  /** On a locked (or later) load of the plan in use, wholly or a part of it: its time cannot change. */
  frozen: boolean;
  /**
   * Cancel / Postpone (owner request 12 Oct 2026): its loads on the plan in use ("T05 L2 (planned)"), and
   * whether it left the depot (DISPATCHED / DELIVERED, or on a dispatched or completed load): then the
   * driver records the result, nothing is cancelled or postponed. `linesWithoutInvoice`: its lines with
   * no sales-order number (the dialog lists the invoices).
   */
  loads: string[];
  left: boolean;
  linesWithoutInvoice: number;
  /**
   * Every case of it is on locked (or later) loads of the plan in use: nothing of it is planned again,
   * so the loading rule never judges it (dayLoadingGaps). Only a part there: its other part is on a
   * PLANNED load (or still to plan), which LOCK judges.
   */
  allFrozen: boolean;
}

/** Products whose order lines have no weight yet (per product: lines and cases). */
/** A product of the day's open lines without a usable cases per pallet (the day screen's red line). */
export interface PalletFactorGap {
  code: string;
  name: string;
  lines: number;
  cases: number;
}

export interface WeightGap {
  code: string;
  name: string;
  lines: number;
  cases: number;
}

/**
 * Why the plan in use is out of date although no new order is waiting (see `outdated` in the
 * result). Every count 0 = up to date; tests compare against UP_TO_DATE, so a key added here is
 * pinned everywhere at once.
 */
export interface DayOutdated {
  weightCases: number;
  inactiveOrders: number;
  masterChanged: number;
  trucksChanged: number;
  /**
   * Customers on PLANNED loads whose location is not usable any more (`locationBlocksDelivery`, the
   * planner's test): a saved point an import marked LOW after planning, or one now outside the
   * delivery area. Their loads cannot be locked (plan-service locationGate); RE-PLAN leaves their
   * orders unserved, or plans them again once the pin is placed (owner's location rule, A5 second review).
   */
  locationBlocked: number;
  /**
   * Audit E1: PLANNED loads still drawn from a depot pin that was moved after the plan was made. Locked
   * and dispatched loads keep their planned origin (owner decision 13); RE-PLAN plans the rest from the new pin.
   */
  depotMoved: number;
  /**
   * Pallets (review of parts A and B): cases on PLANNED loads planned by pallets whose rows give other pallets with
   * the cases per pallet known now - a factor corrected under Products since planning (split.ts
   * rowPalletUnitsNow). RE-PLAN loads them by the figures now; meanwhile a load the new figure puts over
   * its bays cannot be locked (CAPACITY_PALLETS_NEW_FACTOR).
   */
  palletFactorCases: number;
  /**
   * Review of 9 Oct 2026: trucks with PLANNED loads taken out of service (deactivated under Trucks)
   * since the plan was made (snapshots.ts truckOutOfService). Their loads cannot be locked, loaded or
   * dispatched (plan-service truckGate); RE-PLAN moves their orders to the trucks in service. Locked
   * and loading loads on them are kept as they are (the plan screen says so).
   */
  trucksInactive: number;
  /**
   * Review of 9 Oct 2026: open orders the plan in use left unserved for their customer's data (no
   * usable location, a deactivated customer) that a re-plan would plan now: a usable location was
   * saved, or the customer reactivated (left-out-note.ts unservedNowPlannable).
   */
  unservedNowPlannable: number;
  /**
   * Cancel order (owner request 12 Oct 2026): cancelled orders still on PLANNED loads of the plan in use
   * that also hold an order still of the day (not cancelled, not moved to another day). Those loads
   * cannot be locked (plan-service cancelledOrdersGate); RE-PLAN takes the orders off. A load holding
   * nothing else is not counted: it is no work for a re-plan (carry-view holdsOnlyGone; the server
   * answers NOTHING_TO_PLAN when nothing else is open) and is left as it is, never loaded.
   */
  cancelledOnPlan: number;
  /**
   * Postpone order (owner request 12 Oct 2026), and Bring forward of today's orders: orders moved to a
   * later day that are still on PLANNED loads of the plan in use holding an order still of the day, as
   * cancelledOnPlan. Those loads are refused Lock (ORDERS_CARRIED) until RE-PLAN takes the orders off.
   */
  movedOnPlan: number;
  /**
   * Small truck only (owner request 13 Oct 2026): customers marked "Small truck only (3-ton)" with orders
   * on PLANNED loads whose truck (as it is now) is not small - no bays, or more than the company's "small
   * truck" bays (smallTruckMaxBays). A customer marked, or the setting lowered, after the plan was made.
   * Their loads cannot be locked, loaded or dispatched (plan-service smallTruckGate, 409 SMALL_TRUCK_ONLY);
   * RE-PLAN puts them on a small truck, or leaves them out with "Needs a small truck".
   */
  smallTruckBlocked: number;
}
export const UP_TO_DATE: Readonly<DayOutdated> = Object.freeze({
  weightCases: 0,
  inactiveOrders: 0,
  masterChanged: 0,
  trucksChanged: 0,
  locationBlocked: 0,
  depotMoved: 0,
  palletFactorCases: 0,
  trucksInactive: 0,
  unservedNowPlannable: 0,
  cancelledOnPlan: 0,
  movedOnPlan: 0,
  smallTruckBlocked: 0,
});

/** The orders the plan in use leaves unserved (the chosen option's unserved orders still open on this day). */
export interface DayUnserved {
  orders: number;
  cases: number;
  /**
   * Of them, the orders a re-plan could place now (left-out-note.ts replanCouldPlace): not those left
   * out for their customer's data until it is fixed, nor cases still heavier than any truck, and none
   * on a day that is over (bring them forward instead). Step 3 keeps RE-PLAN on only for these.
   */
  replan: number;
}

/** PR9: an order of this day brought forward from an earlier day (badge "Carried over from 26 Sep"). */
export interface CarriedInOrder {
  orderId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  cases: number;
  /** The date the order was first due (YYYY-MM-DD). */
  fromDate: string;
  /** Not in the plan in use yet (RE-PLAN adds it). */
  pending: boolean;
}

/**
 * Cancel order (owner request 12 Oct 2026): an order of this day that was cancelled - the day screen's
 * "Cancelled" list (greyed, with the reason, who and when, and Undo while the day is not over).
 */
export interface CancelledOrder {
  orderId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  cases: number;
  salesOrders: string[];
  linesWithoutInvoice: number;
  reason: string | null;
  note: string | null;
  /** "Customer cancelled", "Other: shop closed". */
  reasonText: string;
  /** Who cancelled it (null = the user was removed). */
  by: string | null;
  /** When (ISO time). */
  at: string;
  /** PLANNED loads of the plan in use still holding it ("T05 L2"). */
  onPlannedLoads: string[];
  /**
   * One of those loads also holds an order still of the day: RE-PLAN takes it off (until then that load
   * cannot be locked). False = every load holding it holds nothing else now: left as it is, never loaded.
   */
  replan: boolean;
  /** The day is not over: Undo is offered. */
  canUndo: boolean;
}

/** PR9: orders of this day brought forward to later days (not open here any more). */
export interface CarriedOut {
  orders: number;
  /** Cases carried (the copies' cases: the open part of each order). */
  cases: number;
  /** The days they went to (YYYY-MM-DD, sorted). */
  toDates: string[];
}

/**
 * `deliveries`: the load follows a write (a result recorded): the delivery results are read even while
 * a search runs (readResultsNow), whose polls otherwise leave them out.
 */
export async function getDayOverview(tenantId: string, opts: { date?: string | null; depotId?: string | null; deliveries?: boolean }) {
  const db = tenantDb(tenantId);
  const cfg = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
  const depots = await db.depot.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, lat: true, lng: true } });
  const depot = depots.find((d) => d.id === opts.depotId) ?? depots[0] ?? null;
  const date = opts.date && isRealIsoDate(opts.date) ? opts.date : tomorrowIso(cfg.timezone);
  const base = {
    date,
    today: todayIso(cfg.timezone),
    tomorrow: tomorrowIso(cfg.timezone),
    timezone: cfg.timezone,
    // Thorough's cap (THOROUGH_MAX_SEC), for the OPTIMIZE / RE-PLAN choice and the progress line,
    // and the choice pre-selected there: THOROUGH before the delivery day, QUICK on it.
    thoroughMaxSec: thoroughMaxSec(),
    searchModeDefault: defaultSearchMode(date, cfg.timezone, new Date()),
    cutoff: fmtHhmm(cfg.planningCutoffMin),
    depots,
    depot,
  };
  if (!depot) {
    return { ...base, orders: { count: 0, cases: 0, customers: 0, late: 0, weightKg: 0 }, cancelled: [] as CancelledOrder[], customers: [] as IssueCustomer[], productsWithoutWeight: [] as WeightGap[], productsWithoutPalletFactor: [] as PalletFactorGap[], weightsToApply: [] as WeightGap[], inactiveCustomers: 0, plan: null, pending: { orderIds: [] as string[], count: 0, cases: 0, late: 0, carried: 0 }, openOrders: 0, unserved: { orders: 0, cases: 0, replan: 0 } as DayUnserved, carriedIn: [] as CarriedInOrder[], carriedOut: null as CarriedOut | null, outdated: { ...UP_TO_DATE }, trucks: { active: 0, capacityCases: 0, withBays: 0, bays: 0, casesWithoutBays: 0, withPayload: 0 }, batches: [] };
  }
  const profiles = new Map<string, TypeProfileLike>((await db.customerTypeProfile.findMany()).map((p) => [p.customerType, p]));
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { country: true } });
  const area = parseServiceArea(cfg.serviceAreaJson, tenant?.country);
  const where = await ordersInScopeWhere(tenantId, depot.id, dateOnly(date));
  const orders = await prisma.order.findMany({
    where,
    include: {
      customer: { include: { windowConfirmedBy: { select: { name: true } } } },
      lines: { include: { product: { select: { code: true, name: true, weightPerCaseKg: true, casesPerPallet: true } } } },
    },
  });
  const byCustomer = new Map<string, IssueCustomer>();
  const plan = await currentPlan(tenantId, depot.id, date);
  // Loads of the plan in use: what frozen loads carry (per line, as buildDispatchRequest counts
  // it: a split order can be partly on a frozen load) and which orders sit on PLANNED loads.
  const onPlan = plan && orders.length
    ? await prisma.routeAssignment.findMany({
        where: { runId: plan.id, orderId: { in: orders.map((o) => o.id) } },
        select: {
          orderId: true,
          portionLinesJson: true,
          portionWeightKg: true,
          stopSnapshotJson: true,
          palletUnits: true,
          load: { select: { status: true, palletUnits: true, loadNo: true, truck: { select: { code: true, onlyOnDate: true, bays: true } } } },
        },
      })
    : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const frozenWhole = new Set<string>();
  const frozenLineCases = new Map<string, number>();
  const onPlannedLoad = new Set<string>();
  // The case weights each line's cases on PLANNED loads of the plan in use were planned with, as far
  // as the rows say (portionPlannedKgPerCase, the timetable check's rule). The open rest of an order
  // partly on a frozen load is planned with the product's weight at every optimize but never saved on
  // its line, so its PLANNED parts are the only record of the weight the plan in use carries.
  const plannedKgOfLine = new Map<string, number[]>();
  for (const a of onPlan) {
    if (!a.load) continue;
    if (a.load.status === 'PLANNED') {
      onPlannedLoad.add(a.orderId);
      const o = orderById.get(a.orderId);
      const kg = o ? portionPlannedKgPerCase(a, o.lines, !orderUsesLineWeights(o)) : null;
      for (const [lineId, k] of kg ?? []) plannedKgOfLine.set(lineId, [...(plannedKgOfLine.get(lineId) ?? []), k]);
      continue;
    }
    const pl = readPortionLines(a.portionLinesJson);
    if (!pl) frozenWhole.add(a.orderId);
    else for (const x of pl) frozenLineCases.set(x.lineId, (frozenLineCases.get(x.lineId) ?? 0) + x.cases);
  }
  // The option in use, with the orders it left unserved: those left out for a case heavier than any
  // truck (leftOutWhole), the ones still open (Step 3 says so), and those its customer's data kept out
  // that a re-plan would plan now (outdated.unservedNowPlannable).
  const chosen = plan?.chosenScenarioId
    ? await prisma.scenarioResult.findUnique({
        where: { id: plan.chosenScenarioId },
        include: { unservedOrders: { select: { orderId: true, reasonCode: true, portionLinesJson: true, portionCases: true } } },
      })
    : null;
  const d = chosen?.detailsJson as unknown as ScenarioDetails | undefined;
  const inScope = new Set(d?.scope ? [...d.scope.orderIds, ...d.scope.frozenOrderIds] : []);
  // Weights per order LINE (0 kg on a line = unknown), not per product: a product whose case
  // weight was entered or corrected after the orders were confirmed leaves those lines as they
  // are until the next optimize applies it. Only the open cases count: what frozen loads carry
  // keeps the kg it was loaded with (the same rule as the OPTIMIZE / RE-PLAN weight check).
  const noWeight = new Map<string, WeightGap & { kgPerCase: number }>();
  const toApply = new Map<string, WeightGap & { kgPerCase: number }>();
  // Pallets: open lines of products without a usable cases per pallet, with the case weight they are
  // planned with: the red list keeps only those OPTIMIZE refuses for (buildDispatchRequest's exclusions,
  // applied below once the trucks are read).
  const factorGaps: { o: (typeof orders)[number]; code: string; name: string; cases: number; kgPerCase: number }[] = [];
  // Why the plan in use is out of date although no new order is waiting (RE-PLAN enabled).
  const outdated: DayOutdated = { ...UP_TO_DATE };
  const inputsInUse = readPlanInputs(d?.inputs);
  // Pallets (review of parts A and B): rows on PLANNED loads planned by pallets whose cases per pallet were
  // corrected since (the factors the option was planned with are kept in its inputs).
  const plannedFactors = inputsInUse?.palletFactors ?? {};
  for (const a of onPlan) {
    if (a.load?.status !== 'PLANNED' || typeof a.load.palletUnits !== 'number') continue;
    const o = orderById.get(a.orderId);
    const now = o ? rowPalletUnitsNow(o.lines, a.portionLinesJson, a.palletUnits, plannedFactors) : null;
    if (now) outdated.palletFactorCases += now.cases;
  }
  const openCasesOf = new Map<string, number>();
  // The case weight each open line is planned with now (planningKgPerCase), for the unserved cases
  // heavier than any truck below.
  const kgPerCaseNow = new Map<string, number>();
  for (const o of orders) {
    if (frozenWhole.has(o.id) || o.status === 'DISPATCHED' || o.status === 'DELIVERED') continue;
    const orderLevel = !orderUsesLineWeights(o);
    // The open rest of an order partly on a frozen load is planned with the product's weight at
    // every optimize but never saved (the frozen part shares the line). It is out of date only while
    // a PLANNED part of the plan in use carries it with another case weight - planned at 0 kg, or
    // the weight was entered or corrected since (PR4 review: the check then blocks a load it now
    // overloads, CAPACITY_KG_NEW_WEIGHT); a re-plan plans it with the weight now.
    const partlyFrozen = o.lines.some((l) => (frozenLineCases.get(l.id) ?? 0) > 0);
    const plannedWithOtherKg = (l: (typeof o.lines)[number]) => (plannedKgOfLine.get(l.id) ?? []).some((k) => plannedKgDiffers(k, l.product.weightPerCaseKg));
    const kgPerCaseOf = planningKgPerCase({
      totalCases: o.totalCases,
      totalWeightKg: o.totalWeightKg,
      lines: o.lines.map((l) => ({ id: l.id, cases: l.cases, weightKg: l.weightKg, fromMaster: l.weightFromMaster, productKgPerCase: l.product.weightPerCaseKg })),
    });
    for (const [lineId, kg] of kgPerCaseOf) kgPerCaseNow.set(lineId, kg);
    let open = 0;
    for (const l of o.lines) {
      const cases = Math.max(0, l.cases - (frozenLineCases.get(l.id) ?? 0));
      if (cases <= 0) continue;
      open += cases;
      if (validPalletFactor(l.product.casesPerPallet) === null) {
        factorGaps.push({ o, code: l.product.code, name: l.product.name, cases, kgPerCase: kgPerCaseOf.get(l.id) ?? 0 });
      }
      const st = lineWeightStatus({ cases: l.cases, weightKg: l.weightKg, fromMaster: l.weightFromMaster }, l.product.weightPerCaseKg, orderLevel);
      if (st === 'KNOWN' || (st === 'MASTER' && partlyFrozen && !plannedWithOtherKg(l))) continue;
      const m = st === 'UNKNOWN' ? noWeight : toApply;
      const g = m.get(l.product.code) ?? { code: l.product.code, name: l.product.name, lines: 0, cases: 0, kgPerCase: l.product.weightPerCaseKg };
      g.lines++;
      g.cases += cases;
      m.set(l.product.code, g);
      if (st === 'MASTER' && inScope.has(o.id)) outdated.weightCases += cases;
    }
    if (open > 0) openCasesOf.set(o.id, open);
  }
  // A deactivated customer matters only while it has open orders (frozen and dispatched loads
  // keep theirs). Orders of it still on PLANNED loads were planned before it was deactivated.
  const inactiveOpen = new Map<string, { orders: number; onPlannedLoads: number }>();
  for (const o of orders) {
    if (o.customer.active || !openCasesOf.has(o.id)) continue;
    const g = inactiveOpen.get(o.customerId) ?? { orders: 0, onPlannedLoads: 0 };
    g.orders++;
    if (onPlannedLoad.has(o.id)) g.onPlannedLoads++;
    inactiveOpen.set(o.customerId, g);
  }
  for (const g of inactiveOpen.values()) outdated.inactiveOrders += g.onPlannedLoads;
  // Owner's location rule (A5 second review): an active customer on a PLANNED load whose location
  // is not usable now (a deactivated one is counted above; its location no longer matters).
  const blockedOnPlanned = new Set<string>();
  for (const o of orders) {
    if (o.customer.active && onPlannedLoad.has(o.id) && openCasesOf.has(o.id) && locationBlocksDelivery(o.customer, area)) blockedOnPlanned.add(o.customerId);
  }
  outdated.locationBlocked = blockedOnPlanned.size;
  // Small truck only (owner request 13 Oct 2026): a marked customer on a PLANNED load whose truck is not
  // small now, by the same test as LOCK's smallTruckGate (the truck's bays and the setting as they are now).
  const smallMax = smallTruckMaxBaysOf(cfg);
  const smallBlocked = new Set<string>();
  for (const a of onPlan) {
    if (a.load?.status !== 'PLANNED') continue;
    const o = orderById.get(a.orderId);
    if (o?.customer.smallTruckOnly && !isSmallTruck(a.load.truck?.bays ?? null, smallMax)) smallBlocked.add(o.customerId);
  }
  outdated.smallTruckBlocked = smallBlocked.size;
  // The orders the option in use left unserved that are still open on this day (not brought forward
  // to a later day, not dispatched since): the work a re-plan tries again (plan-status nothingToReplan,
  // the plan screen's Re-plan). Of them, the ones left out for their customer's data that a re-plan
  // would plan now: a pin saved or the customer reactivated since (review of 9 Oct 2026; before, the
  // day said "up to date" and RE-PLAN was off until someone thought of the plan screen's Re-plan).
  const unservedOpen = new Set<string>();
  const nowPlannable = new Set<string>();
  let unservedCases = 0;
  // Review of 5614ba9: of them, the orders a re-plan could place now (`unserved.replan`, which keeps
  // Step 3's RE-PLAN on; replanCouldPlace). Cases left out as heavier than any truck count only once
  // they are not any more (a case weight corrected, a bigger payload): checked below with the day's
  // trucks (`heavyLines`: the lines each row left out, every line of the order when it names none).
  const replan = new Set<string>();
  const heavyLines = new Map<string, string[]>();
  for (const u of chosen?.unservedOrders ?? []) {
    const o = orderById.get(u.orderId);
    if (!o || !openCasesOf.has(o.id)) continue;
    unservedOpen.add(o.id);
    unservedCases += u.portionCases ?? o.totalCases;
    const plannable = unservedNowPlannable(u.reasonCode, o.customer, area);
    if (plannable) nowPlannable.add(o.id);
    if (u.reasonCode === 'EXCEEDS_ANY_TRUCK_CAPACITY') {
      const ids = readPortionLines(u.portionLinesJson)?.map((x) => x.lineId) ?? o.lines.map((l) => l.id);
      heavyLines.set(o.id, [...(heavyLines.get(o.id) ?? []), ...ids]);
    } else if (replanCouldPlace(u.reasonCode, plannable, false)) replan.add(o.id);
  }
  outdated.unservedNowPlannable = nowPlannable.size;
  // Review F08: customers on PLANNED loads whose pin or receiving hours were corrected after the
  // plan was made, and trucks with PLANNED loads whose capacity or payload was corrected since. The
  // plan keeps what it was planned with; a re-plan adopts the new data.
  // The delivery time a stop would be planned with now (order-window stopWindowFor): one visit per
  // customer, so with all of its customer's orders of the day - on any load, left unserved or waiting -
  // except what its plan left out: orders with every case on loads locked before it was made, and
  // orders left unserved whole as heavier than any truck (plannedVisitOrders; the same rule as LOCK's
  // deliveryTimeGate and the plan screen, data collection review).
  const dayOrdersOf = new Map<string, (typeof orders)[number][]>();
  for (const o of orders) dayOrdersOf.set(o.customerId, [...(dayOrdersOf.get(o.customerId) ?? []), o]);
  const placements: OrderPlacement[] = onPlan.map((a) => ({
    orderId: a.orderId,
    frozen: !!a.load && a.load.status !== 'PLANNED',
    lines: readPortionLines(a.portionLinesJson),
    capturedAt: readStopSnapshot(a.stopSnapshotJson)?.capturedAt ?? null,
  }));
  const tooHeavy = leftOutWhole(chosen?.unservedOrders ?? []);
  const plannedStops = onPlan.flatMap((a) => {
    const o = orderById.get(a.orderId);
    if (a.load?.status !== 'PLANNED' || !o) return [];
    const eff = effectiveAttrs(o.customer, profiles, { serviceTimeMin: cfg.defaultServiceTimeMin });
    const sw = stopWindowFor(eff, plannedVisitOrders(dayOrdersOf.get(o.customerId) ?? [o], placements, readStopSnapshot(a.stopSnapshotJson)?.capturedAt ?? null, tooHeavy));
    return [{
      customerId: o.customerId,
      stopSnapshotJson: a.stopSnapshotJson,
      live: {
        name: o.customer.name, address: o.customer.address, lat: o.customer.lat, lng: o.customer.lng,
        hardStartMin: sw.hardStart, hardEndMin: sw.hardEnd, prefStartMin: sw.prefStart, prefEndMin: sw.prefEnd, promised: sw.promised,
      },
    }];
  });
  const plannedLoads = plan?.chosenScenarioId
    ? await prisma.planLoad.findMany({
        where: { runId: plan.id, tenantId, status: 'PLANNED' },
        select: { truckId: true, truckSnapshotJson: true, truck: { select: { capacityCases: true, capacityWeightKg: true, bays: true, active: true, onlyOnDate: true } } },
      })
    : [];
  // A load planned before origins were kept was planned from the pin its option was optimized
  // from, as the plan screen reads it (plan-detail: readLoadOrigin ?? inputs.depot; A6 review).
  const optimizedFrom = inputsInUse?.depot ?? null;
  const changed = plannedLoadsMasterChanged(
    plannedStops,
    plannedLoads.map((l) => ({
      truckId: l.truckId,
      truckSnapshotJson: l.truckSnapshotJson,
      live: l.truck
        ? { capacityCases: l.truck.capacityCases, capacityWeightKg: l.truck.capacityWeightKg, bays: l.truck.bays, outOfService: truckOutOfService(l.truck, base.today) }
        : null,
    })),
    { lat: depot.lat, lng: depot.lng },
    optimizedFrom ? { lat: optimizedFrom.lat, lng: optimizedFrom.lng } : null,
  );
  outdated.masterChanged = changed.customers;
  outdated.trucksChanged = changed.trucks;
  outdated.depotMoved = changed.depotMoved;
  outdated.trucksInactive = changed.trucksInactive;
  const onFrozenLoad = new Set(onPlan.filter((a) => a.load && a.load.status !== 'PLANNED').map((a) => a.orderId));
  // Each order's loads on the plan in use, for Cancel / Postpone ("T05 L2 (locked)").
  const loadsOf = new Map<string, string[]>();
  const leftOn = new Set<string>();
  for (const a of onPlan) {
    if (!a.load) continue;
    const text = `${a.load.truck ? shownTruckCode(null, a.load.truck) : 'Truck'} L${a.load.loadNo ?? '?'} (${a.load.status.toLowerCase()})`;
    const list = loadsOf.get(a.orderId) ?? [];
    if (!list.includes(text)) list.push(text);
    loadsOf.set(a.orderId, list);
    if (a.load.status === 'DISPATCHED' || a.load.status === 'COMPLETED') leftOn.add(a.orderId);
  }
  const orderTimeRow = (o: (typeof orders)[number]): DayOrderTime => {
    const time = orderTimeOf(o);
    return {
      orderId: o.id,
      cases: o.totalCases,
      salesOrders: [...new Set(o.lines.map((l) => l.salesOrderNo).filter((s): s is string => !!s))].sort(),
      time,
      text: time ? promisedText(time) : null,
      frozen: onFrozenLoad.has(o.id),
      loads: loadsOf.get(o.id) ?? [],
      left: leftOn.has(o.id) || o.status === 'DISPATCHED' || o.status === 'DELIVERED',
      linesWithoutInvoice: o.lines.filter((l) => !l.salesOrderNo?.trim()).length,
      // As buildDispatchRequest reads it: whole on a frozen load, or every case in frozen portions.
      allFrozen: frozenWhole.has(o.id) || allCasesOn(o.lines, frozenLineCases),
    };
  };
  for (const o of orders) {
    const c = o.customer;
    const cur = byCustomer.get(c.id);
    if (cur) {
      cur.orders++;
      cur.cases += o.totalCases;
      cur.orderTimes.push(orderTimeRow(o));
      continue;
    }
    const eff = effectiveAttrs(c, profiles, { serviceTimeMin: cfg.defaultServiceTimeMin });
    // A deactivated customer's open orders are left unserved at optimize (not delivered): that is
    // the only thing to show for it; its location no longer matters.
    const inactive = !c.active ? inactiveOpen.get(c.id) : undefined;
    const issues = c.active ? customerIssues(c, eff, area) : inactive ? [inactiveCustomerIssue(inactive.onPlannedLoads > 0)] : [];
    byCustomer.set(c.id, {
      customerId: c.id,
      code: c.code,
      branchCode: c.branchCode,
      name: c.name,
      customerType: c.customerType,
      priority: eff.priority,
      prioritySource: eff.prioritySource,
      serviceMin: eff.serviceMin,
      serviceSource: eff.serviceSource,
      window: describeWindows(eff),
      hardWindowStartMin: c.hardWindowStartMin,
      hardWindowEndMin: c.hardWindowEndMin,
      prefWindowStartMin: c.prefWindowStartMin,
      prefWindowEndMin: c.prefWindowEndMin,
      lat: c.lat,
      lng: c.lng,
      locationVerified: c.locationVerified,
      geocodeConfidence: c.geocodeConfidence,
      orders: 1,
      cases: o.totalCases,
      issues,
      blocking: issues.some((i) => i.blocking),
      inactive: !c.active,
      windowLabel: windowLabel(eff),
      windowSource: eff.windowSource,
      windowConfirmed: eff.windowConfirmed,
      windowConfirmedAt: c.windowConfirmedAt ? c.windowConfirmedAt.toISOString() : null,
      windowConfirmedBy: c.windowConfirmedBy?.name ?? null,
      phone: c.phone ?? null,
      smallTruckOnly: !!c.smallTruckOnly,
      // Only when set, so the day's answer is the same as before for customers without one.
      ...(c.loadingInstruction ? { loadingInstruction: c.loadingInstruction } : {}),
      ...(c.siteRadiusM ? { siteRadiusM: c.siteRadiusM } : {}),
      effWindow: { hardStart: eff.hardStart, hardEnd: eff.hardEnd, prefStart: eff.prefStart, prefEnd: eff.prefEnd },
      orderTimes: [orderTimeRow(o)],
    });
  }
  for (const c of byCustomer.values()) c.orderTimes.sort((a, b) => a.salesOrders.join().localeCompare(b.salesOrders.join()) || a.orderId.localeCompare(b.orderId));
  const customers = [...byCustomer.values()].sort(
    (a, b) => Number(b.blocking) - Number(a.blocking) || b.issues.length - a.issues.length || a.priority - b.priority || b.cases - a.cases,
  );

  let pending = { orderIds: [] as string[], count: 0, cases: 0, late: 0, carried: 0 };
  let planInfo = null;
  if (plan) {
    const job = await db.runJob.findFirst({ where: { runId: plan.id }, orderBy: { attemptNo: 'desc' } });
    if (d?.scope) {
      const p = orders.filter((o) => !inScope.has(o.id));
      pending = {
        orderIds: p.map((o) => o.id),
        count: p.length,
        cases: p.reduce((a, o) => a + o.totalCases, 0),
        late: p.filter((o) => o.isLate).length,
        // PR9: brought forward from earlier days (a re-plan adds them like late orders).
        carried: p.filter((o) => o.carriedFromOrderId).length,
      };
    }
    const loads = await db.planLoad.groupBy({ by: ['status'], where: { runId: plan.id }, _count: { _all: true } });
    // PR9: the loads that are this day's work - a load that never left the depot and holds only
    // orders brought forward to a later day is not (it stays in the plan for the record): Step 3
    // never says "unlock it" or "every load has left the depot" because of it.
    const ofDay = await db.planLoad.groupBy({
      by: ['status'],
      where: {
        runId: plan.id,
        OR: [
          { status: { in: ['DISPATCHED', 'COMPLETED'] } },
          // A load holding only cancelled orders (Cancel order) is not this day's work either.
          { assignments: { some: { order: { carriedToOrderId: null, cancelledAt: null } } } },
          { assignments: { none: {} } },
        ],
      },
      _count: { _all: true },
    });
    planInfo = {
      id: plan.id,
      version: plan.version,
      status: plan.status,
      reason: plan.reason,
      chosen: !!plan.chosenScenarioId,
      job: job
        ? {
            id: job.id,
            status: job.status,
            message: job.message,
            progressPct: job.progressPct,
            // For the progress line ("Searching ... - 6 min so far"): when it got a solver slot, and its mode.
            startedAt: job.startedAt?.toISOString() ?? null,
            searchMode: job.searchMode ?? null,
          }
        : null,
      loadsByStatus: Object.fromEntries(loads.map((g) => [g.status, g._count._all])),
      /** Loads by status without the ones that never left and hold only orders brought forward (PR9). */
      loadsOfDay: Object.fromEntries(ofDay.map((g) => [g.status, g._count._all])),
      summary: plan.summaryJson,
      reconciliationOk: (plan.reconciliationJson as { ok?: boolean } | null)?.ok ?? null,
    };
  }
  // PR9: brought forward from earlier days (the day screen's order list marks them), and orders of
  // this day brought forward to later days (no longer open here; the plan versions keep them).
  const pendingIds = new Set(pending.orderIds);
  const carriedIn: CarriedInOrder[] = orders
    .filter((o) => o.carriedFromOrderId)
    .map((o) => ({
      orderId: o.id,
      customerCode: o.customer.code,
      branchCode: o.customer.branchCode,
      customerName: o.customer.name,
      cases: o.totalCases,
      fromDate: isoOf(o.carriedFromDate ?? o.deliveryDate),
      pending: !plan?.chosenScenarioId || pendingIds.has(o.id),
    }))
    .sort((a, b) => a.fromDate.localeCompare(b.fromDate) || a.customerCode.localeCompare(b.customerCode));
  const away = await prisma.order.findMany({
    where: { ...where, carriedToOrderId: { not: null } },
    select: { carriedTo: { select: { deliveryDate: true, totalCases: true } } },
  });
  // Cancel order (owner request 12 Oct 2026): this day's cancelled orders (ordersInScopeWhere leaves
  // them out of everything above), with where the plan in use still holds them.
  const cancelledRows = (
    await prisma.order.findMany({
      where: { tenantId, depotId: depot.id, deliveryDate: dateOnly(date), cancelledAt: { not: null } },
      select: {
        id: true,
        totalCases: true,
        cancelledAt: true,
        cancelReason: true,
        cancelNote: true,
        cancelledBy: { select: { name: true } },
        customer: { select: { code: true, branchCode: true, name: true } },
        lines: { select: { salesOrderNo: true } },
      },
      orderBy: [{ cancelledAt: 'desc' }, { id: 'asc' }],
    })
  ).filter((o) => !!o.cancelledAt);
  const cancelledPlaced =
    plan && cancelledRows.length
      ? await prisma.routeAssignment.findMany({
          where: { runId: plan.id, orderId: { in: cancelledRows.map((o) => o.id) } },
          select: { orderId: true, load: { select: { id: true, status: true, loadNo: true, truck: { select: { code: true, onlyOnDate: true } } } } },
        })
      : [];
  // The PLANNED loads of the plan in use that hold an order still of the day, and the orders on them
  // that left the day (cancelled, or moved to a later day): only those make the plan out of date. A
  // load holding nothing else is no work for a re-plan (carry-view holdsOnlyGone), so Step 3 never says
  // RE-PLAN because of it next to "nothing needs to be re-planned". A day that is over is not re-planned.
  const plannedRows = plan?.chosenScenarioId && date >= base.today
    ? await prisma.routeAssignment.findMany({
        where: { runId: plan.id, load: { is: { status: 'PLANNED' } } },
        select: { orderId: true, loadId: true, order: { select: { cancelledAt: true, carriedToOrderId: true } } },
      })
    : [];
  const loadsWithDayOrders = new Set(plannedRows.filter((a) => a.loadId && !a.order.cancelledAt && !a.order.carriedToOrderId).map((a) => a.loadId!));
  const goneOnBusyLoads = (pick: (o: { cancelledAt: Date | null; carriedToOrderId: string | null }) => boolean) =>
    new Set(plannedRows.filter((a) => a.loadId && loadsWithDayOrders.has(a.loadId) && pick(a.order)).map((a) => a.orderId)).size;
  const cancelled: CancelledOrder[] = cancelledRows.map((o) => {
    const onPlanned = [
      ...new Set(
        cancelledPlaced
          .filter((a) => a.orderId === o.id && a.load?.status === 'PLANNED')
          .map((a) => `${a.load!.truck ? shownTruckCode(null, a.load!.truck) : 'Truck'} L${a.load!.loadNo}`),
      ),
    ];
    return {
      orderId: o.id,
      customerCode: o.customer.code,
      branchCode: o.customer.branchCode,
      customerName: o.customer.name,
      cases: o.totalCases,
      salesOrders: [...new Set(o.lines.map((l) => l.salesOrderNo?.trim()).filter((s): s is string => !!s))].sort(),
      linesWithoutInvoice: o.lines.filter((l) => !l.salesOrderNo?.trim()).length,
      reason: o.cancelReason,
      note: o.cancelNote,
      reasonText: orderActionReasonText(o.cancelReason, o.cancelNote),
      by: o.cancelledBy?.name ?? null,
      at: o.cancelledAt!.toISOString(),
      onPlannedLoads: onPlanned,
      replan: cancelledPlaced.some((a) => a.orderId === o.id && a.load?.status === 'PLANNED' && loadsWithDayOrders.has(a.load.id)),
      canUndo: date >= base.today,
    };
  });
  outdated.cancelledOnPlan = goneOnBusyLoads((o) => !!o.cancelledAt);
  outdated.movedOnPlan = goneOnBusyLoads((o) => !o.cancelledAt && !!o.carriedToOrderId);
  const carriedOut: CarriedOut | null = away.length
    ? {
        orders: away.length,
        cases: away.reduce((a, o) => a + (o.carriedTo?.totalCases ?? 0), 0),
        toDates: [...new Set(away.flatMap((o) => (o.carriedTo ? [isoOf(o.carriedTo.deliveryDate)] : [])))].sort(),
      }
    : null;
  // The day's trucks: a one-day hired truck (the hire suggestion) only on its own date.
  const trucks = await db.truck.findMany({
    where: trucksOfDayWhere(depot.id, dateOnly(date)),
    select: { id: true, code: true, capacityCases: true, capacityWeightKg: true, maxTripsPerDay: true, bays: true },
  });
  const bayTrucks = trucks.filter((t) => typeof t.bays === 'number');
  // The heaviest case a truck of the day can take (maxCasePayloadKg; null = no limit), as
  // buildDispatchRequest reads it: with the loads each truck has left today (its locked / loading /
  // dispatched loads counted). Read only when needed, once.
  let maxCaseKg: number | null | undefined;
  const maxCaseKgNow = async () => {
    if (maxCaseKg !== undefined) return maxCaseKg;
    const frozenTrips = plan
      ? await db.planLoad.groupBy({ by: ['truckId'], where: { runId: plan.id, status: { not: 'PLANNED' } }, _count: { _all: true } })
      : [];
    const frozenOf = new Map(frozenTrips.map((g) => [g.truckId, g._count._all]));
    const fleet: FleetTruck[] = trucks.map((t) => ({
      code: t.code,
      cases: t.capacityCases,
      kg: t.capacityWeightKg > 0 ? t.capacityWeightKg : null,
      tripsLeft: (t.maxTripsPerDay || cfg.maxTripsPerTruck) - (frozenOf.get(t.id) ?? 0),
      ...(typeof t.bays === 'number' ? { palletUnits: palletRoomUnits(t.bays, cfg.palletFillPct ?? PALLET_FILL_DEFAULT) } : {}),
    }));
    maxCaseKg = maxCasePayloadKg(fleet);
    return maxCaseKg;
  };
  // Unserved cases heavier than any truck: a re-plan places them once one of their lines fits a truck
  // now (the case weight corrected, or a truck with a bigger payload).
  for (const [orderId, lineIds] of heavyLines) {
    const maxKg = await maxCaseKgNow();
    const stillTooHeavy = lineIds.every((id) => caseHeavierThanAnyTruck(kgPerCaseNow.get(id) ?? 0, maxKg));
    if (replanCouldPlace('EXCEEDS_ANY_TRUCK_CAPACITY', false, stillTooHeavy)) replan.add(orderId);
  }
  // Pallets: the products OPTIMIZE / RE-PLAN refuse for (PALLET_FACTOR_REQUIRED), only with trucks with
  // bays. buildDispatchRequest looks for factors after it has left out the orders of deactivated
  // customers, of customers without a usable location and the cases heavier than any truck (pallets
  // review: the red list named them although OPTIMIZE does not refuse for them), so this list does too.
  const noFactor = new Map<string, PalletFactorGap>();
  if (bayTrucks.length && factorGaps.length) {
    const maxKg = await maxCaseKgNow();
    for (const g of factorGaps) {
      if (!g.o.customer.active || locationBlocksDelivery(g.o.customer, area) || caseHeavierThanAnyTruck(g.kgPerCase, maxKg)) continue;
      const f = noFactor.get(g.code) ?? { code: g.code, name: g.name, lines: 0, cases: 0 };
      f.lines++;
      f.cases += g.cases;
      noFactor.set(g.code, f);
    }
  }
  const batches = await db.uploadBatch.findMany({
    where: { OR: [{ deliveryDate: dateOnly(date) }, { orders: { some: { deliveryDate: dateOnly(date) } } }], depotId: depot.id },
    orderBy: { uploadedAt: 'desc' },
    take: 20,
    select: { id: true, fileName: true, status: true, uploadedAt: true, validRows: true, errorRows: true, isLate: true, lateReason: true },
  });
  // Delivery outcome (owner request 4 Oct 2026, spec section 10.3): the day's results, the stops of
  // loads that are back without one, the late-dispatch notes. Read on their own: a failure here never
  // keeps the day screen from loading (the card then says it could not be read).
  // Not on the polls while a search runs (every 3 s for up to 20 min): undefined = "not read now", the
  // screen keeps the card it has (a search never changes the results). A load after a recorded result
  // (`opts.deliveries`) reads them all the same.
  let deliveries: DayDeliveries | null | undefined = null;
  const searching = !!plan && planSearching({ status: plan.status }, planInfo?.job ? { status: planInfo.job.status } : null);
  if (plan && !readResultsNow({ searching, seen: true, afterWrite: !!opts.deliveries })) deliveries = undefined;
  else if (plan) {
    try {
      deliveries = await dayDeliveries(tenantId, depot.id, date);
    } catch (e) {
      console.error('[day] delivery results not read', (e as Error)?.message ?? e);
    }
  }
  return {
    ...base,
    orders: {
      count: orders.length,
      cases: orders.reduce((a, o) => a + o.totalCases, 0),
      weightKg: Math.round(orders.reduce((a, o) => a + o.totalWeightKg, 0)),
      customers: byCustomer.size,
      late: orders.filter((o) => o.isLate).length,
    },
    customers,
    blockingCount: customers.filter((c) => c.blocking).length,
    missingLocation: customers.filter((c) => !c.inactive && coordStatus(c.lat, c.lng, area) === 'MISSING').length,
    /** Deactivated customers that still have open orders (not on a frozen load). */
    inactiveCustomers: customers.filter((c) => c.inactive && c.blocking).length,
    /** Lines with no weight at all (no case weight on the product either): counted as 0 kg. */
    productsWithoutWeight: [...noWeight.values()].sort((a, b) => b.cases - a.cases || a.code.localeCompare(b.code)),
    /** Lines whose product's case weight (entered or corrected since) gives them another kg: applied at the next optimize. */
    weightsToApply: [...toApply.values()].sort((a, b) => b.cases - a.cases || a.code.localeCompare(b.code)),
    /**
     * Pallets (owner decision 4 Oct 2026): with trucks with bays at this depot, the products of the open
     * lines without a usable cases per pallet that OPTIMIZE / RE-PLAN refuse for until they are entered
     * under Products (PALLET_FACTOR_REQUIRED): not those of deactivated customers, of customers without a
     * usable location, or cases heavier than any truck (left unserved before the factors are looked at).
     * Empty without bay trucks.
     */
    productsWithoutPalletFactor: [...noFactor.values()].sort((a, b) => b.cases - a.cases || a.code.localeCompare(b.code)),
    plan: planInfo,
    pending,
    /**
     * Orders of the day with cases not yet on a locked, loading or dispatched load of the plan in
     * use. 0 while orders exist = nothing left to plan (OPTIMIZE / RE-PLAN answer NOTHING_TO_PLAN).
     */
    openOrders: openCasesOf.size,
    /**
     * Review of 9 Oct 2026 (ui-dispatch-2): the orders the plan in use leaves unserved that are still
     * open on this day, with their cases. Step 3 never says "up to date with all orders" while there
     * are any. It keeps RE-PLAN on, and the step not done, only for `replan`: those a re-plan could
     * place now (review of 5614ba9; before, any unserved order did, also a customer still without a
     * pin). None on a day that is over: its orders are brought forward to a later day, not re-planned.
     */
    unserved: (plan?.chosenScenarioId
      ? { orders: unservedOpen.size, cases: unservedCases, replan: date < base.today ? 0 : replan.size }
      : { orders: 0, cases: 0, replan: 0 }) as DayUnserved,
    carriedIn,
    carriedOut,
    /** Cancel order (owner request 12 Oct 2026): this day's cancelled orders, newest first (the "Cancelled" list). */
    cancelled,
    /**
     * The plan in use is out of date without a new order waiting: open cases on it whose case
     * weight was entered or corrected since, orders of customers deactivated since that are still
     * on planned loads, customers on planned loads whose pin or receiving hours were corrected
     * (masterChanged), trucks with planned loads whose capacity or payload was corrected
     * (trucksChanged), customers on planned loads whose location is not usable any more
     * (locationBlocked), planned loads drawn from a depot pin moved since (depotMoved, audit E1),
     * cases on planned loads whose cases per pallet was corrected since (palletFactorCases), trucks
     * with planned loads taken out of service since (trucksInactive), unserved orders whose
     * customer got a usable location or was reactivated since (unservedNowPlannable), cancelled
     * orders still on planned loads (cancelledOnPlan), and small-truck-only customers on planned
     * loads whose truck is not small now (smallTruckBlocked). RE-PLAN applies them all.
     */
    outdated: plan?.chosenScenarioId ? outdated : { ...UP_TO_DATE },
    trucks: {
      active: trucks.length,
      capacityCases: trucks.reduce((a, t) => a + t.capacityCases, 0),
      // Pallets: the trucks with bays and their bays per load round; the other trucks' cases.
      withBays: bayTrucks.length,
      bays: bayTrucks.reduce((a, t) => a + (t.bays ?? 0), 0),
      casesWithoutBays: trucks.filter((t) => typeof t.bays !== 'number').reduce((a, t) => a + t.capacityCases, 0),
      // Trucks with a payload: only then does OPTIMIZE ask about lines without a weight (a payload of 0 is
      // no weight limit, owner decisions of 4 Oct 2026; start-optimize.ts gate).
      withPayload: trucks.filter((t) => t.capacityWeightKg > 0).length,
    },
    batches: batches.map((b) => ({ ...b, uploadedAt: b.uploadedAt.toISOString() })),
    serviceArea: area,
    runDateIso: isoOf(dateOnly(date)),
    /** Settings (owner decisions 1 Oct 2026, items 3 and 4): the loading gate, and the days ahead of the data-to-collect list. */
    dataRule: { on: cfg.requireDataBeforeLoading, days: cfg.dataCollectDays },
    /**
     * With the loading gate on: the active customers of this day that miss a usable location or a
     * delivery window (own confirmed hours, or a delivery time on one of their orders). Their loads
     * are planned, but cannot be locked, loaded or dispatched (plan-service dataGate).
     */
    loadingGaps: cfg.requireDataBeforeLoading ? dayLoadingGaps(customers, area) : ([] as DataGap[]),
    /** Delivery results of the day (null without a plan, or when they could not be read; absent while a search runs: keep the last). */
    deliveries,
  };
}

/**
 * The day's loading gaps (item 3), by the gate's own rule (`dataGaps`) on the day's customers and order
 * times. Only orders not wholly on locked (or later) loads: the gate judges a load only when it leaves
 * PLANNED, so a customer whose orders are all on locked, loading or dispatched loads is never refused
 * by it and is not listed (data collection review; a missing location there is in step 2's red list,
 * the always-on location rule). An order only partly there (a split part) still counts: its other part
 * is on a PLANNED load, or still to plan, and LOCK of that load judges it (third review).
 */
export function dayLoadingGaps(customers: readonly IssueCustomer[], area: ServiceArea): DataGap[] {
  const active = customers.filter((c) => !c.inactive);
  return dataGaps(
    active.map((c) => ({ id: c.customerId, code: c.code, branchCode: c.branchCode, name: c.name, lat: c.lat, lng: c.lng, locationVerified: c.locationVerified, geocodeConfidence: c.geocodeConfidence, windowConfirmedAt: c.windowConfirmedAt })),
    active.flatMap((c) => c.orderTimes.filter((t) => !t.allFrozen).map((t) => ({ customerId: c.customerId, deliveryStartMin: t.time?.startMin ?? null, deliveryEndMin: t.time?.endMin ?? null }))),
    area,
  );
}
