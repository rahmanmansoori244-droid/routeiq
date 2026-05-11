import { randomBytes } from 'crypto';
import { Role } from '@prisma/client';
import { withTenantApi, ok, fail, parseBody } from '@/lib/api';
import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { userInviteSchema } from '@/lib/schemas';

export const GET = withTenantApi(async (_req, { user }) => {
  // Users on a tenant aren't routed through tenantDb (the User model has nullable
  // tenantId; we filter explicitly here).
  const users = await prisma.user.findMany({
    where: { tenantId: user.tenantId },
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });
  return ok(users);
});

function generateTempPassword(): string {
  // 16-byte base64url ≈ 22 chars — strong enough for a one-shot temp pwd.
  return randomBytes(16).toString('base64').replace(/[+/=]/g, '').slice(0, 18);
}

export const POST = withTenantApi(
  async (req, { user, ip }) => {
    const input = await parseBody(req, userInviteSchema);
    if (input.role === Role.SUPER_ADMIN) return fail('Cannot create a SUPER_ADMIN from here.', 403);

    const email = input.email.toLowerCase();
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return fail('A user with this email already exists.', 409);

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
