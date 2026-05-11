import { withTenantApi, ok, parseBody, notFoundIfNull } from '@/lib/api';
import { productSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';

interface Params { params: { id: string } }

export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.product.findUnique({ where: { id: params.id } }));
      const input = await parseBody(r, productSchema.partial());
      const after = await db.product.update({ where: { id: params.id }, data: input });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'Product',
        entityId: after.id,
        beforeJson: before as never,
        afterJson: after as never,
        ip,
      });
      return ok(after);
    },
    { role: 'TENANT_ADMIN' },
  )(req);

export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.product.findUnique({ where: { id: params.id } }));
      const usage = await db.orderLine.count({ where: { productId: params.id } });
      if (usage > 0) {
        const after = await db.product.update({ where: { id: params.id }, data: { active: false } });
        await audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entity: 'Product',
          entityId: after.id,
          beforeJson: before as never,
          afterJson: { ...(after as object), softDeleted: true } as never,
          ip,
        });
        return ok({ softDeleted: true, product: after });
      }
      await db.product.delete({ where: { id: params.id } });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entity: 'Product',
        entityId: params.id,
        beforeJson: before as never,
        ip,
      });
      return ok({ deleted: true });
    },
    { role: 'TENANT_ADMIN' },
  )(req);
