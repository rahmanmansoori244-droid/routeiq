import { z } from 'zod';
import { Prisma, Role } from '@prisma/client';
import { withTenantApi, ok, fail, notFoundIfNull, parseBody } from '@/lib/api';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';
import { invalidatePrincipal } from '@/lib/session-principal';
import { isLockBusy, setLockTimeout } from '@/lib/dispatch/plan-locks';

interface Params { params: { id: string } }

const patchSchema = z.object({
  role: z.nativeEnum(Role).optional(),
  active: z.boolean().optional(),
});

/** A company-level lock for changes to who administers the company (audit F11). */
async function lockTenantAdmins(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  // FOR NO KEY UPDATE on the Tenant row: two role/active changes of one company wait for each
  // other, while rows that merely reference the tenant (audit rows, orders, plans: FOR KEY SHARE)
  // are never blocked by it.
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR NO KEY UPDATE`;
}

class Refused extends Error {
  constructor(public readonly response: Response) {
    super('refused');
  }
}

/**
 * PATCH /api/users/:id - a tenant admin changes a user's role or deactivates / reactivates them.
 *
 * Audit F11: one transaction takes the company's lock (the Tenant row), then reads the user,
 * checks "at least one active company admin remains" and writes the change and its audit row.
 * Two admins demoting or deactivating each other at the same instant are therefore checked one
 * after the other: the second sees the first's change and is refused (400), so the company always
 * keeps an active admin. Before, each check counted the other admin as still active and both
 * changes went through.
 */
export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const input = await parseBody(r, patchSchema);
      if (input.role === Role.SUPER_ADMIN) return fail('Cannot assign SUPER_ADMIN from tenant UI.', 403);

      let result;
      try {
        result = await prisma.$transaction(
          async (tx) => {
            await setLockTimeout(tx);
            await lockTenantAdmins(tx, user.tenantId);
            // Read under the lock: the state the check and the audit row describe.
            const before = notFoundIfNull(
              await tx.user.findFirst({
                where: { id: params.id, tenantId: user.tenantId },
                select: { id: true, email: true, name: true, role: true, active: true },
              }),
            );

            // A platform admin's account is managed by the owner-run script, not by a tenant admin.
            if (before.role === Role.SUPER_ADMIN && user.role !== Role.SUPER_ADMIN) {
              throw new Refused(fail('This user is a platform admin; only a platform admin can change it.', 403));
            }

            // Guard: the company always keeps at least one active admin.
            if ((input.role && input.role !== before.role) || input.active === false) {
              const remainingAdmins = await tx.user.count({
                where: {
                  tenantId: user.tenantId,
                  active: true,
                  role: { in: [Role.TENANT_ADMIN, Role.SUPER_ADMIN] },
                  NOT: { id: params.id },
                },
              });
              const willStillBeAdmin = (input.role ?? before.role) === Role.TENANT_ADMIN && (input.active ?? before.active);
              if (!willStillBeAdmin && remainingAdmins === 0) {
                throw new Refused(
                  fail(
                    before.id === user.id
                      ? 'You are the last active tenant admin — promote another user before changing your own role.'
                      : 'This is the last active tenant admin of the company — promote another user first.',
                    400,
                  ),
                );
              }
            }

            // Defense in depth: re-scope the update itself so a cross-tenant `id` can never escalate roles.
            const changed = await tx.user.updateMany({
              where: { id: params.id, tenantId: user.tenantId },
              data: input,
            });
            if (changed.count !== 1) throw new Refused(fail('User not found in this tenant.', 404));
            const updated = await tx.user.findUniqueOrThrow({
              where: { id: params.id },
              select: { id: true, email: true, name: true, role: true, active: true },
            });
            // In the same transaction: the change and its audit row commit together.
            await audit(
              {
                tenantId: user.tenantId,
                userId: user.id,
                action: 'UPDATE',
                entity: 'User',
                entityId: updated.id,
                beforeJson: { role: before.role, active: before.active } as never,
                afterJson: { role: updated.role, active: updated.active } as never,
                ip,
              },
              tx,
            );
            return updated;
          },
          { timeout: 15_000, maxWait: 5_000 },
        );
      } catch (e) {
        if (e instanceof Refused) return e.response;
        if (isLockBusy(e)) return fail('Another change to this company\'s users is being saved - retry in a moment.', 409);
        throw e;
      }
      // Role and active are re-read on every request (lib/session-principal.ts); drop the cached
      // copy so the change applies to the user's open sessions now, not after the 30 s cache.
      invalidatePrincipal(params.id);
      return ok(result);
    },
    { role: 'TENANT_ADMIN' },
  )(req);
