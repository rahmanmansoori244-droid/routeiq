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
import type { SearchReport } from '@routeiq/shared-types';
import type { DriverNoteReason } from './load-state';
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
  /**
   * Pallets (owner decision 4 Oct 2026), on a load planned by pallets only: its pallets in 1/1000
   * pallet and its truck's bays as planned. Absent / null: planned by cases.
   */
  palletUnits?: number | null;
  bays?: number | null;
  /**
   * Its truck's driver is paid by the DAY (a hired truck's casual driver, owner answer 4: its truck
   * snapshot's driverDayCost): no paid hours - the load is left out of `driverPaidHours`, as the load
   * plan and the Truck days sheet show it (fourth review). Absent / null: paid by the hour.
   */
  driverDayRate?: number | null;
  /**
   * A truck rented for the day (the hire suggestion): its fuel is in its hire (owner answer 3) - it has
   * no km per litre, and the day's fuel is the own trucks' (sixth review of the hire branch: the Fuel KPI
   * turned blank on any plan with a hired truck). Absent / false: an own truck.
   */
  fuelInHire?: boolean;
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
  /**
   * Pallets: the pallets planned on the loads planned by pallets (1/1000 pallet), how many such loads,
   * and their average bay fill % (pallets / bays, against the physical bays). Null (or absent on a
   * summary saved before pallets) when no load of the day was planned by pallets: the keys are then
   * left out, so a day without bays has the summary it always had.
   */
  palletUnits?: number | null;
  palletLoads?: number;
  avgBayFillPct?: number | null;
  /** The own trucks' fuel (litres: null when one of their loads has no km per litre); a rented truck's is in its hire. */
  fuelLitres: number | null;
  fuelCost: number;
  /** Loads of trucks rented for the day, whose fuel is in the hire (SummaryLoad.fuelInHire); absent when none. */
  fuelIncludedLoads?: number;
  operatingCost: number;
  /** Review F17 (absent on summaries saved before it). */
  costBasis?: CostBasis;
  costs?: CostTotals;
  onRoadHours?: number;
  /**
   * Paid driver hours: the whole truck days (loads costed the earlier way: their time on the road).
   * A driver paid by the day (SummaryLoad.driverDayRate) adds none.
   */
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
  /**
   * `search`: how the recommended plan was searched (Quick / Thorough); absent before search modes.
   * `limitSec`: the option's own search limit - an alternative in use searched that long after the
   * recommended plan's search, for its own goal (search-mode.ts, searchOptionOf). `timeSec`: the
   * option's optimizer time (its search and, when it re-checked the plan, the load re-check).
   */
  solver: { engine: string; scenario: string; status: string; timeSec: number; limitSec?: number; search?: SearchReport } | null;
  /**
   * The applied plan's driver notes (planDrivers in load-state.ts; absent when none): the trips that
   * lost or changed the driver they had before it, and the hand-set drivers whose trip it does not
   * have (TRIP_GONE). Kept through load changes, replaced by the next applied plan; the plan screen
   * shows them as warnings (driverChangeWarnings in driver-links.ts). A summary saved before the
   * simplified driver rules may also hold a `parkedDrivers` list: nothing reads it, and the next
   * refresh of the plan facts leaves it out.
   */
  driverChanges?: DriverChangeNote[];
}

/** A driver note of an applied plan (planDrivers), with the names at that time. */
export interface DriverChangeNote {
  truckId: string;
  truckCode: string;
  loadNo: number;
  /** The trip's times in the plan (TRIP_GONE: its times before; null when unknown). */
  departMin: number | null;
  returnMin: number | null;
  /** The driver the truck and trip had before the plan. */
  from: { id: string; name: string };
  /** The driver the plan gave it (null: none, for the dispatcher to fill; TRIP_GONE: no trip). */
  to: { id: string; name: string } | null;
  reason: DriverNoteReason;
  /** CLASH: the trip that got that driver at an overlapping time. */
  other: { truckCode: string; loadNo: number | null } | null;
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
  // every load's truck has a fuel economy - a truck rented for the day aside: its fuel is in its hire
  // (owner answer 3; sixth review of the hire branch: the KPI turned blank with any hired truck).
  const rented = loads.filter((l) => l.fuelInHire);
  const fuelLoads = loads.filter((l) => !l.fuelInHire);
  const fuelKnown = loads.length > 0 && fuelLoads.every((l) => l.fuelLitres !== null);
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
  // Paid driver hours: a driver paid by the day has none (its day rate is in the money, not in hours).
  const paidMin = loads.reduce((a, l) => a + (typeof l.driverDayRate === 'number' ? 0 : l.cost ? l.cost.driverPaidMin : l.durationMin), 0);
  // Pallets: only the loads planned by pallets (a truck with bays); a day without them says nothing.
  const bayLoads = loads.filter((l): l is SummaryLoad & { palletUnits: number; bays: number } => typeof l.palletUnits === 'number' && typeof l.bays === 'number' && l.bays > 0);
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
    ...(bayLoads.length
      ? {
          palletUnits: bayLoads.reduce((a, l) => a + l.palletUnits, 0),
          palletLoads: bayLoads.length,
          avgBayFillPct: r1(bayLoads.reduce((a, l) => a + l.palletUnits / (l.bays * 10), 0) / bayLoads.length),
        }
      : {}),
    fuelLitres: fuelKnown ? r1(fuelLoads.reduce((a, l) => a + (l.fuelLitres ?? 0), 0)) : null,
    fuelCost: r3(loads.reduce((a, l) => a + l.fuelCost, 0)),
    ...(rented.length ? { fuelIncludedLoads: rented.length } : {}),
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
    // Each warning once: the routing note comes back both on the solver's answer and on the option
    // (scenario tests: "Distances are ESTIMATED" was stored twice with every plan).
    warnings: [...new Set(input.warnings)],
    solver: input.solver,
  };
}

/** The Fuel KPI's note when trucks rented for the day are in the plan (owner answer 3: fuel is in the hire). */
export const FUEL_INCLUDED_NOTE = 'rented trucks: fuel included';

/**
 * The plan's Fuel KPI (litres · OMR): the own trucks' fuel, and a note when trucks rented for the day are
 * in the plan - their fuel is in the hire, never a reason to leave the litres blank (sixth review of the
 * hire branch). A summary stored before `fuelIncludedLoads` (its litres blank because of a rented truck)
 * is read from the plan's loads: a load whose driver is paid by the day is a rented truck's.
 */
export function fuelKpi(
  s: Pick<DailySummary, 'fuelLitres' | 'fuelCost' | 'fuelIncludedLoads'>,
  loads?: readonly FuelLoad[],
): { value: string; note: string | null } {
  const { litres, included } = dayFuel(s, loads);
  return { value: `${litres ?? '—'} · ${s.fuelCost.toFixed(1)}`, note: included > 0 ? FUEL_INCLUDED_NOTE : null };
}

type FuelLoad = { fuelLitres: number | null; fuelCost: number; driverDayRate?: number | null };

/**
 * The day's own-truck fuel in litres (null: one of their loads has no km per litre) and how many loads
 * are of trucks rented for the day (their fuel in the hire), from the summary - or, for a summary stored
 * before `fuelIncludedLoads`, from the plan's loads (fuelKpi).
 */
export function dayFuel(s: Pick<DailySummary, 'fuelLitres' | 'fuelIncludedLoads'>, loads?: readonly FuelLoad[]): { litres: number | null; included: number } {
  if (s.fuelIncludedLoads === undefined && loads?.length) {
    const rented = loads.filter((l) => typeof l.driverDayRate === 'number');
    if (rented.length) {
      const own = loads.filter((l) => typeof l.driverDayRate !== 'number');
      return { litres: own.every((l) => l.fuelLitres !== null) ? r1(own.reduce((a, l) => a + (l.fuelLitres ?? 0), 0)) : null, included: rented.length };
    }
  }
  return { litres: s.fuelLitres, included: s.fuelIncludedLoads ?? 0 };
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
