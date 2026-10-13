import { withTenantApi, ok, parseBody, notFoundIfNull, fail } from '@/lib/api';
import { helperPatchSchema } from '@/lib/schemas';
import { audit } from '@/lib/audit';
import { helperChangesRefused } from '@/lib/rbac';
import { HELPER_PUBLIC_SELECT, helperDeactivatedWarning } from '@/lib/dispatch/load-helpers';
import { codeTaken, withCodeCheck } from '@/lib/unique-code';

interface Params { params: { id: string } }

export const GET = (req: Request, { params }: Params) =>
  withTenantApi(async (_r, { db }) => ok(notFoundIfNull(await db.helper.findUnique({ where: { id: params.id }, select: HELPER_PUBLIC_SELECT }))))(req);

/**
 * Helpers (truck crew), owner request 13 Oct 2026, kept like drivers: only the fields sent change (a
 * field left out stays, an empty or null phone clears it). The dispatcher (PLANNER and up) changes
 * the name, the phone and Active (deactivate / reactivate: helpers are never deleted, so every load
 * keeps who went on it); a new code stays the company admin's (403 ADMIN_ONLY_HELPER_FIELD, nothing
 * saved), and a code another helper has answers 409 CODE_TAKEN. Audited UPDATE with before and after.
 */
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { db, user, ip }) => {
      const before = notFoundIfNull(await db.helper.findUnique({ where: { id: params.id }, select: HELPER_PUBLIC_SELECT }));
      const input = await parseBody(r, helperPatchSchema);
      if (helperChangesRefused(user.role, before, input).length) {
        return fail(
          {
            error: 'Only a company admin can change a helper code. A dispatcher can change the name, the phone and Active. Nothing was saved.',
            code: 'ADMIN_ONLY_HELPER_FIELD',
            fields: ['code'],
          },
          403,
        );
      }
      const newCode = input.code !== undefined && input.code !== before.code ? input.code : undefined;
      if (newCode && (await db.helper.findFirst({ where: { code: newCode, id: { not: params.id } }, select: { id: true } }))) throw codeTaken('Helper', newCode);
      const after = await withCodeCheck('Helper', newCode, () => db.helper.update({ where: { id: params.id }, data: input, select: HELPER_PUBLIC_SELECT }));
      await audit({ tenantId: user.tenantId, userId: user.id, action: 'UPDATE', entity: 'Helper', entityId: after.id, beforeJson: before as never, afterJson: after as never, ip });
      // Deactivated: he stays on his loads and stays the usual helper of his trucks - said so, never cleared.
      if (before.active && !after.active) {
        const trucks = await db.truck.findMany({ where: { defaultHelperId: after.id }, select: { code: true }, orderBy: { code: 'asc' } });
        const warning = helperDeactivatedWarning(trucks.map((t) => t.code));
        if (warning) return ok({ ...after, warning });
      }
      return ok(after);
    },
    { role: 'PLANNER' },
  )(req);
