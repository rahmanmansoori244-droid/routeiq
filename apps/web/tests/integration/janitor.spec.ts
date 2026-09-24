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

async function callJanitor() {
  const tok = process.env.SOLVER_TOKEN ?? process.env.JANITOR_TOKEN;
  expect(tok, 'SOLVER_TOKEN must be set in .env for this test').toBeTruthy();
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
});
