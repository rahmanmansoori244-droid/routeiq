'use client';

import dynamic from 'next/dynamic';
import { useState, type ComponentProps } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocationDialog } from '../../dispatch/location-dialog';

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
  canEdit: boolean;
}

/**
 * The customer page's location (audit PR A5, owner's location rule). The map only shows the saved
 * pin; **Set location** opens the same dialog as ADD LOCATION on Daily dispatch, with the same checks
 * (Read, a pin placed by hand for a reading that is not exact) and the same route,
 * PUT /api/customers/:id/location. The page used to save a map click or two typed numbers through
 * PATCH /api/customers/:id as a verified HIGH location, with no check at all.
 */
export function CustomerEditor({ customer, center, canEdit }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The customer as it was when the dialog was opened: one object for the whole dialog (a new one on
  // every render would reset the dialog, which starts again for another customer).
  const [target, setTarget] = useState<ComponentProps<typeof LocationDialog>['customer']>(null);
  const has = customer.lat !== null && customer.lng !== null;
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
            ? `Pin: ${customer.lat!.toFixed(6)}, ${customer.lng!.toFixed(6)} (${customer.locationVerified ? 'confirmed by a dispatcher' : 'from an import, not confirmed'})`
            : 'No location yet: nothing is delivered to this customer until it has one.'}
        </p>
        {canEdit ? (
          <Button size="sm" onClick={openDialog} data-testid="set-location">
            Set location
          </Button>
        ) : null}
      </div>
      <LocationDialog open={open} onOpenChange={setOpen} customer={target} depot={center} onSaved={() => router.refresh()} />
    </div>
  );
}
