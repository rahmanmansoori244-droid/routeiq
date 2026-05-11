import Link from 'next/link';
import { LifeBuoy, Truck, Upload, ListChecks, Map as MapIcon, FileSpreadsheet, Send, Lock } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Help — RouteIQ' };

export default async function HelpPage({ params }: { params: { slug: string } }) {
  const { tenant } = await getCurrentTenant(params.slug);
  return (
    <PageShell title="Help" description="Quick reference for the daily route-planning flow.">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <LifeBuoy className="h-5 w-5 text-primary" />
              The daily flow (target: 5 minutes)
            </CardTitle>
            <CardDescription>One pass from order upload to dispatch.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Step n={1} icon={Upload} title="Upload today's orders">
              <Link href={`/t/${tenant.slug}/upload`} className="font-mono text-primary hover:underline">/upload</Link> →
              drag your CSV/XLSX, validate, fix any errors with row numbers, confirm. Orders are stored against an
              UploadBatch you can delete later.
            </Step>
            <Step n={2} icon={Truck} title="Create a run">
              <Link href={`/t/${tenant.slug}/runs/new`} className="font-mono text-primary hover:underline">/runs/new</Link>
              — pick depot + delivery date + optimization mode (Balanced is the default).
            </Step>
            <Step n={3} icon={ListChecks} title="Optimize → pick a scenario">
              The run page shows three scenarios side-by-side (Min Trucks / Min Distance / Balanced) with trucks used,
              estimated distance, cost, utilization, and unserved breakdown. Click "Pick this scenario" to commit.
            </Step>
            <Step n={4} icon={MapIcon} title="Tweak on the map">
              Map tab → click any stop → Move / Lock / Unassign. Moves respect target-truck capacity and shift time.
              Locked stops survive re-optimization.
            </Step>
            <Step n={5} icon={FileSpreadsheet} title="Export route sheets">
              Excel (one sheet per truck + summary + unserved + baseline) or PDF (A4) — buttons on the run header.
            </Step>
            <Step n={6} icon={Send} title="Dispatch">
              Supervisor types the depot code to confirm. Status → DISPATCHED, assignments lock, orders flip to
              DISPATCHED. To edit further, click <span className="font-mono">Unlock to edit</span> (audited).
            </Step>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Common conventions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <strong>Estimated km</strong> appears everywhere a kilometer value is shown when the distance provider is
              Haversine (v1 default). It means "straight-line distance × tenant multiplier" — close but not road-true.
              Mapbox Matrix support lands in v2.
            </p>
            <p>
              <strong>Priority 1–5</strong> on customers: 1 is "must serve", 5 is "drop first if capacity is tight". The
              solver inverts the disjunction penalty (5,000,000 for priority 1 vs 1,000,000 for priority 5) so
              high-priority stops are always served unless physically impossible.
            </p>
            <p>
              <strong>Cross-tenant access</strong> returns 404 (not 403) so we don't leak which other tenants exist.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="h-5 w-5 text-primary" />
              When something goes wrong
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <strong>Optimization failed</strong>: the run detail page shows the error message + a "Download debug
              JSON" button containing the exact solver request/response. Send that to support. Click "Retry
              optimization" to spawn a new attempt — the failed job's data is preserved on the run.
            </p>
            <p>
              <strong>Move rejected</strong>: usually capacity or shift-time. The toast tells you which limit hit and
              by how much.
            </p>
            <p>
              <strong>Stuck "optimizing"</strong>: the orphan janitor auto-fails any job stuck &gt;5 minutes. Refreshing
              the page is safe — polling resumes against the run's current job id.
            </p>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

function Step({
  n,
  title,
  icon: Icon,
  children,
}: {
  n: number;
  title: string;
  icon: typeof LifeBuoy;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {n}
      </div>
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-2 font-medium">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </div>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
