/**
 * Single source of truth for what a route sheet contains, regardless of
 * Excel or PDF rendering. Pull once, render twice.
 */
import { prisma } from '../db';

export interface RouteStop {
  sequence: number;
  customerCode: string;
  customerName: string;
  branchKey: string;
  address: string | null;
  cases: number;
  weightKg: number;
  plannedArrivalMin: number;
  plannedDistanceFromPrevKm: number;
  notes: string | null;
  locked: boolean;
}

export interface TruckRoute {
  truckId: string;
  truckCode: string;
  truckDescription: string | null;
  stops: RouteStop[];
  totalCases: number;
  totalWeightKg: number;
  totalDistanceKm: number;
  finalArrivalMin: number;
  capacityCases: number;
  utilizationPct: number;
}

export interface UnservedRow {
  customerCode: string;
  customerName: string;
  branchKey: string;
  cases: number;
  reasonCode: string;
  reasonMessage: string | null;
}

export interface BaselineComparison {
  baselineFileName: string | null;
  truckDelta: number | null;
  distanceDelta: number | null;
  truckPct: number | null;
  distancePct: number | null;
}

export interface RouteSheet {
  tenant: { name: string; currency: string };
  run: {
    id: string;
    runDate: string;
    depotCode: string;
    depotName: string;
    optimizationMode: string;
    status: string;
    finalizedAt: string | null;
    chosenScenarioName: string | null;
    distanceProvider: 'HAVERSINE' | 'MAPBOX_MATRIX' | 'OSRM';
    distanceIsEstimated: boolean;
  };
  routes: TruckRoute[];
  unserved: UnservedRow[];
  totals: {
    trucks: number;
    stops: number;
    cases: number;
    weightKg: number;
    distanceKm: number;
  };
  baselineComparison: BaselineComparison | null;
}

export async function buildRouteSheet(tenantId: string, runId: string): Promise<RouteSheet> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true, currency: true, config: { select: { distanceProvider: true, labelEstimatedDistances: true } } },
  });

  const run = await prisma.runPlan.findFirstOrThrow({
    where: { id: runId, tenantId },
    include: {
      depot: { select: { code: true, name: true } },
      routes: {
        orderBy: [{ truckId: 'asc' }, { sequenceInTruck: 'asc' }],
        include: {
          truck: { select: { id: true, code: true, description: true, capacityCases: true } },
          order: {
            select: {
              id: true,
              notes: true,
              totalCases: true,
              totalWeightKg: true,
              customer: { select: { code: true, name: true, branchKey: true, address: true } },
            },
          },
        },
      },
      scenarios: {
        where: {},
        select: {
          id: true,
          name: true,
          detailsJson: true,
          unservedOrders: {
            include: {
              order: {
                select: {
                  totalCases: true,
                  customer: { select: { code: true, name: true, branchKey: true } },
                },
              },
            },
          },
        },
      },
      manualBaselines: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  const chosen = run.scenarios.find((s) => s.id === run.chosenScenarioId) ?? null;
  // Label from how THIS plan was computed (stored with its scenario), not from today's setting.
  const stored = (chosen?.detailsJson ?? null) as { distance_is_estimated?: unknown; matrix_provider?: unknown; distance_provider?: unknown } | null;
  const storedProvider = [stored?.matrix_provider, stored?.distance_provider].find(
    (p): p is 'HAVERSINE' | 'MAPBOX_MATRIX' | 'OSRM' => p === 'HAVERSINE' || p === 'MAPBOX_MATRIX' || p === 'OSRM',
  );
  const computedEstimated =
    typeof stored?.distance_is_estimated === 'boolean' ? stored.distance_is_estimated : tenant.config?.distanceProvider === 'HAVERSINE';
  const isEstimated = computedEstimated && (tenant.config?.labelEstimatedDistances ?? true);

  // Group assignments by truck.
  const byTruck = new Map<string, TruckRoute>();
  for (const r of run.routes) {
    let truck = byTruck.get(r.truckId);
    if (!truck) {
      truck = {
        truckId: r.truckId,
        truckCode: r.truck.code,
        truckDescription: r.truck.description,
        stops: [],
        totalCases: 0,
        totalWeightKg: 0,
        totalDistanceKm: 0,
        finalArrivalMin: 0,
        capacityCases: r.truck.capacityCases,
        utilizationPct: 0,
      };
      byTruck.set(r.truckId, truck);
    }
    truck.stops.push({
      sequence: r.sequenceInTruck,
      customerCode: r.order.customer.code,
      customerName: r.order.customer.name,
      branchKey: r.order.customer.branchKey,
      address: r.order.customer.address,
      cases: r.portionCases ?? r.order.totalCases,
      weightKg: r.portionWeightKg ?? r.order.totalWeightKg,
      plannedArrivalMin: r.plannedArrivalMin,
      plannedDistanceFromPrevKm: r.plannedDistanceFromPrevKm,
      notes: r.order.notes,
      locked: r.lockedByUserId !== null,
    });
    truck.totalCases += r.portionCases ?? r.order.totalCases;
    truck.totalWeightKg += r.portionWeightKg ?? r.order.totalWeightKg;
    truck.totalDistanceKm += r.plannedDistanceFromPrevKm;
    truck.finalArrivalMin = Math.max(truck.finalArrivalMin, r.plannedArrivalMin);
  }
  for (const t of byTruck.values()) {
    t.utilizationPct = t.capacityCases > 0 ? Math.round((t.totalCases / t.capacityCases) * 1000) / 10 : 0;
  }
  const routes = Array.from(byTruck.values()).sort((a, b) => a.truckCode.localeCompare(b.truckCode));

  // Unserved comes from the chosen scenario (if any) or aggregated from all scenarios.
  const unserved: UnservedRow[] = (chosen?.unservedOrders ?? []).map((u) => ({
    customerCode: u.order.customer.code,
    customerName: u.order.customer.name,
    branchKey: u.order.customer.branchKey,
    cases: u.portionCases ?? u.order.totalCases,
    reasonCode: u.reasonCode,
    reasonMessage: u.reasonMessage,
  }));

  const totals = routes.reduce(
    (a, t) => {
      a.trucks += 1;
      a.stops += t.stops.length;
      a.cases += t.totalCases;
      a.weightKg += t.totalWeightKg;
      a.distanceKm += t.totalDistanceKm;
      return a;
    },
    { trucks: 0, stops: 0, cases: 0, weightKg: 0, distanceKm: 0 },
  );

  // Baseline comparison if a baseline exists.
  let baselineComparison: BaselineComparison | null = null;
  const latestBaseline = run.manualBaselines[0];
  if (latestBaseline && chosen) {
    const truckDelta = totals.trucks - latestBaseline.totalTrucks;
    const distanceDelta =
      latestBaseline.totalDistanceKm !== null ? totals.distanceKm - latestBaseline.totalDistanceKm : null;
    baselineComparison = {
      baselineFileName: latestBaseline.fileName,
      truckDelta,
      distanceDelta,
      truckPct: latestBaseline.totalTrucks > 0 ? (truckDelta / latestBaseline.totalTrucks) * 100 : null,
      distancePct:
        latestBaseline.totalDistanceKm && latestBaseline.totalDistanceKm > 0
          ? ((totals.distanceKm - latestBaseline.totalDistanceKm) / latestBaseline.totalDistanceKm) * 100
          : null,
    };
  }

  return {
    tenant: { name: tenant.name, currency: tenant.currency },
    run: {
      id: run.id,
      runDate: run.runDate.toISOString().slice(0, 10),
      depotCode: run.depot.code,
      depotName: run.depot.name,
      optimizationMode: run.optimizationMode,
      status: run.status,
      finalizedAt: run.finalizedAt?.toISOString() ?? null,
      chosenScenarioName: chosen?.name ?? null,
      distanceProvider: storedProvider ?? tenant.config?.distanceProvider ?? 'HAVERSINE',
      distanceIsEstimated: isEstimated,
    },
    routes,
    unserved,
    totals,
    baselineComparison,
  };
}

export function kmLabel(isEstimated: boolean): string {
  return isEstimated ? 'Estimated km' : 'Km';
}

export function fmtArrival(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
