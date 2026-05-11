/**
 * Driver PWA manifest endpoint.
 *
 * GET /api/driver/manifest — returns today's stops for the driver's truck,
 * in planned sequence, plus whether each stop is already marked done. Auth
 * via ``X-Driver-Token`` header.
 *
 * Response shape:
 *   {
 *     driver: { id, name },
 *     truck:  { id, code },
 *     run:    { id, runDate, depotName, depotLat, depotLng } | null,
 *     stops:  [{ assignmentId, sequence, customerCode, customerName, address,
 *                lat, lng, plannedArrivalMin, plannedLoadCases, doneAt }]
 *   }
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireDriverShift } from '@/lib/driver-auth';
import { rateLimit } from '@/lib/rate-limit';

export async function GET(req: Request) {
  const token = req.headers.get('x-driver-token') ?? '';
  let ctx;
  try {
    ctx = await requireDriverShift(token);
  } catch {
    return NextResponse.json({ data: null, error: 'Unauthorized.' }, { status: 401 });
  }

  // Per-shift rate limit. The PWA only refreshes manifest on user action
  // (pull-to-refresh / after marking done) so 60/min/shift is generous.
  const rl = rateLimit(`driver:manifest:${ctx.shiftId}`, 60, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ data: null, error: 'Too many requests.' }, { status: 429 });
  }

  const [driver, truck, run, assignments] = await Promise.all([
    prisma.driver.findUnique({
      where: { id: ctx.driverId },
      select: { id: true, name: true },
    }),
    prisma.truck.findUnique({
      where: { id: ctx.truckId },
      select: { id: true, code: true, description: true },
    }),
    ctx.runId
      ? prisma.runPlan.findUnique({
          where: { id: ctx.runId },
          select: {
            id: true,
            runDate: true,
            depot: { select: { name: true, lat: true, lng: true } },
          },
        })
      : Promise.resolve(null),
    ctx.runId
      ? prisma.routeAssignment.findMany({
          where: { runId: ctx.runId, truckId: ctx.truckId },
          orderBy: { sequenceInTruck: 'asc' },
          select: {
            id: true,
            sequenceInTruck: true,
            plannedArrivalMin: true,
            plannedDistanceFromPrevKm: true,
            plannedLoadCases: true,
            order: {
              select: {
                id: true,
                totalCases: true,
                customer: {
                  select: {
                    code: true,
                    name: true,
                    address: true,
                    lat: true,
                    lng: true,
                    // Customer model has no phone field in v1 — drop the call-button UI
                    // until v2 adds it. Driver PWA gracefully hides the button when null.
                  },
                },
              },
            },
            deliveryProof: { select: { id: true, completedAt: true, notes: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  return NextResponse.json({
    data: {
      driver,
      truck,
      run: run
        ? {
            id: run.id,
            runDate: run.runDate.toISOString().slice(0, 10),
            depotName: run.depot.name,
            depotLat: run.depot.lat,
            depotLng: run.depot.lng,
          }
        : null,
      stops: assignments.map((a) => ({
        assignmentId: a.id,
        sequence: a.sequenceInTruck,
        customerCode: a.order.customer.code,
        customerName: a.order.customer.name,
        customerPhone: null as string | null,
        address: a.order.customer.address ?? null,
        lat: a.order.customer.lat,
        lng: a.order.customer.lng,
        plannedArrivalMin: a.plannedArrivalMin,
        plannedLoadCases: a.plannedLoadCases,
        cases: a.order.totalCases,
        doneAt: a.deliveryProof?.completedAt?.toISOString() ?? null,
      })),
    },
    error: null,
  });
}
