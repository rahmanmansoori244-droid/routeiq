/**
 * POST /api/account/password - the signed-in user changes their OWN password ("Change password" in
 * the user menu; owner request 24 Oct 2026: every user changes their password).
 * Body: { currentPassword, newPassword }.
 *
 * Every role, SUPER_ADMIN included, with or without a company: withAccountApi (lib/api.ts) acts on
 * the session's own user only, so no id is taken from the request. The work is changeOwnPassword
 * (lib/own-password.ts): throttled after wrong current passwords, the current password checked with
 * bcrypt, the new one checked (lib/password-rules.ts), then one transaction under the user's
 * credential lock (the hash replaced only while it is still the checked one, reset links retired,
 * a PASSWORD_CHANGED audit row). Every open session of the user then ends, this one included: the
 * caller signs in again with the new password.
 *
 * Answers: 200 { changed: true, signInAgain: true }; 400 WEAK_PASSWORD / WRONG_PASSWORD (and a body
 * that is not { currentPassword, newPassword }); 401 no session (or the account is gone or
 * inactive); 409 CHANGED_MEANWHILE; 429 THROTTLED or too many requests. Never cached.
 */
import { z } from 'zod';
import { withAccountApi, ok, fail, parseBody } from '@/lib/api';
import { changeOwnPassword } from '@/lib/own-password';

export const dynamic = 'force-dynamic';

// Loose bounds for the body only; the real rules (12 to 200 characters, ...) are lib/password-rules.ts.
const schema = z.object({
  // As the sign-in form: a current password is at most 200 characters.
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().max(1000),
});

const noStore = (res: Response) => {
  res.headers.set('Cache-Control', 'no-store');
  return res;
};

export const POST = withAccountApi(
  async (req, { user, ip }) => {
    const body = await parseBody(req, schema);
    const result = await changeOwnPassword({ userId: user.id, currentPassword: body.currentPassword, newPassword: body.newPassword, ip });
    if (!result.ok) return noStore(fail({ error: result.message, code: result.code }, result.status));
    return noStore(ok({ changed: true, signInAgain: true }));
  },
  // Every attempt, right or wrong, per user: bounds the bcrypt work one session can ask for.
  { rateLimitKey: 'account-password', rateLimitLimit: 20, rateLimitWindowMs: 60 * 60_000 },
);
