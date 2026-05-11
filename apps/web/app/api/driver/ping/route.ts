/**
 * GPS ping endpoint (Module C).
 *
 * The driver PWA calls this every ~30s with the device's geolocation. Body:
 *   { lat, lng, ts (ms), speedKmh?, headingDeg?, accuracyM?, batteryPct? }
 *
 * Auth via ``X-Driver-Token`` header. Inserts one ``TruckLocation`` row.
 * We do NOT validate the lat/lng range strictly because a few bad samples
 * are acceptable — the dispatcher view averages or filters anyway.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireDriverShift } from '@/lib/driver-auth';
import { rateLimit } from '@/lib/rate-limit';

const bodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  ts: z.number().int().positive(),
  speedKmh: z.number().min(0).max(300).optional(),
  headingDeg: z.number().min(0).max(360).optional(),
  accuracyM: z.number().min(0).optional(),
  batteryPct: z.number().int().min(0).max(100).optional(),
});

export async function POST(req: Request) {
  const token = req.headers.get('x-driver-token') ?? '';

  // Validate the shift BEFORE rate limiting so unauthenticated requests don't
  // pollute the per-token bucket (the previous slice(0,16) key meant empty
  // tokens shared one bucket — an attacker could exhaust it for everyone).
  let ctx;
  try {
    ctx = await requireDriverShift(token);
  } catch {
    return NextResponse.json({ data: null, error: 'Unauthorized.' }, { status: 401 });
  }

  // Per-shift rate limit: max ~4 pings/second (normal is 1 ping/30s = 0.03/s).
  // Key by the SHIFT id (not the token) so it's safe to log and shows up in
  // metrics correctly.
  const rl = rateLimit(`driver:ping:${ctx.shiftId}`, 240, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ data: null, error: 'Too many pings.' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ data: null, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ data: null, error: 'Bad ping payload.' }, { status: 400 });
  }
  const p = parsed.data;

  const ts = new Date(p.ts);
  if (Number.isNaN(ts.getTime())) {
    return NextResponse.json({ data: null, error: 'Invalid timestamp.' }, { status: 400 });
  }

  await prisma.truckLocation.create({
    data: {
      tenantId: ctx.tenantId,
      shiftId: ctx.shiftId,
      truckId: ctx.truckId,
      ts,
      lat: p.lat,
      lng: p.lng,
      speedKmh: p.speedKmh ?? null,
      headingDeg: p.headingDeg ?? null,
      accuracyM: p.accuracyM ?? null,
      batteryPct: p.batteryPct ?? null,
    },
  });

  return NextResponse.json({ data: { ok: true }, error: null }, { status: 200 });
}
