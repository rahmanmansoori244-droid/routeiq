import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canPlan } from '@/lib/rbac';
import { notFoundIfNull } from '@/lib/api';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { ValidationReport } from './validation-report';

export const dynamic = 'force-dynamic';

export default async function BatchDetailPage({
  params,
}: {
  params: { slug: string; batchId: string };
}) {
  const { db, user } = await getCurrentTenant(params.slug);
  const batch = notFoundIfNull(
    await db.uploadBatch.findUnique({
      where: { id: params.batchId },
      include: {
        uploadedBy: { select: { id: true, name: true, email: true } },
        _count: { select: { orders: true } },
      },
    }),
  );

  return (
    <PageShell
      title={batch.fileName}
      description={`Uploaded ${new Date(batch.uploadedAt).toLocaleString()} by ${batch.uploadedBy.email}`}
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={`/t/${params.slug}/upload`}>
            <ChevronLeft className="me-1 h-4 w-4" />
            All batches
          </Link>
        </Button>
      }
    >
      <ValidationReport
        slug={params.slug}
        batch={{
          id: batch.id,
          fileName: batch.fileName,
          status: batch.status,
          totalRows: batch.totalRows,
          validRows: batch.validRows,
          errorRows: batch.errorRows,
          warningRows: batch.warningRows,
          deliveryDate: batch.deliveryDate ? batch.deliveryDate.toISOString().slice(0, 10) : null,
          orderCount: batch._count.orders,
          validationJson: batch.validationJson,
        }}
        canEdit={canPlan(user.role)}
      />
    </PageShell>
  );
}
