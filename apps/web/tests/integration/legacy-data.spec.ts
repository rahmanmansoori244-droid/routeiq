/**
 * Integration: production data created by the previous (PyVRP) planner keeps working after the
 * dispatch-planner release, and nothing forks a day into two live plans.
 *
 * Requires dev server running (no solver calls are made).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, seedMinimal, tomorrowIso, type SeededIds } from './helpers';

const createdSlugs = new Set<string>();

afterAll(async () => {
  for (const slug of createdSlugs) await cleanupTenant(slug);
  await prisma.$disconnect();
});

const LEGACY_SCENARIO = {
  // Shape stored by the previous optimize job: no scope, no loads, no warnings arrays.
  name: 'BALANCED',
  trucks_used: 1,
  total_distance_km: 12.5,
  total_time_min: 60,
  total_cost: 30,
  avg_utilization_pct: 40,
  distance_provider: 'HAVERSINE',
  distance_is_estimated: true,
  unserved_orders: [],
  routes: [],
};

async function legacyRun(h: { tenantId: string; userId: string }, seeded: SeededIds, date: string, opts: { withAssignment: boolean }) {
  const runDate = new Date(date);
  const order = await prisma.order.create({
    data: {
      tenantId: h.tenantId,
      customerId: seeded.customerIds[0],
      deliveryDate: runDate,
      totalCases: 5,
      totalWeightKg: 60,
      totalVolumeL: 60,
      totalServiceTimeMin: 10,
      priority: 3,
      status: 'DISPATCHED',
    },
  });
  const run = await prisma.runPlan.create({
    data: { tenantId: h.tenantId, depotId: seeded.depotId, runDate, status: 'READY', totalOrders: 1, createdById: h.userId },
  });
  const sc = await prisma.scenarioResult.create({
    data: {
      runId: run.id,
      name: 'BALANCED',
      trucksUsed: 1,
      totalDistanceKm: 12.5,
      totalTimeMin: 60,
      totalCost: 30,
      avgUtilizationPct: 40,
      unservedCount: 0,
      detailsJson: LEGACY_SCENARIO,
    },
  });
  await prisma.runPlan.update({ where: { id: run.id }, data: { chosenScenarioId: sc.id } });
  if (opts.withAssignment) {
    await prisma.routeAssignment.create({
      data: {
        runId: run.id,
        truckId: seeded.truckIds[0],
        orderId: order.id,
        sequenceInTruck: 1,
        plannedArrivalMin: 30,
        plannedDistanceFromPrevKm: 5,
        plannedLoadCases: 5,
        lockedByUserId: h.userId,
      },
    });
  }
  return { run, order, scenarioId: sc.id };
}

describe('legacy production data', () => {
  it('opens a legacy plan without a server error and explains it', async () => {
    const h = await freshTenant('leg-view');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    const { run } = await legacyRun(h, seeded, '2026-05-10', { withAssignment: true });

    const res = await fetchWith(h.cookieJar, `${BASE}/api/runs/${run.id}/plan`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { warnings: string[]; scenarios: { name: string; chosen: boolean }[] } };
    expect(body.data.warnings.join(' ')).toMatch(/previous optimizer/);
    expect(body.data.scenarios.find((s) => s.chosen)?.name).toBe('BALANCED');
  });

  it('refuses to re-optimize or re-plan a legacy plan, and leaves it untouched', async () => {
    const h = await freshTenant('leg-guard');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    const { run, order } = await legacyRun(h, seeded, '2026-05-11', { withAssignment: true });
    // Re-optimized on the old planner: chosen scenario cleared, locked assignment kept.
    await prisma.runPlan.update({ where: { id: run.id }, data: { chosenScenarioId: null } });

    const opt = await fetchWith(h.cookieJar, `${BASE}/api/runs/${run.id}/optimize`, { method: 'POST' });
    expect(opt.status).toBe(409);
    expect(((await opt.json()) as { error: { code: string } }).error.code).toBe('LEGACY_PLAN');

    const rp = await fetchWith(h.cookieJar, `${BASE}/api/runs/${run.id}/replan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'REOPTIMIZE' }),
    });
    expect(rp.status).toBe(409);

    const after = await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('READY'); // not SUPERSEDED
    expect(await prisma.runPlan.count({ where: { tenantId: h.tenantId } })).toBe(1); // no child version
    expect(await prisma.routeAssignment.count({ where: { runId: run.id, lockedByUserId: h.userId } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DISPATCHED');
  });

  it('refuses to re-plan a legacy plan whose chosen scenario has the old shape', async () => {
    const h = await freshTenant('leg-replan');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    const { run } = await legacyRun(h, seeded, '2026-05-09', { withAssignment: false });

    const rp = await fetchWith(h.cookieJar, `${BASE}/api/runs/${run.id}/replan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'LATE_ORDER' }),
    });
    expect(rp.status).toBe(409);
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('READY');
  });
});

describe('one live plan per depot and day', () => {
  it('"New run" for a day that already has a plan opens that plan', async () => {
    const h = await freshTenant('one-plan');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    await prisma.order.create({
      data: {
        tenantId: h.tenantId,
        customerId: seeded.customerIds[0],
        deliveryDate: new Date(tomorrowIso()),
        totalCases: 5,
        totalWeightKg: 60,
        totalVolumeL: 60,
        totalServiceTimeMin: 10,
        priority: 3,
        status: 'VALIDATED',
      },
    });
    const create = () =>
      fetchWith(h.cookieJar, `${BASE}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ depotId: seeded.depotId, runDate: tomorrowIso(), optimizationMode: 'BALANCED' }),
      });
    const first = await create();
    expect(first.status).toBe(201);
    const firstId = ((await first.json()) as { data: { id: string } }).data.id;
    const second = await create();
    expect(second.status).toBe(200);
    const b = (await second.json()) as { data: { id: string; existing: boolean } };
    expect(b.data.id).toBe(firstId);
    expect(b.data.existing).toBe(true);
    expect(await prisma.runPlan.count({ where: { tenantId: h.tenantId } })).toBe(1);
  });

  it('the dispatch screen picks the applied plan among several legacy version-1 plans', async () => {
    const h = await freshTenant('tie-plan');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    const date = '2026-05-08';
    const { run: applied } = await legacyRun(h, seeded, date, { withAssignment: false });
    // A later, empty version-1 draft for the same day (what the old "New run" button created).
    await prisma.runPlan.create({
      data: { tenantId: h.tenantId, depotId: seeded.depotId, runDate: new Date(date), status: 'DRAFT', totalOrders: 0, createdById: h.userId },
    });
    for (let i = 0; i < 3; i++) {
      const res = await fetchWith(h.cookieJar, `${BASE}/api/dispatch/day?date=${date}&depotId=${seeded.depotId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { plan: { id: string } | null } };
      expect(body.data.plan?.id).toBe(applied.id);
    }
  });
});

describe('road distances by default', () => {
  it('a new Omani tenant plans on OSRM road distances', async () => {
    const h = await freshTenant('osrm-def');
    createdSlugs.add(h.slug);
    const cfg = await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: h.tenantId } });
    expect(cfg.distanceProvider).toBe('OSRM');
  });

  it('a new tenant outside the OSRM map (Oman + UAE) keeps straight-line estimates', async () => {
    const slug = `osrm-ksa-${Date.now().toString(36)}`;
    createdSlugs.add(slug);
    const res = await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        companyName: `Integration ${slug}`,
        slug,
        country: 'Saudi Arabia',
        currency: 'SAR',
        primaryUnit: 'CASES',
        email: `admin@${slug}.test`,
        password: 'IntegrationTest-Password-12345',
        name: 'Integration Admin',
      }),
    });
    expect(res.status).toBeLessThan(300);
    const t = await prisma.tenant.findUniqueOrThrow({ where: { slug }, include: { config: true } });
    expect(t.config?.distanceProvider).toBe('HAVERSINE');
  });
});

describe('customer time windows', () => {
  it('rejects a PATCH that leaves a window ending before its saved start', async () => {
    const h = await freshTenant('win-merge');
    createdSlugs.add(h.slug);
    const seeded = await seedMinimal(h.tenantId);
    const id = seeded.customerIds[0];
    await prisma.customer.update({ where: { id }, data: { hardWindowStartMin: 600, hardWindowEndMin: 900 } });
    const patch = (body: unknown) =>
      fetchWith(h.cookieJar, `${BASE}/api/customers/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const bad = await patch({ hardWindowEndMin: 300 });
    expect(bad.status).toBe(400);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id } })).hardWindowEndMin).toBe(900);
    const good = await patch({ hardWindowEndMin: 720 });
    expect(good.status).toBe(200);
  });
});
