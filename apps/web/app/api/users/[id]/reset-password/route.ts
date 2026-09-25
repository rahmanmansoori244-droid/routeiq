/**
 * POST /api/users/:id/reset-password - a tenant admin gives a user of their company a new one-time
 * password, returned once to share over a secure channel (the twin of the invite flow).
 *
 * This is how a password is reset when reset email is not configured (RESEND_API_KEY), and the
 * quickest way when it is. In one transaction the password hash is replaced, the user's
 * outstanding reset links are retired and an audit row is written (who reset whom; never a hash).
 * The cached session state is then dropped, so every open session of the user ends on its next
 * request (the password fingerprint no longer matches).
 *
 * - A platform admin (SUPER_ADMIN) is managed by the owner-run script: 403 unless the caller is one.
 * - Not for your own account: your session would end with the dialog still open.
 * - An inactive user can be reset (e.g. before reactivating them); it does not reactivate them.
 */
import { Role } from '@prisma/client';
import { withTenantApi, ok, fail, notFoundIfNull } from '@/lib/api';
import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { invalidatePrincipal } from '@/lib/session-principal';
import { generateTempPassword } from '@/lib/temp-password';

interface Params { params: { id: string } }

export const dynamic = 'force-dynamic';

export const POST = (req: Request, { params }: Params) =>
  withTenantApi(
    async (_r, { user, ip }) => {
      const target = notFoundIfNull(
        await prisma.user.findFirst({
          where: { id: params.id, tenantId: user.tenantId },
          select: { id: true, email: true, role: true },
        }),
      );
      if (target.role === Role.SUPER_ADMIN && user.role !== Role.SUPER_ADMIN) {
        return fail('This user is a platform admin; only a platform admin can reset their password.', 403);
      }
      if (target.id === user.id) {
        return fail('You cannot reset your own password here. Ask another admin of your company, or use "Forgot your password?" on the sign-in page.', 400);
      }

      const tempPassword = generateTempPassword();
      // bcrypt is slow: hash outside the transaction.
      const passwordHash = await hashPassword(tempPassword);
      const done = await prisma.$transaction(async (tx) => {
        // Scoped to the tenant again, so a cross-tenant id can never be reset.
        const updated = await tx.user.updateMany({
          where: { id: target.id, tenantId: user.tenantId },
          data: { passwordHash },
        });
        if (updated.count !== 1) return false;
        await tx.passwordResetToken.updateMany({
          where: { userId: target.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        await audit(
          {
            tenantId: user.tenantId,
            userId: user.id,
            action: 'PASSWORD_RESET_BY_ADMIN',
            entity: 'User',
            entityId: target.id,
            afterJson: { email: target.email },
            ip,
          },
          tx,
        );
        return true;
      });
      if (!done) return fail('User not found in this tenant.', 404);
      invalidatePrincipal(target.id);

      const res = ok({ user: { id: target.id, email: target.email }, tempPassword });
      res.headers.set('Cache-Control', 'no-store');
      return res;
    },
    { role: 'TENANT_ADMIN', rateLimitKey: 'users-reset-password', rateLimitLimit: 30, rateLimitWindowMs: 60 * 60_000 },
  )(req);
