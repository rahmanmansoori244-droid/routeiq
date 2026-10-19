'use client';

import { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import type { SalesRouteView } from '@/lib/sales-link/view-types';
import { filterView, noDeliveriesText, rowKey, summaryChips, UI, type SummaryKey } from '@/lib/sales-page/format';
import { DeliveryCard } from './delivery-card';
import { MapCard } from './map-card';
import { OffTruckList } from './off-truck-list';
import { SummaryBar } from './summary-bar';
import { TruckCard } from './truck-card';

/**
 * One route's dashboard: the count chips (a tap filters the list), the trucks carrying the route, the map, one
 * card per delivery in expected order, and the orders not on a truck. Keys carry the route: the answer's keys
 * are unique per route only.
 */
export function RouteView({ view }: { view: SalesRouteView }) {
  const [filter, setFilter] = useState<SummaryKey | null>(null);
  const chips = useMemo(() => summaryChips(view), [view]);
  const shown = useMemo(() => filterView(view, filter), [view, filter]);
  const total = view.deliveries.length + view.offTruck.length;
  const showing = shown.deliveries.length + shown.offTruck.length;
  return (
    <div className="space-y-4" data-testid={`route-${view.route}`}>
      {view.notLocked ? (
        <p className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-amber-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Not locked yet: times can change if the day is re-planned.
        </p>
      ) : null}
      <SummaryBar chips={chips} active={filter} onPick={setFilter} />
      {filter ? (
        <p className="flex items-center justify-between gap-2 px-1 text-sm text-slate-700" aria-live="polite">
          <span>{UI.filtered(showing, total)}</span>
          <button type="button" onClick={() => setFilter(null)} className="min-h-10 rounded-md px-2 font-semibold text-sky-800 underline">
            {UI.showAll}
          </button>
        </p>
      ) : null}

      {!filter && view.trucks.length ? (
        <section className="space-y-2">
          <h3 className="px-1 text-sm font-semibold uppercase tracking-wide text-slate-600">{UI.trucks}</h3>
          <ul className="space-y-2">
            {view.trucks.map((t) => (
              <TruckCard key={rowKey(view.route, t.key)} t={t} rowKey={rowKey(view.route, t.key)} />
            ))}
          </ul>
        </section>
      ) : null}
      {!filter ? <MapCard view={view} /> : null}

      {shown.deliveries.length || !filter ? (
        <section className="space-y-2">
          <h3 className="px-1 text-sm font-semibold uppercase tracking-wide text-slate-600">{UI.deliveries}</h3>
          {shown.deliveries.length ? (
            <ul className="space-y-2">
              {shown.deliveries.map((d) => (
                <DeliveryCard key={rowKey(view.route, d.key)} d={d} rowKey={rowKey(view.route, d.key)} />
              ))}
            </ul>
          ) : (
            <p className="rounded-lg bg-white p-3 text-sm text-slate-600 ring-1 ring-slate-200" data-testid="no-deliveries">
              {filter ? UI.noDeliveries : noDeliveriesText(view)}
            </p>
          )}
        </section>
      ) : null}
      <OffTruckList items={shown.offTruck} route={view.route} />
    </div>
  );
}
