/**
 * Legacy live-tracking page (driver-app GPS). Retired with the driver app in Sep 2026: it only
 * says so. See lib/driver-app.ts.
 */
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { Button } from '@/components/ui/button';
import { PageShell } from '@/components/page-shell';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Live tracking — RouteIQ' };

export default async function LiveRunPage({ params }: { params: { slug: string; id: string } }) {
  await getCurrentTenant(params.slug);
  return (
    <PageShell
      title="Live tracking"
      description="Live truck tracking came from the driver phone app, which is retired."
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link href={`/t/${params.slug}/runs/${params.id}`}>
            <ChevronLeft className="mr-1 h-4 w-4" /> Back to run
          </Link>
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        Drivers now work from the driver sheet (PDF) and the WhatsApp message from the dispatch screen.
      </p>
    </PageShell>
  );
}
