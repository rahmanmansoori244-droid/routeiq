'use client';

import { useEffect, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  CANCEL_REASONS,
  invoicesText,
  ORDER_ACTION_NOTE_MAX,
  ORDER_ACTION_REASON_TEXT,
  POSTPONE_REASONS,
  checkOrderActionReason,
  postponeRange,
  severalInvoicesNote,
  type PostponeReason,
} from '@/lib/dispatch/order-cancel-rules';
import { fmtDayMonth } from '@/lib/dispatch/time';
import { api } from './client-api';

/** The order a dialog acts on (one row of the day's order list). */
export interface OrderActionTarget {
  orderId: string;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  cases: number;
  salesOrders: string[];
  linesWithoutInvoice?: number;
  /** "T05 L2 (planned)": where the plan in use holds it. */
  loads?: string[];
}

/** One cancelled order of the day (GET /api/dispatch/day: `cancelled`). */
export interface CancelledRow {
  orderId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
  cases: number;
  salesOrders: string[];
  linesWithoutInvoice: number;
  reasonText: string;
  by: string | null;
  at: string;
  onPlannedLoads: string[];
  /** A planned load holding it also holds other orders of the day: RE-PLAN takes it off (absent on an older answer = yes). */
  replan?: boolean;
  canUndo: boolean;
}

const who = (t: { customerName: string; customerCode: string; branchCode: string | null }) => `${t.customerName} — ${t.customerCode}${t.branchCode ? ` / ${t.branchCode}` : ''}`;

/**
 * "Cancel order..." and "Postpone order..." of one order (owner request 12 Oct 2026). The dialog lists
 * the order's invoices and cases (all of them are cancelled or postponed together: one order is every
 * invoice of the customer for the day in one file), a reason, a note (required for Other) and, to
 * postpone, the day: after the order's day, at most 14 days later, not before today. The server checks
 * everything again (locked loads, a load that left, the plan being optimized) and its answer is shown
 * as it is; the day and its plan are then read again (`onDone`).
 */
export function OrderActionDialog({
  action,
  target,
  date,
  today,
  onClose,
  onDone,
}: {
  action: 'CANCEL' | 'POSTPONE';
  target: OrderActionTarget | null;
  /** The day on screen (the order's delivery date) and the company's today (YYYY-MM-DD). */
  date: string;
  today: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const reasons: readonly PostponeReason[] = action === 'CANCEL' ? CANCEL_REASONS : POSTPONE_REASONS;
  const range = postponeRange(date, today);
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [toDate, setToDate] = useState('');
  const [busy, setBusy] = useState(false);
  // An answer that arrives after the dialog closed or moved to another order is reported for its own order.
  const shown = useRef(0);
  useEffect(() => {
    shown.current++;
    setBusy(false);
    setReason(action === 'POSTPONE' ? 'POSTPONED_BY_SALES' : '');
    setNote('');
    setToDate(range?.from ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when another order (or action) is opened
  }, [target, action]);

  const verb = action === 'CANCEL' ? 'Cancel' : 'Postpone';
  const several = target ? severalInvoicesNote(target.salesOrders, action) : null;
  // The day is over (before the company's today): Undo cancel is refused there (409 DAY_OVER), so the
  // dialog says the cancel is final instead of promising Undo.
  const dayOver = date < today;

  async function send() {
    if (!target || busy) return;
    const r = checkOrderActionReason(action, reason, note);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    if (action === 'POSTPONE' && (!range || !toDate || toDate < range.from || toDate > range.to)) {
      toast.error(range ? `Choose a day from ${fmtDayMonth(range.from)} to ${fmtDayMonth(range.to)}.` : 'This order cannot be postponed: its day is over. Use Bring forward.');
      return;
    }
    const started = shown.current;
    setBusy(true);
    const res =
      action === 'CANCEL'
        ? await api<{ message: string }>(`/api/dispatch/orders/${encodeURIComponent(target.orderId)}/cancel`, { method: 'POST', json: { reason: r.reason, note: r.note } })
        : await api<{ message: string }>(`/api/dispatch/orders/${encodeURIComponent(target.orderId)}/postpone`, { method: 'POST', json: { date: toDate, reason: r.reason, note: r.note } });
    if (started === shown.current) setBusy(false);
    if (!res.ok) {
      toast.error(`${target.customerName}: not ${action === 'CANCEL' ? 'cancelled' : 'postponed'}. ${res.error ?? 'Error.'}`, { duration: 12_000 });
      // The day may have changed under the screen (a load locked, the plan being optimized): show it as it is.
      if (res.status === 409) onDone();
      return;
    }
    toast.success(res.data?.message ?? `${verb}ed.`, { duration: 12_000 });
    if (started === shown.current) onClose();
    onDone();
  }

  return (
    <Dialog open={!!target} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="max-w-md" data-testid={`order-${action.toLowerCase()}-dialog`}>
        <DialogHeader>
          <DialogTitle>{action === 'CANCEL' ? 'Cancel order' : 'Postpone order'}</DialogTitle>
          <DialogDescription>
            {target ? who(target) : ''}, {fmtDayMonth(date)}.{' '}
            {action === 'CANCEL'
              ? dayOver
                ? 'The order is taken out of the counts and stays in the Cancelled list of this day.'
                : 'The order is taken out of planning and the counts; it stays in the Cancelled list of this day, where Undo brings it back.'
              : 'The order moves to the day you choose, marked "Carried over from this day". Undo is on that day\'s screen (Bring forward) until it is planned there.'}
          </DialogDescription>
          {action === 'CANCEL' && dayOver ? (
            <p className="text-sm font-medium text-red-700" data-testid="cancel-final">
              This day is over: a cancel here cannot be undone. Use it only for an order that will never be delivered (to deliver it later, use Bring forward on today&apos;s screen instead).
            </p>
          ) : null}
        </DialogHeader>
        {target ? (
          <div className="space-y-1 rounded-md border bg-muted/30 p-2 text-sm" data-testid="order-action-invoices">
            <p>
              <b>Invoices:</b> {invoicesText(target.salesOrders, target.linesWithoutInvoice ?? 0)}
            </p>
            <p>
              <b>Cases:</b> {target.cases.toLocaleString()}
              {target.loads?.length ? <span className="text-muted-foreground"> · on {target.loads.join(', ')}</span> : null}
            </p>
            {several ? <p className="text-xs text-amber-800">{several}</p> : null}
            {target.loads?.some((l) => l.endsWith('(planned)')) ? (
              <p className="text-xs text-muted-foreground">It is on a planned load: RE-PLAN the day afterwards to take it off. Until then that load cannot be locked.</p>
            ) : null}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          {action === 'POSTPONE' ? (
            <div className="col-span-2 space-y-1">
              <Label htmlFor="oa-date">Postpone to</Label>
              <Input
                id="oa-date"
                type="date"
                value={toDate}
                min={range?.from}
                max={range?.to}
                onChange={(e) => setToDate(e.target.value)}
                data-testid="postpone-date"
              />
              <p className="text-xs text-muted-foreground">
                {range ? `From ${fmtDayMonth(range.from)} to ${fmtDayMonth(range.to)} (at most 14 days after the order's day).` : 'This order\'s day is over: use Bring forward on today\'s screen.'}
              </p>
            </div>
          ) : null}
          <div className="col-span-2 space-y-1">
            <Label htmlFor="oa-reason">Reason</Label>
            <select
              id="oa-reason"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="order-action-reason"
            >
              <option value="" disabled>
                Choose a reason
              </option>
              {reasons.map((r) => (
                <option key={r} value={r}>
                  {ORDER_ACTION_REASON_TEXT[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2 space-y-1">
            <Label htmlFor="oa-note">Note{reason === 'OTHER' ? ' (required)' : ' (optional)'}</Label>
            <Input id="oa-note" maxLength={ORDER_ACTION_NOTE_MAX} placeholder="e.g. shop closed for renovation" value={note} onChange={(e) => setNote(e.target.value)} data-testid="order-action-note" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button variant={action === 'CANCEL' ? 'destructive' : 'default'} onClick={() => void send()} disabled={busy} data-testid={`order-${action.toLowerCase()}-confirm`}>
            {action === 'CANCEL' ? 'Cancel this order' : 'Postpone this order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Step 1's "Cancelled orders" list (owner request 12 Oct 2026): greyed rows with the invoices, the
 * reason, who and when, a note when a planned load still holds one (RE-PLAN takes it off), and Undo
 * while the day is not over. Nothing is shown when the day has none.
 */
export function CancelledOrdersList({ rows, canPlan, disabled, onDone }: { rows: CancelledRow[]; canPlan: boolean; disabled: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!rows.length) return null;
  async function undo(c: CancelledRow) {
    if (busy) return;
    if (!window.confirm(`Undo the cancel of ${c.customerName} (${invoicesText(c.salesOrders, c.linesWithoutInvoice)}, ${c.cases} cases)? The order is open again and the next OPTIMIZE or RE-PLAN plans it.`)) return;
    setBusy(c.orderId);
    const res = await api<{ message: string }>(`/api/dispatch/orders/${encodeURIComponent(c.orderId)}/uncancel`, { method: 'POST' });
    setBusy(null);
    if (!res.ok) toast.error(`${c.customerName}: the cancel was not undone. ${res.error ?? 'Error.'}`, { duration: 12_000 });
    else toast.success(res.data?.message ?? 'Cancel undone.', { duration: 10_000 });
    onDone();
  }
  return (
    <details className="rounded-md border border-dashed p-2 text-sm text-muted-foreground" data-testid="cancelled-orders" open={rows.some((c) => c.onPlannedLoads.length > 0 && c.replan !== false)}>
      <summary className="cursor-pointer">
        Cancelled orders — {rows.length} ({rows.reduce((a, c) => a + c.cases, 0).toLocaleString()} cases): not planned or counted
      </summary>
      <ul className="mt-1 space-y-1 text-xs">
        {rows.map((c) => (
          <li key={c.orderId} className="flex flex-wrap items-center justify-between gap-2 opacity-80" data-testid={`cancelled-${c.orderId}`}>
            <span>
              <s>{c.customerName}</s> {c.customerCode}
              {c.branchCode ? ` / ${c.branchCode}` : ''} · {invoicesText(c.salesOrders, c.linesWithoutInvoice)} · {c.cases} cases · {c.reasonText} · {c.by ?? 'a removed user'},{' '}
              {new Date(c.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              {c.onPlannedLoads.length ? (
                c.replan !== false ? (
                  <b className="text-amber-800"> · still on {c.onPlannedLoads.join(', ')}: RE-PLAN to take it off</b>
                ) : (
                  <span> · still shown on {c.onPlannedLoads.join(', ')}, which holds nothing else: leave it as it is (never loaded)</span>
                )
              ) : null}
            </span>
            {canPlan && c.canUndo ? (
              <Button size="sm" variant="outline" disabled={disabled || busy !== null} onClick={() => void undo(c)} data-testid={`uncancel-${c.orderId}`}>
                <Undo2 className="mr-1 h-3 w-3" /> Undo
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
