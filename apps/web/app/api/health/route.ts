import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

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

async function checkSolver(): Promise<'up' | 'down'> {
  const url = process.env.SOLVER_URL;
  if (!url) return 'down';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`${url}/health`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) return 'down';
    const body = (await r.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

export async function GET() {
  const [db, solver] = await Promise.all([checkDb(), checkSolver()]);
  const ok = db === 'up' && solver === 'up';
  return NextResponse.json({ ok, db, solver }, { status: ok ? 200 : 503 });
}
