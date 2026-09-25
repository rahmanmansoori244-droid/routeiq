/**
 * Database locks for plan versions (review F06 / F07). Only database locks are reliable: a Railway
 * deploy briefly runs two web processes, so the in-memory in-flight map is no mutual exclusion.
 *
 * Lock order, everywhere: the day lock (advisory), then the RunPlan row (FOR UPDATE), then its
 * PlanLoad rows. The intake lock (lockIntake), taken only by the optimize start, comes before the
 * RunPlan row. Nobody takes them in another order, so two mutators never deadlock.
 *
 * - lockPlanDay: one depot and delivery date. Taken by everything that creates a version
 *   (createInitialPlan, createNextVersion), so a day never gets two live plans.
 * - lockRunForWrite: the RunPlan row, re-read under the lock and checked. Taken first by every
 *   mutator of a version (applyScenario, choose-scenario, job finalization, load changes,
 *   the optimize start, the re-plan).
 * - setLockTimeout: a screen-facing transaction waits at most 5 s for a row lock (for example
 *   behind a plan being saved); it then answers 409 "Plan is being saved - retry" instead of 500.
 */
import { Prisma, type RunPlan, type RunStatus } from '@prisma/client';
import { PlanError } from './plan-errors';
import { isSupersededRun } from './plan-status';
import { isoOf } from './time';

type Tx = Prisma.TransactionClient;

/** Answer when a lock or the transaction timed out: nothing was changed. */
export const PLAN_BUSY_MESSAGE = 'Plan is being saved - retry in a moment.';

export class PlanBusyError extends PlanError {
  constructor(message = PLAN_BUSY_MESSAGE) {
    super(message, 409, { code: 'PLAN_BUSY' });
  }
}

/**
 * A finished optimization whose plan version moved on while it ran (another job took over, the
 * version was superseded or reaped): its result must not touch the plan.
 */
export class StaleJobError extends Error {
  constructor(public readonly reason: string) {
    super(`Stale result: ${reason}`);
    this.name = 'StaleJobError';
  }
}

/** Advisory lock for one depot and delivery date, held until the transaction ends. */
export async function lockPlanDay(tx: Tx, tenantId: string, depotId: string, runDate: Date | string): Promise<void> {
  const day = typeof runDate === 'string' ? runDate.slice(0, 10) : isoOf(runDate);
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`planday:${tenantId}|${depotId}|${day}`}, 0))`;
}

/** Row locks in this transaction wait at most `ms` (default 5 s), then fail with SQLSTATE 55P03. */
export async function setLockTimeout(tx: Tx, ms = 5_000): Promise<void> {
  // SET does not take bind parameters; the value is a validated integer.
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.round(ms))}ms'`);
}

/**
 * True for a lock or transaction timeout: SQLSTATE 55P03 (lock_timeout), Prisma P2028 (the
 * interactive transaction could not start within maxWait, or ran past its timeout), P2034 (write
 * conflict or deadlock) and 40P01 (deadlock). The caller answers 409 and the user retries.
 */
export function isLockBusy(e: unknown): boolean {
  const err = e as { code?: unknown; meta?: { code?: unknown; message?: unknown }; message?: unknown } | null;
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'P2028' || err.code === 'P2034') return true;
  const meta = err.meta?.code;
  if (meta === '55P03' || meta === '40P01') return true;
  const text = `${typeof err.message === 'string' ? err.message : ''} ${typeof err.meta?.message === 'string' ? err.meta.message : ''}`;
  return /55P03|40P01|lock timeout|canceling statement due to lock timeout|deadlock detected/i.test(text);
}

/** Rethrow a lock or transaction timeout as PlanBusyError (409); anything else unchanged. */
export function asPlanBusy(e: unknown): unknown {
  return isLockBusy(e) ? new PlanBusyError() : e;
}

export interface LockRunOptions {
  /** Statuses the caller may act on (checked after superseded / optimizing). */
  allow?: readonly RunStatus[];
  /** Called by the background job: the version must be OPTIMIZING with this job as current. */
  jobId?: string;
  /** Message for a version that is optimizing (default: wait for it). */
  optimizingMessage?: string;
  /** Return an OPTIMIZING version instead of refusing it (the caller answers with its job). */
  allowOptimizing?: boolean;
}

/**
 * Lock one plan version for writing: SELECT ... FOR UPDATE, then re-read it under the lock and
 * check it may still be changed:
 * - a superseded version (status SUPERSEDED or supersededAt set) is refused (409);
 * - an OPTIMIZING version is refused (409) unless the caller is its current job;
 * - a job caller whose version is no longer OPTIMIZING with it as current gets StaleJobError;
 * - `allow` limits the other statuses.
 */
export async function lockRunForWrite(tx: Tx, tenantId: string, runId: string, opts: LockRunOptions = {}): Promise<RunPlan> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "RunPlan" WHERE id = ${runId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  if (!rows.length) {
    if (opts.jobId) throw new StaleJobError('the plan version no longer exists');
    throw new PlanError('Plan not found.', 404);
  }
  const run = await tx.runPlan.findFirstOrThrow({ where: { id: runId, tenantId } });
  if (opts.jobId) {
    if (isSupersededRun(run)) throw new StaleJobError('the plan version was superseded');
    if (run.status !== 'OPTIMIZING' || run.currentJobId !== opts.jobId) {
      throw new StaleJobError(`the plan version is ${run.status} and its current job is ${run.currentJobId ?? 'none'}`);
    }
    return run;
  }
  if (isSupersededRun(run)) throw new PlanError('This plan version was superseded by a newer version. Open the latest version.', 409, { code: 'SUPERSEDED' });
  if (run.status === 'OPTIMIZING') {
    if (opts.allowOptimizing) return run;
    throw new PlanError(opts.optimizingMessage ?? 'Wait for the running optimization to finish.', 409, { code: 'OPTIMIZING' });
  }
  if (opts.allow && !opts.allow.includes(run.status)) {
    throw new PlanError(`This plan version is ${run.status} and cannot be changed this way.`, 409, { code: 'PLAN_STATUS' });
  }
  return run;
}
