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

import { buildDispatchRequest, planInputsOf } from '@/lib/dispatch/plan-service';
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
    // Apart from the first departure and the warning, the two requests are the same.
    const strip = (b: typeof sameDay) => JSON.stringify({ ...b.request, config: { ...b.request.config, shift_start_min: 0 } });
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
    // T1 L2 at 10:10: 09:57 + 30 min turnaround + 0.04 x 50 cases = 10:29. T2 L1 at 09:00: before 09:30.
    const tooEarly = checkPlanFeasibility({
      scenarioId: 's', solver: null,
      loads: [dispatched, feasLoad('T1-L2', 'T1', 2, 610, 50, newRules), feasLoad('T2-L1', 'T2', 1, 540, 60, newRules)],
    });
    expect(tooEarly.violations.map((v) => [v.truckCode, v.loadNo, v.code])).toEqual([
      ['T1', 2, 'TURNAROUND'],
      ['T2', 1, 'EARLY_DEPARTURE'],
    ]);
    expect(tooEarly.violations[0].message).toContain('ready 10:29');
    expect(tooEarly.violations[1].message).toContain('(09:30)');
    // At 10:29 and 09:30 every rule holds, and the 06:00 dispatched load is not an early departure.
    const onTime = checkPlanFeasibility({
      scenarioId: 's', solver: null,
      loads: [dispatched, feasLoad('T1-L2', 'T1', 2, 629, 50, newRules), feasLoad('T2-L1', 'T2', 1, 570, 60, newRules)],
    });
    expect(onTime.violations).toEqual([]);
    expect(onTime.ok).toBe(true);
  });

  it('a next-day plan keeps the first departure: a 06:00 load is on time', async () => {
    const rules = await rulesOf(DAY_BEFORE_0900);
    expect(rules.shiftStartMin).toBe(360);
    const f = checkPlanFeasibility({ scenarioId: 's', solver: null, loads: [feasLoad('T2-L1', 'T2', 1, 360, 60, rules)] });
    expect(f.violations).toEqual([]);
  });
});

describe('the plan says so: ASSUMPTIONS and Settings', () => {
  it('the ASSUMPTIONS sheet of a same-day plan has a "Planned from" row; a next-day plan has none', async () => {
    const sameDay = await buildDispatchRequest('TEN', 'R2', undefined, { now: AT_0900 });
    const rows = tenantAssumptions(sameDay.settings!, { currency: 'OMR', providerUsed: 'HAVERSINE', distanceIsEstimated: true });
    expect(rows['Planned from (plan made on the delivery day)']).toBe(planFromAssumption({ nowMin: 540, prepMin: 30, fromMin: 570 }));
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
