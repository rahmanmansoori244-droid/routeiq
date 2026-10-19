'use client';

import { useState } from 'react';
import { BarChart3, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ANALYSIS_MAX_DAYS, analysisDefaultRange, analysisExportUrl, analysisRangeProblem } from '@/lib/analysis/view';

/**
 * "Analysis data (Excel)" on the Dashboard (owner request 19 Oct 2026: "build on more data for our analysis
 * later and improvement"): the facts the nightly job keeps per visit, sub-stay, drive, depot turn and
 * truck-day, plus the pins to review and the late result taps, for a From / To range (the last 30 days up to
 * yesterday by default, at most 92), every depot. Company admin and dispatcher only (the page shows it to
 * PLANNER and up; the route refuses a VIEWER): the pins to review are office data.
 */
export function AnalysisExport({ today }: { today: string }) {
  const [range, setRange] = useState(() => analysisDefaultRange(today));
  const problem = analysisRangeProblem(range.from, range.to);
  return (
    <details className="rounded-md border p-3 text-sm" data-testid="analysis-export">
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <BarChart3 className="h-4 w-4" /> Analysis data (Excel): unloading, drives, depot turns, pins to review
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
        {problem ? (
          <span className="pb-2 text-amber-700">{problem}</span>
        ) : (
          <Button asChild variant="outline" size="sm">
            <a href={analysisExportUrl(range.from, range.to, null)} data-testid="analysis-export-download">
              <Download className="mr-1 h-4 w-4" /> Analysis data (Excel)
            </a>
          </Button>
        )}
        <span className="pb-2 text-muted-foreground">
          Built every night for the day before (GPS times and distances while the trail exists, never a position). At most {ANALYSIS_MAX_DAYS} days at a time. Office use only.
        </span>
      </div>
    </details>
  );
}
