/**
 * Daily plan summary + version-to-version change summary. Pure functions so the numbers the
 * dispatcher sees on screen and in Excel are the same, and so they are unit-testable.
 *
 * Money honesty: revenue is only reported when every order carries a sales value, contribution
 * margin only when every order carries a margin. Otherwise they are null ("not supplied").
 *
 * Operating cost (review F17): the sum of the version's loads - carried locked loads and new
 * loads alike - each costed by the optimizer under the one cost model (lib/dispatch/costs.ts: the
 * driver is paid for the whole truck day, overtime on top). Loads costed the earlier way (saved
 * before that model) keep their stored cost and label the day MIXED_LEGACY.
 */
import { costBasisOf, costTotals, type CostBasis, type CostTotals, type LoadCostBreakdown } from './costs';

export interface SummaryOrder {
  id: string;
  customerId: string;
  priority: number; // effective stop priority used by the optimizer (1 = highest)
  cases: number;
  weightKg: number;
  salesValue: number | null;
  marginValue: number | null;
  isLate: boolean;
}

export interface SummaryLoad {
  truckId: string;
  loadNo: number;
  cases: number;
  weightKg: number;
  distanceKm: number;
  durationMin: number;
  utilizationPct: number;
  fuelLitres: number | null;
  fuelCost: number;
  operatingCost: number;
  status: string;
  /** Absent (older callers) = costed the earlier way. */
  departMin?: number;
  returnMin?: number;
  cost?: LoadCostBreakdown | null;
  distanceIsEstimated?: boolean;
}

export interface DailySummary {
  totalOrders: number;
  totalCustomers: number;
  totalCases: number;
  totalWeightKg: number;
  ordersServed: number; // every case planned
  ordersPartial: number; // split delivery: some cases planned, the rest unserved
  ordersUnserved: number; // nothing planned
  casesServed: number;
  casesUnserved: number;
  serviceByPriority: Record<string, { orders: number; served: number; pct: number | null }>;
  trucksUsed: number;
  trips: number;
  totalKm: number;
  /** On the road: departure to return of each load, added up (= onRoadHours). */
  totalHours: number;
  avgUtilizationPct: number;
  fuelLitres: number | null;
  fuelCost: number;
  operatingCost: number;
  /** Review F17 (absent on summaries saved before it). */
  costBasis?: CostBasis;
  costs?: CostTotals;
  onRoadHours?: number;
  /** Paid driver hours: the whole truck days (loads costed the earlier way: their time on the road). */
  driverPaidHours?: number;
  overtimeCost?: number;
  /** Review F18: legs planned on estimated distance, and loads with any. */
  estimatedLegs?: number;
  estimatedLoads?: number;
  revenueServed: number | null;
  marginServed: number | null;
  lateOrders: number;
  lateOrdersServed: number;
  unservedByReason: Record<string, number>;
  loadsByStatus: Record<string, number>;
  distanceIsEstimated: boolean;
  distanceProvider: string;
  warnings: string[];
  solver: { engine: string; scenario: string; status: string; timeSec: number } | null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function computeSummary(input: {
  orders: SummaryOrder[];
  plannedOrderIds: Set<string>;
  /** Split deliveries: cases actually planned per order. Absent = planned orders are planned in full. */
  plannedCasesByOrder?: Map<string, number>;
  /** Split deliveries: revenue / margin of the planned parts (valued from their own lines). */
  plannedMoneyByOrder?: Map<string, { revenue: number | null; margin: number | null }>;
  unserved: { orderId: string; reasonCode: string }[];
  loads: SummaryLoad[];
  warnings: string[];
  distanceIsEstimated: boolean;
  distanceProvider: string;
  solver: DailySummary['solver'];
}): DailySummary {
  const { orders, plannedOrderIds, unserved, loads } = input;
  const plannedCases = (o: SummaryOrder) =>
    Math.min(o.cases, input.plannedCasesByOrder?.get(o.id) ?? (plannedOrderIds.has(o.id) ? o.cases : 0));
  const isServed = (o: SummaryOrder) => plannedOrderIds.has(o.id) && plannedCases(o) >= o.cases;
  const served = orders.filter(isServed);
  const partial = orders.filter((o) => !isServed(o) && plannedCases(o) > 0);
  // Money follows the cases actually delivered (a split order half delivered earns half).
  const share = (o: SummaryOrder) => (o.cases > 0 ? plannedCases(o) / o.cases : plannedOrderIds.has(o.id) ? 1 : 0);
  const byP: DailySummary['serviceByPriority'] = {};
  for (let p = 1; p <= 5; p++) {
    const all = orders.filter((o) => o.priority === p);
    const ok = all.filter(isServed);
    byP[`P${p}`] = { orders: all.length, served: ok.length, pct: all.length ? r1((100 * ok.length) / all.length) : null };
  }
  // Orders per reason (a split order with two parts left for one reason counts once).
  const byReason = new Map<string, Set<string>>();
  for (const u of unserved) byReason.set(u.reasonCode, (byReason.get(u.reasonCode) ?? new Set()).add(u.orderId));
  const unservedByReason: Record<string, number> = Object.fromEntries([...byReason].map(([k, v]) => [k, v.size]));
  const loadsByStatus: Record<string, number> = {};
  for (const l of loads) loadsByStatus[l.status] = (loadsByStatus[l.status] ?? 0) + 1;
  const allRevenue = orders.length > 0 && orders.every((o) => o.salesValue !== null);
  const allMargin = orders.length > 0 && orders.every((o) => o.marginValue !== null);
  // Like revenue/margin: a partial fuel sum would understate the day, so report it only when
  // every load's truck has a fuel economy.
  const fuelKnown = loads.length > 0 && loads.every((l) => l.fuelLitres !== null);
  const costLoads = loads.map((l) => ({
    truckId: l.truckId,
    loadNo: l.loadNo,
    departMin: l.departMin ?? 0,
    returnMin: l.returnMin ?? (l.departMin ?? 0) + l.durationMin,
    durationMin: l.durationMin,
    operatingCost: l.operatingCost,
    cost: l.cost ?? null,
  }));
  const costs = costTotals(costLoads);
  const paidMin = costLoads.reduce((a, l) => a + (l.cost ? l.cost.driverPaidMin : l.durationMin), 0);
  return {
    totalOrders: orders.length,
    totalCustomers: new Set(orders.map((o) => o.customerId)).size,
    totalCases: orders.reduce((a, o) => a + o.cases, 0),
    totalWeightKg: r1(orders.reduce((a, o) => a + o.weightKg, 0)),
    ordersServed: served.length,
    ordersPartial: partial.length,
    ordersUnserved: orders.length - served.length - partial.length,
    casesServed: orders.reduce((a, o) => a + plannedCases(o), 0),
    casesUnserved: orders.reduce((a, o) => a + o.cases - plannedCases(o), 0),
    serviceByPriority: byP,
    trucksUsed: new Set(loads.map((l) => l.truckId)).size,
    trips: loads.length,
    totalKm: r1(loads.reduce((a, l) => a + l.distanceKm, 0)),
    totalHours: r1(loads.reduce((a, l) => a + l.durationMin, 0) / 60),
    avgUtilizationPct: loads.length ? r1(loads.reduce((a, l) => a + l.utilizationPct, 0) / loads.length) : 0,
    fuelLitres: fuelKnown ? r1(loads.reduce((a, l) => a + (l.fuelLitres ?? 0), 0)) : null,
    fuelCost: r3(loads.reduce((a, l) => a + l.fuelCost, 0)),
    operatingCost: r3(loads.reduce((a, l) => a + l.operatingCost, 0)),
    costBasis: costBasisOf(costLoads),
    costs,
    onRoadHours: r1(loads.reduce((a, l) => a + l.durationMin, 0) / 60),
    driverPaidHours: r1(paidMin / 60),
    overtimeCost: costs.overtime,
    estimatedLegs: loads.reduce((a, l) => a + (l.cost?.estimatedLegs ?? 0), 0),
    estimatedLoads: loads.filter((l) => l.distanceIsEstimated || (l.cost?.estimatedLegs ?? 0) > 0).length,
    revenueServed: allRevenue ? r3(orders.reduce((a, o) => a + (input.plannedMoneyByOrder?.get(o.id)?.revenue ?? (o.salesValue ?? 0) * share(o)), 0)) : null,
    marginServed: allMargin ? r3(orders.reduce((a, o) => a + (input.plannedMoneyByOrder?.get(o.id)?.margin ?? (o.marginValue ?? 0) * share(o)), 0)) : null,
    lateOrders: orders.filter((o) => o.isLate).length,
    lateOrdersServed: served.filter((o) => o.isLate).length,
    unservedByReason,
    loadsByStatus,
    distanceIsEstimated: input.distanceIsEstimated,
    distanceProvider: input.distanceProvider,
    warnings: input.warnings,
    solver: input.solver,
  };
}

export interface AssignmentKey {
  orderId: string;
  truckId: string;
  loadNo: number;
}

export interface ChangeSummary {
  parentVersion: number;
  ordersAdded: number;
  assignmentsChanged: number;
  assignmentsUnchanged: number;
  newlyPlanned: number;
  newlyUnserved: number;
  trucksUnchanged: number;
  trucksChanged: number;
  lockedLoadsPreserved: number;
  text: string;
}

/** What changed between plan version N and N+1 - shown to the dispatcher after a re-plan. */
export function computeChangeSummary(input: {
  parentVersion: number;
  parentScope: string[];
  parentPlanned: AssignmentKey[];
  childScope: string[];
  childPlanned: AssignmentKey[];
  lockedLoadsPreserved: number;
}): ChangeSummary {
  const parentScope = new Set(input.parentScope);
  // A split order sits on several loads: compare the set of (truck, load) it is on.
  const where = (list: AssignmentKey[]) => {
    const m = new Map<string, Set<string>>();
    for (const a of list) m.set(a.orderId, (m.get(a.orderId) ?? new Set()).add(`${a.truckId}:${a.loadNo}`));
    return new Map([...m].map(([id, s]) => [id, [...s].sort().join('|')]));
  };
  const parentBy = where(input.parentPlanned);
  const childBy = where(input.childPlanned);
  const ordersAdded = input.childScope.filter((id) => !parentScope.has(id)).length;
  let changed = 0;
  let unchanged = 0;
  let newlyPlanned = 0;
  let newlyUnserved = 0;
  for (const id of input.childScope) {
    const p = parentBy.get(id);
    const c = childBy.get(id);
    if (p && c) {
      if (p === c) unchanged++;
      else changed++;
    } else if (!p && c && parentScope.has(id)) newlyPlanned++;
    else if (p && !c) newlyUnserved++;
  }
  const trucks = new Set([...input.parentPlanned, ...input.childPlanned].map((a) => a.truckId));
  const sig = (list: AssignmentKey[], t: string) =>
    list
      .filter((a) => a.truckId === t)
      .map((a) => `${a.loadNo}:${a.orderId}`)
      .sort()
      .join('|');
  let trucksUnchanged = 0;
  for (const t of trucks) if (sig(input.parentPlanned, t) === sig(input.childPlanned, t)) trucksUnchanged++;
  const trucksChanged = trucks.size - trucksUnchanged;
  const parts = [
    `${ordersAdded} order${ordersAdded === 1 ? '' : 's'} added`,
    `${changed} assignment${changed === 1 ? '' : 's'} changed`,
    `${trucksUnchanged} truck${trucksUnchanged === 1 ? '' : 's'} unchanged`,
    `${input.lockedLoadsPreserved} locked/dispatched load${input.lockedLoadsPreserved === 1 ? '' : 's'} preserved`,
  ];
  if (newlyUnserved) parts.push(`${newlyUnserved} previously planned now unserved`);
  if (newlyPlanned) parts.push(`${newlyPlanned} previously unserved now planned`);
  return {
    parentVersion: input.parentVersion,
    ordersAdded,
    assignmentsChanged: changed,
    assignmentsUnchanged: unchanged,
    newlyPlanned,
    newlyUnserved,
    trucksUnchanged,
    trucksChanged,
    lockedLoadsPreserved: input.lockedLoadsPreserved,
    text: parts.join(', '),
  };
}
