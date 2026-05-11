import Link from 'next/link';
import { Upload, ListChecks, Plus, ArrowRight } from 'lucide-react';
import type { RunStatus } from '@prisma/client';
import { getCurrentTenant } from '@/lib/tenant';
import { getDashboardData } from '@/lib/dashboard';
import { canPlan } from '@/lib/rbac';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { KpiCard } from './kpi-card';
import { TrendChart } from './trend-chart';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Dashboard — RouteIQ' };

const STATUS_VARIANT: Record<RunStatus, 'default' | 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'> = {
  DRAFT: 'outline',
  OPTIMIZING: 'warning',
  READY: 'success',
  FAILED: 'destructive',
  DISPATCHED: 'success',
  ARCHIVED: 'secondary',
};

export default async function DashboardPage({ params }: { params: { slug: string } }) {
  const { tenant, user } = await getCurrentTenant(params.slug);
  const data = await getDashboardData(tenant.id);
  const isPlanner = canPlan(user.role);

  const kmLabel = data.distanceIsEstimated ? 'Estimated km' : 'Km';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Welcome to {tenant.name}</h1>
          <p className="text-sm text-muted-foreground">
            {data.today.runCount > 0
              ? `${data.today.runCount} run${data.today.runCount === 1 ? '' : 's'} today.`
              : "No runs today yet. Start with today's order upload."}
          </p>
        </div>
        {isPlanner ? (
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/t/${tenant.slug}/upload`}>
                <Upload className="me-2 h-4 w-4" />
                Upload orders
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`/t/${tenant.slug}/runs/new`}>
                <Plus className="me-2 h-4 w-4" />
                New run
              </Link>
            </Button>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Trucks used today"
          value={data.today.trucksUsed.toString()}
          previousLabel="vs yesterday"
          previousValue={data.yesterday.trucksUsed}
          currentValue={data.today.trucksUsed}
          smallerIsBetter
        />
        <KpiCard
          label={`${kmLabel} today`}
          value={data.today.distanceKm.toLocaleString('en-US', { maximumFractionDigits: 1 })}
          previousLabel="vs yesterday"
          previousValue={data.yesterday.distanceKm}
          currentValue={data.today.distanceKm}
          smallerIsBetter
          decimals={1}
        />
        <KpiCard
          label="Avg utilization"
          value={`${data.today.utilizationPct.toFixed(1)}%`}
          previousLabel="vs yesterday"
          previousValue={data.yesterday.utilizationPct}
          currentValue={data.today.utilizationPct}
          smallerIsBetter={false}
          decimals={1}
          suffix="%"
        />
        <KpiCard
          label="Orders served today"
          value={`${data.today.ordersServed}/${data.today.ordersTotal}`}
          previousLabel="vs yesterday"
          previousValue={data.yesterday.ordersServed}
          currentValue={data.today.ordersServed}
          smallerIsBetter={false}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <KpiCard
          label={`Total cost (${tenant.currency})`}
          value={data.today.cost.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          previousLabel="vs yesterday"
          previousValue={data.yesterday.cost}
          currentValue={data.today.cost}
          smallerIsBetter
          decimals={2}
        />
        <KpiCard
          label="Cost per case"
          value={data.today.costPerCase === 0 ? '—' : `${tenant.currency} ${data.today.costPerCase.toFixed(3)}`}
          previousLabel="vs yesterday"
          previousValue={data.yesterday.costPerCase}
          currentValue={data.today.costPerCase}
          smallerIsBetter
          decimals={3}
        />
        <KpiCard
          label="Late deliveries"
          value="—"
          previousLabel="v2 feature — time windows not enforced in v1"
          previousValue={null}
          currentValue={null}
          smallerIsBetter
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Trucks used — last 30 days</CardTitle>
          </CardHeader>
          <CardContent>
            <TrendChart data={data.trend} kmLabel={kmLabel} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Week to date</CardTitle>
              <span className="text-xs text-muted-foreground">{data.weekToDate.from} → {data.weekToDate.to}</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <WeeklyRow label="Runs" current={data.weekToDate.runCount} previous={data.previousWeek.runCount} smallerIsBetter={false} />
            <WeeklyRow label="Trucks used" current={data.weekToDate.trucksUsed} previous={data.previousWeek.trucksUsed} smallerIsBetter />
            <WeeklyRow label={kmLabel} current={data.weekToDate.distanceKm} previous={data.previousWeek.distanceKm} smallerIsBetter decimals={1} />
            <WeeklyRow label={`Cost (${tenant.currency})`} current={data.weekToDate.cost} previous={data.previousWeek.cost} smallerIsBetter decimals={2} />
            <WeeklyRow label="Orders served" current={data.weekToDate.ordersServed} previous={data.previousWeek.ordersServed} smallerIsBetter={false} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Recent runs</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href={`/t/${tenant.slug}/runs`}>
                All runs <ArrowRight className="ms-1 h-3 w-3" />
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {data.recentRuns.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">
              <ListChecks className="mx-auto mb-2 h-8 w-8" />
              No runs yet.{' '}
              {isPlanner ? (
                <Link href={`/t/${tenant.slug}/runs/new`} className="text-primary hover:underline">
                  Create your first run.
                </Link>
              ) : null}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run date</TableHead>
                  <TableHead>Depot</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Trucks</TableHead>
                  <TableHead className="text-right">{kmLabel}</TableHead>
                  <TableHead className="text-right">Orders</TableHead>
                  <TableHead className="text-right">Unserved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentRuns.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">
                      <Link className="hover:underline" href={`/t/${tenant.slug}/runs/${r.id}`}>
                        {r.runDate}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{r.depotCode}</span>
                      <span className="ms-2 text-xs text-muted-foreground">{r.depotName}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.status as RunStatus]}>{r.status.toLowerCase()}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.trucksUsed ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.distanceKm === null
                        ? '—'
                        : r.distanceKm.toLocaleString('en-US', { maximumFractionDigits: 1 })}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.totalOrders}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.unservedCount > 0 ? (
                        <span className="text-destructive">{r.unservedCount}</span>
                      ) : (
                        r.unservedCount
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function WeeklyRow({
  label,
  current,
  previous,
  smallerIsBetter,
  decimals = 0,
}: {
  label: string;
  current: number;
  previous: number;
  smallerIsBetter: boolean;
  decimals?: number;
}) {
  const delta = current - previous;
  const pct = previous === 0 ? null : (delta / previous) * 100;
  const improvement = smallerIsBetter ? delta < 0 : delta > 0;
  const cls = delta === 0 ? 'text-muted-foreground' : improvement ? 'text-green-700' : 'text-destructive';
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="text-right">
        <div className="text-sm font-medium tabular-nums">{current.toLocaleString('en-US', { maximumFractionDigits: decimals })}</div>
        <div className={`text-xs ${cls}`}>
          {delta === 0
            ? '0'
            : `${delta > 0 ? '+' : ''}${delta.toLocaleString('en-US', { maximumFractionDigits: decimals })}${pct !== null ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)` : ''}`}
        </div>
      </div>
    </div>
  );
}
