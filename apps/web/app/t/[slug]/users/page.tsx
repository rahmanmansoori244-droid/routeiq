import { redirect } from 'next/navigation';
import { UserCog } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { prisma } from '@/lib/db';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { UsersClient } from './users-client';

export const metadata = { title: 'Users — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function UsersPage({ params }: { params: { slug: string } }) {
  const { tenant, user } = await getCurrentTenant(params.slug);
  if (!canManageMasterData(user.role)) redirect(`/t/${params.slug}`);

  const users = await prisma.user.findMany({
    where: { tenantId: tenant.id },
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
  });

  return (
    <PageShell
      title="Users"
      description={`${users.length} member${users.length === 1 ? '' : 's'}. Invite teammates, set roles, deactivate access.`}
    >
      {users.length === 0 ? (
        <EmptyState icon={UserCog} title="No users yet" description="There should be at least one tenant admin — this is unexpected." />
      ) : (
        <UsersClient
          currentUserId={user.id}
          initial={users.map((u) => ({
            id: u.id,
            email: u.email,
            name: u.name,
            role: u.role,
            active: u.active,
            createdAt: u.createdAt.toISOString(),
          }))}
        />
      )}
    </PageShell>
  );
}
