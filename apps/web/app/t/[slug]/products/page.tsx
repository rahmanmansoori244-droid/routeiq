import Link from 'next/link';
import { Package, Upload } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { ProductsTable } from './products-table';
import { AddProductButton } from './add-product-button';

export const metadata = { title: 'Products — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function ProductsPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  const canManage = canManageMasterData(user.role);
  const products = await db.product.findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }] });
  // The product master from the ERP in one file (weights, cases per pallet): company admins.
  const importButton = canManage ? (
    <Button asChild size="sm" variant="outline">
      <Link href={`/t/${params.slug}/products/import`}>
        <Upload className="me-2 h-4 w-4" />
        Import products
      </Link>
    </Button>
  ) : null;

  return (
    <PageShell
      title="Products"
      description="SKUs with per-case weight, volume and cases per pallet — these drive truck loading math."
      actions={
        canManage ? (
          <div className="flex gap-2">
            {importButton}
            {products.length > 0 ? <AddProductButton /> : null}
          </div>
        ) : null
      }
    >
      {products.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No products yet"
          description="Add the SKUs referenced in your daily orders."
          action={canManage ? <AddProductButton label="Add your first product" /> : null}
        />
      ) : (
        <ProductsTable initial={products} canManage={canManage} />
      )}
    </PageShell>
  );
}
