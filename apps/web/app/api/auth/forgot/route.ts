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
 * and issuing the link, the audit row and email delivery all run AFTER the
 * response (fire-and-forget), so the response time does not reveal whether the
 * account exists either.
 *
 * Review s5-security-2 / web-auth-security-1 (9 Oct 2026): issuing the link used to be awaited
 * before the answer. For a known, active account it locks the user's row and writes in one
 * transaction, while an unknown email costs one SELECT, so a known address answered measurably
 * later (medians 13.7 ms against 8.4 ms). Now every request does the same work before the answer:
 * the rate limit, reading the body and checking it.
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
  void issueAndDeliver(email, ip).catch((err) =>
    console.error('[forgot] reset link not issued or not delivered', (err as Error)?.message ?? err),
  );
  return SENT();
}

/** Runs after the response: issue the link (or not), audit it and send it. */
async function issueAndDeliver(email: string, ip: string | null): Promise<void> {
  const result = await createResetTokenForEmail(email);
  // status='throttled' and 'unknown_email': nothing to send; the caller already has its answer.
  if (result.status !== 'created' || !result.rawToken || !result.userId) return;
  const { rawToken, userId, tenantId } = result;
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
}
