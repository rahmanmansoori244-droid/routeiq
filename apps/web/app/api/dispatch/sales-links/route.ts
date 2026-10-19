import { z } from 'zod';
import { withTenantApi, ok, parseBody } from '@/lib/api';
import { ensureSalesLink, getSalesLink, listSalesLinks } from '@/lib/sales-link/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/dispatch/sales-links[?date=YYYY-MM-DD] - the salesman link of a date (or null), or without a date the
// links of the company's today and tomorrow (owner request 19 Oct 2026). Existing links only: never creates one
// and writes no audit row. PLANNER: the link shows customers to people outside RouteIQ.
export const GET = withTenantApi(
  async (req, { user }) => {
    const url = new URL(req.url);
    const date = url.searchParams.get('date');
    const opts = { origin: url.origin };
    return ok(date === null ? await listSalesLinks(user.tenantId, opts) : await getSalesLink(user.tenantId, date, opts));
  },
  { role: 'PLANNER' },
);

const ensureSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

// POST /api/dispatch/sales-links { date } - get or make the date's salesman link (the plan screen's Salesman
// link dialog): 201 when made, 200 when it existed. Only the company's today or tomorrow (400
// DATE_OUT_OF_RANGE); 409 LINK_DAY_OVER; 503 SALES_LINKS_OFF without a server secret. A link turned off stays
// off (no url) until replaced. Audited SALES_LINK_ISSUED on creation only.
export const POST = withTenantApi(
  async (req, { user }) => {
    const { date } = await parseBody(req, ensureSchema);
    const view = await ensureSalesLink(user.tenantId, user.id, date, { origin: new URL(req.url).origin });
    return ok(view, view.created ? 201 : 200);
  },
  { role: 'PLANNER' },
);
