'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fmtDayMonth } from '@/lib/dispatch/time';
import { customerRef, gapText, type DataGap, type DepotCount, type WorklistRow } from '@/lib/dispatch/data-collection';

/** GET /api/customers/data-to-collect (item 4), as the day screen reads it. */
interface Worklist {
  from: string;
  to: string;
  days: number;
  rows: WorklistRow[];
  perDepot: DepotCount[];
  total: { customers: number; location: number; window: number };
  gateOn: boolean;
}

const SHOWN = 30;

/**
 * Owner decision 1 Oct 2026, item 3: with the loading rule on, the customers of this day that miss a
 * usable location or a delivery window. Planning goes on (the dispatcher sees the plan); their loads
 * cannot be locked, loaded or dispatched until the data is in.
 */
export function LoadingGapsNote({ gaps }: { gaps: readonly DataGap[] }) {
  if (!gaps.length) return null;
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="loading-gaps">
      <p className="font-medium">
        Loading rule is on: {gaps.length} customer(s) of this day miss a location or a delivery window.
      </p>
      <p className="text-xs">
        You can OPTIMIZE and see the plan, but a load with one of them cannot be locked, loaded or dispatched until the data is in: confirm the receiving hours in Details
        (or tick Open all day), set a delivery time for the order under Delivery times, or drop the pin.
      </p>
      <ul className="mt-1 space-y-0.5 text-xs">
        {gaps.slice(0, SHOWN).map((g) => (
          <li key={g.customerId}>
            {customerRef(g)}: no {gapText(g)}
          </li>
        ))}
        {gaps.length > SHOWN ? <li>and {gaps.length - SHOWN} more</li> : null}
      </ul>
    </div>
  );
}

/**
 * Owner decision 1 Oct 2026, item 4: customers with open orders from today to N days ahead (Settings)
 * that miss a usable location or their own confirmed receiving hours - counted per depot, this depot's
 * listed soonest delivery first - with the Excel for whoever collects the data.
 */
export function DataToCollectPanel({ slug, depotId, reloadKey }: { slug: string; depotId: string; reloadKey: string }) {
  const [data, setData] = useState<Worklist | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    fetch(`/api/customers/data-to-collect?depotId=${encodeURIComponent(depotId)}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as { data?: Worklist } | null;
        if (!live) return;
        if (!r.ok || !j?.data) setFailed(true);
        else setData(j.data);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [depotId, reloadKey]);

  if (failed) return <p className="text-xs text-muted-foreground">The data-to-collect list could not be read. Reload the page to try again.</p>;
  if (!data) return null;
  const here = data.perDepot.find((d) => d.depotId === depotId);
  const count = here?.customers ?? 0;
  return (
    <details className="rounded-md border p-2 text-sm" data-testid="data-to-collect">
      <summary className="cursor-pointer">
        Data to collect ({fmtDayMonth(data.from)} to {fmtDayMonth(data.to)}): {count} customer(s) of this depot miss a location or confirmed receiving hours
        {data.total.customers !== count ? ` · ${data.total.customers} in all depots` : ''}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">
          Customers with open orders from today to {data.days} day(s) ahead, soonest delivery first. Send the Excel to whoever collects the data; once filled in it can be
          imported on Customers &gt; Import.
          {data.gateOn ? ' The loading rule is on: a load with one of them cannot be locked, loaded or dispatched without a location and a delivery window.' : ''}
        </p>
        <div className="flex flex-wrap gap-1 text-xs">
          {data.perDepot.map((d) => (
            <Badge key={d.depotId} variant={d.customers ? 'warning' : 'secondary'} title={`${d.name}: ${d.location} without a usable location, ${d.window} without confirmed receiving hours`}>
              {d.code}: {d.customers} ({d.location} location, {d.window} hours)
            </Badge>
          ))}
        </div>
        {data.rows.length ? (
          <ul className="space-y-0.5 text-xs">
            {data.rows.slice(0, SHOWN).map((r) => (
              <li key={r.customerId}>
                <Link className="hover:underline" href={`/t/${slug}/customers/${r.customerId}`}>
                  {customerRef(r)}
                </Link>{' '}
                <span className="text-amber-800">{r.missing}</span> <span className="text-muted-foreground">· first delivery {fmtDayMonth(r.firstDelivery)}</span>
              </li>
            ))}
            {data.rows.length > SHOWN ? <li className="text-muted-foreground">and {data.rows.length - SHOWN} more (all in the Excel)</li> : null}
          </ul>
        ) : (
          <p className="text-xs text-green-700">Nothing to collect for this depot.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={`/api/customers/data-to-collect?format=xlsx&depotId=${encodeURIComponent(depotId)}`} data-testid="data-to-collect-xlsx">
              <Download className="me-1 h-4 w-4" />
              Excel, this depot
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href="/api/customers/data-to-collect?format=xlsx">
              <Download className="me-1 h-4 w-4" />
              Excel, all depots
            </a>
          </Button>
          <Button asChild size="sm" variant="link">
            <Link href={`/t/${slug}/customers?show=collect`}>Open on Customers</Link>
          </Button>
        </div>
      </div>
    </details>
  );
}
