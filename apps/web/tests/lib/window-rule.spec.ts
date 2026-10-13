/**
 * The receiving-hours rule as a company setting (owner request 13 Oct 2026: "14:00 IS the latest
 * arrival"). TenantConfig.windowRule: 'FINISH' (the default, unloading finished by the end of the
 * receiving hours, owner rule 29 Sep 2026) or 'START' (the end is the latest arrival: unloading starts
 * by then and may continue after it).
 * - the setting is sent to the optimizer (config.window_rule) and recorded with the plan as asked;
 * - each load keeps the rule the optimizer ECHOED (PlanRules.windowRule) and is checked by it: under
 *   START a stop arriving 13:50 for a 14:00 close with a long unloading is valid, under FINISH refused;
 * - the "rules not applied" note warns only when the asked rule was not applied;
 * - the texts (effective planner values, ASSUMPTIONS, the Settings choice) follow the rule;
 * - old plans (no echo, or FINISH) keep their checks and their feasibility hash.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FeasibilityReport } from '@routeiq/shared-types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));

import { checkPlanFeasibility, inputHash, type FeasLoad, type FeasStop } from '@/lib/dispatch/feasibility';
import { rulesFrom, type PlanRules } from '@/lib/dispatch/snapshots';
import { dispatchConfigFromTenant, effectivePlannerValues, type TenantPlannerConfig } from '@/lib/dispatch/planner-config';
import { plannerRulesNote } from '@/lib/dispatch/plan-detail';
import { planSettingsOf } from '@/lib/dispatch/plan-service';
import { solverRules, tenantAssumptions } from '@/lib/dispatch/workbook';
import { echoedWindowRule, WINDOW_RULE_CHOICES, WINDOW_RULE_DEFAULT, windowRuleOf, windowRuleText } from '@/lib/dispatch/window-rule';
import { tenantConfigSchema } from '@/lib/schemas';
import { DISPATCHER_SETTINGS_FIELDS, SETTINGS_FIELDS, type EditableConfig } from '@/lib/settings-fields';
import { SettingsForm } from '@/app/t/[slug]/settings/settings-form';

const RULES: PlanRules = {
  shiftStartMin: 420, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0, maxTrips: 3,
  depotOpenMin: 300, depotCloseMin: 1380, availableFromMin: null, availableToMin: null,
};
const VERIFIED: FeasibilityReport = { status: 'VERIFIED', timing: 'EXACT', violations: [] };
const hm = (h: number, m = 0) => h * 60 + m;

/** A store open 08:00-14:00; the truck arrives at `arrive` and unloads for 60 min. */
function storeLoad(rules: PlanRules, arrive = hm(13, 50)): FeasLoad {
  const s: FeasStop = {
    orderId: 'o1', sequence: 1, label: 'Store 12', cases: 600, kg: 6000, kgUnknown: false,
    etaMin: arrive, serviceStartMin: arrive, departureMin: arrive + 60, hardWindowOk: true, hardStartMin: hm(8), hardEndMin: hm(14),
  };
  return {
    id: 'L1', truckId: 't1', truckCode: 'T01', loadNo: 1, onRoad: false, departMin: arrive - 40, returnMin: arrive + 100,
    cases: 600, weightKg: 6000, capacity: { cases: 1000, kg: 10000 }, rules, stops: [s],
  };
}
const run = (l: FeasLoad) => checkPlanFeasibility({ scenarioId: 'sc1', solver: VERIFIED, loads: [l] });

const TENANT = {
  shiftStartMin: 420, driverShiftMaxMinutes: 660, overtimeAfterMin: 540, overtimeCostPerHour: 4, driverBreakMinutes: 0, driverBreakFromMin: 720,
  driverBreakToMin: 840, reloadMinutes: 30, loadingMinPerCase: 0, serviceMinPerCase: 0, maxTripsPerTruck: 3, splitDeliveries: true,
  defaultServiceTimeMin: 20, fuelPricePerLitre: 0, driverCostPerHour: 0, prefWindowPenaltyPerMin: 0.05, priorityWeightsJson: null,
  distanceProvider: 'HAVERSINE', osrmUrl: null, distanceMultiplier: 1.3, avgSpeedKmh: 40, roadTimeFactor: 1.25, planningCutoffMin: 1080,
  dateOrder: 'DMY', timezone: 'Asia/Muscat', serviceAreaJson: null,
} as unknown as TenantPlannerConfig;

describe('the setting', () => {
  it("defaults to FINISH: only 'START' asks for the latest-arrival rule", () => {
    expect(WINDOW_RULE_DEFAULT).toBe('FINISH');
    expect(windowRuleOf(undefined)).toBe('FINISH');
    expect(windowRuleOf({})).toBe('FINISH');
    expect(windowRuleOf({ windowRule: 'FINISH' })).toBe('FINISH');
    expect(windowRuleOf({ windowRule: 'START' })).toBe('START');
    expect(windowRuleOf({ windowRule: 'start' })).toBe('FINISH');
    expect(echoedWindowRule('START')).toBe('START');
    expect(echoedWindowRule('FINISH')).toBe('FINISH');
    expect(echoedWindowRule(undefined)).toBeNull();
    expect(echoedWindowRule('ARRIVAL')).toBeNull();
  });

  it('Settings saves START or FINISH only, as a company admin field', () => {
    const p = tenantConfigSchema.partial();
    expect(p.safeParse({ windowRule: 'START' }).success).toBe(true);
    expect(p.safeParse({ windowRule: 'FINISH' }).success).toBe(true);
    expect(p.safeParse({ windowRule: 'ARRIVAL' }).success).toBe(false);
    expect(p.safeParse({ windowRule: null }).success).toBe(false);
    expect(SETTINGS_FIELDS).toContain('windowRule');
    expect(DISPATCHER_SETTINGS_FIELDS).not.toContain('windowRule');
  });

  it('the migration adds the column with FINISH for every company and a CHECK', () => {
    const sql = readFileSync(path.join(__dirname, '..', '..', 'prisma', 'migrations', '20261013170000_window_rule', 'migration.sql'), 'utf8');
    expect(sql).toMatch(/ADD COLUMN\s+"windowRule" TEXT NOT NULL DEFAULT 'FINISH'/);
    expect(sql).toMatch(/CHECK \("windowRule" IN \('START', 'FINISH'\)\)/);
    const schema = readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(/windowRule\s+String\s+@default\("FINISH"\)/);
  });

  it('the admin Settings page offers the two choices, the saved one checked', () => {
    const config = { ...(TENANT as object), windowRule: 'START' } as unknown as EditableConfig;
    const html = renderToStaticMarkup(
      createElement(SettingsForm, { initial: { tenant: { name: 'T', country: 'Oman', currency: 'OMR', primaryUnit: 'CASES' }, config } as never, effective: [], profiles: [] }),
    );
    expect(html).toContain('id="windowRule"');
    expect(html).toContain(WINDOW_RULE_CHOICES.START.label);
    expect(html).toContain(WINDOW_RULE_CHOICES.FINISH.label);
    expect(html).toMatch(/<input[^>]*value="START"[^>]*checked=""|<input[^>]*checked=""[^>]*value="START"/);
    expect(html).not.toMatch(/<input[^>]*value="FINISH"[^>]*checked=""|<input[^>]*checked=""[^>]*value="FINISH"/);
    // The preferred-window hint follows the choice too.
    expect(html).toContain('starts after the preferred end');
  });
});

describe('config -> request', () => {
  it('sends window_rule from the setting (FINISH unless START)', () => {
    expect(dispatchConfigFromTenant(TENANT, 'OM', ['RECOMMENDED']).config.window_rule).toBe('FINISH');
    expect(dispatchConfigFromTenant({ ...TENANT, windowRule: 'START' }, 'OM', ['RECOMMENDED']).config.window_rule).toBe('START');
    expect(dispatchConfigFromTenant({ ...TENANT, windowRule: 'FINISH' }, 'OM', ['RECOMMENDED']).config.window_rule).toBe('FINISH');
  });

  it('the plan records the rule it asked for (the loads keep the echo)', () => {
    const cfg = { ...(TENANT as object), osrmUrl: null } as never;
    expect(planSettingsOf(cfg)).toMatchObject({ windowRule: 'FINISH' });
    expect(planSettingsOf({ ...(cfg as object), windowRule: 'START' } as never)).toMatchObject({ windowRule: 'START' });
  });
});

describe('each load is checked by the rule it was planned with (the echo)', () => {
  const depot = { openMin: 300, closeMin: 1380 };
  const cfg = { shift_start_min: 420, shift_max_min: 660, reload_min: 30, loading_min_per_case: 0, max_trips_per_truck: 3 } as const;

  it('the echo sets the load rule; what was asked never does', () => {
    expect(rulesFrom(cfg, depot, {}, { window_rule: 'START' })).toMatchObject({ windowRule: 'START' });
    expect(rulesFrom(cfg, depot, {}, { window_rule: 'FINISH' })).toMatchObject({ windowRule: 'FINISH' });
    expect(rulesFrom({ ...cfg, window_rule: 'START' } as never, depot, {})).not.toHaveProperty('windowRule');
  });

  it('13:50 arrival for a 14:00 close with 60 min unloading: valid under START, refused under FINISH', () => {
    expect(run(storeLoad({ ...RULES, windowRule: 'START' })).violations).toEqual([]);
    expect(run(storeLoad({ ...RULES, windowRule: 'START' })).ok).toBe(true);
    const finish = run(storeLoad({ ...RULES, windowRule: 'FINISH' }));
    expect(finish.ok).toBe(false);
    expect(finish.violations).toHaveLength(1);
    expect(finish.violations[0]).toMatchObject({ code: 'HARD_WINDOW', severity: 'BLOCK' });
    expect(finish.violations[0].message).toBe('T01 load 1: Store 12 finishes unloading at 14:50, after its receiving hours end (14:00).');
  });

  it('under START a stop must still START by closing, in the rule’s words', () => {
    const late = run(storeLoad({ ...RULES, windowRule: 'START' }, hm(14, 10)));
    expect(late.ok).toBe(false);
    expect(late.violations.map((v) => v.code)).toEqual(['HARD_WINDOW']);
    expect(late.violations[0].message).toBe('T01 load 1: Store 12 starts unloading at 14:10, after its latest arrival 14:00 (receiving hours 08:00-14:00).');
    // Starting exactly at closing passes (the solver's own rule: start <= closing).
    expect(run(storeLoad({ ...RULES, windowRule: 'START' }, hm(14))).violations).toEqual([]);
  });

  it('an old plan (no echo) keeps the earlier rule and its message; a FINISH plan is unchanged', () => {
    expect(run(storeLoad(RULES)).violations).toEqual([]);
    expect(run(storeLoad(RULES, hm(14, 10))).violations[0].message).toBe('T01 load 1: Store 12 is served at 14:10, outside its receiving hours 08:00-14:00.');
  });

  it('the feasibility hash of old loads is unchanged; START and FINISH each change it', () => {
    const at = (r: PlanRules) => inputHash({ scenarioId: 'sc1', solver: VERIFIED, loads: [storeLoad(r)] });
    const old = at(RULES);
    expect(at({ ...RULES, windowRule: undefined })).toBe(old);
    expect(at({ ...RULES, windowRule: 'START' })).not.toBe(old);
    expect(at({ ...RULES, windowRule: 'FINISH' })).not.toBe(old);
    expect(at({ ...RULES, windowRule: 'START' })).not.toBe(at({ ...RULES, windowRule: 'FINISH' }));
  });
});

describe('"rules not applied": only when the asked rule was not echoed', () => {
  const inputs = (window_rule?: string) => ({
    v: 1, jobId: null, capturedAt: '', depot: { id: 'd', lat: 0, lng: 0, openMin: 0, closeMin: 1440 }, trucks: {}, stops: {},
    config: window_rule ? { window_rule } : {},
  });
  it('START asked: no note when echoed, or when an older planner sent no echo (it plans START anyway)', () => {
    expect(plannerRulesNote({ inputs: inputs('START'), window_rule: 'START' })).toBeNull();
    expect(plannerRulesNote({ inputs: inputs('START') })).toBeNull();
  });
  it('START asked but FINISH echoed: a note in the rule’s words', () => {
    expect(plannerRulesNote({ inputs: inputs('START'), window_rule: 'FINISH' })).toContain('that the end of the receiving hours is the latest arrival');
  });
  it('FINISH asked: a note unless FINISH was echoed (as before)', () => {
    expect(plannerRulesNote({ inputs: inputs('FINISH'), window_rule: 'FINISH' })).toBeNull();
    expect(plannerRulesNote({ inputs: inputs('FINISH'), window_rule: 'START' })).toContain('that unloading must be finished by closing');
    expect(plannerRulesNote({ inputs: inputs('FINISH') })).toContain('that unloading must be finished by closing');
    expect(plannerRulesNote({ inputs: inputs() })).toBeNull();
  });
});

describe('the texts follow the rule', () => {
  const row = (cfg: TenantPlannerConfig, label: string) => effectivePlannerValues(cfg, 'OM', 'OMR').find((r) => r.label === label)!;

  it('Effective planner values: the receiving-hours row is a setting, worded by the rule', () => {
    expect(row(TENANT, 'Receiving hours')).toMatchObject({ value: 'unloading must be finished by the end of the receiving hours', source: 'SETTING' });
    expect(row(TENANT, 'Receiving hours').note).toMatch(/longer than its receiving hours cannot be planned/);
    const start = row({ ...TENANT, windowRule: 'START' }, 'Receiving hours');
    expect(start).toMatchObject({ value: windowRuleText('START'), source: 'SETTING' });
    expect(start.value).toMatch(/latest arrival/);
    expect(start.note).toMatch(/13:50 for a 14:00 close/);
    expect(row(TENANT, 'Preferred-window penalty').note).toMatch(/finishes after the preferred end/);
    expect(row({ ...TENANT, windowRule: 'START' }, 'Preferred-window penalty').note).toMatch(/starts after the preferred end/);
  });

  it('ASSUMPTIONS says the rule the optimizer echoed for the plan in use, never the setting', () => {
    const cfg = {
      timezone: 'Asia/Muscat', planningCutoffMin: 1080, shiftStartMin: 360, driverShiftMaxMinutes: 540, reloadMinutes: 30,
      maxTripsPerTruck: 3, fuelPricePerLitre: 0, driverCostPerHour: 1.5, overtimeAfterMin: 540, overtimeCostPerHour: 0,
      prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, distanceProvider: 'OSRM', distanceMultiplier: 1.3, avgSpeedKmh: 40,
      defaultServiceTimeMin: 10, osrmUrl: null, priorityWeightsJson: null,
    };
    const hours = (windowRule: 'START' | 'FINISH' | null) => {
      const solver = solverRules({ scenarios: [{ chosen: true, weightUnitKg: 0.1, newOvertimeOnly: true, windowRule }] } as never);
      return tenantAssumptions(cfg, { currency: 'OMR', providerUsed: 'OSRM', distanceIsEstimated: false, solverRules: solver })['Receiving hours'];
    };
    expect(hours('FINISH')).toBe('unloading must be finished by the end of the receiving hours');
    expect(hours('START')).toBe('the end of the receiving hours is the latest arrival: unloading must start by then and may continue after it');
    expect(hours(null)).toBe('earlier rule: unloading had to start by closing and could run past it');
  });
});
