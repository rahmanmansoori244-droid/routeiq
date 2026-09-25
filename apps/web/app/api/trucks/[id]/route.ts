import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { truckSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';

interface Params { params: { id: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    const truck = notFoundIfNull(await db.truck.findUnique({ where: { id: params.id } }));
    return ok(truck);
  })(req);

export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.truck.findUnique({ where: { id: params.id } }));
      const input = await parseBody(r, truckSchema.partial());
      if (input.depotId) {
        const depot = await db.depot.findUnique({ where: { id: input.depotId } });
        if (!depot) return fail('Depot not found in this tenant', 400);
      }
      // A new default driver must be an active driver of this tenant (keeping the current one
      // is fine even if they were deactivated since - the form sends every field back).
      if (input.defaultDriverId && input.defaultDriverId !== before.defaultDriverId) {
        const driver = await db.driver.findUnique({ where: { id: input.defaultDriverId } });
        if (!driver) return fail('Driver not found in this tenant', 400);
        if (!driver.active) return fail(`Driver ${driver.name} is inactive`, 400);
      }
      const after = await db.truck.update({ where: { id: params.id }, data: input });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'Truck',
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
      const before = notFoundIfNull(await db.truck.findUnique({ where: { id: params.id } }));
      const assignments = await db.routeAssignment.count({ where: { truckId: params.id } });
      if (assignments > 0) {
        const after = await db.truck.update({ where: { id: params.id }, data: { active: false } });
        await audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entity: 'Truck',
          entityId: after.id,
          beforeJson: before as never,
          afterJson: { ...(after as object), softDeleted: true } as never,
          ip,
        });
        return ok({ softDeleted: true, truck: after });
      }
      await db.truck.delete({ where: { id: params.id } });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entity: 'Truck',
        entityId: params.id,
        beforeJson: before as never,
        ip,
      });
      return ok({ deleted: true });
    },
    { role: 'TENANT_ADMIN' },
  )(req);
