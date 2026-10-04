import Link from 'next/link';
import { Building2, Upload } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData, canPlan } from '@/lib/rbac';
import { measuredByCustomer } from '@/lib/delivery/customer-stats';
import { PinCheckPanel } from './pin-check-panel';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { tenantServiceArea } from '@/lib/dispatch/service-area';
import { loadWorklist } from '@/lib/dispatch/customer-master';
import { CustomersClient } from './customers-client';

export const metadata = { title: 'Customers — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function CustomersPage({ params, searchParams }: { params: { slug: string }; searchParams?: { show?: string } }) {
  const { db, user, tenant } = await getCurrentTenant(params.slug);
  const canEdit = canPlan(user.role);

  const [listed, regions, serviceArea, worklist, measured] = await Promise.all([
    db.customer.findMany({
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
      include: { region: { select: { id: true, code: true, name: true } } },
      take: 1000,
    }),
    db.region.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
    // The company's delivery area: a saved point outside it that nobody confirmed needs a pin.
    tenantServiceArea(tenant.id),
    // Owner decision 1 Oct 2026, item 4: the data to collect (dispatchers and up).
    canEdit ? loadWorklist(tenant.id) : Promise.resolve(null),
    // Delivery outcome (owner request 4 Oct 2026, spec section 11.1): measured unloading times. Never
    // keeps the page from loading.
    measuredByCustomer(tenant.id).catch((e) => {
      console.error('[customers] measured unloading not read', (e as Error)?.message ?? e);
      return {};
    }),
  ]);
  // Every customer of the data-to-collect list is on the page, also past the first 1000.
  const shown = new Set(listed.map((c) => c.id));
  const extra = worklist?.rows.filter((r) => !shown.has(r.customerId)).map((r) => r.customerId) ?? [];
  const customers = extra.length
    ? [...listed, ...(await db.customer.findMany({ where: { id: { in: extra } }, include: { region: { select: { id: true, code: true, name: true } } } }))]
    : listed;
  const collect = worklist
    ? {
        from: worklist.from,
        to: worklist.to,
        days: worklist.days,
        perDepot: worklist.perDepot.map((d) => ({ code: d.code, customers: d.customers })),
        rows: Object.fromEntries(worklist.rows.map((r) => [r.customerId, { missing: r.missing, firstDelivery: r.firstDelivery, depots: r.depots }])),
      }
    : null;

  if (customers.length === 0) {
    return (
      <PageShell
        title="Customers"
        description="Master data for every delivery destination."
        actions={
          canEdit ? (
            <Button asChild size="sm">
              <Link href={`/t/${params.slug}/customers/import`}>
                <Upload className="me-2 h-4 w-4" />
                Import customers
              </Link>
            </Button>
          ) : null
        }
      >
        <EmptyState
          icon={Building2}
          title="No customers yet"
          description="Use the customer import to load 100s of customers at once, or add them one at a time later."
          action={
            canEdit ? (
              <Button asChild>
                <Link href={`/t/${params.slug}/customers/import`}>
                  <Upload className="me-2 h-4 w-4" />
                  Import from CSV
                </Link>
              </Button>
            ) : null
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Customers"
      description={`${customers.length} customers · click a row to edit on the map.`}
      actions={
        canEdit ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/t/${params.slug}/customers/import`}>
              <Upload className="me-2 h-4 w-4" />
              Import CSV
            </Link>
          </Button>
        ) : null
      }
    >
      {/* "Pin may be wrong" (spec section 11.2): company admins only; the location lock stays. */}
      {canManageMasterData(user.role) ? <PinCheckPanel slug={params.slug} /> : null}
      <CustomersClient
        slug={params.slug}
        initial={customers}
        regions={regions}
        canEdit={canEdit}
        serviceArea={serviceArea}
        collect={collect}
        initialCollectOnly={searchParams?.show === 'collect'}
        measured={measured}
      />
    </PageShell>
  );
}
