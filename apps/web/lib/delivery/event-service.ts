/**
 * What happens at a stop, written by the driver page (owner request 4 Oct 2026, spec sections 8.1 to
 * 8.7 and 13.3). Server only.
 *
 * Every action (ARRIVE, DEPART, OUTCOME, BACK_AT_DEPOT) runs in ONE short transaction, in this order:
 * the lock timeout, the outcome-day lock, the live load and its planned stop (read under the lock),
 * the idempotency check (`dl:<uuid>`, a duplicate only for the same link), the rules (section 8.3),
 * the caps (40 arrivals, departures and results per stop, 5 Back at depot per load), the StopEvent,
 * the StopVisit rebuilt from all its events (visit.ts), the audit row. A result equal to the stop's
 * current one is answered ok and stores nothing. After the commit a load that is back at the depot
 * with a result on every stop is completed (completeLoadAsDriver).
 *
 * A unique-key error (P2002) aborts the transaction; it is answered from a fresh read OUTSIDE it,
 * never retried inside it (PostgreSQL refuses every statement after the first error).
 *
 * Stop events are the record of automatic arrivals and departures: they are not audited (about 600
 * rows a day of noise). Results, manual arrivals, photos and Back at depot are.
 */
import { Prisma, type DriverLink } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../audit';
import { HttpError } from '../http-error';
import { completeLoadAsDriver } from '../dispatch/plan-service';
import { isLockBusy, PlanBusyError, setLockTimeout } from '../dispatch/plan-locks';
import { distanceM, readLoadOrigin, readTruckSnapshot } from '../dispatch/snapshots';
import { DEFAULT_TZ, dateOnly, isoOf, zonedDayStart } from '../dispatch/time';
import { driverActor } from '../driver-link/actor';
import { truckDayLoads, type TruckDayLoad } from '../driver-link/service';
import type { DriverActionResult, DriverResults, NotDeliveredReasonName, StopResult } from '../driver-link/manifest-types';
import { lockOutcomesDay } from './locks';
import { plannedStopOf, type PlannedStop } from './planned-stop';
import {
  actionTime,
  carryChangeCheck,
  clockSkewMs,
  inCarryBasis,
  normalizeResult,
  photoRule,
  proofPhotoKeys,
  readCarryBasis,
  REFUSAL_TEXT,
  writeRule,
  type RefusalCode,
  type WriteKind,
} from './outcome-rules';
import { deriveVisit, readVisitLines, resultEvent, type EventSource, type VisitEvent } from './visit';

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/** A lowercase UUID: the only idempotency key a phone may send (stored as dl:<uuid> / dlphoto:<uuid>). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STOP_RE = /^(\d{1,3}):(\d{1,4})$/;
export const MAX_ACTIONS = 50;

// ---------------------------------------------------------------------------------------
// The body (POST /api/d/actions)
// ---------------------------------------------------------------------------------------

const isoString = z.string().min(10).max(40);
const posSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracyM: z.number().gte(0).lte(100_000),
  at: isoString,
  gpsAt: isoString.nullish(),
  speedMps: z.number().gte(0).lte(200).nullish(),
});
const key = z.string().regex(UUID_RE);
const stop = z.string().regex(STOP_RE);
const actionSchema = z.discriminatedUnion('type', [
  z.object({
    key,
    type: z.literal('ARRIVE'),
    stop,
    at: isoString,
    mode: z.enum(['AUTO', 'MANUAL']),
    pos: posSchema.optional(),
    chained: z.boolean().optional(),
    from: stop.optional(),
    observed: z.boolean().optional(),
    chosen: z.boolean().optional(),
    when: z.boolean().optional(),
  }),
  z.object({ key, type: z.literal('DEPART'), stop, at: isoString, mode: z.literal('AUTO'), pos: posSchema.optional(), reason: z.enum(['LEFT', 'NEXT_STOP']), gap: z.boolean().optional() }),
  z.object({
    key,
    type: z.literal('OUTCOME'),
    stop,
    at: isoString,
    pos: posSchema.optional(),
    outcome: z.enum(['DELIVERED', 'PARTLY_DELIVERED', 'NOT_DELIVERED']).nullable(),
    reason: z.string().max(40).nullish(),
    note: z.string().max(1000).nullish(),
    lines: z
      .array(z.object({ lineId: z.string().min(1).max(64), delivered: z.number() }))
      .max(300)
      .nullish(),
    photoKeys: z.array(key).max(10),
    noPhotoReason: z.literal('CAMERA_FAILED').nullish(),
  }),
  z.object({ key, type: z.literal('BACK_AT_DEPOT'), load: z.number().int().min(1).max(999), at: isoString, pos: posSchema.optional() }),
]);
export type ParsedAction = z.infer<typeof actionSchema>;
type Pos = z.infer<typeof posSchema>;

export const actionsBodySchema = z.object({ clientNow: isoString, actions: z.array(z.unknown()).max(MAX_ACTIONS) });

// ---------------------------------------------------------------------------------------
// Who writes
// ---------------------------------------------------------------------------------------

export interface DriverWriteContext {
  tenantId: string;
  truckId: string;
  /** YYYY-MM-DD */
  date: string;
  link: Pick<DriverLink, 'id' | 'generation' | 'driverIdAtIssue' | 'expiresAt'>;
  ip: string | null;
  deviceId: string | null;
  /** A signed-in RouteIQ user (PLANNER+) on the driver page: writes as the office. */
  session: { userId: string; name: string; role: string } | null;
  /** The receipt time. */
  now: Date;
}

/** Facts read once per request: the truck-day's live loads, the truck code, the radius and the time zone. */
export interface DayFacts {
  loads: TruckDayLoad[];
  truckCode: string;
  radiusM: number;
  photoRequired: boolean;
  tz: string;
  dayStart: Date;
  nameAtIssue: string | null;
}

export async function dayFacts(ctx: Pick<DriverWriteContext, 'tenantId' | 'truckId' | 'date' | 'link'>, db: Db = prisma): Promise<DayFacts> {
  const [loads, truck, cfg] = await Promise.all([
    truckDayLoads(db, ctx.tenantId, ctx.truckId, ctx.date),
    db.truck.findFirst({ where: { id: ctx.truckId, tenantId: ctx.tenantId }, select: { code: true } }),
    db.tenantConfig.findFirst({ where: { tenantId: ctx.tenantId }, select: { timezone: true, geofenceRadiusM: true, photoProofRequired: true } }),
  ]);
  const tz = cfg?.timezone || DEFAULT_TZ;
  let nameAtIssue: string | null = null;
  if (ctx.link.driverIdAtIssue) {
    nameAtIssue =
      loads.find((l) => l.driverId === ctx.link.driverIdAtIssue)?.driverName ??
      (await db.driver.findFirst({ where: { id: ctx.link.driverIdAtIssue, tenantId: ctx.tenantId }, select: { name: true } }))?.name ??
      null;
  }
  return {
    loads,
    truckCode: truck?.code ?? '',
    radiusM: Math.min(500, Math.max(50, cfg?.geofenceRadiusM ?? 100)),
    photoRequired: cfg?.photoProofRequired ?? true,
    tz,
    dayStart: zonedDayStart(ctx.date, tz),
    nameAtIssue,
  };
}

/**
 * The audit identity of a write (spec section 16.4): the driver link's actor, or the signed-in office
 * user. `ip`: the AuditLog.ip of the row - the office user's, as on every user row; none (false) for
 * the driver link (audit rows are kept for good, while a driver's IP and browser id are erased from
 * the stop events and photos after locationRetentionDays).
 */
export function writerAudit(ctx: DriverWriteContext, facts: DayFacts, load: TruckDayLoad): { userId: string | null; ip: string | null | false; extra: Record<string, unknown> } {
  if (ctx.session) return { userId: ctx.session.userId, ip: ctx.ip, extra: { via: 'driver page' } };
  const actor = driverActor(
    { generation: ctx.link.generation, driverIdAtIssue: ctx.link.driverIdAtIssue, driverNameAtIssue: facts.nameAtIssue },
    { truckCode: facts.truckCode, date: ctx.date, driverId: load.driverId, driverName: load.driverName },
  );
  return { userId: null, ip: false, extra: { actor, linkGeneration: ctx.link.generation } };
}

export function parseStopKey(s: string): { loadNo: number; sequence: number } | null {
  const m = STOP_RE.exec(s);
  return m ? { loadNo: Number(m[1]), sequence: Number(m[2]) } : null;
}

/** The live load of a load number on the truck-day (the first by departure when two depots share it). */
export function liveLoad(facts: DayFacts, loadNo: number): TruckDayLoad | null {
  return facts.loads.find((l) => l.loadNo === loadNo) ?? null;
}

function refused(k: string, code: RefusalCode, transient = false): DriverActionResult {
  return { key: k, status: 'refused', code, ...(transient ? { transient: true } : {}), message: REFUSAL_TEXT[code] };
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError ? e.code === 'P2002' : (e as { code?: unknown } | null)?.code === 'P2002';
}

const posDate = (p: Pos | undefined, skew: number): Date | null => {
  if (!p) return null;
  const d = new Date(p.at);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + skew);
};

// ---------------------------------------------------------------------------------------
// The visit: find, create, rebuild
// ---------------------------------------------------------------------------------------

export interface VisitKey {
  tenantId: string;
  depotId: string;
  date: string;
  truckId: string;
  loadNo: number;
  sequence: number;
}

export async function findVisit(tx: Db, k: VisitKey) {
  return tx.stopVisit.findFirst({ where: { tenantId: k.tenantId, depotId: k.depotId, deliveryDate: dateOnly(k.date), truckId: k.truckId, loadNo: k.loadNo, sequence: k.sequence } });
}

/** The visit of a stop, created with its planned facts at the first write (frozen loads never change). */
export async function ensureVisit(tx: Tx, k: VisitKey, planned: PlannedStop, firstLoadId: string) {
  const found = await findVisit(tx, k);
  if (found) return found;
  return tx.stopVisit.create({
    data: {
      tenantId: k.tenantId,
      depotId: k.depotId,
      deliveryDate: dateOnly(k.date),
      truckId: k.truckId,
      loadNo: k.loadNo,
      sequence: k.sequence,
      customerId: planned.customerId,
      firstLoadId,
      plannedEtaMin: planned.etaMin,
      plannedServiceMin: planned.plannedServiceMin,
      plannedLat: planned.pin?.lat ?? null,
      plannedLng: planned.pin?.lng ?? null,
      windowStartMin: planned.windowStartMin,
      windowEndMin: planned.windowEndMin,
      linesJson: planned.lines as unknown as Prisma.InputJsonValue,
      casesPlanned: planned.casesPlanned,
    },
  });
}

type VisitRow = NonNullable<Awaited<ReturnType<typeof findVisit>>>;

/** Rebuild the visit from all its events and photos (deriveVisit) and write it. */
export async function rebuildVisit(tx: Tx, visit: VisitRow, ctx: { dayStart: Date; radiusM: number; breakMin: { startMin: number; endMin: number } | null }) {
  const [events, photoCount] = await Promise.all([
    tx.stopEvent.findMany({ where: { tenantId: visit.tenantId, visitId: visit.id } }),
    tx.deliveryPhoto.count({ where: { tenantId: visit.tenantId, visitId: visit.id } }),
  ]);
  const v = deriveVisit(
    events.map(
      (e): VisitEvent => ({
        id: e.id,
        kind: e.kind,
        source: e.source as EventSource,
        at: e.at,
        receivedAt: e.receivedAt,
        lat: e.lat,
        lng: e.lng,
        accuracyM: e.accuracyM,
        distanceM: e.distanceM,
        userId: e.userId,
        payload: (e.payloadJson ?? null) as Record<string, unknown> | null,
      }),
    ),
    {
      dayStart: ctx.dayStart,
      windowStartMin: visit.windowStartMin,
      breakMin: ctx.breakMin,
      lines: readVisitLines(visit.linesJson),
      pin: visit.plannedLat !== null && visit.plannedLng !== null ? { lat: visit.plannedLat, lng: visit.plannedLng } : null,
      radiusM: ctx.radiusM,
    },
  );
  return tx.stopVisit.update({
    where: { id: visit.id },
    data: {
      arrivedAt: v.arrivedAt,
      arrivalSource: v.arrivalSource,
      arrivalDistanceM: v.arrivalDistanceM,
      arrivalAccuracyM: visit.locationPurgedAt ? null : v.arrivalAccuracyM,
      departedAt: v.departedAt,
      departureSource: v.departureSource,
      departedAtOutcome: v.departedAtOutcome,
      arrivalObserved: v.arrivalObserved,
      autoArrivedAt: v.autoArrivedAt,
      autoDepartedAt: v.autoDepartedAt,
      autoBasis: v.autoBasis,
      autoMinutes: v.autoMinutes,
      autoServiceMinutes: v.autoServiceMinutes,
      // After the location purge the positions the plausibility flags were read from are gone: a
      // visit flagged before keeps its flag (it must never start feeding measured times and KPIs).
      timingSuspect: visit.locationPurgedAt ? !!visit.timingSuspect || v.timingSuspect : v.timingSuspect,
      outcome: v.outcome,
      reason: v.reason as NotDeliveredReasonName | null,
      reasonNote: v.reasonNote,
      outcomeAt: v.outcomeAt,
      outcomeSource: v.outcomeSource,
      outcomeById: v.outcomeById,
      outcomeLat: visit.locationPurgedAt ? null : v.outcomeLat,
      outcomeLng: visit.locationPurgedAt ? null : v.outcomeLng,
      outcomeAccuracyM: visit.locationPurgedAt ? null : v.outcomeAccuracyM,
      outcomeDistanceM: v.outcomeDistanceM,
      outcomeLate: v.outcomeLate,
      noPhotoReason: v.noPhotoReason,
      photoKeysJson: v.photoKeys.length ? (v.photoKeys as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      photoCount,
      linesJson: v.lines as unknown as Prisma.InputJsonValue,
      casesDelivered: v.casesDelivered,
      // The driver's own last Delivered / Partly (never changed by an office result): the monitor of
      // results saved without a photo reads these (camera-exceptions.ts).
      driverResultAt: v.driverResultAt,
      driverResultOutcome: v.driverResultOutcome,
      driverNoPhotoReason: v.driverNoPhotoReason,
      driverPhotoKeys: v.driverPhotoKeys,
    },
  });
}

/** The load's planned break, local minutes (frozen loads keep breakJson). */
async function loadBreak(tx: Db, tenantId: string, loadId: string): Promise<{ startMin: number; endMin: number } | null> {
  const l = await tx.planLoad.findFirst({ where: { id: loadId, tenantId }, select: { breakJson: true } });
  const b = l?.breakJson as { v?: unknown; startMin?: unknown; endMin?: unknown } | null | undefined;
  return b && b.v === 1 && typeof b.startMin === 'number' && typeof b.endMin === 'number' ? { startMin: b.startMin, endMin: b.endMin } : null;
}

/**
 * COMPLETED: did the stop have a result at completion? The EFFECTIVE result of the OUTCOME events
 * received at or before it (resultEvent, as deriveVisit picks it): a result that was cleared again
 * before the trip closed is no result, so a late result may still fill that gap.
 */
async function hadResultAtCompletion(tx: Tx, tenantId: string, visitId: string | null, completedAt: Date | null): Promise<boolean> {
  if (!visitId || !completedAt) return false;
  const rows = await tx.stopEvent.findMany({
    where: { tenantId, visitId, kind: 'OUTCOME', receivedAt: { lte: completedAt } },
    select: { kind: true, source: true, at: true, receivedAt: true, payloadJson: true },
  });
  return hadResultAmong(rows);
}

/** The photo keys named by the driver's Delivered and Partly results of a visit (proofPhotoKeys). */
async function visitProofKeys(db: Db, tenantId: string, visitId: string): Promise<Set<string>> {
  const rows = await db.stopEvent.findMany({ where: { tenantId, visitId, kind: 'OUTCOME' }, select: { kind: true, source: true, payloadJson: true } });
  return proofPhotoKeys(rows.map((r) => ({ kind: r.kind, source: r.source, payload: (r.payloadJson ?? null) as Record<string, unknown> | null })));
}

/** Whether OUTCOME events leave a result (not a cleared one) (pure). */
export function hadResultAmong(rows: readonly { kind: string; source: string; at: Date; receivedAt: Date; payloadJson: unknown }[]): boolean {
  const res = resultEvent(rows.map((r) => ({ kind: r.kind as VisitEvent['kind'], source: r.source as EventSource, at: r.at, receivedAt: r.receivedAt, payload: (r.payloadJson ?? null) as Record<string, unknown> | null })));
  return !!res && typeof res.payload?.outcome === 'string';
}

/**
 * The copies' carry basis of the stop's brought-forward orders (an empty basis for copies made before
 * Part 3). Called UNDER the outcome-day lock: the orders' carriedToOrderId is read again here, never
 * taken from the planned stop read before the lock (a Bring forward committing meanwhile would be
 * missed, and a result change would slip past the basis rule).
 */
export async function carryBases(tx: Tx, tenantId: string, planned: PlannedStop): Promise<{ copyId: string; copyDate: string; basis: ReturnType<typeof readCarryBasis>; originalId: string }[]> {
  const ids = planned.orders.map((o) => o.orderId);
  if (!ids.length) return [];
  const fresh = await tx.order.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, carriedToOrderId: true } });
  const originalOf = new Map(fresh.filter((o) => !!o.carriedToOrderId).map((o) => [o.carriedToOrderId!, o.id]));
  if (!originalOf.size) return [];
  const rows = await tx.order.findMany({ where: { tenantId, id: { in: [...originalOf.keys()] } }, select: { id: true, deliveryDate: true, carryBasisJson: true } });
  return rows.map((r) => ({ copyId: r.id, copyDate: isoOf(r.deliveryDate), basis: readCarryBasis(r.carryBasisJson), originalId: originalOf.get(r.id)! }));
}

/** At most this many arrivals, departures and results are stored per stop (a flood of one link is refused INVALID). */
export const MAX_EVENTS_PER_VISIT = 40;
/** At most this many Back at depot events per load. */
export const MAX_BACK_EVENTS_PER_LOAD = 5;

/** Whether a result repeats the visit's current one exactly (same source kind, outcome, reason, note, lines, photos). */
export function repeatsCurrentResult(
  visit: { outcome: string | null; reason: string | null; reasonNote: string | null; outcomeSource: string | null; noPhotoReason: string | null; photoKeysJson: unknown; linesJson: unknown } | null,
  next: { source: EventSource; outcome: string | null; reason: string | null; note: string | null; lines: { lineId: string; delivered: number }[]; photoKeys: readonly string[]; noPhotoReason: string | null },
): boolean {
  if (!visit) return next.outcome === null;
  if (next.outcome === null) return visit.outcome === null;
  if (visit.outcome !== next.outcome || visit.outcomeSource !== next.source) return false;
  if ((visit.reason ?? null) !== (next.reason ?? null) || (visit.reasonNote ?? null) !== (next.note ?? null) || (visit.noPhotoReason ?? null) !== (next.noPhotoReason ?? null)) return false;
  const keys = Array.isArray(visit.photoKeysJson) ? (visit.photoKeysJson as unknown[]).filter((k): k is string => typeof k === 'string') : [];
  if (keys.length !== next.photoKeys.length || [...keys].sort().join('|') !== [...next.photoKeys].sort().join('|')) return false;
  const stored = new Map(readVisitLines(visit.linesJson).map((l) => [l.lineId, l.deliveredCases]));
  return next.lines.every((l) => stored.get(l.lineId) === l.delivered) && stored.size === next.lines.length;
}

// ---------------------------------------------------------------------------------------
// One action
// ---------------------------------------------------------------------------------------

interface Applied {
  result: DriverActionResult;
  /** A load to try completing after the commit (Back at depot, or a result on a returned load). */
  completeLoadNo?: number;
}

const kindOf: Record<ParsedAction['type'], WriteKind> = { ARRIVE: 'ARRIVE', DEPART: 'DEPART', OUTCOME: 'OUTCOME', BACK_AT_DEPOT: 'BACK_AT_DEPOT' };

async function applyAction(ctx: DriverWriteContext, facts: DayFacts, a: ParsedAction, skew: number): Promise<Applied> {
  const office = !!ctx.session;
  const storedKey = `dl:${a.key}`;
  const at = actionTime(new Date(a.at), skew, { receivedAt: ctx.now, dayStart: facts.dayStart, expiresAt: ctx.link.expiresAt });
  if (at === 'TIME_OUT_OF_RANGE') return { result: refused(a.key, 'TIME_OUT_OF_RANGE') };
  const where = a.type === 'BACK_AT_DEPOT' ? { loadNo: a.load, sequence: null } : parseStopKey(a.stop);
  if (!where) return { result: refused(a.key, 'INVALID') };
  const dayLoad = liveLoad(facts, where.loadNo);
  if (!dayLoad) return { result: refused(a.key, 'STOP_NOT_FOUND') };
  const pos = a.pos;
  const posAt = posDate(pos, skew);

  return prisma.$transaction(
    async (tx): Promise<Applied> => {
      await setLockTimeout(tx);
      // The outcome-day lock FIRST: the load's status, the stop's orders (carriedToOrderId) and the
      // visit are read under it, so a Bring forward or a completion committing meanwhile is seen.
      await lockOutcomesDay(tx, ctx.tenantId, dayLoad.depotId, ctx.date);
      const load = await tx.planLoad.findFirst({
        where: { id: dayLoad.id, tenantId: ctx.tenantId },
        select: { id: true, status: true, statusChangedAt: true, breakJson: true, truckSnapshotJson: true, runId: true },
      });
      if (!load) return { result: refused(a.key, 'STOP_NOT_FOUND') };
      const planned = where.sequence !== null ? await plannedStopOf(tx, load, where.sequence) : null;
      if (where.sequence !== null && !planned) return { result: refused(a.key, 'STOP_NOT_FOUND') };
      // Idempotency under the lock: a duplicate only for the same link; another link's key is INVALID.
      const existing = await tx.stopEvent.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: storedKey }, select: { id: true, driverLinkId: true, kind: true } });
      if (existing) {
        if (existing.driverLinkId !== ctx.link.id) return { result: refused(a.key, 'INVALID') };
        return { result: existing.kind === 'CARRY_CONFLICT' ? refused(a.key, 'OUTCOME_CARRIED') : { key: a.key, status: 'duplicate' } };
      }
      const vk: VisitKey = { tenantId: ctx.tenantId, depotId: dayLoad.depotId, date: ctx.date, truckId: ctx.truckId, loadNo: where.loadNo, sequence: where.sequence ?? 0 };
      const visit = where.sequence !== null ? await findVisit(tx, vk) : null;
      const rule = writeRule({
        kind: kindOf[a.type],
        office,
        loadStatus: load.status,
        at,
        statusChangedAt: load.statusChangedAt,
        hadResultAtCompletion: a.type === 'OUTCOME' && load.status === 'COMPLETED' ? await hadResultAtCompletion(tx, ctx.tenantId, visit?.id ?? null, load.statusChangedAt) : false,
        receivedAt: ctx.now,
        expiresAt: ctx.link.expiresAt,
      });
      if (!rule.ok) return { result: refused(a.key, rule.code, rule.transient) };
      // Bounded storage per stop and per load: a link holder flooding one stop with fresh keys is refused.
      if (a.type === 'BACK_AT_DEPOT') {
        const backs = await tx.stopEvent.count({ where: { tenantId: ctx.tenantId, deliveryDate: dateOnly(ctx.date), truckId: ctx.truckId, depotId: dayLoad.depotId, loadNo: where.loadNo, kind: 'BACK_AT_DEPOT' } });
        if (backs >= MAX_BACK_EVENTS_PER_LOAD) return { result: refused(a.key, 'INVALID') };
      } else if (visit) {
        const n = await tx.stopEvent.count({ where: { tenantId: ctx.tenantId, visitId: visit.id, kind: { in: ['ARRIVED', 'DEPARTED', 'OUTCOME'] } } });
        if (n >= MAX_EVENTS_PER_VISIT) return { result: refused(a.key, 'INVALID') };
      }
      const late = rule.late;
      const who = writerAudit(ctx, facts, dayLoad);
      const base = {
        tenantId: ctx.tenantId,
        depotId: dayLoad.depotId,
        deliveryDate: dateOnly(ctx.date),
        truckId: ctx.truckId,
        loadNo: where.loadNo,
        driverLinkId: ctx.link.id,
        linkGeneration: ctx.link.generation,
        userId: ctx.session?.userId ?? null,
        clientIp: ctx.ip,
        deviceId: ctx.deviceId,
        idempotencyKey: storedKey,
        receivedAt: ctx.now,
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        accuracyM: pos?.accuracyM ?? null,
        speedMps: pos?.speedMps ?? null,
      };
      const common = { ...(late ? { late: true } : {}), ...(skew ? { clockSkewMs: skew } : {}), ...(pos?.gpsAt ? { gpsAt: pos.gpsAt } : {}) };

      // --- Back at depot: a load-level event --------------------------------------------
      if (a.type === 'BACK_AT_DEPOT') {
        const origin = readLoadOrigin(readTruckSnapshot(load.truckSnapshotJson));
        const depotPin = origin ?? (await tx.depot.findFirst({ where: { id: dayLoad.depotId, tenantId: ctx.tenantId }, select: { lat: true, lng: true } }));
        await tx.stopEvent.create({
          data: {
            ...base,
            sequence: null,
            visitId: null,
            kind: 'BACK_AT_DEPOT',
            source: office ? 'DISPATCHER' : 'PHONE_MANUAL',
            at,
            distanceM: pos && depotPin ? Math.round(distanceM(pos, depotPin)) : null,
            payloadJson: common as Prisma.InputJsonValue,
          },
        });
        await audit(
          {
            tenantId: ctx.tenantId,
            userId: who.userId,
            action: 'DRIVER_BACK_AT_DEPOT',
            entity: 'PlanLoad',
            entityId: dayLoad.id,
            afterJson: { truckId: ctx.truckId, loadNo: where.loadNo, date: ctx.date, at: at.toISOString(), late, ...who.extra } as Prisma.InputJsonValue,
            ip: who.ip,
          },
          tx,
        );
        return { result: { key: a.key, status: 'ok' }, completeLoadNo: load.status === 'DISPATCHED' ? where.loadNo : undefined };
      }

      const p = planned!;
      const breakMin = p.breakMin;
      const pin = p.pin;
      const dist = (q: { lat: number; lng: number } | null | undefined) => (q && pin ? Math.round(distanceM(q, pin) * 10) / 10 : null);

      // --- Arrival -----------------------------------------------------------------------
      if (a.type === 'ARRIVE') {
        let source: EventSource = a.mode === 'MANUAL' ? (office ? 'DISPATCHER' : 'PHONE_MANUAL') : 'PHONE_AUTO';
        const payload: Record<string, unknown> = { mode: a.mode, ...common };
        if (a.chosen) payload.chosen = true;
        if (a.when && a.mode === 'MANUAL') payload.when = true;
        let arriveAt = at;
        if (a.mode === 'AUTO') {
          // Found inside when the page came back: its time is only an upper bound (spec section 7.3).
          if (a.observed === false) {
            payload.observed = false;
            payload.resumed = true;
          }
          // Downgrade an automatic arrival without a position, or far from the pin (spec section 8.3).
          const d = dist(pos);
          if (!pos || (pin && d !== null && d > facts.radiusM + Math.min(pos.accuracyM, facts.radiusM / 2) + 25)) {
            source = 'PHONE_MANUAL';
            payload.downgraded = true;
          }
          if (a.chained) {
            const from = a.from ? parseStopKey(a.from) : null;
            const fromStop = from && from.loadNo === where.loadNo ? await plannedStopOf(tx, load, from.sequence) : null;
            const ok = !!fromStop?.pin && !!pin && distanceM(fromStop.pin, pin) <= facts.radiusM + 50;
            if (ok) payload.chained = true;
            else if (posAt) arriveAt = new Date(Math.min(posAt.getTime(), ctx.now.getTime())); // chained between distant pins: ignored, the arrival takes its own fix
          }
        }
        const v = await ensureVisit(tx, vk, p, dayLoad.id);
        await tx.stopEvent.create({
          data: { ...base, sequence: where.sequence, visitId: v.id, kind: 'ARRIVED', source, at: arriveAt, distanceM: dist(pos), payloadJson: payload as Prisma.InputJsonValue },
        });
        await rebuildVisit(tx, v, { dayStart: facts.dayStart, radiusM: facts.radiusM, breakMin });
        if (a.mode === 'MANUAL') {
          await audit(
            {
              tenantId: ctx.tenantId,
              userId: who.userId,
              action: 'STOP_ARRIVAL_MANUAL',
              entity: 'StopVisit',
              entityId: v.id,
              afterJson: { truckId: ctx.truckId, loadNo: where.loadNo, sequence: where.sequence, date: ctx.date, at: arriveAt.toISOString(), customerCode: p.customerCode, when: !!a.when, late, ...who.extra } as Prisma.InputJsonValue,
              ip: who.ip,
            },
            tx,
          );
        }
        return { result: { key: a.key, status: 'ok' } };
      }

      // --- Departure ---------------------------------------------------------------------
      if (a.type === 'DEPART') {
        const v = await ensureVisit(tx, vk, p, dayLoad.id);
        await tx.stopEvent.create({
          data: {
            ...base,
            sequence: where.sequence,
            visitId: v.id,
            kind: 'DEPARTED',
            source: 'PHONE_AUTO',
            at,
            distanceM: dist(pos),
            payloadJson: { reason: a.reason, ...(a.gap ? { gap: true } : {}), ...common } as Prisma.InputJsonValue,
          },
        });
        await rebuildVisit(tx, v, { dayStart: facts.dayStart, radiusM: facts.radiusM, breakMin });
        return { result: { key: a.key, status: 'ok' } };
      }

      // --- Result --------------------------------------------------------------------------
      const norm = normalizeResult(
        p.lines.map((l) => ({ orderId: l.orderId, lineId: l.lineId, plannedCases: l.plannedCases })),
        { outcome: a.outcome, reason: a.reason ?? null, note: a.note ?? null, lines: a.lines ?? null },
      );
      if (!norm.ok) return { result: { ...refused(a.key, 'INVALID'), message: { en: norm.message, ar: REFUSAL_TEXT.INVALID.ar } } };
      const outcome = norm.outcome;
      const photoArgs = { required: facts.photoRequired, byDriver: !office, outcome, photoKeys: a.photoKeys, noPhotoReason: a.noPhotoReason };
      if (photoRule(photoArgs) !== 'ok') {
        // A changed or redone result: the photos an earlier Delivered or Partly of the driver named are
        // its proof, also while they are still on their way (proofPhotoKeys). A Not delivered's are not.
        const proof = visit ? await visitProofKeys(tx, ctx.tenantId, visit.id) : new Set<string>();
        if (photoRule({ ...photoArgs, proofPhotos: proof.size }) !== 'ok') return { result: refused(a.key, 'PHOTO_REQUIRED') };
      }
      const after = new Map(p.lines.map((l) => [l.lineId, 0]));
      if (norm.outcome !== null) for (const l of norm.lines) after.set(l.lineId, l.planned - l.delivered);
      const source: EventSource = office ? 'DISPATCHER' : 'PHONE_MANUAL';
      // The same result again (a phone repeating itself, or a flood with fresh keys): nothing to store.
      if (
        repeatsCurrentResult(visit, {
          source,
          outcome: norm.outcome,
          reason: norm.outcome === null ? null : norm.reason,
          note: norm.outcome === null ? null : norm.note,
          lines: norm.outcome === null ? [] : norm.lines.map((l) => ({ lineId: l.lineId, delivered: l.delivered })),
          photoKeys: a.photoKeys,
          noPhotoReason: a.noPhotoReason ?? null,
        })
      ) {
        return { result: { key: a.key, status: 'ok' }, completeLoadNo: load.status === 'DISPATCHED' && norm.outcome !== null ? where.loadNo : undefined };
      }
      const payload: Record<string, unknown> =
        norm.outcome === null
          ? { outcome: null, ...common }
          : {
              outcome: norm.outcome,
              reason: norm.reason,
              note: norm.note,
              lines: norm.lines.map((l) => ({ lineId: l.lineId, delivered: l.delivered })),
              photoKeys: a.photoKeys,
              ...(a.noPhotoReason ? { noPhotoReason: a.noPhotoReason } : {}),
              ...(norm.coerced ? { coerced: true } : {}),
              ...common,
            };
      // The basis rule: a change that shrinks cases already brought forward from this visit is refused.
      if (visit) {
        for (const c of await carryBases(tx, ctx.tenantId, p)) {
          if (!inCarryBasis(c.basis, visit.id)) continue;
          const check = carryChangeCheck(c.basis, visit.id, after);
          if (check.ok) continue;
          await tx.stopEvent.create({
            data: {
              ...base,
              sequence: where.sequence,
              visitId: visit.id,
              kind: 'CARRY_CONFLICT',
              source,
              at,
              distanceM: dist(pos),
              payloadJson: { refused: payload, copyId: c.copyId, copyDate: c.copyDate, lines: check.lines, ...common } as Prisma.InputJsonValue,
            },
          });
          await audit(
            {
              tenantId: ctx.tenantId,
              userId: who.userId,
              action: 'DELIVERY_CARRY_CONFLICT',
              entity: 'StopVisit',
              entityId: visit.id,
              afterJson: { truckId: ctx.truckId, loadNo: where.loadNo, sequence: where.sequence, date: ctx.date, refusedOutcome: norm.outcome, copyDate: c.copyDate, lines: check.lines, ...who.extra } as Prisma.InputJsonValue,
              ip: who.ip,
            },
            tx,
          );
          return { result: refused(a.key, 'OUTCOME_CARRIED') };
        }
      }
      const v = visit ?? (await ensureVisit(tx, vk, p, dayLoad.id));
      const before = { outcome: v.outcome, reason: v.reason, casesDelivered: v.casesDelivered };
      await tx.stopEvent.create({
        data: { ...base, sequence: where.sequence, visitId: v.id, kind: 'OUTCOME', source, at, distanceM: dist(pos), payloadJson: payload as Prisma.InputJsonValue },
      });
      const rebuilt = await rebuildVisit(tx, v, { dayStart: facts.dayStart, radiusM: facts.radiusM, breakMin });
      await audit(
        {
          tenantId: ctx.tenantId,
          userId: who.userId,
          action: 'DELIVERY_OUTCOME_SET',
          entity: 'StopVisit',
          entityId: v.id,
          beforeJson: before as Prisma.InputJsonValue,
          afterJson: {
            truckId: ctx.truckId,
            loadNo: where.loadNo,
            sequence: where.sequence,
            date: ctx.date,
            customerCode: p.customerCode,
            source,
            outcome: rebuilt.outcome,
            reason: rebuilt.reason,
            casesDelivered: rebuilt.casesDelivered,
            casesPlanned: rebuilt.casesPlanned,
            photoKeys: a.photoKeys.length,
            ...(a.noPhotoReason ? { noPhotoReason: a.noPhotoReason } : {}),
            late,
            ...who.extra,
          } as Prisma.InputJsonValue,
          ip: who.ip,
        },
        tx,
      );
      return { result: { key: a.key, status: 'ok' }, completeLoadNo: load.status === 'DISPATCHED' ? where.loadNo : undefined };
    },
    { timeout: 15_000, maxWait: 5_000 },
  );
}

/** A P2002 on the key (a concurrent request): answered from a fresh read outside the aborted transaction. */
async function answerFromStored(ctx: DriverWriteContext, k: string, storedKey: string): Promise<DriverActionResult> {
  const e = await prisma.stopEvent.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: storedKey }, select: { driverLinkId: true, kind: true } });
  if (!e || e.driverLinkId !== ctx.link.id) return refused(k, 'INVALID');
  return e.kind === 'CARRY_CONFLICT' ? refused(k, 'OUTCOME_CARRIED') : { key: k, status: 'duplicate' };
}

/**
 * POST /api/d/actions: each action in its own transaction, in the order sent. A malformed action is
 * refused INVALID (its key is echoed so the phone can drop it); a lock timeout answers the whole
 * request 409 PLAN_BUSY (the phone retries; what was stored answers "duplicate" then).
 */
export async function recordDriverActions(ctx: DriverWriteContext, body: { clientNow: string; actions: unknown[] }): Promise<{ results: DriverActionResult[] } & DriverResults> {
  const facts = await dayFacts(ctx);
  const skew = clockSkewMs(ctx.now, new Date(body.clientNow));
  const results: DriverActionResult[] = [];
  const toComplete = new Set<number>();
  for (const raw of body.actions) {
    const parsed = actionSchema.safeParse(raw);
    if (!parsed.success) {
      const k = (raw as { key?: unknown } | null)?.key;
      results.push(refused(typeof k === 'string' ? k.slice(0, 64) : '', 'INVALID'));
      continue;
    }
    const a = parsed.data;
    try {
      const r = await applyAction(ctx, facts, a, skew);
      results.push(r.result);
      if (r.completeLoadNo !== undefined) toComplete.add(r.completeLoadNo);
    } catch (e) {
      if (isLockBusy(e)) throw new PlanBusyError();
      if (isUniqueViolation(e)) {
        results.push(await answerFromStored(ctx, a.key, `dl:${a.key}`));
        continue;
      }
      if (e instanceof HttpError) throw e;
      // One faulty action never blocks the others: it stays on the phone and is sent again.
      console.error('[delivery] action failed', a.type, (e as Error)?.message ?? e);
      results.push({ key: a.key, status: 'error' });
    }
  }
  // A signed-in office user on the driver page closes the trip as themselves, not as the driver link.
  const closer = ctx.session ? { userId: ctx.session.userId, label: null } : undefined;
  for (const loadNo of toComplete) await maybeCompleteLoad(ctx.tenantId, ctx.truckId, ctx.date, loadNo, facts, closer);
  const res = await truckDayResultsFromDb(prisma, ctx.tenantId, ctx.truckId, ctx.date, ctx.session ? 'OFFICE' : 'DRIVER');
  return { results, ...res };
}

// ---------------------------------------------------------------------------------------
// Back at depot and completion (spec section 8.7)
// ---------------------------------------------------------------------------------------

/** Has the load a BACK_AT_DEPOT event? */
async function isBack(db: Db, tenantId: string, depotId: string, date: string, truckId: string, loadNo: number): Promise<boolean> {
  const n = await db.stopEvent.count({ where: { tenantId, depotId, deliveryDate: dateOnly(date), truckId, loadNo, kind: 'BACK_AT_DEPOT' } });
  return n > 0;
}

/** Who closes a trip: a signed-in user (their own audit row), else the driver link's label. */
export interface CompletionActor {
  userId: string | null;
  label: string | null;
}

/**
 * Completes a DISPATCHED load that is back at the depot with a result on every stop. Best effort: a
 * busy plan (409) or a missing result leaves it DISPATCHED (the janitor tries again); never throws.
 * `actor`: the office user who recorded the last result ({ userId, label: null }); without it the
 * row says "Driver link: <driver> (<truck>, back at depot)" with no user (the driver link, the janitor).
 */
export async function maybeCompleteLoad(tenantId: string, truckId: string, date: string, loadNo: number, facts?: DayFacts, actor?: CompletionActor): Promise<boolean> {
  try {
    const loads = facts?.loads ?? (await truckDayLoads(prisma, tenantId, truckId, date));
    const load = loads.find((l) => l.loadNo === loadNo);
    if (!load || load.status !== 'DISPATCHED') return false;
    if (!(await isBack(prisma, tenantId, load.depotId, date, truckId, loadNo))) return false;
    let who: CompletionActor;
    if (actor?.userId) who = { userId: actor.userId, label: actor.label };
    else {
      const truck = facts?.truckCode ?? (await prisma.truck.findFirst({ where: { id: truckId, tenantId }, select: { code: true } }))?.code ?? '';
      who = { userId: null, label: actor?.label ?? `Driver link: ${load.driverName ?? 'no driver set'} (${truck}, back at depot)` };
    }
    const r = await completeLoadAsDriver(tenantId, { runId: load.runId, loadId: load.id, depotId: load.depotId, date }, who);
    return r.completed;
  } catch (e) {
    console.warn('[delivery] load not completed yet', (e as Error)?.message ?? e);
    return false;
  }
}

/**
 * The janitor's sweep (at most every 10 min from the loop, and the cron route): DISPATCHED loads on
 * live plans that reported Back at depot in the last 4 days and have a result on every stop are
 * completed, actor "Driver link: ... (back at depot)". The usual case never reaches it: the last
 * result completes the load at once. The newest Back at depot events first (index kind, receivedAt);
 * truck-days whose load is no longer DISPATCHED are dropped in one query before any per-load work.
 */
export async function completeReturnedLoads(now: Date = new Date()): Promise<{ completed: number }> {
  const since = new Date(now.getTime() - 4 * 24 * 60 * 60_000);
  const backs = await prisma.stopEvent.findMany({
    where: { kind: 'BACK_AT_DEPOT', receivedAt: { gte: since } },
    select: { tenantId: true, deliveryDate: true, truckId: true, loadNo: true },
    orderBy: [{ receivedAt: 'desc' }],
    take: 2000,
  });
  if (!backs.length) return { completed: 0 };
  // The loads still out (DISPATCHED) of those trucks: anything else needs no work.
  const out = await prisma.planLoad.findMany({
    where: { status: 'DISPATCHED', tenantId: { in: [...new Set(backs.map((b) => b.tenantId))] }, truckId: { in: [...new Set(backs.map((b) => b.truckId))] } },
    select: { tenantId: true, truckId: true, loadNo: true, runId: true },
  });
  const runs = out.length ? await prisma.runPlan.findMany({ where: { id: { in: [...new Set(out.map((l) => l.runId))] } }, select: { id: true, runDate: true } }) : [];
  const dateOfRun = new Map(runs.map((r) => [r.id, isoOf(r.runDate)]));
  const stillOut = new Set(out.map((l) => `${l.tenantId}|${l.truckId}|${dateOfRun.get(l.runId) ?? ''}|${l.loadNo}`));
  const seen = new Set<string>();
  let completed = 0;
  for (const b of backs) {
    const date = isoOf(b.deliveryDate);
    const k = `${b.tenantId}|${b.truckId}|${date}|${b.loadNo}`;
    if (seen.has(k) || !stillOut.has(k)) continue;
    seen.add(k);
    const loads = await truckDayLoads(prisma, b.tenantId, b.truckId, date);
    const load = loads.find((l) => l.loadNo === b.loadNo);
    if (!load || load.status !== 'DISPATCHED') continue;
    const truck = (await prisma.truck.findFirst({ where: { id: b.truckId, tenantId: b.tenantId }, select: { code: true } }))?.code ?? '';
    if (await maybeCompleteLoad(b.tenantId, b.truckId, date, b.loadNo, undefined, { userId: null, label: `Driver link: ${load.driverName ?? 'no driver set'} (${truck}, back at depot)` })) completed++;
  }
  return { completed };
}

// ---------------------------------------------------------------------------------------
// What the page gets back (spec section 8.6)
// ---------------------------------------------------------------------------------------

export interface ResultsLoad {
  loadNo: number;
  depotId: string;
  status: string;
  stops: { sequence: number; orderIds: string[] }[];
}

/** The results of the truck-day's stops and the Back at depot times, for the manifest and the action answers. */
export async function truckDayResults(db: Db, tenantId: string, truckId: string, date: string, loads: readonly ResultsLoad[], viewer: 'DRIVER' | 'OFFICE' = 'DRIVER'): Promise<DriverResults> {
  const stops: Record<string, StopResult> = {};
  const back: Record<string, string> = {};
  if (!loads.length) return { stops, back };
  const [visits, backs] = await Promise.all([
    db.stopVisit.findMany({ where: { tenantId, truckId, deliveryDate: dateOnly(date) } }),
    db.stopEvent.findMany({ where: { tenantId, truckId, deliveryDate: dateOnly(date), kind: 'BACK_AT_DEPOT' }, select: { depotId: true, loadNo: true, at: true } }),
  ]);
  const depotOf = new Map(loads.map((l) => [l.loadNo, l.depotId]));
  for (const b of backs) {
    if (depotOf.get(b.loadNo) !== b.depotId) continue;
    const k = String(b.loadNo);
    if (!back[k] || b.at.toISOString() < back[k]!) back[k] = b.at.toISOString();
  }
  const visitIds = visits.map((v) => v.id);
  const [photos, results] = visitIds.length
    ? await Promise.all([
        db.deliveryPhoto.findMany({ where: { tenantId, visitId: { in: visitIds } }, select: { id: true, visitId: true, takenAt: true } }),
        db.stopEvent.findMany({ where: { tenantId, visitId: { in: visitIds }, kind: 'OUTCOME' }, select: { visitId: true, kind: true, source: true, payloadJson: true } }),
      ])
    : [[], []];
  // The photo proof of each stop, as the server counts it for a changed result (proofPhotoKeys).
  const proofOf = (visitId: string) =>
    proofPhotoKeys(results.filter((e) => e.visitId === visitId).map((e) => ({ kind: e.kind, source: e.source, payload: (e.payloadJson ?? null) as Record<string, unknown> | null }))).size;
  const orderIds = [...new Set(loads.flatMap((l) => l.stops.flatMap((s) => s.orderIds)))];
  const carried = orderIds.length
    ? await db.order.findMany({ where: { tenantId, id: { in: orderIds }, carriedToOrderId: { not: null } }, select: { id: true, carriedToOrderId: true } })
    : [];
  const copies = carried.length
    ? await db.order.findMany({ where: { tenantId, id: { in: carried.map((c) => c.carriedToOrderId!) } }, select: { id: true, deliveryDate: true, carryBasisJson: true } })
    : [];
  const copyOf = new Map(copies.map((c) => [c.id, c]));
  const carriedOf = new Map(carried.map((c) => [c.id, copyOf.get(c.carriedToOrderId!) ?? null]));
  for (const l of loads) {
    for (const s of l.stops) {
      const v = visits.find((x) => x.depotId === l.depotId && x.loadNo === l.loadNo && x.sequence === s.sequence);
      const copies = s.orderIds.map((id) => carriedOf.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
      const carriedTo = copies.length ? copies.map((c) => isoOf(c.deliveryDate)).sort().at(-1)! : null;
      const inBasis = !!v && copies.some((c) => inCarryBasis(readCarryBasis(c.carryBasisJson), v.id));
      const key = `${l.loadNo}:${s.sequence}`;
      if (!v) {
        if (carriedTo) stops[key] = emptyResult(l.status === 'DISPATCHED', carriedTo);
        continue;
      }
      const lines = readVisitLines(v.linesJson);
      const minutes =
        v.autoMinutes ?? (v.arrivedAt && v.departedAt && v.departedAt > v.arrivedAt ? Math.round((v.departedAt.getTime() - v.arrivedAt.getTime()) / 6000) / 10 : null);
      stops[key] = {
        state: v.outcome ? 'DONE' : v.arrivedAt && !v.departedAt ? 'ARRIVED' : 'PENDING',
        arrivedAt: v.arrivedAt?.toISOString() ?? null,
        arrivalObserved: v.arrivalObserved,
        departedAt: v.departedAt?.toISOString() ?? null,
        minutes,
        outcome: v.outcome,
        reason: v.reason,
        note: v.reasonNote,
        outcomeAt: v.outcomeAt?.toISOString() ?? null,
        by: v.outcome ? (v.outcomeSource === 'DISPATCHER' ? 'OFFICE' : 'DRIVER') : null,
        casesDelivered: v.casesDelivered,
        lines: v.outcome ? lines.map((x) => ({ lineId: x.lineId, delivered: x.deliveredCases ?? 0 })) : null,
        photoIds: photos
          .filter((ph) => ph.visitId === v.id)
          .sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime())
          .map((ph) => ph.id),
        proofPhotos: proofOf(v.id),
        noPhotoReason: v.noPhotoReason,
        late: v.outcomeLate,
        editable: (l.status === 'DISPATCHED' || (viewer === 'OFFICE' && l.status === 'COMPLETED')) && !inBasis,
        carriedTo,
      };
    }
  }
  return { stops, back };
}

function emptyResult(dispatched: boolean, carriedTo: string | null): StopResult {
  return {
    state: 'PENDING',
    arrivedAt: null,
    arrivalObserved: true,
    departedAt: null,
    minutes: null,
    outcome: null,
    reason: null,
    note: null,
    outcomeAt: null,
    by: null,
    casesDelivered: null,
    lines: null,
    photoIds: [],
    proofPhotos: 0,
    noPhotoReason: null,
    late: false,
    editable: dispatched,
    carriedTo,
  };
}

/** truckDayResults with the stops read from the plan rows of the truck-day's live loads. */
export async function truckDayResultsFromDb(db: Db, tenantId: string, truckId: string, date: string, viewer: 'DRIVER' | 'OFFICE' = 'DRIVER'): Promise<DriverResults> {
  const loads = await truckDayLoads(db, tenantId, truckId, date);
  if (!loads.length) return { stops: {}, back: {} };
  const rows = await db.routeAssignment.findMany({ where: { loadId: { in: loads.map((l) => l.id) } }, select: { loadId: true, sequenceInTruck: true, orderId: true } });
  return truckDayResults(
    db,
    tenantId,
    truckId,
    date,
    loads.map((l) => {
      const mine = rows.filter((r) => r.loadId === l.id);
      const seqs = [...new Set(mine.map((r) => r.sequenceInTruck))];
      return { loadNo: l.loadNo, depotId: l.depotId, status: l.status, stops: seqs.map((s) => ({ sequence: s, orderIds: mine.filter((r) => r.sequenceInTruck === s).map((r) => r.orderId) })) };
    }),
    viewer,
  );
}
