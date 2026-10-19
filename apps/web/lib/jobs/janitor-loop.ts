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
import { runDeliveryJanitor } from './delivery-janitor';
import { failLostHireChecks, retireOneDayTrucks } from '../dispatch/hire-whatif';
import { runAlertSweep } from '../alerts/sweep';
import { sendAlertDigest } from '../alerts/notify';
import { startIvmsTimer } from '../ivms/poll';
import { ivmsRetentionChanged, runIvmsRetention } from '../ivms/retention';
import { analysisChanged, runAnalysisJob } from '../analysis/job';

const INTERVAL_MS = 60_000;
/** The returned-loads sweep: the last result already completes a load at once; this is the safety net. */
const RETURNED_EVERY_MS = 10 * 60_000;
const g = globalThis as unknown as { __routeiqJanitor?: NodeJS.Timeout; __routeiqReturnedSweepAt?: number };

async function sweep() {
  try {
    const [jobs, shifts] = await Promise.all([reapStuckJobs(), reapStaleShifts()]);
    if (jobs.reaped || jobs.repaired || shifts.reaped) console.warn('janitor: reaped', { jobs: jobs.reaped, stuckPlansRepaired: jobs.repaired, shifts: shifts.reaped });
  } catch (err) {
    // The database may not be reachable yet at boot; the next sweep retries.
    console.error('janitor: sweep failed', (err as Error)?.message ?? err);
  }
  // Delivery outcome (owner request 4 Oct 2026): a load the driver reported back at the depot is
  // completed once every stop has a result (spec section 8.7). The last result normally completes it
  // at once, so this safety net runs at most every 10 min. Its own try: it never stops the reaper.
  const nowMs = Date.now();
  if (!g.__routeiqReturnedSweepAt || nowMs - g.__routeiqReturnedSweepAt >= RETURNED_EVERY_MS) {
    g.__routeiqReturnedSweepAt = nowMs;
    try {
      const returned = await completeReturnedLoads();
      if (returned.completed) console.warn('janitor: returned loads completed', returned);
    } catch (err) {
      console.error('janitor: returned loads not checked', (err as Error)?.message ?? err);
    }
  }
  // The hire suggestion (owner request 6 Oct 2026): a what-if lost with its process is ended, and
  // one-day hired trucks whose day is over are retired. Its own try as well.
  try {
    const [lost, retired] = await Promise.all([failLostHireChecks(), retireOneDayTrucks()]);
    if (lost || retired) console.warn('janitor: hire', { lostChecks: lost, oneDayTrucksRetired: retired });
  } catch (err) {
    console.error('janitor: hire sweep not run', (err as Error)?.message ?? err);
  }
  // Retention (spec section 12.4): old photo bytes, old driver positions and idle daily drivers, at
  // most every 10 min (the daily drivers once a day). Its own try as well.
  try {
    const kept = await runDeliveryJanitor();
    if (kept && (kept.photos.count || kept.locations.events || kept.locations.visits || kept.locations.photos || kept.casual?.deactivated || kept.casual?.phonesCleared || kept.alerts?.alerts || kept.alerts?.digests)) {
      console.warn('janitor: delivery retention', kept);
    }
  } catch (err) {
    console.error('janitor: delivery retention not run', (err as Error)?.message ?? err);
  }
  // The analysis dataset (owner request 19 Oct 2026: "build on more data for our analysis later and
  // improvement", lib/analysis/job.ts): from about 03:00 company time the day before is built while its GPS
  // trail still exists (so before the GPS retention below), the 2nd to 4th days before are refreshed and the
  // 4th frozen, and facts older than analysisRetentionDays are deleted. At most every 10 min, at most 20 s of
  // work per run (the rest at the next run), and its own try: it never stops the GPS retention or the alert
  // sweep after it. ROUTEIQ_DISABLE_ANALYSIS=1 skips it.
  try {
    const facts = await runAnalysisJob();
    if (analysisChanged(facts)) console.warn('janitor: analysis facts', facts);
  } catch (err) {
    console.error('janitor: analysis facts not built', (err as { code?: string } | null)?.code ?? (err as Error)?.name ?? 'error');
  }
  // IVMS live link (16 Oct 2026): the trackers' trail, live positions and depot moves age out (at most
  // every 10 min; one EXISTS and nothing else while no GPS data exists). Its own try as well.
  try {
    const gps = await runIvmsRetention();
    if (ivmsRetentionChanged(gps)) console.warn('janitor: GPS tracking retention', gps);
  } catch (err) {
    console.error('janitor: GPS tracking retention not run', (err as { code?: string } | null)?.code ?? (err as Error)?.name ?? 'error');
  }
  // Operations alerts (owner request 16 Oct 2026): the companies that switched them on, at most every
  // 2 min (lib/alerts/sweep.ts throttles and logs), each followed by its e-mail digest (lib/alerts/notify.ts:
  // sends only with Resend set up and recipients saved, never in the quiet hours). Its own try as well;
  // ROUTEIQ_DISABLE_ALERTS=1 skips it.
  if (process.env.ROUTEIQ_DISABLE_ALERTS !== '1') {
    try {
      await runAlertSweep(new Date(), { notify: sendAlertDigest });
    } catch (err) {
      console.error('janitor: alerts not checked', (err as Error)?.message ?? err);
    }
  }
}

export function startJanitor(): void {
  if (process.env.ROUTEIQ_DISABLE_JANITOR === '1' || g.__routeiqJanitor) return;
  g.__routeiqJanitor = setInterval(sweep, INTERVAL_MS);
  g.__routeiqJanitor.unref();
  setTimeout(sweep, 5_000).unref();
  // IVMS live link (16 Oct 2026): the calls to Ayun run on their own 15 s timer (lib/ivms/poll.ts), so a
  // slow provider never delays the steps above. Not started at all without the AYUN_* variables or with
  // ROUTEIQ_DISABLE_IVMS=1; with them, nothing is called while the company's ivmsMode is OFF.
  startIvmsTimer();
}
