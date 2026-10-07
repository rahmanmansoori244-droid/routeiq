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

export interface DriverRow {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  active: boolean;
  /** A daily (casual) driver added from a load (owner request 4 Oct 2026). */
  casual?: boolean;
  /** On leave today: his last day (owner request 6 Oct 2026). */
  leaveUntil?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  driver?: DriverRow;
  /**
   * A company admin: the only one who may change a driver's code or make a regular driver a daily one
   * (the dispatcher edits the rest; the server refuses those two to him, 403 ADMIN_ONLY_DRIVER_FIELD).
   * Both are on this form for the admin: the Code field and the Daily driver switch.
   */
  canAdmin?: boolean;
  onSaved: () => void;
}

const blank = { code: '', name: '', phone: '', active: true, casual: false };

export function DriverFormDialog({ open, onOpenChange, mode, driver, canAdmin = false, onSaved }: Props) {
  const [form, setForm] = useState(blank);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      if (mode === 'edit' && driver) {
        setForm({ code: driver.code, name: driver.name, phone: driver.phone ?? '', active: driver.active, casual: !!driver.casual });
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
        // casual is sent on an edit only: clearing it makes a daily driver a regular one.
        body: JSON.stringify(mode === 'edit' ? form : { code: form.code, name: form.name, phone: form.phone, active: form.active }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(data, 'Save failed.'));
        return;
      }
      toast.success(mode === 'create' ? 'Driver created' : 'Driver updated');
      // Switched to inactive: the trucks that keep them as default driver are named (audit F20).
      if (typeof data?.data?.warning === 'string') toast.warning(data.data.warning, { duration: 10_000 });
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
                disabled={mode === 'edit' && !canAdmin}
                title={
                  mode === 'edit'
                    ? canAdmin
                      ? 'The driver code. Loads and sheets show the driver by name; the audit log keeps the old code.'
                      : 'Only a company admin changes a driver code: ask them on the Drivers page.'
                    : undefined
                }
                maxLength={32}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+968 9123 4567"
                title="Mobile with the country code, so the WhatsApp link opens the right chat"
                aria-describedby="phone-hint"
              />
              <p id="phone-hint" className="text-[11px] text-muted-foreground">
                With the country code, e.g. +968
              </p>
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
          {/* Daily driver: anyone who edits drivers makes a daily driver regular; only a company admin
              makes a regular driver daily (the server refuses it to the dispatcher). */}
          {mode === 'edit' && (driver?.casual || canAdmin) ? (
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <Label htmlFor="casual" className="text-sm">
                Daily driver
                <span className="block text-xs font-normal text-muted-foreground">
                  {driver?.casual
                    ? 'Added from a load by a dispatcher. Switch off to make them a regular driver.'
                    : 'A regular driver. Switch on to make them a daily driver (company admin only).'}
                </span>
              </Label>
              <Switch id="casual" checked={form.casual} disabled={!driver?.casual && !canAdmin} onCheckedChange={(v) => setForm({ ...form, casual: v })} />
            </div>
          ) : null}
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
