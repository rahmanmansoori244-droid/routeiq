import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { regionSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';

interface Params { params: { id: string } }

export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.region.findUnique({ where: { id: params.id } }));
      const input = await parseBody(r, regionSchema.partial());
      if (input.depotId) {
        const depot = await db.depot.findUnique({ where: { id: input.depotId } });
        if (!depot) return fail('Depot not found in this tenant', 400);
      }
      const after = await db.region.update({ where: { id: params.id }, data: input });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'Region',
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
      const before = notFoundIfNull(await db.region.findUnique({ where: { id: params.id } }));
      const customerCount = await db.customer.count({ where: { regionId: params.id } });
      if (customerCount > 0) {
        // Detach customers from the region rather than blocking, then delete region.
        await db.customer.updateMany({ where: { regionId: params.id }, data: { regionId: null } });
      }
      await db.region.delete({ where: { id: params.id } });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entity: 'Region',
        entityId: params.id,
        beforeJson: before as never,
        afterJson: { detachedCustomers: customerCount } as never,
        ip,
      });
      return ok({ deleted: true, detachedCustomers: customerCount });
    },
    { role: 'TENANT_ADMIN' },
  )(req);
