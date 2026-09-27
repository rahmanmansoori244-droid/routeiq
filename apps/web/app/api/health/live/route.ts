import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/health/live - LIVENESS (audit F15): the web process answers. It checks nothing else
 * (no database, no solver), so a process-restart probe never restarts a healthy web because a
 * dependency is down. Dispatch readiness, the deploy gate, is GET /api/health.
 */
export function GET() {
  return NextResponse.json({ ok: true, service: 'web' }, { headers: { 'Cache-Control': 'no-store' } });
}
