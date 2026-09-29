import { withTenantApi, ok, fail } from '@/lib/api';
import { callRouteGeometry } from '@/lib/solver-client';
import { prisma } from '@/lib/db';
import { routingProviderFor } from '@/lib/dispatch/customer-attrs';
import { isDispatchDetails } from '@/lib/dispatch/plan-service';
import { readLoadOrigin, readPlanInputs, readStopSnapshot, readTruckSnapshot } from '@/lib/dispatch/snapshots';
import { resolveLoadGeometries, roadShapeCache, routingOffReason, type LoadPath } from '@/lib/dispatch/load-geometry';
import { loadPath } from '@/lib/dispatch/load-path';

interface Params { params: { id: string } }

// GET /api/runs/:id/load-geometry - road polyline per load (depot -> stops -> depot) via the
// solver's configured OSRM, 4 loads at a time within one 20 s deadline, road shapes cached in memory
// (lib/dispatch/load-geometry.ts). A load that cannot get its road shape comes back as straight
// segments with `estimated: true` and a `reason`; the other loads keep their road shapes.
// Review F08: drawn through the pins each stop was PLANNED with (its snapshot) and from the depot
// the plan was made from, so a pin corrected later never redraws a locked or dispatched load;
// rows planned before snapshots existed use today's customer pin. Each row carries `pointsKey`, the
// fingerprint of its path, built by the same `loadPath` the map uses on the stops it shows
// (getPlanDetail: one stop per sequence at its first order's planned pin, the plan's depot), so the
// map can tell when its plan is behind this answer. Audit E1: each load starts and ends at the depot
// pin it was planned from (its truck snapshot's origin; getPlanDetail's DetailLoad.origin), so a
// locked or dispatched load is never redrawn from a depot pin moved since.
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
    const depot = inputs ? { lat: inputs.depot.lat, lng: inputs.depot.lng } : { lat: run.depot.lat, lng: run.depot.lng };
    const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { country: true } });
    // Road routing off (Settings), outside the shared road map, or no settings row: no solver call,
    // and each reason gets its own caption on the map.
    const offReason = routingOffReason(cfg ? routingProviderFor(cfg, tenant?.country) : null);
    const osrmUrl = cfg?.osrmUrl?.trim() || null;
    const paths: LoadPath[] = loads.map((l) => {
      // One stop per sequence, in sequence order, at its first order's planned pin (as getPlanDetail).
      const stops = new Map<number, { lat: number | null; lng: number | null }>();
      for (const a of l.assignments) {
        if (stops.has(a.sequenceInTruck)) continue;
        const snap = readStopSnapshot(a.stopSnapshotJson);
        stops.set(a.sequenceInTruck, snap ? { lat: snap.lat, lng: snap.lng } : a.order.customer);
      }
      const inOrder = [...stops.entries()].sort(([x], [y]) => x - y).map(([, c]) => c);
      const origin = readLoadOrigin(readTruckSnapshot(l.truckSnapshotJson)) ?? depot;
      return { loadId: l.id, truckCode: l.truck.code, loadNo: l.loadNo, points: loadPath({ lat: origin.lat, lng: origin.lng }, inOrder) };
    });
    const rows = await resolveLoadGeometries(paths, {
      call: offReason ? null : (pts, signal) => callRouteGeometry(pts, osrmUrl, { signal }),
      offReason: offReason ?? undefined,
      routingKey: osrmUrl ? `osrm:${osrmUrl}` : 'solver-default',
      cache: roadShapeCache,
    });
    // A company setting or its country is not a problem to log; everything else is.
    const estimated = rows.filter((r) => r.estimated && r.reason !== 'ROUTING_OFF' && r.reason !== 'OUTSIDE_COVERAGE');
    if (estimated.length) {
      const why = [...new Set(estimated.map((r) => r.reason))].join(',');
      console.warn(`[load-geometry] run=${run.id} ${estimated.length}/${rows.length} load(s) drawn straight (${why})`);
    }
    return ok(rows);
  })(req);
