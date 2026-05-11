import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from './db';
import { audit } from './audit';
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
  }
}

// NextAuth.js v5 (beta) JWT type augmentation is fragile across beta versions
// — instead of using module augmentation, we cast the token in the callbacks.
// The fields we add to the JWT are: userId, tenantId, role.

const credentialsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt', maxAge: 60 * 60 * 8 }, // 8h
  pages: { signIn: '/login' },
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email.toLowerCase() },
        });
        if (!user || !user.active) return null;

        const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          tenantId: user.tenantId,
          role: user.role,
          name: user.name,
          email: user.email,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const t = token as Record<string, unknown>;
        t.userId = user.id;
        t.tenantId = (user as { tenantId?: string | null }).tenantId ?? null;
        t.role = (user as { role?: Role }).role ?? 'VIEWER';
      }
      return token;
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
      // are covered separately when they cross into a tenant.
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

export function isSuperAdmin(email: string): boolean {
  const list = (process.env.SUPER_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}
