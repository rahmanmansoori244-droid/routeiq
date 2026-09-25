/**
 * PLAN LIFECYCLE AND CONCURRENCY - end-to-end against the running web app + solver, on real
 * PostgreSQL (stabilization PR3; review F03, F06, F07, F16, ADD-STALE-DAY-CLIENT):
 *
 *  - concurrent first-plan requests (3x POST /api/dispatch/plan, 3x legacy POST /api/runs) get one
 *    plan: exactly one RunPlan for the day (day lock);
 *  - every load locked and nothing pending: Re-plan answers 409 NOTHING_TO_PLAN, no version is
 *    created and the parent stays READY; the day overview says nothing is left to plan;
 *  - no active truck: Re-plan answers 400 and creates no version;
 *  - "Use instead" queued behind a re-plan (the plan row held by a test transaction) answers 409
 *    and the parent stays SUPERSEDED - never READY again;
 *  - two concurrent re-plans of one version: exactly one child;
 *  - an option that found no plan (NO_SOLUTION) cannot be used (409);
 *  - a re-plan for another day than the screen shows answers 409 DAY_MISMATCH.
 *
 * The failed-re-plan case (the optimizer down) is in plan-lifecycle-db.spec.ts, with the solver
 * faked. Requires: web server (RATE_LIMITS_DISABLED=1) + solver running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';

let t: TenantHandle;
let depotId = '';

function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000); // Muscat
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const j = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForPlan(runId: string, max = 120) {
  for (let i = 0; i < max; i++) {
    await sleep(1000);
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') return st.data;
  }
  throw new Error('optimization did not finish');
}
const plan = async (runId: string) => (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/plan`))).data;
const dayView = async (day: string) => (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/day?date=${day}&depotId=${depotId}`))).data;
const plansOfDay = (day: string) => prisma.runPlan.count({ where: { tenantId: t.tenantId, depotId, runDate: new Date(`${day}T00:00:00.000Z`) } });

/** `n` small orders for the day, one per customer (well within truck capacity: all served). */
async function seedOrders(day: string, n: number) {
  const product = await prisma.product.findFirstOrThrow({ where: { tenantId: t.tenantId } });
  const customers = await prisma.customer.findMany({ where: { tenantId: t.tenantId }, orderBy: { code: 'asc' } });
  for (let i = 0; i < n; i++) {
    await prisma.order.create({
      data: {
        tenantId: t.tenantId,
        customerId: customers[i % customers.length]!.id,
        depotId,
        deliveryDate: new Date(`${day}T00:00:00.000Z`),
        totalCases: 8,
        totalWeightKg: 80,
        status: 'VALIDATED',
        priority: 3,
        lines: { create: [{ productId: product.id, cases: 8, weightKg: 80, salesOrderNo: `SO-${day}-${i}` }] },
      },
    });
  }
}

/** Optimize the day and wait for the plan. */
async function optimizedDay(day: string, orders = 3) {
  await seedOrders(day, orders);
  const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true }));
  expect(r.status).toBe(202);
  const runId = (await json(r)).data.runId as string;
  const st = await waitForPlan(runId);
  expect(st.run.status).toBe('READY');
  return runId;
}

/** Hold the plan row (SELECT ... FOR UPDATE) in a test transaction until release(). */
async function holdPlanRow(runId: string) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const tx = prisma.$transaction(
    async (q) => {
      await q.$queryRaw`SELECT id FROM "RunPlan" WHERE id = ${runId} FOR UPDATE`;
      locked();
      await released;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  await isLocked;
  return {
    release: async () => {
      release();
      await tx;
    },
  };
}

async function untilPlanRowWaiters(n: number) {
  for (let i = 0; i < 400; i++) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND cardinality(pg_blocking_pids(pid)) > 0 AND query ILIKE '%FROM "RunPlan"%FOR UPDATE%'`;
    if (Number(rows[0]?.n ?? 0) >= n) return;
    await sleep(20);
  }
  throw new Error(`never saw ${n} request(s) waiting for the plan row`);
}

beforeAll(async () => {
  t = await freshTenant('lifecycle');
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, shiftStartMin: 360, driverShiftMaxMinutes: 720, distanceProvider: 'HAVERSINE', osrmUrl: null },
  });
  depotId = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } })).id;
  for (const code of ['T01', 'T02']) {
    await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code, capacityCases: 120, capacityWeightKg: 2500, fixedCostPerDay: 20, costPerKm: 0.08 } });
  }
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TAN-500-24', name: 'Tanuf 500ml x24', weightPerCaseKg: 10 } });
  for (const [code, lat, lng] of [['C1', 23.588, 58.41], ['C2', 23.6, 58.372], ['C3', 23.555, 58.335], ['C4', 23.614, 58.476]] as const) {
    await prisma.customer.create({
      data: { tenantId: t.tenantId, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true },
    });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('one live plan per day (F06)', () => {
  it('3x POST /api/dispatch/plan and 3x POST /api/runs at once: one plan for the day', async () => {
    const day = isoPlus(2);
    await seedOrders(day, 2);
    const calls = [
      ...Array.from({ length: 3 }, () => fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: false }))),
      ...Array.from({ length: 3 }, () => fetchWith(t.cookieJar, `${BASE}/api/runs`, j({ depotId, runDate: day }))),
    ];
    const res = await Promise.all(calls);
    const ids = new Set<string>();
    for (const [i, r] of res.entries()) {
      expect([200, 201]).toContain(r.status);
      const d = (await json(r)).data;
      ids.add(i < 3 ? d.runId : d.id);
    }
    expect(ids.size).toBe(1);
    expect(await plansOfDay(day)).toBe(1);
    expect(res.slice(3).filter((r) => r.status === 201).length).toBeLessThanOrEqual(1);
  });
});

describe('re-plan preflight (F03)', () => {
  it('every load locked and nothing pending: 409 NOTHING_TO_PLAN, no new version, the parent stays READY', async () => {
    const day = isoPlus(3);
    const runId = await optimizedDay(day);
    const p = await plan(runId);
    expect(p.unserved).toHaveLength(0);
    for (const l of [...p.loads].sort((a: any, b: any) => a.loadNo - b.loadNo)) {
      const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/loads/${l.id}`, j({ status: 'LOCKED' }, 'PATCH'));
      expect(r.status).toBe(200);
    }
    expect((await plan(runId)).pendingOrders).toBe(0);
    expect((await dayView(day)).openOrders).toBe(0);
    const before = await plansOfDay(day);
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/replan`, j({ reason: 'REOPTIMIZE' }));
    expect(r.status).toBe(409);
    const b = await json(r);
    expect(b.error.code).toBe('NOTHING_TO_PLAN');
    expect(await plansOfDay(day)).toBe(before);
    expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } })).status).toBe('READY');
  });

  it('no active truck: 400 and no new version', async () => {
    const day = isoPlus(4);
    const runId = await optimizedDay(day);
    await prisma.truck.updateMany({ where: { tenantId: t.tenantId }, data: { active: false } });
    try {
      const before = await plansOfDay(day);
      const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/replan`, j({ reason: 'REOPTIMIZE' }));
      expect(r.status).toBe(400);
      expect(await plansOfDay(day)).toBe(before);
      expect((await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } })).status).toBe('READY');
    } finally {
      await prisma.truck.updateMany({ where: { tenantId: t.tenantId }, data: { active: true } });
    }
  });

  it('a re-plan for another day than the screen shows: 409 DAY_MISMATCH, nothing created', async () => {
    const day = isoPlus(5);
    const runId = await optimizedDay(day, 2);
    const before = await plansOfDay(day);
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/replan`, j({ reason: 'REOPTIMIZE', expect: { date: isoPlus(6), depotId } }));
    expect(r.status).toBe(409);
    expect((await json(r)).error.code).toBe('DAY_MISMATCH');
    expect(await plansOfDay(day)).toBe(before);
  });
});

describe('plan row locks (F07)', () => {
  it('"Use instead" queued behind a re-plan: 409, and the parent stays SUPERSEDED', async () => {
    const day = isoPlus(7);
    const runId = await optimizedDay(day);
    const p = await plan(runId);
    const alt = p.scenarios.find((s: any) => !s.chosen && s.status === 'OPTIMIZED');
    expect(alt, 'the solver returns alternatives').toBeTruthy();
    const hold = await holdPlanRow(runId);
    const replanning = fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/replan`, j({ reason: 'REOPTIMIZE' }));
    await untilPlanRowWaiters(1);
    const choosing = fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/choose-scenario`, j({ scenarioId: alt.id }));
    await untilPlanRowWaiters(2);
    await hold.release();
    const [rp, ch] = await Promise.all([replanning, choosing]);
    expect(rp.status).toBe(202);
    expect(ch.status).toBe(409);
    const parent = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    expect(parent.status).toBe('SUPERSEDED');
    expect(parent.supersededAt).not.toBeNull();
    await waitForPlan((await json(rp)).data.runId);
  });

  it('two concurrent re-plans of one version: exactly one child', async () => {
    const day = isoPlus(8);
    const runId = await optimizedDay(day);
    const [a, b] = await Promise.all([
      fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/replan`, j({ reason: 'REOPTIMIZE' })),
      fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/replan`, j({ reason: 'REOPTIMIZE' })),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const children = await prisma.runPlan.findMany({ where: { parentRunId: runId } });
    expect(children).toHaveLength(1);
    await waitForPlan(children[0]!.id);
  });

  it('an option that found no plan (NO_SOLUTION) cannot be used: 409, the plan in use is unchanged', async () => {
    const day = isoPlus(9);
    const runId = await optimizedDay(day, 2);
    const p = await plan(runId);
    const alt = p.scenarios.find((s: any) => !s.chosen);
    expect(alt).toBeTruthy();
    const before = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    await prisma.$executeRaw`UPDATE "ScenarioResult" SET "detailsJson" = jsonb_set("detailsJson"::jsonb, '{status}', '"NO_SOLUTION"') WHERE id = ${alt.id}`;
    const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/choose-scenario`, j({ scenarioId: alt.id }));
    expect(r.status).toBe(409);
    expect((await json(r)).error.code).toBe('SCENARIO_NOT_USABLE');
    const after = await prisma.runPlan.findUniqueOrThrow({ where: { id: runId } });
    expect(after.chosenScenarioId).toBe(before.chosenScenarioId);
    expect(after.status).toBe('READY');
    expect((await plan(runId)).run.chosenScenario).toBe('RECOMMENDED');
  });
});
