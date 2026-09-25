/**
 * Everything the dispatcher reviews for one plan version - used by the plan screen AND the
 * Excel export so both always show identical numbers.
 */
import { prisma } from '../db';
import { tenantDb } from '../tenant';
import { effectiveAttrs, describeWindows, type EffectiveAttrs, type TypeProfileLike } from './customer-attrs';
import { aggregateSkus, type Reconciliation } from './reconcile';
import type { ChangeSummary, DailySummary } from './summary';
import { feasibilityInputFromRows, isDispatchDetails, legacyPlanFacts, ordersInScopeWhere, type ScenarioDetails } from './plan-service';
import { checkPlanFeasibility, feasibilityGateMode, type PlanFeasibility, type TruckTiming } from './feasibility';
import {
  readPlanInputs,
  readStopSnapshot,
  readTruckSnapshot,
  stopMasterChanges,
  truckMasterChanges,
  type MasterChange,
  type PlanSettings,
} from './snapshots';
import { isSupersededRun } from './plan-status';
import { isCarriedFrozen } from './load-state';
import { noteParts } from './driver-links';
import { readPortionLines, rowLines, splitPartLabels } from './split';
import { lineWeightStatus, orderUsesLineWeights } from './weights';
import { fmtWindow, isoOf } from './time';

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
  window: string;
  hardWindow: string | null;
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
  returnLegKm: number;
  distanceIsEstimated: boolean;
  stops: DetailStop[];
  manifest: { productCode: string; productName: string; cases: number; weightKg: number }[];
  /** The truck code and capacities above are the ones the load was planned with (false: today's truck). */
  truckSnapshot: boolean;
  /** Truck capacity changed since planning. */
  masterChanged: MasterChange[];
  /** The timetable check of this load's truck-day (review F04); null = the version has no applied plan. */
  timing: { status: TruckTiming; ok: boolean } | null;
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
    trucksUsed: number;
    trips: number;
    totalKm: number;
    totalDurationMin: number;
    operatingCost: number;
    avgUtilizationPct: number;
    unservedOrders: number;
    distanceIsEstimated: boolean;
    provider: string;
    objective: ScenarioDetails['objective'] | null;
    chosen: boolean;
    /** The optimizer's own timetable check of this option (null: an option from before the check existed). */
    feasibility: { status: string; timing: string; violations: number } | null;
  }[];
  loads: DetailLoad[];
  unserved: DetailUnserved[];
  versions: { id: string; version: number; status: string; reason: string; reasonNote: string | null; createdAt: string; changeText: string | null }[];
  job: { id: string; status: string; message: string | null; progressPct: number; startedAt: string | null; finishedAt: string | null } | null;
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
}

/** "hard 06:00–14:00, preferred 07:00–10:00" from planned hours (describeWindows reads only these four). */
function plannedWindows(h: { hardStartMin: number | null; hardEndMin: number | null; prefStartMin: number | null; prefEndMin: number | null }) {
  const eff = { hardStart: h.hardStartMin, hardEnd: h.hardEndMin, prefStart: h.prefStartMin, prefEnd: h.prefEndMin } as EffectiveAttrs;
  return { window: describeWindows(eff), hardWindow: h.hardStartMin !== null || h.hardEndMin !== null ? fmtWindow(h.hardStartMin, h.hardEndMin) : null };
}

export async function getPlanDetail(tenantId: string, runId: string): Promise<PlanDetail | null> {
  const db = tenantDb(tenantId);
  const run = await db.runPlan.findUnique({ where: { id: runId }, include: { depot: true } });
  if (!run) return null;
  const cfg = await db.tenantConfig.findUnique({ where: { tenantId } });
  const profiles = new Map<string, TypeProfileLike>((await db.customerTypeProfile.findMany()).map((p) => [p.customerType, p]));
  const scenarios = await prisma.scenarioResult.findMany({ where: { runId }, orderBy: { createdAt: 'asc' }, include: { unservedOrders: true } });
  const chosen = scenarios.find((s) => s.id === run.chosenScenarioId) ?? null;
  // Plans from the previous optimizer (before May 2026) stored another shape: shown without dispatch details.
  const chosenRaw = chosen?.detailsJson;
  const chosenDetails = isDispatchDetails(chosenRaw) ? chosenRaw : undefined;
  const legacyChosen = !!chosen && !chosenDetails;
  const loads = await db.planLoad.findMany({
    where: { runId },
    orderBy: [{ truck: { code: 'asc' } }, { loadNo: 'asc' }],
    include: {
      truck: { select: { code: true, capacityCases: true, capacityWeightKg: true } },
      driver: { select: { name: true, phone: true } },
      assignments: {
        orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }],
        include: {
          order: {
            include: {
              customer: true,
              lines: { include: { product: { select: { code: true, name: true, weightPerCaseKg: true } } } },
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
  const detailLoads: DetailLoad[] = loads.map((l) => {
    const stops = new Map<number, DetailStop>();
    const withPortion = new Set<number>();
    for (const a of l.assignments) {
      const o = a.order;
      const c = o.customer;
      const eff = effectiveAttrs(c, profiles, { serviceTimeMin: cfg?.defaultServiceTimeMin ?? 10 });
      // A split portion carries only some cases of some lines of the order.
      const lines = rowLines(o.lines, a.portionLinesJson);
      if (a.portionLinesJson !== null) withPortion.add(a.sequenceInTruck);
      const cases = a.portionCases ?? o.totalCases;
      const weightKg = a.portionWeightKg ?? o.totalWeightKg;
      const skus = lines.map((ln) => ({ productCode: ln.product.code, productName: ln.product.name, cases: ln.cases, weightKg: ln.weightKg }));
      const salesOrders = lines.map((ln) => ln.salesOrderNo).filter((x): x is string => !!x);
      const s = stops.get(a.sequenceInTruck);
      const snap = readStopSnapshot(a.stopSnapshotJson);
      if (s) {
        s.cases += cases;
        s.weightKg += weightKg;
        s.orderIds.push(o.id);
        s.salesOrders = [...new Set([...s.salesOrders, ...salesOrders])];
        s.skus = aggregateSkus([...s.skus, ...skus]);
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
          ? stopMasterChanges(snap, {
              name: c.name,
              address: c.address,
              lat: c.lat,
              lng: c.lng,
              hardStartMin: eff.hardStart,
              hardEndMin: eff.hardEnd,
              prefStartMin: eff.prefStart,
              prefEndMin: eff.prefEnd,
            })
          : [],
      });
    }
    const stopList = [...stops.values()].sort((a, b) => a.sequence - b.sequence);
    for (const s of stopList) {
      s.weightKg = Math.round(s.weightKg * 10) / 10;
      portionStops.push({ stop: s, customerId: s.customerId, portion: withPortion.has(s.sequence), departMin: l.departMin, truckCode: l.truck.code, sequence: s.sequence });
    }
    const ts = readTruckSnapshot(l.truckSnapshotJson);
    return {
      id: l.id,
      truckId: l.truckId,
      truckCode: ts?.code || l.truck.code,
      truckCapacityCases: ts ? ts.capacityCases : l.truck.capacityCases,
      truckPayloadKg: ts ? ts.capacityWeightKg : l.truck.capacityWeightKg,
      driverId: l.driverId,
      driverName: l.driver?.name ?? null,
      driverPhone: l.driver?.phone ?? null,
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
      returnLegKm: l.returnLegKm,
      distanceIsEstimated: l.distanceIsEstimated,
      stops: stopList,
      manifest: aggregateSkus(stopList.flatMap((s) => s.skus)),
      truckSnapshot: !!ts,
      masterChanged: ts ? truckMasterChanges(ts, l.truck) : [],
      timing: null,
    };
  });

  // The timetable check (review F04), recomputed from the plan's own facts on every read: the
  // screen shows exactly what LOCK / LOADING / DISPATCH would be gated on right now.
  let feasibility: PlanFeasibility | null = null;
  if (chosenDetails) {
    const needLegacy = loads.some((l) => l.carriedFromLoadId === null && !readTruckSnapshot(l.truckSnapshotJson));
    const legacy = needLegacy ? await legacyPlanFacts(prisma, tenantId, run.currentJobId) : null;
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
    ? await prisma.order.findMany({
        where: { tenantId, id: { in: unservedRows.map((u) => u.orderId) } },
        include: { customer: true, lines: { select: { id: true, cases: true, weightKg: true, salesOrderNo: true } } },
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
        reasonMessage: u.reasonMessage,
        late: o.isLate,
        salesOrders: [...new Set(rowLines(o.lines, u.portionLinesJson).map((l) => l.salesOrderNo).filter((x): x is string => !!x))],
        partial: u.portionLinesJson !== null && onTruck.has(o.id), // some of this order is on a truck
      };
    })
    .filter((x): x is DetailUnserved => x !== null)
    .sort((a, b) => a.priority - b.priority || b.cases - a.cases);

  const versions = await db.runPlan.findMany({
    where: { depotId: run.depotId, runDate: run.runDate },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, status: true, supersededAt: true, reason: true, reasonNote: true, createdAt: true, changeSummaryJson: true },
  });
  const job = await db.runJob.findFirst({ where: { runId }, orderBy: { attemptNo: 'desc' } });
  const live = !isSupersededRun(run);
  const outdated = live && chosenDetails ? outdatedNotes(loads) : [];
  let pendingOrders = 0;
  if (live && chosenDetails) {
    const inPlan = [...new Set([...chosenDetails.scope.orderIds, ...chosenDetails.scope.frozenOrderIds, ...(chosenDetails.scope.frozenLoadOrderIds ?? [])])];
    pendingOrders = await prisma.order.count({ where: { ...(await ordersInScopeWhere(tenantId, run.depotId, run.runDate)), id: { notIn: inPlan } } });
  }
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
    scenarios: scenarios.map((s) => {
      const d = (s.detailsJson ?? {}) as unknown as Partial<ScenarioDetails>;
      return {
        id: s.id,
        name: s.name,
        status: d.status ?? 'OPTIMIZED',
        solverStatus: d.solver_status ?? '',
        solverTimeSec: d.solver_time_sec ?? 0,
        trucksUsed: s.trucksUsed,
        trips: d.trips ?? 0,
        totalKm: s.totalDistanceKm,
        totalDurationMin: s.totalTimeMin,
        operatingCost: s.totalCost,
        avgUtilizationPct: s.avgUtilizationPct,
        unservedOrders: s.unservedCount,
        distanceIsEstimated: d.distance_is_estimated ?? true,
        provider: d.matrix_provider ?? 'HAVERSINE',
        objective: d.objective ?? null,
        chosen: s.id === run.chosenScenarioId,
        feasibility: d.feasibility ? { status: d.feasibility.status, timing: d.feasibility.timing, violations: d.feasibility.violations?.length ?? 0 } : null,
      };
    }),
    loads: detailLoads,
    unserved,
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
      ? { id: job.id, status: job.status, message: job.message, progressPct: job.progressPct, startedAt: job.startedAt?.toISOString() ?? null, finishedAt: job.finishedAt?.toISOString() ?? null }
      : null,
    warnings: legacyChosen
      ? ['This plan was made by the previous optimizer (before May 2026). Its routes are shown under Plan history; it cannot be re-planned.']
      : chosenDetails
        ? [...new Set([...outdated, ...(live ? masterChangedNotes(detailLoads) : []), ...(chosenDetails.response_warnings ?? []), ...(chosenDetails.warnings ?? [])])]
        : [],
    pendingOrders,
    feasibility,
    feasibilityGate: feasibilityGateMode(),
    planSettings: inputs?.settings ?? null,
  };
}

/**
 * Review F08: customer or truck master data corrected after this plan was made. The plan keeps
 * what it was planned with (sheets included); nothing switches silently. A PLANNED load adopts the
 * change at the next re-plan; a locked one must be unlocked first (a dispatched one keeps it).
 */
export function masterChangedNotes(loads: Pick<DetailLoad, 'status' | 'truckCode' | 'loadNo' | 'stops' | 'masterChanged'>[]): string[] {
  const stops: string[] = [];
  const frozen: string[] = [];
  const trucks: string[] = [];
  for (const l of loads) {
    if (l.masterChanged.length) trucks.push(`${l.truckCode} L${l.loadNo}`);
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
  return out;
}

type OutdatedLoad = {
  status: string;
  loadNo: number;
  truck: { code: string };
  assignments: {
    orderId: string;
    portionLinesJson: unknown;
    order: {
      status: string;
      totalWeightKg: number;
      customer: { code: string; branchCode: string | null; active: boolean };
      lines: { id: string; cases: number; weightKg: number; weightFromMaster: boolean; product: { code: string; weightPerCaseKg: number } }[];
    };
  }[];
};

/**
 * What changed since the plan in use was made that a RE-PLAN would change on its PLANNED loads
 * (frozen loads keep what they were loaded with): customers deactivated since, whose orders are
 * still on trucks, and case weights entered or corrected under Products since. The open rest of
 * an order partly on a frozen load is planned with the product's weight at every optimize (it is
 * never saved on the line, which the frozen part shares), so it is not reported as out of date.
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
      if (partlyFrozen.has(a.orderId)) continue;
      const orderLevel = !orderUsesLineWeights(o);
      const portion = readPortionLines(a.portionLinesJson);
      const casesOf = new Map((portion ?? o.lines.map((x) => ({ lineId: x.id, cases: x.cases }))).map((x) => [x.lineId, x.cases]));
      for (const ln of o.lines) {
        const cases = casesOf.get(ln.id) ?? 0;
        if (cases <= 0) continue;
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
