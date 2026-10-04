/**
 * The outcome-day lock (owner request 4 Oct 2026, spec sections 8.3 and 9.1): every write of a
 * delivery result, arrival, departure or photo for one depot and delivery date takes it, and so do
 * Bring forward and Undo bring forward (Part 3), so a result change and a carry never interleave.
 * Start fresh (lib/start-fresh.ts) takes it for every depot-day it removes, so no result is written
 * for a day while that day is being removed.
 *
 * Lock order (plan-locks.ts): intake -> day locks -> outcome-day locks -> RunPlan rows -> PlanLoad rows.
 * A driver action takes only this lock; the load completion that may follow runs in its own
 * transaction after the action committed.
 */
import type { Prisma } from '@prisma/client';

export function outcomesLockKey(tenantId: string, depotId: string, dateIso: string): string {
  return `outcomes:${tenantId}|${depotId}|${dateIso}`;
}

export async function lockOutcomesDay(tx: Prisma.TransactionClient, tenantId: string, depotId: string, dateIso: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${outcomesLockKey(tenantId, depotId, dateIso)}, 0))`;
}
