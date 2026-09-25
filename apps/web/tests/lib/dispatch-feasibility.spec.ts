/**
 * Review F04 (web part B): the pure timetable check per truck-day (lib/dispatch/feasibility.ts),
 * and the facts it reads from the plan rows (feasibilityInputFromRows: snapshots first, never
 * today's master data).
 */
import { describe, expect, it } from 'vitest';
import type { FeasibilityReport } from '@routeiq/shared-types';
import {
  checkPlanFeasibility,
  feasibilityGateMode,
  inputHash,
  readFeasibility,
  REPLAN_REMEDY,
  timingRemedy,
  truckDayOk,
  truckViolations,
  type FeasLoad,
  type FeasibilityInput,
  type FeasStop,
} from '@/lib/dispatch/feasibility';
import { feasibilityInputFromRows, isGatedMove, rowUnknownKg, type FeasibilityRow, type ScenarioDetails } from '@/lib/dispatch/plan-service';
import { rulesFrom, type PlanRules } from '@/lib/dispatch/snapshots';
import { partDemandKg, portionsOfPart, splitIntoParts } from '@/lib/dispatch/split';

const RULES: PlanRules = {
  shiftStartMin: 360, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0.5, maxTrips: 3,
  depotOpenMin: 300, depotCloseMin: 1380, availableFromMin: null, availableToMin: null,
};

function stop(over: Partial<FeasStop> = {}): FeasStop {
  return {
    orderId: 'o1', sequence: 1, label: 'Lulu Bausher', cases: 40, kg: 400, kgUnknown: false,
    etaMin: 420, serviceStartMin: 420, departureMin: 440, hardWindowOk: true, hardStartMin: 360, hardEndMin: 840, ...over,
  };
}

function load(id: string, loadNo: number, over: Partial<FeasLoad> = {}): FeasLoad {
  return {
    id, truckId: 't1', truckCode: 'T01', loadNo, onRoad: false,
    departMin: 400 + (loadNo - 1) * 200, returnMin: 500 + (loadNo - 1) * 200, cases: 40, weightKg: 400,
    capacity: { cases: 100, kg: 1000 }, rules: RULES,
    stops: [stop({ orderId: `o${id}`, etaMin: 420 + (loadNo - 1) * 200, serviceStartMin: 420 + (loadNo - 1) * 200, departureMin: 440 + (loadNo - 1) * 200 })],
    ...over,
  };
}

const VERIFIED: FeasibilityReport = { status: 'VERIFIED', timing: 'EXACT', violations: [] };

function input(loads: FeasLoad[], solver: FeasibilityReport | null = VERIFIED): FeasibilityInput {
  return { scenarioId: 'sc1', solver, loads };
}

const codes = (f: ReturnType<typeof checkPlanFeasibility>) => f.violations.map((v) => v.code);

describe('checkPlanFeasibility', () => {
  it('a plan that keeps every rule and that the optimizer verified is VERIFIED and ok', () => {
    const f = checkPlanFeasibility(input([load('L1', 1), load('L2', 2)]));
    expect(f).toMatchObject({ ok: true, status: 'VERIFIED', source: 'SOLVER_AND_WEB', solverStatus: 'VERIFIED' });
    expect(f.violations).toEqual([]);
    expect(f.trucks.t1).toMatchObject({ status: 'VERIFIED', ok: true });
    expect(truckDayOk(f, 't1')).toBe(true);
  });

  it('F01: a 120 kg split portion on a 100 kg truck is a violation (the physical kg, not a capped one)', () => {
    const l = load('L1', 1, { capacity: { cases: 100, kg: 100 }, weightKg: 120, stops: [stop({ kg: 120 })] });
    const f = checkPlanFeasibility(input([l]));
    expect(codes(f)).toEqual(['CAPACITY_KG']);
    expect(f.violations[0]).toMatchObject({ severity: 'BLOCK', truckCode: 'T01', loadNo: 1, shortBy: 20 });
    expect(f.ok).toBe(false);
    expect(f.trucks.t1.status).toBe('VIOLATED');
  });

  it('F02: cases with no weight are reported as KG_UNKNOWN - a warning, not a block', () => {
    const l = load('L1', 1, { stops: [stop({ kgUnknown: true, label: 'Seeb Trading' })] });
    const f = checkPlanFeasibility(input([l]));
    expect(codes(f)).toEqual(['KG_UNKNOWN']);
    expect(f.violations[0].severity).toBe('WARN');
    expect(f.violations[0].message).toContain('Seeb Trading');
    expect(f.ok).toBe(true);
    // Without a payload the kg does not matter.
    const free = load('L1', 1, { capacity: { cases: 100, kg: 0 }, stops: [stop({ kgUnknown: true })] });
    expect(checkPlanFeasibility(input([free])).violations).toEqual([]);
  });

  it('frozen and new loads on one truck: the new load that leaves before the truck is reloaded is blocked', () => {
    const frozen = load('L1', 1, { onRoad: true });
    // 40 cases -> 30 + 20 = 50 min turnaround; L2 leaves 30 min after L1 is back.
    const late = load('L2', 2, { departMin: 530, returnMin: 630, stops: [stop({ orderId: 'oL2', etaMin: 550, serviceStartMin: 550, departureMin: 570 })] });
    const f = checkPlanFeasibility(input([frozen, late]));
    expect(codes(f)).toEqual(['TURNAROUND']);
    expect(f.violations[0]).toMatchObject({ loadNo: 2, severity: 'BLOCK', shortBy: 20 });
    expect(f.violations[0].message).toContain('needs 50 min to reload and load 40 cases');
    expect(truckDayOk(f, 't1')).toBe(false);
  });

  it('a problem on a load that already left is history: a warning that never blocks the truck', () => {
    const out = load('L1', 1, { onRoad: true, stops: [stop({ hardWindowOk: false })] });
    const f = checkPlanFeasibility(input([out, load('L2', 2)]));
    expect(codes(f)).toEqual(['HARD_WINDOW']);
    expect(f.violations[0].severity).toBe('WARN');
    expect(f.violations[0].message).toMatch(/already left/);
    expect(f.ok).toBe(true);
  });

  it('a missed hard window, an early start, the depot hours, the shift and the loads per day', () => {
    expect(codes(checkPlanFeasibility(input([load('L1', 1, { stops: [stop({ serviceStartMin: 900, departureMin: 920, etaMin: 900 })] })])))).toEqual(['HARD_WINDOW']);
    expect(codes(checkPlanFeasibility(input([load('L1', 1, { departMin: 330 })])))).toEqual(['EARLY_DEPARTURE']);
    expect(codes(checkPlanFeasibility(input([load('L1', 1, { rules: { ...RULES, depotCloseMin: 480 } })])))).toEqual(['DEPOT_CLOSE']);
    expect(codes(checkPlanFeasibility(input([load('L1', 1, { rules: { ...RULES, availableToMin: 480 } })])))).toEqual(['TRUCK_AVAILABILITY']);
    const short = { ...RULES, shiftMaxMin: 250 };
    expect(codes(checkPlanFeasibility(input([load('L1', 1, { rules: short }), load('L2', 2, { rules: short })])))).toEqual(['SHIFT_LIMIT']);
    const one = { ...RULES, maxTrips: 1 };
    expect(codes(checkPlanFeasibility(input([load('L1', 1, { rules: one }), load('L2', 2, { rules: one })])))).toEqual(['TRIPS']);
    expect(codes(checkPlanFeasibility(input([load('L1', 1, { capacity: { cases: 30, kg: 1000 } })])))).toEqual(['CAPACITY_CASES']);
  });

  it('each load is checked with the rules it was planned with (settings changed between versions)', () => {
    // L1 was locked in v1 (shift start 06:00); v2 was planned after the shift start moved to 07:00.
    const later = { ...RULES, shiftStartMin: 420, depotCloseMin: 560 };
    const l1 = load('L1', 1, { departMin: 380, returnMin: 520, stops: [stop({ etaMin: 400, serviceStartMin: 400, departureMin: 420 })] });
    const l2 = load('L2', 2, { rules: later, departMin: 600, returnMin: 700, stops: [stop({ orderId: 'x', etaMin: 620, serviceStartMin: 620, departureMin: 640 })] });
    const f = checkPlanFeasibility(input([l1, l2]));
    expect(codes(f)).toEqual(['DEPOT_CLOSE']); // L2 against its own rules; L1 is not "early" under v2's shift start
    expect(f.violations[0].loadNo).toBe(2);
  });

  it("the optimizer's own report: VIOLATED blocks the truck it names only; UNVERIFIED blocks", () => {
    const other = load('M1', 1, { id: 'M1', truckId: 't2', truckCode: 'T02' });
    const solver: FeasibilityReport = {
      status: 'VIOLATED',
      timing: 'ESTIMATED',
      violations: [{ code: 'TURNAROUND', truck_id: 't1', load_no: 2, message: 'T01 load 2 leaves 20 min too early' }],
    };
    const f = checkPlanFeasibility(input([load('L1', 1), load('L2', 2), other], solver));
    expect(f.trucks.t1).toMatchObject({ status: 'VIOLATED', ok: false });
    expect(f.trucks.t2).toMatchObject({ status: 'VERIFIED', ok: true });
    expect(f.violations[0]).toMatchObject({ source: 'SOLVER', loadId: 'L2', truckCode: 'T01' });
    expect(truckViolations(f, 't2')).toEqual([]);
    const u = checkPlanFeasibility(input([load('L1', 1)], { status: 'UNVERIFIED', timing: 'EXACT', violations: [] }));
    expect(u.trucks.t1).toMatchObject({ status: 'UNVERIFIED', ok: false });
  });

  it('legacy details without a report: structural check only, blocked only on a concrete violation', () => {
    const f = checkPlanFeasibility(input([load('L1', 1, { capacity: null, rules: null })], null));
    expect(f).toMatchObject({ ok: true, status: 'STRUCTURAL_ONLY', source: 'LEGACY_STRUCTURAL_ONLY', solverStatus: 'UNKNOWN' });
    const missed = checkPlanFeasibility(input([load('L1', 1, { capacity: null, rules: null, stops: [stop({ hardWindowOk: false, hardStartMin: undefined, hardEndMin: undefined })] })], null));
    expect(missed.ok).toBe(false);
    expect(codes(missed)).toEqual(['HARD_WINDOW']);
    // Without rules only an overlap counts as a turnaround problem.
    const overlap = checkPlanFeasibility(input([load('L1', 1, { rules: null }), load('L2', 2, { rules: null, departMin: 480 })], null));
    expect(codes(overlap)).toEqual(['TURNAROUND']);
  });

  it('the input hash changes with the plan facts and not with the time of the check', () => {
    const a = input([load('L1', 1), load('L2', 2)]);
    const f1 = checkPlanFeasibility(a, new Date('2026-09-27T05:00:00Z'));
    const f2 = checkPlanFeasibility(a, new Date('2026-09-27T06:00:00Z'));
    expect(f1.inputHash).toBe(f2.inputHash);
    expect(f1.inputHash).toMatch(/^[0-9a-f]{64}$/);
    const moved = input([load('L1', 1), load('L2', 2, { departMin: 601 })]);
    expect(inputHash(moved)).not.toBe(f1.inputHash);
    expect(inputHash(input([load('L1', 1), load('L2', 2)], null))).not.toBe(f1.inputHash);
    expect(readFeasibility(JSON.parse(JSON.stringify(f1)))?.inputHash).toBe(f1.inputHash);
    expect(readFeasibility(null)).toBeNull();
  });
});

describe('the gate switch and the moves it covers', () => {
  it('FEASIBILITY_GATE=warn is the only way to switch it off', () => {
    expect(feasibilityGateMode({})).toBe('enforce');
    expect(feasibilityGateMode({ FEASIBILITY_GATE: 'enforce' })).toBe('enforce');
    expect(feasibilityGateMode({ FEASIBILITY_GATE: ' WARN ' })).toBe('warn');
    expect(feasibilityGateMode({ FEASIBILITY_GATE: 'off' })).toBe('enforce');
  });

  it('LOCK, LOADING and DISPATCH forward; never the way back or COMPLETED', () => {
    expect(isGatedMove('PLANNED', 'LOCKED')).toBe(true);
    expect(isGatedMove('LOCKED', 'LOADING')).toBe(true);
    expect(isGatedMove('LOCKED', 'DISPATCHED')).toBe(true);
    expect(isGatedMove('LOADING', 'DISPATCHED')).toBe(true);
    expect(isGatedMove('LOADING', 'LOCKED')).toBe(false);
    expect(isGatedMove('LOCKED', 'PLANNED')).toBe(false);
    expect(isGatedMove('DISPATCHED', 'COMPLETED')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The facts the check reads from the rows
// ---------------------------------------------------------------------------------------

function row(over: Partial<FeasibilityRow> = {}, assignment: Partial<FeasibilityRow['assignments'][number]> = {}): FeasibilityRow {
  return {
    id: 'L1', truckId: 't1', loadNo: 1, status: 'PLANNED', departMin: 400, returnMin: 500, cases: 40, weightKg: 400,
    carriedFromLoadId: null, truckSnapshotJson: null, truck: { code: 'T01-NOW' },
    assignments: [{
      orderId: 'o1', sequenceInTruck: 1, portionCases: null, portionWeightKg: null, portionLinesJson: null,
      etaMin: 420, serviceStartMin: 420, departureMin: 440, hardWindowOk: true, stopSnapshotJson: null,
      order: {
        totalCases: 40, totalWeightKg: 400, customer: { code: 'C1', branchCode: null, name: 'Customer now' },
        lines: [{ id: 'ln1', cases: 40, weightKg: 400, product: { weightPerCaseKg: 10 } }],
      },
      ...assignment,
    }],
    ...over,
  };
}

const truckSnap = {
  v: 1, code: 'T01', capacityCases: 100, capacityWeightKg: 1000, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.1, kmPerLitre: null,
  availableFromMin: null, availableToMin: null, maxTripsPerDay: null, rules: RULES, source: 'PLAN', capturedAt: '2026-09-26T12:00:00Z',
};

describe('feasibilityInputFromRows', () => {
  it('takes the truck and rules the load was planned with (snapshot), never the truck now', () => {
    const inp = feasibilityInputFromRows([row({ truckSnapshotJson: truckSnap })], 'sc1', undefined, null);
    expect(inp.loads[0]).toMatchObject({ truckCode: 'T01', capacity: { cases: 100, kg: 1000 }, rules: RULES });
    expect(inp.solver).toBeNull();
  });

  it('a load planned before snapshots: the request of its own optimization, or nothing (carried copies)', () => {
    const legacy = { capacity: () => ({ cases: 90, kg: 900 }), rules: () => ({ ...RULES, reloadMin: 45 }) };
    const own = feasibilityInputFromRows([row()], 'sc1', undefined, legacy);
    expect(own.loads[0]).toMatchObject({ truckCode: 'T01-NOW', capacity: { cases: 90, kg: 900 } });
    expect(own.loads[0].rules?.reloadMin).toBe(45);
    const carried = feasibilityInputFromRows([row({ carriedFromLoadId: 'L0' })], 'sc1', undefined, legacy);
    expect(carried.loads[0]).toMatchObject({ capacity: null, rules: null });
  });

  it('the stop window from the snapshot; physical kg from the portion; unknown kg only when no weight was used', () => {
    const snap = { v: 1, customerId: 'c1', code: 'C1', branchCode: null, name: 'Planned name', customerType: null, lat: 23.6, lng: 58.4,
      address: null, accessNotes: null, hardStartMin: 420, hardEndMin: 480, prefStartMin: null, prefEndMin: null, serviceMin: 20, priority: 2,
      source: 'PLAN', capturedAt: '2026-09-26T12:00:00Z' };
    const inp = feasibilityInputFromRows([row({}, { stopSnapshotJson: snap, portionCases: 12, portionWeightKg: 120, portionLinesJson: [{ lineId: 'ln1', cases: 12 }] })], 'sc1', undefined, null);
    expect(inp.loads[0].stops[0]).toMatchObject({ label: 'Planned name', cases: 12, kg: 120, kgUnknown: false, hardStartMin: 420, hardEndMin: 480 });
    // A whole order with a 0 kg line: counted as 0 kg on the plan.
    const zero = row({}, { order: { totalCases: 40, totalWeightKg: 0, customer: { code: 'C1', branchCode: null, name: 'x' }, lines: [{ id: 'ln1', cases: 40, weightKg: 0, product: { weightPerCaseKg: 12 } }] } });
    expect(feasibilityInputFromRows([zero], 'sc1', undefined, null).loads[0].stops[0].kgUnknown).toBe(true);
    // A split part of that line was planned with the product's case weight: known.
    const part = row({}, { portionCases: 10, portionWeightKg: 120, portionLinesJson: [{ lineId: 'ln1', cases: 10 }], order: zero.assignments[0].order });
    expect(feasibilityInputFromRows([part], 'sc1', undefined, null).loads[0].stops[0].kgUnknown).toBe(false);
  });

  it("carries the chosen option's report; an on-road load is flagged", () => {
    const details = { feasibility: VERIFIED } as unknown as ScenarioDetails;
    const inp = feasibilityInputFromRows([row({ status: 'DISPATCHED' })], 'sc1', details, null);
    expect(inp.solver).toEqual(VERIFIED);
    expect(inp.loads[0].onRoad).toBe(true);
  });
});

describe('rulesFrom', () => {
  it('builds the truck-day rules from the optimizer config, the depot and the truck', () => {
    expect(
      rulesFrom({ shift_start_min: 390, shift_max_min: 600, reload_min: 20, loading_min_per_case: 0.04, max_trips_per_truck: 3 }, { open_min: 300, close_min: 0 }, { availableFromMin: 420, maxTripsPerDay: 2 }),
    ).toEqual({ shiftStartMin: 390, shiftMaxMin: 600, reloadMin: 20, loadingMinPerCase: 0.04, maxTrips: 2, depotOpenMin: 300, depotCloseMin: 1440, availableFromMin: 420, availableToMin: null });
  });
});

// ---------------------------------------------------------------------------------------
// Stabilization PR4 review fixes
// ---------------------------------------------------------------------------------------

type PortionIn = { orderId: string; lines: { lineId: string; cases: number; kgPerCase?: number }[]; cases: number; weightKg: number };

/** One load carrying `portions` (one row each) of one customer, on a truck of `payload` kg. */
function partRows(portions: PortionIn[], payload: number): FeasibilityRow {
  const base = row({ truckSnapshotJson: { ...truckSnap, capacityCases: 2000, capacityWeightKg: payload } });
  const order = (p: PortionIn) => ({
    totalCases: 900,
    totalWeightKg: 900 * 12.35,
    customer: { code: 'C1', branchCode: null, name: 'Big customer' },
    lines: p.lines.map((l) => ({ id: l.lineId, cases: 900, weightKg: 900 * 12.35, product: { weightPerCaseKg: 12.35 } })),
  });
  return {
    ...base,
    cases: portions.reduce((a, p) => a + p.cases, 0),
    weightKg: Math.round(portions.reduce((a, p) => a + p.weightKg, 0) * 10) / 10,
    assignments: portions.map((p) => ({
      ...base.assignments[0],
      orderId: p.orderId,
      portionCases: p.cases,
      portionWeightKg: p.weightKg,
      portionLinesJson: p.lines,
      order: order(p),
    })),
  };
}

describe('kg rounding: a split part filled to its payload is never refused (PR4 review)', () => {
  it('the 12.35 kg x 800 case example: the parts as split now weigh exactly the payload and pass', () => {
    const lines = [
      { lineId: 'la', orderId: 'OA', cases: 1, kgPerCase: 12.35 },
      { lineId: 'lb', orderId: 'OB', cases: 849, kgPerCase: 12.35 },
    ];
    const [part] = splitIntoParts(lines, { cases: 2000, kg: 9880 });
    const kgPerCase = new Map(lines.map((l) => [l.lineId, l.kgPerCase]));
    expect(partDemandKg(part, kgPerCase)).toBe(9880);
    const f = checkPlanFeasibility(feasibilityInputFromRows([partRows(portionsOfPart(part, 1, 2, kgPerCase), 9880)], 'sc1', undefined, null));
    expect(f.violations).toEqual([]);
    expect(f.ok).toBe(true);
  });

  it('parts stored before the fix (12.4 + 9867.7 = 9880.1 kg on 9880 kg) are within the rounding tolerance', () => {
    const stored: PortionIn[] = [
      { orderId: 'OA', lines: [{ lineId: 'la', cases: 1 }], cases: 1, weightKg: 12.4 },
      { orderId: 'OB', lines: [{ lineId: 'lb', cases: 799 }], cases: 799, weightKg: 9867.7 },
    ];
    const f = checkPlanFeasibility(feasibilityInputFromRows([partRows(stored, 9880)], 'sc1', undefined, null));
    expect(codes(f)).toEqual([]);
    expect(f.ok).toBe(true);
    // A real overload still blocks.
    const over = [stored[0], { ...stored[1], weightKg: 9868.3 }];
    expect(codes(checkPlanFeasibility(feasibilityInputFromRows([partRows(over, 9880)], 'sc1', undefined, null)))).toEqual(['CAPACITY_KG']);
  });
});

describe("cases planned with no weight are judged from the plan, not today's product master (PR4 review)", () => {
  /** A 400-case split part planned at 0 kg, LOCKED on a 3000 kg truck; the product now weighs `productKg` per case. */
  function zeroKgPart(productKg: number, portionLinesJson: unknown = [{ lineId: 'ln1', cases: 400, kgPerCase: 0 }]): FeasibilityRow {
    return row(
      { status: 'LOCKED', cases: 400, weightKg: 0, truckSnapshotJson: { ...truckSnap, capacityCases: 400, capacityWeightKg: 3000 } },
      {
        portionCases: 400,
        portionWeightKg: 0,
        portionLinesJson,
        order: {
          totalCases: 800,
          totalWeightKg: 0,
          customer: { code: 'C1', branchCode: null, name: 'Big customer' },
          lines: [{ id: 'ln1', cases: 800, weightKg: 0, product: { weightPerCaseKg: productKg } }],
        },
      },
    );
  }
  const check = (r: FeasibilityRow) => checkPlanFeasibility(feasibilityInputFromRows([r], 'sc1', undefined, null));

  it('the product still has no weight: KG_UNKNOWN, a warning', () => {
    const f = check(zeroKgPart(0));
    expect(codes(f)).toEqual(['KG_UNKNOWN']);
    expect(f.ok).toBe(true);
  });

  it('a weight entered after locking (20 kg/case = 8000 kg on a 3000 kg truck) blocks - the signal no longer vanishes', () => {
    const inp = feasibilityInputFromRows([zeroKgPart(20)], 'sc1', undefined, null);
    expect(inp.loads[0].stops[0]).toMatchObject({ kgUnknown: true, unknownKgNow: 8000, kg: 0 });
    const f = checkPlanFeasibility(inp);
    expect(codes(f)).toEqual(['CAPACITY_KG_NEW_WEIGHT']);
    expect(f.violations[0]).toMatchObject({ severity: 'BLOCK', shortBy: 5000, frozen: true });
    expect(f.violations[0].message).toMatch(/weighs about 8000 kg - over the truck's payload of 3000 kg\.$/);
    expect(f.ok).toBe(false);
  });

  it('a weight entered since that still fits: KG_UNKNOWN with the weight the load has now', () => {
    const f = check(zeroKgPart(5));
    expect(codes(f)).toEqual(['KG_UNKNOWN']);
    expect(f.violations[0].message).toMatch(/the load weighs about 2000 kg\.$/);
  });

  it('a part stored before the planned case weight was kept: no line weight and a 0 kg part = planned at 0 kg', () => {
    expect(codes(check(zeroKgPart(20, [{ lineId: 'ln1', cases: 400 }])))).toEqual(['CAPACITY_KG_NEW_WEIGHT']);
    // ... while a part whose kg shows it was planned with the product's case weight then is known.
    const known = row({}, {
      portionCases: 10,
      portionWeightKg: 120,
      portionLinesJson: [{ lineId: 'ln1', cases: 10 }],
      order: { totalCases: 40, totalWeightKg: 0, customer: { code: 'C1', branchCode: null, name: 'x' }, lines: [{ id: 'ln1', cases: 40, weightKg: 0, product: { weightPerCaseKg: 12 } }] },
    });
    expect(rowUnknownKg(known.assignments[0])).toEqual({ unknown: false, kgNow: 0 });
  });

  it('a part planned with a case weight stays known whatever the product master says later', () => {
    const r = zeroKgPart(0, [{ lineId: 'ln1', cases: 400, kgPerCase: 7.5 }]);
    r.assignments[0].portionWeightKg = 3000;
    expect(rowUnknownKg(r.assignments[0])).toEqual({ unknown: false, kgNow: 0 });
  });
});

describe('a problem on a locked or loading load: put it back to Planned first (PR4 review)', () => {
  it('flags violations on LOCKED / LOADING loads, and the remedy names them', () => {
    const locked = load('L1', 1, { frozen: true, stops: [stop({ hardWindowOk: false })] });
    const f = checkPlanFeasibility(input([locked, load('L2', 2)]));
    expect(f.violations[0]).toMatchObject({ code: 'HARD_WINDOW', severity: 'BLOCK', frozen: true });
    const r = timingRemedy(f.violations);
    expect(r.unlockFirst).toEqual(['T01 L1']);
    expect(r.text).toBe(
      'A re-plan keeps locked and loading loads exactly as they are, so put load T01 L1 back to Planned first ("Back to locked" if it is loading, then "Unlock"), then re-plan.',
    );
    // On a PLANNED load a re-plan is enough.
    const planned = checkPlanFeasibility(input([load('L1', 1, { stops: [stop({ hardWindowOk: false })] })]));
    expect(planned.violations[0].frozen).toBeUndefined();
    expect(timingRemedy(planned.violations)).toEqual({ text: REPLAN_REMEDY, unlockFirst: [] });
  });

  it("the optimizer's violation on a locked load is flagged the same way; a load already out is history", () => {
    const solver: FeasibilityReport = { status: 'VIOLATED', timing: 'ESTIMATED', violations: [{ code: 'TURNAROUND', truck_id: 't1', load_no: 2, message: 'T01 load 2 leaves too early' }] };
    const f = checkPlanFeasibility(input([load('L1', 1), load('L2', 2, { frozen: true })], solver));
    expect(f.violations[0]).toMatchObject({ source: 'SOLVER', frozen: true });
    const out = checkPlanFeasibility(input([load('L1', 1, { onRoad: true, frozen: true, stops: [stop({ hardWindowOk: false })] })]));
    expect(out.violations[0].severity).toBe('WARN');
    expect(out.violations[0].frozen).toBeUndefined();
  });

  it('feasibilityInputFromRows marks LOCKED and LOADING loads', () => {
    const inp = feasibilityInputFromRows([row({ status: 'LOCKED' }), row({ id: 'L2', loadNo: 2, status: 'LOADING' }), row({ id: 'L3', loadNo: 3 })], 'sc1', undefined, null);
    expect(inp.loads.map((l) => l.frozen)).toEqual([true, true, false]);
  });
});

describe('inverted windows and corrected trucks (PR4 review)', () => {
  it('a window that ends before it starts was planned as any time: no HARD_WINDOW', () => {
    const f = checkPlanFeasibility(input([load('L1', 1, { stops: [stop({ hardStartMin: 1320, hardEndMin: 360 })] })]));
    expect(f.violations).toEqual([]);
  });

  it('a truck whose capacity was lowered since planning, below the load it carries: a warning with the remedy', () => {
    const f = checkPlanFeasibility(input([load('L1', 1, { capacityNow: { cases: 100, kg: 300 } })]));
    expect(codes(f)).toEqual(['CAPACITY_CHANGED']);
    expect(f.violations[0].severity).toBe('WARN');
    expect(f.violations[0].message).toMatch(/was changed to 100 cases \/ 300 kg after planning \(planned with 100 cases \/ 1000 kg\)\. Re-plan to use the new capacity\.$/);
    expect(f.ok).toBe(true);
    // Unchanged, still fitting, or already out: nothing.
    expect(checkPlanFeasibility(input([load('L1', 1, { capacityNow: { cases: 100, kg: 1000 } })])).violations).toEqual([]);
    expect(checkPlanFeasibility(input([load('L1', 1, { capacityNow: { cases: 100, kg: 800 } })])).violations).toEqual([]);
    expect(checkPlanFeasibility(input([load('L1', 1, { onRoad: true, capacityNow: { cases: 10, kg: 300 } })])).violations).toEqual([]);
    const lockedLoad = checkPlanFeasibility(input([load('L1', 1, { frozen: true, capacityNow: { cases: 10, kg: 1000 } })]));
    expect(lockedLoad.violations[0].message).toMatch(/Put the load back to Planned and re-plan to use the new capacity\.$/);
  });

  it('reads the truck now from the row, next to the snapshot', () => {
    const inp = feasibilityInputFromRows([row({ truckSnapshotJson: truckSnap, truck: { code: 'T01', capacityCases: 80, capacityWeightKg: 900 } })], 'sc1', undefined, null);
    expect(inp.loads[0]).toMatchObject({ capacity: { cases: 100, kg: 1000 }, capacityNow: { cases: 80, kg: 900 } });
  });
});
