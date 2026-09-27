/**
 * Stabilization PR3 - starting an optimization and re-planning (lib/dispatch/start-optimize.ts), on
 * the in-memory database, with the request builder and the background job faked:
 *
 * - F03: every known reason to refuse a re-plan is checked BEFORE the new version exists (nothing
 *   to plan, no truck, a job running, the solve admission); a refused re-plan leaves the parent
 *   as it was. The misleading "Upload orders first" is only said when there are no orders.
 * - F16: the admission ticket is reserved before the version is created and handed to the start;
 *   a 429 leaves no version and no job.
 * - ADD-JOB-AUDIT / F07: the start (checks under the row lock, RunJob, OPTIMIZING, the
 *   OPTIMIZE_STARTED audit) is one transaction: an audit failure leaves no QUEUED orphan and an
 *   immediate retry starts.
 * - ADD-STALE-DAY-CLIENT: a plan of another day than the screen's answers 409 DAY_MISMATCH.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
const failAudit = { action: null as string | null };
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return {
    audit: vi.fn(async (input: Record<string, unknown>, tx?: Record<string, any>) => {
      if (failAudit.action === input.action) throw new Error('audit insert failed (simulated)');
      return (tx ?? m.fakePrisma).auditLog.create({ data: { ...input } });
    }),
  };
});
vi.mock('@/lib/jobs/dispatch-job', () => ({ scheduleDispatchOptimize: vi.fn(() => true) }));
vi.mock('@/lib/solver-client', () => ({ SolverError: class extends Error {}, callDispatchSolver: vi.fn() }));

/** What buildDispatchRequest returns for a version: its frozen loads from the tables. */
const buildState = { orderIds: ['O2'] as string[], frozenOrderIds: ['O1'] as string[], trucks: 1 };
function builtFor(runId: string) {
  const frozen = (tables.planLoad ?? []).filter((l) => l.runId === runId && l.status !== 'PLANNED');
  return {
    request: { stops: buildState.orderIds.map((id) => ({ stop_id: id })), trucks: Array.from({ length: buildState.trucks }, (_, i) => ({ id: `T${i + 1}`, capacity_kg: 0 })) },
    preDrops: [],
    scope: {
      orderIds: [...buildState.orderIds],
      frozenOrderIds: [...buildState.frozenOrderIds],
      orderPriority: {},
      frozenLoadIds: frozen.map((l) => l.id).sort(),
      frozenLoadOrderIds: [...buildState.frozenOrderIds],
    },
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
    createNextVersion: vi.fn(real.createNextVersion),
  };
});

import { createNextVersion } from '@/lib/dispatch/plan-service';
import { scheduleDispatchOptimize } from '@/lib/jobs/dispatch-job';
import { solveAdmission } from '@/lib/dispatch/solve-admission';
import { replan, startDispatchOptimize } from '@/lib/dispatch/start-optimize';

const T = 'tA';
const user = { id: 'u1' };
const DAY = new Date('2026-09-27T00:00:00Z');

function load(id: string, runId: string, loadNo: number, status: string) {
  return { id, tenantId: T, runId, truckId: 'T1', loadNo, status, driverId: null, departMin: 400, returnMin: 500, distanceKm: 1, durationMin: 60, cases: 10, weightKg: 100, utilizationPct: 10, fuelLitres: null, fuelCost: 0, operatingCost: 0, returnLegKm: 0, distanceIsEstimated: true, carriedFromLoadId: null, statusChangedAt: null, statusChangedById: null, createdAt: new Date() };
}

function seed(opts: { status?: string; chosen?: string | null; supersededAt?: Date | null } = {}) {
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
  tables.order = ['O1', 'O2'].map((id) => ({ id, tenantId: T, customerId: 'c', totalCases: 10, totalWeightKg: 100, status: 'ASSIGNED' }));
  tables.runPlan = [
    {
      id: 'P',
      tenantId: T,
      depotId: 'D1',
      runDate: DAY,
      status: opts.status ?? 'READY',
      version: 1,
      reason: 'INITIAL',
      optimizationMode: 'BALANCED',
      chosenScenarioId: opts.chosen === undefined ? 'sc1' : opts.chosen,
      parentRunId: null,
      supersededAt: opts.supersededAt ?? null,
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
  tables.planLoad = [load('L1', 'P', 1, 'LOCKED'), load('L2', 'P', 2, 'PLANNED')];
  tables.routeAssignment = [];
  tables.scenarioResult = opts.chosen === null ? [] : [{ id: 'sc1', runId: 'P', name: 'RECOMMENDED', trucksUsed: 1, totalDistanceKm: 1, totalTimeMin: 1, totalCost: 1, avgUtilizationPct: 1, unservedCount: 0, detailsJson: { name: 'RECOMMENDED', status: 'OPTIMIZED', loads: [], scope: { orderIds: ['O2'], frozenOrderIds: ['O1'], orderPriority: {}, frozenLoadIds: ['L1'] } }, createdAt: new Date() }];
  tables.unservedOrder = [];
  tables.runJob = [];
  tables.auditLog = [];
}

beforeEach(() => {
  resetDb();
  failAudit.action = null;
  buildState.orderIds = ['O2'];
  buildState.frozenOrderIds = ['O1'];
  buildState.trucks = 1;
  vi.mocked(createNextVersion).mockClear();
  vi.mocked(scheduleDispatchOptimize).mockClear();
  vi.restoreAllMocks();
});

const admissionIdle = () => expect(solveAdmission.snapshot()).toMatchObject({ running: 0, waiting: 0 });

describe('replan preflight (F03): refused before any version exists', () => {
  it('every order already on a frozen load: 409 NOTHING_TO_PLAN, no child, parent unchanged', async () => {
    seed();
    buildState.orderIds = [];
    const reserve = vi.spyOn(solveAdmission, 'reserve');
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTHING_TO_PLAN');
    expect(String(res.body.error)).not.toMatch(/Upload orders first/);
    expect(tables.runPlan).toHaveLength(1);
    expect(row('runPlan', 'P').status).toBe('READY');
    expect(createNextVersion).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('no active truck: 400, no child', async () => {
    seed();
    buildState.trucks = 0;
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null);
    expect(res.status).toBe(400);
    expect(tables.runPlan).toHaveLength(1);
    expect(createNextVersion).not.toHaveBeenCalled();
  });

  it('a job already running for the parent: 409, no child', async () => {
    seed({ status: 'FAILED' });
    tables.runJob = [{ id: 'J0', runId: 'P', tenantId: T, attemptNo: 1, status: 'RUNNING' }];
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null);
    expect(res.status).toBe(409);
    expect(tables.runPlan).toHaveLength(1);
  });

  it('a plan of another day than the screen shows: 409 DAY_MISMATCH, nothing created', async () => {
    seed();
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null, {}, { date: '2026-09-28', depotId: 'D1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DAY_MISMATCH');
    expect(tables.runPlan).toHaveLength(1);
  });

  it('a superseded parent (also when written READY over its supersede): 409, nothing created', async () => {
    seed({ supersededAt: new Date() });
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null);
    expect(res.status).toBe(409);
    expect(tables.runPlan).toHaveLength(1);
  });

  it('solve admission refuses (quota): 429 with Retry-After, no child and no job', async () => {
    seed();
    vi.spyOn(solveAdmission, 'reserve').mockReturnValueOnce({ ok: false, status: 429, code: 'SOLVE_QUOTA_USER', error: 'quota', retryAfterSec: 120 });
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null);
    expect(res.status).toBe(429);
    expect(res.headers).toEqual({ 'Retry-After': '120' });
    expect(tables.runPlan).toHaveLength(1);
    expect(tables.runJob).toHaveLength(0);
    expect(createNextVersion).not.toHaveBeenCalled();
  });
});

describe('replan success: admission first, copy-forward child, one start transaction', () => {
  it('reserves before creating the version, then starts the child (freshVersion) with that ticket', async () => {
    seed();
    const reserve = vi.spyOn(solveAdmission, 'reserve');
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, '10.0.0.1');
    expect(res.status).toBe(202);
    expect(res.body.version).toBe(2);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createNextVersion).mock.invocationCallOrder[0]!);
    const childId = String(res.body.runId);
    const child = row('runPlan', childId);
    expect(child.status).toBe('OPTIMIZING');
    expect(child.chosenScenarioId).toBeTruthy(); // the copied plan stays until the new one is saved
    const job = tables.runJob.find((j) => j.runId === childId)!;
    expect(job.status).toBe('QUEUED');
    expect(child.currentJobId).toBe(job.id);
    expect(tables.auditLog.map((a) => a.action)).toEqual(expect.arrayContaining(['PLAN_VERSION_CREATED', 'OPTIMIZE_STARTED']));
    expect(row('runPlan', 'P').status).toBe('SUPERSEDED');
    // The job got the same ticket; it releases it when it ends (here the job is faked).
    const call = vi.mocked(scheduleDispatchOptimize).mock.calls[0]![0];
    expect(call.runJobId).toBe(job.id);
    expect(call.ticket).toBeTruthy();
    call.ticket!.release();
    admissionIdle();
  });

  it('a child start refused after the version exists still gives the ticket back (previous plan kept)', async () => {
    seed();
    // The child's request is built around other frozen loads than it holds: refused in the start transaction.
    const { buildDispatchRequest } = await import('@/lib/dispatch/plan-service');
    vi.mocked(buildDispatchRequest).mockImplementationOnce(async (_t, runId) => builtFor(runId) as never).mockImplementationOnce(async (_t, runId) => ({ ...builtFor(runId), scope: { ...builtFor(runId).scope, frozenLoadIds: ['somewhere-else'] } }) as never);
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null);
    expect(res.status).toBe(409);
    expect(res.body.previousPlanKept).toBe(true);
    const child = tables.runPlan.find((r) => r.parentRunId === 'P')!;
    expect(child.status).toBe('READY'); // the usable copy of the previous plan
    expect(child.chosenScenarioId).toBeTruthy();
    expect(tables.runJob).toHaveLength(0);
    admissionIdle();
  });
});

describe('startDispatchOptimize: one transaction (ADD-JOB-AUDIT / F07)', () => {
  it('an OPTIMIZE_STARTED audit failure leaves no QUEUED orphan; an immediate retry starts', async () => {
    seed({ status: 'DRAFT', chosen: null });
    failAudit.action = 'OPTIMIZE_STARTED';
    await expect(startDispatchOptimize(T, 'P', user, null)).rejects.toThrow(/audit insert failed/);
    expect(tables.runJob).toHaveLength(0);
    expect(row('runPlan', 'P').status).toBe('DRAFT');
    expect(row('runPlan', 'P').currentJobId).toBeNull();
    admissionIdle();

    failAudit.action = null;
    const res = await startDispatchOptimize(T, 'P', user, null);
    expect(res.status).toBe(202);
    expect(tables.runJob).toHaveLength(1);
    expect(row('runPlan', 'P').status).toBe('OPTIMIZING');
    vi.mocked(scheduleDispatchOptimize).mock.calls[0]![0].ticket!.release();
  });

  it('locks the plan row inside the start transaction (after the intake lock)', async () => {
    seed({ status: 'DRAFT', chosen: null });
    const { rawLog } = await import('./fake-plan-db');
    await startDispatchOptimize(T, 'P', user, null);
    const intake = rawLog.findIndex((s) => /pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)/.test(s));
    const forUpdate = rawLog.findIndex((s) => /FOR UPDATE/.test(s));
    expect(intake).toBeGreaterThanOrEqual(0);
    expect(forUpdate).toBeGreaterThan(intake);
    vi.mocked(scheduleDispatchOptimize).mock.calls[0]![0].ticket!.release();
  });

  it('a version that became OPTIMIZING meanwhile answers 202 with its job and starts nothing', async () => {
    seed({ status: 'DRAFT', chosen: null });
    const { buildDispatchRequest } = await import('@/lib/dispatch/plan-service');
    vi.mocked(buildDispatchRequest).mockImplementationOnce(async (_t, runId) => {
      // Another start commits while this one builds its request.
      Object.assign(row('runPlan', 'P'), { status: 'OPTIMIZING', currentJobId: 'Jother' });
      tables.runJob.push({ id: 'Jother', runId: 'P', tenantId: T, attemptNo: 1, status: 'QUEUED' });
      return builtFor(runId) as never;
    });
    const res = await startDispatchOptimize(T, 'P', user, null);
    expect(res.status).toBe(202);
    expect(res.body.runJobId).toBe('Jother');
    expect(tables.runJob).toHaveLength(1);
    expect(scheduleDispatchOptimize).not.toHaveBeenCalled();
    admissionIdle();
  });

  it('nothing to plan on a version without a plan says to unlock a load; no orders at all says to upload', async () => {
    seed({ status: 'DRAFT', chosen: null });
    buildState.orderIds = [];
    const a = await startDispatchOptimize(T, 'P', user, null);
    expect(a.status).toBe(409);
    expect(a.body.code).toBe('NOTHING_TO_PLAN');
    expect(String(a.body.error)).toMatch(/unlock one load/);
    buildState.frozenOrderIds = [];
    const b = await startDispatchOptimize(T, 'P', user, null);
    expect(b.status).toBe(400);
    expect(String(b.body.error)).toMatch(/Upload orders first/);
    expect(tables.runJob).toHaveLength(0);
  });

  it('an applied version is re-optimized in place only as a fresh re-plan copy that never had a job', async () => {
    seed(); // READY, applied
    expect((await startDispatchOptimize(T, 'P', user, null)).body.code).toBe('NEW_VERSION_REQUIRED');
    const fresh = await startDispatchOptimize(T, 'P', user, null, { freshVersion: true });
    expect(fresh.status).toBe(202);
    vi.mocked(scheduleDispatchOptimize).mock.calls[0]![0].ticket!.release();
    // Once it had a job, freshVersion no longer applies.
    Object.assign(row('runPlan', 'P'), { status: 'READY' });
    for (const j of tables.runJob) j.status = 'SUCCEEDED';
    expect((await startDispatchOptimize(T, 'P', user, null, { freshVersion: true })).body.code).toBe('NEW_VERSION_REQUIRED');
    admissionIdle();
  });
});

describe('review fixes: in-place optimize, advice, weights at the start', () => {
  it('a FAILED version that still holds the copied plan is never re-optimized in place (409 NEW_VERSION_REQUIRED)', async () => {
    seed({ status: 'FAILED' }); // chosen 'sc1': a failed re-plan keeps the previous plan
    tables.runJob = [{ id: 'J1', runId: 'P', tenantId: T, attemptNo: 1, status: 'FAILED' }];
    const res = await startDispatchOptimize(T, 'P', user, null);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NEW_VERSION_REQUIRED');
    expect(tables.runJob).toHaveLength(1);
    expect(row('runPlan', 'P').status).toBe('FAILED');
    admissionIdle();
  });

  it('a FAILED version without an applied plan (a failed first optimize) is optimized again in place', async () => {
    seed({ status: 'FAILED', chosen: null });
    tables.runJob = [{ id: 'J1', runId: 'P', tenantId: T, attemptNo: 1, status: 'FAILED' }];
    const res = await startDispatchOptimize(T, 'P', user, null);
    expect(res.status).toBe(202);
    expect(row('runPlan', 'P').status).toBe('OPTIMIZING');
    vi.mocked(scheduleDispatchOptimize).mock.calls[0]![0].ticket!.release();
    admissionIdle();
  });

  it('nothing to plan with every load already out: no advice to unlock (a dispatched load cannot be)', async () => {
    seed({ status: 'DRAFT', chosen: null });
    for (const l of tables.planLoad) l.status = 'DISPATCHED';
    buildState.orderIds = [];
    const res = await startDispatchOptimize(T, 'P', user, null);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTHING_TO_PLAN');
    expect(String(res.body.error)).not.toMatch(/unlock/i);
    admissionIdle();
  });

  it('weights from the product master are not saved when the optimization starts (only with the applied plan)', async () => {
    seed({ status: 'DRAFT', chosen: null });
    const { buildDispatchRequest } = await import('@/lib/dispatch/plan-service');
    vi.mocked(buildDispatchRequest).mockImplementationOnce(async (_t, runId) => ({
      ...builtFor(runId),
      weightChanges: {
        lines: [{ orderId: 'O2', lineId: 'LN2', cases: 10, beforeKg: 0, afterKg: 150, product: 'W-15' }],
        orders: [{ orderId: 'O2', beforeKg: 100, afterKg: 250 }],
      },
    }) as never);
    const { rawLog } = await import('./fake-plan-db');
    const res = await startDispatchOptimize(T, 'P', user, null);
    expect(res.status).toBe(202);
    expect(rawLog.some((s) => /UPDATE "OrderLine"|UPDATE "Order"/.test(s))).toBe(false);
    expect(tables.auditLog.some((a) => a.action === 'ORDER_WEIGHTS_RESOLVED')).toBe(false);
    // The job gets them, to save with its plan.
    const call = vi.mocked(scheduleDispatchOptimize).mock.calls[0]![0];
    expect(call.built.weightChanges.lines).toHaveLength(1);
    call.ticket!.release();
    admissionIdle();
  });
});

describe('PR9: an order brought forward to a later day while the start was prepared', () => {
  it('an open order of the request carried meanwhile: 409 ORDERS_CHANGED, no job, the plan is not OPTIMIZING', async () => {
    seed({ status: 'DRAFT', chosen: null });
    row('order', 'O2').carriedToOrderId = 'O2-copy';
    const res = await startDispatchOptimize(T, 'P', user, null);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORDERS_CHANGED');
    expect(String(res.body.error)).toMatch(/brought forward to a later day/);
    expect(tables.runJob).toHaveLength(0);
    expect(row('runPlan', 'P').status).toBe('DRAFT');
    admissionIdle();
  });

  it('PR9 review: every open order of the day was brought forward - the re-plan says so, never "every load has left the depot" or "unlock"', async () => {
    seed();
    // The dispatcher unlocked the load holding only a brought-forward order, as the app said, and re-plans:
    // the builder leaves carried orders out, so nothing is left to plan.
    Object.assign(row('order', 'O2'), { carriedToOrderId: 'O2-copy', deliveryDate: DAY, depotId: 'D1' });
    for (const l of tables.planLoad) l.status = l.id === 'L1' ? 'DISPATCHED' : 'PLANNED';
    buildState.orderIds = [];
    const reserve = vi.spyOn(solveAdmission, 'reserve');
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'NOTHING_TO_PLAN', carriedAway: 1 });
    expect(String(res.body.error)).toMatch(/^Nothing left to plan: 1 order\(s\) of this day were brought forward to a later day and are planned there and every other order/);
    expect(String(res.body.error)).toMatch(/nothing needs to be re-planned/);
    expect(String(res.body.error)).not.toMatch(/left the depot|unlock|Upload orders first/i);
    expect(createNextVersion).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('PR9 review: with a locked load still holding an order of the day, the answer adds how to change it (unlock)', async () => {
    seed(); // L1 LOCKED holds O1
    Object.assign(row('order', 'O2'), { carriedToOrderId: 'O2-copy', deliveryDate: DAY, depotId: 'D1' });
    buildState.orderIds = [];
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null);
    expect(res.body).toMatchObject({ code: 'NOTHING_TO_PLAN', carriedAway: 1 });
    expect(String(res.body.error)).toMatch(/To change a locked or loading load, unlock it first\.$/);
  });

  it('PR9 second review: a locked load holding only brought-forward orders was loaded - the answer says to unload it, never "never loaded"', async () => {
    seed(); // L1 LOCKED (loaded at night), L2 PLANNED
    Object.assign(row('order', 'O1'), { carriedToOrderId: 'O1-copy', deliveryDate: DAY, depotId: 'D1' });
    tables.routeAssignment = [{ id: 'A1', runId: 'P', loadId: 'L1', orderId: 'O1' }];
    buildState.orderIds = [];
    const res = await replan(T, 'P', 'REOPTIMIZE', null, user, null);
    expect(res.body).toMatchObject({ code: 'NOTHING_TO_PLAN', carriedAway: 1 });
    expect(String(res.body.error)).toContain(
      "1 locked or loading load(s) hold only brought-forward orders and were loaded: unload those cases back to stock, or tell the warehouse, before the loads of the later day are picked; then put the load back to Planned.",
    );
    expect(String(res.body.error)).not.toMatch(/never loaded/);
  });

  it('PR9 review: a day whose orders were all brought forward is not told to "upload orders first"', async () => {
    seed({ status: 'DRAFT', chosen: null });
    for (const id of ['O1', 'O2']) Object.assign(row('order', id), { carriedToOrderId: `${id}-copy`, deliveryDate: DAY, depotId: 'D1' });
    buildState.orderIds = [];
    buildState.frozenOrderIds = [];
    const res = await startDispatchOptimize(T, 'P', user, null);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'NOTHING_TO_PLAN', carriedAway: 2 });
    expect(String(res.body.error)).not.toMatch(/Upload orders first|every other order/);
    expect(tables.runJob).toHaveLength(0);
    admissionIdle();
  });

  it('an order carried from a locked load stays on that load (history): the start goes ahead', async () => {
    seed({ status: 'DRAFT', chosen: null });
    row('order', 'O1').carriedToOrderId = 'O1-copy';
    const res = await startDispatchOptimize(T, 'P', user, null);
    expect(res.status).toBe(202);
    vi.mocked(scheduleDispatchOptimize).mock.calls[0]![0].ticket!.release();
  });
});
