'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { acknowledgeAlerts, sendAlertReview, sendAlertReviewRemove, type ReviewAnswer, type ReviewDraft } from '@/components/alerts-api';
import { fmtDayMonth } from '@/lib/dispatch/time';
import {
  ALERT_REVIEW_NOTE_MAX,
  ALERT_REVIEW_OTHER_MAX,
  charCount,
  forcesFollowUp,
  normaliseReview,
  reviewFitsRule,
  reviewOptions,
} from '@/lib/alerts/review';
import type { AlertReviewView, OpsAlertRow } from '@/lib/alerts/types';
import { alertReviewFlags, alertStateText, alertText, alertWhen, alertTime, alertWhere, reviewActionText, reviewCauseText, ruleLabel } from '@/lib/alerts/view';

const EMPTY: ReviewDraft = { cause: '', causeOther: '', action: '', actionOther: '', note: '', followUp: false };

function draftOf(v: AlertReviewView | null): ReviewDraft {
  if (!v) return EMPTY;
  return { cause: v.cause, causeOther: v.causeOther ?? '', action: v.action, actionOther: v.actionOther ?? '', note: v.note ?? '', followUp: v.followUp };
}

const SKIP_WORDS: Record<string, string> = {
  ALREADY_SAVED: 'someone saved one meanwhile',
  NOT_FOR_RULE: 'the cause or action is not offered for its rule',
  OTHER_TRUCK_OR_DAY: 'another truck or day',
  DETAILS_REMOVED: 'older than 90 days',
  NOT_FOUND: 'no longer exists',
};

/** The other alerts the dialog offers to fill too: the same truck and day, none of their own, not read-only. */
export function incidentAlerts(target: OpsAlertRow, rows: readonly OpsAlertRow[]): OpsAlertRow[] {
  return rows.filter((r) => r.id !== target.id && !r.review && !r.detailsRemoved && r.truckId === target.truckId && r.deliveryDate === target.deliveryDate);
}

/**
 * "Cause & action" of an operations alert (owner request 20 Oct 2026: "a place where a note / reason for the
 * alert to have happened and the solution ... entered by someone after checking and finding a solution"; lib/alerts/review.ts).
 * The dispatcher and up record, after checking, the main cause and the action taken or decided (pick-lists that
 * depend on the alert's rule, both starting empty so no default skews the counts; Other takes a short text), an
 * optional note and "needs follow-up". It works on an alert of any state and day.
 *
 * `target` is a snapshot the parent took when it opened the dialog, so the 60 s poll never resets a half-typed
 * note. The save names the last save the editor saw: when someone saved meanwhile, the dialog keeps the draft,
 * says what was saved and saves over it on the next Save. "Also for": the other alerts of the same truck and day
 * without a cause & action (one breakdown raises several: critique item 1), unticked by default. "Acknowledge it
 * too" (an open alert only) acknowledges at the tier the dialog showed (a row that got worse meanwhile stays
 * open). Remove: for a cause & action saved on the wrong alert.
 */
export function AlertReviewDialog({
  target,
  related,
  timezone,
  today,
  canAck,
  onClose,
  onSaved,
}: {
  target: OpsAlertRow | null;
  /** The rows the screen shows: the dialog offers those of the same truck and day without a cause & action. */
  related: readonly OpsAlertRow[];
  timezone: string;
  today?: string;
  canAck: boolean;
  onClose: () => void;
  /** After a save or a removal (the parent reads the alerts again). */
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ReviewDraft>(EMPTY);
  const [current, setCurrent] = useState<AlertReviewView | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [ack, setAck] = useState(true);
  const [also, setAlso] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef(0);

  useEffect(() => {
    shown.current++;
    setBusy(false);
    setNotice(null);
    setAlso([]);
    setAck(true);
    setCurrent(target?.review ?? null);
    setBase(target?.review?.savedAt ?? null);
    setDraft(draftOf(target?.review ?? null));
  }, [target]);

  if (!target) return null;
  const when = (iso: string) => (today ? alertWhen(iso, target.deliveryDate, timezone, today) : alertTime(iso, timezone));
  const options = reviewOptions(target.rule, current);
  const checked = normaliseReview(target.rule, draft, current);
  const problem = checked.ok ? null : checked.message;
  const forced = forcesFollowUp(draft);
  const others = incidentAlerts(target, related);
  const fits = (r: OpsAlertRow) => (checked.ok ? reviewFitsRule(r.rule, checked.value) : true);
  const alsoIds = also.filter((id) => others.some((o) => o.id === id && fits(o)));
  const flags = current ? alertReviewFlags({ ...target, review: current }) : [];
  const set = (patch: Partial<ReviewDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const readOnly = target.detailsRemoved;

  async function answer(r: ReviewAnswer, started: number, removed: boolean) {
    if (started !== shown.current || !target) return;
    setBusy(false);
    if (r.kind === 'saved') {
      const n = r.also.length;
      if (removed) toast.success('Cause & action removed.');
      else toast.success(r.changed || n ? `Cause & action saved${n ? ` (also on ${n} other alert${n === 1 ? '' : 's'})` : ''}.` : 'Nothing changed.');
      if (r.skipped.length) {
        const why = [...new Set(r.skipped.map((s) => SKIP_WORDS[s.reason] ?? s.reason))].join('; ');
        toast.warning(`${r.skipped.length} other alert${r.skipped.length === 1 ? ' was' : 's were'} left as ${r.skipped.length === 1 ? 'it was' : 'they were'} (${why}).`);
      }
      // At the tier the dialog showed: a row that got worse meanwhile stays open (inbox.ts ackAlerts).
      if (!removed && ack && canAck && target.state === 'OPEN' && r.row.state === 'OPEN') await acknowledgeAlerts([{ ...r.row, tier: target.tier }]);
      onClose();
      onSaved();
      return;
    }
    if (r.kind === 'changed') {
      const v = r.row.review;
      setCurrent(v);
      setBase(v?.savedAt ?? null);
      setNotice(
        v
          ? `Saved meanwhile by ${v.byName ?? 'someone'} ${when(v.savedAt)}: cause "${reviewCauseText(v)}", action "${reviewActionText(v)}". Saving again replaces it.`
          : 'The cause & action was removed meanwhile. Saving records yours.',
      );
      return;
    }
    if (r.kind === 'busy') {
      toast.warning(r.message);
      return;
    }
    if (r.kind === 'gone') {
      toast.error('This alert no longer exists.');
      onClose();
      onSaved();
      return;
    }
    toast.error(r.message);
    if (r.kind === 'locked') onClose();
  }

  async function save() {
    if (!target || busy || problem || readOnly) return;
    const started = shown.current;
    setBusy(true);
    await answer(await sendAlertReview(target.id, base, { ...draft, followUp: draft.followUp || forced }, alsoIds), started, false);
  }

  async function remove() {
    if (!target || busy || !base || readOnly) return;
    if (typeof window !== 'undefined' && !window.confirm('Remove the cause & action of this alert?')) return;
    const started = shown.current;
    setBusy(true);
    await answer(await sendAlertReviewRemove(target.id, base), started, true);
  }

  const toggleAlso = (id: string, on: boolean) => setAlso((list) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id)));
  const fitting = others.filter(fits);

  return (
    <Dialog open onOpenChange={(v) => (v ? undefined : onClose())}>
      <DialogContent className="max-w-lg" data-testid="alert-review-dialog">
        <DialogHeader>
          <DialogTitle>Cause &amp; action</DialogTitle>
          <DialogDescription>
            {alertWhere(target)} · {ruleLabel(target.rule)} · {fmtDayMonth(target.deliveryDate)}. What you found after checking, and what was decided: saved with your name for everyone to see.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="rounded-md bg-muted/50 p-2 text-xs" data-testid="alert-review-alert">
            {alertText(target)}{' '}
            <span className="text-muted-foreground">
              ({alertStateText(target, timezone, today)}
              {target.occurrences > 1 ? `, came back ${target.occurrences - 1}×` : ''})
            </span>
          </p>
          {current ? (
            <p className="text-xs text-muted-foreground" data-testid="alert-review-last">
              Last saved by {current.byName ?? 'a user no longer in RouteIQ'} {when(current.savedAt)}
              {current.saves > 1 ? ` (first by ${current.firstByName ?? 'a user no longer in RouteIQ'} ${when(current.firstAt)}; ${current.saves} saves)` : ''}.
            </p>
          ) : null}
          {flags.length ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" data-testid="alert-review-flags">
              This alert {flags.join(', ')}: check the cause &amp; action still fits.
            </p>
          ) : null}
          {notice ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" role="status" data-testid="alert-review-notice">
              {notice}
            </p>
          ) : null}
          {readOnly ? (
            <p className="text-xs text-muted-foreground" data-testid="alert-review-readonly">
              This alert is older than 90 days: its details were removed and its cause &amp; action can no longer be changed.
            </p>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="ar-cause">Main cause</Label>
            <select
              id="ar-cause"
              className="h-9 w-full rounded-md border bg-background px-2"
              value={draft.cause}
              disabled={readOnly}
              onChange={(e) => set({ cause: e.target.value })}
              data-testid="alert-review-cause"
            >
              <option value="">Pick a cause…</option>
              {options.causes.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
            {draft.cause === 'OTHER' ? (
              <Input
                aria-label="The other cause"
                placeholder="Write the cause (3 characters or more)"
                maxLength={ALERT_REVIEW_OTHER_MAX}
                value={draft.causeOther}
                disabled={readOnly}
                onChange={(e) => set({ causeOther: e.target.value })}
                data-testid="alert-review-cause-other"
              />
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="ar-action">Action taken or decided</Label>
            <select
              id="ar-action"
              className="h-9 w-full rounded-md border bg-background px-2"
              value={draft.action}
              disabled={readOnly}
              onChange={(e) => set({ action: e.target.value })}
              data-testid="alert-review-action"
            >
              <option value="">Pick an action…</option>
              {options.actions.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
            {draft.action === 'OTHER' ? (
              <Input
                aria-label="The other action"
                placeholder="Write the action (3 characters or more)"
                maxLength={ALERT_REVIEW_OTHER_MAX}
                value={draft.actionOther}
                disabled={readOnly}
                onChange={(e) => set({ actionOther: e.target.value })}
                data-testid="alert-review-action-other"
              />
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="ar-note">Note (optional)</Label>
            <Textarea
              id="ar-note"
              rows={3}
              maxLength={ALERT_REVIEW_NOTE_MAX}
              placeholder="What you found and what was decided. No phone numbers: any number of 6 digits or more (dates and times written with digits too) is removed."
              value={draft.note}
              disabled={readOnly}
              onChange={(e) => set({ note: e.target.value })}
              data-testid="alert-review-note"
            />
            <p className="text-right text-xs text-muted-foreground">
              {charCount(draft.note)}/{ALERT_REVIEW_NOTE_MAX}
            </p>
          </div>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={draft.followUp || forced}
              disabled={forced || readOnly}
              onCheckedChange={(v) => set({ followUp: v === true })}
              data-testid="alert-review-followup"
            />
            <span>Needs follow-up{forced ? ' (always with "Nothing yet" or "Not found yet")' : ''}</span>
          </label>
          {canAck && target.state === 'OPEN' && !readOnly ? (
            <label className="flex items-center gap-2">
              <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} data-testid="alert-review-ack" />
              <span>Acknowledge it too</span>
            </label>
          ) : null}
          {others.length && !readOnly ? (
            <div className="space-y-1 rounded-md border p-2" data-testid="alert-review-also">
              <p className="text-xs font-medium">
                Also for the other alerts of {target.truckCode} on {fmtDayMonth(target.deliveryDate)} without a cause &amp; action (the same incident):
              </p>
              {others.map((o) => (
                <label key={o.id} className="flex items-start gap-2 text-xs">
                  <Checkbox
                    checked={also.includes(o.id) && fits(o)}
                    disabled={!fits(o)}
                    onCheckedChange={(v) => toggleAlso(o.id, v === true)}
                    data-testid="alert-review-also-item"
                    data-id={o.id}
                  />
                  <span>
                    {alertWhere(o)}: {ruleLabel(o.rule)}
                    {fits(o) ? '' : ' (this cause or action is not offered for it)'}
                  </span>
                </label>
              ))}
              {fitting.length > 1 ? (
                <button type="button" className="text-xs text-primary underline" onClick={() => setAlso(fitting.map((o) => o.id))} data-testid="alert-review-also-all">
                  Tick all {fitting.length}
                </button>
              ) : null}
            </div>
          ) : null}
          <p className="min-h-[1rem] text-xs text-destructive" aria-live="polite" data-testid="alert-review-problem">
            {readOnly ? '' : (problem ?? '')}
          </p>
        </div>
        <DialogFooter className="gap-2">
          {current && !readOnly ? (
            <Button variant="outline" className="text-destructive" disabled={busy} onClick={() => void remove()} data-testid="alert-review-remove">
              Remove
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {readOnly ? null : (
            <Button disabled={busy || !!problem} onClick={() => void save()} data-testid="alert-review-save">
              {busy ? 'Saving…' : 'Save'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
