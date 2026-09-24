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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/error-message';

export interface RegionRow {
  id: string;
  code: string;
  name: string;
  depotId: string | null;
  depot?: { id: string; code: string; name: string } | null;
  _count?: { customers: number };
}

interface DepotOption {
  id: string;
  code: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  region?: RegionRow;
  depots: DepotOption[];
  onSaved: () => void;
}

const NONE = '__none__';

export function RegionFormDialog({ open, onOpenChange, mode, region, depots, onSaved }: Props) {
  const [form, setForm] = useState({ code: '', name: '', depotId: NONE });
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      if (mode === 'edit' && region) {
        setForm({ code: region.code, name: region.name, depotId: region.depotId ?? NONE });
      } else {
        setForm({ code: '', name: '', depotId: NONE });
      }
    }
  }, [open, mode, region]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      code: form.code,
      name: form.name,
      depotId: form.depotId === NONE ? '' : form.depotId,
    };
    startTransition(async () => {
      const url = mode === 'create' ? '/api/regions' : `/api/regions/${region!.id}`;
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
      toast.success(mode === 'create' ? 'Region created' : 'Region updated');
      onSaved();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add region' : `Edit region ${region?.code}`}</DialogTitle>
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
          <div className="space-y-1.5">
            <Label htmlFor="depot">Default depot (optional)</Label>
            <Select value={form.depotId} onValueChange={(v) => setForm({ ...form, depotId: v })}>
              <SelectTrigger id="depot">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>— none —</SelectItem>
                {depots.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.code} — {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
