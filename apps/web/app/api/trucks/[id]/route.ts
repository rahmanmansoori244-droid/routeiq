import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { truckHoursProblem, truckPatchSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { historyOnlyDepotLinkMessage } from '@/lib/master-data-delete';
import { truckFieldsRefused } from '@/lib/rbac';

interface Params { params: { id: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => {
    const truck = notFoundIfNull(await db.truck.findUnique({ where: { id: params.id } }));
    return ok(truck);
  })(req);

/**
 * A company admin changes any truck field. The dispatcher (PLANNER and up, owner request 6 Oct 2026)
 * changes the usual (default) driver only - the Drivers page's "Usual driver of each truck"; any other
 * field is refused (403 ADMIN_ONLY_TRUCK_FIELD, nothing saved). A change of the usual driver alone
 * is audited TRUCK_USUAL_DRIVER_SET { truck, from, to } by code and name ("none": no driver), with
 * the ids; any other change UPDATE with the truck before and after.
 */
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.truck.findUnique({ where: { id: params.id } }));
      const input = await parseBody(r, truckPatchSchema);
      const refused = truckFieldsRefused(user.role, input);
      if (refused.length) {
        return fail(
          {
            error: `Only a company admin can change ${refused.join(', ')} of a truck. A dispatcher can change its usual driver only. Nothing was saved.`,
            code: 'ADMIN_ONLY_TRUCK_FIELD',
            fields: refused,
          },
          403,
        );
      }
      const hours = truckHoursProblem({ ...before, ...input });
      if (hours) return fail(hours, 400);
      if (input.depotId) {
        const depot = await db.depot.findUnique({ where: { id: input.depotId } });
        if (!depot) return fail('Depot not found in this tenant', 400);
        if (depot.historyOnly) return fail({ code: 'DEPOT_HISTORY_ONLY', message: historyOnlyDepotLinkMessage(depot.code, 'truck') }, 422);
      }
      // A new default driver must be an active driver of this tenant (keeping the current one
      // is fine even if they were deactivated since - the form sends every field back).
      if (input.defaultDriverId && input.defaultDriverId !== before.defaultDriverId) {
        const driver = await db.driver.findUnique({ where: { id: input.defaultDriverId }, select: { id: true, name: true, active: true } });
        if (!driver) return fail('Driver not found in this tenant', 400);
        if (!driver.active) return fail(`Driver ${driver.name} is inactive`, 400);
      }
      const after = await db.truck.update({ where: { id: params.id }, data: input });
      const changed = (Object.keys(input) as (keyof typeof input)[]).filter((k) => input[k] !== undefined && input[k] !== (before as Record<string, unknown>)[k]);
      if (changed.length === 1 && changed[0] === 'defaultDriverId') {
        // A row the owner can read (demo of 7 Oct 2026): the truck's code and the drivers by name, as
        // they were at the change, with the ids - not the whole truck row with bare ids.
        const fromId = before.defaultDriverId ?? null;
        const toId = after.defaultDriverId ?? null;
        const ids = [fromId, toId].filter((x): x is string => !!x);
        const names = new Map((await db.driver.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
        const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'unknown driver') : 'none');
        await audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'TRUCK_USUAL_DRIVER_SET',
          entity: 'Truck',
          entityId: after.id,
          afterJson: { truck: after.code, from: nameOf(fromId), to: nameOf(toId), truckId: after.id, fromDriverId: fromId, toDriverId: toId },
          ip,
        });
        return ok(after);
      }
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
    { role: 'PLANNER' },
  )(req);

export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.truck.findUnique({ where: { id: params.id } }));
      // Anything that names the truck keeps it (deactivated, never deleted): plan rows, and the
      // delivery outcome's driver links and stop visits (NO ACTION keys) - a driver link is made when
      // driver sheets are printed, even for a truck no plan uses any more.
      const [assignments, links, visits] = await Promise.all([
        db.routeAssignment.count({ where: { truckId: params.id } }),
        db.driverLink.count({ where: { truckId: params.id } }),
        db.stopVisit.count({ where: { truckId: params.id } }),
      ]);
      if (assignments + links + visits > 0) {
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
