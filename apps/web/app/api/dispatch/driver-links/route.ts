import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail } from '@/lib/api';
import { ensureLink, listLinks } from '@/lib/driver-link/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/dispatch/driver-links?runId= - the plan's truck-day driver links (owner request 4 Oct
// 2026), loaded with the plan so the WhatsApp link can carry the driver link at render time.
// Existing links only: never creates one and writes no audit row. PLANNER: a link can record results.
export const GET = withTenantApi(
  async (req, { user }) => {
    const url = new URL(req.url);
    const runId = url.searchParams.get('runId');
    if (!runId) return fail('runId is required.', 400);
    return ok(await listLinks(user.tenantId, runId, { origin: url.origin }));
  },
  { role: 'PLANNER' },
);

const ensureSchema = z.object({ runId: z.string().min(1), truckId: z.string().min(1) }).strict();

// POST /api/dispatch/driver-links { runId, truckId } - get or create the truck-day's link (the Link
// dialog). 409 LINK_DAY_OVER after 12:00 the day after the delivery date; a revoked link stays
// revoked (no link until Reissue). Audited DRIVER_LINK_ISSUED on creation only.
export const POST = withTenantApi(
  async (req, { user }) => {
    const { runId, truckId } = await parseBody(req, ensureSchema);
    const view = await ensureLink(user.tenantId, runId, truckId, user.id, { origin: new URL(req.url).origin });
    return ok(view, view.created ? 201 : 200);
  },
  { role: 'PLANNER' },
);
