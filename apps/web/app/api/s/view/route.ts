import { withSalesLink } from '@/lib/sales-link/guard';
import { salesView } from '@/lib/sales-link/day-read';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/s/view[?route=R1] - the salesman link's page data (owner request 19 Oct 2026). The token comes in
// `Authorization: SalesLink <token>`, never in the path or the query. Without `route`: the day's header only
// (the page then asks for a route code); with `route` ("R1" or "R1, R2X"): those routes' deliveries, live, and
// their orders not on a truck. Read-only; no driver, phone, money, notes or internal ids (view-types.ts).
export const GET = withSalesLink(salesView);
