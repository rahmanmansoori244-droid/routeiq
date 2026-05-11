/**
 * Live dispatcher view (Module C).
 *
 * Server shell — validates tenant access and that the run exists, then hands
 * off to LiveDispatcher (Client) which polls /api/runs/[id]/live every 5s.
 */
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { notFoundIfNull } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { PageShell } from '@/components/page-shell';
import { LiveDispatcher } from './live-client';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Live tracking — RouteIQ' };

export default async function LiveRunPage({ params }: { params: { slug: string; id: string } }) {
  const { db } = await getCurrentTenant(params.slug);
  const run = notFoundIfNull(
    await db.runPlan.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        runDate: true,
        status: true,
        depot: { select: { name: true, lat: true, lng: true } },
      },
    }),
  );

  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? process.env.MAPBOX_TOKEN ?? '';

  return (
    <PageShell
      title={`Live · ${run.runDate.toISOString().slice(0, 10)}`}
      description={`${run.depot.name} · live truck positions, ETA, and route deviation. Auto-refresh every 5s.`}
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link href={`/t/${params.slug}/runs/${params.id}`}>
            <ChevronLeft className="mr-1 h-4 w-4" /> Back to run
          </Link>
        </Button>
      }
    >
      <LiveDispatcher
        runId={run.id}
        depot={{ name: run.depot.name, lat: run.depot.lat, lng: run.depot.lng }}
        mapboxToken={mapboxToken}
      />
    </PageShell>
  );
}
