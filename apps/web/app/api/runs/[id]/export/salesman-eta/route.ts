import { fail, withTenantApi } from '@/lib/api';
import { planOf, sheetHtmlResponse, tenantNameOf } from '@/lib/exports/warehouse-export';
import { loadSalesmanEtaFacts, salesmanEtaModel } from '@/lib/exports/salesman-eta';
import { renderSalesmanEtaHtml } from '@/lib/exports/salesman-eta-html';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// GET /api/runs/:id/export/salesman-eta - "Salesman ETA" (owner request 17 Oct 2026): one printable page
// per sales route (the order file's "route" column) with that salesman's customers of the plan's delivery
// day and the expected arrival window of each, after a first page with the day's totals per route
// (lib/exports/salesman-eta.ts). Readable by every role, like the load sheets; reads only. 404 for another
// company's run or a run that is not a dispatch plan (planOf, as the load sheets answer), and NO_LOADS for
// a plan without loads. The page is sent like the load sheets (sheetHtmlResponse: no cache, the policy that
// allows only its Print button).
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { user, db }) => {
    const detail = await planOf(user.tenantId, params.id);
    if (detail instanceof Response) return detail;
    if (!detail.loads.length) return fail({ code: 'NO_LOADS', message: 'This plan has no loads, so there are no expected arrival times to print.' }, 404);
    const facts = await loadSalesmanEtaFacts(db, user.tenantId, detail);
    const model = salesmanEtaModel(detail, facts, { tenantName: await tenantNameOf(user.tenantId), now: new Date() });
    return sheetHtmlResponse(renderSalesmanEtaHtml(model));
  })(req);
