/**
 * In-process janitor. Production has no cron service calling /api/cron/janitor, so without
 * this a job orphaned by a restart (every push to main redeploys web) would keep its plan
 * OPTIMIZING forever and block that depot and day. Web runs as one replica, and the reaper
 * only touches jobs whose process stopped writing their heartbeat 5 minutes ago (jobs from before
 * heartbeats: 15 minutes after they started), so a job still running in the previous container
 * during a zero-downtime deploy - even a 20-minute thorough search - is never failed.
 */
import { reapStuckJobs } from './optimize-job';
import { reapStaleShifts } from './shift-janitor';
import { completeReturnedLoads } from '../delivery/event-service';

const INTERVAL_MS = 60_000;
const g = globalThis as unknown as { __routeiqJanitor?: NodeJS.Timeout };

async function sweep() {
  try {
    const [jobs, shifts] = await Promise.all([reapStuckJobs(), reapStaleShifts()]);
    if (jobs.reaped || jobs.repaired || shifts.reaped) console.warn('janitor: reaped', { jobs: jobs.reaped, stuckPlansRepaired: jobs.repaired, shifts: shifts.reaped });
  } catch (err) {
    // The database may not be reachable yet at boot; the next sweep retries.
    console.error('janitor: sweep failed', (err as Error)?.message ?? err);
  }
  // Delivery outcome (owner request 4 Oct 2026): a load the driver reported back at the depot is
  // completed once every stop has a result (spec section 8.7). Its own try: it never stops the reaper.
  try {
    const returned = await completeReturnedLoads();
    if (returned.completed) console.warn('janitor: returned loads completed', returned);
  } catch (err) {
    console.error('janitor: returned loads not checked', (err as Error)?.message ?? err);
  }
}

export function startJanitor(): void {
  if (process.env.ROUTEIQ_DISABLE_JANITOR === '1' || g.__routeiqJanitor) return;
  g.__routeiqJanitor = setInterval(sweep, INTERVAL_MS);
  g.__routeiqJanitor.unref();
  setTimeout(sweep, 5_000).unref();
}
