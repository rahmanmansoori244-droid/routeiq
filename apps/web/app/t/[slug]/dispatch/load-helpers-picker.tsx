'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { DetailLoad } from '@/lib/dispatch/plan-detail';
import { helpersText, MAX_HELPERS } from '@/lib/dispatch/load-helpers';

export interface HelperOption {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

/**
 * The Helper(s) cell of a load on the plan screen (owner request 13 Oct 2026): the helpers' names, and
 * for the dispatcher an Edit link that opens a multi-select of the active helpers (at most 3, in the
 * order ticked). Editable in the same states as the driver: until the load is dispatched.
 */
export function LoadHelpersCell({
  l,
  helpers,
  editable,
  busy,
  onSave,
}: {
  l: DetailLoad;
  helpers: HelperOption[];
  editable: boolean;
  busy: boolean;
  onSave: (helperIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const tag = `${l.truckCode}-${l.loadNo}`;
  const names = helpersText((l.helpers ?? []).map((h) => h.name));
  return (
    <div className="space-y-0.5 text-xs" data-testid={`load-helpers-${tag}`}>
      <p className={names ? '' : 'text-muted-foreground'} title={l.helpersHandSet ? 'Picked by hand: a re-plan keeps these helpers on this truck and trip.' : undefined}>
        {names ?? 'No helper'}
      </p>
      {l.helpersHandSet ? <p className="text-muted-foreground">picked by hand</p> : null}
      {editable ? (
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
          onClick={() => setOpen(true)}
          data-testid={`load-helpers-edit-${tag}`}
        >
          {names ? 'Change' : 'Add helper'}
        </button>
      ) : null}
      <HelpersDialog
        open={open}
        onOpenChange={setOpen}
        load={l}
        helpers={helpers}
        onSave={(ids) => {
          setOpen(false);
          onSave(ids);
        }}
      />
    </div>
  );
}

function HelpersDialog({
  open,
  onOpenChange,
  load,
  helpers,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  load: DetailLoad;
  helpers: HelperOption[];
  onSave: (helperIds: string[]) => void;
}) {
  const current = (load.helpers ?? []).map((h) => h.id);
  const [picked, setPicked] = useState<string[]>(current);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) {
      setPicked((load.helpers ?? []).map((h) => h.id));
      setQuery('');
    }
  }, [open, load]);
  // Active helpers, plus the ones on the load if they were deactivated since (they may stay).
  const options = [
    ...helpers.filter((h) => h.active || current.includes(h.id)),
    ...(load.helpers ?? []).filter((h) => !helpers.some((x) => x.id === h.id)).map((h) => ({ id: h.id, code: h.code, name: h.name, active: false })),
  ];
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((h) => h.name.toLowerCase().includes(q) || h.code.toLowerCase().includes(q)) : options;
  const full = picked.length >= MAX_HELPERS;
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? (p.includes(id) || p.length >= MAX_HELPERS ? p : [...p, id]) : p.filter((x) => x !== id)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Helpers · {load.truckCode} · L{load.loadNo}
          </DialogTitle>
          <DialogDescription>Tick up to {MAX_HELPERS} helpers who go out on this load. A re-plan keeps your choice on this truck and trip.</DialogDescription>
        </DialogHeader>
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active helpers. Add them on the Helpers page first.</p>
        ) : (
          <div className="space-y-2">
            {options.length > 8 ? (
              <input
                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                placeholder="Search helpers"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search helpers"
              />
            ) : null}
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {shown.map((h) => {
                const on = picked.includes(h.id);
                return (
                  <li key={h.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`helper-${h.id}`}
                      checked={on}
                      disabled={!on && full}
                      onCheckedChange={(v) => toggle(h.id, v === true)}
                      data-testid={`helper-option-${h.code || h.id}`}
                    />
                    <label htmlFor={`helper-${h.id}`} className={!on && full ? 'text-muted-foreground' : ''}>
                      {h.name}
                      {h.code ? <span className="ml-1 font-mono text-xs text-muted-foreground">{h.code}</span> : null}
                      {h.active ? null : <span className="ml-1 text-xs text-muted-foreground">(inactive)</span>}
                      {on ? <span className="ml-1 text-xs text-muted-foreground">#{picked.indexOf(h.id) + 1}</span> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
            {full ? <p className="text-xs text-muted-foreground">At most {MAX_HELPERS} helpers on a load.</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {picked.length ? (
            <Button type="button" variant="outline" onClick={() => setPicked([])}>
              Clear
            </Button>
          ) : null}
          <Button type="button" onClick={() => onSave(picked)} data-testid="load-helpers-save">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
