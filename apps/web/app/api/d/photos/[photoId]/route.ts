import { NextResponse } from 'next/server';
import { DRIVER_HEADERS, withDriverLink } from '@/lib/driver-link/guard';
import { photoHeaders, readTruckDayPhoto } from '@/lib/delivery/photo-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/d/photos/<photoId> - a delivery photo of this truck-day for the driver page's thumbnails
// (owner request 4 Oct 2026, spec section 12.3). The token comes in the header; the page fetches the
// photo into a blob URL, so no image URL carries it. 404 for another truck-day's photo, 404
// PHOTO_PURGED after the retention. Served with nosniff, a sandbox CSP and no-store.
export const GET = withDriverLink(
  async (req, ctx) => {
    const photoId = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';
    const photo = await readTruckDayPhoto({ tenantId: ctx.tenantId, truckId: ctx.truckId, date: ctx.date }, decodeURIComponent(photoId));
    return new NextResponse(Buffer.from(photo.bytes), { status: 200, headers: { ...photoHeaders(photo.filename, 'no-store'), ...DRIVER_HEADERS } });
  },
  { limit: 'photoGet' },
);
