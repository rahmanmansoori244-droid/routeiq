'use client';

import dynamic from 'next/dynamic';
import { useState, type ComponentProps } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocationDialog } from '../../dispatch/location-dialog';
import type { ServiceArea } from '@/lib/dispatch/location-input';
import { LOCATION_ADMIN_ONLY_MESSAGE, LOCKED_NOT_EXACT_MESSAGE, locationIssue, savedLocationLocked, savedPointProblem } from '@/lib/dispatch/customer-attrs';

const PinMap = dynamic(() => import('@/components/pin-map').then((m) => m.PinMap), { ssr: false });

interface Props {
  customer: {
    id: string;
    code: string;
    branchCode: string | null;
    name: string;
    lat: number | null;
    lng: number | null;
    locationVerified: boolean;
    geocodeConfidence: string | null;
  };
  /** Where the map looks when the customer has no pin (its depot, else Muscat). */
  center: { lat: number; lng: number };
  /** The company's delivery area: the dialog judges the saved pin with it, as the server does. */
  serviceArea: ServiceArea;
  canEdit: boolean;
  /** TENANT_ADMIN or SUPER_ADMIN: may change a usable saved location (owner decision 1 Oct 2026, item 5). */
  isAdmin?: boolean;
}

/**
 * The customer page's location (audit PR A5, owner's location rule). The map only shows the saved
 * pin; **Set location** opens the same dialog as ADD LOCATION on Daily dispatch, with the same checks
 * (Read, a pin placed by hand for a reading that is not exact) and the same route,
 * PUT /api/customers/:id/location. The page used to save a map click or two typed numbers through
 * PATCH /api/customers/:id as a verified HIGH location, with no check at all.
 */
export function CustomerEditor({ customer, center, serviceArea, canEdit, isAdmin = false }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The customer as it was when the dialog was opened: one object for the whole dialog (a new one on
  // every render would reset the dialog, which starts again for another customer).
  const [target, setTarget] = useState<ComponentProps<typeof LocationDialog>['customer']>(null);
  const has = customer.lat !== null && customer.lng !== null;
  // A saved point that blocks delivery (A5 third review): an import marked it LOW, or it is outside
  // the company's area, or 0,0, and nobody confirmed it. The day card's words, on this page too.
  const issue = has ? locationIssue(customer, serviceArea) : null;
  const blocked = issue?.blocking ? issue.message : null;
  // Item 5: a dispatcher may set a location only while there is no usable one (only an admin changes it).
  const locked = savedLocationLocked(isAdmin, customer, serviceArea);
  // A usable saved point that is not exact cannot be confirmed as it is: only an admin can fix it, so
  // the dispatcher is told so and offered nothing (data collection review).
  const lockedNotExact = locked && savedPointProblem(customer, serviceArea) !== null;
  function openDialog() {
    setTarget({
      customerId: customer.id,
      code: customer.code,
      branchCode: customer.branchCode,
      name: customer.name,
      lat: customer.lat,
      lng: customer.lng,
      locationVerified: customer.locationVerified,
      geocodeConfidence: customer.geocodeConfidence,
    });
    setOpen(true);
  }
  return (
    <div className="space-y-3">
      {/* Shown only: the pin is set in the dialog. */}
      <div className="pointer-events-none">
        <PinMap lat={customer.lat} lng={customer.lng} center={center} onChange={() => {}} height={320} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="customer-location-text">
          <MapPin className="h-3 w-3" />
          {has
            ? `Pin: ${customer.lat!.toFixed(6)}, ${customer.lng!.toFixed(6)} (${blocked ? 'not usable' : customer.locationVerified ? 'confirmed by a dispatcher' : 'from an import, not confirmed'})`
            : 'No location yet: nothing is delivered to this customer until it has one.'}
        </p>
        {canEdit && !lockedNotExact ? (
          <Button size="sm" onClick={openDialog} data-testid="set-location">
            {locked ? 'Confirm location' : 'Set location'}
          </Button>
        ) : null}
      </div>
      {canEdit && locked ? (
        <p className={`text-xs ${lockedNotExact ? 'text-amber-800' : 'text-muted-foreground'}`} data-testid="customer-location-admin-only">
          {lockedNotExact
            ? LOCKED_NOT_EXACT_MESSAGE
            : `${LOCATION_ADMIN_ONLY_MESSAGE} You can confirm the saved location as it is; if it is wrong, ask your company admin to change it.`}
        </p>
      ) : null}
      {blocked ? (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700" data-testid="customer-location-blocked">
          {`${blocked} Its orders are not planned or sent out until then.`}
        </p>
      ) : null}
      <LocationDialog open={open} onOpenChange={setOpen} customer={target} depot={center} serviceArea={serviceArea} locked={locked} onSaved={() => router.refresh()} />
    </div>
  );
}
