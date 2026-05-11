/**
 * End-shift endpoint.
 *
 * Marks the driver's current DriverShift as COMPLETED. Without this, a shift
 * stays ACTIVE until the next login (or the 18h staleness janitor) — which is
 * harmless but pollutes the live dispatcher view for hours after a driver
 * finishes their run.
 *
 * Body (optional): { notes?: string }
 * Auth: X-Driver-Token header.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { endShift, requireDriverShift } from '@/lib/driver-auth';
import { audit } from '@/lib/audit';

const bodySchema = z.object({ notes: z.string().max(500).optional() });

export async function POST(req: Request) {
  const token = req.headers.get('x-driver-token') ?? '';

  let ctx;
  try {
    ctx = await requireDriverShift(token);
  } catch {
    return NextResponse.json({ data: null, error: 'Unauthorized.' }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }
  const parsed = bodySchema.safeParse(body);
  const notes = parsed.success ? parsed.data.notes?.trim() || null : null;

  await endShift(token, notes);

  await audit({
    tenantId: ctx.tenantId,
    userId: null,
    action: 'UPDATE',
    entity: 'DriverShift',
    entityId: ctx.shiftId,
    beforeJson: { status: 'ACTIVE' } as never,
    afterJson: { status: 'COMPLETED', endedByDriver: true, notes } as never,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  });

  return NextResponse.json({ data: { ok: true }, error: null }, { status: 200 });
}
