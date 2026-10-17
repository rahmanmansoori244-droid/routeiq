import { z } from 'zod';
import { withTenantApi, ok, fail, parseBody } from '@/lib/api';
import { undoGpsTimes } from '@/lib/ivms/tracker-admin';

export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

const bodySchema = z.object({ date: z.string().max(10), dryRun: z.boolean().optional() });

// POST /api/ivms/trucks/:id/gps-times - the undo of a truck-day's GPS times (IVMS live link, first review
// M-3; docs/admin.md). Company admin only. { date: 'YYYY-MM-DD', dryRun?: boolean } - a dry run (the
// default) only counts; dryRun false marks the truck-day "GPS suppressed", deletes its GPS (AYUN) arrival
// and departure events, rebuilds the visits from the driver's and the office's events, and writes one
// GPS_TIMES_UNDONE audit row. 404 not this company's truck, 422 a date after today. Never calls Ayun.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const input = await parseBody(r, bodySchema);
      const res = await undoGpsTimes(user.tenantId, params.id, input.date, { dryRun: input.dryRun !== false, actor: { userId: user.id, ip } });
      if (!res.ok) return fail({ code: res.code, message: res.message }, res.status);
      return ok(res);
    },
    { role: 'TENANT_ADMIN' },
  )(req);
