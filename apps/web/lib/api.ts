import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { Prisma, type Role } from '@prisma/client';
import { auth } from './auth';
import { prisma } from './db';
import { tenantDb, type TenantDb } from './tenant';
import { rateLimit, type RateLimitResult } from './rate-limit';
import { clientIp } from './client-ip';
import { HttpError, httpErrorBody } from './http-error';

export interface AuthedContext {
  user: {
    id: string;
    tenantId: string;
    role: Role;
    name: string;
    email: string;
  };
  db: TenantDb;
  ip: string | null;
}

interface OkBody<T> { data: T; error: null }
interface ErrBody { data: null; error: string | Record<string, unknown> }

export function ok<T>(data: T, status = 200) {
  return NextResponse.json<OkBody<T>>({ data, error: null }, { status });
}

export function fail(error: string | Record<string, unknown>, status = 400) {
  return NextResponse.json<ErrBody>({ data: null, error }, { status });
}

const ROLE_RANK: Record<Role, number> = {
  SUPER_ADMIN: 100,
  TENANT_ADMIN: 80,
  SUPERVISOR: 60,
  PLANNER: 50,
  VIEWER: 10,
};

export function hasRole(actual: Role, required: Role) {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/**
 * Wrap an API handler with: auth check, tenant resolution, role gate,
 * Zod body parsing, rate limit, and uniform error handling.
 *
 * Cross-tenant access never reaches the handler — unauthenticated returns 401,
 * tenantless users get 403, role-insufficient gets 403. Resource ownership is
 * still enforced by tenantDb() at the query level.
 */
export interface ApiOptions {
  role?: Role;
  rateLimitKey?: string;
  rateLimitLimit?: number;
  rateLimitWindowMs?: number;
}

export function withTenantApi(handler: (req: Request, ctx: AuthedContext) => Promise<Response>, opts: ApiOptions = {}) {
  return async (req: Request) => {
    try {
      const session = await auth();
      if (!session?.user) return fail('Unauthorized', 401);
      if (!session.user.tenantId) return fail('No tenant on session', 403);

      const ip = clientIp(req);

      if (opts.rateLimitKey) {
        const key = `${opts.rateLimitKey}:${session.user.tenantId}:${session.user.id}`;
        const r: RateLimitResult = rateLimit(key, opts.rateLimitLimit ?? 300, opts.rateLimitWindowMs ?? 60_000);
        if (!r.ok) return fail('Too many requests', 429);
      }

      if (opts.role && !hasRole(session.user.role, opts.role)) {
        return fail('Forbidden', 403);
      }

      const ctx: AuthedContext = {
        user: {
          id: session.user.id,
          tenantId: session.user.tenantId,
          role: session.user.role,
          name: session.user.name,
          email: session.user.email,
        },
        db: tenantDb(session.user.tenantId),
        ip,
      };

      return await handler(req, ctx);
    } catch (err) {
      return handleError(err);
    }
  };
}

// An expected, user-facing failure with its HTTP status (lib/http-error.ts): PlanError,
// RouteAdjustError and BatchRaceError extend it, so an uncaught one maps to its status here.
export { HttpError };

export function handleError(err: unknown) {
  if (err instanceof HttpError) {
    return fail(httpErrorBody(err), err.status);
  }
  if (err instanceof ZodError) {
    return fail(err.flatten(), 400);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return fail('A record with this unique value already exists.', 409);
    if (err.code === 'P2025') return fail('Not found.', 404);
    if (err.code === 'P2003') return fail('Referenced record does not exist.', 400);
  }
  console.error('API error', err);
  return fail('Internal server error', 500);
}

/** The parsed body: the schema's OUTPUT type (a field that preprocesses '' to null is typed as its output). */
export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ZodError([{ code: 'custom', path: [], message: 'Invalid JSON body' }]);
  }
  return schema.parse(raw);
}

/**
 * Cross-tenant returns 404 (not 403) — see CLAUDE.md §3. Since tenantDb already
 * scopes by tenantId, a findUnique that targets another tenant returns null,
 * which we map to 404 here.
 */
export function notFoundIfNull<T>(value: T | null): T {
  if (value === null || value === undefined) {
    throw new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: '5' });
  }
  return value;
}
