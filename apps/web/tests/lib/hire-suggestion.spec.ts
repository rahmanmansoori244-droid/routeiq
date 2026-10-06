/**
 * The hire suggestion (owner request 6 Oct 2026, and the owner's answers of the same day), pure parts:
 * the request's trucks to rent (one per unit, never more than the day may still rent; fuel in the hire,
 * the driver day rate; unique placeholder codes), the codes of rented trucks, only P1-P3 orders starting
 * a check (P4/P5 ones said plainly), the suggestion worked out from a what-if (the owner's example word
 * for word, the running costs without fuel or km, a suggestion that does not help, one truck fewer,
 * nothing left any more), what "nothing changed" compares, the one-day availability of a rented truck,
 * the code a load shows, and the background solves of the solve admission (no quota, never ahead of a
 * dispatcher's solve, one waiting per depot-day). Synthetic data only.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchScenario, DispatchStop, DispatchTruck } from '@routeiq/shared-types';
import {
  CAPACITY_REASONS,
  fleetAverages,
  hireNeed,
  hireSuggestionText,
  lowPriorityOrders,
  lowPriorityText,
  hireTag,
  hireTruckCode,
  hireTrucksForRequest,
  needsHireCheck,
  parseVirtualHireId,
  requestBasisText,
  sameDayMovedOn,
  shownTruckCode,
  summarizeHire,
  trucksOfDayWhere,
  virtualHireId,
  type HireOptionFacts,
} from '@/lib/dispatch/hire';
import { SolveAdmission } from '@/lib/dispatch/solve-admission';
import { hireOptionSchema, hireOptionPatchSchema, hiredTruckPatchSchema, hireUseSchema } from '@/lib/schemas';

const TEN: HireOptionFacts = { id: 'o10', label: '10-ton', bays: 12, capacityCases: 1140, payloadKg: 0, costPerDay: 50, costPerKm: null, maxPerDay: 3 };
const THREE: HireOptionFacts = { id: 'o3', label: '3-ton', bays: 6, capacityCases: 570, payloadKg: 0, costPerDay: 30, costPerKm: 0.2, maxPerDay: 2 };
const own = (id: string, extra: Partial<DispatchTruck> = {}): DispatchTruck => ({ id, code: id, capacity_cases: 1140, cost_per_km: 0.1, km_per_litre: 3.5, trip_cost: 3, fixed_cost: 35, bays: 12, ...extra });

describe('the request: one truck per unit the day may still rent', () => {
  it('adds max per day of each option, less the trucks already rented from it for the day', () => {
    const avg = { tripCost: 2.5 };
    const trucks = hireTrucksForRequest([TEN, THREE], avg, { o10: 1 }, 10);
    expect(trucks.map((t) => t.id)).toEqual([virtualHireId('o10', 1), virtualHireId('o10', 2), virtualHireId('o3', 1), virtualHireId('o3', 2)]);
    expect(trucks.every((t) => t.hire_candidate === true)).toBe(true);
    // Owner answers 3 and 4 (6 Oct 2026): fuel is in the hire (no km cost, no km per litre), the casual
    // driver is paid the company's day rate.
    expect(trucks[0]).toMatchObject({ code: 'HIRE-10T-1', bays: 12, capacity_cases: 1140, capacity_kg: 0, fixed_cost: 50, cost_per_km: 0, trip_cost: 2.5, km_per_litre: null, driver_day_cost: 10 });
    // An option's own km charge (the rental's, never the fleet's fuel).
    expect(trucks[2]).toMatchObject({ code: 'HIRE-3T-1', bays: 6, fixed_cost: 30, cost_per_km: 0.2, driver_day_cost: 10 });
    expect(hireTrucksForRequest([TEN], avg, { o10: 3 }, 10)).toEqual([]);
    expect(hireTrucksForRequest([TEN], avg, { o10: 5 }, 10)).toEqual([]);
  });

  it('two options with the same size tag never share a placeholder code (review of the hire branch)', () => {
    // "10-ton curtain" and "10-ton box" both tag 10T: numbered across the request, so a finding about
    // one names that truck, never the other.
    const curtain: HireOptionFacts = { ...TEN, id: 'cur', label: '10-ton curtain', maxPerDay: 2 };
    const box: HireOptionFacts = { ...TEN, id: 'box', label: '10-ton box', maxPerDay: 1 };
    const codes = hireTrucksForRequest([curtain, box, THREE], { tripCost: 0 }, {}, 10).map((t) => t.code);
    expect(codes).toEqual(['HIRE-10T-1', 'HIRE-10T-2', 'HIRE-10T-3', 'HIRE-3T-1', 'HIRE-3T-2']);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('an option without bays is a truck planned by cases (no bays field)', () => {
    const [t] = hireTrucksForRequest([{ ...THREE, id: 'c', bays: null, capacityCases: 400, payloadKg: 3000, maxPerDay: 1 }], { tripCost: 0 }, {}, 10);
    expect(t).toMatchObject({ capacity_cases: 400, capacity_kg: 3000 });
    expect('bays' in t!).toBe(false);
  });

  it('the virtual ids are never a real truck id and read back', () => {
    expect(parseVirtualHireId(virtualHireId('cm1abc', 2))).toEqual({ optionId: 'cm1abc', n: 2 });
    expect(parseVirtualHireId('cm1abc')).toBeNull();
    expect(parseVirtualHireId('hire~x~0')).toBeNull();
  });

  it("the fleet's average loading cost per load (own trucks only); never its km or fuel", () => {
    const avg = fleetAverages([own('A'), own('B', { cost_per_km: 0.06, km_per_litre: 7, trip_cost: 2 }), { ...own('H'), hire_candidate: true, cost_per_km: 9, trip_cost: 9 }]);
    expect(avg).toEqual({ tripCost: 2.5 });
    expect(fleetAverages([])).toEqual({ tripCost: 0 });
  });

  it('codes: a tag from the label and the delivery date', () => {
    expect(hireTag('10-ton')).toBe('10T');
    expect(hireTag('3 Ton')).toBe('3T');
    expect(hireTag('3.5 tonne')).toBe('3.5T');
    expect(hireTag('Box truck')).toBe('BOXTRU');
    expect(hireTag('!!!')).toBe('TRUCK');
    expect(hireTruckCode('10-ton', '2026-10-07', 1)).toBe('HIRE-10T-0710-1');
    expect(hireTruckCode('Box truck', '2026-12-31', 12)).toBe('HIRE-BOXTRU-3112-12');
  });
});

describe('what starts a hire check', () => {
  it('only reasons a truck more can help', () => {
    expect(CAPACITY_REASONS).toContain('SOLVER_DROPPED_LOW_PRIORITY');
    expect(CAPACITY_REASONS).toContain('TRIP_LIMIT');
    expect(needsHireCheck([{ stop_id: 's', order_ids: ['o'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' }])).toBe(true);
    expect(needsHireCheck([{ stop_id: 's', order_ids: ['o'], reason_code: 'MISSING_COORDINATES' }])).toBe(false);
    expect(needsHireCheck([])).toBe(false);
    expect(needsHireCheck(null)).toBe(false);
  });

  it('only P1-P3 orders justify renting (owner answer 1, 6 Oct 2026): P4/P5 orders left out are said plainly', () => {
    const out = (id: string, ...orders: string[]) => ({ stop_id: id, order_ids: orders, reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' });
    const priorities = { o1: 4, o2: 5, o3: 5, o4: 3, o5: 5 };
    // Only P4/P5 orders left out: no check, and the box says so.
    const low = [out('s1', 'o1'), out('s2', 'o2', 'o3')];
    expect(needsHireCheck(low, priorities)).toBe(false);
    expect(lowPriorityOrders(low, priorities)).toBe(3);
    expect(lowPriorityText(3)).toBe('Left out: 3 orders, all P4/P5 - renting is not suggested for them.');
    expect(lowPriorityText(1)).toBe('Left out: 1 order, P4/P5 - renting is not suggested for it.');
    // A stop with one P3 order is a P3 stop (its most important order): a check runs.
    expect(needsHireCheck([...low, out('s3', 'o4', 'o5')], priorities)).toBe(true);
    expect(lowPriorityOrders([...low, out('s3', 'o4', 'o5')], priorities)).toBe(3);
    // A split part ("o4~1") reads its order's priority; an order with no priority on record counts as P3.
    expect(needsHireCheck([out('s4', 'o4~1')], { o4: 5 })).toBe(false);
    expect(needsHireCheck([out('s5', 'o9')], priorities)).toBe(true);
    expect(needsHireCheck([out('s5', 'o9')])).toBe(true);
    // Another reason never counts, whatever the priority.
    expect(lowPriorityOrders([{ stop_id: 's6', order_ids: ['o2'], reason_code: 'MISSING_COORDINATES' }], priorities)).toBe(0);
  });

  it('receiving hours no OWN truck reaches in time (it is out on a locked load): the what-if decides', () => {
    // Review: the optimizer's window check tries the depot's own trucks from when each is free, so a
    // late order whose customer closes before any own truck is back reads HARD_WINDOW_INFEASIBLE - and
    // a rented truck, free from the start of the day, delivers it (apps/solver tests/test_hire.py).
    expect(CAPACITY_REASONS).toContain('HARD_WINDOW_INFEASIBLE');
    expect(CAPACITY_REASONS).toContain('SHIFT_LIMIT');
    expect(needsHireCheck([{ stop_id: 's', order_ids: ['o'], reason_code: 'HARD_WINDOW_INFEASIBLE' }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The suggestion from a what-if
// ---------------------------------------------------------------------------------------------

/**
 * 18 stops: S1-S4 on the own truck; L1-L14 left out by the plan in use (1,180 cases, 17.6 pallets),
 * all P3 - or the first `low` of them P5.
 */
function day(low = 0) {
  const stop = (id: string, cases: number, units: number, priority = 3): DispatchStop => ({
    stop_id: id, order_ids: [`ord-${id}`], customer_id: `c-${id}`, lat: 23.6, lng: 58.4, demand_cases: cases, demand_kg: 0, demand_pallet_units: units, priority,
  });
  const kept = ['S1', 'S2', 'S3', 'S4'].map((id) => stop(id, 200, 3000));
  // 14 orders: 10 x 80 cases / 1.2 pallets + 4 x 95 cases / 1.4 pallets = 1,180 cases, 17.6 pallets.
  const left = [...Array.from({ length: 10 }, (_, i) => stop(`L${i + 1}`, 80, 1200, i < low ? 5 : 3)), ...Array.from({ length: 4 }, (_, i) => stop(`L${i + 11}`, 95, 1400))];
  const request: DispatchRequest = {
    run_id: 'r', tenant_id: 't', depot: { id: 'd', lat: 23.6, lng: 58.4 }, stops: [...kept, ...left],
    trucks: [own('OWN1'), ...hireTrucksForRequest([TEN, THREE], { tripCost: 2.5 }, {}, 10)],
    config: { scenarios: ['RECOMMENDED'] } as DispatchRequest['config'],
  };
  const baseUnserved = left.map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' }));
  return { request, left, kept, baseUnserved };
}

type Load = DispatchScenario['loads'][number];
/** A load; `parts`: its running costs as the optimizer reports them (driver, loading, km, fuel). */
const load = (truckId: string, stops: DispatchStop[], fixed: number, total: number, parts: Partial<Load> = {}): Load =>
  ({ truck_id: truckId, load_no: 1, cases: stops.reduce((a, s) => a + s.demand_cases, 0), fixed_cost: fixed, total_cost: total, stops: stops.map((s, i) => ({ sequence: i + 1, stop_id: s.stop_id })), ...parts }) as unknown as Load;
/** A rented truck's load as the optimizer costs it (owner answers 3 and 4): its hire, the driver's day rate, loading; no km, no fuel. */
const rentedLoad = (truckId: string, stops: DispatchStop[], hire: number, dayRate = 10, loading = 2.5): Load =>
  load(truckId, stops, hire, hire + dayRate + loading, { driver_cost: dayRate, trip_cost: loading, distance_cost: 0, fuel_cost: 0, overtime_cost: 0 } as Partial<Load>);

describe('the suggestion (summarizeHire, hireSuggestionText)', () => {
  it("the owner's example: 14 orders, hire 1 x 10-ton + 1 x 3-ton, extra about 80 OMR, nothing left", () => {
    const { request, left, kept, baseUnserved } = day();
    const whatIf = {
      loads: [load('OWN1', kept, 35, 60), rentedLoad(virtualHireId('o10', 1), left.slice(0, 10), 50), rentedLoad(virtualHireId('o3', 1), left.slice(10), 30)],
      unserved: [],
      trucks_used: 3,
      trips: 3,
    };
    const s = summarizeHire({ request, baseUnserved, whatIf, options: [TEN, THREE] });
    expect(s.status).toBe('HIRE');
    expect(s.hires.map((h) => [h.label, h.count])).toEqual([['10-ton', 1], ['3-ton', 1]]);
    expect(s.hireCost).toBe(80);
    expect(s.runningCost).toBeCloseTo(25, 6);
    expect(s.running).toEqual({ drivers: 2, dayRate: 10, driver: 20, loading: 5, km: 0 });
    expect(s.leftOut).toMatchObject({ orders: 14, cases: 1180, palletUnits: 17_600 });
    expect(s.delivered.orders).toBe(14);
    expect(s.stillLeft.orders).toBe(0);
    const text = hireSuggestionText(s);
    expect(text.headline).toBe(
      '14 orders (1,180 cases, 17.6 pallets) cannot be delivered with your fleet. To deliver them, hire 1 x 10-ton (12 bays) + 1 x 3-ton (6 bays): extra about 80 OMR. Still left out: none.',
    );
    // Owner answers 3 and 4: the running-costs line names the drivers' day rate and the loading, never fuel or km.
    expect(text.details[0]).toBe('Plus about 25 OMR running costs on the hired trucks: 2 drivers at the day rate of 10 OMR, loading about 5 OMR. Fuel is included in the hire.');
    expect(text.details[0]).not.toMatch(/\bkm\b|driver time/);
    // One truck fewer: both trucks' most important stop is P3, so the one carrying fewer cases goes.
    expect(s.alternative).toMatchObject({ dropped: '3-ton', hireCost: 50 });
    expect(s.alternative!.leftOut).toMatchObject({ orders: 4, cases: 380, palletUnits: 5600 });
    expect(text.details[1]).toBe('With one truck fewer (1 x 10-ton (12 bays), extra about 50 OMR): up to 4 orders (380 cases, 5.6 pallets) stay undelivered - what the 3-ton would carry.');
  });

  it("an option's own km charge is the rental's (named so); fuel never", () => {
    const { request, left, kept, baseUnserved } = day();
    const whatIf = {
      loads: [load('OWN1', kept, 35, 60), load(virtualHireId('o3', 1), left, 30, 30 + 10 + 2.5 + 4, { driver_cost: 10, trip_cost: 2.5, distance_cost: 4, fuel_cost: 0 } as Partial<Load>)],
      unserved: [],
      trucks_used: 2,
      trips: 2,
    };
    const s = summarizeHire({ request, baseUnserved, whatIf, options: [TEN, THREE] });
    expect(hireSuggestionText(s).details[0]).toBe(
      "Plus about 17 OMR running costs on the hired trucks: 1 driver at the day rate of 10 OMR, loading about 3 OMR, the rental's km charge about 4 OMR. Fuel is included in the hire.",
    );
  });

  it('P4/P5 orders never count as what the hire is for; the box says them plainly, and what the hired trucks still carry', () => {
    // L1-L4 are P5: the 10 P3 orders are what the 10-ton is rented for; its spare room carries 1 P5 order.
    const { request, left, kept, baseUnserved } = day(4);
    const whatIf = {
      loads: [load('OWN1', kept, 35, 60), rentedLoad(virtualHireId('o10', 1), [...left.slice(4), left[0]!], 50)],
      unserved: left.slice(1, 4).map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'SOLVER_DROPPED_LOW_PRIORITY', reason_message: '' })),
      trucks_used: 2,
      trips: 2,
    } as unknown as Pick<DispatchScenario, 'loads' | 'unserved' | 'trucks_used' | 'trips'>;
    const s = summarizeHire({ request, baseUnserved, whatIf, options: [TEN, THREE] });
    expect(s.leftOut.orders).toBe(10);
    expect(s.stillLeft.orders).toBe(0);
    // The P5 orders still out are never "still left out" with a reason about the trucks you can rent.
    expect(s.stillLeftReasons).toEqual({});
    expect(s.low).toMatchObject({ leftOut: { orders: 4 }, delivered: { orders: 1 } });
    const text = hireSuggestionText(s);
    expect(text.headline).toBe(
      '10 orders (860 cases, 12.8 pallets) cannot be delivered with your fleet. To deliver them, hire 1 x 10-ton (12 bays): extra about 50 OMR. Still left out: none.',
    );
    expect(text.details).toContain('Also left out: 4 orders, all P4/P5 - renting is not suggested for them; this plan still delivers 1 of them with the hired trucks.');
  });

  it('nothing is left out any more (the orders were brought forward or changed since the plan): never "0 orders"', () => {
    // Review of the hire branch: every order the plan left out is gone from the day to plan.
    const { request, kept } = day();
    const req = { ...request, stops: kept };
    const gone = [{ stop_id: 'L1', order_ids: ['ord-L1'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' }];
    const whatIf = { loads: [load('OWN1', kept, 35, 60)], unserved: [], trucks_used: 1, trips: 1 };
    const s = summarizeHire({ request: req, baseUnserved: gone, baseOrders: kept.flatMap((k) => k.order_ids), whatIf, options: [TEN, THREE] });
    expect(s.leftOut.orders).toBe(0);
    expect(hireNeed({ request: req, baseUnserved: gone, baseOrders: kept.flatMap((k) => k.order_ids) }).leftOut.orders).toBe(0);
    const text = hireSuggestionText(s);
    expect(text.headline).toBe('Nothing is left out for lack of trucks any more: the orders this plan left out are no longer to plan (moved to another day, changed or cancelled). No truck needs to be hired.');
    expect(text.headline).not.toMatch(/0 orders|Check hire options/);
  });

  it('the truck whose stops matter least is the one dropped: lowest priorities first', () => {
    const { request, left, kept, baseUnserved } = day(4);
    // The 10-ton carries only P5 stops (L1-L4, a what-if of before the owner's answers); the 3-ton carries P3 stops.
    const whatIf = {
      loads: [load('OWN1', kept, 35, 60), load(virtualHireId('o10', 1), left.slice(0, 4), 50, 55), load(virtualHireId('o3', 1), left.slice(4, 8), 30, 33)],
      unserved: left.slice(8).map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'HARD_WINDOW_INFEASIBLE', reason_message: '' })),
      trucks_used: 3,
      trips: 3,
    } as unknown as Pick<DispatchScenario, 'loads' | 'unserved' | 'trucks_used' | 'trips'>;
    const s = summarizeHire({ request, baseUnserved, whatIf, options: [TEN, THREE] });
    expect(s.alternative?.dropped).toBe('10-ton');
    expect(s.stillLeft.orders).toBe(6);
    expect(hireSuggestionText(s).headline).toMatch(/Still left out: 6 orders \(\d[\d,]* cases, [\d.]+ pallets\): even with every truck you can rent they do not fit \(their receiving hours or the drivers’ shift\)\./);
  });

  it('hiring does not help: the what-if rents nothing (or delivers none of them)', () => {
    const { request, kept, left, baseUnserved } = day();
    const whatIf = {
      loads: [load('OWN1', kept, 35, 60)],
      unserved: left.map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'HARD_WINDOW_INFEASIBLE', reason_message: '' })),
      trucks_used: 1,
      trips: 1,
    } as unknown as Pick<DispatchScenario, 'loads' | 'unserved' | 'trucks_used' | 'trips'>;
    const s = summarizeHire({ request, baseUnserved, whatIf, options: [TEN, THREE] });
    expect(s.status).toBe('NO_HELP');
    expect(s.hires).toEqual([]);
    expect(s.alternative).toBeNull();
    expect(hireSuggestionText(s).headline).toBe(
      '14 orders (1,180 cases, 17.6 pallets) cannot be delivered with your fleet. Hiring does not help: even with every truck you can rent they do not fit (their receiving hours or the drivers’ shift).',
    );
  });

  it('an order the plan in use left out for another reason never counts (no truck helps it)', () => {
    const { request, left, kept } = day();
    const baseUnserved = [
      ...left.slice(0, 2).map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' })),
      { stop_id: left[2]!.stop_id, order_ids: left[2]!.order_ids, reason_code: 'LOCKED_PLAN_CONFLICT' },
    ];
    const whatIf = {
      loads: [load('OWN1', kept, 35, 60), load(virtualHireId('o3', 1), left.slice(0, 2), 30, 32)],
      unserved: [{ stop_id: left[2]!.stop_id, order_ids: left[2]!.order_ids, reason_code: 'LOCKED_PLAN_CONFLICT', reason_message: '' }],
      trucks_used: 2,
      trips: 2,
    } as unknown as Pick<DispatchScenario, 'loads' | 'unserved' | 'trucks_used' | 'trips'>;
    const s = summarizeHire({ request: { ...request, stops: [...kept, ...left.slice(0, 3)] }, baseUnserved, whatIf, options: [TEN, THREE] });
    expect(s.leftOut.orders).toBe(2);
    expect(s.stillLeft.orders).toBe(0);
    expect(hireSuggestionText(s).headline).toMatch(/^2 orders \(160 cases, 2\.4 pallets\) cannot be delivered with your fleet\. To deliver them, hire 1 x 3-ton \(6 bays\): extra about 30 OMR\. Still left out: none\.$/);
    expect(s.alternative).toBeNull();
  });

  it('a day without pallets says cases only, and a truck without bays its cases', () => {
    const { request, left, kept, baseUnserved } = day();
    const noPallets = { ...request, stops: request.stops.map(({ demand_pallet_units: _u, ...s }) => s) };
    const box: HireOptionFacts = { ...THREE, id: 'box', label: 'Box van', bays: null, capacityCases: 600 };
    const whatIf = { loads: [load('OWN1', kept, 35, 60), load(virtualHireId('box', 1), left, 30, 36)], unserved: [], trucks_used: 2, trips: 2 };
    const s = summarizeHire({ request: noPallets, baseUnserved, whatIf, options: [box] });
    expect(hireSuggestionText(s, 'AED').headline).toBe(
      '14 orders (1,180 cases) cannot be delivered with your fleet. To deliver them, hire 1 x Box van (600 cases): extra about 30 AED. Still left out: none.',
    );
  });
});

/** A small day for the review cases: S1, S2 on the own truck in the plan in use; L1, L2 left out. */
function small() {
  const stop = (id: string, cases: number, units: number): DispatchStop => ({
    stop_id: id, order_ids: [`ord-${id}`], customer_id: `c-${id}`, lat: 23.6, lng: 58.4, demand_cases: cases, demand_kg: 0, demand_pallet_units: units, priority: 3,
  });
  const [s1, s2, l1, l2] = [stop('S1', 200, 3000), stop('S2', 200, 3000), stop('L1', 80, 1200), stop('L2', 80, 1200)];
  const request: DispatchRequest = {
    run_id: 'r', tenant_id: 't', depot: { id: 'd', lat: 23.6, lng: 58.4 }, stops: [s1!, s2!, l1!, l2!],
    trucks: [own('OWN1'), ...hireTrucksForRequest([TEN, THREE], { tripCost: 2.5 }, {}, 10)],
    config: { scenarios: ['RECOMMENDED'] } as DispatchRequest['config'],
  };
  const unserved = (stops: DispatchStop[], reason = 'SOLVER_DROPPED_LOW_PRIORITY') => stops.map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: reason, reason_message: '' }));
  return { request, s1: s1!, s2: s2!, l1: l1!, l2: l2!, unserved, baseOrders: ['ord-S1', 'ord-S2'] };
}
type WhatIf = Pick<DispatchScenario, 'loads' | 'unserved' | 'trucks_used' | 'trips'>;

describe('the suggestion says what the what-if found (review of the hire branch)', () => {
  it('the own fleet carries the orders left out (a search miss, or the day changed): re-plan, never "hiring does not help"', () => {
    const { request, s1, s2, l1, l2, unserved, baseOrders } = small();
    const whatIf = { loads: [load('OWN1', [s1, s2, l1, l2], 35, 60)], unserved: [], trucks_used: 1, trips: 1 } as unknown as WhatIf;
    const s = summarizeHire({ request, baseUnserved: unserved([l1, l2]), baseOrders, whatIf, options: [TEN, THREE] });
    expect(s.status).toBe('OWN_FLEET');
    expect(s.delivered.orders).toBe(2);
    const text = hireSuggestionText(s);
    expect(text.headline).toBe(
      '2 orders (160 cases, 2.4 pallets) are left out of this plan, but the hire check fits them on your own trucks: no truck needs to be hired. Re-plan to put them on your trucks.',
    );
    expect(text.headline).not.toMatch(/Hiring does not help|cannot be delivered with your fleet/);
  });

  it('a stop no own truck reached in time (HARD_WINDOW_INFEASIBLE in the plan) delivered by a rented truck counts as helped', () => {
    const { request, s1, s2, l1, unserved, baseOrders } = small();
    const req1 = { ...request, stops: [s1, s2, l1] };
    const whatIf = { loads: [load('OWN1', [s1, s2], 35, 60), load(virtualHireId('o3', 1), [l1], 30, 33)], unserved: [], trucks_used: 2, trips: 2 } as unknown as WhatIf;
    const s = summarizeHire({ request: req1, baseUnserved: unserved([l1], 'HARD_WINDOW_INFEASIBLE'), baseOrders, whatIf, options: [TEN, THREE] });
    expect(s).toMatchObject({ status: 'HIRE', leftOut: { orders: 1 }, delivered: { orders: 1 }, stillLeft: { orders: 0 } });
    expect(hireSuggestionText(s).headline).toBe('1 order (80 cases, 1.2 pallets) cannot be delivered with your fleet. To deliver it, hire 1 x 3-ton (6 bays): extra about 30 OMR. Still left out: none.');
  });

  it('an order the plan in use delivers and the what-if drops is never "still left out": it is said on its own', () => {
    const { request, s1, s2, l1, l2, unserved, baseOrders } = small();
    const whatIf = { loads: [load('OWN1', [s1], 35, 60), load(virtualHireId('o10', 1), [l1, l2], 50, 55)], unserved: unserved([s2]), trucks_used: 2, trips: 2 } as unknown as WhatIf;
    const s = summarizeHire({ request, baseUnserved: unserved([l1, l2]), baseOrders, whatIf, options: [TEN, THREE] });
    expect(s.status).toBe('HIRE');
    expect(s.stillLeft.orders).toBe(0);
    expect(s.dropped).toMatchObject({ orders: 1, cases: 200, stopIds: ['S2'] });
    expect(hireSuggestionText(s).headline).toBe(
      '2 orders (160 cases, 2.4 pallets) cannot be delivered with your fleet. To deliver them, hire 1 x 10-ton (12 bays): extra about 50 OMR. Still left out: none. But this check leaves out 1 order (200 cases, 3.0 pallets) your current plan delivers: Use this plan re-plans the day with the hired trucks instead.',
    );
  });

  it('orders added after the plan are counted from the request the what-if used; orders gone since are not', () => {
    const { request, s1, s2, l1, l2, unserved, baseOrders } = small();
    // L2 came in after the plan (not in it at all); a stop left out by the plan whose order is gone since is not in the request.
    const whatIf = { loads: [load('OWN1', [s1, s2], 35, 60), load(virtualHireId('o3', 1), [l1, l2], 30, 33)], unserved: [], trucks_used: 2, trips: 2 } as unknown as WhatIf;
    const gone = { stop_id: 'GONE', order_ids: ['ord-GONE'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY', reason_message: '' };
    const s = summarizeHire({ request, baseUnserved: [...unserved([l1]), gone], baseOrders, whatIf, options: [TEN, THREE] });
    expect(s.leftOut).toMatchObject({ orders: 2, stopIds: ['L1', 'L2'] });
    expect(s.delivered.orders).toBe(2);
    expect(s.newOrders).toBe(1);
    expect(hireSuggestionText(s).headline).toMatch(/^2 orders \(160 cases, 2\.4 pallets; 1 of them added after this plan was made\) cannot be delivered with your fleet\. To deliver them, hire 1 x 3-ton/);
  });

  it('"even with every truck you can rent" only when the reasons or the unused trucks back it up', () => {
    const { request, s1, s2, l1, l2, unserved, baseOrders } = small();
    // A truck the check could still rent stayed unused and L2 is out for "not placed": a search miss.
    const miss = { loads: [load('OWN1', [s1, s2], 35, 60), load(virtualHireId('o3', 1), [l1], 30, 33)], unserved: unserved([l2]), trucks_used: 2, trips: 2 } as unknown as WhatIf;
    const a = summarizeHire({ request, baseUnserved: unserved([l1, l2]), baseOrders, whatIf: miss, options: [TEN, THREE] });
    expect(a.unitsUsed).toBe(1);
    expect(a.unitsOffered).toBe(5);
    expect(hireSuggestionText(a).headline).toMatch(/Still left out: 1 order \(80 cases, 1\.2 pallets\): the Quick search did not place it although trucks you can rent stayed unused - press Check hire options to search again\.$/);
    expect(hireSuggestionText(a).headline).not.toMatch(/even with every truck/);
    // Every truck the day can rent is used: that backs it up.
    const all = { ...request, trucks: [own('OWN1'), ...hireTrucksForRequest([{ ...THREE, maxPerDay: 1 }], { tripCost: 2.5 }, {}, 10)] };
    const b = summarizeHire({ request: all, baseUnserved: unserved([l1, l2]), baseOrders, whatIf: miss, options: [TEN, THREE] });
    expect(hireSuggestionText(b).headline).toMatch(/Still left out: 1 order \(80 cases, 1\.2 pallets\): even with every truck you can rent it does not fit \(how many trucks you can rent\)\.$/);
    // Nothing rented, nothing delivered, and trucks unused: never "hiring does not help".
    const none = { loads: [load('OWN1', [s1, s2], 35, 60)], unserved: unserved([l1, l2]), trucks_used: 1, trips: 1 } as unknown as WhatIf;
    const c = summarizeHire({ request, baseUnserved: unserved([l1, l2]), baseOrders, whatIf: none, options: [TEN, THREE] });
    expect(c.status).toBe('NO_HELP');
    expect(hireSuggestionText(c).headline).toBe(
      '2 orders (160 cases, 2.4 pallets) cannot be delivered with your fleet. The hire check placed none of them although trucks you can rent stayed unused - press Check hire options to search again.',
    );
  });
});

describe('"with one truck fewer" (third review of the hire branch)', () => {
  const stop = (id: string, cases: number, priority = 3): DispatchStop => ({
    stop_id: id, order_ids: [`ord-${id}`], customer_id: `c-${id}`, lat: 23.6, lng: 58.4, demand_cases: cases, demand_kg: 0, demand_pallet_units: cases * 10, priority,
  });
  const out = (stops: DispatchStop[]) => stops.map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'SOLVER_DROPPED_LOW_PRIORITY', reason_message: '' }));
  const req = (stops: DispatchStop[]): DispatchRequest => ({
    run_id: 'r', tenant_id: 't', depot: { id: 'd', lat: 23.6, lng: 58.4 }, stops,
    trucks: [own('OWN1'), ...hireTrucksForRequest([TEN, THREE], { tripCost: 2.5 }, {}, 10)],
    config: { scenarios: ['RECOMMENDED'] } as DispatchRequest['config'],
  });

  it('a rental that carries orders the own fleet delivers today never counts more than the orders left out', () => {
    // Review: the plan leaves out X1 and X2 (400 cases each). The what-if puts X2 on the own truck, X1 on
    // one 3-ton and 7 small orders the plan delivers on the other: "up to 7 orders stay undelivered" -
    // more than with no rental at all. Counted now: the orders the hire is for, at most those 2.
    const [x1, x2] = [stop('X1', 400), stop('X2', 400)];
    const base = Array.from({ length: 7 }, (_, i) => stop(`B${i + 1}`, 50));
    const whatIf = {
      loads: [load('OWN1', [x2], 35, 60), rentedLoad(virtualHireId('o3', 1), [x1], 30), rentedLoad(virtualHireId('o3', 2), base, 30)],
      unserved: [], trucks_used: 3, trips: 3,
    } as unknown as WhatIf;
    const s = summarizeHire({ request: req([x1, x2, ...base]), baseUnserved: out([x1, x2]), baseOrders: base.flatMap((b) => b.order_ids), whatIf, options: [TEN, THREE] });
    expect(s.leftOut.orders).toBe(2);
    expect(s.alternative!.leftOut.orders).toBeLessThanOrEqual(s.leftOut.orders);
    expect(s.alternative!.leftOut).toMatchObject({ orders: 2, cases: 800 });
    expect(hireSuggestionText(s).details).toContain(
      'With one truck fewer (1 x 3-ton (6 bays), extra about 30 OMR): up to 2 orders (800 cases, 8.0 pallets) stay undelivered - what the 3-ton would carry or make room for.',
    );
  });

  it('P4/P5 orders riding on the dropped truck are said apart, never counted as the price of one truck fewer', () => {
    // Review: the dropped 3-ton carries 1 P3 order left out and 5 P5 riders: "up to 6 orders".
    const x = stop('X', 400);
    const l = stop('L', 50);
    const riders = Array.from({ length: 5 }, (_, i) => stop(`R${i + 1}`, 60, 5));
    const whatIf = {
      loads: [load('OWN1', [], 35, 35), rentedLoad(virtualHireId('o10', 1), [x], 50), rentedLoad(virtualHireId('o3', 1), [l, ...riders], 30)],
      unserved: [], trucks_used: 3, trips: 3,
    } as unknown as WhatIf;
    const s = summarizeHire({ request: req([x, l, ...riders]), baseUnserved: out([x, l, ...riders]), baseOrders: [], whatIf, options: [TEN, THREE] });
    expect(s.leftOut.orders).toBe(2);
    expect(s.alternative).toMatchObject({ dropped: '3-ton', leftOut: { orders: 1, cases: 50 }, low: { orders: 5 } });
    expect(hireSuggestionText(s).details).toContain(
      'With one truck fewer (1 x 10-ton (12 bays), extra about 50 OMR): up to 1 order (50 cases, 0.5 pallets) stays undelivered - what the 3-ton would carry. It also carries 5 P4/P5 orders, which would stay out too.',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// "Nothing changed since it was computed"
// ---------------------------------------------------------------------------------------------

describe('what "Use this plan" compares (requestBasisText, sameDayMovedOn)', () => {
  const base = (): DispatchRequest => ({
    run_id: 'r1', tenant_id: 't', depot: { id: 'd', lat: 23.6, lng: 58.4 },
    stops: [{ stop_id: 'a', order_ids: ['o1'], customer_id: 'c', lat: 23.6, lng: 58.5, demand_cases: 10, demand_kg: 100, priority: 3 }],
    trucks: [own('T1', { frozen_trips: [{ load_no: 1, depart_min: 400, return_min: 600, cases: 50 }] })],
    config: { shift_start_min: 360, loading_from_min: 600, search_mode: 'QUICK', max_search_sec: null, scenarios: ['RECOMMENDED'], reload_min: 30 } as DispatchRequest['config'],
  });

  it('ignores the trucks to rent and what moves with the clock or the search', () => {
    const a = base();
    const b = { ...base(), run_id: 'r2', trucks: [...base().trucks, ...hireTrucksForRequest([TEN], { tripCost: 0 }, {}, 10)] };
    b.config = { ...b.config, shift_start_min: 700, loading_from_min: 610, search_mode: 'THOROUGH', max_search_sec: 1200, scenarios: ['RECOMMENDED', 'MIN_TRUCKS'] };
    expect(requestBasisText(a, ['L2', 'L1'])).toBe(requestBasisText(b as DispatchRequest, ['L1', 'L2']));
    // run_id is not data either: the same day read for the child version compares equal.
    expect(requestBasisText(a)).not.toContain('r1');
  });

  it('changes with an order, a frozen load, a truck or a setting', () => {
    const a = requestBasisText(base(), ['L1']);
    const order = base();
    order.stops[0]!.demand_cases = 11;
    const frozen = base();
    frozen.trucks[0]!.frozen_trips![0]!.return_min = 610;
    const truck = base();
    truck.trucks[0]!.bays = 10;
    const setting = base();
    setting.config = { ...setting.config, reload_min: 45 };
    for (const r of [order, frozen, truck, setting]) expect(requestBasisText(r, ['L1'])).not.toBe(a);
    expect(requestBasisText(base(), ['L9'])).not.toBe(a);
  });

  it('a plan made on its delivery day goes stale once it would start more than 10 minutes later', () => {
    const cfg = (from: number | null) => ({ loading_from_min: from ?? undefined }) as DispatchRequest['config'];
    expect(sameDayMovedOn(cfg(null), cfg(null))).toBe(false);
    expect(sameDayMovedOn(cfg(600), cfg(610))).toBe(false);
    expect(sameDayMovedOn(cfg(600), cfg(611))).toBe(true);
    expect(sameDayMovedOn(cfg(null), cfg(600))).toBe(true); // midnight passed: now its delivery day
  });
});

describe('a one-day truck', () => {
  it('is in the trucks of its own date only', () => {
    const day7 = new Date('2026-10-07T00:00:00Z');
    expect(trucksOfDayWhere('D1', day7)).toEqual({ depotId: 'D1', active: true, OR: [{ onlyOnDate: null }, { onlyOnDate: day7 }] });
  });

  it('shows its code now (the plate the dispatcher entered); every other truck its planned code', () => {
    expect(shownTruckCode('HIRE-10T-0710-1', { code: '12345AB', onlyOnDate: new Date('2026-10-07T00:00:00Z') })).toBe('12345AB');
    // Its plate taken over by a later day's hired truck ("12345AB.261007"): its own plans still say the plate.
    expect(shownTruckCode('HIRE-10T-0710-1', { code: '12345AB.261007', onlyOnDate: new Date('2026-10-07T00:00:00Z') })).toBe('12345AB');
    expect(shownTruckCode('HIRE-10T-0710-1', { code: '12345AB.261008', onlyOnDate: new Date('2026-10-07T00:00:00Z') })).toBe('12345AB.261008');
    expect(shownTruckCode('R1-5187', { code: 'R1-5187-NEW', onlyOnDate: null })).toBe('R1-5187');
    expect(shownTruckCode(null, { code: 'R2' })).toBe('R2');
  });
});

describe('the forms (lib/schemas.ts)', () => {
  it('a hire option needs a label, a depot, bays or cases, a cost per day above 0, 1-10 a day', () => {
    const ok = { depotId: 'D1', label: '10-ton', bays: 12, costPerDay: 50, maxPerDay: 3 };
    expect(hireOptionSchema.safeParse(ok).success).toBe(true);
    expect(hireOptionSchema.safeParse({ ...ok, bays: null, capacityCases: 570 }).success).toBe(true);
    expect(hireOptionSchema.safeParse({ ...ok, bays: null }).success).toBe(false);
    expect(hireOptionSchema.safeParse({ ...ok, costPerDay: 0 }).success).toBe(false);
    expect(hireOptionSchema.safeParse({ ...ok, maxPerDay: 11 }).success).toBe(false);
    expect(hireOptionSchema.safeParse({ ...ok, bays: 41 }).success).toBe(false);
    expect(hireOptionSchema.safeParse({ ...ok, costPerKm: '' }).success).toBe(true);
    expect(hireOptionSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(hireOptionPatchSchema.safeParse({ active: false }).success).toBe(true);
  });

  it('a hired truck: only its plate (a truck code) and default driver', () => {
    expect(hiredTruckPatchSchema.safeParse({ code: '12345-AB' }).success).toBe(true);
    expect(hiredTruckPatchSchema.safeParse({ code: '12345 AB' }).success).toBe(false);
    expect(hiredTruckPatchSchema.safeParse({ capacityCases: 1 }).success).toBe(false);
    expect(hiredTruckPatchSchema.safeParse({ defaultDriverId: '' }).data).toEqual({ defaultDriverId: null });
    expect(hireUseSchema.safeParse({ suggestionId: 's', expect: { date: '2026-10-07', depotId: 'D1' } }).success).toBe(true);
    expect(hireUseSchema.safeParse({ suggestionId: 's', expect: { date: '2026-13-07', depotId: 'D1' } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Background solves never hold up a dispatcher
// ---------------------------------------------------------------------------------------------

describe('solve admission: background solves (the what-if)', () => {
  const limits = { userPerHour: 2, tenantPerHour: 100, tenantConcurrent: 1, globalConcurrent: 2, maxQueue: 10, queueHardCap: 200, tenantQueue: 2, windowMs: 3_600_000 };

  it('use no hourly quota', () => {
    const a = new SolveAdmission(limits, Date.now, () => false);
    for (let i = 0; i < 5; i++) {
      const r = a.reserveBackground('T', 'u', () => undefined);
      expect(r.ok).toBe(true);
      if (r.ok) {
        r.ticket.commit();
        r.ticket.release();
      }
    }
    // The user's two optimizations an hour are still there.
    const one = a.reserve('T', 'u');
    expect(one.ok).toBe(true);
  });

  it("a dispatcher's solve takes a running what-if's slot at once when the optimizer is full; the what-if is told to stop", () => {
    const a = new SolveAdmission(limits, Date.now, () => true);
    const stop = vi.fn();
    const busy = a.reserve('U', 'u');
    const bg = a.reserveBackground('T', 'u', stop);
    expect(bg.ok && !bg.ticket.waiting).toBe(true);
    // Every slot is taken (U's solve + T's what-if): a dispatcher's QUICK solve of T preempts the what-if.
    const fg = a.reserve('T', 'u');
    expect(fg.ok && !fg.ticket.waiting).toBe(true);
    expect(fg.ok && fg.ticket.preemptedOthers).toBe(true); // its job waits for the optimizer to free the check's slot
    expect(fg.ok && fg.ticket.mayMeetBusy).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(bg.ok && bg.ticket.preempted).toBe(true);
    expect(a.snapshot()).toMatchObject({ running: 2, waiting: 0 });
    // The what-if's own release afterwards changes nothing.
    if (bg.ok) bg.ticket.release();
    expect(a.snapshot()).toMatchObject({ running: 2 });
    if (busy.ok) busy.ticket.release();
    if (fg.ok) fg.ticket.release();
  });

  it("a company's own what-if never costs its next optimization a slot while the optimizer has one free (review)", () => {
    // Depot D1 optimized, its what-if runs; the same dispatcher optimizes depot D2 20 s later.
    const a = new SolveAdmission(limits, Date.now, () => true);
    const stop = vi.fn();
    const bg = a.reserveBackground('T', 'u', stop);
    const fg = a.reserve('T', 'u');
    expect(fg.ok && !fg.ticket.waiting).toBe(true);
    expect(fg.ok && fg.ticket.preemptedOthers).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(bg.ok && bg.ticket.preempted).toBe(false);
    expect(a.snapshot()).toMatchObject({ running: 2, waiting: 0 });
    // Another company's dispatcher arriving now finds the optimizer full: the what-if makes room.
    const other = a.reserve('U', 'u');
    expect(other.ok && !other.ticket.waiting && other.ticket.preemptedOthers).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    for (const r of [fg, other]) if (r.ok) r.ticket.release();
  });

  it("stops only the what-ifs it needs: the requester's own company's first, never another company's for nothing (review)", () => {
    const a = new SolveAdmission(limits, Date.now, () => true);
    const stopA = vi.fn();
    const stopB = vi.fn();
    const bgA = a.reserveBackground('A', 'u', stopA);
    const bgB = a.reserveBackground('B', 'u', stopB);
    expect(bgA.ok && bgB.ok && !bgA.ticket.waiting && !bgB.ticket.waiting).toBe(true);
    // A's dispatcher: one slot is enough, and A's own what-if gives it.
    const fg = a.reserve('A', 'u');
    expect(fg.ok && !fg.ticket.waiting).toBe(true);
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).not.toHaveBeenCalled();
    expect(a.snapshot()).toMatchObject({ running: 2 });
    // C's dispatcher: no what-if of its own, the newest one goes (B's).
    if (fg.ok) fg.ticket.release();
    const bgA2 = a.reserveBackground('A', 'u', stopA);
    expect(bgA2.ok && !bgA2.ticket.waiting).toBe(true);
    const c = a.reserve('C', 'u');
    expect(c.ok && !c.ticket.waiting).toBe(true);
    expect(stopA).toHaveBeenCalledTimes(2); // A's second what-if is the newest
    expect(stopB).not.toHaveBeenCalled();
    for (const r of [bgB, c]) if (r.ok) r.ticket.release();
  });

  it('a solve admitted right after a preemption may still meet the busy optimizer (its job retries), later ones not', () => {
    let t = 1_000_000;
    const a = new SolveAdmission(limits, () => t, () => true);
    const busy = a.reserve('U', 'u');
    a.reserveBackground('T', 'u', () => undefined);
    const fg = a.reserve('T', 'u'); // preempts the what-if
    expect(fg.ok && fg.ticket.preemptedOthers && fg.ticket.mayMeetBusy).toBe(true);
    if (fg.ok) fg.ticket.release();
    t += 1_000;
    // A slot that the admission sees free a second later: the optimizer may still hold the stopped check.
    const next = a.reserve('V', 'u');
    expect(next.ok && !next.ticket.waiting && !next.ticket.preemptedOthers && next.ticket.mayMeetBusy).toBe(true);
    if (next.ok) next.ticket.release();
    t += 5 * 60_000;
    const later = a.reserve('V', 'u');
    expect(later.ok && later.ticket.mayMeetBusy).toBe(false);
    for (const r of [later, busy]) if (r.ok) r.ticket.release();
  });

  it('a waiting what-if starts only after the waiting dispatchers that can start; one per company waits', () => {
    const a = new SolveAdmission(limits, Date.now, () => true);
    const f1 = a.reserve('T', 'u');
    const f2 = a.reserve('U', 'u');
    expect(f1.ok && f2.ok).toBe(true);
    const bg = a.reserveBackground('V', 'u', () => undefined);
    expect(bg.ok && bg.ticket.waiting).toBe(true);
    expect(a.reserveBackground('V', 'u', () => undefined)).toMatchObject({ ok: false, status: 503 });
    const f3 = a.reserve('W', 'u'); // queued after the what-if
    expect(f3.ok && f3.ticket.waiting).toBe(true);
    if (f1.ok) f1.ticket.release();
    expect(f3.ok && !f3.ticket.waiting).toBe(true); // the dispatcher went first
    expect(bg.ok && bg.ticket.waiting).toBe(true);
    if (f2.ok) f2.ticket.release();
    expect(bg.ok && !bg.ticket.waiting).toBe(true);
  });

  it('three depots optimized in quick succession: each depot-day keeps one check waiting, none is lost (review)', () => {
    // Review of the hire branch: depot A's check runs, depot B's waits; depot C's dispatcher solve runs
    // beside A's check and saves: C's automatic check was refused (one waiting per company) and lost.
    const a = new SolveAdmission(limits, Date.now, () => true);
    const checkA = a.reserveBackground('T', 'u', () => undefined, 'A|2026-10-07');
    expect(checkA.ok && !checkA.ticket.waiting).toBe(true);
    const checkB = a.reserveBackground('T', 'u', () => undefined, 'B|2026-10-07');
    const solveC = a.reserve('T', 'u');
    expect(checkB.ok && checkB.ticket.waiting).toBe(true);
    expect(solveC.ok && !solveC.ticket.waiting).toBe(true);
    if (solveC.ok) solveC.ticket.release(); // C's plan saved; A's check still holds the company's slot
    // C's automatic check waits too (its own depot-day), instead of being refused and lost.
    const checkC = a.reserveBackground('T', 'u', () => undefined, 'C|2026-10-07');
    expect(checkC.ok && checkC.ticket.waiting).toBe(true);
    // A second check of a depot-day already waiting is still refused (the version in use has one).
    expect(a.reserveBackground('T', 'u', () => undefined, 'C|2026-10-07')).toMatchObject({ ok: false, status: 503 });
    expect(a.reserveBackground('T', 'u', () => undefined, 'B|2026-10-07')).toMatchObject({ ok: false, status: 503 });
    // They run one after the other, in the order they were queued.
    if (checkA.ok) checkA.ticket.release();
    expect(checkB.ok && !checkB.ticket.waiting).toBe(true);
    expect(checkC.ok && checkC.ticket.waiting).toBe(true);
    if (checkB.ok) checkB.ticket.release();
    expect(checkC.ok && !checkC.ticket.waiting).toBe(true);
    if (checkC.ok) checkC.ticket.release();
    expect(a.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });

  it('a running what-if stopped by its own job (a new optimization of the day) counts as a preemption: the next solves may meet "busy" (review)', () => {
    // Third review: the check's slot was given to the next solve at once while the optimizer still held
    // the cancelled solve, and that solve failed on the first "busy" (mayMeetBusy false).
    let t = 1_000_000;
    const a = new SolveAdmission({ ...limits, globalConcurrent: 2, tenantConcurrent: 2 }, () => t, () => true);
    const bg = a.reserveBackground('A', 'u', () => undefined);
    expect(bg.ok && !bg.ticket.waiting).toBe(true);
    const mine = a.reserve('A', 'u'); // fits beside its own what-if: no preemption
    expect(mine.ok && !mine.ticket.preemptedOthers && !mine.ticket.mayMeetBusy).toBe(true);
    // The check is stopped while its optimizer call runs: its slot is given back at once.
    if (bg.ok) bg.ticket.release({ abandoned: true });
    const other = a.reserve('B', 'u');
    expect(other.ok && !other.ticket.waiting && other.ticket.mayMeetBusy).toBe(true);
    // A background check started in that window may meet "busy" too (it retries instead of failing).
    if (other.ok) other.ticket.release();
    const next = a.reserveBackground('C', 'u', () => undefined);
    expect(next.ok && !next.ticket.waiting && next.ticket.mayMeetBusy).toBe(true);
    // A what-if that ended normally (its call returned) leaves nothing behind.
    t += 5 * 60_000;
    if (next.ok) next.ticket.release();
    const later = a.reserve('D', 'u');
    expect(later.ok && later.ticket.mayMeetBusy).toBe(false);
    for (const r of [mine, later]) if (r.ok) r.ticket.release();
  });

  it('a check that was already stopped once is not the first one stopped again: the others take their turn (review)', () => {
    // Third review: the requeued check was the newest, so it was stopped first again - for good.
    const a = new SolveAdmission({ ...limits, globalConcurrent: 3, tenantConcurrent: 2 }, Date.now, () => true);
    const x = a.reserve('X', 'u');
    const stopC = vi.fn();
    const stopB = vi.fn();
    const wC = a.reserveBackground('C', 'u', stopC);
    const wB = a.reserveBackground('B', 'u', stopB);
    expect(wC.ok && wB.ok && !wC.ticket.waiting && !wB.ticket.waiting).toBe(true);
    const fa = a.reserve('A', 'u'); // the optimizer is full: the newest check (B's) is stopped
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(stopC).not.toHaveBeenCalled();
    // B's check goes back to the queue (once), and gets the slot X frees.
    const wB2 = a.reserveBackground('B', 'u', stopB, 'B', { preemptedBefore: 1 });
    expect(wB2.ok && wB2.ticket.waiting).toBe(true);
    if (x.ok) x.ticket.release();
    expect(wB2.ok && !wB2.ticket.waiting).toBe(true);
    // E's dispatcher needs a slot: C's check, never stopped yet, goes - not B's second run.
    const fe = a.reserve('E', 'u');
    expect(fe.ok && !fe.ticket.waiting).toBe(true);
    expect(stopC).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(wB2.ok && wB2.ticket.preempted).toBe(false);
    for (const r of [fa, fe, wB2]) if (r.ok) r.ticket.release();
    expect(a.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });

  it('a dispatcher waiting behind a what-if of another company is started by preempting it', () => {
    const a = new SolveAdmission(limits, Date.now, () => true);
    const f1 = a.reserve('T', 'u');
    const stop = vi.fn();
    const bg = a.reserveBackground('V', 'u', stop);
    expect(bg.ok && !bg.ticket.waiting).toBe(true);
    // Every slot is taken (T's solve + V's what-if): U's solve takes the what-if's.
    const f2 = a.reserve('U', 'u');
    expect(f2.ok && !f2.ticket.waiting).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    if (f1.ok) f1.ticket.release();
    if (f2.ok) f2.ticket.release();
    expect(a.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });
});
