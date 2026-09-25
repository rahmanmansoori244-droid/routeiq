import { History } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { redactForAudit } from '@/lib/audit';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { AuditClient } from './audit-client';

export const metadata = { title: 'Audit log — RouteIQ' };
export const dynamic = 'force-dynamic';

const ACTIONS = [
  'CREATE', 'UPDATE', 'DELETE', 'OVERRIDE', 'DISPATCH',
  'LOGIN', 'SIGNUP',
  'OPTIMIZE_STARTED', 'OPTIMIZE_SUCCEEDED', 'OPTIMIZE_FAILED',
  'SCENARIO_CHOSEN', 'BASELINE_UPLOADED', 'ROUTE_MANUALLY_CHANGED',
  'LOGIN_THROTTLED', 'CROSS_TENANT_VIEW', 'PLATFORM_ADMIN_GRANTED', 'PLATFORM_ADMIN_REVOKED',
  'PASSWORD_RESET_BY_ADMIN',
  'SECURITY_CLEANUP',
];

const ENTITIES = [
  'Tenant', 'TenantConfig', 'Depot', 'Truck', 'Driver', 'Region', 'Customer',
  'Product', 'UploadBatch', 'Order', 'RunPlan', 'RunJob', 'RouteAssignment',
  'ManualBaseline', 'User',
];

export default async function AuditPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  if (!canManageMasterData(user.role)) redirect(`/t/${params.slug}`);

  // Initial 200 most recent rows. Client narrows via filters via /api/audit.
  const initial = await db.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { user: { select: { id: true, name: true, email: true } } },
  });

  // Also pull tenant users for the user filter dropdown.
  const tenantUsers = await db.auditLog.groupBy({
    by: ['userId'],
    where: { userId: { not: null } },
    _count: { userId: true },
    orderBy: { _count: { userId: 'desc' } },
    take: 25,
  });
  const userIds = tenantUsers.map((t) => t.userId).filter((v): v is string => v !== null);
  const userOptions = userIds.length
    ? (await db.auditLog.findMany({
        where: { userId: { in: userIds } },
        distinct: ['userId'],
        include: { user: { select: { id: true, name: true, email: true } } },
      }))
        .map((r) => r.user)
        .filter((u): u is NonNullable<typeof u> => u !== null)
    : [];

  return (
    <PageShell
      title="Audit log"
      description="Every destructive action and operational event, filterable. Newest first; max 1000 rows per query."
    >
      {initial.length === 0 ? (
        <EmptyState
          icon={History}
          title="No audit entries yet"
          description="Audit rows appear when users sign in, change master data, optimize, or dispatch."
        />
      ) : (
        <AuditClient
          initial={initial.map((r) => ({
            id: r.id,
            action: r.action,
            entity: r.entity,
            entityId: r.entityId,
            // Older rows may still hold credential hashes; never send them to the browser.
            beforeJson: redactForAudit(r.beforeJson),
            afterJson: redactForAudit(r.afterJson),
            ip: r.ip,
            createdAt: r.createdAt.toISOString(),
            user: r.user ? { id: r.user.id, name: r.user.name, email: r.user.email } : null,
          }))}
          actions={ACTIONS}
          entities={ENTITIES}
          users={userOptions.map((u) => ({ id: u.id, name: u.name, email: u.email }))}
        />
      )}
    </PageShell>
  );
}
