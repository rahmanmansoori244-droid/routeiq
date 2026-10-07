'use client';

/**
 * The "Hire suggestion" box (owner request 6 Oct 2026) on the plan screen and the day screen: when the
 * plan leaves orders out because the fleet cannot carry them, which trucks to RENT ("hire 1 x 10-ton
 * (12 bays) + 1 x 3-ton (6 bays): extra about 80 OMR") from a what-if that runs on its own (Quick, never
 * changing the plan). "Use this plan" (PLANNER and above) rents them for the day and uses that plan.
 *
 * Review of the hire branch: it says "Checking which trucks to hire" only while a check runs or is on
 * its way (HireView.checkExpected), keeps polling after a failed read, hides itself for a plan option
 * that leaves nothing out, never offers a suggestion computed for another option, and names one button
 * ("Check hire options") in every text - the instruction only to someone who has the button (forViewer).
 * Only P1-P3 orders justify renting (owner answer 1, 6 Oct 2026): when only P4/P5 orders are left out the
 * box says "Left out: N orders, all P4/P5 - renting is not suggested for them." and offers nothing.
 * Third review: a failed first read keeps polling (and says "Could not refresh" after a few failures,
 * in a box of its own), and a suggestion whose hire option was switched off says so instead of offering
 * Use this plan.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { HireView } from '@/lib/dispatch/hire-whatif';
import { hireUseConfirmText } from '@/lib/dispatch/hire';
import { fmtDayMonth } from '@/lib/dispatch/time';
import { api, askOverride, type OptimizeOverrides } from './client-api';

const POLL_MS = 4_000;
/** Failed reads in a row before the box says it could not refresh (it keeps trying). */
const FAILED_READS_NOTE = 3;

interface Props {
  runId: string;
  /** The plan as loaded (its status, job and option in use): a change reloads the suggestion. */
  planKey: string;
  canPlan: boolean;
  superseded: boolean;
  /** Another action of the plan runs: Use this plan waits. */
  busy: boolean;
  expect: { date: string; depotId: string } | null;
  canEditProducts: boolean;
  onUsed: (newRunId: string) => void | Promise<void>;
}

/**
 * A server text that tells to press the button, for someone who does not have it - a sentence of its own
 * ("Press Check hire options to run it again.") or its end ("... stayed unused - press Check hire options
 * to search again."), in any case (review of the hire branch: the lowercase mid-sentence form reached
 * viewers).
 */
export function forViewer(text: string, canAct: boolean): string {
  if (canAct) return text;
  return text
    .replace(/\s+-\s+press Check hire options[^.]*\./gi, '. A dispatcher can check again.')
    .replace(/\s*\bpress Check hire options[^.]*\./gi, ' A dispatcher can check again.')
    .trim();
}

export function HireSuggestionBox({ runId, planKey, canPlan, superseded, busy, expect, canEditProducts, onUsed }: Props) {
  const [view, setView] = useState<HireView | null>(null);
  const [working, setWorking] = useState<'use' | 'check' | null>(null);
  // Every poll's timer fire counts (review: a failed read changed nothing the effect watched, so
  // polling stopped for good while the box kept spinning).
  const [tick, setTick] = useState(0);
  const [failedReads, setFailedReads] = useState(0);

  const load = useCallback(async () => {
    const r = await api<HireView>(`/api/runs/${runId}/hire-suggestion`);
    if (r.ok && r.data) {
      setView(r.data);
      setFailedReads(0);
    } else setFailedReads((n) => n + 1);
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load, planKey]);

  const status = view?.suggestion?.status;
  const running = status === 'QUEUED' || status === 'RUNNING';
  // Third review: also after a failed read, the first one included - a failed first read left the box
  // out for good (no view: nothing rendered, nothing polled) until the page was reloaded.
  const polling = failedReads > 0 || running || !!view?.checkExpected;
  useEffect(() => {
    if (!polling) return;
    const t = setTimeout(() => {
      setTick((n) => n + 1);
      void load();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [polling, tick, load]);

  if (!view) {
    return failedReads >= FAILED_READS_NOTE ? (
      <div className="space-y-1 rounded-md border border-slate-300 bg-slate-50 p-3 text-sm" data-testid="hire-suggestion">
        <p className="flex items-center gap-2 font-medium">
          <Truck className="h-4 w-4 shrink-0" /> Hire suggestion
        </p>
        <p className="text-xs text-red-700" data-testid="hire-refresh-failed">
          Could not refresh the hire check (still trying).
        </p>
      </div>
    ) : null;
  }
  const s = view.suggestion;
  // A plan option that leaves no P1-P3 order out for the fleet: no suggestion (a check still running
  // aside) - only P4/P5 orders left out are said plainly (owner answer 1, 6 Oct 2026), with no button.
  if (!view.short && !running) {
    return view.lowNote ? (
      <div className="space-y-1 rounded-md border border-slate-300 bg-slate-50 p-3 text-sm" data-testid="hire-suggestion">
        <p className="flex items-center gap-2 font-medium">
          <Truck className="h-4 w-4 shrink-0" /> Hire suggestion
        </p>
        <p data-testid="hire-low-only">{view.lowNote}</p>
      </div>
    ) : null;
  }
  const mayCheck = canPlan && !superseded && view.canCheck;
  if (!s && view.options === 0) {
    return canPlan && !superseded ? (
      <p className="text-xs text-muted-foreground" data-testid="hire-no-options">
        Orders are left out because the fleet cannot carry them. When a company admin enters the trucks you can hire (Trucks page, Trucks to hire), RouteIQ says which ones to rent.
      </p>
    ) : null;
  }

  async function check() {
    setWorking('check');
    try {
      const r = await api<{ suggestionId: string }>(`/api/runs/${runId}/hire-suggestion`, { method: 'POST', json: {} });
      if (r.ok) toast.success('Checking which trucks to hire (Quick search). Your plan stays as it is.');
      else toast.error(r.error ?? 'Could not check the hire options.');
      await load();
    } finally {
      setWorking(null);
    }
  }

  async function use() {
    if (!s?.summary) return;
    // The day as the rest of the screen says it ("11 Oct"; sixth review of the hire branch).
    const day = expect?.date ? fmtDayMonth(expect.date) : 'this day';
    if (!window.confirm(hireUseConfirmText(s.summary, expect?.date ?? null))) {
      return;
    }
    setWorking('use');
    try {
      let overrides: OptimizeOverrides = {};
      for (;;) {
        const r = await api<{ runId: string; version?: number; applied?: string; trucks?: { code: string }[] }>(`/api/runs/${runId}/hire-suggestion/use`, {
          method: 'POST',
          json: { suggestionId: s.id, ...(expect ? { expect } : {}), ...overrides },
        });
        if (r.ok && r.data) {
          const codes = (r.data.trucks ?? []).map((t) => t.code).join(', ');
          toast.success(
            r.data.applied === 'PLAN'
              ? `Plan version ${r.data.version ?? ''} uses the hired trucks ${codes}. Enter each one's plate (Plate on its load) and pick its driver before dispatch.`
              : `The hired trucks ${codes} were added for ${day}; re-planning the day with them (Quick).`,
          );
          await onUsed(r.data.runId);
          return;
        }
        const more = askOverride(r.errorBody, 'Re-plan', { canEditProducts });
        if (more) {
          overrides = { ...overrides, ...more };
          continue;
        }
        if (r.errorBody?.code !== 'LOCATION_REQUIRED' && r.errorBody?.code !== 'WEIGHT_REQUIRED') toast.error(r.error ?? 'Could not use this plan.');
        await load();
        return;
      }
    } finally {
      setWorking(null);
    }
  }

  const canAct = canPlan && !superseded && !busy && !working;
  const tone = s?.status === 'SUCCEEDED' && s.summary?.status === 'HIRE' && !s.forOtherOption ? 'border-blue-300 bg-blue-50' : 'border-amber-300 bg-amber-50';
  const idle = !s
    ? view.checkExpected
      ? ' Checking which trucks to hire…'
      : ` No hire check has run for this plan yet.${view.skipNote ? ` ${view.skipNote}` : ''}${
          view.dayOver ? ' This day is over.' : mayCheck ? ' Press Check hire options to see which trucks to hire.' : view.canCheck ? ' A dispatcher can check which trucks to hire.' : ''
        }`
    : '';
  return (
    <div className={`space-y-1 rounded-md border p-3 text-sm ${tone}`} data-testid="hire-suggestion">
      <p className="flex items-center gap-2 font-medium">
        <Truck className="h-4 w-4 shrink-0" /> Hire suggestion
      </p>
      {!s ? (
        <>
          <p data-testid="hire-idle">
            {view.checkExpected ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}
            Orders are left out because the fleet cannot carry them.{idle}
          </p>
          {view.lowNote ? <p className="text-xs text-slate-700">{view.lowNote}</p> : null}
        </>
      ) : running ? (
        <p className="flex items-center gap-2" data-testid="hire-running">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking which trucks to hire (Quick search, then a few checks with fewer trucks: a minute or a few). Your plan stays as it is meanwhile.
        </p>
      ) : s.forOtherOption ? (
        <p data-testid="hire-other-option">
          The last hire check was computed for another plan option than the one in use.{mayCheck ? ' Press Check hire options to check this one.' : ''}
        </p>
      ) : s.status === 'SUCCEEDED' && s.headline ? (
        <>
          <p data-testid="hire-headline">{forViewer(s.headline, mayCheck)}</p>
          {s.details.map((t) => (
            <p key={t} className="text-xs text-slate-700">
              {t}
            </p>
          ))}
          {s.usedAt ? (
            <p className="text-xs font-medium" data-testid="hire-used">
              Used: the hired trucks were added{s.usedRunId && s.usedRunId !== runId ? ' and a new plan version was made' : ''}.
            </p>
          ) : null}
          {s.optionNote ? (
            <p className="text-xs font-medium text-amber-800" data-testid="hire-option-gone">
              {forViewer(s.optionNote, mayCheck)}
            </p>
          ) : null}
          {s.note ? (
            <p className="text-xs text-slate-600" data-testid="hire-note">
              A newer check did not finish: {forViewer(s.note, mayCheck)}
            </p>
          ) : null}
        </>
      ) : (
        <p data-testid="hire-ended">{forViewer(s.message ?? 'The hire check did not finish.', mayCheck)}</p>
      )}
      {failedReads >= FAILED_READS_NOTE ? (
        <p className="text-xs text-red-700" data-testid="hire-refresh-failed">
          Could not refresh the hire check (still trying).
        </p>
      ) : null}
      {canPlan && !superseded ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {s?.usable ? (
            <Button size="sm" disabled={!canAct} onClick={() => void use()} data-testid="hire-use-btn">
              {working === 'use' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Use this plan
            </Button>
          ) : null}
          {view.canCheck && view.short && !running && !view.checkExpected ? (
            <Button size="sm" variant="outline" disabled={!canAct} onClick={() => void check()} data-testid="hire-check-btn">
              {working === 'check' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
              Check hire options
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
