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
const session = vi.hoisted(() => ({ role: 'SUPERVISOR' as string }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'sup1', tenantId: 'tA', role: session.role, name: 'S', email: 's@a.example' } })) }));

import { JOB_LOST_AFTER_MS, resetStuckPlan, stuckPlanState } from '@/lib/dispatch/stuck-plan';
import { repairStuckPlans, trackInflight } from '@/lib/jobs/optimize-job';
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
