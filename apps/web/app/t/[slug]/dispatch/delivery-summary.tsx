'use client';

import { useState } from 'react';
import { Download, PackageCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DayDeliveries } from '@/lib/delivery/day-results';
import { kpiHeadline, kpiOnTimeText } from '@/lib/delivery/kpis';
import { ACTUALS_MAX_DAYS, actualsDefaultRange, actualsRangeProblem, actualsUrl, countOf, reasonLabel } from '@/lib/delivery/office-text';
import { noOutcomeGroups } from '@/lib/dispatch/carry-view';
import { fmtDayMonth } from '@/lib/dispatch/time';
import { OutcomeDialog, type OutcomeTarget } from './outcome-dialog';

/**
 * The day screen's Deliveries card (owner request 4 Oct 2026, spec section 10.3): how many stops have
 * a result, delivered in full / partly / not delivered, the reasons with their cases, arrivals inside
 * the window (observed arrivals only), "no photo: camera failed" and "recorded after the trip closed";
 * then the stops of loads that are back with no result (grouped per truck, with Record), and the
 * late-dispatch notes. The "Delivery actuals" Excel of the day for dispatchers, and of a From / To
 * range (at most 31 days). A day before the feature started says so instead.
 */
export function DeliverySummary({
  deliveries,
  date,
  depotId,
  canPlan,
  onRecorded,
}: {
  deliveries: DayDeliveries | null | undefined;
  date: string;
  depotId: string;
  canPlan: boolean;
  onRecorded: () => void;
}) {
  const [recordFor, setRecordFor] = useState<OutcomeTarget | null>(null);
  if (!deliveries) return null;
  const k = deliveries.kpis;
  if (deliveries.beforeStart) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="deliveries-before-start">
        Delivery results started on {deliveries.since ? fmtDayMonth(deliveries.since) : 'a later day'}: this day has none.
      </p>
    );
  }
  if (!k.stops && !deliveries.noResult.length && !deliveries.lateDispatch.length) return null;
  const groups = noOutcomeGroups(deliveries.noResult);
  const onTime = kpiOnTimeText(k);
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="deliveries-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <PackageCheck className="h-4 w-4" /> Deliveries
        </p>
        {canPlan ? (
          <Button asChild variant="outline" size="sm">
            <a href={actualsUrl(date, date, depotId)} data-testid="delivery-actuals">
              <Download className="mr-1 h-4 w-4" /> Delivery actuals (Excel)
            </a>
          </Button>
        ) : null}
      </div>
      {canPlan ? <ActualsRange key={date} date={date} depotId={depotId} /> : null}
      <p data-testid="deliveries-headline">{kpiHeadline(k)}</p>
      {k.byReason.length ? (
        <p className="text-xs text-muted-foreground" data-testid="deliveries-reasons">
          {k.byReason.map((r) => `${reasonLabel(r.reason)} ${countOf(r.stops, 'stop')} / ${countOf(r.cases, 'case')}`).join(' · ')}
        </p>
      ) : null}
      {onTime ? <p className="text-xs">{onTime}</p> : null}
      {k.cameraFailed || k.late ? (
        <p className="text-xs text-amber-800">
          {[k.cameraFailed ? `No photo: camera failed ${k.cameraFailed}` : null, k.late ? `Recorded after the trip closed ${k.late}` : null].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {groups.length ? (
        <div className="space-y-1" data-testid="deliveries-no-result">
          <p className="text-xs font-medium">Back at the depot, no result recorded (counted as delivered):</p>
          {groups.map((g) => (
            <div key={`${g.date}-${g.truckCode}`} className="text-xs">
              <p className="font-medium">
                {g.truckCode}: {g.stops.length} stop{g.stops.length === 1 ? '' : 's'}
              </p>
              <ul className="ml-3 space-y-0.5">
                {g.stops.map((s) => (
                  <li key={`${s.loadId}-${s.sequence}`} className="flex flex-wrap items-center gap-2">
                    <span>
                      L{s.loadNo} stop {s.sequence}, {s.customerName} ({s.customerCode}
                      {s.branchCode ? `/${s.branchCode}` : ''}), {s.cases} cases
                    </span>
                    {canPlan ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        onClick={() =>
                          setRecordFor({
                            depotId: s.depotId,
                            date: s.date,
                            truckId: s.truckId,
                            truckCode: s.truckCode,
                            loadNo: s.loadNo,
                            sequence: s.sequence,
                            customerName: s.customerName,
                            customerCode: s.customerCode,
                            lines: s.lines,
                            current: null,
                          })
                        }
                        data-testid={`deliveries-record-${s.truckCode}-${s.loadNo}-${s.sequence}`}
                      >
                        Record
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
      {deliveries.lateDispatch.length ? (
        <div className="space-y-0.5 text-xs text-amber-700" data-testid="deliveries-late-dispatch">
          {deliveries.lateDispatch.map((n) => (
            <p key={n.loadId}>{n.text}</p>
          ))}
        </div>
      ) : null}
      <OutcomeDialog
        open={!!recordFor}
        onOpenChange={(v) => {
          if (!v) setRecordFor(null);
        }}
        target={recordFor}
        onSaved={onRecorded}
      />
    </div>
  );
}

/** "Delivery actuals" for several days: From / To (the last 7 days by default, at most 31), this depot. */
function ActualsRange({ date, depotId }: { date: string; depotId: string }) {
  const [range, setRange] = useState(() => actualsDefaultRange(date));
  const problem = actualsRangeProblem(range.from, range.to);
  return (
    <details className="text-xs" data-testid="delivery-actuals-range">
      <summary className="cursor-pointer text-muted-foreground">Delivery actuals for several days</summary>
      <div className="mt-1 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          From
          <input type="date" className="h-8 rounded-md border px-2" value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-0.5">
          To
          <input type="date" className="h-8 rounded-md border px-2" value={range.to} min={range.from} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
        </label>
        {problem ? (
          <span className="text-amber-700">{problem}</span>
        ) : (
          <Button asChild variant="outline" size="sm">
            <a href={actualsUrl(range.from, range.to, depotId)} data-testid="delivery-actuals-range-download">
              <Download className="mr-1 h-4 w-4" /> Download (Excel)
            </a>
          </Button>
        )}
        <span className="text-muted-foreground">At most {ACTUALS_MAX_DAYS} days at a time.</span>
      </div>
    </details>
  );
}
