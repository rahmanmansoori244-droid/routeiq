import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createResetTokenForEmail, deliverResetEmail } from '@/lib/password-reset';
import { rateLimit, LIMITS } from '@/lib/rate-limit';
import { audit } from '@/lib/audit';
import { prisma } from '@/lib/db';

const schema = z.object({ email: z.string().email().max(254) });

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/forgot
 *
 * Always responds 200 with the same JSON body so the caller can't enumerate
 * which emails exist in the system. The actual outcome is decided server-side.
 */
export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const limit = rateLimit(`auth:forgot:${ip}`, LIMITS.auth.limit, LIMITS.auth.windowMs);
  if (!limit.ok) {
    return NextResponse.json(
      { data: { sent: true }, error: null }, // same shape even on rate limit
      { status: 200 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ data: { sent: true }, error: null }, { status: 200 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ data: { sent: true }, error: null }, { status: 200 });
  }

  const result = await createResetTokenForEmail(parsed.data.email);
  if (result.status === 'created' && result.rawToken) {
    // Audit log under the user's tenant (best effort).
    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email.toLowerCase() },
      select: { id: true, tenantId: true },
    });
    if (user?.tenantId) {
      try {
        await audit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'UPDATE',
          entity: 'PasswordResetToken',
          entityId: null,
          afterJson: { issuedFor: parsed.data.email } as never,
          ip,
        });
      } catch (err) {
        console.error('[forgot] audit failed', err);
      }
    }

    const base = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
    const url = `${base}/reset?token=${encodeURIComponent(result.rawToken)}`;
    await deliverResetEmail(parsed.data.email, url);
  }
  // status='throttled' and 'unknown_email' fall through with the same response.
  return NextResponse.json({ data: { sent: true }, error: null }, { status: 200 });
}
