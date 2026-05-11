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

export interface DriverRow {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  active: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  driver?: DriverRow;
  onSaved: () => void;
}

const blank = { code: '', name: '', phone: '', active: true };

export function DriverFormDialog({ open, onOpenChange, mode, driver, onSaved }: Props) {
  const [form, setForm] = useState(blank);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      if (mode === 'edit' && driver) {
        setForm({ code: driver.code, name: driver.name, phone: driver.phone ?? '', active: driver.active });
      } else {
        setForm(blank);
      }
    }
  }, [open, mode, driver]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const url = mode === 'create' ? '/api/drivers' : `/api/drivers/${driver!.id}`;
      const method = mode === 'create' ? 'POST' : 'PATCH';
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof data.error === 'string' ? data.error : 'Save failed.');
        return;
      }
      toast.success(mode === 'create' ? 'Driver created' : 'Driver updated');
      onSaved();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add driver' : `Edit driver ${driver?.code}`}</DialogTitle>
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
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
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
