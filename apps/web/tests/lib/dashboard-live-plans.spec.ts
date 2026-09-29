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
    tenant: { findUniqueOrThrow: vi.fn(async () => ({ currency: 'OMR', config: { distanceProvider: 'OSRM', timezone: 'Asia/Muscat' } })) },
    runPlan: { findMany: vi.fn(async () => []) },
  },
}));

import { getDashboardData, LIVE_PLAN_IN_USE, PLAN_ORDERS_IN_SCOPE, rollupRows, type RawRunRow } from '@/lib/dashboard';

const flat = (s: Prisma.Sql) => s.sql.replace(/\s+/g, ' ').trim();

describe('dashboard: the plan in use of each depot and day, once', () => {
  it('every plan query counts only the current version of each depot and day, holding a plan in use', async () => {
    await getDashboardData('t1');
    const planQueries = captured.filter((q) => q.includes('FROM "RunPlan" rp'));
    expect(planQueries.length).toBeGreaterThanOrEqual(4); // estimated-km + three range queries
    for (const q of planQueries) expect(q).toContain(flat(LIVE_PLAN_IN_USE));
  });

  it('re-planned days count every load of the plan in use (its summary), not only the new loads of the chosen option', async () => {
    captured.length = 0;
    await getDashboardData('t1');
    const range = captured.filter((q) => q.includes('AS run_count'));
    expect(range.length).toBe(3);
    for (const q of range) {
      expect(q).toContain(`COALESCE((rp."summaryJson"->>'operatingCost')::float8, sr."totalCost")`);
      expect(q).toContain(`COALESCE((rp."summaryJson"->>'trucksUsed')::int, sr."trucksUsed")`);
      expect(q).toContain(`COALESCE((rp."summaryJson"->>'totalKm')::float8, sr."totalDistanceKm")`);
    }
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
  it("each plan's cases are the orders of its own depot and day (every order has a depot: owner rule, audit PR A5)", async () => {
    const sql = flat(PLAN_ORDERS_IN_SCOPE);
    expect(sql).toBe('o."tenantId" = rp."tenantId" AND o."deliveryDate" = rp."runDate" AND o."depotId" = rp."depotId"');
    captured.length = 0;
    await getDashboardData('t1');
    const range = captured.filter((q) => q.includes('AS cases_total'));
    expect(range).toHaveLength(3);
    for (const q of range) expect(q).toContain(`FROM "Order" o WHERE ${sql} ) AS case_totals`);
  });
});

describe('dashboard: cost per case is rounded once, at the 3 decimals it is shown with (audit F23)', () => {
  const day = (cost: number, cases: number): RawRunRow => ({
    date: '2026-09-27', run_count: 1n, trucks_used: 1n, distance_km: 10, cost, avg_util: 50, orders_total: 1n, orders_unserved: 0n, cases_total: cases,
  });

  it('900 OMR over 20,000 cases is 0.045 (it showed 0.050), and 0.0449 / 0.0451 both read 0.045 with no change between them', () => {
    expect(rollupRows([day(900, 20_000)], '2026-09-27').costPerCase).toBe(0.045);
    expect(rollupRows([day(900, 20_000)], '2026-09-27').costPerCase.toFixed(3)).toBe('0.045');
    const a = rollupRows([day(449, 10_000)], '2026-09-27').costPerCase;
    const b = rollupRows([day(451, 10_000)], '2026-09-28').costPerCase;
    expect([a, b, b - a]).toEqual([0.045, 0.045, 0]);
    expect(rollupRows([day(6, 100)], '2026-09-27').costPerCase).toBe(0.06);
  });
});
