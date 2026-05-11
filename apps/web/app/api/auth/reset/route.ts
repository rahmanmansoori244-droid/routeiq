import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { consumeResetToken } from '@/lib/password-reset';
import { rateLimit, LIMITS } from '@/lib/rate-limit';

const schema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(8).max(200),
});

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const limit = rateLimit(`auth:reset:${ip}`, LIMITS.auth.limit, LIMITS.auth.windowMs);
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

  const result = await consumeResetToken(parsed.data.token);
  if (!result.ok) {
    // Don't differentiate invalid vs expired vs used — same response avoids
    // probing for token states.
    return NextResponse.json({ data: null, error: 'This reset link is invalid or has expired.' }, { status: 400 });
  }

  const hash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({
    where: { id: result.userId },
    data: { passwordHash: hash },
  });

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
