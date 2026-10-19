'use client';

import type { SummaryChip, SummaryKey } from '@/lib/sales-page/format';

/** The count chips at the top of a route; a tap shows only those deliveries (a second tap shows all again). */
export function SummaryBar({ chips, active, onPick }: { chips: SummaryChip[]; active: SummaryKey | null; onPick: (key: SummaryKey | null) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-testid="summary" role="group" aria-label="Counts">
      {chips.map((c) => {
        const on = active === c.key;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onPick(on ? null : c.key)}
            aria-pressed={on}
            disabled={c.n === 0 && !on}
            className={`flex min-h-14 flex-col items-center justify-center rounded-lg px-1 py-1 text-center ring-1 ${c.tone} ${on ? 'ring-2 ring-slate-900' : ''} disabled:opacity-60`}
            data-testid={`summary-${c.key}`}
          >
            <span className="text-xl font-bold leading-none">{c.n}</span>
            <span className="mt-1 text-xs font-medium leading-tight">{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}
