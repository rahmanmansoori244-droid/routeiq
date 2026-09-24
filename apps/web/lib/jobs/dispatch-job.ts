/**
 * Background optimize for the NMWC dispatch planner. Same RunJob pattern as the legacy job
 * (202 + polling), sharing its in-flight registry. On success every scenario is stored and
 * the RECOMMENDED plan is applied immediately; alternatives stay available for comparison and
 * are only used if the dispatcher explicitly picks one.
 */
import { prisma } from '../db';
import { audit } from '../audit';
import { callDispatchSolver, SolverError } from '../solver-client';
import { trackInflight } from './optimize-job';
import { applyScenario, persistDispatchResult, type BuiltRequest } from '../dispatch/plan-service';

export interface DispatchJobArgs {
  runId: string;
  runJobId: string;
  tenantId: string;
  userId: string;
  ip: string | null;
  built: BuiltRequest;
}

export function scheduleDispatchOptimize(args: DispatchJobArgs): boolean {
  return trackInflight(args.runId, () => runJob(args).catch((err) => failJob(args, err)));
}

async function runJob(args: DispatchJobArgs) {
  const { runId, runJobId, tenantId, userId, built } = args;
  await prisma.runJob.update({
    where: { id: runJobId },
    data: { status: 'RUNNING', startedAt: new Date(), progressPct: 20, message: `Optimizing ${built.request.stops.length} stops` },
  });
  let resp;
  try {
    resp = await callDispatchSolver(built.request);
  } catch (err) {
    throw err instanceof SolverError ? err : new SolverError(`Solver call failed: ${(err as Error).message}`, 0, null);
  }
  if (!resp.scenarios?.length) throw new SolverError('Solver returned no scenarios.', 200, resp);
  await prisma.runJob.update({ where: { id: runJobId }, data: { progressPct: 80, message: 'Saving plan', responseJson: resp as never } });

  const recommended = resp.scenarios.find((s) => s.name === 'RECOMMENDED') ?? resp.scenarios[0];
  await prisma.$transaction(
    async (tx) => {
      const ids = await persistDispatchResult(tx, tenantId, runId, built, resp);
      await tx.runPlan.update({ where: { id: runId }, data: { status: 'READY' } });
      await applyScenario(tx, tenantId, runId, ids.get(recommended.name)!, userId);
      await tx.runJob.update({
        where: { id: runJobId },
        data: {
          status: 'SUCCEEDED',
          progressPct: 100,
          finishedAt: new Date(),
          message: `${recommended.trips} loads on ${recommended.trucks_used} trucks, ${recommended.unserved.length + built.preDrops.length} stop(s) unserved`,
        },
      });
    },
    { timeout: 120_000, maxWait: 15_000 },
  );
  await audit({
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
  });
}

async function failJob(args: DispatchJobArgs, err: unknown) {
  const errorJson =
    err instanceof SolverError
      ? { reason: 'SOLVER_ERROR', message: err.message, status: err.status, responseBody: err.responseBody }
      : { reason: 'UNKNOWN', message: (err as Error)?.message ?? String(err) };
  console.error('dispatch optimize failed', errorJson);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.runJob.update({
        where: { id: args.runJobId },
        data: { status: 'FAILED', message: String(errorJson.message).slice(0, 500), errorJson: errorJson as never, finishedAt: new Date() },
      });
      await tx.runPlan.update({ where: { id: args.runId }, data: { status: 'FAILED' } });
    });
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
