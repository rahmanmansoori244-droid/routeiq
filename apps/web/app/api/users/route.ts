import { Role } from '@prisma/client';
import { withTenantApi, ok, fail, parseBody } from '@/lib/api';
import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { userInviteSchema } from '@/lib/schemas';
import { generateTempPassword } from '@/lib/temp-password';

// TENANT_ADMIN, like the Users page (review F15): staff emails and roles are admin data.
export const GET = withTenantApi(
  async (_req, { user }) => {
    // Users on a tenant aren't routed through tenantDb (the User model has nullable
    // tenantId; we filter explicitly here).
    const users = await prisma.user.findMany({
      where: { tenantId: user.tenantId },
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
    });
    return ok(users);
  },
  { role: 'TENANT_ADMIN' },
);

export const POST = withTenantApi(
  async (req, { user, ip }) => {
    const input = await parseBody(req, userInviteSchema);
    if (input.role === Role.SUPER_ADMIN) return fail('Cannot create a SUPER_ADMIN from here.', 403);

    const email = input.email.toLowerCase();
    const exists = await prisma.user.findUnique({ where: { email } });
    // An existing user who lost their password gets a new one with "Reset password"
    // (POST /api/users/:id/reset-password), not a second invite.
    if (exists) return fail('A user with this email already exists. If they are in your company and lost their password, use "Reset password" on their row.', 409);

    const tempPwd = generateTempPassword();
    const hash = await hashPassword(tempPwd);

    const created = await prisma.user.create({
      data: {
        tenantId: user.tenantId,
        email,
        name: input.name,
        role: input.role,
        passwordHash: hash,
      },
      select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
    });

    await audit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'CREATE',
      entity: 'User',
      entityId: created.id,
      afterJson: { email: created.email, name: created.name, role: created.role } as never,
      ip,
    });

    return ok({ user: created, tempPassword: tempPwd, sentEmail: false }, 201);
  },
  { role: 'TENANT_ADMIN' },
);
