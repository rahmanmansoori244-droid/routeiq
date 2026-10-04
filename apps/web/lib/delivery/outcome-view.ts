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
 * read from the driver's own results, so a stop the office corrected stays listed.
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
  loadIsBack,
  loadsOfRuns,
  outcomeSettings,
  photoWaitOverOf,
  stopsOfLoads,
  truckDaysWithLinkOrVisit,
  visitKey,
  visitsInRange,
  type NoResultStop,
} from './day-results';
import { actualMinutes, arrivalNote, departureNote, noPhotoText, OUTCOME_LABEL, reasonText, sourceWord } from './office-text';
import { copyConflicts } from './carry-conflicts';
import { readVisitLines, type VisitLine } from './visit';
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
  /** Actual unloading minutes, and how they were measured. */
  actualMin: number | null;
  actualLabel: string | null;
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
          select: { id: true, visitId: true, takenAt: true, distanceM: true, positionStatus: true, oldPhoto: true, purgedAt: true },
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
        departureNote: departureNote(v.departedAtOutcome, departureGap),
        actualMin: actual.min,
        actualLabel: actual.label,
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
  return empty;
}

/** The Loads table chip: "Delivered 7/12". */
export function loadProgressText(o: Pick<OverlayLoad, 'done' | 'total' | 'delivered'>): string {
  return `Delivered ${o.delivered}/${o.total}`;
}
