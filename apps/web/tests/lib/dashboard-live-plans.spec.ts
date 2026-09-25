/**
 * Stabilization PR3 (review): the dashboard counts exactly one plan per depot and day - the
 * current version, the one the day screen shows - in every state of its lifecycle. A version
 * written READY over its supersede before the release (supersededAt set) is never summed with its
 * live child; a re-plan's new version holding the copy of the previous plan is counted while it
 * waits or runs (OPTIMIZING) and after a failed optimization (FAILED), never the superseded parent.
 * Cost per case counts each plan's own orders (its depot and day), so two depots are not counted
 * twice. The same numbers on real PostgreSQL: tests/integration/dashboard-db.spec.ts.
 */
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

const captured: string[] = [];
vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push(Prisma.sql(strings, ...values).sql.replace(/\s+/g, ' '));
      return [];
    }),
    tenant: { findUniqueOrThrow: vi.fn(async () => ({ currency: 'OMR', config: { distanceProvider: 'OSRM', labelEstimatedDistances: true } })) },
    runPlan: { findMany: vi.fn(async () => []) },
  },
}));

import { getDashboardData, LIVE_PLAN_IN_USE, PLAN_ORDERS_IN_SCOPE } from '@/lib/dashboard';

const flat = (s: Prisma.Sql) => s.sql.replace(/\s+/g, ' ').trim();

describe('dashboard: the plan in use of each depot and day, once', () => {
  it('every plan query counts only the current version of each depot and day, holding a plan in use', async () => {
    await getDashboardData('t1');
    const planQueries = captured.filter((q) => q.includes('FROM "RunPlan" rp'));
    expect(planQueries.length).toBeGreaterThanOrEqual(4); // estimated-km + three range queries
    for (const q of planQueries) expect(q).toContain(flat(LIVE_PLAN_IN_USE));
  });

  it('the current version: newest not superseded or archived, as the day screen picks it (currentPlan)', () => {
    const sql = flat(LIVE_PLAN_IN_USE);
    expect(sql).toMatch(/^rp\.id = \( SELECT cur\.id FROM "RunPlan" cur /);
    expect(sql).toContain('cur."tenantId" = rp."tenantId" AND cur."depotId" = rp."depotId" AND cur."runDate" = rp."runDate"');
    expect(sql).toContain(`cur.status NOT IN ('SUPERSEDED', 'ARCHIVED') AND cur."supersededAt" IS NULL`);
    expect(sql).toContain('ORDER BY cur.version DESC, cur."chosenScenarioId" DESC NULLS LAST, cur."createdAt" DESC, cur.id DESC LIMIT 1');
    expect(LIVE_PLAN_IN_USE.values).toEqual([]);
  });

  it('holding a plan in use in every state: READY, DISPATCHED, or any version with an applied plan (OPTIMIZING or FAILED copy)', () => {
    const sql = flat(LIVE_PLAN_IN_USE);
    expect(sql).toMatch(/AND \(rp\.status IN \('READY', 'DISPATCHED'\) OR rp\."chosenScenarioId" IS NOT NULL\)$/);
    // Not a list of states that would leave one out (review: the OPTIMIZING re-plan was dropped).
    expect(sql).not.toMatch(/rp\.status = 'FAILED'/);
  });
});

describe('dashboard: cost per case counts every case once (review of PR3: 1/N with N depots)', () => {
  it("each plan's cases are the orders of its own depot and day (legacy depot-less orders only with one active depot)", async () => {
    const sql = flat(PLAN_ORDERS_IN_SCOPE);
    expect(sql).toContain('o."tenantId" = rp."tenantId" AND o."deliveryDate" = rp."runDate"');
    expect(sql).toContain('AND (o."depotId" = rp."depotId" OR (o."depotId" IS NULL AND (SELECT COUNT(*) FROM "Depot" d WHERE d."tenantId" = rp."tenantId" AND d.active) <= 1))');
    captured.length = 0;
    await getDashboardData('t1');
    const range = captured.filter((q) => q.includes('AS cases_total'));
    expect(range).toHaveLength(3);
    for (const q of range) expect(q).toContain(`FROM "Order" o WHERE ${sql} ) AS case_totals`);
  });
});
