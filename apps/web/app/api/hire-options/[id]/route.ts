import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { hireOptionPatchSchema, hireOptionSizeProblem } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { historyOnlyDepotLinkMessage } from '@/lib/master-data-delete';

interface Params { params: { id: string } }

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
      }
      const after = await db.hireOption.update({ where: { id: params.id }, data: input });
      await audit({ tenantId: user.tenantId, userId: user.id, action: 'UPDATE', entity: 'HireOption', entityId: after.id, beforeJson: before as never, afterJson: after as never, ip });
      return ok(after);
    },
    { role: 'TENANT_ADMIN' },
  )(req);

// Deleted at once: the one-day trucks rented from it keep their own figures (their link is cleared).
export const DELETE = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.hireOption.findUnique({ where: { id: params.id } }));
      await db.hireOption.delete({ where: { id: params.id } });
      await audit({ tenantId: user.tenantId, userId: user.id, action: 'DELETE', entity: 'HireOption', entityId: params.id, beforeJson: before as never, ip });
      return ok({ deleted: true });
    },
    { role: 'TENANT_ADMIN' },
  )(req);
