/**
 * The hire suggestion (owner request 6 Oct 2026), pure parts: the request's trucks to rent (one per
 * unit, never more than the day may still rent), the fleet averages they are costed with, the codes
 * of rented trucks, the suggestion worked out from a what-if (the owner's example word for word, a
 * suggestion that does not help, one truck fewer), what "nothing changed" compares, the one-day
 * availability of a rented truck, the code a load shows, and the background solves of the solve
 * admission (no quota, never ahead of a dispatcher's solve). Synthetic data only.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchScenario, DispatchStop, DispatchTruck } from '@routeiq/shared-types';
import {
  CAPACITY_REASONS,
  fleetAverages,
  hireSuggestionText,
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
    const avg = { costPerKm: 0.17, tripCost: 2.5 };
    const trucks = hireTrucksForRequest([TEN, THREE], avg, { o10: 1 });
    expect(trucks.map((t) => t.id)).toEqual([virtualHireId('o10', 1), virtualHireId('o10', 2), virtualHireId('o3', 1), virtualHireId('o3', 2)]);
    expect(trucks.every((t) => t.hire_candidate === true)).toBe(true);
    expect(trucks[0]).toMatchObject({ code: 'HIRE-10T-1', bays: 12, capacity_cases: 1140, capacity_kg: 0, fixed_cost: 50, cost_per_km: 0.17, trip_cost: 2.5, km_per_litre: null });
    // An option's own cost per km wins over the fleet's average.
    expect(trucks[2]).toMatchObject({ code: 'HIRE-3T-1', bays: 6, fixed_cost: 30, cost_per_km: 0.2 });
    expect(hireTrucksForRequest([TEN], avg, { o10: 3 })).toEqual([]);
    expect(hireTrucksForRequest([TEN], avg, { o10: 5 })).toEqual([]);
  });

  it('an option without bays is a truck planned by cases (no bays field)', () => {
    const [t] = hireTrucksForRequest([{ ...THREE, id: 'c', bays: null, capacityCases: 400, payloadKg: 3000, maxPerDay: 1 }], { costPerKm: 0.1, tripCost: 0 });
    expect(t).toMatchObject({ capacity_cases: 400, capacity_kg: 3000 });
    expect('bays' in t!).toBe(false);
  });

  it('the virtual ids are never a real truck id and read back', () => {
    expect(parseVirtualHireId(virtualHireId('cm1abc', 2))).toEqual({ optionId: 'cm1abc', n: 2 });
    expect(parseVirtualHireId('cm1abc')).toBeNull();
    expect(parseVirtualHireId('hire~x~0')).toBeNull();
  });

  it('the fleet averages: own trucks only, fuel included at the request fuel price', () => {
    const avg = fleetAverages([own('A'), own('B', { cost_per_km: 0.06, km_per_litre: 7, trip_cost: 2 }), { ...own('H'), hire_candidate: true, cost_per_km: 9 }], 0.26);
    // (0.1 + 0.26/3.5 + 0.06 + 0.26/7) / 2
    expect(avg.costPerKm).toBeCloseTo((0.1 + 0.26 / 3.5 + 0.06 + 0.26 / 7) / 2, 4);
    expect(avg.tripCost).toBe(2.5);
    expect(fleetAverages([], 0.26)).toEqual({ costPerKm: 0, tripCost: 0 });
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

/** 18 stops: S1-S4 on the own truck; L1-L14 left out by the plan in use (1,180 cases, 17.6 pallets). */
function day() {
  const stop = (id: string, cases: number, units: number, priority = 3): DispatchStop => ({
    stop_id: id, order_ids: [`ord-${id}`], customer_id: `c-${id}`, lat: 23.6, lng: 58.4, demand_cases: cases, demand_kg: 0, demand_pallet_units: units, priority,
  });
  const kept = ['S1', 'S2', 'S3', 'S4'].map((id) => stop(id, 200, 3000));
  // 14 orders: 10 x 80 cases / 1.2 pallets + 4 x 95 cases / 1.4 pallets = 1,180 cases, 17.6 pallets.
  const left = [...Array.from({ length: 10 }, (_, i) => stop(`L${i + 1}`, 80, 1200, i < 4 ? 5 : 3)), ...Array.from({ length: 4 }, (_, i) => stop(`L${i + 11}`, 95, 1400))];
  const request: DispatchRequest = {
    run_id: 'r', tenant_id: 't', depot: { id: 'd', lat: 23.6, lng: 58.4 }, stops: [...kept, ...left],
    trucks: [own('OWN1'), ...hireTrucksForRequest([TEN, THREE], { costPerKm: 0.17, tripCost: 2.5 })],
    config: { scenarios: ['RECOMMENDED'] } as DispatchRequest['config'],
  };
  const baseUnserved = left.map((s) => ({ stop_id: s.stop_id, order_ids: s.order_ids, reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' }));
  return { request, left, kept, baseUnserved };
}

type Load = DispatchScenario['loads'][number];
const load = (truckId: string, stops: DispatchStop[], fixed: number, total: number): Load =>
  ({ truck_id: truckId, load_no: 1, cases: stops.reduce((a, s) => a + s.demand_cases, 0), fixed_cost: fixed, total_cost: total, stops: stops.map((s, i) => ({ sequence: i + 1, stop_id: s.stop_id })) }) as unknown as Load;

describe('the suggestion (summarizeHire, hireSuggestionText)', () => {
  it("the owner's example: 14 orders, hire 1 x 10-ton + 1 x 3-ton, extra about 80 OMR, nothing left", () => {
    const { request, left, kept, baseUnserved } = day();
    const whatIf = {
      loads: [load('OWN1', kept, 35, 60), load(virtualHireId('o10', 1), left.slice(0, 10), 50, 61.4), load(virtualHireId('o3', 1), left.slice(10), 30, 38.2)],
      unserved: [],
      trucks_used: 3,
      trips: 3,
    };
    const s = summarizeHire({ request, baseUnserved, whatIf, options: [TEN, THREE] });
    expect(s.status).toBe('HIRE');
    expect(s.hires.map((h) => [h.label, h.count])).toEqual([['10-ton', 1], ['3-ton', 1]]);
    expect(s.hireCost).toBe(80);
    expect(s.runningCost).toBeCloseTo(11.4 + 8.2, 6);
    expect(s.leftOut).toMatchObject({ orders: 14, cases: 1180, palletUnits: 17_600 });
    expect(s.delivered.orders).toBe(14);
    expect(s.stillLeft.orders).toBe(0);
    const text = hireSuggestionText(s);
    expect(text.headline).toBe(
      '14 orders (1,180 cases, 17.6 pallets) cannot be delivered with your fleet. To deliver them, hire 1 x 10-ton (12 bays) + 1 x 3-ton (6 bays): extra about 80 OMR. Still left out: none.',
    );
    expect(text.details[0]).toBe("Plus about 20 OMR running costs on the hired trucks' loads (km, fuel, loading, driver time, as your plan costs them).");
    // One truck fewer: both trucks' most important stop is P3, so the one carrying fewer cases goes.
    expect(s.alternative).toMatchObject({ dropped: '3-ton', hireCost: 50 });
    expect(s.alternative!.leftOut).toMatchObject({ orders: 4, cases: 380, palletUnits: 5600 });
    expect(text.details[1]).toBe('With one truck fewer (1 x 10-ton (12 bays), extra about 50 OMR): up to 4 orders (380 cases, 5.6 pallets) stay undelivered - what the 3-ton would carry.');
  });

  it('the truck whose stops matter least is the one dropped: lowest priorities first', () => {
    const { request, left, kept, baseUnserved } = day();
    // The 10-ton carries only P5 stops (L1-L4); the 3-ton carries P3 stops.
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
    trucks: [own('OWN1'), ...hireTrucksForRequest([TEN, THREE], { costPerKm: 0.17, tripCost: 2.5 })],
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
    const all = { ...request, trucks: [own('OWN1'), ...hireTrucksForRequest([{ ...THREE, maxPerDay: 1 }], { costPerKm: 0.17, tripCost: 2.5 })] };
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
    const b = { ...base(), run_id: 'r2', trucks: [...base().trucks, ...hireTrucksForRequest([TEN], { costPerKm: 0.1, tripCost: 0 })] };
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
