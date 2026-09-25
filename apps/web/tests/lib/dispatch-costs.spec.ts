/**
 * Review F17 / F18: the stored cost breakdown of a load (lib/dispatch/costs.ts) - read from the
 * optimizer, never recomputed - the summary built from it, and the labels that must not call
 * estimated legs road km.
 */
import { describe, expect, it } from 'vitest';
import type { PlannedLoad } from '@routeiq/shared-types';
import {
  costBasisOf,
  costTotals,
  kmLabelFor,
  loadCostFromSolver,
  readLoadCost,
  truckDayRows,
  type CostLoad,
  type LoadCostBreakdown,
} from '@/lib/dispatch/costs';
import { computeSummary, type SummaryLoad } from '@/lib/dispatch/summary';

const planned = (over: Partial<PlannedLoad> = {}): PlannedLoad => ({
  truck_id: 't1', load_no: 1, depart_min: 360, return_min: 390, distance_km: 10, duration_min: 30, cases: 10, kg: 100,
  utilization_pct: 10, fuel_litres: 2.5, fuel_cost: 0.5, distance_cost: 1, time_cost: 3, fixed_cost: 20, total_cost: 26,
  return_leg_km: 3, stops: [], trip_cost: 1.5, driver_cost: 3, overtime_cost: 0, driver_paid_min: 30, paid_from_min: 360,
  overtime_min: 0, estimated_legs: 1, ...over,
});

/** A load cost as the optimizer reports it (apps/solver/costing.py). */
function cost(over: Partial<LoadCostBreakdown>): LoadCostBreakdown {
  const c: LoadCostBreakdown = {
    v: 2, policy: 'TRUCK_DAY_SPAN', fixed: 0, trip: 0, distance: 0, fuel: 0, driver: 0, overtime: 0, total: 0,
    driverPaidMin: 0, paidFromMin: null, overtimeMin: 0, estimatedLegs: 0, ...over,
  };
  c.total = Math.round((c.fixed + c.trip + c.distance + c.fuel + c.driver + c.overtime) * 1000) / 1000;
  return c;
}

describe('load cost breakdown', () => {
  it('is taken from a solver with cost_version 2, and round-trips through PlanLoad.costJson', () => {
    const c = loadCostFromSolver(planned(), 2)!;
    expect(c).toMatchObject({ fixed: 20, trip: 1.5, distance: 1, fuel: 0.5, driver: 3, overtime: 0, total: 26, driverPaidMin: 30, estimatedLegs: 1 });
    expect(readLoadCost(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it('an older solver (no cost_version, or no driver cost) gives no breakdown: costed the earlier way', () => {
    expect(loadCostFromSolver(planned(), null)).toBeNull();
    expect(loadCostFromSolver(planned(), 1)).toBeNull();
    expect(loadCostFromSolver(planned({ driver_cost: null }), 2)).toBeNull();
    expect(readLoadCost(null)).toBeNull();
    expect(readLoadCost({ v: 1 })).toBeNull();
  });
});

const L = (truckId: string, loadNo: number, depart: number, ret: number, c: LoadCostBreakdown | null, operatingCost = c?.total ?? 5): CostLoad => ({
  truckId, truckCode: truckId.toUpperCase(), loadNo, departMin: depart, returnMin: ret, durationMin: ret - depart, operatingCost, cost: c,
});

describe('truck days', () => {
  it('one row per truck, each the sum of its loads; the paid time is the truck day', () => {
    const rows = truckDayRows([
      L('t1', 1, 360, 390, cost({ fixed: 20, driver: 3, driverPaidMin: 30 })),
      L('t1', 2, 520, 550, cost({ driver: 16, driverPaidMin: 160 })),
      L('t2', 1, 400, 460, cost({ driver: 6, driverPaidMin: 60 })),
    ]);
    expect(rows.map((r) => [r.truckCode, r.loads, r.spanMin, r.paidMin, r.onRoadMin, r.total])).toEqual([
      ['T1', 2, 190, 190, 60, 39],
      ['T2', 1, 60, 60, 60, 6],
    ]);
    expect(rows[0]!.paidVsSpanMin).toBe(0);
  });

  it('flags a truck whose locked load keeps a share that no longer matches its day (loads locked out of order)', () => {
    // Load 2 was locked while load 1 stayed planned; a re-plan moved load 1 after it. Load 2 still
    // carries the 60 min before its departure it was planned with.
    const [r] = truckDayRows([L('t1', 2, 480, 540, cost({ driver: 12, driverPaidMin: 120 })), L('t1', 3, 570, 600, cost({ driver: 6, driverPaidMin: 60 }))]);
    expect(r!.spanMin).toBe(120);
    expect(r!.paidVsSpanMin).toBe(60);
  });

  it('marks a mix with loads costed the earlier way', () => {
    const loads = [L('t1', 1, 360, 390, null, 11), L('t1', 2, 420, 450, cost({ driver: 6, driverPaidMin: 60 }))];
    expect(costBasisOf(loads)).toBe('MIXED_LEGACY');
    expect(costTotals(loads)).toMatchObject({ earlier: 11, driver: 6, total: 17 });
    expect(truckDayRows(loads)[0]!.basis).toBe('MIXED_LEGACY');
  });
});

const LD = (truckId: string, loadNo: number, over: Partial<SummaryLoad> = {}): SummaryLoad => ({
  truckId, loadNo, cases: 0, weightKg: 0, distanceKm: 10, durationMin: 60, utilizationPct: 50, fuelLitres: 2, fuelCost: 0.5,
  operatingCost: 3, status: 'PLANNED', ...over,
});
const summaryOf = (loads: SummaryLoad[]) =>
  computeSummary({ orders: [], plannedOrderIds: new Set(), unserved: [], loads, warnings: [], distanceIsEstimated: false, distanceProvider: 'OSRM', solver: null });

describe('computeSummary - costs (review F17)', () => {
  // The golden day: L1 06:00-06:30, L2 08:40-09:10, 6 OMR/h, overtime after 60 min at 4 OMR/h.
  const l1 = cost({ driver: 3, driverPaidMin: 30, paidFromMin: 360 });
  const l2 = cost({ driver: 16, overtime: 8.667, driverPaidMin: 160, paidFromMin: 390, overtimeMin: 130 });
  const golden = [
    LD('T1', 1, { departMin: 360, returnMin: 390, durationMin: 30, operatingCost: l1.total, cost: l1, status: 'LOCKED' }),
    LD('T1', 2, { departMin: 520, returnMin: 550, durationMin: 30, operatingCost: l2.total, cost: l2 }),
  ];

  it('includes the whole-day driver pay and overtime: loads add up to the day', () => {
    const s = summaryOf(golden);
    expect(s.operatingCost).toBe(27.667);
    expect(s.costBasis).toBe('TRUCK_DAY_SPAN');
    expect(s.costs).toMatchObject({ driver: 19, overtime: 8.667, earlier: 0, total: 27.667 });
    expect(s.overtimeCost).toBe(8.667);
    expect(s.driverPaidHours).toBe(3.2); // 190 min: 06:00-09:10, the wait between the loads included
    expect(s.onRoadHours).toBe(1);
  });

  it('frozen + new: a re-plan version sums the carried locked load and the new ones, nothing twice', () => {
    const s = summaryOf(golden);
    expect(s.operatingCost).toBeCloseTo(l1.total + l2.total, 6);
    expect(s.costs!.driver).toBe(19);
  });

  it('labels a day with loads costed the earlier way MIXED_LEGACY and keeps their stored cost', () => {
    const s = summaryOf([LD('T1', 1, { operatingCost: 11.5, status: 'DISPATCHED' }), golden[1]!]);
    expect(s.costBasis).toBe('MIXED_LEGACY');
    expect(s.costs!.earlier).toBe(11.5);
    expect(s.operatingCost).toBe(Math.round((11.5 + l2.total) * 1000) / 1000);
  });

  it('counts estimated legs and the loads that have them (review F18)', () => {
    const s = summaryOf([
      LD('T1', 1, { cost: cost({ estimatedLegs: 2 }), distanceIsEstimated: true }),
      LD('T2', 1, { cost: cost({}), distanceIsEstimated: false }),
    ]);
    expect(s.estimatedLegs).toBe(2);
    expect(s.estimatedLoads).toBe(1);
  });
});

describe('km labels (review F18)', () => {
  it('never says road km for estimated legs', () => {
    expect(kmLabelFor({ distanceIsEstimated: true, estimatedLegs: 40 })).toBe('Estimated km');
    expect(kmLabelFor({ distanceIsEstimated: false, estimatedLegs: 3 })).toBe('Road km (3 legs estimated)');
    expect(kmLabelFor({ distanceIsEstimated: false, estimatedLegs: 1 })).toBe('Road km (1 leg estimated)');
    expect(kmLabelFor({ distanceIsEstimated: false, estimatedLegs: 0, estimatedLoads: 2 })).toBe('Road km (2 loads partly estimated)');
    expect(kmLabelFor({ distanceIsEstimated: false })).toBe('Road km');
  });
});
