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
import { isLockBusy, PlanBusyError } from '@/lib/dispatch/plan-locks';
import { failJob, scheduleDispatchOptimize, type DispatchJobArgs } from '@/lib/jobs/dispatch-job';

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
