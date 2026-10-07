/**
 * The hire suggestion's server side (owner request 6 Oct 2026) on the in-memory database
 * (fake-plan-db.ts), with the request builder, the version and plan writers and the optimizer call
 * replaced: the what-if starts only for a plan the fleet cannot carry and a depot with hire options,
 * sends one truck per unit the day may still rent (Quick, the recommended plan only) and stores the
 * suggestion; "Use this plan" rents the trucks as one-day trucks and applies the what-if's plan as the
 * next version when nothing changed, else re-plans with them; the dispatcher's plate; the janitor's
 * sweeps. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchStop } from '@routeiq/shared-types';
import { fakePrisma, rawLog, resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({
  audit: vi.fn(async (input: Record<string, unknown>, tx?: typeof fakePrisma) => (tx ?? fakePrisma).auditLog.create({ data: { ...input } })),
}));
vi.mock('@/lib/solver-client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/solver-client')>()), callDispatchSolver: vi.fn() }));
vi.mock('@/lib/dispatch/plan-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dispatch/plan-service')>()),
  buildDispatchRequest: vi.fn(),
  createNextVersionTx: vi.fn(),
  persistDispatchResult: vi.fn(),
  applyScenario: vi.fn(),
  applyWeightChanges: vi.fn(),
}));
vi.mock('@/lib/dispatch/start-optimize', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dispatch/start-optimize')>()),
  replan: vi.fn(),
  replanRefusal: vi.fn(async () => null),
}));

import { callDispatchSolver, SolverError } from '@/lib/solver-client';
import { applyScenario, buildDispatchRequest, createNextVersionTx, persistDispatchResult, sameDayBasis, type BuiltRequest } from '@/lib/dispatch/plan-service';
import { replan, replanRefusal } from '@/lib/dispatch/start-optimize';
import {
  activeHireJobs,
  basisFingerprint,
  cancelHireChecksOfDay,
  failLostHireChecks,
  hireCheckKey,
  hireView,
  rentedOnDay,
  retireOneDayTrucks,
  startHireCheck,
  startHireCheckAfterPlan,
  type HireBasis,
} from '@/lib/dispatch/hire-whatif';
import { applyHireSuggestion, withRentedTrucks } from '@/lib/dispatch/hire-use';
import { setHiredTruck } from '@/lib/dispatch/hired-truck';
import { summarizeHire, virtualHireId } from '@/lib/dispatch/hire';
import { PREEMPT_RETRY, solveAdmission, type SolveTicket } from '@/lib/dispatch/solve-admission';
import { failJobsForShutdown } from '@/lib/jobs/shutdown';
import { todayIso } from '@/lib/dispatch/time';

const T = 'tA';
const DAY = new Date('2099-10-07T00:00:00Z');
const user = { id: 'u1' };
const stop = (id: string, cases: number, units: number): DispatchStop => ({
  stop_id: id, order_ids: [`o-${id}`], customer_id: `c-${id}`, lat: 23.6, lng: 58.4, demand_cases: cases, demand_kg: 0, demand_pallet_units: units, priority: 3,
});
const STOPS = [stop('A', 600, 6000), stop('B', 600, 6000), stop('C', 300, 3000)];

function built(stops: DispatchStop[] = STOPS): BuiltRequest {
  const request: DispatchRequest = {
    run_id: 'P1', tenant_id: T, depot: { id: 'D1', lat: 23.6, lng: 58.4 }, stops,
    trucks: [{ id: 'OWN', code: 'R1', capacity_cases: 1140, bays: 12, fixed_cost: 35, cost_per_km: 0.1, km_per_litre: 3.5, trip_cost: 3, max_trips: 1, frozen_trips: [{ load_no: 1, depart_min: 400, return_min: 600 }] }],
    config: { fuel_price_per_litre: 0.26, scenarios: ['RECOMMENDED'] } as DispatchRequest['config'],
  };
  return { request, preDrops: [], scope: { orderIds: stops.flatMap((s) => s.order_ids), frozenOrderIds: [], orderPriority: {}, frozenLoadIds: ['L1'] }, blocking: [], warnings: [], unknownWeights: [], weightChanges: { lines: [], orders: [] }, missingPalletFactors: [] };
}

function seed() {
  resetDb();
  // The checks' start notes live in process memory (hire-whatif.ts hireStarts): none from another test.
  (globalThis as { __routeiqHireStarts?: Map<string, unknown> }).__routeiqHireStarts?.clear();
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat' }];
  tables.runPlan = [{ id: 'P1', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 1, chosenScenarioId: 'SC1', supersededAt: null }];
  tables.scenarioResult = [
    {
      id: 'SC1',
      runId: 'P1',
      name: 'RECOMMENDED',
      detailsJson: {
        scope: {},
        // The plan in use: A on the own truck; B and C left out for the fleet.
        loads: [{ truck_id: 'OWN', load_no: 1, stops: [{ sequence: 1, stop_id: 'A', order_ids: ['o-A'] }] }],
        unserved: [
          { stop_id: 'B', order_ids: ['o-B'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY', reason_message: 'Fleet capacity shortage' },
          { stop_id: 'C', order_ids: ['o-C'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY', reason_message: 'Fleet capacity shortage' },
        ],
      },
    },
  ];
  tables.hireOption = [
    { id: 'o10', tenantId: T, depotId: 'D1', label: '10-ton', bays: 12, capacityCases: 1140, payloadKg: 0, costPerDay: 50, costPerKm: null, maxPerDay: 3, active: true },
    { id: 'o3', tenantId: T, depotId: 'D1', label: '3-ton', bays: 6, capacityCases: 570, payloadKg: 0, costPerDay: 30, costPerKm: 0.2, maxPerDay: 2, active: true },
    { id: 'off', tenantId: T, depotId: 'D1', label: 'old', bays: 4, capacityCases: 0, payloadKg: 0, costPerDay: 10, costPerKm: null, maxPerDay: 5, active: false },
  ];
  tables.truck = [
    { id: 'OWN', tenantId: T, depotId: 'D1', code: 'R1', active: true, hired: false, onlyOnDate: null, hireOptionId: null },
    // One 10-ton already rented for the day: two more may be.
    { id: 'H0', tenantId: T, depotId: 'D1', code: 'HIRE-10T-0710-1', active: true, hired: true, onlyOnDate: DAY, hireOptionId: 'o10' },
  ];
  vi.mocked(buildDispatchRequest).mockReset().mockImplementation(async () => built());
  vi.mocked(callDispatchSolver).mockReset();
  vi.mocked(createNextVersionTx).mockReset();
  vi.mocked(persistDispatchResult).mockReset();
  vi.mocked(applyScenario).mockReset();
  vi.mocked(replan).mockReset();
  vi.mocked(replanRefusal).mockReset().mockResolvedValue(null);
}
beforeEach(seed);

/** The what-if's answer: the 10-ton (first free unit) carries B, the 3-ton carries C. */
function answer(req: DispatchRequest): DispatchResponse {
  const ten = req.trucks.find((t) => t.id === virtualHireId('o10', 1))!;
  const three = req.trucks.find((t) => t.id === virtualHireId('o3', 1))!;
  const ld = (truck: string, s: DispatchStop, fixed: number) => ({ truck_id: truck, load_no: 1, cases: s.demand_cases, fixed_cost: fixed, total_cost: fixed + 5, stops: [{ sequence: 1, stop_id: s.stop_id, order_ids: s.order_ids }] });
  return {
    run_id: 'P1', engine: 'ortools', matrix_provider: 'HAVERSINE', distance_is_estimated: true,
    scenarios: [
      {
        name: 'RECOMMENDED', status: 'OPTIMIZED', trucks_used: 3, trips: 3, unserved: [],
        loads: [ld('OWN', STOPS[0]!, 0), ld(ten.id, STOPS[1]!, 50), ld(three.id, STOPS[2]!, 30)],
        truck_days: [{ truck_id: ten.id }, { truck_id: three.id }],
      },
    ],
    warnings: [],
    search: { mode: 'QUICK', cap_sec: 540, limit_sec: 5, search_sec: 5, used_sec: 9, stop_reason: 'TIME_LIMIT' },
  } as unknown as DispatchResponse;
}

async function settled(id: string) {
  await vi.waitFor(() => expect(['SUCCEEDED', 'FAILED', 'CANCELLED']).toContain(row('hireSuggestion', id).status), { timeout: 3000 });
  return row('hireSuggestion', id);
}

describe('the what-if (startHireCheck)', () => {
  it('runs for a plan the fleet cannot carry: one truck per unit the day may still rent, Quick, the recommended plan', async () => {
    vi.mocked(callDispatchSolver).mockImplementation(async (req) => answer(req));
    const r = await startHireCheck(T, 'P1', user, null, 'AFTER_PLAN');
    expect(r.started).toBe(true);
    const id = (r as { suggestionId: string }).suggestionId;
    const s = await settled(id);
    expect(s.status).toBe('SUCCEEDED');
    // Built as a re-plan of the version, by pallets (an option has bays), at a time it keeps (basis.builtAt).
    // The customers' parts are sized with every truck the day may still rent too (fix of 7 Oct 2026).
    const tenTon = { capacityCases: 1140, payloadKg: 0, bays: 12 };
    const threeTon = { capacityCases: 570, payloadKg: 0, bays: 6 };
    expect(vi.mocked(buildDispatchRequest).mock.calls[0]).toEqual([
      T,
      'P1',
      ['RECOMMENDED'],
      {
        withPallets: true,
        now: expect.any(Date),
        splitFleet: [
          { code: 'HIRE-10T-1', ...tenTon },
          { code: 'HIRE-10T-2', ...tenTon },
          { code: 'HIRE-3T-1', ...threeTon },
          { code: 'HIRE-3T-2', ...threeTon },
        ],
      },
    ]);
    expect((s.basisJson as HireBasis).splitWithHires).toBe(true);
    expect((s.basisJson as HireBasis).builtAt).toBe((vi.mocked(buildDispatchRequest).mock.calls[0]![3] as { now: Date }).now.toISOString());
    // The orders the plan in use delivers: the summary tells orders added since apart.
    expect((s.basisJson as HireBasis).baseOrders).toEqual(['o-A']);
    const sent = vi.mocked(callDispatchSolver).mock.calls[0]![0];
    expect(sent.trucks.map((t) => t.id)).toEqual(['OWN', virtualHireId('o10', 1), virtualHireId('o10', 2), virtualHireId('o3', 1), virtualHireId('o3', 2)]);
    expect(sent.trucks.filter((t) => t.hire_candidate).length).toBe(4);
    expect(sent.config).toMatchObject({ scenarios: ['RECOMMENDED'], search_mode: 'QUICK', max_search_sec: null });
    // Owner answers 3 and 4 (6 Oct 2026): fuel is in the hire - no km cost unless the option charges per
    // km (the 3-ton: 0.2), never the fleet's - and the casual driver is paid the company's day rate.
    expect(sent.trucks[1]).toMatchObject({ fixed_cost: 50, trip_cost: 3, bays: 12, cost_per_km: 0, km_per_litre: null, driver_day_cost: 10 });
    expect(sent.trucks[3]).toMatchObject({ fixed_cost: 30, cost_per_km: 0.2, km_per_litre: null, driver_day_cost: 10 });
    expect(s.summaryJson).toMatchObject({ status: 'HIRE', hireCost: 80, leftOut: { orders: 2, cases: 900 }, stillLeft: { orders: 0 } });
    expect(s.message).toBe(
      '2 orders (900 cases, 9.0 pallets) cannot be delivered with your fleet. To deliver them, hire 1 x 10-ton (12 bays) + 1 x 3-ton (6 bays): extra about 80 OMR. Still left out: none.',
    );
    expect(tables.auditLog.map((a) => a.action)).toEqual(['HIRE_CHECK_STARTED', 'HIRE_CHECK_FINISHED']);
    expect(solveAdmission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
    const view = await hireView(T, 'P1');
    expect(view).toMatchObject({ options: 2, short: true, canCheck: true, suggestion: { status: 'SUCCEEDED', usable: true } });
  });

  it('does not run without hire options, for a plan that leaves nothing out because of the fleet, or for a version not in use', async () => {
    tables.hireOption = tables.hireOption!.map((o) => ({ ...o, active: false }));
    expect(await startHireCheck(T, 'P1', user, null, 'AFTER_PLAN')).toMatchObject({ started: false, reason: 'NO_OPTIONS' });
    seed();
    (tables.scenarioResult![0]!.detailsJson as { unserved: { reason_code: string }[] }).unserved.forEach((u) => (u.reason_code = 'LOCKED_PLAN_CONFLICT'));
    expect(await startHireCheck(T, 'P1', user, null, 'AFTER_PLAN')).toMatchObject({ started: false, reason: 'NOT_SHORT' });
    seed();
    row('runPlan', 'P1').status = 'SUPERSEDED';
    expect(await startHireCheck(T, 'P1', user, null, 'ASKED')).toMatchObject({ started: false, reason: 'NOT_CURRENT' });
    seed();
    row('runPlan', 'P1').chosenScenarioId = null;
    expect(await startHireCheck(T, 'P1', user, null, 'ASKED')).toMatchObject({ started: false, reason: 'NO_PLAN' });
    expect(vi.mocked(callDispatchSolver)).not.toHaveBeenCalled();
    expect(tables.hireSuggestion ?? []).toEqual([]);
  });

  it('every truck of the options already rented for the day: nothing to add', async () => {
    tables.truck!.push(
      { id: 'H1', tenantId: T, depotId: 'D1', code: 'x1', active: true, hired: true, onlyOnDate: DAY, hireOptionId: 'o10' },
      { id: 'H2', tenantId: T, depotId: 'D1', code: 'x2', active: true, hired: true, onlyOnDate: DAY, hireOptionId: 'o10' },
      { id: 'H3', tenantId: T, depotId: 'D1', code: 'x3', active: true, hired: true, onlyOnDate: DAY, hireOptionId: 'o3' },
      { id: 'H4', tenantId: T, depotId: 'D1', code: 'x4', active: true, hired: true, onlyOnDate: DAY, hireOptionId: 'o3' },
    );
    expect(await startHireCheck(T, 'P1', user, null, 'ASKED')).toMatchObject({ started: false, reason: 'NO_UNITS' });
  });

  it("the trucks to rent carry the company's daily driver day rate (Settings)", async () => {
    vi.mocked(buildDispatchRequest).mockImplementation(async () => ({ ...built(), settings: { dailyDriverDayRate: 12.5 } as never }));
    vi.mocked(callDispatchSolver).mockImplementation(async (req) => answer(req));
    const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
    await settled((r as { suggestionId: string }).suggestionId);
    const sent = vi.mocked(callDispatchSolver).mock.calls[0]![0];
    expect(sent.trucks.filter((t) => t.hire_candidate).map((t) => t.driver_day_cost)).toEqual([12.5, 12.5, 12.5, 12.5]);
    expect(sent.trucks[0]!.driver_day_cost).toBeUndefined(); // an own truck keeps its hourly driver
  });

  it('only P4/P5 orders left out: no check, and the box says plainly that renting is not suggested for them (owner answer 1)', async () => {
    const d = tables.scenarioResult![0]!.detailsJson as { scope: Record<string, unknown> };
    d.scope = { orderPriority: { 'o-A': 3, 'o-B': 4, 'o-C': 5 } };
    const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
    expect(r).toMatchObject({ started: false, reason: 'NOT_SHORT', message: 'Left out: 2 orders, all P4/P5 - renting is not suggested for them.' });
    expect(callDispatchSolver).not.toHaveBeenCalled();
    expect(tables.hireSuggestion ?? []).toEqual([]);
    expect(await hireView(T, 'P1')).toMatchObject({ short: false, lowLeftOut: 2, lowNote: 'Left out: 2 orders, all P4/P5 - renting is not suggested for them.' });
    // One P3 order among them: the check runs (it is for that order; the others may ride along).
    d.scope = { orderPriority: { 'o-A': 3, 'o-B': 3, 'o-C': 5 } };
    vi.mocked(buildDispatchRequest).mockImplementation(async () => built([STOPS[0]!, STOPS[1]!, { ...STOPS[2]!, priority: 5 }]));
    vi.mocked(callDispatchSolver).mockImplementation(async (req) => answer(req));
    const r2 = await startHireCheck(T, 'P1', user, null, 'ASKED');
    expect(r2.started).toBe(true);
    const s = await settled((r2 as { suggestionId: string }).suggestionId);
    expect(s.summaryJson).toMatchObject({ status: 'HIRE', leftOut: { orders: 1 }, low: { leftOut: { orders: 1 } } });
    expect(await hireView(T, 'P1')).toMatchObject({ short: true, lowLeftOut: 1 });
  });

  it('every order the plan left out is gone from the day (brought forward, say): no check, never "0 orders" (review)', async () => {
    // B and C were carried to tomorrow: the day to plan has A only, and no new order.
    vi.mocked(buildDispatchRequest).mockImplementation(async () => built([STOPS[0]!]));
    const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
    expect(r).toMatchObject({ started: false, reason: 'NOTHING_LEFT' });
    expect((r as { message: string }).message).toMatch(/^Nothing is left out for lack of trucks any more/);
    expect(callDispatchSolver).not.toHaveBeenCalled();
    // Third review: recorded (never run), so the box stays quiet after a restart too.
    expect((tables.hireSuggestion ?? []).map((h) => [h.status, h.errorJson?.reason])).toEqual([['CANCELLED', 'NOTHING_LEFT']]);
    // The box stops offering the check for this plan.
    expect(await hireView(T, 'P1')).toMatchObject({ short: false });
  });

  it('never two at once for a version; a new optimization of the day stops a running one', async () => {
    let release!: () => void;
    vi.mocked(callDispatchSolver).mockImplementation(
      (_req, opts) =>
        new Promise((_resolve, reject) => {
          release = () => reject(new Error('never'));
          opts?.signal?.addEventListener('abort', () => reject(new (class extends Error {})('cancelled')));
        }),
    );
    const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
    const id = (r as { suggestionId: string }).suggestionId;
    await vi.waitFor(() => expect(row('hireSuggestion', id).status).toBe('RUNNING'));
    expect(await startHireCheck(T, 'P1', user, null, 'ASKED')).toMatchObject({ started: false, reason: 'RUNNING', suggestionId: id });
    expect(await cancelHireChecksOfDay(T, 'D1', DAY, 'Stopped: a new optimization started for this day.')).toBe(1);
    const s = await settled(id);
    expect(s).toMatchObject({ status: 'CANCELLED', message: 'Stopped: a new optimization started for this day.' });
    expect(tables.auditLog.map((a) => a.action)).toEqual(['HIRE_CHECK_STARTED', 'HIRE_CHECK_FAILED']);
    void release;
    expect(solveAdmission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });

  it('a failed optimizer call ends the check FAILED with its words; the plan is never touched', async () => {
    vi.mocked(callDispatchSolver).mockRejectedValue(new Error('boom'));
    const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
    const s = await settled((r as { suggestionId: string }).suggestionId);
    expect(s.status).toBe('FAILED');
    expect(s.message).toMatch(/boom/);
    expect(row('runPlan', 'P1')).toMatchObject({ status: 'READY', chosenScenarioId: 'SC1', version: 1 });
  });
});

/** The other companies' dispatchers' solves that fill the optimizer (SOLVER_MAX_CONCURRENT 2), released after the test. */
const held: { release(): void }[] = [];
function dispatcherSolve(tenantId: string) {
  const r = solveAdmission.reserve(tenantId, 'u');
  if (!r.ok) throw new Error('admission refused');
  held.push(r.ticket);
  return r.ticket;
}
afterEach(() => {
  for (const t of held.splice(0)) t.release();
  // The re-plan way of Use this plan hands its admission ticket to the re-plan (mocked here).
  for (const c of vi.mocked(replan).mock.calls) (c[10] as { ticket?: SolveTicket } | undefined)?.ticket?.release();
});

describe('the what-if (review of the hire branch)', () => {
  it('a day that is over: no check, no box button (DAY_OVER), and Use this plan is refused', async () => {
    row('runPlan', 'P1').runDate = new Date('2020-01-07T00:00:00Z');
    expect(await startHireCheck(T, 'P1', user, null, 'ASKED')).toMatchObject({ started: false, reason: 'DAY_OVER' });
    expect(tables.hireSuggestion ?? []).toEqual([]);
    expect(await hireView(T, 'P1')).toMatchObject({ canCheck: false });
    finishedSuggestion();
    expect((await hireView(T, 'P1'))!.suggestion).toMatchObject({ usable: false });
    expect(await applyHireSuggestion(T, 'P1', 'HS1', user, null)).toMatchObject({ status: 409, body: { code: 'DAY_OVER' } });
    expect(tables.truck!.length).toBe(2);
  });

  it('one check at a time per version: a check created meanwhile wins; the optimizer being busy leaves no row behind', async () => {
    // Another check of this version is created while this one builds its request (the automatic one
    // and "Check hire options" pressed together): this one answers RUNNING, no second row.
    vi.mocked(buildDispatchRequest).mockImplementationOnce(async () => {
      tables.hireSuggestion = [{ id: 'OTHER', tenantId: T, runId: 'P1', status: 'QUEUED', trigger: 'AFTER_PLAN', createdAt: new Date() }];
      return built();
    });
    expect(await startHireCheck(T, 'P1', user, null, 'ASKED')).toMatchObject({ started: false, reason: 'RUNNING', suggestionId: 'OTHER' });
    expect(tables.hireSuggestion!.map((r) => r.id)).toEqual(['OTHER']);
    expect(rawLog.some((sql) => /pg_advisory_xact_lock/.test(sql))).toBe(true);
    // Busy: a check of this company already waits for the optimizer, which is full.
    seed();
    dispatcherSolve('tB');
    dispatcherSolve('tC');
    const waiting = solveAdmission.reserveBackground(T, 'u', () => undefined, hireCheckKey('D1', DAY));
    expect(waiting.ok && waiting.ticket.waiting).toBe(true);
    if (waiting.ok) held.push(waiting.ticket);
    expect(await startHireCheck(T, 'P1', user, null, 'ASKED')).toMatchObject({ started: false, reason: 'BUSY' });
    expect(tables.hireSuggestion ?? []).toEqual([]);
  });

  it('a check a dispatcher preempted goes back to the queue once, and runs when a slot frees', async () => {
    let calls = 0;
    vi.mocked(callDispatchSolver).mockImplementation((req, opts) => {
      calls++;
      if (calls > 1) return Promise.resolve(answer(req));
      return new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(new SolverError('The optimization was cancelled.', 0, null, 'CANCELLED'))));
    });
    const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
    const id = (r as { suggestionId: string }).suggestionId;
    await vi.waitFor(() => expect(row('hireSuggestion', id).status).toBe('RUNNING'));
    // Two other companies' dispatchers fill the optimizer: the second takes the check's slot.
    const b = dispatcherSolve('tB');
    const c = dispatcherSolve('tC');
    expect(c.preemptedOthers).toBe(true);
    await vi.waitFor(() => expect(row('hireSuggestion', id).status).toBe('QUEUED'));
    b.release();
    const s = await settled(id);
    expect(s.status).toBe('SUCCEEDED');
    expect(calls).toBe(2);
  });

  it('ISSUE 6: a check queued at 09:05 that runs at 09:20 sends the optimizer 09:20 as now, and Use this plan keeps those times', async () => {
    /** The day built at `now` with the same-day rule (plan-service sameDayBasis): 06:00 first departure, turnaround and loading 0. */
    const builtSameDay = (now: Date): BuiltRequest => {
      const b = built();
      const basis = sameDayBasis({ runDateIso: '2099-10-07', timezone: 'Asia/Muscat', firstDepartureMin: 360, prepMin: 0, depotCloseMin: null, loading: { perCase: 0, exampleCases: 0 } }, 360, now);
      const t = basis.timing;
      b.request.config = { ...b.request.config, shift_start_min: t.planFrom?.fromMin ?? 360, ...(t.loadingFromMin !== null ? { loading_from_min: t.loadingFromMin } : {}) };
      b.sameDay = basis;
      b.warnings = t.warning ? [t.warning] : [];
      b.settings = { timezone: 'Asia/Muscat', planFrom: t.planFrom, loadingFromMin: t.loadingFromMin } as never;
      return b;
    };
    /** The earliest a new load may leave, as the optimizer reads it (dispatch_solver._new_load_start_min, turnaround 0). */
    const earliestDeparture = (c: Record<string, any>) => Math.max(c.shift_start_min, typeof c.loading_from_min === 'number' ? c.loading_from_min : 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2099-10-07T05:05:00Z')); // 09:05 in Muscat, on the delivery day
      vi.mocked(buildDispatchRequest).mockImplementation(async (_t, _r, _s, o) => builtSameDay(o?.now ?? new Date()));
      vi.mocked(callDispatchSolver).mockImplementation(async (req) => answer(req));
      // Two other companies' dispatchers fill the optimizer: the check waits for a slot.
      dispatcherSolve('tB');
      const c = dispatcherSolve('tC');
      const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
      const id = (r as { suggestionId: string }).suggestionId;
      expect(row('hireSuggestion', id).status).toBe('QUEUED');
      expect(row('hireSuggestion', id).requestJson.config.loading_from_min).toBe(545); // built at 09:05
      vi.setSystemTime(new Date('2099-10-07T05:20:00Z')); // the slot frees at 09:20: its search starts now
      c.release();
      const s = await settled(id);
      expect(s.status).toBe('SUCCEEDED');
      const sent = vi.mocked(callDispatchSolver).mock.calls[0]![0].config as Record<string, any>;
      expect(earliestDeparture(sent)).toBeGreaterThanOrEqual(560);
      expect(sent).toMatchObject({ shift_start_min: 560, loading_from_min: 560 });
      // What was sent is what is stored, with the moment the search started.
      expect(JSON.parse(JSON.stringify(s.requestJson.config))).toMatchObject({ shift_start_min: 560, loading_from_min: 560 });
      // (vi.waitFor moves the faked clock on a few milliseconds while it waits.)
      expect((s.basisJson as HireBasis).timedAt).toMatch(/^2099-10-07T05:20:00\./);

      // "Use this plan" at 09:22, nothing changed: the check's loads are saved with the times they were
      // planned with - the plan's warning and settings say 09:20 too, never the 09:05 of the queue.
      vi.setSystemTime(new Date('2099-10-07T05:22:00Z'));
      vi.mocked(createNextVersionTx).mockResolvedValue({ child: { id: 'P2', version: 2 }, frozenLoadsCarried: 1, newLoadId: new Map([['L1', 'L1-copy']]) } as never);
      vi.mocked(persistDispatchResult).mockResolvedValue(new Map([['RECOMMENDED', 'SC2']]));
      const u = await applyHireSuggestion(T, 'P1', id, user, null);
      expect(u.body).toMatchObject({ applied: 'PLAN' });
      const [, , , b] = vi.mocked(persistDispatchResult).mock.calls[0]!;
      expect(b.request.config).toMatchObject({ shift_start_min: 560, loading_from_min: 560 });
      expect(b.settings).toMatchObject({ planFrom: { fromMin: 560 }, loadingFromMin: 560 });
      expect(b.warnings[0]).toMatch(/^Planned from 09:20 \(now 09:20 \+ 0 min preparation\)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a check waiting for a slot is not run once its version was replaced meanwhile', async () => {
    dispatcherSolve('tB');
    const c = dispatcherSolve('tC');
    const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
    const id = (r as { suggestionId: string }).suggestionId;
    expect(row('hireSuggestion', id).status).toBe('QUEUED');
    row('runPlan', 'P1').status = 'SUPERSEDED';
    c.release();
    const s = await settled(id);
    expect(s).toMatchObject({ status: 'CANCELLED' });
    expect(s.message).toMatch(/no longer the one in use/);
    expect(callDispatchSolver).not.toHaveBeenCalled();
  });

  it('the box shows the running check, else the last usable suggestion: a newer check that failed or was stopped is a note', async () => {
    finishedSuggestion();
    tables.hireSuggestion!.push({ id: 'HS2', tenantId: T, runId: 'P1', status: 'CANCELLED', trigger: 'ASKED', message: 'Stopped so that ...', basisJson: row('hireSuggestion', 'HS1').basisJson, createdAt: new Date(Date.now() + 1000) });
    const v = await hireView(T, 'P1');
    expect(v!.suggestion).toMatchObject({ id: 'HS1', status: 'SUCCEEDED', usable: true, note: 'Stopped so that ...' });
    tables.hireSuggestion!.push({ id: 'HS3', tenantId: T, runId: 'P1', status: 'RUNNING', trigger: 'ASKED', basisJson: row('hireSuggestion', 'HS1').basisJson, createdAt: new Date(Date.now() - 1000) });
    expect((await hireView(T, 'P1'))!.suggestion).toMatchObject({ id: 'HS3', status: 'RUNNING' });
  });

  it('a suggestion computed for another plan option is not offered for the option in use', async () => {
    finishedSuggestion();
    tables.scenarioResult!.push({ ...tables.scenarioResult![0]!, id: 'SC9', name: 'MIN_TRUCKS' });
    row('runPlan', 'P1').chosenScenarioId = 'SC9';
    const v = await hireView(T, 'P1');
    expect(v!.suggestion).toMatchObject({ id: 'HS1', forOtherOption: true, usable: false });
  });

  it('says when a check is on its way (a plan just saved) and why none ran; never "checking" otherwise', async () => {
    expect(await hireView(T, 'P1')).toMatchObject({ checkExpected: false, skipNote: null });
    // The plan's job has just saved its plan: its check is created a moment later.
    tables.runJob = [{ id: 'J1', tenantId: T, runId: 'P1', status: 'SUCCEEDED', finishedAt: new Date() }];
    expect(await hireView(T, 'P1')).toMatchObject({ checkExpected: true });
    tables.runJob = [{ id: 'J1', tenantId: T, runId: 'P1', status: 'SUCCEEDED', finishedAt: new Date(Date.now() - 5 * 60_000) }];
    expect(await hireView(T, 'P1')).toMatchObject({ checkExpected: false });
    // The automatic check did not start (products without cases per pallet): the box says why.
    vi.mocked(buildDispatchRequest).mockImplementation(async () => ({ ...built(), missingPalletFactors: [{ productCode: 'P-1' }] }) as never);
    await startHireCheckAfterPlan(T, 'P1', 'u1', null);
    const v = await hireView(T, 'P1');
    expect(v).toMatchObject({ checkExpected: false });
    expect(v!.skipNote).toMatch(/no cases per pallet: P-1/);
  });
});

/** A finished suggestion for P1, as the what-if stores it. */
function finishedSuggestion(extra: Record<string, unknown> = {}) {
  const b = built();
  const options = tables.hireOption!.filter((o) => o.active).map(({ id, label, bays, capacityCases, payloadKg, costPerDay, costPerKm, maxPerDay }) => ({ id, label, bays, capacityCases, payloadKg, costPerDay, costPerKm, maxPerDay }));
  const req: DispatchRequest = {
    ...b.request,
    trucks: [
      ...b.request.trucks,
      { id: virtualHireId('o10', 1), code: 'HIRE-10T-1', capacity_cases: 1140, bays: 12, fixed_cost: 50, cost_per_km: 0, km_per_litre: null, trip_cost: 3, driver_day_cost: 10, hire_candidate: true },
      { id: virtualHireId('o3', 1), code: 'HIRE-3T-1', capacity_cases: 570, bays: 6, fixed_cost: 30, cost_per_km: 0.2, km_per_litre: null, trip_cost: 3, driver_day_cost: 10, hire_candidate: true },
    ],
  };
  const resp = answer(req);
  const basis: HireBasis = {
    v: 1, depotId: 'D1', dateIso: '2099-10-07', runVersion: 1, scenarioId: 'SC1',
    baseUnserved: [{ stop_id: 'B', order_ids: ['o-B'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' }, { stop_id: 'C', order_ids: ['o-C'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY' }],
    fingerprint: basisFingerprint(b.request, b.scope.frozenLoadIds), withPallets: true, options, alreadyRented: { o10: 1 },
  };
  const summary = summarizeHire({ request: req, baseUnserved: basis.baseUnserved, whatIf: resp.scenarios[0]!, options });
  tables.hireSuggestion = [{ id: 'HS1', tenantId: T, runId: 'P1', status: 'SUCCEEDED', trigger: 'AFTER_PLAN', basisJson: basis, requestJson: req, responseJson: resp, summaryJson: summary, usedAt: null, usedRunId: null, createdAt: new Date(), ...extra }];
}

describe('"Use this plan" (applyHireSuggestion)', () => {
  it('nothing changed: rents the trucks for the day and applies the what-if plan as the next version, in one transaction', async () => {
    finishedSuggestion();
    vi.mocked(createNextVersionTx).mockResolvedValue({ child: { id: 'P2', version: 2 }, frozenLoadsCarried: 1, newLoadId: new Map([['L1', 'L1-copy']]) } as never);
    vi.mocked(persistDispatchResult).mockResolvedValue(new Map([['RECOMMENDED', 'SC2']]));
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null, { expect: { date: '2099-10-07', depotId: 'D1' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ runId: 'P2', version: 2, applied: 'PLAN' });
    const rented = tables.truck!.filter((t) => t.id !== 'OWN' && t.id !== 'H0');
    // HIRE-10T-0710-1 is taken (the 10-ton rented before): the next free number.
    expect(rented.map((t) => t.code).sort()).toEqual(['HIRE-10T-0710-2', 'HIRE-3T-0710-1']);
    expect(rented.find((t) => t.code === 'HIRE-10T-0710-2')).toMatchObject({
      depotId: 'D1', hired: true, onlyOnDate: DAY, hireOptionId: 'o10', bays: 12, capacityCases: 1140, capacityWeightKg: 0, fixedCostPerDay: 50, costPerKm: 0, kmPerLitre: null, tripCost: 3, active: true,
      // The day as the badge next to it says it (seventh review: "for 2099-10-07" beside "1 day: 7 Oct").
      description: 'Hired 10-ton for 7 Oct (hire suggestion)',
    });
    expect(vi.mocked(createNextVersionTx).mock.calls[0]!.slice(1)).toEqual([T, 'P1', 'REOPTIMIZE', 'Hire suggestion: 1 x 10-ton (12 bays) + 1 x 3-ton (6 bays)', 'u1']);
    const [, , runId, b, resp] = vi.mocked(persistDispatchResult).mock.calls[0]!;
    expect(runId).toBe('P2');
    const ids = rented.map((t) => t.id);
    // The plan is saved with the rented trucks under their new ids, as plain trucks, around the copied frozen loads.
    expect(b.request.trucks.map((t) => t.id)).toEqual(['OWN', ...[virtualHireId('o10', 1), virtualHireId('o3', 1)].map((v) => rented.find((t) => t.hireOptionId === v.split('~')[1])!.id)]);
    expect(b.request.trucks.some((t) => t.hire_candidate)).toBe(false);
    expect(b.scope.frozenLoadIds).toEqual(['L1-copy']);
    expect(resp.scenarios.map((s) => s.name)).toEqual(['RECOMMENDED']);
    expect(resp.scenarios[0]!.loads.map((l) => l.truck_id).every((id) => id === 'OWN' || ids.includes(id))).toBe(true);
    expect(vi.mocked(applyScenario).mock.calls[0]!.slice(1)).toEqual([T, 'P2', 'SC2', 'u1']);
    expect(row('hireSuggestion', 'HS1')).toMatchObject({ usedById: 'u1', usedRunId: 'P2' });
    expect(tables.auditLog.map((a) => a.action)).toEqual(['HIRED_TRUCKS_ADDED', 'HIRE_SUGGESTION_USED']);
    expect(replan).not.toHaveBeenCalled();
    // Used once: the second press is refused.
    expect(await applyHireSuggestion(T, 'P1', 'HS1', user, null)).toMatchObject({ status: 409, body: { code: 'ALREADY_USED' } });
  });

  it('reads the day again as the what-if did: with its trucks to rent sizing the parts (a suggestion stored before that flag: as before)', async () => {
    vi.mocked(createNextVersionTx).mockResolvedValue({ child: { id: 'P2', version: 2 }, frozenLoadsCarried: 1, newLoadId: new Map([['L1', 'L1-copy']]) } as never);
    vi.mocked(persistDispatchResult).mockResolvedValue(new Map([['RECOMMENDED', 'SC2']]));
    finishedSuggestion();
    (tables.hireSuggestion![0]!.basisJson as HireBasis).splitWithHires = true;
    expect((await applyHireSuggestion(T, 'P1', 'HS1', user, null)).status).toBe(200);
    const fleet = [
      { code: 'HIRE-10T-1', capacityCases: 1140, payloadKg: null, bays: 12 },
      { code: 'HIRE-3T-1', capacityCases: 570, payloadKg: null, bays: 6 },
    ];
    // Read before the locks and again under them: both times the what-if's way.
    expect(vi.mocked(buildDispatchRequest).mock.calls.map((c) => c[3])).toEqual([
      { withPallets: true, now: undefined, splitFleet: fleet },
      { withPallets: true, now: undefined, splitFleet: fleet },
    ]);
    seed();
    finishedSuggestion();
    vi.mocked(createNextVersionTx).mockResolvedValue({ child: { id: 'P2', version: 2 }, frozenLoadsCarried: 1, newLoadId: new Map([['L1', 'L1-copy']]) } as never);
    vi.mocked(persistDispatchResult).mockResolvedValue(new Map([['RECOMMENDED', 'SC2']]));
    expect((await applyHireSuggestion(T, 'P1', 'HS1', user, null)).status).toBe(200);
    expect(vi.mocked(buildDispatchRequest).mock.calls.map((c) => c[3])).toEqual([
      { withPallets: true, now: undefined },
      { withPallets: true, now: undefined },
    ]);
  });

  it('the day changed since: rents the trucks, then a Quick RE-PLAN plans the day with them', async () => {
    finishedSuggestion();
    vi.mocked(buildDispatchRequest).mockImplementation(async () => built([...STOPS, stop('D', 100, 1000)]));
    vi.mocked(replan).mockResolvedValue({ status: 202, body: { runJobId: 'J', runId: 'P2', version: 2 } });
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, '1.2.3.4', { expect: { date: '2099-10-07', depotId: 'D1' } });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ applied: 'REPLAN', runId: 'P2', why: ['the orders, trucks, loads or settings of the day changed'] });
    expect(tables.truck!.filter((t) => t.onlyOnDate && t.id !== 'H0').length).toBe(2);
    expect(vi.mocked(replan).mock.calls[0]!.slice(0, 4)).toEqual([T, 'P1', 'REOPTIMIZE', 'Hire suggestion: 1 x 10-ton (12 bays) + 1 x 3-ton (6 bays)']);
    expect(vi.mocked(replan).mock.calls[0]![9]).toBe('QUICK');
    expect(persistDispatchResult).not.toHaveBeenCalled();
    expect(row('hireSuggestion', 'HS1').usedRunId).toBe('P2');
  });

  it('an option changed since, or another truck of it rented: re-plan instead', async () => {
    finishedSuggestion();
    row('hireOption', 'o3').costPerDay = 35;
    vi.mocked(replan).mockResolvedValue({ status: 202, body: { runId: 'P2' } });
    expect((await applyHireSuggestion(T, 'P1', 'HS1', user, null)).body).toMatchObject({ applied: 'REPLAN', why: ['the 3-ton hire option was changed or switched off'] });
  });

  it("a re-plan's question comes first: nothing is rented until the dispatcher answers", async () => {
    finishedSuggestion();
    vi.mocked(buildDispatchRequest).mockImplementation(async () => built([...STOPS, stop('D', 100, 1000)]));
    vi.mocked(replanRefusal).mockResolvedValue({ status: 409, body: { error: '1 customer(s) need a location before re-planning.', code: 'LOCATION_REQUIRED', blocking: [] } });
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(r).toMatchObject({ status: 409, body: { code: 'LOCATION_REQUIRED' } });
    expect(tables.truck!.length).toBe(2);
    expect(row('hireSuggestion', 'HS1').usedAt).toBeNull();
    expect(replan).not.toHaveBeenCalled();
  });

  it('refused: not finished, nothing to hire, a newer version, an optimization running, another day on screen', async () => {
    finishedSuggestion({ status: 'RUNNING' });
    expect(await applyHireSuggestion(T, 'P1', 'HS1', user, null)).toMatchObject({ status: 409, body: { code: 'NOT_READY' } });
    finishedSuggestion();
    row('hireSuggestion', 'HS1').summaryJson = { ...row('hireSuggestion', 'HS1').summaryJson, status: 'NO_HELP', hires: [] };
    expect(await applyHireSuggestion(T, 'P1', 'HS1', user, null)).toMatchObject({ status: 409, body: { code: 'NOTHING_TO_HIRE' } });
    finishedSuggestion();
    row('runPlan', 'P1').status = 'SUPERSEDED';
    expect(await applyHireSuggestion(T, 'P1', 'HS1', user, null)).toMatchObject({ status: 409, body: { code: 'SUPERSEDED' } });
    row('runPlan', 'P1').status = 'OPTIMIZING';
    expect(await applyHireSuggestion(T, 'P1', 'HS1', user, null)).toMatchObject({ status: 409, body: { code: 'OPTIMIZING' } });
    row('runPlan', 'P1').status = 'READY';
    expect(await applyHireSuggestion(T, 'P1', 'HS1', user, null, { expect: { date: '2099-10-08', depotId: 'D1' } })).toMatchObject({ status: 409, body: { code: 'DAY_MISMATCH' } });
    expect(await applyHireSuggestion('tB', 'P1', 'HS1', user, null)).toMatchObject({ status: 404 });
    expect(tables.truck!.length).toBe(2);
  });

  it('computed for another plan option than the one in use now: refused on the server too (review)', async () => {
    // Review of the hire branch: another dispatcher chose MIN_TRUCKS ("Use instead") after the check;
    // a screen opened before still offered Use this plan, and the server applied the check made for
    // the other option - dropping orders the option in use delivers without the "dropped" protection.
    finishedSuggestion();
    tables.scenarioResult!.push({ ...tables.scenarioResult![0]!, id: 'SC9', name: 'MIN_TRUCKS' });
    row('runPlan', 'P1').chosenScenarioId = 'SC9';
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(r).toMatchObject({ status: 409, body: { code: 'HIRE_OTHER_OPTION' } });
    expect(String(r.body.error)).toMatch(/another plan option.*Check hire options again/);
    expect(tables.truck!.length).toBe(2);
    expect(row('hireSuggestion', 'HS1').usedAt).toBeNull();
    expect(persistDispatchResult).not.toHaveBeenCalled();
    expect(replan).not.toHaveBeenCalled();
  });

  it('two options with the same size tag: each finding names its own rented truck (review)', () => {
    // "10-ton curtain" and "10-ton box" both sent HIRE-10T-1: the first truck's code replaced both.
    const b = built();
    const whatIf: DispatchRequest = {
      ...b.request,
      trucks: [
        ...b.request.trucks,
        { id: virtualHireId('cur', 1), code: 'HIRE-10T-1', capacity_cases: 1140, bays: 12, fixed_cost: 50, hire_candidate: true },
        { id: virtualHireId('box', 1), code: 'HIRE-10T-2', capacity_cases: 1140, bays: 12, fixed_cost: 55, hire_candidate: true },
      ],
    };
    const resp = {
      run_id: 'P1',
      warnings: [],
      scenarios: [
        {
          name: 'RECOMMENDED', loads: [], truck_days: [], warnings: ['HIRE-10T-2 is used for 2 loads'],
          feasibility: { status: 'VIOLATED', violations: [{ code: 'TURNAROUND', truck_id: virtualHireId('box', 1), load_no: 2, message: 'HIRE-10T-2 L2 leaves too early' }] },
        },
      ],
    } as unknown as DispatchResponse;
    const made = new Map([
      [virtualHireId('cur', 1), { id: 'T-CUR', code: 'HIRE-10T-0710-1' }],
      [virtualHireId('box', 1), { id: 'T-BOX', code: 'HIRE-10T-0710-2' }],
    ]);
    const out = withRentedTrucks(whatIf, resp, made, b.request);
    const v = out.response.scenarios[0]!.feasibility!.violations[0]!;
    expect(v).toMatchObject({ truck_id: 'T-BOX', message: 'HIRE-10T-0710-2 L2 leaves too early' });
    expect(out.response.scenarios[0]!.warnings).toEqual(['HIRE-10T-0710-2 is used for 2 loads']);
  });
});

describe('"Use this plan" (review of the hire branch)', () => {
  function planApplied() {
    vi.mocked(createNextVersionTx).mockResolvedValue({ child: { id: 'P2', version: 2 }, frozenLoadsCarried: 1, newLoadId: new Map([['L1', 'L1-copy']]) } as never);
    vi.mocked(persistDispatchResult).mockResolvedValue(new Map([['RECOMMENDED', 'SC2']]));
  }

  it('a same-day plan used a few minutes later keeps the times it was planned with (never the later clock)', async () => {
    // The check was made at 10:00 (new loads from 10:00 + 30 min); Use this plan is pressed at 10:05.
    finishedSuggestion();
    const s = row('hireSuggestion', 'HS1');
    s.requestJson = { ...s.requestJson, config: { ...s.requestJson.config, shift_start_min: 630, loading_from_min: 600 } };
    vi.mocked(buildDispatchRequest).mockImplementation(async () => {
      const b = built();
      b.request.config = { ...b.request.config, shift_start_min: 635, loading_from_min: 605 };
      b.settings = { loadingFromMin: 605 } as never;
      return b;
    });
    planApplied();
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(r.body).toMatchObject({ applied: 'PLAN' });
    const [, , , b] = vi.mocked(persistDispatchResult).mock.calls[0]!;
    expect(b.request.config).toMatchObject({ shift_start_min: 630, loading_from_min: 600 });
    expect(b.settings).toMatchObject({ loadingFromMin: 600 });
  });

  it("the optimizer's own timetable findings on a rented truck name the rented truck (and its code), so the timetable gate holds its loads", async () => {
    finishedSuggestion();
    const s = row('hireSuggestion', 'HS1');
    const sc = s.responseJson.scenarios[0];
    sc.feasibility = { status: 'VIOLATED', timing: 'EXACT', violations: [{ code: 'HARD_WINDOW', truck_id: virtualHireId('o10', 1), load_no: 1, message: 'HIRE-10T-1 L1 arrives after closing' }] };
    sc.warnings = ['HIRE-10T-1 is used for 2 loads'];
    planApplied();
    await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    const ten = tables.truck!.find((t) => t.hireOptionId === 'o10' && t.id !== 'H0')!;
    const [, , , , resp] = vi.mocked(persistDispatchResult).mock.calls[0]!;
    const v = resp.scenarios[0]!.feasibility!.violations[0]!;
    expect(v.truck_id).toBe(ten.id);
    expect(v.message).toBe(`${ten.code} L1 arrives after closing`);
    expect(resp.scenarios[0]!.warnings).toEqual([`${ten.code} is used for 2 loads`]);
  });

  it('lines without a weight: asked first when a truck to hire has a payload, before anything is rented (both ways)', async () => {
    tables.hireOption!.forEach((o) => (o.payloadKg = o.id === 'o10' ? 10_000 : 0));
    finishedSuggestion();
    // The what-if's own 10-ton carries the payload, as the option said.
    const s = row('hireSuggestion', 'HS1');
    s.requestJson.trucks.find((t: { id: string }) => t.id === virtualHireId('o10', 1)).capacity_kg = 10_000;
    s.basisJson.options.find((o: { id: string }) => o.id === 'o10').payloadKg = 10_000;
    const unknownWeights = [{ productCode: 'P-1', lines: 2, cases: 40 }];
    vi.mocked(buildDispatchRequest).mockImplementation(async () => ({ ...built(), unknownWeights }) as never);
    planApplied();
    expect(await applyHireSuggestion(T, 'P1', 'HS1', user, null)).toMatchObject({ status: 409, body: { code: 'WEIGHT_REQUIRED' } });
    expect(tables.truck!.length).toBe(2);
    expect(row('hireSuggestion', 'HS1').usedAt).toBeNull();
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null, { overrides: { allowMissingWeights: true } });
    expect(r.body).toMatchObject({ applied: 'PLAN' });
    const [, , , b] = vi.mocked(persistDispatchResult).mock.calls[0]!;
    expect(b.warnings.some((w) => /^Planned without weights for 2 order line\(s\)/.test(w))).toBe(true);
    // The re-plan way asks with the trucks to rent in the request too.
    finishedSuggestion();
    tables.truck = tables.truck!.filter((t) => t.id === 'OWN' || t.id === 'H0');
    row('hireSuggestion', 'HS1').requestJson.trucks.find((t: { id: string }) => t.id === virtualHireId('o10', 1)).capacity_kg = 10_000;
    vi.mocked(buildDispatchRequest).mockImplementation(async () => ({ ...built([...STOPS, stop('D', 100, 1000)]), unknownWeights }) as never);
    vi.mocked(replanRefusal).mockClear();
    vi.mocked(replan).mockResolvedValue({ status: 202, body: { runId: 'P2' } });
    await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    const probe = vi.mocked(replanRefusal).mock.calls[0]![2];
    expect(probe.request.trucks.some((t) => (t.capacity_kg ?? 0) === 10_000)).toBe(true);
  });

  it("an option's max per day lowered since: never rented past it", async () => {
    finishedSuggestion();
    // The 10-ton: H0 already rented for the day, and the company can now rent only 1.
    row('hireOption', 'o10').maxPerDay = 1;
    vi.mocked(replan).mockResolvedValue({ status: 202, body: { runId: 'P2' } });
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(r).toMatchObject({ status: 409, body: { code: 'HIRE_LIMIT' } });
    expect(tables.truck!.length).toBe(2);
    expect(row('hireSuggestion', 'HS1').usedAt).toBeNull();
    expect(replan).not.toHaveBeenCalled();
  });

  it('the codes are given under the company lock (two depots renting at once never pick the same code)', async () => {
    finishedSuggestion();
    planApplied();
    rawLog.length = 0;
    await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(rawLog.filter((sql) => /pg_advisory_xact_lock/.test(sql)).length).toBeGreaterThanOrEqual(1);
  });

  it('a check that leaves out an order the plan in use delivers re-plans with the hired trucks instead of taking that plan', async () => {
    finishedSuggestion();
    const s = row('hireSuggestion', 'HS1');
    s.summaryJson = { ...s.summaryJson, dropped: { orders: 1, cases: 600, palletUnits: 6000, kg: 0, stopIds: ['A'] } };
    vi.mocked(replan).mockResolvedValue({ status: 202, body: { runId: 'P2' } });
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(r.body).toMatchObject({ applied: 'REPLAN', why: ['its plan leaves out orders your plan in use delivers'] });
    expect(persistDispatchResult).not.toHaveBeenCalled();
  });

  it('applied as a new version: a check of the day still waiting is stopped (it was for the version replaced)', async () => {
    finishedSuggestion();
    tables.hireSuggestion!.push({ id: 'HS2', tenantId: T, runId: 'P1', status: 'QUEUED', trigger: 'ASKED', createdAt: new Date() });
    planApplied();
    await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(row('hireSuggestion', 'HS2').status).toBe('CANCELLED');
  });
});

describe('third review of the hire branch', () => {
  function planApplied() {
    vi.mocked(createNextVersionTx).mockResolvedValue({ child: { id: 'P2', version: 2 }, frozenLoadsCarried: 1, newLoadId: new Map([['L1', 'L1-copy']]) } as never);
    vi.mocked(persistDispatchResult).mockResolvedValue(new Map([['RECOMMENDED', 'SC2']]));
  }
  /** The advisory lock keys taken, in order (the fake logs the statements without their values). */
  function lockKeys(): { keys: string[]; stop: () => void } {
    const keys: string[] = [];
    const orig = fakePrisma.$queryRaw;
    fakePrisma.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (/pg_advisory_xact_lock/.test(strings.join('?'))) keys.push(String(values[0]).split(':')[0]!);
      return orig(strings, ...values);
    };
    return { keys, stop: () => (fakePrisma.$queryRaw = orig) };
  }

  it('the check keeps the daily driver day rate it was computed with; a rate changed since re-plans the day (review)', async () => {
    vi.mocked(buildDispatchRequest).mockImplementation(async () => ({ ...built(), settings: { dailyDriverDayRate: 12.5 } as never }));
    vi.mocked(callDispatchSolver).mockImplementation(async (req) => answer(req));
    const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
    const s = await settled((r as { suggestionId: string }).suggestionId);
    expect((s.basisJson as HireBasis).dayRate).toBe(12.5);
    // A check made at 10 OMR; the admin then sets 15: Use this plan re-plans with the rate of now.
    finishedSuggestion();
    vi.mocked(buildDispatchRequest).mockImplementation(async () => ({ ...built(), settings: { dailyDriverDayRate: 15 } as never }));
    vi.mocked(replan).mockResolvedValue({ status: 202, body: { runId: 'P2' } });
    planApplied();
    const used = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(used.body).toMatchObject({ applied: 'REPLAN', why: ['the daily driver day rate was changed'] });
    expect(persistDispatchResult).not.toHaveBeenCalled();
  });

  it("re-plan way: the trucks are rented, and the re-plan's questions asked, as the hire option is now (review)", async () => {
    finishedSuggestion();
    // After the check: the 3-ton's km charge is cleared (fuel in the hire) and the 10-ton gets a payload.
    row('hireOption', 'o3').costPerKm = null;
    row('hireOption', 'o10').payloadKg = 10_000;
    vi.mocked(replan).mockResolvedValue({ status: 202, body: { runId: 'P2' } });
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(r.body).toMatchObject({ applied: 'REPLAN' });
    const probe = vi.mocked(replanRefusal).mock.calls[0]![2];
    expect(probe.request.trucks.find((t) => t.id === virtualHireId('o10', 1))).toMatchObject({ capacity_kg: 10_000, bays: 12, fixed_cost: 50 });
    expect(probe.request.trucks.find((t) => t.id === virtualHireId('o3', 1))).toMatchObject({ cost_per_km: 0, km_per_litre: null });
    const three = tables.truck!.find((t) => t.hireOptionId === 'o3')!;
    expect(three).toMatchObject({ code: 'HIRE-3T-0710-1', costPerKm: 0, capacityWeightKg: 0 });
    expect(tables.truck!.find((t) => t.hireOptionId === 'o10' && t.id !== 'H0')).toMatchObject({ capacityWeightKg: 10_000 });
  });

  it('nothing changed when pressed, but the day changes before the plan is applied: decided again under the locks, re-planned (review)', async () => {
    finishedSuggestion();
    planApplied();
    vi.mocked(replan).mockResolvedValue({ status: 202, body: { runId: 'P2' } });
    // A colleague brings B forward to tomorrow while Use this plan is being pressed.
    let builds = 0;
    vi.mocked(buildDispatchRequest).mockImplementation(async () => (++builds === 1 ? built() : built([STOPS[0]!, STOPS[2]!])));
    const locks = lockKeys();
    try {
      const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
      expect(r.body).toMatchObject({ applied: 'REPLAN', why: ['the orders, trucks, loads or settings of the day changed while the plan was being applied'] });
      expect(createNextVersionTx).not.toHaveBeenCalled();
      expect(persistDispatchResult).not.toHaveBeenCalled();
      // Under the intake lock first (Bring forward, a late order and a file take it), then the hire
      // codes, then the day - the order every other writer keeps.
      expect(locks.keys.slice(0, 3)).toEqual(['intake', 'hire-codes', 'planday']);
    } finally {
      locks.stop();
    }
    // Nothing changed: applied as it is, read again under the same locks.
    tables.truck = tables.truck!.filter((t) => t.id === 'OWN' || t.id === 'H0');
    finishedSuggestion();
    vi.mocked(buildDispatchRequest).mockReset().mockImplementation(async () => built());
    for (const c of vi.mocked(replan).mock.calls) (c[10] as { ticket?: SolveTicket } | undefined)?.ticket?.release();
    vi.mocked(replan).mockClear();
    const again = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(again.body).toMatchObject({ applied: 'PLAN' });
    expect(vi.mocked(buildDispatchRequest).mock.calls.length).toBe(2);
    expect(replan).not.toHaveBeenCalled();
  });

  it("re-plan way: the optimizer's admission is asked before anything is rented (review)", async () => {
    finishedSuggestion();
    vi.mocked(buildDispatchRequest).mockImplementation(async () => built([...STOPS, stop('D', 100, 1000)]));
    // The company already runs one Quick optimization and has two waiting: its Quick queue is full.
    dispatcherSolve(T);
    dispatcherSolve(T);
    dispatcherSolve(T);
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(r).toMatchObject({ status: 429, body: { code: 'SOLVE_QUEUE_TENANT' } });
    expect(r.headers?.['Retry-After']).toBeTruthy();
    expect(tables.truck!.length).toBe(2);
    expect(row('hireSuggestion', 'HS1').usedAt).toBeNull();
    expect(replan).not.toHaveBeenCalled();
    // With room: the ticket reserved before the rental is the one the re-plan starts with.
    for (const t of held.splice(0)) t.release();
    vi.mocked(replan).mockResolvedValue({ status: 202, body: { runId: 'P2' } });
    await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    const pre = vi.mocked(replan).mock.calls[0]![10] as { ticket?: { searchMode: string } } | undefined;
    expect(pre?.ticket?.searchMode).toBe('QUICK');
  });

  it('a database error while a stopped check goes back to the queue never leaks its admission ticket (review)', async () => {
    vi.mocked(callDispatchSolver).mockImplementation(
      (_req, opts) => new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(new SolverError('The optimization was cancelled.', 0, null, 'CANCELLED')))),
    );
    const orig = fakePrisma.hireSuggestion.updateMany;
    fakePrisma.hireSuggestion.updateMany = async (a: { data?: { status?: string } }) => {
      if (a.data?.status === 'QUEUED') throw new Error('connection reset');
      return orig(a);
    };
    try {
      const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
      const id = (r as { suggestionId: string }).suggestionId;
      await vi.waitFor(() => expect(row('hireSuggestion', id).status).toBe('RUNNING'));
      const b = dispatcherSolve('tB');
      const c = dispatcherSolve('tC'); // takes the check's slot: the check goes back to the queue ... and the write fails
      const s = await settled(id);
      expect(s.status).toBe('FAILED');
      b.release();
      c.release();
      held.length = 0;
      expect(solveAdmission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
    } finally {
      fakePrisma.hireSuggestion.updateMany = orig;
    }
  });

  it('a check started while a stopped solve may still hold the optimizer takes its "busy" answer again (review)', async () => {
    const was = { ...PREEMPT_RETRY };
    Object.assign(PREEMPT_RETRY, { settleMs: 10, maxWaitMs: 2_000 });
    try {
      // Another depot's check was stopped by a new optimization while its optimizer call ran.
      const other = solveAdmission.reserveBackground('tZ', 'u', () => undefined, 'Z|2099-10-07');
      if (other.ok) other.ticket.release({ abandoned: true });
      let calls = 0;
      vi.mocked(callDispatchSolver).mockImplementation(async (req) => {
        if (calls++ === 0) throw new SolverError('The route optimizer is busy.', 503, null);
        return answer(req);
      });
      const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
      const s = await settled((r as { suggestionId: string }).suggestionId);
      expect(s.status).toBe('SUCCEEDED');
      expect(calls).toBe(2);
    } finally {
      Object.assign(PREEMPT_RETRY, was);
    }
  });

  it("ISSUE 6: a same-day check that meets that 'busy' answer is timed again for the call that really starts its search", async () => {
    const was = { ...PREEMPT_RETRY };
    Object.assign(PREEMPT_RETRY, { settleMs: 10, maxWaitMs: 5_000 });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2099-10-07T05:05:58Z')); // 09:05:58 in Muscat, on the delivery day
      vi.mocked(buildDispatchRequest).mockImplementation(async (_t, _r, _s, o) => {
        const b = built();
        const basis = sameDayBasis({ runDateIso: '2099-10-07', timezone: 'Asia/Muscat', firstDepartureMin: 360, prepMin: 0, depotCloseMin: null, loading: { perCase: 0, exampleCases: 0 } }, 360, o?.now ?? new Date());
        b.request.config = { ...b.request.config, shift_start_min: basis.timing.planFrom!.fromMin, loading_from_min: basis.timing.loadingFromMin! };
        b.sameDay = basis;
        return b;
      });
      const other = solveAdmission.reserveBackground('tZ', 'u', () => undefined, 'Z|2099-10-07');
      if (other.ok) other.ticket.release({ abandoned: true });
      const sent: Record<string, any>[] = [];
      vi.mocked(callDispatchSolver).mockImplementation(async (req) => {
        sent.push(JSON.parse(JSON.stringify(req.config)));
        if (sent.length === 1) {
          vi.setSystemTime(new Date('2099-10-07T05:06:01Z')); // the optimizer takes the next call at 09:06:01
          throw new SolverError('The route optimizer is busy.', 503, null);
        }
        return answer(req);
      });
      const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
      const s = await settled((r as { suggestionId: string }).suggestionId);
      expect(s.status).toBe('SUCCEEDED');
      expect(sent.map((c) => [c.shift_start_min, c.loading_from_min])).toEqual([
        [545, 545],
        [546, 546],
      ]);
      expect(JSON.parse(JSON.stringify(s.requestJson.config))).toMatchObject({ shift_start_min: 546, loading_from_min: 546 });
      expect((s.basisJson as HireBasis).timedAt).toMatch(/^2099-10-07T05:06:01\./);
    } finally {
      vi.useRealTimers();
      Object.assign(PREEMPT_RETRY, was);
    }
  });

  it('a deploy ends the checks this process runs at once, as it ends the optimizations (review)', async () => {
    vi.mocked(callDispatchSolver).mockImplementation(
      (_req, opts) => new Promise((_resolve, reject) => opts?.signal?.addEventListener('abort', () => reject(new SolverError('The optimization was cancelled.', 0, null, 'CANCELLED')))),
    );
    const r = await startHireCheck(T, 'P1', user, null, 'ASKED');
    const id = (r as { suggestionId: string }).suggestionId;
    await vi.waitFor(() => expect(row('hireSuggestion', id).status).toBe('RUNNING'));
    expect(await failJobsForShutdown(2_000)).toBe(1);
    const s = await settled(id);
    expect(s).toMatchObject({ status: 'FAILED', errorJson: { reason: 'SHUTDOWN' } });
    expect(s.message).toMatch(/The server was restarted during the hire check\. Press Check hire options to run it again\./);
    await vi.waitFor(() => expect(activeHireJobs.has(id)).toBe(false));
    expect(solveAdmission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
    // A system ending: no request's IP on its audit row.
    expect(tables.auditLog.filter((a) => a.action === 'HIRE_CHECK_FAILED').map((a) => a.ip)).toEqual([false]);
  });

  it("an option's max per day counts its rentals wherever the trucks are, also after the option moved depot (review)", async () => {
    // H0 was rented from the 10-ton for the 7th at D1; the admin then moves the option to D2.
    row('hireOption', 'o10').depotId = 'D2';
    expect(await rentedOnDay(T, DAY)).toEqual({ o10: 1 });
  });

  it('system endings of a check (lost with its process, stopped for a new plan) record no request IP (review)', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    tables.hireSuggestion = [
      { id: 'LOST', tenantId: T, runId: 'P1', status: 'RUNNING', heartbeatAt: old, createdAt: old },
      { id: 'WAIT', tenantId: T, runId: 'P1', status: 'QUEUED', heartbeatAt: new Date(), createdAt: new Date() },
    ];
    await failLostHireChecks();
    await cancelHireChecksOfDay(T, 'D1', DAY, 'Stopped: a new optimization started for this day.');
    const rows = tables.auditLog.filter((a) => a.action === 'HIRE_CHECK_FAILED');
    expect(rows.map((a) => a.entityId).sort()).toEqual(['LOST', 'WAIT']);
    expect(rows.every((a) => a.ip === false)).toBe(true);
  });

  it('every order left out gone: recorded, so the box stays quiet after a restart too, and recorded once (review)', async () => {
    vi.mocked(buildDispatchRequest).mockImplementation(async () => built([STOPS[0]!]));
    expect(await startHireCheck(T, 'P1', user, null, 'AFTER_PLAN')).toMatchObject({ started: false, reason: 'NOTHING_LEFT' });
    // A restart (or ten minutes later): the process's own notes are gone.
    (globalThis as { __routeiqHireStarts?: Map<string, unknown> }).__routeiqHireStarts?.clear();
    const v = await hireView(T, 'P1');
    expect(v).toMatchObject({ short: false, checkExpected: false, suggestion: null });
    expect(tables.hireSuggestion).toHaveLength(1);
    expect(tables.hireSuggestion![0]).toMatchObject({ status: 'CANCELLED', errorJson: { reason: 'NOTHING_LEFT' } });
    expect(tables.auditLog.map((a) => a.action)).toEqual(['HIRE_CHECK_FINISHED']);
    expect(await startHireCheck(T, 'P1', user, null, 'ASKED')).toMatchObject({ started: false, reason: 'NOTHING_LEFT' });
    expect(tables.hireSuggestion).toHaveLength(1);
    expect(callDispatchSolver).not.toHaveBeenCalled();
  });

  it('a suggestion whose hire option was switched off is not offered, and pressing it says so plainly (review)', async () => {
    finishedSuggestion();
    row('hireOption', 'o3').active = false;
    const v = await hireView(T, 'P1');
    expect(v!.suggestion).toMatchObject({ usable: false });
    expect(v!.suggestion!.optionNote).toBe('The 3-ton hire option was switched off or deleted since this check. Press Check hire options to check again.');
    const r = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(r).toMatchObject({ status: 409, body: { code: 'HIRE_OPTION_GONE' } });
    expect(String(r.body.error)).toBe('The 3-ton hire option was switched off or deleted. Check hire options again.');
    expect(tables.truck!.length).toBe(2);
    // The depot's last option switched off: no button to point to.
    row('hireOption', 'o10').active = false;
    expect((await hireView(T, 'P1'))!.suggestion!.optionNote).toBe('The 10-ton and 3-ton hire options were switched off or deleted since this check.');
    const r2 = await applyHireSuggestion(T, 'P1', 'HS1', user, null);
    expect(String(r2.body.error)).not.toMatch(/Check hire options/);
    expect(String(r2.body.error)).toMatch(/A company admin can switch it on again/);
  });
});

describe("a one-day hired truck's plate (setHiredTruck, PLANNER)", () => {
  beforeEach(() => {
    tables.truck!.push(
      // A hired truck of a day that is over, and one of a day still to come (both before the 7th).
      { id: 'OLD', tenantId: T, depotId: 'D1', code: '12345AB', active: false, hired: true, onlyOnDate: new Date('2020-01-05T00:00:00Z'), defaultDriverId: null },
      { id: 'SOON', tenantId: T, depotId: 'D1', code: '777XY', active: true, hired: true, onlyOnDate: new Date('2099-10-06T00:00:00Z'), defaultDriverId: null },
      { id: 'PAST', tenantId: T, depotId: 'D1', code: 'HIRE-3T-0101-1', active: true, hired: true, onlyOnDate: new Date('2020-01-01T00:00:00Z'), defaultDriverId: null },
    );
    tables.driver = [{ id: 'dr', tenantId: T, name: 'Salim', active: true }];
  });

  it('sets the plate (and a default driver), audited', async () => {
    const after = await setHiredTruck(T, 'H0', { code: '99999-XY', defaultDriverId: 'dr' }, user, null);
    expect(after).toMatchObject({ code: '99999-XY', defaultDriverId: 'dr' });
    expect(tables.auditLog.at(-1)).toMatchObject({ action: 'HIRED_TRUCK_CHANGED', entity: 'Truck', entityId: 'H0' });
  });

  it("frees a plate a hired truck of a day that is over still has (audited on that truck too); refuses an own truck's code", async () => {
    await setHiredTruck(T, 'H0', { code: '12345AB' }, user, null);
    expect(row('truck', 'H0').code).toBe('12345AB');
    expect(row('truck', 'OLD').code).toBe('12345AB.200105');
    expect(tables.auditLog.filter((a) => a.action === 'HIRED_TRUCK_CHANGED').map((a) => a.entityId).sort()).toEqual(['H0', 'OLD']);
    await expect(setHiredTruck(T, 'H0', { code: 'R1' }, user, null)).rejects.toMatchObject({ status: 409, details: { code: 'CODE_TAKEN' } });
  });

  it("never takes the plate of a hired truck whose day is not over (today's truck mid-shift, or tomorrow's)", async () => {
    await expect(setHiredTruck(T, 'H0', { code: '777XY' }, user, null)).rejects.toMatchObject({ status: 409, details: { code: 'CODE_TAKEN' } });
    await expect(setHiredTruck(T, 'H0', { code: '777XY' }, user, null)).rejects.toThrow(/777XY-2/);
    expect(row('truck', 'SOON').code).toBe('777XY');
  });

  it('only a one-day hired truck, and not after its day', async () => {
    await expect(setHiredTruck(T, 'OWN', { code: 'X1' }, user, null)).rejects.toMatchObject({ status: 403, details: { code: 'NOT_ONE_DAY' } });
    await expect(setHiredTruck(T, 'PAST', { code: 'X1' }, user, null)).rejects.toMatchObject({ details: { code: 'DAY_OVER' } });
    await expect(setHiredTruck('tB', 'H0', { code: 'X1' }, user, null)).rejects.toMatchObject({ status: 404 });
  });
});

describe('the janitor', () => {
  it('retires one-day trucks after their day (today and ordinary trucks stay)', async () => {
    const today = new Date(`${todayIso('Asia/Muscat')}T00:00:00Z`);
    tables.truck!.push(
      { id: 'Y', tenantId: T, depotId: 'D1', code: 'HIRE-Y', active: true, hired: true, onlyOnDate: new Date(today.getTime() - 86_400_000) },
      { id: 'N', tenantId: T, depotId: 'D1', code: 'HIRE-N', active: true, hired: true, onlyOnDate: today },
    );
    expect(await retireOneDayTrucks()).toBe(1);
    expect(row('truck', 'Y').active).toBe(false);
    expect(row('truck', 'N').active).toBe(true);
    expect(row('truck', 'OWN').active).toBe(true);
    expect(tables.auditLog.map((a) => a.action)).toEqual(['ONE_DAY_TRUCKS_RETIRED']);
  });

  it('ends a check lost with its process (no heartbeat for 2 minutes); a live one stays', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    tables.hireSuggestion = [
      { id: 'LOST', tenantId: T, runId: 'P1', status: 'RUNNING', heartbeatAt: old, createdAt: old },
      { id: 'LIVE', tenantId: T, runId: 'P1', status: 'RUNNING', heartbeatAt: new Date(), createdAt: old },
    ];
    expect(await failLostHireChecks()).toBe(1);
    expect(row('hireSuggestion', 'LOST')).toMatchObject({ status: 'FAILED' });
    expect(row('hireSuggestion', 'LIVE').status).toBe('RUNNING');
  });
});
