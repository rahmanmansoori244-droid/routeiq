/**
 * Driver-shift janitor.
 *
 * Closes DriverShift rows still in ACTIVE state past 18 h. The driver-auth
 * `requireDriverShift()` already self-heals stale shifts when a driver next
 * hits any endpoint — but a driver who never opens the app again (lost phone,
 * battery dead, switched off the device after the route) leaves the row
 * dangling indefinitely. That row keeps the dispatcher's live view in a
 * confused state.
 *
 * Runs alongside `reapStuckJobs` from the cron route.
 */
import { prisma } from '../db';

const SHIFT_STALE_MS = 1000 * 60 * 60 * 18;

export async function reapStaleShifts(thresholdMs = SHIFT_STALE_MS): Promise<{ reaped: number }> {
  // Postgres-side comparison so we don't depend on the Node clock matching
  // the DB clock (same pattern as reapStuckJobs).
  const minutes = Math.max(1, Math.round(thresholdMs / 60_000));
  const result = await prisma.$executeRawUnsafe(
    `UPDATE "DriverShift"
       SET "status" = 'ABANDONED',
           "endedAt" = NOW()
     WHERE "status" = 'ACTIVE'
       AND "startedAt" < NOW() - ($1::int || ' minutes')::interval`,
    minutes,
  );
  return { reaped: result };
}
