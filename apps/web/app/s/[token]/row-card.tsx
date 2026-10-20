'use client';

import { MessageCircle } from 'lucide-react';
import type { SalesRow } from '@/lib/sales-link/view-types';
import { customerText, rowLine, shareText, shareUrl, STATUS_CHIP, STATUS_EDGE, statusLabel } from '@/lib/sales-page/format';
import { st, type SalesLang } from '@/lib/sales-page/i18n';

/**
 * One customer (owner feedback of 20 Oct 2026: "don't write a lot of details for each customer"): the name (and
 * branch), one status word, and one line - delivered at, the cases of a partial delivery, or the approximate time
 * with how far it is ("about 16:30 · in about 1 h 20 min"). "Send to customer" opens WhatsApp with the same in the
 * page's language (no number, no link); an order not on a truck has none.
 */
export function RowCard({ lang, r, rowKey, future, date }: { lang: SalesLang; r: SalesRow; rowKey: string; future: boolean; date: string }) {
  const line = rowLine(lang, r);
  const share = shareText(lang, r, { future, date });
  return (
    <li className={`rounded-lg border-s-4 bg-white p-3 shadow-sm ring-1 ring-slate-200 ${STATUS_EDGE[r.status]}`} data-testid={`row-${rowKey}`} data-status={r.status}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-base font-semibold leading-snug" dir="auto" data-testid="row-customer">
          <bdi>{customerText(r)}</bdi>
        </p>
        <span className={`shrink-0 rounded px-2 py-0.5 text-sm font-semibold ${STATUS_CHIP[r.status]}`} data-testid="row-status">
          {statusLabel(lang, r.status)}
        </span>
      </div>
      {line ? (
        <p className="mt-1 text-base font-medium text-slate-900" data-testid="row-time">
          {line}
        </p>
      ) : null}
      {share ? (
        <a
          href={shareUrl(share)}
          target="_blank"
          rel="noopener noreferrer"
          title={st(lang, 'shareTitle')}
          className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-md border border-emerald-600 px-3 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
          data-testid="row-share"
        >
          <MessageCircle className="h-4 w-4" aria-hidden /> {st(lang, 'share')}
        </a>
      ) : null}
    </li>
  );
}
