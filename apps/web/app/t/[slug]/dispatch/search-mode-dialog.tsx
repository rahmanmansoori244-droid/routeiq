'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { defaultModeReason, searchChoices, type SearchMode } from '@/lib/dispatch/search-mode';

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
  /** A line above the choice (e.g. what a re-plan keeps). */
  note?: string;
}

interface Pending extends SearchModeQuestion {
  resolve: (mode: SearchMode | null) => void;
}

/**
 * The Quick / Thorough choice before an optimization starts (owner decision 29 Sep 2026). `ask`
 * resolves with the mode, or null when the dispatcher cancels; render `dialog` once.
 */
export function useSearchModeChoice(): { ask: (q: SearchModeQuestion) => Promise<SearchMode | null>; dialog: JSX.Element | null } {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback((q: SearchModeQuestion) => new Promise<SearchMode | null>((resolve) => setPending({ ...q, resolve })), []);
  const done = useCallback(
    (mode: SearchMode | null) => {
      setPending((p) => {
        p?.resolve(mode);
        return null;
      });
    },
    [],
  );
  return { ask, dialog: pending ? <SearchModeDialog question={pending} onDone={done} /> : null };
}

function SearchModeDialog({ question, onDone }: { question: SearchModeQuestion; onDone: (mode: SearchMode | null) => void }) {
  const [mode, setMode] = useState<SearchMode>(question.defaultMode);
  const choices = searchChoices(question.defaultMode, question.stops, question.capSec);
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button onClick={() => onDone(mode)} data-testid="search-mode-start">
            {question.verb} ({mode === 'THOROUGH' ? 'Thorough' : 'Quick'})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
