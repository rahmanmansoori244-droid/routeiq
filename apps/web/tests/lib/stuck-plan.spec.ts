/**
 * Audit F09 - plans stuck on "optimizing" (lib/dispatch/stuck-plan.ts), on the in-memory database:
 * - stuckPlanState: which OPTIMIZING plans are stuck (their job ended, is missing, or was lost by a
 *   restart) and which are really optimizing (a live job, or one that just started);
 * - repairStuckPlans (the janitor sweep): a plan OPTIMIZING behind an ended job goes back to FAILED
 *   with an OPTIMIZE_FAILED audit row (reason STUCK_PLAN); a live one is never touched;
 * - resetStuckPlan and POST /api/runs/:id/reset-stuck (owner decision 17): SUPERVISOR and above,
 *   PLAN_RESET audited, refused for a plan that is not stuck.
 * The real PostgreSQL fault injection and races are in tests/integration/recovery-races-db.spec.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const session = vi.hoisted(() => ({ role: 'SUPERVISOR' as string }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'sup1', tenantId: 'tA', role: session.role, name: 'S', email: 's@a.example' } })) }));

import { JOB_LOST_AFTER_MS, resetStuckPlan, stuckPlanState } from '@/lib/dispatch/stuck-plan';
import { isOptimizing, repairStuckPlans, trackInflight, whenIdle } from '@/lib/jobs/optimize-job';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { POST as resetRoute } from '@/app/api/runs/[id]/reset-stuck/route';

const T = 'tA';
const NOW = new Date('2026-09-27T10:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function seed(plan: { status?: string; currentJobId?: string | null; chosen?: string | null; createdAt?: Date }, jobs: Array<{ id: string; status: string; startedAt?: Date | null; createdAt?: Date }>) {
  resetDb();
  tables.runPlan = [
    {
      id: 'P',
      tenantId: T,
      depotId: 'D1',
      runDate: new Date('2026-09-28T00:00:00Z'),
      status: plan.status ?? 'OPTIMIZING',
      currentJobId: plan.currentJobId === undefined ? 'J1' : plan.currentJobId,
      chosenScenarioId: plan.chosen ?? null,
      supersededAt: null,
      version: 1,
      createdById: 'u-creator',
      createdAt: plan.createdAt ?? ago(60 * 60_000),
    },
  ];
  tables.runJob = jobs.map((j, i) => ({ tenantId: T, runId: 'P', attemptNo: i + 1, createdAt: j.createdAt ?? ago(30 * 60_000), startedAt: j.startedAt ?? null, finishedAt: null, ...j }));
  tables.auditLog = [];
}

const job = (status: string, startedMsAgo: number | null = 20 * 60_000) => ({
  id: 'J1',
  status,
  createdAt: ago((startedMsAgo ?? 0) + 1000),
  startedAt: startedMsAgo === null ? null : ago(startedMsAgo),
});

describe('stuckPlanState', () => {
  const run = (status = 'OPTIMIZING', currentJobId: string | null = 'J1') => ({ status, currentJobId });

  it('a plan whose current job ended (FAILED, SUCCEEDED, CANCELLED) or is missing is stuck', () => {
    for (const s of ['FAILED', 'SUCCEEDED', 'CANCELLED']) expect(stuckPlanState(run(), job(s), false, false, NOW)?.kind).toBe('JOB_ENDED');
    expect(stuckPlanState(run(), null, false, false, NOW)).toMatchObject({ kind: 'JOB_ENDED', resettable: true });
    expect(stuckPlanState(run('OPTIMIZING', null), null, false, false, NOW)).toMatchObject({ kind: 'NO_JOB', resettable: true });
  });

  it('a live job, or one started less than 2 minutes ago, is really optimizing', () => {
    expect(stuckPlanState(run(), job('RUNNING'), false, true, NOW)).toBeNull();
    expect(stuckPlanState(run(), job('RUNNING', JOB_LOST_AFTER_MS - 5_000), false, false, NOW)).toBeNull();
    expect(stuckPlanState(run(), job('QUEUED', null), false, true, NOW)).toBeNull();
    // A plan without a current job (an older row) is live while any of its jobs is.
    expect(stuckPlanState(run('OPTIMIZING', null), null, true, false, NOW)).toBeNull();
  });

  it('a job not running in this server and older than 2 minutes was lost (restart): stuck, resettable', () => {
    expect(stuckPlanState(run(), job('RUNNING', JOB_LOST_AFTER_MS + 5_000), false, false, NOW)).toMatchObject({ kind: 'JOB_LOST', resettable: true });
  });

  it('a plan that is not optimizing is never stuck', () => {
    for (const s of ['DRAFT', 'READY', 'FAILED', 'SUPERSEDED']) expect(stuckPlanState(run(s), job('FAILED'), false, false, NOW)).toBeNull();
  });
});

describe('repairStuckPlans (janitor sweep)', () => {
  it('the F09 state - OPTIMIZING behind a FAILED job - goes back to FAILED with one OPTIMIZE_FAILED row', async () => {
    seed({ chosen: 'scCopy' }, [job('FAILED')]);
    expect(await repairStuckPlans(NOW)).toEqual({ repaired: 1 });
    expect(row('runPlan', 'P')).toMatchObject({ status: 'FAILED', chosenScenarioId: 'scCopy', currentJobId: 'J1' });
    expect(tables.auditLog).toEqual([
      expect.objectContaining({ action: 'OPTIMIZE_FAILED', entityId: 'P', userId: 'u-creator', afterJson: expect.objectContaining({ reason: 'STUCK_PLAN', runJobId: 'J1', jobStatus: 'FAILED', repairedBy: 'JANITOR' }) }),
    ]);
    expect(await repairStuckPlans(NOW)).toEqual({ repaired: 0 }); // idempotent
    expect(tables.auditLog).toHaveLength(1);
  });

  it('never touches a plan whose job is QUEUED or RUNNING (the 15-minute reaper decides), nor another status', async () => {
    seed({}, [job('RUNNING', 30 * 60_000)]);
    expect(await repairStuckPlans(NOW)).toEqual({ repaired: 0 });
    expect(row('runPlan', 'P').status).toBe('OPTIMIZING');
    seed({ status: 'READY' }, [job('FAILED')]);
    expect(await repairStuckPlans(NOW)).toEqual({ repaired: 0 });
    expect(tables.auditLog).toHaveLength(0);
  });

  it('a plan without any job is repaired only a minute after it was created', async () => {
    seed({ currentJobId: null, createdAt: ago(10_000) }, []);
    expect(await repairStuckPlans(NOW)).toEqual({ repaired: 0 });
    seed({ currentJobId: null, createdAt: ago(5 * 60_000) }, []);
    expect(await repairStuckPlans(NOW)).toEqual({ repaired: 1 });
    expect(row('runPlan', 'P').status).toBe('FAILED');
  });
});

describe('resetStuckPlan (Reset stuck plan)', () => {
  const sup = { id: 'sup1' };
  const notLive = () => false;

  it('a plan behind an ended job: FAILED, audited PLAN_RESET with who and the note', async () => {
    seed({}, [job('FAILED')]);
    const r = await resetStuckPlan(T, 'P', sup, '10.0.0.5', { isLive: notLive, note: ' truck T03 stuck ', now: NOW });
    expect(r).toEqual({ status: 200, body: { runId: 'P', status: 'FAILED', runJobId: 'J1', jobFailed: false, kind: 'JOB_ENDED' } });
    expect(row('runPlan', 'P').status).toBe('FAILED');
    expect(tables.auditLog).toEqual([
      expect.objectContaining({
        action: 'PLAN_RESET',
        entity: 'RunPlan',
        entityId: 'P',
        userId: 'sup1',
        ip: '10.0.0.5',
        beforeJson: { status: 'OPTIMIZING', currentJobId: 'J1', jobStatus: 'FAILED' },
        afterJson: { status: 'FAILED', runJobId: 'J1', jobFailed: false, kind: 'JOB_ENDED', note: 'truck T03 stuck' },
      }),
    ]);
  });

  it('a job lost by a restart (RUNNING, not in this server, 20 min old) is failed "reset by a supervisor" with the plan', async () => {
    seed({ chosen: 'scCopy' }, [job('RUNNING', 20 * 60_000)]);
    const r = await resetStuckPlan(T, 'P', sup, null, { isLive: notLive, now: NOW });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jobFailed: true, kind: 'JOB_LOST' });
    expect(row('runJob', 'J1')).toMatchObject({ status: 'FAILED', errorJson: { reason: 'RESET', userId: 'sup1' } });
    expect(row('runJob', 'J1').message).toMatch(/Reset by a supervisor/);
    expect(row('runPlan', 'P')).toMatchObject({ status: 'FAILED', chosenScenarioId: 'scCopy' }); // the copied plan stays usable
  });

  it('refused, nothing changed: a job still running in this server, one just started, a plan not optimizing, another company', async () => {
    seed({}, [job('RUNNING', 20 * 60_000)]);
    expect(await resetStuckPlan(T, 'P', sup, null, { isLive: (id) => id === 'P', now: NOW })).toMatchObject({ status: 409, body: { code: 'JOB_RUNNING' } });
    seed({}, [job('RUNNING', 30_000)]);
    expect(await resetStuckPlan(T, 'P', sup, null, { isLive: notLive, now: NOW })).toMatchObject({ status: 409, body: { code: 'JOB_STARTING' } });
    seed({ status: 'READY' }, [job('SUCCEEDED')]);
    expect(await resetStuckPlan(T, 'P', sup, null, { isLive: notLive, now: NOW })).toMatchObject({ status: 409, body: { code: 'NOT_STUCK' } });
    expect(await resetStuckPlan('tOther', 'P', sup, null, { isLive: notLive, now: NOW })).toMatchObject({ status: 404 });
    expect(tables.auditLog).toHaveLength(0);
    expect(row('runPlan', 'P').status).toBe('READY');
  });
});

describe('second review of audit PR4: the plan screen read (getPlanDetail) racing the normal end of a live job', () => {
  // The fake has no snapshot: the job's end (SUCCEEDED + READY) is written only after the read,
  // which is what the read's REPEATABLE READ snapshot shows on PostgreSQL (the same schedule on a
  // real database: tests/integration/recovery-races-db.spec.ts). During the read the job leaves
  // the in-flight map, as its promise does right after its save commits.
  const OLD = JOB_LOST_AFTER_MS + 60_000; // started 3 minutes ago: "lost" if it is not live

  function liveJob() {
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    expect(trackInflight('P', () => done)).toBe(true);
    return { finish };
  }

  it('the job saves its plan and leaves the in-flight map during the read: no stuck line, no Reset button', async () => {
    seed({}, [job('RUNNING', OLD)]);
    const { finish } = liveJob();
    const findFirst = fakePrisma.runJob.findFirst;
    const spy = vi.spyOn(fakePrisma.runJob, 'findFirst').mockImplementationOnce(async (a: unknown) => {
      finish();
      await whenIdle('P');
      expect(isOptimizing('P')).toBe(false); // left the map before the read asks about the job
      return findFirst(a);
    });
    const d = (await getPlanDetail(T, 'P', { now: NOW }))!;
    spy.mockRestore();
    // The read's snapshot: still optimizing, the job still running (the race happened).
    expect(d.run.status).toBe('OPTIMIZING');
    expect(d.job?.status).toBe('RUNNING');
    // Before the fix: JOB_LOST, "the server restarted while it ran", resettable (Reset stuck plan).
    expect(d.stuck ?? null).toBeNull();
    // The commit the snapshot did not see: the next reload shows the plan, never stuck.
    Object.assign(row('runJob', 'J1'), { status: 'SUCCEEDED', finishedAt: NOW, progressPct: 100 });
    row('runPlan', 'P').status = 'READY';
    const next = (await getPlanDetail(T, 'P', { now: NOW }))!;
    expect(next.run.status).toBe('READY');
    expect(next.stuck ?? null).toBeNull();
  });

  it('controls: a live job is not stuck; a job not running in this server and 3 minutes old is lost (resettable)', async () => {
    seed({}, [job('RUNNING', OLD)]);
    const { finish } = liveJob();
    expect((await getPlanDetail(T, 'P', { now: NOW }))!.stuck ?? null).toBeNull();
    finish();
    await whenIdle('P');
    expect(await getPlanDetail(T, 'P', { now: NOW })).toMatchObject({ run: { status: 'OPTIMIZING' }, stuck: { kind: 'JOB_LOST', resettable: true } });
    // A plan behind an ended job is stuck whatever the in-flight map says.
    seed({}, [job('FAILED')]);
    const again = liveJob();
    expect(await getPlanDetail(T, 'P', { now: NOW })).toMatchObject({ stuck: { kind: 'JOB_ENDED', resettable: true } });
    again.finish();
    await whenIdle('P');
  });
});

describe('the "Reset stuck plan" button (static: the plan screens)', () => {
  const read = (p: string) => readFileSync(path.join(__dirname, '../..', p), 'utf8');

  it('is shown only for a resettable stuck plan and only with the supervisor permission, and calls the reset route', () => {
    const view = read('app/t/[slug]/dispatch/plan-view.tsx');
    expect(view).toContain('canResetStuck && d.stuck.resettable ?');
    expect(view).toContain('`/api/runs/${runId}/reset-stuck`');
    expect(view).toContain('window.confirm(STUCK_RESET_CONFIRM)');
    expect(view).toMatch(/canResetStuck = false/); // off unless a screen grants it
  });

  it('both plan screens grant it to SUPERVISOR and above only (canApproveOverride)', () => {
    expect(read('app/t/[slug]/dispatch/dispatch-client.tsx')).toContain('canResetStuck={canDispatch && dayReady}');
    expect(read('app/t/[slug]/dispatch/page.tsx')).toContain('canDispatch={canApproveOverride(user.role)}');
    expect(read('app/t/[slug]/dispatch/plan/[id]/plan-version-client.tsx')).toContain('canResetStuck={canDispatch}');
    expect(read('app/t/[slug]/dispatch/plan/[id]/page.tsx')).toContain('canDispatch={canApproveOverride(user.role)}');
  });
});

describe('review of audit PR4: the stuck-plan text names only what the viewer can do', () => {
  const read = (p: string) => readFileSync(path.join(__dirname, '../..', p), 'utf8');
  const texts = {
    JOB_ENDED: stuckPlanState({ status: 'OPTIMIZING', currentJobId: 'J1' }, job('FAILED'), false, false, NOW)!.text,
    NO_JOB: stuckPlanState({ status: 'OPTIMIZING', currentJobId: null }, null, false, false, NOW)!.text,
    JOB_LOST: stuckPlanState({ status: 'OPTIMIZING', currentJobId: 'J1' }, job('RUNNING', JOB_LOST_AFTER_MS + 5_000), false, false, NOW)!.text,
  };

  it('OPTIMIZE and Re-plan are disabled while the plan is optimizing, so no stuck text sends the dispatcher to them', () => {
    // The gating the text must match: both buttons are off while the plan is OPTIMIZING.
    const view = read('app/t/[slug]/dispatch/plan-view.tsx');
    expect(view).toContain("const running = d.run.status === 'OPTIMIZING'");
    expect(view).toContain('disabled={!!busy || running || nothingToPlan}');
    const day = read('app/t/[slug]/dispatch/dispatch-client.tsx');
    expect(day).toContain("const running = day.plan?.status === 'OPTIMIZING'");
    expect(day).toMatch(/disabled=\{optimizing \|\| planBusy \|\| running \|\|[^}]*\} data-testid="optimize-btn"/);
    for (const [kind, text] of Object.entries(texts)) {
      expect(text, kind).not.toMatch(/\b(OPTIMIZE|RE-PLAN)\b|resets it first/);
    }
  });

  it('a plan behind an ended or missing job: wait (reset by itself within a minute) or a supervisor presses Reset stuck plan', () => {
    for (const text of [texts.JOB_ENDED, texts.NO_JOB]) {
      expect(text).toContain('RouteIQ resets it by itself within a minute');
      expect(text).toContain('a supervisor can press Reset stuck plan');
    }
    expect(texts.JOB_LOST).toContain('A supervisor can reset the plan now');
  });

  it('the dispatcher guide says the same (no "OPTIMIZE or Re-plan resets it first")', () => {
    const guide = read('../../docs/DISPATCHER_GUIDE.md');
    expect(guide).toContain('A plan stuck on "Optimizing…"');
    expect(guide).not.toMatch(/resets it first/);
    expect(guide).toMatch(/\*\*Reset stuck plan\*\* now/);
  });

  it('second review of audit PR4: the admin runbook says the same (the buttons are greyed out; the janitor or Reset stuck plan)', () => {
    const admin = read('../../docs/admin.md');
    const start = admin.indexOf('### When a run is stuck "Optimizing"');
    expect(start).toBeGreaterThan(-1);
    const end = admin.indexOf('\n### ', start + 5);
    const section = admin.slice(start, end === -1 ? undefined : end);
    // Before: "**OPTIMIZE** and **Re-plan** on such a plan do the same first, then start a new optimization."
    expect(section).not.toMatch(/on such a plan do the same first|resets it first/);
    expect(section).toMatch(/\*\*OPTIMIZE\*\* and \*\*Re-plan\*\* stay greyed out while the plan shows \*Optimizing…\*/);
    expect(section).toMatch(/or a supervisor presses \*\*Reset stuck plan\*\* now/);
    // Reset stuck plan also covers a plan whose job has already ended, not only a job lost by a restart.
    expect(section).toContain('a plan whose job has already ended');
  });
});

describe('POST /api/runs/:id/reset-stuck', () => {
  const call = (body?: unknown) =>
    resetRoute(new Request('http://localhost/api/runs/P/reset-stuck', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), { params: { id: 'P' } });

  beforeEach(() => {
    session.role = 'SUPERVISOR';
  });

  it('a planner is refused (403): the reset is for supervisors and above', async () => {
    seed({}, [job('FAILED')]);
    session.role = 'PLANNER';
    const res = await call();
    expect(res.status).toBe(403);
    expect(row('runPlan', 'P').status).toBe('OPTIMIZING');
  });

  it('a supervisor resets a stuck plan (200) and the answer says what happened', async () => {
    seed({}, [job('FAILED')]);
    const res = await call({ note: 'stuck since the deploy' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: 'FAILED', kind: 'JOB_ENDED' });
    expect(tables.auditLog[0]).toMatchObject({ action: 'PLAN_RESET', userId: 'sup1', afterJson: expect.objectContaining({ note: 'stuck since the deploy' }) });
  });

  it('a job running in this server is not reset (409 JOB_RUNNING)', async () => {
    seed({}, [job('RUNNING', 20 * 60_000)]);
    let finish!: () => void;
    trackInflight('P', () => new Promise<void>((r) => (finish = r)));
    const res = await call();
    finish();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: 'JOB_RUNNING' });
    expect(row('runPlan', 'P').status).toBe('OPTIMIZING');
  });
});
