/**
 * Daily plan summary + version-to-version change summary. Pure functions so the numbers the
 * dispatcher sees on screen and in Excel are the same, and so they are unit-testable.
 *
 * Money honesty: revenue is only reported when every order carries a sales value, contribution
 * margin only when every order carries a margin. Otherwise they are null ("not supplied").
 */
import type { DriverChangeReason, DriverOnLoad } from './load-state';

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
  totalHours: number;
  avgUtilizationPct: number;
  fuelLitres: number | null;
  fuelCost: number;
  operatingCost: number;
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
  /**
   * The trips whose driver the applied plan changed versus the same truck and trip before it,
   * and the hand-set drivers whose trip it does not have (TRIP_GONE) (applyScenario; absent when
   * none). Kept through load changes, replaced by the next applied plan; the plan screen shows them
   * as warnings (driverChangeWarnings in driver-links.ts).
   */
  driverChanges?: DriverChangeNote[];
  /**
   * The trucks and trips the applied plan does not have that the version keeps as driver evidence
   * (planReplanDrivers' `parked`; absent when none): each trip this version had, with its driver
   * or "No driver" and its hand-set marker, and the parent's hand-set choices. Kept through load
   * changes, copied to a re-plan's version with the summary (there they are the parent's: `runId`),
   * replaced by the next applied plan: an option or re-plan that has the trip again reads it
   * (readParkedDrivers) - a hand-set driver comes back, "No driver" stays this version's.
   */
  parkedDrivers?: ParkedDriver[];
}

/** A trip whose driver an applied plan changed (planReplanDrivers), with the names at that time. */
export interface DriverChangeNote {
  truckId: string;
  truckCode: string;
  loadNo: number;
  /** The trip's times in the plan (TRIP_GONE: its times before; null when unknown). */
  departMin: number | null;
  returnMin: number | null;
  /** The driver the truck and trip had before the plan (null: no driver). */
  from: { id: string; name: string } | null;
  /** The driver the plan gave it (null: none, for the dispatcher to fill; TRIP_GONE: no trip). */
  to: { id: string; name: string } | null;
  reason: DriverChangeReason;
  /** The load of `from` at the same time (KEPT_LOAD, OTHER_TRIP). */
  other: { truckCode: string; loadNo: number | null } | null;
}

/** A truck and trip kept with a version although its plan does not have it (summary JSON; planReplanDrivers' `parked`). */
export interface ParkedDriver {
  truckId: string;
  loadNo: number;
  /** The trip's driver (null: "No driver"). */
  driverId: string | null;
  departMin: number | null;
  returnMin: number | null;
  driverSetById: string | null;
  /** ISO time of the dispatcher's choice (the hand-set marker); null: RouteIQ filled the driver in, or none. */
  driverSetAt: string | null;
  /**
   * The version that kept it with its plan. A re-plan's version copies its parent's summary, so
   * there the entries carry the parent's id and are read as the parent's (parkedEvidence). Absent
   * before the sixth review of PR3 (hand-set choices only; read as the version's own).
   */
  runId?: string;
}

/** The summary JSON form of planReplanDrivers' `parked`, kept by version `runId`. */
export function toParkedDrivers(parked: readonly DriverOnLoad[], runId: string): ParkedDriver[] {
  return parked.map((p) => ({
    truckId: p.truckId,
    loadNo: p.loadNo,
    driverId: p.driverId,
    departMin: p.departMin ?? null,
    returnMin: p.returnMin ?? null,
    driverSetById: p.driverId && p.driverSetAt ? (p.driverSetById ?? null) : null,
    driverSetAt: p.driverId && p.driverSetAt ? p.driverSetAt.toISOString() : null,
    runId,
  }));
}

/**
 * The parked trips of a stored summary, as planReplanDrivers reads them, with the version they
 * belong to (`runId`; null: stored before the tag, read as the version's own). Malformed entries
 * are skipped.
 */
export function readParkedDrivers(summaryJson: unknown): (DriverOnLoad & { runId: string | null })[] {
  const list = (summaryJson as { parkedDrivers?: unknown } | null)?.parkedDrivers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p: Partial<ParkedDriver> | null) => {
    if (!p || typeof p.truckId !== 'string' || typeof p.loadNo !== 'number') return [];
    const driverId = typeof p.driverId === 'string' ? p.driverId : p.driverId === null ? null : undefined;
    const at = typeof p.driverSetAt === 'string' ? new Date(p.driverSetAt) : p.driverSetAt == null ? null : undefined;
    if (driverId === undefined || at === undefined || (at && (Number.isNaN(at.getTime()) || driverId === null))) return [];
    return [
      {
        truckId: p.truckId,
        loadNo: p.loadNo,
        driverId,
        departMin: typeof p.departMin === 'number' ? p.departMin : undefined,
        returnMin: typeof p.returnMin === 'number' ? p.returnMin : undefined,
        driverSetById: at && typeof p.driverSetById === 'string' ? p.driverSetById : null,
        driverSetAt: at,
        runId: typeof p.runId === 'string' ? p.runId : null,
      },
    ];
  });
}

/**
 * A version's parked trips split by owner (see ParkedDriver.runId): its own (`own`; untagged
 * entries count as its own) and, from the parent's summary, the parent's (`parent`, all of them).
 * Entries the version's summary copied from the parent are left out of `own`: they are the parent's.
 */
export function parkedEvidence(runId: string, summaryJson: unknown, parentSummaryJson: unknown): { own: DriverOnLoad[]; parent: DriverOnLoad[] } {
  return {
    own: readParkedDrivers(summaryJson).filter((p) => p.runId === null || p.runId === runId),
    parent: readParkedDrivers(parentSummaryJson),
  };
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
