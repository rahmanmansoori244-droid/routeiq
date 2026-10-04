'use client';

import { Store } from 'lucide-react';
import { t, type Lang } from '@/lib/driver-page/i18n';

/**
 * "Which customer are you at?" (spec section 7.3): two or more stops of the trip are inside the
 * arrival radius together (two shops in one building, or two branches at one pin). Nothing is
 * recorded until the driver chooses; the chosen stop gets the time the truck first stood there.
 */
export function WhichCustomer({ lang, options, onChoose, onClose }: { lang: Lang; options: { key: string; label: string }[]; onChoose: (key: string) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 rounded-t-2xl border-t bg-white p-4 shadow-2xl" role="dialog" aria-modal="true" data-testid="which-customer">
      <p className="flex items-center gap-2 text-lg font-bold">
        <Store className="h-6 w-6 shrink-0" aria-hidden /> {t(lang, 'whichCustomer')}
      </p>
      <div className="mt-3 space-y-2">
        {options.map((o) => (
          <button key={o.key} type="button" onClick={() => onChoose(o.key)} className="min-h-14 w-full rounded-xl bg-slate-900 px-3 text-start text-lg font-semibold text-white" dir="auto">
            {o.label}
          </button>
        ))}
      </div>
      <button type="button" onClick={onClose} className="mt-2 min-h-12 w-full rounded-xl border border-slate-400 font-semibold">
        {t(lang, 'skip')}
      </button>
    </div>
  );
}
