/**
 * Readers of what happened on the road (owner request 4 Oct 2026, Part 3: the office side). Server
 * only. The plan screen's results, the day screen's Deliveries card, the dashboard tile, Bring
 * forward's "no result recorded" list and the actuals Excel all read the stops of loads that left
 * (DISPATCHED or COMPLETED) and their visits through these functions, so they always agree.
 *
 * A visit is matched to a stop by its natural key (depot, date, truck, load number, sequence), never
 * by a plan version's row id: a re-plan copies the frozen loads with new ids, and frozen loads keep
 * their truck, load number and stop order (spec section F2).
 */
import type { Prisma, StopVisit } from '@prisma/client';
import { prisma } from '../db';
import { addDaysIso, dateOnly, DEFAULT_TZ, isoOf, localDateIso, localMinutes, zonedDayStart } from '../dispatch/time';
import { lateDispatchNotes } from '../driver-link/plan-notes';
import { plannedStopFromRows } from './planned-stop';
import type { VisitLine } from './visit';
import { deliveryKpis, inOutcomeScope, type DeliveryKpis, type KpiVisit } from './kpis';
import { cameraExceptionOf, cameraLinkAlerts, isCameraException, sortCameraExceptions, truckDayKey, type CameraException, type CameraLinkAlert } from './camera-exceptions';

type Db = Prisma.TransactionClient | typeof prisma;

export const ON_ROAD_STATUSES = ['DISPATCHED', 'COMPLETED'] as const;
/** Today: a DISPATCHED load counts as back this long after its planned return (spec section 9.1 item 7). */
export const BACK_AFTER_RETURN_MIN = 60;

/** The plan in use per depot and date (the currentPlan rule), for a range of dates. */
export async function liveRunsInRange(db: Db, tenantId: string, from: string, to: string, depotId?: string | null): Promise<{ id: string; depotId: string; date: string }[]> {
  const runs = await db.runPlan.findMany({
    where: { tenantId, runDate: { gte: dateOnly(from), lte: dateOnly(to) }, status: { notIn: ['SUPERSEDED', 'ARCHIVED'] }, supersededAt: null, ...(depotId ? { depotId } : {}) },
    orderBy: [{ version: 'desc' }, { chosenScenarioId: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, depotId: true, runDate: true },
  });
  const per = new Map<string, { id: string; depotId: string; date: string }>();
  for (const r of runs) {
    const date = isoOf(r.runDate);
    const k = `${r.depotId}|${date}`;
    if (!per.has(k)) per.set(k, { id: r.id, depotId: r.depotId, date });
  }
  return [...per.values()];
}

export interface RoadLoad {
  id: string;
  runId: string;
  depotId: string;
  /** YYYY-MM-DD */
  date: string;
  truckId: string;
  truckCode: string;
  hired: boolean;
  loadNo: number;
  status: string;
  departMin: number;
  returnMin: number;
  driverId: string | null;
  driverName: string | null;
  driverCasual: boolean;
  statusChangedAt: Date | null;
  breakJson: unknown;
}

/** The loads of these runs (by default only the ones that left: DISPATCHED / COMPLETED). */
export async function loadsOfRuns(
  db: Db,
  tenantId: string,
  runs: readonly { id: string; depotId: string; date: string }[],
  opts: { statuses?: readonly string[] } = {},
): Promise<RoadLoad[]> {
  if (!runs.length) return [];
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const loads = await db.planLoad.findMany({
    where: { tenantId, runId: { in: runs.map((r) => r.id) }, status: { in: [...(opts.statuses ?? ON_ROAD_STATUSES)] as never } },
    orderBy: [{ truckId: 'asc' }, { loadNo: 'asc' }],
    select: { id: true, runId: true, truckId: true, loadNo: true, status: true, departMin: true, returnMin: true, driverId: true, statusChangedAt: true, breakJson: true },
  });
  const truckIds = [...new Set(loads.map((l) => l.truckId))];
  const driverIds = [...new Set(loads.map((l) => l.driverId).filter((x): x is string => !!x))];
  const [trucks, drivers] = await Promise.all([
    truckIds.length ? db.truck.findMany({ where: { tenantId, id: { in: truckIds } }, select: { id: true, code: true, hired: true } }) : [],
    driverIds.length ? db.driver.findMany({ where: { tenantId, id: { in: driverIds } }, select: { id: true, name: true, casual: true } }) : [],
  ]);
  const truckOf = new Map(trucks.map((t) => [t.id, t]));
  const driverOf = new Map(drivers.map((d) => [d.id, d]));
  return loads.map((l) => {
    const run = runOf.get(l.runId)!;
    const d = l.driverId ? driverOf.get(l.driverId) : undefined;
    return {
      id: l.id,
      runId: l.runId,
      depotId: run.depotId,
      date: run.date,
      truckId: l.truckId,
      truckCode: truckOf.get(l.truckId)?.code ?? '?',
      hired: !!truckOf.get(l.truckId)?.hired,
      loadNo: l.loadNo,
      status: l.status,
      departMin: l.departMin,
      returnMin: l.returnMin,
      driverId: l.driverId,
      driverName: d?.name ?? null,
      driverCasual: !!d?.casual,
      statusChangedAt: l.statusChangedAt ?? null,
      breakJson: l.breakJson ?? null,
    };
  });
}

/** One planned stop of a load (the same facts a visit copies at its first write). */
export interface PlannedStopRow {
  loadId: string;
  sequence: number;
  customerId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  etaMin: number | null;
  plannedServiceMin: number | null;
  windowStartMin: number | null;
  windowEndMin: number | null;
  pin: { lat: number; lng: number } | null;
  lines: VisitLine[];
  casesPlanned: number;
  orderIds: string[];
}

/** The stops of these loads, per load id, in sequence (the rows of every order of a stop, its lines from rowLines). */
export async function stopsOfLoads(db: Db, loads: readonly { id: string; breakJson?: unknown }[]): Promise<Map<string, PlannedStopRow[]>> {
  const out = new Map<string, PlannedStopRow[]>();
  if (!loads.length) return out;
  const rows = await db.routeAssignment.findMany({
    where: { loadId: { in: loads.map((l) => l.id) } },
    orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }],
    select: {
      loadId: true,
      sequenceInTruck: true,
      orderId: true,
      orderInStop: true,
      etaMin: true,
      serviceStartMin: true,
      departureMin: true,
      portionLinesJson: true,
      stopSnapshotJson: true,
      order: {
        select: {
          id: true,
          customerId: true,
          carriedToOrderId: true,
          customer: { select: { code: true, branchCode: true, name: true, lat: true, lng: true } },
          lines: { select: { id: true, cases: true, weightKg: true, product: { select: { code: true } } } },
        },
      },
    },
  });
  for (const l of loads) {
    const mine = rows.filter((r) => r.loadId === l.id);
    const seqs = [...new Set(mine.map((r) => r.sequenceInTruck))].sort((a, b) => a - b);
    const stops: PlannedStopRow[] = [];
    for (const s of seqs) {
      const at = mine.filter((r) => r.sequenceInTruck === s);
      const p = plannedStopFromRows(at as never, l.breakJson ?? null);
      if (!p) continue;
      const snap = (at[0]?.stopSnapshotJson ?? null) as { branchCode?: string | null } | null;
      stops.push({
        loadId: l.id,
        sequence: s,
        customerId: p.customerId,
        customerCode: p.customerCode,
        branchCode: snap?.branchCode ?? (at[0]?.order as { customer?: { branchCode?: string | null } } | undefined)?.customer?.branchCode ?? null,
        customerName: p.customerName,
        etaMin: p.etaMin,
        plannedServiceMin: p.plannedServiceMin,
        windowStartMin: p.windowStartMin,
        windowEndMin: p.windowEndMin,
        pin: p.pin,
        lines: p.lines,
        casesPlanned: p.casesPlanned,
        orderIds: [...new Set(at.map((r) => r.orderId))],
      });
    }
    out.set(l.id, stops);
  }
  return out;
}

/** The visits of a date range (optionally one depot), keyed by their natural key. */
export async function visitsInRange(db: Db, tenantId: string, from: string, to: string, depotId?: string | null): Promise<StopVisit[]> {
  return db.stopVisit.findMany({ where: { tenantId, deliveryDate: { gte: dateOnly(from), lte: dateOnly(to) }, ...(depotId ? { depotId } : {}) } });
}

export const visitKey = (v: { depotId: string; date: string; truckId: string; loadNo: number; sequence: number }) => `${v.depotId}|${v.date}|${v.truckId}|${v.loadNo}|${v.sequence}`;
export const keyOfVisit = (v: Pick<StopVisit, 'depotId' | 'deliveryDate' | 'truckId' | 'loadNo' | 'sequence'>) =>
  visitKey({ depotId: v.depotId, date: isoOf(v.deliveryDate), truckId: v.truckId, loadNo: v.loadNo, sequence: v.sequence });

/** Truck-days (`date|truckId`) of the range that have a driver link or a visit: in outcome scope whatever the date. */
export async function truckDaysWithLinkOrVisit(db: Db, tenantId: string, from: string, to: string, visits: readonly Pick<StopVisit, 'deliveryDate' | 'truckId'>[]): Promise<Set<string>> {
  const links = await db.driverLink.findMany({ where: { tenantId, deliveryDate: { gte: dateOnly(from), lte: dateOnly(to) } }, select: { deliveryDate: true, truckId: true } });
  return new Set([...links, ...visits].map((x) => `${isoOf(x.deliveryDate)}|${x.truckId}`));
}

/** Loads that reported Back at depot (`depotId|date|truckId|loadNo`). */
export async function backAtDepot(db: Db, tenantId: string, from: string, to: string, depotId?: string | null): Promise<Map<string, Date>> {
  const rows = await db.stopEvent.findMany({
    where: { tenantId, kind: 'BACK_AT_DEPOT', deliveryDate: { gte: dateOnly(from), lte: dateOnly(to) }, ...(depotId ? { depotId } : {}) },
    select: { depotId: true, deliveryDate: true, truckId: true, loadNo: true, at: true },
  });
  const out = new Map<string, Date>();
  for (const b of rows) {
    const k = `${b.depotId}|${isoOf(b.deliveryDate)}|${b.truckId}|${b.loadNo}`;
    const cur = out.get(k);
    if (!cur || b.at < cur) out.set(k, b.at);
  }
  return out;
}

export const backKey = (l: Pick<RoadLoad, 'depotId' | 'date' | 'truckId' | 'loadNo'>) => `${l.depotId}|${l.date}|${l.truckId}|${l.loadNo}`;

/** The company's settings the office side reads: time zone and the local date of outcomesSince. */
export async function outcomeSettings(db: Db, tenantId: string): Promise<{ tz: string; sinceLocal: string | null; serviceMinPerCase: number; defaultServiceTimeMin: number; radiusM: number }> {
  const cfg = await db.tenantConfig.findFirst({
    where: { tenantId },
    select: { timezone: true, outcomesSince: true, serviceMinPerCase: true, defaultServiceTimeMin: true, geofenceRadiusM: true },
  });
  const tz = cfg?.timezone || DEFAULT_TZ;
  return {
    tz,
    sinceLocal: cfg?.outcomesSince ? localDateIso(new Date(cfg.outcomesSince), tz) : null,
    serviceMinPerCase: cfg?.serviceMinPerCase ?? 0,
    defaultServiceTimeMin: cfg?.defaultServiceTimeMin ?? 10,
    radiusM: cfg?.geofenceRadiusM ?? 100,
  };
}

/** A dispatched stop without a result (the day-end list): counted as delivered, listed for the dispatcher. */
export interface NoResultStop {
  /** YYYY-MM-DD */
  date: string;
  depotId: string;
  truckId: string;
  truckCode: string;
  loadId: string;
  loadNo: number;
  sequence: number;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  cases: number;
  /** The planned lines (Record outcome prefills from them). */
  lines: VisitLine[];
}

/**
 * Is a load "back" for the no-result list: an earlier day's load that left, or today's that is
 * COMPLETED, reported Back at depot, or is past its planned return + 60 min. A later day: never.
 */
export function loadIsBack(l: Pick<RoadLoad, 'date' | 'status' | 'returnMin'>, today: string, nowLocalMin: number, back: boolean): boolean {
  if (l.date > today) return false;
  if (l.date < today) return true;
  return l.status === 'COMPLETED' || back || nowLocalMin >= l.returnMin + BACK_AFTER_RETURN_MIN;
}

/**
 * The stops without a result of loads that are back (loadIsBack), on the plans in use of the dates in
 * [from, to] of a depot, in outcome scope. Sorted by date, truck, load and stop.
 */
export async function noResultStops(
  db: Db,
  tenantId: string,
  depotId: string | null,
  range: { from: string; to: string },
  opts: { now?: Date } = {},
): Promise<NoResultStop[]> {
  if (range.to < range.from) return [];
  const now = opts.now ?? new Date();
  const set = await outcomeSettings(db, tenantId);
  const today = localDateIso(now, set.tz);
  const nowMin = localMinutes(now, set.tz);
  const runs = await liveRunsInRange(db, tenantId, range.from, range.to, depotId);
  const loads = await loadsOfRuns(db, tenantId, runs);
  if (!loads.length) return [];
  const [visits, backs] = await Promise.all([visitsInRange(db, tenantId, range.from, range.to, depotId), backAtDepot(db, tenantId, range.from, range.to, depotId)]);
  const scoped = await truckDaysWithLinkOrVisit(db, tenantId, range.from, range.to, visits);
  const back = loads.filter((l) => loadIsBack(l, today, nowMin, backs.has(backKey(l))) && inOutcomeScope(l.date, set.sinceLocal, scoped.has(`${l.date}|${l.truckId}`)));
  const stops = await stopsOfLoads(db, back);
  const done = new Set(visits.filter((v) => v.outcome).map(keyOfVisit));
  const out: NoResultStop[] = [];
  for (const l of back) {
    for (const s of stops.get(l.id) ?? []) {
      if (done.has(visitKey({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo, sequence: s.sequence }))) continue;
      out.push({
        date: l.date,
        depotId: l.depotId,
        truckId: l.truckId,
        truckCode: l.truckCode,
        loadId: l.id,
        loadNo: l.loadNo,
        sequence: s.sequence,
        customerCode: s.customerCode,
        branchCode: s.branchCode,
        customerName: s.customerName,
        cases: s.casesPlanned,
        lines: s.lines,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.truckCode.localeCompare(b.truckCode) || a.loadNo - b.loadNo || a.sequence - b.sequence);
}

/** The days [D-6, D] for a 7-day range ending on `to` (helper for the dashboard). */
export function rangeEnding(to: string, days: number): { from: string; to: string } {
  return { from: addDaysIso(to, -(days - 1)), to };
}

/** A stored visit as the KPIs read it (dayStart from the company's time zone). */
export function kpiVisitOf(v: StopVisit, tz: string): KpiVisit {
  const date = isoOf(v.deliveryDate);
  return {
    outcome: v.outcome,
    reason: v.reason,
    casesPlanned: v.casesPlanned,
    casesDelivered: v.casesDelivered,
    arrivedAt: v.arrivedAt,
    arrivalSource: v.arrivalSource,
    arrivalObserved: v.arrivalObserved,
    timingSuspect: v.timingSuspect,
    windowStartMin: v.windowStartMin,
    windowEndMin: v.windowEndMin,
    autoServiceMinutes: v.autoServiceMinutes,
    plannedServiceMin: v.plannedServiceMin,
    outcomeLate: v.outcomeLate,
    noPhotoReason: v.noPhotoReason,
    autoArrivedAt: v.autoArrivedAt,
    deliveryDate: date,
    dayStart: zonedDayStart(date, tz),
    truckId: v.truckId,
  };
}

/**
 * The KPIs of the dispatched stops of the plans in use in [from, to] (one depot or all), in outcome
 * scope (spec section 11.4).
 */
export async function rangeKpis(db: Db, tenantId: string, range: { from: string; to: string }, depotId?: string | null): Promise<DeliveryKpis> {
  if (range.to < range.from) return deliveryKpis([]);
  const set = await outcomeSettings(db, tenantId);
  const runs = await liveRunsInRange(db, tenantId, range.from, range.to, depotId);
  const loads = await loadsOfRuns(db, tenantId, runs);
  if (!loads.length) return deliveryKpis([]);
  const [rows, visits] = await Promise.all([
    db.routeAssignment.findMany({ where: { loadId: { in: loads.map((l) => l.id) } }, select: { loadId: true, sequenceInTruck: true } }),
    visitsInRange(db, tenantId, range.from, range.to, depotId),
  ]);
  const scoped = await truckDaysWithLinkOrVisit(db, tenantId, range.from, range.to, visits);
  const byKey = new Map(visits.map((v) => [keyOfVisit(v), v]));
  const loadOf = new Map(loads.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const stops: (KpiVisit | null)[] = [];
  for (const r of rows) {
    const l = r.loadId ? loadOf.get(r.loadId) : undefined;
    if (!l || !inOutcomeScope(l.date, set.sinceLocal, scoped.has(`${l.date}|${l.truckId}`))) continue;
    const k = visitKey({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo, sequence: r.sequenceInTruck });
    if (seen.has(k)) continue;
    seen.add(k);
    const v = byKey.get(k);
    stops.push(v ? kpiVisitOf(v, set.tz) : null);
  }
  return deliveryKpis(stops);
}

/**
 * "Camera not working" (owner decision 2, 5 Oct 2026): the results saved without a photo per truck-day
 * (`date|truckId`, one driver link) in [from, to], every depot (a truck that loads at two depots has
 * one link for the day).
 */
export async function cameraCountsByTruckDay(db: Db, tenantId: string, from: string, to: string): Promise<Map<string, number>> {
  const rows = await db.stopVisit.findMany({
    where: { tenantId, deliveryDate: { gte: dateOnly(from), lte: dateOnly(to) }, noPhotoReason: 'CAMERA_FAILED', outcome: { in: ['DELIVERED', 'PARTLY_DELIVERED'] } },
    select: { deliveryDate: true, truckId: true, outcome: true, noPhotoReason: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!isCameraException(r)) continue;
    const k = truckDayKey(isoOf(r.deliveryDate), r.truckId);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/**
 * The day's results saved without a photo on the dispatched stops of a depot's plan in use (stop,
 * customer, driver, time), and the driver links that used it 3 times or more that day.
 */
export async function dayCameraExceptions(db: Db, tenantId: string, depotId: string, date: string, tz: string): Promise<{ list: CameraException[]; alerts: CameraLinkAlert[] }> {
  const visits = (await visitsInRange(db, tenantId, date, date, depotId)).filter(isCameraException);
  if (!visits.length) return { list: [], alerts: [] };
  const runs = await liveRunsInRange(db, tenantId, date, date, depotId);
  const byKey = new Map(visits.map((v) => [keyOfVisit(v), v]));
  const loads = (await loadsOfRuns(db, tenantId, runs)).filter((l) => visits.some((v) => v.truckId === l.truckId && v.loadNo === l.loadNo && v.depotId === l.depotId));
  if (!loads.length) return { list: [], alerts: [] };
  const [stops, counts] = await Promise.all([stopsOfLoads(db, loads), cameraCountsByTruckDay(db, tenantId, date, date)]);
  const list: CameraException[] = [];
  for (const l of loads) {
    for (const s of stops.get(l.id) ?? []) {
      const v = byKey.get(visitKey({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo, sequence: s.sequence }));
      if (v) list.push(cameraExceptionOf(l, s, v, tz));
    }
  }
  const sorted = sortCameraExceptions(list);
  return { list: sorted, alerts: cameraLinkAlerts(sorted, counts) };
}

/** The day screen's Deliveries card (spec section 10.3): the day's KPIs, the stops of loads that are back without a result, the late-dispatch notes. */
export interface DayDeliveries {
  /** The local date the delivery results started (TenantConfig.outcomesSince), or null. */
  since: string | null;
  /** The day is before the feature started: the card says "Delivery results started on ..." instead. */
  beforeStart: boolean;
  kpis: DeliveryKpis;
  noResult: NoResultStop[];
  lateDispatch: { loadId: string; text: string }[];
  /** Owner decision 2 (5 Oct 2026): results saved without a photo ("Camera not working"), every one listed. */
  cameraExceptions: CameraException[];
  /** The driver links (truck-days) that used it 3 times or more that day. */
  cameraAlerts: CameraLinkAlert[];
}

export async function dayDeliveries(tenantId: string, depotId: string, date: string, opts: { now?: Date; db?: Db } = {}): Promise<DayDeliveries> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const set = await outcomeSettings(db, tenantId);
  const beforeStart = !!set.sinceLocal && date < set.sinceLocal;
  const [kpis, noResult, late, camera] = await Promise.all([
    rangeKpis(db, tenantId, { from: date, to: date }, depotId),
    noResultStops(db, tenantId, depotId, { from: date, to: date }, { now }),
    lateDispatchOfDay(db, tenantId, depotId, date, set.tz),
    dayCameraExceptions(db, tenantId, depotId, date, set.tz),
  ]);
  return { since: set.sinceLocal, beforeStart, kpis, noResult, lateDispatch: late, cameraExceptions: camera.list, cameraAlerts: camera.alerts };
}

/** The plan screen's late-dispatch notes for the day screen (driver page opened after a load's planned departure, load still Locked / Loading). */
async function lateDispatchOfDay(db: Db, tenantId: string, depotId: string, date: string, tz: string): Promise<{ loadId: string; text: string }[]> {
  const runs = await liveRunsInRange(db, tenantId, date, date, depotId);
  const loads = await loadsOfRuns(db, tenantId, runs, { statuses: ['LOCKED', 'LOADING'] });
  if (!loads.length) return [];
  const links = await db.driverLink.findMany({ where: { tenantId, deliveryDate: dateOnly(date), truckId: { in: [...new Set(loads.map((l) => l.truckId))] } }, select: { truckId: true, lastSeenAt: true } });
  return lateDispatchNotes(
    loads,
    links.map((x) => ({ truckId: x.truckId, lastSeenAt: x.lastSeenAt ? x.lastSeenAt.toISOString() : null })),
    date,
    tz,
  );
}
