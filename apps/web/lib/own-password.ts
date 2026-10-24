/**
 * "Change password": a signed-in user replaces their OWN password (POST /api/account/password, the
 * user menu's "Change password"). Owner request of 24 Oct 2026: every user changes their password,
 * and until now only an admin could give OTHER users a temporary one
 * (app/api/users/[id]/reset-password) and reset email is not configured.
 *
 * Every role, SUPER_ADMIN included, with or without a company. The steps:
 *
 * 1. Throttle: after LIMITS.ownPasswordFailures wrong current passwords (5 in 15 min) the user's
 *    password changes pause - checked before any work, like the sign-in throttle. Soft: it never
 *    blocks signing in, and a correct current password clears the count.
 * 2. The user is read from the database (never from the request): gone or inactive = the session
 *    is over (401).
 * 3. The new password is checked (lib/password-rules.ts: 12 to 200 characters, not the current one,
 *    not the email) before any bcrypt work.
 * 4. The current password is checked with bcrypt against the stored hash; a wrong one counts as a
 *    failure (400 WRONG_PASSWORD).
 * 5. The new hash is made outside the transaction (bcrypt cost 12, hashPassword in lib/auth.ts),
 *    then ONE transaction, like the admin reset: the user's row is locked first
 *    (lockUserCredentials, audit F10: one credential change per user at a time, always user then
 *    links, so it cannot deadlock with a reset link or an admin reset), the hash is replaced only
 *    while it is still the one the current password was checked against (an admin reset or a reset
 *    link that committed in between wins: 409 CHANGED_MEANWHILE, nothing written), the user's
 *    outstanding reset links are retired, and a PASSWORD_CHANGED audit row is written in the user's
 *    company (the email only; never a hash or a password). A platform admin without a company has
 *    no company to write an audit row in (AuditLog.tenantId is required; the LOGIN row is skipped
 *    for them too), so one log line without the email is written instead.
 * 6. The cached session state is dropped (invalidatePrincipal). Every session carries a fingerprint
 *    of the password hash (lib/session-principal.ts), so EVERY open session of the user ends on its
 *    next request - the caller's own included: the session design sets the fingerprint only at
 *    sign-in, so the caller signs in again with the new password (the dialog says so and signs out).
 *    That is also the safer way: a session cookie copied to another browser stops working too.
 */
import bcrypt from 'bcryptjs';
import { prisma } from './db';
import { hashPassword } from './auth';
import { audit } from './audit';
import { LIMITS, limiter, type RateLimiter } from './rate-limit';
import { lockUserCredentials } from './password-reset';
import { invalidatePrincipal } from './session-principal';
import { newPasswordProblem } from './password-rules';

export type ChangeOwnPasswordCode = 'THROTTLED' | 'NO_ACCOUNT' | 'WEAK_PASSWORD' | 'WRONG_PASSWORD' | 'CHANGED_MEANWHILE';

export type ChangeOwnPasswordResult =
  | { ok: true; auditWritten: boolean }
  | { ok: false; status: 400 | 401 | 409 | 429; code: ChangeOwnPasswordCode; message: string };

export const OWN_PASSWORD_MESSAGES: Record<ChangeOwnPasswordCode, string> = {
  THROTTLED: 'Too many wrong current passwords. Changing your password is paused for up to 15 minutes; try again later.',
  NO_ACCOUNT: 'Your session has ended. Please sign in again.',
  WEAK_PASSWORD: 'This new password cannot be used.',
  WRONG_PASSWORD: 'Your current password is not right. The password was not changed.',
  CHANGED_MEANWHILE: 'Your password was changed meanwhile (by an admin or a reset link), so it was not changed here. Sign in again with the newest password.',
};

export interface ChangeOwnPasswordInput {
  /** The signed-in user (the session's id; never an id from the request body). */
  userId: string;
  currentPassword: string;
  newPassword: string;
  ip: string | null;
}

type OwnPasswordDb = Pick<typeof prisma, 'user' | '$transaction'>;

export interface ChangeOwnPasswordDeps {
  db?: OwnPasswordDb;
  limiter?: RateLimiter;
  hash?: (plain: string) => Promise<string>;
}

/** The throttle key of one user's wrong current passwords. */
export function ownPasswordFailKey(userId: string): string {
  return `account-password:fail:${userId}`;
}

const refused = (status: 400 | 401 | 409 | 429, code: ChangeOwnPasswordCode, message = OWN_PASSWORD_MESSAGES[code]): ChangeOwnPasswordResult => ({
  ok: false,
  status,
  code,
  message,
});

export async function changeOwnPassword(input: ChangeOwnPasswordInput, deps: ChangeOwnPasswordDeps = {}): Promise<ChangeOwnPasswordResult> {
  const db = deps.db ?? prisma;
  const lim = deps.limiter ?? limiter;
  const hash = deps.hash ?? hashPassword;
  const failKey = ownPasswordFailKey(input.userId);

  // 1. Paused after too many wrong current passwords: no bcrypt work at all.
  if (lim.isBlocked(failKey, LIMITS.ownPasswordFailures.limit)) return refused(429, 'THROTTLED');

  // 2. The account as the database has it.
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, tenantId: true, active: true, passwordHash: true },
  });
  if (!user || !user.active) return refused(401, 'NO_ACCOUNT');

  // 3. The new password's rules (cheap; compares the two typed values, never the stored hash).
  const problem = newPasswordProblem(input.newPassword, { currentPassword: input.currentPassword, email: user.email });
  if (problem) return refused(400, 'WEAK_PASSWORD', problem);

  // 4. The current password.
  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
    lim.hit(failKey, LIMITS.ownPasswordFailures.windowMs);
    return refused(400, 'WRONG_PASSWORD');
  }
  lim.reset(failKey);

  // 5. bcrypt is slow: hash outside the transaction.
  const passwordHash = await hash(input.newPassword);
  const outcome = await db.$transaction(async (tx) => {
    // The user's row first, like a reset link being used or an admin reset (audit F10).
    if (!(await lockUserCredentials(tx, user.id))) return 'gone' as const;
    // Only while the hash is still the one the current password was checked against.
    const updated = await tx.user.updateMany({
      where: { id: user.id, passwordHash: user.passwordHash, active: true },
      data: { passwordHash },
    });
    if (updated.count !== 1) {
      // Deactivated meanwhile: the session is over. Otherwise the hash changed after the check.
      const now = await tx.user.findUnique({ where: { id: user.id }, select: { active: true } });
      return now?.active ? ('changed' as const) : ('gone' as const);
    }
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    if (user.tenantId) {
      await audit(
        {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'PASSWORD_CHANGED',
          entity: 'User',
          entityId: user.id,
          afterJson: { email: user.email },
          ip: input.ip,
        },
        tx,
      );
      return 'audited' as const;
    }
    return 'done' as const;
  });
  if (outcome === 'gone') return refused(401, 'NO_ACCOUNT');
  if (outcome === 'changed') return refused(409, 'CHANGED_MEANWHILE');

  // 6. Every open session of this user ends on its next request (the fingerprint no longer matches).
  invalidatePrincipal(user.id);
  if (outcome === 'done') {
    console.info('[account] a platform admin without a company changed their password (no company to write an audit row in)', { userId: user.id });
  }
  return { ok: true, auditWritten: outcome === 'audited' };
}
