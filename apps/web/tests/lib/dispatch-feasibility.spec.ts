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
  truckDayOk,
  truckViolations,
  type FeasLoad,
  type FeasibilityInput,
  type FeasStop,
} from '@/lib/dispatch/feasibility';
import { feasibilityInputFromRows, isGatedMove, type FeasibilityRow, type ScenarioDetails } from '@/lib/dispatch/plan-service';
import { rulesFrom, type PlanRules } from '@/lib/dispatch/snapshots';

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
