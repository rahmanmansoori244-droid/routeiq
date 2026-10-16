import { z } from 'zod';
import { withTenantApi, ok, fail, parseBody } from '@/lib/api';
import { setTruckTracker } from '@/lib/ivms/tracker-admin';

export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

const bodySchema = z.object({ imei: z.string().max(40).nullable() });

// PUT /api/ivms/trucks/:id/tracker - set or clear the truck's GPS tracker IMEI (IVMS live link, 16 Oct
// 2026). Company admin only. 400 not 10-20 digits, 404 not this company's truck, 409 the tracker is on
// another truck, 422 a one-day hired truck. Audited as an UPDATE of the truck with the tracker's last 4
// digits only. The truck's live position is removed with the change.
export const PUT = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const input = await parseBody(r, bodySchema);
      const res = await setTruckTracker(user.tenantId, params.id, input.imei, { userId: user.id, ip });
      if (!res.ok) return fail({ code: res.code, message: res.message }, res.status);
      return ok(res);
    },
    { role: 'TENANT_ADMIN' },
  )(req);
