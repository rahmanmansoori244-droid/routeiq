import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { audit } from './audit';
import { verifyCredentials } from './auth-credentials';
import { isSuperAdminEmail, refreshSessionClaims, withinAbsoluteLifetime, type SessionClaims } from './session-principal';
import type { Role } from '@prisma/client';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      tenantId: string | null;
      role: Role;
      name: string;
      email: string;
    } & DefaultSession['user'];
  }

  // Augment User additively — keep the built-in optional id/name/email and
  // add our custom fields.
  interface User {
    tenantId?: string | null;
    role?: Role;
    /** Password fingerprint (lib/session-principal.ts), present at sign-in only. */
    pwf?: string;
  }
}

// NextAuth.js v5 (beta) JWT type augmentation is fragile across beta versions
// — instead of using module augmentation, we cast the token in the callbacks.
// The fields we add to the JWT are: userId, tenantId, role, pwf (password fingerprint) and
// authTime (sign-in time, ms). See lib/session-principal.ts.

/** Idle timeout: the cookie slides forward on use, but never past SESSION_ABSOLUTE_MS (12 h). */
const SESSION_IDLE_SEC = 60 * 60 * 8;

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt', maxAge: SESSION_IDLE_SEC },
  pages: { signIn: '/login' },
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      // Throttling, dummy compare and the tenant/active checks live in lib/auth-credentials.ts.
      authorize: (raw, request) => verifyCredentials(raw, request),
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      const t = token as SessionClaims;
      if (user) {
        t.userId = user.id;
        t.tenantId = user.tenantId ?? null;
        t.role = user.role ?? 'VIEWER';
        t.pwf = user.pwf;
        t.authTime = Date.now();
        return token;
      }
      // Absolute lifetime: DB-free, so it is enforced in the edge middleware too.
      if (!withinAbsoluteLifetime(t)) return null;
      // The edge runtime cannot reach Postgres; the Node runtime re-checks the user below. Next
      // replaces NEXT_RUNTIME at build time, so the edge bundle never contains that branch.
      if (process.env.NEXT_RUNTIME === 'edge') return token;
      return (await refreshSessionClaims(t)) as typeof token | null;
    },
    async session({ session, token }) {
      const t = token as { userId: string; tenantId: string | null; role: Role };
      session.user.id = t.userId;
      session.user.tenantId = t.tenantId;
      session.user.role = t.role;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      // Audit-log every successful login. Cross-tenant access checks live
      // in getCurrentTenant(); this hook just records the auth event itself.
      if (!user?.id) return;
      // SUPER_ADMIN users with no tenantId — log against the user's null tenant
      // is illegal (AuditLog.tenantId is non-null). Skip; super-admin actions
      // are covered separately when they cross into a tenant (CROSS_TENANT_VIEW).
      if (!user.tenantId) return;
      try {
        await audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'LOGIN',
          entity: 'User',
          entityId: user.id,
        });
      } catch (err) {
        console.error('audit LOGIN failed', err);
      }
    },
  },
});

export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 12);
}

/** True when the email is in SUPER_ADMIN_EMAILS. On its own this grants nothing: see prisma/grant-platform-admin.ts. */
export function isSuperAdmin(email: string): boolean {
  return isSuperAdminEmail(email);
}
