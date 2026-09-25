import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createResetTokenForEmail, deliverResetEmail } from '@/lib/password-reset';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { audit } from '@/lib/audit';
import { clientIp } from '@/lib/client-ip';

const schema = z.object({ email: z.string().email().max(254) });

export const dynamic = 'force-dynamic';

const SENT = () => NextResponse.json({ data: { sent: true }, error: null }, { status: 200 });

/**
 * POST /api/auth/forgot
 *
 * Always responds 200 with the same JSON body so the caller can't enumerate
 * which emails exist in the system. The actual outcome is decided server-side,
 * and the audit row and email delivery run AFTER the response (fire-and-forget),
 * so the response time does not reveal whether the account exists either.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const limit = rateLimit(`auth:forgot:${ip ?? 'unknown'}`, LIMITS.auth.limit, LIMITS.auth.windowMs);
  if (!limit.ok) return SENT(); // same shape even on rate limit

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return SENT();
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return SENT();

  const email = parsed.data.email.trim().toLowerCase();
  const result = await createResetTokenForEmail(email);
  if (result.status === 'created' && result.rawToken && result.userId) {
    const { rawToken, userId, tenantId } = result;
    void (async () => {
      // Audit log under the user's tenant (best effort).
      if (tenantId) {
        try {
          await audit({
            tenantId,
            userId,
            action: 'UPDATE',
            entity: 'PasswordResetToken',
            entityId: null,
            afterJson: { issuedFor: email } as never,
            ip,
          });
        } catch (err) {
          console.error('[forgot] audit failed', (err as Error)?.message ?? err);
        }
      }
      await deliverResetEmail(email, rawToken, userId);
    })().catch((err) => console.error('[forgot] delivery failed', (err as Error)?.message ?? err));
  }
  // status='throttled' and 'unknown_email' fall through with the same response.
  return SENT();
}
