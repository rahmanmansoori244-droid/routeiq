/**
 * Delivery photos from the driver page (owner request 4 Oct 2026, spec sections 12.2 and 12.3).
 * Server only. A photo is a compressed JPEG stored in PostgreSQL (DeliveryPhoto.bytes), stripped of
 * every piece of metadata before it is stored (stripJpeg): no EXIF GPS, maker data or thumbnails.
 *
 * - The file must be a whole JPEG by its bytes (415 NOT_JPEG), at most 4000 px a side.
 * - The key is a lowercase UUID stored as dlphoto:<uuid>: the same key and bytes from the same link
 *   answer "duplicate"; the same key with other bytes 409 KEY_REUSED; another link's key "refused".
 * - At most 3 driver photos per stop and 3 x the truck-day's stops + 10 per link (409 PHOTO_LIMIT).
 * - The capture time is skew-corrected and clamped to [day start - 6 h, receipt]; in the upload grace
 *   it must be before the link's expiry.
 * - The photo, its PHOTO stop event and the visit's photo count are written under the same
 *   outcome-day lock and visit rules as a result (section 8.3).
 */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db';
import { audit } from '../audit';
import { HttpError } from '../http-error';
import { setLockTimeout } from '../dispatch/plan-locks';
import { distanceM } from '../dispatch/snapshots';
import { dateOnly, isoOf } from '../dispatch/time';
import { PHOTO_POSITION_STATUSES, type DriverActionResult } from '../driver-link/manifest-types';
import { lockOutcomesDay } from './locks';
import { plannedStopOf } from './planned-stop';
import { clockSkewMs, MAX_DRIVER_PHOTOS_PER_STOP, photoTime, REFUSAL_TEXT, writeRule } from './outcome-rules';
import { dayFacts, ensureVisit, findVisit, liveLoad, parseStopKey, rebuildVisit, UUID_RE, writerAudit, type DriverWriteContext } from './event-service';
import { inspectJpeg, readExif, startsLikeJpeg, stripJpeg } from './jpeg';

/** The request limit (multipart overhead included) and the file limit. */
export const MAX_PHOTO_REQUEST_BYTES = 1_600_000;
export const MAX_PHOTO_BYTES = 1_500_000;
/** A photo whose EXIF or file time is this long before the arrival (or the dispatch) is "taken earlier". */
export const OLD_PHOTO_MS = 15 * 60_000;
/** A position with accuracy up to this is OK; worse is POOR. */
export const PHOTO_OK_ACCURACY_M = 100;

const iso = z.string().min(10).max(40);
export const photoMetaSchema = z.object({
  key: z.string().max(64),
  stop: z.string().regex(/^\d{1,3}:\d{1,4}$/),
  takenAt: iso,
  clientNow: iso,
  positionStatus: z.enum(PHOTO_POSITION_STATUSES),
  pos: z
    .object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180), accuracyM: z.number().gte(0).lte(100_000), at: iso.nullish() })
    .nullish(),
  exif: z
    .object({ lat: z.number().gte(-90).lte(90).nullish(), lng: z.number().gte(-180).lte(180).nullish(), takenAt: iso.nullish(), zoned: z.boolean().nullish() })
    .nullish(),
  fileLastModified: iso.nullish(),
  /** Sent by older pages (computed on the phone's clock): ignored, the server decides on one clock. */
  oldPhoto: z.boolean().optional(),
});
export type PhotoMeta = z.infer<typeof photoMetaSchema>;

export class PhotoError extends HttpError {
  constructor(message: string, status: number, code: string, extra: Record<string, unknown> = {}) {
    super(message, status, { code, ...extra });
    this.name = 'PhotoError';
  }
}

export interface PhotoAnswer {
  photoId: string | null;
  status: 'ok' | 'duplicate' | 'refused';
  code?: string;
  message?: { en: string; ar: string };
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function refusedPhoto(r: DriverActionResult): PhotoAnswer {
  return { photoId: null, status: 'refused', code: r.code, message: r.message };
}

const date = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The position status kept with the photo: OK needs a position of at most 100 m accuracy; a position
 * worse than that is POOR; without a position the phone's reason (DENIED, TIMEOUT, UNSUPPORTED).
 */
export function positionStatusOf(meta: Pick<PhotoMeta, 'pos' | 'positionStatus'>): (typeof PHOTO_POSITION_STATUSES)[number] {
  if (meta.pos) return meta.pos.accuracyM <= PHOTO_OK_ACCURACY_M ? 'OK' : 'POOR';
  return meta.positionStatus === 'OK' || meta.positionStatus === 'POOR' ? 'TIMEOUT' : meta.positionStatus;
}

/**
 * "Taken earlier": the photo's file time or EXIF time more than 15 min before the arrival (or the
 * dispatch), all on the SERVER clock (pure). The arrival is stored skew-corrected, so the phone's
 * times get the same correction first: a phone running 20 min slow does not flag every genuine photo.
 * An EXIF time without its own offset is a local phone time read in the company zone (a phone left
 * on another zone would be hours off): it is ignored.
 */
export function isOldPhotoOnServerClock(a: { reference: Date | null; skewMs: number; fileLastModified: Date | null; exif: { takenAt: Date | null; zoned: boolean } | null }): boolean {
  if (!a.reference) return false;
  const limit = a.reference.getTime() - OLD_PHOTO_MS;
  const times = [a.fileLastModified, a.exif?.zoned ? a.exif.takenAt : null].filter((t): t is Date => !!t && Number.isFinite(t.getTime()));
  return times.some((t) => t.getTime() + a.skewMs < limit);
}

/** POST /api/d/photos: store one photo (see the top). Throws PhotoError for 409 / 415. */
export async function recordDriverPhoto(ctx: DriverWriteContext, meta: PhotoMeta, file: Uint8Array): Promise<PhotoAnswer> {
  if (!UUID_RE.test(meta.key)) return refusedPhoto({ key: meta.key, status: 'refused', code: 'INVALID', message: REFUSAL_TEXT.INVALID });
  if (file.length > MAX_PHOTO_BYTES) throw new PhotoError('Photo too large: retake it.', 413, 'PHOTO_TOO_LARGE');
  if (!startsLikeJpeg(file) || !inspectJpeg(file)) throw new PhotoError('Only JPEG photos are accepted.', 415, 'NOT_JPEG');
  const facts = await dayFacts(ctx);
  const exifBytes = readExif(file, facts.tz);
  const stored = stripJpeg(file);
  const info = inspectJpeg(stored);
  if (!info) throw new PhotoError('Only JPEG photos are accepted.', 415, 'NOT_JPEG');
  const hash = sha256(stored);
  const storedKey = `dlphoto:${meta.key}`;
  const where = parseStopKey(meta.stop);
  const dayLoad = where ? liveLoad(facts, where.loadNo) : null;
  if (!where || !dayLoad) return refusedPhoto({ key: meta.key, status: 'refused', code: 'STOP_NOT_FOUND', message: REFUSAL_TEXT.STOP_NOT_FOUND });
  const skew = clockSkewMs(ctx.now, date(meta.clientNow));
  const rawTakenAt = date(meta.takenAt);
  const takenAt = photoTime(rawTakenAt ?? ctx.now, skew, { receivedAt: ctx.now, dayStart: facts.dayStart });
  if (takenAt.getTime() > ctx.link.expiresAt.getTime()) return refusedPhoto({ key: meta.key, status: 'refused', code: 'TIME_OUT_OF_RANGE', message: REFUSAL_TEXT.TIME_OUT_OF_RANGE });
  const office = !!ctx.session;
  const maxForDay = 3 * (await stopCount(dayLoadIds(facts))) + 10;
  // The daily cap is a soft limit: counted before the outcome-day lock (index driverLinkId), so the
  // lock every arrival and result of the depot-day waits on is held only for the write itself.
  const usedToday = office ? 0 : await prisma.deliveryPhoto.count({ where: { tenantId: ctx.tenantId, driverLinkId: ctx.link.id } });
  if (!office && usedToday >= maxForDay) throw new PhotoError('Too many photos for this truck today. Call your dispatcher.', 409, 'PHOTO_LIMIT', { daily: true });

  return prisma.$transaction(
    async (tx): Promise<PhotoAnswer> => {
      await setLockTimeout(tx);
      // The lock first: the load, the stop and the visit are read under it.
      await lockOutcomesDay(tx, ctx.tenantId, dayLoad.depotId, ctx.date);
      const load = await tx.planLoad.findFirst({ where: { id: dayLoad.id, tenantId: ctx.tenantId }, select: { id: true, status: true, statusChangedAt: true, breakJson: true, runId: true } });
      if (!load) return refusedPhoto({ key: meta.key, status: 'refused', code: 'STOP_NOT_FOUND', message: REFUSAL_TEXT.STOP_NOT_FOUND });
      const planned = await plannedStopOf(tx, load, where.sequence);
      if (!planned) return refusedPhoto({ key: meta.key, status: 'refused', code: 'STOP_NOT_FOUND', message: REFUSAL_TEXT.STOP_NOT_FOUND });
      const existing = await tx.deliveryPhoto.findFirst({ where: { tenantId: ctx.tenantId, idempotencyKey: storedKey }, select: { id: true, driverLinkId: true, sha256: true } });
      if (existing) {
        if (existing.driverLinkId !== ctx.link.id) return refusedPhoto({ key: meta.key, status: 'refused', code: 'INVALID', message: REFUSAL_TEXT.INVALID });
        if (existing.sha256 !== hash) throw new PhotoError('This photo key was already used for another photo.', 409, 'KEY_REUSED');
        return { photoId: existing.id, status: 'duplicate' };
      }
      const rule = writeRule({
        kind: 'PHOTO',
        office,
        loadStatus: load.status,
        at: takenAt,
        statusChangedAt: load.statusChangedAt,
        hadResultAtCompletion: false,
        receivedAt: ctx.now,
        expiresAt: ctx.link.expiresAt,
      });
      if (!rule.ok) return refusedPhoto({ key: meta.key, status: 'refused', code: rule.code, message: REFUSAL_TEXT[rule.code] });
      const vk = { tenantId: ctx.tenantId, depotId: dayLoad.depotId, date: ctx.date, truckId: ctx.truckId, loadNo: where.loadNo, sequence: where.sequence };
      const found = await findVisit(tx, vk);
      if (found && !office) {
        const n = await tx.deliveryPhoto.count({ where: { tenantId: ctx.tenantId, visitId: found.id, source: { not: 'DISPATCHER' } } });
        if (n >= MAX_DRIVER_PHOTOS_PER_STOP) throw new PhotoError(`At most ${MAX_DRIVER_PHOTOS_PER_STOP} photos per stop.`, 409, 'PHOTO_LIMIT');
      }
      const visit = found ?? (await ensureVisit(tx, vk, planned, dayLoad.id));
      const pin = planned.pin;
      const pos = meta.pos ?? null;
      const exifLat = exifBytes?.lat ?? meta.exif?.lat ?? null;
      const exifLng = exifBytes?.lng ?? meta.exif?.lng ?? null;
      const exifTakenAt = exifBytes?.takenAt ?? date(meta.exif?.takenAt);
      const reference = visit.arrivedAt ?? (load.status === 'DISPATCHED' ? load.statusChangedAt : null);
      const oldPhoto = isOldPhotoOnServerClock({
        reference,
        skewMs: skew,
        fileLastModified: date(meta.fileLastModified),
        exif: exifBytes?.takenAt ? { takenAt: exifBytes.takenAt, zoned: exifBytes.zoned } : meta.exif?.takenAt ? { takenAt: date(meta.exif.takenAt), zoned: meta.exif.zoned === true } : null,
      });
      const positionStatus = positionStatusOf(meta);
      const photo = await tx.deliveryPhoto.create({
        data: {
          tenantId: ctx.tenantId,
          visitId: visit.id,
          idempotencyKey: storedKey,
          source: office ? 'DISPATCHER' : 'PHONE_MANUAL',
          driverLinkId: ctx.link.id,
          userId: ctx.session?.userId ?? null,
          clientIp: ctx.ip,
          deviceId: ctx.deviceId,
          takenAt,
          rawTakenAt,
          receivedAt: ctx.now,
          positionStatus,
          lat: pos?.lat ?? null,
          lng: pos?.lng ?? null,
          accuracyM: pos?.accuracyM ?? null,
          distanceM: pos && pin ? Math.round(distanceM(pos, pin)) : null,
          exifLat: exifLat !== null && exifLng !== null ? exifLat : null,
          exifLng: exifLat !== null && exifLng !== null ? exifLng : null,
          exifTakenAt,
          exifDistanceM: exifLat !== null && exifLng !== null && pin ? Math.round(distanceM({ lat: exifLat, lng: exifLng }, pin)) : null,
          oldPhoto,
          contentType: 'image/jpeg',
          byteSize: stored.length,
          width: info.width,
          height: info.height,
          sha256: hash,
          bytes: Buffer.from(stored),
        },
        select: { id: true },
      });
      await tx.stopEvent.create({
        data: {
          tenantId: ctx.tenantId,
          depotId: dayLoad.depotId,
          deliveryDate: dateOnly(ctx.date),
          truckId: ctx.truckId,
          loadNo: where.loadNo,
          sequence: where.sequence,
          visitId: visit.id,
          kind: 'PHOTO',
          source: office ? 'DISPATCHER' : 'PHONE_MANUAL',
          at: takenAt,
          receivedAt: ctx.now,
          lat: positionStatus === 'OK' ? (pos?.lat ?? null) : null,
          lng: positionStatus === 'OK' ? (pos?.lng ?? null) : null,
          accuracyM: pos?.accuracyM ?? null,
          distanceM: pos && pin ? Math.round(distanceM(pos, pin)) : null,
          driverLinkId: ctx.link.id,
          linkGeneration: ctx.link.generation,
          userId: ctx.session?.userId ?? null,
          clientIp: ctx.ip,
          deviceId: ctx.deviceId,
          idempotencyKey: storedKey,
          payloadJson: { photoId: photo.id, ...(rule.late ? { late: true } : {}), ...(skew ? { clockSkewMs: skew } : {}) } as Prisma.InputJsonValue,
        },
      });
      await rebuildVisit(tx, visit, { dayStart: facts.dayStart, radiusM: facts.radiusM, breakMin: planned.breakMin });
      const who = writerAudit(ctx, facts, dayLoad);
      await audit(
        {
          tenantId: ctx.tenantId,
          userId: who.userId,
          action: 'DELIVERY_PHOTO_ADDED',
          entity: 'StopVisit',
          entityId: visit.id,
          afterJson: {
            photoId: photo.id,
            truckId: ctx.truckId,
            loadNo: where.loadNo,
            sequence: where.sequence,
            date: ctx.date,
            positionStatus,
            byteSize: stored.length,
            oldPhoto,
            late: rule.late,
            ...who.extra,
          } as Prisma.InputJsonValue,
          ip: who.ip,
        },
        tx,
      );
      return { photoId: photo.id, status: 'ok' };
    },
    { timeout: 20_000, maxWait: 5_000 },
  );
}

function dayLoadIds(facts: { loads: { id: string }[] }): string[] {
  return facts.loads.map((l) => l.id);
}

/** The number of stops of the truck-day's live loads (the daily photo cap is 3 per stop + 10). */
async function stopCount(loadIds: string[]): Promise<number> {
  if (!loadIds.length) return 0;
  const rows = await prisma.routeAssignment.findMany({ where: { loadId: { in: loadIds } }, select: { loadId: true, sequenceInTruck: true } });
  return new Set(rows.map((r) => `${r.loadId}:${r.sequenceInTruck}`)).size;
}

export interface PhotoFile {
  bytes: Uint8Array;
  filename: string;
}

/**
 * GET /api/d/photos/<id>: a photo of this truck-day only (404 otherwise, and 404 PHOTO_PURGED once
 * the retention janitor dropped its bytes). Filename "T05-L1-stop3-1.jpg".
 */
export async function readTruckDayPhoto(ctx: Pick<DriverWriteContext, 'tenantId' | 'truckId' | 'date'>, photoId: string): Promise<PhotoFile> {
  const notFound = () => new PhotoError('Photo not found.', 404, 'NOT_FOUND');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(photoId)) throw notFound();
  const photo = await prisma.deliveryPhoto.findFirst({ where: { id: photoId, tenantId: ctx.tenantId }, select: { id: true, visitId: true, bytes: true, purgedAt: true } });
  if (!photo) throw notFound();
  const visit = await prisma.stopVisit.findFirst({ where: { id: photo.visitId, tenantId: ctx.tenantId }, select: { id: true, truckId: true, deliveryDate: true, loadNo: true, sequence: true } });
  if (!visit || visit.truckId !== ctx.truckId || isoOf(visit.deliveryDate) !== ctx.date) throw notFound();
  if (!photo.bytes || photo.purgedAt) throw new PhotoError('Photo removed after the retention period.', 404, 'PHOTO_PURGED');
  const [truck, siblings] = await Promise.all([
    prisma.truck.findFirst({ where: { id: ctx.truckId, tenantId: ctx.tenantId }, select: { code: true } }),
    prisma.deliveryPhoto.findMany({ where: { tenantId: ctx.tenantId, visitId: visit.id }, select: { id: true, takenAt: true } }),
  ]);
  const n = [...siblings].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime()).findIndex((s) => s.id === photo.id) + 1;
  const code = (truck?.code ?? 'truck').replace(/[^A-Za-z0-9_-]/g, '');
  return { bytes: new Uint8Array(photo.bytes), filename: `${code}-L${visit.loadNo}-stop${visit.sequence}-${Math.max(1, n)}.jpg` };
}

/** The headers of a served photo (spec section 12.3). */
export function photoHeaders(filename: string, cache: 'no-store' | 'private'): Record<string, string> {
  return {
    'Content-Type': 'image/jpeg',
    'Content-Disposition': `inline; filename="${filename}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': cache === 'no-store' ? 'no-store' : 'private, max-age=86400',
  };
}
