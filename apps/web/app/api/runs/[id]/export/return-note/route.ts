import { withTenantApi } from '@/lib/api';
import { returnNotesExport } from '@/lib/exports/warehouse-export';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// GET /api/runs/:id/export/return-note - the return notes (gate pass) of the loads that left
// (owner request 12 Oct 2026): per customer what was delivered and what comes back, with the
// driver's reason, for the gate pass officer to count and the supervisor to be told. ?load=<loadId>
// one load, ?truck=<truck id or code> one truck. Readable by every role, like the plan's results. Reads only.
export const GET = (req: Request, { params }: Params) => withTenantApi(async (r, { user }) => returnNotesExport(r, user.tenantId, params.id))(req);
