/**
 * Plans stuck on "optimizing" (audit F09). A plan version is OPTIMIZING exactly while its current
 * job (RunPlan.currentJobId) is QUEUED or RUNNING: the start writes both together, and every way a
 * job ends (saved, failed, stale, reaped by the janitor) moves the plan in the same transaction.
 * Before the audit fix the janitor wrote the job and the plan separately, so a failed second write
 * left a plan OPTIMIZING whose job had already ended - and nothing ever moved it again: the day
 * could not be optimized, re-planned or (on a re-plan version) dispatched.
 *
 * - repairEndedJobPlan: a plan OPTIMIZING whose current job has ended (or is missing) is put back
 *   to FAILED - exactly what that job's failure would have done - with an OPTIMIZE_FAILED audit
 *   row (reason STUCK_PLAN). Automatic: the janitor sweep (every 60 s, repairStuckPlans in
 *   lib/jobs/optimize-job.ts) and every OPTIMIZE / RE-PLAN of such a plan run it first, so a retry
 *   starts real work instead of answering 202 with the dead job.
 * - resetStuckPlan: the supervisor's "Reset stuck plan" (owner decision 17: SUPERVISOR and above,
 *   audited PLAN_RESET). Also for a job lost by a server restart that the janitor would only fail
 *   after 15 minutes. Never for a job still running in this web process.
 *
 * A re-plan version put back to FAILED keeps the copy of the previous plan it holds: its loads
 * stay usable (locked, loaded, dispatched), exactly as after any failed re-plan.
 */
import type { Prisma, RunJobStatus } from '@prisma/client';
import { prisma } from '../db';
import { audit } from '../audit';
import { isLockBusy, lockPlanRow, setLockTimeout } from './plan-locks';

type Tx = Prisma.TransactionClient;

const ACTIVE: RunJobStatus[] = ['QUEUED', 'RUNNING'];
export const isActiveJob = (s: string) => s === 'QUEUED' || s === 'RUNNING';

/**
 * A QUEUED or RUNNING job that this web process is not running counts as lost (the server
 * restarted during it) only after this long: a job created a moment ago may still be starting.
 */
export const JOB_LOST_AFTER_MS = 2 * 60_000;

export type StuckKind = 'JOB_ENDED' | 'NO_JOB' | 'JOB_LOST';

export interface StuckJobFacts {
  id: string;
  status: RunJobStatus | string;
  createdAt: Date;
  startedAt: Date | null;
}

export interface StuckState {
  kind: StuckKind;
  /** A supervisor may reset the plan now ("Reset stuck plan"). */
  resettable: boolean;
  /** What the plan screen says. */
  text: string;
}

const TEXT: Record<StuckKind, string> = {
  JOB_ENDED:
    'This plan is still marked as optimizing, but its optimization has already ended. RouteIQ resets it by itself within a minute; OPTIMIZE or RE-PLAN also resets it first.',
  NO_JOB: 'This plan is marked as optimizing, but no optimization is running for it. RouteIQ resets it by itself within a minute.',
  JOB_LOST:
    'This optimization stopped without a result (the server restarted while it ran). A supervisor can reset the plan now; otherwise RouteIQ fails it 15 minutes after it started.',
};

/**
 * Is this plan stuck on "optimizing"? null = no (not optimizing, or its optimization is really
 * running). `live`: the job is running in this web process (the in-flight map).
 */
export function stuckPlanState(
  run: { status: string; currentJobId: string | null },
  currentJob: StuckJobFacts | null,
  otherActiveJob: boolean,
  live: boolean,
  now: Date = new Date(),
): StuckState | null {
  if (run.status !== 'OPTIMIZING') return null;
  if (currentJob && isActiveJob(currentJob.status)) {
    if (live) return null;
    const since = (currentJob.startedAt ?? currentJob.createdAt).getTime();
    if (now.getTime() - since < JOB_LOST_AFTER_MS) return null;
    return { kind: 'JOB_LOST', resettable: true, text: TEXT.JOB_LOST };
  }
  // Rows from before every start recorded its job: a plan without a current job is live while any
  // of its jobs is still active.
  if (!run.currentJobId && otherActiveJob) return null;
  const kind: StuckKind = run.currentJobId ? 'JOB_ENDED' : 'NO_JOB';
  return { kind, resettable: true, text: TEXT[kind] };
}

interface PlanFacts {
  run: { id: string; tenantId: string; status: string; currentJobId: string | null; createdById: string };
  job: (StuckJobFacts & { finishedAt: Date | null }) | null;
  otherActiveJob: boolean;
}

/** The plan and its current job, read under the plan row lock. */
async function readUnderLock(tx: Tx, tenantId: string, runId: string): Promise<PlanFacts | null> {
  if (!(await lockPlanRow(tx, tenantId, runId))) return null;
  const run = await tx.runPlan.findFirst({
    where: { id: runId, tenantId },
    select: { id: true, tenantId: true, status: true, currentJobId: true, createdById: true },
  });
  if (!run) return null;
  const job = run.currentJobId
    ? await tx.runJob.findFirst({
        where: { id: run.currentJobId, runId },
        select: { id: true, status: true, createdAt: true, startedAt: true, finishedAt: true },
      })
    : null;
  const otherActiveJob = (await tx.runJob.count({ where: { runId, status: { in: ACTIVE } } })) > 0;
  return { run, job, otherActiveJob };
}

export type RepairVia = 'JANITOR' | 'OPTIMIZE' | 'REPLAN';

/**
 * Put back to FAILED a plan OPTIMIZING whose current job has ended or is missing (never one whose
 * job is QUEUED or RUNNING), with its OPTIMIZE_FAILED audit row, in one transaction under the plan
 * row lock. True when it repaired the plan; false when there was nothing to repair or the plan row
 * is busy (the next sweep or click tries again).
 */
export async function repairEndedJobPlan(
  tenantId: string,
  runId: string,
  actor: { userId: string | null; ip?: string | null; via: RepairVia },
): Promise<boolean> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await setLockTimeout(tx);
        const f = await readUnderLock(tx, tenantId, runId);
        if (!f) return false;
        const state = stuckPlanState(f.run, f.job, f.otherActiveJob, false);
        // Only a definitely ended job: a lost QUEUED / RUNNING job is the janitor's (after 15 min)
        // or a supervisor's (Reset stuck plan) to fail.
        if (!state || state.kind === 'JOB_LOST') return false;
        const moved = await tx.runPlan.updateMany({ where: { id: runId, tenantId, status: 'OPTIMIZING', currentJobId: f.run.currentJobId }, data: { status: 'FAILED' } });
        if (moved.count !== 1) return false;
        await audit(
          {
            tenantId,
            userId: actor.userId ?? f.run.createdById,
            action: 'OPTIMIZE_FAILED',
            entity: 'RunPlan',
            entityId: runId,
            beforeJson: { status: 'OPTIMIZING', currentJobId: f.run.currentJobId } as never,
            afterJson: {
              status: 'FAILED',
              runJobId: f.run.currentJobId,
              jobStatus: f.job?.status ?? null,
              reason: 'STUCK_PLAN',
              repairedBy: actor.via,
            } as never,
            ip: actor.ip ?? null,
          },
          tx,
        );
        return true;
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
  } catch (e) {
    if (isLockBusy(e)) return false;
    throw e;
  }
}

export interface ResetResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * "Reset stuck plan" (owner decision 17): a SUPERVISOR or above puts a plan stuck on "optimizing"
 * back to FAILED, so it can be optimized or re-planned again. In one transaction under the plan
 * row lock: its lost job (QUEUED / RUNNING, not running in this web process, older than
 * JOB_LOST_AFTER_MS) is failed "Reset by a supervisor", the plan goes to FAILED and a PLAN_RESET
 * audit row names who did it. Refused (409) for a plan that is not stuck: not optimizing
 * (NOT_STUCK), or its optimization is really running (JOB_RUNNING) or just starting (JOB_STARTING).
 * `isLive` answers whether this web process is running the plan's job (the in-flight map).
 */
export async function resetStuckPlan(
  tenantId: string,
  runId: string,
  user: { id: string },
  ip: string | null,
  opts: { isLive: (runId: string) => boolean; note?: string | null; now?: Date },
): Promise<ResetResult> {
  try {
    return await prisma.$transaction(
      async (tx): Promise<ResetResult> => {
        await setLockTimeout(tx);
        const f = await readUnderLock(tx, tenantId, runId);
        if (!f) return { status: 404, body: { error: 'Plan not found.' } };
        if (f.run.status !== 'OPTIMIZING') {
          return { status: 409, body: { error: `This plan is ${f.run.status}, not optimizing: there is nothing to reset.`, code: 'NOT_STUCK' } };
        }
        const live = opts.isLive(runId);
        const now = opts.now ?? new Date();
        const state = stuckPlanState(f.run, f.job, f.otherActiveJob, live, now);
        if (!state) {
          if (live) {
            return {
              status: 409,
              body: {
                error:
                  'The optimization is still running (or waiting for a free optimizer) on the server, and it ends by itself - at most 10 minutes after it starts. Reset the plan only if it is still shown as optimizing after that.',
                code: 'JOB_RUNNING',
              },
            };
          }
          return {
            status: 409,
            body: { error: 'The optimization started less than 2 minutes ago and may still be starting. Wait a moment, then try again.', code: 'JOB_STARTING' },
          };
        }
        let jobFailed = false;
        if (f.job && isActiveJob(f.job.status)) {
          const n = await tx.runJob.updateMany({
            where: { id: f.job.id, status: { in: ACTIVE } },
            data: {
              status: 'FAILED',
              finishedAt: now,
              message: 'Reset by a supervisor: this optimization stopped without a result. Optimize again.',
              errorJson: { reason: 'RESET', message: 'Plan reset by a supervisor (Reset stuck plan).', userId: user.id } as never,
            },
          });
          jobFailed = n.count === 1;
        }
        await tx.runPlan.updateMany({ where: { id: runId, tenantId, status: 'OPTIMIZING' }, data: { status: 'FAILED' } });
        const note = opts.note?.trim() ? opts.note.trim().slice(0, 500) : null;
        await audit(
          {
            tenantId,
            userId: user.id,
            action: 'PLAN_RESET',
            entity: 'RunPlan',
            entityId: runId,
            beforeJson: { status: 'OPTIMIZING', currentJobId: f.run.currentJobId, jobStatus: f.job?.status ?? null } as never,
            afterJson: { status: 'FAILED', runJobId: f.run.currentJobId, jobFailed, kind: state.kind, note } as never,
            ip,
          },
          tx,
        );
        return { status: 200, body: { runId, status: 'FAILED', runJobId: f.run.currentJobId, jobFailed, kind: state.kind } };
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
  } catch (e) {
    if (isLockBusy(e)) return { status: 409, body: { error: 'Plan is being saved - retry in a moment.', code: 'PLAN_BUSY' } };
    throw e;
  }
}
