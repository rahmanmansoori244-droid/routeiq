'use client';

import type { SalesOffTruck } from '@/lib/sales-link/view-types';
import { codeText, OFF_TONE, UI } from '@/lib/sales-page/format';

/** The route's orders that are not on a truck of the day: cancelled, moved to another day, left out, not planned yet. */
export function OffTruckList({ items, route }: { items: SalesOffTruck[]; route: string }) {
  if (!items.length) return null;
  return (
    <section className="space-y-2" data-testid="off-truck">
      <h3 className="px-1 text-sm font-semibold uppercase tracking-wide text-slate-600">{UI.offTruck}</h3>
      <ul className="space-y-2">
        {items.map((o, i) => (
          <li key={`${route}:${o.kind}:${o.customerCode}:${o.branchCode ?? ''}:${i}`} className="rounded-lg bg-white p-3 shadow-sm ring-1 ring-slate-200" data-kind={o.kind}>
            <span className={`rounded px-2 py-0.5 text-sm font-semibold ${OFF_TONE[o.kind]}`}>{o.kindText}</span>
            <p className="mt-2 text-base font-semibold leading-snug" dir="auto">
              <bdi>{o.customerName}</bdi>
            </p>
            <p className="text-sm text-slate-600">
              {codeText(o.customerCode, o.branchCode)}
              {o.invoices.length ? ` · ${UI.invoices(o.invoices)}` : ''} · {o.cases} {o.cases === 1 ? 'case' : 'cases'}
            </p>
            <p className="mt-1 text-sm text-slate-800">{o.why}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
