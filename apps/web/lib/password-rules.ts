/**
 * The rules for a password a signed-in user chooses for their own account ("Change password" in the
 * user menu, POST /api/account/password; owner request 24 Oct 2026: every
 * user changes their password).
 *
 * Pure (no server imports): the Change password dialog shows the same messages before it sends.
 *
 * - At least 12 characters (counted as the user sees them: an emoji is one).
 * - At most 200 characters as the sign-in check counts them (JavaScript string length, so an emoji
 *   is two): credentialsSchema in lib/auth-credentials.ts accepts no more, so a longer password
 *   could never be used to sign in.
 * - Not the current password. bcrypt reads only the first 72 bytes of a password, so a new password
 *   that differs from the current one only after those 72 bytes is the same password to bcrypt and
 *   is refused too.
 * - Not the account's email address, nor the part of it before "@" (ignoring case and spaces around).
 */

export const PASSWORD_MIN_CHARS = 12;
export const PASSWORD_MAX_CHARS = 200;
/** bcrypt ignores every byte of a password after the 72nd. */
export const BCRYPT_MAX_BYTES = 72;

/** Characters as the user sees them (code points), not UTF-16 code units. */
export function passwordChars(password: string): number {
  return Array.from(password).length;
}

/** Does bcrypt see these two passwords as the same (equal, or equal in their first 72 bytes of UTF-8)? */
export function sameForBcrypt(a: string, b: string): boolean {
  if (a === b) return true;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  // Shorter than 72 bytes, a password is read whole: two different ones stay different.
  if (ea.length < BCRYPT_MAX_BYTES || eb.length < BCRYPT_MAX_BYTES) return false;
  for (let i = 0; i < BCRYPT_MAX_BYTES; i++) if (ea[i] !== eb[i]) return false;
  return true;
}

export interface NewPasswordContext {
  /** The current password the user typed (already, or about to be, checked against the stored hash). */
  currentPassword: string;
  /** The account's email address. */
  email: string;
}

/** Why this new password is refused (one plain sentence), or null when it may be used. */
export function newPasswordProblem(newPassword: string, ctx: NewPasswordContext): string | null {
  if (passwordChars(newPassword) < PASSWORD_MIN_CHARS) return `The new password must have at least ${PASSWORD_MIN_CHARS} characters.`;
  if (newPassword.length > PASSWORD_MAX_CHARS) return `The new password can have at most ${PASSWORD_MAX_CHARS} characters.`;
  if (sameForBcrypt(newPassword, ctx.currentPassword)) return 'The new password must be different from your current password.';
  const typed = newPassword.trim().toLowerCase();
  const email = ctx.email.trim().toLowerCase();
  const local = email.split('@')[0] ?? '';
  if (typed === email || (local && typed === local)) return 'The new password must not be your email address.';
  return null;
}
