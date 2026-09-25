import { withTenantApi, ok, parseBody, notFoundIfNull } from '@/lib/api';
import { driverSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { DRIVER_PUBLIC_SELECT } from '@/lib/driver-fields';

interface Params { params: { id: string } }

// Every read and write projects DRIVER_PUBLIC_SELECT: the PIN hash never reaches a response or
// an audit row (review F13).

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    return ok(notFoundIfNull(await db.driver.findUnique({ where: { id: params.id }, select: DRIVER_PUBLIC_SELECT })));
  })(req);

export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.driver.findUnique({ where: { id: params.id }, select: DRIVER_PUBLIC_SELECT }));
      const input = await parseBody(r, driverSchema.partial());
      const after = await db.driver.update({ where: { id: params.id }, data: input, select: DRIVER_PUBLIC_SELECT });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'Driver',
        entityId: after.id,
        beforeJson: before as never,
        afterJson: after as never,
        ip,
      });
      return ok(after);
    },
    { role: 'TENANT_ADMIN' },
  )(req);

/**
 * A driver who appears on any load (any plan version, dispatched or not) or any legacy
 * driver-app shift is DEACTIVATED instead of deleted: a hard delete would null the driver on
 * dispatched and completed loads (PlanLoad.driverId is ON DELETE SET NULL) and erase who drove
 * them. Only a driver never used anywhere is really deleted.
 */
export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.driver.findUnique({ where: { id: params.id }, select: DRIVER_PUBLIC_SELECT }));
      const [loads, shifts] = await Promise.all([
        db.planLoad.count({ where: { driverId: params.id } }),
        db.driverShift.count({ where: { driverId: params.id } }),
      ]);
      if (loads > 0 || shifts > 0) {
        const after = await db.driver.update({ where: { id: params.id }, data: { active: false }, select: DRIVER_PUBLIC_SELECT });
        await audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entity: 'Driver',
          entityId: after.id,
          beforeJson: before as never,
          afterJson: { ...after, softDeleted: true, usedOnLoads: loads } as never,
          ip,
        });
        return ok({ softDeleted: true, driver: after });
      }
      await db.driver.delete({ where: { id: params.id } });
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'DELETE',
        entity: 'Driver',
        entityId: params.id,
        beforeJson: before as never,
        ip,
      });
      return ok({ deleted: true });
    },
    { role: 'TENANT_ADMIN' },
  )(req);
