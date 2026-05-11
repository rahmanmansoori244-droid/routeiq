import { Users } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { DriversTable } from './drivers-table';
import { AddDriverButton } from './add-driver-button';

export const metadata = { title: 'Drivers — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function DriversPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  const canManage = canManageMasterData(user.role);
  const drivers = await db.driver.findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }] });

  return (
    <PageShell
      title="Drivers"
      description="Driver contacts and active status."
      actions={drivers.length > 0 && canManage ? <AddDriverButton /> : null}
    >
      {drivers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No drivers yet"
          description="Drivers are optional in v1 (no shift scheduling) but useful for route sheets."
          action={canManage ? <AddDriverButton label="Add your first driver" /> : null}
        />
      ) : (
        <DriversTable initial={drivers} canManage={canManage} />
      )}
    </PageShell>
  );
}
