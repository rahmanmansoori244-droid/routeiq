import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { getCurrentTenant } from '@/lib/tenant';
import { canManageMasterData, canPlan } from '@/lib/rbac';
import { notFoundIfNull } from '@/lib/api';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { describeServiceTime, effectiveAttrs, unconfirmedPriorityText, windowLabel, type TypeProfileLike } from '@/lib/dispatch/customer-attrs';
import { fmtDayMonth } from '@/lib/dispatch/time';
import { tenantServiceArea } from '@/lib/dispatch/service-area';
import { CustomerEditor } from './customer-editor';
import { CustomerDetailsButton } from './customer-details-button';
import type { EditableCustomer } from '../../dispatch/customer-dialog';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Customer — RouteIQ' };

export default async function CustomerDetailPage({
  params,
}: {
  params: { slug: string; id: string };
}) {
  const { db, user, tenant } = await getCurrentTenant(params.slug);
  const customer = notFoundIfNull(
    await db.customer.findUnique({
      where: { id: params.id },
      include: { region: { select: { id: true, code: true, name: true } }, windowConfirmedBy: { select: { name: true } } },
    }),
  );
  const regions = await db.region.findMany({
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true },
  });

  // The unloading time the planner uses (customer > customer type > Settings default), not only
  // the stored value: an unconfirmed stored time is not used (stabilization PR5).
  const [profiles, cfg] = await Promise.all([
    db.customerTypeProfile.findMany(),
    db.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: { defaultServiceTimeMin: true } }),
  ]);
  const eff = effectiveAttrs(customer, new Map<string, TypeProfileLike>(profiles.map((p) => [p.customerType, p])), {
    serviceTimeMin: cfg?.defaultServiceTimeMin ?? 10,
  });
  const service = describeServiceTime(customer, eff);
  // The priority the planner uses when the stored one is not confirmed (review ui-rest-2): the
  // Details card showed only the stored one, while the plan used the customer type's default.
  const plannedPriority = unconfirmedPriorityText(eff);

  // Where the map looks when the customer has no pin: the company's first active depot, else Muscat.
  const depot = await db.depot.findFirst({ where: { active: true }, orderBy: { code: 'asc' }, select: { lat: true, lng: true } });
  const center = depot ?? { lat: 23.5859, lng: 58.4059 };
  // The company's delivery area, so Set location judges the saved pin as the server does.
  const serviceArea = await tenantServiceArea(tenant.id);
  const canEdit = canPlan(user.role);
  // What the Details dialog opens with, as the day screen sends it (the hours are the customer's own).
  const details: EditableCustomer = {
    customerId: customer.id,
    code: customer.code,
    branchCode: customer.branchCode,
    name: customer.name,
    customerType: customer.customerType,
    priority: eff.priority,
    prioritySource: eff.prioritySource,
    serviceMin: eff.serviceMin,
    serviceSource: eff.serviceSource,
    hardWindowStartMin: customer.hardWindowStartMin,
    hardWindowEndMin: customer.hardWindowEndMin,
    prefWindowStartMin: customer.prefWindowStartMin,
    prefWindowEndMin: customer.prefWindowEndMin,
    windowConfirmed: eff.windowConfirmed,
    windowLabel: windowLabel(eff),
    windowConfirmedBy: customer.windowConfirmedBy?.name ?? null,
    windowConfirmedAt: customer.windowConfirmedAt ? customer.windowConfirmedAt.toISOString() : null,
  };

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
                  code: customer.code,
                  branchCode: customer.branchCode,
                  name: customer.name,
                  lat: customer.lat,
                  lng: customer.lng,
                  locationVerified: customer.locationVerified,
                  geocodeConfidence: customer.geocodeConfidence,
                }}
                center={center}
                serviceArea={serviceArea}
                canEdit={canEdit}
                isAdmin={canManageMasterData(user.role)}
              />
            </CardContent>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base">Details</CardTitle>
              {canEdit ? <CustomerDetailsButton customer={details} /> : null}
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
                <span data-testid="customer-priority">
                  <Badge variant="outline">{customer.priority}</Badge>
                  {plannedPriority ? (
                    <span className="block max-w-xs text-xs text-muted-foreground" data-testid="customer-priority-note">
                      The planner uses {plannedPriority}.{canEdit ? ' Confirm a priority in Details.' : ''}
                    </span>
                  ) : null}
                </span>
              </Field>
              <Field label="Service time">
                <span data-testid="customer-service-time">
                  {service.minutes} min
                  <span className="block text-xs text-muted-foreground">{service.source}</span>
                  {service.note ? (
                    <span
                      className={`block max-w-xs text-xs ${service.noteLevel === 'warning' ? 'text-amber-700' : 'text-muted-foreground'}`}
                      data-testid="customer-service-time-note"
                    >
                      {service.note}
                    </span>
                  ) : null}
                </span>
              </Field>
              <Field label="Receiving hours">
                <span data-testid="customer-receiving-hours">
                  {windowLabel(eff)}
                  {customer.windowConfirmedAt ? (
                    <span className="block text-xs text-muted-foreground">
                      Confirmed{customer.windowConfirmedBy ? ` by ${customer.windowConfirmedBy.name}` : ''} on {fmtDayMonth(customer.windowConfirmedAt.toISOString().slice(0, 10))}
                    </span>
                  ) : (
                    <span className="block max-w-xs text-xs text-amber-700">
                      Not confirmed: {canEdit ? 'confirm them with Details above (or tick Open all day).' : 'a dispatcher confirms them in Details.'}
                    </span>
                  )}
                </span>
              </Field>
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
              <p>Set location opens the same checks as ADD LOCATION on Daily dispatch: a reading that is not exact needs the pin placed by hand. Details opens the same dialog as on Daily dispatch (customer type, priority, unloading time and receiving hours, with Open all day and confirmed with the customer); the payment type is changed in the customer list.</p>
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
