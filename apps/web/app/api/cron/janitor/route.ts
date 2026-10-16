/**
 * Orphan janitor — CLAUDE.md §7 plus driver-shift cleanup.
 *
 * Marks any RunJob RUNNING (or still QUEUED) whose process is gone - no
 * heartbeat for 5 min (STALE_HEARTBEAT_MS); a job from before heartbeats
 * 15 min after it started (STUCK_JOB_MS) - as FAILED with reason STUCK and rolls
 * its parent RunPlan to FAILED. This is the safety net for jobs orphaned by
 * container restarts (the in-memory `inflight` map disappears with the
 * process; the DB row is left dangling).
 *
 * Also closes any DriverShift in ACTIVE state older than 18h — without this
 * a driver who never explicitly ends their shift leaves the row hanging,
 * polluting the live dispatcher view forever.
 *
 * Triggered by:
 *   - the web process itself every 60 s (lib/jobs/janitor-loop.ts, started from instrumentation.ts)
 *   - this route, for manual runs or an external cron
 *
 * Auth: requires header `X-Janitor-Token` (or `Authorization: Bearer`) matching env
 * `JANITOR_TOKEN`. In production there is no fallback: without JANITOR_TOKEN every call is
 * refused, so this public endpoint never accepts the solver's service secret. Outside
 * production (local dev) it falls back to SOLVER_TOKEN to keep config minimal.
 * Uses timing-safe comparison so a malicious caller can't byte-extract the
 * token via response-time deltas.
 */
import { NextResponse } from 'next/server';
import { reapStuckJobs } from '@/lib/jobs/optimize-job';
import { reapStaleShifts } from '@/lib/jobs/shift-janitor';
import { completeReturnedLoads } from '@/lib/delivery/event-service';
import { runDeliveryJanitor } from '@/lib/jobs/delivery-janitor';
import { failLostHireChecks, retireOneDayTrucks } from '@/lib/dispatch/hire-whatif';
import { janitorAuthorized } from '@/lib/janitor-auth';
import { runIvmsTick } from '@/lib/ivms/poll';
import { runIvmsRetention } from '@/lib/ivms/retention';

export const dynamic = 'force-dynamic';

function authorize(req: Request): boolean {
  return janitorAuthorized(req);
}

async function runJanitor() {
  const [jobs, shifts] = await Promise.all([reapStuckJobs(), reapStaleShifts()]);
  // Delivery outcome: loads reported back at the depot with a result on every stop are completed.
  const returnedLoads = await completeReturnedLoads();
  // Retention: old photo bytes, old driver positions, idle daily drivers (run now, not every 10 min).
  const deliveryRetention = await runDeliveryJanitor(new Date(), { force: true });
  // The hire suggestion: what-ifs lost with their process; one-day hired trucks whose day is over.
  const hire = { lostChecks: await failLostHireChecks(), oneDayTrucksRetired: await retireOneDayTrucks() };
  // IVMS live link (16 Oct 2026): one tick now (`force` skips the wait only while the allowance is ample)
  // and the GPS retention. Both null - and the answer exactly as before - while the link is not in use
  // (no AYUN_* variables, the kill switch, ivmsMode OFF, no GPS data).
  // Each in its own try, as in the in-process janitor (first review LOW): a database error there never turns
  // the answer into a 500 after the steps above already ran; its code only is logged and answered.
  const now = new Date();
  const step = async <T,>(name: string, run: () => Promise<T>): Promise<T | { error: string }> => {
    try {
      return await run();
    } catch (err) {
      const code = String((err as { code?: string; name?: string } | null)?.code ?? (err as Error)?.name ?? 'error').slice(0, 40);
      console.error(`janitor: ${name} failed`, code);
      return { error: code };
    }
  };
  const ivmsTick = await step('ivms tick', () => runIvmsTick(now, { force: true }));
  const ivmsRetention = await step('ivms retention', () => runIvmsRetention(now, { force: true }));
  const ivms = ivmsTick || ivmsRetention ? { tick: ivmsTick, retention: ivmsRetention } : null;
  return { jobs, shifts, returnedLoads, deliveryRetention, hire, ...(ivms ? { ivms } : {}) };
}

export async function POST(req: Request) {
  if (!authorize(req)) return NextResponse.json({ data: null, error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ data: await runJanitor(), error: null });
}

// Also support GET so it can be triggered from a browser during local debugging.
export async function GET(req: Request) {
  if (!authorize(req)) return NextResponse.json({ data: null, error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ data: await runJanitor(), error: null });
}
