import Link from 'next/link';
import { ListChecks, Plus } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canPlan } from '@/lib/rbac';
import { PageShell } from '@/components/page-shell';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export const metadata = { title: 'Runs — RouteIQ' };
export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'> = {
  DRAFT: 'outline',
  OPTIMIZING: 'warning',
  READY: 'success',
  FAILED: 'destructive',
  DISPATCHED: 'success',
  ARCHIVED: 'secondary',
};

export default async function RunsPage({ params }: { params: { slug: string } }) {
  const { db, user } = await getCurrentTenant(params.slug);
  const canStart = canPlan(user.role);

  const runs = await db.runPlan.findMany({
    orderBy: [{ runDate: 'desc' }, { createdAt: 'desc' }],
    take: 100,
    include: {
      depot: { select: { id: true, code: true, name: true } },
      _count: { select: { scenarios: true, jobs: true, routes: true } },
    },
  });

  return (
    <PageShell
      title="Runs"
      description="Plans by delivery date and depot. New plans are made on Daily dispatch; runs from before September 2026 stay here read-only."
      actions={
        canStart ? (
          <Button asChild size="sm">
            <Link href={`/t/${params.slug}/dispatch`}>
              <Plus className="me-2 h-4 w-4" />
              Plan a day
            </Link>
          </Button>
        ) : null
      }
    >
      {runs.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No runs yet"
          description="Upload the day's orders on Daily dispatch and optimize them into truck loads."
          action={
            canStart ? (
              <Button asChild>
                <Link href={`/t/${params.slug}/dispatch`}>Open Daily dispatch</Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run date</TableHead>
                <TableHead>Depot</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right">Scenarios</TableHead>
                <TableHead className="text-right">Routes</TableHead>
                <TableHead className="text-right">Unserved</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">
                    <Link className="hover:underline" href={`/t/${params.slug}/runs/${r.id}`}>
                      {new Date(r.runDate).toISOString().slice(0, 10)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{r.depot.code}</span>
                    <span className="ms-2 text-xs text-muted-foreground">{r.depot.name}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.optimizationMode}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status]}>{r.status.toLowerCase()}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.totalOrders}</TableCell>
                  <TableCell className="text-right tabular-nums">{r._count.scenarios}</TableCell>
                  <TableCell className="text-right tabular-nums">{r._count.routes}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.unservedCount}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageShell>
  );
}
