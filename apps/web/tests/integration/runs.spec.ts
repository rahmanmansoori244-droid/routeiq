/**
 * Integration: run lifecycle — create, optimize, poll, retry, scenarios, pick,
 * baseline upload, manual move + capacity reject, dispatch, unlock.
 *
 * Requires dev server + solver running.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  BASE,
  CookieJar,
  cleanupTenant,
  fetchWith,
  freshTenant,
  prisma,
  seedMinimal,
  tomorrowIso,
  type SeededIds,
} from './helpers';

const createdSlugs = new Set<string>();

afterAll(async () => {
  for (const slug of createdSlugs) await cleanupTenant(slug);
  await prisma.$disconnect();
});

async function seedOrders(tenantId: string, seeded: SeededIds, count = 6): Promise<void> {
  // Use the same UTC-midnight Date as the run-creation endpoint computes from
  // tomorrowIso(), so the date columns match exactly when Prisma rounds to @db.Date.
  const tomorrow = new Date(tomorrowIso());
  for (let i = 0; i < count; i++) {
    const cust = seeded.customerIds[i % seeded.customerIds.length];
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: cust,
        deliveryDate: tomorrow,
        totalCases: 5,
        totalWeightKg: 60,
        totalVolumeL: 60,
        totalServiceTimeMin: 10,
        priority: 3,
        status: 'VALIDATED',
      },
    });
    await prisma.orderLine.create({
      data: { orderId: order.id, productId: seeded.productId, cases: 5 },
    });
  }
}

async function setFastSolver(tenantId: string): Promise<void> {
  await prisma.tenantConfig.update({
    where: { tenantId },
    data: { solverTimeLimitSeconds: 3 },
  });
}

async function pollUntilDone(jar: CookieJar, runId: string, maxIterations = 30): Promise<{ runStatus: string; jobStatus: string }> {
  for (let i = 0; i < maxIterations; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await fetchWith(jar, `${BASE}/api/runs/${runId}/status`);
    const body = (await st.json()) as { data: { run: { status: string }; job: { status: string } | null } };
    if (body.data.run.status !== 'OPTIMIZING') {
      return { runStatus: body.data.run.status, jobStatus: body.data.job?.status ?? '' };
    }
  }
  return { runStatus: 'TIMEOUT', jobStatus: 'TIMEOUT' };
}

async function createRun(jar: CookieJar, depotId: string, runDate: string): Promise<string> {
  const r = await fetchWith(jar, `${BASE}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ depotId, runDate, optimizationMode: 'BALANCED' }),
  });
  expect(r.status).toBe(201);
  const body = (await r.json()) as { data: { id: string } };
  return body.data.id;
}

describe('runs: full lifecycle (NMWC dispatch planner)', () => {
  it('optimizes a small tenant and applies the RECOMMENDED plan (3 options)', async () => {
    const h = await freshTenant('runs-opt');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    await seedOrders(h.tenantId, seeded, 8);
    await setFastSolver(h.tenantId);

    const runId = await createRun(h.cookieJar, seeded.depotId, tomorrowIso());

    const optRes = await fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/optimize`, { method: 'POST' });
    expect(optRes.status).toBe(202);

    const final = await pollUntilDone(h.cookieJar, runId);
    expect(final.runStatus).toBe('READY');
    expect(final.jobStatus).toBe('SUCCEEDED');

    const scenarios = await prisma.scenarioResult.findMany({ where: { runId } });
    expect(scenarios.map((s) => s.name).sort()).toEqual(['MIN_DISTANCE', 'MIN_TRUCKS', 'RECOMMENDED']);
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    expect(scenarios.find((s) => s.id === run.chosenScenarioId)?.name).toBe('RECOMMENDED');
    expect(await prisma.planLoad.count({ where: { runId } })).toBeGreaterThan(0);
  }, 120_000);

  it('never re-optimizes an applied plan in place; re-plan creates version 2', async () => {
    const h = await freshTenant('runs-retry');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    await seedOrders(h.tenantId, seeded, 4);
    await setFastSolver(h.tenantId);
    const runId = await createRun(h.cookieJar, seeded.depotId, tomorrowIso());

    const first = await fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/optimize`, { method: 'POST' });
    expect(first.status).toBe(202);
    await pollUntilDone(h.cookieJar, runId);

    const second = await fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/optimize`, { method: 'POST' });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as { error: { code: string } };
    expect(secondBody.error.code).toBe('NEW_VERSION_REQUIRED');

    const rp = await fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/replan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'REOPTIMIZE' }),
    });
    expect(rp.status).toBe(202);
    const v2 = ((await rp.json()) as { data: { runId: string; version: number } }).data;
    expect(v2.version).toBe(2);
    await pollUntilDone(h.cookieJar, v2.runId);

    const parent = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    expect(parent.status).toBe('SUPERSEDED');
    expect(await prisma.runJob.count({ where: { runId } })).toBe(1);
    const jobs = await prisma.runJob.findMany({ where: { runId: v2.runId } });
    expect(jobs.length).toBe(1);
    expect(jobs[0].requestJson).not.toBeNull();
  }, 120_000);

  it('applied plans have stops numbered 1..N per truck load; an alternative can be chosen explicitly', async () => {
    const h = await freshTenant('runs-pick');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    await seedOrders(h.tenantId, seeded, 6);
    await setFastSolver(h.tenantId);

    const runId = await createRun(h.cookieJar, seeded.depotId, tomorrowIso());
    await fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/optimize`, { method: 'POST' });
    await pollUntilDone(h.cookieJar, runId);

    const checkSequences = async () => {
      const assignments = await prisma.routeAssignment.findMany({
        where: { runId },
        orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }, { sequenceInTruck: 'asc' }, { orderInStop: 'asc' }],
      });
      expect(assignments.length).toBeGreaterThan(0);
      const byLoad = new Map<string, number[]>();
      for (const a of assignments) {
        if (a.orderInStop > 0) continue; // extra orders for the same stop share its sequence
        const k = `${a.truckId}:${a.loadNo}`;
        byLoad.set(k, [...(byLoad.get(k) ?? []), a.sequenceInTruck]);
      }
      for (const [, seq] of byLoad) expect(seq).toEqual(Array.from({ length: seq.length }, (_, i) => i + 1));
    };
    await checkSequences();

    const alt = await prisma.scenarioResult.findFirstOrThrow({ where: { runId, name: 'MIN_DISTANCE' } });
    const pick = await fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/choose-scenario`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId: alt.id }),
    });
    expect(pick.status).toBe(200);
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } })).chosenScenarioId).toBe(alt.id);
    await checkSequences();
  }, 120_000);

  it('dispatch is per load; the legacy whole-run dispatch/unlock are refused on load plans', async () => {
    const h = await freshTenant('runs-disp');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    await seedOrders(h.tenantId, seeded, 4);
    await setFastSolver(h.tenantId);

    const runId = await createRun(h.cookieJar, seeded.depotId, tomorrowIso());
    await fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/optimize`, { method: 'POST' });
    await pollUntilDone(h.cookieJar, runId);

    expect((await fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/dispatch`, { method: 'POST' })).status).toBe(409);
    expect((await fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/unlock`, { method: 'POST' })).status).toBe(409);

    const loads = await prisma.planLoad.findMany({ where: { runId }, orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }] });
    const first = loads[0];
    const patch = (status: string) =>
      fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/loads/${first.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    expect((await patch('DISPATCHED')).status).toBe(409); // must be locked first
    expect((await patch('LOCKED')).status).toBe(200);
    expect((await patch('DISPATCHED')).status).toBe(200);
    expect((await patch('PLANNED')).status).toBe(409); // dispatched is immutable

    const audits = await prisma.auditLog.findMany({ where: { tenantId: h.tenantId, entity: 'PlanLoad', entityId: first.id } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['LOAD_LOCKED', 'LOAD_DISPATCHED']));
  }, 120_000);
});

describe('runs: manual baseline', () => {
  it('uploads a baseline and links to run', async () => {
    const h = await freshTenant('runs-base');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    await seedOrders(h.tenantId, seeded, 3);

    const runId = await createRun(h.cookieJar, seeded.depotId, tomorrowIso());

    const csv =
      'truck_code,customer_code,branch_code,sequence,cases,manual_distance_km,manual_time_min\n' +
      'T-01,C-001,,1,5,3.2,8\n' +
      'T-01,C-002,,2,3,1.4,6\n' +
      'T-02,C-003,,1,4,2.8,7\n';
    const fd = new FormData();
    fd.set('file', new Blob([csv], { type: 'text/csv' }), 'baseline.csv');
    const res = await fetchWith(h.cookieJar, `${BASE}/api/runs/${runId}/baseline`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { totalTrucks: number; assignments: number } };
    expect(body.data.totalTrucks).toBe(2);
    expect(body.data.assignments).toBe(3);
  });
});
