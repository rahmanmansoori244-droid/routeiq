'use client';

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { MapPicker } from '@/components/map-picker';
import { errorMessage } from '@/lib/error-message';
import { fmtHhmm, parseHhmm } from '@/lib/dispatch/time';

export interface DepotRow {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  active: boolean;
  /** Depot hours, minutes from midnight (null = 00:00 / 24:00). */
  openMin?: number | null;
  closeMin?: number | null;
  _count?: { trucks: number; regions?: number; runs?: number };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  depot?: DepotRow;
  mapboxToken: string;
  onSaved: () => void;
}

interface FormState {
  code: string;
  name: string;
  lat: number | null;
  lng: number | null;
  address: string;
  openAt: string; // HH:MM, '' = from midnight
  closeAt: string; // HH:MM, '' = until midnight
  active: boolean;
}

const blank: FormState = { code: '', name: '', lat: 23.5859, lng: 58.4059, address: '', openAt: '', closeAt: '', active: true };

export function DepotFormDialog({ open, onOpenChange, mode, depot, mapboxToken, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(blank);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      if (mode === 'edit' && depot) {
        setForm({
          code: depot.code,
          name: depot.name,
          lat: depot.lat,
          lng: depot.lng,
          address: depot.address ?? '',
          openAt: depot.openMin != null ? fmtHhmm(depot.openMin) : '',
          closeAt: depot.closeMin != null && depot.closeMin < 1440 ? fmtHhmm(depot.closeMin) : '',
          active: depot.active,
        });
      } else {
        setForm(blank);
      }
    }
  }, [open, mode, depot]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.lat === null || form.lng === null) {
      toast.error('Pick a location on the map.');
      return;
    }
    let openMin: number | null;
    let closeMin: number | null;
    try {
      openMin = form.openAt ? parseHhmm(form.openAt) : null;
      closeMin = form.closeAt ? (form.closeAt === '00:00' ? 1440 : parseHhmm(form.closeAt)) : null;
    } catch {
      toast.error('Enter the depot hours as HH:MM.');
      return;
    }
    const body = {
      code: form.code,
      name: form.name,
      lat: form.lat,
      lng: form.lng,
      address: form.address,
      openMin,
      closeMin,
      active: form.active,
    };
    startTransition(async () => {
      const url = mode === 'create' ? '/api/depots' : `/api/depots/${depot!.id}`;
      const method = mode === 'create' ? 'POST' : 'PATCH';
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(data, 'Save failed.'));
        return;
      }
      toast.success(mode === 'create' ? 'Depot created' : 'Depot updated');
      onSaved();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add depot' : `Edit depot ${depot?.code ?? ''}`}</DialogTitle>
          <DialogDescription>Drop a pin on the map, or type coordinates directly.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                required
                disabled={mode === 'edit'}
                maxLength={32}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                maxLength={120}
              />
            </div>
          </div>
          <MapPicker
            lat={form.lat}
            lng={form.lng}
            onChange={(lat, lng) => setForm((f) => ({ ...f, lat, lng }))}
            mapboxToken={mapboxToken}
            height={240}
          />
          <div className="space-y-1.5">
            <Label htmlFor="address">Address</Label>
            <Input
              id="address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              maxLength={500}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="openAt">Opens</Label>
              <Input id="openAt" type="time" value={form.openAt} onChange={(e) => setForm({ ...form, openAt: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="closeAt">Closes</Label>
              <Input id="closeAt" type="time" value={form.closeAt} onChange={(e) => setForm({ ...form, closeAt: e.target.value })} />
            </div>
            <p className="col-span-2 -mt-1 text-xs text-muted-foreground">
              No truck leaves before the depot opens or comes back after it closes. Empty = open all day.
            </p>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor="active" className="text-sm">
              Active
            </Label>
            <Switch
              id="active"
              checked={form.active}
              onCheckedChange={(v) => setForm({ ...form, active: v })}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
