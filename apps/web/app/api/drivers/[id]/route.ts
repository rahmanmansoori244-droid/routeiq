import { withTenantApi, ok, parseBody, notFoundIfNull } from '@/lib/api';
import { driverPatchSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { DRIVER_PUBLIC_SELECT } from '@/lib/driver-fields';
import { driverDeactivatedWarning } from '@/lib/master-data-delete';
import type { TenantDb } from '@/lib/tenant';

interface Params { params: { id: string } }

// Every read and write projects DRIVER_PUBLIC_SELECT: the PIN hash never reaches a response or
// an audit row (review F13).

/** Codes of the trucks that have this driver as their default driver (kept when the driver is deactivated). */
async function defaultOfTrucks(db: TenantDb, driverId: string): Promise<string[]> {
  const trucks = await db.truck.findMany({ where: { defaultDriverId: driverId }, select: { code: true }, orderBy: { code: 'asc' } });
  return trucks.map((t) => t.code);
}

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    return ok(notFoundIfNull(await db.driver.findUnique({ where: { id: params.id }, select: DRIVER_PUBLIC_SELECT })));
  })(req);

/**
 * Only the fields sent change (owner decision 10, audit F26): a field left out stays as it is,
 * and an empty or null phone clears it (before, an emptied phone said "saved" and kept the old
 * number, which WhatsApp links kept using).
 */
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.driver.findUnique({ where: { id: params.id }, select: DRIVER_PUBLIC_SELECT }));
      // casual: false makes a daily driver (added from a load) a regular driver (owner request 4 Oct 2026).
      const input = await parseBody(r, driverPatchSchema);
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
      // Deactivated with the Active switch: the trucks' default driver is kept, and said so (audit F20).
      const warning = before.active && !after.active ? driverDeactivatedWarning(await defaultOfTrucks(db, after.id)) : null;
      return ok(warning ? { ...after, warning } : after);
    },
    { role: 'TENANT_ADMIN' },
  )(req);

/**
 * "Delete" a driver = DEACTIVATE, always (audit F20, owner decision 8). A driver is never deleted
 * from the screen or the API: a delete could run at the same instant as an assignment and
 * dispatch (it counted zero loads, then removed the driver from a load dispatched meanwhile),
 * and it cleared every truck's default driver without a word. Deactivated, the driver stays on
 * every load and shift they have, stays the default driver of their trucks (the answer names
 * them), and is no longer used by new plans. The database refuses a delete of a driver still on
 * a load or still a truck's default (NO ACTION keys, migration 20260930093000_master_data_no_orphans).
 */
export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.driver.findUnique({ where: { id: params.id }, select: DRIVER_PUBLIC_SELECT }));
      const after = before.active ? await db.driver.update({ where: { id: params.id }, data: { active: false }, select: DRIVER_PUBLIC_SELECT }) : before;
      const [loads, trucks] = await Promise.all([db.planLoad.count({ where: { driverId: params.id } }), defaultOfTrucks(db, params.id)]);
      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'Driver',
        entityId: after.id,
        beforeJson: before as never,
        afterJson: { ...after, softDeleted: true, usedOnLoads: loads, defaultOfTrucks: trucks } as never,
        ip,
      });
      const warning = driverDeactivatedWarning(trucks);
      return ok({ softDeleted: true, driver: after, defaultOfTrucks: trucks, ...(warning ? { warning } : {}) });
    },
    { role: 'TENANT_ADMIN' },
  )(req);
