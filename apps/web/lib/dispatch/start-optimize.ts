import { prisma } from '../db';
import { audit } from '../audit';
import { isOptimizing } from '../jobs/optimize-job';
import { scheduleDispatchOptimize } from '../jobs/dispatch-job';
import { buildDispatchRequest, createNextVersion, isLegacyPlan, pendingLateOrderIds, PlanError, type BuiltRequest } from './plan-service';

export interface StartResult {
  status: number;
  body: Record<string, unknown>;
}

/** Plans from the previous optimizer keep their routes as they were: re-optimizing them in
 * place would delete their assignments (including locked stops and delivery proofs). */
const LEGACY_PLAN: StartResult = {
  status: 409,
  body: {
    error: 'This plan was made by the previous optimizer (before May 2026) and is kept exactly as it was. It cannot be re-optimized or re-planned.',
    code: 'LEGACY_PLAN',
  },
};

/**
 * Start an optimization for a plan version that has not been applied yet (DRAFT / FAILED /
 * READY-without-loads). An applied plan is never re-optimized in place: the caller must create
 * a new version (see `replan`), so every plan the dispatcher has seen stays traceable.
 */
export async function startDispatchOptimize(
  tenantId: string,
  runId: string,
  user: { id: string },
  ip: string | null,
  opts: { allowMissingLocations?: boolean; prebuilt?: BuiltRequest } = {},
): Promise<StartResult> {
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
  if (!run) return { status: 404, body: { error: 'Plan not found' } };
  if (run.status === 'SUPERSEDED') return { status: 409, body: { error: 'This plan version was superseded. Open the latest version.' } };
  if (await isLegacyPlan(tenantId, runId)) return LEGACY_PLAN;
  if (run.chosenScenarioId && run.status !== 'FAILED') {
    return { status: 409, body: { error: 'This plan is already in use. Re-plan to create a new version.', code: 'NEW_VERSION_REQUIRED' } };
  }
  const active = await prisma.runJob.findFirst({ where: { runId, status: { in: ['QUEUED', 'RUNNING'] } } });
  if (active || isOptimizing(runId)) {
    return { status: 202, body: { runJobId: active?.id ?? null, status: active?.status ?? 'RUNNING', runId } };
  }
  const built = opts.prebuilt ?? (await buildDispatchRequest(tenantId, runId));
  if (built.blocking.length && !opts.allowMissingLocations) {
    return {
      status: 409,
      body: {
        error: `${built.blocking.length} customer(s) need a location before optimizing.`,
        code: 'LOCATION_REQUIRED',
        blocking: built.blocking,
      },
    };
  }
  const orderCount = built.scope.orderIds.length;
  if (orderCount === 0) return { status: 400, body: { error: 'No new orders to plan for this depot and date. Upload orders first.' } };
  if (built.request.trucks.length === 0) return { status: 400, body: { error: 'No active trucks at this depot.' } };

  const last = await prisma.runJob.findFirst({ where: { runId }, orderBy: { attemptNo: 'desc' }, select: { attemptNo: true } });
  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.runJob.create({
      data: {
        tenantId,
        runId,
        attemptNo: (last?.attemptNo ?? 0) + 1,
        status: 'QUEUED',
        message: 'Queued',
        createdById: user.id,
        requestJson: built.request as never,
      },
    });
    await tx.runPlan.update({ where: { id: runId }, data: { status: 'OPTIMIZING', currentJobId: created.id } });
    return created;
  });
  await audit({
    tenantId,
    userId: user.id,
    action: 'OPTIMIZE_STARTED',
    entity: 'RunPlan',
    entityId: runId,
    afterJson: {
      runJobId: job.id,
      stops: built.request.stops.length,
      orders: orderCount,
      preDropped: built.preDrops.length,
      frozenOrders: built.scope.frozenOrderIds.length,
      trucks: built.request.trucks.length,
      allowMissingLocations: !!opts.allowMissingLocations,
    } as never,
    ip,
  });
  scheduleDispatchOptimize({ runId, runJobId: job.id, tenantId, userId: user.id, ip, built });
  return { status: 202, body: { runJobId: job.id, status: 'QUEUED', runId } };
}

/** Late order / re-plan: new version keeping frozen loads, then optimize the rest. */
export async function replan(
  tenantId: string,
  runId: string,
  reason: 'LATE_ORDER' | 'MANUAL_ADJUSTMENT' | 'REOPTIMIZE',
  note: string | null,
  user: { id: string },
  ip: string | null,
  allowMissingLocations = false,
): Promise<StartResult> {
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
  if (!run) return { status: 404, body: { error: 'Plan not found' } };
  // Checked before anything is superseded: a legacy parent must stay the live plan.
  if (await isLegacyPlan(tenantId, runId)) return LEGACY_PLAN;
  if (!run.chosenScenarioId) {
    // Nothing applied yet: optimizing this version again is still fully traceable.
    return startDispatchOptimize(tenantId, runId, user, ip, { allowMissingLocations });
  }
  // Check location blockers BEFORE creating a version (scope is the same minus frozen loads).
  const probe = await buildDispatchRequest(tenantId, runId);
  if (probe.blocking.length && !allowMissingLocations) {
    return {
      status: 409,
      body: { error: `${probe.blocking.length} customer(s) need a location before re-planning.`, code: 'LOCATION_REQUIRED', blocking: probe.blocking },
    };
  }
  // A late order waiting to be added makes this a late-order re-plan (the other orders keep their
  // trucks) whichever button started it; only with nothing late waiting is it a full re-optimize.
  const effectiveReason = reason === 'REOPTIMIZE' && (await pendingLateOrderIds(tenantId, run)).length ? 'LATE_ORDER' : reason;
  let child;
  try {
    child = (await createNextVersion(tenantId, runId, effectiveReason, note, user.id)).child;
  } catch (e) {
    if (e instanceof PlanError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
  const res = await startDispatchOptimize(tenantId, child.id, user, ip, { allowMissingLocations });
  return { status: res.status, body: { ...res.body, runId: child.id, version: child.version, parentRunId: runId, reason: effectiveReason } };
}
