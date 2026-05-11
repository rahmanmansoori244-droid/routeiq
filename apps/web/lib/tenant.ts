import { notFound } from 'next/navigation';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { auth } from './auth';

/**
 * Tenant-scoped Prisma client wrapper.
 *
 * Every query for a tenant-scoped model is rewritten to include
 * `where: { tenantId }` (reads) and `data: { tenantId }` (writes).
 *
 * Direct `prisma.x.findMany()` is forbidden outside platform-admin routes.
 *
 * See CLAUDE.md section 3 (Multi-tenancy architecture) and the
 * tests/tenant-isolation.spec.ts suite that enforces this in CI.
 */
const TENANT_SCOPED_MODELS = new Set([
  'TenantConfig',
  'Depot',
  'Truck',
  'Driver',
  'Region',
  'Customer',
  'Product',
  'UploadBatch',
  'Order',
  'RunPlan',
  'RunJob',
  'ManualBaseline',
  'AuditLog',
  // Module C driver-tracking models. These have explicit tenantId columns;
  // adding them here means the live-dispatcher endpoint can do
  // `db.truckLocation.findFirst({ where: { truckId } })` without manually
  // tacking on tenantId, and a future bug elsewhere can't accidentally read
  // pings from another tenant.
  'DriverShift',
  'TruckLocation',
  'DeliveryProof',
]);

const SCOPED_WRITE_OPS = new Set(['create', 'createMany', 'upsert']);
const SCOPED_READ_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'aggregate',
  'count',
  'groupBy',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

export function tenantDb(tenantId: string) {
  if (!tenantId) {
    throw new Error('tenantDb() called without a tenantId — this would leak across tenants.');
  }

  return prisma.$extends({
    name: 'tenantScope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          if (SCOPED_READ_OPS.has(operation)) {
            const a = args as { where?: Record<string, unknown> };
            a.where = { ...(a.where ?? {}), tenantId };
          }

          if (SCOPED_WRITE_OPS.has(operation)) {
            const a = args as { data?: Record<string, unknown> | Array<Record<string, unknown>> };
            if (Array.isArray(a.data)) {
              a.data = a.data.map((d) => ({ ...d, tenantId }));
            } else if (a.data) {
              a.data = { ...a.data, tenantId };
            }
          }

          return query(args);
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof tenantDb>;

/**
 * Resolve the current tenant for a request inside `/t/[slug]/...`.
 *
 * Defense in depth: we look up the tenant by slug from the URL AND
 * verify it matches the session's tenantId. Mismatch returns 404 (not 403)
 * to avoid leaking tenant existence.
 */
export async function getCurrentTenant(slug: string) {
  const session = await auth();
  if (!session?.user) notFound();

  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant || !tenant.active) notFound();

  // Super-admins can cross tenants; everyone else must match.
  if (session.user.role !== 'SUPER_ADMIN' && session.user.tenantId !== tenant.id) {
    notFound();
  }

  return {
    tenant,
    user: session.user,
    db: tenantDb(tenant.id),
  };
}

export async function getCurrentTenantOrNull(slug: string) {
  try {
    return await getCurrentTenant(slug);
  } catch {
    return null;
  }
}

/**
 * Slug validation. Used by signup. Lowercase letters, digits, and hyphens only;
 * must start with a letter; 3-32 chars; reserved words rejected.
 */
const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'login',
  'signup',
  'logout',
  'settings',
  'support',
  'help',
  'docs',
  'auth',
  'super',
  'platform',
  't',
  'tenant',
  'www',
]);

export function validateSlug(raw: string): { ok: true; slug: string } | { ok: false; error: string } {
  const slug = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(slug)) {
    return {
      ok: false,
      error:
        'Slug must be 3-32 chars, start with a letter, and contain only lowercase letters, digits, or hyphens.',
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, error: 'That slug is reserved.' };
  }
  return { ok: true, slug };
}

// Prevent runtime drift between this allowlist and the schema.
export const _internal = { TENANT_SCOPED_MODELS };
// satisfy unused-import lint when Prisma namespace is only used for types
export type _PrismaNs = typeof Prisma;
