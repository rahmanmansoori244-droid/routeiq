import { getCurrentTenant } from '@/lib/tenant';
import { canPlan } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { UploadTabs } from './upload-tabs';

export const metadata = { title: 'Upload orders — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function UploadPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  const canEdit = canPlan(user.role);

  // Pre-fetch initial data for the three tabs so the page renders instantly.
  const [batches, orders, regions] = await Promise.all([
    db.uploadBatch.findMany({
      orderBy: { uploadedAt: 'desc' },
      take: 50,
      include: {
        uploadedBy: { select: { id: true, name: true, email: true } },
        _count: { select: { orders: true } },
      },
    }),
    db.order.findMany({
      orderBy: [{ deliveryDate: 'desc' }, { uploadedAt: 'desc' }],
      take: 200,
      include: {
        customer: {
          select: {
            id: true,
            code: true,
            name: true,
            branchKey: true,
            region: { select: { id: true, code: true } },
          },
        },
        _count: { select: { lines: true } },
      },
    }),
    db.region.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
  ]);

  return (
    <PageShell
      title="Daily order upload"
      description="Drag in Excel or CSV. Validation runs before anything is persisted. Confirm to write Order + OrderLine rows."
    >
      <UploadTabs slug={params.slug} canEdit={canEdit} batches={batches} orders={orders} regions={regions} />
    </PageShell>
  );
}
