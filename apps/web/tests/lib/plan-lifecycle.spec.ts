/**
 * Stabilization PR3 - plan lifecycle and concurrency, on an in-memory database (fake-plan-db.ts):
 * the lock statements each mutator issues (and in which order), the status rules and the guarded
 * job finalization. The real-PostgreSQL races are in tests/integration/plan-lifecycle*.spec.ts.
 *
 * - F03: copy-forward re-plan versions; a version without an applied plan never becomes READY
 *   from a load change, and only unlock / back-to-locked are allowed on it.
 * - F06: version 1 is created under the day lock.
 * - F07: applyScenario locks the plan row FIRST and never writes over a superseded version;
 *   a lock timeout answers 409 "Plan is being saved"; NO_SOLUTION options cannot be applied.
 * - ADD-JOB-AUDIT: the job's result and its audit row commit together; failJob never overwrites
 *   READY or SUPERSEDED; a stale result leaves the plan untouched.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, rawLog, resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
const failAudit = { action: null as string | null };
vi.mock('@/lib/audit', () => ({
  audit: vi.fn(async (input: Record<string, unknown>, tx?: typeof fakePrisma) => {
    if (failAudit.action === input.action) throw new Error('audit insert failed (simulated)');
    return (tx ?? fakePrisma).auditLog.create({ data: { ...input } });
  }),
}));
const solver = { impl: null as null | (() => Promise<unknown>) };
vi.mock('@/lib/solver-client', () => ({
  SolverError: class SolverError extends Error {
    constructor(message: string, public status = 0, public responseBody: unknown = null) {
      super(message);
    }
  },
  callDispatchSolver: vi.fn(async () => {
    if (!solver.impl) throw new Error('no solver in this test');
    return solver.impl();
  }),
}));

import {
  applyScenario,
  chooseScenario,
  createInitialPlan,
  createNextVersion,
  PlanError,
  updateLoad,
} from '@/lib/dispatch/plan-service';
import { driverClashes, isHandSetDriver } from '@/lib/dispatch/load-state';
import { driverChangeWarnings } from '@/lib/dispatch/driver-links';
import { isLockBusy, PlanBusyError } from '@/lib/dispatch/plan-locks';
import { SolveAdmission, type SolveTicket } from '@/lib/dispatch/solve-admission';
import { failJob, scheduleDispatchOptimize, type DispatchJobArgs } from '@/lib/jobs/dispatch-job';
import { trackInflight } from '@/lib/jobs/optimize-job';

const T = 'tA';
const user = { id: 'u1', role: 'TENANT_ADMIN' };
const allow = () => true;
const DAY = new Date('2026-09-27T00:00:00Z');

function scope(over: Record<string, unknown> = {}) {
  return { orderIds: ['O2', 'O3'], frozenOrderIds: ['O1'], orderPriority: {}, frozenLoadIds: ['L1'], frozenLoadOrderIds: ['O1'], ...over };
}

function scenarioDetails(over: Record<string, unknown> = {}) {
  return {
    name: 'RECOMMENDED',
    status: 'OPTIMIZED',
    solver_status: 'ROUTING_SUCCESS',
    solver_time_sec: 1,
    trucks_used: 1,
    trips: 1,
    total_distance_km: 10,
    total_duration_min: 60,
    operating_cost: 5,
    avg_utilization_pct: 50,
    loads: [],
    unserved: [],
    warnings: [],
    objective: null,
    engine: 'OR-Tools',
    matrix_provider: 'HAVERSINE',
    distance_is_estimated: true,
    response_warnings: [],
    scope: scope(),
    ...over,
  };
}

function load(id: string, runId: string, loadNo: number, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tenantId: T,
    runId,
    truckId: 'T1',
    loadNo,
    status,
    driverId: null,
    departMin: 360 + loadNo * 120,
    returnMin: 450 + loadNo * 120,
    distanceKm: 10,
    durationMin: 90,
    cases: 20,
    weightKg: 200,
    utilizationPct: 50,
    fuelLitres: null,
    fuelCost: 1,
    operatingCost: 5,
    returnLegKm: 2,
    distanceIsEstimated: true,
    carriedFromLoadId: null,
    statusChangedAt: null,
    statusChangedById: null,
    createdAt: new Date(),
    ...extra,
  };
}

function assignment(id: string, runId: string, loadId: string, orderId: string, loadNo: number) {
  return {
    id,
    runId,
    truckId: 'T1',
    orderId,
    sequenceInTruck: 1,
    plannedArrivalMin: 10,
    plannedDistanceFromPrevKm: 1,
    plannedLoadCases: 20,
    lockedByUserId: null,
    manualOverrideReason: null,
    loadId,
    loadNo,
    orderInStop: 0,
    etaMin: 400,
    serviceStartMin: 400,
    departureMin: 410,
    waitMin: 0,
    cumulativeKm: 1,
    hardWindowOk: true,
    prefWindowOk: true,
    portionCases: null,
    portionWeightKg: null,
    portionLinesJson: null,
  };
}

/** Version 1, applied: T1 Load 1 LOCKED (order O1), Load 2 PLANNED (O2), O3 unserved. */
function seedAppliedPlan(status = 'READY', extra: Record<string, unknown> = {}) {
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true, lat: 23.6, lng: 58.4 }];
  tables.truck = [{ id: 'T1', tenantId: T, code: 'T01', defaultDriverId: null }];
  tables.order = ['O1', 'O2', 'O3'].map((id) => ({ id, tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED' }));
  tables.runPlan = [
    {
      id: 'P',
      tenantId: T,
      depotId: 'D1',
      runDate: DAY,
      status,
      version: 1,
      reason: 'INITIAL',
      optimizationMode: 'BALANCED',
      chosenScenarioId: 'sc1',
      parentRunId: null,
      supersededAt: null,
      currentJobId: null,
      finalizedAt: null,
      totalOrders: 3,
      unservedCount: 1,
      summaryJson: { ordersServed: 2 },
      reconciliationJson: { ok: true },
      changeSummaryJson: null,
      createdById: 'u1',
      createdAt: new Date(),
      ...extra,
    },
  ];
  tables.planLoad = [load('L1', 'P', 1, 'LOCKED'), load('L2', 'P', 2, 'PLANNED')];
  tables.routeAssignment = [assignment('A1', 'P', 'L1', 'O1', 1), assignment('A2', 'P', 'L2', 'O2', 2)];
  tables.scenarioResult = [
    { id: 'sc1', runId: 'P', name: 'RECOMMENDED', trucksUsed: 1, totalDistanceKm: 10, totalTimeMin: 60, totalCost: 5, avgUtilizationPct: 50, unservedCount: 1, detailsJson: scenarioDetails(), createdAt: new Date() },
  ];
  tables.unservedOrder = [{ id: 'U1', scenarioId: 'sc1', orderId: 'O3', reasonCode: 'NO_AVAILABLE_TRUCK', reasonMessage: 'full', portionCases: null, portionWeightKg: null, portionLinesJson: null, createdAt: new Date() }];
  tables.runJob = [];
  tables.auditLog = [];
  tables.driver = [];
}

const forUpdateIndex = () => rawLog.findIndex((s) => /FROM "RunPlan" WHERE id = \? AND "tenantId" = \? FOR UPDATE/.test(s));
const dayLockIndex = () => rawLog.findIndex((s) => /pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)/.test(s));

beforeEach(() => {
  resetDb();
  failAudit.action = null;
  solver.impl = null;
});

describe('createNextVersion: copy-forward (F03) under the day lock (F06)', () => {
  it('copies every load, the chosen option and the plan facts; the child is usable; the parent is superseded', async () => {
    seedAppliedPlan();
    const { child, frozenLoadsCarried } = await createNextVersion(T, 'P', 'REOPTIMIZE', null, 'u1');
    expect(frozenLoadsCarried).toBe(1);
    // Lock order: lock timeout, day lock, then the parent row.
    expect(rawLog[0]).toMatch(/SET LOCAL lock_timeout/);
    expect(dayLockIndex()).toBeGreaterThanOrEqual(0);
    expect(forUpdateIndex()).toBeGreaterThan(dayLockIndex());

    const c = row('runPlan', child.id);
    expect(c.version).toBe(2);
    expect(c.parentRunId).toBe('P');
    expect(c.status).toBe('READY');
    expect(c.reconciliationJson).toEqual({ ok: true });
    expect(c.summaryJson).toEqual({ ordersServed: 2 });
    expect(c.totalOrders).toBe(3);
    expect(c.unservedCount).toBe(1);
    const copies = tables.planLoad.filter((l) => l.runId === child.id);
    expect(copies.map((l) => [l.carriedFromLoadId, l.status]).sort()).toEqual([
      ['L1', 'LOCKED'],
      ['L2', 'PLANNED'],
    ]);
    const stops = tables.routeAssignment.filter((a) => a.runId === child.id);
    expect(stops.map((a) => a.orderId).sort()).toEqual(['O1', 'O2']);
    for (const a of stops) expect(copies.some((l) => l.id === a.loadId)).toBe(true);

    // The chosen option is copied (alternatives are not); its frozen loads are the copies.
    expect(c.chosenScenarioId).toBeTruthy();
    expect(c.chosenScenarioId).not.toBe('sc1');
    const sc = row('scenarioResult', c.chosenScenarioId);
    expect(sc.runId).toBe(child.id);
    const l1copy = copies.find((l) => l.carriedFromLoadId === 'L1')!;
    expect(sc.detailsJson.scope.frozenLoadIds).toEqual([l1copy.id]);
    expect(tables.unservedOrder.filter((u) => u.scenarioId === sc.id).map((u) => u.orderId)).toEqual(['O3']);

    const p = row('runPlan', 'P');
    expect(p.status).toBe('SUPERSEDED');
    expect(p.supersededAt).toBeInstanceOf(Date);
    const auditRow = tables.auditLog.find((a) => a.action === 'PLAN_VERSION_CREATED')!;
    expect(auditRow.afterJson).toMatchObject({ frozenLoadsCarried: 1, loadsCopied: 2, planCopied: true });
  });

  it('a child of a plan whose loads are all out is DISPATCHED, not READY', async () => {
    seedAppliedPlan('DISPATCHED', { finalizedAt: new Date('2026-09-27T05:00:00Z') });
    for (const l of tables.planLoad) l.status = 'DISPATCHED';
    const { child } = await createNextVersion(T, 'P', 'LATE_ORDER', 'late', 'u1');
    expect(row('runPlan', child.id).status).toBe('DISPATCHED');
    expect(row('runPlan', child.id).finalizedAt).toBeInstanceOf(Date);
  });

  it('refuses a parent that was written READY over its supersede (supersededAt set): nothing is created', async () => {
    seedAppliedPlan('READY', { supersededAt: new Date() });
    await expect(createNextVersion(T, 'P', 'REOPTIMIZE', null, 'u1')).rejects.toMatchObject({ status: 409 });
    expect(tables.runPlan).toHaveLength(1);
  });

  it('refuses a parent that is optimizing or has a job running', async () => {
    seedAppliedPlan('OPTIMIZING');
    await expect(createNextVersion(T, 'P', 'REOPTIMIZE', null, 'u1')).rejects.toMatchObject({ status: 409 });
    seedAppliedPlan('FAILED');
    tables.runJob = [{ id: 'J9', runId: 'P', tenantId: T, attemptNo: 1, status: 'RUNNING' }];
    await expect(createNextVersion(T, 'P', 'REOPTIMIZE', null, 'u1')).rejects.toMatchObject({ status: 409 });
    expect(tables.runPlan).toHaveLength(1);
  });
});

describe('createInitialPlan (F06)', () => {
  it('takes the day lock before looking for the live plan, and returns the existing one', async () => {
    seedAppliedPlan();
    const res = await createInitialPlan(T, 'D1', '2026-09-27', 'u1');
    expect(res.created).toBe(false);
    expect(res.run.id).toBe('P');
    expect(dayLockIndex()).toBeGreaterThanOrEqual(0);
    expect(tables.runPlan).toHaveLength(1);
  });

  it('creates version 1 (DRAFT, INITIAL) with its audit row when the day has no live plan', async () => {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
    const res = await createInitialPlan(T, 'D1', '2026-09-28', 'u1', { audit: { depotCode: 'D1' }, ip: '10.0.0.1' });
    expect(res.created).toBe(true);
    expect(row('runPlan', res.run.id)).toMatchObject({ version: 1, reason: 'INITIAL', status: 'DRAFT' });
    expect(tables.auditLog[0]).toMatchObject({ action: 'CREATE', entityId: res.run.id, ip: '10.0.0.1' });
  });

  it('refuses an inactive depot', async () => {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: false }];
    await expect(createInitialPlan(T, 'D1', '2026-09-28', 'u1')).rejects.toBeInstanceOf(PlanError);
    expect(tables.runPlan ?? []).toHaveLength(0);
  });
});

describe('applyScenario / chooseScenario (F07)', () => {
  it('locks the plan row before it reads anything, and refuses a version written READY over its supersede', async () => {
    seedAppliedPlan('READY', { supersededAt: new Date() });
    tables.scenarioResult.push({ id: 'sc2', runId: 'P', name: 'MIN_TRUCKS', detailsJson: scenarioDetails({ name: 'MIN_TRUCKS' }) });
    await expect(applyScenario(fakePrisma as never, T, 'P', 'sc2', 'u1')).rejects.toMatchObject({ status: 409 });
    expect(forUpdateIndex()).toBe(0);
    expect(row('runPlan', 'P').status).toBe('READY'); // untouched
    expect(row('runPlan', 'P').chosenScenarioId).toBe('sc1');
  });

  it('refuses an OPTIMIZING version for a dispatcher (only its own job may apply)', async () => {
    seedAppliedPlan('OPTIMIZING', { currentJobId: 'J1' });
    tables.scenarioResult.push({ id: 'sc2', runId: 'P', name: 'MIN_TRUCKS', detailsJson: scenarioDetails({ name: 'MIN_TRUCKS' }) });
    await expect(applyScenario(fakePrisma as never, T, 'P', 'sc2', 'u1')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a NO_SOLUTION option chosen by the dispatcher; the plan is unchanged', async () => {
    seedAppliedPlan();
    tables.planLoad = tables.planLoad.filter((l) => l.status === 'PLANNED'); // nothing locked in this version
    tables.routeAssignment = tables.routeAssignment.filter((a) => a.loadId === 'L2');
    tables.scenarioResult.push({ id: 'sc2', runId: 'P', name: 'MIN_TRUCKS', detailsJson: scenarioDetails({ name: 'MIN_TRUCKS', status: 'NO_SOLUTION', scope: scope({ frozenLoadIds: [], frozenLoadOrderIds: [], frozenOrderIds: [] }) }) });
    const err = await chooseScenario(T, 'P', 'sc2', 'u1').catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.status).toBe(409);
    expect(err.details).toMatchObject({ code: 'SCENARIO_NOT_USABLE' });
    expect(row('runPlan', 'P').chosenScenarioId).toBe('sc1');
    expect(tables.planLoad.map((l) => l.id)).toEqual(['L2']);
  });

  it('choose-scenario is refused once a load of this version was locked', async () => {
    seedAppliedPlan();
    tables.scenarioResult.push({ id: 'sc2', runId: 'P', name: 'MIN_TRUCKS', detailsJson: scenarioDetails({ name: 'MIN_TRUCKS' }) });
    await expect(chooseScenario(T, 'P', 'sc2', 'u1')).rejects.toMatchObject({ status: 409 });
    expect(row('runPlan', 'P').chosenScenarioId).toBe('sc1');
  });

  it('sets DISPATCHED (with finalizedAt), not READY, when every load of the version is already out', async () => {
    seedAppliedPlan('READY');
    for (const l of tables.planLoad) l.status = 'DISPATCHED';
    tables.scenarioResult.push({
      id: 'sc2',
      runId: 'P',
      name: 'MIN_TRUCKS',
      detailsJson: scenarioDetails({ name: 'MIN_TRUCKS', scope: scope({ frozenLoadIds: ['L1', 'L2'], frozenLoadOrderIds: ['O1', 'O2'], frozenOrderIds: ['O1', 'O2'], orderIds: ['O3'] }) }),
    });
    await applyScenario(fakePrisma as never, T, 'P', 'sc2', 'u1');
    expect(row('runPlan', 'P')).toMatchObject({ status: 'DISPATCHED', chosenScenarioId: 'sc2' });
    expect(row('runPlan', 'P').finalizedAt).toBeInstanceOf(Date);
  });
});

describe('load changes on a version without an applied plan (F03 / L14)', () => {
  function seedStrandedChild(status: 'DRAFT' | 'FAILED') {
    seedAppliedPlan('SUPERSEDED', { supersededAt: new Date() });
    tables.runPlan.push({ ...tables.runPlan[0], id: 'C', status, version: 2, parentRunId: 'P', chosenScenarioId: null, supersededAt: null, reconciliationJson: null, summaryJson: null });
    tables.planLoad.push(load('CL1', 'C', 1, 'LOCKED', { carriedFromLoadId: 'L1' }));
    tables.routeAssignment.push(assignment('CA1', 'C', 'CL1', 'O1', 1));
  }

  for (const status of ['DRAFT', 'FAILED'] as const) {
    it(`${status}: Loading is refused and the version stays ${status}; Unlock is allowed and it still stays ${status}`, async () => {
      seedStrandedChild(status);
      const err = await updateLoad(T, 'C', 'CL1', { status: 'LOADING' }, user, allow).catch((e) => e);
      expect(err).toBeInstanceOf(PlanError);
      expect(err.details).toMatchObject({ code: 'NO_PLAN_APPLIED' });
      expect(row('planLoad', 'CL1').status).toBe('LOCKED');
      expect(row('runPlan', 'C').status).toBe(status);

      await updateLoad(T, 'C', 'CL1', { status: 'PLANNED' }, user, allow);
      expect(row('planLoad', 'CL1').status).toBe('PLANNED');
      expect(row('runPlan', 'C').status).toBe(status); // never READY without a plan
      expect(row('runPlan', 'C').reconciliationJson).toBeNull();
    });
  }

  it('a version with an applied plan follows its loads (FAILED copy -> READY on a lock)', async () => {
    seedAppliedPlan('FAILED');
    await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
    expect(row('runPlan', 'P').status).toBe('READY');
  });

  it('refuses a load change on a superseded version, including one written READY over its supersede', async () => {
    seedAppliedPlan('READY', { supersededAt: new Date() });
    await expect(updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow)).rejects.toMatchObject({ status: 409 });
    expect(row('planLoad', 'L2').status).toBe('PLANNED');
  });

  it('a lock timeout (55P03) answers 409 "Plan is being saved", not 500', async () => {
    seedAppliedPlan();
    const original = fakePrisma.$queryRaw;
    fakePrisma.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('FOR UPDATE')) {
        throw Object.assign(new Error('Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`'), { code: 'P2010', meta: { code: '55P03' } });
      }
      return original(strings, ...values);
    };
    try {
      const err = await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow).catch((e) => e);
      expect(err).toBeInstanceOf(PlanBusyError);
      expect(err.status).toBe(409);
      expect(err.message).toMatch(/being saved/);
    } finally {
      fakePrisma.$queryRaw = original;
    }
    expect(row('planLoad', 'L2').status).toBe('PLANNED');
  });

  it('isLockBusy knows lock and transaction timeouts, and nothing else', () => {
    expect(isLockBusy({ code: 'P2028' })).toBe(true);
    expect(isLockBusy({ code: 'P2034' })).toBe(true);
    expect(isLockBusy({ code: 'P2010', meta: { code: '55P03' } })).toBe(true);
    expect(isLockBusy(new Error('canceling statement due to lock timeout'))).toBe(true);
    expect(isLockBusy({ code: 'P2002' })).toBe(false);
    expect(isLockBusy(new Error('boom'))).toBe(false);
    expect(isLockBusy(null)).toBe(false);
  });
});

describe('job finalization (F07 / ADD-JOB-AUDIT)', () => {
  const built = {
    request: { stops: [{ stop_id: 's' }], trucks: [{ id: 'T1' }] },
    preDrops: [],
    scope: scope({ frozenLoadIds: [], frozenLoadOrderIds: [], frozenOrderIds: [], orderIds: ['O1'] }),
    blocking: [],
    warnings: [],
    unknownWeights: [],
    weightChanges: { lines: [], orders: [] },
  };
  const response = (status = 'OPTIMIZED') => ({
    engine: 'OR-Tools',
    matrix_provider: 'HAVERSINE',
    distance_is_estimated: true,
    warnings: [],
    scenarios: [{ ...scenarioDetails({ status, scope: undefined }), unserved: [{ order_ids: ['O1'], reason_code: 'NO_AVAILABLE_TRUCK', reason_message: 'full' }] }],
  });

  function seedOptimizing(opts: { status?: string; currentJobId?: string; chosen?: string | null; supersededAt?: Date | null } = {}) {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
    tables.truck = [{ id: 'T1', tenantId: T, code: 'T01', defaultDriverId: null }];
    tables.order = [{ id: 'O1', tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'VALIDATED' }];
    tables.runPlan = [
      {
        id: 'R',
        tenantId: T,
        depotId: 'D1',
        runDate: DAY,
        status: opts.status ?? 'OPTIMIZING',
        version: 1,
        reason: 'INITIAL',
        chosenScenarioId: opts.chosen ?? null,
        parentRunId: null,
        supersededAt: opts.supersededAt ?? null,
        currentJobId: opts.currentJobId ?? 'J1',
        finalizedAt: null,
        reconciliationJson: null,
      },
    ];
    tables.runJob = [{ id: 'J1', runId: 'R', tenantId: T, attemptNo: 1, status: 'QUEUED' }];
    tables.planLoad = [];
    tables.routeAssignment = [];
    tables.scenarioResult = [];
    tables.unservedOrder = [];
    tables.auditLog = [];
    tables.driver = [];
  }

  const args = (): DispatchJobArgs => ({ runId: 'R', runJobId: 'J1', tenantId: T, userId: 'u1', ip: null, built: built as never });

  async function runToEnd() {
    scheduleDispatchOptimize(args());
    const g = globalThis as unknown as { __routeiqInflight: Map<string, Promise<void>> };
    await g.__routeiqInflight.get('R');
  }

  it('saves the plan, marks the job SUCCEEDED and writes OPTIMIZE_SUCCEEDED in the same transaction; a later failJob changes nothing', async () => {
    seedOptimizing();
    solver.impl = async () => response();
    await runToEnd();
    expect(row('runPlan', 'R').status).toBe('READY');
    expect(row('runPlan', 'R').chosenScenarioId).toBeTruthy();
    expect(row('runJob', 'J1').status).toBe('SUCCEEDED');
    expect(tables.auditLog.map((a) => a.action)).toEqual(expect.arrayContaining(['SCENARIO_CHOSEN', 'OPTIMIZE_SUCCEEDED']));
    // The plan row was locked before the result was written.
    expect(forUpdateIndex()).toBeGreaterThanOrEqual(0);

    // Something failing after the commit (or a duplicate failure report) never marks it FAILED.
    await failJob(args(), new Error('late error after commit'));
    expect(row('runPlan', 'R').status).toBe('READY');
    expect(row('runJob', 'J1').status).toBe('SUCCEEDED');
  });

  it('an OPTIMIZE_SUCCEEDED audit failure rolls the whole save back: the plan is FAILED with nothing half-saved', async () => {
    seedOptimizing();
    solver.impl = async () => response();
    failAudit.action = 'OPTIMIZE_SUCCEEDED';
    await runToEnd();
    expect(row('runPlan', 'R').status).toBe('FAILED');
    expect(row('runPlan', 'R').chosenScenarioId).toBeNull();
    expect(tables.scenarioResult).toHaveLength(0);
    expect(row('runJob', 'J1').status).toBe('FAILED');
  });

  for (const [label, state] of [
    ['superseded meanwhile', { status: 'SUPERSEDED', supersededAt: new Date() }],
    ['taken over by another job', { currentJobId: 'J2' }],
    ['reaped by the janitor (FAILED)', { status: 'FAILED' }],
  ] as const) {
    it(`a stale result (${label}) is not applied: job FAILED "stale result", plan untouched`, async () => {
      seedOptimizing(state);
      solver.impl = async () => response();
      await runToEnd();
      const plan = row('runPlan', 'R');
      expect(plan.status).toBe(state.status ?? 'OPTIMIZING');
      expect(plan.chosenScenarioId).toBeNull();
      expect(tables.scenarioResult).toHaveLength(0);
      const job = row('runJob', 'J1');
      expect(job.status).toBe('FAILED');
      expect(job.errorJson).toMatchObject({ reason: 'STALE_RESULT' });
    });
  }

  it('failJob fails only a job in progress, and the plan only while it is OPTIMIZING with that job', async () => {
    seedOptimizing({ currentJobId: 'J2' });
    tables.runJob[0]!.status = 'RUNNING';
    await failJob(args(), new Error('solver down'));
    expect(row('runJob', 'J1').status).toBe('FAILED');
    expect(row('runPlan', 'R').status).toBe('OPTIMIZING'); // J2's version: untouched

    seedOptimizing({ status: 'SUPERSEDED', supersededAt: new Date() });
    tables.runJob[0]!.status = 'RUNNING';
    await failJob(args(), new Error('solver down'));
    expect(row('runPlan', 'R').status).toBe('SUPERSEDED'); // never resurrected as FAILED

    seedOptimizing();
    tables.runJob[0]!.status = 'RUNNING';
    await failJob(args(), new Error('solver down'));
    expect(row('runPlan', 'R').status).toBe('FAILED');
    expect(row('runJob', 'J1').status).toBe('FAILED');
  });

  it('a version that holds a plan (re-plan copy) keeps it when the optimizer finds no solution', async () => {
    seedOptimizing({ chosen: 'scCopy' });
    tables.scenarioResult = [{ id: 'scCopy', runId: 'R', name: 'RECOMMENDED', detailsJson: scenarioDetails() }];
    tables.planLoad = [load('LC', 'R', 1, 'PLANNED', { carriedFromLoadId: 'Lp' })];
    solver.impl = async () => response('NO_SOLUTION');
    await runToEnd();
    const plan = row('runPlan', 'R');
    expect(plan.status).toBe('FAILED');
    expect(plan.chosenScenarioId).toBe('scCopy');
    expect(tables.planLoad.map((l) => l.id)).toEqual(['LC']);
    expect(row('runJob', 'J1').message).toMatch(/previous plan is kept/);
  });

  it('a solver failure after a re-plan leaves the copied plan in place (FAILED, still applied)', async () => {
    seedOptimizing({ chosen: 'scCopy' });
    tables.scenarioResult = [{ id: 'scCopy', runId: 'R', name: 'RECOMMENDED', detailsJson: scenarioDetails() }];
    tables.planLoad = [load('LC', 'R', 1, 'PLANNED', { carriedFromLoadId: 'Lp' })];
    solver.impl = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await runToEnd();
    expect(row('runPlan', 'R')).toMatchObject({ status: 'FAILED', chosenScenarioId: 'scCopy' });
    expect(tables.planLoad).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Review of PR3 (fixes): copy-forward drivers and labels, completed loads on a version without a
// plan, weights saved only with an applied plan, and the solve admission wired into the job.
// ---------------------------------------------------------------------------------------------

/** A solver load of truck `truckId` carrying `orderIds` (one stop). */
function solverLoad(truckId: string, loadNo: number, departMin: number, returnMin: number, orderIds: string[]) {
  return {
    truck_id: truckId,
    load_no: loadNo,
    depart_min: departMin,
    return_min: returnMin,
    distance_km: 10,
    duration_min: returnMin - departMin,
    cases: 20,
    kg: 200,
    utilization_pct: 50,
    fuel_litres: 1,
    fuel_cost: 1,
    total_cost: 5,
    return_leg_km: 2,
    stops: [
      { sequence: 1, stop_id: `s-${orderIds[0]}`, order_ids: orderIds, customer_id: 'c', arrival_min: departMin + 20, service_start_min: departMin + 20, departure_min: departMin + 40, wait_min: 0, leg_km: 5, cum_km: 5, hard_window_ok: true, pref_window_ok: true },
    ],
  };
}

describe('copy-forward re-plan: drivers are not double-booked (review: step 1 evidence)', () => {
  /**
   * v1 (superseded): T01 L1 Ali 06:00-09:00 LOCKED; T02 L1 Ali 09:30-11:00 PLANNED. v2 holds copies
   * of both (copy-forward) while its optimization runs; the optimization's RECOMMENDED plan has
   * T02 L1 leaving at `t2DepartMin`, its MIN_COST option at 08:00.
   */
  function seedCopyForward(t2DepartMin: number) {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
    tables.truck = ['T1', 'T2'].map((id) => ({ id, tenantId: T, code: id, defaultDriverId: null }));
    tables.driver = [{ id: 'ALI', tenantId: T, active: true }];
    tables.order = ['O1', 'O2'].map((id) => ({ id, tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED' }));
    const base = { tenantId: T, depotId: 'D1', runDate: DAY, optimizationMode: 'BALANCED', finalizedAt: null, totalOrders: 2, unservedCount: 0, summaryJson: null, reconciliationJson: { ok: true }, changeSummaryJson: null, createdById: 'u1', createdAt: new Date() };
    tables.runPlan = [
      { ...base, id: 'P', status: 'SUPERSEDED', supersededAt: new Date(), version: 1, reason: 'INITIAL', chosenScenarioId: 'scP', parentRunId: null, currentJobId: null },
      { ...base, id: 'C', status: 'OPTIMIZING', supersededAt: null, version: 2, reason: 'LATE_ORDER', chosenScenarioId: 'scCopy', parentRunId: 'P', currentJobId: 'J1' },
    ];
    tables.planLoad = [
      load('PL1', 'P', 1, 'LOCKED', { truckId: 'T1', driverId: 'ALI', departMin: 360, returnMin: 540 }),
      load('PL2', 'P', 1, 'PLANNED', { truckId: 'T2', driverId: 'ALI', departMin: 570, returnMin: 660 }),
      load('CL1', 'C', 1, 'LOCKED', { truckId: 'T1', driverId: 'ALI', departMin: 360, returnMin: 540, carriedFromLoadId: 'PL1' }),
      load('CL2', 'C', 1, 'PLANNED', { truckId: 'T2', driverId: 'ALI', departMin: 570, returnMin: 660, carriedFromLoadId: 'PL2' }),
    ];
    tables.routeAssignment = [
      { ...assignment('PA1', 'P', 'PL1', 'O1', 1), truckId: 'T1' },
      { ...assignment('PA2', 'P', 'PL2', 'O2', 1), truckId: 'T2' },
      { ...assignment('CA1', 'C', 'CL1', 'O1', 1), truckId: 'T1' },
      { ...assignment('CA2', 'C', 'CL2', 'O2', 1), truckId: 'T2' },
    ];
    const newScope = scope({ orderIds: ['O2'], frozenOrderIds: ['O1'], frozenLoadIds: ['CL1'], frozenLoadOrderIds: ['O1'] });
    tables.scenarioResult = [
      { id: 'scP', runId: 'P', name: 'RECOMMENDED', detailsJson: scenarioDetails() },
      { id: 'scCopy', runId: 'C', name: 'RECOMMENDED', detailsJson: scenarioDetails() },
      { id: 'scNew', runId: 'C', name: 'RECOMMENDED', unservedCount: 0, detailsJson: scenarioDetails({ scope: newScope, loads: [solverLoad('T2', 1, t2DepartMin, 660, ['O2'])] }) },
      // An alternative the dispatcher may pick with "Use instead": T02 L1 out at 08:00.
      { id: 'scMinCost', runId: 'C', name: 'MIN_COST', unservedCount: 0, detailsJson: scenarioDetails({ name: 'MIN_COST', scope: newScope, loads: [solverLoad('T2', 1, 480, 660, ['O2'])] }) },
    ];
    tables.unservedOrder = [];
    tables.auditLog = [];
    tables.runJob = [{ id: 'J1', runId: 'C', tenantId: T, attemptNo: 1, status: 'RUNNING' }];
  }

  it('a PLANNED copy re-timed onto a kept LOCKED load of the same driver does not keep that driver', async () => {
    seedCopyForward(480);
    await applyScenario(fakePrisma as never, T, 'C', 'scNew', 'u1', { jobId: 'J1' });
    const loads = tables.planLoad.filter((l) => l.runId === 'C');
    expect(loads.find((l) => l.id === 'CL1')).toMatchObject({ status: 'LOCKED', driverId: 'ALI' }); // kept as it is
    const t2 = loads.find((l) => l.truckId === 'T2')!;
    expect(t2.id).not.toBe('CL2'); // the copy was replaced by the new plan's load
    expect(t2.driverId).toBeNull(); // not a second sheet for Ali at 08:00 while T01 is out until 09:00
  });

  it('"Use instead" re-timing a trip onto a kept LOCKED load of its driver leaves it without a driver (no double booking)', async () => {
    seedCopyForward(570); // RECOMMENDED keeps T02 L1 at 09:30: Ali stays on it
    await applyScenario(fakePrisma as never, T, 'C', 'scNew', 'u1', { jobId: 'J1' });
    const applied = tables.planLoad.find((l) => l.runId === 'C' && l.truckId === 'T2')!;
    expect(applied).toMatchObject({ driverId: 'ALI', carriedFromLoadId: null, departMin: 570 });
    Object.assign(row('runPlan', 'C'), { status: 'READY', currentJobId: null });
    // The dispatcher picks MIN_COST: T02 L1 now leaves at 08:00, while Ali's LOCKED T01 load is out until 09:00.
    await chooseScenario(T, 'C', 'scMinCost', 'u1');
    const loads = tables.planLoad.filter((l) => l.runId === 'C');
    expect(loads.find((l) => l.id === 'CL1')).toMatchObject({ status: 'LOCKED', driverId: 'ALI' });
    const t2 = loads.find((l) => l.truckId === 'T2')!;
    expect(t2).toMatchObject({ departMin: 480, driverId: null });
    expect(driverClashes(loads.map((l) => ({ id: l.id, truckId: l.truckId, driverId: l.driverId, departMin: l.departMin, returnMin: l.returnMin })))).toHaveLength(0);
  });

  /**
   * Third review of PR3: the job gave Ali T2 L1 09:30-11:00 and T3 L1 12:00-14:00 (no clash then).
   * "Use instead" on an option that moves T3 L1 to 10:00-12:00 kept Ali on both trucks.
   */
  function seedTwoTrips(t3DefaultDriver: string | null) {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
    tables.truck = [
      { id: 'T2', tenantId: T, code: 'T2', defaultDriverId: null },
      { id: 'T3', tenantId: T, code: 'T3', defaultDriverId: t3DefaultDriver },
    ];
    tables.driver = [
      { id: 'ALI', tenantId: T, active: true },
      { id: 'SAM', tenantId: T, active: true },
    ];
    tables.order = ['O2', 'O3'].map((id) => ({ id, tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED' }));
    const base = { tenantId: T, depotId: 'D1', runDate: DAY, optimizationMode: 'BALANCED', finalizedAt: null, totalOrders: 2, unservedCount: 0, summaryJson: null, reconciliationJson: { ok: true }, changeSummaryJson: null, createdById: 'u1', createdAt: new Date() };
    tables.runPlan = [{ ...base, id: 'R', status: 'READY', supersededAt: null, version: 1, reason: 'INITIAL', chosenScenarioId: 'scRec', parentRunId: null, currentJobId: null }];
    tables.planLoad = [
      load('N2', 'R', 1, 'PLANNED', { truckId: 'T2', driverId: 'ALI', departMin: 570, returnMin: 660 }),
      load('N3', 'R', 1, 'PLANNED', { truckId: 'T3', driverId: 'ALI', departMin: 720, returnMin: 840 }),
    ];
    tables.routeAssignment = [
      { ...assignment('A2', 'R', 'N2', 'O2', 1), truckId: 'T2' },
      { ...assignment('A3', 'R', 'N3', 'O3', 1), truckId: 'T3' },
    ];
    const sc = scope({ orderIds: ['O2', 'O3'], frozenOrderIds: [], frozenLoadIds: [], frozenLoadOrderIds: [] });
    tables.scenarioResult = [
      { id: 'scRec', runId: 'R', name: 'RECOMMENDED', unservedCount: 0, detailsJson: scenarioDetails({ scope: sc, loads: [solverLoad('T2', 1, 570, 660, ['O2']), solverLoad('T3', 1, 720, 840, ['O3'])] }) },
      // MIN_COST lists T3 first and moves it to 10:00-12:00, onto Ali's T2 trip.
      { id: 'scMinCost', runId: 'R', name: 'MIN_COST', unservedCount: 0, detailsJson: scenarioDetails({ name: 'MIN_COST', scope: sc, loads: [solverLoad('T3', 1, 600, 720, ['O3']), solverLoad('T2', 1, 570, 660, ['O2'])] }) },
    ];
    tables.unservedOrder = [];
    tables.auditLog = [];
    tables.runJob = [];
  }
  const clashesOf = (runId: string) =>
    driverClashes(tables.planLoad.filter((l) => l.runId === runId).map((l) => ({ id: l.id, truckId: l.truckId, driverId: l.driverId, departMin: l.departMin, returnMin: l.returnMin })));

  it('"Use instead" moving one of two trips of a driver onto the other\'s hours: the moved trip loses the driver (no double booking)', async () => {
    seedTwoTrips(null);
    await chooseScenario(T, 'R', 'scMinCost', 'u1');
    const loads = tables.planLoad.filter((l) => l.runId === 'R');
    expect(loads.find((l) => l.truckId === 'T2')).toMatchObject({ departMin: 570, driverId: 'ALI' }); // did not move
    expect(loads.find((l) => l.truckId === 'T3')).toMatchObject({ departMin: 600, driverId: null });
    expect(clashesOf('R')).toHaveLength(0);
  });

  it("the moved trip gets its truck's default driver when that driver is free", async () => {
    seedTwoTrips('SAM');
    await chooseScenario(T, 'R', 'scMinCost', 'u1');
    const loads = tables.planLoad.filter((l) => l.runId === 'R');
    expect(loads.find((l) => l.truckId === 'T3')).toMatchObject({ departMin: 600, driverId: 'SAM' });
    expect(clashesOf('R')).toHaveLength(0);
  });

  it("applyScenario reads the times of the versions' loads (which trips moved, which already overlapped)", () => {
    // The fake database ignores `select`; on PostgreSQL a column left out of it is undefined.
    const src = readFileSync(path.resolve(__dirname, '../../lib/dispatch/plan-service.ts'), 'utf8');
    const sel = /const driverSel = \{([^}]*)\} as const;/.exec(src)?.[1] ?? '';
    expect(sel).toContain('departMin: true');
    expect(sel).toContain('returnMin: true');
  });
});

describe('hand-set drivers across a re-plan and "Use instead" (fourth review of PR3)', () => {
  /**
   * T2's default driver is Ali, T3's is Sam. `version(id, t2, t3)` adds an applied READY version:
   * T2 L1 with Ali and T3 L1 with `t3Driver`, both filled in by RouteIQ (no hand-set marker), and
   * its RECOMMENDED option with those times; `alt` adds a MIN_COST option with other times.
   * Minutes: 570 = 09:30, 600 = 10:00, 660 = 11:00, 720 = 12:00, 840 = 14:00.
   */
  const sc = () => scope({ orderIds: ['O2', 'O3'], frozenOrderIds: [], frozenLoadIds: [], frozenLoadOrderIds: [] });
  const both = ['T2 listed first', 'T3 listed first'] as const;
  const inOrder = (order: (typeof both)[number], loads: ReturnType<typeof solverLoad>[]) => (order === 'T2 listed first' ? loads : [...loads].reverse());
  function seedDay() {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
    tables.truck = [
      { id: 'T2', tenantId: T, code: 'T2', defaultDriverId: 'ALI' },
      { id: 'T3', tenantId: T, code: 'T3', defaultDriverId: 'SAM' },
    ];
    tables.driver = [
      { id: 'ALI', tenantId: T, active: true, name: 'Ali' },
      { id: 'SAM', tenantId: T, active: true, name: 'Sam' },
    ];
    tables.order = ['O2', 'O3'].map((id) => ({ id, tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED' }));
    tables.runPlan = [];
    tables.planLoad = [];
    tables.routeAssignment = [];
    tables.scenarioResult = [];
    tables.unservedOrder = [];
    tables.auditLog = [];
    tables.runJob = [];
  }
  function version(id: string, t2: [number, number], t3: [number, number], t3Driver: string, alt?: { t2: [number, number]; t3: [number, number]; order: (typeof both)[number] }) {
    const base = { tenantId: T, depotId: 'D1', runDate: DAY, optimizationMode: 'BALANCED', finalizedAt: null, totalOrders: 2, unservedCount: 0, summaryJson: null, reconciliationJson: { ok: true }, changeSummaryJson: null, createdById: 'u1', createdAt: new Date() };
    tables.runPlan.push({ ...base, id, status: 'READY', supersededAt: null, version: 1, reason: 'INITIAL', chosenScenarioId: `${id}-rec`, parentRunId: null, currentJobId: null });
    tables.planLoad.push(
      load(`${id}-T2`, id, 1, 'PLANNED', { truckId: 'T2', driverId: 'ALI', departMin: t2[0], returnMin: t2[1] }),
      load(`${id}-T3`, id, 1, 'PLANNED', { truckId: 'T3', driverId: t3Driver, departMin: t3[0], returnMin: t3[1] }),
    );
    tables.routeAssignment.push({ ...assignment(`${id}-A2`, id, `${id}-T2`, 'O2', 1), truckId: 'T2' }, { ...assignment(`${id}-A3`, id, `${id}-T3`, 'O3', 1), truckId: 'T3' });
    const loads = (a: [number, number], b: [number, number]) => [solverLoad('T2', 1, a[0], a[1], ['O2']), solverLoad('T3', 1, b[0], b[1], ['O3'])];
    tables.scenarioResult.push({ id: `${id}-rec`, runId: id, name: 'RECOMMENDED', unservedCount: 0, detailsJson: scenarioDetails({ scope: sc(), loads: loads(t2, t3) }) });
    if (alt) {
      tables.scenarioResult.push({ id: `${id}-alt`, runId: id, name: 'MIN_COST', unservedCount: 0, detailsJson: scenarioDetails({ name: 'MIN_COST', scope: sc(), loads: inOrder(alt.order, loads(alt.t2, alt.t3)) }) });
    }
  }
  /** Late order: the copy-forward version of `parentId`, optimizing, with the job's RECOMMENDED plan. */
  async function replanTo(parentId: string, t2: [number, number], t3: [number, number], order: (typeof both)[number]) {
    const { child } = await createNextVersion(T, parentId, 'LATE_ORDER', null, 'u1');
    Object.assign(row('runPlan', child.id), { status: 'OPTIMIZING', currentJobId: 'J1' });
    tables.runJob.push({ id: 'J1', runId: child.id, tenantId: T, attemptNo: 1, status: 'RUNNING' });
    const loads = [solverLoad('T2', 1, t2[0], t2[1], ['O2']), solverLoad('T3', 1, t3[0], t3[1], ['O3'])];
    tables.scenarioResult.push({ id: 'job-rec', runId: child.id, name: 'RECOMMENDED', unservedCount: 0, detailsJson: scenarioDetails({ scope: sc(), loads: inOrder(order, loads) }) });
    const res = await applyScenario(fakePrisma as never, T, child.id, 'job-rec', 'u1', { jobId: 'J1' });
    return { childId: child.id, res };
  }
  const loadOf = (runId: string, truckId: string) => tables.planLoad.find((l) => l.runId === runId && l.truckId === truckId)!;
  const driversOf = (runId: string) => tables.planLoad.filter((l) => l.runId === runId).map((l) => ({ truckId: l.truckId as string, loadNo: l.loadNo as number, driverId: l.driverId as string | null }));
  const clashesOf = (runId: string) =>
    driverClashes(tables.planLoad.filter((l) => l.runId === runId).map((l) => ({ id: l.id, truckId: l.truckId, driverId: l.driverId, departMin: l.departMin, returnMin: l.returnMin })));

  it("the dispatcher's driver change marks the load (who, when); \"No driver\" clears the marker; a re-plan's copies keep it", async () => {
    seedDay();
    version('P', [720, 840], [570, 660], 'SAM');
    await updateLoad(T, 'P', 'P-T3', { driverId: 'ALI' }, user, allow);
    expect(row('planLoad', 'P-T3')).toMatchObject({ driverId: 'ALI', driverSetById: 'u1' });
    expect(row('planLoad', 'P-T3').driverSetAt).toBeInstanceOf(Date);
    const { child } = await createNextVersion(T, 'P', 'LATE_ORDER', null, 'u1');
    const copy = loadOf(child.id, 'T3');
    expect(copy).toMatchObject({ driverId: 'ALI', driverSetById: 'u1', carriedFromLoadId: 'P-T3' });
    expect(copy.driverSetAt).toEqual(row('planLoad', 'P-T3').driverSetAt);
    expect(loadOf(child.id, 'T2').driverSetAt ?? null).toBeNull(); // filled in by RouteIQ: no marker
    await updateLoad(T, child.id, copy.id, { driverId: null }, user, allow);
    expect(row('planLoad', copy.id)).toMatchObject({ driverId: null, driverSetById: null, driverSetAt: null });
  });

  for (const order of both) {
    it(`D1, re-plan job (${order}): a trip moved onto the hours of a trip the dispatcher gave Ali by hand - Ali stays on the hand-set trip, the overlap is the yellow warning`, async () => {
      seedDay();
      version('P', [720, 840], [570, 660], 'SAM'); // T2 L1 Ali (default) 12:00-14:00, T3 L1 Sam 09:30-11:00
      await updateLoad(T, 'P', 'P-T3', { driverId: 'ALI' }, user, allow); // Ali on T3 by hand (no clash then)
      const { childId, res } = await replanTo('P', [600, 720], [570, 660], order); // T2 L1 moves to 10:00-12:00
      expect(loadOf(childId, 'T3')).toMatchObject({ departMin: 570, driverId: 'ALI', driverSetById: 'u1' });
      expect(loadOf(childId, 'T3').driverSetAt).toEqual(row('planLoad', 'P-T3').driverSetAt);
      expect(loadOf(childId, 'T2')).toMatchObject({ departMin: 600, driverId: 'ALI', driverSetById: null, driverSetAt: null });
      expect(clashesOf(childId)).toHaveLength(1);
      expect(res.driverChanges).toEqual([]);
    });

    it(`D1, "Use instead" (${order}): the same trips and evidence give the same drivers as the re-plan job`, async () => {
      seedDay();
      version('R', [720, 840], [570, 660], 'SAM', { t2: [600, 720], t3: [570, 660], order });
      await updateLoad(T, 'R', 'R-T3', { driverId: 'ALI' }, user, allow);
      await chooseScenario(T, 'R', 'R-alt', 'u1');
      expect(loadOf('R', 'T3')).toMatchObject({ departMin: 570, driverId: 'ALI', driverSetById: 'u1' });
      expect(loadOf('R', 'T2')).toMatchObject({ departMin: 600, driverId: 'ALI', driverSetById: null });
      expect(clashesOf('R')).toHaveLength(1);
    });

    it(`D2, "Use instead" (${order}): re-timing the hand-set trip onto another trip of Ali keeps Ali on both (yellow warning); switching back restores the plan`, async () => {
      seedDay();
      // R: T2 L1 Ali (default) 09:30-11:00; T3 L1 Sam 12:00-14:00, then Ali by hand. MIN_COST moves T3 L1 to 10:00-12:00.
      version('R', [570, 660], [720, 840], 'SAM', { t2: [570, 660], t3: [600, 720], order });
      await updateLoad(T, 'R', 'R-T3', { driverId: 'ALI' }, user, allow);
      const setAt = row('planLoad', 'R-T3').driverSetAt;
      const res = await chooseScenario(T, 'R', 'R-alt', 'u1');
      expect(loadOf('R', 'T3')).toMatchObject({ departMin: 600, driverId: 'ALI', driverSetById: 'u1', driverSetAt: setAt });
      expect(loadOf('R', 'T2')).toMatchObject({ departMin: 570, driverId: 'ALI' });
      expect(clashesOf('R')).toHaveLength(1); // shown, never silently dropped
      expect(res.driverChanges).toEqual([]);
      await chooseScenario(T, 'R', 'R-rec', 'u1');
      expect(loadOf('R', 'T3')).toMatchObject({ departMin: 720, driverId: 'ALI', driverSetById: 'u1', driverSetAt: setAt });
      expect(loadOf('R', 'T2')).toMatchObject({ departMin: 570, driverId: 'ALI' });
      expect(clashesOf('R')).toHaveLength(0);
    });

    it(`drivers RouteIQ filled in (${order}): the trip that moved loses Ali, in the re-plan job and in "Use instead", and the change is reported`, async () => {
      seedDay();
      version('P', [720, 840], [570, 660], 'ALI'); // Ali on both, filled in (no marker), no clash
      const { childId, res } = await replanTo('P', [600, 720], [570, 660], order);
      expect(loadOf(childId, 'T3')).toMatchObject({ departMin: 570, driverId: 'ALI', driverSetById: null });
      expect(loadOf(childId, 'T2')).toMatchObject({ departMin: 600, driverId: null }); // Ali (also its default) is on T3
      expect(clashesOf(childId)).toHaveLength(0);
      const change = { truckId: 'T2', truckCode: 'T2', loadNo: 1, departMin: 600, returnMin: 720, from: { id: 'ALI', name: 'Ali' }, to: null, reason: 'OTHER_TRIP', other: { truckCode: 'T3', loadNo: 1 } };
      expect(res.driverChanges).toEqual([change]);
      // Kept with the plan (summary) and audited; a load change keeps it; the plan shows it until the dispatcher picks a driver.
      expect(row('runPlan', childId).summaryJson.driverChanges).toEqual([change]);
      expect(tables.auditLog.find((a) => a.action === 'SCENARIO_CHOSEN' && a.entityId === childId)!.afterJson.driverChanges).toEqual([
        { truckId: 'T2', loadNo: 1, from: 'ALI', to: null, reason: 'OTHER_TRIP' },
      ]);
      Object.assign(row('runPlan', childId), { status: 'READY', currentJobId: null });
      await updateLoad(T, childId, loadOf(childId, 'T3').id, { status: 'LOCKED' }, user, allow);
      const notes = row('runPlan', childId).summaryJson.driverChanges;
      expect(notes).toEqual([change]);
      expect(driverChangeWarnings(notes, driversOf(childId))).toEqual([
        'Driver changed by this plan: T2 · L1 (10:00–12:00) Ali → no driver, because Ali is on T3 · L1 at that time.',
      ]);
      await updateLoad(T, childId, loadOf(childId, 'T2').id, { driverId: 'SAM' }, user, allow);
      expect(driverChangeWarnings(notes, driversOf(childId))).toEqual([]);

      // "Use instead" with the same trips and evidence: the same answer.
      seedDay();
      version('R', [720, 840], [570, 660], 'ALI', { t2: [600, 720], t3: [570, 660], order });
      const chosen = await chooseScenario(T, 'R', 'R-alt', 'u1');
      expect(loadOf('R', 'T3')).toMatchObject({ departMin: 570, driverId: 'ALI' });
      expect(loadOf('R', 'T2')).toMatchObject({ departMin: 600, driverId: null });
      expect(chosen.driverChanges).toEqual([change]);
    });
  }

  it('the first optimization of a day is unaffected: default drivers, no marker, no driver change', async () => {
    seedDay();
    version('R', [570, 660], [600, 720], 'SAM');
    Object.assign(row('runPlan', 'R'), { status: 'DRAFT', chosenScenarioId: null });
    tables.planLoad = [];
    tables.routeAssignment = [];
    const res = await chooseScenario(T, 'R', 'R-rec', 'u1');
    expect(loadOf('R', 'T2')).toMatchObject({ driverId: 'ALI', driverSetById: null, driverSetAt: null });
    expect(loadOf('R', 'T3')).toMatchObject({ driverId: 'SAM', driverSetById: null, driverSetAt: null });
    expect(res.driverChanges).toEqual([]);
    expect(row('runPlan', 'R').summaryJson.driverChanges).toBeUndefined();
    expect(tables.auditLog.find((a) => a.action === 'SCENARIO_CHOSEN')!.afterJson.driverChanges).toBeUndefined();
  });

  describe('fifth review of PR3: an option or re-plan without the hand-set truck and trip; Keep', () => {
    // Minutes: 480 = 08:00, 600 = 10:00, 620 = 10:20, 740 = 12:20.
    const bobNote = { truckId: 'T3', truckCode: 'T3', loadNo: 1, departMin: 480, returnMin: 600, from: { id: 'BOB', name: 'Bob' }, to: null, reason: 'TRIP_GONE', other: null };
    const bobText = 'Driver picked by hand, not in this plan: you picked Bob for T3 · L1 (08:00–10:00), and this plan has no such trip. Bob goes back on it when a re-plan or Use instead has that trip again.';
    const withBob = () => tables.driver.push({ id: 'BOB', tenantId: T, active: true, name: 'Bob' });
    const t2only = () => [solverLoad('T2', 1, 480, 600, ['O2']), solverLoad('T2', 2, 620, 740, ['O3'])];
    const t2t3 = (order: (typeof both)[number]) => inOrder(order, [solverLoad('T2', 1, 480, 600, ['O2']), solverLoad('T3', 1, 480, 600, ['O3'])]);
    const shown = (runId: string) =>
      driverChangeWarnings(
        row('runPlan', runId).summaryJson?.driverChanges ?? [],
        tables.planLoad.filter((l) => l.runId === runId).map((l) => ({ truckId: l.truckId, loadNo: l.loadNo, driverId: l.driverId, driverHandSet: isHandSetDriver(l as { driverId: string | null; driverSetAt: Date | null }) })),
      );
    const tripsOf = (runId: string) =>
      Object.fromEntries(tables.planLoad.filter((l) => l.runId === runId).map((l) => [`${l.truckId}:${l.loadNo}`, `${l.driverId}${l.driverSetAt ? ' (by hand)' : ''}`]));
    /** Late order from `parentId`: the job applies `loads`, then the version is READY with its job done. */
    async function jobApplies(parentId: string, jobId: string, loads: ReturnType<typeof solverLoad>[]) {
      const { child } = await createNextVersion(T, parentId, 'LATE_ORDER', null, 'u1');
      Object.assign(row('runPlan', child.id), { status: 'OPTIMIZING', currentJobId: jobId });
      tables.runJob.push({ id: jobId, runId: child.id, tenantId: T, attemptNo: 1, status: 'RUNNING' });
      tables.scenarioResult.push({ id: `${jobId}-rec`, runId: child.id, name: 'RECOMMENDED', unservedCount: 0, detailsJson: scenarioDetails({ scope: sc(), loads }) });
      const res = await applyScenario(fakePrisma as never, T, child.id, `${jobId}-rec`, 'u1', { jobId });
      Object.assign(row('runJob', jobId), { status: 'SUCCEEDED' });
      Object.assign(row('runPlan', child.id), { currentJobId: null });
      return { childId: child.id, res };
    }

    for (const order of both) {
      it(`"Use instead" to an option without T3 (${order}): Bob, set by hand on T3 L1, is parked and noted; switching back gives him back`, async () => {
        seedDay();
        withBob();
        version('R', [480, 600], [480, 600], 'SAM');
        tables.scenarioResult[0]!.detailsJson = scenarioDetails({ scope: sc(), loads: t2t3(order) });
        tables.scenarioResult.push({ id: 'R-min', runId: 'R', name: 'MIN_TRUCKS', unservedCount: 0, detailsJson: scenarioDetails({ name: 'MIN_TRUCKS', scope: sc(), loads: t2only() }) });
        await updateLoad(T, 'R', 'R-T3', { driverId: 'BOB' }, user, allow);
        const setAt = row('planLoad', 'R-T3').driverSetAt as Date;

        const res = await chooseScenario(T, 'R', 'R-min', 'u1');
        expect(tripsOf('R')).toEqual({ 'T2:1': 'ALI', 'T2:2': 'ALI' });
        expect(res.driverChanges).toEqual([bobNote]); // counted in the answer (driversChanged)
        expect(row('runPlan', 'R').summaryJson.parkedDrivers).toEqual([
          { truckId: 'T3', loadNo: 1, driverId: 'BOB', departMin: 480, returnMin: 600, driverSetById: 'u1', driverSetAt: setAt.toISOString() },
        ]);
        expect(shown('R')).toEqual([bobText]);
        expect(tables.auditLog.filter((a) => a.action === 'SCENARIO_CHOSEN').at(-1)!.afterJson.driverChanges).toEqual([
          { truckId: 'T3', loadNo: 1, from: 'BOB', to: null, reason: 'TRIP_GONE' },
        ]);
        // A load change keeps the parked choice and its note.
        await updateLoad(T, 'R', loadOf('R', 'T2').id, { status: 'LOCKED' }, user, allow);
        await updateLoad(T, 'R', loadOf('R', 'T2').id, { status: 'PLANNED' }, user, allow);
        expect(row('runPlan', 'R').summaryJson.parkedDrivers).toHaveLength(1);
        expect(shown('R')).toEqual([bobText]);

        const back = await chooseScenario(T, 'R', 'R-rec', 'u1');
        expect(tripsOf('R')).toEqual({ 'T2:1': 'ALI', 'T3:1': 'BOB (by hand)' });
        expect(loadOf('R', 'T3')).toMatchObject({ driverSetById: 'u1', driverSetAt: setAt });
        expect(back.driverChanges).toEqual([]);
        expect(row('runPlan', 'R').summaryJson.parkedDrivers).toBeUndefined();
        expect(shown('R')).toEqual([]);
      });

      it(`re-plan job without T3 (${order}): the parent's hand-set Bob is parked and noted; the next re-plan with T3 L1 gives him back`, async () => {
        seedDay();
        withBob();
        version('P', [480, 600], [480, 600], 'SAM');
        await updateLoad(T, 'P', 'P-T3', { driverId: 'BOB' }, user, allow);
        const setAt = row('planLoad', 'P-T3').driverSetAt as Date;

        const first = await jobApplies('P', 'J1', t2only());
        expect(tripsOf(first.childId)).toEqual({ 'T2:1': 'ALI', 'T2:2': 'ALI' });
        expect(first.res.driverChanges).toEqual([bobNote]);
        expect(shown(first.childId)).toEqual([bobText]);

        // The next re-plan starts from the version without T3: the parked choice travels with it.
        const second = await jobApplies(first.childId, 'J2', t2t3(order));
        expect(tripsOf(second.childId)).toEqual({ 'T2:1': 'ALI', 'T3:1': 'BOB (by hand)' });
        expect(loadOf(second.childId, 'T3')).toMatchObject({ driverSetById: 'u1', driverSetAt: setAt });
        expect(second.res.driverChanges).toEqual([]);
        expect(shown(second.childId)).toEqual([]);
      });

      it(`Keep (${order}): a driver RouteIQ filled in (for example picked before the update) is marked by re-sending it; "Use instead" then keeps it with the yellow warning`, async () => {
        seedDay();
        // R: T2 L1 Ali 09:30-11:00; T3 L1 Ali 12:00-14:00, no marker. MIN_COST moves T3 L1 to 10:00-12:00.
        version('R', [570, 660], [720, 840], 'ALI', { t2: [570, 660], t3: [600, 720], order });
        await updateLoad(T, 'R', 'R-T3', { driverId: 'ALI' }, user, allow);
        expect(row('planLoad', 'R-T3')).toMatchObject({ driverId: 'ALI', driverSetById: 'u1' });
        expect(row('planLoad', 'R-T3').driverSetAt).toBeInstanceOf(Date);
        const keep = tables.auditLog.filter((a) => a.action === 'LOAD_DRIVER_SET');
        expect(keep).toHaveLength(1);
        expect(keep[0]!.afterJson).toMatchObject({ driverId: 'ALI', kept: true, truckId: 'T3', loadNo: 1 });
        // Re-sending it again (already the dispatcher's) writes nothing.
        await updateLoad(T, 'R', 'R-T3', { driverId: 'ALI' }, user, allow);
        expect(tables.auditLog.filter((a) => a.action === 'LOAD_DRIVER_SET')).toHaveLength(1);

        const res = await chooseScenario(T, 'R', 'R-alt', 'u1');
        expect(loadOf('R', 'T3')).toMatchObject({ departMin: 600, driverId: 'ALI', driverSetById: 'u1' });
        expect(loadOf('R', 'T2')).toMatchObject({ departMin: 570, driverId: 'ALI' });
        expect(clashesOf('R')).toHaveLength(1); // the dispatcher's choice: shown, not dropped
        expect(res.driverChanges).toEqual([]);
      });
    }

    it('Keep on a load that is out changes nothing; the plan pick confirmed with Keep clears its yellow note', async () => {
      seedDay();
      // R: Ali on both, filled in. MIN_COST moves T3 L1 onto T2 L1's hours: T3 gets its default Sam, noted.
      version('R', [570, 660], [720, 840], 'ALI', { t2: [570, 660], t3: [600, 720], order: 'T2 listed first' });
      const res = await chooseScenario(T, 'R', 'R-alt', 'u1');
      expect(res.driverChanges.map((c) => [c.truckId, c.from?.id, c.to?.id, c.reason])).toEqual([['T3', 'ALI', 'SAM', 'OTHER_TRIP']]);
      expect(shown('R')).toHaveLength(1);
      await updateLoad(T, 'R', loadOf('R', 'T3').id, { driverId: 'SAM' }, user, allow); // Keep Sam
      expect(loadOf('R', 'T3')).toMatchObject({ driverId: 'SAM', driverSetById: 'u1' });
      expect(shown('R')).toEqual([]);

      Object.assign(loadOf('R', 'T2'), { status: 'DISPATCHED' });
      const audits = tables.auditLog.length;
      const out = await updateLoad(T, 'R', loadOf('R', 'T2').id, { driverId: 'ALI' }, user, allow);
      expect(out).toMatchObject({ driverId: 'ALI' });
      expect(loadOf('R', 'T2').driverSetAt ?? null).toBeNull();
      expect(tables.auditLog.length).toBe(audits);
    });

    it('the job message counts the driver notes (a parked hand-set driver included)', async () => {
      seedDay();
      withBob();
      version('P', [480, 600], [480, 600], 'SAM');
      await updateLoad(T, 'P', 'P-T3', { driverId: 'BOB' }, user, allow);
      const childId = (await createNextVersion(T, 'P', 'LATE_ORDER', null, 'u1')).child.id;
      Object.assign(row('runPlan', childId), { status: 'OPTIMIZING', currentJobId: 'J9' });
      tables.runJob.push({ id: 'J9', runId: childId, tenantId: T, attemptNo: 1, status: 'QUEUED' });
      const plan = { ...scenarioDetails({ scope: undefined, loads: t2only(), trips: 2, trucks_used: 1 }), unserved: [] };
      solver.impl = async () => ({ engine: 'OR-Tools', matrix_provider: 'HAVERSINE', distance_is_estimated: true, warnings: [], scenarios: [plan] });
      const built = { request: { stops: [{ stop_id: 's' }], trucks: [{ id: 'T2' }] }, preDrops: [], scope: sc(), blocking: [], warnings: [], unknownWeights: [], weightChanges: { lines: [], orders: [] } };
      scheduleDispatchOptimize({ runId: childId, runJobId: 'J9', tenantId: T, userId: 'u1', ip: null, built: built as never });
      await (globalThis as unknown as { __routeiqInflight: Map<string, Promise<void>> }).__routeiqInflight.get(childId);
      expect(row('runJob', 'J9')).toMatchObject({ status: 'SUCCEEDED', message: '2 loads on 1 trucks, 0 stop(s) unserved, 1 driver note(s) (see the plan)' });
      expect(shown(childId)).toEqual([bobText]);
    });
  });

  it('the plan screen reads who chose each driver (DetailLoad.driverHandSet) and hides a note once the dispatcher picked the driver', () => {
    const src = readFileSync(path.resolve(__dirname, '../../lib/dispatch/plan-detail.ts'), 'utf8');
    expect(src).toContain('driverHandSet: isHandSetDriver(l),');
    expect(src).toMatch(/driverChangeWarnings\(\(run\.summaryJson as unknown as DailySummary \| null\)\?\.driverChanges \?\? \[\], loads\)/);
  });

  it('applyScenario reads the hand-set marker with the drivers (the fake database ignores `select`)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../lib/dispatch/plan-service.ts'), 'utf8');
    const sel = /const driverSel = \{([^}]*)\} as const;/.exec(src)?.[1] ?? '';
    expect(sel).toContain('driverSetById: true');
    expect(sel).toContain('driverSetAt: true');
  });
});

describe('a failed copy-forward re-plan: labels and change summary (review: PLANNED copies are not "kept")', () => {
  it('after one load change, "locked/dispatched loads preserved" counts only the frozen copies', async () => {
    seedAppliedPlan(); // v1: L1 LOCKED, L2 PLANNED
    const { child } = await createNextVersion(T, 'P', 'REOPTIMIZE', null, 'u1');
    Object.assign(row('runPlan', child.id), { status: 'FAILED' }); // its optimization failed: the copy stays
    const copies = tables.planLoad.filter((l) => l.runId === child.id);
    expect(copies.every((l) => l.carriedFromLoadId)).toBe(true); // both copied (the driver rules need the link)
    const l1 = copies.find((l) => l.carriedFromLoadId === 'L1')!;
    await updateLoad(T, child.id, l1.id, { status: 'DISPATCHED' }, user, allow);
    const summary = row('runPlan', child.id).changeSummaryJson;
    expect(summary).toMatchObject({ parentVersion: 1, lockedLoadsPreserved: 1 }); // not 2: L2's copy is still PLANNED
    expect(row('runPlan', child.id).status).toBe('READY');
  });
});

describe('a version without an applied plan: loads already out can be completed (review F03 dead end)', () => {
  it('DISPATCHED -> COMPLETED is allowed and the version keeps its status; it still needs a supervisor', async () => {
    seedAppliedPlan('SUPERSEDED', { supersededAt: new Date() });
    tables.runPlan.push({ ...tables.runPlan[0], id: 'C', status: 'FAILED', version: 2, parentRunId: 'P', chosenScenarioId: null, supersededAt: null, reconciliationJson: null, summaryJson: null });
    tables.planLoad.push(load('CL1', 'C', 1, 'DISPATCHED', { carriedFromLoadId: 'L1' }), load('CL2', 'C', 2, 'DISPATCHED', { carriedFromLoadId: 'L2' }));
    await updateLoad(T, 'C', 'CL1', { status: 'COMPLETED' }, user, allow);
    expect(row('planLoad', 'CL1').status).toBe('COMPLETED');
    expect(row('runPlan', 'C').status).toBe('FAILED'); // never READY / DISPATCHED without a plan
    expect(tables.auditLog.some((a) => a.action === 'LOAD_COMPLETED' && a.entityId === 'CL1')).toBe(true);
    const plannerOnly = (role: 'PLANNER' | 'SUPERVISOR') => role === 'PLANNER';
    await expect(updateLoad(T, 'C', 'CL2', { status: 'COMPLETED' }, user, plannerOnly)).rejects.toMatchObject({ status: 403 });
    expect(row('planLoad', 'CL2').status).toBe('DISPATCHED');
  });

  it('NO_PLAN_APPLIED on a version whose loads are PLANNED and LOCKED says to OPTIMIZE, not to unlock', async () => {
    seedAppliedPlan('SUPERSEDED', { supersededAt: new Date() });
    tables.runPlan.push({ ...tables.runPlan[0], id: 'C', status: 'DRAFT', version: 2, parentRunId: 'P', chosenScenarioId: null, supersededAt: null, reconciliationJson: null, summaryJson: null });
    tables.planLoad.push(load('CL1', 'C', 1, 'LOCKED', { carriedFromLoadId: 'L1' }), load('CL2', 'C', 2, 'PLANNED', { carriedFromLoadId: 'L2' }));
    const err = await updateLoad(T, 'C', 'CL2', { status: 'LOCKED' }, user, allow).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.details).toMatchObject({ code: 'NO_PLAN_APPLIED' });
    expect(err.message).toMatch(/OPTIMIZE the day first/);
    expect(row('planLoad', 'CL2').status).toBe('PLANNED');
  });
});

describe('solve admission wired into the job (F16): queued solves start, every ending gives the slot back', () => {
  const g = globalThis as unknown as { __routeiqInflight: Map<string, Promise<void>> };
  const jobBuilt = {
    request: { stops: [{ stop_id: 's' }], trucks: [{ id: 'T1' }] },
    preDrops: [],
    scope: scope({ frozenLoadIds: [], frozenLoadOrderIds: [], frozenOrderIds: [], orderIds: ['O1'] }),
    blocking: [],
    warnings: [],
    unknownWeights: [],
    weightChanges: { lines: [], orders: [] },
  };
  const jobResponse = () => ({
    engine: 'OR-Tools',
    matrix_provider: 'HAVERSINE',
    distance_is_estimated: true,
    warnings: [],
    scenarios: [{ ...scenarioDetails({ scope: undefined }), unserved: [{ order_ids: ['O1'], reason_code: 'NO_AVAILABLE_TRUCK', reason_message: 'full' }] }],
  });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  };

  /** Two versions of one company (two days), each OPTIMIZING with its own QUEUED job. */
  function seedTwo() {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
    tables.truck = [{ id: 'T1', tenantId: T, code: 'T01', defaultDriverId: null }];
    tables.order = [{ id: 'O1', tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'VALIDATED' }];
    tables.runPlan = ['R1', 'R2'].map((id, i) => ({
      id,
      tenantId: T,
      depotId: 'D1',
      runDate: new Date(DAY.getTime() + i * 86_400_000),
      status: 'OPTIMIZING',
      version: 1,
      reason: 'INITIAL',
      chosenScenarioId: null,
      parentRunId: null,
      supersededAt: null,
      currentJobId: `J${i + 1}`,
      finalizedAt: null,
      reconciliationJson: null,
    }));
    tables.runJob = ['R1', 'R2'].map((runId, i) => ({ id: `J${i + 1}`, runId, tenantId: T, attemptNo: 1, status: 'QUEUED' }));
    tables.planLoad = [];
    tables.routeAssignment = [];
    tables.scenarioResult = [];
    tables.unservedOrder = [];
    tables.auditLog = [];
    tables.driver = [];
  }

  /** One solve per company at a time (the shipped default with SOLVER_MAX_CONCURRENT=2), quotas off. */
  function admission() {
    return new SolveAdmission({ userPerHour: 100, tenantPerHour: 100, tenantConcurrent: 1, globalConcurrent: 2, maxQueue: 10, queueHardCap: 200, tenantQueue: 2, windowMs: 3_600_000 }, Date.now, () => true);
  }
  function ticketOf(a: SolveAdmission): SolveTicket {
    const r = a.reserve(T, 'u1');
    if (!r.ok) throw new Error(r.code);
    r.ticket.commit();
    return r.ticket;
  }
  const argsFor = (runId: string, runJobId: string, ticket: SolveTicket): DispatchJobArgs => ({ runId, runJobId, tenantId: T, userId: 'u1', ip: null, built: jobBuilt as never, ticket });

  for (const ending of ['success', 'failure', 'stale result'] as const) {
    it(`the second solve waits QUEUED until the first ends (${ending}), then runs; no slot is left taken`, async () => {
      seedTwo();
      const adm = admission();
      const t1 = ticketOf(adm);
      const t2 = ticketOf(adm);
      expect([t1.waiting, t2.waiting]).toEqual([false, true]);
      let calls = 0;
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>((r) => (releaseFirst = r));
      solver.impl = async () => {
        calls++;
        if (calls === 1) {
          await firstBlocked;
          if (ending === 'failure') throw new Error('connect ECONNREFUSED');
        }
        return jobResponse();
      };
      scheduleDispatchOptimize(argsFor('R1', 'J1', t1));
      scheduleDispatchOptimize(argsFor('R2', 'J2', t2));
      const p1 = g.__routeiqInflight.get('R1')!;
      const p2 = g.__routeiqInflight.get('R2')!;
      await settle();
      expect(row('runJob', 'J1').status).toBe('RUNNING');
      expect(row('runJob', 'J2').status).toBe('QUEUED'); // waiting for its slot, not failed
      expect(calls).toBe(1);
      expect(adm.snapshot()).toMatchObject({ running: 1, waiting: 1 });

      if (ending === 'stale result') Object.assign(row('runPlan', 'R1'), { status: 'SUPERSEDED', supersededAt: new Date() });
      releaseFirst();
      await p1;
      await p2;
      expect(row('runJob', 'J1').status).toBe(ending === 'success' ? 'SUCCEEDED' : 'FAILED');
      if (ending === 'stale result') expect(row('runJob', 'J1').errorJson).toMatchObject({ reason: 'STALE_RESULT' });
      expect(row('runJob', 'J2').status).toBe('SUCCEEDED');
      expect(row('runPlan', 'R2').status).toBe('READY');
      expect(calls).toBe(2);
      expect(adm.snapshot()).toMatchObject({ running: 0, waiting: 0 });
    });
  }

  it('a job started right behind a finishing job of the same version (whenIdle path) still gives its slot back', async () => {
    seedTwo();
    const adm = admission();
    const t1 = ticketOf(adm);
    let finishPrevious!: () => void;
    // The previous job of R1 is still leaving the in-flight map.
    trackInflight('R1', () => new Promise<void>((r) => (finishPrevious = r)));
    solver.impl = async () => jobResponse();
    expect(scheduleDispatchOptimize(argsFor('R1', 'J1', t1))).toBe(false);
    expect(adm.snapshot()).toMatchObject({ running: 1 });
    finishPrevious();
    for (let i = 0; i < 50 && row('runJob', 'J1').status !== 'SUCCEEDED'; i++) await settle();
    expect(row('runJob', 'J1').status).toBe('SUCCEEDED');
    await g.__routeiqInflight.get('R1');
    await settle();
    expect(adm.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });
});

describe('weights from the product master are saved with the applied plan only (review: failed re-plan kg)', () => {
  const change = {
    lines: [{ orderId: 'O1', lineId: 'LN1', cases: 20, beforeKg: 0, afterKg: 300, product: 'W-15' }],
    orders: [{ orderId: 'O1', beforeKg: 200, afterKg: 500 }],
  };
  const weightBuilt = {
    request: { stops: [{ stop_id: 's' }], trucks: [{ id: 'T1' }] },
    preDrops: [],
    scope: scope({ frozenLoadIds: [], frozenLoadOrderIds: [], frozenOrderIds: [], orderIds: ['O1'] }),
    blocking: [],
    warnings: [],
    unknownWeights: [],
    weightChanges: change,
  };
  function seedOne(chosen: string | null) {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
    tables.truck = [{ id: 'T1', tenantId: T, code: 'T01', defaultDriverId: null }];
    tables.order = [{ id: 'O1', tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'VALIDATED' }];
    tables.runPlan = [{ id: 'R', tenantId: T, depotId: 'D1', runDate: DAY, status: 'OPTIMIZING', version: 2, reason: 'REOPTIMIZE', chosenScenarioId: chosen, parentRunId: null, supersededAt: null, currentJobId: 'J1', finalizedAt: null, reconciliationJson: { ok: true } }];
    tables.runJob = [{ id: 'J1', runId: 'R', tenantId: T, attemptNo: 1, status: 'QUEUED' }];
    tables.planLoad = chosen ? [load('LC', 'R', 1, 'PLANNED', { carriedFromLoadId: 'Lp', weightKg: 200 })] : [];
    tables.routeAssignment = [];
    tables.scenarioResult = chosen ? [{ id: chosen, runId: 'R', name: 'RECOMMENDED', detailsJson: scenarioDetails() }] : [];
    tables.unservedOrder = [];
    tables.auditLog = [];
    tables.driver = [];
  }
  const jobArgs = (): DispatchJobArgs => ({ runId: 'R', runJobId: 'J1', tenantId: T, userId: 'u1', ip: null, built: weightBuilt as never });
  async function runJobToEnd() {
    const original = fakePrisma.$executeRaw;
    // The weight UPDATEs match every row they were given (the kg the request was built from).
    fakePrisma.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      await original(strings, ...values);
      return Array.isArray(values[0]) ? values[0].length : 0;
    };
    try {
      scheduleDispatchOptimize(jobArgs());
      await (globalThis as unknown as { __routeiqInflight: Map<string, Promise<void>> }).__routeiqInflight.get('R');
    } finally {
      fakePrisma.$executeRaw = original;
    }
  }
  const weightUpdates = () => rawLog.filter((s) => /UPDATE "OrderLine"|UPDATE "Order"/.test(s));

  it('success: saved in the finalization transaction, after the plan row lock, with its audit row', async () => {
    seedOne(null);
    solver.impl = async () => ({
      engine: 'OR-Tools',
      matrix_provider: 'HAVERSINE',
      distance_is_estimated: true,
      warnings: [],
      scenarios: [{ ...scenarioDetails({ scope: undefined }), unserved: [{ order_ids: ['O1'], reason_code: 'NO_AVAILABLE_TRUCK', reason_message: 'full' }] }],
    });
    await runJobToEnd();
    expect(row('runJob', 'J1').status).toBe('SUCCEEDED');
    expect(weightUpdates()).toHaveLength(2);
    const lock = rawLog.findIndex((s) => /FOR UPDATE/.test(s));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(rawLog.findIndex((s) => /UPDATE "OrderLine"/.test(s))).toBeGreaterThan(lock);
    expect(tables.auditLog.find((a) => a.action === 'ORDER_WEIGHTS_RESOLVED')).toMatchObject({ entityId: 'R', userId: 'u1' });
  });

  it('a failed re-plan saves no weight: the copied loads keep matching their orders', async () => {
    seedOne('scCopy');
    solver.impl = async () => {
      throw new Error('solver timeout');
    };
    await runJobToEnd();
    expect(row('runPlan', 'R')).toMatchObject({ status: 'FAILED', chosenScenarioId: 'scCopy' });
    expect(weightUpdates()).toHaveLength(0);
    expect(tables.auditLog.some((a) => a.action === 'ORDER_WEIGHTS_RESOLVED')).toBe(false);
    expect(row('planLoad', 'LC').weightKg).toBe(row('order', 'O1').totalWeightKg);
  });
});
