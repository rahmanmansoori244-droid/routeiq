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
  LOCATION_GATE_RULE,
  noLocationLoadRemedy,
  PlanError,
  replacedPinRemedy,
  updateLoad,
} from '@/lib/dispatch/plan-service';
import { driverClashes, isHandSetDriver } from '@/lib/dispatch/load-state';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { isLockBusy, PlanBusyError } from '@/lib/dispatch/plan-locks';
import { SolveAdmission, type SolveTicket } from '@/lib/dispatch/solve-admission';
import { failJob, scheduleDispatchOptimize, type DispatchJobArgs } from '@/lib/jobs/dispatch-job';
import { trackInflight } from '@/lib/jobs/optimize-job';
import { DATA_GATE_RULE, windowGateRemedy } from '@/lib/dispatch/data-collection';

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

describe("load changes and the owner's location rule (audit PR A5, second review)", () => {
  // The customer of O1 (on LOCKED L1) and O2 (on PLANNED L2), as it is NOW: the gate reads it by id.
  const customerNow = (over: Record<string, unknown>) => {
    tables.customer = [{ id: 'c', tenantId: T, code: 'C1', branchCode: null, lat: 23.6111, lng: 58.4111, locationVerified: false, geocodeConfidence: 'HIGH', ...over }];
  };

  it('a saved point marked LOW after planning: LOCK, LOADING and DISPATCH are refused (409 LOCATION_REQUIRED) and nothing changes', async () => {
    seedAppliedPlan();
    customerNow({ geocodeConfidence: 'LOW' });
    const lock = await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow).catch((e) => e);
    // Before: locked (and then dispatched) to the point the import had said was not usable.
    expect(lock).toBeInstanceOf(PlanError);
    expect(lock).toMatchObject({ status: 409, details: { code: 'LOCATION_REQUIRED', customerIds: ['c'], customers: ['C1'] } });
    expect(lock.message).toBe(`T01 L2: 1 customer on this load has no usable location: C1. ${LOCATION_GATE_RULE} ${noLocationLoadRemedy('PLANNED')}`);
    for (const to of ['LOADING', 'DISPATCHED'] as const) {
      const e = await updateLoad(T, 'P', 'L1', { status: to }, user, allow).catch((x) => x);
      expect(e, to).toMatchObject({ status: 409, details: { code: 'LOCATION_REQUIRED' } });
      expect(e.message).toContain(noLocationLoadRemedy('LOCKED'));
    }
    expect([row('planLoad', 'L1').status, row('planLoad', 'L2').status]).toEqual(['LOCKED', 'PLANNED']);
    expect(tables.auditLog).toEqual([]);
    // The way back is never refused.
    await updateLoad(T, 'P', 'L1', { status: 'PLANNED' }, user, allow);
    expect(row('planLoad', 'L1').status).toBe('PLANNED');
  });

  it.each([
    ['a point outside the delivery area, never confirmed', { lat: 24.7136, lng: 46.6753 }],
    ['no coordinates', { lat: null, lng: null, geocodeConfidence: 'MISSING' }],
    ['the point 0,0', { lat: 0, lng: 0 }],
  ])('a customer with %s is refused the same way', async (_what, over) => {
    seedAppliedPlan();
    customerNow(over);
    await expect(updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow)).rejects.toMatchObject({ status: 409, details: { code: 'LOCATION_REQUIRED' } });
  });

  it.each([
    ['a HIGH point not confirmed yet (an import, like the demo customers)', { geocodeConfidence: 'HIGH' }],
    ['a MEDIUM point not confirmed yet', { geocodeConfidence: 'MEDIUM' }],
    ['a LOW point confirmed by a dispatcher', { geocodeConfidence: 'LOW', locationVerified: true }],
    ['a point outside the delivery area, confirmed', { lat: 24.7136, lng: 46.6753, locationVerified: true }],
  ])('control: a customer with %s is locked and dispatched as before', async (_what, over) => {
    seedAppliedPlan();
    customerNow(over);
    await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
    await updateLoad(T, 'P', 'L1', { status: 'DISPATCHED' }, user, allow);
    expect([row('planLoad', 'L1').status, row('planLoad', 'L2').status]).toEqual(['DISPATCHED', 'LOCKED']);
  });

  it('the remedy says what to do for the load as it is: drop the pin, then RE-PLAN (a locked or loading load unlocked first); or go without them', () => {
    const pin = "Drop the pin on each one's exact location (ADD LOCATION on Daily dispatch, or Set location on the customer page)";
    expect(noLocationLoadRemedy('PLANNED')).toBe(`${pin}, then RE-PLAN. Or RE-PLAN now to leave their orders unserved.`);
    // A5 third review. Before: "then try again", and trying again sent the load out with the stop
    // still at the old point (a stop keeps the pin it was planned with until a re-plan).
    expect(noLocationLoadRemedy('LOCKED')).toBe(
      `${pin}. Then unlock this load (put it back to Planned) and RE-PLAN, so the stops go to the new pins. Or unlock it and RE-PLAN now to leave their orders unserved.`,
    );
    expect(noLocationLoadRemedy('LOADING')).toBe(
      `${pin}. Then put this load Back to locked, Unlock it (put it back to Planned) and RE-PLAN, so the stops go to the new pins. Or do that now, and take their cases off the truck, to leave their orders unserved.`,
    );
    for (const s of ['PLANNED', 'LOCKED', 'LOADING']) expect(noLocationLoadRemedy(s)).not.toMatch(/try again/);
  });

  // A5 third review: the dispatcher follows the refusal ("drop the pin") and tries again. The customer
  // is usable now, but the stop was planned at the point that was flagged: its pin, route link and
  // WhatsApp text still go there until a re-plan.
  describe('a stop still planned at a point that was not usable when a new pin replaced it', () => {
    const P1 = { lat: 23.6111, lng: 58.4111 };
    const snapshot = (at: { lat: number; lng: number } | null) => ({ v: 1, customerId: 'c', code: 'C1', branchCode: null, name: 'C1', customerType: null, address: null, accessNotes: null, hardStartMin: null, hardEndMin: null, prefStartMin: null, prefEndMin: null, serviceMin: 20, priority: 3, source: 'PLAN', capturedAt: '2026-09-26T18:00:00.000Z', ...(at ?? { lat: null, lng: null }) });
    /** Both stops planned at P1; the customer now at `now`; one location change replaced `before`. */
    function seedReplaced(now: Record<string, unknown>, before: Record<string, unknown> | null, planned: { lat: number; lng: number } | null = P1) {
      seedAppliedPlan();
      for (const a of tables.routeAssignment!) a.stopSnapshotJson = planned ? snapshot(planned) : null;
      customerNow({ lat: 23.64, lng: 58.44, locationVerified: true, geocodeConfidence: 'HIGH', ...now });
      if (before) {
        tables.auditLog!.push({ id: 'AU1', tenantId: T, userId: 'u1', action: 'CUSTOMER_LOCATION_SET', entity: 'Customer', entityId: 'c', beforeJson: before, afterJson: { lat: 23.64, lng: 58.44, source: 'MAP_PIN', confidence: 'HIGH', check: 'HAND_PIN' }, createdAt: new Date() });
      }
    }

    it.each([
      ['an import had marked it LOW', { ...P1, verified: false, confidence: 'LOW' }],
      ['it was outside the delivery area, never confirmed', { lat: 24.7136, lng: 46.6753, verified: false, confidence: 'HIGH' }],
    ])('%s: LOCK, LOADING and DISPATCH are refused (409 STOP_PIN_REPLACED) until a re-plan', async (_what, before) => {
      const planned = { lat: before.lat, lng: before.lng };
      seedReplaced({}, before, planned);
      const lock = await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow).catch((e) => e);
      // Before: locked (and then loaded and dispatched) with the stop at the flagged point.
      expect(lock).toBeInstanceOf(PlanError);
      expect(lock).toMatchObject({ status: 409, details: { code: 'STOP_PIN_REPLACED', customerIds: ['c'], customers: ['C1'] } });
      expect(lock.message).toBe(`T01 L2: the stop for C1 still goes to its old point, which was not usable. A new pin was placed after this load was planned. ${LOCATION_GATE_RULE} ${replacedPinRemedy('PLANNED')}`);
      for (const to of ['LOADING', 'DISPATCHED'] as const) {
        const e = await updateLoad(T, 'P', 'L1', { status: to }, user, allow).catch((x) => x);
        expect(e, to).toMatchObject({ status: 409, details: { code: 'STOP_PIN_REPLACED' } });
        expect(e.message).toContain(replacedPinRemedy('LOCKED'));
      }
      expect([row('planLoad', 'L1').status, row('planLoad', 'L2').status]).toEqual(['LOCKED', 'PLANNED']);
      // The way back is never refused.
      await updateLoad(T, 'P', 'L1', { status: 'PLANNED' }, user, allow);
      expect(row('planLoad', 'L1').status).toBe('PLANNED');
    });

    it('the remedy: RE-PLAN, after unlocking a locked or loading load', () => {
      expect(replacedPinRemedy('PLANNED')).toBe('RE-PLAN so the stops go to the new pins.');
      expect(replacedPinRemedy('LOCKED')).toBe('Unlock this load (put it back to Planned), then RE-PLAN so the stops go to the new pins.');
      expect(replacedPinRemedy('LOADING')).toBe('Put this load Back to locked, then Unlock it (put it back to Planned), then RE-PLAN so the stops go to the new pins.');
    });

    it.each([
      // A2's "New pin" path (owner default, frozen plan facts): an ordinary correction of a point that was usable.
      ['an ordinary correction of a usable point (HIGH, not confirmed)', {}, { ...P1, verified: false, confidence: 'HIGH' }, P1],
      ['an ordinary correction of a confirmed point', {}, { ...P1, verified: true, confidence: 'LOW' }, P1],
      ['the new pin within 50 m of the planned one', { lat: 23.6113, lng: 58.4112 }, { ...P1, verified: false, confidence: 'LOW' }, P1],
      ['a flagged point that is not the planned one', {}, { lat: 23.5, lng: 58.3, verified: false, confidence: 'LOW' }, P1],
      ['no location change recorded', {}, null, P1],
      ['a stop planned before snapshots existed (it shows the live pin)', {}, { ...P1, verified: false, confidence: 'LOW' }, null],
    ])('control: %s is locked and dispatched as before', async (_what, now, before, planned) => {
      seedReplaced(now, before, planned);
      await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
      await updateLoad(T, 'P', 'L1', { status: 'DISPATCHED' }, user, allow);
      expect([row('planLoad', 'L1').status, row('planLoad', 'L2').status]).toEqual(['DISPATCHED', 'LOCKED']);
    });

    // A5 fourth review: only the change that moved the customer off the planned point counts. A
    // change that confirmed the point where it was (a dispatcher typing its own coordinates, read as
    // exact; the ADD LOCATION dialog allows it) moves nothing, and an older change off the point is
    // not the one that replaced it. Before: any row whose "before" was the planned point while it was
    // flagged refused the load, so an ordinary correction of a confirmed point was refused with
    // "its old point, which was not usable" and a locked load was sent through unlock and RE-PLAN.
    const NOW = { lat: 23.64, lng: 58.44 };
    const R = { lat: 23.62, lng: 58.42 };
    const flagged = { verified: false, confidence: 'LOW' };
    const confirmed = { verified: true, confidence: 'HIGH' };
    /** Location changes of customer c, oldest first: [before, after]; `sameMs`: all made in the same millisecond. */
    function history(changes: [Record<string, unknown>, Record<string, unknown>][], sameMs = false) {
      tables.auditLog = changes.map(([before, after], i) => ({
        id: `AU${i + 1}`, tenantId: T, userId: 'u1', action: 'CUSTOMER_LOCATION_SET', entity: 'Customer', entityId: 'c',
        beforeJson: { source: 'IMPORT', ...before }, afterJson: { source: 'MAP_PIN', confidence: 'HIGH', check: 'HAND_PIN', ...after },
        createdAt: new Date(Date.UTC(2026, 8, 26, 18, sameMs ? 0 : i)),
      }));
    }
    // A hand pin a few metres from the planned point (P1 + about 3 m, about 44 m, about 61 m north).
    const P1_3M = { lat: 23.61113, lng: 58.4111 };
    const P1_44M = { lat: 23.6115, lng: 58.4111 };
    const P1_61M = { lat: 23.61165, lng: 58.4111 };

    it.each([
      [
        // Also a usable point planned, then flagged by a customer file (which writes no row), then this.
        'a flagged point confirmed where it was (its coordinates typed), then corrected by hand',
        [[{ ...P1, ...flagged }, { ...P1, source: 'MANUAL_LATLNG', check: 'READING' }], [{ ...P1, ...confirmed, source: 'MANUAL_LATLNG' }, NOW]],
      ],
      [
        'a flagged point replaced, set back by hand, then corrected by hand',
        [[{ ...P1, ...flagged }, R], [{ ...R, ...confirmed }, P1], [{ ...P1, ...confirmed }, NOW]],
      ],
      // A5 fifth review: a pin dropped exactly on a flagged saved point is refused (PIN_REQUIRED), so a
      // hand pin confirms it a few metres off; the gate counts that pin as the same place (within 50 m),
      // and so does this. Before: its later correction was refused as "its old point, which was not
      // usable" (the change off the pin did not start exactly at the planned point, so the older
      // flagged row decided).
      [
        'a flagged point confirmed by a hand pin about 3 m off, then corrected by hand',
        [[{ ...P1, ...flagged }, P1_3M], [{ ...P1_3M, ...confirmed }, NOW]],
      ],
      [
        'a flagged point confirmed by a hand pin about 44 m off, then corrected by hand',
        [[{ ...P1, ...flagged }, P1_44M], [{ ...P1_44M, ...confirmed }, NOW]],
      ],
    ] as [string, [Record<string, unknown>, Record<string, unknown>][]][])('control: %s is locked and dispatched as before', async (_what, changes) => {
      seedReplaced({}, null);
      history(changes);
      await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
      await updateLoad(T, 'P', 'L1', { status: 'LOADING' }, user, allow);
      await updateLoad(T, 'P', 'L1', { status: 'DISPATCHED' }, user, allow);
      expect([row('planLoad', 'L1').status, row('planLoad', 'L2').status]).toEqual(['DISPATCHED', 'LOCKED']);
    });

    it.each([
      [
        'confirmed where it was, flagged again by a customer file, then replaced',
        [[{ ...P1, ...flagged }, { ...P1, check: 'READING' }], [{ ...P1, ...flagged }, NOW]],
      ],
      [
        'corrected once while usable, set back, flagged, then replaced',
        [[{ ...P1, ...confirmed }, R], [{ ...R, ...confirmed }, { ...P1, source: 'IMPORT', check: 'IMPORT' }], [{ ...P1, ...flagged }, NOW]],
      ],
      // A pin more than 50 m from the flagged point is not the same place: the change that moved the
      // customer there was made while the point was flagged, whatever came after it.
      [
        'a flagged point replaced by a hand pin about 61 m away, then corrected by hand',
        [[{ ...P1, ...flagged }, P1_61M], [{ ...P1_61M, ...confirmed }, NOW]],
      ],
      ['a flagged point replaced by a hand pin about 3 km away', [[{ ...P1, ...flagged }, NOW]]],
      // The planned point's place is PIN_MOVED_M around it: a flagged point about 33 m from it (the
      // saved point moved a little after planning, then a file flagged it) is the same place.
      ['a flagged point about 33 m from the planned one, replaced by a hand pin about 3 km away', [[{ lat: 23.6114, lng: 58.4111, ...flagged }, NOW]]],
    ] as [string, [Record<string, unknown>, Record<string, unknown>][]][])('still refused: %s (the newest change off the planned point was made while it was flagged)', async (_what, changes) => {
      seedReplaced({}, null);
      history(changes);
      await expect(updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow)).rejects.toMatchObject({ status: 409, details: { code: 'STOP_PIN_REPLACED' } });
      await expect(updateLoad(T, 'P', 'L1', { status: 'LOADING' }, user, allow)).rejects.toMatchObject({ status: 409, details: { code: 'STOP_PIN_REPLACED' } });
    });

    // A5 fifth review: a change that left the customer at the planned point's place (a flagged point
    // confirmed where it is, typed or by a hand pin a few metres off) moved nothing, so it never
    // decides, also when a correction was recorded in the same millisecond. Before: the fourth
    // review's "confirmed where it was" skip was reached by no test (removing it left every test
    // green), and changes of the same millisecond were refused when one of them blocked.
    it.each([
      ['confirmed by its coordinates typed', [[{ ...P1, ...flagged }, { ...P1, source: 'MANUAL_LATLNG', check: 'READING' }], [{ ...P1, ...confirmed, source: 'MANUAL_LATLNG' }, NOW]]],
      ['confirmed by a hand pin about 3 m off', [[{ ...P1, ...flagged }, P1_3M], [{ ...P1_3M, ...confirmed }, NOW]]],
    ] as [string, [Record<string, unknown>, Record<string, unknown>][]][])('control: a flagged point %s, then corrected by hand in the same millisecond, is locked and loaded', async (_what, changes) => {
      seedReplaced({}, null);
      history(changes, true);
      await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
      await updateLoad(T, 'P', 'L1', { status: 'LOADING' }, user, allow);
      expect([row('planLoad', 'L1').status, row('planLoad', 'L2').status]).toEqual(['LOADING', 'LOCKED']);
    });

    it('still refused in the same millisecond: a flagged point replaced by a pin 3 km away, whatever else was recorded then', async () => {
      seedReplaced({}, null);
      history([[{ ...P1, ...flagged }, P1_3M], [{ ...P1, ...flagged }, NOW]], true);
      await expect(updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow)).rejects.toMatchObject({ status: 409, details: { code: 'STOP_PIN_REPLACED' } });
    });
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

  it('audit F09: failJob writes the job, the plan and OPTIMIZE_FAILED in ONE transaction under the plan row lock', async () => {
    seedOptimizing();
    tables.runJob[0]!.status = 'RUNNING';
    failAudit.action = 'OPTIMIZE_FAILED';
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await failJob(args(), new Error('solver down'));
    quiet.mockRestore();
    // The audit write failed: nothing changed - never a FAILED job behind an OPTIMIZING plan (or
    // the reverse). The job stays in progress with no process, so the janitor fails both later.
    expect(row('runJob', 'J1').status).toBe('RUNNING');
    expect(row('runPlan', 'R').status).toBe('OPTIMIZING');
    expect(tables.auditLog.filter((a) => a.action === 'OPTIMIZE_FAILED')).toHaveLength(0);

    failAudit.action = null;
    rawLog.length = 0;
    await failJob(args(), new Error('solver down'));
    expect(row('runJob', 'J1').status).toBe('FAILED');
    expect(row('runPlan', 'R').status).toBe('FAILED');
    expect(tables.auditLog.filter((a) => a.action === 'OPTIMIZE_FAILED')).toHaveLength(1);
    expect(forUpdateIndex()).toBeGreaterThanOrEqual(0); // the plan row was locked first
  });

  it('audit F09: a stale result is recorded (job FAILED + OPTIMIZE_FAILED) in one transaction too', async () => {
    seedOptimizing({ status: 'SUPERSEDED', supersededAt: new Date() });
    solver.impl = async () => response();
    failAudit.action = 'OPTIMIZE_FAILED';
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runToEnd();
    quiet.mockRestore();
    expect(row('runJob', 'J1').status).toBe('RUNNING'); // not FAILED without its audit row
    expect(tables.auditLog.filter((a) => a.action === 'OPTIMIZE_FAILED')).toHaveLength(0);
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
    // The search's raw OR-Tools code never reaches the dispatcher (PR6, scenario tests).
    expect(row('runJob', 'J1').message).not.toMatch(/ROUTING_/);
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

describe('copy-forward re-plan: drivers are never double-booked on a frozen load', () => {
  /**
   * v1 (superseded): T01 L1 Ali 06:00-09:00 `frozen` (LOCKED unless said); T02 L1 Ali 09:30-11:00
   * PLANNED. v2 holds copies of both (copy-forward) while its optimization runs; the optimization's
   * RECOMMENDED plan has T02 L1 leaving at `t2DepartMin`, its MIN_COST option at 08:00. The trucks'
   * codes (T01, T02) differ from their ids (T1, T2): a note names T01, which the new plan leaves
   * out, by its code.
   */
  function seedCopyForward(t2DepartMin: number, frozen = 'LOCKED') {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
    tables.truck = ['T1', 'T2'].map((id) => ({ id, tenantId: T, code: id.replace('T', 'T0'), defaultDriverId: null }));
    tables.driver = [{ id: 'ALI', tenantId: T, active: true, name: 'Ali' }];
    tables.order = ['O1', 'O2'].map((id) => ({ id, tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED' }));
    const base = { tenantId: T, depotId: 'D1', runDate: DAY, optimizationMode: 'BALANCED', finalizedAt: null, totalOrders: 2, unservedCount: 0, summaryJson: null, reconciliationJson: { ok: true }, changeSummaryJson: null, createdById: 'u1', createdAt: new Date() };
    tables.runPlan = [
      { ...base, id: 'P', status: 'SUPERSEDED', supersededAt: new Date(), version: 1, reason: 'INITIAL', chosenScenarioId: 'scP', parentRunId: null, currentJobId: null },
      { ...base, id: 'C', status: 'OPTIMIZING', supersededAt: null, version: 2, reason: 'LATE_ORDER', chosenScenarioId: 'scCopy', parentRunId: 'P', currentJobId: 'J1' },
    ];
    const byHand = { driverSetById: 'u1', driverSetAt: new Date('2026-09-26T05:00:00Z') };
    tables.planLoad = [
      load('PL1', 'P', 1, frozen, { truckId: 'T1', driverId: 'ALI', departMin: 360, returnMin: 540, ...byHand }),
      load('PL2', 'P', 1, 'PLANNED', { truckId: 'T2', driverId: 'ALI', departMin: 570, returnMin: 660 }),
      load('CL1', 'C', 1, frozen, { truckId: 'T1', driverId: 'ALI', departMin: 360, returnMin: 540, carriedFromLoadId: 'PL1', ...byHand }),
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
  const aliOnT1 = { truckId: 'T2', truckCode: 'T02', loadNo: 1, departMin: 480, returnMin: 660, from: { id: 'ALI', name: 'Ali' }, to: null, reason: 'CLASH', other: { truckCode: 'T01', loadNo: 1 } };

  for (const frozen of ['LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED']) {
    it(`the re-plan job: a PLANNED trip re-timed onto the ${frozen} load of its filled-in driver loses the driver (CLASH note naming T01 by its code); the ${frozen} load is untouched`, async () => {
      seedCopyForward(480, frozen);
      const frozenBefore = { ...row('planLoad', 'CL1') };
      const res = await applyScenario(fakePrisma as never, T, 'C', 'scNew', 'u1', { jobId: 'J1' });
      const loads = tables.planLoad.filter((l) => l.runId === 'C');
      expect(loads.find((l) => l.id === 'CL1')).toEqual(frozenBefore); // frozen: driver, marker, status and times as they were
      const t2 = loads.find((l) => l.truckId === 'T2')!;
      expect(t2.id).not.toBe('CL2'); // the copy was replaced by the new plan's load
      expect(t2.driverId).toBeNull(); // not a second sheet for Ali at 08:00 while T01 is out until 09:00
      expect(res.driverChanges).toEqual([aliOnT1]); // T01 by its code: the truck of the frozen load, not in the new plan
      expect(row('runPlan', 'C').summaryJson.driverChanges).toEqual([aliOnT1]);
    });
  }

  it('"Use instead" re-timing a trip onto the LOCKED load of its driver leaves it without a driver (no double booking)', async () => {
    seedCopyForward(570); // RECOMMENDED keeps T02 L1 at 09:30: Ali stays on it
    await applyScenario(fakePrisma as never, T, 'C', 'scNew', 'u1', { jobId: 'J1' });
    const applied = tables.planLoad.find((l) => l.runId === 'C' && l.truckId === 'T2')!;
    expect(applied).toMatchObject({ driverId: 'ALI', carriedFromLoadId: null, departMin: 570 });
    Object.assign(row('runPlan', 'C'), { status: 'READY', currentJobId: null });
    // The dispatcher picks MIN_COST: T02 L1 now leaves at 08:00, while Ali's LOCKED T01 load is out until 09:00.
    const res = await chooseScenario(T, 'C', 'scMinCost', 'u1');
    const loads = tables.planLoad.filter((l) => l.runId === 'C');
    expect(loads.find((l) => l.id === 'CL1')).toMatchObject({ status: 'LOCKED', driverId: 'ALI', driverSetById: 'u1' });
    expect(loads.find((l) => l.truckId === 'T2')).toMatchObject({ departMin: 480, driverId: null });
    expect(driverClashes(loads.map((l) => ({ id: l.id, truckId: l.truckId, driverId: l.driverId, departMin: l.departMin, returnMin: l.returnMin })))).toHaveLength(0);
    expect(res.driverChanges).toEqual([aliOnT1]);
  });
});

describe('drivers of an optimize, a re-plan and "Use instead" (the simplified driver rules)', () => {
  /**
   * Trucks T2 and T3 (codes T02, T03): T2's default driver is Ali, T3's is Sam; Bob has no truck. `version(id, loads)` adds an applied
   * READY version holding `loads` (RouteIQ's drivers unless `hand`) and its RECOMMENDED option.
   * "Use instead" (`useInstead`) and the re-plan job (`replanJob`, from a copy-forward version)
   * apply `trips` to the version. Minutes: 480 = 08:00, 570 = 09:30, 600 = 10:00, 620 = 10:20,
   * 660 = 11:00, 720 = 12:00, 740 = 12:20, 840 = 14:00.
   */
  type Trip = { truck: 'T2' | 'T3'; loadNo?: number; at: [number, number]; order: string };
  type Held = Trip & { driver?: string | null; hand?: boolean };
  const both = ['T2 listed first', 'T3 listed first'] as const;
  type Order = (typeof both)[number];
  const inOrder = <X,>(order: Order, list: X[]) => (order === 'T2 listed first' ? list : [...list].reverse());
  const HAND_AT = new Date('2026-09-26T05:00:00Z');
  const ali = { id: 'ALI', name: 'Ali' };
  const sam = { id: 'SAM', name: 'Sam' };
  const bob = { id: 'BOB', name: 'Bob' };
  const customer = {
    id: 'c', code: 'C', branchCode: null, name: 'Customer', customerType: null, priority: 3, priorityConfirmed: true, avgServiceTimeMin: 10, serviceTimeConfirmed: true,
    lat: 23.6, lng: 58.4, branchKey: '__MAIN__', address: null, accessNotes: null, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, active: true,
  };
  function seedDay() {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true, lat: 23.6, lng: 58.4 }];
    // Codes differ from ids: a note names a truck by its code, also one the new plan leaves out.
    tables.truck = [
      { id: 'T2', tenantId: T, code: 'T02', defaultDriverId: 'ALI' },
      { id: 'T3', tenantId: T, code: 'T03', defaultDriverId: 'SAM' },
    ];
    tables.driver = [ali, sam, bob].map((d) => ({ ...d, tenantId: T, active: true }));
    // Orders the plan screen (getPlanDetail) can read: customer, lines and notes on the row.
    tables.order = ['O2', 'O3'].map((id) => ({ id, tenantId: T, customerId: 'c', totalCases: 20, totalWeightKg: 200, priority: 3, salesValue: null, marginValue: null, isLate: false, status: 'ASSIGNED', notes: null, lines: [], customer }));
    tables.tenantConfig = [];
    tables.customerTypeProfile = [];
    tables.runPlan = [];
    tables.planLoad = [];
    tables.routeAssignment = [];
    tables.scenarioResult = [];
    tables.unservedOrder = [];
    tables.auditLog = [];
    tables.runJob = [];
  }
  const solverOf = (trips: Trip[]) => trips.map((t) => solverLoad(t.truck, t.loadNo ?? 1, t.at[0], t.at[1], [t.order]));
  const sc = (trips: Trip[]) => scope({ orderIds: trips.map((t) => t.order), frozenOrderIds: [], frozenLoadIds: [], frozenLoadOrderIds: [] });
  function version(id: string, held: Held[]) {
    const base = { tenantId: T, depotId: 'D1', runDate: DAY, optimizationMode: 'BALANCED', finalizedAt: null, totalOrders: 2, unservedCount: 0, summaryJson: null, reconciliationJson: { ok: true }, changeSummaryJson: null, createdById: 'u1', createdAt: new Date() };
    tables.runPlan.push({ ...base, id, status: 'READY', supersededAt: null, version: 1, reason: 'INITIAL', chosenScenarioId: `${id}-rec`, parentRunId: null, currentJobId: null });
    for (const h of held) {
      const loadId = `${id}-${h.truck}-${h.loadNo ?? 1}`;
      const marker = h.hand ? { driverSetById: 'u1', driverSetAt: HAND_AT } : { driverSetById: null, driverSetAt: null };
      tables.planLoad.push(load(loadId, id, h.loadNo ?? 1, 'PLANNED', { truckId: h.truck, driverId: h.driver ?? null, departMin: h.at[0], returnMin: h.at[1], ...marker }));
      tables.routeAssignment.push({ ...assignment(`${loadId}-A`, id, loadId, h.order, h.loadNo ?? 1), truckId: h.truck });
    }
    tables.scenarioResult.push({ id: `${id}-rec`, runId: id, name: 'RECOMMENDED', unservedCount: 0, detailsJson: scenarioDetails({ scope: sc(held), loads: solverOf(held) }) });
  }
  /**
   * The plans are applied by another dispatcher (u2) than the one who set drivers by hand (u1,
   * `user`): a carried marker must name u1, read from the evidence row.
   */
  const APPLIER = 'u2';
  /** "Use instead": the dispatcher chooses an option of `runId` with `trips`. */
  async function useInstead(runId: string, trips: Trip[], name = 'MIN_COST') {
    const id = `${runId}-opt${tables.scenarioResult.length}`;
    tables.scenarioResult.push({ id, runId, name, unservedCount: 0, detailsJson: scenarioDetails({ name, scope: sc(trips), loads: solverOf(trips) }) });
    return { runId, res: await chooseScenario(T, runId, id, APPLIER) };
  }
  /** The optimization job of version `runId` applies `trips` (its RECOMMENDED option); the version is READY after. */
  async function jobApplies(runId: string, trips: Trip[]) {
    const jobId = `J${tables.runJob.length + 1}`;
    Object.assign(row('runPlan', runId), { status: 'OPTIMIZING', currentJobId: jobId });
    tables.runJob.push({ id: jobId, runId, tenantId: T, attemptNo: 1, status: 'RUNNING' });
    tables.scenarioResult.push({ id: `${jobId}-rec`, runId, name: 'RECOMMENDED', unservedCount: 0, detailsJson: scenarioDetails({ scope: sc(trips), loads: solverOf(trips) }) });
    const res = await applyScenario(fakePrisma as never, T, runId, `${jobId}-rec`, APPLIER, { jobId });
    Object.assign(row('runJob', jobId), { status: 'SUCCEEDED' });
    Object.assign(row('runPlan', runId), { currentJobId: null });
    return { runId, res };
  }
  /** A late-order re-plan of `parentId` (copy-forward) whose job applies `trips`; the new version is READY after. */
  async function replanJob(parentId: string, trips: Trip[]) {
    const { child } = await createNextVersion(T, parentId, 'LATE_ORDER', null, APPLIER);
    return jobApplies(child.id, trips);
  }
  const loadOf = (runId: string, truckId: string, loadNo = 1) => tables.planLoad.find((l) => l.runId === runId && l.truckId === truckId && l.loadNo === loadNo)!;
  /** Each trip's driver, "(by hand: <user>)" when it carries the marker. */
  const tripsOf = (runId: string) =>
    Object.fromEntries(
      tables.planLoad
        .filter((l) => l.runId === runId)
        .map((l) => [`${l.truckId}:${l.loadNo}`, `${l.driverId ?? 'none'}${l.driverSetAt || l.driverSetById ? ` (by hand: ${l.driverSetById})` : ''}`]),
    );
  /** The driver notes of the last SCENARIO_CHOSEN audit row. */
  const auditedNotes = () => tables.auditLog.filter((a) => a.action === 'SCENARIO_CHOSEN').at(-1)!.afterJson.driverChanges;
  const clashesOf = (runId: string) =>
    driverClashes(tables.planLoad.filter((l) => l.runId === runId).map((l) => ({ id: l.id, truckId: l.truckId, driverId: l.driverId, departMin: l.departMin, returnMin: l.returnMin }))).length;
  /** The driver notes the plan screen (and the Excel workbook: the same PlanDetail) lists. */
  const shown = async (runId: string) => (await getPlanDetail(T, runId))!.warnings.filter((w) => w.startsWith('Driver '));
  /**
   * The same evidence through "Use instead" on version R and through the re-plan job from version P
   * (evidence: its copy-forward copies): drivers, notes, clashes and what the screen lists.
   */
  async function bothPaths(held: Held[], trips: Trip[], before: (runId: string) => void | Promise<void> = () => {}) {
    const outcome = async (runId: string, res: { driverChanges: unknown[] }) => ({
      trips: tripsOf(runId),
      notes: res.driverChanges,
      stored: row('runPlan', runId).summaryJson.driverChanges ?? [],
      clashes: clashesOf(runId),
      shown: await shown(runId),
    });
    seedDay();
    version('R', held);
    await before('R');
    const u = await useInstead('R', trips);
    const viaUseInstead = await outcome(u.runId, u.res);
    seedDay();
    version('P', held);
    await before('P');
    const j = await replanJob('P', trips);
    return { viaUseInstead, viaJob: await outcome(j.runId, j.res) };
  }

  it("the dispatcher's driver change marks the load (who, when); a re-plan's copies keep it; \"No driver\" is marked too, but is no hand-set driver", async () => {
    seedDay();
    version('P', [{ truck: 'T2', at: [720, 840], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [570, 660], order: 'O3', driver: 'SAM' }]);
    await updateLoad(T, 'P', 'P-T3-1', { driverId: 'ALI' }, user, allow);
    expect(row('planLoad', 'P-T3-1')).toMatchObject({ driverId: 'ALI', driverSetById: 'u1' });
    expect(row('planLoad', 'P-T3-1').driverSetAt).toBeInstanceOf(Date);
    const { child } = await createNextVersion(T, 'P', 'LATE_ORDER', null, 'u1');
    const copy = loadOf(child.id, 'T3');
    expect(copy).toMatchObject({ driverId: 'ALI', driverSetById: 'u1', carriedFromLoadId: 'P-T3-1' });
    expect(copy.driverSetAt).toEqual(row('planLoad', 'P-T3-1').driverSetAt);
    expect(loadOf(child.id, 'T2').driverSetAt ?? null).toBeNull(); // filled in by RouteIQ: no marker
    await updateLoad(T, child.id, copy.id, { driverId: null }, { id: 'u3', role: 'TENANT_ADMIN' }, allow);
    expect(row('planLoad', copy.id)).toMatchObject({ driverId: null, driverSetById: 'u3' }); // who chose "No driver"
    expect(row('planLoad', copy.id).driverSetAt).toBeInstanceOf(Date);
    expect(isHandSetDriver(row('planLoad', copy.id) as { driverId: string | null })).toBe(false);
  });

  it('the re-plan job reads the copies as they are when it applies: a driver the dispatcher sets on a copy before the job starts is hand-set and kept, as "Use instead" keeps it', async () => {
    // Filled in: T2 L1 Ali, T3 L1 Sam. The dispatcher then picks Bob for T3 L1 of the version the plan is applied to.
    const held: Held[] = [{ truck: 'T2', at: [480, 600], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [480, 600], order: 'O3', driver: 'SAM' }];
    const trips: Trip[] = [{ truck: 'T2', at: [480, 600], order: 'O2' }, { truck: 'T3', at: [480, 600], order: 'O3' }];
    const expected = { 'T2:1': 'ALI', 'T3:1': 'BOB (by hand: u1)' };
    seedDay();
    version('R', held);
    await updateLoad(T, 'R', 'R-T3-1', { driverId: 'BOB' }, user, allow);
    await useInstead('R', trips);
    expect(tripsOf('R')).toEqual(expected);
    // The re-plan commits the new version (READY, its copies editable) and only then starts the job.
    seedDay();
    version('P', held);
    const { child } = await createNextVersion(T, 'P', 'LATE_ORDER', null, APPLIER);
    expect(row('runPlan', child.id).status).toBe('READY');
    await updateLoad(T, child.id, loadOf(child.id, 'T3').id, { driverId: 'BOB' }, user, allow);
    expect(loadOf('P', 'T3')).toMatchObject({ driverId: 'SAM', driverSetAt: null }); // the previous version still says Sam
    const job = await jobApplies(child.id, trips);
    expect(tripsOf(child.id)).toEqual(expected); // the copy, not the previous version's Sam
    expect(job.res.driverChanges).toEqual([]);
  });

  it('Keep: re-sending a filled-in driver marks it (audited once); on a load that is out it changes nothing', async () => {
    seedDay();
    version('R', [{ truck: 'T2', at: [570, 660], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [720, 840], order: 'O3', driver: 'ALI' }]);
    await updateLoad(T, 'R', 'R-T3-1', { driverId: 'ALI' }, user, allow);
    expect(row('planLoad', 'R-T3-1')).toMatchObject({ driverId: 'ALI', driverSetById: 'u1' });
    expect(row('planLoad', 'R-T3-1').driverSetAt).toBeInstanceOf(Date);
    const kept = tables.auditLog.filter((a) => a.action === 'LOAD_DRIVER_SET');
    expect(kept).toHaveLength(1);
    expect(kept[0]!.afterJson).toMatchObject({ driverId: 'ALI', kept: true, truckId: 'T3', loadNo: 1 });
    await updateLoad(T, 'R', 'R-T3-1', { driverId: 'ALI' }, user, allow); // already the dispatcher's: nothing
    expect(tables.auditLog.filter((a) => a.action === 'LOAD_DRIVER_SET')).toHaveLength(1);

    Object.assign(row('planLoad', 'R-T2-1'), { status: 'DISPATCHED' });
    const audits = tables.auditLog.length;
    expect(await updateLoad(T, 'R', 'R-T2-1', { driverId: 'ALI' }, user, allow)).toMatchObject({ driverId: 'ALI' });
    expect(row('planLoad', 'R-T2-1').driverSetAt ?? null).toBeNull();
    expect(tables.auditLog.length).toBe(audits);
  });

  for (const order of both) {
    it(`a hand-set driver stays on its trip; the filled-in trip moved onto it loses the driver (CLASH note) - the re-plan job and "Use instead" alike (${order})`, async () => {
      // T2 L1 Ali filled in 12:00-14:00, moved to 10:00-12:00; T3 L1 Ali by hand 09:30-11:00.
      const { viaUseInstead, viaJob } = await bothPaths(
        [{ truck: 'T2', at: [720, 840], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [570, 660], order: 'O3', driver: 'ALI', hand: true }],
        inOrder(order, [{ truck: 'T2', at: [600, 720], order: 'O2' }, { truck: 'T3', at: [570, 660], order: 'O3' }]),
      );
      const note = { truckId: 'T2', truckCode: 'T02', loadNo: 1, departMin: 600, returnMin: 720, from: ali, to: null, reason: 'CLASH', other: { truckCode: 'T03', loadNo: 1 } };
      expect(viaUseInstead).toEqual({
        trips: { 'T2:1': 'none', 'T3:1': 'ALI (by hand: u1)' }, // Ali is T2's default too: taken
        notes: [note],
        stored: [note],
        clashes: 0,
        shown: ['Driver changed by this plan: T02 · L1 (10:00–12:00) Ali → no driver, because Ali is on T03 · L1 at that time.'],
      });
      expect(viaJob).toEqual(viaUseInstead);
      expect(loadOf(tables.runPlan.at(-1)!.id, 'T3').driverSetAt).toEqual(HAND_AT); // the marker, carried as it was
      expect(tables.auditLog.find((a) => a.action === 'SCENARIO_CHOSEN')!.afterJson.driverChanges).toEqual([{ truckId: 'T2', loadNo: 1, from: 'ALI', to: null, reason: 'CLASH' }]);
    });

    it(`two hand-set trips of one driver that now overlap both keep the driver: the yellow clash warning, no note (${order})`, async () => {
      const { viaUseInstead, viaJob } = await bothPaths(
        [{ truck: 'T2', at: [570, 660], order: 'O2', driver: 'ALI', hand: true }, { truck: 'T3', at: [720, 840], order: 'O3', driver: 'ALI', hand: true }],
        inOrder(order, [{ truck: 'T2', at: [600, 720], order: 'O2' }, { truck: 'T3', at: [630, 750], order: 'O3' }]),
      );
      expect(viaUseInstead).toEqual({ trips: { 'T2:1': 'ALI (by hand: u1)', 'T3:1': 'ALI (by hand: u1)' }, notes: [], stored: [], clashes: 1, shown: [] });
      expect(viaJob).toEqual(viaUseInstead);
    });

    it(`filled-in drivers: the trip that moved loses the driver and gets its default when free (CLASH note) - the job and "Use instead" alike (${order})`, async () => {
      // T2 L1 Ali 09:30-11:00 does not move; T3 L1 Ali 12:00-14:00 moves to 10:00-12:00: Sam, its default.
      const { viaUseInstead, viaJob } = await bothPaths(
        [{ truck: 'T2', at: [570, 660], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [720, 840], order: 'O3', driver: 'ALI' }],
        inOrder(order, [{ truck: 'T2', at: [570, 660], order: 'O2' }, { truck: 'T3', at: [600, 720], order: 'O3' }]),
      );
      const note = { truckId: 'T3', truckCode: 'T03', loadNo: 1, departMin: 600, returnMin: 720, from: ali, to: sam, reason: 'CLASH', other: { truckCode: 'T02', loadNo: 1 } };
      expect(viaUseInstead).toEqual({
        trips: { 'T2:1': 'ALI', 'T3:1': 'SAM' },
        notes: [note],
        stored: [note],
        clashes: 0,
        shown: ['Driver changed by this plan: T03 · L1 (10:00–12:00) Ali → Sam, because Ali is on T02 · L1 at that time.'],
      });
      expect(viaJob).toEqual(viaUseInstead);
    });

    it(`a hand-set driver who is no longer active: RouteIQ's pick without the marker, and an INACTIVE note - the job and "Use instead" alike (${order})`, async () => {
      const { viaUseInstead, viaJob } = await bothPaths(
        [{ truck: 'T2', at: [480, 600], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [480, 600], order: 'O3', driver: 'BOB', hand: true }],
        inOrder(order, [{ truck: 'T2', at: [480, 600], order: 'O2' }, { truck: 'T3', at: [480, 600], order: 'O3' }]),
        () => void Object.assign(row('driver', 'BOB'), { active: false }),
      );
      const note = { truckId: 'T3', truckCode: 'T03', loadNo: 1, departMin: 480, returnMin: 600, from: bob, to: sam, reason: 'INACTIVE', other: null };
      expect(viaUseInstead).toEqual({
        trips: { 'T2:1': 'ALI', 'T3:1': 'SAM' },
        notes: [note],
        stored: [note],
        clashes: 0,
        shown: ['Driver changed by this plan: T03 · L1 (08:00–10:00) Bob → Sam, because Bob is no longer active.'],
      });
      expect(viaJob).toEqual(viaUseInstead);
    });

    it(`filling a trip that had no driver ("No driver") is not a note - the job and "Use instead" alike (${order})`, async () => {
      const { viaUseInstead, viaJob } = await bothPaths(
        [{ truck: 'T2', at: [480, 600], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [480, 600], order: 'O3', driver: 'SAM' }],
        inOrder(order, [{ truck: 'T2', at: [480, 600], order: 'O2' }, { truck: 'T3', at: [490, 610], order: 'O3' }]),
        (runId) => updateLoad(T, runId, `${runId}-T3-1`, { driverId: null }, user, allow).then(() => undefined),
      );
      expect(viaUseInstead).toEqual({ trips: { 'T2:1': 'ALI', 'T3:1': 'SAM' }, notes: [], stored: [], clashes: 0, shown: [] });
      expect(viaJob).toEqual(viaUseInstead);
    });

    it(`trip 1 and trip 2 of one truck share the driver when their times only touch - the job and "Use instead" alike (${order})`, async () => {
      // T2 L1 Ali by hand 08:00-10:00; T2 L2 had no driver, re-timed to leave at 10:00: Ali, from T2 L1.
      const { viaUseInstead, viaJob } = await bothPaths(
        [{ truck: 'T2', at: [480, 600], order: 'O2', driver: 'ALI', hand: true }, { truck: 'T2', loadNo: 2, at: [620, 740], order: 'O3', driver: null }],
        inOrder(order, [{ truck: 'T2', at: [480, 600], order: 'O2' }, { truck: 'T2', loadNo: 2, at: [600, 720], order: 'O3' }]),
      );
      expect(viaUseInstead).toEqual({ trips: { 'T2:1': 'ALI (by hand: u1)', 'T2:2': 'ALI' }, notes: [], stored: [], clashes: 0, shown: [] });
      expect(viaJob).toEqual(viaUseInstead);
    });

    it(`TRIP_GONE: an option without the hand-set trip notes it; the plan with that trip again does not bring the driver back (${order})`, async () => {
      const bobGone = { truckId: 'T3', truckCode: 'T03', loadNo: 1, departMin: 480, returnMin: 600, from: bob, to: null, reason: 'TRIP_GONE', other: null };
      const bobText = 'Driver picked by hand, not in this plan: you picked Bob for T03 · L1 (08:00–10:00), and this plan has no such trip. If a later plan has that trip again, pick the driver again.';
      const bobAudited = { truckId: 'T3', loadNo: 1, from: 'BOB', to: null, reason: 'TRIP_GONE' };
      const held: Held[] = [{ truck: 'T2', at: [480, 600], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [480, 600], order: 'O3', driver: 'BOB', hand: true }];
      const t2only: Trip[] = [{ truck: 'T2', at: [480, 600], order: 'O2' }, { truck: 'T2', loadNo: 2, at: [620, 740], order: 'O3' }];
      const t2t3 = inOrder<Trip>(order, [{ truck: 'T2', at: [480, 600], order: 'O2' }, { truck: 'T3', at: [480, 600], order: 'O3' }]);

      // "Use instead" to MIN_TRUCKS (no T3), then back to an option with T3 L1.
      seedDay();
      version('R', held);
      const away = await useInstead('R', t2only, 'MIN_TRUCKS');
      expect(tripsOf('R')).toEqual({ 'T2:1': 'ALI', 'T2:2': 'ALI' }); // T2 L2 gets T2 L1's Ali (filled in: no note)
      expect(away.res.driverChanges).toEqual([bobGone]);
      expect(auditedNotes()).toEqual([bobAudited]);
      expect(await shown('R')).toEqual([bobText]);
      expect(row('runPlan', 'R').summaryJson).not.toHaveProperty('parkedDrivers');
      // A load change keeps the note (the summary is refreshed, the notes stay).
      await updateLoad(T, 'R', loadOf('R', 'T2').id, { status: 'LOCKED' }, user, allow);
      await updateLoad(T, 'R', loadOf('R', 'T2').id, { status: 'PLANNED' }, user, allow);
      expect(await shown('R')).toEqual([bobText]);
      const back = await useInstead('R', t2t3);
      expect(tripsOf('R')).toEqual({ 'T2:1': 'ALI', 'T3:1': 'SAM' }); // T3's default, filled in: Bob is not put back
      expect(back.res.driverChanges).toEqual([]);
      expect(auditedNotes()).toBeUndefined();
      expect(row('runPlan', 'R').summaryJson.driverChanges).toBeUndefined(); // replaced, not kept
      expect(await shown('R')).toEqual([]);

      // The re-plan job the same way: without T3, then a re-plan with T3 L1 again.
      seedDay();
      version('P', held);
      const first = await replanJob('P', t2only);
      expect(tripsOf(first.runId)).toEqual({ 'T2:1': 'ALI', 'T2:2': 'ALI' });
      expect(first.res.driverChanges).toEqual([bobGone]);
      expect(auditedNotes()).toEqual([bobAudited]);
      expect(await shown(first.runId)).toEqual([bobText]);
      const second = await replanJob(first.runId, t2t3);
      expect(row('runPlan', second.runId).summaryJson.driverChanges).toBeUndefined(); // the copied summary's note is replaced
      expect(tripsOf(second.runId)).toEqual({ 'T2:1': 'ALI', 'T3:1': 'SAM' });
      expect(second.res.driverChanges).toEqual([]);
      expect(auditedNotes()).toBeUndefined();
      expect(await shown(second.runId)).toEqual([]);
    });
  }

  it('the plan screen (getPlanDetail, and so the Excel workbook) lists a note until the dispatcher sets that trip\'s driver: Keep, or another driver', async () => {
    for (const pick of ['SAM', 'BOB']) {
      seedDay();
      version('R', [{ truck: 'T2', at: [570, 660], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [720, 840], order: 'O3', driver: 'ALI' }]);
      await useInstead('R', [{ truck: 'T2', at: [570, 660], order: 'O2' }, { truck: 'T3', at: [600, 720], order: 'O3' }]);
      const t3 = loadOf('R', 'T3');
      expect(t3).toMatchObject({ driverId: 'SAM', driverSetAt: null });
      let detail = (await getPlanDetail(T, 'R'))!;
      expect(detail.loads.find((l) => l.truckId === 'T3')!.driverHandSet).toBe(false);
      expect(detail.warnings).toContain('Driver changed by this plan: T03 · L1 (10:00–12:00) Ali → Sam, because Ali is on T02 · L1 at that time.');
      await updateLoad(T, 'R', t3.id, { driverId: pick }, user, allow); // SAM: Keep; BOB: another driver
      expect(loadOf('R', 'T3')).toMatchObject({ driverId: pick, driverSetById: 'u1' });
      detail = (await getPlanDetail(T, 'R'))!;
      expect(detail.loads.find((l) => l.truckId === 'T3')!.driverHandSet).toBe(true);
      expect(detail.warnings.filter((w) => w.startsWith('Driver '))).toEqual([]);
      expect(row('runPlan', 'R').summaryJson.driverChanges).toHaveLength(1); // still stored: the rows decide what is shown
    }
  });

  it('a note that left a trip without a driver stays until the dispatcher picks a driver for it ("No driver" alone changes nothing); Bob, then "No driver", does not bring it back', async () => {
    // T2 L1 Ali filled in 12:00-14:00, moved to 10:00-12:00 onto T3 L1, Ali by hand: T2 L1 gets no driver (Ali is its default too).
    seedDay();
    version('R', [{ truck: 'T2', at: [720, 840], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [570, 660], order: 'O3', driver: 'ALI', hand: true }]);
    await useInstead('R', [{ truck: 'T2', at: [600, 720], order: 'O2' }, { truck: 'T3', at: [570, 660], order: 'O3' }]);
    const text = 'Driver changed by this plan: T02 · L1 (10:00–12:00) Ali → no driver, because Ali is on T03 · L1 at that time.';
    expect(tripsOf('R')).toEqual({ 'T2:1': 'none', 'T3:1': 'ALI (by hand: u1)' });
    expect(await shown('R')).toEqual([text]);
    const t2 = loadOf('R', 'T2').id;
    // "No driver" on the trip that has none: the Driver list sends nothing (it is already selected),
    // and sent anyway it changes nothing - no marker, the note stays until a driver is picked.
    const audits = tables.auditLog.length;
    await updateLoad(T, 'R', t2, { driverId: null }, user, allow);
    expect(row('planLoad', t2)).toMatchObject({ driverId: null, driverSetById: null, driverSetAt: null });
    expect(tables.auditLog.length).toBe(audits);
    expect(await shown('R')).toEqual([text]);
    await updateLoad(T, 'R', t2, { driverId: 'BOB' }, user, allow);
    expect(await shown('R')).toEqual([]);
    await updateLoad(T, 'R', t2, { driverId: null }, user, allow);
    expect(row('planLoad', t2)).toMatchObject({ driverId: null, driverSetById: 'u1' }); // the dispatcher's "No driver", marked
    const detail = (await getPlanDetail(T, 'R'))!;
    expect(detail.loads.find((l) => l.id === t2)!.driverHandSet).toBe(false); // no driver: never "picked by hand"
    expect(detail.warnings.filter((w) => w.startsWith('Driver '))).toEqual([]);
    // The next plan fills that trip in like any other (it had no driver): no note, no marker.
    const next = await useInstead('R', [{ truck: 'T2', at: [480, 560], order: 'O2' }, { truck: 'T3', at: [570, 660], order: 'O3' }]);
    expect(tripsOf('R')).toEqual({ 'T2:1': 'ALI', 'T3:1': 'ALI (by hand: u1)' });
    expect(next.res.driverChanges).toEqual([]);
  });

  it('an apply without notes replaces the notes stored before, the copied ones of a re-plan too: a trip that keeps its filled-in driver is no note', async () => {
    // T3 L1 Ali filled in 12:00-14:00 moves to 10:00-12:00, onto T2 L1 Ali: Sam, T3's default (CLASH note).
    // The same plan again: T3 L1 keeps Sam, its own driver now - no note, and the old one is gone.
    const held: Held[] = [{ truck: 'T2', at: [570, 660], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [720, 840], order: 'O3', driver: 'ALI' }];
    const trips: Trip[] = [{ truck: 'T2', at: [570, 660], order: 'O2' }, { truck: 'T3', at: [600, 720], order: 'O3' }];
    const text = 'Driver changed by this plan: T03 · L1 (10:00–12:00) Ali → Sam, because Ali is on T02 · L1 at that time.';
    const noteGone = async (runId: string, res: { driverChanges: unknown[] }) => {
      expect(tripsOf(runId)).toEqual({ 'T2:1': 'ALI', 'T3:1': 'SAM' });
      expect(res.driverChanges).toEqual([]);
      expect(auditedNotes()).toBeUndefined();
      expect(row('runPlan', runId).summaryJson.driverChanges).toBeUndefined();
      expect(await shown(runId)).toEqual([]);
    };
    seedDay();
    version('R', held);
    await useInstead('R', trips);
    expect(await shown('R')).toEqual([text]);
    const again = await useInstead('R', trips);
    await noteGone('R', again.res);

    seedDay();
    version('P', held);
    const first = await replanJob('P', trips);
    expect(await shown(first.runId)).toEqual([text]);
    const { child } = await createNextVersion(T, first.runId, 'LATE_ORDER', null, APPLIER);
    expect(await shown(child.id)).toEqual([text]); // the copy shows the previous version's note while it is in use
    const second = await jobApplies(child.id, trips);
    await noteGone(child.id, second.res);
  });

  it("the first optimization of a day is unaffected: the trucks' default drivers, no marker, no note", async () => {
    seedDay();
    version('R', [{ truck: 'T2', at: [570, 660], order: 'O2' }, { truck: 'T3', at: [600, 720], order: 'O3' }]);
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

  it('the first optimization of a day: two trucks with the same default driver at overlapping times - the trip the optimizer lists first gets the driver (it lists by truck code), the other none', async () => {
    const trips: Trip[] = [{ truck: 'T2', at: [570, 660], order: 'O2' }, { truck: 'T3', at: [600, 720], order: 'O3' }];
    for (const [listed, expected] of [
      [trips, { 'T2:1': 'ALI', 'T3:1': 'none' }],
      [[...trips].reverse(), { 'T2:1': 'none', 'T3:1': 'ALI' }],
    ] as const) {
      seedDay();
      row('truck', 'T3').defaultDriverId = 'ALI';
      version('R', [...listed]);
      Object.assign(row('runPlan', 'R'), { status: 'DRAFT', chosenScenarioId: null });
      tables.planLoad = [];
      tables.routeAssignment = [];
      const res = await chooseScenario(T, 'R', 'R-rec', APPLIER);
      expect(tripsOf('R')).toEqual(expected);
      expect(res.driverChanges).toEqual([]);
    }
  });

  it('a summary saved with parkedDrivers (before the simplified rules) is ignored: nothing comes back from it, and the next refresh drops it', async () => {
    const parked = [{ truckId: 'T3', loadNo: 1, driverId: 'BOB', departMin: 480, returnMin: 600, driverSetById: 'u1', driverSetAt: HAND_AT.toISOString(), runId: 'R' }];
    // "Use instead" on the version itself.
    seedDay();
    version('R', [{ truck: 'T2', at: [480, 600], order: 'O2', driver: 'ALI' }]);
    row('runPlan', 'R').summaryJson = { ordersServed: 1, parkedDrivers: parked };
    await updateLoad(T, 'R', 'R-T2-1', { status: 'LOCKED' }, user, allow); // a load change refreshes the facts
    expect(row('runPlan', 'R').summaryJson).not.toHaveProperty('parkedDrivers');
    await updateLoad(T, 'R', 'R-T2-1', { status: 'PLANNED' }, user, allow);
    row('runPlan', 'R').summaryJson = { ordersServed: 1, parkedDrivers: parked };
    const res = await useInstead('R', [{ truck: 'T2', at: [480, 600], order: 'O2' }, { truck: 'T3', at: [480, 600], order: 'O3' }]);
    expect(tripsOf('R')).toEqual({ 'T2:1': 'ALI', 'T3:1': 'SAM' });
    expect(res.res.driverChanges).toEqual([]);
    expect(row('runPlan', 'R').summaryJson).not.toHaveProperty('parkedDrivers');
    // A re-plan's version copies the summary: its job ignores the list too.
    seedDay();
    version('P', [{ truck: 'T2', at: [480, 600], order: 'O2', driver: 'ALI' }]);
    row('runPlan', 'P').summaryJson = { ordersServed: 1, parkedDrivers: parked };
    const job = await replanJob('P', [{ truck: 'T2', at: [480, 600], order: 'O2' }, { truck: 'T3', at: [480, 600], order: 'O3' }]);
    expect(tripsOf(job.runId)).toEqual({ 'T2:1': 'ALI', 'T3:1': 'SAM' });
    expect(job.res.driverChanges).toEqual([]);
    expect(row('runPlan', job.runId).summaryJson).not.toHaveProperty('parkedDrivers');
  });

  it('the job message counts the driver notes', async () => {
    seedDay();
    version('P', [{ truck: 'T2', at: [480, 600], order: 'O2', driver: 'ALI' }, { truck: 'T3', at: [480, 600], order: 'O3', driver: 'BOB', hand: true }]);
    const childId = (await createNextVersion(T, 'P', 'LATE_ORDER', null, 'u1')).child.id;
    Object.assign(row('runPlan', childId), { status: 'OPTIMIZING', currentJobId: 'J9' });
    tables.runJob.push({ id: 'J9', runId: childId, tenantId: T, attemptNo: 1, status: 'QUEUED' });
    const t2only: Trip[] = [{ truck: 'T2', at: [480, 600], order: 'O2' }, { truck: 'T2', loadNo: 2, at: [620, 740], order: 'O3' }];
    // The optimizer checked its own timetable (PR4), so the message carries no timing note.
    const plan = {
      ...scenarioDetails({ scope: undefined, loads: solverOf(t2only), trips: 2, trucks_used: 1 }),
      unserved: [],
      feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
    };
    solver.impl = async () => ({ engine: 'OR-Tools', matrix_provider: 'HAVERSINE', distance_is_estimated: true, warnings: [], scenarios: [plan] });
    const built = { request: { stops: [{ stop_id: 's' }], trucks: [{ id: 'T2' }] }, preDrops: [], scope: sc(t2only), blocking: [], warnings: [], unknownWeights: [], weightChanges: { lines: [], orders: [] } };
    scheduleDispatchOptimize({ runId: childId, runJobId: 'J9', tenantId: T, userId: 'u1', ip: null, built: built as never });
    await (globalThis as unknown as { __routeiqInflight: Map<string, Promise<void>> }).__routeiqInflight.get(childId);
    expect(row('runJob', 'J9')).toMatchObject({ status: 'SUCCEEDED', message: '2 loads on 1 trucks, 0 stop(s) unserved, 1 driver note(s) (see the plan)' });
    expect(row('runPlan', childId).summaryJson.driverChanges.map((c: { reason: string }) => c.reason)).toEqual(['TRIP_GONE']);
  });

  it('the job message counts the kept loads and their trucks, also a truck no longer in the request (PR7, B3)', async () => {
    seedDay();
    version('P', [{ truck: 'T2', at: [480, 600], order: 'O2' }, { truck: 'T3', at: [360, 470], order: 'O3' }]);
    loadOf('P', 'T3').status = 'DISPATCHED';
    const childId = (await createNextVersion(T, 'P', 'LATE_ORDER', null, 'u1')).child.id;
    const kept = loadOf(childId, 'T3');
    expect(kept.status).toBe('DISPATCHED');
    Object.assign(row('runPlan', childId), { status: 'OPTIMIZING', currentJobId: 'J9' });
    tables.runJob.push({ id: 'J9', runId: childId, tenantId: T, attemptNo: 1, status: 'QUEUED' });
    const t2only: Trip[] = [{ truck: 'T2', at: [480, 600], order: 'O2' }];
    // As an optimizer before PR7 counted it: 1 truck (T2). T3 was deactivated after its load went
    // out, so it is not in the request either; the day still used it.
    const plan = {
      ...scenarioDetails({ scope: undefined, loads: solverOf(t2only), trips: 1, trucks_used: 1 }),
      unserved: [],
      feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
    };
    solver.impl = async () => ({ engine: 'OR-Tools', matrix_provider: 'HAVERSINE', distance_is_estimated: true, warnings: [], scenarios: [plan] });
    const scopeKept = { ...sc(t2only), frozenOrderIds: ['O3'], frozenLoadIds: [kept.id], frozenLoadOrderIds: ['O3'] };
    const built = { request: { stops: [{ stop_id: 's' }], trucks: [{ id: 'T2' }] }, preDrops: [], scope: scopeKept, blocking: [], warnings: [], unknownWeights: [], weightChanges: { lines: [], orders: [] } };
    scheduleDispatchOptimize({ runId: childId, runJobId: 'J9', tenantId: T, userId: 'u1', ip: null, built: built as never });
    await (globalThis as unknown as { __routeiqInflight: Map<string, Promise<void>> }).__routeiqInflight.get(childId);
    expect(row('runJob', 'J9')).toMatchObject({ status: 'SUCCEEDED', message: '1 new loads + 1 kept (locked or dispatched) on 2 trucks, 0 stop(s) unserved' });
  });

  it('applyScenario reads the times and the hand-set marker with the drivers (the fake database ignores `select`)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../lib/dispatch/plan-service.ts'), 'utf8');
    const sel = /const driverSel = \{([^}]*)\} as const;/.exec(src)?.[1] ?? '';
    for (const col of ['truckId', 'loadNo', 'status', 'driverId', 'departMin', 'returnMin', 'driverSetById', 'driverSetAt']) expect(sel).toContain(`${col}: true`);
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

describe('owner decision 1 Oct 2026, item 3: location and delivery window before loading (Settings switch)', () => {
  // The customer of O1 (on LOCKED L1) and O2 (on PLANNED L2): a usable point, no confirmed hours.
  const customerNow = (over: Record<string, unknown> = {}) => {
    tables.customer = [{ id: 'c', tenantId: T, code: 'C1', branchCode: null, name: 'Corner Shop', lat: 23.6111, lng: 58.4111, locationVerified: false, geocodeConfidence: 'HIGH', windowConfirmedAt: null, ...over }];
  };
  const gate = (on: boolean) => {
    tables.tenantConfig = [{ id: 'cfg', tenantId: T, requireDataBeforeLoading: on, serviceAreaJson: null }];
  };
  // The stop as the plan made at 20:00 UTC on 30 Sep kept it (a RouteAssignment's stopSnapshotJson).
  const plannedStop = (over: Record<string, unknown> = {}) => ({
    v: 1, customerId: 'c', code: 'C1', branchCode: null, name: 'Corner Shop', customerType: null, address: null, accessNotes: null,
    lat: 23.6111, lng: 58.4111, hardStartMin: null, hardEndMin: null, prefStartMin: null, prefEndMin: null, serviceMin: 10, priority: 3,
    source: 'PLAN', capturedAt: '2026-09-30T20:00:00.000Z', ...over,
  });

  it('off (the default): a customer without confirmed hours is locked and dispatched as before', async () => {
    seedAppliedPlan();
    customerNow();
    gate(false);
    await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
    await updateLoad(T, 'P', 'L1', { status: 'DISPATCHED' }, user, allow);
    expect([row('planLoad', 'L1').status, row('planLoad', 'L2').status]).toEqual(['DISPATCHED', 'LOCKED']);
  });

  it('on: LOCK of a planned load is refused (409 DATA_REQUIRED) with each customer, what it misses, the rule and the remedy; nothing changes', async () => {
    seedAppliedPlan();
    customerNow();
    gate(true);
    const lock = await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow).catch((e) => e);
    expect(lock).toBeInstanceOf(PlanError);
    expect(lock).toMatchObject({ status: 409, details: { code: 'DATA_REQUIRED', customerIds: ['c'], customers: [{ code: 'C1', branchCode: null, name: 'Corner Shop', missing: 'delivery window' }] } });
    expect(lock.message).toBe(`T01 L2: 1 customer on this load misses data needed before loading - C1 (Corner Shop): no delivery window. ${DATA_GATE_RULE} Delivery window: ${windowGateRemedy()}`);
    expect(row('planLoad', 'L2').status).toBe('PLANNED');
    expect(tables.auditLog).toEqual([]);
  });

  it('on: a load already locked (or loading) is never blocked by the rule switched on later: it goes to LOADING and out', async () => {
    seedAppliedPlan();
    customerNow();
    gate(true);
    await updateLoad(T, 'P', 'L1', { status: 'LOADING' }, user, allow);
    expect(row('planLoad', 'L1').status).toBe('LOADING');
    await updateLoad(T, 'P', 'L1', { status: 'DISPATCHED' }, user, allow);
    expect(row('planLoad', 'L1').status).toBe('DISPATCHED');
  });

  it('on: own confirmed hours (or open all day) let the load go; so does a delivery time the stop was planned with', async () => {
    seedAppliedPlan();
    gate(true);
    customerNow({ windowConfirmedAt: new Date('2026-09-30T08:00:00Z') });
    await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'L2').status).toBe('LOCKED');

    // The stop of O2 was planned "Promised 10:00-11:00" (StopFacts.promised): covered, even when the
    // part on this load holds only an order without a time of its own (a split customer).
    seedAppliedPlan();
    gate(true);
    customerNow();
    row('routeAssignment', 'A2').stopSnapshotJson = plannedStop({ promised: { startMin: 600, endMin: 660, reason: 'PROMISED', note: null } });
    await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'L2').status).toBe('LOCKED');
  });

  it('a delivery time set after the plan was made: LOCK is refused until a RE-PLAN (also with the rule off); one set before planning is what the stop was planned with', async () => {
    for (const on of [true, false]) {
      seedAppliedPlan();
      gate(on);
      customerNow();
      row('routeAssignment', 'A2').stopSnapshotJson = plannedStop();
      Object.assign(row('order', 'O2'), { deliveryStartMin: 600, deliveryEndMin: 660, deliveryTimeSetAt: new Date('2026-09-30T21:00:00Z') });
      const e = await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow).catch((x) => x);
      expect(e, `rule ${on ? 'on' : 'off'}`).toMatchObject({ status: 409, details: { code: 'DELIVERY_TIME_CHANGED', orderIds: ['O2'] } });
      expect(e.message).toMatch(/^T01 L2: the delivery time of 1 order was set or changed after this plan was made \(C1 \(Corner Shop\)\)\. RE-PLAN first/);
      expect(row('planLoad', 'L2').status).toBe('PLANNED');
    }
    // Set before the plan was made, and the stop was planned with it: locked.
    seedAppliedPlan();
    gate(true);
    customerNow();
    row('routeAssignment', 'A2').stopSnapshotJson = plannedStop({ promised: { startMin: 600, endMin: 660, reason: 'PROMISED', note: null } });
    Object.assign(row('order', 'O2'), { deliveryStartMin: 600, deliveryEndMin: 660, deliveryTimeSetAt: new Date('2026-09-30T19:00:00Z') });
    await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'L2').status).toBe('LOCKED');
  });

  // Data collection review: one visit per customer, so the RE-PLAN-first check looks at every order of
  // the day of each customer on the load (a split customer's other part, an order left unserved), and
  // judges what the stop would be planned with now - not only that a time was saved.
  it("a split customer: a delivery time set after planning on its order elsewhere (on another load or left unserved) refuses LOCK of this load too", async () => {
    seedAppliedPlan();
    gate(false);
    customerNow();
    row('routeAssignment', 'A2').stopSnapshotJson = plannedStop();
    // O3: the same customer, the same day and depot, left unserved by this plan.
    Object.assign(row('order', 'O3'), {
      depotId: 'D1', deliveryDate: DAY, carriedToOrderId: null, deliveryStartMin: 600, deliveryEndMin: 660, deliveryTimeReason: 'PROMISED', deliveryTimeSetAt: new Date('2026-09-30T21:00:00Z'),
    });
    const e = await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow).catch((x) => x);
    expect(e).toMatchObject({ status: 409, details: { code: 'DELIVERY_TIME_CHANGED', orderIds: ['O3'] } });
    expect(e.message).toMatch(/^T01 L2: the delivery time of 1 order was set or changed after this plan was made \(C1 \(Corner Shop\)\)\. RE-PLAN first/);
    expect(row('planLoad', 'L2').status).toBe('PLANNED');
  });

  it('the plan screen and the driver outputs: a part of a split customer holding no timed order is not "changed after planning" (one visit, one time)', async () => {
    // O1 (on L1, locked after planning) was given "Promised 06:00-07:00" before planning; the plan gave
    // every part of the customer that time, also the part on L2 holding only O2 (no time of its own).
    seedAppliedPlan();
    const promised = { startMin: 360, endMin: 420, reason: 'PROMISED', note: null };
    row('routeAssignment', 'A1').stopSnapshotJson = plannedStop({ hardStartMin: 360, hardEndMin: 420, promised });
    row('routeAssignment', 'A2').stopSnapshotJson = plannedStop({ hardStartMin: 360, hardEndMin: 420, promised });
    Object.assign(row('order', 'O1'), { deliveryStartMin: 360, deliveryEndMin: 420, deliveryTimeReason: 'PROMISED' });
    const hoursOf = async () => {
      const d = (await getPlanDetail(T, 'P'))!;
      return d.loads.map((l) => l.stops.flatMap((s) => s.masterChanged.filter((c) => c.kind === 'HOURS').map((c) => c.text)));
    };
    expect(await hoursOf()).toEqual([[], []]);
    // The timed order left unserved, the untimed one planned with its time: not changed either.
    seedAppliedPlan();
    row('routeAssignment', 'A2').stopSnapshotJson = plannedStop({ hardStartMin: 360, hardEndMin: 420, promised });
    Object.assign(row('order', 'O3'), { deliveryStartMin: 360, deliveryEndMin: 420, deliveryTimeReason: 'PROMISED' });
    expect((await hoursOf())[1]).toEqual([]);
    // The time removed from O3 since: the part on L2 now says so.
    row('order', 'O3').deliveryStartMin = null;
    row('order', 'O3').deliveryEndMin = null;
    expect((await hoursOf())[1]).toEqual([expect.stringMatching(/^Delivery time changed after planning: now receives .* \(planned with Promised 06:00–07:00\)$/)]);
  });

  it('a delivery time set and then removed after planning, or saved again as the stop was planned: nothing to re-plan, LOCK goes through', async () => {
    // Set at 21:00 after the 20:00 plan, then removed: the order is as planned (no time).
    seedAppliedPlan();
    gate(false);
    customerNow();
    row('routeAssignment', 'A2').stopSnapshotJson = plannedStop();
    Object.assign(row('order', 'O2'), { deliveryStartMin: null, deliveryEndMin: null, deliveryTimeReason: null, deliveryTimeSetAt: new Date('2026-09-30T21:00:00Z') });
    await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'L2').status).toBe('LOCKED');
    // Planned "Promised 06:00-07:00" (served at 06:40), the same time saved again later (another reason): as planned.
    seedAppliedPlan();
    gate(false);
    customerNow();
    row('routeAssignment', 'A2').stopSnapshotJson = plannedStop({ hardStartMin: 360, hardEndMin: 420, promised: { startMin: 360, endMin: 420, reason: 'PROMISED', note: null } });
    Object.assign(row('order', 'O2'), { deliveryStartMin: 360, deliveryEndMin: 420, deliveryTimeReason: 'URGENT', deliveryTimeSetAt: new Date('2026-09-30T21:00:00Z') });
    await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'L2').status).toBe('LOCKED');
  });

  it('on: confirmed hours that are not the hours the stop was planned with (a default, or hours changed since): LOCK refused, RE-PLAN first', async () => {
    // The stop is served at 06:40 (the fixture's ETA), inside every planned window below.
    const confirmed = { hardWindowStartMin: 360, hardWindowEndMin: 720, prefWindowStartMin: null, prefWindowEndMin: null, windowConfirmedAt: new Date('2026-09-30T21:00:00Z') };
    // Planned with the customer-type default 06:00-18:00; the dispatcher then confirmed 06:00-12:00.
    seedAppliedPlan();
    gate(true);
    customerNow(confirmed);
    row('routeAssignment', 'A2').stopSnapshotJson = plannedStop({ hardStartMin: 360, hardEndMin: 1080 });
    const e = await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow).catch((x) => x);
    expect(e).toMatchObject({ status: 409, details: { code: 'HOURS_CHANGED', customerIds: ['c'] } });
    expect(e.message).toBe(
      `T01 L2: 1 customer on this load has confirmed receiving hours that its stop was not planned with - C1 (Corner Shop): planned with hard 06:00–18:00, confirmed hard 06:00–12:00. ${DATA_GATE_RULE} RE-PLAN first, so the stop is planned with the confirmed hours. Then lock the load.`,
    );
    expect(row('planLoad', 'L2').status).toBe('PLANNED');
    // Planned with the hours confirmed now: locked.
    seedAppliedPlan();
    gate(true);
    customerNow(confirmed);
    row('routeAssignment', 'A2').stopSnapshotJson = plannedStop({ hardStartMin: 360, hardEndMin: 720 });
    await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'L2').status).toBe('LOCKED');
    // Open all day (confirmed, no hours), planned as any time: locked; planned with a default: refused.
    for (const [snap, ok] of [[plannedStop(), true], [plannedStop({ hardStartMin: 360, hardEndMin: 1080 }), false]] as const) {
      seedAppliedPlan();
      gate(true);
      customerNow({ windowConfirmedAt: new Date('2026-09-30T21:00:00Z') });
      row('routeAssignment', 'A2').stopSnapshotJson = snap;
      const r = await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow).catch((x) => x);
      if (ok) expect(row('planLoad', 'L2').status).toBe('LOCKED');
      else expect(r).toMatchObject({ status: 409, details: { code: 'HOURS_CHANGED' } });
    }
    // The rule off: not checked (the day screen says the plan is out of date).
    seedAppliedPlan();
    gate(false);
    customerNow(confirmed);
    row('routeAssignment', 'A2').stopSnapshotJson = plannedStop({ hardStartMin: 360, hardEndMin: 1080 });
    await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow);
    expect(row('planLoad', 'L2').status).toBe('LOCKED');
  });

  it('on: a customer missing both is listed with both and the location remedy; one missing only a location is refused by the location rule as before', async () => {
    seedAppliedPlan();
    gate(true);
    customerNow({ lat: null, lng: null, geocodeConfidence: 'MISSING' });
    const both = await updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow).catch((e) => e);
    expect(both).toMatchObject({ status: 409, details: { code: 'DATA_REQUIRED', customers: [{ missing: 'location and delivery window' }] } });
    expect(both.message).toContain(`C1 (Corner Shop): no location and delivery window. ${DATA_GATE_RULE} Delivery window: ${windowGateRemedy()} Location: ${noLocationLoadRemedy('PLANNED')}`);
    customerNow({ lat: null, lng: null, geocodeConfidence: 'MISSING', windowConfirmedAt: new Date() });
    await expect(updateLoad(T, 'P', 'L2', { status: 'LOCKED' }, user, allow)).rejects.toMatchObject({ status: 409, details: { code: 'LOCATION_REQUIRED' } });
  });
});
