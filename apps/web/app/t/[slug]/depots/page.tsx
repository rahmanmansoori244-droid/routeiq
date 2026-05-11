import { Warehouse } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { DepotsTable } from './depots-table';
import { AddDepotButton } from './add-depot-button';

export const metadata = { title: 'Depots — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function DepotsPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  const canManage = canManageMasterData(user.role);
  const mapboxToken = process.env.MAPBOX_TOKEN ?? '';

  const depots = await db.depot.findMany({
    orderBy: [{ active: 'desc' }, { code: 'asc' }],
    include: { _count: { select: { trucks: true, regions: true } } },
  });

  return (
    <PageShell
      title="Depots"
      description="Warehouses where trucks load up and return to."
      actions={depots.length > 0 && canManage ? <AddDepotButton mapboxToken={mapboxToken} /> : null}
    >
      {depots.length === 0 ? (
        <EmptyState
          icon={Warehouse}
          title="No depots yet"
          description="Add your first depot to start configuring trucks and customers."
          action={canManage ? <AddDepotButton mapboxToken={mapboxToken} label="Add your first depot" /> : null}
        />
      ) : (
        <DepotsTable initial={depots} canManage={canManage} mapboxToken={mapboxToken} />
      )}
    </PageShell>
  );
}
