/**
 * Background optimize for the NMWC dispatch planner. Same RunJob pattern as the legacy job
 * (202 + polling), sharing its in-flight registry. On success every scenario is stored and
 * the RECOMMENDED plan is applied immediately; alternatives stay available for comparison and
 * are only used if the dispatcher explicitly picks one.
 *
 * Finalization is guarded (review F07 / ADD-JOB-AUDIT):
 * - the result is saved in ONE transaction that first locks the plan row and checks the version
 *   is still OPTIMIZING with this job as its current job, and the job still RUNNING. Otherwise
 *   the result is stale (the version was superseded, reaped by the janitor, or another job took
 *   over): the job is marked FAILED "stale result" and the plan is left untouched;
 * - the OPTIMIZE_SUCCEEDED audit row is written in that same transaction, so a saved plan can
 *   never be marked FAILED afterwards by an audit error;
 * - failJob only fails a job that is still QUEUED or RUNNING, and only moves the plan to FAILED
 *   while it is OPTIMIZING with this job as current: it never overwrites READY or SUPERSEDED.
 */
import { prisma } from '../db';
import { audit } from '../audit';
import { callDispatchSolver, SolverError } from '../solver-client';
import { trackInflight, whenIdle } from './optimize-job';
import { applyScenario, persistDispatchResult, type BuiltRequest } from '../dispatch/plan-service';
import { lockRunForWrite, StaleJobError } from '../dispatch/plan-locks';
import type { SolveTicket } from '../dispatch/solve-admission';

export interface DispatchJobArgs {
  runId: string;
  runJobId: string;
  tenantId: string;
  userId: string;
  ip: string | null;
  built: BuiltRequest;
  /** Solve admission: the job waits for its slot, and gives it back when it ends. */
  ticket?: SolveTicket;
}

/**
 * Run the job in the background (not awaited by the caller). The admission ticket is released
 * when the job ends, whatever the outcome.
 */
export function scheduleDispatchOptimize(args: DispatchJobArgs): boolean {
  const start = () =>
    runJob(args)
      .catch((err) => failJob(args, err))
      .finally(() => args.ticket?.release());
  if (trackInflight(args.runId, start)) return true;
  // The previous job of this version is still finishing (its promise leaves the in-flight map a
  // moment after its commit): start right after it instead of leaving this job QUEUED.
  void whenIdle(args.runId).then(() => scheduleDispatchOptimize(args));
  return false;
}

/** Saved result and final job message, or why nothing was saved. */
async function runJob(args: DispatchJobArgs) {
  const { runId, runJobId, tenantId, userId, built } = args;
  // Queued behind other solves (solve admission): wait for a free slot.
  if (args.ticket?.waiting) await args.ticket.ready();
  const started = await prisma.runJob.updateMany({
    where: { id: runJobId, status: 'QUEUED' },
    data: { status: 'RUNNING', startedAt: new Date(), progressPct: 20, message: `Optimizing ${built.request.stops.length} stops` },
  });
  if (started.count !== 1) {
    console.warn('dispatch optimize: job no longer QUEUED, not started', { runId, runJobId });
    return;
  }
  let resp;
  try {
    resp = await callDispatchSolver(built.request);
  } catch (err) {
    throw err instanceof SolverError ? err : new SolverError(`Solver call failed: ${(err as Error).message}`, 0, null);
  }
  if (!resp.scenarios?.length) throw new SolverError('Solver returned no scenarios.', 200, resp);
  await prisma.runJob.updateMany({ where: { id: runJobId, status: 'RUNNING' }, data: { progressPct: 80, message: 'Saving plan', responseJson: resp as never } });

  const recommended = resp.scenarios.find((s) => s.name === 'RECOMMENDED') ?? resp.scenarios[0];
  try {
    await prisma.$transaction(
      async (tx) => {
        // The plan row first (lock order: RunPlan, then its loads), then every check on it.
        const run = await lockRunForWrite(tx, tenantId, runId, { jobId: runJobId });
        const job = await tx.runJob.findUnique({ where: { id: runJobId }, select: { status: true } });
        if (job?.status !== 'RUNNING') throw new StaleJobError(`the job is ${job?.status ?? 'gone'}`);
        // A version that already holds a plan (a re-plan's copy of the previous plan) keeps it
        // when the optimizer found no plan at all this time: that is a failed re-plan.
        if (recommended.status === 'NO_SOLUTION' && run.chosenScenarioId) {
          throw new SolverError(
            `The optimizer found no feasible plan this time (${recommended.solver_status || 'no solution'}). The previous plan is kept - try again, or check trucks and customer hours.`,
            200,
            null,
          );
        }
        const ids = await persistDispatchResult(tx, tenantId, runId, built, resp);
        await applyScenario(tx, tenantId, runId, ids.get(recommended.name)!, userId, { jobId: runJobId });
        const done = await tx.runJob.updateMany({
          where: { id: runJobId, status: 'RUNNING' },
          data: {
            status: 'SUCCEEDED',
            progressPct: 100,
            finishedAt: new Date(),
            message: `${recommended.trips} loads on ${recommended.trucks_used} trucks, ${recommended.unserved.length + built.preDrops.length} stop(s) unserved`,
          },
        });
        if (done.count !== 1) throw new StaleJobError('the job changed while its plan was being saved');
        // In the transaction: the saved plan and its audit row commit together.
        await audit(
          {
            tenantId,
            userId,
            action: 'OPTIMIZE_SUCCEEDED',
            entity: 'RunPlan',
            entityId: runId,
            afterJson: {
              runJobId,
              engine: resp.engine,
              provider: resp.matrix_provider,
              estimated: resp.distance_is_estimated,
              scenarios: resp.scenarios.map((s) => ({ name: s.name, status: s.solver_status, loads: s.trips, km: s.total_distance_km, unserved: s.unserved.length, sec: s.solver_time_sec })),
            } as never,
            ip: args.ip,
          },
          tx,
        );
      },
      { timeout: 120_000, maxWait: 15_000 },
    );
  } catch (e) {
    if (e instanceof StaleJobError) {
      await markStale(args, e);
      return;
    }
    throw e;
  }
}

/** A result for a version that moved on: the job fails as "stale result", the plan is not touched. */
async function markStale(args: DispatchJobArgs, e: StaleJobError) {
  console.warn('dispatch optimize: stale result not applied', { runId: args.runId, runJobId: args.runJobId, reason: e.reason });
  try {
    const n = await prisma.runJob.updateMany({
      where: { id: args.runJobId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        message: 'Stale result: the plan changed while this optimization ran, so nothing was applied.',
        errorJson: { reason: 'STALE_RESULT', message: e.reason } as never,
      },
    });
    if (n.count) {
      await audit({
        tenantId: args.tenantId,
        userId: args.userId,
        action: 'OPTIMIZE_FAILED',
        entity: 'RunPlan',
        entityId: args.runId,
        afterJson: { runJobId: args.runJobId, errorJson: { reason: 'STALE_RESULT', message: e.reason } } as never,
        ip: args.ip,
      });
    }
  } catch (writeErr) {
    console.error('dispatch markStale: could not record the stale result', writeErr);
  }
}

export async function failJob(args: DispatchJobArgs, err: unknown) {
  const errorJson =
    err instanceof SolverError
      ? { reason: 'SOLVER_ERROR', message: err.message, status: err.status, responseBody: err.responseBody }
      : { reason: 'UNKNOWN', message: (err as Error)?.message ?? String(err) };
  console.error('dispatch optimize failed', errorJson);
  try {
    const changed = await prisma.$transaction(async (tx) => {
      // Only a job still in progress fails; only its own OPTIMIZING version goes FAILED.
      const job = await tx.runJob.updateMany({
        where: { id: args.runJobId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'FAILED', message: String(errorJson.message).slice(0, 500), errorJson: errorJson as never, finishedAt: new Date() },
      });
      const plan = await tx.runPlan.updateMany({
        where: { id: args.runId, tenantId: args.tenantId, status: 'OPTIMIZING', currentJobId: args.runJobId },
        data: { status: 'FAILED' },
      });
      return { job: job.count, plan: plan.count };
    });
    if (!changed.job && !changed.plan) return;
    await audit({
      tenantId: args.tenantId,
      userId: args.userId,
      action: 'OPTIMIZE_FAILED',
      entity: 'RunPlan',
      entityId: args.runId,
      afterJson: { runJobId: args.runJobId, errorJson } as never,
      ip: args.ip,
    });
  } catch (writeErr) {
    console.error('dispatch failJob: could not record failure', writeErr);
  }
}
