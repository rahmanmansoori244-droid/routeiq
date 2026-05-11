import { withTenantApi, ok, notFoundIfNull, fail } from '@/lib/api';
import { audit } from '@/lib/audit';

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

export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(
        await db.uploadBatch.findUnique({
          where: { id: params.batchId },
          include: { _count: { select: { orders: true } } },
        }),
      );
      if (before.status === 'CONFIRMED' && (before._count?.orders ?? 0) === 0) {
        return fail('Batch has no orders to delete.', 400);
      }
      // Cascade delete all Order rows from this batch. OrderLine has onDelete: Cascade
      // on Order, so orders → lines drop atomically. RouteAssignment is not a Phase-2
      // concern; if any orders ended up referenced (Phase 3+), this delete would fail
      // and we'd surface that back to the user.
      const deleted = await db.order.deleteMany({ where: { uploadBatchId: params.batchId } });
      await db.uploadBatch.update({
        where: { id: params.batchId },
        data: { status: 'DELETED' },
      });

      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entity: 'UploadBatch',
        entityId: params.batchId,
        beforeJson: {
          fileName: before.fileName,
          status: before.status,
          orderCount: before._count?.orders ?? 0,
        } as never,
        afterJson: { status: 'DELETED', ordersDeleted: deleted.count } as never,
        ip,
      });

      return ok({ deleted: true, ordersDeleted: deleted.count });
    },
    { role: 'PLANNER' },
  )(req);
