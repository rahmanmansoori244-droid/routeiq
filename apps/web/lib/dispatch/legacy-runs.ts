/**
 * Daily dispatch plans vs legacy runs (the May-2026 PyVRP runs shown read-only under Plan
 * history). One predicate, used by the legacy run page (it redirects dispatch plans to their own
 * screen) and by the legacy run API routes, which refuse dispatch plans (review F22).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';

/** A plan made by the daily dispatch planner: it has loads, a RECOMMENDED option, or a later version. */
export const DISPATCH_PLAN_WHERE = {
  OR: [{ loads: { some: {} } }, { scenarios: { some: { name: 'RECOMMENDED' } } }, { version: { gt: 1 } }],
} satisfies Prisma.RunPlanWhereInput;

/**
 * The same rule as DISPATCH_PLAN_WHERE for a plan already read (getPlanDetail): the plan screen
 * offers the dispatch Excel workbook by it, also for a plan in which every order is unserved and
 * that therefore has no load (audit F16). Kept equal to the where clause by a unit test.
 */
export function isDispatchPlanShape(p: { loadCount: number; scenarioNames: readonly string[]; version: number }): boolean {
  return p.loadCount > 0 || p.scenarioNames.includes('RECOMMENDED') || p.version > 1;
}

export async function isDispatchPlan(tenantId: string, runId: string): Promise<boolean> {
  const hit = await prisma.runPlan.findFirst({ where: { id: runId, tenantId, ...DISPATCH_PLAN_WHERE }, select: { id: true } });
  return !!hit;
}

/** The 409 body a legacy run route answers for a dispatch plan. */
export const DISPATCH_PLAN_REFUSAL = {
  error: 'This is a daily dispatch plan: open it under Daily dispatch. This action is for legacy runs only.',
  code: 'DISPATCH_PLAN',
} as const;
