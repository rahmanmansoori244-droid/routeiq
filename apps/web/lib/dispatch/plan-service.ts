/**
 * Dispatch plan service: the only place that turns orders into a solver request and a solver
 * response into loads. Route handlers stay thin.
 *
 * Plan = RunPlan row for (depot, delivery date, version). Version 1 is INITIAL. A late order or
 * a re-plan after loads were chosen creates version N+1: frozen loads (LOCKED / LOADING /
 * DISPATCHED / COMPLETED) are copied verbatim, the parent is marked SUPERSEDED (kept, never
 * overwritten) and only the remaining orders are optimized again.
 */
import type { LoadStatus, Prisma, UnservedReasonCode } from '@prisma/client';
import type {
  DispatchRequest,
  DispatchResponse,
  DispatchScenario,
  DispatchScenarioName,
  DispatchStop,
  DispatchTruck,
} from '@routeiq/shared-types';
import { prisma } from '../db';
import { tenantDb } from '../tenant';
import {
  coordStatus,
  customerIssues,
  effectiveAttrs,
  parsePriorityWeights,
  parseServiceArea,
  type CustomerForPlanning,
  type TypeProfileLike,
} from './customer-attrs';
import { checkTransition, isFrozen, type LoadStatusName } from './load-state';
import { reconcile, type Reconciliation } from './reconcile';
import { computeChangeSummary, computeSummary, type AssignmentKey } from './summary';
import { dateOnly, isoOf } from './time';

type Tx = Prisma.TransactionClient;

export class PlanError extends Error {
  constructor(message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}

export const ALL_SCENARIOS: DispatchScenarioName[] = ['RECOMMENDED', 'MIN_TRUCKS', 'MIN_DISTANCE'];

export interface OrderDrop {
  orderId: string;
  reasonCode: UnservedReasonCode;
  message: string;
}

export interface BlockingIssue {
  customerId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  code: string;
  message: string;
  orderIds: string[];
  cases: number;
}

export interface PlanScope {
  orderIds: string[]; // orders sent to (or pre-dropped before) the optimizer
  frozenOrderIds: string[]; // orders sitting in frozen loads, kept as-is
  orderPriority: Record<string, number>;
}

export interface BuiltRequest {
  request: DispatchRequest;
  preDrops: OrderDrop[];
  scope: PlanScope;
  blocking: BlockingIssue[];
  warnings: string[];
}

const ORDER_INCLUDE = {
  customer: true,
  lines: { include: { product: { select: { code: true, name: true, weightPerCaseKg: true } } } },
} as const;

/** Orders belonging to a plan: same delivery date and depot. Legacy orders without a depot
 * are included only when the tenant has exactly one active depot (unambiguous). */
export async function ordersInScopeWhere(tenantId: string, depotId: string, runDate: Date): Promise<Prisma.OrderWhereInput> {
  const depots = await prisma.depot.count({ where: { tenantId, active: true } });
  return {
    tenantId,
    deliveryDate: runDate,
    OR: depots <= 1 ? [{ depotId }, { depotId: null }] : [{ depotId }],
  };
}

function toPlanningCustomer(c: {
  id: string; code: string; branchCode: string | null; name: string; lat: number | null; lng: number | null;
  priority: number; priorityConfirmed: boolean; avgServiceTimeMin: number; serviceTimeConfirmed: boolean;
  customerType: string | null; hardWindowStartMin: number | null; hardWindowEndMin: number | null;
  prefWindowStartMin: number | null; prefWindowEndMin: number | null; locationVerified: boolean; createdFromUpload: boolean;
}): CustomerForPlanning {
  return { ...c };
}

export async function buildDispatchRequest(
  tenantId: string,
  runId: string,
  scenarios: DispatchScenarioName[] = ALL_SCENARIOS,
): Promise<BuiltRequest> {
  const db = tenantDb(tenantId);
  const run = await db.runPlan.findUniqueOrThrow({ where: { id: runId }, include: { depot: true } });
  const cfg = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
  const profiles = new Map<string, TypeProfileLike>(
    (await db.customerTypeProfile.findMany()).map((p) => [p.customerType, p]),
  );
  const area = parseServiceArea(cfg.serviceAreaJson);
  const where = await ordersInScopeWhere(tenantId, run.depotId, run.runDate);
  const orders = await prisma.order.findMany({ where, include: ORDER_INCLUDE, orderBy: { uploadedAt: 'asc' } });
  const frozenLoads = await db.planLoad.findMany({
    where: { runId, status: { not: 'PLANNED' } },
    include: { assignments: { select: { orderId: true } } },
    orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }],
  });
  const frozenOrderIds = new Set(frozenLoads.flatMap((l) => l.assignments.map((a) => a.orderId)));
  const trucks = await db.truck.findMany({ where: { depotId: run.depotId, active: true }, orderBy: { code: 'asc' } });
  // Plan continuity: on a re-plan, tell the optimizer which truck each order was on in the
  // previous version so one late order does not reshuffle every unlocked load.
  const previousTruck = new Map<string, string>();
  if (run.parentRunId) {
    const prev = await prisma.routeAssignment.findMany({ where: { runId: run.parentRunId }, select: { orderId: true, truckId: true } });
    for (const a of prev) previousTruck.set(a.orderId, a.truckId);
  }

  const preDrops: OrderDrop[] = [];
  const blockingByCustomer = new Map<string, BlockingIssue>();
  const orderPriority: Record<string, number> = {};
  const stops = new Map<string, DispatchStop & { _margins: (number | null)[]; _revenues: (number | null)[] }>();
  const scopeIds: string[] = [];

  for (const o of orders) {
    if (frozenOrderIds.has(o.id)) continue;
    scopeIds.push(o.id);
    const c = toPlanningCustomer(o.customer);
    const eff = effectiveAttrs(c, profiles, { serviceTimeMin: cfg.defaultServiceTimeMin });
    const pr = o.priorityFromFile ? Math.min(o.priority, eff.priority) : eff.priority;
    const cs = coordStatus(c.lat, c.lng, area);
    const locBad = cs === 'MISSING' || cs === 'INVALID' || (cs === 'OUTSIDE_AREA' && !c.locationVerified);
    if (locBad) {
      const code: UnservedReasonCode = cs === 'MISSING' ? 'MISSING_COORDINATES' : 'INVALID_LOCATION';
      const issue = customerIssues(c, eff, area).find((i) => i.blocking);
      preDrops.push({ orderId: o.id, reasonCode: code, message: issue?.message ?? 'Location missing.' });
      orderPriority[o.id] = pr;
      const b = blockingByCustomer.get(c.id) ?? {
        customerId: c.id, customerCode: c.code, branchCode: c.branchCode, customerName: c.name,
        code: cs === 'MISSING' ? 'LOCATION_REQUIRED' : 'INVALID_LOCATION', message: issue?.message ?? '', orderIds: [], cases: 0,
      };
      b.orderIds.push(o.id);
      b.cases += o.totalCases;
      blockingByCustomer.set(c.id, b);
      continue;
    }
    const s = stops.get(c.id);
    if (s) {
      s.order_ids.push(o.id);
      s.demand_cases += o.totalCases;
      s.demand_kg = (s.demand_kg ?? 0) + o.totalWeightKg;
      s.priority = Math.min(s.priority ?? 5, pr);
      s.late = s.late || o.isLate;
      s._margins.push(o.marginValue);
      s._revenues.push(o.salesValue);
    } else {
      stops.set(c.id, {
        stop_id: c.id,
        order_ids: [o.id],
        customer_id: c.id,
        lat: c.lat as number,
        lng: c.lng as number,
        demand_cases: o.totalCases,
        demand_kg: o.totalWeightKg,
        service_min: Math.max(0, Math.min(480, eff.serviceMin)),
        priority: pr,
        hard_start_min: eff.hardStart,
        hard_end_min: eff.hardEnd,
        pref_start_min: eff.prefStart,
        pref_end_min: eff.prefEnd,
        late: o.isLate,
        _margins: [o.marginValue],
        _revenues: [o.salesValue],
      });
    }
  }
  const stopList: DispatchStop[] = [];
  for (const s of stops.values()) {
    const { _margins, _revenues, ...rest } = s;
    const prevTrucks = rest.order_ids.map((id) => previousTruck.get(id)).filter((t): t is string => !!t);
    rest.previous_truck_id = prevTrucks[0] ?? null;
    rest.margin = _margins.every((m) => m !== null) ? _margins.reduce<number>((a, m) => a + (m ?? 0), 0) : null;
    rest.revenue = _revenues.every((m) => m !== null) ? _revenues.reduce<number>((a, m) => a + (m ?? 0), 0) : null;
    for (const id of rest.order_ids) orderPriority[id] = rest.priority ?? 3;
    stopList.push(rest);
  }

  const frozenByTruck = new Map<string, typeof frozenLoads>();
  for (const l of frozenLoads) frozenByTruck.set(l.truckId, [...(frozenByTruck.get(l.truckId) ?? []), l]);
  const truckList: DispatchTruck[] = trucks.map((t) => ({
    id: t.id,
    code: t.code,
    capacity_cases: t.capacityCases,
    capacity_kg: t.capacityWeightKg,
    fixed_cost: t.fixedCostPerDay,
    trip_cost: t.tripCost,
    cost_per_km: t.costPerKm,
    km_per_litre: t.kmPerLitre,
    available_from_min: t.availableFromMin,
    available_to_min: t.availableToMin,
    max_trips: t.maxTripsPerDay,
    frozen_trips: (frozenByTruck.get(t.id) ?? []).map((l) => ({
      load_no: l.loadNo,
      depart_min: l.departMin,
      return_min: l.returnMin,
      cases: l.cases,
    })),
  }));

  const warnings: string[] = [];
  if (cfg.distanceProvider === 'MAPBOX_MATRIX') warnings.push('Mapbox matrix is not used by the dispatch planner; OSRM/Haversine is used instead.');
  const request: DispatchRequest = {
    run_id: runId,
    tenant_id: tenantId,
    depot: {
      id: run.depot.id,
      lat: run.depot.lat,
      lng: run.depot.lng,
      open_min: run.depot.openMin ?? 0,
      close_min: run.depot.closeMin ?? 1440,
    },
    trucks: truckList,
    stops: stopList,
    config: {
      shift_start_min: cfg.shiftStartMin,
      shift_max_min: cfg.driverShiftMaxMinutes,
      overtime_after_min: cfg.overtimeAfterMin,
      overtime_cost_per_hour: cfg.overtimeCostPerHour,
      reload_min: cfg.reloadMinutes,
      max_trips_per_truck: cfg.maxTripsPerTruck,
      fuel_price_per_litre: cfg.fuelPricePerLitre,
      driver_cost_per_hour: cfg.driverCostPerHour,
      priority_weights: parsePriorityWeights(cfg.priorityWeightsJson),
      pref_window_penalty_per_min: cfg.prefWindowPenaltyPerMin,
      use_margin: true,
      distance_provider: cfg.distanceProvider === 'HAVERSINE' ? 'HAVERSINE' : 'OSRM',
      osrm_url: cfg.osrmUrl ?? null,
      haversine_multiplier: cfg.distanceMultiplier,
      avg_speed_kmh: cfg.avgSpeedKmh,
      road_time_factor: cfg.roadTimeFactor,
      time_limit_sec: null,
      scenarios,
    },
  };
  return {
    request,
    preDrops,
    scope: { orderIds: scopeIds, frozenOrderIds: [...frozenOrderIds], orderPriority },
    blocking: [...blockingByCustomer.values()],
    warnings,
  };
}

// ---------------------------------------------------------------------------------------
// Persist the solver response and apply a scenario as the plan
// ---------------------------------------------------------------------------------------

export interface ScenarioDetails extends DispatchScenario {
  engine: string;
  matrix_provider: string;
  distance_is_estimated: boolean;
  response_warnings: string[];
  scope: PlanScope;
}

export async function persistDispatchResult(
  tx: Tx,
  tenantId: string,
  runId: string,
  built: BuiltRequest,
  resp: DispatchResponse,
): Promise<Map<string, string>> {
  await tx.scenarioResult.deleteMany({ where: { runId } });
  const ids = new Map<string, string>();
  for (const sc of resp.scenarios) {
    const unserved: { orderId: string; reasonCode: UnservedReasonCode; reasonMessage: string }[] = built.preDrops.map((d) => ({
      orderId: d.orderId,
      reasonCode: d.reasonCode,
      reasonMessage: d.message,
    }));
    for (const u of sc.unserved) {
      for (const orderId of u.order_ids) {
        unserved.push({ orderId, reasonCode: u.reason_code as UnservedReasonCode, reasonMessage: u.reason_message });
      }
    }
    const details: ScenarioDetails = {
      ...sc,
      engine: resp.engine,
      matrix_provider: resp.matrix_provider,
      distance_is_estimated: resp.distance_is_estimated,
      response_warnings: [...built.warnings, ...resp.warnings],
      scope: built.scope,
    };
    const row = await tx.scenarioResult.create({
      data: {
        runId,
        name: sc.name,
        trucksUsed: sc.trucks_used,
        totalDistanceKm: sc.total_distance_km,
        totalTimeMin: sc.total_duration_min,
        totalCost: sc.operating_cost,
        avgUtilizationPct: sc.avg_utilization_pct,
        unservedCount: unserved.length,
        detailsJson: details as never,
        unservedOrders: { create: unserved },
      },
    });
    ids.set(sc.name, row.id);
  }
  void tenantId;
  return ids;
}

/** Materialize a scenario into PlanLoads + RouteAssignments, keeping frozen loads intact. */
export async function applyScenario(tx: Tx, tenantId: string, runId: string, scenarioId: string, userId: string) {
  const run = await tx.runPlan.findFirstOrThrow({ where: { id: runId, tenantId } });
  if (run.status === 'SUPERSEDED') throw new PlanError('This plan version was superseded by a newer version.', 409);
  const sc = await tx.scenarioResult.findFirstOrThrow({ where: { id: scenarioId, runId }, include: { unservedOrders: true } });
  const d = sc.detailsJson as unknown as ScenarioDetails;
  if (!d || !Array.isArray(d.loads) || !d.scope) throw new PlanError('This scenario was produced by the legacy optimizer; re-optimize.', 409);

  // Frozen loads must be exactly the ones the scenario was computed around.
  const frozenNow = await tx.planLoad.findMany({ where: { runId, status: { not: 'PLANNED' } }, include: { assignments: true } });
  const frozenIdsNow = new Set(frozenNow.flatMap((l) => l.assignments.map((a) => a.orderId)));
  const scopeFrozen = new Set(d.scope.frozenOrderIds);
  if (frozenIdsNow.size !== scopeFrozen.size || [...frozenIdsNow].some((id) => !scopeFrozen.has(id))) {
    throw new PlanError('Loads were locked/unlocked after this optimization. Optimize again before applying.', 409);
  }

  await tx.planLoad.deleteMany({ where: { runId, status: 'PLANNED' } });
  await tx.routeAssignment.deleteMany({ where: { runId, loadId: null } });

  const trucks = await tx.truck.findMany({ where: { tenantId, id: { in: d.loads.map((l) => l.truck_id) } } });
  const truckById = new Map(trucks.map((t) => [t.id, t]));
  const orderIds = [...d.scope.orderIds];
  const orders = await tx.order.findMany({ where: { tenantId, id: { in: orderIds } }, select: { id: true, totalCases: true } });
  const casesOf = new Map(orders.map((o) => [o.id, o.totalCases]));

  for (const ld of d.loads) {
    const t = truckById.get(ld.truck_id);
    if (!t) throw new PlanError(`Truck ${ld.truck_id} no longer exists.`, 409);
    const load = await tx.planLoad.create({
      data: {
        tenantId,
        runId,
        truckId: ld.truck_id,
        loadNo: ld.load_no,
        status: 'PLANNED',
        driverId: t.defaultDriverId,
        departMin: ld.depart_min,
        returnMin: ld.return_min,
        distanceKm: ld.distance_km,
        durationMin: ld.duration_min,
        cases: ld.cases,
        weightKg: ld.kg,
        utilizationPct: ld.utilization_pct,
        fuelLitres: ld.fuel_litres,
        fuelCost: ld.fuel_cost,
        operatingCost: ld.total_cost,
        returnLegKm: ld.return_leg_km,
        distanceIsEstimated: d.distance_is_estimated,
      },
    });
    let running = 0;
    const rows: Prisma.RouteAssignmentCreateManyInput[] = [];
    for (const st of ld.stops) {
      st.order_ids.forEach((orderId, k) => {
        running += casesOf.get(orderId) ?? 0;
        rows.push({
          runId,
          truckId: ld.truck_id,
          orderId,
          loadId: load.id,
          loadNo: ld.load_no,
          sequenceInTruck: st.sequence,
          orderInStop: k,
          plannedArrivalMin: Math.max(0, st.arrival_min - ld.depart_min),
          plannedDistanceFromPrevKm: k === 0 ? st.leg_km : 0,
          plannedLoadCases: running,
          etaMin: st.arrival_min,
          serviceStartMin: st.service_start_min,
          departureMin: st.departure_min,
          waitMin: st.wait_min,
          cumulativeKm: st.cum_km,
          hardWindowOk: st.hard_window_ok,
          prefWindowOk: st.pref_window_ok,
        });
      });
    }
    if (rows.length) await tx.routeAssignment.createMany({ data: rows });
  }

  const plannedNew = new Set(d.loads.flatMap((l) => l.stops.flatMap((s) => s.order_ids)));
  const unservedIds = sc.unservedOrders.map((u) => u.orderId);
  if (plannedNew.size) await tx.order.updateMany({ where: { tenantId, id: { in: [...plannedNew] } }, data: { status: 'ASSIGNED' } });
  if (unservedIds.length) await tx.order.updateMany({ where: { tenantId, id: { in: unservedIds } }, data: { status: 'UNSERVED' } });

  await tx.runPlan.update({ where: { id: runId }, data: { chosenScenarioId: scenarioId, status: 'READY' } });
  await refreshPlanFacts(tx, tenantId, runId);
  await tx.auditLog.create({
    data: {
      tenantId,
      userId,
      action: 'SCENARIO_CHOSEN',
      entity: 'RunPlan',
      entityId: runId,
      afterJson: { scenario: sc.name, loads: d.loads.length, unserved: unservedIds.length } as never,
    },
  });
}

/** Recompute reconciliation, daily summary and (for versions > 1) the change summary. */
export async function refreshPlanFacts(tx: Tx, tenantId: string, runId: string) {
  const run = await tx.runPlan.findFirstOrThrow({ where: { id: runId, tenantId } });
  if (!run.chosenScenarioId) return;
  const sc = await tx.scenarioResult.findFirstOrThrow({ where: { id: run.chosenScenarioId }, include: { unservedOrders: true } });
  const d = sc.detailsJson as unknown as ScenarioDetails;
  const scopeIds = [...new Set([...d.scope.orderIds, ...d.scope.frozenOrderIds])];
  const orders = await tx.order.findMany({
    where: { tenantId, id: { in: scopeIds } },
    include: { customer: { select: { id: true, code: true, branchKey: true } }, lines: { include: { product: { select: { code: true, name: true } } } } },
  });
  const loads = await tx.planLoad.findMany({ where: { runId }, include: { assignments: { include: { order: { select: { customerId: true } } } } } });
  const planned = loads.flatMap((l) =>
    l.assignments.map((a) => ({ orderId: a.orderId, customerId: a.order.customerId, truckId: l.truckId, loadNo: l.loadNo })),
  );
  // Planned-for customer on NEW loads comes from the solver stop - checks branches never merge.
  const stopCustomer = new Map<string, string>();
  for (const ld of d.loads) for (const st of ld.stops) for (const oid of st.order_ids) stopCustomer.set(oid, st.customer_id);
  const recon: Reconciliation = reconcile(
    orders.map((o) => ({
      id: o.id,
      customerId: o.customerId,
      customerKey: `${o.customer.code}::${o.customer.branchKey}`,
      lines: o.lines.map((l) => ({ productCode: l.product.code, productName: l.product.name, salesOrderNo: l.salesOrderNo, cases: l.cases })),
    })),
    planned.map((p) => ({ ...p, customerId: stopCustomer.get(p.orderId) ?? p.customerId })),
    sc.unservedOrders.map((u) => ({ orderId: u.orderId, reasonCode: u.reasonCode })),
  );
  const plannedIds = new Set(planned.map((p) => p.orderId));
  const summary = computeSummary({
    orders: orders.map((o) => ({
      id: o.id,
      customerId: o.customerId,
      priority: d.scope.orderPriority[o.id] ?? o.priority,
      cases: o.totalCases,
      weightKg: o.totalWeightKg,
      salesValue: o.salesValue,
      marginValue: o.marginValue,
      isLate: o.isLate,
    })),
    plannedOrderIds: plannedIds,
    unserved: sc.unservedOrders.map((u) => ({ orderId: u.orderId, reasonCode: u.reasonCode })),
    loads: loads.map((l) => ({
      truckId: l.truckId,
      loadNo: l.loadNo,
      cases: l.cases,
      weightKg: l.weightKg,
      distanceKm: l.distanceKm,
      durationMin: l.durationMin,
      utilizationPct: l.utilizationPct,
      fuelLitres: l.fuelLitres,
      fuelCost: l.fuelCost,
      operatingCost: l.operatingCost,
      status: l.status,
    })),
    warnings: [...d.response_warnings, ...d.warnings],
    distanceIsEstimated: d.distance_is_estimated,
    distanceProvider: d.matrix_provider,
    solver: { engine: d.engine, scenario: d.name, status: d.solver_status, timeSec: d.solver_time_sec },
  });
  let change = null;
  if (run.parentRunId) {
    const parent = await tx.runPlan.findFirst({ where: { id: run.parentRunId, tenantId } });
    if (parent?.chosenScenarioId) {
      const psc = await tx.scenarioResult.findFirst({ where: { id: parent.chosenScenarioId } });
      const pd = psc?.detailsJson as unknown as ScenarioDetails | undefined;
      const pLoads = await tx.planLoad.findMany({ where: { runId: parent.id }, include: { assignments: { select: { orderId: true } } } });
      const parentPlanned: AssignmentKey[] = pLoads.flatMap((l) => l.assignments.map((a) => ({ orderId: a.orderId, truckId: l.truckId, loadNo: l.loadNo })));
      change = computeChangeSummary({
        parentVersion: parent.version,
        parentScope: pd ? [...pd.scope.orderIds, ...pd.scope.frozenOrderIds] : parentPlanned.map((p) => p.orderId),
        parentPlanned,
        childScope: scopeIds,
        childPlanned: planned.map((p) => ({ orderId: p.orderId, truckId: p.truckId, loadNo: p.loadNo })),
        lockedLoadsPreserved: loads.filter((l) => l.carriedFromLoadId).length,
      });
    }
  }
  await tx.runPlan.update({
    where: { id: runId },
    data: {
      reconciliationJson: recon as never,
      summaryJson: summary as never,
      changeSummaryJson: (change ?? undefined) as never,
      totalOrders: orders.length,
      unservedCount: sc.unservedOrders.length,
    },
  });
  return { recon, summary, change };
}

// ---------------------------------------------------------------------------------------
// Plan versions
// ---------------------------------------------------------------------------------------

export async function currentPlan(tenantId: string, depotId: string, dateIso: string) {
  return prisma.runPlan.findFirst({
    where: { tenantId, depotId, runDate: dateOnly(dateIso), status: { not: 'SUPERSEDED' } },
    orderBy: { version: 'desc' },
  });
}

export async function getOrCreatePlan(tenantId: string, depotId: string, dateIso: string, userId: string) {
  const existing = await currentPlan(tenantId, depotId, dateIso);
  if (existing) return { run: existing, created: false };
  const depot = await prisma.depot.findFirst({ where: { id: depotId, tenantId, active: true } });
  if (!depot) throw new PlanError('Depot not found or inactive.', 400);
  const run = await prisma.runPlan.create({
    data: { tenantId, depotId, runDate: dateOnly(dateIso), createdById: userId, version: 1, reason: 'INITIAL' },
  });
  await prisma.auditLog.create({
    data: { tenantId, userId, action: 'CREATE', entity: 'RunPlan', entityId: run.id, afterJson: { depotId, runDate: dateIso, version: 1 } as never },
  });
  return { run, created: true };
}

/**
 * New plan version for a late order / re-plan. Frozen loads (and their assignments) are
 * copied verbatim; PLANNED loads are left behind for the optimizer to rebuild. The parent is
 * kept as SUPERSEDED for traceability.
 */
export async function createNextVersion(
  tenantId: string,
  parentRunId: string,
  reason: 'LATE_ORDER' | 'MANUAL_ADJUSTMENT' | 'REOPTIMIZE',
  note: string | null,
  userId: string,
) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "RunPlan" WHERE id = ${parentRunId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (!locked.length) throw new PlanError('Plan not found.', 404);
    const parent = await tx.runPlan.findFirstOrThrow({ where: { id: parentRunId, tenantId } });
    if (parent.status === 'SUPERSEDED') throw new PlanError('This version was already superseded; open the latest version.', 409);
    if (parent.status === 'OPTIMIZING') throw new PlanError('An optimization is running for this plan.', 409);
    const child = await tx.runPlan.create({
      data: {
        tenantId,
        depotId: parent.depotId,
        runDate: parent.runDate,
        createdById: userId,
        version: parent.version + 1,
        parentRunId: parent.id,
        reason,
        reasonNote: note,
        optimizationMode: parent.optimizationMode,
      },
    });
    const frozen = await tx.planLoad.findMany({ where: { runId: parent.id, status: { not: 'PLANNED' } }, include: { assignments: true } });
    for (const l of frozen) {
      const { id: oldId, runId: _r, createdAt: _c, assignments, ...rest } = l;
      void _r;
      void _c;
      const copy = await tx.planLoad.create({ data: { ...rest, runId: child.id, carriedFromLoadId: oldId } });
      if (assignments.length) {
        await tx.routeAssignment.createMany({
          data: assignments.map(({ id: _id, runId: _rr, loadId: _l, ...a }) => {
            void _id;
            void _rr;
            void _l;
            return { ...a, runId: child.id, loadId: copy.id };
          }),
        });
      }
    }
    await tx.runPlan.update({ where: { id: parent.id }, data: { status: 'SUPERSEDED', supersededAt: new Date() } });
    await tx.auditLog.create({
      data: {
        tenantId,
        userId,
        action: 'PLAN_VERSION_CREATED',
        entity: 'RunPlan',
        entityId: child.id,
        afterJson: { parentRunId: parent.id, version: child.version, reason, note, frozenLoadsCarried: frozen.length } as never,
      },
    });
    return { child, frozenLoadsCarried: frozen.length };
  });
}

// ---------------------------------------------------------------------------------------
// Load status changes
// ---------------------------------------------------------------------------------------

export async function changeLoadStatus(
  tenantId: string,
  runId: string,
  loadId: string,
  to: LoadStatusName,
  user: { id: string; role: string },
  hasRole: (role: 'PLANNER' | 'SUPERVISOR') => boolean,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "RunPlan" WHERE id = ${runId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const run = await tx.runPlan.findFirst({ where: { id: runId, tenantId } });
    if (!run) throw new PlanError('Plan not found.', 404);
    if (run.status === 'SUPERSEDED') throw new PlanError('This plan version was superseded. Open the latest version.', 409);
    if (run.status === 'OPTIMIZING') throw new PlanError('Wait for the running optimization to finish.', 409);
    const load = await tx.planLoad.findFirst({ where: { id: loadId, runId, tenantId } });
    if (!load) throw new PlanError('Load not found.', 404);
    const siblings = await tx.planLoad.findMany({ where: { runId, truckId: load.truckId } });
    const check = checkTransition(load, siblings, to);
    if (!check.ok) throw new PlanError(check.reason, 409);
    if (!hasRole(check.role)) throw new PlanError(`Only a ${check.role.toLowerCase()} (or above) can do this.`, 403);
    if (to === 'DISPATCHED') {
      const recon = run.reconciliationJson as unknown as Reconciliation | null;
      if (!recon?.ok) throw new PlanError('Cases do not reconcile for this plan - fix before dispatching.', 409);
    }
    const updated = await tx.planLoad.update({
      where: { id: loadId },
      data: { status: to as LoadStatus, statusChangedAt: new Date(), statusChangedById: user.id },
    });
    const orderIds = (await tx.routeAssignment.findMany({ where: { loadId }, select: { orderId: true } })).map((a) => a.orderId);
    if (to === 'DISPATCHED' && orderIds.length) {
      await tx.order.updateMany({ where: { tenantId, id: { in: orderIds } }, data: { status: 'DISPATCHED' } });
    }
    const all = await tx.planLoad.findMany({ where: { runId }, select: { status: true } });
    const allOut = all.length > 0 && all.every((l) => l.status === 'DISPATCHED' || l.status === 'COMPLETED');
    await tx.runPlan.update({
      where: { id: runId },
      data: { status: allOut ? 'DISPATCHED' : 'READY', finalizedAt: allOut ? new Date() : null },
    });
    await tx.auditLog.create({
      data: {
        tenantId,
        userId: user.id,
        action: `LOAD_${to}`,
        entity: 'PlanLoad',
        entityId: loadId,
        beforeJson: { status: load.status } as never,
        afterJson: { status: to, runId, truckId: load.truckId, loadNo: load.loadNo } as never,
      },
    });
    await refreshPlanFacts(tx, tenantId, runId);
    return updated;
  });
}

export function frozenStatuses(): LoadStatus[] {
  return ['LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'];
}

export { isFrozen, isoOf };
