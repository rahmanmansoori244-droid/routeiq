/**
 * Daily plan summary and version-to-version change summary (pure).
 */
import { describe, expect, it } from 'vitest';
import {
  computeChangeSummary,
  computeSummary,
  type AssignmentKey,
  type SummaryLoad,
  type SummaryOrder,
} from '@/lib/dispatch/summary';

const O = (id: string, over: Partial<SummaryOrder> = {}): SummaryOrder => ({
  id,
  customerId: `C-${id}`,
  priority: 3,
  cases: 10,
  weightKg: 100,
  salesValue: 50,
  marginValue: 10,
  isLate: false,
  ...over,
});

const LD = (truckId: string, loadNo: number, over: Partial<SummaryLoad> = {}): SummaryLoad => ({
  truckId,
  loadNo,
  cases: 0,
  weightKg: 0,
  distanceKm: 10,
  durationMin: 60,
  utilizationPct: 50,
  fuelLitres: 2,
  fuelCost: 0.5,
  operatingCost: 3,
  status: 'PLANNED',
  ...over,
});

function summary(orders: SummaryOrder[], planned: string[], unserved: { orderId: string; reasonCode: string }[] = [], loads: SummaryLoad[] = []) {
  return computeSummary({
    orders,
    plannedOrderIds: new Set(planned),
    unserved,
    loads,
    warnings: ['w1'],
    distanceIsEstimated: true,
    distanceProvider: 'HAVERSINE',
    solver: { engine: 'ortools', scenario: 'BALANCED', status: 'OK', timeSec: 1.5 },
  });
}

describe('computeSummary', () => {
  // P1: 3 orders, 2 served. P2: 1 order, served. P3: none. P5: 1 order, unserved.
  const orders = [
    O('a', { priority: 1, customerId: 'C1' }),
    O('b', { priority: 1, customerId: 'C1' }),
    O('c', { priority: 1, customerId: 'C2', isLate: true }),
    O('d', { priority: 2, customerId: 'C3', isLate: true, cases: 5, weightKg: 50.25 }),
    O('e', { priority: 5, customerId: 'C4' }),
  ];
  const planned = ['a', 'b', 'd'];
  const unserved = [
    { orderId: 'c', reasonCode: 'CAPACITY' },
    { orderId: 'e', reasonCode: 'CAPACITY' },
  ];

  it('counts orders, customers, cases and weight', () => {
    const s = summary(orders, planned, unserved);
    expect(s).toMatchObject({
      totalOrders: 5,
      totalCustomers: 4,
      totalCases: 45,
      totalWeightKg: 450.3, // rounded to 0.1
      ordersServed: 3,
      ordersUnserved: 2,
      casesServed: 25,
      casesUnserved: 20,
    });
  });

  it('service % per priority P1..P5, null when a priority has no orders', () => {
    const s = summary(orders, planned, unserved);
    expect(s.serviceByPriority).toEqual({
      P1: { orders: 3, served: 2, pct: 66.7 },
      P2: { orders: 1, served: 1, pct: 100 },
      P3: { orders: 0, served: 0, pct: null },
      P4: { orders: 0, served: 0, pct: null },
      P5: { orders: 1, served: 0, pct: 0 },
    });
  });

  it('counts late orders and late orders served', () => {
    const s = summary(orders, planned, unserved);
    expect(s.lateOrders).toBe(2);
    expect(s.lateOrdersServed).toBe(1);
  });

  it('groups unserved orders by reason', () => {
    const s = summary(orders, planned, [...unserved, { orderId: 'x', reasonCode: 'NO_LOCATION' }]);
    expect(s.unservedByReason).toEqual({ CAPACITY: 2, NO_LOCATION: 1 });
  });

  it('revenue and margin count served orders only', () => {
    const s = summary(orders, planned, unserved);
    expect(s.revenueServed).toBe(150);
    expect(s.marginServed).toBe(30);
  });

  it('revenue is null when any order lacks a sales value (even an unserved one)', () => {
    const s = summary([...orders.slice(0, 4), O('e', { priority: 5, salesValue: null })], planned, unserved);
    expect(s.revenueServed).toBeNull();
    expect(s.marginServed).toBe(30);
  });

  it('margin is null when any order lacks a margin', () => {
    const s = summary([O('a', { marginValue: null }), O('b')], ['a', 'b']);
    expect(s.marginServed).toBeNull();
    expect(s.revenueServed).toBe(100);
  });

  it('revenue / margin are null with no orders at all', () => {
    const s = summary([], []);
    expect(s.revenueServed).toBeNull();
    expect(s.marginServed).toBeNull();
    expect(s.serviceByPriority.P1.pct).toBeNull();
  });

  it('rolls up loads: trucks, trips, km, hours, utilization, costs, statuses', () => {
    const loads = [
      LD('T1', 1, { distanceKm: 40.04, durationMin: 150, utilizationPct: 90, fuelLitres: 8, fuelCost: 1.8, operatingCost: 12.3456, status: 'LOCKED' }),
      LD('T1', 2, { distanceKm: 20.02, durationMin: 90, utilizationPct: 60, fuelLitres: 4, fuelCost: 0.9, operatingCost: 6.1, status: 'PLANNED' }),
      LD('T2', 1, { distanceKm: 10, durationMin: 30, utilizationPct: 45, fuelLitres: 2.05, fuelCost: 0.45, operatingCost: 3, status: 'PLANNED' }),
    ];
    const s = summary(orders, planned, unserved, loads);
    expect(s).toMatchObject({
      trucksUsed: 2,
      trips: 3,
      totalKm: 70.1,
      totalHours: 4.5,
      avgUtilizationPct: 65,
      fuelLitres: 14.1,
      fuelCost: 3.15,
      operatingCost: 21.446,
      loadsByStatus: { LOCKED: 1, PLANNED: 2 },
    });
  });

  it('fuel litres are null when no load knows its fuel use', () => {
    const s = summary(orders, planned, unserved, [LD('T1', 1, { fuelLitres: null }), LD('T2', 1, { fuelLitres: null })]);
    expect(s.fuelLitres).toBeNull();
  });

  it('no loads: zero utilization, no fuel figure', () => {
    const s = summary(orders, [], unserved);
    expect(s).toMatchObject({ trucksUsed: 0, trips: 0, totalKm: 0, avgUtilizationPct: 0, fuelLitres: null, loadsByStatus: {} });
  });

  it('passes through warnings, distance info and solver info', () => {
    const s = summary(orders, planned, unserved);
    expect(s.warnings).toEqual(['w1']);
    expect(s.distanceIsEstimated).toBe(true);
    expect(s.distanceProvider).toBe('HAVERSINE');
    expect(s.solver).toEqual({ engine: 'ortools', scenario: 'BALANCED', status: 'OK', timeSec: 1.5 });
  });
});

describe('computeChangeSummary', () => {
  const A = (orderId: string, truckId: string, loadNo = 1): AssignmentKey => ({ orderId, truckId, loadNo });

  it('counts added orders, changed/unchanged assignments, trucks and newly unserved', () => {
    const r = computeChangeSummary({
      parentVersion: 1,
      parentScope: ['O1', 'O2', 'O3', 'O5'],
      parentPlanned: [A('O1', 'T1'), A('O2', 'T1'), A('O3', 'T2'), A('O5', 'T3')],
      childScope: ['O1', 'O2', 'O3', 'O5', 'O4'],
      childPlanned: [A('O1', 'T1'), A('O2', 'T2'), A('O4', 'T2', 2), A('O5', 'T3')],
      lockedLoadsPreserved: 2,
    });
    expect(r).toEqual({
      parentVersion: 1,
      ordersAdded: 1, // O4
      assignmentsChanged: 1, // O2 moved T1 -> T2
      assignmentsUnchanged: 2, // O1, O5
      newlyPlanned: 0, // O4 is new, not "previously unserved"
      newlyUnserved: 1, // O3
      trucksUnchanged: 1, // T3
      trucksChanged: 2, // T1, T2
      lockedLoadsPreserved: 2,
      text: '1 order added, 1 assignment changed, 1 truck unchanged, 2 locked/dispatched loads preserved, 1 previously planned now unserved',
    });
  });

  it('a move to another load of the same truck is a change', () => {
    const r = computeChangeSummary({
      parentVersion: 2,
      parentScope: ['O1'],
      parentPlanned: [A('O1', 'T1', 1)],
      childScope: ['O1'],
      childPlanned: [A('O1', 'T1', 2)],
      lockedLoadsPreserved: 0,
    });
    expect(r.assignmentsChanged).toBe(1);
    expect(r.assignmentsUnchanged).toBe(0);
    expect(r.trucksUnchanged).toBe(0);
    expect(r.trucksChanged).toBe(1);
  });

  it('counts previously unserved orders that are now planned', () => {
    const r = computeChangeSummary({
      parentVersion: 1,
      parentScope: ['O1', 'O6'],
      parentPlanned: [A('O1', 'T1')],
      childScope: ['O1', 'O6'],
      childPlanned: [A('O1', 'T1'), A('O6', 'T2')],
      lockedLoadsPreserved: 1,
    });
    expect(r.newlyPlanned).toBe(1);
    expect(r.newlyUnserved).toBe(0);
    expect(r.ordersAdded).toBe(0);
    expect(r.trucksUnchanged).toBe(1); // T1
    expect(r.trucksChanged).toBe(1); // T2 gained a stop
    expect(r.text).toBe(
      '0 orders added, 0 assignments changed, 1 truck unchanged, 1 locked/dispatched load preserved, 1 previously unserved now planned',
    );
  });

  it('an identical re-plan changes nothing', () => {
    const planned = [A('O1', 'T1'), A('O2', 'T1', 2), A('O3', 'T2')];
    const r = computeChangeSummary({
      parentVersion: 3,
      parentScope: ['O1', 'O2', 'O3'],
      parentPlanned: planned,
      childScope: ['O1', 'O2', 'O3'],
      childPlanned: [...planned].reverse(),
      lockedLoadsPreserved: 0,
    });
    expect(r).toMatchObject({ ordersAdded: 0, assignmentsChanged: 0, assignmentsUnchanged: 3, trucksUnchanged: 2, trucksChanged: 0 });
    expect(r.text).toBe('0 orders added, 0 assignments changed, 2 trucks unchanged, 0 locked/dispatched loads preserved');
  });
});

describe('computeSummary - split deliveries', () => {
  it('counts an order with only some cases planned as partial, with money pro rata', () => {
    const orders = [O('A', { cases: 300, salesValue: 600, marginValue: 90, priority: 1 }), O('B'), O('C')];
    const s = computeSummary({
      orders,
      plannedOrderIds: new Set(['A', 'B']),
      plannedCasesByOrder: new Map([
        ['A', 200],
        ['B', 10],
      ]),
      unserved: [
        { orderId: 'A', reasonCode: 'CAPACITY' },
        { orderId: 'C', reasonCode: 'TIME_WINDOW' },
      ],
      loads: [LD('T1', 1), LD('T2', 1)],
      warnings: [],
      distanceIsEstimated: false,
      distanceProvider: 'OSRM',
      solver: null,
    });
    expect([s.ordersServed, s.ordersPartial, s.ordersUnserved]).toEqual([1, 1, 1]);
    expect([s.casesServed, s.casesUnserved, s.totalCases]).toEqual([210, 110, 320]); // 100 of A + all 10 of C
    expect(s.revenueServed).toBe(400 + 50); // 2/3 of A + all of B
    expect(s.marginServed).toBe(60 + 10);
    expect(s.serviceByPriority.P1).toEqual({ orders: 1, served: 0, pct: 0 }); // partial is not "served"
  });

  it('a split order fully planned across two trucks is served', () => {
    const s = computeSummary({
      orders: [O('A', { cases: 300 })],
      plannedOrderIds: new Set(['A']),
      plannedCasesByOrder: new Map([['A', 300]]),
      unserved: [],
      loads: [LD('T1', 1), LD('T2', 1)],
      warnings: [],
      distanceIsEstimated: false,
      distanceProvider: 'OSRM',
      solver: null,
    });
    expect([s.ordersServed, s.ordersPartial, s.ordersUnserved, s.casesServed]).toEqual([1, 0, 0, 300]);
  });
});

describe('computeChangeSummary - split orders', () => {
  it('compares the set of loads a split order is on', () => {
    const K = (orderId: string, truckId: string, loadNo = 1): AssignmentKey => ({ orderId, truckId, loadNo });
    const same = computeChangeSummary({
      parentVersion: 1,
      parentScope: ['A'],
      parentPlanned: [K('A', 'T1'), K('A', 'T2')],
      childScope: ['A'],
      childPlanned: [K('A', 'T2'), K('A', 'T1')],
      lockedLoadsPreserved: 0,
    });
    expect([same.assignmentsUnchanged, same.assignmentsChanged]).toEqual([1, 0]);
    const moved = computeChangeSummary({
      parentVersion: 1,
      parentScope: ['A'],
      parentPlanned: [K('A', 'T1'), K('A', 'T2')],
      childScope: ['A'],
      childPlanned: [K('A', 'T1'), K('A', 'T3')],
      lockedLoadsPreserved: 0,
    });
    expect([moved.assignmentsUnchanged, moved.assignmentsChanged]).toEqual([0, 1]);
  });
});

describe('computeSummary - split money and reasons', () => {
  it('uses the planned parts\' own value and counts each order once per reason', () => {
    const s = computeSummary({
      orders: [O('A', { cases: 200, salesValue: 1100, marginValue: 110 })],
      plannedOrderIds: new Set(['A']),
      plannedCasesByOrder: new Map([['A', 100]]),
      plannedMoneyByOrder: new Map([['A', { revenue: 1000, margin: 100 }]]),
      unserved: [
        { orderId: 'A', reasonCode: 'SHIFT_LIMIT' },
        { orderId: 'A', reasonCode: 'SHIFT_LIMIT' },
      ],
      loads: [LD('T1', 1)],
      warnings: [],
      distanceIsEstimated: false,
      distanceProvider: 'OSRM',
      solver: null,
    });
    expect(s.revenueServed).toBe(1000);
    expect(s.marginServed).toBe(100);
    expect(s.unservedByReason).toEqual({ SHIFT_LIMIT: 1 });
  });
});
