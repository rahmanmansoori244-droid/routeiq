'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRightCircle, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { BringForwardResult, CarryCandidate, CarryPreview } from '@/lib/dispatch/carry-over';
import { carryDoneText, carriedFromBadge, carrySelectionPayload, defaultCarrySelection } from '@/lib/dispatch/carry-view';
import { addDaysIso, fmtDayMonth } from '@/lib/dispatch/time';
import { api, REASON_TEXT } from './client-api';

const WHY_LABEL: Record<string, string> = {
  NOT_LEFT: 'Load never left',
  UNSERVED: 'Unserved',
  NEVER_PLANNED: 'Never planned',
};

interface Props {
  /** Day D and the depot on screen (the loaded day, never the pickers). */
  date: string;
  depotId: string;
  canPlan: boolean;
  /** The day on screen is the selected one and loaded without error. */
  ready: boolean;
  /** Another action of the screen runs (OPTIMIZE / RE-PLAN, a plan action). */
  busy: boolean;
  /** Changes when the day's orders may have changed (a file added, a plan made): the list is read again. */
  reloadKey: string;
  /** After orders were brought forward: reload the day (its pending orders, the plan below). */
  onCarried: () => Promise<unknown>;
}

/**
 * PR9 "Bring forward": the orders of the 7 days before this day that were not delivered (unserved,
 * on a load that never left the depot, or never planned) - only days that are over, never today or
 * later in the company's timezone - with the reason for each, and the button
 * that brings the selected ones forward to this day. Orders that cannot be brought forward
 * (deactivated customer, entered again for this day, ...) are listed with the reason.
 */
export function CarryOverPanel({ date, depotId, canPlan, ready, busy, reloadKey, onCarried }: Props) {
  const [preview, setPreview] = useState<CarryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  // Only the answer for the day and depot on screen is shown (an older request can answer later).
  const want = useRef('');

  const load = useCallback(async () => {
    const key = `${date}|${depotId}`;
    want.current = key;
    const q = new URLSearchParams({ date, depotId });
    const r = await api<CarryPreview>(`/api/dispatch/carry-over?${q}`);
    if (want.current !== key) return;
    if (!r.ok || !r.data) {
      setError(r.error ?? 'Could not read the orders of earlier days.');
      return;
    }
    setError(null);
    setPreview(r.data);
    setSelected(defaultCarrySelection(r.data.candidates));
  }, [date, depotId]);

  // Another day or depot: nothing of the previous one stays on screen.
  useEffect(() => {
    setPreview(null);
    setError(null);
    setOpen(false);
  }, [date, depotId]);
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  async function bringForward() {
    if (!preview || running || busy || !ready) return;
    const body = carrySelectionPayload(preview.candidates, selected);
    if (!body.length) return;
    const cases = body.reduce((a, s) => a + s.cases, 0);
    const day = fmtDayMonth(date);
    if (!window.confirm(`Bring ${body.length} order(s) (${cases.toLocaleString()} cases) forward to ${day}?\n\nThey become orders of ${day} and are no longer open on their own days. The plans of those days stay as they are.`)) return;
    setRunning(true);
    try {
      const r = await api<BringForwardResult>('/api/dispatch/carry-over', { method: 'POST', json: { date, depotId, selected: body } });
      if (!r.ok || !r.data) {
        toast.error(r.error ?? 'Could not bring the orders forward.');
      } else {
        toast.success(carryDoneText(r.data, date));
        await onCarried();
      }
      await load();
    } finally {
      setRunning(false);
    }
  }

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-red-700" data-testid="carry-over-error">
        Orders of earlier days: {error}
        <Button size="sm" variant="outline" onClick={() => void load()}>
          <RefreshCw className="mr-1 h-3 w-3" /> Try again
        </Button>
      </div>
    );
  }
  if (!preview || preview.candidates.length === 0) return null;
  const chosen = preview.candidates.filter((c) => selected.has(c.orderId) && !c.blocked);
  const chosenCases = chosen.reduce((a, c) => a + c.cases, 0);
  const toggle = (c: CarryCandidate) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(c.orderId)) n.delete(c.orderId);
      else n.add(c.orderId);
      return n;
    });

  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="carry-over">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">
          Not delivered on earlier days: {preview.orders} order(s) ({preview.cases.toLocaleString()} cases)
          {preview.blocked ? <span className="font-normal text-muted-foreground"> · {preview.blocked} cannot be brought forward (see the list)</span> : null}
        </p>
        <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)} data-testid="carry-over-toggle">
          {open ? 'Hide list' : 'Show list'}
        </Button>
        {canPlan ? (
          <Button size="sm" onClick={() => void bringForward()} disabled={!ready || busy || running || chosen.length === 0} data-testid="carry-over-btn">
            {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ArrowRightCircle className="mr-1 h-4 w-4" />}
            Bring forward to {fmtDayMonth(date)}
            {chosen.length !== preview.orders ? ` (${chosen.length} order(s), ${chosenCases.toLocaleString()} cases)` : ''}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Orders of this depot from {fmtDayMonth(preview.from)} to {fmtDayMonth(preview.to)} whose cases were not delivered: unserved, on a load that never left the depot, or never
        planned. Orders on dispatched or completed loads count as delivered. Brought forward, an order keeps its priority and its sales orders.
        {preview.to < addDaysIso(date, -1) ? (
          <span data-testid="carry-over-today-note">
            {' '}
            Orders due today ({fmtDayMonth(preview.today)}) are listed from tomorrow on: the day is not over and its loads may still leave.
          </span>
        ) : null}
      </p>
      {open ? (
        <div className="max-h-80 overflow-auto rounded border bg-background">
          <table className="w-full text-xs" data-testid="carry-over-list">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2" />
                <th className="p-2">Customer</th>
                <th className="p-2">Due</th>
                <th className="p-2">Cases</th>
                <th className="p-2">Why not delivered</th>
              </tr>
            </thead>
            <tbody>
              {preview.candidates.map((c) => (
                <tr key={c.orderId} className="border-t align-top" data-testid={`carry-${c.customerCode}`}>
                  <td className="p-2">
                    <input
                      type="checkbox"
                      aria-label={`Bring forward ${c.customerCode}`}
                      checked={!c.blocked && selected.has(c.orderId)}
                      disabled={!!c.blocked || !canPlan}
                      onChange={() => toggle(c)}
                    />
                  </td>
                  <td className="p-2">
                    {c.customerName}{' '}
                    <span className="text-muted-foreground">
                      {c.customerCode}
                      {c.branchCode ? ` / ${c.branchCode}` : ''} · P{c.priority}
                    </span>
                    {c.salesOrders.length ? <span className="block text-muted-foreground">SO {c.salesOrders.join(', ')}</span> : null}
                    {c.blocked ? <span className="block font-medium text-red-700">{c.blocked.text}</span> : null}
                  </td>
                  <td className="p-2">
                    {fmtDayMonth(c.date)}
                    {c.firstDate !== c.date ? <Badge variant="secondary" className="ml-1">{carriedFromBadge(c.firstDate)}</Badge> : null}
                  </td>
                  <td className="p-2">{c.partial ? `${c.cases} of ${c.orderCases}` : c.cases}</td>
                  <td className="p-2">
                    {c.why.map((w, i) => (
                      <span key={i} className="block">
                        <b>{w.kind === 'UNSERVED' && w.reasonCode ? `Unserved: ${REASON_TEXT[w.reasonCode] ?? w.reasonCode}` : WHY_LABEL[w.kind]}</b>
                        <span className="text-muted-foreground"> - {w.text}</span>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
