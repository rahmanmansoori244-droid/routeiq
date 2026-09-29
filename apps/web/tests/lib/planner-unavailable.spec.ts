/**
 * Rule 22 (owner decision, audit policy 22): when the route optimizer cannot start its worker
 * processes it refuses within seconds with 503 { code: WORKERS_UNAVAILABLE } (apps/solver/main.py)
 * instead of searching inside its API process and freezing the planner. On the web:
 * - the dispatcher reads the plain "The planner is busy or restarting - try again in a minute.";
 * - the job ends FAILED with that message, the plan in use is untouched (a failed re-plan keeps the
 *   copy of the previous plan, loads included), and OPTIMIZE_FAILED is audited with the code;
 * - an administrator gets an ALERT log line (and /api/health says degraded: health.spec.ts);
 * - Optimize / Re-plan again works: nothing is left running, queued or holding a solver slot.
 *
 * The real solver client and the real job run against a local HTTP server standing in for the
 * optimizer, on the in-memory database (fake-plan-db.ts).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>, tx?: Record<string, any>) => (tx ?? m.fakePrisma).auditLog.create({ data: { ...input } })) };
});

/** What buildDispatchRequest returns for a version: its frozen loads from the tables. */
function builtFor(runId: string) {
  const frozen = (tables.planLoad ?? []).filter((l) => l.runId === runId && l.status !== 'PLANNED');
  const frozenOrderIds = frozen.length ? ['O1'] : [];
  const orderIds = frozen.length ? ['O2'] : ['O1'];
  return {
    request: { run_id: runId, tenant_id: 'tA', stops: orderIds.map((id) => ({ stop_id: id })), trucks: [{ id: 'T1', capacity_kg: 0 }] },
    preDrops: [],
    scope: { orderIds, frozenOrderIds, orderPriority: {}, frozenLoadIds: frozen.map((l) => l.id).sort(), frozenLoadOrderIds: frozenOrderIds },
    blocking: [],
    warnings: [],
    unknownWeights: [],
    weightChanges: { lines: [], orders: [] },
  };
}
vi.mock('@/lib/dispatch/plan-service', async (orig) => {
  const real = await orig<typeof import('@/lib/dispatch/plan-service')>();
  return {
    ...real,
    buildDispatchRequest: vi.fn(async (_t: string, runId: string) => builtFor(runId)),
    isLegacyPlan: vi.fn(async () => false),
    pendingLateOrderIds: vi.fn(async () => []),
  };
});

import { callDispatchSolver, SolverError } from '@/lib/solver-client';
import { PLANNER_UNAVAILABLE_MESSAGE, WORKERS_UNAVAILABLE } from '@/lib/planner-unavailable';
import { replan, startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { solveAdmission } from '@/lib/dispatch/solve-admission';
import { activeDispatchJobs } from '@/lib/jobs/dispatch-job';

const T = 'tA';
const user = { id: 'u1' };
const DAY = new Date('2026-09-27T00:00:00Z');

/** The stand-in optimizer: refuses as the solver does when its worker processes cannot start, or plans. */
const optimizer = { mode: 'refuse' as 'refuse' | 'busy' | 'ok', calls: 0 };
let server: http.Server;
const saved = { url: process.env.SOLVER_URL, token: process.env.SOLVER_TOKEN };

function planned(runId: string) {
  // Every order of the request unserved (no truck needed): enough for the job to save and apply it.
  const orderIds = runId === 'P' ? ['O1'] : ['O2'];
  return {
    run_id: runId,
    engine: 'ortools-routing',
    matrix_provider: 'HAVERSINE',
    distance_is_estimated: true,
    warnings: [],
    scenarios: [
      {
        name: 'RECOMMENDED',
        status: 'OPTIMIZED',
        solver_status: 'ROUTING_SUCCESS',
        solver_time_sec: 1,
        trucks_used: 0,
        trips: 0,
        total_distance_km: 0,
        total_duration_min: 0,
        operating_cost: 0,
        avg_utilization_pct: 0,
        loads: [],
        unserved: [{ order_ids: orderIds, reason_code: 'NO_AVAILABLE_TRUCK', reason_message: 'full' }],
        warnings: [],
        objective: null,
      },
    ],
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      optimizer.calls += 1;
      if (optimizer.mode === 'refuse') {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '60' });
        res.end(JSON.stringify({ detail: 'The planner is busy or restarting - try again in a minute.', code: 'WORKERS_UNAVAILABLE' }));
        return;
      }
      if (optimizer.mode === 'busy') {
        // Both solver slots in use (main.py's own 503, no code).
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '60' });
        res.end(JSON.stringify({ detail: 'Solver busy: 2 optimization(s) already running. Try again in a minute.' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(planned(JSON.parse(body).run_id)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.SOLVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SOLVER_TOKEN = 'unit-test-token';
});

afterAll(async () => {
  if (saved.url === undefined) delete process.env.SOLVER_URL;
  else process.env.SOLVER_URL = saved.url;
  if (saved.token === undefined) delete process.env.SOLVER_TOKEN;
  else process.env.SOLVER_TOKEN = saved.token;
  await new Promise<void>((r) => server.close(() => r()));
});

function load(id: string, runId: string, loadNo: number, status: string) {
  return { id, tenantId: T, runId, truckId: 'T1', loadNo, status, driverId: null, departMin: 360 + loadNo * 120, returnMin: 450 + loadNo * 120, distanceKm: 10, durationMin: 90, cases: 20, weightKg: 200, utilizationPct: 50, fuelLitres: null, fuelCost: 1, operatingCost: 5, returnLegKm: 2, distanceIsEstimated: true, carriedFromLoadId: null, statusChangedAt: null, statusChangedById: null, createdAt: new Date() };
}

function assignment(id: string, loadId: string, orderId: string, loadNo: number) {
  return { id, runId: 'P', truckId: 'T1', orderId, sequenceInTruck: 1, plannedArrivalMin: 10, plannedDistanceFromPrevKm: 1, plannedLoadCases: 20, lockedByUserId: null, manualOverrideReason: null, loadId, loadNo, orderInStop: 0, etaMin: 400, serviceStartMin: 400, departureMin: 410, waitMin: 0, cumulativeKm: 1, hardWindowOk: true, prefWindowOk: true, portionCases: null, portionWeightKg: null, portionLinesJson: null };
}

/** Version 1 of the day: a DRAFT without a plan, or READY with T1 Load 1 LOCKED (O1) and Load 2 PLANNED (O2). */
function seed(applied: boolean) {
  resetDb();
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true, lat: 23.6, lng: 58.4 }];
  tables.truck = [{ id: 'T1', tenantId: T, code: 'T01', defaultDriverId: null }];
  tables.driver = [];
  tables.order = ['O1', 'O2'].map((id) => ({ id, tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: applied ? 'ASSIGNED' : 'VALIDATED' }));
  tables.runPlan = [
    {
      id: 'P',
      tenantId: T,
      depotId: 'D1',
      runDate: DAY,
      status: applied ? 'READY' : 'DRAFT',
      version: 1,
      reason: 'INITIAL',
      optimizationMode: 'BALANCED',
      chosenScenarioId: applied ? 'sc1' : null,
      parentRunId: null,
      supersededAt: null,
      currentJobId: null,
      finalizedAt: null,
      totalOrders: 2,
      unservedCount: 0,
      summaryJson: null,
      reconciliationJson: { ok: true },
      changeSummaryJson: null,
      createdById: 'u1',
      createdAt: new Date(),
    },
  ];
  tables.planLoad = applied ? [load('L1', 'P', 1, 'LOCKED'), load('L2', 'P', 2, 'PLANNED')] : [];
  tables.routeAssignment = applied ? [assignment('A1', 'L1', 'O1', 1), assignment('A2', 'L2', 'O2', 2)] : [];
  tables.scenarioResult = applied
    ? [{ id: 'sc1', runId: 'P', name: 'RECOMMENDED', trucksUsed: 1, totalDistanceKm: 20, totalTimeMin: 180, totalCost: 10, avgUtilizationPct: 50, unservedCount: 0, detailsJson: { name: 'RECOMMENDED', status: 'OPTIMIZED', loads: [], scope: { orderIds: ['O1', 'O2'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [] } }, createdAt: new Date() }]
    : [];
  tables.unservedOrder = [];
  tables.runJob = [];
  tables.auditLog = [];
}

/** Wait for the background job of `runId` (the in-flight map of lib/jobs/optimize-job.ts). */
async function jobEnded(runId: string) {
  const g = globalThis as unknown as { __routeiqInflight: Map<string, Promise<void>> };
  await g.__routeiqInflight.get(runId);
}

const idle = () => expect(solveAdmission.snapshot()).toMatchObject({ running: 0, waiting: 0 });

beforeEach(() => {
  optimizer.mode = 'refuse';
  optimizer.calls = 0;
  activeDispatchJobs.clear();
  vi.restoreAllMocks();
});

describe('the solver call', () => {
  it('503 WORKERS_UNAVAILABLE is the plain "busy or restarting" answer with its code; the slots-full 503 keeps its own words', async () => {
    const refused = await callDispatchSolver({ run_id: 'r1', stops: [], trucks: [] } as never).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(SolverError);
    expect(refused).toMatchObject({ status: 503, code: WORKERS_UNAVAILABLE, message: 'The planner is busy or restarting - try again in a minute. Nothing was changed.' });
    expect(PLANNER_UNAVAILABLE_MESSAGE).toBe((refused as Error).message);

    optimizer.mode = 'busy';
    const busy = await callDispatchSolver({ run_id: 'r1', stops: [], trucks: [] } as never).then(
      () => null,
      (e: unknown) => e,
    );
    expect(busy).toMatchObject({ status: 503, message: 'The route optimizer is busy with other plans right now. Optimize again in a minute.' });
    expect((busy as SolverError).code).toBeUndefined();
  });
});

describe('the job, the plan and the retry', () => {
  it('a first optimization refused: the job FAILED with the plain message, nothing saved, audited, alerted; Optimize again then works', async () => {
    seed(false);
    const alerts = vi.spyOn(console, 'error').mockImplementation(() => {});
    const start = await startDispatchOptimize(T, 'P', user, '10.0.0.1');
    expect(start.status).toBe(202);
    await jobEnded('P');

    const job = row('runJob', String(start.body.runJobId));
    expect(job.status).toBe('FAILED');
    expect(job.message).toBe('The planner is busy or restarting - try again in a minute. Nothing was changed.');
    expect(job.errorJson).toMatchObject({ reason: 'SOLVER_ERROR', status: 503, code: 'WORKERS_UNAVAILABLE' });
    expect(row('runPlan', 'P')).toMatchObject({ status: 'FAILED', chosenScenarioId: null });
    expect(tables.scenarioResult).toHaveLength(0);
    expect(tables.planLoad).toHaveLength(0);
    const failed = tables.auditLog.filter((a) => a.action === 'OPTIMIZE_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ entity: 'RunPlan', entityId: 'P', afterJson: { runJobId: job.id, errorJson: { code: 'WORKERS_UNAVAILABLE' } } });
    // The administrator's line, with the same code as the solver's ERROR line.
    const lines = alerts.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith('ALERT WORKERS_UNAVAILABLE:') && l.includes('plan P'))).toHaveLength(1);
    // Nothing left running, waiting or holding a slot.
    idle();
    expect(activeDispatchJobs.size).toBe(0);

    // The optimizer can start its workers again: the dispatcher presses Optimize again.
    optimizer.mode = 'ok';
    const retry = await startDispatchOptimize(T, 'P', user, '10.0.0.1');
    expect(retry.status).toBe(202);
    expect(retry.body.runJobId).not.toBe(job.id);
    await jobEnded('P');
    expect(row('runJob', String(retry.body.runJobId)).status).toBe('SUCCEEDED');
    expect(row('runPlan', 'P').status).toBe('READY');
    expect(row('runPlan', 'P').chosenScenarioId).toBeTruthy();
    expect(optimizer.calls).toBe(2);
    idle();
  });

  it('a re-plan refused: the previous plan stays in use, loads untouched; Re-plan again then works', async () => {
    seed(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null);
    expect(res.status).toBe(202);
    const childId = String(res.body.runId);
    await jobEnded(childId);

    const child = row('runPlan', childId);
    const job = row('runJob', String(res.body.runJobId));
    expect(job).toMatchObject({ status: 'FAILED', message: 'The planner is busy or restarting - try again in a minute. Nothing was changed.' });
    // The version keeps the copy of the previous plan, applied and usable (the screen says
    // "Optimization failed - previous plan kept"): its locked load and its planned load as they were.
    expect(child.status).toBe('FAILED');
    expect(child.chosenScenarioId).toBeTruthy();
    const copies = tables.planLoad.filter((l) => l.runId === childId);
    expect(copies.map((l) => [l.loadNo, l.status, l.carriedFromLoadId])).toEqual([
      [1, 'LOCKED', 'L1'],
      [2, 'PLANNED', 'L2'],
    ]);
    // The parent's own rows are untouched too.
    expect(tables.planLoad.filter((l) => l.runId === 'P').map((l) => [l.id, l.status])).toEqual([
      ['L1', 'LOCKED'],
      ['L2', 'PLANNED'],
    ]);
    expect(tables.auditLog.filter((a) => a.action === 'OPTIMIZE_FAILED' && a.entityId === childId)).toHaveLength(1);
    idle();

    // Re-plan again (a failed version holding a plan is re-planned as a new version).
    optimizer.mode = 'ok';
    const again = await replan(T, childId, 'REOPTIMIZE', null, user, null);
    expect(again.status).toBe(202);
    const nextId = String(again.body.runId);
    await jobEnded(nextId);
    expect(row('runJob', String(again.body.runJobId)).status).toBe('SUCCEEDED');
    expect(row('runPlan', nextId).status).toBe('READY');
    // The locked load went through both versions unchanged.
    expect(tables.planLoad.filter((l) => l.runId === nextId && l.status === 'LOCKED')).toHaveLength(1);
    idle();
  });
});
