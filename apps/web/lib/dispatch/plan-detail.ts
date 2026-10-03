/**
 * Everything the dispatcher reviews for one plan version - used by the plan screen AND the
 * Excel export so both always show identical numbers.
 */
import { Prisma } from '@prisma/client';
import { tenantDb } from '../tenant';
import { effectiveAttrs, describeWindows, type EffectiveAttrs, type TypeProfileLike } from './customer-attrs';
import { leftOutWhole, plannedVisitOrders, promisedText, stopWindowFor, type OrderPlacement, type OrderTimeColumns } from './order-window';
import { aggregateSkus, type Reconciliation } from './reconcile';
import type { ChangeSummary, DailySummary } from './summary';
import { feasibilityInputFromRows, isDispatchDetails, legacyPlanFacts, ordersInScopeWhere, type ScenarioDetails } from './plan-service';
import { checkPlanFeasibility, feasibilityGateMode, type PlanFeasibility, type TruckTiming } from './feasibility';
import {
  depotMovedChange,
  parseLoadBreak,
  readLoadOrigin,
  readPlanInputs,
  readStopSnapshot,
  readTruckSnapshot,
  stopMasterChanges,
  truckMasterChanges,
  type LoadBreak,
  type MasterChange,
  type PlanSettings,
  type StopFacts,
} from './snapshots';
import { isSupersededRun } from './plan-status';
import { driverSetByDispatcher, isCarriedFrozen, isHandSetDriver } from './load-state';
import { driverChangeWarnings, noteParts } from './driver-links';
import { orderIdOf, portionPlannedKgPerCase, readPortionLines, rowLines, rowLinesKg, splitPartLabels } from './split';
import { earlyPriorities, earlyStarts, optionTradeoffs, physicalTruckCount, planSignature, preferenceFigures, type OptionFacts } from './plan-options';
import type { PreferencePenalties, SearchMode, SearchReport } from '@routeiq/shared-types';
import { defaultSearchMode, searchOptionOf, thoroughMaxSec, type SearchOption } from './search-mode';
import { lineWeightStatus, orderUsesLineWeights, plannedKgDiffers, roundKg } from './weights';
import { DEFAULT_TZ, fmtWindow, isoOf, todayIso } from './time';
import { carriedLoadShows } from './carry-view';
import { readLoadCost, type LoadCostBreakdown } from './costs';
import { withPlainSolverCodes } from './solver-status';
import { isDispatchPlanShape } from './legacy-runs';
import { stuckPlanState, type StuckState } from './stuck-plan';
import { isOptimizing } from '../jobs/optimize-job';

export interface DetailStop {
  sequence: number;
  customerId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  customerType: string | null;
  lat: number | null;
  lng: number | null;
  priority: number;
  etaMin: number | null;
  serviceStartMin: number | null;
  departureMin: number | null;
  waitMin: number | null;
  /** The hours the stop was planned with: "Promised 10:00–11:00" when an order of it had its own delivery time. */
  window: string;
  hardWindow: string | null;
  /** "Promised 10:00–11:00" (urgent / promised time of one of its orders, owner decision 1 Oct 2026); null = the customer's hours. */
  promised: string | null;
  serviceMin: number;
  cases: number;
  weightKg: number;
  legKm: number;
  cumulativeKm: number | null;
  hardWindowOk: boolean | null;
  prefWindowOk: boolean | null;
  late: boolean;
  orderIds: string[];
  salesOrders: string[];
  skus: { productCode: string; productName: string; cases: number; weightKg: number }[];
  mapsUrl: string | null;
  /** Customer master address (free text), for the driver sheet. */
  address: string | null;
  /** Notes on the orders of this stop (from the order file / late-order entry). */
  notes: string[];
  /** Customer master access / receiving notes (gate, forklift, contact...), as they are NOW: contact
   * details stay live like the driver's phone, so a correction reaches the driver sheet (review of PR4). */
  accessNotes: string | null;
  /** Split delivery: this stop is part `part` of the customer's `parts` deliveries on trucks;
   * `restUnserved` = more of the customer's cases are on the unserved list. */
  split: { part: number; parts: number; restUnserved: boolean } | null;
  /**
   * Review F08: true = the pin, hours, name and address above are the ones the stop was PLANNED
   * with (its snapshot); false = a stop planned before snapshots existed, shown with today's
   * customer data. Access notes are always today's.
   */
  snapshot: boolean;
  /** What changed in the customer master since planning (never applied silently: re-plan to adopt it). */
  masterChanged: MasterChange[];
  /**
   * PR9: an order of this stop was brought forward from an earlier day: the date it was first due
   * (YYYY-MM-DD, the earliest of the stop's orders); null = none. Badge "Carried over from 26 Sep".
   */
  carriedFrom: string | null;
  /**
   * PR9: an order of this stop was brought forward to a later day (YYYY-MM-DD): not delivered on this
   * day. Only on a load that never left (PLANNED, LOCKED, LOADING): a dispatched or completed stop
   * was delivered, also when the rest of its split order was carried.
   */
  carriedTo: string | null;
  /**
   * The order lines of this stop as planned: one entry per order line (a split part's own cases), no
   * aggregation - from the same row lines as `skus` (rowLinesKg). The driver page lists them per
   * order, and a partly-delivered result names their line ids (owner request 4 Oct 2026). The Excel
   * workbook and the PDF do not read it.
   */
  orderLines: DetailOrderLine[];
  /**
   * The receiving hours the stop was planned with, as minutes from midnight (the structured `window`;
   * with a promised time the hard pair is that time). Null only for a stop without a snapshot whose
   * customer has no hours.
   */
  plannedHours: { hardStart: number | null; hardEnd: number | null; prefStart: number | null; prefEnd: number | null } | null;
  /** The promised delivery time of an order of this stop, as minutes (the structured `promised`); null = none. */
  promisedWindow: { startMin: number | null; endMin: number | null } | null;
}

export interface DetailOrderLine {
  orderId: string;
  lineId: string;
  salesOrderNo: string | null;
  productCode: string;
  productName: string;
  cases: number;
}

export interface DetailLoad {
  id: string;
  truckId: string;
  truckCode: string;
  truckCapacityCases: number;
  truckPayloadKg: number;
  driverId: string | null;
  driverName: string | null;
  driverPhone: string | null;
  /**
   * The dispatcher chose this driver by hand (the row's marker, isHandSetDriver; set by the Driver
   * list and by Keep): a re-plan or "Use instead" keeps it on this truck and trip ("picked by hand").
   * False: RouteIQ filled it in, or there is no driver.
   */
  driverHandSet: boolean;
  loadNo: number;
  status: string;
  /** Kept unchanged from the previous version: carried by a re-plan and frozen (isCarriedFrozen). */
  carried: boolean;
  departMin: number;
  returnMin: number;
  distanceKm: number;
  durationMin: number;
  cases: number;
  weightKg: number;
  utilizationPct: number;
  fuelLitres: number | null;
  fuelCost: number;
  operatingCost: number;
  /** The load's cost breakdown under the one cost model (review F17); null = costed the earlier way. */
  cost: LoadCostBreakdown | null;
  returnLegKm: number;
  distanceIsEstimated: boolean;
  stops: DetailStop[];
  manifest: { productCode: string; productName: string; cases: number; weightKg: number }[];
  /** The truck code and capacities above are the ones the load was planned with (false: today's truck). */
  truckSnapshot: boolean;
  /**
   * Audit E1 (owner decision 13): the depot pin this load starts from and returns to - the one it was
   * planned from (its truck snapshot; the option's depot for loads planned before it was kept). The
   * map, the road shapes, the route links, WhatsApp text and sheets draw the load from here.
   */
  origin: { lat: number; lng: number };
  /** Truck capacity changed since planning; the depot pin moved since planning (kind DEPOT). */
  masterChanged: MasterChange[];
  /** The timetable check of this load's truck-day (review F04); null = the version has no applied plan. */
  timing: { status: TruckTiming; ok: boolean } | null;
  /**
   * PR9: orders on this load brought forward to a later day (it cannot be locked, loaded or dispatched
   * with them); always 0 on a load that left (what left was delivered, never carried).
   */
  carriedAway: number;
  /** The driver break planned with this load (PlanLoad.breakJson); null = none on this load. */
  break: LoadBreak | null;
  /** The truck is hired from outside (Truck.hired, as it is now): a badge on the plan and the sheets. */
  hired?: boolean;
}

export interface DetailUnserved {
  orderId: string;
  customerId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  cases: number;
  weightKg: number;
  priority: number;
  reasonCode: string;
  reasonMessage: string | null;
  late: boolean;
  salesOrders: string[];
  /** Split delivery: only these cases of the order are unserved; the rest is on a truck. */
  partial: boolean;
  /** PR9: brought forward from an earlier day: the date it was first due (YYYY-MM-DD). */
  carriedFrom: string | null;
  /** PR9: brought forward to a later day since (YYYY-MM-DD): planned there, not a problem of this plan. */
  carriedTo: string | null;
}

export interface PlanDetail {
  run: {
    id: string;
    version: number;
    status: string;
    reason: string;
    reasonNote: string | null;
    runDate: string;
    depot: { id: string; code: string; name: string; lat: number; lng: number };
    parentRunId: string | null;
    createdAt: string;
    supersededAt: string | null;
    chosenScenario: string | null;
  };
  summary: DailySummary | null;
  reconciliation: Reconciliation | null;
  change: ChangeSummary | null;
  scenarios: {
    id: string;
    name: string;
    status: string;
    solverStatus: string;
    solverTimeSec: number;
    /**
     * Physical trucks of the day with this option: its new loads' trucks + the trucks of the
     * locked, loading and dispatched loads it was planned around (PR7, B3).
     */
    trucksUsed: number;
    /** This option's NEW loads. */
    trips: number;
    /** The locked, loading and dispatched loads the option was planned around (the day's loads = trips + frozenLoads). */
    frozenLoads: number;
    /** km of this option's NEW loads. */
    totalKm: number;
    /**
     * The whole day's km with this option: the kept loads' stored km + its new loads' (PR7 review),
     * rounded like the KPI, so the option in use shows the KPI's km.
     */
    dayKm: number;
    totalDurationMin: number;
    /** This option's NEW loads (what the optimizer planned). */
    operatingCost: number;
    /**
     * The whole day with this option: the locked, loading and dispatched loads it was planned around
     * (their stored cost) + its new loads. What the plan in use's KPI shows (review F17).
     */
    dayOperatingCost: number;
    /** The option was costed with the whole-day driver pay (cost_version 2). */
    costVersion: number | null;
    /** Legs planned on estimated distance (review F18); null from an older solver. */
    estimatedLegs: number | null;
    avgUtilizationPct: number;
    unservedOrders: number;
    distanceIsEstimated: boolean;
    provider: string;
    objective: ScenarioDetails['objective'] | null;
    /** The preferences RECOMMENDED also values, in OMR-equivalent (not money); null from an older optimizer. */
    preference: PreferencePenalties | null;
    /** preference window + early + continuity; null for an option from an optimizer that did not report them (before PR5). */
    preferenceCost: number | null;
    /** The preferred-hours part alone (for an older option the only part known); null unknown. */
    preferredHoursCost: number | null;
    /** What this option gains over the others, or that it is the same plan (PR7, N1); null when there is nothing to compare. */
    tradeoff: string | null;
    chosen: boolean;
    /** The optimizer's own timetable check of this option (null: an option from before the check existed). */
    feasibility: { status: string; timing: string; violations: number } | null;
    /** The kg unit every weight check of this option used (0.1, audit F08); null: an optimizer before it (whole kg, rounded up). */
    weightUnitKg: number | null;
    /** true: only new overtime counted when this option chose trucks (audit E4); null: an optimizer before it. */
    newOvertimeOnly: boolean | null;
    /** The receiving-hours rule this option was made with (the solver's echo); null: unloading only had to start by closing. */
    windowRule?: 'FINISH' | null;
    /** The driver-break rule this option was made with (the solver's echo); null: no break was planned. */
    breakRule?: { lengthMin: number; startFromMin: number; startToMin: number } | null;
  }[];
  loads: DetailLoad[];
  unserved: DetailUnserved[];
  /**
   * A daily dispatch plan (loads, a RECOMMENDED option or a later version; legacy-runs.ts): it has the
   * dispatch Excel workbook, also when every order is unserved and it has no load (audit F16). The
   * driver sheets (PDF) need loads. Always set by getPlanDetail; optional for older fixtures.
   */
  isDispatchPlan?: boolean;
  versions: { id: string; version: number; status: string; reason: string; reasonNote: string | null; createdAt: string; changeText: string | null }[];
  job: {
    id: string;
    status: string;
    message: string | null;
    progressPct: number;
    startedAt: string | null;
    finishedAt: string | null;
    /** QUICK or THOROUGH; null on jobs from before search modes. */
    searchMode?: string | null;
  } | null;
  /**
   * How the applied plan was searched (Quick / Thorough, how long, why it stopped); null for a plan
   * from before search modes or without an applied plan.
   */
  search?: SearchReport | null;
  /**
   * The alternative in use (MIN_TRUCKS, MIN_DISTANCE) and its own search limit: `search` is the
   * recommended plan's search, and the alternative searched after it (searchResultText says so).
   * null when RECOMMENDED is in use (skeptic review of the long-search PR).
   */
  searchOption?: SearchOption | null;
  /** Thorough's cap in seconds (THOROUGH_MAX_SEC): the Re-plan choice and the progress line. */
  thoroughMaxSec?: number;
  /**
   * The Re-plan choice pre-selected when the plan was read: THOROUGH before the plan's delivery day,
   * QUICK on it. The screen works it out again from the clock when Re-plan is pressed (`timezone`).
   */
  searchModeDefault?: SearchMode;
  /** The company's timezone: the Re-plan choice is worked out from the clock when it is asked (searchModeNow). */
  timezone?: string;
  warnings: string[];
  /**
   * Orders of the day that the applied plan does not contain yet (uploaded or recorded after it).
   * With no PLANNED load and nothing unserved, 0 here means a re-plan has nothing to plan.
   * Always 0 for a superseded version or one without an applied plan.
   */
  pendingOrders?: number;
  /** The timetable check per truck-day (review F04): what LOCK / LOADING / DISPATCH are gated on. */
  feasibility?: PlanFeasibility | null;
  /** enforce: a truck-day that fails the check cannot be locked, loaded or dispatched; warn: operator switch FEASIBILITY_GATE=warn. */
  feasibilityGate?: 'enforce' | 'warn';
  /** The tenant settings the plan in use was built with (null: an option from before they were kept). */
  planSettings?: PlanSettings | null;
  /** PR9: orders of this plan (on its loads or unserved) brought forward from earlier days. */
  carriedIn?: CarrySummary | null;
  /** PR9: orders of this plan brought forward to later days since: not delivered on this day, planned there. */
  carriedOut?: CarrySummary | null;
  /**
   * PR9: the company's today (YYYY-MM-DD, its timezone) when the plan was read. A load of today
   * holding an order brought forward to tomorrow says "re-plan today" / "unlock" on every plan
   * screen (carriedLoadTitle), also the standalone plan version page, like the 409 ORDERS_CARRIED.
   */
  today?: string;
  /**
   * Audit F09: the version is shown as optimizing but its optimization has ended or was lost (a
   * stuck plan): what the screen says, and whether a supervisor may reset it now. null = not stuck.
   */
  stuck?: StuckState | null;
}

/** PR9: orders brought forward, in one line: how many, their cases and the days (first due, or went to). */
export interface CarrySummary {
  orders: number;
  cases: number;
  /** YYYY-MM-DD, sorted: the days the orders were first due (carriedIn) or went to (carriedOut). */
  dates: string[];
}

/** "hard 06:00–14:00, preferred 07:00–10:00" from planned hours (describeWindows reads only these four). */
function plannedWindows(h: { hardStartMin: number | null; hardEndMin: number | null; prefStartMin: number | null; prefEndMin: number | null; promised?: StopFacts['promised'] }) {
  const eff = { hardStart: h.hardStartMin, hardEnd: h.hardEndMin, prefStart: h.prefStartMin, prefEnd: h.prefEndMin } as EffectiveAttrs;
  const promised = h.promised ? promisedText(h.promised) : null;
  return { window: promised ?? describeWindows(eff), hardWindow: h.hardStartMin !== null || h.hardEndMin !== null ? fmtWindow(h.hardStartMin, h.hardEndMin) : null, promised };
}

/** How long the consistent read may wait for a connection and run (it takes no locks). */
export const PLAN_DETAIL_TX = { maxWait: 5_000, timeout: 20_000 } as const;

/**
 * `clock.now`: the moment the company's today is read for (PlanDetail.today); the real clock by default.
 *
 * Audit F21: every row of the answer comes from ONE database snapshot - a REPEATABLE READ
 * transaction on the tenant-scoped client. Before, the plan row (chosen option, summary,
 * reconciliation) and the loads were separate reads, so "Use instead" committing in between gave
 * a screen or an Excel file with option A's summary and option B's loads, reconciliation still
 * "ok". The transaction only reads (MVCC: it never blocks a writer and is never blocked) and is
 * kept short: nothing slow (road shapes, rendering the workbook or PDF) runs inside it; the export
 * routes render after this returns.
 *
 * Second review of audit PR4: whether this web process runs the plan's optimization (the in-flight
 * map, for PlanDetail.stuck) is asked BEFORE the snapshot starts, not at the end of the read. A job
 * that saved its plan and left the map while the read ran is still OPTIMIZING / RUNNING in the
 * snapshot; asked at the end, it looked "lost", and the screen showed "the server restarted" and
 * Reset stuck plan for one reload. Asked first: a job in the map then is either still active in
 * the snapshot (really optimizing) or already ended there (plan READY or FAILED, never stuck); a
 * job started after the question is under 2 minutes old, so never "lost" (JOB_LOST_AFTER_MS).
 */
export async function getPlanDetail(tenantId: string, runId: string, clock: { now?: Date } = {}): Promise<PlanDetail | null> {
  const db = tenantDb(tenantId);
  const liveAtStart = isOptimizing(runId);
  return db.$transaction((tx) => readPlanDetail(tx as unknown as DetailDb, tenantId, runId, clock, liveAtStart), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    ...PLAN_DETAIL_TX,
  });
}

/** The tenant-scoped transaction client getPlanDetail reads through (typed as a plain transaction client). */
type DetailDb = Prisma.TransactionClient;

/** `liveAtStart`: this web process was running the plan's optimization when the read began (getPlanDetail). */
async function readPlanDetail(db: DetailDb, tenantId: string, runId: string, clock: { now?: Date }, liveAtStart: boolean): Promise<PlanDetail | null> {
  const run = await db.runPlan.findUnique({ where: { id: runId }, include: { depot: true } });
  if (!run) return null;
  const cfg = await db.tenantConfig.findUnique({ where: { tenantId } });
  const profiles = new Map<string, TypeProfileLike>((await db.customerTypeProfile.findMany()).map((p) => [p.customerType, p]));
  const scenarios = await db.scenarioResult.findMany({ where: { runId }, orderBy: { createdAt: 'asc' }, include: { unservedOrders: true } });
  const chosen = scenarios.find((s) => s.id === run.chosenScenarioId) ?? null;
  // Plans from the previous optimizer (May 2026) stored another shape: shown without dispatch details.
  const chosenRaw = chosen?.detailsJson;
  const chosenDetails = isDispatchDetails(chosenRaw) ? chosenRaw : undefined;
  const legacyChosen = !!chosen && !chosenDetails;
  const loads = await db.planLoad.findMany({
    where: { runId },
    orderBy: [{ truck: { code: 'asc' } }, { loadNo: 'asc' }],
    include: {
      truck: { select: { code: true, capacityCases: true, capacityWeightKg: true, hired: true } },
      driver: { select: { name: true, phone: true } },
      assignments: {
        orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }],
        include: {
          order: {
            include: {
              customer: true,
              lines: { include: { product: { select: { code: true, name: true, weightPerCaseKg: true } } } },
              carriedTo: { select: { deliveryDate: true, totalCases: true } },
            },
          },
        },
      },
    },
  });
  const priorityOf = (orderId: string, fallback: number) => chosenDetails?.scope.orderPriority[orderId] ?? fallback;
  // The depot the option was planned from (F08); the live one for options from before inputs.
  const inputs = readPlanInputs(chosenDetails?.inputs);
  const depotPoint = inputs ? { lat: inputs.depot.lat, lng: inputs.depot.lng } : { lat: run.depot.lat, lng: run.depot.lng };
  // Stops that carry split portions, for the "Part k of n" labels across the whole plan.
  const portionStops: { stop: DetailStop; customerId: string; portion: boolean; departMin: number; truckCode: string; sequence: number }[] = [];
  // The delivery time a stop would be planned with now (order-window): one visit per customer, so with
  // all of its customer's orders in this plan - on every load and left unserved - as the plan was made
  // (every part of a split customer carries the time of any of its orders; data collection review),
  // not only the part on this load.
  type VisitOrder = OrderTimeColumns & { id: string; lines: { id: string; cases: number }[] };
  const visitOrders = new Map<string, Map<string, VisitOrder>>();
  const addVisitOrder = (customerId: string, o: VisitOrder) => {
    const m = visitOrders.get(customerId) ?? new Map<string, VisitOrder>();
    m.set(o.id, o);
    visitOrders.set(customerId, m);
  };
  for (const l of loads) for (const a of l.assignments) addVisitOrder(a.order.customerId, a.order);
  const unservedIds = (chosen?.unservedOrders ?? []).map((u) => u.orderId);
  if (unservedIds.length) {
    const times = await db.order.findMany({
      where: { tenantId, id: { in: unservedIds } },
      select: { id: true, customerId: true, deliveryStartMin: true, deliveryEndMin: true, deliveryTimeReason: true, deliveryTimeNote: true, lines: { select: { id: true, cases: true } } },
    });
    for (const o of times) addVisitOrder(o.customerId, o);
  }
  const placements: OrderPlacement[] = loads.flatMap((l) =>
    l.assignments.map((a) => ({
      orderId: a.orderId,
      frozen: l.status !== 'PLANNED',
      lines: readPortionLines(a.portionLinesJson),
      capturedAt: readStopSnapshot(a.stopSnapshotJson)?.capturedAt ?? null,
    })),
  );
  // Orders the chosen option left unserved whole as heavier than any truck: not in its stops' visits.
  const tooHeavy = leftOutWhole(chosen?.unservedOrders ?? []);
  const detailLoads: DetailLoad[] = loads.map((l) => {
    const stops = new Map<number, DetailStop>();
    const withPortion = new Set<number>();
    const carriedAwayOrders = new Set<string>();
    for (const a of l.assignments) {
      const o = a.order;
      const c = o.customer;
      const eff = effectiveAttrs(c, profiles, { serviceTimeMin: cfg?.defaultServiceTimeMin ?? 10 });
      // A split portion carries only some cases of some lines of the order. The row weighs what it was
      // planned with (to 0.1 kg, like its load: audit F08), and its SKU lines share exactly that kg
      // (audit E3: the loading sheet's kg must be the load's kg).
      if (a.portionLinesJson !== null) withPortion.add(a.sequenceInTruck);
      const cases = a.portionCases ?? o.totalCases;
      const weightKg = roundKg(a.portionWeightKg ?? o.totalWeightKg);
      const lines = rowLinesKg(o.lines, a.portionLinesJson, weightKg, !orderUsesLineWeights(o));
      const skus = lines.map((ln) => ({ productCode: ln.product.code, productName: ln.product.name, cases: ln.cases, weightKg: ln.weightKg }));
      const salesOrders = lines.map((ln) => ln.salesOrderNo).filter((x): x is string => !!x);
      const orderLines: DetailOrderLine[] = lines.map((ln) => ({
        orderId: o.id,
        lineId: ln.id,
        salesOrderNo: ln.salesOrderNo ?? null,
        productCode: ln.product.code,
        productName: ln.product.name,
        cases: ln.cases,
      }));
      const s = stops.get(a.sequenceInTruck);
      const snap = readStopSnapshot(a.stopSnapshotJson);
      // PR9: brought forward from an earlier day (the date first due), or to a later day since. What
      // was carried is what never left, so only a load that never left (PLANNED, LOCKED, LOADING)
      // holds carried cases: on a dispatched or completed load the cases were delivered (the part
      // of a split order that left), and nothing is marked there (carriedLoadShows).
      const cameFrom = o.carriedFromDate ? isoOf(o.carriedFromDate) : null;
      const wentTo = o.carriedTo && carriedLoadShows(l.status) ? isoOf(o.carriedTo.deliveryDate) : null;
      if (wentTo) carriedAwayOrders.add(o.id);
      if (s) {
        if (cameFrom && (!s.carriedFrom || cameFrom < s.carriedFrom)) s.carriedFrom = cameFrom;
        if (wentTo && (!s.carriedTo || wentTo > s.carriedTo)) s.carriedTo = wentTo;
        s.cases += cases;
        s.weightKg += weightKg;
        s.orderIds.push(o.id);
        s.salesOrders = [...new Set([...s.salesOrders, ...salesOrders])];
        s.skus = aggregateSkus([...s.skus, ...skus]);
        s.orderLines.push(...orderLines);
        s.late = s.late || o.isLate;
        for (const n of noteParts(o.notes)) if (!s.notes.includes(n)) s.notes.push(n);
        s.priority = Math.min(s.priority, priorityOf(o.id, o.priority));
        continue;
      }
      // Review F08: the facts the stop was planned with; today's customer only for older rows.
      const planned = snap ? plannedWindows(snap) : null;
      const lat = snap ? snap.lat : c.lat;
      const lng = snap ? snap.lng : c.lng;
      stops.set(a.sequenceInTruck, {
        sequence: a.sequenceInTruck,
        customerId: c.id,
        customerCode: snap?.code || c.code,
        branchCode: snap ? snap.branchCode : c.branchCode,
        customerName: snap?.name || c.name,
        customerType: snap ? snap.customerType : c.customerType,
        lat,
        lng,
        priority: priorityOf(o.id, o.priority),
        etaMin: a.etaMin,
        serviceStartMin: a.serviceStartMin,
        departureMin: a.departureMin,
        waitMin: a.waitMin,
        window: planned ? planned.window : describeWindows(eff),
        hardWindow: planned ? planned.hardWindow : eff.hardStart !== null || eff.hardEnd !== null ? fmtWindow(eff.hardStart, eff.hardEnd) : null,
        promised: planned ? planned.promised : null,
        // Show the unloading time the optimizer scheduled (a split part's share, plus the
        // per-case time when the tenant sets one); the customer's own time when not scheduled.
        serviceMin: a.departureMin !== null && a.serviceStartMin !== null ? a.departureMin - a.serviceStartMin : eff.serviceMin,
        cases,
        weightKg,
        legKm: a.plannedDistanceFromPrevKm,
        cumulativeKm: a.cumulativeKm,
        hardWindowOk: a.hardWindowOk,
        prefWindowOk: a.prefWindowOk,
        late: o.isLate,
        orderIds: [o.id],
        salesOrders: [...new Set(salesOrders)],
        skus: aggregateSkus(skus),
        mapsUrl: lat !== null && lng !== null ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : null,
        address: snap ? snap.address : c.address,
        notes: noteParts(o.notes),
        // Live, never the snapshot: gate / receiver details do not change the timetable, and a
        // correction must reach the driver sheet (the snapshot keeps the planned notes for the record).
        accessNotes: c.accessNotes,
        split: null,
        snapshot: !!snap,
        masterChanged: snap
          ? (() => {
              // As the stop would be planned now: its customer's orders' own delivery time, else its hours.
              // The chosen option's left-out orders only for its own stops (a frozen one may be older).
              const leftOut = l.status === 'PLANNED' ? tooHeavy : undefined;
              const sw = stopWindowFor(eff, plannedVisitOrders([...(visitOrders.get(c.id)?.values() ?? [o])], placements, snap.capturedAt, leftOut));
              return stopMasterChanges(snap, {
                name: c.name,
                address: c.address,
                lat: c.lat,
                lng: c.lng,
                hardStartMin: sw.hardStart,
                hardEndMin: sw.hardEnd,
                prefStartMin: sw.prefStart,
                prefEndMin: sw.prefEnd,
                promised: sw.promised,
              });
            })()
          : [],
        carriedFrom: cameFrom,
        carriedTo: wentTo,
        orderLines,
        plannedHours: snap
          ? { hardStart: snap.hardStartMin, hardEnd: snap.hardEndMin, prefStart: snap.prefStartMin, prefEnd: snap.prefEndMin }
          : eff.hardStart !== null || eff.hardEnd !== null || eff.prefStart !== null || eff.prefEnd !== null
            ? { hardStart: eff.hardStart, hardEnd: eff.hardEnd, prefStart: eff.prefStart, prefEnd: eff.prefEnd }
            : null,
        promisedWindow: snap?.promised ? { startMin: snap.promised.startMin, endMin: snap.promised.endMin } : null,
      });
    }
    const stopList = [...stops.values()].sort((a, b) => a.sequence - b.sequence);
    for (const s of stopList) {
      s.weightKg = Math.round(s.weightKg * 10) / 10;
      portionStops.push({ stop: s, customerId: s.customerId, portion: withPortion.has(s.sequence), departMin: l.departMin, truckCode: l.truck.code, sequence: s.sequence });
    }
    const ts = readTruckSnapshot(l.truckSnapshotJson);
    // Audit E1: the depot pin the load was planned from, and a note when the depot's pin moved since.
    const origin = readLoadOrigin(ts) ?? depotPoint;
    const depotMoved = depotMovedChange(origin, { lat: run.depot.lat, lng: run.depot.lng });
    return {
      id: l.id,
      truckId: l.truckId,
      truckCode: ts?.code || l.truck.code,
      truckCapacityCases: ts ? ts.capacityCases : l.truck.capacityCases,
      truckPayloadKg: ts ? ts.capacityWeightKg : l.truck.capacityWeightKg,
      driverId: l.driverId,
      driverName: l.driver?.name ?? null,
      driverPhone: l.driver?.phone ?? null,
      driverHandSet: isHandSetDriver(l),
      loadNo: l.loadNo,
      status: l.status,
      carried: isCarriedFrozen(l),
      departMin: l.departMin,
      returnMin: l.returnMin,
      distanceKm: l.distanceKm,
      durationMin: l.durationMin,
      cases: l.cases,
      weightKg: l.weightKg,
      utilizationPct: l.utilizationPct,
      fuelLitres: l.fuelLitres,
      fuelCost: l.fuelCost,
      operatingCost: l.operatingCost,
      cost: readLoadCost(l.costJson),
      returnLegKm: l.returnLegKm,
      distanceIsEstimated: l.distanceIsEstimated,
      stops: stopList,
      manifest: aggregateSkus(stopList.flatMap((s) => s.skus)),
      truckSnapshot: !!ts,
      origin: { lat: origin.lat, lng: origin.lng },
      masterChanged: [...(ts ? truckMasterChanges(ts, l.truck) : []), ...(depotMoved ? [depotMoved] : [])],
      timing: null,
      carriedAway: carriedAwayOrders.size,
      break: parseLoadBreak(l.breakJson),
      hired: l.truck.hired,
    };
  });

  // The timetable check (review F04), recomputed from the plan's own facts on every read: the
  // screen shows exactly what LOCK / LOADING / DISPATCH would be gated on right now.
  let feasibility: PlanFeasibility | null = null;
  if (chosenDetails) {
    const needLegacy = loads.some((l) => l.carriedFromLoadId === null && !readTruckSnapshot(l.truckSnapshotJson));
    const legacy = needLegacy ? await legacyPlanFacts(db, tenantId, run.currentJobId) : null;
    feasibility = checkPlanFeasibility(feasibilityInputFromRows(loads, run.chosenScenarioId, chosenDetails, legacy));
    for (const dl of detailLoads) {
      const t = feasibility.trucks[dl.truckId];
      dl.timing = t ? { status: t.status, ok: t.ok } : null;
    }
  }

  const unservedRows = chosen?.unservedOrders ?? [];
  const restUnserved = new Set<string>();
  const onTruck = new Set(loads.flatMap((l) => l.assignments.map((a) => a.orderId)));
  const customerOfOrder = new Map(loads.flatMap((l) => l.assignments.map((a) => [a.orderId, a.order.customerId] as const)));
  for (const u of unservedRows) {
    const cust = customerOfOrder.get(u.orderId);
    if (u.portionLinesJson !== null && cust) restUnserved.add(cust);
  }
  for (const [p, label] of splitPartLabels(portionStops)) p.stop.split = { ...label, restUnserved: restUnserved.has(p.customerId) };

  const unservedOrders = unservedRows.length
    ? await db.order.findMany({
        where: { tenantId, id: { in: unservedRows.map((u) => u.orderId) } },
        include: { customer: true, lines: { select: { id: true, cases: true, weightKg: true, salesOrderNo: true } }, carriedTo: { select: { deliveryDate: true, totalCases: true } } },
      })
    : [];
  const uo = new Map(unservedOrders.map((o) => [o.id, o]));
  const unserved: DetailUnserved[] = unservedRows
    .map((u): DetailUnserved | null => {
      const o = uo.get(u.orderId);
      if (!o) return null;
      const cases = u.portionCases ?? o.totalCases;
      return {
        orderId: o.id,
        customerId: o.customerId,
        customerCode: o.customer.code,
        branchCode: o.customer.branchCode,
        customerName: o.customer.name,
        cases,
        weightKg: u.portionWeightKg ?? o.totalWeightKg,
        priority: priorityOf(o.id, o.priority),
        reasonCode: u.reasonCode,
        // A reason saved by an older solver may carry its raw status code: shown in plain words.
        reasonMessage: withPlainSolverCodes(u.reasonMessage),
        late: o.isLate,
        salesOrders: [...new Set(rowLines(o.lines, u.portionLinesJson).map((l) => l.salesOrderNo).filter((x): x is string => !!x))],
        partial: u.portionLinesJson !== null && onTruck.has(o.id), // some of this order is on a truck
        carriedFrom: o.carriedFromDate ? isoOf(o.carriedFromDate) : null,
        carriedTo: o.carriedTo ? isoOf(o.carriedTo.deliveryDate) : null,
      };
    })
    .filter((x): x is DetailUnserved => x !== null)
    .sort((a, b) => a.priority - b.priority || b.cases - a.cases);

  // PR9: orders of this plan brought forward from earlier days, and orders of it brought forward to
  // later days since (the plan keeps them as they were: history; they are planned on that day now).
  const inPlanOrders = new Map<string, { totalCases: number; carriedFromDate: Date | null }>();
  for (const l of loads) for (const a of l.assignments) inPlanOrders.set(a.orderId, a.order);
  for (const o of unservedOrders) inPlanOrders.set(o.id, o);
  const cameIn = [...inPlanOrders.values()].filter((o) => o.carriedFromDate);
  const carriedIn: CarrySummary | null = cameIn.length
    ? { orders: cameIn.length, cases: cameIn.reduce((a, o) => a + o.totalCases, 0), dates: [...new Set(cameIn.map((o) => isoOf(o.carriedFromDate!)))].sort() }
    : null;
  const planOrderIds = [...new Set([...inPlanOrders.keys(), ...(chosenDetails ? [...chosenDetails.scope.orderIds, ...chosenDetails.scope.frozenOrderIds] : [])])];
  const wentOut = planOrderIds.length
    ? await db.order.findMany({
        where: { tenantId, id: { in: planOrderIds }, carriedToOrderId: { not: null } },
        select: { id: true, carriedTo: { select: { deliveryDate: true, totalCases: true } } },
      })
    : [];
  const carriedOut: CarrySummary | null = wentOut.length
    ? {
        orders: wentOut.length,
        cases: wentOut.reduce((a, o) => a + (o.carriedTo?.totalCases ?? 0), 0),
        dates: [...new Set(wentOut.flatMap((o) => (o.carriedTo ? [isoOf(o.carriedTo.deliveryDate)] : [])))].sort(),
      }
    : null;

  const versions = await db.runPlan.findMany({
    where: { depotId: run.depotId, runDate: run.runDate },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, status: true, supersededAt: true, reason: true, reasonNote: true, createdAt: true, changeSummaryJson: true },
  });
  const job = await db.runJob.findFirst({ where: { runId }, orderBy: { attemptNo: 'desc' } });
  const stuck = run.status === 'OPTIMIZING' ? await stuckOf(db, run, job, liveAtStart, clock.now ?? new Date()) : null;
  const live = !isSupersededRun(run);
  const rulesNote = live && chosenDetails ? plannerRulesNote(chosenDetails) : null;
  const outdated = live && chosenDetails ? [...outdatedNotes(loads), ...(rulesNote ? [rulesNote] : [])] : [];
  let pendingOrders = 0;
  if (live && chosenDetails) {
    const inPlan = [...new Set([...chosenDetails.scope.orderIds, ...chosenDetails.scope.frozenOrderIds, ...(chosenDetails.scope.frozenLoadOrderIds ?? [])])];
    pendingOrders = await db.order.count({ where: { ...(await ordersInScopeWhere(tenantId, run.depotId, run.runDate, db)), id: { notIn: inPlan } } });
  }
  // The plan options (PR7). Each is counted as the whole day with it: the loads it was planned
  // around (locked, loading, dispatched when it was optimized - the same for every option of the
  // version) + its new loads, so its trucks are the day's physical trucks (B3), and its day cost
  // (review F17) and day km (PR7 review) add the kept loads' stored figures: the option in use
  // reads like the KPI row. Then what each option gains over the others (N1).
  const early = earlyPriorities(inputs?.config.early_preference_per_min as Record<string, number> | undefined);
  const options = scenarios.map((s) => {
    const d = (s.detailsJson ?? {}) as unknown as Partial<ScenarioDetails>;
    const frozenIds = new Set(d.scope?.frozenLoadIds ?? loads.filter((l) => isCarriedFrozen(l)).map((l) => l.id));
    const frozen = loads.filter((l) => frozenIds.has(l.id));
    const frozenCost = frozen.reduce((a, l) => a + l.operatingCost, 0);
    // Rounded like the KPI (summary.totalKm), so the option in use shows the KPI's km.
    const dayKm = Math.round((frozen.reduce((a, l) => a + l.distanceKm, 0) + s.totalDistanceKm) * 10) / 10;
    const newLoads = Array.isArray(d.loads) ? d.loads : null;
    // An optimizer before PR7 counted only the new loads' trucks: counted again from the loads.
    const trucksUsed = newLoads ? physicalTruckCount(newLoads, frozen.map((l) => l.truckId)) : s.trucksUsed;
    const optInputs = readPlanInputs(d.inputs);
    const priorityOfStop = (st: { stop_id: string; order_ids: string[] }): number | null => {
      const planned = optInputs?.stops[st.stop_id]?.priority;
      if (typeof planned === 'number') return planned;
      const ps = st.order_ids.map((id) => d.scope?.orderPriority[orderIdOf(id)]).filter((p): p is number => typeof p === 'number');
      return ps.length ? Math.min(...ps) : null;
    };
    const pref = preferenceFigures(d.preference_penalties, d.objective?.window_penalty);
    const facts: OptionFacts = {
      name: s.name,
      usable: (d.status ?? 'OPTIMIZED') === 'OPTIMIZED' && !!newLoads,
      trucks: trucksUsed,
      loads: (d.trips ?? 0) + frozen.length,
      km: dayKm,
      dayCost: frozenCost + s.totalCost,
      preferenceCost: pref.total,
      preferredHoursCost: pref.preferredHours,
      unserved: s.unservedCount,
      signature: newLoads ? planSignature(newLoads) : s.id,
      earlyStarts: newLoads ? earlyStarts(newLoads, early, priorityOfStop) : {},
      // Audit F22: an option that breaks the timing rules is never described as cheaper or better.
      feasibility: d.feasibility?.status ?? null,
      violations: d.feasibility?.violations?.length ?? 0,
    };
    return { s, d, frozenLoads: frozen.length, frozenCost, dayKm, trucksUsed, pref, facts };
  });
  const tradeoffs = optionTradeoffs(
    options.map((o) => o.facts),
    early.map((p) => `P${p}`).join('/'),
  );
  return {
    run: {
      id: run.id,
      version: run.version,
      status: run.status,
      reason: run.reason,
      reasonNote: run.reasonNote,
      runDate: isoOf(run.runDate),
      depot: { id: run.depot.id, code: run.depot.code, name: run.depot.name, lat: depotPoint.lat, lng: depotPoint.lng },
      parentRunId: run.parentRunId,
      createdAt: run.createdAt.toISOString(),
      supersededAt: run.supersededAt?.toISOString() ?? null,
      chosenScenario: chosen?.name ?? null,
    },
    summary: (run.summaryJson as unknown as DailySummary) ?? null,
    reconciliation: (run.reconciliationJson as unknown as Reconciliation) ?? null,
    change: (run.changeSummaryJson as unknown as ChangeSummary) ?? null,
    scenarios: options.map(({ s, d, frozenLoads, frozenCost, dayKm, trucksUsed, pref }) => {
      return {
        id: s.id,
        name: s.name,
        status: d.status ?? 'OPTIMIZED',
        solverStatus: d.solver_status ?? '',
        solverTimeSec: d.solver_time_sec ?? 0,
        trucksUsed,
        trips: d.trips ?? 0,
        frozenLoads,
        totalKm: s.totalDistanceKm,
        dayKm,
        totalDurationMin: s.totalTimeMin,
        operatingCost: s.totalCost,
        dayOperatingCost: Math.round((frozenCost + s.totalCost) * 1000) / 1000,
        costVersion: d.cost_version ?? null,
        estimatedLegs: d.estimated_legs ?? null,
        avgUtilizationPct: s.avgUtilizationPct,
        unservedOrders: s.unservedCount,
        distanceIsEstimated: d.distance_is_estimated ?? true,
        provider: d.matrix_provider ?? 'HAVERSINE',
        objective: d.objective ?? null,
        preference: d.preference_penalties ?? null,
        preferenceCost: pref.total,
        preferredHoursCost: pref.preferredHours,
        tradeoff: tradeoffs[s.name]?.text || null,
        chosen: s.id === run.chosenScenarioId,
        feasibility: d.feasibility ? { status: d.feasibility.status, timing: d.feasibility.timing, violations: d.feasibility.violations?.length ?? 0 } : null,
        weightUnitKg: typeof d.weight_unit_kg === 'number' ? d.weight_unit_kg : null,
        newOvertimeOnly: typeof d.new_overtime_only === 'boolean' ? d.new_overtime_only : null,
        windowRule: d.window_rule === 'FINISH' ? 'FINISH' : null,
        breakRule: d.break_rule && d.break_rule.length_min > 0
          ? { lengthMin: d.break_rule.length_min, startFromMin: d.break_rule.start_from_min, startToMin: d.break_rule.start_to_min }
          : null,
      };
    }),
    loads: detailLoads,
    unserved,
    isDispatchPlan: isDispatchPlanShape({ loadCount: loads.length, scenarioNames: scenarios.map((s) => s.name), version: run.version }),
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      // A version written READY over its supersede (before the stabilization release) is listed as replaced.
      status: isSupersededRun(v) ? 'SUPERSEDED' : v.status,
      reason: v.reason,
      reasonNote: v.reasonNote,
      createdAt: v.createdAt.toISOString(),
      changeText: (v.changeSummaryJson as { text?: string } | null)?.text ?? null,
    })),
    job: job
      ? {
          id: job.id,
          status: job.status,
          message: job.message,
          progressPct: job.progressPct,
          startedAt: job.startedAt?.toISOString() ?? null,
          finishedAt: job.finishedAt?.toISOString() ?? null,
          searchMode: job.searchMode ?? null,
        }
      : null,
    search: chosenDetails?.search ?? null,
    searchOption: chosenDetails?.search ? searchOptionOf(chosen?.name, chosenDetails.time_limit_sec) : null,
    thoroughMaxSec: thoroughMaxSec(),
    searchModeDefault: defaultSearchMode(isoOf(run.runDate), cfg?.timezone || DEFAULT_TZ, clock.now ?? new Date()),
    timezone: cfg?.timezone || DEFAULT_TZ,
    warnings: legacyChosen
      ? ['This plan was made by the previous optimizer (May 2026). Its routes are shown under Plan history; it cannot be re-planned.']
      : chosenDetails
        ? [
            ...new Set([
              ...outdated,
              ...(live ? masterChangedNotes(detailLoads) : []),
              // A driver the applied plan changed is never silent. Read with each row's marker, so a
              // note ends once the dispatcher sets that trip's driver (a driver, Keep or "No driver").
              ...driverChangeWarnings(
                (run.summaryJson as unknown as DailySummary | null)?.driverChanges ?? [],
                loads.map((l) => ({ truckId: l.truckId, loadNo: l.loadNo, driverId: l.driverId, driverSet: driverSetByDispatcher(l) })),
              ),
              ...(chosenDetails.response_warnings ?? []),
              ...(chosenDetails.warnings ?? []),
            ]),
          ]
        : [],
    pendingOrders,
    feasibility,
    feasibilityGate: feasibilityGateMode(),
    planSettings: inputs?.settings ?? null,
    carriedIn,
    carriedOut,
    today: todayIso(cfg?.timezone || DEFAULT_TZ, clock.now ?? new Date()),
    stuck,
  };
}

/**
 * Audit F09: is this OPTIMIZING version stuck (its current job ended, missing or lost)? `live`: the
 * in-flight map as it was before the snapshot began (getPlanDetail), never asked during the read.
 */
async function stuckOf(
  db: DetailDb,
  run: { id: string; status: string; currentJobId: string | null },
  latest: { id: string; status: string; createdAt: Date; startedAt: Date | null; heartbeatAt?: Date | null } | null,
  live: boolean,
  now: Date,
): Promise<StuckState | null> {
  const current = !run.currentJobId ? null : latest?.id === run.currentJobId ? latest : await db.runJob.findFirst({ where: { id: run.currentJobId, runId: run.id } });
  const otherActive = (await db.runJob.count({ where: { runId: run.id, status: { in: ['QUEUED', 'RUNNING'] } } })) > 0;
  return stuckPlanState(run, current, otherActive, live, now);
}

/**
 * Review F08: customer or truck master data corrected after this plan was made. The plan keeps
 * what it was planned with (sheets included); nothing switches silently. A PLANNED load adopts the
 * change at the next re-plan; a locked one must be unlocked first (a dispatched one keeps it).
 */
export function masterChangedNotes(loads: Pick<DetailLoad, 'status' | 'truckCode' | 'loadNo' | 'stops' | 'masterChanged' | 'origin'>[]): string[] {
  const stops: string[] = [];
  const frozen: string[] = [];
  const trucks: string[] = [];
  const depotPlanned: DepotMovedLoad[] = [];
  const depotKept: DepotMovedLoad[] = [];
  for (const l of loads) {
    if (l.masterChanged.some((c) => c.kind !== 'DEPOT')) trucks.push(`${l.truckCode} L${l.loadNo}`);
    const depot = l.masterChanged.find((c) => c.kind === 'DEPOT');
    if (depot) {
      // Each load its own distance: loads kept through two depot moves were planned from different pins (A6 review).
      (l.status === 'PLANNED' ? depotPlanned : depotKept).push({
        label: `${l.truckCode} L${l.loadNo}`,
        far: typeof depot.movedM === 'number' ? (depot.movedM >= 1000 ? `${(depot.movedM / 1000).toFixed(1)} km` : `${depot.movedM} m`) : null,
        pin: l.origin ? `${l.origin.lat},${l.origin.lng}` : '',
      });
    }
    for (const s of l.stops) {
      if (!s.masterChanged.some((c) => c.kind === 'LOCATION' || c.kind === 'HOURS')) continue;
      const label = `${s.customerCode}${s.branchCode ? `/${s.branchCode}` : ''} (${l.truckCode} L${l.loadNo})`;
      (l.status === 'PLANNED' ? stops : frozen).push(label);
    }
  }
  const out: string[] = [];
  if (stops.length) {
    out.push(`Location or receiving hours changed after this plan was made: ${stops.join(', ')}. The plan still uses what it was planned with - re-plan to use the new data.`);
  }
  if (frozen.length) {
    out.push(`Location or receiving hours changed after these locked or dispatched loads were planned: ${frozen.join(', ')}. Their sheets show the planned stop with the change noted; unlock and re-plan to adopt it (not possible once a load has left).`);
  }
  if (trucks.length) out.push(`Truck capacity changed after planning: ${trucks.join(', ')}. The loads keep the capacity they were planned with - re-plan to use the new one.`);
  // Audit E1 (owner decision 13): its own sentence, never "truck capacity changed".
  if (depotKept.length) out.push(depotMovedSentence(depotKept, true));
  if (depotPlanned.length) out.push(depotMovedSentence(depotPlanned, false));
  return out;
}

/** A load whose depot pin moved since it was planned: its label, how far (null: unknown) and the pin it was planned from. */
type DepotMovedLoad = { label: string; far: string | null; pin: string };

/**
 * The plan's "Depot moved since planning" sentence for the kept (locked, dispatched) or the PLANNED
 * loads. One distance when every load gives the same one; else each load its own, after its label
 * (A6 review: the last load's distance was printed for all). Singular words for one load.
 */
function depotMovedSentence(items: DepotMovedLoad[], kept: boolean): string {
  const one = items.length === 1;
  const fars = new Set(items.map((i) => i.far));
  const sameFar = fars.size === 1;
  const onePin = new Set(items.map((i) => i.pin)).size === 1;
  const list = items.map((i) => (sameFar || !i.far ? i.label : `${i.label} (${i.far})`)).join(', ');
  const [only] = [...fars];
  const far = sameFar ? (only ? ` (${only} from the depot's pin now)` : '') : " (distance from the depot's pin now)";
  const pin = onePin ? 'pin' : 'pins';
  if (kept) {
    const verb = one ? 'starts and ends at the depot pin it was' : `start and end at the depot ${pin} they were`;
    return `Depot moved since planning: ${list} ${verb} planned from${far}. Locked and dispatched loads keep ${onePin ? 'it' : 'them'}.`;
  }
  return `Depot moved since planning: ${list} ${one ? 'is' : 'are'} still planned from the old depot ${pin}${far}. Re-plan to plan ${one ? 'it' : 'them'} from the new pin.`;
}

type OutdatedLoad = {
  status: string;
  loadNo: number;
  truck: { code: string };
  assignments: {
    orderId: string;
    portionLinesJson: unknown;
    portionWeightKg?: number | null;
    order: {
      status: string;
      totalWeightKg: number;
      customer: { code: string; branchCode: string | null; active: boolean };
      lines: { id: string; cases: number; weightKg: number; weightFromMaster: boolean; product: { code: string; weightPerCaseKg: number } }[];
    };
  }[];
};

/**
 * A plan asked for with the finish-by-closing rule (owner rule 29 Sep 2026) but made by a planner
 * without it (the planner and the web are updated one after the other): its loads keep the earlier
 * rule, which the solver's echo shows (DispatchScenario.window_rule absent). Null when it was
 * planned with the rule, or never asked for it.
 */
export function plannerRulesNote(d: { window_rule?: string | null; break_rule?: unknown; inputs?: unknown }): string | null {
  const cfg = readPlanInputs(d.inputs)?.config;
  const missing: string[] = [];
  if (cfg?.window_rule === 'FINISH' && d.window_rule !== 'FINISH') missing.push('that unloading must be finished by closing');
  if ((cfg?.break_min ?? 0) > 0 && !d.break_rule) missing.push('the driver break');
  if (!missing.length) return null;
  return `Made by a planner without the rule${missing.length > 1 ? 's' : ''} ${missing.join(' and ')} (an update was being installed): these loads keep the earlier rules. Re-plan in a few minutes to use ${missing.length > 1 ? 'them' : 'it'}.`;
}

/**
 * What changed since the plan in use was made that a RE-PLAN would change on its PLANNED loads
 * (frozen loads keep what they were loaded with): customers deactivated since, whose orders are
 * still on trucks, and case weights entered or corrected under Products since. The open rest of
 * an order partly on a frozen load is planned with the product's weight at every optimize (it is
 * never saved on the line, which the frozen part shares), so it is reported only while its PLANNED
 * part carries another case weight than the product has now (portionPlannedKgPerCase, the
 * timetable check's rule; second review of PR4) - the same rule as the day overview.
 */
export function outdatedNotes(loads: OutdatedLoad[]): string[] {
  const inactive = new Map<string, Set<string>>();
  const weights = new Map<string, number>();
  const partlyFrozen = new Set(loads.filter((l) => l.status !== 'PLANNED').flatMap((l) => l.assignments.map((a) => a.orderId)));
  for (const l of loads) {
    if (l.status !== 'PLANNED') continue;
    for (const a of l.assignments) {
      const o = a.order;
      if (o.status === 'DISPATCHED' || o.status === 'DELIVERED') continue;
      if (!o.customer.active) {
        const label = o.customer.branchCode ? `${o.customer.code}/${o.customer.branchCode}` : o.customer.code;
        inactive.set(label, (inactive.get(label) ?? new Set()).add(`${l.truck.code} L${l.loadNo}`));
      }
      const orderLevel = !orderUsesLineWeights(o);
      const portion = readPortionLines(a.portionLinesJson);
      // A partly frozen order: only the lines this PLANNED part carries with another case weight.
      const plannedKg = partlyFrozen.has(a.orderId)
        ? (portionPlannedKgPerCase({ portionLinesJson: a.portionLinesJson, portionWeightKg: a.portionWeightKg ?? null }, o.lines, orderLevel) ?? new Map<string, number>())
        : null;
      const casesOf = new Map((portion ?? o.lines.map((x) => ({ lineId: x.id, cases: x.cases }))).map((x) => [x.lineId, x.cases]));
      for (const ln of o.lines) {
        const cases = casesOf.get(ln.id) ?? 0;
        if (cases <= 0) continue;
        if (plannedKg && !plannedKgDiffers(plannedKg.get(ln.id), ln.product.weightPerCaseKg)) continue;
        if (lineWeightStatus({ cases: ln.cases, weightKg: ln.weightKg, fromMaster: ln.weightFromMaster }, ln.product.weightPerCaseKg, orderLevel) === 'MASTER') {
          weights.set(ln.product.code, (weights.get(ln.product.code) ?? 0) + cases);
        }
      }
    }
  }
  const out: string[] = [];
  if (inactive.size) {
    out.push(
      `Deactivated after this plan was made, but still on planned loads: ${[...inactive].map(([c, ls]) => `${c} (${[...ls].join(', ')})`).join('; ')}. Re-plan to leave their orders unserved, or reactivate them in Customers.`,
    );
  }
  if (weights.size) {
    out.push(
      `Case weight entered or corrected under Products after this plan was made: ${[...weights].map(([code, n]) => `${code} (${n} cases on planned loads)`).join(', ')}. These loads were planned with the old weight: re-plan to use the new one.`,
    );
  }
  return out;
}
