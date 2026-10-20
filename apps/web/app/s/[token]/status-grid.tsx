'use client';

import type { SalesStatus } from '@/lib/sales-link/view-types';
import { STATUS_BUTTON, statusLabel, type StatusButton } from '@/lib/sales-page/format';
import { st, type SalesLang } from '@/lib/sales-page/i18n';

/**
 * The status buttons at the top of a route (owner feedback of 20 Oct 2026: "first a list - delivered, on the way,
 * delayed, not delivered, cancelled, partly delivered - and when he clicks on one he sees those"): "All" with every
 * customer, then one big button per status with its count. One is selected at a time; a second tap on it shows all
 * again. A status with none is shown with 0 (not hidden), and cannot be picked.
 */
export function StatusGrid({
  lang,
  buttons,
  total,
  active,
  onPick,
}: {
  lang: SalesLang;
  buttons: readonly StatusButton[];
  total: number;
  active: SalesStatus | null;
  onPick: (status: SalesStatus | null) => void;
}) {
  return (
    <div className="space-y-2" data-testid="status-grid">
      <button
        type="button"
        onClick={() => onPick(null)}
        aria-pressed={active === null}
        className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-lg bg-white px-4 ${active === null ? 'ring-2 ring-slate-900' : 'ring-1 ring-slate-300'}`}
        data-testid="status-all"
      >
        <span className="text-base font-semibold">{st(lang, 'all')}</span>
        <span className="text-xl font-bold">{total}</span>
      </button>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label={st(lang, 'all')}>
        {buttons.map((b) => {
          const on = active === b.status;
          return (
            <button
              key={b.status}
              type="button"
              onClick={() => onPick(on ? null : b.status)}
              aria-pressed={on}
              disabled={b.n === 0 && !on}
              className={`flex min-h-16 flex-col items-start justify-center rounded-lg px-3 py-2 text-start ${STATUS_BUTTON[b.status]} ${on ? 'ring-2 ring-slate-900' : 'ring-1 ring-slate-200'} disabled:opacity-50`}
              data-testid={`status-${b.status}`}
            >
              <span className="text-2xl font-bold leading-none">{b.n}</span>
              <span className="mt-1 text-sm font-semibold leading-tight">{statusLabel(lang, b.status)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
