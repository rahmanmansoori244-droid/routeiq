/**
 * The hire what-if sizes split deliveries with the trucks it may rent (fix of 7 Oct 2026). The request
 * builder (buildDispatchRequest) on a fake database, as pallets-request.spec.ts, and the pure split.
 *
 * Before, a customer's order was cut into parts for the OWN fleet, and the trucks to rent were added to
 * the request afterwards: each part was a visit with the full stop time. Controlled case: own truck 100
 * cases, the order 300 cases, trucks to rent 300 cases at 60 OMR, 60 min a visit, receiving 08:00-09:30:
 * three visits took two rentals (120 OMR), or left 100 cases out with one to rent (the solver side is
 * apps/solver/tests/test_hire.py, test_a_customer_that_fits_one_truck_to_rent_is_one_visit_one_rental).
 * Now:
 * - a customer that fits one truck to rent stays one visit (one stop time);
 * - a customer that fits no truck is cut in parts sized with the trucks to rent too;
 * - a day without splits is built exactly as before (the trucks to rent change nothing);
 * - the packing never depends on the order of the SKU lines and closes the pallet-rounding gaps: six
 *   cases that fit two trucks of 2 bays are two parts whatever the order (before: three in some orders);
 * - the plan in use's left-out parts ("C#2") count as the what-if's one stop ("C") of that customer.
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchStop } from '@routeiq/shared-types';

const fake = vi.hoisted(() => ({ prisma: {} as Record<string, any>, tdb: {} as Record<string, any> }));
vi.mock('@/lib/db', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => (k === 'then' ? undefined : fake.prisma[k]) }) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => fake.tdb }));

import { buildDispatchRequest, type SplitFleetTruck } from '@/lib/dispatch/plan-service';
import { splitIntoParts, type OpenLine } from '@/lib/dispatch/split';
import { alignUnserved, hireNeed, hireSplitFleet, hireTrucksForRequest, summarizeHire, type HireOptionFacts } from '@/lib/dispatch/hire';
import { palletUnits } from '@/lib/dispatch/pallets';

const CFG: Record<string, any> = {
  avgSpeedKmh: 40, distanceProvider: 'HAVERSINE', distanceMultiplier: 1.3, driverShiftMaxMinutes: 660, shiftStartMin: 420,
  reloadMinutes: 30, loadingMinPerCase: 0, serviceMinPerCase: 0, maxTripsPerTruck: 3, splitDeliveries: true,
  defaultServiceTimeMin: 10, timezone: 'Asia/Muscat', planningCutoffMin: 1080, fuelPricePerLitre: 0, driverCostPerHour: 0,
  overtimeAfterMin: 540, overtimeCostPerHour: 0, prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, osrmUrl: null,
  driverBreakMinutes: 0, driverBreakFromMin: 720, driverBreakToMin: 840, priorityWeightsJson: null, dateOrder: 'DMY',
  serviceAreaJson: null,
};
const truckRow = (id: string, over: Record<string, any> = {}) => ({
  id, code: id, capacityCases: 100, capacityWeightKg: 0, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.15, kmPerLitre: null,
  availableFromMin: null, availableToMin: null, maxTripsPerDay: null, bays: null, ...over,
});
const PRODUCTS: Record<string, { code: string; cpp: number | null }> = {
  W: { code: 'WATER', cpp: null },
  A: { code: 'SKU-A', cpp: 4 }, // 2 cases = 0.5 pallet
  B: { code: 'SKU-B', cpp: 1 }, // 1 case = 1 pallet
  C: { code: 'SKU-C', cpp: 2 }, // 1 case = 0.5 pallet
};

function customer(id: string, lat: number, lng: number, over: Record<string, any> = {}) {
  return {
    id, code: id, branchCode: null, name: id, lat, lng, priority: 2, priorityConfirmed: true, avgServiceTimeMin: 60, serviceTimeConfirmed: true,
    customerType: null, hardWindowStartMin: 480, hardWindowEndMin: 570, prefWindowStartMin: null, prefWindowEndMin: null, locationVerified: true,
    createdFromUpload: false, active: true, ...over,
  };
}
function order(id: string, cust: ReturnType<typeof customer>, lines: [string, number][]) {
  const total = lines.reduce((a, [, c]) => a + c, 0);
  return {
    id, customerId: cust.id, customer: cust, totalCases: total, totalWeightKg: total * 5, priority: 2, priorityFromFile: false, isLate: false,
    salesValue: null, marginValue: null, status: 'NEW',
    lines: lines.map(([p, cases], i) => ({
      id: `${id}-l${i + 1}`, productId: p, cases, weightKg: cases * 5, weightFromMaster: false, salesValue: null, marginValue: null,
      product: { code: PRODUCTS[p]!.code, name: PRODUCTS[p]!.code, weightPerCaseKg: 5, casesPerPallet: PRODUCTS[p]!.cpp, active: true },
    })),
  };
}

function wire(trucks: Record<string, any>[], orders: unknown[]) {
  fake.tdb.runPlan = { findUniqueOrThrow: async () => ({ id: 'R1', depotId: 'D1', runDate: new Date('2026-10-08T00:00:00Z'), parentRunId: null, reason: 'INITIAL', depot: { id: 'D1', lat: 23.58, lng: 58.38, openMin: null, closeMin: null } }) };
  fake.tdb.tenantConfig = { findUniqueOrThrow: async () => ({ ...CFG }) };
  fake.tdb.customerTypeProfile = { findMany: async () => [] };
  fake.tdb.planLoad = { findMany: async () => [] };
  fake.tdb.truck = { findMany: async () => trucks };
  fake.prisma.tenant = { findUniqueOrThrow: async () => ({ country: 'Oman' }) };
  fake.prisma.order = { findMany: async () => orders };
  fake.prisma.routeAssignment = { findMany: async () => [] };
  // No other depot has a plan this day (buildDispatchRequest reads them: cross-depot.ts).
  fake.prisma.runPlan = { findMany: async () => [] };
}

const NOW = new Date('2026-10-07T12:00:00Z');
const C1 = customer('C1', 23.6, 58.4);
const C2 = customer('C2', 23.55, 58.3, { hardWindowStartMin: null, hardWindowEndMin: null });
/** A hire option of 300 cases (no bays, no payload limit) at 60 OMR a day, as the what-if sends it. */
const RENT300: HireOptionFacts = { id: 'r300', label: '300-case', bays: null, capacityCases: 300, payloadKg: 0, costPerDay: 60, costPerKm: null, maxPerDay: 2 };
const splitFleetOf = (options: HireOptionFacts[]): SplitFleetTruck[] => hireSplitFleet(hireTrucksForRequest(options, { tripCost: 0 }, {}));

beforeEach(() => {
  for (const k of Object.keys(fake.tdb)) delete fake.tdb[k];
  for (const k of Object.keys(fake.prisma)) delete fake.prisma[k];
});

describe('the what-if request: split deliveries sized with the trucks to rent', () => {
  it('the 300-case order on 100-case own trucks: three visits of the full stop time without the trucks to rent; ONE visit with them', async () => {
    wire([truckRow('OWN')], [order('O1', C1, [['W', 300]])]);
    const own = await buildDispatchRequest('TEN', 'R1', ['RECOMMENDED'], { now: NOW });
    expect(own.request.stops.map((s) => [s.stop_id, s.demand_cases])).toEqual([
      ['C1#1', 100],
      ['C1#2', 100],
      ['C1#3', 100],
    ]);
    // The owner rule: each visit gets the full stop time.
    const stopTime = own.request.stops[0]!.service_min;
    expect(own.request.stops.map((s) => s.service_min)).toEqual([stopTime, stopTime, stopTime]);
    const withHires = await buildDispatchRequest('TEN', 'R1', ['RECOMMENDED'], { now: NOW, splitFleet: splitFleetOf([RENT300]) });
    expect(withHires.request.stops.map((s) => [s.stop_id, s.order_ids, s.demand_cases, s.service_min, s.hard_start_min, s.hard_end_min])).toEqual([['C1', ['O1'], 300, stopTime, 480, 570]]);
    expect(withHires.scope.portions ?? {}).toEqual({});
    // The trucks to rent are not added to the request by the builder (the what-if adds them, priced).
    expect(withHires.request.trucks.map((t) => t.id)).toEqual(['OWN']);
  });

  it('a customer that fits no truck is cut in parts sized with the trucks to rent too (fewest parts)', async () => {
    wire([truckRow('OWN')], [order('O1', C1, [['W', 500]])]);
    const own = await buildDispatchRequest('TEN', 'R1', ['RECOMMENDED'], { now: NOW });
    expect(own.request.stops.map((s) => s.demand_cases)).toEqual([100, 100, 100, 100, 100]);
    const withHires = await buildDispatchRequest('TEN', 'R1', ['RECOMMENDED'], { now: NOW, splitFleet: splitFleetOf([RENT300]) });
    expect(withHires.request.stops.map((s) => [s.stop_id, s.demand_cases])).toEqual([
      ['C1#1', 300],
      ['C1#2', 200],
    ]);
    expect(withHires.warnings.join(' ')).toMatch(/C1 \(500 cases, 2500 kg\) in 2 parts sized for HIRE-300CAS-1/);
  });

  it('a day without splits is built exactly as before: the trucks to rent change nothing', async () => {
    wire([truckRow('OWN'), truckRow('OWN2')], [order('O1', C1, [['W', 90]]), order('O2', C2, [['W', 100]])]);
    const before = await buildDispatchRequest('TEN', 'R1', ['RECOMMENDED'], { now: NOW });
    const after = await buildDispatchRequest('TEN', 'R1', ['RECOMMENDED'], { now: NOW, splitFleet: splitFleetOf([RENT300]) });
    expect(after.request).toEqual(before.request);
    expect(after.scope).toEqual(before.scope);
    expect(after.warnings).toEqual(before.warnings);
  });

  it('pallets: six cases that fit two trucks of 2 bays are two parts whatever the order of the SKU lines (before: three in some orders)', async () => {
    const lines: [string, number][] = [['A', 2], ['B', 3], ['C', 1]]; // 0.5 + 3.0 + 0.5 = 4.0 pallets
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const p of perms) {
      wire([truckRow('B2', { bays: 2, capacityCases: 1000 })], [order('O1', C2, p.map((i) => lines[i]!))]);
      const b = await buildDispatchRequest('TEN', 'R1', ['RECOMMENDED'], { now: NOW });
      expect([p, b.request.stops.map((s) => [s.demand_pallet_units, s.demand_cases])]).toEqual([
        p,
        [
          [2000, expect.any(Number)],
          [2000, expect.any(Number)],
        ],
      ]);
      expect(b.request.stops.reduce((a, s) => a + s.demand_cases, 0)).toBe(6);
    }
  });
});

describe('splitIntoParts: first fit decreasing, whatever the order of the lines', () => {
  const L = (lineId: string, cases: number, cpp: number | null, kg = 5): OpenLine => ({ lineId, orderId: 'O1', cases, kgPerCase: kg, casesPerPallet: cpp });

  it('the same lines in every order give the same parts, the fewest the room allows', () => {
    const lines = [L('a', 2, 4), L('b', 3, 1), L('c', 1, 2)];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const results = perms.map((p) => splitIntoParts(p.map((i) => lines[i]!), { cases: 1000, kg: null, palletUnits: 2000 }));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]!.map((part) => part.map((x) => [x.lineId, x.cases]))).toEqual([[['b', 2]], [['b', 1], ['a', 2], ['c', 1]]]);
    // The input order alone used to close a part at the first line that did not fit: A, B, C made three.
    const cpp = new Map([['a', 4], ['b', 1], ['c', 2]]);
    for (const part of results[0]!) expect(part.reduce((u, x) => u + palletUnits(x.cases, cpp.get(x.lineId)), 0)).toBeLessThanOrEqual(2000);
  });

  it('by cases (no bays) and by kg too: order-independent, every case kept, never over the room', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 200; run++) {
      const lines = Array.from({ length: 2 + Math.floor(rnd() * 5) }, (_, i) => L(`l${i}`, 1 + Math.floor(rnd() * 300), null, Math.round(rnd() * 20 * 10) / 10));
      const cap = { cases: 100 + Math.floor(rnd() * 300), kg: rnd() < 0.5 ? null : 1000 + Math.floor(rnd() * 3000) };
      const a = splitIntoParts(lines, cap);
      const b = splitIntoParts([...lines].reverse(), cap);
      expect(b).toEqual(a);
      const total = lines.reduce((s, l) => s + l.cases, 0);
      expect(a.flat().reduce((s, x) => s + x.cases, 0)).toBe(total);
      // Cases alone (kg free): exactly the fewest parts.
      if (cap.kg === null) expect(a.length).toBe(Math.ceil(total / cap.cases));
      for (const part of a) {
        expect(part.reduce((s, x) => s + x.cases, 0)).toBeLessThanOrEqual(cap.cases);
        if (cap.kg !== null) expect(part.reduce((s, x) => s + x.weightKg, 0)).toBeLessThanOrEqual(cap.kg + 0.5);
      }
    }
  });
});

describe('the plan in use split a customer the what-if keeps as one visit', () => {
  const stop = (stop_id: string, order_ids: string[], cases: number, priority = 2): DispatchStop =>
    ({ stop_id, order_ids, customer_id: 'C1', lat: 23.6, lng: 58.4, demand_cases: cases, service_min: 60, priority }) as DispatchStop;

  it('its left-out parts count as the what-if\'s one stop of that customer, with their reason', () => {
    // The plan in use: C1#1 delivered by the own truck, C1#2 and C1#3 left out for the fleet.
    const base = [
      { stop_id: 'C1#2', order_ids: ['O1~2'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' },
      { stop_id: 'C1#3', order_ids: ['O1~3'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' },
      { stop_id: 'C9', order_ids: ['O9'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' },
    ];
    const request = { stops: [stop('C1', ['O1'], 300), stop('C9', ['O9'], 40)] };
    expect(alignUnserved(base, request.stops)).toEqual([
      { stop_id: 'C1', order_ids: ['O1'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' },
      { stop_id: 'C9', order_ids: ['O9'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' },
    ]);
    const need = hireNeed({ request, baseUnserved: base, baseOrders: ['O1~1'] });
    expect([...need.outIds].sort()).toEqual(['C1', 'C9']);
    expect(need.leftOut).toMatchObject({ orders: 2, cases: 340 });
    // The what-if delivers it as one visit on one rented truck: nothing still left out, nothing dropped.
    const whatIf = {
      loads: [{ truck_id: 'hire~r300~1', load_no: 1, cases: 340, fixed_cost: 60, total_cost: 60, stops: [{ sequence: 1, stop_id: 'C1', order_ids: ['O1'] }, { sequence: 2, stop_id: 'C9', order_ids: ['O9'] }] }],
      unserved: [],
      trucks_used: 1,
      trips: 1,
    };
    const s = summarizeHire({ request: { ...request, trucks: [], config: {} } as never, baseUnserved: base, baseOrders: ['O1~1'], whatIf: whatIf as never, options: [RENT300] });
    expect(s).toMatchObject({ status: 'HIRE', hireCost: 60, leftOut: { orders: 2 }, delivered: { orders: 2 }, stillLeft: { orders: 0 }, dropped: { orders: 0 } });
    expect(s.hires.map((h) => [h.label, h.count])).toEqual([['300-case', 1]]);
  });
});
