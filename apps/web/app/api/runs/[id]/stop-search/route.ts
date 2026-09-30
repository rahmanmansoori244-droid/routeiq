import { withTenantApi, ok, fail } from '@/lib/api';
import { stopSearch } from '@/lib/dispatch/stop-search';

interface Params { params: { id: string } }

/**
 * POST /api/runs/:id/stop-search - "Use the best plan found so far" (SUPERVISOR and above, audited
 * SEARCH_STOPPED). A running THOROUGH search ends at the next plan it finds; the job then checks and
 * saves that plan as usual. 409 when no thorough search is running for the plan (NOT_RUNNING,
 * NOT_THOROUGH, NOT_STARTED, SOLVER_NOT_RUNNING); 502 when the optimizer cannot be reached (the
 * search goes on). See lib/dispatch/stop-search.ts.
 */
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { user, ip }) => {
      const res = await stopSearch(user.tenantId, params.id, user, ip);
      if (res.status >= 400) return fail(res.body, res.status);
      return ok(res.body, res.status);
    },
    { role: 'SUPERVISOR' },
  )(req);
