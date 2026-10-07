import { withTenantApi, ok, fail } from '@/lib/api';
import { hireView, startHireCheck } from '@/lib/dispatch/hire-whatif';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params { params: { id: string } }

// GET /api/runs/:id/hire-suggestion - the hire suggestion of this plan version (owner request 6 Oct
// 2026): the latest what-if (waiting, running, finished, failed or stopped), its words, whether it can
// be used, and whether the depot has trucks to hire. Any signed-in user (VIEWER reads it).
export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { user, db }) => {
    const tenant = await db.tenant.findUnique({ where: { id: user.tenantId }, select: { currency: true } });
    const view = await hireView(user.tenantId, params.id, tenant?.currency ?? 'OMR');
    if (!view) return fail('Not found.', 404);
    return ok(view);
  })(req);

// POST /api/runs/:id/hire-suggestion - "Check hire options": run the what-if now for this version
// (the version in use, with a plan). 202 with the suggestion id; 409 with the reason it did not run
// (no trucks to hire, nothing left out, already running, a newer version, the optimizer busy, ...).
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { user, ip }) => {
      const r = await startHireCheck(user.tenantId, params.id, user, ip, 'ASKED');
      if (r.started) return ok({ suggestionId: r.suggestionId }, 202);
      if (r.reason === 'NOT_FOUND') return fail('Not found.', 404);
      return fail({ error: r.message, code: `HIRE_${r.reason}`, ...(r.suggestionId ? { suggestionId: r.suggestionId } : {}) }, r.reason === 'BUSY' ? 503 : 409);
    },
    { role: 'PLANNER' },
  )(req);
