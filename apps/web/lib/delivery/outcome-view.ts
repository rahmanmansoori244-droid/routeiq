/**
 * The results on the plan screen (owner request 4 Oct 2026, spec section 10.1, GET
 * /api/runs/<id>/outcomes). Server only; the shape is browser-safe (types below).
 *
 * For one plan version's loads that left (DISPATCHED / COMPLETED): per load the progress ("Delivered
 * 7/12", not delivered, no result, Back at depot) and per stop the result, who recorded it, the
 * arrival and departure with how they were recorded, the unloading minutes (actual vs planned), the
 * photos (metadata only: the bytes come from GET /api/delivery-photos/<id>), the planned lines (the
 * Record outcome dialog prefills from them) and the notes ("recorded after the trip closed", "no
 * photo: camera failed (driver)", "unverified timing", "changed after it was brought forward").
 * Visits are matched by (truck, load number, stop), so a superseded version shows the same physical
 * results. Plus, for any load of the version, the brought-forward copies whose original result changed
 * after the carry (the red chip and the Lock question). And (owner decision 2, 5 Oct 2026) every
 * result saved without a photo ("Camera not working", or a named photo that never arrived: stop,
 * customer, driver, time, what changed after), with the driver links with 3 or more that day. They are
 * read from the driver's own results, so a stop the office corrected stays listed. And (owner decision of
 * 16 Oct 2026, alert rule R2) the turnaround at the depot before each trip after the truck's first: Back
 * at depot of the trip before to the driver's Leaving for next load (or the Dispatch press / the first
 * stop reached less the planned drive when he did not tap; lib/delivery/turnaround.ts), live while the
 * truck is still at the depot; only while the company has the alerts and rule R2 on.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { isoOf, localDateIso, localMinutes } from '../dispatch/time';
import { readDevices } from '../driver-link/service';
import { deliveryKpis, inOutcomeScope, type DeliveryKpis } from './kpis';
import { cameraExceptionOf, cameraLinkAlerts, noPhotoKind, sortCameraExceptions, truckDayKey, type CameraException, type CameraLinkAlert } from './camera-exceptions';
import {
  backAtDepot,
  backKey,
  cameraCountsByTruckDay,
  keyOfVisit,
  kpiVisitOf,
  leftDepotTaps,
  liveRunsInRange,
  loadOrigins,
  loadIsBack,
  loadsOfRuns,
  outcomeSettings,
  photoWaitOverOf,
  stopsOfLoads,
  truckDaysWithLinkOrVisit,
  visitKey,
  visitsInRange,
  type NoResultStop,
  type RoadLoad,
} from './day-results';
import { firstSignOf, plannedDriveOf, previousTrip, turnaroundLine, turnaroundOf, type LeftHow, type NotMeasured, type SignVisit } from './turnaround';
import { clockText } from '../alerts/text';
import { actualMinutes, arrivalNote, departureNote, noPhotoText, OUTCOME_LABEL, reasonText, sourceWord } from './office-text';
import { copyConflicts } from './carry-conflicts';
import { readVisitLines, withoutGpsTimes, type VisitLine, type VisitTimes } from './visit';
import type { KpiVisit } from './kpis';

type Db = Prisma.TransactionClient | typeof prisma;

export interface OverlayPhoto {
  id: string;
  takenAt: string;
  distanceM: number | null;
  positionStatus: string;
  oldPhoto: boolean;
  purged: boolean;
}

export interface OverlayStop {
  state: 'PENDING' | 'ARRIVED' | 'DONE';
  outcome: string | null;
  reason: string | null;
  /** "Shop closed", "Other - gate locked". */
  reasonText: string | null;
  note: string | null;
  /** "driver" / "dispatcher". */
  source: string | null;
  /** The office user who recorded it (null for the driver link). */
  by: string | null;
  outcomeAt: string | null;
  arrivedAt: string | null;
  arrivalSource: string | null;
  arrivalObserved: boolean;
  /** "manual", "set by office", "arrival not observed (page opened at the shop)". */
  arrivalNote: string | null;
  departedAt: string | null;
  departureGap: boolean;
  departedAtOutcome: boolean;
  /** "result time", "not observed". */
  departureNote: string | null;
  /** Actual unloading minutes (on site: the minutes away taken off), and how they were measured. */
  actualMin: number | null;
  actualLabel: string | null;
  /**
   * Minutes the GPS showed the truck away from the customer between the arrival and the departure (owner
   * request 19 Oct 2026, StopVisit.awayMinutes: a leave-and-return), shown as "away N min"; null: none.
   */
  awayMin: number | null;
  /** Planned unloading (departure - service start). */
  plannedMin: number | null;
  /** The minutes come from observed automatic timing (they feed measured times). */
  autoTimed: boolean;
  timingSuspect: boolean;
  casesPlanned: number;
  casesDelivered: number | null;
  lines: VisitLine[];
  photos: OverlayPhoto[];
  /** Photos the result named that have not arrived yet. */
  photoMissing: number;
  noPhotoReason: string | null;
  /** "no photo: camera failed (driver)" / "... , corrected by office" / "no photo (office)". */
  noPhotoText: string | null;
  late: boolean;
  /** The copy's date when an order of the stop was brought forward. */
  carriedTo: string | null;
  /** "Driver says Delivered after it was brought forward" (a refused change), else null. */
  carryConflict: string | null;
  /** An automatic arrival far from the pin, stored as manual. */
  downgradedArrival: boolean;
  /** The visit exists (it has events). */
  visitId: string | null;
}

export interface OverlayLoad {
  done: number;
  total: number;
  delivered: number;
  notDelivered: number;
  partly: number;
  noResult: number;
  backAtDepotAt: string | null;
  driverLink: { lastSeenAt: string | null; devices: number } | null;
  /** Results of this truck's day (its driver link, every depot) saved without a photo ("Camera not working" or the photo never arrived): 3 or more is highlighted. */
  cameraFailedToday: number;
}

/**
 * The turnaround at the depot before a trip (owner decision of 16 Oct 2026, alert rule R2): from Back at
 * depot of the trip before (`afterLoadNo`, same depot) to the truck leaving with this one. Only when Back
 * at depot was tapped; never for the truck's first trip of the day.
 */
export interface LoadTurnaround {
  afterLoadNo: number;
  backAt: string;
  /** null: the truck is still at the depot (`minutes` so far). */
  leftAt: string | null;
  /** TAP: the driver's Leaving for next load; DISPATCH / ARRIVAL: a fallback (no tap, or a tap after the first arrival). */
  how: LeftHow | null;
  tapLate: boolean;
  minutes: number;
  final: boolean;
  /** BACK_LATE: Back at depot of the trip before was tapped after this trip had started; NO_LEAVE: no leave recorded (Completed). */
  notMeasured: NotMeasured | null;
  /** "back 11:20, left 12:08, 48 min" / "back 11:20, not left yet, 25 min so far" / "back 11:20, no leave recorded" (company time). */
  line: string;
}

export interface OutcomeOverlay {
  runId: string;
  date: string;
  depotId: string;
  tz: string;
  /** Per load id (DISPATCHED / COMPLETED loads of this version). */
  loads: Record<string, OverlayLoad>;
  /** Per `${loadId}:${sequence}`. */
  stops: Record<string, OverlayStop>;
  summary: DeliveryKpis;
  /** Stops of loads that are back with no result (counted as delivered). */
  noOutcome: NoResultStop[];
  /** Per `${loadId}:${sequence}` of ANY load of this version: a brought-forward copy whose original result changed after the carry. */
  copyConflicts: Record<string, string>;
  /** Per load id: the Lock question's lines (the same copies). */
  lockWarnings: Record<string, string[]>;
  /** Owner decision 2 (5 Oct 2026): this version's results saved without a photo ("Camera not working", or the photo never arrived). */
  cameraExceptions: CameraException[];
  /** The driver links (truck-days) that used it 3 times or more that day. */
  cameraAlerts: CameraLinkAlert[];
  /** Per load id of ANY status of this version: the turnaround at the depot before it (rule R2), when known. */
  turnarounds: Record<string, LoadTurnaround>;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Actual unloading of a visit (spec section 10.1): shared with the actuals Excel (office-text.ts). */
export { actualMinutes } from './office-text';

export async function readOutcomeOverlay(tenantId: string, runId: string, opts: { now?: Date; db?: Db } = {}): Promise<OutcomeOverlay | null> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const run = await db.runPlan.findFirst({ where: { id: runId, tenantId }, select: { id: true, depotId: true, runDate: true } });
  if (!run) return null;
  const date = isoOf(run.runDate);
  const set = await outcomeSettings(db, tenantId);
  const empty: OutcomeOverlay = {
    runId,
    date,
    depotId: run.depotId,
    tz: set.tz,
    loads: {},
    stops: {},
    summary: deliveryKpis([]),
    noOutcome: [],
    copyConflicts: {},
    lockWarnings: {},
    cameraExceptions: [],
    cameraAlerts: [],
    turnarounds: {},
  };

  // Brought-forward copies on any load of this version (the chip and the Lock question).
  const allRows = await db.routeAssignment.findMany({ where: { runId }, select: { loadId: true, sequenceInTruck: true, orderId: true } });
  const conflicts = await copyConflicts(db, tenantId, [...new Set(allRows.map((r) => r.orderId))]);
  for (const r of allRows) {
    const c = conflicts.get(r.orderId);
    if (!c || !r.loadId) continue;
    empty.copyConflicts[`${r.loadId}:${r.sequenceInTruck}`] = c.chip;
    const w = (empty.lockWarnings[r.loadId] ??= []);
    if (!w.includes(c.lockText)) w.push(c.lockText);
  }

  const loads = await loadsOfRuns(db, tenantId, [{ id: run.id, depotId: run.depotId, date }]);
  if (!loads.length) return empty;
  const [stopsBy, visits, backs] = await Promise.all([
    stopsOfLoads(db, loads),
    visitsInRange(db, tenantId, date, date, run.depotId),
    backAtDepot(db, tenantId, date, date, run.depotId),
  ]);
  const byKey = new Map(visits.map((v) => [keyOfVisit(v), v]));
  const visitIds = visits.map((v) => v.id);
  // "Photo not received": a named photo that can no longer arrive (the link's state, the load's).
  const waitOver = await photoWaitOverOf(db, tenantId, date, date, visits, { now, loads });
  const noPhoto = (v: (typeof visits)[number]) => noPhotoKind(v, waitOver.has(v.id));
  const [photos, flagged, users, links, scoped, cameraCounts] = await Promise.all([
    visitIds.length
      ? db.deliveryPhoto.findMany({
          where: { tenantId, visitId: { in: visitIds } },
          select: { id: true, visitId: true, source: true, takenAt: true, distanceM: true, positionStatus: true, oldPhoto: true, purgedAt: true },
          orderBy: [{ takenAt: 'asc' }],
        })
      : [],
    visitIds.length
      ? db.stopEvent.findMany({ where: { tenantId, visitId: { in: visitIds }, kind: { in: ['CARRY_CONFLICT', 'ARRIVED', 'DEPARTED'] } }, select: { visitId: true, kind: true, at: true, source: true, payloadJson: true } })
      : [],
    (async () => {
      const ids = [...new Set(visits.map((v) => v.outcomeById).filter((x): x is string => !!x))];
      return ids.length ? db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    })(),
    db.driverLink.findMany({ where: { tenantId, deliveryDate: run.runDate, truckId: { in: [...new Set(loads.map((l) => l.truckId))] } }, select: { truckId: true, lastSeenAt: true, devicesJson: true } }),
    truckDaysWithLinkOrVisit(db, tenantId, date, date, visits),
    visits.some(noPhoto) ? cameraCountsByTruckDay(db, tenantId, date, date, { now }) : new Map<string, number>(),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  // The copies of this day's orders (carriedTo per stop).
  const orderIds = [...new Set([...stopsBy.values()].flat().flatMap((s) => s.orderIds))];
  const carried = orderIds.length
    ? await db.order.findMany({ where: { tenantId, id: { in: orderIds }, carriedToOrderId: { not: null } }, select: { id: true, carriedTo: { select: { deliveryDate: true } } } })
    : [];
  const carriedTo = new Map(carried.map((c) => [c.id, c.carriedTo ? isoOf(c.carriedTo.deliveryDate) : null]));

  const today = localDateIso(now, set.tz);
  const nowMin = localMinutes(now, set.tz);
  const kpiStops: (KpiVisit | null)[] = [];
  for (const l of loads) {
    const stops = stopsBy.get(l.id) ?? [];
    const back = backs.get(backKey(l)) ?? null;
    const link = links.find((x) => x.truckId === l.truckId);
    const ov: OverlayLoad = {
      done: 0,
      total: stops.length,
      delivered: 0,
      notDelivered: 0,
      partly: 0,
      noResult: 0,
      backAtDepotAt: iso(back),
      driverLink: link ? { lastSeenAt: iso(link.lastSeenAt), devices: readDevices(link.devicesJson).length } : null,
      cameraFailedToday: cameraCounts.get(truckDayKey(l.date, l.truckId)) ?? 0,
    };
    const inScope = inOutcomeScope(l.date, set.sinceLocal, scoped.has(`${l.date}|${l.truckId}`));
    const isBack = loadIsBack(l, today, nowMin, !!back);
    for (const s of stops) {
      const v = byKey.get(visitKey({ depotId: l.depotId, date: l.date, truckId: l.truckId, loadNo: l.loadNo, sequence: s.sequence })) ?? null;
      if (inScope) kpiStops.push(v ? kpiVisitOf(v, set.tz, waitOver.has(v.id)) : null);
      const copies = s.orderIds.map((id) => carriedTo.get(id)).filter((x): x is string => !!x).sort();
      const key = `${l.id}:${s.sequence}`;
      if (!v) {
        ov.noResult++;
        if (isBack && inScope) {
          empty.noOutcome.push({ date: l.date, depotId: l.depotId, truckId: l.truckId, truckCode: l.truckCode, loadId: l.id, loadNo: l.loadNo, sequence: s.sequence, customerCode: s.customerCode, branchCode: s.branchCode, customerName: s.customerName, cases: s.casesPlanned, lines: s.lines });
        }
        empty.stops[key] = {
          state: 'PENDING',
          outcome: null,
          reason: null,
          reasonText: null,
          note: null,
          source: null,
          by: null,
          outcomeAt: null,
          arrivedAt: null,
          arrivalSource: null,
          arrivalObserved: true,
          arrivalNote: null,
          departedAt: null,
          departureGap: false,
          departedAtOutcome: false,
          departureNote: null,
          actualMin: null,
          actualLabel: null,
          awayMin: null,
          plannedMin: s.plannedServiceMin,
          autoTimed: false,
          timingSuspect: false,
          casesPlanned: s.casesPlanned,
          casesDelivered: null,
          lines: s.lines,
          photos: [],
          photoMissing: 0,
          noPhotoReason: null,
          noPhotoText: null,
          late: false,
          carriedTo: copies.at(-1) ?? null,
          carryConflict: null,
          downgradedArrival: false,
          visitId: null,
        };
        continue;
      }
      if (v.outcome) {
        ov.done++;
        if (v.outcome === 'DELIVERED') ov.delivered++;
        else if (v.outcome === 'PARTLY_DELIVERED') ov.partly++;
        else ov.notDelivered++;
      } else {
        ov.noResult++;
        if (isBack && inScope) {
          empty.noOutcome.push({ date: l.date, depotId: l.depotId, truckId: l.truckId, truckCode: l.truckCode, loadId: l.id, loadNo: l.loadNo, sequence: s.sequence, customerCode: s.customerCode, branchCode: s.branchCode, customerName: s.customerName, cases: s.casesPlanned, lines: s.lines });
        }
      }
      const kind = noPhoto(v);
      if (kind) empty.cameraExceptions.push(cameraExceptionOf(l, s, v, kind, set.tz));
      const vPhotos = photos.filter((p) => p.visitId === v.id);
      const events = flagged.filter((e) => e.visitId === v.id);
      const conflict = events.filter((e) => e.kind === 'CARRY_CONFLICT').sort((a, b) => a.at.getTime() - b.at.getTime()).at(-1);
      const refused = (conflict?.payloadJson as { refused?: { outcome?: unknown } } | null)?.refused?.outcome;
      const conflictText = conflict
        ? `${conflict.source === 'DISPATCHER' ? 'Office' : 'Driver'} says ${refused ? (OUTCOME_LABEL[String(refused)] ?? String(refused)) : 'no result'} after it was brought forward`
        : null;
      const keys = Array.isArray(v.photoKeysJson) ? (v.photoKeysJson as unknown[]).length : 0;
      const actual = actualMinutes(v);
      // A departure found only after the page was away (dated at the last inside fix): not observed.
      const departureGap =
        !!v.departedAt &&
        !v.departedAtOutcome &&
        events.some((e) => e.kind === 'DEPARTED' && e.at.getTime() === v.departedAt!.getTime() && (e.payloadJson as { gap?: unknown } | null)?.gap === true);
      empty.stops[key] = {
        state: v.outcome ? 'DONE' : v.arrivedAt && !v.departedAt ? 'ARRIVED' : 'PENDING',
        outcome: v.outcome,
        reason: v.reason,
        reasonText: v.outcome && v.outcome !== 'DELIVERED' ? reasonText(v.reason, v.reasonNote) : null,
        note: v.reasonNote,
        source: v.outcome ? sourceWord(v.outcomeSource) : null,
        by: v.outcomeById ? (userName.get(v.outcomeById) ?? null) : null,
        outcomeAt: iso(v.outcomeAt),
        arrivedAt: iso(v.arrivedAt),
        arrivalSource: v.arrivalSource,
        arrivalObserved: v.arrivalObserved,
        arrivalNote: arrivalNote(v.arrivalSource, v.arrivalObserved),
        departedAt: iso(v.departedAt),
        departureGap,
        departedAtOutcome: v.departedAtOutcome,
        departureNote: departureNote(v.departedAtOutcome, departureGap, v.departureSource),
        actualMin: actual.min,
        actualLabel: actual.label,
        awayMin: v.awayMinutes ?? null,
        plannedMin: v.plannedServiceMin ?? s.plannedServiceMin,
        autoTimed: actual.auto,
        timingSuspect: v.timingSuspect,
        casesPlanned: v.casesPlanned,
        casesDelivered: v.casesDelivered,
        lines: s.lines.map((pl) => ({ ...pl, deliveredCases: v.outcome ? (readVisitLines(v.linesJson).find((x) => x.lineId === pl.lineId)?.deliveredCases ?? null) : null })),
        photos: vPhotos.map((p) => ({ id: p.id, takenAt: p.takenAt.toISOString(), distanceM: p.distanceM, positionStatus: p.positionStatus, oldPhoto: p.oldPhoto, purged: !!p.purgedAt })),
        photoMissing: Math.max(0, keys - vPhotos.length),
        noPhotoReason: v.noPhotoReason,
        noPhotoText: noPhotoText({ outcome: v.outcome, noPhotoReason: v.noPhotoReason, outcomeSource: v.outcomeSource, photoCount: vPhotos.length, driverNoPhotoReason: v.driverNoPhotoReason }),
        late: v.outcomeLate,
        carriedTo: copies.at(-1) ?? null,
        carryConflict: conflictText,
        downgradedArrival: events.some((e) => e.kind === 'ARRIVED' && (e.payloadJson as { downgraded?: unknown } | null)?.downgraded === true),
        visitId: v.id,
      };
    }
    empty.loads[l.id] = ov;
  }
  empty.summary = deliveryKpis(kpiStops);
  empty.cameraExceptions = sortCameraExceptions(empty.cameraExceptions);
  empty.cameraAlerts = cameraLinkAlerts(empty.cameraExceptions, cameraCounts);
  // A Back at depot is needed for any turnaround: none tapped at this depot that day, nothing more to read.
  // A failure here never takes the delivery results down with it (second review of 16 Oct 2026, M3).
  if (backs.size) {
    try {
      empty.turnarounds = await turnaroundsOf(db, tenantId, { id: run.id, depotId: run.depotId, date }, { backs, visits, photos, stopsBy, tz: set.tz, now, today });
    } catch (e) {
      console.error('[delivery] turnaround line not read', (e as Error)?.message ?? e);
      empty.turnarounds = {};
    }
  }
  return empty;
}

const ALL_STATUSES = ['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'] as const;

/** A visit as turnaroundsOf reads it (its times without the GPS ones: withoutGpsTimes). */
type TurnaroundVisit = { id: string; depotId: string; deliveryDate: Date; truckId: string; loadNo: number } & SignVisit & VisitTimes;

/**
 * The turnaround before each load of the version (every status: a trip still Locked or Loading shows the
 * time so far), read with rule R2's own inputs (lib/delivery/turnaround.ts): the driver's latest Leaving
 * tap before the truck reached a stop (none on a Planned load), the Dispatch press whatever the status now
 * and when the trip was planned (loadOrigins), the first sign at a stop (arrival, departure, the phone's
 * result or photo) and the planned drive to the first stop. The trip before is the truck-day's load before
 * it in departure order, the other depots' plans in use included (a trip after one at another depot is
 * not measured, as rule R2 does not). Shown only while the company has the alerts on with rule R2 on: the
 * driver's Leaving button is offered then only (lib/driver-link/manifest.ts), so merging changes nothing
 * on the screens until the owner turns them on (second review of 16 Oct 2026, M1 and M3). A day that is
 * over shows "no leave recorded" for a trip that never left, as does a wait over TURNAROUND_MAX_MIN.
 * The first sign leaves out the GPS times of the IVMS live link, as rule R2 does (lib/alerts/facts.ts;
 * merge review of 17 Oct 2026): the driver page offers Leaving for next load until the driver's own
 * arrival, so his tap after a GPS-only arrival still counts.
 */
async function turnaroundsOf(
  db: Db,
  tenantId: string,
  run: { id: string; depotId: string; date: string },
  known: {
    backs: ReadonlyMap<string, Date>;
    visits: readonly TurnaroundVisit[];
    photos: readonly { visitId: string; source: string; takenAt: Date; oldPhoto: boolean }[];
    stopsBy: ReadonlyMap<string, readonly { sequence: number; etaMin: number | null }[]>;
    tz: string;
    now: Date;
    today: string;
  },
): Promise<Record<string, LoadTurnaround>> {
  const out: Record<string, LoadTurnaround> = {};
  const cfg = await db.tenantConfig.findFirst({ where: { tenantId }, select: { alertsEnabled: true, alertLoadingOverMin: true } });
  if (!cfg?.alertsEnabled || cfg.alertLoadingOverMin === null || cfg.alertLoadingOverMin === undefined) return out;
  const mine = await loadsOfRuns(db, tenantId, [run], { statuses: ALL_STATUSES });
  if (mine.length < 2) return out;
  const trucks = new Set(mine.map((l) => l.truckId));
  const others = (await liveRunsInRange(db, tenantId, run.date, run.date)).filter((r) => r.depotId !== run.depotId);
  const elsewhere = others.length ? (await loadsOfRuns(db, tenantId, others, { statuses: ALL_STATUSES })).filter((l) => trucks.has(l.truckId)) : [];
  const dayOf = (l: RoadLoad) => [...mine, ...elsewhere].filter((x) => x.truckId === l.truckId);
  const pairs = mine
    .map((l) => ({ l, prev: previousTrip(dayOf(l), l.id) }))
    .filter((p): p is { l: RoadLoad; prev: RoadLoad } => !!p.prev && p.prev.depotId === p.l.depotId && known.backs.has(backKey(p.prev)));
  if (!pairs.length) return out;
  const [lefts, origins] = await Promise.all([leftDepotTaps(db, tenantId, run.date, run.date, run.depotId), loadOrigins(db, tenantId, pairs.map((p) => p.l.id))]);
  const visitsOf = new Map<string, TurnaroundVisit[]>();
  for (const v of known.visits) {
    const k = backKey({ depotId: v.depotId, date: isoOf(v.deliveryDate), truckId: v.truckId, loadNo: v.loadNo });
    visitsOf.set(k, [...(visitsOf.get(k) ?? []), v]);
  }
  const phoneTimes = new Map<string, Date[]>();
  for (const p of known.photos) {
    if ((p.source !== 'PHONE_AUTO' && p.source !== 'PHONE_MANUAL') || p.oldPhoto) continue;
    phoneTimes.set(p.visitId, [...(phoneTimes.get(p.visitId) ?? []), p.takenAt]);
  }
  const clock = (d: Date) => clockText(d, run.date, known.tz);
  const dayOver = run.date < known.today;
  for (const { l, prev } of pairs) {
    const vs = visitsOf.get(backKey(l)) ?? [];
    const o = origins.get(l.id);
    const t = turnaroundOf({
      backAt: known.backs.get(backKey(prev)) ?? null,
      leftTaps: l.status === 'PLANNED' ? [] : (lefts.get(backKey(l)) ?? []),
      dispatchAt: o?.dispatchedAt ?? (l.status === 'DISPATCHED' ? l.statusChangedAt : null),
      firstSignAt: firstSignOf(vs.map(withoutGpsTimes), vs.flatMap((v) => phoneTimes.get(v.id) ?? [])),
      plannedDriveMin: plannedDriveOf(l.departMin, known.stopsBy.get(l.id) ?? []),
      existedAt: o?.firstAt ?? null,
      completed: l.status === 'COMPLETED',
      now: known.now,
    });
    if (!t) continue;
    out[l.id] = {
      afterLoadNo: prev.loadNo,
      backAt: t.backAt.toISOString(),
      leftAt: t.leftAt ? t.leftAt.toISOString() : null,
      how: t.how,
      tapLate: t.tapLate,
      minutes: Math.round(t.minutes),
      final: t.final,
      notMeasured: t.notMeasured,
      line: turnaroundLine(t, clock, { dayOver }),
    };
  }
  return out;
}

/** The Loads table chip: "Delivered 7/12". */
export function loadProgressText(o: Pick<OverlayLoad, 'done' | 'total' | 'delivered'>): string {
  return `Delivered ${o.delivered}/${o.total}`;
}
