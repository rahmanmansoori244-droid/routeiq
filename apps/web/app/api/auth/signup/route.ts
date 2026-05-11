import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma, Role, CapacityUnit } from '@prisma/client';
import { prisma } from '@/lib/db';
import { hashPassword, isSuperAdmin } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { validateSlug } from '@/lib/tenant';
import { rateLimit, LIMITS } from '@/lib/rate-limit';

const signupSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  slug: z.string().trim().min(3).max(32),
  country: z.string().trim().min(2).max(64),
  currency: z.string().trim().min(3).max(8).default('OMR'),
  primaryUnit: z.nativeEnum(CapacityUnit).default('CASES'),
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(2).max(120),
});

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const limit = rateLimit(`auth:signup:${ip}`, LIMITS.auth.limit, LIMITS.auth.windowMs);
  if (!limit.ok) {
    return NextResponse.json(
      { data: null, error: 'Too many signup attempts. Try again shortly.' },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ data: null, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { data: null, error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const slugCheck = validateSlug(input.slug);
  if (!slugCheck.ok) {
    return NextResponse.json({ data: null, error: slugCheck.error }, { status: 400 });
  }
  const slug = slugCheck.slug;

  const email = input.email.toLowerCase();
  const passwordHash = await hashPassword(input.password);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingTenant = await tx.tenant.findUnique({ where: { slug } });
      if (existingTenant) throw new Error('SLUG_TAKEN');

      const existingUser = await tx.user.findUnique({ where: { email } });
      if (existingUser) throw new Error('EMAIL_TAKEN');

      const tenant = await tx.tenant.create({
        data: {
          slug,
          name: input.companyName,
          country: input.country,
          currency: input.currency,
          primaryUnit: input.primaryUnit,
          config: { create: {} },
        },
      });

      const role: Role = isSuperAdmin(email) ? 'SUPER_ADMIN' : 'TENANT_ADMIN';

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          passwordHash,
          name: input.name,
          role,
        },
      });

      await audit(
        {
          tenantId: tenant.id,
          userId: user.id,
          action: 'SIGNUP',
          entity: 'Tenant',
          entityId: tenant.id,
          afterJson: { slug: tenant.slug, name: tenant.name, country: tenant.country },
          ip,
        },
        tx,
      );

      return { tenant, user };
    });

    return NextResponse.json(
      {
        data: {
          tenantSlug: result.tenant.slug,
          userId: result.user.id,
          email: result.user.email,
        },
        error: null,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'SLUG_TAKEN') {
      return NextResponse.json({ data: null, error: 'That tenant slug is already taken.' }, { status: 409 });
    }
    if (err instanceof Error && err.message === 'EMAIL_TAKEN') {
      return NextResponse.json(
        { data: null, error: 'An account with that email already exists.' },
        { status: 409 },
      );
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json({ data: null, error: 'That tenant or email is already taken.' }, { status: 409 });
    }
    console.error('signup failed', err);
    return NextResponse.json({ data: null, error: 'Signup failed. Please try again.' }, { status: 500 });
  }
}
