'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MapPinned } from 'lucide-react';
import type { PinCheckRow } from '@/lib/delivery/customer-stats';
import { fmtDayMonth } from '@/lib/dispatch/time';

/**
 * "Pin may be wrong" (owner request 4 Oct 2026, spec section 11.2), for the company admin on the
 * Customers page: customers whose delivery photos (else a manual arrival or the result) were more than
 * 150 m from the pin on at least 2 of their last 3 visits, or where the driver said "wrong location".
 * The suggested point opens in Google Maps; the admin checks it and uses Set location on the customer
 * (the location lock stays: nothing moves by itself). Hidden when nothing is flagged.
 */
export function PinCheckPanel({ slug }: { slug: string }) {
  const [rows, setRows] = useState<PinCheckRow[] | null>(null);
  useEffect(() => {
    let gone = false;
    void fetch('/api/customers/pin-check', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!gone && b && Array.isArray(b.data)) setRows(b.data as PinCheckRow[]);
      })
      .catch(() => null);
    return () => {
      gone = true;
    };
  }, []);
  if (!rows || !rows.length) return null;
  return (
    <details className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="pin-check">
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <MapPinned className="h-4 w-4" /> Pin may be wrong: {rows.length} customer{rows.length === 1 ? '' : 's'}
      </summary>
      <p className="mt-1 text-xs text-muted-foreground">
        Delivery photos or the driver&apos;s position were far from the saved pin on 2 of the last 3 visits, or the driver said &quot;wrong location&quot;. Check the
        suggested point, then open the customer and use Set location. Nothing changes by itself.
      </p>
      <ul className="mt-2 space-y-1 text-xs">
        {rows.map((r) => (
          <li key={r.customerId} data-testid={`pin-check-${r.code}`}>
            <Link className="font-medium hover:underline" href={`/t/${slug}/customers/${r.customerId}`}>
              {r.name} ({r.code}
              {r.branchCode ? `/${r.branchCode}` : ''})
            </Link>
            {' · '}
            {r.far
              .filter((f) => f.distanceM !== null)
              .map((f) => `${f.distanceM} m (${fmtDayMonth(f.date)})`)
              .join(', ')}
            {r.wrongLocationDates.length ? ` · Driver said: wrong location (${r.wrongLocationDates.map(fmtDayMonth).join(', ')})` : ''}
            {r.suggested ? (
              <>
                {' · '}
                <a className="text-primary hover:underline" href={r.suggested.mapsUrl} target="_blank" rel="noreferrer noopener">
                  suggested point
                </a>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
