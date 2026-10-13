'use client';

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { errorMessage } from '@/lib/error-message';

export interface HelperRow {
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
  helper?: HelperRow;
  /** A company admin: the only one who may change a helper's code (the server refuses it to the dispatcher). */
  canAdmin?: boolean;
  onSaved: () => void;
}

const blank = { code: '', name: '', phone: '', active: true };

/** Add or edit a helper (owner request 13 Oct 2026), as the driver form. A code already used: the server's 409 message. */
export function HelperFormDialog({ open, onOpenChange, mode, helper, canAdmin = false, onSaved }: Props) {
  const [form, setForm] = useState(blank);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) setForm(mode === 'edit' && helper ? { code: helper.code, name: helper.name, phone: helper.phone ?? '', active: helper.active } : blank);
  }, [open, mode, helper]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await fetch(mode === 'create' ? '/api/helpers' : `/api/helpers/${helper!.id}`, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(data, 'Save failed.'));
        return;
      }
      toast.success(mode === 'create' ? 'Helper created' : 'Helper updated');
      if (typeof data?.data?.warning === 'string') toast.warning(data.data.warning, { duration: 10_000 });
      onSaved();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add helper' : `Edit helper ${helper?.code}`}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="helper-code">Code</Label>
              <Input
                id="helper-code"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                required
                disabled={mode === 'edit' && !canAdmin}
                title={mode === 'edit' && !canAdmin ? 'Only a company admin changes a helper code.' : 'Letters, digits, dot, dash, underscore, e.g. H01'}
                maxLength={32}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="helper-phone">Phone</Label>
              <Input
                id="helper-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+968 9123 4567"
                aria-describedby="helper-phone-hint"
              />
              <p id="helper-phone-hint" className="text-[11px] text-muted-foreground">
                Optional, with the country code, e.g. +968
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="helper-name">Name</Label>
            <Input id="helper-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor="helper-active" className="text-sm">
              Active
            </Label>
            <Switch id="helper-active" checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} />
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
