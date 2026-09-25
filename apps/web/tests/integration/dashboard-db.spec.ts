/**
 * DASHBOARD KPIs ON REAL POSTGRESQL (stabilization PR3, review of the fix commits). Needs
 * DATABASE_URL (migrated); the web server and solver are not used.
 *
 *  - exactly one plan per depot and day is counted, in every state of a re-plan: the new version
 *    holding the copy of the previous plan while it waits or runs (OPTIMIZING) and after a failed
 *    optimization (FAILED), never the superseded parent; of two live versions (legacy data) only
 *    the newest; a first optimization (no plan applied yet) not at all;
 *  - cost per case: each plan counts the orders of its own depot and day, so a tenant with two
 *    depots is not counted twice (and depot-less orders only with one active depot).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma as libPrisma } from '@/lib/db';
import { fetchRangeRows, rollupRows } from '@/lib/dashboard';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `dash-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let userId = '';
let depotA = '';
let depotB = '';
let customerId = '';

function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const D1 = isoPlus(40);
const D2 = isoPlus(41);
const D3 = isoPlus(42);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function order(depotId: string | null, iso: string, cases: number) {
  await prisma.order.create({
    data: { tenantId, customerId, depotId, deliveryDate: day(iso), totalCases: cases, totalWeightKg: cases * 10, status: 'VALIDATED', priority: 3 },
  });
}

/** One plan version; with `cost` it holds an applied plan (a chosen option with that cost). */
async function version(
  depotId: string,
  iso: string,
  v: number,
  status: 'DRAFT' | 'OPTIMIZING' | 'READY' | 'FAILED' | 'DISPATCHED' | 'SUPERSEDED',
  opts: { cost?: number; trucks?: number; superseded?: boolean; parentRunId?: string } = {},
) {
  const run = await prisma.runPlan.create({
    data: {
      tenantId,
      depotId,
      runDate: day(iso),
      status,
      version: v,
      reason: v === 1 ? 'INITIAL' : 'REOPTIMIZE',
      parentRunId: opts.parentRunId ?? null,
      supersededAt: opts.superseded ? new Date() : null,
      createdById: userId,
      totalOrders: 10,
      unservedCount: 0,
    },
  });
  if (opts.cost !== undefined) {
    const sc = await prisma.scenarioResult.create({
      data: {
        runId: run.id,
        name: 'RECOMMENDED',
        trucksUsed: opts.trucks ?? 1,
        totalDistanceKm: 100,
        totalTimeMin: 300,
        totalCost: opts.cost,
        avgUtilizationPct: 80,
        unservedCount: 0,
        detailsJson: { distance_is_estimated: true },
      },
    });
    await prisma.runPlan.update({ where: { id: run.id }, data: { chosenScenarioId: sc.id } });
  }
  return run;
}

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Dashboard ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  userId = (await prisma.user.create({ data: { tenantId, email: `planner@${slug}.test`, passwordHash: 'x', name: 'Planner', role: 'TENANT_ADMIN' } })).id;
  depotA = (await prisma.depot.create({ data: { tenantId, code: 'MCT', name: 'Muscat', lat: 23.568, lng: 58.392 } })).id;
  depotB = (await prisma.depot.create({ data: { tenantId, code: 'SOH', name: 'Sohar', lat: 24.34, lng: 56.73 } })).id;
  customerId = (await prisma.customer.create({ data: { tenantId, code: 'C1', name: 'C1', branchKey: '__MAIN__', lat: 23.6, lng: 58.4, priority: 3 } })).id;

  // D1: depot A 1000 cases, depot B 500; a depot-less order (not counted: two active depots).
  await order(depotA, D1, 600);
  await order(depotA, D1, 400);
  await order(depotB, D1, 500);
  await order(null, D1, 70);
  // Depot B on D2 has no plan: its cases never count for depot A's plan.
  await order(depotB, D2, 999);

  // D1, depot A: a re-plan is waiting or running - the new version holds the copy of v1's plan.
  const a1 = await version(depotA, D1, 1, 'SUPERSEDED', { cost: 100, trucks: 4, superseded: true });
  await version(depotA, D1, 2, 'OPTIMIZING', { cost: 60, trucks: 3, parentRunId: a1.id });
  // D1, depot B: the re-plan failed - the new version keeps the copy of v1's plan.
  const b1 = await version(depotB, D1, 1, 'SUPERSEDED', { cost: 50, trucks: 3, superseded: true });
  await version(depotB, D1, 2, 'FAILED', { cost: 30, trucks: 2, parentRunId: b1.id });
  // D2, depot A: two live versions (data from before versions were superseded): the newest only.
  await version(depotA, D2, 1, 'READY', { cost: 7, trucks: 1 });
  await version(depotA, D2, 2, 'READY', { cost: 9, trucks: 1 });
  // D3, depot B: a first optimization is running - no plan applied yet.
  await version(depotB, D3, 1, 'OPTIMIZING');
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('dashboard on real PostgreSQL: one plan per depot and day, each case once', () => {
  it('counts the re-plan copy while OPTIMIZING and after FAILED, never the superseded parents; cost per case over both depots', async () => {
    const rows = await fetchRangeRows(tenantId, D1, D3);
    const d1 = rows.find((r) => r.date === D1)!;
    expect(d1).toBeDefined();
    expect(Number(d1.run_count)).toBe(2);
    expect(Number(d1.trucks_used)).toBe(3 + 2);
    expect(Number(d1.cost)).toBe(60 + 30);
    expect(Number(d1.cases_total)).toBe(1000 + 500); // not 1570 per plan (the whole day of the tenant, twice)
    expect(rollupRows([d1], D1).costPerCase).toBe(0.06);
  });

  it('of two live versions of one depot and day only the newest; its cases are its own depot\'s only', async () => {
    const rows = await fetchRangeRows(tenantId, D1, D3);
    const d2 = rows.find((r) => r.date === D2)!;
    expect(Number(d2.run_count)).toBe(1);
    expect(Number(d2.cost)).toBe(9);
    expect(Number(d2.cases_total)).toBe(0); // depot B's 999 cases on D2 belong to no plan
  });

  it('a first optimization with no plan applied yet is not counted', async () => {
    const rows = await fetchRangeRows(tenantId, D1, D3);
    expect(rows.find((r) => r.date === D3)).toBeUndefined();
  });
});
