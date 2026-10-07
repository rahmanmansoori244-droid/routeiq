/**
 * Truck capacity in pallets (owner decision 4 Oct 2026), the pure web side of part A:
 * - lib/dispatch/pallets.ts: units of 1/1000 pallet rounded up per line, the room of a bay truck
 *   (bays x Pallet fill), the text, full pallets + loose cases, the PALLET_FACTOR_REQUIRED words;
 * - split deliveries by pallets (split.ts: a customer bigger than one truck in its own measure);
 * - the dispatch gate (feasibility.ts): CAPACITY_PALLETS instead of CAPACITY_CASES on a load planned
 *   by pallets, never on a load planned without them, CAPACITY_CHANGED when bays or fill change;
 * - the snapshots keep bays / fill / room only when the optimizer echoed the rule;
 * - a cases per pallet corrected after planning: the rows with the figures known now, and the gate's
 *   CAPACITY_PALLETS_NEW_FACTOR (blocks a PLANNED load it puts over its bays, warns on a locked one);
 * - the start gate refuses without an override (pallets.ts palletFactorGate, called by start-optimize).
 */
import { describe, expect, it } from 'vitest';
import type { FeasibilityReport } from '@routeiq/shared-types';
import {
  describeMissingPalletFactors,
  fullAndLoose,
  fullAndLooseText,
  groupMissingPalletFactors,
  palletFactorGate,
  palletFactorRefusal,
  palletRoomUnits,
  palletText,
  palletUnits,
  validBays,
  validPalletFactor,
} from '@/lib/dispatch/pallets';
import { choosePartCapacity, fitsCapacity, linesPalletUnits, portionsOfPart, rowPalletUnitsNow, splitIntoParts, type FleetTruck, type OpenLine } from '@/lib/dispatch/split';
import { checkPlanFeasibility, inputHash, type FeasLoad, type FeasStop } from '@/lib/dispatch/feasibility';
import { feasibilityInputFromRows, type FeasibilityRow } from '@/lib/dispatch/plan-service';
import { plannedTruckFacts, rulesFrom, type PlanRules, type TruckFacts } from '@/lib/dispatch/snapshots';
import { masterDataProblems } from '@/lib/dispatch/planner-config';

describe('pallet units (pallets.ts)', () => {
  it('rounds each line up to 1/1000 pallet, in integers: 84 at 84 = 1.0 pallet exactly', () => {
    expect(palletUnits(84, 84)).toBe(1000);
    expect(palletUnits(100, 96)).toBe(1042); // 1,041.67 up
    expect(palletUnits(50, 39)).toBe(1283);
    expect(palletUnits(30, 160)).toBe(188);
    // The spec's worked example: a stop of three products = 2,513 units = 2.5 pallets.
    expect(palletUnits(100, 96) + palletUnits(50, 39) + palletUnits(30, 160)).toBe(2513);
    expect(palletText(2513)).toBe('2.5');
    expect(palletUnits(0, 84)).toBe(0);
    expect(palletUnits(1, 10_000)).toBe(1); // never 0 for a case
  });

  it('a factor is a whole number 1-10,000; anything else is missing (and counts 0 units)', () => {
    expect(validPalletFactor(84)).toBe(84);
    for (const bad of [null, undefined, 0, -5, 84.5, 10_001, Number.NaN]) expect(validPalletFactor(bad as number), String(bad)).toBeNull();
    expect(palletUnits(84, null)).toBe(0);
    expect(palletUnits(84, 84.5)).toBe(0);
    expect(validBays(12)).toBe(12);
    expect(validBays(0)).toBeNull();
    expect(validBays(41)).toBeNull();
  });

  it('room = bays x fill x 10: 12 bays at 95% = 11.4 pallets, 2 bays = 1.9', () => {
    expect(palletRoomUnits(12, 95)).toBe(11_400);
    expect(palletRoomUnits(2, 95)).toBe(1_900);
    expect(palletRoomUnits(12, 100)).toBe(12_000);
    expect(palletText(11_400)).toBe('11.4');
    expect(palletText(160_250)).toBe('160.3');
    expect(palletText(1_234_550)).toBe('1,234.6');
  });

  it('full pallets and loose cases on a manifest: "3 pallets + 12 cases"', () => {
    expect(fullAndLoose(300, 96)).toEqual({ full: 3, loose: 12 });
    expect(fullAndLooseText(300, 96)).toBe('3 pallets + 12 cases');
    expect(fullAndLooseText(40, 96)).toBe('40 cases');
    expect(fullAndLooseText(96, 96)).toBe('1 pallet');
    expect(fullAndLooseText(1, null)).toBe('1 case');
  });

  it('products without a factor are grouped per product, biggest first, and named in the refusal', () => {
    const list = groupMissingPalletFactors([
      { productId: 'p2', productCode: 'SS6L', productName: 'Shower 6L', cases: 40 },
      { productId: 'p1', productCode: 'TN1.5L', productName: 'Tanuf 1.5L', cases: 70 },
      { productId: 'p1', productCode: 'TN1.5L', productName: 'Tanuf 1.5L', cases: 50 },
      { productId: 'p3', productCode: 'EFF24-GV', productName: 'EFF 24', cases: 12 },
    ]);
    expect(list).toEqual([
      { productId: 'p1', productCode: 'TN1.5L', productName: 'Tanuf 1.5L', lines: 2, cases: 120 },
      { productId: 'p2', productCode: 'SS6L', productName: 'Shower 6L', lines: 1, cases: 40 },
      { productId: 'p3', productCode: 'EFF24-GV', productName: 'EFF 24', lines: 1, cases: 12 },
    ]);
    expect(describeMissingPalletFactors(list, 2)).toBe('TN1.5L (120 cases), SS6L (40 cases) and 1 more');
    expect(palletFactorRefusal(list)).toBe(
      "Cannot plan by pallets: 3 product(s) on this day's orders have no cases per pallet: TN1.5L (120 cases), SS6L (40 cases), EFF24-GV (12 cases). Enter the cases per pallet under Products (company admins can edit products), then optimize again.",
    );
  });
});

describe('the start gate: PALLET_FACTOR_REQUIRED, no override', () => {
  it('refuses with the list and the code; nothing when every factor is there or the day has no bay truck', () => {
    const missing = [{ productId: 'p1', productCode: 'TN1.5L', productName: 'Tanuf 1.5L', lines: 2, cases: 120 }];
    const r = palletFactorGate({ missingPalletFactors: missing }, 'optimize');
    expect(r?.status).toBe(409);
    expect(r?.body).toMatchObject({ code: 'PALLET_FACTOR_REQUIRED', missingPalletFactors: missing });
    expect(String(r?.body.error)).toMatch(/then optimize again\.$/);
    expect(String(palletFactorGate({ missingPalletFactors: missing }, 're-plan')?.body.error)).toMatch(/then re-plan again\.$/);
    expect(palletFactorGate({ missingPalletFactors: [] })).toBeNull();
    expect(palletFactorGate({})).toBeNull();
  });

  it('a truck with bays outside 1-40 (a database edit) is named before the optimizer', () => {
    const t = { code: 'R5', capacityCases: 1140, capacityWeightKg: 10000, fixedCostPerDay: 0, tripCost: 0, costPerKm: 0, kmPerLitre: null, availableFromMin: null, availableToMin: null, maxTripsPerDay: null };
    expect(masterDataProblems([{ ...t, bays: 0 }], { openMin: null, closeMin: null })).toEqual(['Truck R5: bays 0 (1-40, or empty)']);
    expect(masterDataProblems([{ ...t, bays: 12 }, { ...t, code: 'R6', bays: null }], { openMin: null, closeMin: null })).toEqual([]);
  });
});

describe('split deliveries by pallets (split.ts)', () => {
  const line = (id: string, cases: number, cpp: number | null, kgPerCase = 0): OpenLine => ({ lineId: id, orderId: 'O1', cases, kgPerCase, casesPerPallet: cpp });

  it('fits by pallets on a bay truck, by cases otherwise; kg as before', () => {
    expect(fitsCapacity(1400, 0, { cases: 1140, kg: null, palletUnits: 11_400 }, 10_000)).toBe(true); // cases are no limit
    expect(fitsCapacity(100, 0, { cases: 1140, kg: null, palletUnits: 11_400 }, 11_401)).toBe(false);
    expect(fitsCapacity(1400, 0, { cases: 1140, kg: null })).toBe(false);
    expect(fitsCapacity(100, 10_000.1, { cases: 1140, kg: 10_000, palletUnits: 11_400 }, 1000)).toBe(false);
  });

  it('cuts parts at the pallet room, never over it, each line rounded up on its own', () => {
    // 2,000 cases of an 84-per-pallet product = 23.81 pallets on 12 bays at 95% (11.4 pallets).
    const parts = splitIntoParts([line('L1', 2000, 84)], { cases: 1140, kg: null, palletUnits: 11_400 });
    expect(parts.map((p) => p.reduce((a, x) => a + x.cases, 0))).toEqual([957, 957, 86]);
    const cpp = new Map([['L1', 84]]);
    for (const p of parts) expect(linesPalletUnits(p, cpp)).toBeLessThanOrEqual(11_400);
    expect(parts.flat().reduce((a, x) => a + x.cases, 0)).toBe(2000);
  });

  it('mixed products share a part (mixed pallets) and the kg still closes a part', () => {
    const lines = [line('A', 600, 96, 10), line('B', 600, 39, 10)];
    const parts = splitIntoParts(lines, { cases: 1140, kg: 10_000, palletUnits: 11_400 });
    const cpp = new Map<string, number>([['A', 96], ['B', 39]]);
    for (const p of parts) {
      expect(linesPalletUnits(p, cpp)).toBeLessThanOrEqual(11_400);
      expect(p.reduce((a, x) => a + x.weightKg, 0)).toBeLessThanOrEqual(10_000);
    }
    expect(parts.flat().reduce((a, x) => a + x.cases, 0)).toBe(1200);
    // First fit decreasing by pallet units (7 Oct 2026): B (15,385 units) first, cut at the room (444
    // cases, 11,385 units) and its other 156 cases (4,000 units); then all 600 cases of A (6,250 units)
    // whole into part 2 with them (10,250 units, 7,560 kg). Still two parts, one line cut.
    expect(parts.map((p) => p.map((x) => [x.lineId, x.cases]))).toEqual([[['B', 444]], [['B', 156], ['A', 600]]]);
    expect(linesPalletUnits(parts[0], cpp)).toBe(11_385);
    expect(linesPalletUnits(parts[1], cpp)).toBe(10_250);
  });

  it('the part keeps the factor each line was cut with', () => {
    const parts = splitIntoParts([line('L1', 200, 84, 12)], { cases: 1140, kg: null, palletUnits: 1_900 });
    const recs = portionsOfPart(parts[0], 1, parts.length, new Map([['L1', 12]]), new Map([['L1', 84]]));
    expect(recs[0].lines[0]).toEqual({ lineId: 'L1', cases: 159, kgPerCase: 12, casesPerPallet: 84 });
  });

  it('sizes parts in each truck size own measure; a case truck never carries a pallet size (mixed fleet)', () => {
    const fleet: FleetTruck[] = [
      { code: 'B12', cases: 1140, kg: 10_000, tripsLeft: 3, palletUnits: 11_400 },
      { code: 'C570', cases: 570, kg: 3_000, tripsLeft: 3 },
    ];
    // 1,020 cases, 16.3 pallets, 9,000 kg: two parts sized for the bay truck.
    const best = choosePartCapacity(1020, 9_000, fleet, 0, 16_300);
    expect(best).toEqual({ cap: { cases: 1140, kg: 10_000, palletUnits: 11_400 }, truckCode: 'B12' });
    // Without bays anywhere: exactly as before (cases).
    const cases = choosePartCapacity(1500, 0, [{ code: 'C1', cases: 1000, kg: null, tripsLeft: 3 }]);
    expect(cases).toEqual({ cap: { cases: 1000, kg: null }, truckCode: 'C1' });
  });
});

const RULES: PlanRules = {
  shiftStartMin: 360, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0, maxTrips: 3,
  depotOpenMin: 300, depotCloseMin: 1380, availableFromMin: null, availableToMin: null,
};
const VERIFIED: FeasibilityReport = { status: 'VERIFIED', timing: 'EXACT', violations: [] };

function pstop(orderId: string, cases: number, palletUnits?: number | null): FeasStop {
  return {
    orderId, sequence: 1, label: 'Lulu', cases, kg: cases * 5, kgUnknown: false,
    etaMin: 420, serviceStartMin: 420, departureMin: 440, hardWindowOk: true, hardStartMin: 360, hardEndMin: 840,
    ...(palletUnits === undefined ? {} : { palletUnits }),
  };
}
function pload(over: Partial<FeasLoad> = {}): FeasLoad {
  return {
    id: 'L1', truckId: 't1', truckCode: 'R5', loadNo: 2, onRoad: false, departMin: 400, returnMin: 500, cases: 1339, weightKg: 6695,
    capacity: { cases: 1140, kg: 10_000, palletRoomUnits: 11_400, bays: 12, fillPct: 95 }, rules: RULES,
    stops: [pstop('o1', 1000, 8_000), pstop('o2', 339, 3_000)],
    ...over,
  };
}
const codes = (f: ReturnType<typeof checkPlanFeasibility>) => f.violations.map((v) => v.code);

describe('the dispatch gate by pallets (feasibility.ts)', () => {
  it('a load planned by pallets is checked by its bays, never by its case capacity', () => {
    // 1,339 cases > 1,140, but 11.0 pallets <= 11.4: fine.
    expect(codes(checkPlanFeasibility({ scenarioId: 's', solver: VERIFIED, loads: [pload()] }))).toEqual([]);
    const over = pload({ stops: [pstop('o1', 1000, 8_000), pstop('o2', 339, 3_600)] });
    const f = checkPlanFeasibility({ scenarioId: 's', solver: VERIFIED, loads: [over] });
    expect(codes(f)).toEqual(['CAPACITY_PALLETS']);
    expect(f.violations[0]).toMatchObject({ severity: 'BLOCK', message: 'R5 load 2 needs 11.6 pallets; the truck takes 11.4 (12 bays at 95% fill).', shortBy: 0.2 });
    expect(f.ok).toBe(false);
  });

  it('a load whose rows have no units (planned by cases, or before pallets) is never blocked for pallets after the fact', () => {
    const legacy = pload({ stops: [pstop('o1', 1000), pstop('o2', 339)] });
    expect(codes(checkPlanFeasibility({ scenarioId: 's', solver: VERIFIED, loads: [legacy] }))).toEqual([]);
    // Planned by cases (no room kept): the case rule as before.
    const cases = pload({ capacity: { cases: 1140, kg: 10_000 }, stops: [pstop('o1', 1000), pstop('o2', 339)] });
    expect(codes(checkPlanFeasibility({ scenarioId: 's', solver: VERIFIED, loads: [cases] }))).toEqual(['CAPACITY_CASES']);
  });

  it('bays or Pallet fill changed since planning so the load no longer fits: CAPACITY_CHANGED (a warning)', () => {
    const fewer = pload({ capacityNow: { cases: 1140, kg: 10_000, bays: 10, fillPct: 95, palletRoomUnits: 9_500 } });
    const f = checkPlanFeasibility({ scenarioId: 's', solver: VERIFIED, loads: [fewer] });
    expect(codes(f)).toEqual(['CAPACITY_CHANGED']);
    expect(f.violations[0]).toMatchObject({ severity: 'WARN' });
    expect(f.violations[0].message).toBe(
      'R5 load 2 needs 11.0 pallets, but the truck was changed to 10 bays (9.5 pallets at 95% fill) after planning. Re-plan to use the new capacity.',
    );
    expect(f.ok).toBe(true);
    // The same room: nothing to say.
    const same = pload({ capacityNow: { cases: 999, kg: 10_000, bays: 12, fillPct: 95, palletRoomUnits: 11_400 } });
    expect(codes(checkPlanFeasibility({ scenarioId: 's', solver: VERIFIED, loads: [same] }))).toEqual([]);
    // The truck lost its bays: its case capacity now.
    const none = pload({ capacityNow: { cases: 1140, kg: 10_000, bays: null, fillPct: 95, palletRoomUnits: null } });
    expect(checkPlanFeasibility({ scenarioId: 's', solver: VERIFIED, loads: [none] }).violations[0].message).toMatch(/changed to 1140 cases \(no bays\)/);
  });

  it('the stored check hash changes with the units and the room, and not for plans without pallets', () => {
    const a = inputHash({ scenarioId: 's', solver: VERIFIED, loads: [pload()] });
    const b = inputHash({ scenarioId: 's', solver: VERIFIED, loads: [pload({ stops: [pstop('o1', 1000, 8_001), pstop('o2', 339, 3_000)] })] });
    expect(a).not.toBe(b);
    const plain = pload({ capacity: { cases: 1140, kg: 10_000 }, stops: [pstop('o1', 1000), pstop('o2', 339)] });
    const plainWithEmptyRoom = { ...plain, capacity: { cases: 1140, kg: 10_000, palletRoomUnits: null } };
    expect(inputHash({ scenarioId: 's', solver: VERIFIED, loads: [plain] })).toBe(inputHash({ scenarioId: 's', solver: VERIFIED, loads: [plainWithEmptyRoom] }));
  });

  it('feasibilityInputFromRows reads the room from the snapshot and the units from the rows', () => {
    const snap = {
      v: 1, code: 'R5', capacityCases: 1140, capacityWeightKg: 10_000, fixedCostPerDay: 0, tripCost: 0, costPerKm: 0, kmPerLitre: null,
      availableFromMin: null, availableToMin: null, maxTripsPerDay: null, bays: 12, palletFillPct: 95, palletRoomUnits: 11_400,
      rules: RULES, source: 'PLAN', capturedAt: '2026-10-04T12:00:00Z',
    };
    const order = { totalCases: 900, totalWeightKg: 4500, customer: { code: 'C1', branchCode: null, name: 'x' }, lines: [{ id: 'ln1', cases: 900, weightKg: 4500, product: { weightPerCaseKg: 5 } }] };
    const row: FeasibilityRow = {
      id: 'L1', truckId: 't1', loadNo: 1, status: 'PLANNED', departMin: 400, returnMin: 500, cases: 900, weightKg: 4500, carriedFromLoadId: null,
      truckSnapshotJson: snap, truck: { code: 'R5', capacityCases: 1140, capacityWeightKg: 10_000, bays: 10 },
      assignments: [{ orderId: 'o1', sequenceInTruck: 1, portionCases: null, portionWeightKg: null, portionLinesJson: null, palletUnits: 10_715, etaMin: 420, serviceStartMin: 420, departureMin: 440, hardWindowOk: true, stopSnapshotJson: null, order }],
    };
    const inp = feasibilityInputFromRows([row], 'sc1', undefined, null, { palletFillPctNow: 95 });
    expect(inp.loads[0].capacity).toEqual({ cases: 1140, kg: 10_000, palletRoomUnits: 11_400, bays: 12, fillPct: 95 });
    expect(inp.loads[0].capacityNow).toEqual({ cases: 1140, kg: 10_000, bays: 10, fillPct: 95, palletRoomUnits: 9_500 });
    expect(inp.loads[0].stops[0].palletUnits).toBe(10_715);
    expect(codes(checkPlanFeasibility(inp))).toEqual(['CAPACITY_CHANGED']);
  });
});

describe('a cases per pallet corrected after planning (pallets review)', () => {
  // The pilot's case: JA0.5L imported at 96 per pallet, 1,090 cases planned on a 12-bay truck =
  // 11.355 pallets (within 11.4); the owner says 84, corrected under Products: 12.977 pallets, more
  // than its 12 bays. Before, nothing but a grey manifest line said so: LOCK went through.
  const line = (casesPerPallet: number | null) => ({ id: 'ln1', cases: 1090, weightKg: 10_791, product: { weightPerCaseKg: 9.9, code: 'JA0.5L', casesPerPallet } });

  it('rowPalletUnitsNow: a row with the figures known now, only when they give other pallets than it was planned with', () => {
    expect([palletUnits(1090, 96), palletUnits(1090, 84)]).toEqual([11_355, 12_977]);
    expect(rowPalletUnitsNow([line(84)], null, 11_355, { 'JA0.5L': 96 })).toEqual({ units: 12_977, products: ['JA0.5L'], cases: 1090 });
    expect(rowPalletUnitsNow([line(96)], null, 11_355, { 'JA0.5L': 96 })).toBeNull();
    // Removed since: the pallets cannot be worked out (the day's red list names the product).
    expect(rowPalletUnitsNow([line(null)], null, 11_355, { 'JA0.5L': 96 })).toBeNull();
    // Planned by cases (no units on the row): nothing to compare.
    expect(rowPalletUnitsNow([line(84)], null, null, { 'JA0.5L': 96 })).toBeNull();
    // A split part: its own lines and the factor it was cut with (500 cases: 5.209 -> 5.953 pallets).
    expect(rowPalletUnitsNow([line(84)], [{ lineId: 'ln1', cases: 500, kgPerCase: 9.9, casesPerPallet: 96 }], 5_209, {})).toEqual({ units: 5_953, products: ['JA0.5L'], cases: 500 });
    // A load kept from an earlier version whose figures the option does not know: still found, products not named.
    expect(rowPalletUnitsNow([line(84)], null, 11_355, { 'JA0.5L': 84 })).toEqual({ units: 12_977, products: [], cases: 1090 });
  });

  const changed = (units: number, unitsNow: number) => ({ ...pstop('o1', 1090, units), palletUnitsNow: unitsNow, palletFactorChanged: ['JA0.5L'] });

  it('the gate: a PLANNED load the corrected figure puts over its bays is blocked (CAPACITY_PALLETS_NEW_FACTOR)', () => {
    const f = checkPlanFeasibility({ scenarioId: 's', solver: VERIFIED, loads: [pload({ cases: 1090, stops: [changed(11_355, 12_977)] })] });
    expect(codes(f)).toEqual(['CAPACITY_PALLETS_NEW_FACTOR']);
    expect(f.violations[0]).toMatchObject({
      severity: 'BLOCK',
      shortBy: 1.6,
      message:
        'R5 load 2 was planned with 11.4 pallets; with the cases per pallet corrected under Products since (JA0.5L) it needs 13.0 pallets, more than the truck takes: 11.4 (12 bays at 95% fill). Re-plan to load it by the cases per pallet now.',
    });
    expect(f.ok).toBe(false);
    // Still within the bays: nothing.
    expect(codes(checkPlanFeasibility({ scenarioId: 's', solver: VERIFIED, loads: [pload({ stops: [changed(11_355, 11_400)] })] }))).toEqual([]);
    // A LOCKED load (a re-plan keeps it): shown, never blocking; it says to unlock it first.
    const locked = checkPlanFeasibility({ scenarioId: 's', solver: VERIFIED, loads: [pload({ frozen: true, stops: [changed(11_355, 12_977)] })] });
    expect(locked.violations[0]).toMatchObject({ code: 'CAPACITY_PALLETS_NEW_FACTOR', severity: 'WARN', frozen: true });
    expect(locked.violations[0].message).toMatch(/Put R5 L2 back to Planned first and re-plan to use the cases per pallet now\.$/);
    expect(locked.ok).toBe(true);
    // The stored check's hash changes with it; a load without a change keeps its hash.
    const plain = pload();
    expect(inputHash({ scenarioId: 's', solver: VERIFIED, loads: [plain] })).toBe(inputHash({ scenarioId: 's', solver: VERIFIED, loads: [pload()] }));
    expect(inputHash({ scenarioId: 's', solver: VERIFIED, loads: [pload({ stops: [changed(11_355, 12_977)] })] })).not.toBe(
      inputHash({ scenarioId: 's', solver: VERIFIED, loads: [pload({ stops: [pstop('o1', 1090, 11_355)] })] }),
    );
  });

  it('feasibilityInputFromRows: the rows of a load planned by pallets get the figures known now (the option kept the planned ones)', () => {
    const snap = {
      v: 1, code: 'R5', capacityCases: 1140, capacityWeightKg: 12_000, fixedCostPerDay: 0, tripCost: 0, costPerKm: 0, kmPerLitre: null,
      availableFromMin: null, availableToMin: null, maxTripsPerDay: null, bays: 12, palletFillPct: 95, palletRoomUnits: 11_400,
      rules: RULES, source: 'PLAN', capturedAt: '2026-10-04T12:00:00Z',
    };
    const order = { totalCases: 1090, totalWeightKg: 10_791, customer: { code: 'C1', branchCode: null, name: 'x' }, lines: [line(84)] };
    const row: FeasibilityRow = {
      id: 'L1', truckId: 't1', loadNo: 1, status: 'PLANNED', departMin: 400, returnMin: 500, cases: 1090, weightKg: 10_791, carriedFromLoadId: null,
      truckSnapshotJson: snap, truck: { code: 'R5', capacityCases: 1140, capacityWeightKg: 12_000, bays: 12 },
      assignments: [{ orderId: 'o1', sequenceInTruck: 1, portionCases: null, portionWeightKg: null, portionLinesJson: null, palletUnits: 11_355, etaMin: 420, serviceStartMin: 420, departureMin: 440, hardWindowOk: true, stopSnapshotJson: null, order }],
    };
    const details = { inputs: { v: 1, depot: { id: 'D1', lat: 23.6, lng: 58.4 }, config: {}, stops: {}, trucks: {}, palletFactors: { 'JA0.5L': 96 } } } as unknown as Parameters<typeof feasibilityInputFromRows>[2];
    const inp = feasibilityInputFromRows([row], 'sc1', details, null, { palletFillPctNow: 95 });
    expect(inp.loads[0].stops[0]).toMatchObject({ palletUnits: 11_355, palletUnitsNow: 12_977, palletFactorChanged: ['JA0.5L'] });
    expect(codes(checkPlanFeasibility(inp))).toEqual(['CAPACITY_PALLETS_NEW_FACTOR']);
    // A load planned by cases (no room kept) is never judged by pallets.
    const byCases = { ...row, truckSnapshotJson: { ...snap, bays: undefined, palletFillPct: undefined, palletRoomUnits: undefined } };
    expect(feasibilityInputFromRows([byCases], 'sc1', details, null).loads[0].stops[0]).not.toHaveProperty('palletUnitsNow');
  });
});

describe('snapshots keep the pallet facts only from the echo (snapshots.ts)', () => {
  const facts: TruckFacts = {
    code: 'R5', capacityCases: 1140, capacityWeightKg: 10_000, fixedCostPerDay: 0, tripCost: 0, costPerKm: 0, kmPerLitre: null,
    availableFromMin: null, availableToMin: null, maxTripsPerDay: null, bays: 12, palletFillPct: 95, palletRoomUnits: 11_400,
  };

  it('bays, fill and room stay only when the optimizer echoed the pallet rule', () => {
    expect(plannedTruckFacts(facts, true)).toEqual(facts);
    const { bays: _b, palletFillPct: _f, palletRoomUnits: _r, ...cases } = facts;
    expect(plannedTruckFacts(facts, false)).toEqual(cases);
    expect(plannedTruckFacts(cases, true)).toEqual(cases);
  });

  it('PlanRules.pallets only from the echo, so older loads keep their rules exactly', () => {
    const config = { shift_start_min: 360, shift_max_min: 660, reload_min: 30, loading_min_per_case: 0, max_trips_per_truck: 3, pallet_fill_pct: 95 };
    expect(rulesFrom(config, { openMin: 0, closeMin: 1440 }, {}, { pallet_unit: 0.001, pallet_fill_pct: 95 }).pallets).toEqual({ fillPct: 95, unit: 0.001 });
    expect(rulesFrom(config, { openMin: 0, closeMin: 1440 }, {}, {})).not.toHaveProperty('pallets');
    expect(rulesFrom(config, { openMin: 0, closeMin: 1440 }, {}, null)).not.toHaveProperty('pallets');
  });
});
