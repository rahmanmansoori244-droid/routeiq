import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canPlan } from '@/lib/rbac';
import { notFoundIfNull } from '@/lib/api';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CustomerEditor } from './customer-editor';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Customer — RouteIQ' };

export default async function CustomerDetailPage({
  params,
}: {
  params: { slug: string; id: string };
}) {
  const { db, user } = await getCurrentTenant(params.slug);
  const customer = notFoundIfNull(
    await db.customer.findUnique({
      where: { id: params.id },
      include: { region: { select: { id: true, code: true, name: true } } },
    }),
  );
  const regions = await db.region.findMany({
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true },
  });

  const mapboxToken = process.env.MAPBOX_TOKEN ?? '';
  const canEdit = canPlan(user.role);

  return (
    <PageShell
      title={customer.name}
      description={
        <span className="font-mono text-xs">
          {customer.code}
          {customer.branchKey !== '__MAIN__' ? ` · branch ${customer.branchKey}` : ''}
        </span>
      }
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={`/t/${params.slug}/customers`}>
            <ChevronLeft className="me-1 h-4 w-4" />
            Back to list
          </Link>
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Location</CardTitle>
            </CardHeader>
            <CardContent>
              <CustomerEditor
                customer={{
                  id: customer.id,
                  lat: customer.lat,
                  lng: customer.lng,
                  geocodeConfidence: customer.geocodeConfidence,
                }}
                mapboxToken={mapboxToken}
                canEdit={canEdit}
              />
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Field label="Code">
                <span className="font-mono text-xs">{customer.code}</span>
              </Field>
              <Field label="Branch">
                <span className="font-mono text-xs">
                  {customer.branchKey === '__MAIN__' ? '— main —' : customer.branchKey}
                </span>
              </Field>
              <Field label="Region">{customer.region ? `${customer.region.code} — ${customer.region.name}` : '—'}</Field>
              <Field label="Priority">
                <Badge variant="outline">{customer.priority}</Badge>
              </Field>
              <Field label="Service time">{customer.avgServiceTimeMin} min</Field>
              <Field label="Payment">
                <Badge variant="outline">{customer.paymentType.toLowerCase()}</Badge>
              </Field>
              <Field label="Geocode quality">
                <Badge variant={customer.geocodeConfidence === 'HIGH' ? 'success' : 'warning'}>
                  {customer.geocodeConfidence ?? 'unknown'}
                </Badge>
              </Field>
              <Field label="Active">
                {customer.active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
              </Field>
              {customer.address ? <Field label="Address">{customer.address}</Field> : null}
              {customer.accessNotes ? <Field label="Access notes">{customer.accessNotes}</Field> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Phase 1 scope</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-muted-foreground">
              <p>You can drag the pin to update lat/lng. Full edit dialog (priority, service time, payment type) is reachable from the customer list inline controls.</p>
              <p>The {regions.length} regions in this tenant are visible in the dropdown filter.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-end">{children}</dd>
    </div>
  );
}
