/**
 * Driver PWA login. POST { tenantSlug, driverCode, pin, truckId?, runId? }.
 *
 * On success returns { sessionToken, driverName, truckCode, truckId, runId }.
 * The token must be sent on every subsequent driver endpoint via the
 * ``X-Driver-Token`` header or ``token`` body field. Stored in the PWA's
 * localStorage; cleared on shift end or 18h timeout.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { loginDriver } from '@/lib/driver-auth';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { audit } from '@/lib/audit';

const bodySchema = z.object({
  tenantSlug: z.string().trim().min(1).max(64),
  driverCode: z.string().trim().min(1).max(64),
  pin: z.string().trim().min(4).max(12),
  truckId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
});

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const limit = rateLimit(`driver:login:${ip}`, LIMITS.auth.limit, LIMITS.auth.windowMs);
  if (!limit.ok) {
    return NextResponse.json(
      { data: null, error: 'Too many login attempts. Try again in a minute.' },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ data: null, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ data: null, error: 'Missing fields.' }, { status: 400 });
  }

  try {
    const result = await loginDriver(parsed.data);
    // Audit on success only. Driver login uses tenantSlug, so we don't know
    // tenantId until after loginDriver runs — that's fine because login is
    // the boundary that creates a per-tenant DriverShift anyway.
    const tenantId = await (async () => {
      const { prisma } = await import('@/lib/db');
      const t = await prisma.tenant.findUnique({ where: { slug: parsed.data.tenantSlug }, select: { id: true } });
      return t?.id ?? null;
    })();
    if (tenantId) {
      await audit({
        tenantId,
        userId: null,
        action: 'DRIVER_LOGIN',
        entity: 'DriverShift',
        entityId: result.shiftId,
        afterJson: { driverCode: parsed.data.driverCode, truckCode: result.truckCode, runId: result.runId },
        ip,
      });
    }
    return NextResponse.json({ data: result, error: null }, { status: 200 });
  } catch (err) {
    // Never reveal which field was wrong — auth-style errors look identical.
    const msg = err instanceof Error ? err.message : 'UNKNOWN';
    if (msg === 'TRUCK_REQUIRED') {
      return NextResponse.json(
        { data: null, error: 'No truck assigned for this driver — pick one in the next step.' },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { data: null, error: 'Invalid driver code, PIN, or truck.' },
      { status: 401 },
    );
  }
}
