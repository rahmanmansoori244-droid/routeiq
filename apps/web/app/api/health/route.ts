import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { emailDeliveryConfigured } from '@/lib/password-reset';

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

type Routing = { provider: string; status: 'up' | 'down' | 'not_configured' } | null;

async function checkSolver(): Promise<{ solver: 'up' | 'down'; routing: Routing }> {
  const url = process.env.SOLVER_URL;
  if (!url) return { solver: 'down', routing: null };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${url}/health`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) return { solver: 'down', routing: null };
    const body = (await r.json().catch(() => null)) as { ok?: boolean; routing?: Routing } | null;
    return { solver: body?.ok ? 'up' : 'down', routing: body?.routing ?? null };
  } catch {
    return { solver: 'down', routing: null };
  }
}

// `routing` is informational: without OSRM plans still work (distances labelled estimated), so
// it never makes the app unhealthy - alert on routing.status !== 'up' in monitoring instead.
// `email` is informational too: without it password-reset emails are not sent (tenant admins
// reset passwords on the Users screen instead: "Reset password", POST /api/users/:id/reset-password).
export async function GET() {
  const [db, { solver, routing }] = await Promise.all([checkDb(), checkSolver()]);
  const ok = db === 'up' && solver === 'up';
  const email = emailDeliveryConfigured() ? 'configured' : 'not_configured';
  return NextResponse.json({ ok, db, solver, routing, email }, { status: ok ? 200 : 503 });
}
