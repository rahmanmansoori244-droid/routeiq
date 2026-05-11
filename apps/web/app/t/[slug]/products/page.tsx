import { Package } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { ProductsTable } from './products-table';
import { AddProductButton } from './add-product-button';

export const metadata = { title: 'Products — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function ProductsPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  const canManage = canManageMasterData(user.role);
  const products = await db.product.findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }] });

  return (
    <PageShell
      title="Products"
      description="SKUs with per-case weight and volume — these drive truck loading math."
      actions={products.length > 0 && canManage ? <AddProductButton /> : null}
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
