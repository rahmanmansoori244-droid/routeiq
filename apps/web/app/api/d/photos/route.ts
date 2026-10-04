import { driverFail, driverOk, withDriverLink } from '@/lib/driver-link/guard';
import { truckDayResultsFromDb } from '@/lib/delivery/event-service';
import { MAX_PHOTO_BYTES, MAX_PHOTO_REQUEST_BYTES, photoMetaSchema, recordDriverPhoto } from '@/lib/delivery/photo-service';
import { prisma } from '@/lib/db';
import { LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/d/photos - one delivery photo from the driver page (owner request 4 Oct 2026, spec
// section 12): multipart with `meta` (JSON) and `file` (JPEG). Content-Length is required (411) and at
// most 1.6 MB (413); the file must be a JPEG by its bytes (415). All metadata is stripped before it is
// stored. At most 3 driver photos per stop (409 PHOTO_LIMIT). Accepted in the upload grace for photos
// taken before the link expired.
export const POST = withDriverLink(
  async (req, ctx) => {
    const lenHeader = req.headers.get('content-length');
    if (lenHeader === null || lenHeader.trim() === '') return driverFail({ code: 'LENGTH_REQUIRED', message: 'Content-Length is required.' }, 411);
    const declared = Number(lenHeader);
    if (!Number.isFinite(declared) || declared < 0) return driverFail({ code: 'LENGTH_REQUIRED', message: 'Content-Length is required.' }, 411);
    if (declared > MAX_PHOTO_REQUEST_BYTES) return driverFail({ code: 'PHOTO_TOO_LARGE', message: 'Photo too large: retake it.' }, 413);
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return driverFail({ code: 'BAD_BODY', message: 'The photo could not be read.' }, 400);
    }
    const metaRaw = form.get('meta');
    const file = form.get('file');
    if (typeof metaRaw !== 'string' || !file || typeof file === 'string') return driverFail({ code: 'BAD_BODY', message: 'The photo could not be read.' }, 400);
    if (file.size > MAX_PHOTO_BYTES) return driverFail({ code: 'PHOTO_TOO_LARGE', message: 'Photo too large: retake it.' }, 413);
    let metaJson: unknown;
    try {
      metaJson = JSON.parse(metaRaw);
    } catch {
      return driverFail({ code: 'BAD_BODY', message: 'The photo could not be read.' }, 400);
    }
    const meta = photoMetaSchema.parse(metaJson);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const wctx = { tenantId: ctx.tenantId, truckId: ctx.truckId, date: ctx.date, link: ctx.link, ip: ctx.ip, deviceId: ctx.deviceId, session: ctx.session, now: ctx.now };
    const answer = await recordDriverPhoto(wctx, meta, bytes);
    const results = answer.status === 'refused' ? null : await truckDayResultsFromDb(prisma, ctx.tenantId, ctx.truckId, ctx.date, ctx.session ? 'OFFICE' : 'DRIVER');
    return driverOk({ ...answer, ...(results ?? {}) });
  },
  { limit: 'photo', write: true, allowUploadOnly: true, maxInFlight: LIMITS.driverInFlight },
);
