import { Truck } from 'lucide-react';
import Link from 'next/link';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { TrucksTable } from './trucks-table';
import { AddTruckButton } from './add-truck-button';
import { HireOptionsCard } from './hire-options';
import { GpsTrackersCard } from './gps-trackers-card';
import { ivmsApiReady, readIvmsEnv } from '@/lib/ivms/env';
import { ivmsModeAtLeast, ivmsModeOf } from '@/lib/ivms/settings';

export const metadata = { title: 'Trucks — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function TrucksPage({ params }: { params: { slug: string } }) {
  const { db, user, tenant } = await getCurrentTenant(params.slug);
  const canManage = canManageMasterData(user.role);

  const [trucks, depots, drivers, helpers] = await Promise.all([
    db.truck.findMany({
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
      include: { depot: { select: { id: true, code: true, name: true } } },
    }),
    db.depot.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
    db.driver.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }], select: { id: true, code: true, name: true, active: true } }),
    // Helpers (owner request 13 Oct 2026): the Default helper list.
    db.helper.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }], select: { id: true, code: true, name: true, active: true } }),
  ]);

  // GPS trackers (IVMS live link, 16 Oct 2026): the company admin only. The IMEIs are read here by name
  // (every other truck read omits them: lib/db.ts PRISMA_GLOBAL_OMIT); never for a one-day hired truck.
  const trackers = canManage
    ? await db.truck.findMany({ where: { active: true, onlyOnDate: null }, orderBy: { code: 'asc' }, select: { id: true, code: true, ivmsImei: true } })
    : [];
  const ivmsCfg = canManage ? await db.tenantConfig.findFirst({ select: { ivmsMode: true } }) : null;
  const ivmsEnv = readIvmsEnv();
  const ivmsMode = ivmsEnv.disabled ? 'OFF' : ivmsModeOf(ivmsCfg);
  const canSuggest = ivmsModeAtLeast(ivmsMode, 'MAP') && ivmsApiReady(ivmsEnv) && ivmsEnv.tenantSlug === tenant.slug.toLowerCase();
  const modeText =
    ivmsMode === 'OFF'
      ? 'GPS tracking is OFF (Settings): nothing is read from Ayun, so these numbers are only stored.'
      : `GPS tracking is ${ivmsMode === 'MAP' ? 'MAP (live trucks on the day screen)' : 'TIMES (live trucks and GPS arrival and departure times)'}.`;

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
      actions={trucks.length > 0 && canManage ? <AddTruckButton depots={depots} drivers={drivers} helpers={helpers} /> : null}
    >
      {trucks.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No trucks yet"
          description="Add a truck with capacity in your primary unit, plus daily and per-km cost."
          action={canManage ? <AddTruckButton depots={depots} drivers={drivers} helpers={helpers} label="Add your first truck" /> : null}
        />
      ) : (
        <TrucksTable initial={trucks} depots={depots} drivers={drivers} helpers={helpers} canManage={canManage} primaryUnit={tenant.primaryUnit} currency={tenant.currency} />
      )}
      {canManage && trackers.length ? (
        <div className="mt-6">
          <GpsTrackersCard trucks={trackers} canSuggest={canSuggest} modeText={modeText} />
        </div>
      ) : null}
      {/* The hire suggestion (owner request 6 Oct 2026): the trucks each depot can rent for a day. */}
      <div className="mt-6">
        <HireOptionsCard depots={depots} canManage={canManage} currency={tenant.currency} />
      </div>
    </PageShell>
  );
}
