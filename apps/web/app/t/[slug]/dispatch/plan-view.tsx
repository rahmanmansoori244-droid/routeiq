'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, FileText, History, Lock, Truck, Unlock, PackageCheck, Send, Flag, RefreshCw, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { driverClashNotes, tripsByTruck, whatsappNumber, whatsappText, whatsappUrl } from '@/lib/dispatch/driver-links';
import type { PlanDetail, DetailLoad } from '@/lib/dispatch/plan-detail';
import { TIMING_TEXT } from '@/lib/dispatch/feasibility-view';
import { isSupersededRun, nothingToReplan } from '@/lib/dispatch/plan-status';
import { canStepBack } from '@/lib/dispatch/load-state';
import { api, askOverride, durH, hhmm, REASON_TEXT, weightFixText, type OptimizeOverrides } from './client-api';
import { LateOrderDialog } from './late-order-dialog';

const PlanMap = dynamic(() => import('@/components/plan-map').then((m) => m.PlanMap), { ssr: false });

const STATUS_VARIANT: Record<string, 'outline' | 'secondary' | 'warning' | 'success' | 'destructive' | 'default'> = {
  PLANNED: 'outline',
  LOCKED: 'secondary',
  LOADING: 'warning',
  DISPATCHED: 'success',
  COMPLETED: 'default',
};

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
  /** called after anything that changes the day (late order, replan, status) */
  onChanged?: (newRunId?: string) => void;
  showVersionLink?: boolean;
  /** Calling code added to drivers' phones saved without one (WhatsApp links); null = unknown. */
  phoneCountryCode?: string | null;
  /** A request of the screen around this plan is running (the day screen's OPTIMIZE / RE-PLAN): every action here waits. */
  externalBusy?: boolean;
  /** Told when an action of this plan starts (true) and ends (false), so the screen around it waits too. */
  onBusyChange?: (busy: boolean) => void;
}

export function PlanView({ slug, runId, canPlan, canDispatch, canEditProducts = false, onChanged, showVersionLink = true, phoneCountryCode = null, externalBusy = false, onBusyChange }: Props) {
  const [d, setD] = useState<PlanDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [ownBusy, setBusy] = useState<string | null>(null);
  // One action at a time across the whole day screen (F07): this plan's own request, or the day
  // screen's OPTIMIZE / RE-PLAN request around it.
  const busy = ownBusy ?? (externalBusy ? 'external' : null);
  const [lateOpen, setLateOpen] = useState(false);
  const [selectedLoad, setSelectedLoad] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<DriverOption[]>([]);

  const load = useCallback(async () => {
    const r = await api<PlanDetail>(`/api/runs/${runId}/plan`);
    if (!r.ok || !r.data) {
      setErr(r.error ?? 'Could not load the plan');
      return null;
    }
    setErr(null);
    setD(r.data);
    return r.data;
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onBusyChange?.(ownBusy !== null);
  }, [ownBusy, onBusyChange]);
  // Unmounted mid-action (the day reloads the plan): never leave the day screen waiting.
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    void api<DriverOption[]>('/api/drivers').then((r) => {
      if (r.ok && r.data) setDrivers(r.data.map(({ id, code, name, phone, active }) => ({ id, code, name, phone, active })));
    });
  }, []);

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
  // instead, Re-plan), every other action is disabled, so one user cannot race themselves (F07).
  async function setStatus(l: DetailLoad, status: string) {
    if (busy) return;
    setBusy(l.id);
    const r = await api(`/api/runs/${runId}/loads/${l.id}`, { method: 'PATCH', json: { status } });
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error ?? 'Could not change the load.');
      await load(); // show the plan as it is now (it may have changed meanwhile)
      return;
    }
    toast.success(`${l.truckCode} Load ${l.loadNo}: ${status}`);
    await load();
    onChanged?.();
  }

  async function setDriver(l: DetailLoad, driverId: string | null) {
    if (busy) return;
    setBusy(l.id);
    const r = await api(`/api/runs/${runId}/loads/${l.id}`, { method: 'PATCH', json: { driverId } });
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error ?? 'Could not set the driver.');
      return;
    }
    const name = drivers.find((x) => x.id === driverId)?.name;
    toast.success(`${l.truckCode} Load ${l.loadNo}: ${name ? `driver ${name}` : 'no driver'}`);
    const fresh = await load();
    // Allowed, but a driver cannot be on two trucks at once: say so right away.
    const clash = fresh ? driverClashNotes(fresh.loads).find((c) => c.loadIds.includes(l.id)) : undefined;
    if (clash) toast.warning(clash.text);
  }

  async function lockAll() {
    if (!d || busy) return;
    setBusy('all');
    const planned = d.loads.filter((l) => l.status === 'PLANNED').sort((a, b) => a.loadNo - b.loadNo);
    let n = 0;
    let firstError: string | null = null;
    for (const l of planned) {
      const r = await api(`/api/runs/${runId}/loads/${l.id}`, { method: 'PATCH', json: { status: 'LOCKED' } });
      if (r.ok) n++;
      else firstError ??= r.error;
    }
    setBusy(null);
    if (firstError && n < planned.length) toast.warning(`${n} of ${planned.length} load(s) locked. ${firstError}`);
    else toast.success(`${n} load(s) locked.`);
    await load();
    onChanged?.();
  }

  async function chooseScenario(id: string, name: string) {
    if (busy) return;
    setBusy(id);
    const r = await api(`/api/runs/${runId}/choose-scenario`, { method: 'POST', json: { scenarioId: id } });
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error ?? 'Could not switch.');
      await load();
      onChanged?.();
      return;
    }
    toast.success(`Now using the ${name} plan.`);
    await load();
    onChanged?.();
  }

  async function replan(reason: 'LATE_ORDER' | 'REOPTIMIZE', overrides: OptimizeOverrides = {}) {
    if (busy && busy !== 'replan') return;
    setBusy('replan');
    const expect = d ? { date: d.run.runDate, depotId: d.run.depot.id } : undefined;
    const r = await api<{ runId: string; version?: number; reason?: string; queued?: boolean }>(`/api/runs/${runId}/replan`, { method: 'POST', json: { reason, expect, ...overrides } });
    if (!r.ok || !r.data) {
      // No location, or no weight: the same questions as OPTIMIZE on the day screen.
      const more = askOverride(r.errorBody, 'Re-plan', { canEditProducts });
      if (more) return replan(reason, { ...overrides, ...more });
      setBusy(null);
      if (r.errorBody?.code === 'LOCATION_REQUIRED' || r.errorBody?.code === 'WEIGHT_REQUIRED') return;
      toast.error(r.error ?? 'Re-plan failed.');
      // The plan may have changed meanwhile (superseded by another re-plan, a new version kept
      // after a refused start): reload it and the day instead of keeping stale buttons.
      await load();
      onChanged?.();
      return;
    }
    setBusy(null);
    const how =
      r.data.reason === 'LATE_ORDER'
        ? 'Late order added; the other orders stay on their trucks where possible.'
        : 'Full re-optimize: orders may move to other trucks.';
    toast.success(
      `Plan version ${r.data.version ?? ''} is ${r.data.queued ? 'queued behind other optimizations' : 'being optimized'}. ${how} Locked and dispatched loads are kept; if the optimization fails, the previous plan stays in use.`,
    );
    onChanged?.(r.data.runId);
  }

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!d) return <p className="text-sm text-muted-foreground">Loading plan…</p>;

  const s = d.summary;
  const rec = d.reconciliation;
  const running = d.run.status === 'OPTIMIZING' || d.job?.status === 'QUEUED' || d.job?.status === 'RUNNING';
  // Replaced by a newer version: status SUPERSEDED, or supersededAt set (review F07).
  const superseded = isSupersededRun(d.run);
  const kmLabel = s?.distanceIsEstimated ? 'Estimated km' : 'Road km';
  // Every order is on a locked, loading or dispatched load: a re-plan would have nothing to plan.
  const nothingToPlan = nothingToReplan({ loadStatuses: d.loads.map((l) => l.status), unservedOrders: d.unserved.length, pendingOrders: d.pendingOrders ?? 1 });
  const applied = !!d.run.chosenScenario;
  // Review F04: the timetable check. With the gate on (the default), a truck whose times break a
  // rule cannot be locked, loaded or dispatched; the remedy is Re-plan.
  const feas = d.feasibility ?? null;
  const gateOn = (d.feasibilityGate ?? 'enforce') === 'enforce';
  const blockingViolations = feas ? feas.violations.filter((v) => v.severity === 'BLOCK') : [];
  const timingWarnings = feas ? feas.violations.filter((v) => v.severity === 'WARN') : [];

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
          {d.loads.length ? (
            <>
              <Button asChild variant="outline" size="sm">
                <a href={`/api/runs/${runId}/export/excel`} data-testid="export-excel">
                  <Download className="mr-1 h-4 w-4" /> Export Excel
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={`/api/runs/${runId}/export/pdf`} target="_blank" rel="noreferrer" data-testid="export-driver-pdf" title="One printable sheet per truck load, for the drivers">
                  <FileText className="mr-1 h-4 w-4" /> Driver sheets (PDF)
                </a>
              </Button>
            </>
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
                  nothingToPlan
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

      {superseded ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">This version was replaced by a newer plan version. It is kept read-only for traceability.</div>
      ) : null}
      {running ? (
        <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="optimizing">
          Optimizing… {d.job?.message ?? ''} ({d.job?.progressPct ?? 0}%)
          {applied ? ' Until the new plan is saved, the loads below are the previous plan (kept if the optimization fails).' : ''}
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
              ? 'the trucks below cannot be locked, loaded or dispatched until the day is re-planned.'
              : 'the check is switched to warn only (FEASIBILITY_GATE=warn), so these trucks can still be dispatched - check each time with the drivers.'}
          </p>
          {blockingViolations.slice(0, 8).map((v, i) => (
            <p key={`${v.code}-${v.loadId ?? v.truckId ?? ''}-${i}`} className="text-red-800">
              <b>{v.truckCode ?? 'Plan'}{v.loadNo ? ` L${v.loadNo}` : ''}:</b> {v.message}
            </p>
          ))}
          {blockingViolations.length > 8 ? <p className="text-red-800">… and {blockingViolations.length - 8} more (all listed in the Excel export).</p> : null}
          {canPlan && d.run.chosenScenario ? (
            <Button size="sm" variant="destructive" className="mt-1" disabled={!!busy || nothingToPlan} onClick={() => replan('REOPTIMIZE')} data-testid="timing-replan-btn">
              <RefreshCw className="mr-1 h-4 w-4" /> Re-plan
            </Button>
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
          <Kpi label="Planned hours" value={String(s.totalHours)} />
          <Kpi label="Avg utilization" value={`${s.avgUtilizationPct}%`} />
          <Kpi label="Fuel (l · OMR)" value={`${s.fuelLitres ?? '—'} · ${s.fuelCost.toFixed(1)}`} />
          <Kpi label="Operating cost OMR" value={s.operatingCost.toFixed(1)} />
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
        </div>
      ) : null}

      {d.scenarios.length > 1 ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Plan options (the recommended plan balances service, priorities, customer hours and cost)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs">
                <tr>
                  <th className="p-2">Option</th>
                  <th className="p-2">Trucks</th>
                  <th className="p-2">Loads</th>
                  <th className="p-2">{kmLabel}</th>
                  <th className="p-2">Cost OMR</th>
                  <th className="p-2" title="Minutes outside customers' preferred hours, valued in OMR. Only the recommended plan tries to keep them low.">
                    Preferred-hours miss
                  </th>
                  <th className="p-2">Unserved</th>
                  <th className="p-2" title="The optimizer re-checked this option's timetable: loading time between loads, receiving hours, capacity, shift. An option that fails can be reviewed but its trucks cannot be dispatched.">
                    Timing checked
                  </th>
                  <th className="p-2">Solver</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {d.scenarios.map((sc) => (
                  <tr key={sc.id} className={sc.chosen ? 'bg-blue-50' : ''}>
                    <td className="p-2 font-medium">{sc.name === 'RECOMMENDED' ? 'RECOMMENDED' : sc.name.replace('_', ' ')}</td>
                    <td className="p-2">{sc.trucksUsed}</td>
                    <td className="p-2">{sc.trips}</td>
                    <td className="p-2">{sc.totalKm}</td>
                    <td className="p-2">{sc.operatingCost.toFixed(1)}</td>
                    <td className="p-2">{sc.objective ? sc.objective.window_penalty.toFixed(1) : '—'}</td>
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
                    <td className="p-2 text-xs text-muted-foreground">
                      {sc.solverTimeSec}s · {sc.solverStatus.replace('ROUTING_', '')}
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
                <th className="p-2">{kmLabel}</th>
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
                      {l.timing && !l.timing.ok ? (
                        <Badge variant="destructive" className="ml-1" data-testid={`load-timing-${l.truckCode}-${l.loadNo}`} title={TIMING_TEXT[l.timing.status]}>
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
                    <td className="p-2">{l.operatingCost.toFixed(1)}</td>
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
                    </td>
                    <td className="p-2">P{u.priority}</td>
                    <td className="p-2">{u.cases}</td>
                    <td className="p-2 text-xs">{u.salesOrders.join(', ') || '—'}</td>
                    <td className="p-2">
                      <b>{REASON_TEXT[u.reasonCode] ?? u.reasonCode}</b>
                      <span className="block text-xs text-muted-foreground">{u.reasonMessage}</span>
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
          loads={d.loads.map((l) => ({
            id: l.id,
            truckCode: l.truckCode,
            loadNo: l.loadNo,
            colorIdx: colorIdx.get(l.truckId) ?? 0,
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
        onSaved={(res) => {
          onChanged?.();
          if (res.productsWithoutWeight?.length) {
            toast.warning(`No case weight for ${res.productsWithoutWeight.join(', ')}: ${weightFixText(canEditProducts)}, or the re-plan will ask before counting it as 0 kg.`);
          }
          if (res.locationRequired) {
            toast.warning('New customer has no location yet — add it in step 2 before re-planning.');
            return;
          }
          if (window.confirm('Late order saved. Re-plan now? Locked and dispatched loads stay exactly as they are.')) void replan('LATE_ORDER');
        }}
      />
    </div>
  );
}

function Kpi({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-md border p-2 ${warn ? 'border-amber-400 bg-amber-50' : 'bg-card'}`}>
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
  pdfUrl,
  clash,
  whatsapp,
}: {
  l: DetailLoad;
  drivers: DriverOption[];
  editable: boolean;
  busy: boolean;
  onChange: (driverId: string | null) => void;
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
      </div>
    </div>
  );
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
  /** Review F04: this truck's times break a rule - Lock, Loading and Dispatch wait for a re-plan. */
  timingBlocked: boolean;
  onStatus: (s: string) => void;
}) {
  const timingTitle = !reconOk ? 'Cases must reconcile first' : timingBlocked ? "This truck's times break a planning rule (see the red box above): re-plan first" : undefined;
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
              </tr>
            ))}
            <tr>
              <td colSpan={2} className="py-1 font-semibold">
                TOTAL ({Math.round(l.weightKg)} kg)
              </td>
              <td className="py-1 text-right font-semibold">{l.cases}</td>
            </tr>
          </tbody>
        </table>
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
