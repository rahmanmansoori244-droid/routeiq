'use client';

/**
 * The "Hire suggestion" box (owner request 6 Oct 2026) on the plan screen and the day screen: when the
 * plan leaves orders out because the fleet cannot carry them, which trucks to RENT ("hire 1 x 10-ton
 * (12 bays) + 1 x 3-ton (6 bays): extra about 80 OMR") from a what-if that runs on its own (Quick, never
 * changing the plan). "Use this plan" (PLANNER and above) rents them for the day and uses that plan.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { HireView } from '@/lib/dispatch/hire-whatif';
import { api, askOverride, type OptimizeOverrides } from './client-api';

const POLL_MS = 4_000;
/** After a plan is saved its what-if is created a moment later: look a few times before giving up. */
const LOOKS_FOR_NEW = 6;

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

export function HireSuggestionBox({ runId, planKey, canPlan, superseded, busy, expect, canEditProducts, onUsed }: Props) {
  const [view, setView] = useState<HireView | null>(null);
  const [working, setWorking] = useState<'use' | 'check' | null>(null);
  // Looks for the check a just-saved plan starts (it is created a moment after the plan).
  const [looks, setLooks] = useState(0);

  const load = useCallback(async () => {
    const r = await api<HireView>(`/api/runs/${runId}/hire-suggestion`);
    if (r.ok && r.data) setView(r.data);
  }, [runId]);

  useEffect(() => {
    setLooks(0);
    void load();
  }, [load, planKey]);

  const status = view?.suggestion?.status;
  const running = status === 'QUEUED' || status === 'RUNNING';
  const expected = !!view && view.short && view.options > 0 && view.canCheck && !view.suggestion;
  useEffect(() => {
    if (!running && !(expected && looks < LOOKS_FOR_NEW)) return;
    const t = setTimeout(() => {
      if (!running) setLooks((n) => n + 1);
      void load();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [running, expected, looks, view, load]);

  if (!view) return null;
  const s = view.suggestion;
  if (!s && !view.short) return null;
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
    const trucks = s.summary.hires.map((h) => `${h.count} x ${h.label}`).join(' + ');
    const day = expect?.date ?? 'this day';
    if (
      !window.confirm(
        `Hire ${trucks} for ${day} and use this plan?\n\nThe trucks are added for ${day} only (codes HIRE-...; enter each one's real plate and driver on its loads). A new plan version is made with them; locked and dispatched loads stay exactly as they are. If the day changed since this was computed, RouteIQ re-plans with the hired trucks instead.`,
      )
    ) {
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
  const tone = s?.status === 'SUCCEEDED' && s.summary?.status === 'HIRE' ? 'border-blue-300 bg-blue-50' : 'border-amber-300 bg-amber-50';
  return (
    <div className={`space-y-1 rounded-md border p-3 text-sm ${tone}`} data-testid="hire-suggestion">
      <p className="flex items-center gap-2 font-medium">
        <Truck className="h-4 w-4 shrink-0" /> Hire suggestion
      </p>
      {!s ? (
        <p>
          Orders are left out because the fleet cannot carry them.
          {view.canCheck ? (looks < LOOKS_FOR_NEW ? ' Checking which trucks to hire…' : ' Press Check hire options to see which trucks to hire.') : ''}
        </p>
      ) : running ? (
        <p className="flex items-center gap-2" data-testid="hire-running">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking which trucks to hire (Quick search, about a minute). Your plan stays as it is meanwhile.
        </p>
      ) : s.status === 'SUCCEEDED' && s.headline ? (
        <>
          <p data-testid="hire-headline">{s.headline}</p>
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
        </>
      ) : (
        <p data-testid="hire-ended">{s.message ?? 'The hire check did not finish.'}</p>
      )}
      {canPlan && !superseded ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {s?.usable ? (
            <Button size="sm" disabled={!canAct} onClick={() => void use()} data-testid="hire-use-btn">
              {working === 'use' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
              Use this plan
            </Button>
          ) : null}
          {view.canCheck && view.short && !running ? (
            <Button size="sm" variant="outline" disabled={!canAct} onClick={() => void check()} data-testid="hire-check-btn">
              {working === 'check' ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
              {s ? 'Check again' : 'Check hire options'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
