import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { hireOptionPatchSchema, hireOptionSizeProblem } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { historyOnlyDepotLinkMessage } from '@/lib/master-data-delete';
import { liveRentalDays } from '@/lib/dispatch/hire-whatif';

interface Params { params: { id: string } }

/**
 * Third review of the hire branch: a truck hired from the option for today or a coming day keeps it
 * counted - its link is never cleared (delete) or moved to another depot under the rental, or the day
 * could be rented past the option's max per day. Switching it off is the way meanwhile.
 */
function inUse(days: string[], what: 'deleted' | 'moved to another depot') {
  return fail(
    {
      code: 'HIRE_OPTION_IN_USE',
      message: `Trucks are hired from this option for ${days.join(', ')}: it cannot be ${what} until their day is over. Switch it off instead (Active) so it is not offered again.`,
    },
    409,
  );
}

// One truck the company can rent for a day (the hire suggestion): company admin. A field left out
// stays as it is; null clears bays or the rental's km charge (= none: fuel is in the hire).
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.hireOption.findUnique({ where: { id: params.id } }));
      const input = await parseBody(r, hireOptionPatchSchema);
      const size = hireOptionSizeProblem({ ...before, ...input });
      if (size) return fail(size, 400);
      if (input.depotId && input.depotId !== before.depotId) {
        const depot = await db.depot.findUnique({ where: { id: input.depotId } });
        if (!depot) return fail('Depot not found in this tenant', 400);
        if (depot.historyOnly) return fail({ code: 'DEPOT_HISTORY_ONLY', message: historyOnlyDepotLinkMessage(depot.code, 'truck') }, 422);
        const days = await liveRentalDays(user.tenantId, params.id);
        if (days.length) return inUse(days, 'moved to another depot');
      }
      const after = await db.hireOption.update({ where: { id: params.id }, data: input });
      await audit({ tenantId: user.tenantId, userId: user.id, action: 'UPDATE', entity: 'HireOption', entityId: after.id, beforeJson: before as never, afterJson: after as never, ip });
      return ok(after);
    },
    { role: 'TENANT_ADMIN' },
  )(req);

// Deleted at once - unless trucks are hired from it for today or a coming day (inUse). The one-day
// trucks of days that are over keep their own figures (their link is cleared).
export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.hireOption.findUnique({ where: { id: params.id } }));
      const days = await liveRentalDays(user.tenantId, params.id);
      if (days.length) return inUse(days, 'deleted');
      await db.hireOption.delete({ where: { id: params.id } });
      await audit({ tenantId: user.tenantId, userId: user.id, action: 'DELETE', entity: 'HireOption', entityId: params.id, beforeJson: before as never, ip });
      return ok({ deleted: true });
    },
    { role: 'TENANT_ADMIN' },
  )(req);
