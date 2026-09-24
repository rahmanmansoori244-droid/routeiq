import { withTenantApi, ok, fail } from '@/lib/api';
import { callRouteGeometry } from '@/lib/solver-client';

interface Params { params: { id: string } }

// GET /api/runs/:id/load-geometry - road polyline per load (depot -> stops -> depot) via the
// solver's configured OSRM; straight segments (flagged estimated) when routing is unavailable.
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db, user }) => {
    const run = await db.runPlan.findUnique({ where: { id: params.id }, include: { depot: true } });
    if (!run) return fail('Not found', 404);
    const cfg = await db.tenantConfig.findUnique({ where: { tenantId: user.tenantId } });
    const loads = await db.planLoad.findMany({
      where: { runId: run.id },
      include: {
        truck: { select: { code: true } },
        assignments: { orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }], include: { order: { include: { customer: { select: { lat: true, lng: true } } } } } },
      },
    });
    const out = [];
    for (const l of loads) {
      const pts: [number, number][] = [[run.depot.lat, run.depot.lng]];
      const seen = new Set<number>();
      for (const a of l.assignments) {
        if (seen.has(a.sequenceInTruck)) continue;
        seen.add(a.sequenceInTruck);
        const c = a.order.customer;
        if (c.lat !== null && c.lng !== null) pts.push([c.lat, c.lng]);
      }
      pts.push([run.depot.lat, run.depot.lng]);
      const geo = cfg?.distanceProvider === 'HAVERSINE' ? null : await callRouteGeometry(pts, cfg?.osrmUrl);
      out.push({
        loadId: l.id,
        truckCode: l.truck.code,
        loadNo: l.loadNo,
        estimated: geo ? geo.is_estimated : true,
        coordinates: geo?.coordinates ?? pts.map(([lat, lng]) => [lng, lat]),
      });
    }
    return ok(out);
  })(req);
