'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRightCircle, Loader2, RefreshCw, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { BringForwardResult, CarryCandidate, CarryPreview, UndoableCarry } from '@/lib/dispatch/carry-over';
import {
  carryButtonSuffix,
  carryConfirmText,
  carryDoneText,
  carriedFromBadge,
  carryResultNote,
  carrySelected,
  carrySelectionPayload,
  carryTickedByDefault,
  carryTodayHint,
  carryTodaySplit,
  carryTodayTitle,
  carryUndoConfirmText,
  carryWhyLabel,
  noOutcomeGroups,
  toggleCarry,
  type CarryChoices,
} from '@/lib/dispatch/carry-view';
import { addDaysIso, fmtDayMonth } from '@/lib/dispatch/time';
import { api, REASON_TEXT } from './client-api';

interface Props {
  /** Day D and the depot on screen (the loaded day, never the pickers). */
  date: string;
  depotId: string;
  canPlan: boolean;
  /** The day on screen is the selected one and loaded without error. */
  ready: boolean;
  /**
   * Another action of the screen runs (OPTIMIZE / RE-PLAN, a plan action), or the day's plan is
   * being optimized (or queued): that optimization was started without the orders it would bring.
   */
  busy: boolean;
  /** Changes when the day's orders may have changed (a file added, a plan made): the list is read again. */
  reloadKey: string;
  /** After orders were brought forward: reload the day (its pending orders, the plan below). */
  onCarried: () => Promise<unknown>;
}

/**
 * PR9 "Bring forward": the orders of the 7 days before this day that were not delivered (unserved,
 * on a load that has not left the depot, or never planned) - never after the company's today - with
 * the reason for each, and the button that brings the selected ones forward to this day. Orders
 * that cannot be brought forward (deactivated customer, entered again for this day or a later one,
 * ...) are listed with the reason.
 *
 * Two groups (owner decision): the days before today are over - their orders are ticked by
 * default; today's orders (when this day is later than today, for example tomorrow planned in the
 * evening) are listed on their own, "Today (27 Sep) - ...", with a warning, and are NOT ticked by
 * default, except those the driver's result settled (every open case recorded as not delivered, the
 * truck back): today's loads that have not left yet may still go out today. The heading says which
 * rows are ticked and which "may still leave today (not ticked)" (carryTodayTitle). An order of
 * today goes in the POST only when ticked (`today: true`); the server refuses it otherwise.
 *
 * What the dispatcher ticked or unticked stays when the list is read again (after a refusal, a
 * partial bring forward, a new plan version or file, Look again): only orders new to the list get
 * their default. A day that is over (before the company's today) shows nothing.
 */
export function CarryOverPanel({ date, depotId, canPlan, ready, busy, reloadKey, onCarried }: Props) {
  const [preview, setPreview] = useState<CarryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What the dispatcher ticked or unticked by hand (kept across reloads of the list; reset for another day or depot).
  const [choices, setChoices] = useState<CarryChoices>(new Map());
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
  }, [date, depotId]);

  // Another day or depot: nothing of the previous one stays on screen.
  useEffect(() => {
    setPreview(null);
    setError(null);
    setOpen(false);
    setChoices(new Map());
  }, [date, depotId]);
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  async function bringForward() {
    if (!preview || preview.dayOver || running || busy || !ready) return;
    const selected = carrySelected(preview.candidates, choices);
    const body = carrySelectionPayload(preview.candidates, selected);
    if (!body.length) return;
    if (!window.confirm(carryConfirmText(preview.candidates.filter((c) => selected.has(c.orderId) && !c.blocked), date, preview.today))) return;
    setRunning(true);
    try {
      const r = await api<BringForwardResult>('/api/dispatch/carry-over', { method: 'POST', json: { date, depotId, selected: body } });
      if (!r.ok || !r.data) {
        toast.error(r.error ?? 'Could not bring the orders forward.');
      } else {
        toast.success(carryDoneText(r.data, date, preview.today));
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
  async function undo(u: UndoableCarry) {
    if (running || busy || !ready || !canPlan) return;
    if (!window.confirm(carryUndoConfirmText(u, date))) return;
    setRunning(true);
    try {
      const r = await api('/api/dispatch/carry-over/undo', { method: 'POST', json: { originalOrderId: u.originalOrderId } });
      if (!r.ok) toast.error(r.error ?? 'Could not undo the bring forward.');
      else {
        toast.success(`The copy of ${u.customerCode} on ${fmtDayMonth(date)} was removed: the order is open again on ${fmtDayMonth(u.fromDate)}.`);
        await onCarried();
      }
      await load();
    } finally {
      setRunning(false);
    }
  }

  // A day that is over lists nothing (the server answers 409 DAY_OVER to a bring forward).
  if (!preview || preview.dayOver || (preview.candidates.length === 0 && !hasFollowUps(preview))) return null;
  if (preview.candidates.length === 0) return <CarryFollowUps preview={preview} canPlan={canPlan} disabled={!ready || busy || running} onUndo={(u) => void undo(u)} />;
  const selected = carrySelected(preview.candidates, choices);
  const chosen = preview.candidates.filter((c) => selected.has(c.orderId));
  const earlier = preview.candidates.filter((c) => !c.ofToday);
  const todays = preview.candidates.filter((c) => c.ofToday);
  // Today's group: the rows ticked by default (the driver's result is settled, the truck is back) and the
  // rows that may still leave today (not ticked); what the dispatcher changed by hand is said apart.
  const todaySplit = carryTodaySplit(todays);
  const tickedByYou = todays.filter((c) => selected.has(c.orderId) && !carryTickedByDefault(c)).length;
  const untickedByYou = todays.filter((c) => !c.blocked && !selected.has(c.orderId) && carryTickedByDefault(c)).length;
  const toggle = (c: CarryCandidate) => setChoices((m) => toggleCarry(m, c));
  // The count is on the button whenever the selection is not "every order of the earlier days" (with today's ticked).
  const suffix = carryButtonSuffix(chosen, preview);

  const row = (c: CarryCandidate) => (
    <tr key={c.orderId} className={`border-t align-top ${c.ofToday ? 'bg-amber-50/60' : ''}`} data-testid={`carry-${c.customerCode}`}>
      <td className="p-2">
        <input
          type="checkbox"
          aria-label={`Bring forward ${c.customerCode}${c.ofToday ? ' (order of today)' : ''}`}
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
            <b>{w.kind === 'UNSERVED' && w.reasonCode ? `Unserved: ${REASON_TEXT[w.reasonCode] ?? w.reasonCode}` : carryWhyLabel(w.kind, c.ofToday)}</b>
            <span className="text-muted-foreground">
              {' '}
              - {w.text}
              {w.where ? ` (${w.where})` : ''}
            </span>
          </span>
        ))}
        {/* Delivery results: why a recorded shortfall is not ticked by itself (truck still out, ...). */}
        {carryResultNote(c) ? (
          <span className="block text-amber-800" data-testid={`carry-result-note-${c.customerCode}`}>
            {carryResultNote(c)}
          </span>
        ) : null}
      </td>
    </tr>
  );

  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="carry-over">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">
          Not delivered on earlier days: {preview.orders} order(s) ({preview.cases.toLocaleString()} cases)
          {todays.length ? (
            <span className="font-normal" data-testid="carry-over-today-count">
              {' '}
              · Today ({fmtDayMonth(preview.today)}): {preview.todayOrders} order(s) ({preview.todayCases.toLocaleString()} cases) not delivered yet
            </span>
          ) : null}
          {preview.blocked ? <span className="font-normal text-muted-foreground"> · {preview.blocked} cannot be brought forward (see the list)</span> : null}
        </p>
        <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)} data-testid="carry-over-toggle">
          {open ? 'Hide list' : 'Show list'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={running} data-testid="carry-over-refresh" title="Read the list again (today's loads may have left meanwhile)">
          <RefreshCw className="mr-1 h-3 w-3" /> Look again
        </Button>
        {canPlan ? (
          <Button size="sm" onClick={() => void bringForward()} disabled={!ready || busy || running || chosen.length === 0} data-testid="carry-over-btn">
            {running ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ArrowRightCircle className="mr-1 h-4 w-4" />}
            Bring forward to {fmtDayMonth(date)}
            {suffix}
          </Button>
        ) : null}
      </div>
      {todays.length ? (
        <p className="flex items-start gap-1 text-xs font-medium text-amber-900" data-testid="carry-over-today-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {carryTodayTitle(preview.today, todaySplit)}: {carryTodayHint(todaySplit)}
            {tickedByYou ? ` ${tickedByYou} more ticked by you.` : ''}
            {untickedByYou ? ` ${untickedByYou} unticked by you.` : ''}
          </span>
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Orders of this depot from {fmtDayMonth(preview.from)} to {fmtDayMonth(preview.to)} whose cases were not delivered: unserved, on a load that has not left the depot, never
        planned, or recorded as not delivered by the driver or the office. Other orders on dispatched or completed loads count as delivered. Brought forward, an order keeps its
        priority and its sales orders.
        {preview.to < addDaysIso(date, -1) ? (
          <span data-testid="carry-over-later-note">
            {' '}
            Orders due after today (from {fmtDayMonth(addDaysIso(preview.today, 1))}) are not listed: they are not due yet.
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
              {earlier.length && todays.length ? (
                <tr className="border-t bg-muted/30">
                  <td className="p-2 font-medium" colSpan={5} data-testid="carry-over-earlier-group">
                    Earlier days - ticked by default
                  </td>
                </tr>
              ) : null}
              {earlier.map(row)}
              {todays.length ? (
                <tr className="border-t bg-amber-100">
                  <td className="p-2" colSpan={5} data-testid="carry-over-today-group">
                    <span className="block font-medium">{carryTodayTitle(preview.today, todaySplit)}</span>
                    <span className="block text-amber-900">{carryTodayHint(todaySplit)}</span>
                  </td>
                </tr>
              ) : null}
              {todays.map(row)}
            </tbody>
          </table>
        </div>
      ) : null}
      {hasFollowUps(preview) ? <CarryFollowUps preview={preview} canPlan={canPlan} disabled={!ready || busy || running} onUndo={(u) => void undo(u)} inline /> : null}
    </div>
  );
}

function hasFollowUps(p: CarryPreview): boolean {
  return !!(p.noOutcome?.length || p.lateShortfalls?.length || p.undoable?.length);
}

/**
 * The information below the list (delivery outcome, spec sections 9.1 items 7 and 11, 9.4): copies on
 * this day that are not planned yet (Undo), shortfalls recorded after an order was brought forward,
 * and stops of loads that are back with no result recorded (counted as delivered). Never selectable.
 */
function CarryFollowUps({ preview, canPlan, disabled, onUndo, inline = false }: { preview: CarryPreview; canPlan: boolean; disabled: boolean; onUndo: (u: UndoableCarry) => void; inline?: boolean }) {
  const groups = noOutcomeGroups(preview.noOutcome ?? []);
  return (
    <div className={`space-y-2 text-xs ${inline ? '' : 'rounded-md border p-3'}`} data-testid="carry-follow-ups">
      {preview.undoable?.length ? (
        <div data-testid="carry-undoable">
          <p className="font-medium">Brought forward to {fmtDayMonth(preview.date)}, not planned yet:</p>
          <ul className="space-y-0.5">
            {preview.undoable.map((u) => (
              <li key={u.copyId}>
                {u.customerName} <span className="text-muted-foreground">{u.customerCode}{u.branchCode ? ` / ${u.branchCode}` : ''} · {u.cases} cases · from {fmtDayMonth(u.fromDate)}</span>{' '}
                {canPlan ? (
                  <button type="button" className="text-primary underline-offset-2 hover:underline disabled:opacity-50" disabled={disabled} onClick={() => onUndo(u)} data-testid={`carry-undo-${u.customerCode}`}>
                    <Undo2 className="mr-0.5 inline h-3 w-3" />
                    Undo
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.lateShortfalls?.length ? (
        <div className="text-red-800" data-testid="carry-late-shortfalls">
          {preview.lateShortfalls.map((s) => (
            <p key={s.orderId}>{s.text}</p>
          ))}
        </div>
      ) : null}
      {groups.length ? (
        <details data-testid="carry-no-outcome">
          <summary className="cursor-pointer">
            Dispatched, no result recorded (counted as delivered): {groups.map((g) => `${g.truckCode}${g.date !== preview.today ? ` ${fmtDayMonth(g.date)}` : ''}: ${g.stops.length} stop${g.stops.length === 1 ? '' : 's'}`).join(' · ')}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {groups.flatMap((g) =>
              g.stops.map((s) => (
                <li key={`${s.date}-${s.truckCode}-${s.loadNo}-${s.sequence}`}>
                  {s.truckCode} L{s.loadNo} stop {s.sequence}, {s.customerName} ({s.customerCode}{s.branchCode ? `/${s.branchCode}` : ''}), {s.cases} cases ({fmtDayMonth(s.date)})
                </li>
              )),
            )}
          </ul>
          <p className="mt-1 text-muted-foreground">Record their results on the plan of that day (Record), or leave them: they count as delivered.</p>
        </details>
      ) : null}
    </div>
  );
}
