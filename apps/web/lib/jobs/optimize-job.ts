/**
 * RunJob orchestration — CLAUDE.md §7 mandates this exact pattern.
 *
 * One in-process inflight map keyed by runId prevents duplicate concurrent
 * solver calls. The optimize API route writes the RunJob row, calls
 * `scheduleOptimize(runId, runJobId)`, and returns 202 immediately. The
 * actual solver call runs in the background and updates the row when done.
 *
 * **Hard rule (CLAUDE.md §7):** the web Node process is the only place that
 * calls the solver, and the deployment MUST be exactly one Railway replica.
 * Horizontal scaling without Redis-backed locking is forbidden in v1.
 */
import { prisma } from '../db';
import { tenantDb } from '../tenant';
import { audit } from '../audit';
import { callSolver, SolverError } from '../solver-client';
import type {
  OptimizeRequest,
  OptimizeResponse,
  OptimizationScenarioName,
} from '@routeiq/shared-types';

const inflight = new Map<string, Promise<void>>();

export interface ScheduleArgs {
  runId: string;
  runJobId: string;
  tenantId: string;
  userId: string;
  ip: string | null;
  solverPayload: OptimizeRequest;
}

export function scheduleOptimize(args: ScheduleArgs): void {
  if (inflight.has(args.runId)) return;
  const p = runOptimizeJob(args)
    .catch((err) => failJob(args, err))
    .finally(() => {
      inflight.delete(args.runId);
    });
  inflight.set(args.runId, p);
}

export function isOptimizing(runId: string): boolean {
  return inflight.has(runId);
}

async function runOptimizeJob(args: ScheduleArgs): Promise<void> {
  const { runId, runJobId } = args;
  await prisma.runJob.update({
    where: { id: runJobId },
    data: { status: 'RUNNING', startedAt: new Date(), progressPct: 25, message: 'Calling solver' },
  });

  let response: OptimizeResponse;
  try {
    response = await callSolver(args.solverPayload);
  } catch (err) {
    throw err instanceof SolverError
      ? err
      : new SolverError(`Solver call failed: ${(err as Error).message}`, 0, null);
  }

  await prisma.runJob.update({
    where: { id: runJobId },
    data: { progressPct: 75, message: 'Persisting scenarios', responseJson: response as never },
  });

  // Persist scenarios in a transaction with the parent run status flip.
  await prisma.$transaction(async (tx) => {
    // Wipe any prior scenarios for this run (retries replace earlier results).
    await tx.scenarioResult.deleteMany({ where: { runId } });

    for (const s of response.scenarios) {
      const totalCount = s.unserved_orders.length;
      await tx.scenarioResult.create({
        data: {
          runId,
          name: s.name,
          trucksUsed: s.trucks_used,
          totalDistanceKm: s.total_distance_km,
          totalTimeMin: s.total_time_min,
          totalCost: s.total_cost,
          avgUtilizationPct: s.avg_utilization_pct,
          unservedCount: totalCount,
          detailsJson: s as never,
          unservedOrders: {
            create: s.unserved_orders.map((u) => ({
              orderId: u.order_id,
              reasonCode: u.reason_code,
              reasonMessage: u.reason_message ?? null,
            })),
          },
        },
      });
    }

    await tx.runPlan.update({
      where: { id: runId },
      data: { status: 'READY' },
    });

    await tx.runJob.update({
      where: { id: runJobId },
      data: {
        status: 'SUCCEEDED',
        progressPct: 100,
        message: `Returned ${response.scenarios.length} scenarios`,
        finishedAt: new Date(),
      },
    });
  });

  await audit({
    tenantId: args.tenantId,
    userId: args.userId,
    action: 'OPTIMIZE_SUCCEEDED',
    entity: 'RunPlan',
    entityId: runId,
    afterJson: {
      runJobId,
      scenarios: response.scenarios.map((s: { name: OptimizationScenarioName; trucks_used: number; total_distance_km: number; unserved_orders: unknown[] }) => ({
        name: s.name,
        trucksUsed: s.trucks_used,
        distanceKm: s.total_distance_km,
        unservedCount: s.unserved_orders.length,
      })),
      warnings: response.warnings,
    } as never,
    ip: args.ip,
  });
}

async function failJob(args: ScheduleArgs, err: unknown): Promise<void> {
  const errorJson =
    err instanceof SolverError
      ? { reason: 'SOLVER_ERROR', message: err.message, status: err.status, responseBody: err.responseBody }
      : { reason: 'UNKNOWN', message: (err as Error)?.message ?? String(err) };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.runJob.update({
        where: { id: args.runJobId },
        data: {
          status: 'FAILED',
          message: typeof errorJson.message === 'string' ? errorJson.message : 'Solver call failed',
          errorJson: errorJson as never,
          finishedAt: new Date(),
        },
      });
      await tx.runPlan.update({
        where: { id: args.runId },
        data: { status: 'FAILED' },
      });
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
    console.error('failJob: failed to record failure', writeErr);
  }
}

/**
 * Orphan janitor — mark RUNNING jobs older than 5 minutes as FAILED with
 * reason STUCK. Called from the cron route every 60s.
 */
export async function reapStuckJobs(thresholdMs = 5 * 60 * 1000): Promise<{ reaped: number }> {
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
    }>
  >(
    // Both sides are computed Postgres-side so the comparison stays in the
    // server's session timezone. (Prisma converts JS Dates to local-time
    // TIMESTAMPs when writing, so NOW() — also local — matches them. See
    // feedback_db_gotchas memory for context.)
    `SELECT id, "runId", "tenantId", "createdById", "attemptNo"
     FROM "RunJob"
     WHERE status = 'RUNNING'
       AND "startedAt" IS NOT NULL
       AND "startedAt" < NOW() - ($1::int || ' minutes')::interval`,
    minutes,
  );
  if (stuck.length === 0) return { reaped: 0 };

  for (const job of stuck) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.runJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            message: 'Stuck > 5 minutes — janitor failed it.',
            errorJson: { reason: 'STUCK', message: 'Job exceeded the 5-minute running threshold.' } as never,
          },
        });
        await tx.runPlan.update({
          where: { id: job.runId },
          data: { status: 'FAILED' },
        });
      });
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
    // Clear inflight tracking so a retry can spawn a fresh promise.
    inflight.delete(job.runId);
  }
  return { reaped: stuck.length };
}

export interface LockedAssignment {
  assignmentId: string;
  orderId: string;
  truckId: string;
  sequenceInTruck: number;
  cases: number;
  lockedByUserId: string;
  manualOverrideReason: string | null;
  // Captured so the merger in choose-scenario can preserve the planner's intent.
  plannedArrivalMin: number;
  plannedDistanceFromPrevKm: number;
  plannedLoadCases: number;
}

export interface BuiltPayload {
  payload: OptimizeRequest;
  lockedAssignments: LockedAssignment[];
}

/**
 * Build the solver payload, optionally respecting locked stops.
 *
 * When `respectLocks` is true:
 *  - Locked stops are EXCLUDED from `stops` (solver doesn't know about them)
 *  - Each truck's `capacity_cases` is reduced by the sum of locked cases on it
 *  - Locked stops are returned alongside so `choose-scenario` can re-merge
 *
 * v1 limitation: locked stop geography doesn't influence routing of the
 * remaining stops — the solver routes around an empty depot-stops-depot tour.
 * v2 should pre-seed initial routes via ReadAssignmentFromRoutes for true
 * lock-aware optimization.
 */
export async function buildSolverPayload(
  tenantId: string,
  runId: string,
  scenarioRequests: OptimizationScenarioName[] = ['MIN_TRUCKS', 'MIN_DISTANCE', 'BALANCED'],
  options: { respectLocks?: boolean } = {},
): Promise<BuiltPayload> {
  const db = tenantDb(tenantId);
  const run = await db.runPlan.findUniqueOrThrow({
    where: { id: runId },
    include: { depot: true },
  });

  const config = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } });
  const trucks = await db.truck.findMany({
    where: { active: true, depotId: run.depotId },
    select: {
      id: true,
      code: true,
      capacityCases: true,
      capacityWeightKg: true,
      fixedCostPerDay: true,
      costPerKm: true,
    },
  });
  const orders = await db.order.findMany({
    where: { deliveryDate: run.runDate },
    include: { customer: true },
  });

  // Optional: pull locked assignments and trim payload accordingly.
  let lockedAssignments: LockedAssignment[] = [];
  let excludedOrderIds = new Set<string>();
  const lockedLoadByTruck = new Map<string, number>();
  if (options.respectLocks) {
    const locked = await db.routeAssignment.findMany({
      where: { runId, lockedByUserId: { not: null } },
      include: { order: { select: { id: true, totalCases: true } } },
    });
    for (const l of locked) {
      lockedAssignments.push({
        assignmentId: l.id,
        orderId: l.orderId,
        truckId: l.truckId,
        sequenceInTruck: l.sequenceInTruck,
        cases: l.order.totalCases,
        lockedByUserId: l.lockedByUserId!,
        manualOverrideReason: l.manualOverrideReason,
        plannedArrivalMin: l.plannedArrivalMin,
        plannedDistanceFromPrevKm: l.plannedDistanceFromPrevKm,
        plannedLoadCases: l.plannedLoadCases,
      });
      excludedOrderIds.add(l.orderId);
      lockedLoadByTruck.set(l.truckId, (lockedLoadByTruck.get(l.truckId) ?? 0) + l.order.totalCases);
    }
  }

  const payload: OptimizeRequest = {
    run_id: runId,
    tenant_id: tenantId,
    depot: { id: run.depot.id, lat: run.depot.lat, lng: run.depot.lng },
    trucks: trucks.map((t) => ({
      id: t.id,
      capacity_cases: Math.max(0, t.capacityCases - (lockedLoadByTruck.get(t.id) ?? 0)),
      capacity_weight_kg: t.capacityWeightKg,
      fixed_cost_per_day: t.fixedCostPerDay,
      cost_per_km: t.costPerKm,
    })),
    stops: orders
      .filter((o) => !excludedOrderIds.has(o.id))
      .map((o) => ({
        order_id: o.id,
        customer_id: o.customerId,
        lat: o.customer.lat ?? 0,
        lng: o.customer.lng ?? 0,
        demand_cases: o.totalCases,
        demand_weight_kg: o.totalWeightKg,
        service_time_min: o.totalServiceTimeMin,
        priority: o.priority,
      })),
    config: {
      avg_speed_kmh: config.avgSpeedKmh,
      distance_provider: config.distanceProvider,
      distance_multiplier: config.distanceMultiplier,
      driver_shift_max_min: config.driverShiftMaxMinutes,
      return_to_depot: config.returnToDepot,
      solver_time_limit_sec: config.solverTimeLimitSeconds,
      scenarios_requested: scenarioRequests,
      max_utilization_mode: run.optimizationMode === 'MAX_UTILIZATION',
    },
  };

  return { payload, lockedAssignments };
}
