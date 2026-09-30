/**
 * The in-process registry of background optimizations, and the stuck-job janitor.
 *
 * One in-process in-flight map keyed by plan version (runId): the dispatch job
 * (lib/jobs/dispatch-job.ts, scheduleDispatchOptimize) registers its promise here, so duplicate
 * starts do no double work and the janitor never reaps a live job. Plan correctness does not
 * depend on it: every plan mutator takes database locks (stabilization PR3). The web must still
 * run as exactly one replica (the map, the rate limits and the solve admission are in memory).
 *
 * The legacy PyVRP path (scheduleOptimize / buildSolverPayload / callSolver to the solver's
 * /optimize) had no caller since the dispatch planner replaced it and was removed in stabilization
 * PR5; the solver's /optimize endpoint stays until the owner retires it.
 */
import { prisma } from '../db';
import { audit } from '../audit';
import { lockPlanRow, setLockTimeout } from '../dispatch/plan-locks';
import { isActiveJob, repairEndedJobPlan, stuckPlanState } from '../dispatch/stuck-plan';

// On globalThis: Next compiles instrumentation.ts (the in-process janitor) into its own bundle
// layer with a separate copy of this module, and the janitor must see the same live jobs.
const g = globalThis as unknown as { __routeiqInflight?: Map<string, Promise<void>> };
const inflight = (g.__routeiqInflight ??= new Map<string, Promise<void>>());

export function isOptimizing(runId: string): boolean {
  return inflight.has(runId);
}

/** Register any background optimize promise (legacy or dispatch) in the shared in-flight map,
 * so duplicate starts are refused and the stuck-job janitor never reaps a live job. */
export function trackInflight(runId: string, start: () => Promise<void>): boolean {
  if (inflight.has(runId)) return false;
  const p: Promise<void> = start().finally(() => {
    if (inflight.get(runId) === p) inflight.delete(runId);
  });
  inflight.set(runId, p);
  return true;
}

/** Resolves once no background optimize of this plan version is in flight (never rejects). */
export async function whenIdle(runId: string): Promise<void> {
  // Each tracked promise removes itself from the map in its own finally, before it settles.
  for (let p = inflight.get(runId); p; p = inflight.get(runId)) await p.catch(() => undefined);
}

/**
 * A job WITHOUT a heartbeat (started by a release before heartbeats: a QUICK search, 10 min at most)
 * is failed this long after it started. Longer than it can legitimately run: the solver call plus
 * saving the plan.
 */
export const STUCK_JOB_MS = 15 * 60 * 1000;

/**
 * A job WITH a heartbeat (every 30 s while it waits or runs, lib/jobs/dispatch-job.ts) is failed
 * this long after its last one: its process is gone (restart, deploy, crash, out of memory). A
 * 20-minute THOROUGH search keeps its heartbeat going, so it is never failed for running long.
 */
export const STALE_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Orphan janitor — mark jobs whose process is gone as FAILED with reason STUCK, and put their plan
 * back to FAILED so it can be optimized again: a job with a heartbeat 5 minutes after its last one
 * (STALE_HEARTBEAT_MS), a job from before heartbeats 15 minutes after it started (STUCK_JOB_MS).
 * Runs every 60 s inside the web process (instrumentation.ts) and from the cron route.
 *
 * Audit F09: each job is reaped in ONE transaction - the plan row lock (the order every plan
 * writer uses: plan, then its job), the job FAILED, its plan FAILED and the OPTIMIZE_FAILED audit
 * row - so a failed write leaves both as they were (the next sweep retries) and can never strand a
 * plan OPTIMIZING behind a FAILED job again. Then repairStuckPlans puts back any plan stranded
 * that way before the fix.
 */
export async function reapStuckJobs(thresholdMs = STUCK_JOB_MS, heartbeatMs = STALE_HEARTBEAT_MS): Promise<{ reaped: number; repaired: number }> {
  // We use a Postgres-side NOW() comparison instead of passing a JS Date,
  // because RunJob.startedAt is a TIMESTAMP (no time zone) column — comparing
  // it against a JS Date via Prisma's serialized ISO string would mis-match
  // by however many hours separate the server's clock from UTC.
  const minutes = Math.max(1, Math.round(thresholdMs / 60000));
  const beatSec = Math.max(1, Math.round(heartbeatMs / 1000));
  const stuck = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      runId: string;
      tenantId: string;
      createdById: string;
      attemptNo: number;
      status: 'RUNNING' | 'QUEUED';
      heartbeat: boolean;
    }>
  >(
    // Both sides are computed Postgres-side so the comparison stays in the
    // server's session timezone. (Prisma converts JS Dates to local-time
    // TIMESTAMPs when writing, so NOW() — also local — matches them. See
    // feedback_db_gotchas memory for context.)
    // With a heartbeat: its process is gone once the heartbeat is older than $2 seconds, whether the
    // job waited (QUEUED) or searched (RUNNING) - however long it has been running.
    // Without one (a job from before heartbeats): a RUNNING job $1 minutes after it started; a
    // QUEUED one (it normally turns RUNNING within milliseconds) $1 minutes after it was created.
    `SELECT id, "runId", "tenantId", "createdById", "attemptNo", status::text AS status, ("heartbeatAt" IS NOT NULL) AS heartbeat
     FROM "RunJob"
     WHERE status IN ('RUNNING', 'QUEUED') AND (
           ("heartbeatAt" IS NOT NULL AND "heartbeatAt" < NOW() - ($2::int || ' seconds')::interval)
        OR ("heartbeatAt" IS NULL AND status = 'RUNNING' AND "startedAt" IS NOT NULL AND "startedAt" < NOW() - ($1::int || ' minutes')::interval)
        OR ("heartbeatAt" IS NULL AND status = 'QUEUED' AND "createdAt" < NOW() - ($1::int || ' minutes')::interval))`,
    minutes,
    beatSec,
  );
  const beatMin = Math.max(1, Math.round(beatSec / 60));
  let reaped = 0;
  for (const job of stuck) {
    // Skip jobs whose background promise is still tracked in-process. The
    // janitor is conservative: only DB rows with no live promise (i.e. the
    // process restarted and lost the inflight map) need cleanup. Failing a
    // job that's still running would race the success path and corrupt
    // RunPlan.status.
    if (inflight.has(job.runId)) continue;
    try {
      const done = await prisma.$transaction(
        async (tx) => {
          // A plan being saved holds its row: wait at most 5 s, then leave it to the next sweep.
          await setLockTimeout(tx);
          await lockPlanRow(tx, job.tenantId, job.runId);
          // Conditional update so we don't FAIL a job that just succeeded
          // between the SELECT and the UPDATE.
          const flipped = await tx.runJob.updateMany({
            where: { id: job.id, status: job.status },
            data: {
              status: 'FAILED',
              finishedAt: new Date(),
              message: job.heartbeat
                ? `No sign of life for ${beatMin} minutes: the server running this optimization stopped (a restart or an update). Nothing was saved - optimize again.`
                : `No result after ${minutes} minutes (the server restarted during the optimization). Optimize again.`,
              errorJson: {
                reason: 'STUCK',
                message: job.heartbeat ? `Job ${job.status} with no heartbeat for more than ${beatMin} minutes.` : `Job ${job.status} for more than ${minutes} minutes.`,
              } as never,
            },
          });
          if (flipped.count === 0) return false;
          // Only the version this job was optimizing (review F07): never a version another job
          // took over. A version that a re-plan copied forward keeps its copied plan, usable.
          await tx.runPlan.updateMany({
            where: { id: job.runId, status: 'OPTIMIZING', OR: [{ currentJobId: job.id }, { currentJobId: null }] },
            data: { status: 'FAILED' },
          });
          await audit(
            {
              tenantId: job.tenantId,
              userId: job.createdById,
              action: 'OPTIMIZE_FAILED',
              entity: 'RunPlan',
              entityId: job.runId,
              afterJson: { runJobId: job.id, attemptNo: job.attemptNo, reason: 'STUCK' } as never,
            },
            tx,
          );
          return true;
        },
        { timeout: 15_000, maxWait: 5_000 },
      );
      if (done) reaped++;
    } catch (err) {
      // Nothing was written (one transaction); the next sweep tries again.
      console.error('reapStuckJobs: failed to reap', job.id, err);
    }
  }
  const { repaired } = await repairStuckPlans();
  return { reaped, repaired };
}

/**
 * A plan without a current job counts as stuck only this long after it was created: a start writes
 * the plan and its job together, but a plan row written by hand (or by an older release) gets a
 * moment before the sweep calls it stuck.
 */
export const STUCK_PLAN_GRACE_MS = 60_000;

/**
 * Audit F09 repair sweep: every plan OPTIMIZING whose current job is not QUEUED or RUNNING (it
 * ended, or is missing) goes back to FAILED with an OPTIMIZE_FAILED audit row (reason STUCK_PLAN),
 * one transaction each (repairEndedJobPlan). These rows are what the old two-write janitor left
 * behind when its second write failed; the sweep also mends any found later. A plan whose current
 * job is still QUEUED or RUNNING is never touched here (reapStuckJobs fails it once its process is
 * gone: 5 minutes after its last heartbeat).
 */
export async function repairStuckPlans(now: Date = new Date()): Promise<{ repaired: number }> {
  const plans = await prisma.runPlan.findMany({
    where: { status: 'OPTIMIZING' },
    select: { id: true, tenantId: true, status: true, currentJobId: true, createdAt: true },
  });
  if (plans.length === 0) return { repaired: 0 };
  const jobs = await prisma.runJob.findMany({
    where: { runId: { in: plans.map((p) => p.id) } },
    select: { id: true, runId: true, status: true, createdAt: true, startedAt: true },
  });
  let repaired = 0;
  for (const p of plans) {
    const current = p.currentJobId ? (jobs.find((j) => j.id === p.currentJobId) ?? null) : null;
    const otherActive = jobs.some((j) => j.runId === p.id && isActiveJob(j.status));
    const state = stuckPlanState(p, current, otherActive, false, now);
    if (!state || state.kind === 'JOB_LOST') continue;
    if (state.kind === 'NO_JOB' && now.getTime() - p.createdAt.getTime() < STUCK_PLAN_GRACE_MS) continue;
    try {
      if (await repairEndedJobPlan(p.tenantId, p.id, { userId: null, via: 'JANITOR' })) repaired++;
    } catch (err) {
      console.error('repairStuckPlans: failed to repair', p.id, err);
    }
  }
  return { repaired };
}
