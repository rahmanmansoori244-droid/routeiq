'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fmtDayMonth } from '@/lib/dispatch/time';
import { api, CUSTOMER_TYPES } from './client-api';
import { detailsFormOf, detailsPatch, EMPTY_DETAILS, type DetailsCustomer, type DetailsForm } from './customer-details';

export interface EditableCustomer extends DetailsCustomer {
  customerId: string;
  code: string;
  branchCode: string | null;
  name: string;
  /** The hours in use with their source ("hard 06:00–10:00 (default - not confirmed)"). */
  windowLabel?: string;
  windowConfirmedBy?: string | null;
  windowConfirmedAt?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  customer: EditableCustomer | null;
  onSaved: () => void;
}

// Where a default comes from. A priority has no Settings default: DEFAULT is the stored, unconfirmed one.
const PRIORITY_DEFAULT_TEXT: Record<string, string> = { TYPE: 'customer type default', DEFAULT: 'default' };
const SERVICE_DEFAULT_TEXT: Record<string, string> = { TYPE: 'customer type default', DEFAULT: 'Settings default' };

/**
 * Confirm priority / type / service time / receiving hours. Saved on the customer master.
 *
 * Audit F07 (owner decision 9, customer-details.ts): times are checked strictly (HH:MM), unloading
 * time is whole minutes or blank (= the default, not confirmed), and Save sends only what the
 * dispatcher changed, so a priority or unloading time nobody touched is never marked as confirmed.
 * A window with a changed end is sent whole, both ends as shown (A2 review), so the saved window is
 * always one the dispatcher saw.
 */
export function CustomerDialog({ open, onOpenChange, customer, onSaved }: Props) {
  // The form as it opened (what "changed" is measured against) and as typed now.
  const [initial, setInitial] = useState<DetailsForm>(EMPTY_DETAILS);
  const [form, setForm] = useState<DetailsForm>(EMPTY_DETAILS);
  const [busy, setBusy] = useState(false);
  // Bumped whenever the dialog opens, closes or shows another customer: a Save answer that arrives
  // after that is reported for its own customer, never applied to the dialog on screen.
  const shown = useRef(0);

  useEffect(() => {
    shown.current++;
    setBusy(false);
    if (!open || !customer) return;
    const f = detailsFormOf(customer);
    setInitial(f);
    setForm(f);
  }, [open, customer]);

  const set = (key: keyof DetailsForm) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  const tick = (key: 'openAllDay' | 'confirmHours') => (value: boolean) => setForm((f) => ({ ...f, [key]: value }));
  const hoursShown = !!(form.hardStart.trim() || form.hardEnd.trim() || form.prefStart.trim() || form.prefEnd.trim());
  const confirmedText = customer?.windowConfirmed
    ? `Receiving hours confirmed${customer.windowConfirmedBy ? ` by ${customer.windowConfirmedBy}` : ''}${customer.windowConfirmedAt ? ` on ${fmtDayMonth(customer.windowConfirmedAt.slice(0, 10))}` : ''}.`
    : `Receiving hours not confirmed${customer?.windowLabel ? ` (now: ${customer.windowLabel})` : ''}. Enter them as the customer gave them, or tick "Open all day".`;

  async function save() {
    if (!customer || busy) return;
    const r = detailsPatch(initial, form);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    if (Object.keys(r.patch).length === 0) {
      toast.info('Nothing changed.');
      onOpenChange(false);
      return;
    }
    const started = shown.current;
    const target = customer;
    setBusy(true);
    const res = await api(`/api/customers/${target.customerId}`, { method: 'PATCH', json: r.patch });
    if (started !== shown.current) {
      if (res.ok) {
        toast.success(`Details saved for ${target.name}.`);
        onSaved();
      } else toast.error(`The details of ${target.name} were not saved: ${res.error ?? 'error'}`);
      return;
    }
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error ?? 'Could not save.');
      return;
    }
    toast.success('Customer details saved.');
    onOpenChange(false);
    onSaved();
  }

  const priorityDefault = initial.priority === '' && customer ? `P${customer.priority} - ${PRIORITY_DEFAULT_TEXT[customer.prioritySource ?? ''] ?? 'default'}, not confirmed` : null;
  const serviceDefault =
    customer && customer.serviceSource && customer.serviceSource !== 'CUSTOMER' ? `${customer.serviceMin} (${SERVICE_DEFAULT_TEXT[customer.serviceSource] ?? 'default'})` : 'empty = default';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Customer delivery details</DialogTitle>
          <DialogDescription>
            {customer?.name} — {customer?.code}
            {customer?.branchCode ? ` / ${customer.branchCode}` : ''}. Only what you change is saved. Empty receiving hours = the customer-type default (not confirmed); empty
            unloading time = the customer-type or Settings default.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="cd-type">Customer type</Label>
            <select id="cd-type" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.type} onChange={(e) => set('type')(e.target.value)}>
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
            <select id="cd-prio" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.priority} onChange={(e) => set('priority')(e.target.value)}>
              {priorityDefault ? <option value="">{priorityDefault}</option> : null}
              {[1, 2, 3, 4, 5].map((p) => (
                <option key={p} value={String(p)}>
                  P{p}
                  {p === 1 ? ' — highest' : p === 5 ? ' — lowest' : ''}
                </option>
              ))}
            </select>
            {priorityDefault && form.priority === '' ? <p className="text-xs text-muted-foreground">Pick a priority to confirm it.</p> : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="cd-svc">Unloading time (whole minutes, 0 to 480)</Label>
            <Input id="cd-svc" inputMode="numeric" value={form.service} placeholder={serviceDefault} onChange={(e) => set('service')(e.target.value)} />
            <p className="text-xs text-muted-foreground">Empty = the customer-type or Settings default. 0 = no unloading time.</p>
          </div>
          <div />
          <div className="space-y-1">
            <Label htmlFor="cd-hs">Receiving hours — HARD (never outside)</Label>
            <div className="flex items-center gap-1">
              <Input id="cd-hs" placeholder="06:00" value={form.hardStart} disabled={!!form.openAllDay} onChange={(e) => set('hardStart')(e.target.value)} />
              <span>–</span>
              <Input id="cd-he" aria-label="Receiving hours end" placeholder="10:00" value={form.hardEnd} disabled={!!form.openAllDay} onChange={(e) => set('hardEnd')(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cd-ps">Preferred hours (soft)</Label>
            <div className="flex items-center gap-1">
              <Input id="cd-ps" placeholder="07:00" value={form.prefStart} disabled={!!form.openAllDay} onChange={(e) => set('prefStart')(e.target.value)} />
              <span>–</span>
              <Input id="cd-pe" aria-label="Preferred hours end" placeholder="09:00" value={form.prefEnd} disabled={!!form.openAllDay} onChange={(e) => set('prefEnd')(e.target.value)} />
            </div>
          </div>
          <div className="col-span-2 space-y-1 rounded-md border p-2 text-sm" data-testid="window-confirmation">
            <p className={`text-xs ${customer?.windowConfirmed ? 'text-green-700' : 'text-amber-800'}`}>{confirmedText}</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!form.openAllDay} onChange={(e) => tick('openAllDay')(e.target.checked)} data-testid="open-all-day" />
              Open all day — this customer accepts deliveries at any time
            </label>
            {!initial.confirmHours && !form.openAllDay && hoursShown ? (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!!form.confirmHours} onChange={(e) => tick('confirmHours')(e.target.checked)} data-testid="confirm-hours" />
                These hours are confirmed with the customer
              </label>
            ) : null}
            <p className="text-xs text-muted-foreground">Hours you type here are saved as confirmed by you. To give one order a different time (urgent or promised), use Delivery times on the day screen: the customer&apos;s hours do not change.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy} data-testid="save-customer-details">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
