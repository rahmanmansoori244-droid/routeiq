'use client';

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { CapacityUnit } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { unitLong } from '@/lib/format';
import { errorMessage } from '@/lib/error-message';
import { fmtHhmm, parseHhmm } from '@/lib/dispatch/time';

export interface TruckRow {
  id: string;
  code: string;
  description: string | null;
  depotId: string;
  capacityCases: number;
  capacityWeightKg: number;
  capacityVolumeL: number;
  fixedCostPerDay: number;
  costPerKm: number;
  // Planner inputs (review F21: they could only be set in the database before).
  tripCost?: number;
  kmPerLitre?: number | null;
  maxTripsPerDay?: number | null;
  availableFromMin?: number | null;
  availableToMin?: number | null;
  defaultDriverId: string | null;
  active: boolean;
  depot?: { id: string; code: string; name: string };
}

export interface DepotOption { id: string; code: string; name: string }

export interface DriverOption { id: string; code: string; name: string; active: boolean }

// Radix Select items cannot have an empty value.
const NO_DRIVER = '__none__';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  truck?: TruckRow;
  depots: DepotOption[];
  drivers: DriverOption[];
  primaryUnit?: CapacityUnit;
  currency?: string;
  onSaved: () => void;
}

interface FormState {
  code: string;
  description: string;
  depotId: string;
  capacityCases: string;
  capacityWeightKg: string;
  capacityVolumeL: string;
  fixedCostPerDay: string;
  costPerKm: string;
  tripCost: string;
  kmPerLitre: string;
  maxTripsPerDay: string;
  availableFrom: string; // HH:MM, '' = from the first departure
  availableTo: string; // HH:MM, '' = to the end of the day
  defaultDriverId: string;
  active: boolean;
}

function buildBlank(depots: DepotOption[]): FormState {
  return {
    code: '',
    description: '',
    depotId: depots[0]?.id ?? '',
    capacityCases: '200',
    capacityWeightKg: '3000',
    capacityVolumeL: '8000',
    // No invented costs: a new truck costs nothing until its real figures are entered.
    fixedCostPerDay: '0',
    costPerKm: '0',
    tripCost: '0',
    kmPerLitre: '',
    maxTripsPerDay: '',
    availableFrom: '',
    availableTo: '',
    defaultDriverId: NO_DRIVER,
    active: true,
  };
}

export function TruckFormDialog({
  open,
  onOpenChange,
  mode,
  truck,
  depots,
  drivers,
  primaryUnit = 'CASES',
  currency = '',
  onSaved,
}: Props) {
  const [form, setForm] = useState<FormState>(() => buildBlank(depots));
  const [pending, startTransition] = useTransition();

  // Active drivers, plus the truck's current one if it was deactivated since (so it still shows).
  const current = truck?.defaultDriverId ?? null;
  const driverOptions = drivers.filter((d) => d.active || (mode === 'edit' && d.id === current));

  useEffect(() => {
    if (open) {
      if (mode === 'edit' && truck) {
        setForm({
          code: truck.code,
          description: truck.description ?? '',
          depotId: truck.depotId,
          capacityCases: String(truck.capacityCases),
          capacityWeightKg: String(truck.capacityWeightKg),
          capacityVolumeL: String(truck.capacityVolumeL),
          fixedCostPerDay: String(truck.fixedCostPerDay),
          costPerKm: String(truck.costPerKm),
          tripCost: String(truck.tripCost ?? 0),
          kmPerLitre: truck.kmPerLitre != null ? String(truck.kmPerLitre) : '',
          maxTripsPerDay: truck.maxTripsPerDay != null ? String(truck.maxTripsPerDay) : '',
          availableFrom: truck.availableFromMin != null ? fmtHhmm(truck.availableFromMin) : '',
          availableTo: truck.availableToMin != null ? fmtHhmm(truck.availableToMin) : '',
          defaultDriverId: truck.defaultDriverId ?? NO_DRIVER,
          active: truck.active,
        });
      } else {
        setForm(buildBlank(depots));
      }
    }
  }, [open, mode, truck, depots]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    let availableFromMin: number | null;
    let availableToMin: number | null;
    try {
      availableFromMin = form.availableFrom ? parseHhmm(form.availableFrom) : null;
      // "24:00" (or 00:00 as the end) = until midnight.
      availableToMin = form.availableTo ? (form.availableTo === '00:00' || form.availableTo === '24:00' ? 1440 : parseHhmm(form.availableTo)) : null;
    } catch {
      toast.error('Enter availability as HH:MM.');
      return;
    }
    const body = {
      code: form.code,
      description: form.description,
      depotId: form.depotId,
      capacityCases: Number(form.capacityCases),
      capacityWeightKg: Number(form.capacityWeightKg),
      capacityVolumeL: Number(form.capacityVolumeL),
      fixedCostPerDay: Number(form.fixedCostPerDay),
      costPerKm: Number(form.costPerKm),
      tripCost: Number(form.tripCost || 0),
      kmPerLitre: form.kmPerLitre === '' ? null : Number(form.kmPerLitre),
      maxTripsPerDay: form.maxTripsPerDay === '' ? null : Number(form.maxTripsPerDay),
      availableFromMin,
      availableToMin,
      defaultDriverId: form.defaultDriverId === NO_DRIVER ? null : form.defaultDriverId,
      active: form.active,
    };
    startTransition(async () => {
      const url = mode === 'create' ? '/api/trucks' : `/api/trucks/${truck!.id}`;
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
      toast.success(mode === 'create' ? 'Truck created' : 'Truck updated');
      onSaved();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add truck' : `Edit truck ${truck?.code}`}</DialogTitle>
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
              <Label htmlFor="depot">Depot</Label>
              <Select value={form.depotId} onValueChange={(v) => setForm({ ...form, depotId: v })}>
                <SelectTrigger id="depot">
                  <SelectValue placeholder="Select depot" />
                </SelectTrigger>
                <SelectContent>
                  {depots.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.code} — {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="e.g. 8-ton Isuzu"
              maxLength={200}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="capacityCases">Capacity ({unitLong(primaryUnit)})</Label>
              <Input
                id="capacityCases"
                type="number"
                min="0"
                value={form.capacityCases}
                onChange={(e) => setForm({ ...form, capacityCases: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="capacityWeightKg">Weight (kg)</Label>
              <Input
                id="capacityWeightKg"
                type="number"
                min="0"
                step="0.1"
                value={form.capacityWeightKg}
                onChange={(e) => setForm({ ...form, capacityWeightKg: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="capacityVolumeL">Volume (L)</Label>
              <Input
                id="capacityVolumeL"
                type="number"
                min="0"
                step="0.1"
                value={form.capacityVolumeL}
                onChange={(e) => setForm({ ...form, capacityVolumeL: e.target.value })}
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fixedCostPerDay">Fixed daily cost {currency ? `(${currency})` : ''}</Label>
              <Input
                id="fixedCostPerDay"
                type="number"
                min="0"
                step="0.01"
                value={form.fixedCostPerDay}
                onChange={(e) => setForm({ ...form, fixedCostPerDay: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="costPerKm">Cost per km {currency ? `(${currency})` : ''}</Label>
              <Input
                id="costPerKm"
                type="number"
                min="0"
                step="0.01"
                value={form.costPerKm}
                onChange={(e) => setForm({ ...form, costPerKm: e.target.value })}
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tripCost">Cost per load {currency ? `(${currency})` : ''}</Label>
              <Input
                id="tripCost"
                type="number"
                min="0"
                step="0.01"
                value={form.tripCost}
                onChange={(e) => setForm({ ...form, tripCost: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Loading labour and the like, per load.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kmPerLitre">Km per litre</Label>
              <Input
                id="kmPerLitre"
                type="number"
                min="0.1"
                max="100"
                step="0.1"
                value={form.kmPerLitre}
                placeholder="not set"
                onChange={(e) => setForm({ ...form, kmPerLitre: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Fuel use = km / this, costed at the fuel price in Settings. With it, keep fuel out of the cost per km.</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="maxTripsPerDay">Max loads per day</Label>
              <Input
                id="maxTripsPerDay"
                type="number"
                min="1"
                max="10"
                step="1"
                value={form.maxTripsPerDay}
                placeholder="company default"
                onChange={(e) => setForm({ ...form, maxTripsPerDay: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="availableFrom">Available from</Label>
              <Input id="availableFrom" type="time" value={form.availableFrom} onChange={(e) => setForm({ ...form, availableFrom: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="availableTo">Available until</Label>
              <Input id="availableTo" type="time" value={form.availableTo} onChange={(e) => setForm({ ...form, availableTo: e.target.value })} />
            </div>
            <p className="col-span-3 -mt-1 text-xs text-muted-foreground">
              Empty = the company settings: max loads from Settings, available all day from the first departure. The truck must be back by
              &quot;available until&quot;.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="defaultDriver">Default driver</Label>
            <Select value={form.defaultDriverId} onValueChange={(v) => setForm({ ...form, defaultDriverId: v })}>
              <SelectTrigger id="defaultDriver">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DRIVER}>None</SelectItem>
                {driverOptions.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name} ({d.code}){d.active ? '' : ' - inactive'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">New plans put this driver on the truck&apos;s loads. You can still change the driver per load on the plan.</p>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor="active" className="text-sm">
              Active
            </Label>
            <Switch id="active" checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} />
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
