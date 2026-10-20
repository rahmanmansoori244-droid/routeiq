'use client';

import { useMemo, useState } from 'react';
import type { SalesRouteView, SalesStatus } from '@/lib/sales-link/view-types';
import { allNotPlannedYet, rowKey, rowsOf, statusButtons, statusLabel } from '@/lib/sales-page/format';
import { st, type SalesLang } from '@/lib/sales-page/i18n';
import { RowCard } from './row-card';
import { StatusGrid } from './status-grid';

/**
 * One route's customers (or one truck's: its customers of the day, every route; owner feedback of 20 Oct 2026): the
 * status buttons, then the customers of the status picked ("All" first: every customer by time). No truck, trip,
 * map or reason. Keys carry the result's query: the answer's keys are unique per result only. On a later delivery date
 * (`future`: tomorrow's link the evening before) "On the way" reads "Planned" and each customer says the day.
 */
export function RouteView({ view, lang, future, date }: { view: SalesRouteView; lang: SalesLang; future: boolean; date: string }) {
  const [filter, setFilter] = useState<SalesStatus | null>(null);
  // The button picked stays even when a refresh empties it (pressed, with 0).
  const buttons = useMemo(() => statusButtons(view.rows, filter), [view.rows, filter]);
  const shown = useMemo(() => rowsOf(view.rows, filter), [view.rows, filter]);
  return (
    <div className="space-y-4" data-testid={`${view.kind === 'TRUCK' ? 'truck-view' : 'route'}-${view.code}`} data-kind={view.kind}>
      <StatusGrid lang={lang} buttons={buttons} total={view.rows.length} active={filter} onPick={setFilter} future={future} />
      {allNotPlannedYet(view.rows) ? (
        <p className="rounded-lg bg-white p-3 text-sm text-slate-700 ring-1 ring-slate-200" data-testid="not-planned-yet">
          {st(lang, 'notPlannedYetAll')}
        </p>
      ) : null}
      <section className="space-y-2" aria-live="polite">
        <h2 className="px-1 text-base font-semibold text-slate-700" data-testid="list-heading">
          {filter ? statusLabel(lang, filter, future) : st(lang, 'all')} · {shown.length}
        </h2>
        {shown.length ? (
          <ul className="space-y-2">
            {shown.map((r) => (
              <RowCard key={rowKey(view.query, r.key)} lang={lang} r={r} rowKey={rowKey(view.query, r.key)} future={future} date={date} />
            ))}
          </ul>
        ) : (
          <p className="rounded-lg bg-white p-3 text-sm text-slate-600 ring-1 ring-slate-200" data-testid="no-rows">
            {view.rows.length ? st(lang, 'noneHere') : st(lang, 'nothingYet')}
          </p>
        )}
      </section>
    </div>
  );
}
