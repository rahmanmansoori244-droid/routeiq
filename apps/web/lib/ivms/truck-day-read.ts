/**
 * GET /api/ivms/trucks/[id]/day (owner request 18 Oct 2026: a truck's day with one click from the plan
 * screen): reads the rows that the pure buildTruckDay (lib/ivms/truck-day.ts) turns into the page's
 * model. Server only; reads only; PLANNER and up (the route).
 *
 * - Every query names the company (tenantId): another company's truck is null (404) before anything
 *   else is read, and none of its rows can reach the answer.
 * - The loads are the truck's on the plans in use of the date, every depot (liveRunsInRange: the rule of
 *   the plan screen and the day results), so a re-plan's newest version is the one shown.
 * - Of the tracker, only whether the truck has one is read (a count): never the IMEI. Never a depot's
 *   Ayun zone name (lib/db.ts omits it; the depots are selected by field).
 * - GPS rows only while the mode in effect needs them (the kill switch is OFF): the live position from
 *   MAP on, for today or yesterday and only while a load of that date is out (Locked, Loading, On the
 *   road: the live map's rule, lib/ivms/vehicles.ts readLiveVehicles, review M7; a stored row the poller
 *   has not cleared yet is never read for a truck off duty, review of 18 Oct 2026); the trail, the depot
 *   moves and the GPS stop events in TIMES only, the trail from IvmsTruckDay.trailFrom on (never a point
 *   from before the tracker was put on this truck: second review M-1), at most TRAIL_READ_MAX points, and
 *   only for a day the retention keeps whole (trailKept: today and yesterday by default).
 * - The phone's own photo times (DeliveryPhoto: the capture time only, never the photo or its position),
 *   so the timeline places the Leaving for next load tap that rule R2 counts.
 */
import { prisma } from '../db';
import { ALERT_ROW_USERS, toOpsAlertRow } from '../alerts/types';
import { liveRunsInRange, stopsOfLoads } from '../delivery/day-results';
import { dispatchedAt } from '../dispatch/dispatched-at';
import { shownTruckCode } from '../dispatch/hire';
import { readTruckSnapshot } from '../dispatch/snapshots';
import { addDaysIso, dateOnly, DEFAULT_TZ, todayIso, zonedDayStart } from '../dispatch/time';
import { readIvmsEnv } from './env';
import { IVMS_SETTING_DEFAULTS, ivmsModeAtLeast, ivmsModeOf } from './settings';
import {
  buildTruckDay,
  lastActivityOf,
  trailKept,
  trailWindow,
  TRAIL_READ_MAX,
  TRUCK_DAY_ALERTS_MAX,
  TRUCK_DAY_DATES_AHEAD,
  TRUCK_DAY_DATES_BACK,
  TRUCK_DAY_EVENTS_MAX,
  TRUCK_DAY_MOVES_MAX,
  type TruckDayEventInput,
  type TruckDayModel,
} from './truck-day';
import type { IvmsMode } from './types';

const OUT = new Set(['LOCKED', 'LOADING', 'DISPATCHED']);

/** The truck's day, or null when the truck is not this company's. `date` null = the company's today. */
export async function readTruckDay(tenantId: string, truckId: string, date: string | null, now: Date = new Date()): Promise<TruckDayModel | null> {
  const truck = await prisma.truck.findFirst({
    where: { id: truckId, tenantId },
    select: { id: true, code: true, description: true, hired: true, onlyOnDate: true, depotId: true },
  });
  if (!truck) return null;
  const [cfg, tracked] = await Promise.all([
    prisma.tenantConfig.findFirst({
      where: { tenantId },
      select: { timezone: true, ivmsMode: true, avgSpeedKmh: true, distanceMultiplier: true, ivmsStopRadiusM: true, ivmsTrailDays: true },
    }),
    // Whether there is a tracker, never which one.
    prisma.truck.count({ where: { id: truckId, tenantId, ivmsImei: { not: null } } }),
  ]);
  const tz = cfg?.timezone || DEFAULT_TZ;
  const mode: IvmsMode = readIvmsEnv().disabled ? 'OFF' : ivmsModeOf(cfg);
  const today = todayIso(tz, now);
  const day = date ?? today;
  const dayStart = zonedDayStart(day, tz);
  const deliveryDate = dateOnly(day);
  const times = ivmsModeAtLeast(mode, 'TIMES');

  // The loads of the truck on the plans in use of the date (every depot), with their stops and drivers.
  const runs = await liveRunsInRange(prisma, tenantId, day, day);
  const loadRows = runs.length
    ? await prisma.planLoad.findMany({
        where: { tenantId, truckId, runId: { in: runs.map((r) => r.id) } },
        orderBy: [{ departMin: 'asc' }, { loadNo: 'asc' }],
        select: { id: true, runId: true, loadNo: true, status: true, departMin: true, returnMin: true, driverId: true, statusChangedAt: true, breakJson: true, carriedFromLoadId: true, truckSnapshotJson: true },
      })
    : [];
  const depotOfRun = new Map(runs.map((r) => [r.id, r.depotId]));
  const driverIds = [...new Set(loadRows.map((l) => l.driverId).filter((x): x is string => !!x))];
  const depotIds = [...new Set([truck.depotId, ...loadRows.map((l) => depotOfRun.get(l.runId) ?? truck.depotId)])];
  const [stops, pressed, drivers, depots, visits, events, alerts, truckDay, dateRuns] = await Promise.all([
    stopsOfLoads(prisma, loadRows.map((l) => ({ id: l.id, breakJson: l.breakJson }))),
    dispatchedAt(prisma, tenantId, loadRows.map((l) => ({ id: l.id, carriedFromLoadId: l.carriedFromLoadId ?? null }))),
    driverIds.length ? prisma.driver.findMany({ where: { tenantId, id: { in: driverIds } }, select: { id: true, name: true, casual: true } }) : Promise.resolve([]),
    prisma.depot.findMany({ where: { tenantId, id: { in: depotIds } }, select: { id: true, code: true, name: true, lat: true, lng: true } }),
    prisma.stopVisit.findMany({
      where: { tenantId, truckId, deliveryDate },
      select: {
        id: true,
        depotId: true,
        loadNo: true,
        sequence: true,
        arrivedAt: true,
        arrivalSource: true,
        arrivalDistanceM: true,
        arrivalAccuracyM: true,
        arrivalObserved: true,
        departedAt: true,
        departureSource: true,
        departedAtOutcome: true,
        outcome: true,
        outcomeAt: true,
        outcomeSource: true,
        reason: true,
        reasonNote: true,
        casesPlanned: true,
        casesDelivered: true,
        photoCount: true,
        outcomeLate: true,
        // Owner request 19 Oct 2026: the minutes the GPS showed the truck away (a leave-and-return), "away N min".
        awayMinutes: true,
      },
    }),
    // The driver's and the office's load-level taps; the GPS arrivals and departures in TIMES only.
    prisma.stopEvent.findMany({
      where: {
        tenantId,
        truckId,
        deliveryDate,
        OR: [{ kind: { in: ['BACK_AT_DEPOT', 'DEPOT_DEPART'] } }, ...(times ? [{ source: 'AYUN' as const, kind: { in: ['ARRIVED' as const, 'DEPARTED' as const] } }] : [])],
      },
      orderBy: { at: 'asc' },
      take: TRUCK_DAY_EVENTS_MAX,
      select: { depotId: true, loadNo: true, sequence: true, kind: true, source: true, at: true, receivedAt: true, payloadJson: true },
    }),
    prisma.opsAlert.findMany({
      where: { tenantId, truckId, deliveryDate },
      include: ALERT_ROW_USERS,
      orderBy: { occurredAt: 'asc' },
      take: TRUCK_DAY_ALERTS_MAX,
    }),
    mode === 'OFF' ? Promise.resolve(null) : prisma.ivmsTruckDay.findFirst({ where: { tenantId, truckId, deliveryDate }, select: { suppressedAt: true, suppressReason: true, gpsFactsJson: true, trailFrom: true } }),
    liveRunsInRange(prisma, tenantId, addDaysIso(today, -TRUCK_DAY_DATES_BACK), addDaysIso(today, TRUCK_DAY_DATES_AHEAD)),
  ]);

  // The date picker: the dates with a load of this truck on the plans in use.
  const dateOfRun = new Map(dateRuns.map((r) => [r.id, r.date]));
  const withLoads = dateRuns.length
    ? await prisma.planLoad.findMany({ where: { tenantId, truckId, runId: { in: dateRuns.map((r) => r.id) } }, select: { runId: true } })
    : [];
  const dates = [...new Set(withLoads.map((l) => dateOfRun.get(l.runId)).filter((x): x is string => !!x))];

  const eventRows: TruckDayEventInput[] = events.map((e) => ({
    depotId: e.depotId,
    loadNo: e.loadNo,
    sequence: e.sequence,
    kind: e.kind,
    source: e.source,
    at: e.at,
    receivedAt: e.receivedAt,
    payload: e.payloadJson && typeof e.payloadJson === 'object' && !Array.isArray(e.payloadJson) ? (e.payloadJson as Record<string, unknown>) : null,
  }));
  const loadStatuses = loadRows.map((l) => ({ status: l.status as string, statusChangedAt: l.statusChangedAt ?? null }));
  const window = trailWindow(dayStart, lastActivityOf(visits, eventRows, loadStatuses));
  const suppressed = !!truckDay?.suppressedAt;
  // A trail stored for the day stays its history when the tracker was taken off the truck since.
  const gps = times && !suppressed;
  const since = truckDay?.trailFrom && truckDay.trailFrom > window.from ? truckDay.trailFrom : window.from;
  const anyOut = loadRows.some((l) => OUT.has(l.status));
  const liveDay = anyOut && (day === today || day === addDaysIso(today, -1));
  const visitIds = visits.map((v) => v.id);
  const [moves, trail, position, photos] = await Promise.all([
    gps
      ? prisma.ivmsEvent.findMany({
          where: { tenantId, truckId, kind: { in: ['DEPOT_IN', 'DEPOT_OUT'] }, eventAt: { gte: window.from, lte: window.to } },
          orderBy: { eventAt: 'asc' },
          take: TRUCK_DAY_MOVES_MAX,
          select: { kind: true, origin: true, eventAt: true, depotId: true, outcome: true },
        })
      : Promise.resolve([]),
    gps && since <= window.to && trailKept(day, today, cfg?.ivmsTrailDays ?? IVMS_SETTING_DEFAULTS.ivmsTrailDays)
      ? prisma.truckTrailPoint.findMany({
          where: { tenantId, truckId, fixAt: { gte: since, lte: window.to } },
          orderBy: { fixAt: 'asc' },
          take: TRAIL_READ_MAX,
          select: { fixAt: true, lat: true, lng: true, speedKmh: true },
        })
      : Promise.resolve([]),
    ivmsModeAtLeast(mode, 'MAP') && liveDay && tracked > 0
      ? prisma.truckPosition.findFirst({ where: { tenantId, truckId }, select: { truckId: true, fixAt: true, lat: true, lng: true, speedKmh: true, heading: true, flags: true, movedAt: true } })
      : Promise.resolve(null),
    // The phone's own photos (not old gallery ones): a first sign at a stop for which Leaving tap counts
    // (rule R2's firstSignOf), read only when there is a Leaving tap to place.
    visitIds.length && eventRows.some((e) => e.kind === 'DEPOT_DEPART')
      ? prisma.deliveryPhoto.findMany({
          where: { tenantId, visitId: { in: visitIds }, source: { in: ['PHONE_AUTO', 'PHONE_MANUAL'] }, oldPhoto: false },
          orderBy: { takenAt: 'asc' },
          take: TRUCK_DAY_EVENTS_MAX,
          select: { visitId: true, takenAt: true },
        })
      : Promise.resolve([]),
  ]);
  const photosOf = new Map<string, Date[]>();
  for (const p of photos) photosOf.set(p.visitId, [...(photosOf.get(p.visitId) ?? []), p.takenAt]);

  const driverOf = new Map(drivers.map((d) => [d.id, d]));
  const snapshotCode = readTruckSnapshot(loadRows[0]?.truckSnapshotJson ?? null)?.code ?? null;
  return buildTruckDay({
    now,
    tz,
    date: day,
    mode,
    trailDays: cfg?.ivmsTrailDays ?? IVMS_SETTING_DEFAULTS.ivmsTrailDays,
    truck: {
      id: truck.id,
      code: shownTruckCode(snapshotCode, truck),
      description: truck.description ?? null,
      hired: !!truck.hired,
      oneDay: !!truck.onlyOnDate,
      depotId: truck.depotId,
      hasTracker: tracked > 0,
    },
    depots,
    loads: loadRows.map((l) => {
      const d = l.driverId ? driverOf.get(l.driverId) : undefined;
      return {
        id: l.id,
        runId: l.runId,
        depotId: depotOfRun.get(l.runId) ?? truck.depotId,
        loadNo: l.loadNo,
        status: l.status,
        departMin: l.departMin,
        returnMin: l.returnMin,
        driverName: d?.name ?? null,
        driverCasual: !!d?.casual,
        dispatchedAt: pressed.get(l.id) ?? null,
        statusChangedAt: l.statusChangedAt ?? null,
        stops: (stops.get(l.id) ?? []).map((s) => ({
          sequence: s.sequence,
          customerCode: s.customerCode,
          customerName: s.customerName,
          etaMin: s.etaMin,
          plannedServiceMin: s.plannedServiceMin,
          windowStartMin: s.windowStartMin,
          windowEndMin: s.windowEndMin,
          pin: s.pin,
          casesPlanned: s.casesPlanned,
        })),
      };
    }),
    visits: visits.map(({ id: visitId, ...v }) => ({ ...v, outcome: v.outcome ?? null, reason: v.reason ?? null, phonePhotoTimes: photosOf.get(visitId) ?? [] })),
    events: eventRows,
    moves: moves.map((m) => ({ kind: m.kind, origin: m.origin, at: m.eventAt, depotId: m.depotId ?? null, outcome: m.outcome ?? null })),
    trail,
    truckDay: truckDay ? { suppressedAt: truckDay.suppressedAt ?? null, suppressReason: truckDay.suppressReason ?? null, gpsFactsJson: truckDay.gpsFactsJson ?? null } : null,
    position: position ? { ...position, flags: position.flags ?? [] } : null,
    alerts: alerts.map(toOpsAlertRow),
    dates,
    cfg: {
      avgSpeedKmh: cfg?.avgSpeedKmh ?? 40,
      distanceMultiplier: cfg?.distanceMultiplier ?? 1.3,
      stopRadiusM: cfg?.ivmsStopRadiusM ?? IVMS_SETTING_DEFAULTS.ivmsStopRadiusM,
    },
  });
}
