import { NextResponse } from 'next/server';
import { z } from 'zod';
import { hashPassword } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { resetPasswordWithToken, resetTokenUsable } from '@/lib/password-reset';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { clientIp } from '@/lib/client-ip';
import { invalidatePrincipal } from '@/lib/session-principal';

const schema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(8).max(200),
});

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const ip = clientIp(req);
  const limit = rateLimit(`auth:reset:${ip ?? 'unknown'}`, LIMITS.auth.limit, LIMITS.auth.windowMs);
  if (!limit.ok) {
    return NextResponse.json({ data: null, error: 'Too many attempts. Try again shortly.' }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ data: null, error: 'Invalid request body.' }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ data: null, error: 'Invalid request.' }, { status: 400 });
  }

  // Don't differentiate invalid vs expired vs used — same response avoids
  // probing for token states.
  const invalid = () =>
    NextResponse.json({ data: null, error: 'This reset link is invalid or has expired.' }, { status: 400 });

  // Cheap read-only check first, so junk tokens never cost a bcrypt hash. Then hash (slow, outside
  // the transaction), then consume the token and set the password in ONE transaction that also
  // retires the user's other reset links.
  if (!(await resetTokenUsable(parsed.data.token))) return invalid();
  const hash = await hashPassword(parsed.data.newPassword);
  const result = await resetPasswordWithToken(parsed.data.token, hash);
  if (!result.ok) return invalid();
  // Sessions carry a fingerprint of the password hash: every open session of this user ends on
  // its next request. Drop the cached copy so that happens now.
  invalidatePrincipal(result.userId);

  if (result.tenantId) {
    try {
      await audit({
        tenantId: result.tenantId,
        userId: result.userId,
        action: 'UPDATE',
        entity: 'User',
        entityId: result.userId,
        afterJson: { passwordReset: true } as never,
        ip,
      });
    } catch (err) {
      console.error('[reset] audit failed', err);
    }
  }

  return NextResponse.json({ data: { ok: true }, error: null }, { status: 200 });
}
