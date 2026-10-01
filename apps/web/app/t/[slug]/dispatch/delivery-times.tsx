'use client';

import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clockText, DELIVERY_TIME_REASON_TEXT, DELIVERY_TIME_REASONS, orderTimeFromForm, type OrderTime, type OrderTimeForm } from '@/lib/dispatch/order-window';
import { api } from './client-api';

/** One order of the day (GET /api/dispatch/day: customers[].orderTimes). */
export interface DayOrderTimeRow {
  orderId: string;
  cases: number;
  salesOrders: string[];
  time: OrderTime | null;
  text: string | null;
  frozen: boolean;
}

/** A customer of the day with its orders' delivery times. */
export interface DeliveryTimesCustomer {
  customerId: string;
  code: string;
  branchCode: string | null;
  name: string;
  windowLabel?: string;
  effWindow?: { hardStart: number | null; hardEnd: number | null; prefStart: number | null; prefEnd: number | null };
  orderTimes?: DayOrderTimeRow[];
  inactive?: boolean;
}

const minText = (m: number | null | undefined) => (m == null ? '' : clockText(m));

/**
 * The form an order's Change time opens with (owner decision 1 Oct 2026, item 1): the order's own time
 * when it has one, else prefilled from the customer's receiving hours (hard, else preferred), which the
 * dispatcher then changes for this order only.
 */
export function orderTimeFormOf(c: DeliveryTimesCustomer, o: DayOrderTimeRow): OrderTimeForm {
  if (o.time) return { start: minText(o.time.startMin), end: minText(o.time.endMin), reason: o.time.reason, note: o.time.note ?? '' };
  const w = c.effWindow;
  const hard = w && (w.hardStart !== null || w.hardEnd !== null);
  return { start: minText(hard ? w?.hardStart : w?.prefStart), end: minText(hard ? w?.hardEnd : w?.prefEnd), reason: 'URGENT', note: '' };
}

/**
 * Step 2's "Delivery times" list: every customer of the day, its receiving hours (with "default - not
 * confirmed" when they are not its own confirmed hours), and each order with its own delivery time
 * if it has one. Change time sets a time for that order only (urgent / promised); the customer
 * master is not changed. An order on a locked load cannot change (frozen loads never change).
 */
export function DeliveryTimesPanel({ customers, canPlan, onSaved }: { customers: DeliveryTimesCustomer[]; canPlan: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState<{ c: DeliveryTimesCustomer; o: DayOrderTimeRow } | null>(null);
  const list = customers.filter((c) => !c.inactive && c.orderTimes?.length);
  if (!list.length) return null;
  const orders = list.reduce((a, c) => a + (c.orderTimes?.length ?? 0), 0);
  const timed = list.reduce((a, c) => a + (c.orderTimes ?? []).filter((o) => o.time).length, 0);
  return (
    <details className="rounded-md border p-2 text-sm" data-testid="delivery-times">
      <summary className="cursor-pointer">
        Delivery times — {orders} order(s){timed ? `, ${timed} with an urgent or promised time` : ''}. Each order uses its customer&apos;s receiving hours unless you change it.
      </summary>
      <div className="mt-2 max-h-96 space-y-2 overflow-y-auto">
        {list.map((c) => (
          <div key={c.customerId} className="rounded border p-2">
            <p className="font-medium">
              {c.name} <span className="text-xs text-muted-foreground">{c.code}{c.branchCode ? ` / ${c.branchCode}` : ''}</span>
            </p>
            <p className="text-xs text-muted-foreground">Receiving hours: {c.windowLabel ?? '—'}</p>
            <ul className="mt-1 space-y-1">
              {(c.orderTimes ?? []).map((o) => (
                <li key={o.orderId} className="flex flex-wrap items-center justify-between gap-2 text-xs" data-testid={`order-time-${o.orderId}`}>
                  <span>
                    {o.salesOrders.length ? `SO ${o.salesOrders.join(', ')}` : 'Order'} · {o.cases} cases ·{' '}
                    {o.text ? <b className="text-blue-800">{o.text} ({DELIVERY_TIME_REASON_TEXT[o.time!.reason]}{o.time!.note ? `: ${o.time!.note}` : ''})</b> : "customer's hours"}
                    {o.frozen ? ' · on a locked load' : ''}
                  </span>
                  {canPlan && !o.frozen ? (
                    <Button size="sm" variant="outline" onClick={() => setEdit({ c, o })} data-testid={`change-time-${o.orderId}`}>
                      <Clock className="mr-1 h-3 w-3" /> {o.time ? 'Change time' : 'Set time'}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <OrderTimeDialog target={edit} onClose={() => setEdit(null)} onSaved={onSaved} />
    </details>
  );
}

export function OrderTimeDialog({ target, onClose, onSaved }: { target: { c: DeliveryTimesCustomer; o: DayOrderTimeRow } | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<OrderTimeForm>({ start: '', end: '', reason: 'URGENT', note: '' });
  const [busy, setBusy] = useState(false);
  // An answer that arrives after the dialog closed or moved to another order is reported for its own order.
  const shown = useRef(0);
  useEffect(() => {
    shown.current++;
    setBusy(false);
    if (target) setForm(orderTimeFormOf(target.c, target.o));
  }, [target]);
  const set = (k: keyof OrderTimeForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function send(clear: boolean) {
    if (!target || busy) return;
    let body: Record<string, unknown> = { orderId: target.o.orderId, clear: true };
    if (!clear) {
      const r = orderTimeFromForm(form);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      body = { orderId: target.o.orderId, startMin: r.time.startMin, endMin: r.time.endMin, reason: r.time.reason, note: r.time.note };
    }
    const started = shown.current;
    setBusy(true);
    const res = await api<{ message: string }>('/api/dispatch/delivery-time', { method: 'PUT', json: body });
    if (started === shown.current) setBusy(false);
    if (!res.ok) {
      toast.error(`The delivery time was not saved for ${target.c.name}: ${res.error ?? 'error'}`);
      return;
    }
    toast.success(res.data?.message ?? 'Delivery time saved.');
    if (started === shown.current) onClose();
    onSaved();
  }

  return (
    <Dialog open={!!target} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delivery time for one order</DialogTitle>
          <DialogDescription>
            {target ? `${target.c.name} — ${target.c.code}${target.c.branchCode ? ` / ${target.c.branchCode}` : ''}` : ''}
            {target?.o.salesOrders.length ? `, SO ${target.o.salesOrders.join(', ')}` : ''}. Receiving hours: {target?.c.windowLabel ?? '—'}. This time is for this order
            only (urgent or promised): the customer&apos;s hours do not change. RE-PLAN to plan the order with it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="ot-start">From (HH:MM)</Label>
            <Input id="ot-start" placeholder="10:00" value={form.start} onChange={(e) => set('start')(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ot-end">To (HH:MM)</Label>
            <Input id="ot-end" placeholder="11:00" value={form.end} onChange={(e) => set('end')(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ot-reason">Reason</Label>
            <select id="ot-reason" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={form.reason} onChange={(e) => set('reason')(e.target.value)}>
              {DELIVERY_TIME_REASONS.map((r) => (
                <option key={r} value={r}>
                  {DELIVERY_TIME_REASON_TEXT[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ot-note">Note{form.reason === 'OTHER' ? ' (required)' : ' (optional)'}</Label>
            <Input id="ot-note" maxLength={200} placeholder="e.g. promised by sales" value={form.note} onChange={(e) => set('note')(e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Leave From or To empty for &quot;by 10:00&quot; or &quot;from 14:00&quot;.</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {target?.o.time ? (
            <Button variant="outline" onClick={() => void send(true)} disabled={busy} data-testid="clear-order-time">
              Use customer&apos;s hours
            </Button>
          ) : null}
          <Button onClick={() => void send(false)} disabled={busy} data-testid="save-order-time">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
