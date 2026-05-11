/**
 * Live truck positions for a given run (Module C — dispatcher view).
 *
 * GET /api/runs/[id]/live — returns each truck's latest GPS sample, stop
 * progress, next planned stop, and a simple distance-to-next indicator.
 * Tenant-scoped via withTenantApi.
 */
import { withTenantApi, ok, notFoundIfNull } from '@/lib/api';

const OFFLINE_AFTER_MIN = 10;

interface Params { params: { id: string } }

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    const run = notFoundIfNull(
      await db.runPlan.findUnique({
        where: { id: params.id },
        select: {
          id: true,
          runDate: true,
          depot: { select: { name: true, lat: true, lng: true } },
          routes: {
            select: {
              id: true,
              truckId: true,
              sequenceInTruck: true,
              plannedArrivalMin: true,
              deliveryProof: { select: { id: true } },
              order: {
                select: {
                  customer: { select: { code: true, name: true, lat: true, lng: true } },
                },
              },
            },
            orderBy: { sequenceInTruck: 'asc' },
          },
        },
      }),
    );

    const byTruck = new Map<string, typeof run.routes>();
    for (const r of run.routes) {
      const arr = byTruck.get(r.truckId) ?? [];
      arr.push(r);
      byTruck.set(r.truckId, arr);
    }

    const latestLocations = await Promise.all(
      Array.from(byTruck.keys()).map(async (truckId) => {
        const loc = await db.truckLocation.findFirst({
          where: { truckId },
          orderBy: { ts: 'desc' },
          select: { ts: true, lat: true, lng: true, speedKmh: true, headingDeg: true, shiftId: true },
        });
        return [truckId, loc] as const;
      }),
    );

    const truckCodes = await db.truck.findMany({
      where: { id: { in: Array.from(byTruck.keys()) } },
      select: { id: true, code: true },
    });
    const truckCodeById = new Map(truckCodes.map((t) => [t.id, t.code]));

    const now = Date.now();
    const out = latestLocations.map(([truckId, loc]) => {
      const stops = byTruck.get(truckId) ?? [];
      const total = stops.length;
      const done = stops.filter((s) => s.deliveryProof).length;
      const nextStop = stops.find((s) => !s.deliveryProof);
      const truckCode = truckCodeById.get(truckId) ?? '???';

      if (!loc) {
        return {
          truckId,
          truckCode,
          shiftId: null,
          lastTs: null,
          lat: null,
          lng: null,
          speedKmh: null,
          headingDeg: null,
          totalStops: total,
          doneStops: done,
          nextStop: nextStop
            ? {
                assignmentId: nextStop.id,
                sequence: nextStop.sequenceInTruck,
                customerCode: nextStop.order.customer.code,
                customerName: nextStop.order.customer.name,
                lat: nextStop.order.customer.lat,
                lng: nextStop.order.customer.lng,
                plannedArrivalMin: nextStop.plannedArrivalMin,
              }
            : null,
          distanceToNextKm: null,
          status: 'OFFLINE' as const,
        };
      }

      const offlineMin = (now - loc.ts.getTime()) / 60_000;
      let status: 'ON_PLAN' | 'BEHIND' | 'AHEAD' | 'OFFLINE' = 'ON_PLAN';
      if (offlineMin > OFFLINE_AFTER_MIN) status = 'OFFLINE';

      let distanceToNextKm: number | null = null;
      const nextLat = nextStop?.order.customer.lat ?? null;
      const nextLng = nextStop?.order.customer.lng ?? null;
      if (nextLat != null && nextLng != null) {
        distanceToNextKm = haversineKm(loc.lat, loc.lng, nextLat, nextLng);
      }

      return {
        truckId,
        truckCode,
        shiftId: loc.shiftId,
        lastTs: loc.ts.toISOString(),
        lat: loc.lat,
        lng: loc.lng,
        speedKmh: loc.speedKmh,
        headingDeg: loc.headingDeg,
        totalStops: total,
        doneStops: done,
        nextStop: nextStop
          ? {
              assignmentId: nextStop.id,
              sequence: nextStop.sequenceInTruck,
              customerCode: nextStop.order.customer.code,
              customerName: nextStop.order.customer.name,
              lat: nextStop.order.customer.lat,
              lng: nextStop.order.customer.lng,
              plannedArrivalMin: nextStop.plannedArrivalMin,
            }
          : null,
        distanceToNextKm,
        status,
      };
    });

    return ok({
      run: {
        id: run.id,
        runDate: run.runDate.toISOString().slice(0, 10),
        depotName: run.depot.name,
        depotLat: run.depot.lat,
        depotLng: run.depot.lng,
      },
      trucks: out,
    });
  })(req);
