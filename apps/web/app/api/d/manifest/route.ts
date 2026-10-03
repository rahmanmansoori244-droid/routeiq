import { driverOk, withDriverLink } from '@/lib/driver-link/guard';
import { driverManifest } from '@/lib/driver-link/manifest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/d/manifest - the driver page's trips and stops for one truck-day (owner request 4 Oct
// 2026). The token comes in `Authorization: DriverLink <token>`, never in the path. Only that
// truck's loads on the plans in use; no money, no priorities, no other truck. 410 LINK_EXPIRED with
// uploadOnly in the upload grace (withDriverLink).
export const GET = withDriverLink(
  async (_req, ctx) => {
    const manifest = await driverManifest({
      tenantId: ctx.tenantId,
      truckId: ctx.truckId,
      date: ctx.date,
      link: { expiresAt: ctx.expiresAt, uploadUntil: ctx.uploadUntil, generation: ctx.link.generation },
      office: ctx.session ? { userName: ctx.session.name } : null,
      now: ctx.now,
    });
    return driverOk(manifest);
  },
  { limit: 'manifest' },
);
