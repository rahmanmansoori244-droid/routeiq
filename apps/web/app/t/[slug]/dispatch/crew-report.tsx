'use client';

import { useState } from 'react';
import { Download, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CREW_MAX_DAYS, crewDefaultRange, crewRangeProblem, crewReportUrl } from '@/lib/dispatch/crew-report-view';

/**
 * "Crew report (Excel)" on the Daily dispatch screen (owner request 13 Oct 2026): management sees who
 * were the driver and the helpers on each truck and load, for a From / To range (the last 7 days by
 * default, at most 31), this depot or every depot. Every role may download it, like the plan's Excel.
 */
export function CrewReport({ date, depotId, depotCode }: { date: string; depotId: string; depotCode: string }) {
  const [range, setRange] = useState(() => crewDefaultRange(date));
  const [allDepots, setAllDepots] = useState(false);
  const problem = crewRangeProblem(range.from, range.to);
  return (
    <details className="rounded-md border p-3 text-sm" data-testid="crew-report">
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <Users className="h-4 w-4" /> Crew report (Excel): drivers and helpers on each load
      </summary>
      <div className="mt-2 flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-0.5">
          From
          <input type="date" className="h-8 rounded-md border px-2" value={range.from} max={range.to} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
        </label>
        <label className="flex flex-col gap-0.5">
          To
          <input type="date" className="h-8 rounded-md border px-2" value={range.to} min={range.from} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
        </label>
        <label className="flex items-center gap-1 pb-2">
          <input type="checkbox" checked={allDepots} onChange={(e) => setAllDepots(e.target.checked)} data-testid="crew-report-all-depots" />
          Every depot (else {depotCode} only)
        </label>
        {problem ? (
          <span className="pb-2 text-amber-700">{problem}</span>
        ) : (
          <Button asChild variant="outline" size="sm">
            <a href={crewReportUrl(range.from, range.to, allDepots ? null : depotId)} data-testid="crew-report-download">
              <Download className="mr-1 h-4 w-4" /> Crew report (Excel)
            </a>
          </Button>
        )}
        <span className="pb-2 text-muted-foreground">
          One row per load: driver, helpers, departure, back at depot, stops, cases. At most {CREW_MAX_DAYS} days at a time.
        </span>
      </div>
    </details>
  );
}
