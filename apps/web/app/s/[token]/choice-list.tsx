'use client';

import { Truck } from 'lucide-react';
import type { SalesChoice } from '@/lib/sales-link/view-types';
import { UI } from '@/lib/sales-page/format';

/**
 * The trucks the server offers for a code typed (owner decision of 20 Oct 2026): several trucks have the digits
 * ("5678 matches 2 trucks today. Pick one:"), or a route code is also a truck's code ("C1 is also a truck code. Show
 * the truck instead:"). A tap sends the option's whole lookup ("Truck 1234-AB", or with the other codes shown).
 */
export function ChoiceList({ choices, working, onPick }: { choices: readonly SalesChoice[]; working: boolean; onPick: (query: string) => void }) {
  if (!choices.length) return null;
  return (
    <div className="space-y-3" data-testid="choices">
      {choices.map((c) => (
        <div key={`${c.kind}:${c.asked}`} className="space-y-2 rounded-md bg-sky-50 p-3 text-sm text-sky-950 ring-1 ring-sky-200" data-testid="choice" data-kind={c.kind}>
          <p>{c.text}</p>
          <div className="flex flex-wrap gap-2">
            {c.options.map((o) => (
              <button
                key={o.code}
                type="button"
                disabled={working}
                onClick={() => onPick(o.query)}
                className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-4 text-sm font-semibold text-slate-900 ring-1 ring-slate-300 disabled:opacity-60"
                data-testid="choice-option"
                data-query={o.query}
              >
                <Truck className="h-4 w-4" aria-hidden /> {UI.pickTruck(o.code)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
