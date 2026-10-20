'use client';

import type { SalesChoice } from '@/lib/sales-link/view-types';
import { choiceText, viewTitle } from '@/lib/sales-page/format';
import type { SalesLang } from '@/lib/sales-page/i18n';

/**
 * The trucks the server offers for a code typed (owner decision of 20 Oct 2026): several trucks have the digits or
 * the compact key ("5678: more than one truck has this code. Pick one:"), or a route code is also a truck's code. A
 * tap sends the option's whole lookup ("Truck 1234-AB", or with the other codes shown).
 */
export function ChoiceList({ lang, choices, working, onPick }: { lang: SalesLang; choices: readonly SalesChoice[]; working: boolean; onPick: (query: string) => void }) {
  if (!choices.length) return null;
  return (
    <div className="space-y-3" data-testid="choices">
      {choices.map((c) => (
        <div key={`${c.kind}:${c.asked}`} className="space-y-2 rounded-md bg-sky-50 p-3 text-sm text-sky-950 ring-1 ring-sky-200" data-testid="choice" data-kind={c.kind}>
          <p>{choiceText(lang, c)}</p>
          <div className="flex flex-wrap gap-2">
            {c.options.map((o) => (
              <button
                key={o.code}
                type="button"
                disabled={working}
                onClick={() => onPick(o.query)}
                className="inline-flex min-h-11 items-center rounded-full bg-white px-4 text-sm font-semibold text-slate-900 ring-1 ring-slate-300 disabled:opacity-60"
                data-testid="choice-option"
                data-query={o.query}
              >
                {viewTitle(lang, { kind: 'TRUCK', code: o.code })}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
