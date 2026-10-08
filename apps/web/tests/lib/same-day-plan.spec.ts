/**
 * Stabilization PR8 - same-day planning starts from now (scenario finding S04 / N2: a late order
 * re-planned at 09:00 for TODAY was put on trucks leaving at 06:00, before the order existed).
 *
 * - sameDayPlanFrom (pure): only a plan built on its own delivery day, in the company's timezone,
 *   starts from now + preparation (the turnaround between loads); a future day never changes;
 * - the real buildDispatchRequest against a fake database, with the clock fixed: a same-day
 *   re-plan at 09:00 sends 09:30 as the day's first departure, says so in the plan warnings and
 *   keeps it with the plan's settings (ASSUMPTIONS); the next day's plan is byte-for-byte what it
 *   was; locked / dispatched loads are sent unchanged, and no truck's own availability is touched;
 * - the timetable rules the new plan's loads are timed with (the solver's truck-day rules, also the
 *   web's dispatch gate): no new load before 09:30, a truck back at 09:57 still needs its turnaround,
 *   and the dispatched 06:00 load is not reported.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ prisma: {} as Record<string, any>, tdb: {} as Record<string, any> }));
vi.mock('@/lib/db', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => (k === 'then' ? undefined : fake.prisma[k]) }) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => fake.tdb }));

import { buildDispatchRequest, planInputsOf, retimeSameDay } from '@/lib/dispatch/plan-service';
import { fmtPlanTime, planFromAssumption, planFromWarning, sameDayPlanFrom } from '@/lib/dispatch/plan-from';
import { checkPlanFeasibility, type FeasLoad } from '@/lib/dispatch/feasibility';
import { rulesFrom, type PlanRules } from '@/lib/dispatch/snapshots';
import { tenantAssumptions } from '@/lib/dispatch/workbook';
import { effectivePlannerValues } from '@/lib/dispatch/planner-config';

const DAY = '2026-10-05';
/** 09:00 in Muscat (UTC+4) on the delivery day. */
const AT_0900 = new Date(`${DAY}T05:00:00Z`);
/** 09:00 the day before (a normal next-day plan). */
const DAY_BEFORE_0900 = new Date('2026-10-04T05:00:00Z');

const CFG: Record<string, any> = {
  avgSpeedKmh: 40, distanceProvider: 'HAVERSINE', distanceMultiplier: 1.3, driverShiftMaxMinutes: 660, shiftStartMin: 360,
  reloadMinutes: 30, loadingMinPerCase: 0.04, serviceMinPerCase: 0, maxTripsPerTruck: 3, splitDeliveries: true,
  defaultServiceTimeMin: 10, timezone: 'Asia/Muscat', planningCutoffMin: 1080, fuelPricePerLitre: 0.26, driverCostPerHour: 2.5,
  overtimeAfterMin: 540, overtimeCostPerHour: 4, prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, osrmUrl: null,
  priorityWeightsJson: null, orderColumnMapJson: null, dateOrder: 'DMY', serviceAreaJson: null,
};
const DEPOT = { id: 'D1', lat: 22.93, lng: 57.53, openMin: null as number | null, closeMin: null as number | null };
const truck = (id: string) => ({
  id, code: id, capacityCases: 800, capacityWeightKg: 9000, fixedCostPerDay: 25, tripCost: 0, costPerKm: 0.12,
  kmPerLitre: null, availableFromMin: null, availableToMin: null, maxTripsPerDay: null,
});

function customer(id: string, lat: number, lng: number) {
  return {
    id, code: id, branchCode: null, name: id, lat, lng, priority: 3, priorityConfirmed: false, avgServiceTimeMin: 10, serviceTimeConfirmed: false,
    customerType: null, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, locationVerified: true,
    createdFromUpload: false, active: true,
  };
}
function order(id: string, cust: ReturnType<typeof customer>, cases: number, isLate = false) {
  return {
    id, customerId: cust.id, customer: cust, totalCases: cases, totalWeightKg: cases * 10, priority: 3, priorityFromFile: false, isLate,
    salesValue: null, marginValue: null, status: 'NEW',
    lines: [{ id: `${id}-l1`, cases, weightKg: cases * 10, weightFromMaster: false, salesValue: null, marginValue: null, product: { code: 'P', name: 'P', weightPerCaseKg: 10, active: true } }],
  };
}

const C0 = customer('C0', 22.95, 57.55);
const C1 = customer('C1', 22.97, 57.5);
const C2 = customer('C2', 22.9, 57.6);
/** T1's first load: dispatched at 06:00, back at 09:57 (the scenario report's S04b). */
const DISPATCHED = { id: 'L-T1-1', truckId: 'T1', loadNo: 1, status: 'DISPATCHED', departMin: 360, returnMin: 597, cases: 90, assignments: [{ orderId: 'O0', portionLinesJson: null }] };

function wire(opts: { frozen?: unknown[]; cfg?: Record<string, any>; depot?: Partial<typeof DEPOT> } = {}) {
  fake.tdb.runPlan = {
    findUniqueOrThrow: async () => ({ id: 'R2', depotId: 'D1', runDate: new Date(`${DAY}T00:00:00Z`), parentRunId: 'R1', reason: 'LATE_ORDER', depot: { ...DEPOT, ...opts.depot } }),
  };
  fake.tdb.tenantConfig = { findUniqueOrThrow: async () => ({ ...CFG, ...opts.cfg }) };
  fake.tdb.customerTypeProfile = { findMany: async () => [] };
  fake.tdb.planLoad = { findMany: async () => opts.frozen ?? [DISPATCHED] };
  fake.tdb.truck = { findMany: async () => [truck('T1'), truck('T2')] };
  fake.prisma.tenant = { findUniqueOrThrow: async () => ({ country: 'Oman' }) };
  fake.prisma.depot = { count: async () => 1 };
  fake.prisma.order = { findMany: async () => [order('O0', C0, 90), order('O1', C1, 50), order('O2', C2, 60, true)] };
  fake.prisma.routeAssignment = { findMany: async () => [] };
  // No other depot has a plan this day (buildDispatchRequest reads them: cross-depot.ts).
  fake.prisma.runPlan = { findMany: async () => [] };
}

beforeEach(() => wire());

describe('sameDayPlanFrom: when a plan starts from now', () => {
  const base = { runDateIso: DAY, timezone: 'Asia/Muscat', firstDepartureMin: 360, prepMin: 30 };

  it('a plan made at 09:00 on its delivery day starts at 09:30 (now + the 30 min turnaround)', () => {
    expect(sameDayPlanFrom(base, AT_0900)).toEqual({ nowMin: 540, prepMin: 30, fromMin: 570 });
  });

  it('a plan for another day is never changed: the next day, or a past day', () => {
    expect(sameDayPlanFrom(base, DAY_BEFORE_0900)).toBeNull();
    expect(sameDayPlanFrom(base, new Date('2026-10-06T05:00:00Z'))).toBeNull();
  });

  it('nothing changes while now + preparation is not after the first departure (or a later depot opening)', () => {
    expect(sameDayPlanFrom(base, new Date(`${DAY}T01:00:00Z`))).toBeNull(); // 05:00 + 30 min = 05:30 < 06:00
    expect(sameDayPlanFrom(base, new Date(`${DAY}T01:30:00Z`))).toBeNull(); // 05:30 + 30 min = 06:00 exactly
    expect(sameDayPlanFrom({ ...base, firstDepartureMin: 600 }, AT_0900)).toBeNull(); // the depot opens at 10:00
    expect(sameDayPlanFrom(base, new Date(`${DAY}T01:31:00Z`))).toEqual({ nowMin: 331, prepMin: 30, fromMin: 361 });
  });

  it('"today" is the company\'s day, not the server\'s (UTC): 21:30 UTC on the 4th is 01:30 on the 5th in Muscat', () => {
    expect(sameDayPlanFrom({ ...base, firstDepartureMin: 0 }, new Date('2026-10-04T21:30:00Z'))).toEqual({ nowMin: 90, prepMin: 30, fromMin: 120 });
    expect(sameDayPlanFrom({ ...base, runDateIso: '2026-10-04', firstDepartureMin: 0 }, new Date('2026-10-04T21:30:00Z'))).toBeNull();
  });

  it('uses the company timezone, and Asia/Muscat when it is empty or unknown', () => {
    expect(sameDayPlanFrom({ ...base, timezone: 'Asia/Kolkata' }, AT_0900)).toEqual({ nowMin: 630, prepMin: 30, fromMin: 660 }); // 10:30 IST
    expect(sameDayPlanFrom({ ...base, timezone: 'Not/AZone' }, AT_0900)?.fromMin).toBe(570);
    expect(sameDayPlanFrom({ ...base, timezone: '' }, AT_0900)?.fromMin).toBe(570);
  });

  it('late in the evening it ends at 24:00 of the delivery day, and the warning says nothing can leave any more', () => {
    const p = sameDayPlanFrom(base, new Date(`${DAY}T19:45:00Z`))!; // 23:45
    expect(p).toEqual({ nowMin: 1425, prepMin: 30, fromMin: 1440 });
    expect(fmtPlanTime(p.fromMin)).toBe('24:00');
    expect(planFromWarning(p)).toBe(
      'Planned from 24:00 (now 23:45 + 30 min preparation): the plan is for today, so no new load leaves the depot before 24:00. The depot closes at 24:00, so no new load can leave today: open orders stay unserved.',
    );
    expect(planFromWarning({ nowMin: 1300, prepMin: 30, fromMin: 1330 }, 1320)).toMatch(/The depot closes at 22:00, so no new load can leave today/);
  });

  it('says it plainly: "Planned from 09:30 (now 09:00 + 30 min preparation)"', () => {
    const p = sameDayPlanFrom(base, AT_0900)!;
    expect(planFromWarning(p, 1380)).toBe(
      'Planned from 09:30 (now 09:00 + 30 min preparation): the plan is for today, so no new load leaves the depot before 09:30. Locked, loading and dispatched loads keep their times; a truck still out leaves again only after it is back and turned around.',
    );
    expect(planFromAssumption(p)).toBe(
      '09:30 - planned on the delivery day at 09:00: no new load leaves before now + 30 min preparation (the turnaround between loads). Locked, loading and dispatched loads keep their times.',
    );
  });
});

describe('buildDispatchRequest: a same-day re-plan starts from now', () => {
  it('a late-order re-plan at 09:00 for today sends 09:30 as the first departure and says so', async () => {
    const b = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0900 });
    expect(b.request.config.shift_start_min).toBe(570);
    expect(b.warnings[0]).toMatch(/^Planned from 09:30 \(now 09:00 \+ 30 min preparation\): the plan is for today/);
    // Kept with the plan: the setting stays the setting, the start is recorded next to it.
    expect(b.settings?.shiftStartMin).toBe(360);
    expect(b.settings?.planFrom).toEqual({ nowMin: 540, prepMin: 30, fromMin: 570 });
    const inputs = planInputsOf(b, 'job-1', AT_0900)!;
    expect(inputs.config.shift_start_min).toBe(570);
    expect(inputs.settings?.planFrom?.fromMin).toBe(570);
  });

  it('the preparation time follows the turnaround setting, and a later depot opening wins', async () => {
    wire({ cfg: { reloadMinutes: 45 } });
    expect((await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0900 })).request.config.shift_start_min).toBe(585);
    wire({ depot: { openMin: 600 } });
    const b = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0900 });
    expect(b.request.config.shift_start_min).toBe(360); // the depot opens at 10:00: nothing to move
    expect(b.warnings.some((w) => w.startsWith('Planned from'))).toBe(false);
  });

  it('a plan for the next day is exactly what it was (the clock does not matter)', async () => {
    const nextDay = await buildDispatchRequest('TEN', 'R2', undefined, { now: DAY_BEFORE_0900 });
    const weekBefore = await buildDispatchRequest('TEN', 'R2', undefined, { now: new Date('2026-09-28T05:00:00Z') });
    expect(nextDay.request.config.shift_start_min).toBe(360);
    expect(nextDay.warnings.some((w) => w.startsWith('Planned from'))).toBe(false);
    expect(nextDay.settings?.planFrom).toBeNull();
    expect(JSON.stringify({ r: nextDay.request, w: nextDay.warnings, s: nextDay.settings })).toBe(
      JSON.stringify({ r: weekBefore.request, w: weekBefore.warnings, s: weekBefore.settings }),
    );
  });

  it('locked / dispatched loads are sent unchanged, and no truck availability is overwritten', async () => {
    const sameDay = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0900 });
    const nextDay = await buildDispatchRequest('TEN', 'R2', undefined, { now: DAY_BEFORE_0900 });
    for (const b of [sameDay, nextDay]) {
      const t1 = b.request.trucks.find((t) => t.id === 'T1')!;
      expect(t1.frozen_trips).toEqual([{ load_no: 1, depart_min: 360, return_min: 597, cases: 90 }]);
      expect(b.request.trucks.map((t) => [t.available_from_min, t.available_to_min])).toEqual([[null, null], [null, null]]);
      expect(b.scope.frozenOrderIds).toContain('O0');
      expect(b.request.stops.flatMap((s) => s.order_ids)).not.toContain('O0');
    }
    // Apart from the first departure, the time the plan was made (PR8 review) and the warning, the
    // two requests are the same.
    expect(sameDay.request.config.loading_from_min).toBe(540);
    expect('loading_from_min' in nextDay.request.config).toBe(false);
    const strip = (b: typeof sameDay) => JSON.stringify({ ...b.request, config: { ...b.request.config, shift_start_min: 0, loading_from_min: undefined } });
    expect(strip(sameDay)).toBe(strip(nextDay));
  });
});

describe('the timetable rules of a same-day plan (the optimizer\'s truck day, and the dispatch gate)', () => {
  const stopAt = (orderId: string, cases: number, at: number) => ({
    orderId, sequence: 1, label: orderId, cases, kg: cases * 10, kgUnknown: false, etaMin: at, serviceStartMin: at, departureMin: at + 10, hardWindowOk: true,
    hardStartMin: null, hardEndMin: null,
  });
  const feasLoad = (id: string, truckId: string, loadNo: number, depart: number, cases: number, rules: PlanRules, over: Partial<FeasLoad> = {}): FeasLoad => ({
    id, truckId, truckCode: truckId, loadNo, onRoad: false, departMin: depart, returnMin: depart + 90, cases, weightKg: cases * 10,
    capacity: { cases: 800, kg: 9000 }, rules, stops: [stopAt(`${id}-o`, cases, depart + 30)], ...over,
  });

  async function rulesOf(now: Date) {
    const b = await buildDispatchRequest('TEN', 'R2', undefined, { now });
    return rulesFrom(b.request.config, b.request.depot, { availableFromMin: null, availableToMin: null, maxTripsPerDay: null });
  }

  it('no new load before 09:30; T1, back at 09:57, still needs its turnaround; its 06:00 dispatched load is not reported', async () => {
    const newRules = await rulesOf(AT_0900);
    const earlier = await rulesOf(DAY_BEFORE_0900); // what the dispatched load was planned with
    expect(newRules.shiftStartMin).toBe(570);
    const dispatched = feasLoad('T1-L1', 'T1', 1, 360, 90, earlier, { onRoad: true, returnMin: 597 });
    // T1 L2 at 10:10: 09:57 + 30 min turnaround + 0.04 x 50 cases = 10:29. T2 L1 at 09:00: before
    // 09:30, and (PR8 review) before its 60 cases can be loaded from 09:00: 09:00 + 30 + 2.4 = 09:32.
    const tooEarly = checkPlanFeasibility({
      scenarioId: 's', solver: null,
      loads: [dispatched, feasLoad('T1-L2', 'T1', 2, 610, 50, newRules), feasLoad('T2-L1', 'T2', 1, 540, 60, newRules)],
    });
    expect(tooEarly.violations.map((v) => [v.truckCode, v.loadNo, v.code])).toEqual([
      ['T1', 2, 'TURNAROUND'],
      ['T2', 1, 'TURNAROUND'],
    ]);
    expect(tooEarly.violations[0].message).toContain('ready 10:29');
    expect(tooEarly.violations[1].message).toContain('ready 09:32');
    // Only before 09:30 (a later depot opening, no loading per case): the early departure itself.
    const noLoading = { ...newRules, loadingMinPerCase: 0 };
    const early = checkPlanFeasibility({ scenarioId: 's', solver: null, loads: [feasLoad('T2-L1', 'T2', 1, 540, 60, noLoading)] });
    expect(early.violations.map((v) => [v.code, v.message])).toEqual([['EARLY_DEPARTURE', 'T2 load 1 leaves at 09:00, before the shift start (09:30).']]);
    // At 10:29 and 09:33 every rule holds, and the 06:00 dispatched load is not an early departure.
    const onTime = checkPlanFeasibility({
      scenarioId: 's', solver: null,
      loads: [dispatched, feasLoad('T1-L2', 'T1', 2, 629, 50, newRules), feasLoad('T2-L1', 'T2', 1, 573, 60, newRules)],
    });
    expect(onTime.violations).toEqual([]);
    expect(onTime.ok).toBe(true);
  });

  it('PR8 review: a truck idle at the depot and trucks back at 09:00 or 08:00 are timed by the same rule for the same load', async () => {
    const rules = await rulesOf(AT_0900);
    const earlier = await rulesOf(DAY_BEFORE_0900);
    expect(rules.loadingFromMin).toBe(540);
    expect(earlier.loadingFromMin).toBeUndefined();
    const backAt = (truckId: string, ret: number) => feasLoad(`${truckId}-L1`, truckId, 1, 360, 90, earlier, { onRoad: true, returnMin: ret });
    const day = (depart: number) =>
      checkPlanFeasibility({
        scenarioId: 's', solver: null,
        loads: [
          feasLoad('TA-L1', 'TA', 1, depart, 700, rules), // at the depot all morning
          backAt('TB', 540), feasLoad('TB-L2', 'TB', 2, depart, 700, rules), // back at 09:00 (now)
          backAt('TC', 480), feasLoad('TC-L2', 'TC', 2, depart, 700, rules), // back at 08:00
        ],
      });
    // 700 cases: 30 min + 0.04 x 700 = 58 min from 09:00 -> 09:58 on each truck; at 09:30 all three are short.
    const at0930 = day(570);
    expect(at0930.violations.map((v) => [v.truckCode, v.loadNo, v.code, v.severity, /ready (\d\d:\d\d)/.exec(v.message)?.[1]])).toEqual([
      ['TA', 1, 'TURNAROUND', 'BLOCK', '09:58'],
      ['TB', 2, 'TURNAROUND', 'BLOCK', '09:58'],
      ['TC', 2, 'TURNAROUND', 'BLOCK', '09:58'],
    ]);
    expect(at0930.violations[0].message).toBe(
      'TA load 1 leaves at 09:30, but the plan was made at 09:00 on its delivery day, so loading starts then: the truck needs 58 min to reload and load 700 cases: ready 09:58.',
    );
    expect(at0930.violations[1].message).toContain('after load 1 (back 09:00) the truck needs 58 min');
    expect(at0930.violations[2].message).toContain('the plan was made at 09:00 on its delivery day');
    expect(at0930.violations[0].shortBy).toBe(28);
    expect(day(598).violations).toEqual([]);
    // The same load planned the day before (no loadingFromMin): loaded before the shift, 06:00 is on time.
    expect(checkPlanFeasibility({ scenarioId: 's', solver: null, loads: [feasLoad('TA-L1', 'TA', 1, 360, 700, earlier)] }).violations).toEqual([]);
  });

  it('a next-day plan keeps the first departure: a 06:00 load is on time', async () => {
    const rules = await rulesOf(DAY_BEFORE_0900);
    expect(rules.shiftStartMin).toBe(360);
    const f = checkPlanFeasibility({ scenarioId: 's', solver: null, loads: [feasLoad('T2-L1', 'T2', 1, 360, 60, rules)] });
    expect(f.violations).toEqual([]);
  });
});

describe('PR8 review: on its delivery day loading starts now, for every truck', () => {
  /** 05:15 and 01:00 in Muscat on the delivery day (before the 06:00 first departure). */
  const AT_0515 = new Date(`${DAY}T01:15:00Z`);
  const AT_0100 = new Date('2026-10-04T21:00:00Z');

  it('the request carries the time the plan is made on its delivery day - also before the first departure - and never for another day', async () => {
    const at0900 = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0900 });
    expect(at0900.request.config.loading_from_min).toBe(540);
    expect(at0900.settings?.loadingFromMin).toBe(540);
    expect(planInputsOf(at0900, 'job-1', AT_0900)!.config.loading_from_min).toBe(540);
    // 05:15: 05:45 is not after 06:00, so no "Planned from" - but loading still cannot start before 05:15.
    const early = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0515 });
    expect(early.request.config.shift_start_min).toBe(360);
    expect(early.request.config.loading_from_min).toBe(315);
    expect(early.settings?.planFrom).toBeNull();
    expect(early.settings?.loadingFromMin).toBe(315);
    const nextDay = await buildDispatchRequest('TEN', 'R2', undefined, { now: DAY_BEFORE_0900 });
    expect('loading_from_min' in nextDay.request.config).toBe(false);
    expect(nextDay.settings?.loadingFromMin).toBeNull();
  });

  it('the plan warning says so, with a full truck as the example; before the first departure only when it can matter', async () => {
    const at0900 = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0900 });
    expect(at0900.warnings[0]).toBe(
      'Planned from 09:30 (now 09:00 + 30 min preparation): the plan is for today, so no new load leaves the depot before 09:30. Loading starts now too, so each new load also waits for its own loading time, 0.04 min per case: a full 800-case truck leaves at 10:02 at the earliest. Locked, loading and dispatched loads keep their times; a truck still out leaves again only after it is back and turned around.',
    );
    // 05:15 + 30 min + 0.04 x 800 = 06:17, after the 06:00 first departure.
    const early = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0515 });
    expect(early.warnings[0]).toBe(
      'Planned on the delivery day at 05:15: loading starts now, so a new load leaves no earlier than now + 30 min turnaround + 0.04 min per case of its load - a full 800-case truck at 06:17, although the first departure is 06:00.',
    );
    // 01:00: even a full truck is loaded by 02:02, long before 06:00 - no note (the time is still sent).
    const night = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0100 });
    expect(night.request.config.loading_from_min).toBe(60);
    expect(night.warnings.some((w) => w.startsWith('Planned'))).toBe(false);
    // Without loading per case nothing is added to the texts.
    wire({ cfg: { loadingMinPerCase: 0 } });
    const noLoading = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0900 });
    expect(noLoading.warnings[0]).toBe(planFromWarning({ nowMin: 540, prepMin: 30, fromMin: 570 }, null));
    expect(noLoading.warnings[0]).not.toContain('Loading starts now');
    expect((await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0515 })).warnings.some((w) => w.startsWith('Planned'))).toBe(false);
  });

  it('ASSUMPTIONS: a plan made on its delivery day before the first departure has a "Loading from" row', async () => {
    const early = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0515 });
    const rows = tenantAssumptions(early.settings!, { currency: 'OMR', providerUsed: 'HAVERSINE', distanceIsEstimated: true });
    expect(rows['Loading from (plan made on the delivery day)']).toBe(
      '05:15 - planned on the delivery day: loading starts then, so no new load leaves before now + 30 min turnaround + 0.04 min per case of that load (nor before the first departure).',
    );
    expect(Object.keys(rows).some((k) => k.startsWith('Planned from'))).toBe(false);
    expect(rows['Shift start (earliest departure)']).toBe('06:00');
    // Without loading per case the row would say nothing new: none.
    wire({ cfg: { loadingMinPerCase: 0 } });
    const plain = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0515 });
    const plainRows = tenantAssumptions(plain.settings!, { currency: 'OMR', providerUsed: 'HAVERSINE', distanceIsEstimated: true });
    expect(Object.keys(plainRows).some((k) => k.startsWith('Loading from'))).toBe(false);
  });

  it('Settings says the loading time counts from now for every truck on the delivery day', () => {
    const rows = effectivePlannerValues(CFG as never, 'Oman', 'OMR');
    expect(rows.find((r) => r.label === 'First departure (earliest)')!.note).toMatch(/each new load also waits for its loading per case from now/);
    expect(rows.find((r) => r.label === 'Turnaround between loads')!.note).toMatch(/loading per case counts from now for every truck, also one standing at the depot/);
  });
});

describe('the plan says so: ASSUMPTIONS and Settings', () => {
  it('the ASSUMPTIONS sheet of a same-day plan has a "Planned from" row; a next-day plan has none', async () => {
    const sameDay = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0900 });
    const rows = tenantAssumptions(sameDay.settings!, { currency: 'OMR', providerUsed: 'HAVERSINE', distanceIsEstimated: true });
    expect(rows['Planned from (plan made on the delivery day)']).toBe(planFromAssumption({ nowMin: 540, prepMin: 30, fromMin: 570 }, 0.04));
    expect(rows['Planned from (plan made on the delivery day)']).toContain('+ 30 min preparation (the turnaround between loads) + 0.04 min loading per case of that load');
    expect(rows['Shift start (earliest departure)']).toBe('06:00 (the setting; this plan was made on the delivery day, see "Planned from")');
    // The row sits right after the shift start.
    const keys = Object.keys(rows);
    expect(keys[keys.indexOf('Shift start (earliest departure)') + 1]).toBe('Planned from (plan made on the delivery day)');

    const nextDay = await buildDispatchRequest('TEN', 'R2', undefined, { now: DAY_BEFORE_0900 });
    const plain = tenantAssumptions(nextDay.settings!, { currency: 'OMR', providerUsed: 'HAVERSINE', distanceIsEstimated: true });
    expect(plain['Shift start (earliest departure)']).toBe('06:00');
    expect(Object.keys(plain).some((k) => k.startsWith('Planned from'))).toBe(false);
  });

  it('Settings says where the preparation time comes from', () => {
    const rows = effectivePlannerValues(CFG as never, 'Oman', 'OMR');
    expect(rows.find((r) => r.label === 'First departure (earliest)')!.note).toMatch(/delivery day itself starts from now \+ 30 min \(the turnaround between loads\)/);
    expect(rows.find((r) => r.label === 'Turnaround between loads')!.note).toMatch(/preparation time of a plan made on the delivery day/);
  });
});

describe('a same-day THOROUGH plan cannot be used before its search ends (review of the long-search PR)', () => {
  const base = { runDateIso: DAY, timezone: 'Asia/Muscat', firstDepartureMin: 360, prepMin: 30 };
  const AT_0515 = new Date(`${DAY}T01:15:00Z`);
  const LOADING = { perCase: 0.04, exampleCases: 800 };

  it('sameDayPlanFrom: new loads count from now + the search time + the preparation; without a search as before', () => {
    expect(sameDayPlanFrom(base, AT_0900, 20)).toEqual({ nowMin: 540, prepMin: 30, fromMin: 590, searchMin: 20 });
    expect(sameDayPlanFrom(base, AT_0900, 0)).toEqual({ nowMin: 540, prepMin: 30, fromMin: 570 });
    expect(sameDayPlanFrom(base, AT_0900)).toEqual({ nowMin: 540, prepMin: 30, fromMin: 570 });
    // 05:15 + 20 min search + 30 min = 06:05: after the 06:00 first departure (Quick: 05:45, nothing moves).
    expect(sameDayPlanFrom(base, AT_0515, 20)).toEqual({ nowMin: 315, prepMin: 30, fromMin: 365, searchMin: 20 });
    expect(sameDayPlanFrom(base, AT_0515)).toBeNull();
    // Another day: nothing; never past the end of the delivery day.
    expect(sameDayPlanFrom(base, DAY_BEFORE_0900, 20)).toBeNull();
    expect(sameDayPlanFrom(base, new Date(`${DAY}T19:45:00Z`), 20)?.fromMin).toBe(1440);
  });

  it('the plan warning and the ASSUMPTIONS row say the loads wait for the search, in plain words', () => {
    const p = sameDayPlanFrom(base, AT_0900, 20)!;
    expect(planFromWarning(p, null, LOADING)).toBe(
      'Planned from 09:50 (now 09:00 + up to 20 min Thorough search + 30 min preparation): the plan is for today and cannot be used before its search ends, so no new load leaves the depot before 09:50. Loading starts when the search ends, so each new load also waits for its own loading time, 0.04 min per case: a full 800-case truck leaves at 10:22 at the earliest. Locked, loading and dispatched loads keep their times; a truck still out leaves again only after it is back and turned around.',
    );
    expect(planFromAssumption(p, 0.04)).toBe(
      '09:50 - planned on the delivery day at 09:00 with a Thorough search of up to 20 min: no new load leaves before the search ends + 30 min preparation (the turnaround between loads) + 0.04 min loading per case of that load. Locked, loading and dispatched loads keep their times.',
    );
    // Quick: the texts are exactly the ones from before.
    expect(planFromWarning({ nowMin: 540, prepMin: 30, fromMin: 570 }, null)).toMatch(/^Planned from 09:30 \(now 09:00 \+ 30 min preparation\): the plan is for today, so no new load/);
  });

  it('retimeSameDay (a THOROUGH start): the first departure, loading, warning and settings move by the search time; QUICK and a later day never change', async () => {
    const b = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0900 });
    const quick = JSON.stringify(b);
    expect(retimeSameDay(b, AT_0900, 0)).toBe(false);
    expect(JSON.stringify(b)).toBe(quick);

    expect(retimeSameDay(b, AT_0900, 20)).toBe(true);
    expect(b.request.config.shift_start_min).toBe(590); // 09:00 + 20 min search + 30 min turnaround
    expect(b.request.config.loading_from_min).toBe(560); // loading starts when the search ends
    expect(b.warnings.filter((w) => w.startsWith('Planned'))).toEqual([expect.stringMatching(/^Planned from 09:50 \(now 09:00 \+ up to 20 min Thorough search/)]);
    expect(b.settings).toMatchObject({ planFrom: { nowMin: 540, prepMin: 30, fromMin: 590, searchMin: 20 }, loadingFromMin: 560, searchLeadMin: 20 });
    expect(planInputsOf(b, 'job-1', AT_0900)!.config).toMatchObject({ shift_start_min: 590, loading_from_min: 560 });

    // The job got its solver slot 25 minutes later (queued behind another Thorough): timed from then.
    expect(retimeSameDay(b, new Date(AT_0900.getTime() + 25 * 60_000), 20)).toBe(true);
    expect(b.request.config.shift_start_min).toBe(615);
    expect(b.request.config.loading_from_min).toBe(585);
    expect(b.warnings.filter((w) => w.startsWith('Planned'))).toEqual([expect.stringMatching(/^Planned from 10:15 \(now 09:25 \+ up to 20 min/)]);

    // A plan for the next day: nothing changes (the first loads are loaded before the shift).
    const next = await buildDispatchRequest('TEN', 'R2', undefined, { now: DAY_BEFORE_0900 });
    const nextBefore = JSON.stringify(next);
    expect(retimeSameDay(next, DAY_BEFORE_0900, 20)).toBe(false);
    expect(JSON.stringify(next)).toBe(nextBefore);
    // ... unless its job only starts after midnight, on the delivery day: loading then starts when its search ends.
    expect(retimeSameDay(next, new Date('2026-10-04T20:30:00Z'), 20)).toBe(true); // 00:30 on the 5th
    expect(next.request.config).toMatchObject({ shift_start_min: 360, loading_from_min: 50 });
  });

  it('a same-day plan whose job only starts after the delivery day ended plans nothing more that day (never 06:00 of a past day)', async () => {
    const late = await buildDispatchRequest('TEN', 'R2', undefined, { now: new Date(`${DAY}T19:30:00Z`) }); // 23:30
    expect(retimeSameDay(late, new Date(`${DAY}T20:10:00Z`), 20)).toBe(true); // 00:10 the next day
    expect(late.request.config).toMatchObject({ shift_start_min: 1440, loading_from_min: 1440 });
    expect(late.warnings[0]).toMatch(/no new load can leave today/);
  });

  it('before the first departure: the "Loading from" warning and ASSUMPTIONS row count the search too', async () => {
    const early = await buildDispatchRequest('TEN', 'R2', undefined, { now: new Date(`${DAY}T00:00:00Z`) }); // 04:00
    expect(retimeSameDay(early, new Date(`${DAY}T00:00:00Z`), 20)).toBe(true);
    expect(early.request.config).toMatchObject({ shift_start_min: 360, loading_from_min: 260 }); // 04:00 + 20 min
    // 04:20 + 30 min + 0.04 x 800 = 05:22: before 06:00, so no warning; the ASSUMPTIONS row says it.
    expect(early.warnings.some((w) => w.startsWith('Planned'))).toBe(false);
    const rows = tenantAssumptions(early.settings!, { currency: 'OMR', providerUsed: 'HAVERSINE', distanceIsEstimated: true });
    expect(rows['Loading from (plan made on the delivery day)']).toBe(
      '04:20 - planned on the delivery day at 04:00 with a Thorough search of up to 20 min: loading starts when the search ends, so no new load leaves before then + 30 min turnaround + 0.04 min per case of that load (nor before the first departure).',
    );
    wire({ cfg: { reloadMinutes: 10 } });
    const tight = await buildDispatchRequest('TEN', 'R2', undefined, { now: new Date(`${DAY}T01:00:00Z`) }); // 05:00, 10 min turnaround
    expect(retimeSameDay(tight, new Date(`${DAY}T01:00:00Z`), 20)).toBe(true);
    // 05:00 + 20 + 10 = 05:30 (before 06:00: no "Planned from"), but a full truck: 05:30 + 32 min = 06:02.
    expect(tight.warnings[0]).toBe(
      'Planned on the delivery day at 05:00 with a Thorough search of up to 20 min: loading starts when the search ends (05:20 at the latest), so a new load leaves no earlier than then + 10 min turnaround + 0.04 min per case of its load - a full 800-case truck at 06:02, although the first departure is 06:00.',
    );
    expect(tight.request.config.loading_from_min).toBe(320);
  });
});
