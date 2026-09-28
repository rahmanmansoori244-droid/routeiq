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
 * - weights taken from the product master (BuiltRequest.weightChanges) are saved on the orders in
 *   that same transaction too, never earlier: a failed optimization leaves order kg as they were;
 * - failJob only fails a job that is still QUEUED or RUNNING, and only moves the plan to FAILED
 *   while it is OPTIMIZING with this job as current: it never overwrites READY or SUPERSEDED. The
 *   job, the plan and the OPTIMIZE_FAILED audit row commit in ONE transaction (audit F09).
 */
import { prisma } from '../db';
import { audit } from '../audit';
import { callDispatchSolver, SolverError } from '../solver-client';
import { trackInflight, whenIdle } from './optimize-job';
import { applyScenario, applyWeightChanges, persistDispatchResult, type BuiltRequest } from '../dispatch/plan-service';
import { lockPlanRow, lockRunForWrite, StaleJobError } from '../dispatch/plan-locks';
import { isPlanFoundStatus, solverStatusText } from '../dispatch/solver-status';
import { frozenOfRequest, physicalTruckCount } from '../dispatch/plan-options';
import type { SolveTicket } from '../dispatch/solve-admission';
import type { DispatchScenario } from '@routeiq/shared-types';

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
          // The search's own code in plain words, never the raw OR-Tools name.
          const why = recommended.solver_status && !isPlanFoundStatus(recommended.solver_status) ? ` (${solverStatusText(recommended.solver_status, 'short')})` : '';
          throw new SolverError(
            `The optimizer found no feasible plan this time${why}. The previous plan is kept - try again, or check trucks and customer hours.`,
            200,
            null,
          );
        }
        // Weights the request took from the product master are saved on the orders now, with the
        // plan that uses them (audited; each row only if it still has the kg the request was built
        // from). A failed or stale optimization therefore changes no order kg under the plan still
        // in use - a re-plan's copied loads keep matching their orders, and the "planned with the
        // old weight" warning stays until a plan with the new weight is applied.
        await applyWeightChanges(tx, tenantId, runId, built.weightChanges, userId);
        const ids = await persistDispatchResult(tx, tenantId, runId, built, resp, { jobId: runJobId });
        const { driverChanges } = await applyScenario(tx, tenantId, runId, ids.get(recommended.name)!, userId, { jobId: runJobId });
        // PR7 (B3): the kept loads the plan was made around, counted like the plan screen does -
        // from the version's rows, so a truck deactivated after its load went out (not in the
        // request) still counts. A request without the list (older callers) uses its frozen trips.
        const keptIds = built.scope.frozenLoadIds;
        const keptRows = keptIds?.length ? await tx.planLoad.findMany({ where: { runId, id: { in: keptIds } }, select: { truckId: true } }) : [];
        const kept = keptIds ? { truckIds: [...new Set(keptRows.map((l) => l.truckId))], loads: keptRows.length } : frozenOfRequest(built.request.trucks);
        const done = await tx.runJob.updateMany({
          where: { id: runJobId, status: 'RUNNING' },
          data: {
            status: 'SUCCEEDED',
            progressPct: 100,
            finishedAt: new Date(),
            // The plan's driver notes (a trip that lost or changed its driver, a hand-set driver whose
            // trip the plan does not have) are counted in the message: never silent.
            message: jobMessage(recommended, built.preDrops.length, driverChanges.length, kept),
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
              scenarios: resp.scenarios.map((s) => ({
                name: s.name,
                status: s.solver_status,
                loads: s.trips,
                km: s.total_distance_km,
                unserved: s.unserved.length,
                sec: s.solver_time_sec,
                // Review F04: whether the optimizer's own check passed the timetable.
                feasibility: s.feasibility
                  ? { status: s.feasibility.status, timing: s.feasibility.timing, violations: s.feasibility.violations.length, codes: [...new Set(s.feasibility.violations.map((v) => v.code))] }
                  : { status: 'UNKNOWN' },
              })),
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

/**
 * The job's closing message: loads, trucks, unserved stops, the plan's driver notes (PR3) and,
 * when the recommended timetable did not pass the optimizer's own check (review F04), that it
 * is not verified: such a plan is shown for review but its trucks cannot be locked or
 * dispatched until it is re-planned.
 *
 * `frozen`: the locked, loading and dispatched loads the plan was made around (their trucks and
 * count). The trucks are then the day's physical trucks, those loads' trucks included, and
 * the loads are "N new + M kept" (PR7, B3: "10 loads on 6 trucks" when the day used 7).
 */
export function jobMessage(sc: DispatchScenario, preDrops: number, driverNotes = 0, frozen?: { truckIds: string[]; loads: number }): string {
  const drivers = driverNotes ? `, ${driverNotes} driver note(s) (see the plan)` : '';
  const kept = frozen?.loads ?? 0;
  const trucks = kept && Array.isArray(sc.loads) ? physicalTruckCount(sc.loads, frozen!.truckIds) : sc.trucks_used;
  const loads = kept ? `${sc.trips} new loads + ${kept} kept (locked or dispatched)` : `${sc.trips} loads`;
  const base = `${loads} on ${trucks} trucks, ${sc.unserved.length + preDrops} stop(s) unserved${drivers}`;
  const f = sc.feasibility;
  if (!f) return `${base}. Timetable not checked by the optimizer (older optimizer version).`;
  if (f.status === 'VERIFIED') return base;
  const n = f.violations.length;
  return f.status === 'VIOLATED'
    ? `${base}. Timetable NOT verified: ${n} rule(s) broken (${[...new Set(f.violations.map((v) => v.code))].join(', ')}) - re-plan before locking.`
    : `${base}. Timetable NOT verified: the optimizer could not check it - re-plan before locking.`;
}

/** A failure write waits this long for the plan row (a plan being saved holds it); then it gives up. */
const FAIL_TX = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * A result for a version that moved on: the job fails as "stale result", the plan is not touched.
 * The job and its OPTIMIZE_FAILED audit row commit together (audit F09).
 */
async function markStale(args: DispatchJobArgs, e: StaleJobError) {
  console.warn('dispatch optimize: stale result not applied', { runId: args.runId, runJobId: args.runJobId, reason: e.reason });
  try {
    await prisma.$transaction(async (tx) => {
      const n = await tx.runJob.updateMany({
        where: { id: args.runJobId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          message: 'Stale result: the plan changed while this optimization ran, so nothing was applied.',
          errorJson: { reason: 'STALE_RESULT', message: e.reason } as never,
        },
      });
      if (!n.count) return;
      await audit(
        {
          tenantId: args.tenantId,
          userId: args.userId,
          action: 'OPTIMIZE_FAILED',
          entity: 'RunPlan',
          entityId: args.runId,
          afterJson: { runJobId: args.runJobId, errorJson: { reason: 'STALE_RESULT', message: e.reason } } as never,
          ip: args.ip,
        },
        tx,
      );
    }, FAIL_TX);
  } catch (writeErr) {
    // Nothing was written: the job stays RUNNING and the janitor fails it after 15 minutes.
    console.error('dispatch markStale: could not record the stale result', writeErr);
  }
}

/**
 * A job that failed (solver error, no plan found, an error while saving). Audit F09: ONE
 * transaction under the plan row lock (the order every plan writer uses: plan, then its job) -
 * the job FAILED (only while still QUEUED or RUNNING), its plan FAILED (only while OPTIMIZING with
 * this job as current: never over READY or SUPERSEDED) and the OPTIMIZE_FAILED audit row commit
 * together or not at all. If this write itself fails, nothing changed: the job is still in
 * progress in the database with no live process, and the janitor fails job and plan together
 * 15 minutes after it started (or a supervisor resets the plan) - a plan is never left OPTIMIZING
 * behind an ended job.
 */
export async function failJob(args: DispatchJobArgs, err: unknown) {
  const errorJson =
    err instanceof SolverError
      ? { reason: 'SOLVER_ERROR', message: err.message, status: err.status, responseBody: err.responseBody }
      : { reason: 'UNKNOWN', message: (err as Error)?.message ?? String(err) };
  console.error('dispatch optimize failed', errorJson);
  try {
    await prisma.$transaction(async (tx) => {
      await lockPlanRow(tx, args.tenantId, args.runId);
      // Only a job still in progress fails; only its own OPTIMIZING version goes FAILED.
      const job = await tx.runJob.updateMany({
        where: { id: args.runJobId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: { status: 'FAILED', message: String(errorJson.message).slice(0, 500), errorJson: errorJson as never, finishedAt: new Date() },
      });
      const plan = await tx.runPlan.updateMany({
        where: { id: args.runId, tenantId: args.tenantId, status: 'OPTIMIZING', currentJobId: args.runJobId },
        data: { status: 'FAILED' },
      });
      if (!job.count && !plan.count) return;
      await audit(
        {
          tenantId: args.tenantId,
          userId: args.userId,
          action: 'OPTIMIZE_FAILED',
          entity: 'RunPlan',
          entityId: args.runId,
          afterJson: { runJobId: args.runJobId, errorJson } as never,
          ip: args.ip,
        },
        tx,
      );
    }, FAIL_TX);
  } catch (writeErr) {
    console.error('dispatch failJob: could not record failure (nothing changed; the janitor fails the job and its plan later)', writeErr);
  }
}
