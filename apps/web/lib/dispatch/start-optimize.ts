import { prisma } from '../db';
import { audit } from '../audit';
import { isOptimizing } from '../jobs/optimize-job';
import { scheduleDispatchOptimize } from '../jobs/dispatch-job';
import { applyWeightChanges, buildDispatchRequest, createNextVersion, isLegacyPlan, pendingLateOrderIds, PlanError, type BuiltRequest } from './plan-service';
import { INTAKE_BUSY, isTransactionTimeout, lockIntake } from './intake-server';
import { describeUnknownWeights } from './weights';

export interface StartResult {
  status: number;
  body: Record<string, unknown>;
}

/** What the dispatcher explicitly accepted when optimizing (after a 409 asked). */
export interface OptimizeOverrides {
  /** Plan anyway; customers without a (valid) location are left unserved. */
  allowMissingLocations?: boolean;
  /** Plan anyway; lines without a case weight count as 0 kg in the payload checks. */
  allowMissingWeights?: boolean;
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
 * Checks on a built request that need the dispatcher's explicit go-ahead: customers without a
 * location (LOCATION_REQUIRED) and, when a truck has a payload, lines without a case weight
 * (WEIGHT_REQUIRED). With the override for weights, the plan carries a warning that stays on it.
 */
function gate(built: BuiltRequest, opts: OptimizeOverrides, verb: string): StartResult | null {
  if (built.blocking.length && !opts.allowMissingLocations) {
    return {
      status: 409,
      body: { error: `${built.blocking.length} customer(s) need a location before ${verb}.`, code: 'LOCATION_REQUIRED', blocking: built.blocking },
    };
  }
  const payloads = built.request.trucks.some((t) => (t.capacity_kg ?? 0) > 0);
  if (built.unknownWeights.length && payloads) {
    const lines = built.unknownWeights.reduce((a, u) => a + u.lines, 0);
    const cases = built.unknownWeights.reduce((a, u) => a + u.cases, 0);
    if (!opts.allowMissingWeights) {
      return {
        status: 409,
        body: {
          error: `${lines} order line(s) (${cases} cases) have no weight: ${describeUnknownWeights(built.unknownWeights)}. Truck payloads cannot be checked for them. Have the case weight entered under Products (company admins can edit products), or ${verb === 're-planning' ? 're-plan' : 'optimize'} anyway (treated as 0 kg).`,
          code: 'WEIGHT_REQUIRED',
          unknownWeights: built.unknownWeights,
        },
      };
    }
    const note = `Planned without weights for ${lines} order line(s) (${cases} cases): ${describeUnknownWeights(built.unknownWeights)} - counted as 0 kg, so loads may be heavier than shown. Optimized anyway by the dispatcher.`;
    if (!built.warnings.includes(note)) built.warnings.push(note);
  }
  return null;
}

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
  opts: OptimizeOverrides & { prebuilt?: BuiltRequest } = {},
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
  // Weights entered or corrected under Products after the orders were confirmed are planned
  // with (in memory); they are saved on the orders below, only once the checks passed.
  const built = opts.prebuilt ?? (await buildDispatchRequest(tenantId, runId));
  const refused = gate(built, opts, 'optimizing');
  if (refused) return refused;
  const orderCount = built.scope.orderIds.length;
  if (orderCount === 0) return { status: 400, body: { error: 'No new orders to plan for this depot and date. Upload orders first.' } };
  if (built.request.trucks.length === 0) return { status: 400, body: { error: 'No active trucks at this depot.' } };

  const last = await prisma.runJob.findFirst({ where: { runId }, orderBy: { attemptNo: 'desc' }, select: { attemptNo: true } });
  let job;
  try {
    job = await prisma.$transaction(
      async (tx) => {
        // Under the intake lock (confirm, late order and batch delete take it too): a batch
        // delete that committed after the request was built must not leave the job planning
        // orders that no longer exist. Once OPTIMIZING is committed, a delete is refused.
        await lockIntake(tx, tenantId);
        const ids = [...new Set([...built.scope.orderIds, ...built.scope.frozenOrderIds])];
        const found = ids.length ? await tx.order.count({ where: { tenantId, id: { in: ids } } }) : 0;
        if (found !== ids.length) throw new PlanError('Orders of this day were removed while the plan was being prepared (a file was deleted). Optimize again.', 409);
        // Weights the request took from the product master are saved on the orders now (audited).
        await applyWeightChanges(tx, tenantId, runId, built.weightChanges, user.id);
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
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (e) {
    if (e instanceof PlanError) return { status: e.status, body: { error: e.message, code: 'ORDERS_CHANGED' } };
    if (isTransactionTimeout(e)) return { status: 409, body: INTAKE_BUSY };
    throw e;
  }
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
      allowMissingWeights: !!opts.allowMissingWeights,
      unknownWeightLines: built.unknownWeights.reduce((a, u) => a + u.lines, 0),
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
  overrides: OptimizeOverrides = {},
): Promise<StartResult> {
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
  if (!run) return { status: 404, body: { error: 'Plan not found' } };
  // Checked before anything is superseded: a legacy parent must stay the live plan.
  if (await isLegacyPlan(tenantId, runId)) return LEGACY_PLAN;
  if (!run.chosenScenarioId) {
    // Nothing applied yet: optimizing this version again is still fully traceable.
    return startDispatchOptimize(tenantId, runId, user, ip, overrides);
  }
  // Check location and weight blockers BEFORE creating a version (scope is the same minus
  // frozen loads). The probe plans weights entered since the last optimize in memory only: the
  // parent stays the live plan if this is refused, so its orders and loads must not change.
  // They are saved by startDispatchOptimize(child), after the parent was superseded.
  const probe = await buildDispatchRequest(tenantId, runId);
  const refused = gate(probe, overrides, 're-planning');
  if (refused) return refused;
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
  const res = await startDispatchOptimize(tenantId, child.id, user, ip, overrides);
  return { status: res.status, body: { ...res.body, runId: child.id, version: child.version, parentRunId: runId, reason: effectiveReason } };
}
