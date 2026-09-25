import { randomBytes } from 'crypto';

/**
 * A one-time password that a tenant admin shares with a user by hand: on invite (POST /api/users)
 * and on an admin password reset (POST /api/users/:id/reset-password). 18 characters from
 * [A-Za-z0-9], about 107 bits. It is returned once and stored only as a bcrypt hash.
 */
export function generateTempPassword(): string {
  // 24 random bytes = 32 base64 characters; dropping "+", "/" and "=" still leaves more than 18.
  return randomBytes(24).toString('base64').replace(/[+/=]/g, '').slice(0, 18);
}
