import Link from 'next/link';
import { LifeBuoy, Upload, MapPin, Wand2, ListChecks, Lock, FileSpreadsheet, Clock } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Help — RouteIQ' };

export default async function HelpPage({ params }: { params: { slug: string } }) {
  const { tenant } = await getCurrentTenant(params.slug);
  const dispatch = `/t/${tenant.slug}/dispatch`;
  return (
    <PageShell title="Help" description="Quick reference for the nightly dispatch planning flow.">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <LifeBuoy className="h-5 w-5 text-primary" />
              Tomorrow&apos;s dispatch plan, step by step
            </CardTitle>
            <CardDescription>
              Everything happens on{' '}
              <Link href={dispatch} className="font-mono text-primary hover:underline">
                Daily dispatch
              </Link>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Step n={1} icon={Upload} title="Upload orders">
              Choose the sales order Excel/CSV and click Check file. NMWC column names are recognised automatically. Row errors are listed with their row
              number and nothing is saved until you confirm. New customers are created and marked LOCATION REQUIRED.
            </Step>
            <Step n={2} icon={MapPin} title="Resolve issues">
              ADD LOCATION: paste the Google Maps link (short links work) or &quot;latitude, longitude&quot;, check the pin and save. Locations are saved
              permanently. Optionally confirm priority (P1 = highest), customer type and receiving hours.
            </Step>
            <Step n={3} icon={Wand2} title="OPTIMIZE">
              Builds the recommended plan on road distances: capacity, receiving hours and priorities are respected, and trucks can make several loads.
              About half a minute to a minute for a normal day.
            </Step>
            <Step n={4} icon={ListChecks} title="Review">
              Per truck load: loading manifest (cases per product), delivery sequence with ETAs, km, utilisation and cost. Every order is either planned
              or listed as unserved with a reason, and cases always reconcile.
            </Step>
            <Step n={5} icon={Lock} title="Lock, export, dispatch">
              Lock loads in order (Load 1 before Load 2), then Loading, then Dispatch. Dispatched loads can never be changed. Export Excel gives the
              warehouse and drivers their sheets.
            </Step>
            <Step n={6} icon={Clock} title="Late orders">
              Add the late order (with the reason) and click Re-plan. A new plan version keeps locked and dispatched loads exactly as they were and
              shows what changed.
            </Step>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              Words used on screen
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              <b>Hard hours</b>: the customer cannot receive outside them; the plan never delivers outside. <b>Preferred hours</b>: soft; used when
              possible.
            </p>
            <p>
              <b>Estimated km</b>: road routing was unavailable, so straight-line distances were used; the plan is still valid.
            </p>
            <p>
              <b>Optimized plan</b>: a good plan found within a time limit. It is not claimed to be the single perfect answer.
            </p>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

function Step({ n, icon: Icon, title, children }: { n: number; icon: typeof LifeBuoy; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{n}</div>
      <div>
        <p className="flex items-center gap-1 font-medium">
          <Icon className="h-4 w-4" /> {title}
        </p>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
