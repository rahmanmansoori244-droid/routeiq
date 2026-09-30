/**
 * Planning rules, phase B (owner decisions 29-30 Sep 2026): the driver break.
 * - one break per truck-day, STARTING inside the window (12:00-14:00 by default), at the depot
 *   between loads (it may overlap the reload) or on the road between two unloadings; none for a
 *   truck-day back for good by the window's end or first leaving at its start or later - decided
 *   by TIMES, never by load status;
 * - the rule each load was planned with comes ONLY from the solver's echo (PlanRules.break); a
 *   load planned before the rule is never blocked after the fact;
 * - a missing break blocks Lock / Loading / Dispatch (no override), with the unlock remedy on a
 *   locked load; a load already on the road only warns;
 * - the dispatcher edits the break on Settings (length and window); settings that cannot work are
 *   refused on save.
 */
import { describe, expect, it } from 'vitest';
import type { FeasibilityReport } from '@routeiq/shared-types';
import { breakProblem, checkPlanFeasibility, inputHash, type FeasLoad } from '@/lib/dispatch/feasibility';
import { loadBreakJson, parseLoadBreak, rulesFrom, type LoadBreak, type PlanRules } from '@/lib/dispatch/snapshots';
import { dispatchConfigFromTenant, plannerSettingProblems, type TenantPlannerConfig } from '@/lib/dispatch/planner-config';
import { plannerRulesNote } from '@/lib/dispatch/plan-detail';
import { whatsappText } from '@/lib/dispatch/driver-links';
import { breakLine } from '@/lib/dispatch/break-text';
import { breakSaveProblem, DISPATCHER_SETTINGS_FIELDS, SETTINGS_FIELDS } from '@/lib/settings-fields';

const BREAK = { lengthMin: 60, startFromMin: 720, startToMin: 840 };
const RULES: PlanRules = {
  shiftStartMin: 420, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0, maxTrips: 3,
  depotOpenMin: 300, depotCloseMin: 1380, availableFromMin: null, availableToMin: null, break: BREAK,
};
const VERIFIED: FeasibilityReport = { status: 'VERIFIED', timing: 'EXACT', violations: [] };
const brk = (startMin: number, where: 'DEPOT' | 'ROAD', afterSequence: number | null = null): LoadBreak => ({
  v: 1, startMin, endMin: startMin + 60, lengthMin: 60, where, afterSequence,
});

/** A load with two stops; times in minutes. */
function load(id: string, loadNo: number, depart: number, ret: number, over: Partial<FeasLoad> = {}): FeasLoad {
  return {
    id, truckId: 't1', truckCode: 'T01', loadNo, onRoad: false, departMin: depart, returnMin: ret, cases: 20, weightKg: 200,
    capacity: { cases: 100, kg: 1000 }, rules: RULES,
    stops: [
      { orderId: `${id}a`, sequence: 1, label: 'A', cases: 10, kg: 100, kgUnknown: false, etaMin: depart + 60, serviceStartMin: depart + 60, departureMin: depart + 90, hardWindowOk: true },
      { orderId: `${id}b`, sequence: 2, label: 'B', cases: 10, kg: 100, kgUnknown: false, etaMin: ret - 90, serviceStartMin: ret - 90, departureMin: ret - 60, hardWindowOk: true },
    ],
    ...over,
  };
}
const gate = (loads: FeasLoad[]) => checkPlanFeasibility({ scenarioId: 'sc1', solver: VERIFIED, loads });
const breaks = (loads: FeasLoad[]) => gate(loads).violations.filter((v) => v.code === 'BREAK');

describe('driver break: when a truck-day needs one (times, never load status)', () => {
  it('a day 07:00-16:00 with no break is blocked on its planned load, in plain words', () => {
    const v = breaks([load('L1', 1, 420, 960)]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ severity: 'BLOCK', loadNo: 1 });
    expect(v[0].message).toBe('T01 works 07:00-16:00 through midday without the 60-min driver break (to start between 12:00 and 14:00). Re-plan to add it.');
  });

  it('no break is needed when back for good by 14:00, or first leaving at 12:00 or later (owner: 12:00-13:00 too)', () => {
    expect(breaks([load('L1', 1, 420, 840)])).toEqual([]);
    expect(breaks([load('L1', 1, 720, 1080)])).toEqual([]);
    expect(breaks([load('L1', 1, 750, 1080)])).toEqual([]);
  });

  it('a truck whose locked load leaves at 13:30 is never blocked, however it was locked', () => {
    expect(breaks([load('L1', 1, 810, 960, { frozen: true, rules: { ...RULES } }), load('L2', 2, 1000, 1080)])).toEqual([]);
  });
});

describe('driver break: what holds it', () => {
  it('a recorded ROAD break between two unloadings, inside the window', () => {
    const l = load('L1', 1, 420, 960, { break: brk(825, 'ROAD', 1) });
    // stop 1 done 08:30, stop 2 served 14:30 -> a break 13:45-14:45 overlaps its unloading
    expect(breaks([l])[0].message).toContain('overlaps unloading');
    const ok = load('L1', 1, 420, 960, { break: brk(720, 'ROAD', 1) });
    expect(breaks([ok])).toEqual([]);
  });

  it('a recorded DEPOT break during the reload before load 2', () => {
    const l1 = load('L1', 1, 420, 710);
    const l2 = load('L2', 2, 780, 1000, { break: brk(720, 'DEPOT') });
    expect(breaks([l1, l2])).toEqual([]);
    const late = load('L2', 2, 770, 1000, { break: brk(720, 'DEPOT') }); // leaves before the break ends
    expect(breaks([l1, late])[0].message).toContain('at the depot does not fit');
  });

  it('a break outside the window is refused', () => {
    expect(breaks([load('L1', 1, 420, 960, { break: brk(660, 'ROAD', 1) })])[0].message).toContain('is not a 60-min break to start between 12:00 and 14:00');
  });

  it('an undeclared depot gap of an hour that starts in the window (11:30-13:00 counts from 12:00)', () => {
    expect(breaks([load('L1', 1, 420, 690), load('L2', 2, 780, 1000)])).toEqual([]);
  });

  it('idle time before a plan does not count: a gap before a load planned later counts from then', () => {
    const later = { ...RULES, loadingFromMin: 750 }; // load 2 planned at 12:30: the gap counts from 12:30
    expect(breaks([load('L1', 1, 420, 690), load('L2', 2, 800, 1000, { rules: later })])).toHaveLength(1);
    expect(breaks([load('L1', 1, 420, 690), load('L2', 2, 815, 1000, { rules: later })])).toEqual([]);
  });
});

describe('driver break: who is blocked (precedence, review FIX 3)', () => {
  it('a load planned before the rule (its own rules have no break) only warns, locked or not', () => {
    const old = { ...RULES };
    delete old.break;
    for (const frozen of [false, true]) {
      const v = breaks([load('L1', 1, 420, 960, { rules: old, frozen }), load('L2', 2, 1000, 1080)]);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ severity: 'WARN', loadNo: 1 });
      expect(v[0].message).toContain('planned before the driver break rule');
    }
  });

  it('a locked load under the rule is flagged frozen (unlock first); a load on the road only warns', () => {
    expect(breaks([load('L1', 1, 420, 960, { frozen: true })])[0]).toMatchObject({ severity: 'BLOCK', frozen: true });
    expect(breaks([load('L1', 1, 420, 960, { onRoad: true })])[0]).toMatchObject({ severity: 'WARN' });
  });

  it('the missing break goes on the latest planned load out during the window', () => {
    const p = breakProblem([load('L1', 1, 420, 700, { frozen: true }), load('L2', 2, 730, 1000)]);
    expect(p?.target.id).toBe('L2');
  });
});

describe('driver break: rules and hashes come from the echo only', () => {
  const cfg = { shift_start_min: 420, shift_max_min: 660, reload_min: 30, loading_min_per_case: 0, max_trips_per_truck: 3 };
  it('rulesFrom sets break only from the solver echo', () => {
    expect(rulesFrom(cfg, {}, {}, { break_rule: { length_min: 60, start_from_min: 720, start_to_min: 840 } }).break).toEqual(BREAK);
    expect('break' in rulesFrom(cfg, {}, {}, null)).toBe(false);
    expect('break' in rulesFrom({ ...cfg, break_min: 60 } as typeof cfg, {}, {}, {})).toBe(false);
  });

  it('inputHash changes with the break rule and a load break, and is unchanged without them', () => {
    const old = { ...RULES };
    delete old.break;
    const base = { scenarioId: 's', solver: VERIFIED, loads: [load('L1', 1, 420, 800, { rules: old })] };
    const copy = { ...base, loads: [load('L1', 1, 420, 800, { rules: { ...old } })] };
    expect(inputHash(copy)).toBe(inputHash(base));
    expect(inputHash({ ...base, loads: [load('L1', 1, 420, 800)] })).not.toBe(inputHash(base));
    expect(inputHash({ ...base, loads: [load('L1', 1, 420, 800, { rules: old, break: brk(720, 'ROAD', 1) })] })).not.toBe(inputHash(base));
  });

  it('breakJson round-trips; a mixed-deploy plan says the break was missing', () => {
    const j = loadBreakJson({ start_min: 750, end_min: 810, where: 'ROAD', after_sequence: 3 });
    expect(j).toEqual({ v: 1, startMin: 750, endMin: 810, lengthMin: 60, where: 'ROAD', afterSequence: 3 });
    expect(parseLoadBreak(j)).toEqual(j);
    expect(parseLoadBreak(null)).toBeNull();
    expect(loadBreakJson(null)).toBeNull();
    const inputs = { v: 1, config: { break_min: 60 }, stops: {}, trucks: {} };
    expect(plannerRulesNote({ inputs })).toContain('the driver break');
    expect(plannerRulesNote({ inputs, break_rule: { length_min: 60 } })).toBeNull();
  });
});

describe('driver break: settings and request', () => {
  const tenant = {
    shiftStartMin: 420, driverShiftMaxMinutes: 660, overtimeAfterMin: 540, overtimeCostPerHour: 0, driverBreakMinutes: 60,
    driverBreakFromMin: 720, driverBreakToMin: 840, reloadMinutes: 30, loadingMinPerCase: 0, serviceMinPerCase: 0,
    maxTripsPerTruck: 3, splitDeliveries: true, defaultServiceTimeMin: 10, fuelPricePerLitre: 0, driverCostPerHour: 0,
    prefWindowPenaltyPerMin: 0.05, priorityWeightsJson: null, distanceProvider: 'HAVERSINE', osrmUrl: null, distanceMultiplier: 1.3,
    avgSpeedKmh: 40, roadTimeFactor: 1.25, timezone: 'Asia/Muscat', planningCutoffMin: 1080, dateOrder: 'DMY',
  } satisfies TenantPlannerConfig;

  it('the request carries the break; the dispatcher may edit it', () => {
    const { config } = dispatchConfigFromTenant(tenant, 'Oman', ['RECOMMENDED']);
    expect(config).toMatchObject({ break_min: 60, break_start_from_min: 720, break_start_to_min: 840, window_rule: 'FINISH' });
    for (const k of ['driverBreakMinutes', 'driverBreakFromMin', 'driverBreakToMin'] as const) {
      expect(SETTINGS_FIELDS).toContain(k);
      expect(DISPATCHER_SETTINGS_FIELDS).toContain(k);
    }
  });

  it('settings that cannot work are refused on save and warned about when stored', () => {
    const m = { driverBreakMinutes: 60, driverBreakFromMin: 900, driverBreakToMin: 840, driverShiftMaxMinutes: 660 };
    expect(breakSaveProblem({ driverBreakFromMin: 900 }, m)).toContain('after its latest start');
    expect(breakSaveProblem({ driverBreakMinutes: 700 }, { ...m, driverBreakFromMin: 720, driverBreakMinutes: 700 })).toContain('shorter than the driver shift maximum');
    expect(breakSaveProblem({ overtimeAfterMin: 1 }, m)).toBeNull(); // another field saves
    expect(breakSaveProblem({ driverBreakMinutes: 0 }, { ...m, driverBreakMinutes: 0 })).toBeNull(); // 0 = no break
    expect(plannerSettingProblems({ ...tenant, driverBreakFromMin: 900 }).warnings.join(' ')).toContain('no break is planned');
  });
});

describe('driver break: what the driver reads', () => {
  it('WhatsApp: unloading until, and the break line where it is taken', () => {
    const stops = [1, 2, 3].map((n) => ({
      sequence: n, etaMin: 480 + n * 60, departureMin: 500 + n * 60, customerName: `C${n}`, customerCode: `C${n}`, branchCode: null,
      cases: 10, lat: 23.6, lng: 58.4, split: null,
    }));
    const plan = { runDate: '2026-10-02', version: 2, status: 'APPLIED', supersededAt: null, depot: { lat: 23.58, lng: 58.39 } };
    const text = whatsappText(plan as never, { truckCode: 'T01', loadNo: 1, departMin: 420, returnMin: 900, cases: 30, stops, break: brk(760, 'ROAD', 2) }, 1);
    const lines = text.split('\n');
    const i = lines.findIndex((x) => x.startsWith('2. '));
    expect(lines[i]).toContain('10:00 (unload until 10:20)');
    expect(lines.slice(i).find((x) => x.startsWith('Break'))).toBe('Break 12:40-13:40 between stop 2 and stop 3');
    expect(breakLine(brk(720, 'DEPOT'), 3)).toBe('Break 12:00-13:00 at the depot before leaving (loading continues meanwhile)');
    expect(breakLine(brk(720, 'ROAD', 3), 3)).toBe('Break 12:00-13:00 on the way back to the depot');
  });
});

describe('driver break: the gate reads the break position by STOP, not by order row (review)', () => {
  // Stop 1 holds two orders (one row each, same sequence), stop 2 one order.
  const twoOrderStop = (over: Partial<FeasLoad>, s1: [number, number, number], s2: [number, number]) =>
    load('L1', 1, 420, 960, {
      stops: [
        { orderId: 'oA', sequence: 1, label: 'A', cases: 5, kg: 50, kgUnknown: false, etaMin: s1[0], serviceStartMin: s1[0], departureMin: s1[1], hardWindowOk: true },
        { orderId: 'oB', sequence: 1, label: 'A', cases: 5, kg: 50, kgUnknown: false, etaMin: s1[1], serviceStartMin: s1[1], departureMin: s1[2], hardWindowOk: true },
        { orderId: 'oC', sequence: 2, label: 'C', cases: 10, kg: 100, kgUnknown: false, etaMin: s2[0], serviceStartMin: s2[0], departureMin: s2[1], hardWindowOk: true },
      ],
      ...over,
    });

  it('a road break between stop 1 (two orders, 11:40-12:25) and stop 2 (13:50) is accepted', () => {
    expect(breaks([twoOrderStop({ break: brk(750, 'ROAD', 1) }, [700, 720, 745], [830, 860])])).toEqual([]);
  });

  it('a break that starts before the second order of stop 1 is unloaded still overlaps unloading', () => {
    expect(breaks([twoOrderStop({ break: brk(740, 'ROAD', 1) }, [700, 720, 745], [830, 860])])[0].message).toContain('overlaps unloading');
  });

  it('a road break on the way back after the last stop is accepted', () => {
    expect(breaks([twoOrderStop({ break: brk(720, 'ROAD', 2) }, [600, 620, 650], [680, 710])])).toEqual([]);
  });
});

describe('driver break: loads the solver could not give a break never block a new load (review)', () => {
  const old = (): PlanRules => {
    const r = { ...RULES };
    delete r.break;
    return r;
  };

  it('a pre-rule locked load back at 14:10, then a load leaving before 15:00: a warning, no block', () => {
    const loads = [load('L1', 1, 420, 850, { rules: old(), frozen: true }), load('L2', 2, 880, 1020)];
    const v = breaks(loads);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ severity: 'WARN', loadNo: 1 });
    expect(breakProblem(loads)?.target.id).toBe('L1');
    expect(gate(loads).ok).toBe(true);
  });

  it('a load locked under a 12:00-14:00 window, back 13:55, after the window was cut to 13:30: a warning, no block', () => {
    const cut = { ...RULES, break: { ...BREAK, startToMin: 810 } };
    for (const depart of [865, 900]) {
      const loads = [load('L1', 1, 420, 835, { frozen: true }), load('L2', 2, depart, 1020, { rules: cut })];
      const v = breaks(loads);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ severity: 'WARN', loadNo: 1 });
      expect(v[0].message).toContain('no break can be added now');
      expect(gate(loads).ok).toBe(true);
    }
  });

  it('a load locked under the rule that itself needed a break and has none still asks to unlock it', () => {
    const v = breaks([load('L1', 1, 420, 960, { frozen: true }), load('L2', 2, 1000, 1080)]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ severity: 'BLOCK', loadNo: 1, frozen: true });
  });
});

describe('latest return: 18:00 whenever the truck leaves (owner, review)', () => {
  const cfg = { shift_start_min: 420, shift_max_min: 660, reload_min: 30, loading_min_per_case: 0, max_trips_per_truck: 3 };
  it('the request carries the tenant first departure + shift maximum; the rules take it from the echo only', () => {
    const tenant = {
      shiftStartMin: 420, driverShiftMaxMinutes: 660, overtimeAfterMin: 540, overtimeCostPerHour: 0, driverBreakMinutes: 60,
      driverBreakFromMin: 720, driverBreakToMin: 840, reloadMinutes: 30, loadingMinPerCase: 0, serviceMinPerCase: 0,
      maxTripsPerTruck: 3, splitDeliveries: true, defaultServiceTimeMin: 10, fuelPricePerLitre: 0, driverCostPerHour: 0,
      prefWindowPenaltyPerMin: 0.05, priorityWeightsJson: null, distanceProvider: 'HAVERSINE', osrmUrl: null, distanceMultiplier: 1.3,
      avgSpeedKmh: 40, roadTimeFactor: 1.25, timezone: 'Asia/Muscat', planningCutoffMin: 1080, dateOrder: 'DMY',
    } satisfies TenantPlannerConfig;
    expect(dispatchConfigFromTenant(tenant, 'Oman', ['RECOMMENDED']).config.latest_return_min).toBe(1080);
    expect(rulesFrom(cfg, {}, {}, { latest_return_min: 1080 }).latestReturnMin).toBe(1080);
    expect('latestReturnMin' in rulesFrom(cfg, {}, {}, {})).toBe(false);
  });

  it('a load back after the latest return it was planned with is blocked; one planned without it is not', () => {
    const late = (rules: PlanRules) => gate([load('L1', 1, 750, 1110, { rules })]).violations.filter((v) => v.code === 'SHIFT_LIMIT');
    const v = late({ ...RULES, latestReturnMin: 1080 });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ severity: 'BLOCK', shortBy: 30 });
    expect(v[0].message).toBe('T01 load 1 is back at 18:30, after the latest return (18:00).');
    expect(late(RULES)).toEqual([]);
  });
});
