import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getCurrentTenant } from '@/lib/tenant';
import { canPlan } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { NewRunForm } from './new-run-form';

export const metadata = { title: 'New run — RouteIQ' };
export const dynamic = 'force-dynamic';

export default async function NewRunPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  if (!canPlan(user.role)) redirect(`/t/${params.slug}/runs`);

  const depots = await db.depot.findMany({
    where: { active: true },
    orderBy: { code: 'asc' },
    include: {
      _count: { select: { trucks: { where: { active: true } } } },
    },
  });

  // Fetch the upcoming order counts by date (for the next 14 days) — feeds the
  // hint shown when the planner picks a date.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + 14);
  const grouped = await db.order.groupBy({
    by: ['deliveryDate'],
    _count: { id: true },
    where: { deliveryDate: { gte: today, lte: cutoff } },
    orderBy: { deliveryDate: 'asc' },
  });
  const orderCounts = grouped.map((g) => ({
    date: g.deliveryDate.toISOString().slice(0, 10),
    count: g._count.id,
  }));

  return (
    <PageShell
      title="New run"
      description="One run = one depot + one delivery date. Optimization produces three scenarios; you pick the winner."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={`/t/${params.slug}/runs`}>
            <ChevronLeft className="me-1 h-4 w-4" />
            All runs
          </Link>
        </Button>
      }
    >
      <NewRunForm slug={params.slug} depots={depots} orderCounts={orderCounts} />
    </PageShell>
  );
}
