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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>, tx?: Record<string, any>) => (tx ?? m.fakePrisma).auditLog.create({ data: { ...input } })) };
});
const scheduled = vi.hoisted(() => ({ args: [] as Record<string, any>[], real: null as null | ((args: any) => boolean) }));
vi.mock('@/lib/jobs/dispatch-job', async (orig) => {
  const real = await orig<typeof import('@/lib/jobs/dispatch-job')>();
  scheduled.real = real.scheduleDispatchOptimize;
  return {
    ...real,
    scheduleDispatchOptimize: vi.fn((args: Record<string, any>) => {
      scheduled.args.push(args);
      return true;
    }),
  };
});
/** What the fake optimizer was sent (the real job's call), and how it answers. */
const solverFake = vi.hoisted(() => ({ sent: [] as Record<string, any>[] }));
vi.mock('@/lib/solver-client', async (orig) => {
  const real = await orig<typeof import('@/lib/solver-client')>();
  return {
    ...real,
    callDispatchSolver: vi.fn(async (req: Record<string, any>) => {
      solverFake.sent.push(JSON.parse(JSON.stringify(req)));
      throw new real.SolverError('fake optimizer: no plan in this test', 0, null);
    }),
  };
});
/** The request is built for this delivery day at the start's clock (a plan for it made on the day moves its times). */
const build = vi.hoisted(() => ({ runDateIso: null as string | null }));
function builtFor(now: Date = new Date()) {
  // The same-day rule exactly as buildDispatchRequest applies it (plan-service sameDayBasis): 06:00
  // first departure, 30 min turnaround, 0.04 min per case, 800-case trucks.
  const basis = build.runDateIso
    ? sameDayBasis({ runDateIso: build.runDateIso, timezone: 'Asia/Muscat', firstDepartureMin: 360, prepMin: 30, depotCloseMin: null, loading: { perCase: 0.04, exampleCases: 800 } }, 360, now)
    : undefined;
  const t = basis?.timing;
  return {
    request: {
      run_id: 'P',
      tenant_id: 'tA',
      stops: [{ stop_id: 'O2' }],
      trucks: [{ id: 'T1', capacity_kg: 0 }],
      config: {
        scenarios: ['RECOMMENDED'],
        ...(basis ? { shift_start_min: t?.planFrom?.fromMin ?? 360 } : {}),
        ...(typeof t?.loadingFromMin === 'number' ? { loading_from_min: t.loadingFromMin } : {}),
      } as Record<string, unknown>,
    },
    preDrops: [],
    scope: { orderIds: ['O2'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] },
    blocking: [],
    warnings: t?.warning ? [t.warning] : [],
    unknownWeights: [],
    weightChanges: { lines: [], orders: [] },
    settings: { timezone: 'Asia/Muscat', planFrom: t?.planFrom ?? null, loadingFromMin: t?.loadingFromMin ?? null },
    ...(basis ? { sameDay: basis } : {}),
  };
}
vi.mock('@/lib/dispatch/plan-service', async (orig) => {
  const real = await orig<typeof import('@/lib/dispatch/plan-service')>();
  return {
    ...real,
    buildDispatchRequest: vi.fn(async (_t: string, _r: string, _s: unknown, o?: { now?: Date }) => builtFor(o?.now)),
    isLegacyPlan: vi.fn(async () => false),
    pendingLateOrderIds: vi.fn(async () => []),
  };
});

import { JOB_LOST_AFTER_MS, jobRunningText, lastSignOfLife, resetStuckPlan, stuckPlanState } from '@/lib/dispatch/stuck-plan';
import { trackInflight } from '@/lib/jobs/optimize-job';
import { startDispatchOptimize } from '@/lib/dispatch/start-optimize';
import { solveAdmission } from '@/lib/dispatch/solve-admission';
import { stopSearch } from '@/lib/dispatch/stop-search';
import { activeDispatchJobs } from '@/lib/jobs/dispatch-job';
import { failJobsForShutdown, installShutdownHandler, SHUTDOWN_MESSAGE } from '@/lib/jobs/shutdown';
import { sameDayBasis } from '@/lib/dispatch/plan-service';
import { optimizeStartedText } from '@/lib/dispatch/search-mode';

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
  solverFake.sent = [];
  build.runDateIso = null;
  activeDispatchJobs.clear();
});
// Every slot a start took goes back to the process-wide admission, also when a test failed.
afterEach(() => {
  for (const a of scheduled.args) a.ticket?.release();
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

describe('a same-day THOROUGH is timed from the end of its search, never from the button press (review of the long-search PR)', () => {
  const MIN_1900 = 19 * 60; // NOW in Muscat
  const g = globalThis as unknown as { __routeiqInflight: Map<string, Promise<unknown>> };

  it('the start: no new load before now + the cap + the turnaround, loading from the end of the search; QUICK and tomorrow as before', async () => {
    seed('2026-09-29');
    build.runDateIso = '2026-09-29';
    const res = await startDispatchOptimize(T, 'P', { id: 'u1' }, null, { now: NOW, searchMode: 'THOROUGH' });
    expect(res.status).toBe(202);
    const cfg = tables.runJob[0].requestJson.config;
    expect(cfg.shift_start_min).toBeGreaterThanOrEqual(MIN_1900 + 1200 / 60 + 30);
    expect(cfg).toMatchObject({ search_mode: 'THOROUGH', shift_start_min: 1190, loading_from_min: 1160 }); // 19:50, 19:20
    expect(scheduled.args[0].built.warnings[0]).toMatch(/^Planned from 19:50 \(now 19:00 \+ up to 20 min Thorough search \+ 30 min preparation\): the plan is for today and cannot be used before its search ends/);
    expect(tables.auditLog.find((a) => a.action === 'OPTIMIZE_STARTED')?.afterJson).toMatchObject({ planFromMin: 1190, loadingFromMin: 1160 });
    scheduled.args[0].ticket.release();

    seed('2026-09-29');
    await startDispatchOptimize(T, 'P', { id: 'u1' }, null, { now: NOW, searchMode: 'QUICK' });
    expect(tables.runJob[0].requestJson.config).toMatchObject({ search_mode: 'QUICK', shift_start_min: 1170, loading_from_min: 1140 }); // as before
    expect(scheduled.args[1].built.warnings[0]).toMatch(/^Planned from 19:30 \(now 19:00 \+ 30 min preparation\): the plan is for today, so/);
    scheduled.args[1].ticket.release();

    seed('2026-09-30');
    build.runDateIso = '2026-09-30';
    await startDispatchOptimize(T, 'P', { id: 'u1' }, null, { now: NOW, searchMode: 'THOROUGH' });
    const tomorrow = tables.runJob[0].requestJson.config;
    expect(tomorrow.shift_start_min).toBe(360);
    expect('loading_from_min' in tomorrow).toBe(false);
    scheduled.args[2].ticket.release();
    expect(solveAdmission.snapshot().running).toBe(0);
  });

  for (const mode of ['THOROUGH', 'QUICK'] as const) {
    it(`the job: ${mode === 'THOROUGH' ? 'after 25 minutes in the queue it is timed from when it really starts' : 'QUICK is sent exactly as it was built, however long it waited'}`, async () => {
      seed('2026-09-29');
      build.runDateIso = '2026-09-29';
      // Another company's solve of the same mode holds the slot this start needs: it queues.
      const blockers = [solveAdmission.reserve('OTHER', 'x', mode), ...(mode === 'QUICK' ? [solveAdmission.reserve('THIRD', 'y', mode)] : [])];
      const freeBlockers = () => blockers.forEach((b) => b.ok && b.ticket.release());
      let args!: Record<string, any>;
      let built = '';
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(NOW);
        const res = await startDispatchOptimize(T, 'P', { id: 'u1' }, null, { now: NOW, searchMode: mode });
        expect(res.body).toMatchObject({ queued: true });
        args = scheduled.args[0];
        built = JSON.stringify(args.built.request.config);
        vi.setSystemTime(new Date(NOW.getTime() + 25 * 60_000)); // 19:25: the slot frees
        scheduled.real!(args);
        freeBlockers();
        await g.__routeiqInflight.get('P');
        for (let i = 0; i < 20 && row('runJob', tables.runJob[0].id).status !== 'FAILED'; i++) await new Promise((r) => setTimeout(r, 5));
      } finally {
        vi.useRealTimers();
        freeBlockers();
      }
      expect(solverFake.sent).toHaveLength(1);
      const sent = solverFake.sent[0].config;
      const job = row('runJob', tables.runJob[0].id);
      expect(job.startedAt).toEqual(new Date(NOW.getTime() + 25 * 60_000));
      if (mode === 'THOROUGH') {
        expect(sent).toMatchObject({ shift_start_min: 1215, loading_from_min: 1185 }); // 19:25 + 20 + 30; 19:25 + 20
        expect(job.requestJson.config).toMatchObject({ shift_start_min: 1215, loading_from_min: 1185 }); // what was sent is what is stored
        expect(args.built.warnings[0]).toMatch(/^Planned from 20:15 \(now 19:25 \+ up to 20 min Thorough search/);
        expect(args.built.settings).toMatchObject({ planFrom: { fromMin: 1215 }, loadingFromMin: 1185 });
      } else {
        expect(JSON.stringify(sent)).toBe(built);
        expect(sent).toMatchObject({ shift_start_min: 1170, loading_from_min: 1140 });
      }
      expect(solveAdmission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
    }, 20_000);
  }
});

describe('two dispatchers at once: a choice that was not applied is never reported as applied (review of the long-search PR)', () => {
  it('a start while a job runs answers with that job and its own mode, flagged as already running; the toast says the choice was not applied', async () => {
    seed('2026-09-30');
    const b = await startDispatchOptimize(T, 'P', { id: 'uB' }, null, { now: NOW, searchMode: 'QUICK' });
    expect(b.body).toMatchObject({ searchMode: 'QUICK', queued: false });
    expect(b.body.alreadyRunning).toBeUndefined();
    const a = await startDispatchOptimize(T, 'P', { id: 'uA' }, null, { now: NOW, searchMode: 'THOROUGH' });
    expect(a).toMatchObject({ status: 202, body: { runJobId: b.body.runJobId, status: 'QUEUED', searchMode: 'QUICK', alreadyRunning: true } });
    expect(tables.runJob).toHaveLength(1);
    expect(optimizeStartedText(a.body, 'THOROUGH', 1200, 10)).toBe(
      'An optimization (Quick) was already running for this plan, so your choice (Thorough) was not applied. When it ends, re-plan with Thorough if needed.',
    );
    expect(optimizeStartedText({ ...a.body, searchMode: 'THOROUGH' }, 'THOROUGH', 1200, 10)).toBe(
      'An optimization (Thorough) is already running for this plan; nothing new was started. The plan is saved when it ends.',
    );
    // The usual answers, from the server's mode.
    expect(optimizeStartedText(b.body, 'QUICK', 1200, 80)).toBe('Optimizing (Quick): usually about 1 min for this day.');
    expect(optimizeStartedText({ queued: false, searchMode: 'THOROUGH' }, 'THOROUGH', 1200, 80)).toMatch(/^Optimizing \(Thorough\): up to 20 min, stops early/);
    expect(optimizeStartedText({ queued: true, searchMode: 'QUICK' }, 'QUICK', 1200, 80)).toMatch(/^Queued: other optimizations are running/);

    // A job from before search modes (no mode stored) searched QUICK.
    seed('2026-09-30', { status: 'RUNNING', startedAt: ago(60_000), heartbeatAt: ago(5_000), searchMode: null });
    const c = await startDispatchOptimize(T, 'P', { id: 'uA' }, null, { now: NOW, searchMode: 'THOROUGH' });
    expect(c.body).toMatchObject({ runJobId: 'J1', status: 'RUNNING', searchMode: 'QUICK', alreadyRunning: true });
  });

  it('the same answer when the other start wins inside the start transaction', async () => {
    seed('2026-09-30', { status: 'QUEUED', searchMode: 'QUICK' });
    // The job appears between the first look and the locked read (the other start committed then).
    const spy = vi.spyOn(fakePrisma.runJob, 'findFirst').mockResolvedValueOnce(null as never);
    const a = await startDispatchOptimize(T, 'P', { id: 'uA' }, null, { now: NOW, searchMode: 'THOROUGH' });
    spy.mockRestore();
    expect(a).toMatchObject({ status: 202, body: { runJobId: 'J1', status: 'QUEUED', searchMode: 'QUICK', alreadyRunning: true } });
    expect(tables.runJob).toHaveLength(1);
    expect(solveAdmission.snapshot()).toMatchObject({ running: 0, waiting: 0 });
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
