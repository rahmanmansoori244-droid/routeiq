/**
 * Stabilization PR7 - the plan options table (plan screen, Excel SUMMARY, job message):
 * - B3: an option's trucks are the day's PHYSICAL trucks, the trucks of locked / loading /
 *   dispatched loads included; the job message says "N new loads + M kept on T trucks".
 * - N1: each option says what it gains over the others (P1/P2 minutes, preference cost, OMR, km,
 *   trucks), or that it is the same plan. RECOMMENDED's objective itself is unchanged.
 * - PR7 review: an option saved by an optimizer that did not report the preference parts (every
 *   plan made on main) compares its preferred-hours part under that name, never as "preference
 *   cost"; km, like trucks, loads and day cost, is the whole day (kept + new loads).
 * Pure helpers first, then getPlanDetail and the workbook on the in-memory database (fake-plan-db.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>) => m.fakePrisma.auditLog.create({ data: { ...input } })) };
});

import type { DispatchScenario, PlannedLoad } from '@routeiq/shared-types';
import {
  earlyPriorities,
  earlyStarts,
  frozenOfRequest,
  optionTradeoffs,
  physicalTruckCount,
  planSignature,
  preferenceFigures,
  type OptionFacts,
} from '@/lib/dispatch/plan-options';
import { jobMessage } from '@/lib/jobs/dispatch-job';
import { getPlanDetail, type PlanDetail } from '@/lib/dispatch/plan-detail';
import { buildDispatchWorkbook, solverRules, withSearchAssumptions } from '@/lib/dispatch/workbook';
import { chooseScenario } from '@/lib/dispatch/plan-service';
import { searchResultText } from '@/lib/dispatch/search-mode';
import { manifestKgNote } from '@/lib/dispatch/weights';

const T = 'tA';
const DAY = new Date('2026-09-27T00:00:00Z');

/** A new load: stops [stop id, service start min]. */
function newLoad(truck: string, loadNo: number, stops: [string, number][]): PlannedLoad {
  return {
    truck_id: truck, load_no: loadNo, depart_min: 400, return_min: 600, distance_km: 20, duration_min: 200, cases: 40, kg: 400,
    utilization_pct: 40, fuel_litres: null, fuel_cost: 0, distance_cost: 2, time_cost: 0, fixed_cost: 0, total_cost: 2, return_leg_km: 5,
    stops: stops.map(([id, start], i) => ({
      sequence: i + 1, stop_id: id, order_ids: [id.replace('S', 'O')], customer_id: 'c1', arrival_min: start, service_start_min: start,
      departure_min: start + 20, wait_min: 0, leg_km: 5, cum_km: 5 * (i + 1), leg_min: 10, cases: 40, kg: 400, hard_window_ok: true, pref_window_ok: true,
    })),
  };
}

function facts(over: Partial<OptionFacts> & { name: string }): OptionFacts {
  return { usable: true, trucks: 3, loads: 4, km: 400, dayCost: 200, preferenceCost: 10, preferredHoursCost: 2, unserved: 0, signature: 'A', earlyStarts: {}, ...over };
}

describe('B3: physical trucks', () => {
  it('counts the trucks of the new loads and of the kept loads once each', () => {
    expect(physicalTruckCount([{ truck_id: 'T1' }, { truck_id: 'T3' }, { truck_id: 'T3' }], ['T1', 'T2'])).toBe(3);
    expect(physicalTruckCount([], ['T1', 'T2'])).toBe(2);
    expect(physicalTruckCount([{ truck_id: 'T1' }], [])).toBe(1);
  });

  it("reads the kept loads from the request's frozen trips", () => {
    const trucks = [
      { id: 'T1', frozen_trips: [{}, {}] },
      { id: 'T2', frozen_trips: [] },
      { id: 'T3' },
      { id: 'T4', frozen_trips: [{}] },
    ];
    expect(frozenOfRequest(trucks)).toEqual({ truckIds: ['T1', 'T4'], loads: 3 });
  });

  it('the job message counts the physical trucks and says how many loads were kept (the S04 probe: "10 loads on 6 trucks" for a 7-truck day)', () => {
    // As an optimizer before PR7 reported it: trucks_used counts only the trucks of the new loads.
    const newTrucks = ['T01', 'T01', 'T03', 'T04', 'T04', 'T05', 'T05', 'T07', 'T08', 'T08'];
    const sc = {
      trips: 10, trucks_used: 6, unserved: [], loads: newTrucks.map((t, i) => newLoad(t, i + 2, [])),
      feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
    } as unknown as DispatchScenario;
    expect(jobMessage(sc, 0, 0, { truckIds: ['T01', 'T02'], loads: 2 })).toBe('10 new loads + 2 kept (locked or dispatched) on 7 trucks, 0 stop(s) unserved');
    // A fresh day reads as before.
    expect(jobMessage(sc, 0, 0, { truckIds: [], loads: 0 })).toBe('10 loads on 6 trucks, 0 stop(s) unserved');
  });
});

describe('N1: what each option gains', () => {
  it('RECOMMENDED shows what its extra cost buys; the cheaper option what it gives up; twins say "same plan"', () => {
    const rec = facts({
      name: 'RECOMMENDED', trucks: 7, loads: 11, km: 485.8, dayCost: 237.8, preferenceCost: 12.4, signature: 'R',
      earlyStarts: { S1: 400, S2: 420, S3: 450 },
    });
    const minTrucks = facts({
      name: 'MIN_TRUCKS', trucks: 6, loads: 11, km: 398.5, dayCost: 202.4, preferenceCost: 31.9, signature: 'M',
      earlyStarts: { S1: 460, S2: 470, S3: 460 },
    });
    const minDistance = { ...minTrucks, name: 'MIN_DISTANCE' };
    const t = optionTradeoffs([rec, minTrucks, minDistance], 'P1/P2');
    expect(t.RECOMMENDED.text).toBe(
      'vs MIN TRUCKS: P1/P2 delivered on average 40 min earlier, preference cost 19.5 OMR lower; but costs 35.4 OMR more, 87 km more, 1 more truck',
    );
    expect(t.MIN_TRUCKS.text).toBe(
      'vs RECOMMENDED: 35.4 OMR cheaper, 87 km less, 1 fewer truck; but P1/P2 delivered on average 40 min later, preference cost 19.5 OMR higher',
    );
    expect(t.MIN_DISTANCE.text).toBe('Same plan as MIN TRUCKS');
  });

  it('identical options say "same plan"; an alternative equal to RECOMMENDED says so', () => {
    const a = facts({ name: 'RECOMMENDED' });
    const same = optionTradeoffs([a, { ...a, name: 'MIN_TRUCKS' }, { ...a, name: 'MIN_DISTANCE' }]);
    expect(Object.values(same).map((x) => x.text)).toEqual(['Same plan as the other options', 'Same plan as the other options', 'Same plan as the other options']);
    const d = facts({ name: 'MIN_DISTANCE', signature: 'D', km: 380, dayCost: 199 });
    const t = optionTradeoffs([a, { ...a, name: 'MIN_TRUCKS' }, d]);
    expect(t.MIN_TRUCKS.text).toBe('Same plan as RECOMMENDED');
    expect(t.MIN_DISTANCE.text).toBe('vs RECOMMENDED: 1.0 OMR cheaper, 20 km less');
    expect(t.RECOMMENDED.text).toBe('vs MIN DISTANCE: no gain; but costs 1.0 OMR more, 20 km more');
  });

  it('an option without a plan gets no line and is never compared', () => {
    const t = optionTradeoffs([facts({ name: 'RECOMMENDED' }), facts({ name: 'MIN_TRUCKS', usable: false, signature: 'X', dayCost: 1 })]);
    expect(t.MIN_TRUCKS).toBeUndefined();
    expect(t.RECOMMENDED.text).toBe('');
  });

  it('serving more orders is a gain; minutes are compared over the stops both options serve', () => {
    const rec = facts({ name: 'RECOMMENDED', unserved: 1, signature: 'R', earlyStarts: { S1: 400 } });
    const alt = facts({ name: 'MIN_DISTANCE', unserved: 0, signature: 'D', earlyStarts: { S1: 400, S9: 900 } });
    expect(optionTradeoffs([rec, alt]).MIN_DISTANCE.text).toBe('vs RECOMMENDED: 1 more order served');
  });

  it('preference cost adds preferred hours, early delivery and moved orders; an older option has the preferred-hours part only', () => {
    expect(preferenceFigures({ window: 1.25, early: 10.5, continuity: 3 })).toEqual({ total: 14.75, preferredHours: 1.25 });
    // An older option: its total is unknown, never its preferred-hours part under the total's name.
    expect(preferenceFigures(null, 2.5)).toEqual({ total: null, preferredHours: 2.5 });
    expect(preferenceFigures(undefined, undefined)).toEqual({ total: null, preferredHours: null });
  });

  it('options made before the optimizer reported the preference parts compare the preferred-hours cost under its own name (main/S01)', () => {
    // main/S01 (repeat 2): objective.window_penalty only. Before, the MIN DISTANCE row read
    // "preference cost 11.6 OMR lower ... but P1/P2 delivered on average 68 min later".
    const old = (name: string, windowPenalty: number, over: Partial<OptionFacts>) =>
      facts({ name, preferenceCost: null, preferredHoursCost: windowPenalty, ...over });
    const rec = old('RECOMMENDED', 18.558, { trucks: 7, km: 520, dayCost: 230, signature: 'R', earlyStarts: { S1: 400, S2: 420 } });
    const minTrucks = old('MIN_TRUCKS', 34.175, { trucks: 6, km: 530, dayCost: 215, signature: 'M', earlyStarts: { S1: 450, S2: 470 } });
    const minDistance = old('MIN_DISTANCE', 6.953, { trucks: 8, km: 439, dayCost: 245.3, signature: 'D', earlyStarts: { S1: 468, S2: 488 } });
    const t = optionTradeoffs([rec, minTrucks, minDistance]);
    expect(t.MIN_DISTANCE.text).toBe(
      'vs RECOMMENDED: preferred-hours cost 11.6 OMR lower, 81 km less; but P1/P2 delivered on average 68 min later, costs 15.3 OMR more, 1 more truck',
    );
    expect(t.RECOMMENDED.text).toBe(
      'vs MIN TRUCKS: P1/P2 delivered on average 50 min earlier, preferred-hours cost 15.6 OMR lower, 10 km less; but costs 15.0 OMR more, 1 more truck',
    );
    expect(Object.values(t).map((x) => x.text).join(' ')).not.toContain('preference cost');
    // One side known, the other not (never in one version): only the part both have.
    const mixed = optionTradeoffs([facts({ name: 'RECOMMENDED', signature: 'R', preferenceCost: 12, preferredHoursCost: 3 }), old('MIN_TRUCKS', 5, { signature: 'M' })]);
    expect(mixed.MIN_TRUCKS.text).toBe('vs RECOMMENDED: no gain; but preferred-hours cost 2.0 OMR higher');
  });

  it('the early priorities follow the optimizer config (default P1, P2)', () => {
    expect(earlyPriorities(undefined)).toEqual([1, 2]);
    expect(earlyPriorities({ 1: 0.01, 2: 0, 3: 0.002 } as unknown as Record<string, number>)).toEqual([1, 3]);
    const loads = [newLoad('T1', 1, [['S1', 400], ['S2', 420]]), newLoad('T2', 1, [['S3', 500]])];
    const prio: Record<string, number> = { S1: 1, S2: 3, S3: 2 };
    expect(earlyStarts(loads, [1, 2], (s) => prio[s.stop_id] ?? null)).toEqual({ S1: 400, S3: 500 });
  });

  it('audit F22: an option that breaks the timing rules is never called cheaper or better, and nothing is compared with it', () => {
    // The verifiers' case: MIN TRUCKS serves one more order for 20 OMR less, but its timetable is VIOLATED.
    const rec = facts({ name: 'RECOMMENDED', dayCost: 100, unserved: 1, signature: 'R', feasibility: 'VERIFIED' });
    const bad = facts({ name: 'MIN_TRUCKS', dayCost: 80, unserved: 0, signature: 'M', feasibility: 'VIOLATED', violations: 3 });
    let t = optionTradeoffs([rec, bad]);
    expect(t.MIN_TRUCKS).toEqual({ text: 'Breaks the timing rules (3 problems): it cannot be dispatched. Re-plan, or use another option.', versus: null, gains: [], givesUp: [] });
    expect(t.RECOMMENDED.text).toBe('Every different option breaks the timing rules.');
    for (const x of Object.values(t)) expect(x.text).not.toMatch(/cheaper|more order|no gain/);
    // With a third option that keeps the rules, RECOMMENDED is compared with that one only.
    const ok = facts({ name: 'MIN_DISTANCE', dayCost: 90, km: 380, unserved: 1, signature: 'D', feasibility: 'VERIFIED' });
    t = optionTradeoffs([rec, bad, ok]);
    expect(t.RECOMMENDED.versus).toBe('MIN_DISTANCE');
    expect(t.MIN_DISTANCE.text).toMatch(/^vs RECOMMENDED: 10\.0 OMR cheaper/);
    expect(t.MIN_TRUCKS.gains).toEqual([]);
    // UNVERIFIED (the check could not run) is not dispatchable either; an option from before the check (null) is compared as before.
    t = optionTradeoffs([rec, { ...bad, feasibility: 'UNVERIFIED' }]);
    expect(t.MIN_TRUCKS.text).toBe('Its timing could not be checked, so it cannot be dispatched. Re-plan, or use another option.');
    t = optionTradeoffs([rec, { ...bad, feasibility: null }]);
    expect(t.MIN_TRUCKS.text).toMatch(/^vs RECOMMENDED: 1 more order served/);
    expect(t.MIN_TRUCKS.gains).toContain('20.0 OMR cheaper');
    // RECOMMENDED itself broken: it says so, and no alternative is praised against it.
    t = optionTradeoffs([{ ...rec, feasibility: 'VIOLATED', violations: 1 }, { ...bad, feasibility: 'VERIFIED' }]);
    expect(t.RECOMMENDED.text).toBe('Breaks the timing rules (1 problem): it cannot be dispatched. Re-plan, or use another option.');
    expect(t.MIN_TRUCKS.text).toBe('');
  });

  it('audit F22 (A6 third review): two rule-keeping options with the same plan beside a broken different plan are not "the same plan as the other options"', () => {
    // RECOMMENDED and MIN TRUCKS keep the rules and are one plan; MIN DISTANCE is another plan and breaks them.
    const rec = facts({ name: 'RECOMMENDED', signature: 'R', feasibility: 'VERIFIED' });
    const minTrucks = { ...rec, name: 'MIN_TRUCKS' };
    for (const feasibility of ['VIOLATED', 'UNVERIFIED'] as const) {
      const bad = facts({ name: 'MIN_DISTANCE', signature: 'D', dayCost: 150, km: 300, feasibility, violations: 2 });
      const t = optionTradeoffs([rec, minTrucks, bad]);
      expect(t.RECOMMENDED.text).toBe('Every different option breaks the timing rules.');
      expect(t.MIN_TRUCKS).toEqual({ text: 'Same plan as RECOMMENDED', versus: 'RECOMMENDED', gains: [], givesUp: [] });
      expect(t.MIN_DISTANCE.text).toBe(
        feasibility === 'VIOLATED'
          ? 'Breaks the timing rules (2 problems): it cannot be dispatched. Re-plan, or use another option.'
          : 'Its timing could not be checked, so it cannot be dispatched. Re-plan, or use another option.',
      );
      for (const x of Object.values(t)) expect(x.text).not.toContain('Same plan as the other options');
    }
  });

  it('the plan signature ignores load order in the list but not the stop order', () => {
    const a = [newLoad('T1', 1, [['S1', 400], ['S2', 420]]), newLoad('T2', 1, [['S3', 500]])];
    expect(planSignature([...a].reverse())).toBe(planSignature(a));
    expect(planSignature([newLoad('T1', 1, [['S2', 400], ['S1', 420]]), a[1]])).not.toBe(planSignature(a));
  });
});

// ---------------------------------------------------------------------------------------
// getPlanDetail + workbook on the in-memory database
// ---------------------------------------------------------------------------------------

const customer = { id: 'c1', tenantId: T, code: 'C1', branchCode: null, name: 'Lulu', customerType: null, address: null, accessNotes: null, lat: 23.6, lng: 58.4,
  priority: 2, avgServiceTimeMin: 20, serviceTimeConfirmed: true, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, active: true };

function planLoad(id: string, truckId: string, loadNo: number, status: string, operatingCost: number, carriedFromLoadId: string | null = null) {
  return {
    id, tenantId: T, runId: 'P', truckId, loadNo, status, driverId: null, departMin: 400, returnMin: 500, distanceKm: 10, durationMin: 100, cases: 40, weightKg: 400,
    utilizationPct: 40, fuelLitres: null, fuelCost: 0, operatingCost, returnLegKm: 2, distanceIsEstimated: true, carriedFromLoadId, truckSnapshotJson: null,
    statusChangedAt: null, statusChangedById: null, createdAt: new Date(),
  };
}

function assignment(id: string, loadId: string, truckId: string, orderId: string, loadNo: number) {
  return {
    id, runId: 'P', truckId, orderId, sequenceInTruck: 1, plannedArrivalMin: 20, plannedDistanceFromPrevKm: 5, plannedLoadCases: 40, lockedByUserId: null,
    manualOverrideReason: null, loadId, loadNo, orderInStop: 0, etaMin: 420, serviceStartMin: 420, departureMin: 440, waitMin: 0, cumulativeKm: 5,
    hardWindowOk: true, prefWindowOk: true, portionCases: null, portionWeightKg: null, portionLinesJson: null, stopSnapshotJson: null,
  };
}

function option(id: string, name: string, loads: PlannedLoad[], over: Record<string, unknown>) {
  const scope = { orderIds: ['O2', 'O3'], frozenOrderIds: ['O1'], orderPriority: { O1: 1, O2: 1, O3: 2 }, frozenLoadIds: ['K1'], frozenLoadOrderIds: ['O1'] };
  return {
    id, runId: 'P', name, trucksUsed: new Set(loads.map((l) => l.truck_id)).size, totalDistanceKm: 30, totalTimeMin: 300, totalCost: 50, avgUtilizationPct: 40,
    unservedCount: 0, createdAt: new Date(),
    detailsJson: {
      name, status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 1, trucks_used: new Set(loads.map((l) => l.truck_id)).size, trips: loads.length,
      total_distance_km: 30, operating_cost: 50, loads, unserved: [], warnings: [], objective: { window_penalty: 1 }, engine: 'OR-Tools',
      matrix_provider: 'HAVERSINE', distance_is_estimated: true, response_warnings: [], scope, feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
      ...over,
    },
  };
}

/**
 * A re-plan: T2 carries a dispatched load K1 (kept); RECOMMENDED planned its new loads on T1 only,
 * stored the way an optimizer before PR7 counted them (1 truck). MIN_TRUCKS is a cheaper plan
 * that delivers the P1 / P2 stops later.
 */
function seed() {
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true, lat: 23.58, lng: 58.39, openMin: 0, closeMin: 1440 }];
  tables.truck = ['T1', 'T2', 'T3'].map((id, i) => ({ id, tenantId: T, code: `T0${i + 1}`, defaultDriverId: null, capacityCases: 100, capacityWeightKg: 1000 }));
  tables.customer = [customer];
  tables.order = ['O1', 'O2', 'O3'].map((id) => ({
    id, tenantId: T, customerId: 'c1', customer, lines: [{ id: `${id}-l`, cases: 40, weightKg: 400, weightFromMaster: false, salesOrderNo: `SO-${id}`, product: { code: 'TAN', name: 'Tanuf', weightPerCaseKg: 10 } }],
    totalCases: 40, totalWeightKg: 400, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED', notes: null, depotId: 'D1', deliveryDate: DAY,
  }));
  tables.runPlan = [{
    id: 'P', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 2, reason: 'LATE_ORDER', optimizationMode: 'BALANCED', chosenScenarioId: 'sc1',
    parentRunId: null, supersededAt: null, currentJobId: null, finalizedAt: null, totalOrders: 3, unservedCount: 0, summaryJson: null,
    reconciliationJson: null, changeSummaryJson: null, feasibilityJson: null, createdById: 'u1', createdAt: new Date(),
  }];
  tables.planLoad = [
    planLoad('K1', 'T2', 1, 'DISPATCHED', 30, 'K0'),
    { ...planLoad('L2', 'T1', 1, 'PLANNED', 25), distanceKm: 15 },
    { ...planLoad('L3', 'T1', 2, 'PLANNED', 25), distanceKm: 15 },
  ];
  tables.routeAssignment = [assignment('A1', 'K1', 'T2', 'O1', 1), assignment('A2', 'L2', 'T1', 'O2', 1), assignment('A3', 'L3', 'T1', 'O3', 2)];
  const recLoads = [newLoad('T1', 1, [['S2', 400]]), newLoad('T1', 2, [['S3', 520]])];
  const minLoads = [newLoad('T3', 1, [['S2', 420], ['S3', 520]])];
  tables.scenarioResult = [
    option('sc1', 'RECOMMENDED', recLoads, { preference_penalties: { window: 1, early: 4, continuity: 0 } }),
    { ...option('sc2', 'MIN_TRUCKS', minLoads, { preference_penalties: { window: 1, early: 9, continuity: 0 } }), totalCost: 40, totalDistanceKm: 22 },
  ];
  tables.unservedOrder = [];
  tables.runJob = [];
  tables.auditLog = [];
  tables.driver = [];
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, defaultServiceTimeMin: 10, timezone: 'Asia/Muscat' }];
  tables.customerTypeProfile = [];
}

beforeEach(() => resetDb());

describe('the plan options of a re-plan with a dispatched load (getPlanDetail)', () => {
  it('counts the kept truck and load in every option, and says what each option gains', async () => {
    seed();
    const d = (await getPlanDetail(T, 'P'))!;
    const [rec, min] = d.scenarios;
    // B3: T1 (new loads) + T2 (dispatched K1), although the stored option says 1 truck.
    expect(rec).toMatchObject({ name: 'RECOMMENDED', trucksUsed: 2, trips: 2, frozenLoads: 1, dayOperatingCost: 80, preferenceCost: 5, preferredHoursCost: 1 });
    expect(min).toMatchObject({ name: 'MIN_TRUCKS', trucksUsed: 2, trips: 1, frozenLoads: 1, dayOperatingCost: 70, preferenceCost: 10, preferredHoursCost: 1 });
    // PR7 review: km is the whole day too - K1's 10 km + the option's new loads (30 and 22 km).
    // The option in use reads like the KPI (every load of the version: K1 10 + L2 15 + L3 15).
    expect([rec.totalKm, rec.dayKm, min.totalKm, min.dayKm]).toEqual([30, 40, 22, 32]);
    expect(rec.dayKm).toBe(tables.planLoad.reduce((a, l) => a + Number(l.distanceKm), 0));
    // N1: P1 (S2: O2) and P2 (S3: O3) stops, 400/520 against 420/520 = 10 min earlier on average.
    expect(rec.tradeoff).toBe('vs MIN TRUCKS: P1/P2 delivered on average 10 min earlier, preference cost 5.0 OMR lower; but costs 10.0 OMR more, 8 km more, 1 more load');
    expect(min.tradeoff).toBe('vs RECOMMENDED: 10.0 OMR cheaper, 8 km less, 1 fewer load; but P1/P2 delivered on average 10 min later, preference cost 5.0 OMR higher');
  });

  it('the workbook SUMMARY lists the options with the same trucks, loads and trade-offs', async () => {
    seed();
    const d = (await getPlanDetail(T, 'P'))!;
    const buf = await buildDispatchWorkbook(d, { tenantName: 'NMWC', currency: 'OMR', generatedAt: new Date('2026-09-27T05:00:00Z'), generatedBy: 'Planner', assumptions: {} });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('SUMMARY')!;
    const rows: string[][] = [];
    ws.eachRow((row) => rows.push([1, 2, 3].map((c) => row.getCell(c).text)));
    const at = rows.findIndex((r) => r[0] === 'PLAN OPTIONS');
    expect(at).toBeGreaterThan(0);
    const rec = rows.findIndex((r, i) => i > at && r[0] === 'RECOMMENDED (in use)');
    expect(rows[rec][1]).toBe('2 trucks · 3 loads (2 new)');
    expect(rows[rec][2]).toBe('40.0 km (new 30.0) · day cost 80.0 OMR (new 50.0) · preference cost 5.0 · 0 unserved · timing VERIFIED');
    expect(rows[rec + 1][2]).toBe(d.scenarios[0].tradeoff);
    const min = rows.findIndex((r, i) => i > at && r[0] === 'MIN TRUCKS');
    expect(rows[min][1]).toBe('2 trucks · 2 loads (1 new)');
    expect(rows[min][2]).toBe('32.0 km (new 22.0) · day cost 70.0 OMR (new 40.0) · preference cost 10.0 · 0 unserved · timing VERIFIED');
    expect(rows[min + 1][2]).toMatch(/^vs RECOMMENDED: 10\.0 OMR cheaper/);
  });

  it('A6 review: each option carries the weight and overtime rules its optimizer reported (none from an older one)', async () => {
    seed();
    const rec = tables.scenarioResult[0];
    rec.detailsJson = { ...(rec.detailsJson as Record<string, unknown>), weight_unit_kg: 0.1, new_overtime_only: true };
    const d = (await getPlanDetail(T, 'P'))!;
    expect(d.scenarios[0]).toMatchObject({ name: 'RECOMMENDED', weightUnitKg: 0.1, newOvertimeOnly: true });
    expect(d.scenarios[1]).toMatchObject({ name: 'MIN_TRUCKS', weightUnitKg: null, newOvertimeOnly: null });
    expect(solverRules(d)).toMatchObject({ weightsToTenthKg: true, newOvertimeOnly: true });
  });

  it('audit F22: an option whose timetable is VIOLATED says so on screen and in the Excel, never "cheaper"', async () => {
    seed();
    const min = tables.scenarioResult[1];
    min.detailsJson = { ...(min.detailsJson as Record<string, unknown>), feasibility: { status: 'VIOLATED', timing: 'ESTIMATED', violations: [{ code: 'TURNAROUND', message: 'x' }, { code: 'TURNAROUND', message: 'y' }] } };
    const d = (await getPlanDetail(T, 'P'))!;
    expect(d.scenarios[1].tradeoff).toBe('Breaks the timing rules (2 problems): it cannot be dispatched. Re-plan, or use another option.');
    expect(d.scenarios[0].tradeoff).toBe('Every different option breaks the timing rules.');
    const buf = await buildDispatchWorkbook(d, { tenantName: 'NMWC', currency: 'OMR', generatedAt: new Date('2026-09-27T05:00:00Z'), generatedBy: 'Planner', assumptions: {} });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const texts: string[] = [];
    wb.getWorksheet('SUMMARY')!.eachRow((row) => texts.push(row.getCell(3).text));
    expect(texts).toContain('32.0 km (new 22.0) · day cost 70.0 OMR (new 40.0) · preference cost 10.0 · 0 unserved · timing VIOLATED');
    expect(texts).toContain('Breaks the timing rules (2 problems): it cannot be dispatched. Re-plan, or use another option.');
    expect(texts.some((x) => /cheaper/.test(x))).toBe(false);
  });

  it('options saved by an optimizer without the preference parts show their preferred hours as such, on screen and in the Excel', async () => {
    seed();
    for (const [sc, w] of [
      [tables.scenarioResult[0], 1.5],
      [tables.scenarioResult[1], 4],
    ] as const) {
      const { preference_penalties: _pp, ...rest } = sc.detailsJson as Record<string, unknown>;
      sc.detailsJson = { ...rest, objective: { window_penalty: w } };
    }
    const d = (await getPlanDetail(T, 'P'))!;
    const [rec, min] = d.scenarios;
    expect(rec).toMatchObject({ preference: null, preferenceCost: null, preferredHoursCost: 1.5 });
    expect(min).toMatchObject({ preference: null, preferenceCost: null, preferredHoursCost: 4 });
    expect(rec.tradeoff).toBe(
      'vs MIN TRUCKS: P1/P2 delivered on average 10 min earlier, preferred-hours cost 2.5 OMR lower; but costs 10.0 OMR more, 8 km more, 1 more load',
    );
    expect(min.tradeoff).not.toContain('preference cost');
    const buf = await buildDispatchWorkbook(d, { tenantName: 'NMWC', currency: 'OMR', generatedAt: new Date('2026-09-27T05:00:00Z'), generatedBy: 'Planner', assumptions: {} });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const texts: string[] = [];
    wb.getWorksheet('SUMMARY')!.eachRow((row) => texts.push(row.getCell(3).text));
    expect(texts).toContain('40.0 km (new 30.0) · day cost 80.0 OMR (new 50.0) · preferred hours only 1.5 (older optimizer: early delivery not reported) · 0 unserved · timing VERIFIED');
  });
});

describe('audit E3 through getPlanDetail: each load sheet weighs what the load weighs (A6 review)', () => {
  /**
   * The verifiers' two shapes, through getPlanDetail (the helper alone passed while getPlanDetail
   * could still call the old rowLines): O2 is weighed at order level (lines of 24 and 16 cases at
   * 0 kg, the order 400 kg); O3 is a LOCKED split part of 20 cases planned at 15 kg per case (300 kg)
   * while its line now says 10 kg per case. O1 on the dispatched K1 is the control.
   */
  function seedWeights() {
    seed();
    const o2 = tables.order.find((o) => o.id === 'O2')!;
    o2.lines = [
      { id: 'O2-a', cases: 24, weightKg: 0, weightFromMaster: false, salesOrderNo: 'SO-O2', product: { code: 'TAN', name: 'Tanuf', weightPerCaseKg: 0 } },
      { id: 'O2-b', cases: 16, weightKg: 0, weightFromMaster: false, salesOrderNo: 'SO-O2', product: { code: 'MAI', name: 'Masafi', weightPerCaseKg: 0 } },
    ];
    Object.assign(tables.planLoad.find((l) => l.id === 'L3')!, { status: 'LOCKED', cases: 20, weightKg: 300 });
    Object.assign(tables.routeAssignment.find((a) => a.id === 'A3')!, {
      plannedLoadCases: 20, portionCases: 20, portionWeightKg: 300, portionLinesJson: [{ lineId: 'O3-l', cases: 20, kgPerCase: 15 }],
    });
  }

  it("each load's manifest kg and each stop's SKU kg equal the load's and the row's kg", async () => {
    seedWeights();
    const d = (await getPlanDetail(T, 'P'))!;
    const kg = (xs: { weightKg: number }[]) => Math.round(xs.reduce((a, x) => a + x.weightKg, 0) * 10) / 10;
    const byId = Object.fromEntries(d.loads.map((l) => [l.id, [l.weightKg, kg(l.manifest)]]));
    expect(byId).toEqual({ K1: [400, 400], L2: [400, 400], L3: [300, 300] });
    for (const l of d.loads) for (const st of l.stops) expect(kg(st.skus), `${l.id} stop ${st.sequence}`).toBe(st.weightKg);
    const manifest = (id: string) =>
      d.loads.find((l) => l.id === id)!.manifest.map((m) => [m.productCode, m.cases, m.weightKg]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    // Order-level weights are spread per case (24 : 16), not left at 0 kg.
    expect(manifest('L2')).toEqual([
      ['MAI', 16, 160],
      ['TAN', 24, 240],
    ]);
    // The part keeps the 15 kg per case it was planned with (not the line's 10 kg now: 200 kg).
    expect(manifest('L3')).toEqual([['TAN', 20, 300]]);
  });

  it('an older version whose orders were re-weighed after it was made says so under its manifest, as its Excel sheet does (A6 second review)', async () => {
    seed();
    // Kept for the record: a re-plan made v3 after O2's case weight was corrected from 10 to 10.5 kg,
    // and re-weighed O2 (not frozen). This version's T01 L1 was planned at 400 kg.
    Object.assign(tables.runPlan[0], { status: 'SUPERSEDED', supersededAt: new Date() });
    const o2 = tables.order.find((o) => o.id === 'O2')!;
    o2.lines = [{ ...o2.lines[0], weightKg: 420 }];
    o2.totalWeightKg = 420;
    const d = (await getPlanDetail(T, 'P'))!;
    const l2 = d.loads.find((l) => l.id === 'L2')!;
    expect([l2.weightKg, l2.manifest.map((m) => m.weightKg)]).toEqual([400, [420]]);
    expect(manifestKgNote(l2)).toBe('The load was planned at 400 kg. Order weights changed since planning, so the products add up to 420 kg.');
    expect(d.loads.filter((l) => l.id !== 'L2').map(manifestKgNote)).toEqual([null, null]);
    // The Excel flags the same load, and only it.
    const buf = await buildDispatchWorkbook(d, { tenantName: 'NMWC', currency: 'OMR', generatedAt: new Date('2026-09-27T05:00:00Z'), generatedBy: 'Planner', assumptions: {} });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const flagged = wb.worksheets.filter((ws) => {
      let hit = false;
      ws.eachRow((row) => row.eachCell((c) => void (hit ||= c.text.includes('MISMATCH: load records 400 kg (order weights changed since planning)'))));
      return hit;
    });
    expect(flagged.map((ws) => ws.name)).toEqual(['T01 - L1']);
  });
});

describe('an alternative in use says how IT was searched (skeptic review of the long-search PR)', () => {
  // The response's search report, stored with every option (persistDispatchResult): always the
  // recommended plan's search - here THOROUGH, stopped after 12 min when it stopped improving.
  const SEARCH = {
    mode: 'THOROUGH', cap_sec: 1200, limit_sec: 985, search_sec: 720, used_sec: 800, stop_reason: 'CONVERGED', last_improvement_sec: 360, stall_sec: 360,
    best_over_time: [[0.4, 612.4, 0], [360, 525.3, 0]], solutions: 9000,
  };
  const REC_LINE = 'Thorough search: searched 12 min (up to 20 min allowed); stopped when it stopped improving (no better plan for 6 min). The best plan was last improved after 6 min.';
  const MIN_LINE =
    "The MIN TRUCKS option is in use. It searched for up to 1 min for its own goal (the fewest trucks), after the recommended plan's search (Thorough: 12 min of up to 20 min; stopped when it stopped improving).";
  function seedSearched() {
    seed();
    Object.assign(tables.scenarioResult[0].detailsJson, { search: SEARCH, time_limit_sec: 985, solver_time_sec: 760 });
    // MIN_TRUCKS searched its own 60 s limit after it (no early stop), then the load re-check: 75 s.
    Object.assign(tables.scenarioResult[1].detailsJson, { search: SEARCH, time_limit_sec: 60, solver_time_sec: 75 });
  }
  async function sheets(d: PlanDetail) {
    const buf = await buildDispatchWorkbook(d, {
      tenantName: 'NMWC', currency: 'OMR', generatedAt: new Date('2026-09-27T05:00:00Z'), generatedBy: 'Planner', assumptions: withSearchAssumptions(d, {}),
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const rowsOf = (name: string) => {
      const out: string[][] = [];
      wb.getWorksheet(name)!.eachRow((r) => out.push([1, 2, 3].map((c) => r.getCell(c).text)));
      return out;
    };
    return { summary: rowsOf('SUMMARY'), assumptions: rowsOf('ASSUMPTIONS') };
  }

  it('RECOMMENDED in use: its own search, with the progress', async () => {
    seedSearched();
    const d = (await getPlanDetail(T, 'P'))!;
    expect(d.searchOption).toBeNull();
    expect(searchResultText(d.search, d.searchOption)).toBe(REC_LINE);
    const { assumptions } = await sheets(d);
    expect(assumptions.find((r) => r[0] === 'Route search')?.[1]).toBe(REC_LINE);
    expect(assumptions.some((r) => r[0] === 'Route search - progress')).toBe(true);
  });

  it('"Use instead" MIN_TRUCKS: the plan screen, the stored summary and the Excel give its own search, after the recommended one', async () => {
    seedSearched();
    await chooseScenario(T, 'P', 'sc2', 'u1');
    // The summary keeps the option's own search limit next to the report.
    expect(row('runPlan', 'P').summaryJson.solver).toMatchObject({ scenario: 'MIN_TRUCKS', timeSec: 75, limitSec: 60, search: { stop_reason: 'CONVERGED', search_sec: 720 } });
    const d = (await getPlanDetail(T, 'P'))!;
    expect(d.run.chosenScenario).toBe('MIN_TRUCKS');
    expect(d.searchOption).toEqual({ name: 'MIN_TRUCKS', limitSec: 60 });
    // The plan screen's line (plan-view.tsx: searchResultText(d.search, d.searchOption)).
    expect(searchResultText(d.search, d.searchOption)).toBe(MIN_LINE);
    const { summary, assumptions } = await sheets(d);
    // SUMMARY: the option's optimizer time is not called its search, and the search line is its own.
    expect(summary.find((r) => r[0] === 'Route search')?.[2]).toBe('MIN_TRUCKS option · optimizer time 75 s');
    expect(summary.find((r) => r[0] === 'Search time')?.[1]).toBe(MIN_LINE);
    // ASSUMPTIONS: the same line; the recommended plan's progress is not shown as this option's.
    expect(assumptions.find((r) => r[0] === 'Route search')?.[1]).toBe(MIN_LINE);
    expect(assumptions.some((r) => r[0] === 'Route search - progress')).toBe(false);
    for (const r of [...summary, ...assumptions]) expect(r.join(' ')).not.toContain(REC_LINE);
  });

  it('a summary saved before the option limit was kept: its own search without a time', async () => {
    seedSearched();
    await chooseScenario(T, 'P', 'sc2', 'u1');
    delete row('runPlan', 'P').summaryJson.solver.limitSec;
    const d = (await getPlanDetail(T, 'P'))!;
    const { summary } = await sheets(d);
    expect(summary.find((r) => r[0] === 'Search time')?.[1]).toMatch(/^The MIN TRUCKS option is in use\. It searched for its own goal \(the fewest trucks\), after the recommended plan's search/);
  });
});
