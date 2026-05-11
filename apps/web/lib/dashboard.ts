/**
 * Dashboard KPIs and trend timeseries — CLAUDE.md §12 Phase 5.
 *
 * KPIs use the "chosen scenario" of READY/DISPATCHED runs for the date. Runs
 * with no chosen scenario are excluded from cost/trucks-used totals because
 * the planner hasn't committed to a result yet.
 *
 * Late deliveries are a v2 placeholder — v1 doesn't enforce time windows.
 */
import { prisma } from './db';

export interface DayStats {
  date: string; // YYYY-MM-DD
  runCount: number;
  trucksUsed: number;
  distanceKm: number;
  cost: number;
  utilizationPct: number;
  ordersServed: number;
  ordersTotal: number;
  costPerCase: number;
}

export interface DashboardData {
  today: DayStats;
  yesterday: DayStats;
  weekToDate: DayStats & { from: string; to: string };
  previousWeek: DayStats & { from: string; to: string };
  trend: Array<Omit<DayStats, 'costPerCase' | 'utilizationPct' | 'ordersTotal'>>;
  recentRuns: RecentRun[];
  distanceIsEstimated: boolean;
  currency: string;
}

export interface RecentRun {
  id: string;
  runDate: string;
  depotCode: string;
  depotName: string;
  status: string;
  trucksUsed: number | null;
  distanceKm: number | null;
  unservedCount: number;
  totalOrders: number;
  createdAt: string;
}

interface RawRunRow {
  date: string; // ISO date
  run_count: bigint;
  trucks_used: bigint | null;
  distance_km: number | null;
  cost: number | null;
  avg_util: number | null;
  orders_total: bigint;
  orders_unserved: bigint;
  cases_total: number | null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function emptyStats(date: string): DayStats {
  return {
    date,
    runCount: 0,
    trucksUsed: 0,
    distanceKm: 0,
    cost: 0,
    utilizationPct: 0,
    ordersServed: 0,
    ordersTotal: 0,
    costPerCase: 0,
  };
}

function rollupRows(rows: RawRunRow[], date: string): DayStats {
  const totals = emptyStats(date);
  if (rows.length === 0) return totals;
  for (const r of rows) {
    totals.runCount += Number(r.run_count ?? 0);
    totals.trucksUsed += Number(r.trucks_used ?? 0);
    totals.distanceKm += Number(r.distance_km ?? 0);
    totals.cost += Number(r.cost ?? 0);
    totals.ordersTotal += Number(r.orders_total ?? 0);
    totals.ordersServed += Number(r.orders_total ?? 0) - Number(r.orders_unserved ?? 0);
  }
  const validUtilRows = rows.filter((r) => r.avg_util !== null);
  totals.utilizationPct = validUtilRows.length
    ? Math.round((validUtilRows.reduce((a, r) => a + Number(r.avg_util ?? 0), 0) / validUtilRows.length) * 10) / 10
    : 0;
  const totalCases = rows.reduce((a, r) => a + Number(r.cases_total ?? 0), 0);
  totals.costPerCase = totalCases > 0 ? Math.round((totals.cost / totalCases) * 100) / 100 : 0;
  return totals;
}

/**
 * Pull aggregated per-date stats over a window. Uses raw SQL so we don't have
 * to handle bigint conversions for COUNT(*) values from Prisma.
 */
async function fetchRangeRows(tenantId: string, from: string, to: string): Promise<RawRunRow[]> {
  return prisma.$queryRaw<RawRunRow[]>`
    SELECT
      rp."runDate"::date::text AS date,
      COUNT(DISTINCT rp.id)::bigint AS run_count,
      COALESCE(SUM(sr."trucksUsed"), 0)::bigint AS trucks_used,
      COALESCE(SUM(sr."totalDistanceKm"), 0) AS distance_km,
      COALESCE(SUM(sr."totalCost"), 0) AS cost,
      AVG(sr."avgUtilizationPct") AS avg_util,
      COALESCE(SUM(rp."totalOrders"), 0)::bigint AS orders_total,
      COALESCE(SUM(rp."unservedCount"), 0)::bigint AS orders_unserved,
      COALESCE(SUM(case_totals.total_cases), 0) AS cases_total
    FROM "RunPlan" rp
    LEFT JOIN "ScenarioResult" sr ON sr.id = rp."chosenScenarioId"
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(o."totalCases"), 0) AS total_cases
      FROM "Order" o
      WHERE o."tenantId" = rp."tenantId" AND o."deliveryDate" = rp."runDate"
    ) AS case_totals ON TRUE
    WHERE rp."tenantId" = ${tenantId}
      AND rp."runDate" BETWEEN ${from}::date AND ${to}::date
      AND rp.status IN ('READY', 'DISPATCHED')
    GROUP BY rp."runDate"
    ORDER BY rp."runDate" ASC
  `;
}

export async function getDashboardData(tenantId: string): Promise<DashboardData> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { currency: true, config: { select: { distanceProvider: true, labelEstimatedDistances: true } } },
  });
  const distanceIsEstimated =
    tenant.config?.distanceProvider === 'HAVERSINE' && (tenant.config?.labelEstimatedDistances ?? true);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = addDays(today, -1);
  const last30From = addDays(today, -29);
  const weekFrom = addDays(today, -6);
  const previousWeekTo = addDays(weekFrom, -1);
  const previousWeekFrom = addDays(previousWeekTo, -6);

  const todayIso = isoDate(today);
  const yesterdayIso = isoDate(yesterday);
  const last30FromIso = isoDate(last30From);
  const weekFromIso = isoDate(weekFrom);
  const previousWeekFromIso = isoDate(previousWeekFrom);
  const previousWeekToIso = isoDate(previousWeekTo);

  // Pull 30-day raw rows for the trend; derive today/yesterday/week/previous from the same set.
  const rangeRows = await fetchRangeRows(tenantId, previousWeekFromIso, todayIso);
  // For "previous week" we need to also cover before last30From in case windows overlap weirdly;
  // run a second narrow query for safety.
  const previousWeekRows = await fetchRangeRows(tenantId, previousWeekFromIso, previousWeekToIso);
  const trendRows = await fetchRangeRows(tenantId, last30FromIso, todayIso);

  const todayRows = rangeRows.filter((r) => r.date === todayIso);
  const yesterdayRows = rangeRows.filter((r) => r.date === yesterdayIso);
  const weekRows = rangeRows.filter((r) => r.date >= weekFromIso && r.date <= todayIso);

  // Build trend with zero-filled days for the last 30
  const trendByDate = new Map(trendRows.map((r) => [r.date, r]));
  const trend: DashboardData['trend'] = [];
  for (let i = 29; i >= 0; i--) {
    const d = isoDate(addDays(today, -i));
    const row = trendByDate.get(d);
    if (row) {
      trend.push({
        date: d,
        runCount: Number(row.run_count),
        trucksUsed: Number(row.trucks_used ?? 0),
        distanceKm: Math.round(Number(row.distance_km ?? 0) * 100) / 100,
        cost: Math.round(Number(row.cost ?? 0) * 100) / 100,
        ordersServed: Number(row.orders_total ?? 0) - Number(row.orders_unserved ?? 0),
      });
    } else {
      trend.push({ date: d, runCount: 0, trucksUsed: 0, distanceKm: 0, cost: 0, ordersServed: 0 });
    }
  }

  // Recent runs (any status) for the widget
  const recentRunRows = await prisma.runPlan.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 7,
    include: {
      depot: { select: { code: true, name: true } },
      scenarios: { select: { id: true, name: true, trucksUsed: true, totalDistanceKm: true } },
    },
  });
  const recentRuns: RecentRun[] = recentRunRows.map((r) => {
    const chosen = r.chosenScenarioId ? r.scenarios.find((s) => s.id === r.chosenScenarioId) : null;
    return {
      id: r.id,
      runDate: r.runDate.toISOString().slice(0, 10),
      depotCode: r.depot.code,
      depotName: r.depot.name,
      status: r.status,
      trucksUsed: chosen?.trucksUsed ?? null,
      distanceKm: chosen?.totalDistanceKm ?? null,
      unservedCount: r.unservedCount,
      totalOrders: r.totalOrders,
      createdAt: r.createdAt.toISOString(),
    };
  });

  return {
    today: rollupRows(todayRows, todayIso),
    yesterday: rollupRows(yesterdayRows, yesterdayIso),
    weekToDate: { ...rollupRows(weekRows, todayIso), from: weekFromIso, to: todayIso },
    previousWeek: { ...rollupRows(previousWeekRows, previousWeekToIso), from: previousWeekFromIso, to: previousWeekToIso },
    trend,
    recentRuns,
    distanceIsEstimated,
    currency: tenant.currency,
  };
}
