'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NOT_DELIVERED_REASONS } from '@/lib/driver-link/manifest-types';
import { officeTimesToSend, reasonLabel } from '@/lib/delivery/office-text';
import { fmtDayMonth } from '@/lib/dispatch/time';
import type { VisitLine } from '@/lib/delivery/visit';
import { api } from './client-api';

/** The stop the dialog records for, with its planned lines and the current result (if any). */
export interface OutcomeTarget {
  depotId: string;
  /** YYYY-MM-DD */
  date: string;
  truckId: string;
  truckCode: string;
  loadNo: number;
  sequence: number;
  customerName: string;
  customerCode: string;
  lines: VisitLine[];
  current: { outcome: string | null; reason: string | null; note: string | null } | null;
  /** The stored Arrived / Left (HH:MM, officeTimesPrefill): shown in the boxes, sent only when changed. */
  times?: { arrived: string; left: string };
}

type Choice = 'DELIVERED' | 'PARTLY_DELIVERED' | 'NOT_DELIVERED';

/** A lowercase UUID for the request's key (a double click records once). */
function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID().toLowerCase();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * "Record outcome" (owner request 4 Oct 2026, spec section 10.2): the dispatcher records or corrects
 * a stop's delivery result - a driver without a phone, a forgotten stop, a wrong tap. Result, reason
 * and note; cases delivered per order line (Partly); optional Arrived and Left times (HH:MM, recorded
 * as the office); "Clear result". Stored with the dispatcher's name and audited with before and after.
 * When the cases were already brought forward the answer says so; while that copy is not planned the
 * dialog offers "Undo the bring forward and record this result".
 */
export function OutcomeDialog({ open, onOpenChange, target, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; target: OutcomeTarget | null; onSaved: () => void }) {
  const [choice, setChoice] = useState<Choice>('DELIVERED');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [delivered, setDelivered] = useState<Record<string, string>>({});
  const [arrived, setArrived] = useState('');
  const [left, setLeft] = useState('');
  const [busy, setBusy] = useState(false);
  const [carried, setCarried] = useState<{ text: string; undoable: boolean } | null>(null);
  const shown = useRef(0);

  useEffect(() => {
    shown.current++;
    setBusy(false);
    setCarried(null);
    if (!open || !target) return;
    const cur = target.current;
    setChoice(cur?.outcome === 'PARTLY_DELIVERED' || cur?.outcome === 'NOT_DELIVERED' ? cur.outcome : 'DELIVERED');
    setReason(cur?.reason ?? '');
    setNote(cur?.note ?? '');
    setDelivered(Object.fromEntries(target.lines.map((l) => [l.lineId, String(l.deliveredCases ?? l.plannedCases)])));
    setArrived(target.times?.arrived ?? '');
    setLeft(target.times?.left ?? '');
  }, [open, target]);

  async function send(outcome: Choice | null, undoCarry = false) {
    if (!target || busy) return;
    const lines =
      outcome === 'PARTLY_DELIVERED'
        ? target.lines.map((l) => ({ lineId: l.lineId, delivered: Number(delivered[l.lineId] ?? l.plannedCases) }))
        : null;
    if (lines && lines.some((l) => !Number.isInteger(l.delivered) || l.delivered < 0)) {
      toast.error('Cases delivered must be whole numbers.');
      return;
    }
    const started = shown.current;
    setBusy(true);
    const r = await api<{ result: string; loadCompleted?: boolean; carryUndone?: { copyDate: string }; carriesUndone?: { copyDate: string }[] }>('/api/dispatch/outcomes', {
      method: 'POST',
      json: {
        key: newKey(),
        depotId: target.depotId,
        date: target.date,
        truckId: target.truckId,
        loadNo: target.loadNo,
        sequence: target.sequence,
        outcome,
        reason: outcome && outcome !== 'DELIVERED' ? reason || null : null,
        note: note.trim() || null,
        lines,
        // Only a changed box: re-sending the phone's stored times would turn them into office times.
        ...officeTimesToSend({ arrived, left }, target.times ?? { arrived: '', left: '' }),
        ...(undoCarry ? { undoCarry: true } : {}),
      },
    });
    if (started !== shown.current) return;
    setBusy(false);
    if (!r.ok) {
      if (r.errorBody?.code === 'OUTCOME_CARRIED') {
        setCarried({ text: r.error ?? 'These cases were brought forward.', undoable: r.errorBody.undoable === true });
        return;
      }
      toast.error(r.error ?? 'Could not save the result.');
      return;
    }
    // Every copy removed (several orders of the stop may have been brought forward).
    const undoneDays = [...new Set((r.data?.carriesUndone ?? (r.data?.carryUndone ? [r.data.carryUndone] : [])).map((u) => fmtDayMonth(u.copyDate)))];
    toast.success(
      `${target.truckCode} L${target.loadNo} stop ${target.sequence}: ${outcome ? 'result recorded' : 'result cleared'}${undoneDays.length ? ` (the bring forward to ${undoneDays.join(' and ')} was undone)` : ''}${r.data?.loadCompleted ? ' · the load is completed' : ''}.`,
    );
    onOpenChange(false);
    onSaved();
  }

  if (!target) return null;
  const needsReason = choice !== 'DELIVERED';
  const otherNeedsNote = needsReason && reason === 'OTHER' && note.trim().length < 3;
  const canSave = !busy && (!needsReason || !!reason) && !otherNeedsNote;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="outcome-dialog">
        <DialogHeader>
          <DialogTitle>Record outcome</DialogTitle>
          <DialogDescription>
            {target.truckCode} L{target.loadNo} stop {target.sequence} · {target.customerName} ({target.customerCode}) · {fmtDayMonth(target.date)}. Recorded as the office, with your name.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Result">
            {(['DELIVERED', 'PARTLY_DELIVERED', 'NOT_DELIVERED'] as const).map((c) => (
              <label key={c} className="flex items-center gap-1">
                <input type="radio" name="outcome" checked={choice === c} onChange={() => setChoice(c)} data-testid={`outcome-${c}`} />
                {c === 'DELIVERED' ? 'Delivered (all)' : c === 'PARTLY_DELIVERED' ? 'Partly delivered' : 'Not delivered'}
              </label>
            ))}
          </div>
          {needsReason ? (
            <div className="space-y-1">
              <Label htmlFor="od-reason">{choice === 'PARTLY_DELIVERED' ? 'Why were cases not delivered?' : 'Reason'}</Label>
              <select id="od-reason" className="h-9 w-full rounded-md border bg-background px-2" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="outcome-reason">
                <option value="">— choose —</option>
                {NOT_DELIVERED_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {reasonLabel(r)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="od-note">Note{needsReason && reason === 'OTHER' ? ' (required for Other)' : ' (optional)'}</Label>
            <Input id="od-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} data-testid="outcome-note" />
          </div>
          {choice === 'PARTLY_DELIVERED' ? (
            <div className="space-y-1">
              <p className="font-medium">Cases delivered per line</p>
              <table className="w-full text-xs">
                <tbody>
                  {target.lines.map((l) => (
                    <tr key={l.lineId} className="border-b">
                      <td className="py-1 font-mono">{l.productCode}</td>
                      <td className="py-1 text-muted-foreground">of {l.plannedCases}</td>
                      <td className="py-1">
                        <Input
                          className="h-7 w-20"
                          inputMode="numeric"
                          aria-label={`Cases delivered of ${l.productCode}`}
                          value={delivered[l.lineId] ?? ''}
                          onChange={(e) => setDelivered((d) => ({ ...d, [l.lineId]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="od-arr">Arrived (HH:MM, optional)</Label>
              <Input id="od-arr" placeholder="10:05" value={arrived} onChange={(e) => setArrived(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="od-left">Left (HH:MM, optional)</Label>
              <Input id="od-left" placeholder="10:30" value={left} onChange={(e) => setLeft(e.target.value)} />
            </div>
          </div>
          {carried ? (
            <div className="space-y-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-900" data-testid="outcome-carried">
              <p>{carried.text}</p>
              {carried.undoable ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void send(choice, true)} data-testid="outcome-undo-carry">
                  Undo the bring forward and record this result
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          {target.current?.outcome ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Clear the result of this stop? It then counts as delivered with no result recorded.')) void send(null);
              }}
              data-testid="outcome-clear"
            >
              Clear result
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void send(choice)} disabled={!canSave} data-testid="outcome-save">
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
