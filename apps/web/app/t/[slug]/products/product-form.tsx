'use client';

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
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
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '@/lib/error-message';

export interface ProductRow {
  id: string;
  code: string;
  name: string;
  weightPerCaseKg: number;
  volumePerCaseL: number;
  active: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  product?: ProductRow;
  onSaved: () => void;
}

const blank = { code: '', name: '', weightPerCaseKg: '12', volumePerCaseL: '15', active: true };

export function ProductFormDialog({ open, onOpenChange, mode, product, onSaved }: Props) {
  const [form, setForm] = useState(blank);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      if (mode === 'edit' && product) {
        setForm({
          code: product.code,
          name: product.name,
          weightPerCaseKg: String(product.weightPerCaseKg),
          volumePerCaseL: String(product.volumePerCaseL),
          active: product.active,
        });
      } else {
        setForm(blank);
      }
    }
  }, [open, mode, product]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      code: form.code,
      name: form.name,
      weightPerCaseKg: Number(form.weightPerCaseKg),
      volumePerCaseL: Number(form.volumePerCaseL),
      active: form.active,
    };
    startTransition(async () => {
      const url = mode === 'create' ? '/api/products' : `/api/products/${product!.id}`;
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
      toast.success(mode === 'create' ? 'Product created' : 'Product updated');
      if (typeof data?.data?.warning === 'string') toast.warning(data.data.warning, { duration: 10_000 });
      onSaved();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add product' : `Edit product ${product?.code}`}</DialogTitle>
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
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="weightPerCaseKg">Weight per case (kg)</Label>
              <Input
                id="weightPerCaseKg"
                type="number"
                min="0"
                step="0.01"
                value={form.weightPerCaseKg}
                onChange={(e) => setForm({ ...form, weightPerCaseKg: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="volumePerCaseL">Volume per case (L)</Label>
              <Input
                id="volumePerCaseL"
                type="number"
                min="0"
                step="0.01"
                value={form.volumePerCaseL}
                onChange={(e) => setForm({ ...form, volumePerCaseL: e.target.value })}
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
