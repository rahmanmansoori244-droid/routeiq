/**
 * Operations alerts (owner request 16 Oct 2026): the company's alert lock, a transaction-level advisory
 * lock on `ops-alerts:<tenantId>` (critique M4). The sweep takes it with pg_try_advisory_xact_lock
 * around reading the facts and writing OpsAlert, and skips the company while someone else holds it: two
 * web processes during a zero-downtime deploy can no longer close and reopen the same row from facts of
 * different moments (a reopen clears the e-mail state, so the alert would be e-mailed twice). The e-mail
 * claim (notify.ts) takes it the same way. Start fresh waits for it (pg_advisory_xact_lock under its lock
 * timeout) before it deletes the company's rows, so a sweep in flight never writes rows for data just
 * removed (critique H2).
 *
 * The holder of this lock takes no other lock in that transaction (the sweep only reads and writes
 * OpsAlert; Start fresh takes it last), so it never closes a cycle with the plan, outcome or link locks.
 * One exception (cause & action, review of the branch of 20 Oct 2026, finding 1): a save or removal of a
 * cause & action waits for this lock, then for the company's e-mail lock (notify.ts lockTenantDigest), then
 * writes OpsAlert rows and its audit rows (inbox.ts lockForReview). Nothing takes the e-mail lock before this
 * one, so that order closes no cycle either.
 */
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export function alertsLockKey(tenantId: string): string {
  return `ops-alerts:${tenantId}`;
}

/** True when this transaction now holds the company's alert lock; false when another holds it (skip the company). */
export async function tryLockTenantAlerts(tx: Tx, tenantId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${alertsLockKey(tenantId)}, 0)) AS locked`;
  return rows[0]?.locked === true;
}

/** Waits for the company's alert lock (the transaction's lock timeout applies). Start fresh. */
export async function lockTenantAlerts(tx: Tx, tenantId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${alertsLockKey(tenantId)}, 0))`;
}
