/**
 * Dispatch plan service: the only place that turns orders into a solver request and a solver
 * response into loads. Route handlers stay thin.
 *
 * Plan = RunPlan row for (depot, delivery date, version). Version 1 is INITIAL. A late order or
 * a re-plan after loads were chosen creates version N+1: frozen loads (LOCKED / LOADING /
 * DISPATCHED / COMPLETED) are copied verbatim, the parent is marked SUPERSEDED (kept, never
 * overwritten) and only the remaining orders are optimized again.
 */
import { Prisma, type LoadStatus, type OrderStatus, type UnservedReasonCode } from '@prisma/client';
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
  routingProviderFor,
  type CustomerForPlanning,
  type TypeProfileLike,
} from './customer-attrs';
import { checkTransition, isFrozen, type LoadStatusName } from './load-state';
import { reconcile, type Reconciliation } from './reconcile';
import {
  choosePartCapacity,
  fitsCapacity,
  mergePortions,
  orderIdOf,
  portionId,
  portionMoney,
  portionsOfPart,
  readPortionLines,
  splitIntoParts,
  type FleetTruck,
  type OpenLine,
  type PartCapacity,
  type PortionRecord,
} from './split';
import { stopServiceMin } from './service-time';
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
  portion?: PortionRecord; // only the open (not frozen) part of the order is dropped
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
  /** Optimizer ids ("<orderId>~<part>") that stand for part of an order (split deliveries). */
  portions?: Record<string, PortionRecord>;
  /** Every order on a frozen load, fully or in part. */
  frozenLoadOrderIds?: string[];
  /** The frozen loads the optimization was computed around (for the "loads changed" check). */
  frozenLoadIds?: string[];
}

/** The order an optimizer order-id stands for, and the portion when it is only part of it. */
export function resolveOrderRef(scope: Pick<PlanScope, 'portions'>, id: string): { orderId: string; portion: PortionRecord | null } {
  return { orderId: orderIdOf(id), portion: scope.portions?.[id] ?? null };
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

/** A window ending before it starts cannot be planned (the solver would reject the whole day):
 * it is dropped for this plan and reported as a warning instead. */
function usableWindow(start: number | null, end: number | null): { start: number | null; end: number | null; ok: boolean } {
  if (start != null && end != null && end < start) return { start: null, end: null, ok: false };
  return { start, end, ok: true };
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
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { country: true } });
  const area = parseServiceArea(cfg.serviceAreaJson, tenant.country);
  const where = await ordersInScopeWhere(tenantId, run.depotId, run.runDate);
  const orders = await prisma.order.findMany({ where, include: ORDER_INCLUDE, orderBy: { uploadedAt: 'asc' } });
  const frozenLoads = await db.planLoad.findMany({
    where: { runId, status: { not: 'PLANNED' } },
    include: { assignments: { select: { orderId: true, portionLinesJson: true } } },
    orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }],
  });
  // What frozen (locked / loading / dispatched) loads already carry. A split order can be only
  // partly on frozen loads: its remaining cases are planned again, never twice.
  const frozenWhole = new Set<string>();
  const frozenLineCases = new Map<string, number>();
  for (const l of frozenLoads) {
    for (const a of l.assignments) {
      const pl = readPortionLines(a.portionLinesJson);
      if (!pl) frozenWhole.add(a.orderId);
      else for (const x of pl) frozenLineCases.set(x.lineId, (frozenLineCases.get(x.lineId) ?? 0) + x.cases);
    }
  }
  const frozenLoadOrderIds = [...new Set(frozenLoads.flatMap((l) => l.assignments.map((a) => a.orderId)))];
  const trucks = await db.truck.findMany({ where: { depotId: run.depotId, active: true }, orderBy: { code: 'asc' } });
  const frozenByTruck = new Map<string, typeof frozenLoads>();
  for (const l of frozenLoads) frozenByTruck.set(l.truckId, [...(frozenByTruck.get(l.truckId) ?? []), l]);
  // Plan continuity: on a re-plan, tell the optimizer which truck carried each order line in the
  // previous version so one late order does not reshuffle every unlocked load. Per line (not per
  // order) so each part of a split delivery is steered to the truck it was on.
  const prevLineTruck = new Map<string, Map<string, number>>(); // lineId -> truckId -> cases
  if (run.parentRunId) {
    const prev = await prisma.routeAssignment.findMany({
      where: { runId: run.parentRunId },
      select: { orderId: true, truckId: true, portionLinesJson: true },
      orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }, { sequenceInTruck: 'asc' }],
    });
    const linesOf = new Map(orders.map((o) => [o.id, o.lines]));
    for (const a of prev) {
      const pl = readPortionLines(a.portionLinesJson) ?? (linesOf.get(a.orderId) ?? []).map((l) => ({ lineId: l.id, cases: l.cases }));
      for (const x of pl) {
        const m = prevLineTruck.get(x.lineId) ?? new Map<string, number>();
        m.set(a.truckId, (m.get(a.truckId) ?? 0) + x.cases);
        prevLineTruck.set(x.lineId, m);
      }
    }
  }
  const previousTruckOf = (lineIds: string[]): string | null => {
    const votes = new Map<string, number>();
    for (const id of lineIds) for (const [t, n] of prevLineTruck.get(id) ?? []) votes.set(t, (votes.get(t) ?? 0) + n);
    return [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  };

  // Each order with the lines (cases) still to plan.
  type OpenOrder = { o: (typeof orders)[number]; lines: OpenLine[]; cases: number; kg: number; partial: boolean };
  const frozenOrderIds: string[] = [];
  const openByCustomer = new Map<string, OpenOrder[]>();
  for (const o of orders) {
    if (frozenWhole.has(o.id)) {
      frozenOrderIds.push(o.id);
      continue;
    }
    // Line kg is what the order total is summed from, so a part's kg matches the order's. Old
    // orders may have no line weights: then the order's own kg is spread per case.
    const linesKg = o.lines.reduce((a, l) => a + l.weightKg, 0);
    const lineKgOk = linesKg > 0 && Math.abs(linesKg - o.totalWeightKg) <= 0.5 + 0.001 * o.totalWeightKg;
    const orderKgPerCase = o.totalCases > 0 ? o.totalWeightKg / o.totalCases : 0;
    const lines: OpenLine[] = o.lines.map((l) => ({
      lineId: l.id,
      orderId: o.id,
      cases: Math.max(0, l.cases - (frozenLineCases.get(l.id) ?? 0)),
      kgPerCase: lineKgOk ? (l.cases > 0 ? l.weightKg / l.cases : 0) : orderKgPerCase,
    }));
    const partial = lines.some((l, i) => l.cases !== o.lines[i].cases);
    const cases = lines.reduce((a, l) => a + l.cases, 0);
    if (partial && cases === 0) {
      frozenOrderIds.push(o.id); // every case is already on frozen loads
      continue;
    }
    const open: OpenOrder = partial
      ? { o, lines: lines.filter((l) => l.cases > 0), cases, kg: Math.round(lines.reduce((a, l) => a + l.cases * l.kgPerCase, 0) * 10) / 10, partial }
      : { o, lines, cases: o.totalCases, kg: o.totalWeightKg, partial };
    openByCustomer.set(o.customerId, [...(openByCustomer.get(o.customerId) ?? []), open]);
  }
  // Orders on frozen loads that today's order query no longer returns (e.g. a legacy order
  // without a depot once a second depot exists) stay in scope, so the plan still reconciles.
  const inScope = new Set([...frozenOrderIds, ...[...openByCustomer.values()].flat().map((x) => x.o.id)]);
  for (const id of frozenLoadOrderIds) if (!inScope.has(id)) frozenOrderIds.push(id);

  // Split deliveries: a customer that fits no truck (cases or kg) is planned as several stops at
  // the same place. Only trucks with a load left today count, and parts are sized so that
  // several of them can carry the parts (see choosePartCapacity).
  const fleet: FleetTruck[] = trucks.map((t) => ({
    code: t.code,
    cases: t.capacityCases,
    kg: t.capacityWeightKg > 0 ? t.capacityWeightKg : null,
    tripsLeft: (t.maxTripsPerDay || cfg.maxTripsPerTruck) - (frozenByTruck.get(t.id)?.length ?? 0),
  }));
  const available = fleet.filter((t) => t.cases > 0 && t.tripsLeft > 0);
  const partCapFor = (cases: number, kg: number): { cap: PartCapacity; truckCode: string } | null => {
    const pool = available.length ? available : fleet;
    if (!cfg.splitDeliveries || !pool.some((t) => t.cases > 0)) return null;
    if (pool.some((t) => t.cases > 0 && fitsCapacity(cases, kg, { cases: t.cases, kg: t.kg }))) return null;
    return choosePartCapacity(cases, kg, pool);
  };

  const preDrops: OrderDrop[] = [];
  const blockingByCustomer = new Map<string, BlockingIssue>();
  const orderPriority: Record<string, number> = {};
  const portions: Record<string, PortionRecord> = {};
  const stopList: DispatchStop[] = [];
  const scopeIds: string[] = [];
  const badWindows: string[] = [];
  const splitNotes: string[] = [];
  const wholePortion = (x: OpenOrder): PortionRecord => ({
    orderId: x.o.id,
    lines: x.lines.map((l) => ({ lineId: l.lineId, cases: l.cases })),
    cases: x.cases,
    weightKg: x.kg,
    part: null,
    parts: null,
  });
  // Id the optimizer sees for (the open part of) an order: plain when the whole order is open.
  const orderRef = (x: OpenOrder) => {
    if (!x.partial) return x.o.id;
    const id = portionId(x.o.id, 'open');
    portions[id] = wholePortion(x);
    return id;
  };
  // Revenue / margin of (part of) an order: from its own lines when they carry values.
  const money = (o: OpenOrder['o'], field: 'salesValue' | 'marginValue', lines: { lineId: string; cases: number }[] | null) =>
    lines === null
      ? o[field]
      : portionMoney(o[field], o.totalCases, o.lines.map((l) => ({ id: l.id, cases: l.cases, value: l[field] })), lines);
  const openMoney = (x: OpenOrder, field: 'salesValue' | 'marginValue') => money(x.o, field, x.partial ? x.lines : null);

  for (const group of openByCustomer.values()) {
    const c = toPlanningCustomer(group[0].o.customer);
    const eff = effectiveAttrs(c, profiles, { serviceTimeMin: cfg.defaultServiceTimeMin });
    const prOf = (o: OpenOrder['o']) => (o.priorityFromFile ? Math.min(o.priority, eff.priority) : eff.priority);
    const pr = Math.min(...group.map((x) => prOf(x.o)));
    for (const x of group) scopeIds.push(x.o.id);
    const cs = coordStatus(c.lat, c.lng, area);
    const locBad = cs === 'MISSING' || cs === 'INVALID' || (cs === 'OUTSIDE_AREA' && !c.locationVerified);
    if (locBad) {
      const code: UnservedReasonCode = cs === 'MISSING' ? 'MISSING_COORDINATES' : 'INVALID_LOCATION';
      const issue = customerIssues(c, eff, area).find((i) => i.blocking);
      const b = blockingByCustomer.get(c.id) ?? {
        customerId: c.id, customerCode: c.code, branchCode: c.branchCode, customerName: c.name,
        code: cs === 'MISSING' ? 'LOCATION_REQUIRED' : 'INVALID_LOCATION', message: issue?.message ?? '', orderIds: [], cases: 0,
      };
      for (const x of group) {
        preDrops.push({ orderId: x.o.id, reasonCode: code, message: issue?.message ?? 'Location missing.', portion: x.partial ? wholePortion(x) : undefined });
        orderPriority[x.o.id] = prOf(x.o);
        b.orderIds.push(x.o.id);
        b.cases += x.cases;
      }
      blockingByCustomer.set(c.id, b);
      continue;
    }
    const hard = usableWindow(eff.hardStart, eff.hardEnd);
    const pref = usableWindow(eff.prefStart, eff.prefEnd);
    if (!hard.ok || !pref.ok) badWindows.push(c.branchCode ? `${c.code}/${c.branchCode}` : c.code);
    const totalCases = group.reduce((a, x) => a + x.cases, 0);
    const totalKg = group.reduce((a, x) => a + x.kg, 0);
    const late = group.some((x) => x.o.isLate);
    const serviceMin = eff.serviceMin; // + unloading time per case (stopServiceMin)
    const base = {
      customer_id: c.id,
      lat: c.lat as number,
      lng: c.lng as number,
      priority: pr,
      hard_start_min: hard.start,
      hard_end_min: hard.end,
      pref_start_min: pref.start,
      pref_end_min: pref.end,
      late,
    };
    const sumMoney = (vals: (number | null)[]) => (vals.every((v) => v !== null) ? vals.reduce<number>((a, v) => a + (v ?? 0), 0) : null);

    const split = partCapFor(totalCases, totalKg);
    if (!split) {
      const ids = group.map(orderRef);
      stopList.push({
        ...base,
        stop_id: c.id,
        order_ids: ids,
        demand_cases: totalCases,
        demand_kg: totalKg,
        service_min: stopServiceMin(serviceMin, cfg.serviceMinPerCase, totalCases),
        previous_truck_id: previousTruckOf(group.flatMap((x) => x.lines.map((l) => l.lineId))),
        margin: sumMoney(group.map((x) => openMoney(x, 'marginValue'))),
        revenue: sumMoney(group.map((x) => openMoney(x, 'salesValue'))),
      });
    } else {
      const parts = splitIntoParts(group.flatMap((x) => x.lines), split.cap);
      const byOrder = new Map(group.map((x) => [x.o.id, x.o]));
      const kgPerCase = new Map(group.flatMap((x) => x.lines.map((l) => [l.lineId, l.kgPerCase] as const)));
      parts.forEach((part, k) => {
        const recs = portionsOfPart(part, k + 1, parts.length);
        const ids = recs.map((r) => {
          const id = portionId(r.orderId, k + 1);
          portions[id] = r;
          return id;
        });
        const cases = recs.reduce((a, r) => a + r.cases, 0);
        // From the exact weights, never above the payload the part was sized for (display
        // rounding of each line must not push a full part over its truck).
        const exactKg = part.reduce((a, x) => a + x.cases * (kgPerCase.get(x.lineId) ?? 0), 0);
        stopList.push({
          ...base,
          stop_id: `${c.id}#${k + 1}`,
          order_ids: ids,
          demand_cases: cases,
          demand_kg: Math.min(split.cap.kg ?? Number.POSITIVE_INFINITY, Math.round(exactKg * 10) / 10),
          // Unloading time follows the part's share of the delivery (at least a few minutes).
          service_min: stopServiceMin(serviceMin, cfg.serviceMinPerCase, cases, totalCases),
          previous_truck_id: previousTruckOf(part.map((x) => x.lineId)),
          margin: sumMoney(recs.map((r) => money(byOrder.get(r.orderId)!, 'marginValue', r.lines))),
          revenue: sumMoney(recs.map((r) => money(byOrder.get(r.orderId)!, 'salesValue', r.lines))),
        });
      });
      splitNotes.push(
        `${c.branchCode ? `${c.code}/${c.branchCode}` : c.code} (${totalCases} cases, ${Math.round(totalKg)} kg) in ${parts.length} parts sized for ${split.truckCode}`,
      );
    }
    for (const x of group) orderPriority[x.o.id] = pr;
  }

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
  if (splitNotes.length) {
    warnings.push(`Split delivery (bigger than any truck): ${splitNotes.join('; ')}.`);
  }
  if (cfg.distanceProvider === 'MAPBOX_MATRIX') warnings.push('Mapbox matrix is not used by the dispatch planner; OSRM/Haversine is used instead.');
  if (badWindows.length) {
    warnings.push(`Time window ignored because it ends before it starts: ${badWindows.join(', ')}. Fix it in the customer master.`);
  }
  const routing = routingProviderFor(cfg, tenant.country);
  if (routing.outsideCoverage) {
    warnings.push('Road distances (OSRM) cover Oman and the UAE only; this plan uses straight-line estimates.');
  }
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
      loading_min_per_case: cfg.loadingMinPerCase,
      max_trips_per_truck: cfg.maxTripsPerTruck,
      fuel_price_per_litre: cfg.fuelPricePerLitre,
      driver_cost_per_hour: cfg.driverCostPerHour,
      // A higher priority always wins over any number of lower ones (weights kept for reference).
      strict_priorities: true,
      priority_weights: parsePriorityWeights(cfg.priorityWeightsJson),
      pref_window_penalty_per_min: cfg.prefWindowPenaltyPerMin,
      use_margin: true,
      distance_provider: routing.provider,
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
    scope: { orderIds: scopeIds, frozenOrderIds, orderPriority, portions, frozenLoadOrderIds, frozenLoadIds: frozenLoads.map((l) => l.id).sort() },
    blocking: [...blockingByCustomer.values()],
    warnings,
  };
}

// ---------------------------------------------------------------------------------------
// Persist the solver response and apply a scenario as the plan
// ---------------------------------------------------------------------------------------

/** Portion columns of a RouteAssignment / UnservedOrder row (all null = the whole order). */
function portionFields(p: PortionRecord | null) {
  return p
    ? { portionCases: p.cases, portionWeightKg: p.weightKg, portionLinesJson: p.lines as unknown as Prisma.InputJsonValue }
    : { portionCases: null, portionWeightKg: null, portionLinesJson: Prisma.DbNull };
}

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
    const unserved: Prisma.UnservedOrderUncheckedCreateWithoutScenarioInput[] = built.preDrops.map((d) => ({
      orderId: d.orderId,
      reasonCode: d.reasonCode,
      reasonMessage: d.message,
      ...portionFields(d.portion ?? null),
    }));
    // Split parts left off the plan: one row per order and reason, the parts' lines merged.
    const parts = new Map<string, { orderId: string; reasonCode: string; reasonMessage: string; list: PortionRecord[] }>();
    for (const u of sc.unserved) {
      for (const id of u.order_ids) {
        const { orderId, portion } = resolveOrderRef(built.scope, id);
        if (!portion) {
          unserved.push({ orderId, reasonCode: u.reason_code as UnservedReasonCode, reasonMessage: u.reason_message });
          continue;
        }
        const key = `${orderId}|${u.reason_code}`;
        const g = parts.get(key) ?? { orderId, reasonCode: u.reason_code, reasonMessage: u.reason_message, list: [] };
        g.list.push(portion);
        parts.set(key, g);
      }
    }
    for (const g of parts.values()) {
      unserved.push({
        orderId: g.orderId,
        reasonCode: g.reasonCode as UnservedReasonCode,
        reasonMessage: g.reasonMessage,
        ...portionFields(mergePortions(g.list)),
      });
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
        unservedCount: new Set(unserved.map((u) => u.orderId)).size,
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
  if (!isDispatchDetails(sc.detailsJson)) {
    throw new PlanError('This option was made by the previous optimizer and cannot be applied. Plan the day from Daily dispatch.', 409);
  }
  const d = sc.detailsJson;

  // Frozen loads must be exactly the ones the scenario was computed around.
  const frozenNow = await tx.planLoad.findMany({ where: { runId, status: { not: 'PLANNED' } }, include: { assignments: true } });
  // Compared by load: one split order can sit on several loads, so unlocking one of them does
  // not change the set of orders. (Plans optimized before split deliveries compare orders.)
  const frozenIdsNow = new Set(frozenNow.flatMap((l) => l.assignments.map((a) => a.orderId)));
  const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((id) => b.has(id));
  const unchanged = d.scope.frozenLoadIds
    ? sameSet(new Set(frozenNow.map((l) => l.id)), new Set(d.scope.frozenLoadIds)) &&
      sameSet(frozenIdsNow, new Set(d.scope.frozenLoadOrderIds ?? []))
    : sameSet(frozenIdsNow, new Set(d.scope.frozenOrderIds));
  if (!unchanged) {
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
      st.order_ids.forEach((ref, k) => {
        const { orderId, portion } = resolveOrderRef(d.scope, ref);
        running += portion ? portion.cases : (casesOf.get(orderId) ?? 0);
        rows.push({
          ...portionFields(portion),
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

  const plannedNew = new Set(d.loads.flatMap((l) => l.stops.flatMap((s) => s.order_ids.map(orderIdOf))));
  // A split order with any part on a truck counts as assigned; the summary reports it as partial.
  const unservedIds = [...new Set(sc.unservedOrders.map((u) => u.orderId))].filter((id) => !plannedNew.has(id) && !frozenIdsNow.has(id));
  // Never move an order backwards: one already out for delivery (or delivered) keeps its status.
  const movable = { notIn: ['DISPATCHED', 'DELIVERED'] as OrderStatus[] };
  if (plannedNew.size) {
    await tx.order.updateMany({ where: { tenantId, id: { in: [...plannedNew] }, status: movable }, data: { status: 'ASSIGNED' } });
  }
  if (unservedIds.length) {
    await tx.order.updateMany({ where: { tenantId, id: { in: unservedIds }, status: movable }, data: { status: 'UNSERVED' } });
  }

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
  const loads = await tx.planLoad.findMany({ where: { runId }, include: { assignments: { include: { order: { select: { customerId: true, totalCases: true } } } } } });
  const planned = loads.flatMap((l) =>
    l.assignments.map((a) => ({
      orderId: a.orderId,
      customerId: a.order.customerId,
      truckId: l.truckId,
      loadNo: l.loadNo,
      lines: readPortionLines(a.portionLinesJson),
      cases: a.portionCases ?? a.order.totalCases,
    })),
  );
  // Planned-for customer on NEW loads comes from the solver stop - checks branches never merge.
  const stopCustomer = new Map<string, string>();
  const where = (truckId: string, loadNo: number, orderId: string) => `${truckId}:${loadNo}:${orderId}`;
  for (const ld of d.loads) {
    for (const st of ld.stops) for (const oid of st.order_ids) stopCustomer.set(where(ld.truck_id, ld.load_no, orderIdOf(oid)), st.customer_id);
  }
  const recon: Reconciliation = reconcile(
    orders.map((o) => ({
      id: o.id,
      customerId: o.customerId,
      customerKey: `${o.customer.code}::${o.customer.branchKey}`,
      lines: o.lines.map((l) => ({ id: l.id, productCode: l.product.code, productName: l.product.name, salesOrderNo: l.salesOrderNo, cases: l.cases })),
    })),
    planned.map(({ cases: _c, ...p }) => ({ ...p, customerId: stopCustomer.get(where(p.truckId, p.loadNo, p.orderId)) ?? p.customerId })),
    sc.unservedOrders.map((u) => ({ orderId: u.orderId, reasonCode: u.reasonCode, lines: readPortionLines(u.portionLinesJson) })),
  );
  const plannedIds = new Set(planned.map((p) => p.orderId));
  const plannedCasesByOrder = new Map<string, number>();
  for (const p of planned) plannedCasesByOrder.set(p.orderId, (plannedCasesByOrder.get(p.orderId) ?? 0) + p.cases);
  // Money of what is actually planned: a split part is valued from its own lines.
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const plannedMoneyByOrder = new Map<string, { revenue: number | null; margin: number | null }>();
  for (const p of planned) {
    const o = orderById.get(p.orderId);
    if (!o) continue;
    const val = (field: 'salesValue' | 'marginValue') =>
      p.lines ? portionMoney(o[field], o.totalCases, o.lines.map((l) => ({ id: l.id, cases: l.cases, value: l[field] })), p.lines) : o[field];
    const cur = plannedMoneyByOrder.get(p.orderId) ?? { revenue: 0, margin: 0 };
    const r = val('salesValue');
    const m = val('marginValue');
    plannedMoneyByOrder.set(p.orderId, {
      revenue: cur.revenue === null || r === null ? null : cur.revenue + r,
      margin: cur.margin === null || m === null ? null : cur.margin + m,
    });
  }
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
    plannedCasesByOrder,
    plannedMoneyByOrder,
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
      const pdRaw = psc?.detailsJson;
      const pd = isDispatchDetails(pdRaw) ? pdRaw : undefined;
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
      unservedCount: new Set(sc.unservedOrders.map((u) => u.orderId)).size,
    },
  });
  return { recon, summary, change };
}

// ---------------------------------------------------------------------------------------
// Plan versions
// ---------------------------------------------------------------------------------------

/**
 * The live plan for a depot and day. Plans created by the previous optimizer are all version 1,
 * and a day can hold several of them, so ties go to the plan that was actually applied and
 * then to the newest: the answer must never flip between requests.
 */
export async function currentPlan(tenantId: string, depotId: string, dateIso: string) {
  return prisma.runPlan.findFirst({
    where: { tenantId, depotId, runDate: dateOnly(dateIso), status: { notIn: ['SUPERSEDED', 'ARCHIVED'] } },
    orderBy: [{ version: 'desc' }, { chosenScenarioId: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
  });
}

/** Chosen scenario stored by this planner (not the previous PyVRP optimizer, whose details have no scope/loads). */
export function isDispatchDetails(json: unknown): json is ScenarioDetails {
  const d = json as Partial<ScenarioDetails> | null;
  return !!d && typeof d === 'object' && !!d.scope && Array.isArray(d.loads);
}

/** Plans made by the previous optimizer (before the dispatch planner) cannot be re-optimized or re-planned in place. */
export async function isLegacyPlan(tenantId: string, runId: string): Promise<boolean> {
  const legacyRows = await prisma.routeAssignment.count({ where: { runId, loadId: null, run: { tenantId } } });
  if (legacyRows > 0) return true;
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId }, select: { chosenScenarioId: true } });
  if (!run?.chosenScenarioId) return false;
  const sc = await prisma.scenarioResult.findFirst({ where: { id: run.chosenScenarioId }, select: { detailsJson: true } });
  return !isDispatchDetails(sc?.detailsJson);
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
          data: assignments.map(({ id: _id, runId: _rr, loadId: _l, portionLinesJson, ...a }) => {
            void _id;
            void _rr;
            void _l;
            return { ...a, portionLinesJson: portionLinesJson ?? Prisma.DbNull, runId: child.id, loadId: copy.id };
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
    const orderIds = [...new Set((await tx.routeAssignment.findMany({ where: { loadId }, select: { orderId: true } })).map((a) => a.orderId))];
    if (to === 'DISPATCHED' && orderIds.length) {
      // A split order is DISPATCHED only once every part is out (and none is unserved).
      const parts = await tx.routeAssignment.findMany({ where: { runId, orderId: { in: orderIds } }, select: { orderId: true, load: { select: { status: true } } } });
      const unserved = run.chosenScenarioId
        ? new Set((await tx.unservedOrder.findMany({ where: { scenarioId: run.chosenScenarioId, orderId: { in: orderIds } }, select: { orderId: true } })).map((u) => u.orderId))
        : new Set<string>();
      const out = orderIds.filter(
        (id) => !unserved.has(id) && parts.filter((p) => p.orderId === id).every((p) => p.load?.status === 'DISPATCHED' || p.load?.status === 'COMPLETED'),
      );
      if (out.length) await tx.order.updateMany({ where: { tenantId, id: { in: out } }, data: { status: 'DISPATCHED' } });
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
