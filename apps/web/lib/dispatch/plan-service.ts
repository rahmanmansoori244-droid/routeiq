/**
 * Dispatch plan service: the only place that turns orders into a solver request and a solver
 * response into loads. Route handlers stay thin.
 *
 * Plan = RunPlan row for (depot, delivery date, version). Version 1 is INITIAL. A late order or
 * a re-plan after loads were chosen creates version N+1: frozen loads (LOCKED / LOADING /
 * DISPATCHED / COMPLETED) are copied verbatim, the parent is marked SUPERSEDED (kept, never
 * overwritten) and only the remaining orders are optimized again.
 */
import { Prisma, type LoadStatus, type OptimizationMode, type OrderStatus, type PlanReason, type RunStatus, type UnservedReasonCode } from '@prisma/client';
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
import { assignReplanDrivers, checkDriverChange, checkTransition, isFrozen, scenariolessTransitionAllowed, type LoadStatusName } from './load-state';
import { reconcile, type Reconciliation } from './reconcile';
import {
  choosePartCapacity,
  fitsCapacity,
  mergePortions,
  orderIdOf,
  partDemandKg,
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
import { MAX_SERVICE_MIN, stopService } from './service-time';
import {
  groupUnknownWeights,
  orderUsesLineWeights,
  resolveOrderLineWeights,
  type LineWeightChange,
  type OrderWeightChange,
  type UnknownWeight,
} from './weights';
import { computeChangeSummary, computeSummary, type AssignmentKey } from './summary';
import { dateOnly, isoOf } from './time';
import { PlanError } from './plan-errors';
import { asPlanBusy, lockPlanDay, lockRunForWrite, setLockTimeout } from './plan-locks';
import { appliedPlanStatus } from './plan-status';
import { copyRowData } from './prisma-copy';

export { PlanError, planErrorBody } from './plan-errors';

type Tx = Prisma.TransactionClient;
/** The Prisma client or a transaction client (read helpers that also run inside a transaction). */
type Db = Prisma.TransactionClient | typeof prisma;

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
  /** Open lines sent with 0 kg because neither the line nor its product has a weight. */
  unknownWeights: UnknownWeight[];
  /**
   * Line weights this request takes from the product master (0 kg lines whose product has a
   * case weight now, lines weighed from the master whose case weight was corrected), for orders
   * with no part on a frozen load. They are saved with the optimize (applyWeightChanges) - never
   * by a probe - so the lines, orders and loads of the plan all use the kg the solver was sent.
   */
  weightChanges: WeightChanges;
}

export interface WeightChanges {
  lines: (LineWeightChange & { product: string })[];
  orders: OrderWeightChange[];
}

const ORDER_INCLUDE = {
  customer: true,
  lines: { include: { product: { select: { code: true, name: true, weightPerCaseKg: true, active: true } } } },
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

/**
 * Whether moving an order to another truck than in the previous version costs a penalty. Late
 * orders and manual adjustments keep the rest of the plan steady. A re-optimize asks for the best
 * plan for everything not locked, so it starts from scratch (frozen loads never move either way).
 */
export function usesPlanContinuity(run: { parentRunId: string | null; reason: PlanReason }): boolean {
  return !!run.parentRunId && run.reason !== 'REOPTIMIZE';
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
  if (run.parentRunId && usesPlanContinuity(run)) {
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
  const lineInfo = new Map<string, { productCode: string; productName: string; productActive: boolean }>();
  const unknownWeightLines: { productCode: string; productName: string; cases: number }[] = [];
  const weightChanges: WeightChanges = { lines: [], orders: [] };
  for (const o of orders) {
    if (frozenWhole.has(o.id)) {
      frozenOrderIds.push(o.id);
      continue;
    }
    for (const l of o.lines) lineInfo.set(l.id, { productCode: l.product.code, productName: l.product.name, productActive: l.product.active });
    // Line kg is what the order total is summed from, so a part's kg matches the order's. Old
    // orders may have no line weights: then the order's own kg is spread per case. A line at 0 kg
    // (unknown) or weighed from the product master is planned with the product's case weight now
    // (see weights.ts). Here that is in memory only: the optimize saves it (applyWeightChanges)
    // for orders with no part on a frozen load, so a probe never changes a live plan's orders.
    const lineLevel = orderUsesLineWeights(o);
    const orderKgPerCase = o.totalCases > 0 ? o.totalWeightKg / o.totalCases : 0;
    const frozenPart = o.lines.some((l) => (frozenLineCases.get(l.id) ?? 0) > 0);
    const resolved = resolveOrderLineWeights(
      [{ id: o.id, totalWeightKg: o.totalWeightKg, lines: o.lines.map((l) => ({ id: l.id, cases: l.cases, weightKg: l.weightKg, fromMaster: l.weightFromMaster, productKgPerCase: l.product.weightPerCaseKg })) }],
      new Set(),
    );
    const lineKg = new Map(resolved.lines.map((c) => [c.lineId, c.afterKg]));
    const orderKg = resolved.orders[0]?.afterKg ?? o.totalWeightKg;
    if (resolved.lines.length && !frozenPart && o.status !== 'DISPATCHED' && o.status !== 'DELIVERED') {
      weightChanges.lines.push(...resolved.lines.map((c) => ({ ...c, product: lineInfo.get(c.lineId)?.productCode ?? '?' })));
      weightChanges.orders.push(...resolved.orders);
    }
    const lines: OpenLine[] = o.lines.map((l) => {
      const kg = lineKg.get(l.id) ?? l.weightKg;
      return {
        lineId: l.id,
        orderId: o.id,
        cases: Math.max(0, l.cases - (frozenLineCases.get(l.id) ?? 0)),
        kgPerCase: !lineLevel ? orderKgPerCase : kg > 0 && l.cases > 0 ? kg / l.cases : 0,
      };
    });
    const partial = lines.some((l, i) => l.cases !== o.lines[i].cases);
    const cases = lines.reduce((a, l) => a + l.cases, 0);
    if (partial && cases === 0) {
      frozenOrderIds.push(o.id); // every case is already on frozen loads
      continue;
    }
    const open: OpenOrder = partial
      ? { o, lines: lines.filter((l) => l.cases > 0), cases, kg: Math.round(lines.reduce((a, l) => a + l.cases * l.kgPerCase, 0) * 10) / 10, partial }
      : { o, lines, cases: o.totalCases, kg: orderKg, partial };
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
  const pool = available.length ? available : fleet;
  const partCapFor = (cases: number, kg: number, maxCaseKg: number): { cap: PartCapacity; truckCode: string } | null => {
    if (!cfg.splitDeliveries || !pool.some((t) => t.cases > 0)) return null;
    if (pool.some((t) => t.cases > 0 && fitsCapacity(cases, kg, { cases: t.cases, kg: t.kg }))) return null;
    return choosePartCapacity(cases, kg, pool, maxCaseKg);
  };
  // One case heavier than every payload cannot go on any truck: almost always a wrong case weight
  // (kg per pallet, grams). Such lines are left unserved before the optimizer, with that hint.
  const usableTrucks = pool.filter((t) => t.cases > 0);
  const maxPayloadKg = usableTrucks.length && usableTrucks.every((t) => t.kg !== null) ? Math.max(...usableTrucks.map((t) => t.kg as number)) : null;
  const tooHeavy = (l: OpenLine) => maxPayloadKg !== null && l.kgPerCase > maxPayloadKg + 1e-6;
  const heavyMessage = (lines: OpenLine[]) =>
    [...new Map(lines.map((l) => [lineInfo.get(l.lineId)?.productCode ?? '?', l.kgPerCase])).entries()]
      .map(([code, kg]) => `One case of ${code} weighs ${Math.round(kg * 10) / 10} kg, more than any truck payload (${Math.round(maxPayloadKg ?? 0)} kg) - check the product weight.`)
      .join(' ');

  const preDrops: OrderDrop[] = [];
  const blockingByCustomer = new Map<string, BlockingIssue>();
  const orderPriority: Record<string, number> = {};
  const portions: Record<string, PortionRecord> = {};
  const stopList: DispatchStop[] = [];
  const scopeIds: string[] = [];
  const badWindows: string[] = [];
  const splitNotes: string[] = [];
  const inactiveCustomers: string[] = [];
  const inactiveProducts = new Set<string>();
  const tooHeavyNotes: string[] = [];
  const longStops: string[] = [];
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
    const cust = group[0].o.customer;
    const c = toPlanningCustomer(cust);
    const eff = effectiveAttrs(c, profiles, { serviceTimeMin: cfg.defaultServiceTimeMin });
    const prOf = (o: OpenOrder['o']) => (o.priorityFromFile ? Math.min(o.priority, eff.priority) : eff.priority);
    const pr = Math.min(...group.map((x) => prOf(x.o)));
    const label = c.branchCode ? `${c.code}/${c.branchCode}` : c.code;
    for (const x of group) scopeIds.push(x.o.id);
    // A customer deactivated after its orders were confirmed: its open orders are not delivered
    // (reactivating the customer brings them back at the next re-plan). Frozen loads keep theirs.
    if (!cust.active) {
      for (const x of group) {
        preDrops.push({
          orderId: x.o.id,
          reasonCode: 'INVALID_CUSTOMER',
          message: 'Customer deactivated after the order was confirmed - reactivate it in Customers to deliver it, or leave it unserved.',
          portion: x.partial ? wholePortion(x) : undefined,
        });
        orderPriority[x.o.id] = prOf(x.o);
      }
      inactiveCustomers.push(label);
      continue;
    }
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
    // Cases heavier than every truck payload are left out (a data error), the rest is planned.
    const live: OpenOrder[] = [];
    for (const x of group) {
      const heavy = x.lines.filter(tooHeavy);
      if (!heavy.length) {
        live.push(x);
        continue;
      }
      const rest = x.lines.filter((l) => !tooHeavy(l));
      const heavyPortion: PortionRecord = {
        orderId: x.o.id,
        lines: heavy.map((l) => ({ lineId: l.lineId, cases: l.cases })),
        cases: heavy.reduce((a, l) => a + l.cases, 0),
        weightKg: Math.round(heavy.reduce((a, l) => a + l.cases * l.kgPerCase, 0) * 10) / 10,
        part: null,
        parts: null,
      };
      // The whole order when nothing else of it is open or frozen; else just those lines.
      preDrops.push({ orderId: x.o.id, reasonCode: 'EXCEEDS_ANY_TRUCK_CAPACITY', message: heavyMessage(heavy), portion: rest.length || x.partial ? heavyPortion : undefined });
      orderPriority[x.o.id] = prOf(x.o);
      tooHeavyNotes.push(`${label}: ${heavyMessage(heavy)}`);
      if (rest.length) {
        live.push({
          o: x.o,
          lines: rest,
          cases: rest.reduce((a, l) => a + l.cases, 0),
          kg: Math.round(rest.reduce((a, l) => a + l.cases * l.kgPerCase, 0) * 10) / 10,
          partial: true,
        });
      }
    }
    if (!live.length) continue;
    for (const x of live) {
      for (const l of x.lines) {
        if (l.cases > 0 && !(l.kgPerCase > 0)) {
          const info = lineInfo.get(l.lineId);
          unknownWeightLines.push({ productCode: info?.productCode ?? '?', productName: info?.productName ?? '', cases: l.cases });
        }
        if (lineInfo.get(l.lineId)?.productActive === false) inactiveProducts.add(lineInfo.get(l.lineId)!.productCode);
      }
    }
    const hard = usableWindow(eff.hardStart, eff.hardEnd);
    const pref = usableWindow(eff.prefStart, eff.prefEnd);
    if (!hard.ok || !pref.ok) badWindows.push(label);
    const totalCases = live.reduce((a, x) => a + x.cases, 0);
    const totalKg = live.reduce((a, x) => a + x.kg, 0);
    const late = live.some((x) => x.o.isLate);
    const serviceMin = eff.serviceMin; // + unloading time per case (stopService)
    const serviceOf = (cases: number, total?: number) => {
      const s = stopService(serviceMin, cfg.serviceMinPerCase, cases, total);
      if (s.capped) longStops.push(`${label} needs ${s.neededMin} min`);
      return s.min;
    };
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

    const maxCaseKg = Math.max(0, ...live.flatMap((x) => x.lines.map((l) => l.kgPerCase)));
    const split = partCapFor(totalCases, totalKg, maxCaseKg);
    if (!split) {
      const ids = live.map(orderRef);
      stopList.push({
        ...base,
        stop_id: c.id,
        order_ids: ids,
        demand_cases: totalCases,
        demand_kg: totalKg,
        service_min: serviceOf(totalCases),
        previous_truck_id: previousTruckOf(live.flatMap((x) => x.lines.map((l) => l.lineId))),
        margin: sumMoney(live.map((x) => openMoney(x, 'marginValue'))),
        revenue: sumMoney(live.map((x) => openMoney(x, 'salesValue'))),
      });
    } else {
      const parts = splitIntoParts(live.flatMap((x) => x.lines), split.cap);
      const byOrder = new Map(live.map((x) => [x.o.id, x.o]));
      const kgPerCase = new Map(live.flatMap((x) => x.lines.map((l) => [l.lineId, l.kgPerCase] as const)));
      parts.forEach((part, k) => {
        const recs = portionsOfPart(part, k + 1, parts.length);
        const ids = recs.map((r) => {
          const id = portionId(r.orderId, k + 1);
          portions[id] = r;
          return id;
        });
        const cases = recs.reduce((a, r) => a + r.cases, 0);
        stopList.push({
          ...base,
          stop_id: `${c.id}#${k + 1}`,
          order_ids: ids,
          demand_cases: cases,
          // The true kg, never capped at the payload the part was sized for (F01).
          demand_kg: partDemandKg(part, kgPerCase),
          // Unloading time follows the part's share of the delivery (at least a few minutes).
          service_min: serviceOf(cases, totalCases),
          previous_truck_id: previousTruckOf(part.map((x) => x.lineId)),
          margin: sumMoney(recs.map((r) => money(byOrder.get(r.orderId)!, 'marginValue', r.lines))),
          revenue: sumMoney(recs.map((r) => money(byOrder.get(r.orderId)!, 'salesValue', r.lines))),
        });
      });
      splitNotes.push(`${label} (${totalCases} cases, ${Math.round(totalKg)} kg) in ${parts.length} parts sized for ${split.truckCode}`);
    }
    for (const x of live) orderPriority[x.o.id] = pr;
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
  if (inactiveCustomers.length) {
    warnings.push(`Deactivated customer(s) with open orders, left unserved: ${inactiveCustomers.join(', ')}. Reactivate a customer in Customers and re-plan to deliver them.`);
  }
  if (inactiveProducts.size) {
    warnings.push(`Deactivated product(s) still on open orders, planned as ordered: ${[...inactiveProducts].sort().join(', ')}.`);
  }
  if (tooHeavyNotes.length) warnings.push(`Left unserved, heavier than any truck: ${tooHeavyNotes.join(' ')}`);
  if (longStops.length) {
    warnings.push(
      `Unloading time over ${MAX_SERVICE_MIN} min (the most one stop can take): ${[...new Set(longStops)].join('; ')} - planned with ${MAX_SERVICE_MIN} min, so later arrival times may be optimistic. Check the service time or split the delivery.`,
    );
  }
  const unknownWeights = groupUnknownWeights(unknownWeightLines);
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
    unknownWeights,
    weightChanges,
  };
}

/** Refused because the day changed between building the request and saving the optimize. */
export class OrdersChangedError extends PlanError {
  constructor(message = 'The orders of this day changed while the plan was being prepared (a file was deleted, or weights were applied by another optimize). Optimize again.') {
    super(message, 409);
  }
}

/**
 * Save the line weights a request took from the product master (BuiltRequest.weightChanges):
 * 0-kg lines whose product has a case weight now, and lines weighed from the master whose case
 * weight was corrected. Run inside the transaction that starts the optimize, after the location
 * and weight checks passed - never for a probe - so a refused re-plan leaves the live plan's
 * orders and loads as they were. Set-based (a whole NMWC day in a few statements). Each row is
 * changed only if it still has the kg the request was built from; otherwise OrdersChangedError.
 * One ORDER_WEIGHTS_RESOLVED audit row lists every line and order total before and after.
 */
export async function applyWeightChanges(tx: Tx, tenantId: string, runId: string, changes: WeightChanges, userId: string | null): Promise<number> {
  if (!changes.lines.length) return 0;
  const run = await tx.runPlan.findFirstOrThrow({ where: { id: runId, tenantId }, select: { runDate: true, version: true } });
  const CHUNK = 1000;
  for (let i = 0; i < changes.lines.length; i += CHUNK) {
    const part = changes.lines.slice(i, i + CHUNK);
    const n = await tx.$executeRaw`
      UPDATE "OrderLine" AS l
      SET "weightKg" = v.after_kg, "weightFromMaster" = true
      FROM unnest(${part.map((c) => c.lineId)}::text[], ${part.map((c) => c.beforeKg)}::float8[], ${part.map((c) => c.afterKg)}::float8[]) AS v(id, before_kg, after_kg),
           "Order" AS o
      WHERE l.id = v.id AND o.id = l."orderId" AND o."tenantId" = ${tenantId} AND abs(l."weightKg" - v.before_kg) < 0.0005`;
    if (n !== part.length) throw new OrdersChangedError();
  }
  for (let i = 0; i < changes.orders.length; i += CHUNK) {
    const part = changes.orders.slice(i, i + CHUNK);
    const n = await tx.$executeRaw`
      UPDATE "Order" AS o
      SET "totalWeightKg" = v.after_kg
      FROM unnest(${part.map((c) => c.orderId)}::text[], ${part.map((c) => c.beforeKg)}::float8[], ${part.map((c) => c.afterKg)}::float8[]) AS v(id, before_kg, after_kg)
      WHERE o.id = v.id AND o."tenantId" = ${tenantId} AND abs(o."totalWeightKg" - v.before_kg) < 0.0005`;
    if (n !== part.length) throw new OrdersChangedError();
  }
  await tx.auditLog.create({
    data: {
      tenantId,
      userId,
      action: 'ORDER_WEIGHTS_RESOLVED',
      entity: 'RunPlan',
      entityId: runId,
      afterJson: { runDate: isoOf(run.runDate), version: run.version, lines: changes.lines, orders: changes.orders } as never,
    },
  });
  return changes.lines.length;
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
  // Every earlier option of this version goes, including the plan a re-plan copied from its
  // parent (createNextVersion): the new RECOMMENDED plan is applied right after, in the same
  // transaction, and replaces the copied PLANNED loads.
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

/** Versions a dispatcher may apply an option to (not superseded, optimizing or archived). */
const APPLY_STATUSES = ['DRAFT', 'READY', 'FAILED', 'DISPATCHED'] as const;

export interface ApplyOptions {
  /** The background job applying its own result: the version must be OPTIMIZING with this job current. */
  jobId?: string;
  /** A dispatcher's choice ("Use instead"): only an OPTIMIZED option can be applied. */
  requireOptimized?: boolean;
}

/**
 * Materialize a scenario into PlanLoads + RouteAssignments, keeping frozen loads intact.
 *
 * The plan row is locked FIRST (lockRunForWrite), before anything is read: a version superseded
 * or optimizing meanwhile is refused (the job may apply to its own OPTIMIZING version), so a
 * superseded version is never written READY again (review F07). The final status follows the
 * loads: DISPATCHED (with finalizedAt) when every load is out, otherwise READY.
 */
export async function applyScenario(tx: Tx, tenantId: string, runId: string, scenarioId: string, userId: string, opts: ApplyOptions = {}) {
  const run = await lockRunForWrite(tx, tenantId, runId, { jobId: opts.jobId, allow: opts.jobId ? undefined : APPLY_STATUSES });
  const sc = await tx.scenarioResult.findFirst({ where: { id: scenarioId, runId }, include: { unservedOrders: true } });
  if (!sc) throw new PlanError('This plan option no longer exists. Reload the plan.', 409, { code: 'SCENARIO_GONE' });
  if (!isDispatchDetails(sc.detailsJson)) {
    throw new PlanError('This option was made by the previous optimizer and cannot be applied. Plan the day from Daily dispatch.', 409);
  }
  const d = sc.detailsJson;
  if (opts.requireOptimized && d.status !== 'OPTIMIZED') {
    throw new PlanError(
      d.status === 'NO_SOLUTION'
        ? `The ${sc.name.replace('_', ' ')} option found no plan (every order would be unserved). It cannot be used.`
        : `The ${sc.name.replace('_', ' ')} option has no loads to use.`,
      409,
      { code: 'SCENARIO_NOT_USABLE' },
    );
  }

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

  const trucks = await tx.truck.findMany({ where: { tenantId, id: { in: d.loads.map((l) => l.truck_id) } } });
  const truckById = new Map(trucks.map((t) => [t.id, t]));
  for (const ld of d.loads) if (!truckById.has(ld.truck_id)) throw new PlanError(`Truck ${ld.truck_id} no longer exists.`, 409);

  // Drivers stay with their truck and trip across re-plans: this version's loads (read before
  // its PLANNED loads are deleted), then the parent version, then the truck's default driver -
  // without guessing one driver onto two trucks at the same time. Rules: assignReplanDrivers.
  const usableDrivers = new Set((await tx.driver.findMany({ where: { tenantId, active: true }, select: { id: true } })).map((x) => x.id));
  const driverSel = { truckId: true, loadNo: true, driverId: true } as const;
  const driversNow = await tx.planLoad.findMany({ where: { runId, tenantId }, select: driverSel });
  const driversParent = run.parentRunId ? await tx.planLoad.findMany({ where: { runId: run.parentRunId, tenantId }, select: driverSel }) : [];
  const loadKey = (truckId: string, loadNo: number) => `${truckId}:${loadNo}`;
  const driverOf = assignReplanDrivers(
    d.loads.map((ld) => ({
      key: loadKey(ld.truck_id, ld.load_no),
      truckId: ld.truck_id,
      loadNo: ld.load_no,
      departMin: ld.depart_min,
      returnMin: ld.return_min,
      defaultDriverId: truckById.get(ld.truck_id)!.defaultDriverId,
    })),
    driversNow,
    driversParent,
    frozenNow,
    usableDrivers,
  );

  await tx.planLoad.deleteMany({ where: { runId, status: 'PLANNED' } });
  await tx.routeAssignment.deleteMany({ where: { runId, loadId: null } });

  const orderIds = [...d.scope.orderIds];
  const orders = await tx.order.findMany({ where: { tenantId, id: { in: orderIds } }, select: { id: true, totalCases: true, totalWeightKg: true } });
  const casesOf = new Map(orders.map((o) => [o.id, o.totalCases]));
  const kgOf = new Map(orders.map((o) => [o.id, o.totalWeightKg]));
  const kgMismatches: { truckId: string; loadNo: number; solverKg: number; ordersKg: number }[] = [];

  for (const ld of d.loads) {
    // A load weighs what its orders (or split portions) weigh - the same figures the stops,
    // manifests and driver sheets show. The optimizer's own sum must agree (F01: a capped part
    // weight once made a load look lighter than it was); a difference is kept in the audit.
    const ordersKg = loadKgFromRefs(ld.stops.flatMap((st) => st.order_ids), d.scope, kgOf);
    if (Math.abs(ordersKg - ld.kg) > 0.5) kgMismatches.push({ truckId: ld.truck_id, loadNo: ld.load_no, solverKg: ld.kg, ordersKg });
    const load = await tx.planLoad.create({
      data: {
        tenantId,
        runId,
        truckId: ld.truck_id,
        loadNo: ld.load_no,
        status: 'PLANNED',
        driverId: driverOf.get(loadKey(ld.truck_id, ld.load_no)) ?? null,
        departMin: ld.depart_min,
        returnMin: ld.return_min,
        distanceKm: ld.distance_km,
        durationMin: ld.duration_min,
        cases: ld.cases,
        weightKg: ordersKg,
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

  // READY, or DISPATCHED when every load of the version is already out (e.g. a late order left
  // unserved while every carried load is dispatched). Conditional: never over a superseded row.
  const next = appliedPlanStatus((await tx.planLoad.findMany({ where: { runId }, select: { status: true } })).map((l) => l.status));
  const wrote = await tx.runPlan.updateMany({
    where: { id: runId, tenantId, status: { not: 'SUPERSEDED' }, supersededAt: null },
    data: { chosenScenarioId: scenarioId, status: next, finalizedAt: next === 'DISPATCHED' ? (run.finalizedAt ?? new Date()) : null },
  });
  if (wrote.count !== 1) throw new PlanError('This plan version was superseded by a newer version. Open the latest version.', 409, { code: 'SUPERSEDED' });
  await refreshPlanFacts(tx, tenantId, runId);
  await tx.auditLog.create({
    data: {
      tenantId,
      userId,
      action: 'SCENARIO_CHOSEN',
      entity: 'RunPlan',
      entityId: runId,
      afterJson: { scenario: sc.name, loads: d.loads.length, unserved: unservedIds.length, ...(kgMismatches.length ? { loadKgMismatches: kgMismatches } : {}) } as never,
    },
  });
  if (kgMismatches.length) console.warn('applyScenario: load kg differs from its orders', { runId, kgMismatches });
}

/**
 * "Use instead": apply another option of the same version (choose-scenario). One transaction; the
 * plan row is locked before anything is checked, so a re-plan or a Lock that commits first is
 * seen (409), never overwritten. Refused while optimizing or superseded, once a load of this
 * version was locked (unlock or re-plan first), and for an option that found no plan.
 */
export async function chooseScenario(tenantId: string, runId: string, scenarioId: string, userId: string) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await setLockTimeout(tx);
        await lockRunForWrite(tx, tenantId, runId, { allow: APPLY_STATUSES, optimizingMessage: 'Wait for the optimization to finish.' });
        const frozenNew = await tx.planLoad.count({ where: { runId, status: { not: 'PLANNED' }, carriedFromLoadId: null } });
        if (frozenNew > 0) {
          throw new PlanError('Loads of this version are already locked. Unlock them (or re-plan) before switching scenario.', 409, { code: 'LOADS_LOCKED' });
        }
        await applyScenario(tx, tenantId, runId, scenarioId, userId, { requireOptimized: true });
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (e) {
    throw asPlanBusy(e);
  }
}

/**
 * Kg of a load from the orders it carries: a split portion's own kg, else the order's total.
 * Rounded to 0.1 kg like every stored weight.
 */
export function loadKgFromRefs(refs: string[], scope: Pick<PlanScope, 'portions'>, orderKg: Map<string, number>): number {
  const kg = refs.reduce((a, ref) => {
    const { orderId, portion } = resolveOrderRef(scope, ref);
    return a + (portion ? portion.weightKg : (orderKg.get(orderId) ?? 0));
  }, 0);
  return Math.round(kg * 10) / 10;
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
    // Every order the plan was made for must still exist: a deleted one is a problem, so the
    // plan cannot be dispatched until it is re-planned (F20).
    scopeIds,
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
export async function currentPlan(tenantId: string, depotId: string, dateIso: string, client: Db = prisma) {
  return client.runPlan.findFirst({
    // supersededAt too: a version written READY over its supersede (before the stabilization
    // release) is never the live plan again.
    where: { tenantId, depotId, runDate: dateOnly(dateIso), status: { notIn: ['SUPERSEDED', 'ARCHIVED'] }, supersededAt: null },
    orderBy: [{ version: 'desc' }, { chosenScenarioId: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
  });
}

/** Chosen scenario stored by this planner (not the previous PyVRP optimizer, whose details have no scope/loads). */
export function isDispatchDetails(json: unknown): json is ScenarioDetails {
  const d = json as Partial<ScenarioDetails> | null;
  return !!d && typeof d === 'object' && !!d.scope && Array.isArray(d.loads);
}

/** Late orders for this plan's day that its applied scenario does not contain yet (the day
 * screen's "late orders waiting"). */
export async function pendingLateOrderIds(
  tenantId: string,
  run: { depotId: string; runDate: Date; chosenScenarioId: string | null },
): Promise<string[]> {
  if (!run.chosenScenarioId) return [];
  const sc = await prisma.scenarioResult.findFirst({ where: { id: run.chosenScenarioId, run: { tenantId } }, select: { detailsJson: true } });
  const d = sc?.detailsJson;
  if (!isDispatchDetails(d)) return [];
  const inPlan = new Set([...d.scope.orderIds, ...d.scope.frozenOrderIds, ...(d.scope.frozenLoadOrderIds ?? [])]);
  const where = await ordersInScopeWhere(tenantId, run.depotId, run.runDate);
  const late = await prisma.order.findMany({ where: { ...where, isLate: true }, select: { id: true } });
  return late.map((o) => o.id).filter((id) => !inPlan.has(id));
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

/**
 * The live plan of a depot and day, or version 1 created now (review F06). One transaction under
 * the day lock: the check and the create cannot interleave with another request for the same
 * day, in this web process or another one (Railway deploy overlap), so a day never gets two
 * live plans. `created` is false when a live plan already existed.
 */
export async function createInitialPlan(
  tenantId: string,
  depotId: string,
  dateIso: string,
  userId: string,
  extra: { optimizationMode?: OptimizationMode; totalOrders?: number; audit?: Record<string, unknown>; ip?: string | null } = {},
) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await setLockTimeout(tx);
        await lockPlanDay(tx, tenantId, depotId, dateIso);
        const existing = await currentPlan(tenantId, depotId, dateIso, tx);
        if (existing) return { run: existing, created: false };
        const depot = await tx.depot.findFirst({ where: { id: depotId, tenantId, active: true } });
        if (!depot) throw new PlanError('Depot not found or inactive.', 400);
        const run = await tx.runPlan.create({
          data: {
            tenantId,
            depotId,
            runDate: dateOnly(dateIso),
            createdById: userId,
            version: 1,
            reason: 'INITIAL',
            ...(extra.optimizationMode ? { optimizationMode: extra.optimizationMode } : {}),
            ...(extra.totalOrders !== undefined ? { totalOrders: extra.totalOrders } : {}),
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId,
            action: 'CREATE',
            entity: 'RunPlan',
            entityId: run.id,
            afterJson: { depotId, runDate: dateIso, version: 1, ...(extra.audit ?? {}) } as never,
            ...(extra.ip ? { ip: extra.ip } : {}),
          },
        });
        return { run, created: true };
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
  } catch (e) {
    throw asPlanBusy(e);
  }
}

export async function getOrCreatePlan(tenantId: string, depotId: string, dateIso: string, userId: string) {
  // Fast path without a transaction; the create itself re-checks under the day lock.
  const existing = await currentPlan(tenantId, depotId, dateIso);
  if (existing) return { run: existing, created: false };
  return createInitialPlan(tenantId, depotId, dateIso, userId);
}

/** Versions a re-plan can start from (a superseded or optimizing one is refused). */
const REPLAN_FROM: readonly RunStatus[] = ['DRAFT', 'READY', 'FAILED', 'DISPATCHED'];

/**
 * New plan version for a late order / re-plan (copy-forward, review F03). One transaction, under
 * the day lock and then the parent's row lock:
 *
 * - the child copies EVERY load of the parent (PLANNED ones too; carriedFromLoadId = the parent
 *   load) with its assignments, the parent's CHOSEN option with its unserved orders (not the
 *   alternatives: they were computed around the parent's loads), and the plan facts (summary,
 *   reconciliation, order counts). Its status follows its loads (READY, or DISPATCHED when every
 *   load is out);
 * - the parent becomes SUPERSEDED (kept read-only for traceability).
 *
 * So the new version is a usable copy of the previous plan from the start: if its optimization
 * then fails (solver error, timeout, a deploy during the solve), the day keeps a plan that can be
 * locked and dispatched. A successful optimization replaces the copied PLANNED loads and the
 * copied option (persistDispatchResult + applyScenario); frozen loads are never touched.
 */
export async function createNextVersion(
  tenantId: string,
  parentRunId: string,
  reason: 'LATE_ORDER' | 'MANUAL_ADJUSTMENT' | 'REOPTIMIZE',
  note: string | null,
  userId: string,
) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await setLockTimeout(tx);
        const head = await tx.runPlan.findFirst({ where: { id: parentRunId, tenantId }, select: { depotId: true, runDate: true } });
        if (!head) throw new PlanError('Plan not found.', 404);
        await lockPlanDay(tx, tenantId, head.depotId, head.runDate);
        const parent = await lockRunForWrite(tx, tenantId, parentRunId, { allow: REPLAN_FROM, optimizingMessage: 'An optimization is running for this plan.' });
        const activeJob = await tx.runJob.count({ where: { runId: parent.id, status: { in: ['QUEUED', 'RUNNING'] } } });
        if (activeJob) throw new PlanError('An optimization is running for this plan.', 409, { code: 'OPTIMIZING' });

        const loads = await tx.planLoad.findMany({
          where: { runId: parent.id },
          include: { assignments: true },
          orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }],
        });
        const chosen = parent.chosenScenarioId
          ? await tx.scenarioResult.findFirst({ where: { id: parent.chosenScenarioId, runId: parent.id }, include: { unservedOrders: true } })
          : null;
        const status = chosen ? appliedPlanStatus(loads.map((l) => l.status)) : 'DRAFT';
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
            status,
            finalizedAt: status === 'DISPATCHED' ? (parent.finalizedAt ?? new Date()) : null,
            ...(chosen
              ? {
                  totalOrders: parent.totalOrders,
                  unservedCount: parent.unservedCount,
                  summaryJson: parent.summaryJson ?? Prisma.DbNull,
                  reconciliationJson: parent.reconciliationJson ?? Prisma.DbNull,
                }
              : {}),
          },
        });

        // Loads and their stops. The copy keeps status, driver, times and costs.
        const newLoadId = new Map<string, string>();
        const assignmentRows: Prisma.RouteAssignmentCreateManyInput[] = [];
        for (const l of loads) {
          const { assignments, ...row } = l;
          const copy = await tx.planLoad.create({
            data: copyRowData('PlanLoad', row, ['id', 'runId', 'createdAt', 'carriedFromLoadId'], { runId: child.id, carriedFromLoadId: l.id }) as Prisma.PlanLoadUncheckedCreateInput,
          });
          newLoadId.set(l.id, copy.id);
          for (const a of assignments) {
            assignmentRows.push(copyRowData('RouteAssignment', a, ['id', 'runId', 'loadId'], { runId: child.id, loadId: copy.id }) as Prisma.RouteAssignmentCreateManyInput);
          }
        }
        if (assignmentRows.length) await tx.routeAssignment.createMany({ data: assignmentRows });

        // The option in use, so the copy reconciles and can be dispatched. Its scope names the
        // frozen loads it was computed around: renamed to the copies (the "loads changed" check).
        let chosenCopyId: string | null = null;
        if (chosen) {
          const { unservedOrders, ...row } = chosen;
          const raw: unknown = chosen.detailsJson;
          const details = isDispatchDetails(raw)
            ? {
                ...raw,
                scope: {
                  ...raw.scope,
                  ...(raw.scope.frozenLoadIds ? { frozenLoadIds: raw.scope.frozenLoadIds.map((id) => newLoadId.get(id) ?? id).sort() } : {}),
                },
              }
            : raw;
          const copy = await tx.scenarioResult.create({
            data: copyRowData('ScenarioResult', row, ['id', 'runId', 'createdAt', 'detailsJson'], {
              runId: child.id,
              detailsJson: details as Prisma.InputJsonValue,
            }) as Prisma.ScenarioResultUncheckedCreateInput,
          });
          if (unservedOrders.length) {
            await tx.unservedOrder.createMany({
              data: unservedOrders.map((u) => copyRowData('UnservedOrder', u, ['id', 'scenarioId', 'createdAt'], { scenarioId: copy.id }) as Prisma.UnservedOrderCreateManyInput),
            });
          }
          chosenCopyId = copy.id;
        }
        const saved = chosenCopyId ? await tx.runPlan.update({ where: { id: child.id }, data: { chosenScenarioId: chosenCopyId } }) : child;

        await tx.runPlan.update({ where: { id: parent.id }, data: { status: 'SUPERSEDED', supersededAt: new Date() } });
        const frozenLoadsCarried = loads.filter((l) => l.status !== 'PLANNED').length;
        await tx.auditLog.create({
          data: {
            tenantId,
            userId,
            action: 'PLAN_VERSION_CREATED',
            entity: 'RunPlan',
            entityId: child.id,
            afterJson: {
              parentRunId: parent.id,
              version: child.version,
              reason,
              note,
              frozenLoadsCarried,
              loadsCopied: loads.length,
              planCopied: !!chosenCopyId,
            } as never,
          },
        });
        return { child: saved, frozenLoadsCarried };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (e) {
    throw asPlanBusy(e);
  }
}

// ---------------------------------------------------------------------------------------
// Load changes: status and driver
// ---------------------------------------------------------------------------------------

/** Versions whose loads can change (not superseded, optimizing or archived). */
const LOAD_CHANGE_FROM: readonly RunStatus[] = ['DRAFT', 'READY', 'FAILED', 'DISPATCHED'];

/** Lock a plan version for a load change (row lock until the transaction ends); it must be open for changes. */
async function lockOpenRun(tx: Tx, tenantId: string, runId: string) {
  return lockRunForWrite(tx, tenantId, runId, { allow: LOAD_CHANGE_FROM });
}
type OpenRun = Awaited<ReturnType<typeof lockOpenRun>>;

/**
 * A load change runs in one screen-facing transaction under the plan's row lock. Waiting more
 * than 5 s for that lock (a plan being saved holds it) or for the transaction answers
 * 409 "Plan is being saved - retry" instead of a 500 (review F07).
 */
async function inLoadTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await setLockTimeout(tx);
        return fn(tx);
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
  } catch (e) {
    throw asPlanBusy(e);
  }
}
type RoleCheck = (role: 'PLANNER' | 'SUPERVISOR') => boolean;

export interface LoadChange {
  status?: LoadStatusName;
  /** null = no driver */
  driverId?: string | null;
}

/**
 * One request on one load - its driver and/or its status - in ONE transaction under the plan's
 * row lock, so a refused status change also leaves the driver as it was. The driver goes first:
 * a load being dispatched can get its driver in the same request.
 */
export async function updateLoad(
  tenantId: string,
  runId: string,
  loadId: string,
  change: LoadChange,
  user: { id: string; role: string },
  hasRole: RoleCheck,
) {
  return inLoadTx(async (tx) => {
    const run = await lockOpenRun(tx, tenantId, runId);
    let load: Awaited<ReturnType<typeof setDriverTx>> | null = null;
    if (change.driverId !== undefined) load = await setDriverTx(tx, tenantId, run, loadId, change.driverId, user);
    if (change.status) load = await changeStatusTx(tx, tenantId, run, loadId, change.status, user, hasRole);
    return load;
  });
}

export async function changeLoadStatus(
  tenantId: string,
  runId: string,
  loadId: string,
  to: LoadStatusName,
  user: { id: string; role: string },
  hasRole: RoleCheck,
) {
  return inLoadTx(async (tx) => changeStatusTx(tx, tenantId, await lockOpenRun(tx, tenantId, runId), loadId, to, user, hasRole));
}

/**
 * Assign (or clear) the driver of one load. A driver is who drives, not what is planned: it
 * does not touch the plan facts. It can change until the load leaves the depot.
 */
export async function setLoadDriver(tenantId: string, runId: string, loadId: string, driverId: string | null, user: { id: string }) {
  return inLoadTx(async (tx) => setDriverTx(tx, tenantId, await lockOpenRun(tx, tenantId, runId), loadId, driverId, user));
}

async function changeStatusTx(tx: Tx, tenantId: string, run: OpenRun, loadId: string, to: LoadStatusName, user: { id: string }, hasRole: RoleCheck) {
  const runId = run.id;
  const load = await tx.planLoad.findFirst({ where: { id: loadId, runId, tenantId } });
  if (!load) throw new PlanError('Load not found.', 404);
  // A version without an applied plan (for example one left behind by a failed re-plan before
  // the stabilization release) has no summary or reconciliation: only the way back is open
  // (unlock, back to locked), so the day can be optimized again. Review F03.
  if (!run.chosenScenarioId && !scenariolessTransitionAllowed(load.status, to)) {
    throw new PlanError(
      'This plan version has no optimized plan yet, so its loads cannot be locked, loaded or dispatched. Unlock a load, then OPTIMIZE the day.',
      409,
      { code: 'NO_PLAN_APPLIED' },
    );
  }
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
  // The version's status follows its loads only when it has an applied plan: a DRAFT or FAILED
  // version without one never becomes READY from a load change (review F03 / L14).
  if (run.chosenScenarioId) {
    const next = appliedPlanStatus((await tx.planLoad.findMany({ where: { runId }, select: { status: true } })).map((l) => l.status));
    await tx.runPlan.update({
      where: { id: runId },
      data: { status: next, finalizedAt: next === 'DISPATCHED' ? (run.finalizedAt ?? new Date()) : null },
    });
  }
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
}

async function setDriverTx(tx: Tx, tenantId: string, run: OpenRun, loadId: string, driverId: string | null, user: { id: string }) {
  const load = await tx.planLoad.findFirst({ where: { id: loadId, runId: run.id, tenantId } });
  if (!load) throw new PlanError('Load not found.', 404);
  // Unchanged is checked before "after dispatch": re-sending the current driver is not a change.
  const check = checkDriverChange(load, driverId);
  if (!check.ok) throw new PlanError(check.reason, 409);
  if (check.unchanged) return load;
  const driver = driverId ? await tx.driver.findFirst({ where: { id: driverId, tenantId } }) : null;
  if (driverId && !driver) throw new PlanError('Driver not found.', 400);
  if (driver && !driver.active) throw new PlanError(`Driver ${driver.name} is inactive.`, 400);
  const before = load.driverId ? await tx.driver.findFirst({ where: { id: load.driverId, tenantId }, select: { name: true } }) : null;
  const updated = await tx.planLoad.update({ where: { id: loadId }, data: { driverId } });
  await tx.auditLog.create({
    data: {
      tenantId,
      userId: user.id,
      action: 'LOAD_DRIVER_SET',
      entity: 'PlanLoad',
      entityId: loadId,
      beforeJson: { driverId: load.driverId, driverName: before?.name ?? null } as never,
      afterJson: { driverId, driverName: driver?.name ?? null, runId: run.id, truckId: load.truckId, loadNo: load.loadNo } as never,
    },
  });
  return updated;
}

export function frozenStatuses(): LoadStatus[] {
  return ['LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'];
}

export { isFrozen, isoOf };
