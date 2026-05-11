import { withTenantApi, ok, fail, notFoundIfNull } from '@/lib/api';
import { audit } from '@/lib/audit';

interface Params { params: { id: string } }

/**
 * Reverses a dispatch: a SUPERVISOR can flip a DISPATCHED run back to READY for
 * further edits. Always audited. Per CLAUDE.md §12 Phase 4 acceptance: "After
 * dispatch, I cannot edit assignments without explicit 'unlock' action that audits."
 */
export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const run = notFoundIfNull(await db.runPlan.findUnique({ where: { id: params.id } }));
      if (run.status !== 'DISPATCHED') return fail(`Run is ${run.status}, not DISPATCHED.`, 409);

      const updated = await db.runPlan.update({
        where: { id: params.id },
        data: { status: 'READY', finalizedAt: null },
      });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'OVERRIDE',
        entity: 'RunPlan',
        entityId: run.id,
        beforeJson: { status: 'DISPATCHED' } as never,
        afterJson: { status: 'READY', unlockedFor: 'edit' } as never,
        ip,
      });
      return ok({ status: updated.status });
    },
    { role: 'SUPERVISOR' },
  )(req);
