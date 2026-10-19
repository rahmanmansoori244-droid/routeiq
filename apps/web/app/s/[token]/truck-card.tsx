'use client';

import { Truck } from 'lucide-react';
import type { SalesTruck, SalesViewKind } from '@/lib/sales-link/view-types';

const TRIP_TONE: Record<string, string> = {
  DISPATCHED: 'bg-emerald-600 text-white',
  LOADING: 'bg-amber-200 text-amber-950',
  LOCKED: 'bg-slate-300 text-slate-900',
  PLANNED: 'bg-slate-200 text-slate-800',
  COMPLETED: 'bg-slate-700 text-white',
};

/**
 * One truck carrying the route's deliveries (or, for a truck looked up, the truck itself): its code (as on the
 * Salesman ETA), the trip that matters now, how far behind plan it runs, the route's (the truck's) next customer on
 * it, and its GPS line. The position itself is on the map.
 */
export function TruckCard({ t, rowKey, kind = 'ROUTE' }: { t: SalesTruck; rowKey: string; kind?: SalesViewKind }) {
  const own = kind === 'TRUCK';
  return (
    <li className="rounded-lg bg-white p-3 shadow-sm ring-1 ring-slate-200" data-testid={`truck-${rowKey}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Truck className="h-5 w-5 text-slate-700" aria-hidden />
        <span className="text-base font-bold">{t.truckCode}</span>
        {t.trip ? <span className={`rounded px-2 py-0.5 text-xs font-semibold ${TRIP_TONE[t.trip.status] ?? TRIP_TONE.PLANNED}`}>Trip {t.trip.loadNo}</span> : null}
        {t.trips > 1 ? <span className="text-xs text-slate-500">{own ? `${t.trips} trips` : `${t.trips} trips with your customers`}</span> : null}
      </div>
      {t.trip ? <p className="mt-1 text-sm text-slate-800">{t.trip.text}</p> : null}
      {t.lateText ? <p className="mt-1 text-sm font-semibold text-orange-800">{t.lateText}</p> : null}
      {t.nextYours ? (
        <p className="mt-1 text-sm text-slate-800" dir="auto">
          <span className="font-medium">{own ? 'Next: ' : 'Your next: '}</span>
          <bdi>{t.nextYours}</bdi>
        </p>
      ) : null}
      {t.gpsText ? <p className="mt-1 text-xs text-slate-500">{t.position ? `${t.gpsText} · on the map below` : t.gpsText}</p> : null}
    </li>
  );
}
