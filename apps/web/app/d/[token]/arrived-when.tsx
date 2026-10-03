'use client';

import { Clock } from 'lucide-react';
import { t, type Lang } from '@/lib/driver-page/i18n';

/**
 * "Arrived at ACME - when?" (spec section 6.3): shown when the page came back at a stop whose arrival
 * it did not see (the driver was in Maps or the screen was locked). A chip records a manual arrival
 * at that time; Skip keeps the time the page found (an upper bound, never used for measured times).
 */
export function ArrivedWhen({ lang, customer, onAnswer }: { lang: Lang; customer: string; onAnswer: (minutesAgo: number | null) => void }) {
  const chips: [number, string][] = [
    [0, t(lang, 'now')],
    [5, t(lang, 'minAgo', { n: 5 })],
    [10, t(lang, 'minAgo', { n: 10 })],
    [15, t(lang, 'minAgo', { n: 15 })],
  ];
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 rounded-t-2xl border-t bg-white p-4 shadow-2xl" role="dialog" aria-modal="true" data-testid="arrived-when">
      <p className="flex items-center gap-2 text-lg font-bold">
        <Clock className="h-6 w-6 shrink-0" aria-hidden />
        <span dir="auto">{t(lang, 'arrivedWhen', { customer })}</span>
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {chips.map(([n, label]) => (
          <button key={n} type="button" onClick={() => onAnswer(n)} className="min-h-14 rounded-xl bg-slate-900 text-lg font-semibold text-white">
            {label}
          </button>
        ))}
      </div>
      <button type="button" onClick={() => onAnswer(null)} className="mt-2 min-h-12 w-full rounded-xl border border-slate-400 font-semibold">
        {t(lang, 'skip')}
      </button>
    </div>
  );
}
