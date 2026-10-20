/**
 * The salesman link's reader and its answer (owner request 19 Oct 2026). Server only.
 *
 * salesDayFor(tenantId, date): every route's and truck's view of the day (day.ts buildSalesDay), built ONCE per company and
 * date and kept SALES_DAY_MEMO_MS (30 s); requests arriving while it is built wait for that one build (single
 * flight): thirty salesmen opening the WhatsApp post at once cause one build. The plan detail is the driver
 * manifest's memo (lib/driver-link/manifest.ts memoPlanDetail, per plan version, 60 s under a stamp).
 *
 * Tenant scoping: the company comes from the verified link row only (guard.ts); every read here names it - the
 * Order reads through tenantDb, OrderLine through its order (`order: { tenantId }`), the rest with `tenantId`.
 * The page never calls the GPS provider: it reads the stored TruckPosition rows only (the poller writes them).
 *
 * What is read (indexed, a dozen queries per build):
 *  1. the company's name and settings (time zone, GPS tracking mode and radii, the alerts' Running late threshold
 *     for the projection's late Dispatch press, as rules.ts) and the IVMS kill switch;
 *  2. the plan in use per depot (liveRuns) and its detail (memoPlanDetail); a depot whose plan has no applied
 *     option is "not planned yet";
 *  3. per planned depot, the facts its detail does not carry (lib/exports/salesman-eta.ts loadSalesmanEtaFacts);
 *  4. the day's orders the plans do not show as they are now: cancelled, moved, copies, and every order of a
 *     depot not planned yet (one query);
 *  5. the day's visits (without their GPS times below GPS tracking TIMES, as the truck's day page), their photos;
 *  6. the loads' Dispatch press (statusChangedAt), Back at depot taps, when each truck's phone was last heard;
 *  7. GPS (tracking MAP or higher, the link on), for the expected times only: the trucks' latest positions, their
 *     history pull (trailTo) and their trail-confirmed depot moves (TIMES and up), and the customers' GPS site
 *     radius. No position, truck or trip is sent (owner feedback of 20 Oct 2026: simple-view.ts).
 */
import { prisma } from '../db';
import { tenantDb } from '../tenant';
import { findInParts } from '../in-parts';
import { dateOnly, DEFAULT_TZ, isoOf, todayIso, zonedDayStart, addDaysIso } from '../dispatch/time';
import { liveRuns } from '../driver-link/service';
import { memoPlanDetail } from '../driver-link/manifest';
import { backAtDepot } from '../delivery/day-results';
import { withoutGpsTimes } from '../delivery/visit';
import { loadSalesmanEtaFacts } from '../exports/salesman-eta';
import { gpsReadConfigOf, moveObserved } from '../alerts/gps';
import { trailToOf } from '../alerts/facts';
import { readIvmsEnv } from '../ivms/env';
import { ivmsModeAtLeast, ivmsModeOf } from '../ivms/settings';
import type { IvmsMode } from '../ivms/types';
import type { PlanDetail } from '../dispatch/plan-detail';
import { buildSalesDay, salesLateDispatchMin, type SalesDay, type SalesDayInput, type SalesExtraOrderIn, type SalesGpsIn, type SalesPlanIn, type SalesPositionIn, type SalesVisitIn } from './day';
import { matchLookup, MAX_CODES, parseRouteQuery, truckQuery, type LookupChoice } from './route-code';
import { consumeMisses, salesFail, salesOk, type SalesLinkContext } from './guard';
import { touchSalesLink, TRUCK_SEEN_PREFIX } from './service';
import { salesRouteView } from './simple-view';
import { SALES_PAGE_HEADER, salesPageCurrent } from './page-version';
import type { SalesChoice, SalesMeta, SalesRouteView, SalesViewAnswer } from './view-types';

/** One build of a company's day serves every request for this long. */
export const SALES_DAY_MEMO_MS = 30_000;
/** The page refreshes this often while it is visible. */
export const SALES_REFRESH_SEC = 60;
const MEMO_MAX = 20;
const PHONE = ['PHONE_AUTO', 'PHONE_MANUAL'] as const;
/** The trail-confirmed depot moves read around a delivery day, as the alerts read them (facts.ts). */
const MOVES_BEFORE_MS = 3 * 3_600_000;
const MOVES_AFTER_MS = 27 * 3_600_000;

export interface SalesDayMemo {
  at: number;
  day: SalesDay;
  company: string;
  tz: string;
}

type G = { __routeiqSalesDayMemo?: Map<string, SalesDayMemo>; __routeiqSalesDayInflight?: Map<string, Promise<SalesDayMemo>>; __routeiqSalesDayBuilds?: number };
const g = globalThis as unknown as G;
const memo = (g.__routeiqSalesDayMemo ??= new Map<string, SalesDayMemo>());
const inflight = (g.__routeiqSalesDayInflight ??= new Map<string, Promise<SalesDayMemo>>());

/** How many builds this process made (tests: the memo and the single flight). */
export function salesDayBuilds(): number {
  return g.__routeiqSalesDayBuilds ?? 0;
}

/** Tests: forget every build. */
export function _resetSalesDayMemo(): void {
  memo.clear();
  inflight.clear();
  g.__routeiqSalesDayBuilds = 0;
}

/** The day of a company and date: from the memo when at most 30 s old, else one build (waited for by every request meanwhile). */
export async function salesDayFor(tenantId: string, date: string, now: Date = new Date()): Promise<SalesDayMemo> {
  const key = `${tenantId}|${date}`;
  const hit = memo.get(key);
  if (hit && now.getTime() - hit.at >= 0 && now.getTime() - hit.at < SALES_DAY_MEMO_MS) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const { input, company } = await readSalesDayInput(tenantId, date, now);
    g.__routeiqSalesDayBuilds = (g.__routeiqSalesDayBuilds ?? 0) + 1;
    const m: SalesDayMemo = { at: now.getTime(), day: buildSalesDay(input), company, tz: input.tz };
    memo.delete(key);
    memo.set(key, m);
    while (memo.size > MEMO_MAX) {
      const oldest = memo.keys().next().value;
      if (oldest === undefined) break;
      memo.delete(oldest);
    }
    return m;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Every input of buildSalesDay for a company and date (see the file comment). */
export async function readSalesDayInput(tenantId: string, date: string, now: Date): Promise<{ input: SalesDayInput; company: string }> {
  const db = tenantDb(tenantId);
  const [cfg, tenant] = await Promise.all([
    prisma.tenantConfig.findFirst({
      where: { tenantId },
      select: { timezone: true, ivmsMode: true, avgSpeedKmh: true, distanceMultiplier: true, ivmsStopRadiusM: true, ivmsDepotRadiusM: true, alertsEnabled: true, alertEtaLateMin: true },
    }),
    prisma.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
  ]);
  const tz = cfg?.timezone || DEFAULT_TZ;
  const mode: IvmsMode = readIvmsEnv().disabled ? 'OFF' : ivmsModeOf(cfg);

  // 2-3. The plans in use and the facts their details do not carry.
  const runs = await liveRuns(prisma, tenantId, date);
  const details = (await Promise.all(runs.map((r) => memoPlanDetail(tenantId, r.id, now.getTime())))).filter(
    (d): d is PlanDetail => !!d && d.isDispatchPlan !== false && !!d.run.chosenScenario,
  );
  const plans: SalesPlanIn[] = [];
  for (const detail of details) plans.push({ detail, facts: await loadSalesmanEtaFacts(db, tenantId, detail) });
  const plannedDepots = [...new Set(plans.map((p) => p.detail.run.depot.id))];

  // 4. The day's orders the plans do not show as they are now.
  const orders = await db.order.findMany({
    where: {
      tenantId,
      deliveryDate: dateOnly(date),
      ...(plannedDepots.length
        ? { OR: [{ cancelledAt: { not: null } }, { carriedToOrderId: { not: null } }, { carriedFromOrderId: { not: null } }, { depotId: { notIn: plannedDepots } }] }
        : {}),
    },
    select: {
      id: true,
      depotId: true,
      cancelledAt: true,
      cancelReason: true,
      carriedFromDate: true,
      carriedTo: { select: { deliveryDate: true } },
      customer: { select: { code: true, branchCode: true, name: true } },
      lines: { select: { id: true, salesRoute: true, salesOrderNo: true, cases: true } },
    },
  });
  const extraOrders: SalesExtraOrderIn[] = orders.map((o) => ({
    id: o.id,
    depotId: o.depotId,
    customerCode: o.customer.code,
    branchCode: o.customer.branchCode,
    customerName: o.customer.name,
    cancelled: !!o.cancelledAt,
    cancelReason: o.cancelReason,
    carriedFromDate: o.carriedFromDate ? isoOf(o.carriedFromDate) : null,
    carriedTo: o.carriedTo ? isoOf(o.carriedTo.deliveryDate) : null,
    lines: o.lines.map((l) => ({ id: l.id, salesRoute: l.salesRoute ?? null, salesOrderNo: l.salesOrderNo, cases: l.cases })),
  }));

  // 5. Visits (GPS times only from GPS tracking TIMES up, as the truck's day page) and their photos.
  const rows = await prisma.stopVisit.findMany({ where: { tenantId, deliveryDate: dateOnly(date) } });
  const withGps = ivmsModeAtLeast(mode, 'TIMES');
  const photos = await findInParts(
    rows.map((v) => v.id),
    (part) => prisma.deliveryPhoto.findMany({ where: { tenantId, visitId: { in: part } }, select: { visitId: true, source: true, receivedAt: true, takenAt: true, oldPhoto: true } }),
  );
  const photosOf = new Map<string, SalesVisitIn['photos']>();
  for (const p of photos) photosOf.set(p.visitId, [...(photosOf.get(p.visitId) ?? []), { source: p.source, receivedAt: p.receivedAt, takenAt: p.takenAt, oldPhoto: p.oldPhoto }]);
  const visits: SalesVisitIn[] = rows.map((raw) => {
    const v = withGps ? raw : withoutGpsTimes(raw);
    return {
      depotId: v.depotId,
      date: isoOf(v.deliveryDate),
      truckId: v.truckId,
      loadNo: v.loadNo,
      sequence: v.sequence,
      arrivedAt: v.arrivedAt,
      arrivalSource: v.arrivalSource,
      departedAt: v.departedAt,
      departureSource: v.departureSource,
      outcome: v.outcome,
      reason: v.reason,
      outcomeAt: v.outcomeAt,
      outcomeSource: v.outcomeSource,
      casesPlanned: v.casesPlanned,
      casesDelivered: v.casesDelivered,
      linesJson: v.linesJson,
      plannedServiceMin: v.plannedServiceMin,
      windowStartMin: v.windowStartMin,
      photos: photosOf.get(v.id) ?? [],
    };
  });

  // 6. Dispatch presses, Back at depot, the phones' last signs (driver events and phone photos, by receipt).
  const runIds = plans.map((p) => p.detail.run.id);
  const [loadRows, backAt, events] = await Promise.all([
    runIds.length ? prisma.planLoad.findMany({ where: { tenantId, runId: { in: runIds } }, select: { id: true, statusChangedAt: true } }) : [],
    backAtDepot(prisma, tenantId, date, date),
    prisma.stopEvent.groupBy({ by: ['truckId'], where: { tenantId, deliveryDate: dateOnly(date), source: { in: [...PHONE] } }, _max: { receivedAt: true } }),
  ]);
  const phoneSeen = new Map<string, Date>();
  const seen = (truckId: string, at: Date | null | undefined) => {
    if (!at) return;
    const cur = phoneSeen.get(truckId);
    if (!cur || at > cur) phoneSeen.set(truckId, at);
  };
  for (const e of events) seen(e.truckId, e._max.receivedAt);
  const truckOfVisit = new Map(rows.map((v) => [v.id, v.truckId]));
  for (const p of photos) if ((PHONE as readonly string[]).includes(p.source)) seen(truckOfVisit.get(p.visitId) ?? '', p.receivedAt);
  phoneSeen.delete('');

  // 7. GPS (MAP and up, the link on, today's or an earlier day's trip still out): stored rows only.
  let gps: SalesGpsIn | null = null;
  const siteRadius = new Map<string, number>();
  const today = todayIso(tz, now);
  const onRoad = plans.flatMap((p) => p.detail.loads.filter((l) => l.status === 'DISPATCHED').map((l) => l.truckId));
  if (ivmsModeAtLeast(mode, 'MAP') && date <= today && date >= addDaysIso(today, -1)) {
    const truckIds = [...new Set(onRoad)];
    const dayStart = zonedDayStart(date, tz);
    const [positions, days, moves, sites] = await Promise.all([
      truckIds.length ? prisma.truckPosition.findMany({ where: { tenantId, truckId: { in: truckIds } }, select: { truckId: true, fixAt: true, lat: true, lng: true, speedKmh: true, flags: true, movedAt: true } }) : [],
      truckIds.length ? prisma.ivmsTruckDay.findMany({ where: { tenantId, truckId: { in: truckIds }, deliveryDate: dateOnly(date) }, select: { truckId: true, pulledTo: true, processedAt: true, suppressedAt: true } }) : [],
      truckIds.length && ivmsModeAtLeast(mode, 'TIMES')
        ? prisma.ivmsEvent.findMany({
            where: { tenantId, truckId: { in: truckIds }, kind: { in: ['DEPOT_IN', 'DEPOT_OUT'] }, outcome: 'USED', eventAt: { gte: new Date(dayStart.getTime() - MOVES_BEFORE_MS), lte: new Date(dayStart.getTime() + MOVES_AFTER_MS) } },
            select: { truckId: true, depotId: true, kind: true, origin: true, eventAt: true, observed: true },
          })
        : [],
      prisma.customer.findMany({
        where: { tenantId, id: { in: [...new Set(plans.flatMap((p) => p.detail.loads.flatMap((l) => l.stops.map((s) => s.customerId))))] }, siteRadiusM: { not: null } },
        select: { id: true, siteRadiusM: true },
      }),
    ]);
    // A truck-day whose GPS the office suppressed is read as with the link off (the alerts' rule).
    const suppressed = new Set(days.filter((d) => d.suppressedAt).map((d) => d.truckId));
    const positionOf = new Map<string, SalesPositionIn>();
    for (const p of positions) if (!suppressed.has(p.truckId)) positionOf.set(p.truckId, { fixAt: p.fixAt, lat: p.lat, lng: p.lng, speedKmh: p.speedKmh, flags: p.flags ?? [], movedAt: p.movedAt });
    const trailTo = new Map(days.filter((d) => !d.suppressedAt).map((d) => [d.truckId, trailToOf(d)]));
    const movesOf = new Map<string, { kind: 'DEPOT_IN' | 'DEPOT_OUT'; at: Date; observed: boolean; depotId: string | null }[]>();
    for (const e of moves) {
      if (suppressed.has(e.truckId) || (e.kind !== 'DEPOT_IN' && e.kind !== 'DEPOT_OUT')) continue;
      const m = { kind: e.kind as 'DEPOT_IN' | 'DEPOT_OUT', at: e.eventAt, observed: moveObserved({ kind: e.kind as 'DEPOT_IN' | 'DEPOT_OUT', at: e.eventAt, origin: e.origin, observed: e.observed ?? null }, []), depotId: e.depotId ?? null };
      movesOf.set(e.truckId, [...(movesOf.get(e.truckId) ?? []), m]);
    }
    for (const c of sites) if (c.siteRadiusM) siteRadius.set(c.id, c.siteRadiusM);
    gps = {
      settings: { ...gpsReadConfigOf(cfg), depots: new Map(plans.map((p) => [p.detail.run.depot.id, { lat: p.detail.run.depot.lat, lng: p.detail.run.depot.lng }])) },
      positions: positionOf,
      trailTo,
      moves: movesOf,
    };
  }

  return {
    company: tenant?.name ?? '',
    input: {
      date,
      tz,
      now,
      plans,
      extraOrders,
      visits,
      loadTimes: new Map(loadRows.map((l) => [l.id, l.statusChangedAt ?? null])),
      backAt,
      phoneSeen,
      gps,
      siteRadius,
      lateDispatchMin: salesLateDispatchMin(cfg),
    },
  };
}

/** The header of every answer: the day, the company, the link's end (the page says them in its language). */
export function salesMeta(o: { date: string; company: string; tz: string; expiresAt: Date; now: Date }): SalesMeta {
  return {
    date: o.date,
    company: o.company,
    expiresAt: o.expiresAt.toISOString(),
    tz: o.tz,
    serverNow: o.now.toISOString(),
    refreshSec: SALES_REFRESH_SEC,
  };
}

/**
 * GET /api/s/view: without `route` the header only (the page asks for a route code); with `route=<codes>`
 * ("R1", "R1, R2X", "C1, 5678", "Truck 1234-AB") the routes and trucks they name (route-code.ts matchLookup), each
 * as simple-view.ts says it (one status and one time per customer), and the trucks to pick from. Codes that matched no route and no truck that day count against the link and client
 * (429 over the limit). A salesman's phone (never the office) is then recorded: the phone, the routes and trucks found.
 * A page of an older version (no `X-Sales-Page` header, or an older one: page-version.ts) is answered 410
 * LINK_REPLACED with the link's date before anything is read: an older page open since before a deploy then asks the
 * salesman to open the link again instead of failing on an answer it cannot read (review of 20 Oct 2026).
 */
export async function salesView(req: Request, ctx: SalesLinkContext): Promise<Response> {
  if (!salesPageCurrent(req.headers.get(SALES_PAGE_HEADER))) {
    return salesFail({ code: 'LINK_REPLACED', message: 'This page was updated. Open the link again from your group.', date: ctx.date }, 410);
  }
  const raw = new URL(req.url).searchParams.get('route');
  if (raw === null) {
    const [cfg, tenant] = await Promise.all([
      prisma.tenantConfig.findFirst({ where: { tenantId: ctx.tenantId }, select: { timezone: true } }),
      prisma.tenant.findFirst({ where: { id: ctx.tenantId }, select: { name: true } }),
    ]);
    if (!ctx.session) await touchSalesLink(ctx.link, ctx.deviceId, [], ctx.now);
    const answer: SalesViewAnswer = { meta: salesMeta({ date: ctx.date, company: tenant?.name ?? '', tz: cfg?.timezone || DEFAULT_TZ, expiresAt: ctx.expiresAt, now: ctx.now }), lookup: null };
    return salesOk(answer);
  }
  const q = parseRouteQuery(raw);
  if (!q.ok) {
    const message =
      q.code === 'ROUTE_CODE_MISSING' ? 'Type your route or truck code.' : q.code === 'TOO_MANY_CODES' ? 'At most 5 codes at once.' : 'That code is too long.';
    return salesFail({ code: q.code, message }, 400);
  }
  const m = await salesDayFor(ctx.tenantId, ctx.date, ctx.now);
  const match = matchLookup(q.codes, m.day.routes.keys(), m.day.truckRefs);
  // A code that matched no route and no truck counts against the link and client (a truck lookup as a route's).
  if (match.notFound.length) {
    const used = consumeMisses(ctx, match.notFound.length);
    if (!used.ok) return used.response;
  }
  const at = { date: ctx.date, tz: m.tz, now: ctx.now, builtAt: m.day.builtAt };
  const results = [...match.routes.map((r) => m.day.routes.get(r)!), ...match.trucks.map((id) => m.day.trucks.get(id)!)].map((v) => salesRouteView(v, at));
  // "Routes looked up": the route codes found, and the trucks found as "T:<code>" (owner decision of 20 Oct 2026).
  if (!ctx.session) await touchSalesLink(ctx.link, ctx.deviceId, [...match.routes, ...match.trucks.map((id) => `${TRUCK_SEEN_PREFIX}${m.day.trucks.get(id)!.code}`)], ctx.now);
  const answer: SalesViewAnswer = {
    meta: salesMeta({ date: ctx.date, company: m.company, tz: m.tz, expiresAt: ctx.expiresAt, now: ctx.now }),
    lookup: {
      asked: q.codes,
      results,
      notFound: match.notFound,
      ambiguous: match.ambiguous,
      choices: salesChoices(match.choices, results, m.day),
    },
  };
  return salesOk(answer);
}

/**
 * The trucks offered for a code (several trucks with its digits or compact key; a route code that is also a truck's), each with
 * the whole lookup to send when picked: what is shown now (without the routes an ALSO_TRUCK code showed) and the
 * truck, at most MAX_CODES codes.
 */
export function salesChoices(choices: readonly LookupChoice[], results: readonly Pick<SalesRouteView, 'kind' | 'code' | 'query'>[], day: Pick<SalesDay, 'trucks'>): SalesChoice[] {
  return choices.map((ch) => {
    const kept = results.filter((v) => !(ch.why === 'ALSO_TRUCK' && v.kind === 'ROUTE' && ch.routes.includes(v.code))).map((v) => v.query);
    const options = ch.trucks.map((id) => {
      const code = day.trucks.get(id)!.code;
      const pick = truckQuery(code);
      const rest = kept.filter((x) => x !== pick).slice(0, MAX_CODES - 1);
      return { code, query: [...rest, pick].join(', ') };
    });
    return { asked: ch.asked, kind: ch.why, options };
  });
}
