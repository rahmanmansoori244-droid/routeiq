/**
 * Real road-route geometry for the legacy run-detail Map tab.
 *
 * Returns, per truck, the full polyline of road shape-nodes that connects
 * depot → ordered stops → depot. The client uses these to draw curved,
 * road-snapped lines instead of straight `[depot,stop1,stop2,...,depot]`
 * Haversine guesses.
 *
 * Geometries are resolved via Mapbox Directions (MAPBOX_TOKEN) → the self-hosted
 * OSRM (OSRM_URL; no public default) → straight lines. See `lib/road-routing.ts`.
 *
 * GET /api/runs/[id]/route-geometries
 *
 * Response:
 *   {
 *     data: {
 *       trucks: [{
 *         truckId, truckCode,
 *         coordinates: [[lng,lat], ...],   // GeoJSON LineString shape
 *         distanceKm, durationMin, provider,
 *         waypointCount,
 *       }],
 *       provider: 'osrm' | 'mapbox' | 'fallback' | 'mixed',
 *     }
 *   }
 */
import { withTenantApi, ok, notFoundIfNull } from '@/lib/api';
import { getRouteGeometry, type LngLat } from '@/lib/road-routing';

interface Params { params: { id: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    const run = notFoundIfNull(
      await db.runPlan.findUnique({
        where: { id: params.id },
        include: {
          depot: { select: { lat: true, lng: true } },
          routes: {
            orderBy: [{ truckId: 'asc' }, { sequenceInTruck: 'asc' }],
            include: {
              truck: { select: { id: true, code: true } },
              order: { include: { customer: { select: { lat: true, lng: true } } } },
            },
          },
        },
      }),
    );

    // Group stops by truck.
    interface Stop { lat: number; lng: number; sequence: number }
    const byTruck = new Map<string, { code: string; stops: Stop[] }>();
    for (const r of run.routes) {
      const c = r.order.customer;
      if (c.lat == null || c.lng == null) continue;
      const entry = byTruck.get(r.truckId) ?? { code: r.truck.code, stops: [] };
      entry.stops.push({ lat: c.lat, lng: c.lng, sequence: r.sequenceInTruck });
      byTruck.set(r.truckId, entry);
    }

    const depot: LngLat = [run.depot.lng, run.depot.lat];

    // Resolve geometry per truck. Run in parallel — providers handle their own
    // rate limits and cache; this is the right tradeoff for ~8 trucks per run.
    const trucks = await Promise.all(
      [...byTruck.entries()].map(async ([truckId, entry]) => {
        const ordered = [...entry.stops].sort((a, b) => a.sequence - b.sequence);
        const waypoints: LngLat[] = [depot];
        for (const s of ordered) waypoints.push([s.lng, s.lat]);
        waypoints.push(depot);
        const geom = await getRouteGeometry(waypoints);
        return {
          truckId,
          truckCode: entry.code,
          coordinates: geom.coordinates,
          distanceKm: Math.round(geom.distanceKm * 100) / 100,
          durationMin: geom.durationMin,
          provider: geom.provider,
          waypointCount: waypoints.length,
        };
      }),
    );

    const providers = new Set(trucks.map((t) => t.provider));
    const aggregate = providers.size === 1 ? [...providers][0]! : 'mixed';

    return ok({ trucks, provider: aggregate });
  })(req);
