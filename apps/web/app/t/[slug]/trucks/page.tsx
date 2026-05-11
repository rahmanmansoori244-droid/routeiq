import { Truck } from 'lucide-react';
import Link from 'next/link';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { TrucksTable } from './trucks-table';
import { AddTruckButton } from './add-truck-button';

export const metadata = { title: 'Trucks — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function TrucksPage({ params }: { params: { slug: string } }) {
  const { db, user, tenant } = await getCurrentTenant(params.slug);
  const canManage = canManageMasterData(user.role);

  const [trucks, depots] = await Promise.all([
    db.truck.findMany({
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
      include: { depot: { select: { id: true, code: true, name: true } } },
    }),
    db.depot.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
  ]);

  if (depots.length === 0) {
    return (
      <PageShell title="Trucks" description="Fleet capacities and per-truck cost parameters.">
        <EmptyState
          icon={Truck}
          title="Add a depot first"
          description="Every truck belongs to a depot. Configure a depot before adding trucks."
          action={
            <Button asChild size="sm">
              <Link href={`/t/${params.slug}/depots`}>Go to depots</Link>
            </Button>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Trucks"
      description="Fleet capacities and per-truck cost parameters."
      actions={trucks.length > 0 && canManage ? <AddTruckButton depots={depots} /> : null}
    >
      {trucks.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No trucks yet"
          description="Add a truck with capacity in your primary unit, plus daily and per-km cost."
          action={canManage ? <AddTruckButton depots={depots} label="Add your first truck" /> : null}
        />
      ) : (
        <TrucksTable initial={trucks} depots={depots} canManage={canManage} primaryUnit={tenant.primaryUnit} currency={tenant.currency} />
      )}
    </PageShell>
  );
}
