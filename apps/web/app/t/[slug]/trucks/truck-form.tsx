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
  active: boolean;
  depot?: { id: string; code: string; name: string };
}

export interface DepotOption { id: string; code: string; name: string }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  truck?: TruckRow;
  depots: DepotOption[];
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
    fixedCostPerDay: '20',
    costPerKm: '0.15',
    active: true,
  };
}

export function TruckFormDialog({
  open,
  onOpenChange,
  mode,
  truck,
  depots,
  primaryUnit = 'CASES',
  currency = '',
  onSaved,
}: Props) {
  const [form, setForm] = useState<FormState>(() => buildBlank(depots));
  const [pending, startTransition] = useTransition();

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
          active: truck.active,
        });
      } else {
        setForm(buildBlank(depots));
      }
    }
  }, [open, mode, truck, depots]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      code: form.code,
      description: form.description,
      depotId: form.depotId,
      capacityCases: Number(form.capacityCases),
      capacityWeightKg: Number(form.capacityWeightKg),
      capacityVolumeL: Number(form.capacityVolumeL),
      fixedCostPerDay: Number(form.fixedCostPerDay),
      costPerKm: Number(form.costPerKm),
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
