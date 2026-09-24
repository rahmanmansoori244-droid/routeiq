/**
 * Integration: orphan janitor reaps stuck RunJobs.
 * CLAUDE.md §7: jobs RUNNING >5 minutes flip to FAILED with reason STUCK.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, freshTenant, prisma } from './helpers';

const createdSlugs = new Set<string>();

afterAll(async () => {
  for (const slug of createdSlugs) await cleanupTenant(slug);
  await prisma.$disconnect();
});

describe('orphan janitor', () => {
  it('reaps RunJobs stuck in RUNNING longer than the threshold', async () => {
    const h = await freshTenant('jan-stuck');
    createdSlugs.add(h.slug);

    // Insert a fake RUNNING job with startedAt 6 minutes ago.
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
    // Park startedAt 6 minutes in the past via raw SQL (avoids JS Date TZ trap).
    const job = await prisma.runJob.create({
      data: {
        tenantId: h.tenantId,
        runId: run.id,
        attemptNo: 1,
        status: 'RUNNING',
        progressPct: 50,
        createdById: h.userId,
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "RunJob" SET "startedAt" = NOW() - INTERVAL '6 minutes' WHERE id = $1`,
      job.id,
    );

    // Invoke janitor with the dev SOLVER_TOKEN (= JANITOR_TOKEN fallback).
    const tok = process.env.SOLVER_TOKEN ?? process.env.JANITOR_TOKEN;
    expect(tok, 'SOLVER_TOKEN must be set in .env for this test').toBeTruthy();

    const res = await fetch(`${BASE}/api/cron/janitor`, {
      method: 'POST',
      headers: { 'X-Janitor-Token': tok! },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { jobs: { reaped: number } } };
    expect(body.data.jobs.reaped).toBeGreaterThanOrEqual(1);

    const afterJob = await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterJob.status).toBe('FAILED');
    expect((afterJob.errorJson as { reason?: string } | null)?.reason).toBe('STUCK');

    const afterRun = await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } });
    expect(afterRun.status).toBe('FAILED');
  });

  it('does not reap recently-started jobs', async () => {
    const h = await freshTenant('jan-fresh');
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

    const tok = process.env.SOLVER_TOKEN ?? process.env.JANITOR_TOKEN;
    const res = await fetch(`${BASE}/api/cron/janitor`, {
      method: 'POST',
      headers: { 'X-Janitor-Token': tok! },
    });
    expect(res.status).toBe(200);

    const after = await prisma.runJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('RUNNING'); // untouched
  });
});
