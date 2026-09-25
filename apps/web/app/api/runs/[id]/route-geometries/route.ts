/**
 * Road-route geometry for the legacy run-detail Map tab (May-2026 runs, read-only).
 *
 * Returns, per truck, the polyline depot -> ordered stops -> depot. Since stabilization PR5
 * (review F22) it goes through the solver's private /route-geometry (lib/solver-client.ts
 * callRouteGeometry) with the tenant's routing server, like /load-geometry for dispatch plans: the
 * web never calls a routing service itself (no Mapbox, no OSRM, no public server). When the solver
 * or routing is unavailable the stops are joined by straight lines (provider 'fallback').
 *
 * Dispatch plans (loads, a RECOMMENDED option, or a later version) answer 409: their map uses
 * GET /api/runs/[id]/load-geometry, one polyline per LOAD (grouping by truck would merge loads).
 *
 * GET /api/runs/[id]/route-geometries
 *
 * Response:
 *   { data: { trucks: [{ truckId, truckCode, coordinates: [[lng,lat], ...], distanceKm, durationMin, provider, waypointCount }],
 *             provider: 'osrm' | 'fallback' | 'mixed' } }
 * distanceKm / durationMin: 0 (the geometry service returns the shape only; the run's own figures
 * are on its route sheets).
 */
import { withTenantApi, ok, fail, notFoundIfNull } from '@/lib/api';
import { callRouteGeometry } from '@/lib/solver-client';
import { DISPATCH_PLAN_REFUSAL, isDispatchPlan } from '@/lib/dispatch/legacy-runs';

interface Params { params: { id: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db, user }) => {
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
    if (await isDispatchPlan(user.tenantId, run.id)) {
      return fail({ ...DISPATCH_PLAN_REFUSAL, error: 'This is a daily dispatch plan: its map is drawn per load (GET /api/runs/[id]/load-geometry).', code: 'USE_LOAD_GEOMETRY' }, 409);
    }
    const cfg = await db.tenantConfig.findUnique({ where: { tenantId: user.tenantId }, select: { osrmUrl: true } });

    // Stops per truck, in visit order (a legacy run has one route per truck).
    const byTruck = new Map<string, { code: string; stops: { lat: number; lng: number; sequence: number }[] }>();
    for (const r of run.routes) {
      const c = r.order.customer;
      if (c.lat == null || c.lng == null) continue;
      const entry = byTruck.get(r.truckId) ?? { code: r.truck.code, stops: [] };
      entry.stops.push({ lat: c.lat, lng: c.lng, sequence: r.sequenceInTruck });
      byTruck.set(r.truckId, entry);
    }

    const depot: [number, number] = [run.depot.lat, run.depot.lng];
    let useSolver = true;
    const trucks = [];
    // One truck at a time: a legacy run has a handful, and a down solver is noticed once.
    for (const [truckId, entry] of byTruck) {
      const pts: [number, number][] = [depot, ...[...entry.stops].sort((a, b) => a.sequence - b.sequence).map((s) => [s.lat, s.lng] as [number, number]), depot];
      const geo = useSolver ? await callRouteGeometry(pts, cfg?.osrmUrl) : null;
      if (!geo) useSolver = false;
      const roads = !!geo && !geo.is_estimated;
      trucks.push({
        truckId,
        truckCode: entry.code,
        coordinates: roads ? geo!.coordinates : pts.map(([lat, lng]) => [lng, lat] as [number, number]),
        distanceKm: 0,
        durationMin: 0,
        provider: roads ? ('osrm' as const) : ('fallback' as const),
        waypointCount: pts.length,
      });
    }
    const providers = new Set(trucks.map((t) => t.provider));
    const aggregate = providers.size === 1 ? [...providers][0]! : providers.size === 0 ? 'fallback' : 'mixed';
    return ok({ trucks, provider: aggregate });
  })(req);
