import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { tenantDb } from '@/lib/tenant';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { hasRole } from '@/lib/api';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { buildSolverPayload, scheduleOptimize } from '@/lib/jobs/optimize-job';

interface Params { params: { id: string } }

export async function POST(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user || !session.user.tenantId) {
    return NextResponse.json({ data: null, error: 'Unauthorized' }, { status: 401 });
  }
  if (!hasRole(session.user.role, 'PLANNER')) {
    return NextResponse.json({ data: null, error: 'Forbidden' }, { status: 403 });
  }
  const ip = _req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

  const limit = rateLimit(
    `optimize:${session.user.tenantId}`,
    LIMITS.optimize.limit,
    LIMITS.optimize.windowMs,
  );
  if (!limit.ok) return NextResponse.json({ data: null, error: 'Too many optimize requests for this tenant.' }, { status: 429 });

  const db = tenantDb(session.user.tenantId);

  // Validate run state.
  const run = await db.runPlan.findUnique({ where: { id: params.id } });
  if (!run) return NextResponse.json({ data: null, error: 'Run not found' }, { status: 404 });
  if (!(run.status === 'DRAFT' || run.status === 'FAILED' || run.status === 'READY')) {
    return NextResponse.json(
      { data: null, error: `Run status is ${run.status}; cannot start a new optimization from here.` },
      { status: 409 },
    );
  }

  // Refuse if an active job already exists.
  const active = await db.runJob.findFirst({
    where: { runId: params.id, status: { in: ['QUEUED', 'RUNNING'] } },
  });
  if (active) {
    return NextResponse.json(
      { data: { runJobId: active.id, attemptNo: active.attemptNo, status: active.status }, error: null },
      { status: 202 },
    );
  }

  // Calculate next attempt number.
  const last = await db.runJob.findFirst({
    where: { runId: params.id },
    orderBy: { attemptNo: 'desc' },
    select: { attemptNo: true },
  });
  const nextAttempt = (last?.attemptNo ?? 0) + 1;

  // Re-optimize semantics: if the run is READY/FAILED AND has existing route
  // assignments with locks, the solver should be told to respect those locks.
  // First-time optimize (DRAFT) ignores locks since none exist.
  const respectLocks = run.status === 'READY' || run.status === 'FAILED';

  // Build payload (orders + trucks + config) — locked stops excluded when respectLocks.
  const { payload, lockedAssignments } = await buildSolverPayload(
    session.user.tenantId,
    params.id,
    ['MIN_TRUCKS', 'MIN_DISTANCE', 'BALANCED'],
    { respectLocks },
  );
  if (payload.stops.length === 0 && lockedAssignments.length === 0) {
    return NextResponse.json(
      { data: null, error: 'No orders to optimize for this run date.' },
      { status: 400 },
    );
  }
  if (payload.trucks.length === 0) {
    return NextResponse.json(
      { data: null, error: 'No active trucks at this depot.' },
      { status: 400 },
    );
  }

  // Single transaction: create RunJob, flip RunPlan, write audit.
  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.runJob.create({
      data: {
        tenantId: session.user!.tenantId!,
        runId: params.id,
        attemptNo: nextAttempt,
        status: 'QUEUED',
        progressPct: 0,
        message: 'Queued',
        createdById: session.user!.id,
        requestJson: payload as never,
      },
    });
    // Clear stale chosenScenarioId on re-optimize. The previous scenarios get
    // wiped by the optimize-job's transaction; without this, the UI's
    // "selected scenario" state points at a now-deleted row.
    // RouteAssignment rows are left in place — the locked ones are still
    // meaningful to the next attempt (buildSolverPayload respects them); the
    // unlocked ones are replaced wholesale by choose-scenario after success.
    await tx.runPlan.update({
      where: { id: params.id },
      data: { status: 'OPTIMIZING', currentJobId: created.id, chosenScenarioId: null },
    });
    return created;
  });

  await audit({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    action: 'OPTIMIZE_STARTED',
    entity: 'RunPlan',
    entityId: params.id,
    afterJson: {
      runJobId: job.id,
      attemptNo: nextAttempt,
      orderCount: payload.stops.length,
      truckCount: payload.trucks.length,
    } as never,
    ip,
  });

  // Kick off the background work (non-blocking).
  scheduleOptimize({
    runId: params.id,
    runJobId: job.id,
    tenantId: session.user.tenantId,
    userId: session.user.id,
    ip,
    solverPayload: payload,
  });

  return NextResponse.json(
    { data: { runJobId: job.id, attemptNo: nextAttempt, status: 'QUEUED' }, error: null },
    { status: 202 },
  );
}
