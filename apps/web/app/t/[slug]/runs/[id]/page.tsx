import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canPlan, canApproveOverride } from '@/lib/rbac';
import { notFoundIfNull } from '@/lib/api';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { RunDetail } from './run-detail';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Run detail — RouteIQ' };

export default async function RunDetailPage({
  params,
}: {
  params: { slug: string; id: string };
}) {
  const { db, tenant, user } = await getCurrentTenant(params.slug);
  const run = notFoundIfNull(
    await db.runPlan.findUnique({
      where: { id: params.id },
      include: {
        depot: { select: { id: true, code: true, name: true, lat: true, lng: true } },
        scenarios: {
          orderBy: { name: 'asc' },
          include: {
            unservedOrders: {
              include: {
                order: {
                  select: {
                    id: true,
                    totalCases: true,
                    customer: { select: { code: true, name: true, branchKey: true, lat: true, lng: true } },
                  },
                },
              },
            },
          },
        },
        jobs: {
          orderBy: { attemptNo: 'desc' },
          select: {
            id: true,
            status: true,
            attemptNo: true,
            progressPct: true,
            message: true,
            startedAt: true,
            finishedAt: true,
            createdAt: true,
          },
        },
        routes: {
          include: {
            truck: { select: { id: true, code: true, capacityCases: true } },
            order: {
              select: {
                id: true,
                totalCases: true,
                totalWeightKg: true,
                customer: { select: { id: true, code: true, name: true, branchKey: true, lat: true, lng: true } },
              },
            },
          },
          orderBy: [{ truckId: 'asc' }, { sequenceInTruck: 'asc' }],
        },
        manualBaselines: {
          orderBy: { createdAt: 'desc' },
          include: { _count: { select: { assignments: true } } },
        },
      },
    }),
  );

  // Trucks for the depot (needed by the Map tab's move dialog).
  const trucks = await db.truck.findMany({
    where: { active: true, depotId: run.depotId },
    select: { id: true, code: true, capacityCases: true },
    orderBy: { code: 'asc' },
  });

  // Compute current load per truck from assignments.
  const loadByTruck = new Map<string, number>();
  for (const r of run.routes) {
    loadByTruck.set(r.truckId, (loadByTruck.get(r.truckId) ?? 0) + r.order.totalCases);
  }

  // Choose unserved orders from the chosen scenario (if any) for the map.
  const chosen = run.scenarios.find((s) => s.id === run.chosenScenarioId) ?? null;
  const unservedForMap = (chosen?.unservedOrders ?? []).map((u) => ({
    orderId: u.order.id,
    customerCode: u.order.customer.code,
    customerName: u.order.customer.name,
    cases: u.order.totalCases,
    reason: u.reasonCode,
    lat: u.order.customer.lat,
    lng: u.order.customer.lng,
  }));

  return (
    <PageShell
      title={`Run · ${new Date(run.runDate).toISOString().slice(0, 10)}`}
      description={`${run.depot.code} — ${run.depot.name} · mode ${run.optimizationMode} · ${run.totalOrders} orders`}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={`/t/${params.slug}/runs`}>
            <ChevronLeft className="me-1 h-4 w-4" />
            All runs
          </Link>
        </Button>
      }
    >
      <RunDetail
        slug={params.slug}
        canEdit={canPlan(user.role)}
        canDispatch={canApproveOverride(user.role)}
        currency={tenant.currency}
        mapboxToken={process.env.MAPBOX_TOKEN ?? ''}
        run={{
          id: run.id,
          status: run.status,
          chosenScenarioId: run.chosenScenarioId,
          unservedCount: run.unservedCount,
          totalOrders: run.totalOrders,
          optimizationMode: run.optimizationMode,
          currentJobId: run.currentJobId,
          depot: run.depot,
          runDate: run.runDate.toISOString().slice(0, 10),
        }}
        scenarios={run.scenarios.map((s) => ({
          id: s.id,
          name: s.name,
          trucksUsed: s.trucksUsed,
          totalDistanceKm: s.totalDistanceKm,
          totalTimeMin: s.totalTimeMin,
          totalCost: s.totalCost,
          avgUtilizationPct: s.avgUtilizationPct,
          unservedCount: s.unservedCount,
          unservedOrders: s.unservedOrders.map((u) => ({
            reasonCode: u.reasonCode,
            reasonMessage: u.reasonMessage,
            order: { id: u.order.id, customerCode: u.order.customer.code, customerName: u.order.customer.name, cases: u.order.totalCases },
          })),
        }))}
        jobs={run.jobs.map((j) => ({
          id: j.id,
          attemptNo: j.attemptNo,
          status: j.status,
          progressPct: j.progressPct,
          message: j.message,
          startedAt: j.startedAt?.toISOString() ?? null,
          finishedAt: j.finishedAt?.toISOString() ?? null,
          createdAt: j.createdAt.toISOString(),
        }))}
        routes={run.routes.map((r) => ({
          id: r.id,
          truckId: r.truckId,
          truckCode: r.truck.code,
          sequence: r.sequenceInTruck,
          plannedArrivalMin: r.plannedArrivalMin,
          plannedDistanceFromPrevKm: r.plannedDistanceFromPrevKm,
          plannedLoadCases: r.plannedLoadCases,
          customerCode: r.order.customer.code,
          customerName: r.order.customer.name,
          customerBranchKey: r.order.customer.branchKey,
          customerLat: r.order.customer.lat,
          customerLng: r.order.customer.lng,
          orderCases: r.order.totalCases,
          locked: r.lockedByUserId !== null,
        }))}
        trucks={trucks.map((t) => ({
          id: t.id,
          code: t.code,
          capacityCases: t.capacityCases,
          currentLoad: loadByTruck.get(t.id) ?? 0,
        }))}
        unserved={unservedForMap}
        baselines={run.manualBaselines.map((b) => ({
          id: b.id,
          fileName: b.fileName,
          createdAt: b.createdAt.toISOString(),
          totalTrucks: b.totalTrucks,
          totalDistanceKm: b.totalDistanceKm,
          totalTimeMin: b.totalTimeMin,
          assignmentCount: b._count.assignments,
        }))}
      />
    </PageShell>
  );
}
