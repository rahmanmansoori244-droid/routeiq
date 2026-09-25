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

/** Longer than any job can legitimately run: the dispatch solver call (10 min max) plus saving the plan. */
export const STUCK_JOB_MS = 15 * 60 * 1000;

/**
 * Orphan janitor — mark jobs RUNNING (or never started) for longer than any real optimization
 * as FAILED with reason STUCK, and put their plan back to FAILED so it can be optimized again.
 * Runs every 60 s inside the web process (instrumentation.ts) and from the cron route.
 */
export async function reapStuckJobs(thresholdMs = STUCK_JOB_MS): Promise<{ reaped: number }> {
  // We use a Postgres-side NOW() comparison instead of passing a JS Date,
  // because RunJob.startedAt is a TIMESTAMP (no time zone) column — comparing
  // it against a JS Date via Prisma's serialized ISO string would mis-match
  // by however many hours separate the server's clock from UTC.
  const minutes = Math.max(1, Math.round(thresholdMs / 60000));
  const stuck = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      runId: string;
      tenantId: string;
      createdById: string;
      attemptNo: number;
      status: 'RUNNING' | 'QUEUED';
    }>
  >(
    // Both sides are computed Postgres-side so the comparison stays in the
    // server's session timezone. (Prisma converts JS Dates to local-time
    // TIMESTAMPs when writing, so NOW() — also local — matches them. See
    // feedback_db_gotchas memory for context.)
    // A QUEUED row normally turns RUNNING within milliseconds; one that stays QUEUED lost its
    // process between creating the job and starting it.
    `SELECT id, "runId", "tenantId", "createdById", "attemptNo", status::text AS status
     FROM "RunJob"
     WHERE (status = 'RUNNING' AND "startedAt" IS NOT NULL AND "startedAt" < NOW() - ($1::int || ' minutes')::interval)
        OR (status = 'QUEUED' AND "createdAt" < NOW() - ($1::int || ' minutes')::interval)`,
    minutes,
  );
  if (stuck.length === 0) return { reaped: 0 };

  let reaped = 0;
  for (const job of stuck) {
    // Skip jobs whose background promise is still tracked in-process. The
    // janitor is conservative: only DB rows with no live promise (i.e. the
    // process restarted and lost the inflight map) need cleanup. Failing a
    // job that's still running would race the success path and corrupt
    // RunPlan.status.
    if (inflight.has(job.runId)) continue;
    try {
      // Conditional update so we don't FAIL a job that just succeeded
      // between the SELECT and the UPDATE.
      const flipped = await prisma.runJob.updateMany({
        where: { id: job.id, status: job.status },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          message: `No result after ${minutes} minutes (the server restarted during the optimization). Optimize again.`,
          errorJson: { reason: 'STUCK', message: `Job ${job.status} for more than ${minutes} minutes.` } as never,
        },
      });
      if (flipped.count === 0) continue;
      // Only the version this job was optimizing (review F07): never a version another job
      // took over. A version that a re-plan copied forward keeps its copied plan, usable.
      await prisma.runPlan.updateMany({
        where: { id: job.runId, status: 'OPTIMIZING', OR: [{ currentJobId: job.id }, { currentJobId: null }] },
        data: { status: 'FAILED' },
      });
      reaped++;
      await audit({
        tenantId: job.tenantId,
        userId: job.createdById,
        action: 'OPTIMIZE_FAILED',
        entity: 'RunPlan',
        entityId: job.runId,
        afterJson: { runJobId: job.id, attemptNo: job.attemptNo, reason: 'STUCK' } as never,
      });
    } catch (err) {
      console.error('reapStuckJobs: failed to reap', job.id, err);
    }
  }
  return { reaped };
}
