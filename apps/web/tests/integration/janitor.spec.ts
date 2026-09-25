/**
 * Integration: orphan janitor reaps stuck RunJobs.
 * A job RUNNING (or still QUEUED) longer than any real optimization (STUCK_JOB_MS = 15 min)
 * flips to FAILED with reason STUCK, and its plan goes back to FAILED. The web process also
 * runs this every 60 s itself (instrumentation.ts), so the assertions check the end state
 * rather than which caller did the reaping.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, freshTenant, prisma } from './helpers';

const createdSlugs = new Set<string>();

afterAll(async () => {
  for (const slug of createdSlugs) await cleanupTenant(slug);
  await prisma.$disconnect();
});

async function optimizingRun(slugPrefix: string) {
  const h = await freshTenant(slugPrefix);
  createdSlugs.add(h.slug);
  const depot = await prisma.depot.create({
    data: { tenantId: h.tenantId, code: 'D1', name: 'D1', lat: 23.5, lng: 58.4 },
  });
  const run = await prisma.runPlan.create({
    data: {
      tenantId: h.tenantId,
      depotId: depot.id,
      runDate: new Date(),
      status: 'OPTIMIZING',
      totalOrders: 0,
      createdById: h.userId,
    },
  });
  return { h, run };
}

// A production server (CI runs `pnpm start`) accepts only JANITOR_TOKEN; a dev server falls back
// to SOLVER_TOKEN (lib/janitor-auth.ts).
async function callJanitor() {
  const tok = process.env.JANITOR_TOKEN || process.env.SOLVER_TOKEN;
  expect(tok, 'JANITOR_TOKEN (or, on a dev server, SOLVER_TOKEN) must be set for this test').toBeTruthy();
  const res = await fetch(`${BASE}/api/cron/janitor`, { method: 'POST', headers: { 'X-Janitor-Token': tok! } });
  expect(res.status).toBe(200);
}

describe('orphan janitor', () => {
  it('reaps RunJobs stuck in RUNNING longer than the threshold', async () => {
    const { h, run } = await optimizingRun('jan-stuck');
    const job = await prisma.runJob.create({
      data: { tenantId: h.tenantId, runId: run.id, attemptNo: 1, status: 'RUNNING', progressPct: 50, createdById: h.userId },
    });
    // Park startedAt 16 minutes in the past via raw SQL (avoids JS Date TZ trap).
    await prisma.$executeRawUnsafe(`UPDATE "RunJob" SET "startedAt" = NOW() - INTERVAL '16 minutes' WHERE id = $1`, job.id);

    await callJanitor();

    const afterJob = await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterJob.status).toBe('FAILED');
    expect((afterJob.errorJson as { reason?: string } | null)?.reason).toBe('STUCK');
    const afterRun = await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterRun.status).toBe('FAILED');
  });

  it('reaps RunJobs that never left QUEUED', async () => {
    const { h, run } = await optimizingRun('jan-queued');
    const job = await prisma.runJob.create({
      data: { tenantId: h.tenantId, runId: run.id, attemptNo: 1, status: 'QUEUED', createdById: h.userId },
    });
    await prisma.$executeRawUnsafe(`UPDATE "RunJob" SET "createdAt" = NOW() - INTERVAL '16 minutes' WHERE id = $1`, job.id);

    await callJanitor();

    const afterJob = await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterJob.status).toBe('FAILED');
    const afterRun = await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterRun.status).toBe('FAILED');
  });

  it('does not reap a long but legitimate dispatch solve (6 minutes)', async () => {
    const { h, run } = await optimizingRun('jan-long');
    const job = await prisma.runJob.create({
      data: { tenantId: h.tenantId, runId: run.id, attemptNo: 1, status: 'RUNNING', progressPct: 20, createdById: h.userId },
    });
    await prisma.$executeRawUnsafe(`UPDATE "RunJob" SET "startedAt" = NOW() - INTERVAL '6 minutes' WHERE id = $1`, job.id);

    await callJanitor();

    const after = await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('RUNNING');
  });

  it('does not reap recently-started jobs', async () => {
    const { h, run } = await optimizingRun('jan-fresh');
    const job = await prisma.runJob.create({
      data: {
        tenantId: h.tenantId,
        runId: run.id,
        attemptNo: 1,
        status: 'RUNNING',
        progressPct: 30,
        createdById: h.userId,
        startedAt: new Date(),
      },
    });

    await callJanitor();

    const after = await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('RUNNING'); // untouched
  });

  // Stabilization PR3 (F03 copy-forward): a re-plan version starts as a copy of the previous plan.
  // When a deploy kills its solve, the janitor fails it - and the copied plan stays usable.
  it('reaping a re-plan version keeps its copied plan (loads and chosen option) intact', async () => {
    const { h, run } = await optimizingRun('jan-copy');
    const truck = await prisma.truck.create({ data: { tenantId: h.tenantId, depotId: run.depotId, code: 'T01', capacityCases: 100, fixedCostPerDay: 0, costPerKm: 0 } });
    const scenario = await prisma.scenarioResult.create({
      data: { runId: run.id, name: 'RECOMMENDED', trucksUsed: 1, totalDistanceKm: 5, totalTimeMin: 60, totalCost: 3, avgUtilizationPct: 20, unservedCount: 0, detailsJson: { name: 'RECOMMENDED', status: 'OPTIMIZED', loads: [], scope: { orderIds: [], frozenOrderIds: [], orderPriority: {} } } },
    });
    const load = await prisma.planLoad.create({
      data: { tenantId: h.tenantId, runId: run.id, truckId: truck.id, loadNo: 1, status: 'PLANNED', departMin: 420, returnMin: 500, distanceKm: 5, durationMin: 80, cases: 20, weightKg: 200, utilizationPct: 20, carriedFromLoadId: 'previous-version-load' },
    });
    const job = await prisma.runJob.create({
      data: { tenantId: h.tenantId, runId: run.id, attemptNo: 1, status: 'RUNNING', progressPct: 20, createdById: h.userId },
    });
    await prisma.runPlan.update({ where: { id: run.id }, data: { chosenScenarioId: scenario.id, currentJobId: job.id, version: 2, reason: 'REOPTIMIZE' } });
    await prisma.$executeRawUnsafe(`UPDATE "RunJob" SET "startedAt" = NOW() - INTERVAL '16 minutes' WHERE id = $1`, job.id);

    await callJanitor();

    expect((await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    const afterRun = await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterRun.status).toBe('FAILED');
    expect(afterRun.chosenScenarioId).toBe(scenario.id);
    expect(await prisma.planLoad.findUnique({ where: { id: load.id } })).not.toBeNull();
    expect(await prisma.scenarioResult.findUnique({ where: { id: scenario.id } })).not.toBeNull();
  });

  it('never fails a plan that another job took over (currentJobId differs)', async () => {
    const { h, run } = await optimizingRun('jan-other');
    const stuck = await prisma.runJob.create({
      data: { tenantId: h.tenantId, runId: run.id, attemptNo: 1, status: 'RUNNING', progressPct: 20, createdById: h.userId },
    });
    const current = await prisma.runJob.create({
      data: { tenantId: h.tenantId, runId: run.id, attemptNo: 2, status: 'RUNNING', progressPct: 20, createdById: h.userId, startedAt: new Date() },
    });
    await prisma.runPlan.update({ where: { id: run.id }, data: { currentJobId: current.id } });
    await prisma.$executeRawUnsafe(`UPDATE "RunJob" SET "startedAt" = NOW() - INTERVAL '16 minutes' WHERE id = $1`, stuck.id);

    await callJanitor();

    expect((await prisma.runJob.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe('FAILED');
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('OPTIMIZING');
    expect((await prisma.runJob.findUniqueOrThrow({ where: { id: current.id } })).status).toBe('RUNNING');
  });
});

describe('janitor authentication', () => {
  it('refuses a call without a token', async () => {
    const res = await fetch(`${BASE}/api/cron/janitor`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  // With a separate JANITOR_TOKEN configured (CI, production), the solver secret is never accepted.
  const both = process.env.JANITOR_TOKEN && process.env.SOLVER_TOKEN && process.env.JANITOR_TOKEN !== process.env.SOLVER_TOKEN;
  it.skipIf(!both)('does not accept SOLVER_TOKEN when JANITOR_TOKEN is set', async () => {
    const res = await fetch(`${BASE}/api/cron/janitor`, { method: 'POST', headers: { 'X-Janitor-Token': process.env.SOLVER_TOKEN! } });
    expect(res.status).toBe(401);
  });
});
