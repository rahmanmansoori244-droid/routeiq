/**
 * Stabilization PR3 (review): the dashboard counts the plan in use of each day only. A version
 * written READY over its supersede before the release (supersededAt set) is never summed with its
 * live child, and a FAILED version that still holds the applied plan (a failed re-plan keeps the
 * previous plan) is counted, since that plan is the one dispatched.
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

import { getDashboardData, LIVE_PLAN_IN_USE } from '@/lib/dashboard';

describe('dashboard: the plan in use of each day only', () => {
  it('every plan query leaves out superseded versions and counts a FAILED version holding the kept plan', async () => {
    await getDashboardData('t1');
    const planQueries = captured.filter((q) => q.includes('FROM "RunPlan" rp'));
    expect(planQueries.length).toBeGreaterThanOrEqual(4); // estimated-km + three range queries
    for (const q of planQueries) {
      expect(q).toContain('rp."supersededAt" IS NULL');
      expect(q).toContain(`(rp.status IN ('READY', 'DISPATCHED') OR (rp.status = 'FAILED' AND rp."chosenScenarioId" IS NOT NULL))`);
    }
  });

  it('the condition itself', () => {
    const sql = LIVE_PLAN_IN_USE.sql.replace(/\s+/g, ' ');
    expect(sql).toMatch(/^rp\."supersededAt" IS NULL AND /);
    expect(LIVE_PLAN_IN_USE.values).toEqual([]);
  });
});
