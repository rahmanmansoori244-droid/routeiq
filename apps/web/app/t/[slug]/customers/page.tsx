import Link from 'next/link';
import { Building2, Upload } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canPlan } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { CustomersClient } from './customers-client';

export const metadata = { title: 'Customers — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function CustomersPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  const canEdit = canPlan(user.role);

  const [customers, regions] = await Promise.all([
    db.customer.findMany({
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
      include: { region: { select: { id: true, code: true, name: true } } },
      take: 1000,
    }),
    db.region.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
  ]);

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
      <CustomersClient slug={params.slug} initial={customers} regions={regions} canEdit={canEdit} />
    </PageShell>
  );
}
