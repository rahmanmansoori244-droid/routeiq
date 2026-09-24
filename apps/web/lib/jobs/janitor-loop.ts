/**
 * In-process janitor. Production has no cron service calling /api/cron/janitor, so without
 * this a job orphaned by a restart (every push to main redeploys web) would keep its plan
 * OPTIMIZING forever and block that depot and day. Web runs as one replica, and the reaper
 * only touches jobs older than any real optimization, so a job still running in the previous
 * container during a zero-downtime deploy is never failed.
 */
import { reapStuckJobs } from './optimize-job';
import { reapStaleShifts } from './shift-janitor';

const INTERVAL_MS = 60_000;
const g = globalThis as unknown as { __routeiqJanitor?: NodeJS.Timeout };

async function sweep() {
  try {
    const [jobs, shifts] = await Promise.all([reapStuckJobs(), reapStaleShifts()]);
    if (jobs.reaped || shifts.reaped) console.warn('janitor: reaped', { jobs: jobs.reaped, shifts: shifts.reaped });
  } catch (err) {
    // The database may not be reachable yet at boot; the next sweep retries.
    console.error('janitor: sweep failed', (err as Error)?.message ?? err);
  }
}

export function startJanitor(): void {
  if (process.env.ROUTEIQ_DISABLE_JANITOR === '1' || g.__routeiqJanitor) return;
  g.__routeiqJanitor = setInterval(sweep, INTERVAL_MS);
  g.__routeiqJanitor.unref();
  setTimeout(sweep, 5_000).unref();
}
