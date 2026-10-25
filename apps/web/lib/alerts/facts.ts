/**
 * Operations alerts (owner request 16 Oct 2026): the facts of one company's yesterday, today and
 * tomorrow (its time zone), read for the rules (rules.ts). Server only; every query names the company
 * (or takes ids read for it), as the other janitor sweeps do. About a dozen indexed queries:
 *
 *  1. the plan in use per depot and date (liveRunsInRange) and its loads, every status (loadsOfRuns);
 *  2. per load: the receiving-hours rule it was planned with (its truck snapshot's echo; none = START,
 *     the earlier rule: critique L2), the planned stops and their times;
 *  3. for the loads that left (DISPATCHED / COMPLETED): the planned stops (stopsOfLoads), their orders'
 *     priority, whether each customer's pin is verified and whether it moved since the visit was planned
 *     (PIN_MOVED_M), the visits, their photos (source, old photo and time too: R9 and the projection);
 *     a visit without the GPS times of the IVMS live link (alertVisitRow);
 *  4. Back at depot per load (backAtDepot) and the driver's Leaving for next load taps (leftDepotTaps: rule
 *     R2; none on a load that is Planned now), and for the trips after one with Back at depot their Dispatch
 *     press and when they were planned (loadOrigins: completing a load overwrites its status time);
 *  5. per truck-day (one driver link): the link's lastSeenAt and the last thing the phone sent (driver
 *     events PHONE_AUTO / PHONE_MANUAL and photos, by the server's receipt time: the phone holds its
 *     events while offline and before Dispatch);
 *  6. the alert rows open now, and every row of the window's dates (the store needs both).
 *
 * The "Pin may be wrong" check (customer-stats.ts pinCheckList) runs only when the proof-far rule is on
 * and a verified customer of the window has evidence over PIN_FAR_M, and only for those customers.
 *
 * GPS alerts (owner request 18 Oct 2026; GPS tracking ALERTS only, `opts.gps` from the sweep: gps.ts
 * gpsAlertConfigOf): for the trucks of the window, their truck-days (IvmsTruckDay: suppressed? history
 * pulled and processed up to?), their latest live fix (TruckPosition), their trail-confirmed depot moves
 * (IvmsEvent DEPOT_IN / DEPOT_OUT with outcome USED, as the stop detector uses them, with their depot; a
 * trail move's time is exact as the detector stored it - IvmsEvent.observed, review of 18 Oct 2026, finding
 * 6 - and only a move from before that is read against the trail points just before it), the loads' depot
 * pins, the GPS departures' observed flags (their StopEvent payload) - six more indexed queries. Every
 * truck-day whose GPS is not suppressed then gets its GpsTruckDayFact (lib/ivms/types.ts) and its visits
 * WITH their GPS times; a suppressed one is read as with the link off. Below ALERTS none of this is read
 * and the facts are exactly as before.
 */
import type { Prisma, StopVisit } from '@prisma/client';
import { prisma } from '../db';
import { findInParts, inParts } from '../in-parts';
import { addDaysIso, dateOnly, isoOf, todayIso, zonedDayStart } from '../dispatch/time';
import { echoedWindowRule } from '../dispatch/window-rule';
import { parseLoadBreak, readHandAllowances, readTruckSnapshot } from '../dispatch/snapshots';
import { rowKeyOf } from '../dispatch/split';
import { backAtDepot, backKey, keyOfVisit, leftDepotTaps, liveRunsInRange, loadOrigins, loadsOfRuns, stopsOfLoads, visitKey, visitsInRange } from '../delivery/day-results';
import { previousTrip } from '../delivery/turnaround';
import { PIN_FAR_M } from '../delivery/pin-check';
import { afterResultOf, withoutGpsTimes } from '../delivery/visit';
import { distanceM, PIN_MOVED_M } from '../dispatch/snapshots';
import { pinCheckList } from '../delivery/customer-stats';
import { ALERT_DAYS_AHEAD, ALERT_DAYS_BACK, type AlertRule } from './catalog';
import { gpsTruckDayFactOf, moveNeedsPoints, moveObserved, type AlertGpsConfig, type AlertGpsSettings, type ConfirmedMove } from './gps';
import { openKey, truckDayOf, type AlertFacts, type FactLoad, type FactPhoto, type FactSignal, type FactStop, type FactTruckDay, type FactVisit, type OpenRowInfo } from './rules';
import { DETECTOR_FIXED, type GpsTruckDayFact } from '../ivms/types';
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
  opts: { tz: string; now: Date; thresholds: Readonly<Record<AlertRule, number | null>>; gps?: AlertGpsConfig | null },
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

  const [extra, rowsOfPlan, planned, visits, backs, lefts, links, rows] = await Promise.all([
    findInParts(loadIds, (part) => db.planLoad.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, truckSnapshotJson: true } })),
    // The load ids came from this company's plans (loadsOfRuns): RouteAssignment has no company column.
    findInParts(loadIds, (part) =>
      db.routeAssignment.findMany({
        where: { loadId: { in: part } },
        select: { loadId: true, sequenceInTruck: true, orderId: true, orderInStop: true, etaMin: true, serviceStartMin: true, departureMin: true, portionLinesJson: true },
        orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }],
      }),
    ),
    stopsOfLoads(db, onRoad),
    visitsInRange(db, tenantId, from, to),
    backAtDepot(db, tenantId, from, to),
    leftDepotTaps(db, tenantId, from, to),
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
    findInParts(customerIds, (part) => db.customer.findMany({ where: { tenantId, id: { in: part } }, select: { id: true, locationVerified: true, lat: true, lng: true, siteRadiusM: true } })),
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

  // GPS alerts (GPS tracking ALERTS only): the truck-days' GPS, read once for the window.
  const gpsRead = opts.gps ? await readGpsFacts(db, tenantId, { loads, dates, tz, now }) : null;
  /** The truck-day's visits keep their GPS times: ALERTS, and its GPS not suppressed. */
  const keepGps = (date: string, truckId: string) => !!gpsRead && !gpsRead.suppressed.has(truckDayOf(date, truckId));

  // Rule R2 reads, for a trip after one that has Back at depot, its Dispatch press whatever its status now
  // and when it was planned (a trip added after the truck came back counts from then). With GPS (ALERTS, the
  // truck-day not suppressed) for every trip after another: the trail's depot IN may stand in for Back at depot.
  const r2Ids = loads
    .filter((l) => {
      const prev = previousTrip(
        loads.filter((x) => x.date === l.date && x.truckId === l.truckId),
        l.id,
      );
      return !!prev && (backs.has(backKey(prev)) || keepGps(l.date, l.truckId));
    })
    .map((l) => l.id);
  const origins = opts.thresholds.LOADING_OVER !== null ? await loadOrigins(db, tenantId, r2Ids) : new Map<string, { firstAt: Date | null; dispatchedAt: Date | null }>();

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
          const row = visitOf.get(visitKey({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo, sequence: s.sequence }));
          const gpsTimes = keepGps(l.date, l.truckId);
          const v = row ? alertVisitRow(row, photosOf.get(row.id) ?? [], gpsTimes) : null;
          // GPS alerts: the planned pin (the visit's, else the plan's, as the stop detector) for "at the stop" and the live ETA,
          // and the customer's site radius (owner request 19 Oct 2026: "at the stop" reaches that far, gps.ts atStopRadiusOf).
          const site = pinOf.get(s.customerId)?.siteRadiusM ?? null;
          // A late arrival allowed by hand on this stop (its rows covered by a LATE allowance of the load).
          const keys = at.map((r) => rowKeyOf(r.orderId, r.portionLinesJson));
          const late = keys.length ? readHandAllowances(x?.truckSnapshotJson ?? null).find((a) => a.kind === 'LATE' && keys.every((k) => a.rowKeys.includes(k))) : undefined;
          const gpsStop = gpsRead ? { pin: row && row.plannedLat !== null && row.plannedLng !== null ? { lat: row.plannedLat, lng: row.plannedLng } : s.pin, ...(site ? { siteRadiusM: site } : {}) } : {};
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
            ...(late && typeof late.maxLateMin === 'number' ? { allowedLateMin: late.maxLateMin } : {}),
            priority: prios.length ? Math.min(...prios) : null,
            pinVerified: verified.has(s.customerId) && !flagged.has(s.customerId),
            pinMoved: pinMovedSince(v ?? null, pinOf.get(s.customerId) ?? null),
            ...gpsStop,
            visit: v ? factVisit(v, photosOf.get(v.id) ?? [], gpsTimes ? gpsRead!.departureObserved(v) : undefined) : null,
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
      // A load planned before the rule was echoed was checked by the earlier rule (unloading had to start by closing).
      windowRule: echoedWindowRule(readTruckSnapshot(x?.truckSnapshotJson ?? null)?.rules?.windowRule) ?? 'START',
      breakMin: brk ? { startMin: brk.startMin, endMin: brk.endMin } : null,
      backAt: backs.get(backKey(l)) ?? null,
      // A load moved back to Planned loses its taps (plan-service.ts); one still Planned has none that count.
      leftTapAt: l.status === 'PLANNED' ? null : (lefts.get(backKey(l))?.at(-1) ?? null),
      leftTaps: l.status === 'PLANNED' ? [] : (lefts.get(backKey(l)) ?? []),
      dispatchedAt: origins.get(l.id)?.dispatchedAt ?? null,
      existedAt: origins.get(l.id)?.firstAt ?? null,
      stopCount: new Set(own.map((r) => r.sequenceInTruck)).size,
      stops,
    };
  });

  const linkOf = new Map(links.map((x) => [truckDayOf(isoOf(x.deliveryDate), x.truckId), x]));
  const truckDays: FactTruckDay[] = [...new Set(loads.map((l) => truckDayOf(l.date, l.truckId)))].map((k) => {
    const [date, truckId] = k.split('|') as [string, string];
    const link = linkOf.get(k);
    const lastSignal = signals.get(k) ?? null;
    return { date, truckId, linkSeenAt: link?.lastSeenAt ?? null, pageOpened: !!link?.lastSeenAt || !!lastSignal, lastSignal, ...(gpsRead ? { gps: gpsRead.truckDays.get(k) ?? null } : {}) };
  });

  const stored = rows.map(storedOf);
  const open = new Map<string, OpenRowInfo>();
  for (const r of stored) if (!r.resolvedAt) open.set(openKey(r.rule, r.subjectKey), { kind: r.kind as AlertKind, tier: r.tier, depotId: r.depotId, deliveryDate: r.deliveryDate });

  const gps: AlertGpsSettings | null = gpsRead && opts.gps ? { ...opts.gps, depots: gpsRead.depots } : null;
  return { facts: { tz, today: todayIso(tz, now), dates, loads: factLoads, truckDays, open, ...(gps ? { gps } : {}) }, rows: stored };
}

/**
 * How far a truck-day's GPS history has been turned into GPS times (GpsTruckDayFact.trailTo): the earlier of
 * how far it was pulled (pulledTo) and when the stop detector last ran over it (processedAt) - between a pull
 * and the detector's run the new points have no stop time yet (review of 18 Oct 2026, findings 1, 3 and 4).
 * Null: never pulled or never processed.
 */
export function trailToOf(row: { pulledTo: Date | null; processedAt: Date | null } | null): Date | null {
  if (!row?.pulledTo || !row.processedAt) return null;
  return row.processedAt.getTime() < row.pulledTo.getTime() ? row.processedAt : row.pulledTo;
}

/** The trail read around a truck-day, as the stop detector reads it (lib/ivms/stop-events.ts): 3 h before its local midnight to 27 h after. */
const GPS_WINDOW_BEFORE_MS = 3 * 3_600_000;
const GPS_WINDOW_AFTER_MS = 27 * 3_600_000;
/** Trail moves per query of the points just before them (each is an OR branch with three parameters). */
const TRAIL_MOVES_PER_QUERY = 500;

interface GpsRead {
  /** The truck-days whose GPS is suppressed (IvmsTruckDay.suppressedAt): read as with the link off. */
  suppressed: Set<string>;
  /** The GpsTruckDayFact of every other truck-day of the window with any GPS (a truck-day row, a live fix or a depot move). */
  truckDays: Map<string, GpsTruckDayFact>;
  depots: Map<string, { lat: number; lng: number }>;
  /** Is a visit's GPS departure exact (its AYUN DEPARTED event neither unobserved nor after a gap)? */
  departureObserved: (v: Pick<StopVisit, 'id' | 'departedAt' | 'departureSource' | 'departedAtOutcome'>) => boolean;
}

/** The GPS of the window's truck-days (GPS alerts, ALERTS only; see the file comment). Every query names the company. */
async function readGpsFacts(db: Db, tenantId: string, i: { loads: readonly { truckId: string; date: string; depotId: string }[]; dates: readonly string[]; tz: string; now: Date }): Promise<GpsRead> {
  const truckIds = [...new Set(i.loads.map((l) => l.truckId))];
  const depotIds = [...new Set(i.loads.map((l) => l.depotId))];
  const first = i.dates[0]!;
  const last = i.dates[i.dates.length - 1]!;
  const from = new Date(zonedDayStart(first, i.tz).getTime() - GPS_WINDOW_BEFORE_MS);
  const to = new Date(zonedDayStart(last, i.tz).getTime() + GPS_WINDOW_AFTER_MS);
  const range = { gte: dateOnly(first), lte: dateOnly(last) };
  const [days, positions, events, depots, departures] = await Promise.all([
    findInParts(truckIds, (part) => db.ivmsTruckDay.findMany({ where: { tenantId, truckId: { in: part }, deliveryDate: range }, select: { truckId: true, deliveryDate: true, suppressedAt: true, pulledTo: true, processedAt: true } })),
    findInParts(truckIds, (part) => db.truckPosition.findMany({ where: { tenantId, truckId: { in: part } }, select: { truckId: true, fixAt: true, lat: true, lng: true, speedKmh: true, flags: true, movedAt: true } })),
    findInParts(truckIds, (part) =>
      db.ivmsEvent.findMany({
        where: { tenantId, truckId: { in: part }, kind: { in: ['DEPOT_IN', 'DEPOT_OUT'] }, outcome: 'USED', eventAt: { gte: from, lte: to } },
        select: { truckId: true, depotId: true, kind: true, origin: true, eventAt: true, observed: true },
      }),
    ),
    depotIds.length ? db.depot.findMany({ where: { tenantId, id: { in: depotIds } }, select: { id: true, lat: true, lng: true } }) : [],
    db.stopEvent.findMany({ where: { tenantId, deliveryDate: range, source: 'AYUN', kind: 'DEPARTED' }, select: { visitId: true, at: true, payloadJson: true } }),
  ]);
  // A trail move's time is exact as the detector stored it; only a move from before 18 Oct 2026 (no flag)
  // is read against the trail points just before it, while they are kept (gps.ts moveObserved).
  const gapMs = DETECTOR_FIXED.observedMaxGapSec * 1000;
  const confirmed = (e: (typeof events)[number]): ConfirmedMove => ({ kind: e.kind as ConfirmedMove['kind'], at: e.eventAt, origin: e.origin, observed: e.observed ?? null });
  const trailMoves = events.filter((e) => moveNeedsPoints(confirmed(e)));
  const pointsOf = new Map<string, Date[]>();
  for (const part of inParts(trailMoves, TRAIL_MOVES_PER_QUERY)) {
    const points = await db.truckTrailPoint.findMany({
      where: { tenantId, OR: part.map((m) => ({ truckId: m.truckId, fixAt: { gte: new Date(m.eventAt.getTime() - gapMs), lt: m.eventAt } })) },
      select: { truckId: true, fixAt: true },
    });
    for (const p of points) pointsOf.set(p.truckId, [...(pointsOf.get(p.truckId) ?? []), p.fixAt]);
  }
  const moves = events
    .filter((e): e is typeof e & { kind: 'DEPOT_IN' | 'DEPOT_OUT' } => e.kind === 'DEPOT_IN' || e.kind === 'DEPOT_OUT')
    .map((e) => ({ truckId: e.truckId, kind: e.kind, at: e.eventAt, depotId: e.depotId ?? null, observed: moveObserved(confirmed(e), pointsOf.get(e.truckId) ?? []) }));

  const today = todayIso(i.tz, i.now);
  const keyOfDay = (d: { deliveryDate: Date; truckId: string }) => truckDayOf(isoOf(d.deliveryDate), d.truckId);
  const suppressed = new Set(days.filter((d) => d.suppressedAt).map(keyOfDay));
  const dayRow = new Map(days.map((d) => [keyOfDay(d), d]));
  const posOf = new Map(positions.map((p) => [p.truckId, p]));
  const keys = [...new Set(i.loads.map((l) => truckDayOf(l.date, l.truckId)))];
  // The live fix is the truck's latest: it is its truck-day of today's, else that of its latest day before today.
  const posDate = new Map<string, string>();
  for (const k of keys) {
    const [date, truckId] = k.split('|') as [string, string];
    if (date > today) continue;
    const cur = posDate.get(truckId);
    if (!cur || date > cur) posDate.set(truckId, date);
  }
  const truckDays = new Map<string, GpsTruckDayFact>();
  for (const k of keys) {
    if (suppressed.has(k)) continue;
    const [date, truckId] = k.split('|') as [string, string];
    const start = zonedDayStart(date, i.tz).getTime();
    const mine = moves.filter((m) => m.truckId === truckId && m.at.getTime() >= start - GPS_WINDOW_BEFORE_MS && m.at.getTime() <= start + GPS_WINDOW_AFTER_MS);
    const pos = posDate.get(truckId) === date ? (posOf.get(truckId) ?? null) : null;
    const row = dayRow.get(k);
    if (!row && !pos && !mine.length) continue;
    truckDays.set(k, gpsTruckDayFactOf({ position: pos ? { fixAt: pos.fixAt, lat: pos.lat, lng: pos.lng, speedKmh: pos.speedKmh, flags: pos.flags ?? [], movedAt: pos.movedAt } : null, moves: mine, trailTo: trailToOf(row ?? null), now: i.now }));
  }

  const departuresOf = new Map<string, { at: Date; payload: { observed?: unknown; gap?: unknown } | null }[]>();
  for (const e of departures) if (e.visitId) departuresOf.set(e.visitId, [...(departuresOf.get(e.visitId) ?? []), { at: e.at, payload: e.payloadJson as { observed?: unknown; gap?: unknown } | null }]);
  const departureObserved: GpsRead['departureObserved'] = (v) => {
    if (v.departureSource !== 'AYUN' || v.departedAtOutcome || !v.departedAt) return true;
    // The event the rebuild took the departure from; none found: not taken as exact.
    const e = (departuresOf.get(v.id) ?? []).find((x) => x.at.getTime() === v.departedAt!.getTime());
    return !!e && e.payload?.observed !== false && e.payload?.gap !== true;
  };
  return { suppressed, truckDays, depots: new Map(depots.map((d) => [d.id, { lat: d.lat, lng: d.lng }])), departureObserved };
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

/**
 * The visit as the alerts read it (merge review of 17 Oct 2026, finding 1): without the GPS times of the
 * IVMS live link (lib/delivery/visit.ts withoutGpsTimes: the driver's and the office's times only, as with
 * the link off), and none at all when GPS made it alone (no time, result or photo of its own: before the
 * link there was no row). GPS tracking ALERTS (owner request 18 Oct 2026, `keepGps`: the truck-day's GPS
 * is not suppressed): the stored visit as it is, WITH the GPS times the rebuild filled into the driver's and
 * the office's gaps (lib/alerts/gps.ts), and a visit only GPS made counts (a GPS arrival).
 */
export function alertVisitRow(row: StopVisit, photos: readonly FactPhoto[], keepGps = false): StopVisit | null {
  if (keepGps) return row;
  const own = withoutGpsTimes(row);
  if (own !== row && !own.arrivedAt && !own.departedAt && !own.outcome && !photos.length) return null;
  return own;
}

/** The visit as the rules read it; `departureObserved` given (GPS tracking ALERTS): also who gave the departure and whether a GPS one is exact. */
function factVisit(v: StopVisit, photos: FactPhoto[], departureObserved?: boolean): FactVisit {
  return {
    ...(departureObserved !== undefined ? { departureSource: v.departureSource, departureObserved } : {}),
    // The minutes away (owner request 19 Oct 2026): GPS facts, only with the GPS alerts (alertVisitRow clears them below ALERTS).
    ...(v.awayMinutes ? { awayMinutes: v.awayMinutes } : {}),
    // Owner decision 21 Oct 2026: the minutes after the driver's result (F2, never unloading) and the driver's own tap a
    // GPS arrival replaced (F1/F5: the arrival is not GPS alone). GPS facts too: withoutGpsTimes clears them below ALERTS.
    ...(afterResultOf(v) ? { afterResultMinutes: afterResultOf(v) } : {}),
    ...(v.arrivalSource === 'AYUN' && v.ownArrivedAt ? { ownArrivedAt: v.ownArrivedAt } : {}),
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
