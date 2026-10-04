import { NextResponse } from 'next/server';
import { withTenantApi } from '@/lib/api';
import { readOfficePhoto } from '@/lib/delivery/office-service';
import { photoHeaders } from '@/lib/delivery/photo-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// GET /api/delivery-photos/:id - a delivery photo for a signed-in user of the company (owner request
// 4 Oct 2026, spec section 12.3): the plan screen's photo viewer fetches it into a blob. image/jpeg
// with nosniff, a sandbox CSP and a private cache. 404 for another company's photo; 404 PHOTO_PURGED
// (JSON) after the retention removed its bytes.
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { user }) => {
    const photo = await readOfficePhoto(user.tenantId, decodeURIComponent(params.id));
    return new NextResponse(Buffer.from(photo.bytes), { status: 200, headers: photoHeaders(photo.filename, 'private') });
  })(req);
