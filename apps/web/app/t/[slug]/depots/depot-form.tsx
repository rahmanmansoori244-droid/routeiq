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

export interface DepotRow {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  active: boolean;
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
  active: boolean;
}

const blank: FormState = { code: '', name: '', lat: 23.5859, lng: 58.4059, address: '', active: true };

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
    const body = {
      code: form.code,
      name: form.name,
      lat: form.lat,
      lng: form.lng,
      address: form.address,
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
        toast.error(typeof data.error === 'string' ? data.error : 'Save failed.');
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
