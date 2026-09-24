/**
 * Everything the dispatcher reviews for one plan version - used by the plan screen AND the
 * Excel export so both always show identical numbers.
 */
import { prisma } from '../db';
import { tenantDb } from '../tenant';
import { effectiveAttrs, describeWindows, type TypeProfileLike } from './customer-attrs';
import { aggregateSkus, type Reconciliation } from './reconcile';
import type { ChangeSummary, DailySummary } from './summary';
import type { ScenarioDetails } from './plan-service';
import { fmtWindow, isoOf } from './time';

export interface DetailStop {
  sequence: number;
  customerId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  customerType: string | null;
  lat: number | null;
  lng: number | null;
  priority: number;
  etaMin: number | null;
  serviceStartMin: number | null;
  departureMin: number | null;
  waitMin: number | null;
  window: string;
  hardWindow: string | null;
  serviceMin: number;
  cases: number;
  weightKg: number;
  legKm: number;
  cumulativeKm: number | null;
  hardWindowOk: boolean | null;
  prefWindowOk: boolean | null;
  late: boolean;
  orderIds: string[];
  salesOrders: string[];
  skus: { productCode: string; productName: string; cases: number; weightKg: number }[];
  mapsUrl: string | null;
}

export interface DetailLoad {
  id: string;
  truckId: string;
  truckCode: string;
  truckCapacityCases: number;
  truckPayloadKg: number;
  driverName: string | null;
  loadNo: number;
  status: string;
  carried: boolean;
  departMin: number;
  returnMin: number;
  distanceKm: number;
  durationMin: number;
  cases: number;
  weightKg: number;
  utilizationPct: number;
  fuelLitres: number | null;
  fuelCost: number;
  operatingCost: number;
  returnLegKm: number;
  distanceIsEstimated: boolean;
  stops: DetailStop[];
  manifest: { productCode: string; productName: string; cases: number; weightKg: number }[];
}

export interface DetailUnserved {
  orderId: string;
  customerId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  cases: number;
  weightKg: number;
  priority: number;
  reasonCode: string;
  reasonMessage: string | null;
  late: boolean;
  salesOrders: string[];
}

export interface PlanDetail {
  run: {
    id: string;
    version: number;
    status: string;
    reason: string;
    reasonNote: string | null;
    runDate: string;
    depot: { id: string; code: string; name: string; lat: number; lng: number };
    parentRunId: string | null;
    createdAt: string;
    supersededAt: string | null;
    chosenScenario: string | null;
  };
  summary: DailySummary | null;
  reconciliation: Reconciliation | null;
  change: ChangeSummary | null;
  scenarios: {
    id: string;
    name: string;
    status: string;
    solverStatus: string;
    solverTimeSec: number;
    trucksUsed: number;
    trips: number;
    totalKm: number;
    totalDurationMin: number;
    operatingCost: number;
    avgUtilizationPct: number;
    unservedOrders: number;
    distanceIsEstimated: boolean;
    provider: string;
    objective: ScenarioDetails['objective'] | null;
    chosen: boolean;
  }[];
  loads: DetailLoad[];
  unserved: DetailUnserved[];
  versions: { id: string; version: number; status: string; reason: string; reasonNote: string | null; createdAt: string; changeText: string | null }[];
  job: { id: string; status: string; message: string | null; progressPct: number; startedAt: string | null; finishedAt: string | null } | null;
  warnings: string[];
}

export async function getPlanDetail(tenantId: string, runId: string): Promise<PlanDetail | null> {
  const db = tenantDb(tenantId);
  const run = await db.runPlan.findUnique({ where: { id: runId }, include: { depot: true } });
  if (!run) return null;
  const cfg = await db.tenantConfig.findUnique({ where: { tenantId } });
  const profiles = new Map<string, TypeProfileLike>((await db.customerTypeProfile.findMany()).map((p) => [p.customerType, p]));
  const scenarios = await prisma.scenarioResult.findMany({ where: { runId }, orderBy: { createdAt: 'asc' }, include: { unservedOrders: true } });
  const chosen = scenarios.find((s) => s.id === run.chosenScenarioId) ?? null;
  const chosenDetails = chosen?.detailsJson as unknown as ScenarioDetails | undefined;
  const loads = await db.planLoad.findMany({
    where: { runId },
    orderBy: [{ truck: { code: 'asc' } }, { loadNo: 'asc' }],
    include: {
      truck: { select: { code: true, capacityCases: true, capacityWeightKg: true } },
      driver: { select: { name: true } },
      assignments: {
        orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }],
        include: {
          order: {
            include: {
              customer: true,
              lines: { include: { product: { select: { code: true, name: true } } } },
            },
          },
        },
      },
    },
  });
  const priorityOf = (orderId: string, fallback: number) => chosenDetails?.scope.orderPriority[orderId] ?? fallback;
  const detailLoads: DetailLoad[] = loads.map((l) => {
    const stops = new Map<number, DetailStop>();
    for (const a of l.assignments) {
      const o = a.order;
      const c = o.customer;
      const eff = effectiveAttrs(c, profiles, { serviceTimeMin: cfg?.defaultServiceTimeMin ?? 10 });
      const skus = o.lines.map((ln) => ({ productCode: ln.product.code, productName: ln.product.name, cases: ln.cases, weightKg: ln.weightKg }));
      const s = stops.get(a.sequenceInTruck);
      if (s) {
        s.cases += o.totalCases;
        s.weightKg += o.totalWeightKg;
        s.orderIds.push(o.id);
        s.salesOrders = [...new Set([...s.salesOrders, ...o.lines.map((ln) => ln.salesOrderNo).filter((x): x is string => !!x)])];
        s.skus = aggregateSkus([...s.skus, ...skus]);
        s.late = s.late || o.isLate;
        s.priority = Math.min(s.priority, priorityOf(o.id, o.priority));
        continue;
      }
      stops.set(a.sequenceInTruck, {
        sequence: a.sequenceInTruck,
        customerId: c.id,
        customerCode: c.code,
        branchCode: c.branchCode,
        customerName: c.name,
        customerType: c.customerType,
        lat: c.lat,
        lng: c.lng,
        priority: priorityOf(o.id, o.priority),
        etaMin: a.etaMin,
        serviceStartMin: a.serviceStartMin,
        departureMin: a.departureMin,
        waitMin: a.waitMin,
        window: describeWindows(eff),
        hardWindow: eff.hardStart !== null || eff.hardEnd !== null ? fmtWindow(eff.hardStart, eff.hardEnd) : null,
        serviceMin: eff.serviceMin,
        cases: o.totalCases,
        weightKg: o.totalWeightKg,
        legKm: a.plannedDistanceFromPrevKm,
        cumulativeKm: a.cumulativeKm,
        hardWindowOk: a.hardWindowOk,
        prefWindowOk: a.prefWindowOk,
        late: o.isLate,
        orderIds: [o.id],
        salesOrders: [...new Set(o.lines.map((ln) => ln.salesOrderNo).filter((x): x is string => !!x))],
        skus: aggregateSkus(skus),
        mapsUrl: c.lat !== null && c.lng !== null ? `https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}` : null,
      });
    }
    const stopList = [...stops.values()].sort((a, b) => a.sequence - b.sequence);
    return {
      id: l.id,
      truckId: l.truckId,
      truckCode: l.truck.code,
      truckCapacityCases: l.truck.capacityCases,
      truckPayloadKg: l.truck.capacityWeightKg,
      driverName: l.driver?.name ?? null,
      loadNo: l.loadNo,
      status: l.status,
      carried: !!l.carriedFromLoadId,
      departMin: l.departMin,
      returnMin: l.returnMin,
      distanceKm: l.distanceKm,
      durationMin: l.durationMin,
      cases: l.cases,
      weightKg: l.weightKg,
      utilizationPct: l.utilizationPct,
      fuelLitres: l.fuelLitres,
      fuelCost: l.fuelCost,
      operatingCost: l.operatingCost,
      returnLegKm: l.returnLegKm,
      distanceIsEstimated: l.distanceIsEstimated,
      stops: stopList,
      manifest: aggregateSkus(stopList.flatMap((s) => s.skus)),
    };
  });

  const unservedRows = chosen?.unservedOrders ?? [];
  const unservedOrders = unservedRows.length
    ? await prisma.order.findMany({
        where: { tenantId, id: { in: unservedRows.map((u) => u.orderId) } },
        include: { customer: true, lines: { select: { salesOrderNo: true } } },
      })
    : [];
  const uo = new Map(unservedOrders.map((o) => [o.id, o]));
  const unserved: DetailUnserved[] = unservedRows
    .map((u): DetailUnserved | null => {
      const o = uo.get(u.orderId);
      if (!o) return null;
      return {
        orderId: o.id,
        customerId: o.customerId,
        customerCode: o.customer.code,
        branchCode: o.customer.branchCode,
        customerName: o.customer.name,
        cases: o.totalCases,
        weightKg: o.totalWeightKg,
        priority: priorityOf(o.id, o.priority),
        reasonCode: u.reasonCode,
        reasonMessage: u.reasonMessage,
        late: o.isLate,
        salesOrders: [...new Set(o.lines.map((l) => l.salesOrderNo).filter((x): x is string => !!x))],
      };
    })
    .filter((x): x is DetailUnserved => x !== null)
    .sort((a, b) => a.priority - b.priority || b.cases - a.cases);

  const versions = await db.runPlan.findMany({
    where: { depotId: run.depotId, runDate: run.runDate },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, status: true, reason: true, reasonNote: true, createdAt: true, changeSummaryJson: true },
  });
  const job = await db.runJob.findFirst({ where: { runId }, orderBy: { attemptNo: 'desc' } });
  return {
    run: {
      id: run.id,
      version: run.version,
      status: run.status,
      reason: run.reason,
      reasonNote: run.reasonNote,
      runDate: isoOf(run.runDate),
      depot: { id: run.depot.id, code: run.depot.code, name: run.depot.name, lat: run.depot.lat, lng: run.depot.lng },
      parentRunId: run.parentRunId,
      createdAt: run.createdAt.toISOString(),
      supersededAt: run.supersededAt?.toISOString() ?? null,
      chosenScenario: chosen?.name ?? null,
    },
    summary: (run.summaryJson as unknown as DailySummary) ?? null,
    reconciliation: (run.reconciliationJson as unknown as Reconciliation) ?? null,
    change: (run.changeSummaryJson as unknown as ChangeSummary) ?? null,
    scenarios: scenarios.map((s) => {
      const d = s.detailsJson as unknown as Partial<ScenarioDetails>;
      return {
        id: s.id,
        name: s.name,
        status: d.status ?? 'OPTIMIZED',
        solverStatus: d.solver_status ?? '',
        solverTimeSec: d.solver_time_sec ?? 0,
        trucksUsed: s.trucksUsed,
        trips: d.trips ?? 0,
        totalKm: s.totalDistanceKm,
        totalDurationMin: s.totalTimeMin,
        operatingCost: s.totalCost,
        avgUtilizationPct: s.avgUtilizationPct,
        unservedOrders: s.unservedCount,
        distanceIsEstimated: d.distance_is_estimated ?? true,
        provider: d.matrix_provider ?? 'HAVERSINE',
        objective: d.objective ?? null,
        chosen: s.id === run.chosenScenarioId,
      };
    }),
    loads: detailLoads,
    unserved,
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status,
      reason: v.reason,
      reasonNote: v.reasonNote,
      createdAt: v.createdAt.toISOString(),
      changeText: (v.changeSummaryJson as { text?: string } | null)?.text ?? null,
    })),
    job: job
      ? { id: job.id, status: job.status, message: job.message, progressPct: job.progressPct, startedAt: job.startedAt?.toISOString() ?? null, finishedAt: job.finishedAt?.toISOString() ?? null }
      : null,
    warnings: chosenDetails ? [...new Set([...chosenDetails.response_warnings, ...chosenDetails.warnings])] : [],
  };
}
