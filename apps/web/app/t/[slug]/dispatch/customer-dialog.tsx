'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, CUSTOMER_TYPES, hhmm, toMinutes } from './client-api';

export interface EditableCustomer {
  customerId: string;
  code: string;
  branchCode: string | null;
  name: string;
  customerType: string | null;
  priority: number;
  serviceMin: number;
  hardWindowStartMin: number | null;
  hardWindowEndMin: number | null;
  prefWindowStartMin: number | null;
  prefWindowEndMin: number | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  customer: EditableCustomer | null;
  onSaved: () => void;
}

/** Confirm priority / type / service time / receiving hours. Saved on the customer master. */
export function CustomerDialog({ open, onOpenChange, customer, onSaved }: Props) {
  const [type, setType] = useState('');
  const [priority, setPriority] = useState(3);
  const [service, setService] = useState('10');
  const [hs, setHs] = useState('');
  const [he, setHe] = useState('');
  const [ps, setPs] = useState('');
  const [pe, setPe] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !customer) return;
    setType(customer.customerType ?? '');
    setPriority(customer.priority);
    setService(String(customer.serviceMin));
    const f = (v: number | null) => (v === null ? '' : hhmm(v));
    setHs(f(customer.hardWindowStartMin));
    setHe(f(customer.hardWindowEndMin));
    setPs(f(customer.prefWindowStartMin));
    setPe(f(customer.prefWindowEndMin));
  }, [open, customer]);

  async function save() {
    if (!customer) return;
    const mins = [hs, he, ps, pe].map(toMinutes);
    if (mins.some((m) => m !== null && Number.isNaN(m))) {
      toast.error('Use HH:MM for times, e.g. 06:30.');
      return;
    }
    const [a, b, c, d] = mins;
    if ((a === null) !== (b === null) || (c === null) !== (d === null)) {
      toast.error('Give both the start and the end of a window (or leave both empty).');
      return;
    }
    setBusy(true);
    const r = await api(`/api/customers/${customer.customerId}`, {
      method: 'PATCH',
      json: {
        customerType: type || null,
        priority,
        avgServiceTimeMin: Number(service) || 0,
        hardWindowStartMin: a,
        hardWindowEndMin: b,
        prefWindowStartMin: c,
        prefWindowEndMin: d,
      },
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error ?? 'Could not save.');
      return;
    }
    toast.success('Customer details saved.');
    onOpenChange(false);
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Customer delivery details</DialogTitle>
          <DialogDescription>
            {customer?.name} — {customer?.code}
            {customer?.branchCode ? ` / ${customer.branchCode}` : ''}. Empty receiving hours = use the customer-type default.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="cd-type">Customer type</Label>
            <select id="cd-type" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">— not set —</option>
              {CUSTOMER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cd-prio">Priority (P1 = highest)</Label>
            <select id="cd-prio" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((p) => (
                <option key={p} value={p}>
                  P{p}
                  {p === 1 ? ' — highest' : p === 5 ? ' — lowest' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cd-svc">Unloading time (min, at most 480)</Label>
            <Input id="cd-svc" inputMode="numeric" value={service} onChange={(e) => setService(e.target.value)} />
          </div>
          <div />
          <div className="space-y-1">
            <Label>Receiving hours — HARD (never outside)</Label>
            <div className="flex items-center gap-1">
              <Input placeholder="06:00" value={hs} onChange={(e) => setHs(e.target.value)} />
              <span>–</span>
              <Input placeholder="10:00" value={he} onChange={(e) => setHe(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Preferred hours (soft)</Label>
            <div className="flex items-center gap-1">
              <Input placeholder="07:00" value={ps} onChange={(e) => setPs(e.target.value)} />
              <span>–</span>
              <Input placeholder="09:00" value={pe} onChange={(e) => setPe(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
