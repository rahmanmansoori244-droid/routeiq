import { withTenantApi, ok, fail, notFoundIfNull } from '@/lib/api';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';

interface Params { params: { id: string } }

export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const run = notFoundIfNull(
        await db.runPlan.findUnique({
          where: { id: params.id },
          include: { _count: { select: { routes: true } } },
        }),
      );

      if (run.status === 'DISPATCHED') return fail('Run already dispatched.', 409);
      if (run.status !== 'READY') return fail(`Run status is ${run.status}, must be READY.`, 409);
      if (!run.chosenScenarioId) return fail('Pick a scenario before dispatching.', 400);
      if (run._count.routes === 0) return fail('No routes to dispatch.', 400);

      const dispatched = await prisma.$transaction(async (tx) => {
        // Mark every assigned order as DISPATCHED.
        await tx.order.updateMany({
          where: {
            tenantId: user.tenantId,
            assignments: { some: { runId: params.id } },
          },
          data: { status: 'DISPATCHED' },
        });
        return tx.runPlan.update({
          where: { id: params.id },
          data: { status: 'DISPATCHED', finalizedAt: new Date() },
        });
      });

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
