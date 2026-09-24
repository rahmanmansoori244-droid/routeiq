'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { MapPicker } from '@/components/map-picker';
import { errorMessage } from '@/lib/error-message';

interface Props {
  customer: { id: string; lat: number | null; lng: number | null; geocodeConfidence: string | null };
  mapboxToken: string;
  canEdit: boolean;
}

export function CustomerEditor({ customer, mapboxToken, canEdit }: Props) {
  const router = useRouter();
  const [lat, setLat] = useState<number | null>(customer.lat);
  const [lng, setLng] = useState<number | null>(customer.lng);
  const [dirty, setDirty] = useState(false);
  const [pending, startSave] = useTransition();

  function onPick(nextLat: number, nextLng: number) {
    setLat(nextLat);
    setLng(nextLng);
    setDirty(true);
  }

  function save() {
    if (lat === null || lng === null) {
      toast.error('Set coordinates first.');
      return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      toast.error('Invalid coordinates.');
      return;
    }
    startSave(async () => {
      const res = await fetch(`/api/customers/${customer.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lat, lng }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(errorMessage(body, 'Save failed.'));
        return;
      }
      toast.success('Coordinates updated.');
      setDirty(false);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <MapPicker lat={lat} lng={lng} onChange={onPick} mapboxToken={mapboxToken} disabled={!canEdit} />
      <div className="flex justify-end">
        {canEdit ? (
          <Button size="sm" disabled={!dirty || pending} onClick={save}>
            {pending ? 'Saving…' : 'Save coordinates'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
