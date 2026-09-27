import { z } from 'zod';
import { withTenantApi, ok, parseBody, HttpError } from '@/lib/api';
import { isoDateSchema, isRealIsoDate } from '@/lib/schemas';
import { bringForward, carryOverPreview } from '@/lib/dispatch/carry-over';

// GET /api/dispatch/carry-over?date=YYYY-MM-DD&depotId=... - the orders of this depot with a
// delivery date in the 7 days before `date` whose cases were not delivered (unserved, on a load
// that never left the depot, or never planned): what "Bring forward to <date>" would carry, with
// the reason for each and the ones that cannot be carried. Reads only.
export const GET = withTenantApi(async (req, { user }) => {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') ?? '';
  const depotId = url.searchParams.get('depotId') ?? '';
  if (!isRealIsoDate(date)) throw new HttpError('Use a real date as YYYY-MM-DD.', 400, { code: 'INVALID_DATE' });
  if (!depotId) throw new HttpError('Choose a depot.', 400, { code: 'DEPOT_REQUIRED' });
  return ok(await carryOverPreview(user.tenantId, depotId, date));
});

const schema = z
  .object({
    date: isoDateSchema,
    depotId: z.string().min(1),
    /** The orders to bring forward, each with the open cases the list showed (the expected state). */
    selected: z
      .array(z.object({ orderId: z.string().min(1).max(64), cases: z.number().int().positive() }).strict())
      .min(1, 'Select at least one order.')
      .max(2000)
      .refine((xs) => new Set(xs.map((x) => x.orderId)).size === xs.length, 'An order is selected twice.'),
  })
  .strict();

// POST /api/dispatch/carry-over - bring the selected orders forward to `date` (one transaction under
// the intake lock, like a confirmed file or a late order). Answers what was carried; orders already
// carried are skipped. A list that changed since it was shown answers 409 CARRY_OVER_CHANGED and
// carries nothing. Nothing is planned yet: OPTIMIZE (no plan) or RE-PLAN (a plan in use) does that.
export const POST = withTenantApi(
  async (req, { user, ip }) => {
    const input = await parseBody(req, schema);
    const res = await bringForward(user.tenantId, input.depotId, input.date, input.selected, user, { ip });
    return ok(res, res.orders > 0 ? 201 : 200);
  },
  { role: 'PLANNER' },
);
