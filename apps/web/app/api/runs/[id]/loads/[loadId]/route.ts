import { z } from 'zod';
import { withTenantApi, ok, parseBody, fail, hasRole } from '@/lib/api';
import { changeLoadStatus, PlanError } from '@/lib/dispatch/plan-service';

interface Params { params: { id: string; loadId: string } }

const schema = z.object({ status: z.enum(['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED']) });

// PATCH /api/runs/:id/loads/:loadId { status } - lock / unlock / loading / dispatch / complete.
// Rules live in lib/dispatch/load-state.ts (loads go out in order; dispatched is immutable).
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user }) => {
      const { status } = await parseBody(r, schema);
      try {
        const load = await changeLoadStatus(user.tenantId, params.id, params.loadId, status, user, (role) => hasRole(user.role, role));
        return ok(load);
      } catch (e) {
        if (e instanceof PlanError) return fail(e.message, e.status);
        throw e;
      }
    },
    { role: 'PLANNER' },
  )(req);
