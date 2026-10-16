import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { emailDeliveryConfigured } from '@/lib/password-reset';
import { checkDispatchReadiness, overallReadiness, solverField } from '@/lib/health';
import { alertSweepHealth } from '@/lib/alerts/sweep';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function checkDb(): Promise<'up' | 'down'> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return 'up';
  } catch {
    return 'down';
  }
}

/**
 * GET /api/health - READINESS, Railway's deploy health check (audit F15, owner decision 5; the
 * process-only liveness is GET /api/health/live). See lib/health.ts:
 * - 503 `not_ready`: the database is down, or dispatch is misconfigured (SOLVER_URL / SOLVER_TOKEN
 *   missing on web, a SOLVER_URL no call can use such as one without http://, a SOLVER_TOKEN that
 *   is not plain ASCII, the solver refuses the token with 401, or the solver has no token) - a
 *   deploy with this fault fails its health check and the previous version keeps serving;
 * - 200 `degraded` (`ok: false`): the solver could not be asked (unreachable, timeout, an older
 *   solver, an error or a redirect in front of it), or its worker processes could not start, or
 *   stopped, recently (rule 22, `SOLVER_WORKERS_FAILED`: an optimization was refused, or a plan's
 *   load re-check was skipped) - alert, but do not
 *   block the deploy;
 * - 200 `ready` (`ok: true`).
 * It never starts an optimization. `routing`, `email` and `alerts` are informational and never change
 * the answer: without OSRM plans still work (distances labelled estimated) - alert on
 * routing.status !== 'up' instead; without email, tenant admins reset passwords on the Users
 * screen ("Reset password", POST /api/users/:id/reset-password); `alerts` says when the
 * operations-alert sweep last ran in this process and how many companies' last sweep failed or is
 * overdue (counts only, never a company; review of 16 Oct 2026, M2).
 */
export async function GET() {
  const [db, dispatch] = await Promise.all([checkDb(), checkDispatchReadiness()]);
  const { status, httpStatus } = overallReadiness(db, dispatch);
  const email = emailDeliveryConfigured() ? 'configured' : 'not_configured';
  return NextResponse.json(
    {
      ok: status === 'ready',
      status,
      db,
      solver: solverField(dispatch),
      dispatch: { status: dispatch.status, reason: dispatch.reason, message: dispatch.message },
      routing: dispatch.routing,
      email,
      alerts: alertSweepHealth(),
    },
    { status: httpStatus, headers: { 'Cache-Control': 'no-store' } },
  );
}
