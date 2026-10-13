/**
 * One customer on a truck may use every bay (owner rule 13 Oct 2026: "keep 90% for trucks with several
 * customers, but let a truck that carries only one customer be filled to 100%. A big single order then
 * goes whole on one truck. When a split truly can't be avoided, the planner should keep the leftover as
 * small as possible and avoid adding an extra truck just for it.") Weight is not a limit (NMWC: no payload).
 *
 * The production order behind it: 300 cases of SS250ML (143 per pallet) + 500 of JA1.5L (56 per pallet) =
 * 2,098 + 8,929 = 11,027 units (11.03 pallets). At Pallet fill 90% a 12-bay truck holds 10,800, so it was
 * split 9.89 + 1.13 pallets (sized for the 11-bay truck, "more trips" first).
 * - pallets.ts: the room of a load by its customers (loadRoomUnits, plannedLoadRoom), the limit text, the
 *   solver-echo warning;
 * - split.ts: classifyCustomer (STOP / FULL_TRUCK / SPLIT) and the part sizes (every bay, biggest size
 *   first: the smallest leftover);
 * - buildDispatchRequest (on a fake database): one stop for a customer that fills a truck alone (also with
 *   split deliveries off), its warning, the config sent, a small-truck-only customer on its small truck;
 * - the dispatch check: a load of one customer by every bay, a load of several by the fill; loads planned
 *   before the rule keep their room (and their check hash); no false CAPACITY_CHANGED;
 * - the snapshot keeps the rule only from the optimizer's echo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ prisma: {} as Record<string, any>, tdb: {} as Record<string, any> }));
vi.mock('@/lib/db', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => (k === 'then' ? undefined : fake.prisma[k]) }) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => fake.tdb }));

import type { FeasibilityReport } from '@routeiq/shared-types';
import {
  baysTruckText,
  loadCustomerCount,
  loadPallets,
  loadRoomUnits,
  palletLimitText,
  palletRoomUnits,
  palletsOverBays,
  palletUnits,
  plannedLoadRoom,
  SINGLE_CUSTOMER_FILL_PCT,
  SINGLE_CUSTOMER_SOLVER_NOTE,
  singleCustomerSolverNote,
} from '@/lib/dispatch/pallets';
import { choosePartCapacity, classifyCustomer, linesPalletUnits, splitIntoParts, type FleetTruck, type OpenLine } from '@/lib/dispatch/split';
import { checkPlanFeasibility, inputHash } from '@/lib/dispatch/feasibility';
import { buildDispatchRequest, feasibilityInputFromRows, type FeasibilityRow } from '@/lib/dispatch/plan-service';
import { plannedTruckFacts, type PlanRules, type TruckFacts } from '@/lib/dispatch/snapshots';
import { dispatchConfigFromTenant, effectivePlannerValues } from '@/lib/dispatch/planner-config';
import { tenantAssumptions } from '@/lib/dispatch/workbook';

// ------------------------------------------------------------------------------------------------
// Tawoos, with the numbers
// ------------------------------------------------------------------------------------------------

const SS = 143; // SS250ML cases per pallet
const JA = 56; // JA1.5L cases per pallet
const tawoosLines = (k = 1): OpenLine[] => [
  { lineId: 'ss', orderId: 'o1', cases: 300 * k, kgPerCase: 6, casesPerPallet: SS },
  { lineId: 'ja', orderId: 'o1', cases: 500 * k, kgPerCase: 9.4, casesPerPallet: JA },
];
const cpp = new Map<string, number>([['ss', SS], ['ja', JA]]);
const unitsOf = (lines: { lineId: string; cases: number }[]) => linesPalletUnits(lines, cpp);
/** NMWC's fleet (bays 4, 5, 5, 6, 11, 12 x 4) at Pallet fill 90, every truck 3 loads, no payload. */
const nmwcFleet = (fill = 90, rule = true): FleetTruck[] =>
  [4, 5, 5, 6, 11, 12, 12, 12, 12].map((bays, i) => ({
    code: `T${i + 1}-${bays}`,
    cases: bays * 95,
    kg: null,
    tripsLeft: 3,
    bays,
    palletUnits: palletRoomUnits(bays, fill),
    ...(rule ? { fullPalletUnits: palletRoomUnits(bays, Math.max(fill, SINGLE_CUSTOMER_FILL_PCT)) } : {}),
  }));

describe('the room of a load by its customers (pallets.ts)', () => {
  it('Tawoos is 11,027 units; one customer on 12 bays at 90% may use 12,000, several 10,800; the 11-bay truck holds 11,000', () => {
    expect(palletUnits(300, SS) + palletUnits(500, JA)).toBe(11_027);
    expect(unitsOf(tawoosLines())).toBe(11_027);
    expect(SINGLE_CUSTOMER_FILL_PCT).toBe(100);
    expect(loadRoomUnits(12, 90, 100, 1)).toBe(12_000);
    expect(loadRoomUnits(12, 90, 100, 2)).toBe(10_800);
    expect(loadRoomUnits(11, 90, 100, 1)).toBe(11_000);
    expect(loadRoomUnits(12, 90, null, 1)).toBe(10_800); // no rule: the fill
    expect(loadRoomUnits(12, 95, 90, 1)).toBe(11_400); // never less than the fill
  });

  it('plannedLoadRoom: every bay only for a load of one customer planned under the echoed rule', () => {
    const ts = { bays: 12, palletFillPct: 90, palletRoomUnits: 10_800, singleCustomerFillPct: 100 };
    expect(plannedLoadRoom(ts, 1)).toEqual({ palletRoomUnits: 12_000, bays: 12, palletFillPct: 100, palletOneCustomer: true });
    expect(plannedLoadRoom(ts, 2)).toEqual({ palletRoomUnits: 10_800, bays: 12, palletFillPct: 90, palletOneCustomer: false });
    // Planned before the rule (no echo kept): the room it was planned with.
    expect(plannedLoadRoom({ bays: 12, palletFillPct: 90, palletRoomUnits: 10_800 }, 1)).toEqual({ palletRoomUnits: 10_800, bays: 12, palletFillPct: 90, palletOneCustomer: false });
    // At Pallet fill 100% the rule adds no room: an ordinary load ("limit 12.0 at 100% fill", as before).
    const at100 = plannedLoadRoom({ bays: 12, palletFillPct: 100, palletRoomUnits: 12_000, singleCustomerFillPct: 100 }, 1)!;
    expect(at100).toEqual({ palletRoomUnits: 12_000, bays: 12, palletFillPct: 100, palletOneCustomer: false });
    expect(palletLimitText(loadPallets({ palletUnits: 11_027, ...at100 })!)).toBe('limit 12.0 at 100% fill');
    expect(plannedLoadRoom({ bays: null, palletRoomUnits: null }, 1)).toBeNull();
    expect(plannedLoadRoom(null, 1)).toBeNull();
    expect(loadCustomerCount([{ order: { customerId: 'a' } }, { order: { customerId: 'a' } }])).toBe(1);
    expect(loadCustomerCount([{ order: { customerId: 'a' } }, { order: { customerId: 'b' } }])).toBe(2);
    expect(loadCustomerCount([{ order: { customer: { code: 'C1', branchCode: 'X' } } }, { order: { customer: { code: 'C1', branchCode: 'Y' } } }])).toBe(2);
  });

  it('the limit text: "limit 12.0 at 100% (one customer)" for a one-customer load, so 11.0 / 12 does not look overfilled', () => {
    const one = loadPallets({ palletUnits: 11_027, bays: 12, palletRoomUnits: 12_000, palletFillPct: 100, palletOneCustomer: true })!;
    expect(one.oneCustomer).toBe(true);
    expect(`${palletsOverBays(one)} (${palletLimitText(one)})`).toBe('11.0 / 12 (limit 12.0 at 100% (one customer))');
    const mixed = loadPallets({ palletUnits: 10_500, bays: 12, palletRoomUnits: 10_800, palletFillPct: 90 })!;
    expect(mixed).not.toHaveProperty('oneCustomer');
    expect(palletLimitText(mixed)).toBe('limit 10.8 at 90% fill');
  });

  it('baysTruckText names the trucks a customer fills alone', () => {
    expect(baysTruckText([12])).toBe('a 12-bay truck');
    expect(baysTruckText([11, 12])).toBe('an 11- or 12-bay truck');
    expect(baysTruckText([6])).toBe('a 6-bay truck');
    expect(baysTruckText([4, 6, 12])).toBe('a 4-, 6- or 12-bay truck');
  });

  it('the plan warns when the optimizer did not apply the rule it was sent (an older optimizer)', () => {
    const request = { config: { single_customer_fill_pct: 100 }, trucks: [{ bays: 12 }] };
    expect(singleCustomerSolverNote(request, { pallet_unit: 0.001, single_customer_fill_pct: 100 })).toEqual([]);
    expect(singleCustomerSolverNote(request, { pallet_unit: 0.001 })).toEqual([SINGLE_CUSTOMER_SOLVER_NOTE]);
    expect(singleCustomerSolverNote(request, { pallet_unit: 0.001, single_customer_fill_pct: null })).toEqual([SINGLE_CUSTOMER_SOLVER_NOTE]);
    // Not planned by pallets at all (the pallet note says so), no bay truck, or nothing sent: no note.
    expect(singleCustomerSolverNote(request, {})).toEqual([]);
    expect(singleCustomerSolverNote({ config: { single_customer_fill_pct: 100 }, trucks: [{ bays: null }] }, { pallet_unit: 0.001 })).toEqual([]);
    expect(singleCustomerSolverNote({ config: {}, trucks: [{ bays: 12 }] }, { pallet_unit: 0.001 })).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// split.ts: classify before splitting, and the smallest leftover
// ------------------------------------------------------------------------------------------------

describe('classifyCustomer and the part sizes (split.ts)', () => {
  it('Tawoos at 90%: FULL_TRUCK, alone on a 12-bay truck (never the 11-bay, 11,000 < 11,027)', () => {
    expect(classifyCustomer(800, 0, 11_027, nmwcFleet())).toEqual({ kind: 'FULL_TRUCK', bays: [12] });
    // At 95% it fits a 12-bay truck shared (11,400): an ordinary stop.
    expect(classifyCustomer(800, 0, 11_027, nmwcFleet(95))).toEqual({ kind: 'STOP' });
    // Without the rule: split (as in production).
    expect(classifyCustomer(800, 0, 11_027, nmwcFleet(90, false))).toEqual({ kind: 'SPLIT' });
    // 10,950 fits the 11-bay truck alone (11,000) too.
    expect(classifyCustomer(800, 0, 10_950, nmwcFleet())).toEqual({ kind: 'FULL_TRUCK', bays: [11, 12] });
    // Bigger than every bay: split.
    expect(classifyCustomer(900, 0, 12_001, nmwcFleet())).toEqual({ kind: 'SPLIT' });
    // A truck with no load left still counts when the pool is all there is (the caller's pool decides).
    expect(classifyCustomer(800, 0, 11_027, nmwcFleet().filter((t) => (t.bays ?? 0) < 12))).toEqual({ kind: 'SPLIT' });
  });

  it('a payload, where one is set, still binds a full truck', () => {
    const fleet = nmwcFleet().map((t) => ({ ...t, kg: 10_000 }));
    expect(classifyCustomer(800, 11_900, 11_027, fleet)).toEqual({ kind: 'SPLIT' });
    expect(classifyCustomer(800, 9_900, 11_027, fleet)).toEqual({ kind: 'FULL_TRUCK', bays: [12] });
  });

  it('without the rule the parts are sized for 12 bays now (biggest size first): 10,797 + 231 units, a 33-case leftover', () => {
    const split = choosePartCapacity(800, 0, nmwcFleet(90, false), 0, 11_027)!;
    expect(split.cap.palletUnits).toBe(10_800);
    expect(split.truckCode).toMatch(/-12$/);
    const parts = splitIntoParts(tawoosLines(), split.cap);
    expect(parts.map((p) => unitsOf(p))).toEqual([10_797, 231]);
    expect(parts[1].reduce((a, x) => a + x.cases, 0)).toBe(33);
  });

  it('Tawoos x1.2 (13.2 pallets): 11,995 alone + a 1,238 leftover; x2 (22.1 pallets): 2 parts, 12,000 + 10,054 (3 before)', () => {
    const x12 = tawoosLines(1.2);
    expect(unitsOf(x12)).toBe(13_233);
    const s12 = choosePartCapacity(960, 0, nmwcFleet(), 0, 13_233)!;
    expect(s12.cap.palletUnits).toBe(12_000); // every bay: each full part rides alone
    expect(splitIntoParts(x12, s12.cap).map((p) => unitsOf(p))).toEqual([11_995, 1_238]);
    const x2 = tawoosLines(2);
    expect(unitsOf(x2)).toBe(22_054);
    const s2 = choosePartCapacity(1600, 0, nmwcFleet(), 0, 22_054)!;
    expect(splitIntoParts(x2, s2.cap).map((p) => unitsOf(p))).toEqual([12_000, 10_054]);
    // Before the rule (sizes at 90%, more trips first): three parts for the 11-bay truck.
    const old = choosePartCapacity(1600, 0, nmwcFleet(90, false), 0, 22_054)!;
    expect(Math.ceil(22_054 / (old.cap.palletUnits as number))).toBe(3);
  });

  it('fewest parts first, then the biggest size, then more trips', () => {
    // 15.0 pallets on a 12-bay (2 trips) and an 11-bay truck (3 trips), every bay: 2 parts either way, and
    // the 11-bay size has more trips to choose from (5 against 2); the bigger 12-bay size wins (smaller leftover).
    const fleet: FleetTruck[] = [
      { code: 'A12', cases: 1140, kg: null, tripsLeft: 2, bays: 12, palletUnits: 10_800, fullPalletUnits: 12_000 },
      { code: 'B11', cases: 1045, kg: null, tripsLeft: 3, bays: 11, palletUnits: 9_900, fullPalletUnits: 11_000 },
    ];
    expect(choosePartCapacity(1000, 0, fleet, 0, 15_000)!.truckCode).toBe('A12');
    // 25.0 pallets: 3 parts either way, but only the 12-bay truck carries a 12,000 part (2 trips): the trips
    // are checked first, so the 11,000 size (5 trips) is used.
    expect(choosePartCapacity(1000, 0, fleet, 0, 25_000)!.truckCode).toBe('B11');
  });

  it('a 12-bay and two 6-bay trucks, one trip each: 13,000 units in parts of 6,000 (a 6-bay truck alone) + 6,000 + 1,000', () => {
    // Review 13 Oct 2026: the parts are sized at the 6-bay truck's every bay, and the optimizer decides
    // "alone" per truck, so its route search plans a 6,000 part alone on a 6-bay truck (or with the
    // customer's other parts on the 12-bay one) - test_the_route_search_decides_alone_per_truck (solver).
    const fleet: FleetTruck[] = [
      { code: 'R12', cases: 1140, kg: null, tripsLeft: 1, bays: 12, palletUnits: 10_800, fullPalletUnits: 12_000 },
      { code: 'S6A', cases: 570, kg: null, tripsLeft: 1, bays: 6, palletUnits: 5_400, fullPalletUnits: 6_000 },
      { code: 'S6B', cases: 570, kg: null, tripsLeft: 1, bays: 6, palletUnits: 5_400, fullPalletUnits: 6_000 },
    ];
    expect(classifyCustomer(1000, 0, 13_000, fleet)).toEqual({ kind: 'SPLIT' });
    const s = choosePartCapacity(1000, 0, fleet, 0, 13_000)!;
    expect(s).toMatchObject({ truckCode: 'S6A', cap: { palletUnits: 6_000 } });
    expect(Math.ceil(13_000 / 6_000)).toBe(3); // 3 parts, 3 trips: 6,000 + 6,000 + 1,000
  });

  it('at an equal number of parts a size the own trucks carry wins over a truck to rent (hire what-if)', () => {
    // Review 13 Oct 2026: own 4 x 12-bay + an 11-bay (2 trips each) and a 14-bay truck the what-if may rent.
    const own: FleetTruck[] = [
      ...[1, 2, 3, 4].map((i) => ({ code: `R${i}`, cases: 1140, kg: null, tripsLeft: 2, bays: 12, palletUnits: 10_800, fullPalletUnits: 12_000 })),
      { code: 'B11', cases: 1045, kg: null, tripsLeft: 2, bays: 11, palletUnits: 9_900, fullPalletUnits: 11_000 },
    ];
    const hire14: FleetTruck = { code: 'HIRE14', cases: 1330, kg: null, tripsLeft: 3, bays: 14, palletUnits: 12_600, fullPalletUnits: 14_000, hire: true };
    // 15,000 units: 2 parts either way - sized for the own 12-bay truck (12,000 + 3,000), not the one to rent (14,000 + 1,000).
    expect(choosePartCapacity(1000, 0, own, 0, 15_000)).toMatchObject({ truckCode: 'R1', cap: { palletUnits: 12_000 } });
    expect(choosePartCapacity(1000, 0, [...own, hire14], 0, 15_000)).toMatchObject({ truckCode: 'R1', cap: { palletUnits: 12_000 } });
    expect(choosePartCapacity(1000, 0, [...own, hire14], 0, 23_000)!.truckCode).toBe('R1');
    // Not marked as a truck to rent (own), the bigger size wins as before.
    expect(choosePartCapacity(1000, 0, [...own, { ...hire14, hire: false }], 0, 15_000)!.truckCode).toBe('HIRE14');
    // Fewer parts still win (the 7 Oct fix): 26,000 units are 3 own parts but 2 of 14,000 on the truck to rent (3 trips).
    expect(choosePartCapacity(1000, 0, [...own, hire14], 0, 26_000)).toMatchObject({ truckCode: 'HIRE14', cap: { palletUnits: 14_000 } });
    // Cases only: own 500-case trucks and a 600-case truck to rent, 1,000 cases: 500 + 500, not 600 + 400.
    const caseOwn: FleetTruck[] = [{ code: 'C1', cases: 500, kg: null, tripsLeft: 2 }, { code: 'C2', cases: 500, kg: null, tripsLeft: 2 }];
    expect(choosePartCapacity(1000, 0, [...caseOwn, { code: 'H', cases: 600, kg: null, tripsLeft: 3, hire: true }])!.cap.cases).toBe(500);
  });
});

// ------------------------------------------------------------------------------------------------
// buildDispatchRequest on a fake database
// ------------------------------------------------------------------------------------------------

const CFG: Record<string, any> = {
  avgSpeedKmh: 40, distanceProvider: 'HAVERSINE', distanceMultiplier: 1.3, driverShiftMaxMinutes: 660, shiftStartMin: 420,
  reloadMinutes: 30, loadingMinPerCase: 0, serviceMinPerCase: 0, maxTripsPerTruck: 3, splitDeliveries: true,
  defaultServiceTimeMin: 10, timezone: 'Asia/Muscat', planningCutoffMin: 1080, fuelPricePerLitre: 0, driverCostPerHour: 0,
  overtimeAfterMin: 540, overtimeCostPerHour: 0, prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, osrmUrl: null,
  driverBreakMinutes: 0, driverBreakFromMin: 720, driverBreakToMin: 840, priorityWeightsJson: null, dateOrder: 'DMY',
  serviceAreaJson: null, palletFillPct: 90,
};
const truckRow = (id: string, bays: number) => ({
  id, code: id, capacityCases: bays * 95, capacityWeightKg: 0, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.15, kmPerLitre: null,
  availableFromMin: null, availableToMin: null, maxTripsPerDay: null, bays,
});
const FLEET = () => [4, 5, 5, 6, 11, 12, 12, 12, 12].map((b, i) => truckRow(`T${i + 1}`, b));
function customer(id: string, code: string, over: Record<string, unknown> = {}) {
  return {
    id, code, branchCode: 'SUWIQ', name: `Shop ${code}`, lat: 23.6, lng: 58.4, priority: 3, priorityConfirmed: false, avgServiceTimeMin: 10, serviceTimeConfirmed: false,
    customerType: null, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, locationVerified: true,
    createdFromUpload: false, active: true, smallTruckOnly: false, ...over,
  };
}
/** The production order: SS250ML x ss + JA1.5L x ja cases (no case weight entered: weight is not a limit). */
function tawoosOrder(cust: ReturnType<typeof customer>, k = 1) {
  const ss = Math.round(300 * k);
  const ja = Math.round(500 * k);
  const line = (id: string, cases: number, code: string, casesPerPallet: number) => ({
    id, productId: code, cases, weightKg: 0, weightFromMaster: false, salesValue: null, marginValue: null,
    product: { code, name: code, weightPerCaseKg: 0, casesPerPallet, active: true },
  });
  return {
    id: 'O1', customerId: cust.id, customer: cust, totalCases: ss + ja, totalWeightKg: 0, priority: 3, priorityFromFile: false, isLate: false,
    salesValue: null, marginValue: null, status: 'NEW', lines: [line('l-ss', ss, 'SS250ML', SS), line('l-ja', ja, 'JA1.5L', JA)],
  };
}
function wire(orders: unknown[], cfg: Record<string, any> = {}, trucks = FLEET()) {
  fake.tdb.runPlan = { findUniqueOrThrow: async () => ({ id: 'R1', depotId: 'D1', runDate: new Date('2026-10-14T00:00:00Z'), parentRunId: null, reason: 'INITIAL', depot: { id: 'D1', lat: 23.58, lng: 58.38, openMin: null, closeMin: null } }) };
  fake.tdb.tenantConfig = { findUniqueOrThrow: async () => ({ ...CFG, ...cfg }) };
  fake.tdb.customerTypeProfile = { findMany: async () => [] };
  fake.tdb.planLoad = { findMany: async () => [] };
  fake.tdb.truck = { findMany: async () => trucks };
  fake.prisma.tenant = { findUniqueOrThrow: async () => ({ country: 'Oman' }) };
  fake.prisma.order = { findMany: async () => orders };
  fake.prisma.routeAssignment = { findMany: async () => [] };
  fake.prisma.runPlan = { findMany: async () => [] };
}
const NOW = new Date('2026-10-13T12:00:00Z');

beforeEach(() => {
  for (const k of Object.keys(fake.tdb)) delete fake.tdb[k];
  for (const k of Object.keys(fake.prisma)) delete fake.prisma[k];
});

describe('buildDispatchRequest: one customer that fills a truck', () => {
  const TAWOOS = customer('cust-tawoos', 'CCT0005');

  it('Tawoos at 90%: ONE stop of 11,027 units, the rule sent, and the warning names it', async () => {
    wire([tawoosOrder(TAWOOS)]);
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.stops.map((s) => [s.stop_id, s.demand_cases, s.demand_pallet_units])).toEqual([['cust-tawoos', 800, 11_027]]);
    expect(b.request.config.pallet_fill_pct).toBe(90);
    expect(b.request.config.single_customer_fill_pct).toBe(100);
    expect(b.warnings).toContain(
      'One customer fills a truck: CCT0005/SUWIQ 11.0 pallets, alone on a 12-bay truck (every bay; trucks with several customers keep 90%).',
    );
    expect(b.warnings.join(' ')).not.toMatch(/Split delivery/);
  });

  it('with split deliveries off it is still one stop (classified before the switch), never "larger than any truck"', async () => {
    wire([tawoosOrder(TAWOOS)], { splitDeliveries: false });
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.stops.map((s) => s.stop_id)).toEqual(['cust-tawoos']);
    expect(b.warnings.join(' ')).toMatch(/One customer fills a truck: CCT0005\/SUWIQ 11\.0 pallets/);
  });

  it('at 95% it fits a 12-bay truck shared: an ordinary stop, no warning', async () => {
    wire([tawoosOrder(TAWOOS)], { palletFillPct: 95 });
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.stops.map((s) => s.stop_id)).toEqual(['cust-tawoos']);
    expect(b.warnings.join(' ')).not.toMatch(/One customer fills a truck/);
  });

  it('x1.2 (13.2 pallets) is split: a full part of 11,995 that rides alone and a leftover of 1,238 the warning names', async () => {
    wire([tawoosOrder(TAWOOS, 1.2)]);
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.stops.map((s) => [s.stop_id, s.demand_pallet_units])).toEqual([
      ['cust-tawoos#1', 11_995],
      ['cust-tawoos#2', 1_238],
    ]);
    expect(b.request.stops.reduce((a, s) => a + s.demand_cases, 0)).toBe(960);
    expect(b.warnings.join(' ')).toMatch(/Split delivery \(bigger than any truck\): CCT0005\/SUWIQ \(960 cases, 13\.2 pallets, 0 kg\) in 2 parts sized for T6, leftover 1\.2 pallets \(177 cases\)\./);
  });

  it('a small-truck-only customer of 5.6 pallets fills its 6-bay truck alone (one stop, small trucks only)', async () => {
    const small = customer('cust-mt', 'MT1', { smallTruckOnly: true });
    // 532 cases at 95 per pallet = 5,600 units: over 6 bays x 90% (5,400), within every bay (6,000).
    const o = {
      id: 'O2', customerId: small.id, customer: small, totalCases: 532, totalWeightKg: 0, priority: 3, priorityFromFile: false, isLate: false,
      salesValue: null, marginValue: null, status: 'NEW',
      lines: [{ id: 'l-tn', productId: 'TN', cases: 532, weightKg: 0, weightFromMaster: false, salesValue: null, marginValue: null, product: { code: 'TN1.5L', name: 'TN', weightPerCaseKg: 0, casesPerPallet: 95, active: true } }],
    };
    wire([o]);
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.stops).toHaveLength(1);
    expect(b.request.stops[0]).toMatchObject({ stop_id: 'cust-mt', demand_pallet_units: 5_600, allowed_truck_ids: ['T1', 'T2', 'T3', 'T4'] });
    expect(b.warnings).toContain('One customer fills a truck: MT1/SUWIQ 5.6 pallets, alone on a 6-bay truck (every bay; trucks with several customers keep 90%).');
  });
});

describe('the config and the rules panel (planner-config.ts)', () => {
  it('sends single_customer_fill_pct 100 and says the rule in plain words', () => {
    const { config } = dispatchConfigFromTenant(CFG as never, 'Oman', ['RECOMMENDED']);
    expect(config.single_customer_fill_pct).toBe(100);
    const row = effectivePlannerValues(CFG as never, 'Oman', 'OMR').find((r) => r.label === 'Truck capacity')!;
    expect(row.value).toMatch(/^bays x 90% for a truck with several customers, every bay \(100%\) for a truck with one customer/);
    // At Pallet fill 100% (the default) the exception adds nothing and is not said (it read "bays x 100% ... every bay (100%)").
    const at100 = effectivePlannerValues({ ...CFG, palletFillPct: 100 } as never, 'Oman', 'OMR').find((r) => r.label === 'Truck capacity')!;
    expect(at100.value).toBe('bays x 100% and payload (trucks without bays: cases and payload); a payload of 0 = no weight limit');
    expect(at100.note).not.toMatch(/one customer|alone/);
  });

  it('the workbook ASSUMPTIONS name the one-customer room only when it is more than the fill', () => {
    const cfg = {
      timezone: 'Asia/Muscat', planningCutoffMin: 1080, shiftStartMin: 360, driverShiftMaxMinutes: 540, reloadMinutes: 30,
      maxTripsPerTruck: 3, fuelPricePerLitre: 0, driverCostPerHour: 0, overtimeAfterMin: 540, overtimeCostPerHour: 0,
      prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, distanceProvider: 'OSRM', distanceMultiplier: 1.3, avgSpeedKmh: 40,
      defaultServiceTimeMin: 10, osrmUrl: null, priorityWeightsJson: null,
    };
    const capacity = (fillPct: number) =>
      tenantAssumptions(cfg, { currency: 'OMR', providerUsed: 'OSRM', distanceIsEstimated: false, solverRules: { weightsToTenthKg: true, newOvertimeOnly: true, pallets: { fillPct, singleCustomerFillPct: 100 } } })['Truck capacity'];
    expect(capacity(90)).toMatch(/^trucks with bays: pallets up to bays x 90% \(Pallet fill\), or bays x 100% for a truck that carries only one customer, and the payload/);
    expect(capacity(100)).toMatch(/^trucks with bays: pallets up to bays x 100% \(Pallet fill\) and the payload/);
  });
});

// ------------------------------------------------------------------------------------------------
// The dispatch check (feasibility.ts via feasibilityInputFromRows)
// ------------------------------------------------------------------------------------------------

const RULES: PlanRules = {
  shiftStartMin: 360, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0, maxTrips: 3,
  depotOpenMin: 300, depotCloseMin: 1380, availableFromMin: null, availableToMin: null,
};
const VERIFIED: FeasibilityReport = { status: 'VERIFIED', timing: 'EXACT', violations: [] };
const snap = (single: number | null) => ({
  v: 1, code: 'R1-5187', capacityCases: 1140, capacityWeightKg: 0, fixedCostPerDay: 0, tripCost: 0, costPerKm: 0, kmPerLitre: null,
  availableFromMin: null, availableToMin: null, maxTripsPerDay: null, bays: 12, palletFillPct: 90, palletRoomUnits: 10_800,
  ...(single !== null ? { singleCustomerFillPct: single } : {}),
  rules: RULES, source: 'PLAN', capturedAt: '2026-10-14T03:00:00Z',
});
function assignment(orderId: string, customerId: string, units: number, seq = 1): FeasibilityRow['assignments'][number] {
  return {
    orderId, sequenceInTruck: seq, portionCases: null, portionWeightKg: null, portionLinesJson: null, palletUnits: units,
    etaMin: 420 + seq * 30, serviceStartMin: 420 + seq * 30, departureMin: 440 + seq * 30, hardWindowOk: true, stopSnapshotJson: null,
    order: { totalCases: 400, totalWeightKg: 0, customerId, customer: { code: customerId, branchCode: null, name: customerId }, lines: [{ id: `${orderId}-l`, cases: 400, weightKg: 0, product: { weightPerCaseKg: 0 } }] },
  };
}
function loadRow(assignments: FeasibilityRow['assignments'], single: number | null = 100, bays = 12): FeasibilityRow {
  return {
    id: 'L1', truckId: 't1', loadNo: 1, status: 'PLANNED', departMin: 400, returnMin: 560, cases: 800, weightKg: 0, carriedFromLoadId: null,
    truckSnapshotJson: snap(single), truck: { code: 'R1-5187', capacityCases: 1140, capacityWeightKg: 0, bays },
    assignments,
  };
}
const codes = (f: ReturnType<typeof checkPlanFeasibility>) => f.violations.map((v) => v.code);

describe('the dispatch check measures each load by its customers', () => {
  it('Tawoos alone at 11.03 on 12 bays passes (room 12.0, one customer); no false CAPACITY_CHANGED', () => {
    const inp = feasibilityInputFromRows([loadRow([assignment('o1', 'tawoos', 11_027)])], 'sc1', undefined, null, { palletFillPctNow: 90 });
    expect(inp.loads[0].capacity).toEqual({ cases: 1140, kg: 0, palletRoomUnits: 12_000, bays: 12, fillPct: 100, oneCustomer: true });
    expect(inp.loads[0].capacityNow).toMatchObject({ bays: 12, fillPct: 100, palletRoomUnits: 12_000, oneCustomer: true });
    expect(codes(checkPlanFeasibility(inp))).toEqual([]);
    // Two rows (two orders) of the same customer are one customer too.
    const two = feasibilityInputFromRows([loadRow([assignment('o1', 'tawoos', 9_000), assignment('o2', 'tawoos', 2_027, 1)])], 'sc1', undefined, null, { palletFillPctNow: 90 });
    expect(codes(checkPlanFeasibility(two))).toEqual([]);
    // The Pallet fill changed since (90 -> 95): a one-customer load still has every bay: no warning.
    const later = feasibilityInputFromRows([loadRow([assignment('o1', 'tawoos', 11_027)])], 'sc1', undefined, null, { palletFillPctNow: 95 });
    expect(codes(checkPlanFeasibility(later))).toEqual([]);
  });

  it('a load of two customers at 11.03 is over its room (10.8 at 90%): CAPACITY_PALLETS', () => {
    const inp = feasibilityInputFromRows([loadRow([assignment('o1', 'tawoos', 9_000), assignment('o2', 'other', 2_027, 2)])], 'sc1', undefined, null, { palletFillPctNow: 90 });
    expect(inp.loads[0].capacity).toEqual({ cases: 1140, kg: 0, palletRoomUnits: 10_800, bays: 12, fillPct: 90 });
    const f = checkPlanFeasibility(inp);
    expect(codes(f)).toEqual(['CAPACITY_PALLETS']);
    expect(f.violations[0].message).toBe('R1-5187 load 1 needs 11.0 pallets; the truck takes 10.8 (12 bays at 90% fill).');
  });

  it('one customer over every bay names the one-customer room', () => {
    const f = checkPlanFeasibility(feasibilityInputFromRows([loadRow([assignment('o1', 'tawoos', 12_100)])], 'sc1', undefined, null));
    expect(codes(f)).toEqual(['CAPACITY_PALLETS']);
    expect(f.violations[0].message).toBe('R1-5187 load 1 needs 12.1 pallets; the truck takes 12.0 (12 bays at 100% fill, one customer).');
  });

  it('a load planned before the rule (no echo in its snapshot) keeps the room it was planned with, and its check hash', () => {
    const rows = [loadRow([assignment('o1', 'tawoos', 11_027)], null)];
    const inp = feasibilityInputFromRows(rows, 'sc1', undefined, null, { palletFillPctNow: 90 });
    // Exactly the fields an older web gave (no oneCustomer key anywhere): the hash reads only these.
    expect(inp.loads[0].capacity).toEqual({ cases: 1140, kg: 0, palletRoomUnits: 10_800, bays: 12, fillPct: 90 });
    expect(inp.loads[0].capacityNow).toEqual({ cases: 1140, kg: 0, bays: 12, fillPct: 90, palletRoomUnits: 10_800 });
    expect(codes(checkPlanFeasibility(inp))).toEqual(['CAPACITY_PALLETS']);
    // Its hash does not depend on whether rows carry the customer id (older rows read none).
    const noIds = rows.map((r) => ({ ...r, assignments: r.assignments.map((a) => ({ ...a, order: { ...a.order, customerId: undefined } })) }));
    expect(inputHash(feasibilityInputFromRows(noIds, 'sc1', undefined, null, { palletFillPctNow: 90 }))).toBe(inputHash(inp));
    // A one-customer load under the rule hashes differently from the same load before it (its room differs).
    expect(inputHash(feasibilityInputFromRows([loadRow([assignment('o1', 'tawoos', 11_027)])], 'sc1', undefined, null, { palletFillPctNow: 90 }))).not.toBe(inputHash(inp));
    expect(VERIFIED.status).toBe('VERIFIED');
  });
});

describe('the snapshot keeps the rule only from the echo (snapshots.ts)', () => {
  const facts: TruckFacts = {
    code: 'R1', capacityCases: 1140, capacityWeightKg: 0, fixedCostPerDay: 0, tripCost: 0, costPerKm: 0, kmPerLitre: null,
    availableFromMin: null, availableToMin: null, maxTripsPerDay: null, bays: 12, palletFillPct: 90, palletRoomUnits: 10_800,
  };

  it('singleCustomerFillPct as echoed, never as asked; nothing without the pallet echo', () => {
    expect(plannedTruckFacts(facts, true, 100)).toEqual({ ...facts, singleCustomerFillPct: 100 });
    expect(plannedTruckFacts(facts, true, null)).toEqual(facts);
    expect(plannedTruckFacts(facts, true)).toEqual(facts);
    expect(plannedTruckFacts({ ...facts, singleCustomerFillPct: 100 }, true, undefined)).toEqual(facts);
    const { bays: _b, palletFillPct: _f, palletRoomUnits: _r, ...cases } = facts;
    expect(plannedTruckFacts(facts, false, 100)).toEqual(cases);
  });
});
