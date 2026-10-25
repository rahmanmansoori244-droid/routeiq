'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { defaultModeReason, searchChoices, type SearchMode } from '@/lib/dispatch/search-mode';
import { KEPT_DIALOG_LEAD, type KeptLoadRef, type KeptQuestion } from '@/lib/dispatch/kept-changes';
import { ALLOWANCES_DROPPED_TEXT } from '@/lib/dispatch/plan-edit-view';

/** What the OPTIMIZE / RE-PLAN confirmation asks about. */
export interface SearchModeQuestion {
  /** The button that asked: "Optimize" or "Re-plan". */
  verb: 'Optimize' | 'Re-plan';
  /** The default for the plan's day (Thorough before the delivery day, Quick on it). */
  defaultMode: SearchMode;
  /** Stops (customers) of the day, for Quick's estimate; null when unknown. */
  stops: number | null;
  /** Thorough's cap in seconds (the server's THOROUGH_MAX_SEC). */
  capSec: number;
  /**
   * The plan is for today (company timezone): the Thorough choice says the plan cannot be used
   * before its search ends, so its new loads are timed from then.
   */
  deliveryDay?: boolean;
  /** A line above the choice (e.g. what a re-plan keeps). */
  note?: string;
  /**
   * A re-plan: the locked and loading loads planned with older customer data (kept-changes.ts keptQuestion),
   * listed with one "Unlock ... first" choice per load, unticked (a locked load may be on its truck already).
   */
  kept?: KeptQuestion;
  /**
   * Moves by hand, allow anyway: the rules allowed by hand on PLANNED loads (allowancesOnPlannedText). A re-plan
   * plans those loads again with every rule, so it drops them; the dialog lists them (lock a load to keep it).
   */
  allowances?: string[];
}

/** The dialog's answer: the mode, and the unlock chains of the ticked loads (empty: none). */
export interface SearchModeAnswer {
  mode: SearchMode;
  unlock: KeptLoadRef[][];
}

interface Pending extends SearchModeQuestion {
  resolve: (answer: SearchModeAnswer | null) => void;
}

/**
 * The Quick / Thorough choice before an optimization starts (owner decision 29 Sep 2026). `ask`
 * resolves with the mode, or null when the dispatcher cancels; `askFull` also with the kept loads ticked
 * to unlock first; render `dialog` once.
 */
export function useSearchModeChoice(): {
  ask: (q: SearchModeQuestion) => Promise<SearchMode | null>;
  askFull: (q: SearchModeQuestion) => Promise<SearchModeAnswer | null>;
  dialog: JSX.Element | null;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const askFull = useCallback((q: SearchModeQuestion) => new Promise<SearchModeAnswer | null>((resolve) => setPending({ ...q, resolve })), []);
  const ask = useCallback((q: SearchModeQuestion) => askFull(q).then((a) => a?.mode ?? null), [askFull]);
  const done = useCallback(
    (answer: SearchModeAnswer | null) => {
      setPending((p) => {
        p?.resolve(answer);
        return null;
      });
    },
    [],
  );
  return { ask, askFull, dialog: pending ? <SearchModeDialog question={pending} onDone={done} /> : null };
}

/** The dialog itself (exported for its spec: the kept-load choices start unticked). */
export function SearchModeDialog({ question, onDone }: { question: SearchModeQuestion; onDone: (answer: SearchModeAnswer | null) => void }) {
  const [mode, setMode] = useState<SearchMode>(question.defaultMode);
  // Every unlock choice starts unticked (owner decision: NMWC loads trucks the night before).
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const kept = question.kept;
  const toggle = (id: string) =>
    setTicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const unlock = (kept?.offers ?? []).filter((o) => !o.blocked && ticked.has(o.id)).map((o) => o.loads);
  const choices = searchChoices(question.defaultMode, question.stops, question.capSec, !!question.deliveryDay);
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onDone(null))}>
      <DialogContent data-testid="search-mode-dialog">
        <DialogHeader>
          <DialogTitle>{question.verb}: how long should the optimizer search?</DialogTitle>
          <DialogDescription>
            {question.note ? `${question.note} ` : ''}
            {defaultModeReason(question.defaultMode)}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2" role="radiogroup" aria-label="Search time">
          {choices.map((c) => (
            <label
              key={c.mode}
              className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm ${mode === c.mode ? 'border-primary bg-primary/5' : ''}`}
              data-testid={`search-mode-${c.mode.toLowerCase()}`}
            >
              <input type="radio" name="search-mode" className="mt-1" checked={mode === c.mode} onChange={() => setMode(c.mode)} />
              <span>
                <b>{c.label}</b>
                {c.recommended ? <span className="ml-1 text-xs text-muted-foreground">(suggested)</span> : null}
                <span className="block text-muted-foreground">{c.detail}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            The plan is the best one found in that time. No search can promise the best possible plan, so RouteIQ says how long it searched and why it
            stopped.
          </p>
        </div>
        {question.allowances?.length ? (
          <div className="space-y-1 rounded-md border border-violet-300 bg-violet-50 p-2 text-sm" data-testid="allowances-in-dialog">
            <p className="font-medium text-violet-900">{ALLOWANCES_DROPPED_TEXT}</p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              {question.allowances.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {kept ? (
          <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="kept-in-dialog">
            <p className="font-medium text-amber-900">Locked loads planned with older customer data</p>
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              {kept.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
              {kept.more ? <li>and {kept.more} more on the plan screen</li> : null}
            </ul>
            <p className="text-xs text-muted-foreground">{KEPT_DIALOG_LEAD}</p>
            {kept.offers.map((o) =>
              o.blocked ? (
                <p key={o.id} className="text-xs text-amber-800" data-testid={`kept-offer-blocked-${o.id}`}>
                  {o.blocked}
                </p>
              ) : (
                <label key={o.id} className="flex cursor-pointer items-start gap-2 text-xs" data-testid={`kept-offer-${o.id}`}>
                  <input type="checkbox" className="mt-0.5" checked={ticked.has(o.id)} onChange={() => toggle(o.id)} />
                  <span>{o.label}</span>
                </label>
              ),
            )}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button onClick={() => onDone({ mode, unlock })} data-testid="search-mode-start">
            {question.verb} ({mode === 'THOROUGH' ? 'Thorough' : 'Quick'})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
