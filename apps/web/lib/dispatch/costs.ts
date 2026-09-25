/**
 * The cost breakdown of a load under the one cost model (review F17). The optimizer computes it
 * (apps/solver/costing.py, policy TRUCK_DAY_SPAN: the driver is paid for the WHOLE truck day, from
 * the first departure - or first frozen departure - to the last return, depot turnaround and
 * waiting included; overtime after the configured hours on top). The web stores it per load
 * (PlanLoad.costJson) and only adds it up - it never prices anything itself - so the plan screen,
 * the options table, the workbook and the dashboard show the same money.
 *
 * Allocation to loads (documented in costing.py): each load owns the paid time from the truck's
 * previous return to its own return (load 1 from its departure, the first new load after frozen
 * loads from the last frozen return); the fixed truck cost is on load 1; trip, distance and fuel are
 * the load's own. Frozen loads keep the costs they were planned with, so frozen + new = the day.
 *
 * Pure: shared by the server and the browser.
 */
import type { PlannedLoad } from '@routeiq/shared-types';

export const COST_POLICY = 'TRUCK_DAY_SPAN';
export const COST_VERSION = 2;

export interface LoadCostBreakdown {
  v: 2;
  policy: typeof COST_POLICY;
  fixed: number;
  trip: number;
  distance: number;
  fuel: number;
  /** This load's share of the whole-day driver pay. */
  driver: number;
  overtime: number;
  /** = fixed + trip + distance + fuel + driver + overtime (PlanLoad.operatingCost). */
  total: number;
  /** Paid minutes this load owns, from `paidFromMin` to its return. */
  driverPaidMin: number;
  paidFromMin: number | null;
  overtimeMin: number;
  /** Legs of the load (return included) whose distance is an estimate, not a road distance. */
  estimatedLegs: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The breakdown of a load the optimizer planned with cost_version 2 (null for an older solver: its
 * total_cost excluded turnarounds and overtime, and the load is then costed the earlier way).
 */
export function loadCostFromSolver(ld: PlannedLoad, costVersion: number | null | undefined): LoadCostBreakdown | null {
  if (!costVersion || costVersion < COST_VERSION || ld.driver_cost == null) return null;
  return {
    v: 2,
    policy: COST_POLICY,
    fixed: num(ld.fixed_cost),
    trip: num(ld.trip_cost),
    distance: num(ld.distance_cost),
    fuel: num(ld.fuel_cost),
    driver: num(ld.driver_cost),
    overtime: num(ld.overtime_cost),
    total: num(ld.total_cost),
    driverPaidMin: num(ld.driver_paid_min),
    paidFromMin: typeof ld.paid_from_min === 'number' ? ld.paid_from_min : null,
    overtimeMin: num(ld.overtime_min),
    estimatedLegs: num(ld.estimated_legs),
  };
}

/** A stored PlanLoad.costJson, or null (a load costed the earlier way, or an unreadable value). */
export function readLoadCost(json: unknown): LoadCostBreakdown | null {
  const j = json as Partial<LoadCostBreakdown> | null;
  if (!j || typeof j !== 'object' || j.v !== 2 || j.policy !== COST_POLICY) return null;
  return {
    v: 2,
    policy: COST_POLICY,
    fixed: num(j.fixed),
    trip: num(j.trip),
    distance: num(j.distance),
    fuel: num(j.fuel),
    driver: num(j.driver),
    overtime: num(j.overtime),
    total: num(j.total),
    driverPaidMin: num(j.driverPaidMin),
    paidFromMin: typeof j.paidFromMin === 'number' ? j.paidFromMin : null,
    overtimeMin: num(j.overtimeMin),
    estimatedLegs: num(j.estimatedLegs),
  };
}

/**
 * TRUCK_DAY_SPAN: every load was costed with the whole-day driver pay. MIXED_LEGACY: some loads
 * (typically locked loads kept from a plan made before this release) were costed the earlier way,
 * without depot turnaround, waiting and overtime - their stored cost is kept as it was.
 */
export type CostBasis = 'TRUCK_DAY_SPAN' | 'MIXED_LEGACY';

export const COST_BASIS_TEXT: Record<CostBasis, string> = {
  TRUCK_DAY_SPAN: 'driver paid for the whole truck day (first departure to last return, depot turnaround and waiting included) + overtime',
  MIXED_LEGACY:
    'some loads were costed the earlier way (plans saved before the cost update): their cost excludes depot turnaround, waiting and overtime',
};

export function costBasisOf(loads: { cost: LoadCostBreakdown | null }[]): CostBasis {
  return loads.every((l) => l.cost !== null) ? 'TRUCK_DAY_SPAN' : 'MIXED_LEGACY';
}

export interface CostTotals {
  fixed: number;
  trip: number;
  distance: number;
  fuel: number;
  driver: number;
  overtime: number;
  /** Stored cost of loads costed the earlier way (no breakdown). */
  earlier: number;
  total: number;
}

export interface CostLoad {
  truckId: string;
  truckCode?: string;
  loadNo: number;
  departMin: number;
  returnMin: number;
  durationMin: number;
  operatingCost: number;
  cost: LoadCostBreakdown | null;
}

/** Money of a set of loads: the breakdown of the loads that carry one, the rest as "earlier". */
export function costTotals(loads: CostLoad[]): CostTotals {
  const t: CostTotals = { fixed: 0, trip: 0, distance: 0, fuel: 0, driver: 0, overtime: 0, earlier: 0, total: 0 };
  for (const l of loads) {
    t.total += l.operatingCost;
    if (!l.cost) {
      t.earlier += l.operatingCost;
      continue;
    }
    t.fixed += l.cost.fixed;
    t.trip += l.cost.trip;
    t.distance += l.cost.distance;
    t.fuel += l.cost.fuel;
    t.driver += l.cost.driver;
    t.overtime += l.cost.overtime;
  }
  for (const k of Object.keys(t) as (keyof CostTotals)[]) t[k] = r3(t[k]);
  return t;
}

export interface TruckDayRow {
  truckId: string;
  truckCode: string;
  loads: number;
  firstDepartMin: number;
  lastReturnMin: number;
  /** First departure to last return of the loads of this version. */
  spanMin: number;
  /** Paid minutes the loads carry (whole-day policy); on-road minutes for loads costed the earlier way. */
  paidMin: number;
  onRoadMin: number;
  driver: number;
  overtime: number;
  fixed: number;
  trip: number;
  distance: number;
  fuel: number;
  earlier: number;
  total: number;
  basis: CostBasis;
  /**
   * Whole-day loads whose stored paid minutes differ from the day's span by more than the rounding
   * (loads locked out of order and re-planned around: a locked load keeps the share it was planned
   * with). 0 when they agree.
   */
  paidVsSpanMin: number;
}

/** One row per truck day, each the sum of its loads (the workbook's TRUCK DAYS sheet, the summary). */
export function truckDayRows(loads: CostLoad[]): TruckDayRow[] {
  const by = new Map<string, CostLoad[]>();
  for (const l of loads) by.set(l.truckId, [...(by.get(l.truckId) ?? []), l]);
  const rows: TruckDayRow[] = [];
  for (const [truckId, ls] of by) {
    const sorted = [...ls].sort((a, b) => a.departMin - b.departMin || a.loadNo - b.loadNo);
    const t = costTotals(sorted);
    const first = sorted[0]!;
    const last = sorted.reduce((a, l) => (l.returnMin > a.returnMin ? l : a), first);
    const spanMin = last.returnMin - first.departMin;
    const paidMin = sorted.reduce((a, l) => a + (l.cost ? l.cost.driverPaidMin : l.durationMin), 0);
    const basis = costBasisOf(sorted);
    rows.push({
      truckId,
      truckCode: first.truckCode ?? truckId,
      loads: sorted.length,
      firstDepartMin: first.departMin,
      lastReturnMin: last.returnMin,
      spanMin,
      paidMin,
      onRoadMin: sorted.reduce((a, l) => a + l.durationMin, 0),
      driver: t.driver,
      overtime: t.overtime,
      fixed: t.fixed,
      trip: t.trip,
      distance: t.distance,
      fuel: t.fuel,
      earlier: t.earlier,
      total: t.total,
      basis,
      paidVsSpanMin: basis === 'TRUCK_DAY_SPAN' && Math.abs(paidMin - spanMin) > sorted.length ? paidMin - spanMin : 0,
    });
  }
  return rows.sort((a, b) => a.truckCode.localeCompare(b.truckCode));
}

/** ROAD: every leg a road distance; MIXED: some legs estimated; ESTIMATED: all estimated. */
export type DistanceQuality = 'ROAD' | 'MIXED' | 'ESTIMATED';

/**
 * "Road km", "Road km (3 legs estimated)" or "Estimated km" (review F18): a plan is never labelled
 * road km while some of its legs are straight-line estimates.
 */
export function kmLabelFor(q: { distanceIsEstimated: boolean; estimatedLegs?: number | null; estimatedLoads?: number | null }): string {
  if (q.distanceIsEstimated) return 'Estimated km';
  const legs = q.estimatedLegs ?? 0;
  if (legs > 0) return `Road km (${legs} leg${legs === 1 ? '' : 's'} estimated)`;
  const loads = q.estimatedLoads ?? 0;
  if (loads > 0) return `Road km (${loads} load${loads === 1 ? '' : 's'} partly estimated)`;
  return 'Road km';
}
