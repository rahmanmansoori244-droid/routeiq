'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, MapPin, Pencil, RefreshCw, Upload, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, askOverride, weightFixText, type OptimizeOverrides } from './client-api';
import { LocationDialog } from './location-dialog';
import { CustomerDialog, type EditableCustomer } from './customer-dialog';
import { PlanView } from './plan-view';
import { createDayLoader, dayAfterConfirm, sameSelection, type DayLoader } from './day-loader';
import { dayKey } from './request-gate';

interface Issue {
  code: string;
  blocking: boolean;
  message: string;
}
interface IssueCustomer extends EditableCustomer {
  window: string;
  prioritySource: string;
  lat: number | null;
  lng: number | null;
  locationVerified: boolean;
  orders: number;
  cases: number;
  issues: Issue[];
  blocking: boolean;
  inactive?: boolean;
}
interface WeightGap {
  code: string;
  name: string;
  lines: number;
  cases: number;
  kgPerCase?: number;
}
interface Day {
  date: string;
  tomorrow: string;
  cutoff: string;
  depots: { id: string; code: string; name: string; lat: number; lng: number }[];
  depot: { id: string; code: string; name: string; lat: number; lng: number } | null;
  orders: { count: number; cases: number; customers: number; late: number; weightKg: number };
  customers: IssueCustomer[];
  blockingCount?: number;
  inactiveCustomers?: number;
  /** Lines with no weight at all: counted as 0 kg until the product gets a case weight. */
  productsWithoutWeight: WeightGap[];
  /** Lines whose product's case weight was entered or corrected since: applied at the next optimize. */
  weightsToApply?: WeightGap[];
  /** The plan in use is out of date without a new order: weights changed, customers deactivated. */
  outdated?: { weightCases: number; inactiveOrders: number };
  plan: null | {
    id: string;
    version: number;
    status: string;
    chosen: boolean;
    job: { status: string; message: string | null; progressPct: number } | null;
    /** Loads of the plan per status (PLANNED, LOCKED, LOADING, DISPATCHED, COMPLETED). */
    loadsByStatus?: Record<string, number>;
  };
  pending: { count: number; cases: number; late: number };
  /** Orders with cases not yet on a locked, loading or dispatched load (0 = nothing left to plan). */
  openOrders?: number;
  trucks: { active: number; capacityCases: number };
  batches: { id: string; fileName: string; status: string; uploadedAt: string; validRows: number; errorRows: number; isLate: boolean }[];
}
interface Validation {
  totalRows: number;
  validRows: number;
  errorRows: number;
  errors: { row: number; message: string }[];
  warnings: string[];
  duplicates: { row: number; message: string }[];
  totals: { lines: number; cases: number; customers: number; salesOrders: number; deliveryDates: string[] };
  fileCases: number;
  issues: { newCustomers: { code: string; name: string }[]; newProducts: { code: string; name: string }[]; customersWithoutLocation: string[]; productsWithoutWeight?: string[] };
  mapping: Record<string, string>;
  late: { isLate: boolean; reasons: string[] };
  depotCode: string;
}

interface Props {
  slug: string;
  canPlan: boolean;
  canDispatch: boolean;
  /** Company admin: can enter case weights under Products. */
  canEditProducts: boolean;
  initialDate: string | null;
  initialDepot: string | null;
  /** Calling code for drivers' phones saved without one (WhatsApp links); null = unknown. */
  phoneCountryCode: string | null;
}

export function DispatchClient({ slug, canPlan, canDispatch, canEditProducts, initialDate, initialDepot, phoneCountryCode }: Props) {
  const router = useRouter();
  const [date, setDate] = useState<string | null>(initialDate);
  const [depotId, setDepotId] = useState<string | null>(initialDepot);
  const [day, setDay] = useState<Day | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [batch, setBatch] = useState<{ id: string; v: Validation } | null>(null);
  const [lateReason, setLateReason] = useState('');
  // The customer stays set while a dialog animates closed (no flash of empty text).
  const [locFor, setLocFor] = useState<IssueCustomer | null>(null);
  const [locOpen, setLocOpen] = useState(false);
  const [editFor, setEditFor] = useState<IssueCustomer | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  // An action of the plan below (a load change, Lock all, Use instead, Re-plan) is running: Step 3
  // waits for it, and the plan's actions wait for Step 3's request (one action at a time, F07).
  const [planBusy, setPlanBusy] = useState(false);
  const [planKey, setPlanKey] = useState(0);
  const [showAllCustomers, setShowAllCustomers] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Every load is for the day selected NOW (day-loader.ts), also the reload after an action that
  // ends after another day was picked; only answers for the day being loaded reach the screen,
  // newest first (review ADD-STALE-DAY-CLIENT), and a failed load shows an error instead of the
  // previous day.
  const loaderRef = useRef<DayLoader | null>(null);
  loaderRef.current ??= createDayLoader<Day>(
    { date: initialDate, depotId: initialDepot },
    {
      fetchDay: (sel) => {
        const q = new URLSearchParams();
        if (sel.date) q.set('date', sel.date);
        if (sel.depotId) q.set('depotId', sel.depotId);
        return api<Day>(`/api/dispatch/day?${q}`);
      },
      show: (d, { afterError }) => {
        setDay(d);
        setLoadError(null);
        // The day is back after a failed load: load the plan below again too (its own load most
        // likely failed as well; third review of PR3).
        if (afterError) setPlanKey((k) => k + 1);
      },
      showError: setLoadError,
      selected: (sel) => {
        setDate(sel.date);
        setDepotId(sel.depotId);
      },
    },
  );
  const loader = loaderRef.current;
  const refresh = useCallback(() => loader.refresh(), [loader]);

  // A new selection (or the first render) loads it.
  useEffect(() => {
    void refresh();
  }, [date, depotId, refresh]);

  // Poll while an optimization runs. A tick is skipped while the previous load of the same day is
  // still on its way (a slow link or a busy server), so requests do not pile up - but never more
  // than a few ticks in a row, in case that request hangs.
  const skippedTicks = useRef(0);
  useEffect(() => {
    const running = day?.plan?.status === 'OPTIMIZING' || day?.plan?.job?.status === 'RUNNING' || day?.plan?.job?.status === 'QUEUED';
    if (!running) return;
    const t = setInterval(() => {
      if (loader.pendingKey() === dayKey(date, depotId) && skippedTicks.current < 5) {
        skippedTicks.current++;
        return;
      }
      skippedTicks.current = 0;
      void refresh();
    }, 3000);
    return () => clearInterval(t);
  }, [day, refresh, loader, date, depotId]);

  function changeDay(nextDate: string, nextDepot: string | null) {
    loader.select({ date: nextDate, depotId: nextDepot });
    setDate(nextDate);
    setDepotId(nextDepot);
    setBatch(null);
    setLoadError(null);
    const q = new URLSearchParams({ date: nextDate, ...(nextDepot ? { depot: nextDepot } : {}) });
    router.replace(`/t/${slug}/dispatch?${q}`);
  }

  // The day on screen must be the selected one, loaded without error, before anything is changed
  // on it: payloads are built from the loaded day only, never from the date or depot selection.
  const loadedKey = day ? dayKey(day.date, day.depot?.id) : null;
  const selectedKey = dayKey(date ?? day?.date, depotId ?? day?.depot?.id);
  const switching = !day || loadedKey !== selectedKey;
  const dayReady = !switching && !loadError;

  async function upload() {
    if (!file || !day?.depot || !dayReady) return;
    setUploading(true);
    const started = loader.selection();
    const fd = new FormData();
    fd.set('file', file);
    fd.set('depotId', day.depot.id);
    fd.set('deliveryDate', day.date);
    // Through api(), so an ended session goes to sign-in like every other dispatch call.
    const r = await api<{ batchId: string; validation: Validation }>('/api/orders/upload', { method: 'POST', body: fd });
    setUploading(false);
    if (!sameSelection(started, loader.selection())) {
      // Another day was picked meanwhile: the check was for the previous day, so it is not offered
      // on this one (its "Add ... lines" would add the file to a day not on screen).
      if (r.ok) toast.info(`The file was checked for ${started.date ?? 'the previous day'}. Click Check file again for the day on screen.`);
      return;
    }
    if (!r.ok || !r.data) {
      toast.error(r.error ?? 'Upload failed.');
      return;
    }
    setBatch({ id: r.data.batchId, v: r.data.validation });
    setLateReason('');
  }

  async function confirmBatch() {
    if (!batch || !dayReady) return;
    // The day the file is added on: the dispatcher may pick another one before the answer.
    const started = loader.selection();
    const r = await api<{ ordersCreated: number; cases: number; customersCreated: number; deliveryDates: string[] }>(`/api/orders/${batch.id}/confirm`, {
      method: 'POST',
      json: batch.v.late.isLate ? { lateReason } : {},
    });
    if (!sameSelection(started, loader.selection())) {
      // Another day was picked meanwhile: say what happened to the file, and stay on the day
      // picked (never jump back to the file's date; third review of PR3). Its screen - a file
      // being checked there included - is left as it is.
      if (r.ok && r.data) toast.success(`${r.data.ordersCreated} orders (${r.data.cases} cases) added to ${r.data.deliveryDates.join(', ') || (started.date ?? 'the previous day')}.`);
      else toast.error(`The file for ${started.date ?? 'the previous day'} was not added: ${r.error ?? 'Confirm failed.'}`);
      await refresh();
      return;
    }
    if (!r.ok || !r.data) {
      const code = r.errorBody?.code;
      if (code === 'LATE_REASON_REQUIRED') {
        // Checked before the cutoff but confirmed after it: ask for the reason now.
        const reasons = Array.isArray(r.errorBody?.reasons) ? (r.errorBody?.reasons as string[]) : [];
        setBatch({ ...batch, v: { ...batch.v, late: { isLate: true, reasons } } });
        toast.error(r.error ?? 'These orders are late now. Enter the reason for accepting them.');
        return;
      }
      toast.error(r.error ?? 'Confirm failed.');
      if (code === 'STALE_VALIDATION' || code === 'DUPLICATE_LINES' || code === 'DUPLICATE_FILE' || code === 'MASTER_CHANGED') {
        // Nothing was added; the file must be checked again against the day as it is now.
        setBatch(null);
        await refresh();
      }
      return;
    }
    toast.success(`${r.data.ordersCreated} orders (${r.data.cases} cases) added${r.data.customersCreated ? `, ${r.data.customersCreated} new customers need a location` : ''}.`);
    setBatch(null);
    setFile(null);
    // A file for another date than the day on screen: show that date.
    const next = dayAfterConfirm(started, loader.selection(), r.data.deliveryDates);
    if (next?.date) changeDay(next.date, next.depotId);
    else await refresh();
  }

  async function optimize() {
    if (!day?.depot || !dayReady || planBusy || optimizing) return;
    // Everything from the loaded day (never the date or depot selection); the server refuses a
    // plan of another day (409 DAY_MISMATCH).
    const expect = { date: day.date, depotId: day.depot.id };
    const replanning = !!day.plan?.chosen;
    const planId = day.plan?.id;
    const reason = day.pending.late ? 'LATE_ORDER' : 'REOPTIMIZE';
    // Busy until the day shows the result (the job, or the day as it is after a refusal), and
    // never stuck: api() never rejects, and the flag is cleared in finally (review of PR3).
    setOptimizing(true);
    try {
      let overrides: OptimizeOverrides = {};
      // False when the start never reached the server (status 0): the plan below stays as it is.
      let reached = true;
      for (;;) {
        const r = replanning
          ? await api<{ runId: string; queued?: boolean }>(`/api/runs/${planId}/replan`, { method: 'POST', json: { reason, expect, ...overrides } })
          : await api<{ runId: string; queued?: boolean }>('/api/dispatch/plan', { method: 'POST', json: { date: expect.date, depotId: expect.depotId, optimize: true, expect, ...overrides } });
        if (r.ok) {
          toast.success(r.data?.queued ? 'Queued: other optimizations are running. This plan starts as soon as one finishes.' : 'Optimizing… this takes up to a minute for a normal day.');
          break;
        }
        const more = askOverride(r.errorBody, replanning ? 'Re-plan' : 'Optimize', { canEditProducts });
        if (more) {
          overrides = { ...overrides, ...more };
          continue;
        }
        if (r.errorBody?.code === 'LOCATION_REQUIRED' || r.errorBody?.code === 'WEIGHT_REQUIRED') return;
        // The day may have changed under the screen (another user, a failed re-plan): show it as it is.
        toast.error(r.error ?? 'Could not start optimization.');
        reached = r.status !== 0;
        break;
      }
      // The plan below is loaded again: the job, or the plan as it is after a refusal.
      if (reached) setPlanKey((k) => k + 1);
      await refresh();
    } finally {
      setOptimizing(false);
    }
  }

  const loadFailed = loadError ? (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm" data-testid="day-load-error">
      <AlertTriangle className="h-4 w-4 text-red-700" />
      <span>
        Could not load {date ?? 'the day'}: {loadError}
      </span>
      <Button size="sm" variant="outline" onClick={() => void refresh()}>
        <RefreshCw className="mr-1 h-3 w-3" /> Try again
      </Button>
    </div>
  ) : null;
  if (!day) return loadFailed ?? <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!day.depot) return <p className="text-sm">No active depot. Create a depot and trucks first.</p>;

  const blocking = day.customers.filter((c) => c.blocking);
  const noLocation = blocking.filter((c) => !c.inactive).length;
  const inactive = blocking.length - noLocation;
  const blockingSummary = [noLocation ? `${noLocation} customer(s) need a location` : '', inactive ? `${inactive} deactivated customer(s): orders left unserved` : '']
    .filter(Boolean)
    .join(' · ');
  const notes = day.customers.filter((c) => !c.blocking && c.issues.some((i) => i.code !== 'LOCATION_UNVERIFIED' && i.code !== 'NEW_CUSTOMER'));
  const toApply = day.weightsToApply ?? [];
  const casesOf = (list: WeightGap[]) => list.reduce((a, g) => a + g.cases, 0);
  const running = day.plan?.status === 'OPTIMIZING' || day.plan?.job?.status === 'RUNNING' || day.plan?.job?.status === 'QUEUED';
  const outdated = day.outdated ?? { weightCases: 0, inactiveOrders: 0 };
  const planOutdated = !!day.plan?.chosen && (outdated.weightCases > 0 || outdated.inactiveOrders > 0);
  // Every order is already on a locked, loading or dispatched load: OPTIMIZE / RE-PLAN would have
  // nothing to plan (the server answers 409 NOTHING_TO_PLAN), so the button is off (review F03).
  const nothingLeft = day.orders.count > 0 && day.openOrders === 0 && day.pending.count === 0;
  const lastFailed = day.plan?.status === 'FAILED';
  const byStatus = day.plan?.loadsByStatus ?? {};
  // A LOCKED or LOADING load can be unlocked (put back to locked); a dispatched one cannot.
  const canUnlock = (byStatus.LOCKED ?? 0) + (byStatus.LOADING ?? 0) > 0;
  const loadCount = Object.values(byStatus).reduce((a, n) => a + n, 0);
  // Every load is out: the day is dispatched even when the last re-plan failed (its version stays
  // FAILED, holding the plan that was dispatched).
  const allOut = loadCount > 0 && (byStatus.DISPATCHED ?? 0) + (byStatus.COMPLETED ?? 0) === loadCount;
  const needsPlan = day.orders.count > 0 && !nothingLeft && (!day.plan?.chosen || day.pending.count > 0 || planOutdated || lastFailed);
  const fixWeight = weightFixText(canEditProducts);
  const selectedDate = date ?? day.date;
  const selectedDepot = depotId ?? day.depot.id;

  const pickers = (
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1">
        <Label htmlFor="d-date">Delivery date</Label>
        <Input id="d-date" type="date" value={selectedDate} onChange={(e) => e.target.value && changeDay(e.target.value, selectedDepot)} className="w-44" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="d-depot">Depot</Label>
        <select id="d-depot" className="h-9 rounded-md border bg-background px-2 text-sm" value={selectedDepot} onChange={(e) => changeDay(selectedDate, e.target.value)}>
          {day.depots.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code} — {d.name}
            </option>
          ))}
        </select>
      </div>
      <p className="pb-2 text-xs text-muted-foreground">
        {switching ? (
          <span className="inline-flex items-center gap-1" data-testid="day-loading">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading {selectedDate}…
          </span>
        ) : (
          <>
            Order cutoff {day.cutoff} the day before · {day.trucks.active} trucks ({day.trucks.capacityCases.toLocaleString()} cases per load round)
          </>
        )}
      </p>
    </div>
  );

  // Another date or depot was picked: nothing of the previous day stays on screen (or usable)
  // until the new one has loaded; a failed load shows the error, not the old day.
  if (switching) {
    return (
      <div className="space-y-5">
        {pickers}
        {loadFailed}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {pickers}
      {loadFailed}

      {/* STEP 1 */}
      <Step n={1} title="Upload orders" done={day.orders.count > 0} summary={`${day.orders.count} orders · ${day.orders.customers} customers · ${day.orders.cases.toLocaleString()} cases${day.orders.late ? ` · ${day.orders.late} late` : ''}`}>
        {canPlan ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm hover:bg-muted/40">
              <FileSpreadsheet className="h-4 w-4" />
              <span>{file ? file.name : 'Choose the sales order file (Excel or CSV)'}</span>
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" data-testid="order-file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setBatch(null); }} />
            </label>
            <Button onClick={upload} disabled={!file || uploading || !dayReady} data-testid="upload-btn">
              {uploading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
              Check file
            </Button>
          </div>
        ) : null}
        {batch ? <ValidationPanel v={batch.v} fixWeight={fixWeight} lateReason={lateReason} setLateReason={setLateReason} onConfirm={confirmBatch} onCancel={() => setBatch(null)} disabled={!dayReady} /> : null}
        {day.batches.length ? (
          <p className="text-xs text-muted-foreground">
            Files for this day: {day.batches.map((b) => `${b.fileName} (${b.status.toLowerCase()}${b.isLate ? ', late' : ''})`).join(' · ')}
          </p>
        ) : null}
      </Step>

      {/* STEP 2 */}
      <Step
        n={2}
        title="Resolve issues"
        done={day.orders.count > 0 && blocking.length === 0}
        warn={blocking.length > 0}
        summary={blocking.length ? blockingSummary : day.orders.count ? 'All delivery locations known' : '—'}
      >
        {blocking.length ? (
          <div className="grid gap-2 md:grid-cols-2" data-testid="blocking-issues">
            {blocking.map((c) => (
              <IssueCard key={c.customerId} c={c} canPlan={canPlan} onLocation={() => { setLocFor(c); setLocOpen(true); }} onEdit={() => { setEditFor(c); setEditOpen(true); }} />
            ))}
          </div>
        ) : null}
        {notes.length ? (
          <details className="rounded-md border p-2 text-sm" open={blocking.length === 0 && notes.length <= 6}>
            <summary className="cursor-pointer">{notes.length} customer(s) to confirm (priority / type / receiving hours) — optional, defaults are used</summary>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {notes.slice(0, showAllCustomers ? undefined : 12).map((c) => (
                <IssueCard key={c.customerId} c={c} canPlan={canPlan} onLocation={() => { setLocFor(c); setLocOpen(true); }} onEdit={() => { setEditFor(c); setEditOpen(true); }} />
              ))}
            </div>
            {notes.length > 12 && !showAllCustomers ? (
              <Button variant="link" size="sm" onClick={() => setShowAllCustomers(true)}>
                Show all {notes.length}
              </Button>
            ) : null}
          </details>
        ) : null}
        {day.productsWithoutWeight.length ? (
          <p className="text-xs text-amber-700" data-testid="weights-unknown">
            No weight for {casesOf(day.productsWithoutWeight).toLocaleString()} cases of {day.productsWithoutWeight.length} product(s) (
            {day.productsWithoutWeight.map((p) => `${p.code}: ${p.cases} cases`).join(', ')}). To check truck payloads, {fixWeight}: until then OPTIMIZE asks before planning them as 0 kg.
          </p>
        ) : null}
        {toApply.length ? (
          <p className="text-xs text-muted-foreground" data-testid="weights-to-apply">
            Case weight entered or corrected under Products after these orders were added, for {casesOf(toApply).toLocaleString()} cases ({toApply.map((p) => `${p.code}: ${p.kgPerCase ?? '?'} kg per case`).join(', ')}): applied at the next OPTIMIZE or RE-PLAN.
          </p>
        ) : null}
      </Step>

      {/* STEP 3 */}
      <Step
        n={3}
        title="Optimize"
        done={!!day.plan?.chosen && day.pending.count === 0 && !planOutdated && !running}
        summary={
          running
            ? `Optimizing… ${day.plan?.job?.message ?? ''}`
            : day.plan?.chosen
              ? `Plan version ${day.plan.version} ${lastFailed ? 'in use: the last optimization failed, the previous plan was kept' : 'ready'}${day.pending.count ? ` · ${day.pending.count} new order(s) not planned yet` : ''}${planOutdated ? ' · out of date, RE-PLAN' : ''}`
              : 'Not optimized yet'
        }
      >
        {day.pending.count > 0 && day.plan?.chosen ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="pending-orders">
            {day.pending.count} order(s) ({day.pending.cases} cases{day.pending.late ? `, ${day.pending.late} late` : ''}) arrived after this plan. Re-plan to add them — locked and dispatched loads are kept exactly as they are.
          </div>
        ) : null}
        {canPlan ? (
          <Button onClick={() => optimize()} disabled={optimizing || planBusy || running || !needsPlan || !dayReady} data-testid="optimize-btn" size="lg">
            {optimizing || running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
            {day.plan?.chosen ? 'RE-PLAN' : 'OPTIMIZE'}
          </Button>
        ) : null}
        {planOutdated && !running ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="plan-outdated">
            The plan in use was made before{' '}
            {[
              outdated.weightCases ? `case weights were entered or corrected for ${outdated.weightCases.toLocaleString()} of its cases` : '',
              outdated.inactiveOrders ? `${outdated.inactiveOrders} of its order(s) on planned loads had their customer deactivated` : '',
            ]
              .filter(Boolean)
              .join(', and ')}
            . RE-PLAN to apply this — locked and dispatched loads are kept exactly as they are.
          </div>
        ) : null}
        {nothingLeft && !running ? (
          <p className="text-xs text-muted-foreground" data-testid="nothing-to-plan">
            Every order of this day is already on a locked, loading or dispatched load: nothing left to plan.
            {canUnlock
              ? day.plan?.chosen
                ? ' To change a load, unlock it first.'
                : ' This version has no optimized plan yet: unlock one load below, then OPTIMIZE.'
              : ' Every load has left the depot; a late order for this day can still be planned.'}
          </p>
        ) : !needsPlan && day.plan?.chosen ? (
          <p className="text-xs text-muted-foreground">The plan is up to date with all orders.</p>
        ) : null}
      </Step>

      {/* STEPS 4-5 */}
      {day.plan ? (
        <Step n={4} title="Review plan · 5 Lock, export, dispatch" done={day.plan.status === 'DISPATCHED' || (day.plan.chosen && allOut)} summary={`Version ${day.plan.version} · ${day.plan.status}`}>
          <PlanView
            key={`${day.plan.id}-${planKey}`}
            slug={slug}
            runId={day.plan.id}
            canPlan={canPlan && dayReady}
            canDispatch={canDispatch && dayReady}
            canEditProducts={canEditProducts}
            phoneCountryCode={phoneCountryCode}
            externalBusy={optimizing}
            onBusyChange={setPlanBusy}
            onChanged={async () => {
              // The plan's action keeps its buttons (and Step 3) waiting until the day shows its
              // result; then the plan screen is loaded fresh. When the day could not be loaded, the
              // plan stays as it is (with its own Try again) until the day's Try again reloads both.
              if (await refresh()) setPlanKey((k) => k + 1);
            }}
          />
        </Step>
      ) : null}

      <LocationDialog open={locOpen} onOpenChange={setLocOpen} customer={locFor} depot={{ lat: day.depot.lat, lng: day.depot.lng }} onSaved={() => void refresh()} />
      <CustomerDialog open={editOpen} onOpenChange={setEditOpen} customer={editFor} onSaved={() => void refresh()} />
    </div>
  );
}

function Step({ n, title, done, warn, summary, children }: { n: number; title: string; done: boolean; warn?: boolean; summary: string; children: React.ReactNode }) {
  return (
    <Card data-testid={`step-${n}`}>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0 py-3">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${done ? 'bg-green-600 text-white' : warn ? 'bg-amber-500 text-white' : 'bg-muted'}`}>
          {done ? <CheckCircle2 className="h-4 w-4" /> : n}
        </span>
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="text-xs text-muted-foreground">{summary}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function IssueCard({ c, canPlan, onLocation, onEdit }: { c: IssueCustomer; canPlan: boolean; onLocation: () => void; onEdit: () => void }) {
  const needsLoc = c.issues.some((i) => i.code === 'LOCATION_REQUIRED' || i.code === 'INVALID_LOCATION');
  return (
    <div className={`rounded-md border p-2 text-sm ${c.blocking ? 'border-red-300 bg-red-50' : ''}`} data-testid={`issue-${c.code}${c.branchCode ? `-${c.branchCode}` : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-muted-foreground">
            {c.code}
            {c.branchCode ? ` / ${c.branchCode}` : ''} · {c.customerType ?? 'type not set'} · {c.cases} cases
          </p>
        </div>
        <Badge variant={c.priority <= 2 ? 'warning' : 'outline'}>
          P{c.priority}
          {c.prioritySource === 'DEFAULT' ? '?' : ''}
        </Badge>
      </div>
      {c.inactive ? (
        <p className="mt-1 text-xs font-medium text-red-700">{c.issues.find((i) => i.code === 'CUSTOMER_INACTIVE')?.message}</p>
      ) : (
        <p className="mt-1 text-xs">
          Location: {needsLoc ? <b className="text-red-700">{c.issues.find((i) => i.blocking)?.code === 'INVALID_LOCATION' ? 'INVALID' : 'MISSING'}</b> : c.locationVerified ? 'confirmed' : 'imported'} · Window: {c.window}
        </p>
      )}
      {c.issues
        .filter((i) => !i.blocking && i.code !== 'NEW_CUSTOMER')
        .map((i) => (
          <p key={i.code} className="text-xs text-muted-foreground">
            • {i.message}
          </p>
        ))}
      {canPlan && !c.inactive ? (
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant={needsLoc ? 'default' : 'outline'} onClick={onLocation} data-testid={`add-location-${c.code}`}>
            <MapPin className="mr-1 h-3 w-3" /> {needsLoc ? 'ADD LOCATION' : 'Location'}
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="mr-1 h-3 w-3" /> Details
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ValidationPanel({ v, fixWeight, lateReason, setLateReason, onConfirm, onCancel, disabled = false }: { v: Validation; fixWeight: string; lateReason: string; setLateReason: (s: string) => void; onConfirm: () => void; onCancel: () => void; disabled?: boolean }) {
  const ok = v.errorRows === 0;
  return (
    <div className={`space-y-2 rounded-md border p-3 text-sm ${ok ? 'border-green-300' : 'border-red-300'}`} data-testid="validation-panel">
      <p className="font-medium">
        {v.totalRows} rows read · {v.totals.lines} order lines · {v.totals.customers} customers · {v.totals.salesOrders} sales orders · <b>{v.totals.cases.toLocaleString()} cases</b> for {v.totals.deliveryDates.join(', ') || '—'} (depot {v.depotCode})
      </p>
      <p className="text-xs text-muted-foreground">Columns used: {Object.entries(v.mapping).map(([k, h]) => `${h} → ${k}`).join(' · ')}</p>
      {v.issues.newCustomers.length ? (
        <p className="text-amber-800">
          {v.issues.newCustomers.length} new customer(s) will be created and need a location: {v.issues.newCustomers.slice(0, 6).map((c) => `${c.code} ${c.name}`).join(', ')}
          {v.issues.newCustomers.length > 6 ? '…' : ''}
        </p>
      ) : null}
      {v.issues.newProducts.length ? <p className="text-amber-800">{v.issues.newProducts.length} new product(s) will be created, without a case weight: {v.issues.newProducts.map((p) => p.code).join(', ')}</p> : null}
      {v.issues.productsWithoutWeight?.length ? (
        <p className="text-amber-800">
          No weight in the file or on the product for: {v.issues.productsWithoutWeight.join(', ')}. Before optimizing, {fixWeight}, or those lines count as 0 kg.
        </p>
      ) : null}
      {v.duplicates.length ? <p className="text-amber-800">{v.duplicates.length} line(s) were already uploaded and will be skipped.</p> : null}
      {v.errors.length ? (
        <div className="max-h-40 overflow-y-auto rounded border border-red-200 bg-red-50 p-2 text-xs" data-testid="validation-errors">
          <p className="mb-1 font-semibold text-red-800">{v.errors.length} row(s) need fixing in the file (nothing was saved):</p>
          {v.errors.slice(0, 50).map((e, i) => (
            <p key={i}>
              Row {e.row}: {e.message}
            </p>
          ))}
        </div>
      ) : null}
      {v.warnings.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer">{v.warnings.length} note(s)</summary>
          {v.warnings.slice(0, 50).map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </details>
      ) : null}
      {v.late.isLate ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-2">
          <p className="flex items-center gap-1 font-semibold text-amber-900">
            <AlertTriangle className="h-4 w-4" /> LATE ORDERS
          </p>
          {v.late.reasons.map((r) => (
            <p key={r} className="text-xs">
              {r}
            </p>
          ))}
          <Label htmlFor="late-reason" className="mt-1 block text-xs">
            Reason for accepting them
          </Label>
          <Input id="late-reason" value={lateReason} onChange={(e) => setLateReason(e.target.value)} placeholder="e.g. Hypermarket promotion approved by sales manager" />
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={onConfirm} disabled={disabled || !ok || (v.late.isLate && lateReason.trim().length < 3)} data-testid="confirm-upload">
          Add {v.totals.lines} lines to the day
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
