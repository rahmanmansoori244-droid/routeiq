/**
 * The dispatcher's side of delivery results (owner request 4 Oct 2026, Part 3, spec sections 8.3,
 * 9.4 and 10.2). Server only.
 *
 * "Record outcome" on the plan screen (POST /api/dispatch/outcomes): a result, or a correction, for
 * any stop of a load that left (DISPATCHED or COMPLETED), at any time - a driver without a phone, a
 * forgotten stop, a wrong tap. It is stored as an event of source DISPATCHER with the user's id (key
 * `disp:<uuid>`, so a double click records once), rebuilds the visit (visit.ts) and is audited
 * DELIVERY_OUTCOME_SET with before and after. The office is not held to "photo required". Optional
 * Arrived / Left times (HH:MM) are stored as DISPATCHER arrival and departure events: the newest
 * office entry overrides the phone's and any earlier office entry (visit.ts). "Left" needs an arrival
 * (typed, or stored) before it; the time a result is entered is never taken as "Left".
 *
 * The carry basis rule (section 9.4): a change that would shrink cases already brought forward from
 * this visit is refused 409 OUTCOME_CARRIED and kept as a CARRY_CONFLICT event per copy it would
 * shrink (it warns on each copy's plan). When every such copy is on no plan yet the answer says
 * `undoable`, and the dialog offers "Undo the bring forward and record this result": the same request
 * with `undoCarry: true` removes the copies and records the result in ONE transaction (locks: intake,
 * day locks, outcome-day lock). All or nothing: every copy is checked before anything changes, and
 * when one of them cannot be removed (planned, on the road, brought forward again, its day being
 * optimized) none is removed, no result is recorded, and the refusal names each copy that blocks it.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../audit';
import { HttpError } from '../http-error';
import { isLockBusy, PlanBusyError, setLockTimeout } from '../dispatch/plan-locks';
import { DEFAULT_TZ, dateOnly, parseHhmm, zonedDayStart } from '../dispatch/time';
import { isoDateSchema } from '../schemas';
import { DEFAULT_PHOTO_RETENTION_DAYS } from '../settings-fields';
import { lockForUndo, undoCheck, undoCarryTx, type UndoCarryResult, type UndoRefusalCode } from '../dispatch/carry-over';
import { shownTruckCode } from '../dispatch/hire';
import { truckDayLoads } from '../driver-link/service';
import { NOT_DELIVERED_REASONS } from '../driver-link/manifest-types';
import { lockOutcomesDay } from './locks';
import { carriedRefusalText, type CarriedCopy } from './office-text';
import { plannedStopOf } from './planned-stop';
import { carryChangeCheck, inCarryBasis, normalizeResult } from './outcome-rules';
import { carryBases, ensureVisit, findVisit, maybeCompleteLoad, rebuildVisit, UUID_RE, type VisitKey } from './event-service';

const hhmmField = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use a time as HH:MM.')
  .nullish();

export const officeOutcomeSchema = z
  .object({
    /** Made once by the dialog (crypto.randomUUID): a double click or a retry records once. */
    key: z.string().regex(UUID_RE, 'A lowercase UUID.'),
    depotId: z.string().min(1).max(64),
    date: isoDateSchema,
    truckId: z.string().min(1).max(64),
    loadNo: z.number().int().min(1).max(999),
    sequence: z.number().int().min(1).max(9999),
    /** null = clear the result. */
    outcome: z.enum(['DELIVERED', 'PARTLY_DELIVERED', 'NOT_DELIVERED']).nullable(),
    reason: z.enum(NOT_DELIVERED_REASONS).nullish(),
    note: z.string().max(1000).nullish(),
    lines: z
      .array(z.object({ lineId: z.string().min(1).max(64), delivered: z.number() }).strict())
      .max(300)
      .nullish(),
    arrivedAt: hhmmField,
    departedAt: hhmmField,
    undoCarry: z.boolean().optional(),
  })
  .strict();
export type OfficeOutcomeInput = z.infer<typeof officeOutcomeSchema>;

export interface OfficeOutcomeAnswer {
  result: 'ok' | 'duplicate';
  visitId: string | null;
  /** The bring forward that was undone first (undoCarry: true); `carriesUndone` has every one. */
  carryUndone?: UndoCarryResult;
  /** Every copy removed before the result was recorded (undoCarry: true), in one transaction with it. */
  carriesUndone?: UndoCarryResult[];
  /** The load was completed after this result (it was back at the depot and this was its last stop). */
  loadCompleted?: boolean;
}

class OfficeOutcomeError extends HttpError {
  constructor(message: string, status: number, code: string, extra: Record<string, unknown> = {}) {
    super(message, status, { code, ...extra });
    this.name = 'OfficeOutcomeError';
  }
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError ? e.code === 'P2002' : (e as { code?: unknown } | null)?.code === 'P2002';
}

/** A copy the refused change would shrink, as the 409 names it (`code`: why it cannot be removed). */
type Conflict = CarriedCopy & { code: UndoRefusalCode | null };

/**
 * POST /api/dispatch/outcomes. `user`: the signed-in dispatcher (PLANNER+, checked by the route).
 * 404 STOP_NOT_FOUND, 409 LOAD_NOT_DISPATCHED, 422 INVALID, 409 OUTCOME_CARRIED { copyId, copyDate,
 * undoable, copies } (copyId / copyDate: the first copy that blocks the undo, else the first copy;
 * undoable: every copy can be removed; copies: each copy the change would shrink, with its own
 * undoable and code), 409 PLAN_BUSY (a lock timed out: try again).
 */
export async function recordOfficeOutcome(
  tenantId: string,
  user: { id: string; name: string },
  input: OfficeOutcomeInput,
  opts: { ip?: string | null; now?: Date } = {},
): Promise<OfficeOutcomeAnswer> {
  const now = opts.now ?? new Date();
  const storedKey = `disp:${input.key}`;
  const loads = await truckDayLoads(prisma, tenantId, input.truckId, input.date);
  const load = loads.find((l) => l.loadNo === input.loadNo && l.depotId === input.depotId);
  if (!load) throw new OfficeOutcomeError('This stop is not on a plan in use for that day.', 404, 'STOP_NOT_FOUND');
  if (load.status !== 'DISPATCHED' && load.status !== 'COMPLETED') {
    throw new OfficeOutcomeError('A result can be recorded once the load is dispatched.', 409, 'LOAD_NOT_DISPATCHED');
  }
  const cfg = await prisma.tenantConfig.findFirst({ where: { tenantId }, select: { timezone: true, geofenceRadiusM: true } });
  const tz = cfg?.timezone || DEFAULT_TZ;
  const radiusM = Math.min(500, Math.max(50, cfg?.geofenceRadiusM ?? 100));
  const dayStart = zonedDayStart(input.date, tz);
  const timeOf = (hhmm: string | null | undefined) => {
    const m = parseHhmm(hhmm ?? null);
    return m === null ? null : new Date(dayStart.getTime() + m * 60_000);
  };
  const arrivedAt = timeOf(input.arrivedAt);
  const departedAt = timeOf(input.departedAt);
  if (arrivedAt && departedAt && departedAt <= arrivedAt) throw new OfficeOutcomeError('"Left" must be after "Arrived".', 422, 'INVALID');
  if ((arrivedAt && arrivedAt > now) || (departedAt && departedAt > now)) throw new OfficeOutcomeError('A time in the future cannot be recorded.', 422, 'INVALID');
  const planLoad = await prisma.planLoad.findFirst({ where: { id: load.id, tenantId }, select: { id: true, breakJson: true } });
  if (!planLoad) throw new OfficeOutcomeError('This stop is not on a plan in use for that day.', 404, 'STOP_NOT_FOUND');

  let conflict: Conflict[] | null = null;
  let answer: OfficeOutcomeAnswer;
  try {
    answer = await prisma.$transaction(
      async (tx): Promise<OfficeOutcomeAnswer> => {
        const planned = await plannedStopOf(tx, planLoad, input.sequence);
        if (!planned) throw new OfficeOutcomeError('This stop is not on the load.', 404, 'STOP_NOT_FOUND');
        // Undo needs the intake and day locks BEFORE the outcome-day lock (lock order, plan-locks.ts).
        // Which orders were brought forward is only a hint here (read before the locks): the basis rule
        // below reads it again under the outcome-day lock (carryBases), and an undo runs only for an
        // order whose locks were taken here.
        const carriedOrders = planned.orders.filter((o) => o.carriedToOrderId);
        const undoLocked = new Set<string>();
        if (input.undoCarry && carriedOrders.length) {
          await lockForUndo(
            tx,
            tenantId,
            carriedOrders.map((o) => o.orderId),
          );
          for (const o of carriedOrders) undoLocked.add(o.orderId);
        } else {
          await setLockTimeout(tx);
        }
        await lockOutcomesDay(tx, tenantId, load.depotId, input.date);
        // Idempotency under the lock: the same user's key answers "duplicate"; anyone else's is refused.
        const existing = await tx.stopEvent.findFirst({ where: { tenantId, idempotencyKey: storedKey }, select: { userId: true, visitId: true, kind: true, payloadJson: true } });
        if (existing) {
          if (existing.userId !== user.id) throw new OfficeOutcomeError('This entry could not be saved: open the dialog again.', 409, 'INVALID');
          if (existing.kind === 'CARRY_CONFLICT') {
            const p = (existing.payloadJson ?? {}) as { copyId?: string; copyDate?: string; copies?: { copyId: string; copyDate: string }[] };
            const copies = (p.copies ?? (p.copyId ? [{ copyId: p.copyId, copyDate: p.copyDate ?? '' }] : [])).map((c) => ({ copyId: c.copyId, copyDate: c.copyDate, undoable: false }));
            throw new OfficeOutcomeError('This change was already refused: the cases were brought forward.', 409, 'OUTCOME_CARRIED', { copyId: p.copyId ?? null, copyDate: p.copyDate ?? null, undoable: false, copies });
          }
          return { result: 'duplicate', visitId: existing.visitId };
        }
        const norm = normalizeResult(
          planned.lines.map((l) => ({ orderId: l.orderId, lineId: l.lineId, plannedCases: l.plannedCases })),
          { outcome: input.outcome, reason: input.reason ?? null, note: input.note ?? null, lines: input.lines ?? null },
        );
        if (!norm.ok) throw new OfficeOutcomeError(norm.message, 422, 'INVALID');
        const vk: VisitKey = { tenantId, depotId: load.depotId, date: input.date, truckId: input.truckId, loadNo: input.loadNo, sequence: input.sequence };
        const visit = await findVisit(tx, vk);
        // "Left" needs an arrival (typed now, or already stored) and must come after it.
        const arrivalForLeft = arrivedAt ?? visit?.arrivedAt ?? null;
        if (departedAt && !arrivalForLeft) throw new OfficeOutcomeError('Enter "Arrived" too: "Left" needs an arrival time.', 422, 'INVALID');
        if (departedAt && arrivalForLeft && departedAt <= arrivalForLeft) throw new OfficeOutcomeError('"Left" must be after "Arrived".', 422, 'INVALID');
        const after = new Map(planned.lines.map((l) => [l.lineId, 0]));
        if (norm.outcome !== null) for (const l of norm.lines) after.set(l.lineId, l.planned - l.delivered);
        const payload: Record<string, unknown> =
          norm.outcome === null
            ? { outcome: null, via: 'office' }
            : {
                outcome: norm.outcome,
                reason: norm.reason,
                note: norm.note,
                lines: norm.lines.map((l) => ({ lineId: l.lineId, delivered: l.delivered })),
                photoKeys: [],
                ...(norm.coerced ? { coerced: true } : {}),
                via: 'office',
              };
        const base = {
          tenantId,
          depotId: load.depotId,
          deliveryDate: dateOnly(input.date),
          truckId: input.truckId,
          loadNo: input.loadNo,
          sequence: input.sequence,
          userId: user.id,
          receivedAt: now,
        };
        // The basis rule (section 9.4), all or nothing. First every copy brought forward from this
        // visit whose cases the change would shrink is found and checked, before anything changes.
        // Only when there is none, or (undoCarry) every one of them can be removed, does anything
        // change: then the copies are removed and the result recorded below, in this transaction (an
        // error on the way rolls all of it back). Before, the copies were taken one at a time: the
        // first was removed, the second refused, and that removal was committed without the result.
        const carriesUndone: UndoCarryResult[] = [];
        if (visit) {
          const affected: { copyId: string; copyDate: string; originalId: string; lines: { lineId: string; carried: number; after: number }[]; can: Awaited<ReturnType<typeof undoCheck>> }[] = [];
          for (const c of await carryBases(tx, tenantId, planned)) {
            if (!inCarryBasis(c.basis, visit.id)) continue;
            const check = carryChangeCheck(c.basis, visit.id, after);
            if (check.ok) continue;
            affected.push({ copyId: c.copyId, copyDate: c.copyDate, originalId: c.originalId, lines: check.lines, can: await undoCheck(tx, tenantId, c.originalId) });
          }
          // An undo runs only for an order whose locks were taken above (its carry read before them).
          const removable = affected.every((a) => a.can.ok && undoLocked.has(a.originalId));
          if (affected.length && input.undoCarry && removable) {
            for (const a of affected) carriesUndone.push(await undoCarryTx(tx, tenantId, a.originalId, user, { ip: opts.ip }));
          } else if (affected.length) {
            // Refused: nothing is removed and no result recorded. Each copy keeps a CARRY_CONFLICT event
            // (it warns on that copy's plan) and an audit row; the first event holds the request's key
            // (a repeat of the request answers from it) and the list of every copy.
            for (const [i, a] of affected.entries()) {
              await tx.stopEvent.create({
                data: {
                  ...base,
                  visitId: visit.id,
                  kind: 'CARRY_CONFLICT',
                  source: 'DISPATCHER',
                  at: now,
                  idempotencyKey: i === 0 ? storedKey : `${storedKey}:copy:${a.copyId}`,
                  payloadJson: {
                    refused: payload,
                    copyId: a.copyId,
                    copyDate: a.copyDate,
                    lines: a.lines,
                    by: user.name,
                    ...(i === 0 ? { copies: affected.map((x) => ({ copyId: x.copyId, copyDate: x.copyDate })) } : {}),
                  } as Prisma.InputJsonValue,
                },
              });
              await audit(
                {
                  tenantId,
                  userId: user.id,
                  action: 'DELIVERY_CARRY_CONFLICT',
                  entity: 'StopVisit',
                  entityId: visit.id,
                  afterJson: { truckId: input.truckId, loadNo: input.loadNo, sequence: input.sequence, date: input.date, refusedOutcome: norm.outcome, copyDate: a.copyDate, lines: a.lines, via: 'office' } as Prisma.InputJsonValue,
                  ...(opts.ip ? { ip: opts.ip } : {}),
                },
                tx,
              );
            }
            conflict = affected.map((a) => ({ copyId: a.copyId, copyDate: a.copyDate, undoable: a.can.ok, text: a.can.ok ? '' : a.can.text, code: a.can.ok ? null : a.can.code }));
            return { result: 'ok', visitId: visit.id };
          }
        }
        const v = visit ?? (await ensureVisit(tx, vk, planned, load.id));
        // What this entry replaces, as the weekly review needs it: whose result it was and whether it
        // was saved without a photo ("Camera not working"); the driver's own mark stays on the visit.
        const before = {
          outcome: v.outcome ?? null,
          reason: v.reason ?? null,
          casesDelivered: v.casesDelivered ?? null,
          arrivedAt: v.arrivedAt?.toISOString() ?? null,
          departedAt: v.departedAt?.toISOString() ?? null,
          outcomeSource: v.outcomeSource ?? null,
          noPhotoReason: v.noPhotoReason ?? null,
          photoCount: v.photoCount ?? 0,
        };
        if (arrivedAt) {
          await tx.stopEvent.create({ data: { ...base, visitId: v.id, kind: 'ARRIVED', source: 'DISPATCHER', at: arrivedAt, idempotencyKey: `${storedKey}:arrived`, payloadJson: { mode: 'OFFICE' } } });
        }
        if (departedAt) {
          await tx.stopEvent.create({ data: { ...base, visitId: v.id, kind: 'DEPARTED', source: 'DISPATCHER', at: departedAt, idempotencyKey: `${storedKey}:departed`, payloadJson: { reason: 'LEFT', mode: 'OFFICE' } } });
        }
        // The office's result is the latest (its time is now, and never at or before a result already
        // stored for the stop, even within the same millisecond): a correction always wins.
        const lastResult = await tx.stopEvent.findFirst({ where: { tenantId, visitId: v.id, kind: 'OUTCOME' }, orderBy: [{ at: 'desc' }], select: { at: true } });
        const at = new Date(Math.max(now.getTime(), (lastResult?.at.getTime() ?? 0) + 1));
        await tx.stopEvent.create({ data: { ...base, visitId: v.id, kind: 'OUTCOME', source: 'DISPATCHER', at, idempotencyKey: storedKey, payloadJson: payload as Prisma.InputJsonValue } });
        const rebuilt = await rebuildVisit(tx, v, { dayStart, radiusM, breakMin: planned.breakMin });
        await audit(
          {
            tenantId,
            userId: user.id,
            action: 'DELIVERY_OUTCOME_SET',
            entity: 'StopVisit',
            entityId: v.id,
            beforeJson: before as Prisma.InputJsonValue,
            afterJson: {
              truckId: input.truckId,
              loadNo: input.loadNo,
              sequence: input.sequence,
              date: input.date,
              customerCode: planned.customerCode,
              source: 'DISPATCHER',
              outcome: rebuilt.outcome,
              reason: rebuilt.reason,
              casesDelivered: rebuilt.casesDelivered,
              casesPlanned: rebuilt.casesPlanned,
              arrivedAt: rebuilt.arrivedAt?.toISOString() ?? null,
              departedAt: rebuilt.departedAt?.toISOString() ?? null,
              correction: !!before.outcome,
              loadStatus: load.status,
              // The driver's own result saved with "Camera not working": kept on every monitor.
              ...(rebuilt.driverNoPhotoReason ? { driverNoPhotoReason: rebuilt.driverNoPhotoReason, driverResultOutcome: rebuilt.driverResultOutcome } : {}),
              ...(carriesUndone.length
                ? {
                    carryUndone: { copyId: carriesUndone[0]!.copyId, copyDate: carriesUndone[0]!.copyDate },
                    carriesUndone: carriesUndone.map((u) => ({ copyId: u.copyId, copyDate: u.copyDate })),
                  }
                : {}),
            } as Prisma.InputJsonValue,
            ...(opts.ip ? { ip: opts.ip } : {}),
          },
          tx,
        );
        return { result: 'ok', visitId: v.id, ...(carriesUndone.length ? { carryUndone: carriesUndone[0], carriesUndone } : {}) };
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (isLockBusy(e)) throw new PlanBusyError();
    if (isUniqueViolation(e)) {
      // A concurrent request stored the key: answered from a fresh read outside the aborted transaction.
      const ev = await prisma.stopEvent.findFirst({ where: { tenantId, idempotencyKey: storedKey }, select: { userId: true, visitId: true } });
      if (ev && ev.userId === user.id) return { result: 'duplicate', visitId: ev.visitId };
      throw new OfficeOutcomeError('This entry could not be saved: open the dialog again.', 409, 'INVALID');
    }
    throw e;
  }
  const copies = conflict as Conflict[] | null;
  if (copies?.length) {
    // copyId / copyDate (what the answer had before several copies were named): the first copy that
    // blocks the undo, else the first copy.
    const first = copies.find((c) => !c.undoable) ?? copies[0]!;
    throw new OfficeOutcomeError(carriedRefusalText(copies), 409, 'OUTCOME_CARRIED', {
      copyId: first.copyId,
      copyDate: first.copyDate,
      undoable: copies.every((c) => c.undoable),
      copies: copies.map((c) => ({ copyId: c.copyId, copyDate: c.copyDate, undoable: c.undoable, ...(c.code ? { code: c.code } : {}) })),
    });
  }
  // A load that is back at the depot closes once every stop has a result (the driver's rule, section
  // 8.7). The dispatcher recorded that last result: the LOAD_COMPLETED row is theirs.
  if (answer.result === 'ok' && load.status === 'DISPATCHED') {
    const completed = await maybeCompleteLoad(tenantId, input.truckId, input.date, { depotId: load.depotId, loadNo: input.loadNo }, undefined, { userId: user.id, label: null });
    if (completed) answer.loadCompleted = true;
  }
  return answer;
}

/**
 * GET /api/delivery-photos/<id>: a delivery photo for a signed-in user of the company (any role).
 * 404 NOT_FOUND, 404 PHOTO_PURGED after the retention. Filename "T05-L1-stop3-1.jpg".
 */
export async function readOfficePhoto(tenantId: string, photoId: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const notFound = () => new OfficeOutcomeError('Photo not found.', 404, 'NOT_FOUND');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(photoId)) throw notFound();
  const photo = await prisma.deliveryPhoto.findFirst({ where: { id: photoId, tenantId }, select: { id: true, visitId: true, bytes: true, purgedAt: true, receivedAt: true } });
  if (!photo) throw notFound();
  const visit = await prisma.stopVisit.findFirst({ where: { id: photo.visitId, tenantId }, select: { id: true, truckId: true, loadNo: true, sequence: true } });
  if (!visit) throw notFound();
  if (!photo.bytes || photo.purgedAt) {
    const cfg = await prisma.tenantConfig.findFirst({ where: { tenantId }, select: { photoRetentionDays: true } });
    throw new OfficeOutcomeError(`Photo removed after ${cfg?.photoRetentionDays ?? DEFAULT_PHOTO_RETENTION_DAYS} days (retention).`, 404, 'PHOTO_PURGED');
  }
  const [truck, siblings] = await Promise.all([
    prisma.truck.findFirst({ where: { id: visit.truckId, tenantId }, select: { code: true, onlyOnDate: true } }),
    prisma.deliveryPhoto.findMany({ where: { tenantId, visitId: visit.id }, select: { id: true, takenAt: true } }),
  ]);
  const n = [...siblings].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime()).findIndex((s) => s.id === photo.id) + 1;
  // The plate it drove with that day: a past day's hired truck whose plate a later day's truck took is
  // "12345AB.261006" (hire.ts shownTruckCode), as on the plan, the sheets and the day's results.
  const code = (truck ? shownTruckCode(null, truck) : 'truck').replace(/[^A-Za-z0-9_-]/g, '');
  return { bytes: new Uint8Array(photo.bytes), filename: `${code}-L${visit.loadNo}-stop${visit.sequence}-${Math.max(1, n)}.jpg` };
}
