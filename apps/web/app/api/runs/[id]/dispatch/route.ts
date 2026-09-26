import { withTenantApi, ok, fail, notFoundIfNull } from '@/lib/api';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';

interface Params { params: { id: string } }

class DispatchRaceError extends Error {}

export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      if ((await db.planLoad.count({ where: { runId: params.id } })) > 0) {
        return fail('This plan uses truck loads: lock and dispatch each load from the Daily Dispatch screen (dispatched loads cannot be unlocked).', 409);
      }
      const run = notFoundIfNull(
        await db.runPlan.findUnique({
          where: { id: params.id },
          include: { _count: { select: { routes: true } } },
        }),
      );

      if (run.status === 'DISPATCHED') return fail('Run already dispatched.', 409);
      // A version written READY over its supersede (before the stabilization release) stays replaced.
      if (run.supersededAt) return fail('This plan version was superseded. Open the latest version.', 409);
      if (run.status !== 'READY') return fail(`Run status is ${run.status}, must be READY.`, 409);
      if (!run.chosenScenarioId) return fail('Pick a scenario before dispatching.', 400);
      if (run._count.routes === 0) return fail('No routes to dispatch.', 400);

      const dispatched = await prisma.$transaction(async (tx) => {
        // Atomic status transition: a concurrent dispatch races to here and
        // either both updateMany'ed 1 row or both 0. The first wins; the
        // second sees count=0 and we bail. Without this, two dispatches both
        // succeed and we get a duplicate audit + a stomped finalizedAt.
        const flipped = await tx.runPlan.updateMany({
          where: { id: params.id, status: 'READY', supersededAt: null, tenantId: user.tenantId },
          data: { status: 'DISPATCHED', finalizedAt: new Date() },
        });
        if (flipped.count !== 1) {
          throw new DispatchRaceError();
        }
        // Mark every assigned order as DISPATCHED.
        await tx.order.updateMany({
          where: {
            tenantId: user.tenantId,
            assignments: { some: { runId: params.id } },
          },
          data: { status: 'DISPATCHED' },
        });
        return tx.runPlan.findUniqueOrThrow({
          where: { id: params.id },
          select: { id: true, status: true, finalizedAt: true, runDate: true },
        });
      }).catch((e) => {
        if (e instanceof DispatchRaceError) return null;
        throw e;
      });

      if (!dispatched) return fail('Run already dispatched by another request.', 409);

      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DISPATCH',
        entity: 'RunPlan',
        entityId: dispatched.id,
        afterJson: {
          runDate: dispatched.runDate.toISOString().slice(0, 10),
          assignmentCount: run._count.routes,
        } as never,
        ip,
      });

      return ok({ status: dispatched.status, finalizedAt: dispatched.finalizedAt });
    },
    { role: 'SUPERVISOR' },
  )(req);
