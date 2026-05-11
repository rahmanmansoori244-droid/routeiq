/**
 * Orphan janitor — CLAUDE.md §7.
 *
 * Marks any RunJob stuck in RUNNING > 5 minutes as FAILED with reason STUCK
 * and rolls its parent RunPlan to FAILED. This is the safety net for jobs
 * orphaned by container restarts (the in-memory `inflight` map disappears
 * with the process; the DB row is left dangling).
 *
 * Triggered by:
 *   - Railway Cron service (recommended in production) hitting POST every 60s
 *   - Self-poll from in-process setInterval (Phase 5 polish)
 *
 * Auth: requires header `X-Janitor-Token` matching env `JANITOR_TOKEN`.
 * In dev, `JANITOR_TOKEN` defaults to the SOLVER_TOKEN to keep config minimal.
 */
import { NextResponse } from 'next/server';
import { reapStuckJobs } from '@/lib/jobs/optimize-job';

export const dynamic = 'force-dynamic';

function authorize(req: Request): boolean {
  const expected = process.env.JANITOR_TOKEN ?? process.env.SOLVER_TOKEN ?? '';
  if (!expected) return false;
  const got = req.headers.get('x-janitor-token') ?? req.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';
  return got === expected;
}

export async function POST(req: Request) {
  if (!authorize(req)) return NextResponse.json({ data: null, error: 'Unauthorized' }, { status: 401 });
  const r = await reapStuckJobs();
  return NextResponse.json({ data: r, error: null });
}

// Also support GET so it can be triggered from a browser during local debugging.
export async function GET(req: Request) {
  if (!authorize(req)) return NextResponse.json({ data: null, error: 'Unauthorized' }, { status: 401 });
  const r = await reapStuckJobs();
  return NextResponse.json({ data: r, error: null });
}
