'use client';

import { AlertTriangle, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KEPT_BOX_LEAD, unlockAlsoText, unlockButtonText, type KeptEffect, type KeptLoadRef, type KeptReport, type KeptStop } from '@/lib/dispatch/kept-changes';

const EFFECT_CLASS: Record<KeptEffect, string> = {
  BREAKS: 'text-red-700',
  CHECK: 'text-amber-800',
  STILL_OK: 'text-muted-foreground',
};

const stopLabel = (s: KeptStop) => `${s.branchCode ? `${s.code}/${s.branchCode}` : s.code} ${s.name}${s.split ? ` (part ${s.split.part} of ${s.split.parts})` : ''}`;

/**
 * "Locked loads planned with older customer data" (Step 3 and the plan screen): per locked or loading
 * load, what changed since it was planned and whether the planned times still keep the rules, with its
 * Unlock (PLANNER, a LOCKED load only; a loading load says what to do instead). Red: a rule fails with
 * the data now; amber: check it; grey: still keeps every rule.
 */
export function KeptChangesBox({
  report,
  canPlan,
  busy,
  onUnlock,
  testId,
}: {
  report: KeptReport;
  canPlan: boolean;
  busy: boolean;
  onUnlock: (loads: KeptLoadRef[]) => void;
  testId: string;
}) {
  if (!report.loads.length) return null;
  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm" data-testid={testId}>
      <p className="flex items-center gap-2 font-medium text-amber-900">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Locked loads planned with older customer data ({report.counts.loads})
      </p>
      <p className="text-xs text-amber-900">{KEPT_BOX_LEAD}</p>
      {report.loads.map((l) => (
        <div key={l.loadId} className="rounded border border-amber-200 bg-white/60 p-2" data-testid={`kept-load-${l.truckCode}-${l.loadNo}`}>
          <p className="font-medium">
            {l.label} - {l.status === 'LOADING' ? 'being loaded' : 'locked'}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {l.stops.flatMap((s) =>
              s.changes.map((c, i) => (
                <li key={`${s.sequence}-${c.kind}-${i}`} className={EFFECT_CLASS[c.effect]}>
                  <b>{stopLabel(s)}:</b> {c.text}
                </li>
              )),
            )}
          </ul>
          {canPlan ? (
            l.unlock.blocked ? (
              <p className="mt-1 text-xs text-amber-800" data-testid={`kept-blocked-${l.truckCode}-${l.loadNo}`}>
                {l.unlock.blocked}
              </p>
            ) : (
              <>
                <Button size="sm" variant="outline" className="mt-1" disabled={busy} onClick={() => onUnlock(l.unlock.loads)} data-testid={`kept-unlock-${l.truckCode}-${l.loadNo}`}>
                  <Unlock className="mr-1 h-3 w-3" /> {unlockButtonText(l)}
                </Button>
                {/* Loads without a change that go back too (a truck's later loads first): said under the button. */}
                {unlockAlsoText(l) ? <p className="mt-0.5 text-xs text-muted-foreground">{unlockAlsoText(l)}</p> : null}
              </>
            )
          ) : null}
        </div>
      ))}
    </div>
  );
}
