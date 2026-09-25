/**
 * Dashboard KPIs and trend timeseries — CLAUDE.md §12 Phase 5.
 *
 * KPIs use the "chosen scenario" of the plan in use of each depot and day (LIVE_PLAN_IN_USE):
 * exactly one version per depot and day - the current one - in every state of its lifecycle, never
 * a superseded one. Runs with no chosen scenario are excluded from cost/trucks-used totals because
 * the planner hasn't committed to a result yet. Cases (cost per case) are the orders of each plan's
 * own depot and day (PLAN_ORDERS_IN_SCOPE), so every case is counted once.
 *
 * Late deliveries are a v2 placeholder — v1 doesn't enforce time windows.
 */
import { Prisma } from '@prisma/client';
import { prisma } from './db';

/**
 * The plan versions the dashboard counts, as a SQL condition on "RunPlan" rp: exactly one per depot
 * and day, the current version - the one the day screen shows (`currentPlan` in plan-service.ts:
 * the newest version not superseded or archived; supersededAt too, so a version written READY over
 * its supersede before the stabilization release is never counted) - and only while it holds a
 * plan in use: READY or DISPATCHED, or any other state with an applied plan (a chosen option).
 * During a re-plan that is the new version: it holds the copy of the previous plan while it is
 * DRAFT, waits or runs (OPTIMIZING), and keeps it when its optimization fails (FAILED) - the plan
 * being dispatched (copy-forward). The superseded parent is never counted, so a depot's day counts
 * once in every state. A first optimization (no plan applied yet) is not counted. Stabilization PR3.
 */
export const LIVE_PLAN_IN_USE = Prisma.sql`rp.id = (
        SELECT cur.id FROM "RunPlan" cur
        WHERE cur."tenantId" = rp."tenantId" AND cur."depotId" = rp."depotId" AND cur."runDate" = rp."runDate"
          AND cur.status NOT IN ('SUPERSEDED', 'ARCHIVED') AND cur."supersededAt" IS NULL
        ORDER BY cur.version DESC, cur."chosenScenarioId" DESC NULLS LAST, cur."createdAt" DESC, cur.id DESC
        LIMIT 1
      )
      AND (rp.status IN ('READY', 'DISPATCHED') OR rp."chosenScenarioId" IS NOT NULL)`;

/**
 * The orders of plan rp, as a SQL condition on "Order" o - the same scope as `ordersInScopeWhere`
 * (plan-service.ts), the orders the plan's reconciliation checks: same tenant and delivery date,
 * the plan's depot, and orders without a depot (legacy) only when the tenant has one active depot.
 * One plan per depot and day, so every case is counted once (review of PR3: the whole day of the
 * tenant was counted once per depot plan, so cost per case was 1/N of the truth with N depots).
 */
export const PLAN_ORDERS_IN_SCOPE = Prisma.sql`o."tenantId" = rp."tenantId" AND o."deliveryDate" = rp."runDate"
        AND (o."depotId" = rp."depotId"
          OR (o."depotId" IS NULL AND (SELECT COUNT(*) FROM "Depot" d WHERE d."tenantId" = rp."tenantId" AND d.active) <= 1))`;

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

export interface RawRunRow {
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

export function rollupRows(rows: RawRunRow[], date: string): DayStats {
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
export async function fetchRangeRows(tenantId: string, from: string, to: string): Promise<RawRunRow[]> {
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
      WHERE ${PLAN_ORDERS_IN_SCOPE}
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
    select: { currency: true, config: { select: { distanceProvider: true, labelEstimatedDistances: true } } },
  });

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
  const distanceIsEstimated =
    (est[0]?.anyEstimated ?? tenant.config?.distanceProvider === 'HAVERSINE') && (tenant.config?.labelEstimatedDistances ?? true);

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
