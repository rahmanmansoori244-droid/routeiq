'use client';

import { AlertTriangle, MessageCircle } from 'lucide-react';
import type { SalesDelivery, SalesViewKind } from '@/lib/sales-link/view-types';
import { casesLine, codeText, hoursLine, shareUrl, STATUS_EDGE, STATUS_TONE, timeLine, timingChip, tripText, UI, windowLine } from '@/lib/sales-page/format';

/**
 * One delivery of the route (one stop of one trip): the number (the map's pin), the status and the timing against
 * the printed window, the customer, the time (delivered at / expected about / the window), the cases (x of y),
 * the truck, trip and stop, the reason as the driver reported it, the customer's hours, notes, and "Send to
 * customer" (WhatsApp with the status as text; no link is sent).
 */
export function DeliveryCard({ d, rowKey, kind = 'ROUTE' }: { d: SalesDelivery; rowKey: string; kind?: SalesViewKind }) {
  const timing = timingChip(d.eta);
  const time = timeLine(d);
  const win = windowLine(d);
  const hours = hoursLine(d);
  return (
    <li className={`rounded-lg border-l-4 bg-white p-3 shadow-sm ring-1 ring-slate-200 ${STATUS_EDGE[d.status]}`} data-testid={`delivery-${rowKey}`} data-status={d.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-slate-900 px-2 text-sm font-bold text-white" aria-label={`Delivery ${d.no}`}>
          {d.no}
        </span>
        <span className={`rounded px-2 py-0.5 text-sm font-semibold ${STATUS_TONE[d.status]}`} data-testid="delivery-status">
          {d.statusText}
        </span>
        {timing ? (
          <span className={`rounded px-2 py-0.5 text-sm font-semibold ${timing.tone}`} data-testid="delivery-timing">
            {timing.text}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-base font-semibold leading-snug" dir="auto">
        <bdi>{d.customerName}</bdi>
      </p>
      <p className="text-sm text-slate-600">
        {codeText(d.customerCode, d.branchCode)}
        {d.invoices.length ? ` · ${UI.invoices(d.invoices)}` : ''}
      </p>
      {kind === 'TRUCK' && d.routes?.length ? (
        <p className="text-sm font-medium text-slate-700" data-testid="delivery-routes">
          {UI.routesOf(d.routes)}
        </p>
      ) : null}
      {time ? (
        <p className="mt-1 text-base font-medium text-slate-900" data-testid="delivery-time">
          {time}
        </p>
      ) : null}
      {win ? <p className="text-sm text-slate-700">{win}</p> : null}
      <p className="mt-1 text-sm text-slate-700">
        <span className="font-medium" data-testid="delivery-cases">
          {casesLine(d)}
        </span>
        {' · '}
        {tripText(d)}
      </p>
      {d.reason ? (
        <p className="mt-1 text-sm text-red-900" data-testid="delivery-reason">
          Reason: {d.reason}
        </p>
      ) : null}
      {d.afterHours ? (
        <p className="mt-1 flex items-start gap-1 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {d.afterHours}
        </p>
      ) : null}
      {hours ? <p className="mt-1 text-xs text-slate-500">{hours}</p> : null}
      {d.notes.length ? (
        <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
          {d.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <a
        href={shareUrl(d.shareText)}
        target="_blank"
        rel="noopener noreferrer"
        title={UI.shareTitle}
        className="mt-2 inline-flex min-h-10 items-center gap-2 rounded-md border border-emerald-600 px-3 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
        data-testid="delivery-share"
      >
        <MessageCircle className="h-4 w-4" aria-hidden /> {UI.share}
      </a>
    </li>
  );
}
