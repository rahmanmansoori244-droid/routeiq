/**
 * Dashboard KPIs and trend timeseries.
 *
 * KPIs use the plan in use for each date (LIVE_PLAN_IN_USE): READY or DISPATCHED, or FAILED while
 * it still holds an applied plan (a failed re-plan keeps the previous plan, the one being
 * dispatched), never a superseded version. Runs with no applied plan are excluded from the totals.
 *
 * The figures come from the version's plan summary (RunPlan.summaryJson), which covers EVERY load
 * of the version - the locked and dispatched loads a re-plan carried, not only the new loads of
 * the option it chose (review: the dashboard understated re-planned days). Plans without a summary
 * (made by the previous optimizer) fall back to their chosen option. Days are Asia/Muscat days
 * (the tenant's timezone).
 */
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { addDaysIso, DEFAULT_TZ, localDateIso } from './dispatch/time';

/**
 * The plan versions the dashboard counts, as a SQL condition on "RunPlan" rp: the plan in use of
 * each day. Never a superseded one - status SUPERSEDED or supersededAt set (a version written
 * READY over its supersede before the stabilization release must not be summed with its live
 * child) - and only with an applied plan: READY, DISPATCHED, or FAILED with a chosen option (a
 * failed re-plan keeps the previous plan in use). Stabilization PR3.
 */
export const LIVE_PLAN_IN_USE = Prisma.sql`rp."supersededAt" IS NULL
      AND (rp.status IN ('READY', 'DISPATCHED') OR (rp.status = 'FAILED' AND rp."chosenScenarioId" IS NOT NULL))`;

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
 * Per-date stats over a window, one row per date summed over the depots' plans in use. Each plan
 * contributes its summary (every load of the version); a plan without one (previous optimizer)
 * its chosen option and the day's orders. Raw SQL so COUNT(*) bigints need no Prisma handling.
 */
async function fetchRangeRows(tenantId: string, from: string, to: string): Promise<RawRunRow[]> {
  return prisma.$queryRaw<RawRunRow[]>`
    SELECT
      rp."runDate"::date::text AS date,
      COUNT(DISTINCT rp.id)::bigint AS run_count,
      COALESCE(SUM(COALESCE((rp."summaryJson"->>'trucksUsed')::int, sr."trucksUsed")), 0)::bigint AS trucks_used,
      COALESCE(SUM(COALESCE((rp."summaryJson"->>'totalKm')::float8, sr."totalDistanceKm")), 0) AS distance_km,
      COALESCE(SUM(COALESCE((rp."summaryJson"->>'operatingCost')::float8, sr."totalCost")), 0) AS cost,
      AVG(COALESCE((rp."summaryJson"->>'avgUtilizationPct')::float8, sr."avgUtilizationPct")) AS avg_util,
      COALESCE(SUM(rp."totalOrders"), 0)::bigint AS orders_total,
      COALESCE(SUM(rp."unservedCount"), 0)::bigint AS orders_unserved,
      COALESCE(SUM(COALESCE((rp."summaryJson"->>'totalCases')::float8, case_totals.total_cases)), 0) AS cases_total
    FROM "RunPlan" rp
    LEFT JOIN "ScenarioResult" sr ON sr.id = rp."chosenScenarioId"
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(o."totalCases"), 0) AS total_cases
      FROM "Order" o
      WHERE o."tenantId" = rp."tenantId" AND o."deliveryDate" = rp."runDate" AND (o."depotId" = rp."depotId" OR o."depotId" IS NULL)
    ) AS case_totals ON TRUE
    WHERE rp."tenantId" = ${tenantId}
      AND rp."runDate" BETWEEN ${from}::date AND ${to}::date
      AND ${LIVE_PLAN_IN_USE}
    GROUP BY rp."runDate"
    ORDER BY rp."runDate" ASC
  `;
}

export async function getDashboardData(tenantId: string): Promise<DashboardData> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { currency: true, config: { select: { distanceProvider: true, timezone: true } } },
  });

  // Delivery days are the tenant's local days (Asia/Muscat), never the server's.
  const todayIso = localDateIso(new Date(), tenant.config?.timezone || DEFAULT_TZ);
  const yesterdayIso = addDaysIso(todayIso, -1);
  const last30FromIso = addDaysIso(todayIso, -29);
  const weekFromIso = addDaysIso(todayIso, -6);
  const previousWeekToIso = addDaysIso(weekFromIso, -1);
  const previousWeekFromIso = addDaysIso(previousWeekToIso, -6);

  // "Estimated km" follows how the plans shown were computed (stored per plan), falling back to
  // the current setting only when there is no plan in the range.
  const est = await prisma.$queryRaw<{ anyEstimated: boolean | null }[]>`
    SELECT bool_or(COALESCE((sr."detailsJson"->>'distance_is_estimated')::boolean, true)) AS "anyEstimated"
    FROM "RunPlan" rp
    JOIN "ScenarioResult" sr ON sr.id = rp."chosenScenarioId"
    WHERE rp."tenantId" = ${tenantId}
      AND rp."runDate" BETWEEN ${last30FromIso}::date AND ${todayIso}::date
      AND ${LIVE_PLAN_IN_USE}
  `;
  // Estimated distances are always labelled (the old "label estimated distances" switch is gone).
  const distanceIsEstimated = est[0]?.anyEstimated ?? tenant.config?.distanceProvider === 'HAVERSINE';

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
    const d = addDaysIso(todayIso, -i);
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
    // The whole version (carried loads included), else the chosen option.
    const sum = r.summaryJson as { trucksUsed?: number; totalKm?: number } | null;
    return {
      id: r.id,
      runDate: r.runDate.toISOString().slice(0, 10),
      depotCode: r.depot.code,
      depotName: r.depot.name,
      status: r.status,
      trucksUsed: typeof sum?.trucksUsed === 'number' ? sum.trucksUsed : (chosen?.trucksUsed ?? null),
      distanceKm: typeof sum?.totalKm === 'number' ? sum.totalKm : (chosen?.totalDistanceKm ?? null),
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
