import { withTenantApi } from '@/lib/api';
import { loadSheetsExport } from '@/lib/exports/warehouse-export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// GET /api/runs/:id/export/load-sheet - the warehouse load sheets of a dispatch plan version (owner
// request 12 Oct 2026): per truck load, the products and cases to load and every invoice with its
// customer, as one printable page. ?load=<loadId> one load, ?truck=<truck id or code> one truck.
// Readable by every role, like the driver sheets. Reads only.
export const GET = (req: Request, { params }: Params) => withTenantApi(async (r, { user }) => loadSheetsExport(r, user.tenantId, params.id))(req);
