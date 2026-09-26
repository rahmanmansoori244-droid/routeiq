/**
 * Stabilization PR3 (review F16) - route wiring of the shared solve admission: every solve entry
 * (POST /api/dispatch/plan with optimize, POST /api/runs/:id/replan, POST /api/runs/:id/optimize)
 * answers 429 with Retry-After when admission refuses, and leaves no RunJob and no new version.
 * The legacy per-tenant limiter of /runs/:id/optimize is gone: a no-op answer uses no quota.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';

const { auth } = vi.hoisted(() => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'P', email: 'p@a.example' } }),
}));
vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>, tx?: Record<string, any>) => (tx ?? m.fakePrisma).auditLog.create({ data: { ...input } })) };
});
vi.mock('@/lib/jobs/dispatch-job', () => ({ scheduleDispatchOptimize: vi.fn(() => true) }));
vi.mock('@/lib/solver-client', () => ({ SolverError: class extends Error {}, callDispatchSolver: vi.fn() }));
vi.mock('@/lib/dispatch/plan-service', async (orig) => {
  const real = await orig<typeof import('@/lib/dispatch/plan-service')>();
  const m = await import('./fake-plan-db');
  return {
    ...real,
    buildDispatchRequest: vi.fn(async (_t: string, runId: string) => ({
      request: { stops: [{ stop_id: 's' }], trucks: [{ id: 'T1', capacity_kg: 0 }] },
      preDrops: [],
      scope: {
        orderIds: ['O2'],
        frozenOrderIds: [],
        orderPriority: {},
        frozenLoadIds: (m.tables.planLoad ?? []).filter((l) => l.runId === runId && l.status !== 'PLANNED').map((l) => l.id),
        frozenLoadOrderIds: [],
      },
      blocking: [],
      warnings: [],
      unknownWeights: [],
      weightChanges: { lines: [], orders: [] },
    })),
    isLegacyPlan: vi.fn(async () => false),
    pendingLateOrderIds: vi.fn(async () => []),
  };
});

import { solveAdmission } from '@/lib/dispatch/solve-admission';
import { POST as planPost } from '@/app/api/dispatch/plan/route';
import { POST as replanPost } from '@/app/api/runs/[id]/replan/route';
import { POST as optimizePost } from '@/app/api/runs/[id]/optimize/route';

const DAY = new Date('2026-09-27T00:00:00.000Z');

function seed(status: 'DRAFT' | 'READY') {
  tables.depot = [{ id: 'D1', tenantId: 'tA', code: 'D1', name: 'Depot', active: true }];
  tables.order = [{ id: 'O2', tenantId: 'tA', customerId: 'c', totalCases: 5, totalWeightKg: 50 }];
  tables.runPlan = [
    { id: 'P', tenantId: 'tA', depotId: 'D1', runDate: DAY, status, version: 1, reason: 'INITIAL', optimizationMode: 'BALANCED', chosenScenarioId: status === 'READY' ? 'sc1' : null, parentRunId: null, supersededAt: null, currentJobId: null, finalizedAt: null, totalOrders: 1, unservedCount: 0, summaryJson: null, reconciliationJson: null, changeSummaryJson: null, createdById: 'u1' },
  ];
  tables.planLoad = [];
  tables.routeAssignment = [];
  tables.scenarioResult = status === 'READY' ? [{ id: 'sc1', runId: 'P', name: 'RECOMMENDED', detailsJson: { name: 'RECOMMENDED', loads: [], scope: { orderIds: ['O2'], frozenOrderIds: [], orderPriority: {} } } }] : [];
  tables.unservedOrder = [];
  tables.runJob = [];
  tables.auditLog = [];
}

const post = (url: string, body: unknown) => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  resetDb();
  vi.restoreAllMocks();
  vi.spyOn(solveAdmission, 'reserve').mockReturnValue({ ok: false, status: 429, code: 'SOLVE_QUOTA_TENANT', error: 'Your company started 30 optimizations in the last hour.', retryAfterSec: 300 });
});

async function expect429(res: Response) {
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe('300');
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('SOLVE_QUOTA_TENANT');
  expect(tables.runJob).toHaveLength(0);
  expect(tables.runPlan).toHaveLength(1);
  expect(tables.runPlan[0]!.status).not.toBe('OPTIMIZING');
}

describe('solve admission on every solve entry (F16)', () => {
  it('POST /api/dispatch/plan with optimize', async () => {
    seed('DRAFT');
    await expect429(await planPost(post('http://t/api/dispatch/plan', { date: '2026-09-27', depotId: 'D1', optimize: true })));
  });

  it('POST /api/runs/:id/replan (no child version is created)', async () => {
    seed('READY');
    await expect429(await replanPost(post('http://t/api/runs/P/replan', { reason: 'REOPTIMIZE' }), { params: { id: 'P' } }));
  });

  it('POST /api/runs/:id/optimize', async () => {
    seed('DRAFT');
    await expect429(await optimizePost(post('http://t/api/runs/P/optimize', {}), { params: { id: 'P' } }));
  });

  it('a no-op answer (already running) does not ask for admission', async () => {
    seed('DRAFT');
    tables.runJob = [{ id: 'J1', runId: 'P', tenantId: 'tA', attemptNo: 1, status: 'RUNNING' }];
    const res = await optimizePost(post('http://t/api/runs/P/optimize', {}), { params: { id: 'P' } });
    expect(res.status).toBe(202);
    expect(solveAdmission.reserve).not.toHaveBeenCalled();
  });

  it('POST /api/dispatch/plan refuses a date or depot that differs from the screen (409 DAY_MISMATCH)', async () => {
    seed('DRAFT');
    const res = await planPost(post('http://t/api/dispatch/plan', { date: '2026-09-27', depotId: 'D1', optimize: true, expect: { date: '2026-09-28', depotId: 'D1' } }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('DAY_MISMATCH');
  });
});
