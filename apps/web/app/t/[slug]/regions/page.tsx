import { Map } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { RegionsTable } from './regions-table';
import { AddRegionButton } from './add-region-button';

export const metadata = { title: 'Regions — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function RegionsPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  const canManage = canManageMasterData(user.role);
  const [regions, depots] = await Promise.all([
    db.region.findMany({
      orderBy: { code: 'asc' },
      include: {
        depot: { select: { id: true, code: true, name: true } },
        _count: { select: { customers: true } },
      },
    }),
    db.depot.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
  ]);

  return (
    <PageShell
      title="Regions"
      description="Logical groupings of customers, optionally tied to a default depot."
      actions={regions.length > 0 && canManage ? <AddRegionButton depots={depots} /> : null}
    >
      {regions.length === 0 ? (
        <EmptyState
          icon={Map}
          title="No regions yet"
          description="Optional, but useful for filtering and assigning customers to specific depots."
          action={canManage ? <AddRegionButton depots={depots} label="Add your first region" /> : null}
        />
      ) : (
        <RegionsTable initial={regions} depots={depots} canManage={canManage} />
      )}
    </PageShell>
  );
}
