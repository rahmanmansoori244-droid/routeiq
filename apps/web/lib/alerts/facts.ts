/**
 * Operations alerts (owner request 16 Oct 2026): the facts of one company's yesterday, today and
 * tomorrow (its time zone), read for the rules (rules.ts). Server only; every query names the company
 * (or takes ids read for it), as the other janitor sweeps do. About a dozen indexed queries:
 *
 *  1. the plan in use per depot and date (liveRunsInRange) and its loads, every status (loadsOfRuns);
 *  2. per load: the receiving-hours rule it was planned with (its truck snapshot's echo; none = START,
 *     the earlier rule: critique L2), the Loaded press, the planned stops and their times;
 *  3. for the loads that left (DISPATCHED / COMPLETED): the planned stops (stopsOfLoads), their orders'
 *     priority, whether each customer's pin is verified and whether it moved since the visit was planned
 *     (PIN_MOVED_M), the visits, their photos (source, old photo and time too: R9 and the projection);
 *  4. Back at depot per load (backAtDepot);
 *  5. per truck-day (one driver link): the link's lastSeenAt and the last thing the phone sent (driver
 *     events PHONE_AUTO / PHONE_MANUAL and photos, by the server's receipt time: the phone holds its
 *     events while offline and before Dispatch);
 *  6. the alert rows open now, and every row of the window's dates (the store needs both).
 *
 * The "Pin may be wrong" check (customer-stats.ts pinCheckList) runs only when the proof-far rule is on
 * and a verified customer of the window has evidence over PIN_FAR_M, and only for those customers.
 */
import type { Prisma, StopVisit } from '@prisma/client';
import { prisma } from '../db';
import { findInParts } from '../in-parts';
import { addDaysIso, dateOnly, isoOf, todayIso } from '../dispatch/time';
import { echoedWindowRule } from '../dispatch/window-rule';
import { parseLoadBreak, readTruckSnapshot } from '../dispatch/snapshots';
import { backAtDepot, backKey, keyOfVisit, liveRunsInRange, loadsOfRuns, stopsOfLoads, visitKey, visitsInRange } from '../delivery/day-results';
import { PIN_FAR_M } from '../delivery/pin-check';
import { distanceM, PIN_MOVED_M } from '../dispatch/snapshots';
import { pinCheckList } from '../delivery/customer-stats';
import { ALERT_DAYS_AHEAD, ALERT_DAYS_BACK, type AlertRule } from './catalog';
import { openKey, truckDayOf, type AlertFacts, type FactLoad, type FactPhoto, type FactSignal, type FactStop, type FactTruckDay, type FactVisit, type OpenRowInfo } from './rules';
import { STORED_SELECT, storedOf, type StoredAlert } from './store';
import type { AlertKind } from './catalog';

type Db = Prisma.TransactionClient | typeof prisma;

const ALL_STATUSES = ['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'] as const;
const ON_ROAD = new Set(['DISPATCHED', 'COMPLETED']);
const PHONE = ['PHONE_AUTO', 'PHONE_MANUAL'] as const;

/** The window: yesterday, today and tomorrow in the company's time zone. */
export function alertDates(tz: string, now: Date): string[] {
  const today = todayIso(tz, now);
  const out: string[] = [];
  for (let d = -ALERT_DAYS_BACK; d <= ALERT_DAYS_AHEAD; d++) out.push(addDaysIso(today, d));
  return out;
}

/** The facts the rules read, and the rows the store compares them with. */
export async function readAlertFacts(
  db: Db,
  tenantId: string,
  opts: { tz: string; now: Date; thresholds: Readonly<Record<AlertRule, number | null>> },
): Promise<{ facts: AlertFacts; rows: StoredAlert[] }> {
  const { tz, now } = opts;
  const dates = alertDates(tz, now);
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  const range = { gte: dateOnly(from), lte: dateOnly(to) };

  const runs = await liveRunsInRange(db, tenantId, from, to);
  const loads = await loadsOfRuns(db, tenantId, runs, { statuses: ALL_STATUSES });
  const loadIds = loads.map((l) => l.id);
  const onRoad = loads.filter((l) => ON_ROAD.has(l.status));

  const [extra, rowsOfPlan, planned, visits, backs, links, rows] = await Promise.all([
    findInParts(loadIds, (part) => db.planLoad.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, truckSnapshotJson: true, loadedAt: true } })),
    // The load ids came from this company's plans (loadsOfRuns): RouteAssignment has no company column.
    findInParts(loadIds, (part) =>
      db.routeAssignment.findMany({
        where: { loadId: { in: part } },
        select: { loadId: true, sequenceInTruck: true, orderId: true, orderInStop: true, etaMin: true, serviceStartMin: true, departureMin: true },
        orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }],
      }),
    ),
    stopsOfLoads(db, onRoad),
    visitsInRange(db, tenantId, from, to),
    backAtDepot(db, tenantId, from, to),
    db.driverLink.findMany({ where: { tenantId, deliveryDate: range }, select: { truckId: true, deliveryDate: true, lastSeenAt: true } }),
    db.opsAlert.findMany({ where: { tenantId, OR: [{ resolvedAt: null }, { deliveryDate: { gte: dateOnly(from) } }] }, select: STORED_SELECT }),
  ]);

  // Orders' priority (the stop's: the best of its orders) and the customers' verified pins, for the stops that left.
  const onRoadIds = new Set(onRoad.map((l) => l.id));
  const roadRows = rowsOfPlan.filter((r) => r.loadId && onRoadIds.has(r.loadId));
  const orderIds = [...new Set(roadRows.map((r) => r.orderId))];
  const customerIds = [...new Set([...planned.values()].flat().map((s) => s.customerId))];
  const [orders, customers] = await Promise.all([
    findInParts(orderIds, (part) => db.order.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, priority: true } })),
    findInParts(customerIds, (part) => db.customer.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, locationVerified: true, lat: true, lng: true } })),
  ]);
  const priorityOf = new Map(orders.map((o) => [o.id, o.priority]));
  const verified = new Set(customers.filter((c) => c.locationVerified).map((c) => c.id));
  const pinOf = new Map(customers.map((c) => [c.id, c]));

  // Photos of the window's visits, and each visit's own row by its natural key.
  const visitIds = visits.map((v) => v.id);
  const photos = await findInParts(visitIds, (part) =>
    db.deliveryPhoto.findMany({
      where: { tenantId, visitId: { in: part } },
      select: { visitId: true, source: true, positionStatus: true, distanceM: true, accuracyM: true, exifDistanceM: true, receivedAt: true, takenAt: true, oldPhoto: true },
    }),
  );
  const photosOf = new Map<string, FactPhoto[]>();
  for (const p of photos) {
    const list = photosOf.get(p.visitId);
    const f: FactPhoto = {
      positionStatus: p.positionStatus,
      distanceM: p.distanceM,
      accuracyM: p.accuracyM,
      exifDistanceM: p.exifDistanceM,
      receivedAt: p.receivedAt,
      source: p.source,
      oldPhoto: p.oldPhoto,
      takenAt: p.takenAt,
    };
    if (list) list.push(f);
    else photosOf.set(p.visitId, [f]);
  }
  const visitOf = new Map(visits.map((v) => [keyOfVisit(v), v]));

  // "Pin may be wrong" (critique M1): only for verified customers with far evidence in the window, and only when the rule is on.
  let flagged = new Set<string>();
  if (opts.thresholds.PROOF_FAR !== null) {
    const suspects = new Set<string>();
    for (const v of visits) {
      if (!verified.has(v.customerId)) continue;
      const far = (photosOf.get(v.id) ?? []).some((p) => (p.positionStatus === 'OK' && (p.distanceM ?? 0) > PIN_FAR_M) || (p.exifDistanceM ?? 0) > PIN_FAR_M) || (v.outcomeDistanceM ?? 0) > PIN_FAR_M;
      if (far) suspects.add(v.customerId);
    }
    if (suspects.size) flagged = new Set((await pinCheckList(tenantId, { db, now, customerIds: [...suspects] })).map((r) => r.customerId));
  }

  // The last thing each truck-day's phone sent (events and photos, by receipt time).
  const signals = await lastSignals(db, tenantId, range, visits, photos);

  const extraOf = new Map(extra.map((x) => [x.id, x]));
  const stopRowsOf = new Map<string, typeof rowsOfPlan>();
  for (const r of rowsOfPlan) {
    if (!r.loadId) continue;
    const list = stopRowsOf.get(r.loadId);
    if (list) list.push(r);
    else stopRowsOf.set(r.loadId, [r]);
  }

  const factLoads: FactLoad[] = loads.map((l) => {
    const x = extraOf.get(l.id);
    const own = stopRowsOf.get(l.id) ?? [];
    const brk = parseLoadBreak(l.breakJson);
    const stops: FactStop[] = ON_ROAD.has(l.status)
      ? (planned.get(l.id) ?? []).map((s) => {
          const at = own.filter((r) => r.sequenceInTruck === s.sequence);
          const first = at[0];
          const prios = at.map((r) => priorityOf.get(r.orderId)).filter((p): p is number => typeof p === 'number');
          const v = visitOf.get(visitKey({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo, sequence: s.sequence }));
          return {
            sequence: s.sequence,
            customerId: s.customerId,
            customerCode: s.customerCode,
            branchCode: s.branchCode,
            customerName: s.customerName,
            etaMin: s.etaMin,
            serviceStartMin: first?.serviceStartMin ?? null,
            departureMin: first?.departureMin ?? null,
            plannedServiceMin: s.plannedServiceMin,
            windowStartMin: s.windowStartMin,
            windowEndMin: s.windowEndMin,
            priority: prios.length ? Math.min(...prios) : null,
            pinVerified: verified.has(s.customerId) && !flagged.has(s.customerId),
            pinMoved: pinMovedSince(v ?? null, pinOf.get(s.customerId) ?? null),
            visit: v ? factVisit(v, photosOf.get(v.id) ?? []) : null,
          };
        })
      : [];
    return {
      id: l.id,
      depotId: l.depotId,
      date: l.date,
      truckId: l.truckId,
      truckCode: l.truckCode,
      loadNo: l.loadNo,
      status: l.status,
      departMin: l.departMin,
      returnMin: l.returnMin,
      statusChangedAt: l.statusChangedAt,
      loadedAt: x?.loadedAt ?? null,
      // A load planned before the rule was echoed was checked by the earlier rule (unloading had to start by closing).
      windowRule: echoedWindowRule(readTruckSnapshot(x?.truckSnapshotJson ?? null)?.rules?.windowRule) ?? 'START',
      breakMin: brk ? { startMin: brk.startMin, endMin: brk.endMin } : null,
      backAt: backs.get(backKey(l)) ?? null,
      stopCount: new Set(own.map((r) => r.sequenceInTruck)).size,
      stops,
    };
  });

  const linkOf = new Map(links.map((x) => [truckDayOf(isoOf(x.deliveryDate), x.truckId), x]));
  const truckDays: FactTruckDay[] = [...new Set(loads.map((l) => truckDayOf(l.date, l.truckId)))].map((k) => {
    const [date, truckId] = k.split('|') as [string, string];
    const link = linkOf.get(k);
    const lastSignal = signals.get(k) ?? null;
    return { date, truckId, linkSeenAt: link?.lastSeenAt ?? null, pageOpened: !!link?.lastSeenAt || !!lastSignal, lastSignal };
  });

  const stored = rows.map(storedOf);
  const open = new Map<string, OpenRowInfo>();
  for (const r of stored) if (!r.resolvedAt) open.set(openKey(r.rule, r.subjectKey), { kind: r.kind as AlertKind, tier: r.tier, depotId: r.depotId, deliveryDate: r.deliveryDate });

  return { facts: { tz, today: todayIso(tz, now), dates, loads: factLoads, truckDays, open }, rows: stored };
}

/**
 * The visit was planned at a pin more than PIN_MOVED_M from the customer's pin now (it was corrected
 * since): its photo and result distances were measured to the old pin (lib/delivery/pin-check.ts leaves
 * such a visit out too). False when either pin is unknown.
 */
export function pinMovedSince(v: { plannedLat: number | null; plannedLng: number | null } | null, now: { lat: number | null; lng: number | null } | null): boolean {
  if (!v || !now || v.plannedLat === null || v.plannedLng === null || now.lat === null || now.lng === null) return false;
  return distanceM({ lat: v.plannedLat, lng: v.plannedLng }, { lat: now.lat, lng: now.lng }) > PIN_MOVED_M;
}

function factVisit(v: StopVisit, photos: FactPhoto[]): FactVisit {
  return {
    arrivedAt: v.arrivedAt,
    arrivalSource: v.arrivalSource,
    arrivalObserved: v.arrivalObserved,
    arrivalDistanceM: v.arrivalDistanceM,
    arrivalAccuracyM: v.arrivalAccuracyM,
    timingSuspect: v.timingSuspect,
    departedAt: v.departedAt,
    departedAtOutcome: v.departedAtOutcome,
    autoMinutes: v.autoMinutes,
    autoServiceMinutes: v.autoServiceMinutes,
    outcome: v.outcome,
    reason: v.reason,
    reasonNote: v.reasonNote,
    outcomeAt: v.outcomeAt,
    outcomeSource: v.outcomeSource,
    outcomeDistanceM: v.outcomeDistanceM,
    outcomeAccuracyM: v.outcomeAccuracyM,
    casesPlanned: v.casesPlanned,
    casesDelivered: v.casesDelivered,
    plannedServiceMin: v.plannedServiceMin,
    windowStartMin: v.windowStartMin,
    windowEndMin: v.windowEndMin,
    photos,
  };
}

/**
 * The last thing each truck-day's phone sent, by the server's receipt time: the newest driver event
 * (PHONE_AUTO / PHONE_MANUAL; one grouped query, then the events at those times) or photo.
 */
async function lastSignals(
  db: Db,
  tenantId: string,
  range: { gte: Date; lte: Date },
  visits: readonly Pick<StopVisit, 'id' | 'depotId' | 'deliveryDate' | 'truckId' | 'loadNo' | 'sequence'>[],
  photos: readonly { visitId: string; source: string; receivedAt: Date }[],
): Promise<Map<string, FactSignal>> {
  const out = new Map<string, FactSignal>();
  const take = (k: string, s: FactSignal) => {
    const cur = out.get(k);
    if (!cur || s.at > cur.at) out.set(k, s);
  };
  const groups = await db.stopEvent.groupBy({
    by: ['deliveryDate', 'truckId'],
    where: { tenantId, deliveryDate: range, source: { in: [...PHONE] } },
    _max: { receivedAt: true },
  });
  const wanted = groups.filter((g) => g._max.receivedAt);
  if (wanted.length) {
    const events = await db.stopEvent.findMany({
      where: { tenantId, source: { in: [...PHONE] }, OR: wanted.map((g) => ({ deliveryDate: g.deliveryDate, truckId: g.truckId, receivedAt: g._max.receivedAt! })) },
      select: { deliveryDate: true, truckId: true, depotId: true, loadNo: true, sequence: true, kind: true, receivedAt: true },
    });
    for (const e of events) take(truckDayOf(isoOf(e.deliveryDate), e.truckId), { at: e.receivedAt, kind: e.kind, depotId: e.depotId, loadNo: e.loadNo, sequence: e.sequence });
  }
  const visitById = new Map(visits.map((v) => [v.id, v]));
  for (const p of photos) {
    const v = visitById.get(p.visitId);
    if (v && (PHONE as readonly string[]).includes(p.source)) take(truckDayOf(isoOf(v.deliveryDate), v.truckId), { at: p.receivedAt, kind: 'PHOTO', depotId: v.depotId, loadNo: v.loadNo, sequence: v.sequence });
  }
  return out;
}
