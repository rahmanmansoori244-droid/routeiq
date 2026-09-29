/**
 * Long searches and the job model (owner request 29 Sep 2026), on the in-memory database:
 * - a start stores the mode on the job (and in the request, with THOROUGH's cap) and reserves its
 *   admission for that mode: THOROUGH by default before the delivery day, QUICK on it;
 * - the heartbeat: a job searching for 20 minutes - in this process or another - is never "lost";
 *   a job whose process is gone is lost 2 minutes after its last heartbeat;
 * - the "Reset stuck plan" refusal says how long the job can still take for its mode;
 * - "Use the best plan found so far" (stop-search): who, when, and what it answers;
 * - shutdown: the jobs of a stopping process fail at once, retryable, with a plain message.
 * The janitor's SQL (5 min after the last heartbeat) is in tests/integration/janitor.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const scheduled = vi.hoisted(() => ({ args: [] as Record<string, any>[] }));
vi.mock('@/lib/jobs/dispatch-job', async (orig) => {
  const real = await orig<typeof import('@/lib/jobs/dispatch-job')>();
  return {
    ...real,
    scheduleDispatchOptimize: vi.fn((args: Record<string, any>) => {
      scheduled.args.push(args);
      return true;
    }),
  };
});
function builtFor() {
  return {
    request: { run_id: 'P', tenant_id: 'tA', stops: [{ stop_id: 'O2' }], trucks: [{ id: 'T1', capacity_kg: 0 }], config: { scenarios: ['RECOMMENDED'] } as Record<string, unknown> },
    preDrops: [],
    scope: { orderIds: ['O2'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] },
    blocking: [],
    warnings: [],
    unknownWeights: [],
    weightChanges: { lines: [], orders: [] },
    settings: { timezone: 'Asia/Muscat' },
  };
}
vi.mock('@/lib/dispatch/plan-service', async (orig) => {
  const real = await orig<typeof import('@/lib/dispatch/plan-service')>();
  return { ...real, buildDispatchRequest: vi.fn(async () => builtFor()), isLegacyPlan: vi.fn(async () => false), pendingLateOrderIds: vi.fn(async () => []) };
});

import { JOB_LOST_AFTER_MS, jobRunningText, lastSignOfLife, resetStuckPlan, stuckPlanState } from '@/lib/dispatch/stuck-plan';
import { trackInflight } from '@/lib/jobs/optimize-job';
import { startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { solveAdmission } from '@/lib/dispatch/solve-admission';
import { stopSearch } from '@/lib/dispatch/stop-search';
import { activeDispatchJobs } from '@/lib/jobs/dispatch-job';
import { failJobsForShutdown, installShutdownHandler, SHUTDOWN_MESSAGE } from '@/lib/jobs/shutdown';

const T = 'tA';
const NOW = new Date('2026-09-29T15:00:00Z'); // 19:00 in Muscat
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function seed(runDate: string, job?: { status: string; startedAt?: Date | null; heartbeatAt?: Date | null; searchMode?: string | null; createdAt?: Date }) {
  resetDb();
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true }];
  tables.order = [{ id: 'O2', tenantId: T, customerId: 'c', totalCases: 10, totalWeightKg: 100, status: 'OPEN' }];
  tables.runPlan = [
    {
      id: 'P',
      tenantId: T,
      depotId: 'D1',
      runDate: new Date(`${runDate}T00:00:00Z`),
      status: job ? 'OPTIMIZING' : 'DRAFT',
      version: 1,
      reason: 'INITIAL',
      chosenScenarioId: null,
      parentRunId: null,
      supersededAt: null,
      currentJobId: job ? 'J1' : null,
      createdById: 'u-creator',
      createdAt: ago(60 * 60_000),
    },
  ];
  tables.planLoad = [];
  tables.runJob = job
    ? [{ id: 'J1', tenantId: T, runId: 'P', attemptNo: 1, createdById: 'u1', createdAt: job.createdAt ?? ago(25 * 60_000), startedAt: null, heartbeatAt: null, searchMode: null, finishedAt: null, message: null, ...job }]
    : [];
  tables.auditLog = [];
}

beforeEach(() => {
  scheduled.args = [];
  activeDispatchJobs.clear();
});

describe('a start stores its search mode', () => {
  it('THOROUGH (chosen for the evening plan of tomorrow): on the job, in the request with the cap, in the ticket and the audit row', async () => {
    seed('2026-09-30');
    const res = await startDispatchOptimize(T, 'P', { id: 'u1' }, null, { now: NOW, searchMode: 'THOROUGH' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ searchMode: 'THOROUGH', maxSearchSec: 1200 });
    const job = tables.runJob[0];
    expect(job).toMatchObject({ status: 'QUEUED', searchMode: 'THOROUGH' });
    expect(job.heartbeatAt).toBeInstanceOf(Date);
    expect(job.message).toBe('Queued. Thorough search: up to 20 min, stops early when it stops improving.');
    expect(job.requestJson.config).toMatchObject({ search_mode: 'THOROUGH', max_search_sec: 1200 });
    expect(scheduled.args[0].ticket.searchMode).toBe('THOROUGH');
    expect(tables.auditLog.find((a) => a.action === 'OPTIMIZE_STARTED')?.afterJson).toMatchObject({ searchMode: 'THOROUGH', searchModeChosen: true, maxSearchSec: 1200 });
    scheduled.args[0].ticket.release();
  });

  it('a start that names no mode (a script, an older screen) searches QUICK, as before - whatever the day', async () => {
    for (const day of ['2026-09-29', '2026-09-30']) {
      seed(day);
      await startDispatchOptimize(T, 'P', { id: 'u1' }, null, { now: NOW });
      expect(tables.runJob[0]).toMatchObject({ searchMode: 'QUICK' });
      expect(tables.runJob[0].requestJson.config).toMatchObject({ search_mode: 'QUICK', max_search_sec: null });
      expect(tables.auditLog.find((a) => a.action === 'OPTIMIZE_STARTED')?.afterJson).toMatchObject({ searchMode: 'QUICK', searchModeChosen: false, maxSearchSec: null });
      expect(scheduled.args.at(-1)!.ticket.searchMode).toBe('QUICK');
      scheduled.args.at(-1)!.ticket.release();
    }
    expect(solveAdmission.snapshot().running).toBe(0);
  });
});

describe('the heartbeat: long searches are alive, lost jobs are found', () => {
  const run = { status: 'OPTIMIZING', currentJobId: 'J1' };
  const job = (startedMsAgo: number, heartbeatMsAgo: number | null, searchMode = 'THOROUGH') => ({
    id: 'J1',
    status: 'RUNNING',
    createdAt: ago(startedMsAgo + 1000),
    startedAt: ago(startedMsAgo),
    heartbeatAt: heartbeatMsAgo === null ? null : ago(heartbeatMsAgo),
    searchMode,
  });

  it('a THOROUGH job searching for 20 minutes with a fresh heartbeat is never lost, even in another process', () => {
    expect(stuckPlanState(run, job(20 * 60_000, 20_000), false, false, NOW)).toBeNull();
    expect(stuckPlanState(run, job(20 * 60_000, JOB_LOST_AFTER_MS - 5_000), false, false, NOW)).toBeNull();
  });

  it('its process gone (no heartbeat for 2 minutes): lost, and a supervisor may reset it', () => {
    expect(stuckPlanState(run, job(20 * 60_000, JOB_LOST_AFTER_MS + 5_000), false, false, NOW)).toMatchObject({ kind: 'JOB_LOST', resettable: true });
    expect(stuckPlanState(run, job(3 * 60_000, 3 * 60_000), false, false, NOW)?.text).toMatch(/fails it by itself within a few minutes/);
  });

  it('a job from before heartbeats counts from its start, as before', () => {
    expect(stuckPlanState(run, job(JOB_LOST_AFTER_MS - 5_000, null, 'QUICK'), false, false, NOW)).toBeNull();
    expect(stuckPlanState(run, job(JOB_LOST_AFTER_MS + 5_000, null, 'QUICK'), false, false, NOW)?.kind).toBe('JOB_LOST');
  });

  it('the last sign of life is the latest of heartbeat, start and creation', () => {
    expect(lastSignOfLife({ createdAt: ago(10_000), startedAt: ago(5_000), heartbeatAt: ago(1_000) })).toEqual(ago(1_000));
    expect(lastSignOfLife({ createdAt: ago(10_000), startedAt: null, heartbeatAt: null })).toEqual(ago(10_000));
  });

  it('"Reset stuck plan" refuses a job running here with its real limit, and one alive elsewhere', async () => {
    expect(jobRunningText('THOROUGH')).toMatch(/at most 22 minutes after it starts \(a thorough search\)/);
    expect(jobRunningText('QUICK')).toMatch(/at most 10 minutes after it starts\./);
    expect(jobRunningText(null)).toMatch(/at most 10 minutes/);

    seed('2026-09-30', { status: 'RUNNING', startedAt: ago(15 * 60_000), heartbeatAt: ago(20_000), searchMode: 'THOROUGH' });
    let finish!: () => void;
    trackInflight('P', () => new Promise<void>((r) => (finish = r)));
    const live = await resetStuckPlan(T, 'P', { id: 'sup' }, null, { isLive: (id) => id === 'P', now: NOW });
    finish();
    expect(live).toMatchObject({ status: 409, body: { code: 'JOB_RUNNING' } });
    expect(String(live.body.error)).toMatch(/22 minutes/);
    // Alive in another process (a deploy overlap): its heartbeat is fresh.
    const elsewhere = await resetStuckPlan(T, 'P', { id: 'sup' }, null, { isLive: () => false, now: NOW });
    expect(elsewhere).toMatchObject({ status: 409, body: { code: 'JOB_STARTING' } });
    expect(String(elsewhere.body.error)).toMatch(/sign of life less than 2 minutes ago/);
    expect(row('runJob', 'J1').status).toBe('RUNNING');
    // Its heartbeat stopped 3 minutes ago: now it may be reset.
    row('runJob', 'J1').heartbeatAt = ago(3 * 60_000);
    const reset = await resetStuckPlan(T, 'P', { id: 'sup' }, null, { isLive: () => false, now: NOW });
    expect(reset).toMatchObject({ status: 200, body: { kind: 'JOB_LOST', jobFailed: true } });
  });
});

describe('"Use the best plan found so far"', () => {
  const stop = vi.fn(async () => 'STOPPING' as const);
  beforeEach(() => stop.mockClear());

  it('stops a running THOROUGH search, audited', async () => {
    seed('2026-09-30', { status: 'RUNNING', startedAt: ago(6 * 60_000), heartbeatAt: ago(10_000), searchMode: 'THOROUGH' });
    const res = await stopSearch(T, 'P', { id: 'sup' }, '10.0.0.1', { callStop: stop });
    expect(res).toMatchObject({ status: 202, body: { stopping: true, runJobId: 'J1' } });
    expect(stop).toHaveBeenCalledWith('P', T);
    expect(tables.auditLog.map((a) => a.action)).toEqual(['SEARCH_STOPPED']);
    // Nothing else changes: the job saves the plan it gets back.
    expect(row('runJob', 'J1').status).toBe('RUNNING');
    expect(row('runPlan', 'P').status).toBe('OPTIMIZING');
  });

  it('refuses what cannot be stopped, and says why', async () => {
    seed('2026-09-30');
    expect((await stopSearch(T, 'nope', { id: 'sup' }, null, { callStop: stop })).status).toBe(404);
    expect((await stopSearch(T, 'P', { id: 'sup' }, null, { callStop: stop })).body.code).toBe('NOT_RUNNING');
    seed('2026-09-29', { status: 'RUNNING', startedAt: ago(30_000), searchMode: 'QUICK' });
    expect((await stopSearch(T, 'P', { id: 'sup' }, null, { callStop: stop })).body.code).toBe('NOT_THOROUGH');
    seed('2026-09-30', { status: 'QUEUED', searchMode: 'THOROUGH' });
    expect((await stopSearch(T, 'P', { id: 'sup' }, null, { callStop: stop })).body.code).toBe('NOT_STARTED');
    expect(stop).not.toHaveBeenCalled();
    seed('2026-09-30', { status: 'RUNNING', startedAt: ago(60_000), searchMode: 'THOROUGH' });
    expect((await stopSearch(T, 'P', { id: 'sup' }, null, { callStop: async () => 'NOT_RUNNING' })).body.code).toBe('SOLVER_NOT_RUNNING');
    const unreachable = await stopSearch(T, 'P', { id: 'sup' }, null, { callStop: async () => 'FAILED' });
    expect(unreachable).toMatchObject({ status: 502, body: { code: 'SOLVER_UNREACHABLE' } });
    expect(tables.auditLog).toEqual([]);
  });
});

describe('shutdown: the jobs of a stopping process fail at once, retryable', () => {
  const args = { runId: 'P', runJobId: 'J1', tenantId: T, userId: 'u1', ip: null, built: builtFor() as never };

  it('fails every job this process runs (job and plan FAILED, plain message, audited)', async () => {
    seed('2026-09-30', { status: 'RUNNING', startedAt: ago(8 * 60_000), heartbeatAt: ago(5_000), searchMode: 'THOROUGH' });
    activeDispatchJobs.set('J1', args);
    expect(await failJobsForShutdown()).toBe(1);
    expect(row('runJob', 'J1')).toMatchObject({ status: 'FAILED', message: SHUTDOWN_MESSAGE });
    expect(row('runPlan', 'P').status).toBe('FAILED');
    expect(tables.auditLog.map((a) => a.action)).toEqual(['OPTIMIZE_FAILED']);
    expect(await failJobsForShutdown()).toBe(1); // still registered here; a second pass changes nothing
    expect(tables.auditLog).toHaveLength(1);
  });

  it('with NEXT_MANUAL_SIG_HANDLE it owns the exit: the jobs first, then exit(0)', async () => {
    seed('2026-09-30', { status: 'RUNNING', startedAt: ago(60_000), heartbeatAt: ago(5_000), searchMode: 'THOROUGH' });
    activeDispatchJobs.set('J1', args);
    (globalThis as { __routeiqShutdownHandler?: boolean }).__routeiqShutdownHandler = undefined;
    const exited = new Promise<number>((resolve) => installShutdownHandler({ exit: resolve, env: { NEXT_MANUAL_SIG_HANDLE: '1' } as never }));
    expect(installShutdownHandler({ exit: () => undefined })).toBe(false); // once per process
    process.emit('SIGTERM', 'SIGTERM');
    expect(await exited).toBe(0);
    expect(row('runJob', 'J1').status).toBe('FAILED');
  });
});
