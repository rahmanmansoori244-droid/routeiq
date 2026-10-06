import { withTenantApi, parseBody } from '@/lib/api';
import { hireUseSchema } from '@/lib/schemas';
import { applyHireSuggestion } from '@/lib/dispatch/hire-use';
import { startResponse } from '@/lib/dispatch/start-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// POST /api/runs/:id/hire-suggestion/use { suggestionId, expect?, allowMissingLocations?,
// allowMissingWeights? } - "Use this plan" (owner request 6 Oct 2026): rents the trucks the what-if
// used as one-day trucks for the plan's date, then applies the what-if's plan as the next version when
// nothing changed since it was computed (200, applied PLAN), else starts a RE-PLAN with them (202,
// applied REPLAN). 409 ALREADY_USED / NOT_READY / NOTHING_TO_HIRE / SUPERSEDED / OPTIMIZING /
// DAY_MISMATCH, and a re-plan's own questions (LOCATION_REQUIRED, WEIGHT_REQUIRED) before anything is rented.
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const input = await parseBody(r, hireUseSchema);
      const res = await applyHireSuggestion(user.tenantId, params.id, input.suggestionId, user, ip, {
        expect: input.expect,
        overrides: { allowMissingLocations: input.allowMissingLocations, allowMissingWeights: input.allowMissingWeights },
      });
      return startResponse(res);
    },
    { role: 'PLANNER' },
  )(req);
