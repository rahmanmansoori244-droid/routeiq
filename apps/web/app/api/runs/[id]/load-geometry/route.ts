import { withTenantApi, ok, fail } from '@/lib/api';
import { callRouteGeometry } from '@/lib/solver-client';
import { prisma } from '@/lib/db';
import { routingProviderFor } from '@/lib/dispatch/customer-attrs';
import { isDispatchDetails } from '@/lib/dispatch/plan-service';
import { readPlanInputs, readStopSnapshot } from '@/lib/dispatch/snapshots';

interface Params { params: { id: string } }

// GET /api/runs/:id/load-geometry - road polyline per load (depot -> stops -> depot) via the
// solver's configured OSRM; straight segments (flagged estimated) when routing is unavailable.
// Review F08: drawn through the pins each stop was PLANNED with (its snapshot) and from the depot
// the plan was made from, so a pin corrected later never redraws a locked or dispatched load;
// rows planned before snapshots existed use today's customer pin.
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
    const chosen = run.chosenScenarioId ? await prisma.scenarioResult.findFirst({ where: { id: run.chosenScenarioId, runId: run.id }, select: { detailsJson: true } }) : null;
    const raw: unknown = chosen?.detailsJson;
    const inputs = isDispatchDetails(raw) ? readPlanInputs(raw.inputs) : null;
    const depot: [number, number] = inputs ? [inputs.depot.lat, inputs.depot.lng] : [run.depot.lat, run.depot.lng];
    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { country: true } });
    let useRoads = !!cfg && routingProviderFor(cfg, tenant?.country).provider === 'OSRM';
    const out = [];
    for (const l of loads) {
      const pts: [number, number][] = [depot];
      const seen = new Set<number>();
      for (const a of l.assignments) {
        if (seen.has(a.sequenceInTruck)) continue;
        seen.add(a.sequenceInTruck);
        const snap = readStopSnapshot(a.stopSnapshotJson);
        const lat = snap ? snap.lat : a.order.customer.lat;
        const lng = snap ? snap.lng : a.order.customer.lng;
        if (lat !== null && lng !== null) pts.push([lat, lng]);
      }
      pts.push(depot);
      const geo = useRoads ? await callRouteGeometry(pts, cfg?.osrmUrl) : null;
      // Routing down, slow or not configured: straight lines for the remaining loads instead of
      // one timeout each. A single load OSRM cannot route (e.g. no road to one stop) does not stop the rest.
      const routeSpecific = /noroute|no route|nosegment/i.test(geo?.warning ?? '');
      if (!geo || (geo.is_estimated && !routeSpecific)) useRoads = false;
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
