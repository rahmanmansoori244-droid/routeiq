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

      // Atomic transition: a concurrent unlock can't double-fire the audit
      // log because updateMany sees the row in READY on the second pass and
      // matches zero. tenantId stays in the predicate as defense-in-depth.
      const flipped = await db.runPlan.updateMany({
        where: { id: params.id, status: 'DISPATCHED' },
        data: { status: 'READY', finalizedAt: null },
      });
      if (flipped.count !== 1) return fail('Run already unlocked by another request.', 409);
      const updated = await db.runPlan.findUniqueOrThrow({
        where: { id: params.id },
        select: { status: true },
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
