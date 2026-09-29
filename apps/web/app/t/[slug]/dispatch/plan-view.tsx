'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, FileText, History, Lock, Truck, Unlock, PackageCheck, Send, Flag, RefreshCw, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { driverClashNotes, tripsByTruck, whatsappNumber, whatsappText, whatsappUrl } from '@/lib/dispatch/driver-links';
import type { PlanDetail, DetailLoad } from '@/lib/dispatch/plan-detail';
import { TIMING_TEXT, remedyLoads, timingRemedy, timingReplanOff, unlockFirstText, type RemedyLoad } from '@/lib/dispatch/feasibility-view';
import type { PlanViolation } from '@/lib/dispatch/feasibility';
import { isSupersededRun, nothingToReplan } from '@/lib/dispatch/plan-status';
import { canStepBack, driverPickLink } from '@/lib/dispatch/load-state';
import { COST_BASIS_TEXT, kmLabelFor, summaryCostBasis } from '@/lib/dispatch/costs';
import { solverStatusText } from '@/lib/dispatch/solver-status';
import { carriedFromBadge, carriedLoadTitle, carriedToBadge, replanWork } from '@/lib/dispatch/carry-view';
import { fmtDayMonth } from '@/lib/dispatch/time';
import { kgText, manifestKgNote } from '@/lib/dispatch/weights';
import { api, askOverride, durH, hhmm, REASON_TEXT, weightFixText, type OptimizeOverrides } from './client-api';
import { LateOrderDialog } from './late-order-dialog';
import { afterLateOrderSaved, createLoadOrder, planAfterLoad, planReloadErrorText, runPlanAction, type ActionLock, type PlanPanel } from './plan-actions';

const PlanMap = dynamic(() => import('@/components/plan-map').then((m) => m.PlanMap), { ssr: false });

const STATUS_VARIANT: Record<string, 'outline' | 'secondary' | 'warning' | 'success' | 'destructive' | 'default'> = {
  PLANNED: 'outline',
  LOCKED: 'secondary',
  LOADING: 'warning',
  DISPATCHED: 'success',
  COMPLETED: 'default',
};

/** Asked before "Reset stuck plan" (audit F09). */
const STUCK_RESET_CONFIRM =
  'Reset this plan? It is shown as optimizing, but its optimization has ended or was lost. The plan goes back to "failed" (a re-plan version keeps the loads it holds) so it can be optimized or re-planned again. This is recorded in the audit log.';

/** Once a load is out, who drove it is history. */
const ON_ROAD = new Set(['DISPATCHED', 'COMPLETED']);

interface DriverOption { id: string; code: string; name: string; phone: string | null; active: boolean }

interface Props {
  slug: string;
  runId: string;
  canPlan: boolean;
  canDispatch: boolean;
  /** Company admin: can enter case weights under Products (the weight question says whom to ask). */
  canEditProducts?: boolean;
  /**
   * Called after anything that changes the day (late order, replan, status). May return the day's
   * reload: the action keeps its busy state until it resolves.
   */
  onChanged?: (newRunId?: string) => void | Promise<void>;
  showVersionLink?: boolean;
  /** Calling code added to drivers' phones saved without one (WhatsApp links); null = unknown. */
  phoneCountryCode?: string | null;
  /** Supervisor and above: may "Reset stuck plan" (audit F09, owner decision 17). */
  canResetStuck?: boolean;
  /** A request of the screen around this plan is running (the day screen's OPTIMIZE / RE-PLAN): every action here waits. */
  externalBusy?: boolean;
  /** Told when an action of this plan starts (true) and ends (false), so the screen around it waits too. */
  onBusyChange?: (busy: boolean) => void;
  /**
   * Bumped by the screen around the plan to load it again in place - the day back after a failed
   * load. Never a remount: an open late order, opened loads and a running action stay (fourth
   * review of PR3: a remount after one failed day poll closed the late order being typed).
   */
  reloadSignal?: number;
  /**
   * The company's today (YYYY-MM-DD) as the day screen knows it: a load of today holding orders
   * brought forward to tomorrow says "re-plan today" / "unlock" (carriedLoadTitle). Optional:
   * without it (the standalone plan version page) the plan's own today is used (PlanDetail.today).
   */
  today?: string;
}

export function PlanView({ slug, runId, canPlan, canDispatch, canEditProducts = false, onChanged, showVersionLink = true, phoneCountryCode = null, canResetStuck = false, externalBusy = false, onBusyChange, reloadSignal = 0, today }: Props) {
  // The plan last loaded, and why the last load failed: a failed reload keeps the plan on screen
  // with the error and Try again (planAfterLoad; third review of PR3).
  const [panel, setPanel] = useState<PlanPanel<PlanDetail>>({ plan: null, error: null });
  const d = panel.plan;
  const err = panel.error;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [ownBusy, setBusy] = useState<string | null>(null);
  // One action at a time across the whole day screen (F07): this plan's own request, or the day
  // screen's OPTIMIZE / RE-PLAN request around it.
  const busy = ownBusy ?? (externalBusy ? 'external' : null);
  // Read synchronously, so two quick clicks cannot both start (plan-actions.ts).
  const busyRef = useRef<string | null>(null);
  const lock: ActionLock = {
    current: () => busyRef.current ?? (externalBusy ? 'external' : null),
    set: (key) => {
      busyRef.current = key;
      setBusy(key);
    },
  };
  const failed = (message: string) => toast.error(message);
  const [lateOpen, setLateOpen] = useState(false);
  const [selectedLoad, setSelectedLoad] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<DriverOption[]>([]);

  // Newest answer wins (createLoadOrder): an answer older than the one on screen is dropped (null).
  const loadOrder = useRef(createLoadOrder());
  // A load newer than the answer on screen is on its way: Try again waits for it.
  const [reloading, setReloading] = useState(false);
  const load = useCallback(async () => {
    const ticket = loadOrder.current.begin();
    setReloading(true);
    const r = await api<PlanDetail>(`/api/runs/${runId}/plan`);
    if (!loadOrder.current.accept(ticket)) return null;
    setReloading(loadOrder.current.pending());
    setPanel((shown) => planAfterLoad(shown, r));
    return r.ok ? r.data : null;
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onBusyChange?.(ownBusy !== null);
  }, [ownBusy, onBusyChange]);
  // Unmounted mid-action (the day reloads the plan): never leave the day screen waiting.
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const loadDrivers = useCallback(async () => {
    const r = await api<DriverOption[]>('/api/drivers');
    if (r.ok && r.data) setDrivers(r.data.map(({ id, code, name, phone, active }) => ({ id, code, name, phone, active })));
  }, []);

  useEffect(() => {
    void loadDrivers();
  }, [loadDrivers]);

  // Try again after a failed load: the plan, and the driver list if it did not load either.
  const retry = () => {
    void load();
    if (!drivers.length) void loadDrivers();
  };
  // Off while a reload is on its way or an action runs (its own reload shows the plan).
  const retryOff = !!busy || reloading;

  // The screen around the plan asks for a reload (reloadSignal): the same, in place.
  const seenReload = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === seenReload.current) return;
    seenReload.current = reloadSignal;
    void load();
    if (!drivers.length) void loadDrivers();
  }, [reloadSignal, load, loadDrivers, drivers.length]);

  useEffect(() => {
    if (!d) return;
    const running = d.run.status === 'OPTIMIZING' || d.job?.status === 'QUEUED' || d.job?.status === 'RUNNING';
    if (!running) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [d, load]);

  const colorIdx = useMemo(() => {
    const m = new Map<string, number>();
    d?.loads.forEach((l) => {
      if (!m.has(l.truckId)) m.set(l.truckId, m.size);
    });
    return m;
  }, [d]);

  const trips = useMemo(() => tripsByTruck(d?.loads ?? []), [d]);
  const clashes = useMemo(() => driverClashNotes(d?.loads ?? []), [d]);

  // One action at a time: while any request of this plan runs (a load change, Lock all, Use
  // instead, Re-plan) and until the day shows its result, every other action is disabled, so one
  // user cannot race themselves (F07; plan-actions.ts).
  function setStatus(l: DetailLoad, status: string) {
    return runPlanAction(
      lock,
      l.id,
      async () => {
        const r = await api(`/api/runs/${runId}/loads/${l.id}`, { method: 'PATCH', json: { status } });
        if (!r.ok) {
          toast.error(r.error ?? 'Could not change the load.');
          await load(); // show the plan as it is now (it may have changed meanwhile)
          return;
        }
        toast.success(`${l.truckCode} Load ${l.loadNo}: ${status}`);
        await load();
        await onChanged?.();
      },
      failed,
    );
  }

  /**
   * Set the load's driver (the Driver list), or `keep` the driver RouteIQ filled in: the same
   * driver re-sent, which the server marks as the dispatcher's choice (a re-plan or "Use instead"
   * then keeps it on this truck and trip). The Driver list cannot do that: choosing the driver
   * already selected fires no change.
   */
  function setDriver(l: DetailLoad, driverId: string | null, keep = false) {
    return runPlanAction(
      lock,
      l.id,
      async () => {
        const r = await api(`/api/runs/${runId}/loads/${l.id}`, { method: 'PATCH', json: { driverId } });
        if (!r.ok) {
          toast.error(r.error ?? 'Could not set the driver.');
          // Show the driver the server has (the change may have been saved before the answer was
          // lost), or the out-of-date banner with Try again - never the old driver and its
          // WhatsApp link as if current (fourth review of PR3).
          await load();
          return;
        }
        const name = drivers.find((x) => x.id === driverId)?.name;
        if (keep) toast.success(`${l.truckCode} Load ${l.loadNo}: ${name ?? 'driver'} kept as your pick. Re-plans keep this driver on this trip.`);
        else toast.success(`${l.truckCode} Load ${l.loadNo}: ${name ? `driver ${name}` : 'no driver'}`);
        const fresh = await load();
        // Allowed, but a driver cannot be on two trucks at once: say so right away.
        const clash = fresh ? driverClashNotes(fresh.loads).find((c) => c.loadIds.includes(l.id)) : undefined;
        if (clash) toast.warning(clash.text);
      },
      failed,
    );
  }

  function lockAll() {
    if (!d) return;
    const planned = d.loads.filter((l) => l.status === 'PLANNED').sort((a, b) => a.loadNo - b.loadNo);
    return runPlanAction(
      lock,
      'all',
      async () => {
        let n = 0;
        let firstError: string | null = null;
        for (const l of planned) {
          const r = await api(`/api/runs/${runId}/loads/${l.id}`, { method: 'PATCH', json: { status: 'LOCKED' } });
          if (r.ok) n++;
          else firstError ??= r.error;
        }
        if (firstError && n < planned.length) toast.warning(`${n} of ${planned.length} load(s) locked. ${firstError}`);
        else toast.success(`${n} load(s) locked.`);
        await load();
        await onChanged?.();
      },
      failed,
    );
  }

  function chooseScenario(id: string, name: string) {
    return runPlanAction(
      lock,
      id,
      async () => {
        const r = await api<{ driversChanged?: number }>(`/api/runs/${runId}/choose-scenario`, { method: 'POST', json: { scenarioId: id } });
        const changed = r.data?.driversChanged ?? 0;
        if (!r.ok) toast.error(r.error ?? 'Could not switch.');
        else if (changed) toast.warning(`Now using the ${name} plan. ${changed} driver note(s): see the yellow notes on the plan.`);
        else toast.success(`Now using the ${name} plan.`);
        await load();
        await onChanged?.();
      },
      failed,
    );
  }

  /**
   * "Reset stuck plan" (audit F09, owner decision 17: supervisors and above, audited). Only offered
   * when the server says the version is stuck on "optimizing" (PlanDetail.stuck).
   */
  function resetStuck() {
    if (!window.confirm(STUCK_RESET_CONFIRM)) return;
    return runPlanAction(
      lock,
      'reset-stuck',
      async () => {
        const r = await api<{ status: string }>(`/api/runs/${runId}/reset-stuck`, { method: 'POST', json: {} });
        if (r.ok) toast.success('Plan reset: it is no longer optimizing. Optimize or re-plan it again.');
        else toast.error(r.error ?? 'Could not reset the plan.');
        await load();
        await onChanged?.();
      },
      failed,
    );
  }

  function replan(reason: 'LATE_ORDER' | 'REOPTIMIZE') {
    const expect = d ? { date: d.run.runDate, depotId: d.run.depot.id } : undefined;
    return runPlanAction(
      lock,
      'replan',
      async () => {
        let overrides: OptimizeOverrides = {};
        for (;;) {
          const r = await api<{ runId: string; version?: number; reason?: string; queued?: boolean }>(`/api/runs/${runId}/replan`, { method: 'POST', json: { reason, expect, ...overrides } });
          if (r.ok && r.data) {
            const how =
              r.data.reason === 'LATE_ORDER'
                ? 'Late order added; the other orders stay on their trucks where possible.'
                : 'Full re-optimize: orders may move to other trucks.';
            toast.success(
              `Plan version ${r.data.version ?? ''} is ${r.data.queued ? 'queued behind other optimizations' : 'being optimized'}. ${how} Locked and dispatched loads are kept; if the optimization fails, the previous plan stays in use.`,
            );
            await onChanged?.(r.data.runId);
            return;
          }
          // No location, or no weight: the same questions as OPTIMIZE on the day screen.
          const more = askOverride(r.errorBody, 'Re-plan', { canEditProducts });
          if (more) {
            overrides = { ...overrides, ...more };
            continue;
          }
          if (r.errorBody?.code !== 'LOCATION_REQUIRED' && r.errorBody?.code !== 'WEIGHT_REQUIRED') {
            toast.error(r.error ?? 'Re-plan failed.');
            // The plan may have changed meanwhile (superseded by another re-plan, a new version kept
            // after a refused start): reload it and the day instead of keeping stale buttons.
            await load();
          }
          // Not re-planned (also when a question was declined): the day as it is now - after a
          // late order, with the order waiting.
          await onChanged?.();
          return;
        }
      },
      failed,
    );
  }

  if (!d) {
    // Never loaded: the error alone, with Try again (a failed reload keeps the plan, below).
    return err ? (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm" data-testid="plan-load-error">
        <AlertTriangle className="h-4 w-4 text-red-700" />
        <span>Could not load the plan: {err}</span>
        <Button size="sm" variant="outline" onClick={retry} disabled={retryOff}>
          <RefreshCw className="mr-1 h-3 w-3" /> Try again
        </Button>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground">Loading plan…</p>
    );
  }

  const s = d.summary;
  const rec = d.reconciliation;
  const running = d.run.status === 'OPTIMIZING' || d.job?.status === 'QUEUED' || d.job?.status === 'RUNNING';
  // Replaced by a newer version: status SUPERSEDED, or supersededAt set (review F07).
  const superseded = isSupersededRun(d.run);
  // "Road km (3 legs estimated)" when some legs could not be routed on roads (review F18).
  const kmLabel = kmLabelFor({ distanceIsEstimated: !!s?.distanceIsEstimated, estimatedLegs: s?.estimatedLegs, estimatedLoads: s?.estimatedLoads });
  const kmShort = s?.distanceIsEstimated ? 'Estimated km' : 'Road km';
  // Every order is on a locked, loading or dispatched load, or was brought forward to a later day
  // (PR9: a load or unserved line holding only such orders is not work): a re-plan has nothing to plan.
  const nothingToPlan = nothingToReplan({ ...replanWork(d.loads, d.unserved), pendingOrders: d.pendingOrders ?? 1 });
  // Nothing to plan only because the rest was brought forward (the title says so, never "unlock a load").
  const onlyCarriedLeft = nothingToPlan && !nothingToReplan({ loadStatuses: d.loads.map((l) => l.status), unservedOrders: d.unserved.length, pendingOrders: d.pendingOrders ?? 1 });
  const applied = !!d.run.chosenScenario;
  // Review F04: the timetable check. With the gate on (the default), a truck whose times break a
  // rule cannot be locked, loaded or dispatched. The remedy is Re-plan - except for a problem on a
  // LOCKED or LOADING load, which a re-plan carries over unchanged: that load, and every later locked
  // or loading load of its truck (Unlock goes latest first), goes back to Planned first.
  const feas = d.feasibility ?? null;
  const gateOn = (d.feasibilityGate ?? 'enforce') === 'enforce';
  const blockingViolations = feas ? feas.violations.filter((v) => v.severity === 'BLOCK') : [];
  const timingWarnings = feas ? feas.violations.filter((v) => v.severity === 'WARN') : [];
  const planLoads = remedyLoads(d.loads);
  const remedy = timingRemedy(blockingViolations, planLoads);
  const replanOff = timingReplanOff(remedy, nothingToPlan);

  return (
    <div className="space-y-4" data-testid="plan-view">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">
            Plan v{d.run.version} · {d.run.depot.code} · {d.run.runDate}
          </h2>
          <Badge variant={superseded ? 'secondary' : d.run.status === 'FAILED' ? 'destructive' : d.run.status === 'DISPATCHED' ? 'success' : 'outline'}>{superseded ? 'SUPERSEDED' : d.run.status}</Badge>
          {d.run.reason !== 'INITIAL' ? <Badge variant="warning">{d.run.reason.replace('_', ' ')}</Badge> : null}
          {d.run.chosenScenario ? <Badge variant="secondary">{d.run.chosenScenario === 'RECOMMENDED' ? 'RECOMMENDED PLAN' : `${d.run.chosenScenario} (alternative)`}</Badge> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {/* The dispatch workbook for every dispatch plan, also one in which every order is unserved
              (no load): its UNSERVED, RECONCILIATION and ASSUMPTIONS sheets matter most then (audit F16). */}
          {d.isDispatchPlan || d.loads.length ? (
            <Button asChild variant="outline" size="sm">
              <a href={`/api/runs/${runId}/export/excel`} data-testid="export-excel">
                <Download className="mr-1 h-4 w-4" /> Export Excel
              </a>
            </Button>
          ) : null}
          {/* Driver sheets only: one per load, so none without loads. */}
          {d.loads.length ? (
            <Button asChild variant="outline" size="sm">
              <a href={`/api/runs/${runId}/export/pdf`} target="_blank" rel="noreferrer" data-testid="export-driver-pdf" title="One printable sheet per truck load, for the drivers">
                <FileText className="mr-1 h-4 w-4" /> Driver sheets (PDF)
              </a>
            </Button>
          ) : null}
          {canPlan && !superseded && d.run.chosenScenario ? (
            <>
              <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setLateOpen(true)}>
                <Plus className="mr-1 h-4 w-4" /> Late order
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy || running || nothingToPlan}
                onClick={() => replan('REOPTIMIZE')}
                data-testid="replan-btn"
                title={
                  onlyCarriedLeft
                    ? 'Nothing to plan: the orders still shown on Planned loads or as unserved were brought forward to a later day (they need nothing: they stay here for the record), and every other order is on a locked, loading or dispatched load. Add a late order to plan more.'
                    : nothingToPlan
                    ? canStepBack(d.loads.map((l) => l.status))
                      ? 'Nothing to plan: every order is on a locked, loading or dispatched load. Unlock a load (or add a late order) first.'
                      : 'Nothing to plan: every load has left the depot. Add a late order to plan more.'
                    : 'With a late order waiting: add it, keeping the other orders on their trucks where possible. Otherwise: re-optimize everything not locked, so orders may move to other trucks. Locked and dispatched loads never change.'
                }
              >
                <RefreshCw className="mr-1 h-4 w-4" /> Re-plan
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {err ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm" data-testid="plan-reload-error">
          <AlertTriangle className="h-4 w-4 text-red-700" />
          <span>{planReloadErrorText(err)}</span>
          <Button size="sm" variant="outline" onClick={retry} disabled={retryOff}>
            <RefreshCw className="mr-1 h-3 w-3" /> Try again
          </Button>
        </div>
      ) : null}
      {superseded ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">This version was replaced by a newer plan version. It is kept read-only for traceability.</div>
      ) : null}
      {running ? (
        <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="optimizing">
          Optimizing… {d.job?.message ?? ''} ({d.job?.progressPct ?? 0}%)
          {applied ? ' Until the new plan is saved, the loads below are the previous plan (kept if the optimization fails).' : ''}
          {d.stuck ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-amber-800" data-testid="plan-stuck">
              <AlertTriangle className="h-4 w-4" />
              <span>{d.stuck.text}</span>
              {canResetStuck && d.stuck.resettable ? (
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void resetStuck()} data-testid="reset-stuck-btn">
                  <RefreshCw className="mr-1 h-3 w-3" /> Reset stuck plan
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {d.run.status === 'FAILED' && !superseded ? (
        applied ? (
          // A failed re-plan: the version holds a copy of the previous plan (copy-forward, F03).
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm" data-testid="failed-plan-kept">
            <b>Optimization failed - previous plan kept.</b> {d.job?.message ?? ''} The loads below are the previous plan: they can be locked and dispatched as they are. Re-plan to try again.
          </div>
        ) : (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm">Optimization failed: {d.job?.message}</div>
        )
      ) : null}
      {feas && !feas.ok && !superseded && !running ? (
        <div className="space-y-1 rounded-md border border-red-400 bg-red-50 p-3 text-sm" data-testid="timing-violations">
          <p className="flex items-center gap-2 font-medium text-red-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Times not verified:{' '}
            {gateOn
              ? 'the trucks below cannot be locked, loaded or dispatched until this is fixed.'
              : 'the check is switched to warn only (FEASIBILITY_GATE=warn), so these trucks can still be dispatched - check each time with the drivers.'}
          </p>
          {blockingViolations.slice(0, 8).map((v, i) => (
            <p key={`${v.code}-${v.loadId ?? v.truckId ?? ''}-${i}`} className="text-red-800">
              <b>{v.truckCode ?? 'Plan'}{v.loadNo ? ` L${v.loadNo}` : ''}:</b> {v.message}
              {v.frozen ? <i> (locked or loading: a re-plan keeps it as it is)</i> : null}
            </p>
          ))}
          {blockingViolations.length > 8 ? <p className="text-red-800">… and {blockingViolations.length - 8} more (all listed in the Excel export).</p> : null}
          <p className="font-medium text-red-800" data-testid="timing-remedy">
            {remedy.text}
          </p>
          {canPlan && d.run.chosenScenario ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="destructive" disabled={!!busy || !!replanOff} onClick={() => replan('REOPTIMIZE')} data-testid="timing-replan-btn">
                <RefreshCw className="mr-1 h-4 w-4" /> Re-plan
              </Button>
              {replanOff ? (
                <span className="text-xs text-red-800" data-testid="timing-replan-off">
                  {replanOff}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {timingWarnings.length && !superseded ? (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="timing-warnings">
          {timingWarnings.slice(0, 6).map((v, i) => (
            <p key={`${v.code}-${v.loadId ?? ''}-${i}`} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              {v.message}
            </p>
          ))}
        </div>
      ) : null}
      {d.change ? (
        <div className="rounded-md border border-blue-300 bg-blue-50 p-3 text-sm" data-testid="change-summary">
          <b>Changes vs version {d.change.parentVersion}:</b> {d.change.text}.
        </div>
      ) : null}
      {d.warnings.length ? (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          {d.warnings.map((w) => (
            <p key={w} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              {w}
            </p>
          ))}
        </div>
      ) : null}
      {clashes.length && !superseded ? (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="driver-clashes">
          {clashes.map((c) => (
            <p key={c.loadIds.join()} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              {c.text} Pick another driver for one of them.
            </p>
          ))}
        </div>
      ) : null}

      {s ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8" data-testid="kpis">
          <Kpi label="Orders served" value={`${s.ordersServed} / ${s.totalOrders}${s.ordersPartial ? ` (+${s.ordersPartial} part)` : ''}`} />
          <Kpi label="Cases planned" value={`${s.casesServed.toLocaleString()} / ${s.totalCases.toLocaleString()}`} />
          <Kpi label="Trucks · loads" value={`${s.trucksUsed} · ${s.trips}`} />
          <Kpi label={kmLabel} value={s.totalKm.toLocaleString()} />
          <Kpi
            label="Hours on road · paid"
            value={`${s.onRoadHours ?? s.totalHours} · ${s.driverPaidHours ?? '—'}`}
            title="On the road: departure to return of each load. Paid: each truck's first departure to its last return (depot turnaround and waiting included), what driver cost is charged on."
          />
          <Kpi label="Avg utilization" value={`${s.avgUtilizationPct}%`} />
          <Kpi label="Fuel (l · OMR)" value={`${s.fuelLitres ?? '—'} · ${s.fuelCost.toFixed(1)}`} />
          <Kpi
            label="Operating cost OMR"
            value={`${s.operatingCost.toFixed(1)}${summaryCostBasis(s) === 'MIXED_LEGACY' ? ' *' : ''}`}
            title={
              s.costs
                ? `Fixed ${s.costs.fixed.toFixed(1)} + trip ${s.costs.trip.toFixed(1)} + distance ${s.costs.distance.toFixed(1)} + fuel ${s.costs.fuel.toFixed(1)} + driver ${s.costs.driver.toFixed(1)} + overtime ${s.costs.overtime.toFixed(1)}${s.costs.earlier ? ` + ${s.costs.earlier.toFixed(1)} costed the earlier way` : ''}. ${summaryCostBasis(s) === 'MIXED_LEGACY' ? `* ${COST_BASIS_TEXT.MIXED_LEGACY}` : `Driver ${COST_BASIS_TEXT.TRUCK_DAY_SPAN}.`}`
                : `* ${COST_BASIS_TEXT.MIXED_LEGACY}`
            }
            testId="kpi-operating-cost"
          />
          {Object.entries(s.serviceByPriority).map(([p, v]) => (
            <Kpi key={p} label={`${p} service`} value={v.pct === null ? '—' : `${v.pct}% (${v.served}/${v.orders})`} warn={v.pct !== null && v.pct < 100 && (p === 'P1' || p === 'P2')} />
          ))}
          <Kpi label="Late orders served" value={`${s.lateOrdersServed} / ${s.lateOrders}`} />
          <Kpi label="Revenue served" value={s.revenueServed === null ? 'not supplied' : s.revenueServed.toLocaleString()} />
          <Kpi label="Margin served" value={s.marginServed === null ? 'not supplied' : s.marginServed.toLocaleString()} />
        </div>
      ) : null}

      {rec ? (
        <div className={`rounded-md border p-3 text-sm ${rec.ok ? 'border-green-300 bg-green-50' : 'border-red-400 bg-red-50'}`} data-testid="reconciliation">
          <p className="flex items-center gap-2 font-medium">
            {rec.ok ? <CheckCircle2 className="h-4 w-4 text-green-700" /> : <AlertTriangle className="h-4 w-4 text-red-700" />}
            Cases reconcile: {rec.uploadedCases.toLocaleString()} uploaded = {rec.plannedCases.toLocaleString()} planned + {rec.unservedCases.toLocaleString()} unserved
            {rec.ok ? ` (checked per SKU (${rec.bySku.length}) and per sales order (${rec.bySalesOrder.length}))` : ' — MISMATCH'}
          </p>
          {rec.problems.slice(0, 8).map((p) => (
            <p key={p} className="text-red-800">
              {p}
            </p>
          ))}
          {d.carriedOut?.orders ? (
            <p className="mt-1 text-slate-700" data-testid="carried-out">
              {d.carriedOut.orders} order(s) ({d.carriedOut.cases.toLocaleString()} cases) of this plan were not delivered and were brought forward to{' '}
              {d.carriedOut.dates.map(fmtDayMonth).join(', ')}: they are planned on that day now (this plan keeps them as history, not as a problem).
            </p>
          ) : null}
          {d.carriedIn?.orders ? (
            <p className="mt-1 text-slate-700" data-testid="carried-in">
              {d.carriedIn.orders} order(s) ({d.carriedIn.cases.toLocaleString()} cases) were brought forward from {d.carriedIn.dates.map(fmtDayMonth).join(', ')} (not delivered that day).
            </p>
          ) : null}
        </div>
      ) : null}

      {d.scenarios.length > 1 ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Plan options (the recommended plan balances service, priorities, customer hours and cost)</CardTitle>
            <p className="text-xs text-muted-foreground">
              RECOMMENDED also values delivering P1/P2 customers early and inside their preferred hours (the preference cost); MIN TRUCKS and MIN DISTANCE ignore
              both. That is why it can cost more: the last column says what each option gains.
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs">
                <tr>
                  <th className="p-2">Option</th>
                  <th className="p-2" title="Physical trucks of the day with this option, the trucks of locked, loading and dispatched loads included.">
                    Trucks
                  </th>
                  <th className="p-2" title="Loads of the day with this option: the kept locked, loading and dispatched loads + its new loads.">
                    Loads
                  </th>
                  <th className="p-2" title="The whole day with this option: the locked, loading and dispatched loads kept as they are, plus this option's new loads.">
                    {kmShort}
                  </th>
                  <th className="p-2" title="The whole day with this option: the locked, loading and dispatched loads kept as they are, plus this option's new loads. Driver paid for the whole truck day, overtime included.">
                    Day cost OMR
                  </th>
                  <th
                    className="p-2"
                    title="What the recommended plan also values, in OMR-equivalent (not money): minutes outside preferred hours, P1/P2 delivered later in the day, and orders moved to another truck on a late-order re-plan. Only the recommended plan tries to keep it low."
                  >
                    Preference cost
                  </th>
                  <th className="p-2">Unserved</th>
                  <th className="p-2" title="The optimizer re-checked this option's timetable: loading time between loads, receiving hours, capacity, shift. An option that fails can be reviewed but its trucks cannot be dispatched.">
                    Timing checked
                  </th>
                  <th className="p-2" title="How long the route search ran, and how it ended. The search is time-limited: a plan is the best it found in that time.">
                    Search
                  </th>
                  <th className="p-2" title="What this option gains over the other options, and what it gives up; or that it is the same plan.">
                    What it gains
                  </th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {d.scenarios.map((sc) => (
                  <tr key={sc.id} className={sc.chosen ? 'bg-blue-50' : ''}>
                    <td className="p-2 font-medium">{sc.name === 'RECOMMENDED' ? 'RECOMMENDED' : sc.name.replace('_', ' ')}</td>
                    <td className="p-2" data-testid={`trucks-${sc.name}`}>
                      {sc.trucksUsed}
                    </td>
                    <td className="p-2">
                      {sc.trips + sc.frozenLoads}
                      {sc.frozenLoads ? (
                        <span className="ml-1 text-xs text-muted-foreground" title="New loads this option planned (the rest are kept locked, loading or dispatched loads)">
                          ({sc.trips} new)
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2" data-testid={`day-km-${sc.name}`}>
                      {sc.dayKm}
                      {Math.abs(sc.dayKm - sc.totalKm) >= 0.05 ? (
                        <span className="ml-1 text-xs text-muted-foreground" title="km of the new loads this option planned">
                          (new {sc.totalKm.toFixed(1)})
                        </span>
                      ) : null}
                      {sc.estimatedLegs ? <span className="ml-1 text-xs text-amber-700" title="Legs that could not be routed on roads use straight-line estimates">({sc.estimatedLegs} est.)</span> : null}
                    </td>
                    <td className="p-2" data-testid={`day-cost-${sc.name}`}>
                      {sc.dayOperatingCost.toFixed(1)}
                      {Math.abs(sc.dayOperatingCost - sc.operatingCost) >= 0.05 ? (
                        <span className="ml-1 text-xs text-muted-foreground" title="Cost of the new loads this option planned">
                          (new {sc.operatingCost.toFixed(1)})
                        </span>
                      ) : null}
                      {sc.costVersion ? null : (
                        <span className="ml-1 text-xs text-muted-foreground" title={COST_BASIS_TEXT.MIXED_LEGACY}>
                          *
                        </span>
                      )}
                    </td>
                    <td
                      className="p-2"
                      title={
                        sc.preference
                          ? `Preferred hours ${sc.preference.window.toFixed(1)} + early delivery ${sc.preference.early.toFixed(1)} + moved orders ${sc.preference.continuity.toFixed(1)}`
                          : 'Preferred hours only: an older optimizer made this option and did not report its early-delivery part, so this is not the whole preference cost'
                      }
                    >
                      {sc.preferenceCost !== null ? (
                        sc.preferenceCost.toFixed(1)
                      ) : sc.preferredHoursCost !== null ? (
                        <>
                          {sc.preferredHoursCost.toFixed(1)}
                          <span className="ml-1 text-xs text-muted-foreground">(hours only)</span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="p-2">{sc.unservedOrders}</td>
                    <td className="p-2 text-xs" data-testid={`timing-checked-${sc.name}`}>
                      {sc.status !== 'OPTIMIZED' ? (
                        '—'
                      ) : !sc.feasibility ? (
                        <span className="text-muted-foreground" title="Made before the optimizer checked its own times">not checked</span>
                      ) : sc.feasibility.status === 'VERIFIED' ? (
                        <span className="text-green-700">Yes</span>
                      ) : sc.feasibility.status === 'VIOLATED' ? (
                        <span className="font-medium text-red-700" title="Not dispatchable: re-plan, or choose another option">
                          No - {sc.feasibility.violations} rule(s) broken
                        </span>
                      ) : (
                        <span className="font-medium text-red-700" title="Not dispatchable: re-plan">Not verified</span>
                      )}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground" title={solverStatusText(sc.solverStatus)} data-testid={`solver-${sc.name}`}>
                      {sc.solverTimeSec}s · {solverStatusText(sc.solverStatus, 'short')}
                    </td>
                    <td className="min-w-[16rem] p-2 text-xs" data-testid={`tradeoff-${sc.name}`}>
                      {sc.tradeoff ?? '—'}
                    </td>
                    <td className="p-2 text-right">
                      {sc.chosen ? (
                        <Badge variant="success">In use</Badge>
                      ) : sc.status !== 'OPTIMIZED' ? (
                        // NO_SOLUTION (or nothing to plan): this option has no plan to use.
                        <span className="text-xs text-muted-foreground" title="This option found no plan; it cannot be used.">
                          No plan
                        </span>
                      ) : canPlan && !superseded ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!busy || running}
                          onClick={() => chooseScenario(sc.id, sc.name)}
                          title={sc.feasibility && sc.feasibility.status !== 'VERIFIED' ? 'Its times break a rule: it can be reviewed, but its trucks cannot be dispatched.' : undefined}
                        >
                          Use instead
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Truck className="h-4 w-4" /> Truck loads ({d.loads.length})
          </CardTitle>
          {canPlan && !superseded && applied && d.loads.some((l) => l.status === 'PLANNED') ? (
            <Button size="sm" variant="outline" disabled={!!busy || running} onClick={lockAll}>
              <Lock className="mr-1 h-4 w-4" /> Lock all loads
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm" data-testid="loads-table">
            <thead className="bg-muted/50 text-left text-xs">
              <tr>
                <th className="p-2" />
                <th className="p-2">Truck · load</th>
                <th className="p-2">Driver · sheet</th>
                <th className="p-2">Status</th>
                <th className="p-2">Depart → return</th>
                <th className="p-2">Stops</th>
                <th className="p-2">Cases / capacity</th>
                <th className="p-2">Util.</th>
                <th className="p-2">{kmShort}</th>
                <th className="p-2">Time</th>
                <th className="p-2">Fuel l</th>
                <th className="p-2">Cost</th>
                <th className="p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {d.loads.map((l) => (
                <Fragment key={l.id}>
                  <tr className="cursor-pointer border-t hover:bg-muted/30" onClick={() => { setOpen({ ...open, [l.id]: !open[l.id] }); setSelectedLoad(open[l.id] ? null : l.id); }}>
                    <td className="p-2">{open[l.id] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                    <td className="p-2 font-medium">
                      {l.truckCode} · L{l.loadNo}
                    </td>
                    <td className="p-2" onClick={(e) => e.stopPropagation()}>
                      <LoadDriver
                        l={l}
                        drivers={drivers}
                        editable={canPlan && !superseded && !running && !ON_ROAD.has(l.status)}
                        busy={!!busy}
                        onChange={(id) => setDriver(l, id)}
                        onKeep={() => setDriver(l, l.driverId, true)}
                        pdfUrl={`/api/runs/${runId}/export/pdf?load=${l.id}`}
                        clash={clashes.find((c) => c.loadIds.includes(l.id))?.text ?? null}
                        whatsapp={
                          superseded
                            ? { off: 'This plan version was replaced: send the trip from the latest version.' }
                            : running
                              ? { off: 'Wait for the optimization to finish: the trips are about to change.' }
                              : {
                                  url: whatsappUrl(l.driverPhone, whatsappText(d.run, l, trips.get(l.truckId) ?? l.loadNo), phoneCountryCode),
                                  number: whatsappNumber(l.driverPhone, phoneCountryCode),
                                }
                        }
                      />
                    </td>
                    <td className="p-2">
                      <Badge variant={STATUS_VARIANT[l.status] ?? 'outline'} data-testid={`load-status-${l.truckCode}-${l.loadNo}`}>
                        {l.status}
                      </Badge>
                      {l.carried ? <span className="ml-1 text-xs text-muted-foreground">kept</span> : null}
                      {l.carriedAway ? (
                        <Badge
                          variant="warning"
                          className="ml-1"
                          data-testid={`load-carried-away-${l.truckCode}-${l.loadNo}`}
                          title={carriedLoadTitle(l, d, today)}
                        >
                          {l.carriedAway} order(s) carried over
                        </Badge>
                      ) : null}
                      {l.timing && !l.timing.ok ? (
                        <Badge
                          variant="destructive"
                          className="ml-1"
                          data-testid={`load-timing-${l.truckCode}-${l.loadNo}`}
                          title={loadTimingTitle(l, blockingViolations, planLoads)}
                        >
                          Times not verified
                        </Badge>
                      ) : null}
                      {l.masterChanged.length || l.stops.some((st) => st.masterChanged.length) ? (
                        <Badge
                          variant="warning"
                          className="ml-1"
                          data-testid={`load-master-changed-${l.truckCode}-${l.loadNo}`}
                          title={[...l.masterChanged, ...l.stops.flatMap((st) => st.masterChanged)].map((c) => c.text).join('\n')}
                        >
                          Changed after planning
                        </Badge>
                      ) : null}
                    </td>
                    <td className="p-2">
                      {hhmm(l.departMin)} → {hhmm(l.returnMin)}
                    </td>
                    <td className="p-2">{l.stops.length}</td>
                    <td className="p-2">
                      {l.cases} / {l.truckCapacityCases}
                    </td>
                    <td className="p-2">{l.utilizationPct}%</td>
                    <td className="p-2">{l.distanceKm}</td>
                    <td className="p-2">{durH(l.durationMin)}</td>
                    <td className="p-2">{l.fuelLitres ?? '—'}</td>
                    <td
                      className="p-2"
                      title={
                        l.cost
                          ? `Fixed ${l.cost.fixed.toFixed(2)} + trip ${l.cost.trip.toFixed(2)} + distance ${l.cost.distance.toFixed(2)} + fuel ${l.cost.fuel.toFixed(2)} + driver ${l.cost.driver.toFixed(2)} (${durH(l.cost.driverPaidMin)} paid, from the truck's previous return) + overtime ${l.cost.overtime.toFixed(2)}`
                          : COST_BASIS_TEXT.MIXED_LEGACY
                      }
                    >
                      {l.operatingCost.toFixed(1)}
                      {l.cost ? null : ' *'}
                      {l.distanceIsEstimated && !s?.distanceIsEstimated ? (
                        <span className="ml-1 text-xs text-amber-700" title="Some legs of this load use straight-line estimates">
                          est. km
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2" onClick={(e) => e.stopPropagation()}>
                      {!superseded ? (
                        <LoadActions
                          l={l}
                          busy={!!busy || running}
                          applied={applied}
                          canPlan={canPlan}
                          canDispatch={canDispatch}
                          reconOk={!!rec?.ok}
                          timingBlocked={gateOn && !!l.timing && !l.timing.ok}
                          onStatus={(st) => setStatus(l, st)}
                        />
                      ) : null}
                    </td>
                  </tr>
                  {open[l.id] ? (
                    <tr className="bg-muted/20">
                      <td colSpan={13} className="p-3">
                        <LoadDetail l={l} depotCode={d.run.depot.code} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
              {d.loads.length === 0 ? (
                <tr>
                  <td colSpan={13} className="p-4 text-center text-muted-foreground">
                    No loads yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Unserved orders ({new Set(d.unserved.map((u) => u.orderId)).size})</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {d.unserved.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">Every order is planned.</p>
          ) : (
            <table className="w-full text-sm" data-testid="unserved-table">
              <thead className="bg-muted/50 text-left text-xs">
                <tr>
                  <th className="p-2">Customer</th>
                  <th className="p-2">Priority</th>
                  <th className="p-2">Cases</th>
                  <th className="p-2">Sales orders</th>
                  <th className="p-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {d.unserved.map((u) => (
                  <tr key={`${u.orderId}-${u.reasonCode}`} className="border-t">
                    <td className="p-2">
                      {u.customerName} <span className="text-xs text-muted-foreground">{u.customerCode}{u.branchCode ? ` / ${u.branchCode}` : ''}</span>
                      {u.late ? <Badge variant="warning" className="ml-1">LATE</Badge> : null}
                      {u.partial ? <Badge variant="secondary" className="ml-1" title="The rest of this order is on a truck">REST OF SPLIT</Badge> : null}
                      {u.carriedFrom ? (
                        <Badge variant="secondary" className="ml-1" data-testid="unserved-carried-from">
                          {carriedFromBadge(u.carriedFrom)}
                        </Badge>
                      ) : null}
                    </td>
                    <td className="p-2">P{u.priority}</td>
                    <td className="p-2">{u.cases}</td>
                    <td className="p-2 text-xs">{u.salesOrders.join(', ') || '—'}</td>
                    <td className="p-2">
                      {u.carriedTo ? (
                        <>
                          <b data-testid="unserved-carried-to">{carriedToBadge(u.carriedTo)}</b>
                          <span className="block text-xs text-muted-foreground">
                            Planned on that day now. Unserved here: {REASON_TEXT[u.reasonCode] ?? u.reasonCode}
                          </span>
                        </>
                      ) : (
                        <>
                          <b>{REASON_TEXT[u.reasonCode] ?? u.reasonCode}</b>
                          <span className="block text-xs text-muted-foreground">{u.reasonMessage}</span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {d.loads.length ? (
        <PlanMap
          runId={runId}
          depot={{ lat: d.run.depot.lat, lng: d.run.depot.lng, name: d.run.depot.name }}
          selectedLoadId={selectedLoad}
          // The road shapes answer is for loads other than these (the plan changed on the server): reload.
          onStale={load}
          loads={d.loads.map((l) => ({
            id: l.id,
            truckCode: l.truckCode,
            loadNo: l.loadNo,
            colorIdx: colorIdx.get(l.truckId) ?? 0,
            // Audit E1: drawn from the depot pin the load was planned from.
            origin: l.origin,
            stops: l.stops.map((st) => ({ sequence: st.sequence, lat: st.lat, lng: st.lng, label: `${st.customerName} (${st.cases} cs${st.split ? `, part ${st.split.part}/${st.split.parts}` : ''})` })),
          }))}
          unserved={[]}
        />
      ) : null}

      {d.versions.length > 1 && showVersionLink ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4" /> Plan versions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {d.versions.map((v) => (
              <p key={v.id}>
                <Link className="font-medium underline-offset-2 hover:underline" href={`/t/${slug}/dispatch/plan/${v.id}`}>
                  Version {v.version}
                </Link>{' '}
                · {v.reason.replace('_', ' ')} · {v.status} · {new Date(v.createdAt).toLocaleString()}
                {v.changeText ? <span className="text-muted-foreground"> — {v.changeText}</span> : null}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <LateOrderDialog
        open={lateOpen}
        onOpenChange={setLateOpen}
        date={d.run.runDate}
        depotId={d.run.depot.id}
        onSaved={(res) =>
          // Re-plan now, or reload the day - never the day first: that replaced this plan screen
          // before the re-plan took the busy state (plan-actions.ts).
          void afterLateOrderSaved(res, {
            warn: (m) => toast.warning(m),
            weightFix: weightFixText(canEditProducts),
            confirmReplan: () => window.confirm('Late order saved. Re-plan now? Locked and dispatched loads stay exactly as they are.'),
            replan: async () => {
              await replan('LATE_ORDER');
            },
            refresh: async () => {
              await runPlanAction(
                lock,
                'late-order',
                async () => {
                  await load();
                  await onChanged?.();
                },
                failed,
              );
            },
          })
        }
      />
    </div>
  );
}

function Kpi({ label, value, warn, title, testId }: { label: string; value: string; warn?: boolean; title?: string; testId?: string }) {
  return (
    <div className={`rounded-md border p-2 ${warn ? 'border-amber-400 bg-amber-50' : 'bg-card'}`} title={title} data-testid={testId}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  );
}

function LoadDriver({
  l,
  drivers,
  editable,
  busy,
  onChange,
  onKeep,
  pdfUrl,
  clash,
  whatsapp,
}: {
  l: DetailLoad;
  drivers: DriverOption[];
  editable: boolean;
  busy: boolean;
  onChange: (driverId: string | null) => void;
  /** Keep the driver RouteIQ filled in as the dispatcher's own pick. */
  onKeep: () => void;
  pdfUrl: string;
  /** This load's driver is also on another truck at the same time. */
  clash: string | null;
  /** The message link, or why there is none (replaced version, optimization running). */
  whatsapp: { off: string } | { url: string; number: string | null };
}) {
  const tag = `${l.truckCode}-${l.loadNo}`;
  // Active drivers, plus the one on the load if they were deactivated since.
  const options = drivers.filter((x) => x.active || x.id === l.driverId);
  if (l.driverId && !options.some((x) => x.id === l.driverId)) {
    options.push({ id: l.driverId, code: '', name: l.driverName ?? 'Unknown driver', phone: l.driverPhone, active: false });
  }
  const current = drivers.find((x) => x.id === l.driverId);
  const driverName = l.driverName ?? current?.name ?? 'this driver';
  // "picked by hand", or the Keep link exactly when the server marks the re-sent driver (driverPickLink).
  const pick = driverPickLink(l, { editable, driverActive: !!current?.active });
  let waTitle = '';
  if ('url' in whatsapp) {
    if (!l.driverPhone) waTitle = 'No phone for this driver: WhatsApp asks who to send it to';
    else if (!whatsapp.number) waTitle = `Phone ${l.driverPhone} has no country code: pick the chat in WhatsApp (save the phone as +<country code> <number> under Drivers)`;
    else waTitle = `Send the stops to ${l.driverName ?? 'the driver'} on WhatsApp (+${whatsapp.number})`;
  }
  return (
    <div className="space-y-1">
      <select
        className={`h-7 w-40 rounded-md border px-1 text-xs disabled:opacity-70 ${clash ? 'border-amber-500 bg-amber-50' : 'bg-background'}`}
        value={l.driverId ?? ''}
        disabled={!editable || busy}
        title={ON_ROAD.has(l.status) ? 'The load has left: the driver cannot change any more.' : (clash ?? undefined)}
        onChange={(e) => onChange(e.target.value || null)}
        data-testid={`driver-select-${tag}`}
      >
        <option value="">No driver</option>
        {options.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
            {x.active ? '' : ' (inactive)'}
          </option>
        ))}
      </select>
      <div className="flex gap-2 text-xs">
        <a className="text-primary underline-offset-2 hover:underline" href={pdfUrl} target="_blank" rel="noreferrer" data-testid={`load-pdf-${tag}`} title="Driver sheet for this load">
          PDF
        </a>
        {'url' in whatsapp ? (
          <a className="text-primary underline-offset-2 hover:underline" href={whatsapp.url} target="_blank" rel="noreferrer" data-testid={`load-whatsapp-${tag}`} title={waTitle}>
            WhatsApp
          </a>
        ) : (
          <span className="cursor-not-allowed text-muted-foreground" aria-disabled="true" data-testid={`load-whatsapp-${tag}`} title={whatsapp.off}>
            WhatsApp
          </span>
        )}
        {/* Who chose the driver: a re-plan or "Use instead" keeps a driver picked by hand on this
            truck and trip; Keep makes one RouteIQ filled in the dispatcher's pick. */}
        {pick === 'HAND_SET' ? (
          <span className="text-muted-foreground" data-testid={`driver-handset-${tag}`} title={`Picked by hand: a re-plan or Use instead keeps ${driverName} on this truck and trip.`}>
            picked by hand
          </span>
        ) : pick === 'KEEP' ? (
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy}
            onClick={onKeep}
            data-testid={`driver-keep-${tag}`}
            title={`RouteIQ filled in ${driverName}. Keep makes ${driverName} your pick: a re-plan or Use instead then keeps ${driverName} on this truck and trip.`}
          >
            Keep
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The load's "Times not verified" tooltip. A load that itself breaks a rule while locked or loading
 * says which loads go back to Planned first: it and every later locked or loading load of its
 * truck, latest first (Unlock is refused while a later load of the truck is frozen).
 */
function loadTimingTitle(l: DetailLoad, blocking: PlanViolation[], loads: RemedyLoad[]): string {
  const base = TIMING_TEXT[l.timing!.status];
  const own = timingRemedy(
    blocking.filter((v) => v.loadId === l.id),
    loads,
  );
  return own.unlockFirst.length ? `${base}: this load breaks a rule and a re-plan keeps it as it is - ${unlockFirstText(own.unlockFirst)}, then re-plan.` : base;
}

function LoadActions({
  l,
  busy,
  applied,
  canPlan,
  canDispatch,
  reconOk,
  timingBlocked,
  onStatus,
}: {
  l: DetailLoad;
  busy: boolean;
  /** The version has an optimized plan; without one only Unlock, Back to locked and Completed are offered. */
  applied: boolean;
  canPlan: boolean;
  canDispatch: boolean;
  reconOk: boolean;
  /** Review F04: this truck's times break a rule - Lock, Loading and Dispatch wait until it is fixed. */
  timingBlocked: boolean;
  onStatus: (s: string) => void;
}) {
  const timingTitle = !reconOk
    ? 'Cases must reconcile first'
    : timingBlocked
      ? "This truck's times break a planning rule: the red box above says what to do (re-plan, or first put a locked load back to Planned)"
      : undefined;
  const canFreeze = reconOk && !timingBlocked;
  const b = (label: string, to: string, icon: React.ReactNode, enabled = true, title?: string) => (
    <Button key={to} size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy || !enabled} title={title} onClick={() => onStatus(to)} data-testid={`act-${to}-${l.truckCode}-${l.loadNo}`}>
      {icon}
      {label}
    </Button>
  );
  const out: React.ReactNode[] = [];
  if (!applied) {
    // No optimized plan on this version (left by a failed re-plan before the stabilization
    // release): only the way back, so the day can be optimized again, and closing loads already out.
    if (l.status === 'LOCKED' && canPlan) out.push(b('Unlock', 'PLANNED', <Unlock className="mr-1 h-3 w-3" />));
    if (l.status === 'LOADING' && canPlan) out.push(b('Back to locked', 'LOCKED', <Lock className="mr-1 h-3 w-3" />));
    if (l.status === 'DISPATCHED' && canDispatch) out.push(b('Completed', 'COMPLETED', <Flag className="mr-1 h-3 w-3" />));
    return <div className="flex flex-wrap gap-1">{out}</div>;
  }
  if (l.status === 'PLANNED' && canPlan) out.push(b('Lock', 'LOCKED', <Lock className="mr-1 h-3 w-3" />, canFreeze, timingTitle));
  if (l.status === 'LOCKED' && canPlan) {
    out.push(b('Unlock', 'PLANNED', <Unlock className="mr-1 h-3 w-3" />));
    out.push(b('Loading', 'LOADING', <PackageCheck className="mr-1 h-3 w-3" />, canFreeze, timingTitle));
  }
  if (l.status === 'LOADING' && canPlan) out.push(b('Back to locked', 'LOCKED', <Lock className="mr-1 h-3 w-3" />));
  if ((l.status === 'LOCKED' || l.status === 'LOADING') && canDispatch) {
    out.push(b('Dispatch', 'DISPATCHED', <Send className="mr-1 h-3 w-3" />, canFreeze, timingTitle));
  }
  if (l.status === 'DISPATCHED' && canDispatch) out.push(b('Completed', 'COMPLETED', <Flag className="mr-1 h-3 w-3" />));
  return <div className="flex flex-wrap gap-1">{out}</div>;
}

function LoadDetail({ l, depotCode }: { l: DetailLoad; depotCode: string }) {
  // A6 second review: an older version whose orders a later re-plan re-weighed says so (as its Excel sheet does).
  const kgNote = manifestKgNote(l);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Loading manifest</p>
        <table className="w-full text-xs" data-testid={`manifest-${l.truckCode}-${l.loadNo}`}>
          <tbody>
            {l.manifest.map((m) => (
              <tr key={m.productCode} className="border-b">
                <td className="py-1 pr-2 font-mono">{m.productCode}</td>
                <td className="py-1 pr-2">{m.productName}</td>
                <td className="py-1 text-right font-semibold">{m.cases}</td>
                {/* Audit E3 (A6 review): each product's kg, which add up to the load's kg (to 0.1 kg). */}
                <td className="py-1 pl-2 text-right text-muted-foreground">{kgText(m.weightKg)} kg</td>
              </tr>
            ))}
            <tr>
              <td colSpan={2} className="py-1 font-semibold">
                TOTAL
              </td>
              <td className="py-1 text-right font-semibold">{l.cases}</td>
              <td className="py-1 pl-2 text-right font-semibold">{kgText(l.weightKg)} kg</td>
            </tr>
          </tbody>
        </table>
        {kgNote ? (
          <p className="mt-1 text-xs text-amber-700" data-testid={`manifest-kg-note-${l.truckCode}-${l.loadNo}`}>
            {kgNote}
          </p>
        ) : null}
      </div>
      <div className="lg:col-span-2">
        <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Delivery route</p>
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1">#</th>
              <th>Customer</th>
              <th>P</th>
              <th>ETA</th>
              <th>Window</th>
              <th>Svc</th>
              <th>Cases</th>
              <th>SKUs</th>
              <th>km</th>
              <th>cum km</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="py-1">—</td>
              <td colSpan={9}>
                DEPOT {depotCode} — depart {hhmm(l.departMin)}
              </td>
            </tr>
            {l.stops.map((st) => (
              <tr key={st.sequence} className="border-b align-top">
                <td className="py-1">{st.sequence}</td>
                <td>
                  {st.mapsUrl ? (
                    <a className="hover:underline" href={st.mapsUrl} target="_blank" rel="noreferrer">
                      {st.customerName}
                    </a>
                  ) : (
                    st.customerName
                  )}
                  <span className="block text-muted-foreground">
                    {st.customerCode}
                    {st.branchCode ? ` / ${st.branchCode}` : ''} {st.customerType ? `· ${st.customerType}` : ''}
                    {st.late ? ' · LATE' : ''}
                  </span>
                  {st.split ? (
                    <Badge variant="secondary" className="mt-0.5" data-testid="split-part" title="Customer bigger than one truck: delivered in parts">
                      Part {st.split.part} of {st.split.parts}
                      {st.split.restUnserved ? ' · rest unserved' : ''}
                    </Badge>
                  ) : null}
                  {st.carriedFrom ? (
                    <Badge variant="warning" className="mt-0.5" data-testid="stop-carried-from" title="Not delivered on the day it was due: brought forward to this day. Its priority is kept as it was.">
                      {carriedFromBadge(st.carriedFrom)}
                    </Badge>
                  ) : null}
                  {st.carriedTo ? (
                    <Badge variant="secondary" className="mt-0.5" data-testid="stop-carried-to" title="Brought forward to a later day: planned there, not delivered on this day.">
                      {carriedToBadge(st.carriedTo)}
                    </Badge>
                  ) : null}
                  {st.masterChanged.length ? (
                    <span className="mt-0.5 block text-amber-700" data-testid="stop-master-changed">
                      {st.masterChanged.map((c) => c.text).join(' · ')}
                    </span>
                  ) : null}
                  {!st.snapshot ? <span className="block text-muted-foreground" title="Planned before stop details were kept with the plan">current customer data</span> : null}
                </td>
                <td>P{st.priority}</td>
                <td className={st.hardWindowOk === false ? 'text-red-600' : ''}>
                  {hhmm(st.etaMin)}
                  {st.waitMin ? <span className="block text-muted-foreground">wait {st.waitMin}m</span> : null}
                </td>
                <td className={st.prefWindowOk === false ? 'text-amber-700' : ''}>{st.window}</td>
                <td>{st.serviceMin}m</td>
                <td>{st.cases}</td>
                <td className="max-w-[220px]">{st.skus.map((k) => `${k.productCode} ×${k.cases}`).join('; ')}</td>
                <td>{st.legKm}</td>
                <td>{st.cumulativeKm ?? '—'}</td>
              </tr>
            ))}
            <tr>
              <td className="py-1">—</td>
              <td colSpan={9}>
                DEPOT — return {hhmm(l.returnMin)} (+{l.returnLegKm} km)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
