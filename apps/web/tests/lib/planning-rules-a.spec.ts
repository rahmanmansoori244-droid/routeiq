/**
 * Planning rules, phase A (owner decisions 29 Sep 2026):
 * - unloading must be FINISHED by the end of the receiving hours: the web asks for it
 *   (window_rule 'FINISH'), takes the rule each load was planned with ONLY from the solver's echo,
 *   and checks each load under its own rule, so a load planned before it is never blocked after
 *   the fact;
 * - the dispatcher (PLANNER role) changes the driver shift on Settings; everything else stays
 *   company-admin data.
 */
import { describe, expect, it } from 'vitest';
import type { FeasibilityReport } from '@routeiq/shared-types';
import { checkPlanFeasibility, inputHash, type FeasLoad, type FeasStop } from '@/lib/dispatch/feasibility';
import { rulesFrom, type PlanRules } from '@/lib/dispatch/snapshots';
import { dispatchConfigFromTenant, type TenantPlannerConfig } from '@/lib/dispatch/planner-config';
import { plannerRulesNote } from '@/lib/dispatch/plan-detail';
import { adminOnlyFields, DISPATCHER_SETTINGS_FIELDS, SETTINGS_FIELDS } from '@/lib/settings-fields';
import { visibleNavItems } from '@/lib/nav';

const RULES: PlanRules = {
  shiftStartMin: 420, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0, maxTrips: 3,
  depotOpenMin: 300, depotCloseMin: 1380, availableFromMin: null, availableToMin: null,
};
const VERIFIED: FeasibilityReport = { status: 'VERIFIED', timing: 'EXACT', violations: [] };

/** A stop open 06:00-11:00, served 10:40, unloading 35 min: finished 11:15. */
function lateFinish(rules: PlanRules, over: Partial<FeasLoad> = {}): FeasLoad {
  const s: FeasStop = {
    orderId: 'o1', sequence: 1, label: 'Lulu Bausher', cases: 40, kg: 400, kgUnknown: false,
    etaMin: 640, serviceStartMin: 640, departureMin: 675, hardWindowOk: true, hardStartMin: 360, hardEndMin: 660,
  };
  return {
    id: 'L1', truckId: 't1', truckCode: 'T01', loadNo: 1, onRoad: false, departMin: 620, returnMin: 700,
    cases: 40, weightKg: 400, capacity: { cases: 100, kg: 1000 }, rules, stops: [s], ...over,
  };
}

const run = (l: FeasLoad) => checkPlanFeasibility({ scenarioId: 'sc1', solver: VERIFIED, loads: [l] });

describe('finish by closing: the web gate checks each load under the rule it was planned with', () => {
  it("a load planned under FINISH that finishes after closing is blocked, in the dispatcher's words", () => {
    const f = run(lateFinish({ ...RULES, windowRule: 'FINISH' }));
    expect(f.violations.map((v) => v.code)).toEqual(['HARD_WINDOW']);
    expect(f.violations[0]).toMatchObject({ severity: 'BLOCK', loadNo: 1 });
    expect(f.violations[0].message).toBe('T01 load 1: Lulu Bausher finishes unloading at 11:15, after its receiving hours end (11:00).');
    expect(f.ok).toBe(false);
  });

  it('within the 1-minute rounding tolerance it passes', () => {
    const l = lateFinish({ ...RULES, windowRule: 'FINISH' });
    l.stops[0] = { ...l.stops[0], serviceStartMin: 626, etaMin: 626, departureMin: 661 };
    expect(run(l).violations).toEqual([]);
  });

  it('a load planned before the rule (no windowRule) keeps the earlier rule: never blocked after the fact, locked or not', () => {
    expect(run(lateFinish(RULES)).violations).toEqual([]);
    expect(run(lateFinish(RULES, { frozen: true })).violations).toEqual([]);
  });

  it('a start before opening is still the earlier message under FINISH (one violation per stop)', () => {
    const l = lateFinish({ ...RULES, windowRule: 'FINISH' });
    l.stops[0] = { ...l.stops[0], serviceStartMin: 350, etaMin: 350, departureMin: 385 };
    const f = run(l);
    expect(f.violations.map((v) => v.code)).toEqual(['HARD_WINDOW']);
    expect(f.violations[0].message).toContain('is served at 05:50, outside its receiving hours 06:00-11:00');
  });

  it('the input hash of a load without the rule is unchanged; the rule changes it', () => {
    const old = { scenarioId: 'sc1', solver: VERIFIED, loads: [lateFinish(RULES)] };
    const withRule = { scenarioId: 'sc1', solver: VERIFIED, loads: [lateFinish({ ...RULES, windowRule: 'FINISH' })] };
    const noKey = { scenarioId: 'sc1', solver: VERIFIED, loads: [lateFinish({ ...RULES, windowRule: undefined })] };
    expect(inputHash(noKey)).toBe(inputHash(old));
    expect(inputHash(withRule)).not.toBe(inputHash(old));
  });
});

describe('the rules each load was planned with come only from the echo', () => {
  const cfg = { shift_start_min: 420, shift_max_min: 660, reload_min: 30, loading_min_per_case: 0, max_trips_per_truck: 3 } as const;
  const depot = { openMin: 300, closeMin: 1380 };

  it("the asked config never sets the rule; the solver's echo does", () => {
    expect(rulesFrom({ ...cfg, window_rule: 'FINISH' } as never, depot, {})).not.toHaveProperty('windowRule');
    expect(rulesFrom(cfg, depot, {}, { window_rule: 'FINISH' })).toMatchObject({ windowRule: 'FINISH' });
    expect(rulesFrom(cfg, depot, {}, { window_rule: 'START' })).not.toHaveProperty('windowRule');
    expect(rulesFrom(cfg, depot, {}, null)).toEqual(rulesFrom(cfg, depot, {}));
  });

  it('a plan asked with the rule but made by an older planner gets a note; one made with it does not', () => {
    const inputs = { v: 1, jobId: null, capturedAt: '', depot: { id: 'd', lat: 0, lng: 0, openMin: 0, closeMin: 1440 }, trucks: {}, stops: {}, config: { window_rule: 'FINISH' } };
    expect(plannerRulesNote({ inputs })).toContain('unloading must be finished by closing');
    expect(plannerRulesNote({ inputs, window_rule: 'FINISH' })).toBeNull();
    expect(plannerRulesNote({ inputs: { ...inputs, config: {} } })).toBeNull();
    expect(plannerRulesNote({})).toBeNull();
  });
});

describe('the request asks for finish by closing', () => {
  it('dispatchConfigFromTenant sends window_rule FINISH (an owner rule, not a setting)', () => {
    const t = {
      shiftStartMin: 420, driverShiftMaxMinutes: 660, overtimeAfterMin: 540, overtimeCostPerHour: 4, reloadMinutes: 30, loadingMinPerCase: 0,
      serviceMinPerCase: 0, maxTripsPerTruck: 3, splitDeliveries: true, defaultServiceTimeMin: 20, fuelPricePerLitre: 0, driverCostPerHour: 0,
      prefWindowPenaltyPerMin: 0.05, priorityWeightsJson: null, distanceProvider: 'HAVERSINE', osrmUrl: null, distanceMultiplier: 1.3,
      avgSpeedKmh: 40, roadTimeFactor: 1.25, planningCutoffMin: 1080, dateOrder: 'DMY', timezone: 'Asia/Muscat', serviceAreaJson: null,
    } as unknown as TenantPlannerConfig;
    expect(dispatchConfigFromTenant(t, 'OM', ['RECOMMENDED']).config.window_rule).toBe('FINISH');
  });
});

describe('the dispatcher changes the driver shift on Settings', () => {
  it('the driver-shift fields are Settings fields; everything else is admin-only', () => {
    expect([...DISPATCHER_SETTINGS_FIELDS]).toEqual(['shiftStartMin', 'driverShiftMaxMinutes', 'overtimeAfterMin']);
    for (const k of DISPATCHER_SETTINGS_FIELDS) expect(SETTINGS_FIELDS).toContain(k);
    expect(adminOnlyFields({}, { shiftStartMin: 420, driverShiftMaxMinutes: 660, overtimeAfterMin: 540 })).toEqual([]);
    expect(adminOnlyFields({ name: 'X' }, { shiftStartMin: 420, driverCostPerHour: 2 })).toEqual(['name', 'driverCostPerHour']);
  });

  it('Settings is in the menu of a dispatcher, not of a viewer', () => {
    const has = (r: Parameters<typeof visibleNavItems>[0]) => visibleNavItems(r).some((i) => i.label === 'Settings');
    expect([has('PLANNER'), has('SUPERVISOR'), has('TENANT_ADMIN'), has('VIEWER')]).toEqual([true, true, true, false]);
  });
});
