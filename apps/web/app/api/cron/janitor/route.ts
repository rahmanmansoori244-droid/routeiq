/**
 * Orphan janitor — CLAUDE.md §7 plus driver-shift cleanup.
 *
 * Marks any RunJob stuck in RUNNING > 5 minutes as FAILED with reason STUCK
 * and rolls its parent RunPlan to FAILED. This is the safety net for jobs
 * orphaned by container restarts (the in-memory `inflight` map disappears
 * with the process; the DB row is left dangling).
 *
 * Also closes any DriverShift in ACTIVE state older than 18h — without this
 * a driver who never explicitly ends their shift leaves the row hanging,
 * polluting the live dispatcher view forever.
 *
 * Triggered by:
 *   - Railway Cron service (recommended in production) hitting POST every 60s
 *   - Self-poll from in-process setInterval (Phase 5 polish)
 *
 * Auth: requires header `X-Janitor-Token` matching env `JANITOR_TOKEN`.
 * In dev, `JANITOR_TOKEN` defaults to the SOLVER_TOKEN to keep config minimal.
 * Uses timing-safe comparison so a malicious caller can't byte-extract the
 * token via response-time deltas.
 */
import { NextResponse } from 'next/server';
import { reapStuckJobs } from '@/lib/jobs/optimize-job';
import { reapStaleShifts } from '@/lib/jobs/shift-janitor';
import { constantTimeEqual } from '@/lib/driver-auth';

export const dynamic = 'force-dynamic';

function authorize(req: Request): boolean {
  const expected = process.env.JANITOR_TOKEN ?? process.env.SOLVER_TOKEN ?? '';
  if (!expected) return false;
  const got = req.headers.get('x-janitor-token') ?? req.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';
  if (!got) return false;
  return constantTimeEqual(got, expected);
}

async function runJanitor() {
  const [jobs, shifts] = await Promise.all([reapStuckJobs(), reapStaleShifts()]);
  return { jobs, shifts };
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
