import { z } from 'zod';
import { Role } from '@prisma/client';
import { withTenantApi, ok, fail, notFoundIfNull, parseBody } from '@/lib/api';
import { prisma } from '@/lib/db';
import { audit } from '@/lib/audit';

interface Params { params: { id: string } }

const patchSchema = z.object({
  role: z.nativeEnum(Role).optional(),
  active: z.boolean().optional(),
});

export const PATCH = (req: Request, { params }: Params) =>
  withTenantApi(
    async (r, { user, ip }) => {
      const input = await parseBody(r, patchSchema);
      if (input.role === Role.SUPER_ADMIN) return fail('Cannot assign SUPER_ADMIN from tenant UI.', 403);

      const before = notFoundIfNull(
        await prisma.user.findFirst({
          where: { id: params.id, tenantId: user.tenantId },
          select: { id: true, email: true, name: true, role: true, active: true },
        }),
      );

      // Guard: don't let the only admin demote/deactivate themselves.
      if ((input.role && input.role !== before.role) || input.active === false) {
        const remainingAdmins = await prisma.user.count({
          where: {
            tenantId: user.tenantId,
            active: true,
            role: { in: [Role.TENANT_ADMIN, Role.SUPER_ADMIN] },
            NOT: { id: params.id },
          },
        });
        const willStillBeAdmin = (input.role ?? before.role) === Role.TENANT_ADMIN && (input.active ?? before.active);
        if (!willStillBeAdmin && remainingAdmins === 0) {
          return fail(
            'You are the last active tenant admin — promote another user before changing your own role.',
            400,
          );
        }
      }

      // Defense in depth: findFirst above already validated tenant ownership,
      // but a future refactor could remove that guard. Re-scope the update
      // itself via updateMany so a cross-tenant `id` can never escalate roles.
      const result = await prisma.user.updateMany({
        where: { id: params.id, tenantId: user.tenantId },
        data: input,
      });
      if (result.count !== 1) return fail('User not found in this tenant.', 404);
      const updated = await prisma.user.findUniqueOrThrow({
        where: { id: params.id },
        select: { id: true, email: true, name: true, role: true, active: true },
      });

      await audit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'UPDATE',
        entity: 'User',
        entityId: updated.id,
        beforeJson: { role: before.role, active: before.active } as never,
        afterJson: { role: updated.role, active: updated.active } as never,
        ip,
      });

      return ok(updated);
    },
    { role: 'TENANT_ADMIN' },
  )(req);
