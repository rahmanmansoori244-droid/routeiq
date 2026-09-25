import { withTenantApi, ok, notFoundIfNull, fail } from '@/lib/api';
import { prisma } from '@/lib/db';
import { lockIntake } from '@/lib/dispatch/intake-server';
import { isDispatchDetails } from '@/lib/dispatch/plan-service';
import { isoOf } from '@/lib/dispatch/time';

interface Params { params: { batchId: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    const batch = notFoundIfNull(
      await db.uploadBatch.findUnique({
        where: { id: params.batchId },
        include: {
          uploadedBy: { select: { id: true, name: true, email: true } },
          _count: { select: { orders: true } },
        },
      }),
    );
    return ok(batch);
  })(req);

class DeleteRefused extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

// DELETE /api/orders/:batchId - remove a confirmed file's orders. Allowed only while none of its
// orders was ever optimized: a plan (any version, any option, including unserved rows) must
// never lose orders it was made for. Planned orders cannot be removed in the app yet (the
// "cancel orders" flow is deferred); a late order or a re-plan only adds or re-plans orders.
// Everything happens in one transaction under the batch row lock and the tenant intake lock.
export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { user, ip }) => {
      const tenantId = user.tenantId;
      let result;
      try {
        result = await prisma.$transaction(
          async (tx) => {
            await lockIntake(tx, tenantId);
            const locked = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM "UploadBatch" WHERE id = ${params.batchId} AND "tenantId" = ${tenantId} FOR UPDATE`;
            if (!locked.length) throw new DeleteRefused('Not found.', 404);
            const before = await tx.uploadBatch.findUniqueOrThrow({ where: { id: params.batchId }, include: { _count: { select: { orders: true } } } });
            if (before.status === 'DELETED') throw new DeleteRefused('This file was already deleted.', 409);
            if (before.status === 'CONFIRMED' && before._count.orders === 0) throw new DeleteRefused('Batch has no orders to delete.', 400);
            const orders = await tx.order.findMany({ where: { tenantId, uploadBatchId: before.id }, select: { id: true, depotId: true, deliveryDate: true } });
            const ids = orders.map((o) => o.id);
            if (ids.length) {
              const dates = [...new Set(orders.map((o) => o.deliveryDate.getTime()))].map((t) => new Date(t));
              const depots = [...new Set(orders.map((o) => o.depotId))];
              const running = await tx.runPlan.findFirst({
                // Orders without a depot belong to the plan of any depot that day.
                where: { tenantId, runDate: { in: dates }, status: 'OPTIMIZING', ...(depots.includes(null) ? {} : { depotId: { in: depots as string[] } }) },
                select: { runDate: true, version: true },
              });
              if (running) {
                throw new DeleteRefused(`A plan for ${isoOf(running.runDate)} is being optimized. Wait for it to finish.`, 409, 'PLAN_OPTIMIZING');
              }
              // Every plan version that used these orders: loads, unserved rows, or the scope of the
              // option in use (orders left out before the optimizer, e.g. no location, are there too).
              const used = new Map<string, { date: string; version: number }>();
              const note = (run: { id: string; runDate: Date; version: number }) => used.set(run.id, { date: isoOf(run.runDate), version: run.version });
              const runSel = { select: { id: true, runDate: true, version: true } } as const;
              for (const a of await tx.routeAssignment.findMany({ where: { orderId: { in: ids } }, select: { runId: true, run: runSel }, distinct: ['runId'] })) note(a.run);
              for (const u of await tx.unservedOrder.findMany({ where: { orderId: { in: ids } }, select: { scenarioId: true, scenario: { select: { run: runSel } } }, distinct: ['scenarioId'] })) {
                note(u.scenario.run);
              }
              const idSet = new Set(ids);
              const chosen = await tx.runPlan.findMany({
                where: { tenantId, runDate: { in: dates }, chosenScenarioId: { not: null } },
                select: { id: true, runDate: true, version: true, chosenScenarioId: true },
              });
              for (const run of chosen) {
                if (used.has(run.id)) continue;
                const sc = await tx.scenarioResult.findFirst({ where: { id: run.chosenScenarioId!, runId: run.id }, select: { detailsJson: true } });
                const d = sc?.detailsJson;
                if (!isDispatchDetails(d)) continue;
                const scope = [...d.scope.orderIds, ...d.scope.frozenOrderIds, ...(d.scope.frozenLoadOrderIds ?? [])];
                if (scope.some((id) => idSet.has(id))) note(run);
              }
              if (used.size) {
                const byDate = new Map<string, number[]>();
                for (const u of used.values()) byDate.set(u.date, [...(byDate.get(u.date) ?? []), u.version]);
                const where = [...byDate].map(([d, vs]) => `${d} (version ${[...new Set(vs)].sort((a, b) => a - b).join(', ')})`).join('; ');
                throw new DeleteRefused(
                  `Orders from this file are in the plan for ${where}, so the file cannot be deleted: a plan keeps every order it was made for. Removing planned orders is not possible in the app yet (a cancel function is not built yet). Nothing was changed; ask your RouteIQ administrator.`,
                  409,
                  'BATCH_IN_PLAN',
                );
              }
            }
            const deleted = ids.length ? await tx.order.deleteMany({ where: { tenantId, id: { in: ids } } }) : { count: 0 };
            await tx.uploadBatch.update({ where: { id: before.id }, data: { status: 'DELETED' } });
            await tx.auditLog.create({
              data: {
                tenantId,
                userId: user.id,
                action: 'DELETE',
                entity: 'UploadBatch',
                entityId: before.id,
                beforeJson: { fileName: before.fileName, status: before.status, orderCount: before._count.orders } as never,
                afterJson: { status: 'DELETED', ordersDeleted: deleted.count } as never,
                ip,
              },
            });
            return { deleted: true, ordersDeleted: deleted.count };
          },
          { timeout: 30_000, maxWait: 10_000 },
        );
      } catch (e) {
        if (e instanceof DeleteRefused) return fail(e.code ? { code: e.code, message: e.message } : e.message, e.status);
        throw e;
      }
      return ok(result);
    },
    { role: 'PLANNER' },
  )(req);
