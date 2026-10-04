/**
 * The dispatcher's side of delivery results (owner request 4 Oct 2026, Part 3, spec sections 8.3,
 * 9.4 and 10.2). Server only.
 *
 * "Record outcome" on the plan screen (POST /api/dispatch/outcomes): a result, or a correction, for
 * any stop of a load that left (DISPATCHED or COMPLETED), at any time - a driver without a phone, a
 * forgotten stop, a wrong tap. It is stored as an event of source DISPATCHER with the user's id (key
 * `disp:<uuid>`, so a double click records once), rebuilds the visit (visit.ts) and is audited
 * DELIVERY_OUTCOME_SET with before and after. The office is not held to "photo required". Optional
 * Arrived / Left times (HH:MM) are stored as DISPATCHER arrival and departure events: an office
 * arrival overrides the phone's.
 *
 * The carry basis rule (section 9.4): a change that would shrink cases already brought forward from
 * this visit is refused 409 OUTCOME_CARRIED and kept as a CARRY_CONFLICT event (it warns on the
 * copy's plan). When the copy is on no plan yet the answer says `undoable`, and the dialog offers
 * "Undo the bring forward and record this result": the same request with `undoCarry: true` removes
 * the copy and records the result in ONE transaction (locks: intake, day locks, outcome-day lock).
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../audit';
import { HttpError } from '../http-error';
import { isLockBusy, PlanBusyError, setLockTimeout } from '../dispatch/plan-locks';
import { DEFAULT_TZ, dateOnly, fmtDayMonth, parseHhmm, zonedDayStart } from '../dispatch/time';
import { isoDateSchema } from '../schemas';
import { lockForUndo, undoCheck, undoCarryTx, type UndoCarryResult } from '../dispatch/carry-over';
import { truckDayLoads } from '../driver-link/service';
import { NOT_DELIVERED_REASONS } from '../driver-link/manifest-types';
import { lockOutcomesDay } from './locks';
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
  /** The bring forward that was undone first (undoCarry: true). */
  carryUndone?: UndoCarryResult;
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

type Conflict = { copyId: string; copyDate: string; undoable: boolean; text: string };

/**
 * POST /api/dispatch/outcomes. `user`: the signed-in dispatcher (PLANNER+, checked by the route).
 * 404 STOP_NOT_FOUND, 409 LOAD_NOT_DISPATCHED, 422 INVALID, 409 OUTCOME_CARRIED { copyId, copyDate,
 * undoable }, 409 PLAN_BUSY (a lock timed out: try again).
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

  let conflict: Conflict | null = null;
  let answer: OfficeOutcomeAnswer;
  try {
    answer = await prisma.$transaction(
      async (tx): Promise<OfficeOutcomeAnswer> => {
        const planned = await plannedStopOf(tx, planLoad, input.sequence);
        if (!planned) throw new OfficeOutcomeError('This stop is not on the load.', 404, 'STOP_NOT_FOUND');
        // Undo needs the intake and day locks BEFORE the outcome-day lock (lock order, plan-locks.ts).
        const carriedOrders = planned.orders.filter((o) => o.carriedToOrderId);
        if (input.undoCarry && carriedOrders.length) {
          await lockForUndo(
            tx,
            tenantId,
            carriedOrders.map((o) => o.orderId),
          );
        } else {
          await setLockTimeout(tx);
        }
        await lockOutcomesDay(tx, tenantId, load.depotId, input.date);
        // Idempotency under the lock: the same user's key answers "duplicate"; anyone else's is refused.
        const existing = await tx.stopEvent.findFirst({ where: { tenantId, idempotencyKey: storedKey }, select: { userId: true, visitId: true, kind: true, payloadJson: true } });
        if (existing) {
          if (existing.userId !== user.id) throw new OfficeOutcomeError('This entry could not be saved: open the dialog again.', 409, 'INVALID');
          if (existing.kind === 'CARRY_CONFLICT') {
            const p = (existing.payloadJson ?? {}) as { copyId?: string; copyDate?: string };
            throw new OfficeOutcomeError('This change was already refused: the cases were brought forward.', 409, 'OUTCOME_CARRIED', { copyId: p.copyId ?? null, copyDate: p.copyDate ?? null, undoable: false });
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
        // The basis rule (section 9.4).
        let carryUndone: UndoCarryResult | undefined;
        if (visit) {
          for (const c of await carryBases(tx, tenantId, planned)) {
            if (!inCarryBasis(c.basis, visit.id)) continue;
            const check = carryChangeCheck(c.basis, visit.id, after);
            if (check.ok) continue;
            const original = planned.orders.find((o) => o.carriedToOrderId === c.copyId);
            const can = original ? await undoCheck(tx, tenantId, original.orderId) : null;
            if (input.undoCarry && original && can?.ok) {
              carryUndone = await undoCarryTx(tx, tenantId, original.orderId, user, { ip: opts.ip });
              continue;
            }
            // Refused: kept as a CARRY_CONFLICT event (it warns on the copy's plan), nothing else changes.
            await tx.stopEvent.create({
              data: {
                ...base,
                visitId: visit.id,
                kind: 'CARRY_CONFLICT',
                source: 'DISPATCHER',
                at: now,
                idempotencyKey: storedKey,
                payloadJson: { refused: payload, copyId: c.copyId, copyDate: c.copyDate, lines: check.lines, by: user.name } as Prisma.InputJsonValue,
              },
            });
            await audit(
              {
                tenantId,
                userId: user.id,
                action: 'DELIVERY_CARRY_CONFLICT',
                entity: 'StopVisit',
                entityId: visit.id,
                afterJson: { truckId: input.truckId, loadNo: input.loadNo, sequence: input.sequence, date: input.date, refusedOutcome: norm.outcome, copyDate: c.copyDate, lines: check.lines, via: 'office' } as Prisma.InputJsonValue,
                ...(opts.ip ? { ip: opts.ip } : {}),
              },
              tx,
            );
            conflict = { copyId: c.copyId, copyDate: c.copyDate, undoable: !!can?.ok, text: can && !can.ok ? can.text : '' };
            return { result: 'ok', visitId: visit.id };
          }
        }
        const v = visit ?? (await ensureVisit(tx, vk, planned, load.id));
        const before = {
          outcome: v.outcome ?? null,
          reason: v.reason ?? null,
          casesDelivered: v.casesDelivered ?? null,
          arrivedAt: v.arrivedAt?.toISOString() ?? null,
          departedAt: v.departedAt?.toISOString() ?? null,
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
              ...(carryUndone ? { carryUndone: { copyId: carryUndone.copyId, copyDate: carryUndone.copyDate } } : {}),
            } as Prisma.InputJsonValue,
            ...(opts.ip ? { ip: opts.ip } : {}),
          },
          tx,
        );
        return { result: 'ok', visitId: v.id, ...(carryUndone ? { carryUndone } : {}) };
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
  const c = conflict as Conflict | null;
  if (c) {
    const day = fmtDayMonth(c.copyDate);
    throw new OfficeOutcomeError(
      c.undoable
        ? `These cases were brought forward to ${day} and that copy is not planned yet. Undo the bring forward to record this result.`
        : c.text || `These cases were brought forward to ${day}: the result cannot shrink them.`,
      409,
      'OUTCOME_CARRIED',
      { copyId: c.copyId, copyDate: c.copyDate, undoable: c.undoable },
    );
  }
  // A load that is back at the depot closes once every stop has a result (the driver's rule, section 8.7).
  if (answer.result === 'ok' && load.status === 'DISPATCHED') {
    const completed = await maybeCompleteLoad(tenantId, input.truckId, input.date, input.loadNo);
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
    throw new OfficeOutcomeError(`Photo removed after ${cfg?.photoRetentionDays ?? 365} days (retention).`, 404, 'PHOTO_PURGED');
  }
  const [truck, siblings] = await Promise.all([
    prisma.truck.findFirst({ where: { id: visit.truckId, tenantId }, select: { code: true } }),
    prisma.deliveryPhoto.findMany({ where: { tenantId, visitId: visit.id }, select: { id: true, takenAt: true } }),
  ]);
  const n = [...siblings].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime()).findIndex((s) => s.id === photo.id) + 1;
  const code = (truck?.code ?? 'truck').replace(/[^A-Za-z0-9_-]/g, '');
  return { bytes: new Uint8Array(photo.bytes), filename: `${code}-L${visit.loadNo}-stop${visit.sequence}-${Math.max(1, n)}.jpg` };
}
