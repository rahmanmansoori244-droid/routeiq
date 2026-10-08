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
import { shownTruckCode } from '../dispatch/hire';
import { lateDispatchNotes } from '../driver-link/plan-notes';
import { linkUploadUntil } from '../driver-link/token';
import { plannedStopFromRows } from './planned-stop';
import type { VisitLine } from './visit';
import { deliveryKpis, inOutcomeScope, type DeliveryKpis, type KpiVisit } from './kpis';
import { awaitsPhoto, cameraExceptionOf, cameraLinkAlerts, isCameraException, noPhotoKind, photoWaitOver, sortCameraExceptions, truckDayKey, type CameraException, type CameraLinkAlert } from './camera-exceptions';

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
    truckIds.length ? db.truck.findMany({ where: { tenantId, id: { in: truckIds } }, select: { id: true, code: true, hired: true, onlyOnDate: true } }) : [],
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
      // The plate a hired truck drove with, also after a later day's hired truck took it (third review of
      // the hire branch: "12345AB.261006" on the delivery results and the Bring forward list).
      truckCode: truckOf.has(l.truckId) ? shownTruckCode(null, truckOf.get(l.truckId)!) : '?',
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
  // The rows grouped once, by load and then by stop (in the query's order), never a scan of every row
  // per load and per stop: a month of every depot has thousands of loads and tens of thousands of
  // rows (review of 8 Oct 2026: seconds of the actuals Excel's time, the web process blocked).
  const byLoad = new Map<string | null, Map<number, typeof rows>>();
  for (const r of rows) {
    let bySeq = byLoad.get(r.loadId);
    if (!bySeq) byLoad.set(r.loadId, (bySeq = new Map()));
    const at = bySeq.get(r.sequenceInTruck);
    if (at) at.push(r);
    else bySeq.set(r.sequenceInTruck, [r]);
  }
  for (const l of loads) {
    const bySeq = byLoad.get(l.id);
    const seqs = [...(bySeq?.keys() ?? [])].sort((a, b) => a - b);
    const stops: PlannedStopRow[] = [];
    for (const s of seqs) {
      const at = bySeq!.get(s)!;
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

/** A stored visit as the KPIs read it (dayStart from the company's time zone). `photoWaitOver`: photoWaitOverOf has the visit. */
export function kpiVisitOf(v: StopVisit, tz: string, photoWaitOver = false): KpiVisit {
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
    driverResultOutcome: v.driverResultOutcome,
    driverNoPhotoReason: v.driverNoPhotoReason,
    driverPhotoKeys: v.driverPhotoKeys,
    photoCount: v.photoCount,
    photoWaitOver,
  };
}

/**
 * The KPIs of the dispatched stops of the plans in use in [from, to] (one depot or all), in outcome
 * scope (spec section 11.4).
 */
export async function rangeKpis(db: Db, tenantId: string, range: { from: string; to: string }, depotId?: string | null, opts: { now?: Date } = {}): Promise<DeliveryKpis> {
  if (range.to < range.from) return deliveryKpis([]);
  const set = await outcomeSettings(db, tenantId);
  const runs = await liveRunsInRange(db, tenantId, range.from, range.to, depotId);
  const loads = await loadsOfRuns(db, tenantId, runs);
  if (!loads.length) return deliveryKpis([]);
  const [rows, visits] = await Promise.all([
    db.routeAssignment.findMany({ where: { loadId: { in: loads.map((l) => l.id) } }, select: { loadId: true, sequenceInTruck: true } }),
    visitsInRange(db, tenantId, range.from, range.to, depotId),
  ]);
  const [scoped, waitOver] = await Promise.all([
    truckDaysWithLinkOrVisit(db, tenantId, range.from, range.to, visits),
    photoWaitOverOf(db, tenantId, range.from, range.to, visits, { now: opts.now ?? new Date(), loads }),
  ]);
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
    stops.push(v ? kpiVisitOf(v, set.tz, waitOver.has(v.id)) : null);
  }
  return deliveryKpis(stops);
}

type WaitVisit = Pick<StopVisit, 'id' | 'depotId' | 'deliveryDate' | 'truckId' | 'loadNo' | 'driverResultAt' | 'driverResultOutcome' | 'driverNoPhotoReason' | 'driverPhotoKeys' | 'photoCount'>;

/**
 * "Photo not received" (owner decision 2, review of 5 Oct 2026): the ids of the visits whose driver
 * result named a photo that has not arrived (awaitsPhoto) and can no longer arrive (photoWaitOver:
 * the truck-day's link reissued or revoked after the result, past its upload time, or the load
 * COMPLETED for an hour). No query when no visit waits for a photo. `loads`: the dispatched loads the
 * visits belong to when the caller has them; else the plans in use of [from, to], every depot.
 */
export async function photoWaitOverOf(db: Db, tenantId: string, from: string, to: string, visits: readonly WaitVisit[], opts: { now: Date; loads?: readonly RoadLoad[] }): Promise<Set<string>> {
  const waiting = visits.filter(awaitsPhoto);
  if (!waiting.length) return new Set();
  const [links, loads] = await Promise.all([
    db.driverLink.findMany({
      where: { tenantId, deliveryDate: { gte: dateOnly(from), lte: dateOnly(to) }, truckId: { in: [...new Set(waiting.map((v) => v.truckId))] } },
      select: { truckId: true, deliveryDate: true, issuedAt: true, revokedAt: true, expiresAt: true },
    }),
    opts.loads ?? (async () => loadsOfRuns(db, tenantId, await liveRunsInRange(db, tenantId, from, to)))(),
  ]);
  const linkOf = new Map(links.map((x) => [truckDayKey(isoOf(x.deliveryDate), x.truckId), x]));
  const loadOf = new Map(loads.map((l) => [backKey(l), l]));
  const out = new Set<string>();
  for (const v of waiting) {
    const date = isoOf(v.deliveryDate);
    const link = linkOf.get(truckDayKey(date, v.truckId));
    const load = loadOf.get(backKey({ depotId: v.depotId, date, truckId: v.truckId, loadNo: v.loadNo })) ?? null;
    const over = photoWaitOver({
      resultAt: v.driverResultAt,
      link: link ? { issuedAt: link.issuedAt, revokedAt: link.revokedAt, uploadUntil: linkUploadUntil(link.expiresAt) } : null,
      load: load ? { status: load.status, statusChangedAt: load.statusChangedAt } : null,
      now: opts.now,
    });
    if (over) out.add(v.id);
  }
  return out;
}

/**
 * Results saved without a photo (owner decision 2, 5 Oct 2026: "Camera not working", and a named photo
 * that never arrived) per truck-day (`date|truckId`, one driver link) in [from, to], every depot (a
 * truck that loads at two depots has one link for the day). Read from the driver's own results: an
 * office correction keeps a stop counted.
 */
export async function cameraCountsByTruckDay(db: Db, tenantId: string, from: string, to: string, opts: { now?: Date } = {}): Promise<Map<string, number>> {
  const rows = await db.stopVisit.findMany({
    // Only the candidates: "Camera not working", or a named photo with no photo arrived (noPhotoKind decides).
    where: {
      tenantId,
      deliveryDate: { gte: dateOnly(from), lte: dateOnly(to) },
      driverResultOutcome: { in: ['DELIVERED', 'PARTLY_DELIVERED'] },
      OR: [{ driverNoPhotoReason: 'CAMERA_FAILED' }, { driverPhotoKeys: { gte: 1 }, photoCount: 0 }],
    },
    select: { id: true, depotId: true, deliveryDate: true, truckId: true, loadNo: true, driverResultAt: true, driverResultOutcome: true, driverNoPhotoReason: true, driverPhotoKeys: true, photoCount: true },
  });
  const waitOver = await photoWaitOverOf(db, tenantId, from, to, rows, { now: opts.now ?? new Date() });
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!noPhotoKind(r, waitOver.has(r.id))) continue;
    const k = truckDayKey(isoOf(r.deliveryDate), r.truckId);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/**
 * The day's results saved without a photo on the dispatched stops of a depot's plan in use (stop,
 * customer, driver, time, why, what changed after), and the driver links with 3 or more that day.
 */
export async function dayCameraExceptions(db: Db, tenantId: string, depotId: string, date: string, tz: string, opts: { now?: Date } = {}): Promise<{ list: CameraException[]; alerts: CameraLinkAlert[] }> {
  const now = opts.now ?? new Date();
  const candidates = (await visitsInRange(db, tenantId, date, date, depotId)).filter((v) => isCameraException(v) || awaitsPhoto(v));
  if (!candidates.length) return { list: [], alerts: [] };
  const runs = await liveRunsInRange(db, tenantId, date, date, depotId);
  const loads = (await loadsOfRuns(db, tenantId, runs)).filter((l) => candidates.some((v) => v.truckId === l.truckId && v.loadNo === l.loadNo && v.depotId === l.depotId));
  if (!loads.length) return { list: [], alerts: [] };
  const waitOver = await photoWaitOverOf(db, tenantId, date, date, candidates, { now, loads });
  const byKey = new Map(candidates.map((v) => [keyOfVisit(v), v]));
  const [stops, counts] = await Promise.all([stopsOfLoads(db, loads), cameraCountsByTruckDay(db, tenantId, date, date, { now })]);
  const list: CameraException[] = [];
  for (const l of loads) {
    for (const s of stops.get(l.id) ?? []) {
      const v = byKey.get(visitKey({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo, sequence: s.sequence }));
      const kind = v ? noPhotoKind(v, waitOver.has(v.id)) : null;
      if (v && kind) list.push(cameraExceptionOf(l, s, v, kind, tz));
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
  /** Owner decision 2 (5 Oct 2026): results saved without a photo ("Camera not working", or the named photo never arrived), every one listed. */
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
    rangeKpis(db, tenantId, { from: date, to: date }, depotId, { now }),
    noResultStops(db, tenantId, depotId, { from: date, to: date }, { now }),
    lateDispatchOfDay(db, tenantId, depotId, date, set.tz),
    dayCameraExceptions(db, tenantId, depotId, date, set.tz, { now }),
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
