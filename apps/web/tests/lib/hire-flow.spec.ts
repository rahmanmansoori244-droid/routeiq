/**
 * The hire suggestion's server side (owner request 6 Oct 2026) on the in-memory database
 * (fake-plan-db.ts), with the request builder, the version and plan writers and the optimizer call
 * replaced: the what-if starts only for a plan the fleet cannot carry and a depot with hire options,
 * sends one truck per unit the day may still rent (Quick, the recommended plan only) and stores the
 * suggestion; "Use this plan" rents the trucks as one-day trucks and applies the what-if's plan as the
 * next version when nothing changed, else re-plans with them; the dispatcher's plate; the janitor's
 * sweeps. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRequest, DispatchResponse, DispatchStop } from '@routeiq/shared-types';
import { fakePrisma, resetDb, row, tables } from './fake-plan-db';

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

import { callDispatchSolver } from '@/lib/solver-client';
import { applyScenario, buildDispatchRequest, createNextVersionTx, persistDispatchResult, type BuiltRequest } from '@/lib/dispatch/plan-service';
import { replan, replanRefusal } from '@/lib/dispatch/start-optimize';
import { basisFingerprint, cancelHireChecksOfDay, failLostHireChecks, hireView, retireOneDayTrucks, startHireCheck, type HireBasis } from '@/lib/dispatch/hire-whatif';
import { applyHireSuggestion } from '@/lib/dispatch/hire-use';
import { setHiredTruck } from '@/lib/dispatch/hired-truck';
import { summarizeHire, virtualHireId } from '@/lib/dispatch/hire';
import { solveAdmission } from '@/lib/dispatch/solve-admission';
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
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat' }];
  tables.runPlan = [{ id: 'P1', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 1, chosenScenarioId: 'SC1', supersededAt: null }];
  tables.scenarioResult = [
    {
      id: 'SC1',
      runId: 'P1',
      name: 'RECOMMENDED',
      detailsJson: {
        scope: {},
        loads: [],
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
    // Built as a re-plan of the version, by pallets (an option has bays).
    expect(vi.mocked(buildDispatchRequest).mock.calls[0]).toEqual([T, 'P1', ['RECOMMENDED'], { withPallets: true }]);
    const sent = vi.mocked(callDispatchSolver).mock.calls[0]![0];
    expect(sent.trucks.map((t) => t.id)).toEqual(['OWN', virtualHireId('o10', 1), virtualHireId('o10', 2), virtualHireId('o3', 1), virtualHireId('o3', 2)]);
    expect(sent.trucks.filter((t) => t.hire_candidate).length).toBe(4);
    expect(sent.config).toMatchObject({ scenarios: ['RECOMMENDED'], search_mode: 'QUICK', max_search_sec: null });
    // The 10-ton is costed with the fleet's all-in km rate (0.1 + 0.26 / 3.5) and trip cost.
    expect(sent.trucks[1]).toMatchObject({ fixed_cost: 50, trip_cost: 3, bays: 12 });
    expect(sent.trucks[1]!.cost_per_km).toBeCloseTo(0.1 + 0.26 / 3.5, 4);
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
    (tables.scenarioResult![0]!.detailsJson as { unserved: { reason_code: string }[] }).unserved.forEach((u) => (u.reason_code = 'HARD_WINDOW_INFEASIBLE'));
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

/** A finished suggestion for P1, as the what-if stores it. */
function finishedSuggestion(extra: Record<string, unknown> = {}) {
  const b = built();
  const options = tables.hireOption!.filter((o) => o.active).map(({ id, label, bays, capacityCases, payloadKg, costPerDay, costPerKm, maxPerDay }) => ({ id, label, bays, capacityCases, payloadKg, costPerDay, costPerKm, maxPerDay }));
  const req: DispatchRequest = {
    ...b.request,
    trucks: [...b.request.trucks, { id: virtualHireId('o10', 1), code: 'HIRE-10T-1', capacity_cases: 1140, bays: 12, fixed_cost: 50, cost_per_km: 0.17, trip_cost: 3, hire_candidate: true }, { id: virtualHireId('o3', 1), code: 'HIRE-3T-1', capacity_cases: 570, bays: 6, fixed_cost: 30, cost_per_km: 0.2, trip_cost: 3, hire_candidate: true }],
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
      depotId: 'D1', hired: true, onlyOnDate: DAY, hireOptionId: 'o10', bays: 12, capacityCases: 1140, capacityWeightKg: 0, fixedCostPerDay: 50, costPerKm: 0.17, tripCost: 3, active: true,
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
});

describe("a one-day hired truck's plate (setHiredTruck, PLANNER)", () => {
  beforeEach(() => {
    tables.truck!.push(
      { id: 'OLD', tenantId: T, depotId: 'D1', code: '12345AB', active: false, hired: true, onlyOnDate: new Date('2099-10-01T00:00:00Z'), defaultDriverId: null },
      { id: 'PAST', tenantId: T, depotId: 'D1', code: 'HIRE-3T-0101-1', active: true, hired: true, onlyOnDate: new Date('2020-01-01T00:00:00Z'), defaultDriverId: null },
    );
    tables.driver = [{ id: 'dr', tenantId: T, name: 'Salim', active: true }];
  });

  it('sets the plate (and a default driver), audited', async () => {
    const after = await setHiredTruck(T, 'H0', { code: '99999-XY', defaultDriverId: 'dr' }, user, null);
    expect(after).toMatchObject({ code: '99999-XY', defaultDriverId: 'dr' });
    expect(tables.auditLog.at(-1)).toMatchObject({ action: 'HIRED_TRUCK_CHANGED', entity: 'Truck', entityId: 'H0' });
  });

  it("frees a plate an earlier day's hired truck still has; refuses an own truck's code", async () => {
    await setHiredTruck(T, 'H0', { code: '12345AB' }, user, null);
    expect(row('truck', 'H0').code).toBe('12345AB');
    expect(row('truck', 'OLD').code).toBe('12345AB.991001');
    await expect(setHiredTruck(T, 'H0', { code: 'R1' }, user, null)).rejects.toMatchObject({ status: 409, details: { code: 'CODE_TAKEN' } });
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
