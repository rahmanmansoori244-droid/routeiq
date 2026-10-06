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
import { breakLine, breakTimes } from '@/lib/dispatch/break-text';
import {
  fmtSearchTime,
  optimizeStartedText,
  planSearching,
  readResultsNow,
  searchModeNow,
  searchPollMs,
  searchProgressText,
  searchResultText,
  THOROUGH_MAX_SEC_DEFAULT,
  type SearchMode,
  type StartedAnswer,
} from '@/lib/dispatch/search-mode';
import { kgText, manifestKgNote } from '@/lib/dispatch/weights';
import { fullAndLooseText, loadPallets, manifestPalletTotals, manifestTotalText, palletLimitText, palletsOverBays, palletText } from '@/lib/dispatch/pallets';
import { api, askOverride, durH, hhmm, isPalletFactorRefusal, palletRefusalToast, REASON_TEXT, weightFixText, type OptimizeOverrides } from './client-api';
import { LateOrderDialog } from './late-order-dialog';
import { useSearchModeChoice } from './search-mode-dialog';
import { useTicker } from './use-ticker';
import { afterLateOrderSaved, createLoadOrder, planAfterLoad, planReloadErrorText, runPlanAction, type ActionLock, type PlanPanel } from './plan-actions';
import type { DriverLinkView } from '@/lib/driver-link/manifest-types';
import { reissuePrompt, reissuePromptText } from '@/lib/driver-link/reissue-prompt';
import { lateDispatchNotes } from '@/lib/driver-link/plan-notes';
import { DriverLinkDialog, ReissueLinkPrompt } from './driver-link-dialog';
import { CasualDriverDialog, type CasualDriverAnswer, type CasualDriverBody } from './casual-driver-dialog';
import type { ApiResult } from './client-api';
import type { OutcomeOverlay, OverlayPhoto, OverlayStop } from '@/lib/delivery/outcome-view';
import { officeTimesPrefill } from '@/lib/delivery/office-text';
import { OutcomeDialog, type OutcomeTarget } from './outcome-dialog';
import { PhotoViewer } from './photo-viewer';
import { CameraExceptions } from './camera-exceptions';
import { HireSuggestionBox } from './hire-suggestion';
import { CAMERA_ALERT_PER_DAY } from '@/lib/delivery/camera-exceptions';

const PlanMap = dynamic(() => import('@/components/plan-map').then((m) => m.PlanMap), { ssr: false });

const STATUS_VARIANT: Record<string, 'outline' | 'secondary' | 'warning' | 'success' | 'destructive' | 'default'> = {
  PLANNED: 'outline',
  LOCKED: 'secondary',
  LOADING: 'warning',
  DISPATCHED: 'success',
  COMPLETED: 'default',
};

/** Asked before "Use the best plan found so far" (a thorough search stopped early). */
const STOP_SEARCH_CONFIRM =
  'Stop the thorough search now and use the best plan found so far? The search ends at the next plan it finds, the alternative options are skipped, and the plan is checked and saved in about a minute. This is recorded in the audit log.';

/** Asked before "Reset stuck plan" (audit F09). */
const STUCK_RESET_CONFIRM =
  'Reset this plan? It is shown as optimizing, but its optimization has ended or was lost. The plan goes back to "failed" (a re-plan version keeps the loads it holds) so it can be optimized or re-planned again. This is recorded in the audit log.';

/** Once a load is out, who drove it is history. */
const ON_ROAD = new Set(['DISPATCHED', 'COMPLETED']);

interface DriverOption { id: string; code: string; name: string; phone: string | null; active: boolean; casual?: boolean }

/** Owner rule 20: the Dispatch button's title on a load without a driver. */
const DISPATCH_NEEDS_DRIVER = 'Pick the driver first: a load never leaves without a driver';
/** The Driver list's last option: add a daily (casual) driver from the load. */
const ADD_DAILY = '__add_daily_driver__';
/** PATCH /api/dispatch/driver-links/:id action after the "Reissue link?" prompt. */
const LINK_REISSUE = 'REISSUE' as const;

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
  /** The dispatcher (PLANNER and above, owner decision 4 of 5 Oct 2026): may "Reset stuck plan" and "Use the best plan found so far". */
  canResetStuck?: boolean;
  /**
   * The list of results saved without a photo ("Camera not working"). Off on the day screen, whose
   * Deliveries card right below lists them; the load rows' red badge shows either way.
   */
  showCameraList?: boolean;
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
   * A result was recorded on this plan (Record outcome): the screen around it reads its Deliveries
   * card again, also while a search runs.
   */
  onResultRecorded?: () => void;
  /**
   * The company's today (YYYY-MM-DD) as the day screen knows it: a load of today holding orders
   * brought forward to tomorrow says "re-plan today" / "unlock" (carriedLoadTitle). Optional:
   * without it (the standalone plan version page) the plan's own today is used (PlanDetail.today).
   */
  today?: string;
}

export function PlanView({ slug, runId, canPlan, canDispatch, canEditProducts = false, onChanged, showVersionLink = true, phoneCountryCode = null, canResetStuck = false, showCameraList = true, externalBusy = false, onBusyChange, reloadSignal = 0, onResultRecorded, today }: Props) {
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

  // Delivery results of this version's loads that left (owner request 4 Oct 2026, spec section 10):
  // read with the plan, and every 60 s while a load is on the road and the page is in front.
  const [overlay, setOverlay] = useState<OutcomeOverlay | null>(null);
  const [recordFor, setRecordFor] = useState<OutcomeTarget | null>(null);
  const [photosFor, setPhotosFor] = useState<{ title: string; photos: OverlayPhoto[] } | null>(null);
  const overlayOrder = useRef(0);
  // The plan's load reads the results too (a ref, so `load` keeps depending on the run only).
  const overlayLoad = useRef<() => void>(() => undefined);
  // The results were read once: a running search's polls do not read them again.
  const overlaySeen = useRef(false);

  // Newest answer wins (createLoadOrder): an answer older than the one on screen is dropped (null).
  const loadOrder = useRef(createLoadOrder());
  // A load newer than the answer on screen is on its way: Try again waits for it.
  const [reloading, setReloading] = useState(false);
  // `results`: the load follows a write (a result recorded, a reload the screen asked for): the
  // results are read at once, whatever the plan's answer - also while a search runs, and even when a
  // search poll answers first and this answer is dropped.
  const load = useCallback(async (opts?: { results?: boolean }) => {
    const afterWrite = opts?.results === true;
    if (afterWrite) overlayLoad.current();
    const ticket = loadOrder.current.begin();
    setReloading(true);
    const r = await api<PlanDetail>(`/api/runs/${runId}/plan`);
    if (!loadOrder.current.accept(ticket)) return null;
    setReloading(loadOrder.current.pending());
    setPanel((shown) => planAfterLoad(shown, r));
    // The results follow the plan (a load completed): read again with it - but not on the polls of a
    // running search (every 2.5-10 s for up to 20 min): a search never changes them, and the 60 s read
    // below brings the phones' results.
    if (!afterWrite && readResultsNow({ searching: !!(r.ok && r.data && planSearching(r.data.run, r.data.job)), seen: overlaySeen.current, afterWrite })) overlayLoad.current();
    return r.ok ? r.data : null;
  }, [runId]);

  const loadOverlay = useCallback(async () => {
    const ticket = ++overlayOrder.current;
    const r = await api<OutcomeOverlay>(`/api/runs/${runId}/outcomes`);
    if (ticket === overlayOrder.current && r.ok && r.data) {
      overlaySeen.current = true;
      setOverlay(r.data);
    }
  }, [runId]);
  overlayLoad.current = () => void loadOverlay();

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
    if (r.ok && r.data) setDrivers(r.data.map(({ id, code, name, phone, active, casual }) => ({ id, code, name, phone, active, casual: !!casual })));
  }, []);

  useEffect(() => {
    void loadDrivers();
  }, [loadDrivers]);

  // The plan's truck-day driver links (owner request 4 Oct 2026), loaded with the plan for the
  // dispatcher (PLANNER+): the WhatsApp link carries the driver link at render time, never after an
  // awaited call a browser would block as a pop-up. Existing links only (nothing is made here).
  const [links, setLinks] = useState<DriverLinkView[]>([]);
  const [linkDialog, setLinkDialog] = useState<{ truckId: string; loadId: string } | null>(null);
  const [casualFor, setCasualFor] = useState<DetailLoad | null>(null);
  const [reissueAsk, setReissueAsk] = useState<{ link: DriverLinkView; text: string } | null>(null);
  const loadLinks = useCallback(async () => {
    if (!canPlan) return;
    const r = await api<DriverLinkView[]>(`/api/dispatch/driver-links?runId=${encodeURIComponent(runId)}`);
    if (r.ok && Array.isArray(r.data)) setLinks(r.data);
  }, [runId, canPlan]);

  useEffect(() => {
    void loadLinks();
  }, [loadLinks]);

  const linkOf = (truckId: string) => links.find((x) => x.truckId === truckId) ?? null;
  const keepLink = (view: DriverLinkView) => setLinks((cur) => [...cur.filter((x) => x.truckId !== view.truckId), view]);

  /**
   * After a driver change (the Driver list or a daily driver): "Reissue link?" only when the truck-day's
   * link was made for another named driver, the change is on its earliest open trip and nobody else
   * is on the road with it; a link made before any driver was set takes the new driver silently
   * (reissuePrompt, spec 4.3).
   */
  async function afterDriverChange(fresh: PlanDetail | null, l: DetailLoad, driverId: string | null) {
    const link = linkOf(l.truckId);
    if (!fresh || !link) return;
    const truckLoads = fresh.loads.filter((x) => x.truckId === l.truckId).map((x) => ({ id: x.id, loadNo: x.loadNo, status: x.status, driverId: x.driverId, departMin: x.departMin }));
    const decision = reissuePrompt({ driverIdAtIssue: link.driverIdAtIssue, revoked: link.revoked, expired: link.expired }, truckLoads, l.id, driverId);
    if (decision === 'RECORD') {
      const r = await api<DriverLinkView>('/api/dispatch/driver-links', { method: 'POST', json: { runId, truckId: l.truckId } });
      if (r.ok && r.data) keepLink(r.data);
    } else if (decision === 'PROMPT') {
      const newName = fresh.loads.find((x) => x.id === l.id)?.driverName ?? 'the new driver';
      setReissueAsk({ link, text: reissuePromptText(l.truckCode, fmtDayMonth(fresh.run.runDate), link.driverNameAtIssue ?? 'another driver', newName) });
    }
  }

  async function reissueNow(link: DriverLinkView) {
    const r = await api<DriverLinkView>(`/api/dispatch/driver-links/${link.linkId}`, { method: 'PATCH', json: { action: LINK_REISSUE, reason: 'driver changed' } });
    if (r.ok && r.data) {
      keepLink(r.data);
      toast.success(`New driver link for ${r.data.truckCode}: send it or print the sheets again.`);
    } else toast.error(r.error ?? 'Could not reissue the driver link.');
  }

  /** "+ Add daily driver…": the quick add under the plan's action lock, then the plan and the driver list again. */
  async function addDailyDriver(l: DetailLoad, body: CasualDriverBody): Promise<ApiResult<CasualDriverAnswer> | null> {
    let res: ApiResult<CasualDriverAnswer> | null = null;
    await runPlanAction(
      lock,
      l.id,
      async () => {
        res = await api<CasualDriverAnswer>('/api/dispatch/casual-driver', { method: 'POST', json: { runId, loadId: l.id, name: body.name, phone: body.phone || null, ...(body.useExisting ? { useExisting: body.useExisting } : {}) } });
        if (!res.ok || !res.data) return;
        toast.success(`${l.truckCode} Load ${l.loadNo}: daily driver ${res.data.driver.name}${res.data.reused ? ' (already saved)' : ''}`);
        await loadDrivers();
        const fresh = await load();
        await afterDriverChange(fresh, l, res.data.driver.id);
      },
      failed,
    );
    return res;
  }

  // Try again after a failed load: the plan, and the driver list if it did not load either.
  const retry = () => {
    void load();
    if (!drivers.length) void loadDrivers();
  };
  // Off while a reload is on its way or an action runs (its own reload shows the plan).
  const retryOff = !!busy || reloading;

  // The screen around the plan asks for a reload (reloadSignal): the same, in place, with the results
  // (it follows a write there: a result recorded on the Deliveries card, a customer saved).
  const seenReload = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === seenReload.current) return;
    seenReload.current = reloadSignal;
    void load({ results: true });
    if (!drivers.length) void loadDrivers();
    void loadLinks();
  }, [reloadSignal, load, loadDrivers, drivers.length, loadLinks]);

  // Results come in from the drivers' phones while loads are on the road: read them every 60 s.
  const onRoadNow = !!d?.loads.some((l) => l.status === 'DISPATCHED');
  useEffect(() => {
    if (!onRoadNow) return;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void loadOverlay();
    }, 60_000);
    return () => clearInterval(t);
  }, [onRoadNow, loadOverlay]);

  useEffect(() => {
    if (!d) return;
    const running = d.run.status === 'OPTIMIZING' || d.job?.status === 'QUEUED' || d.job?.status === 'RUNNING';
    if (!running) return;
    // Every 2.5 s; every 10 s once a thorough search has run a minute (it may take 20 minutes).
    const t = setInterval(() => void load(), searchPollMs(d.job, 2500, new Date()));
    return () => clearInterval(t);
  }, [d, load]);
  // The progress line ("6 min so far") ticks between reloads.
  const now = useTicker(d?.job?.status === 'RUNNING', 5_000);
  // Quick or Thorough, asked before every Re-plan (owner decision 29 Sep 2026).
  const searchChoice = useSearchModeChoice();

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
    // Delivery outcome (spec section 9.4): a brought-forward order on this load whose original result
    // changed after the carry may not be needed. Lock asks; it is never refused.
    const warnings = status === 'LOCKED' ? (overlay?.lockWarnings[l.id] ?? []) : [];
    if (warnings.length && !window.confirm(`${warnings.join('\n')}\n\nLock anyway?`)) return;
    return runPlanAction(
      lock,
      l.id,
      async () => {
        const r = await api<{ warnings?: string[] }>(`/api/runs/${runId}/loads/${l.id}`, { method: 'PATCH', json: { status } });
        if (!r.ok) {
          toast.error(r.error ?? 'Could not change the load.');
          await load(); // show the plan as it is now (it may have changed meanwhile)
          return;
        }
        if (r.data?.warnings?.length && !warnings.length) toast.warning(r.data.warnings.join(' '));
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
        if (!keep) await afterDriverChange(fresh, l, driverId);
      },
      failed,
    );
  }

  /**
   * A one-day hired truck (the hire suggestion): the dispatcher enters its real plate, which becomes the
   * truck code on the plan, the driver sheets and the driver page (PLANNER and above, audited).
   */
  function setPlate(l: DetailLoad) {
    const plate = window.prompt(`Real plate of the hired truck ${l.truckCode} (letters, digits, dot, dash, underscore; no spaces):`, l.truckCode.startsWith('HIRE-') ? '' : l.truckCode);
    if (plate === null || !plate.trim() || plate.trim() === l.truckCode) return;
    return runPlanAction(
      lock,
      `plate-${l.truckId}`,
      async () => {
        const r = await api<{ code: string }>(`/api/dispatch/hired-trucks/${l.truckId}`, { method: 'PATCH', json: { code: plate.trim() } });
        if (!r.ok) toast.error(r.error ?? 'Could not save the plate.');
        else toast.success(`${l.truckCode} is now ${r.data?.code ?? plate.trim()}. Print the driver sheets again if they were printed.`);
        await load();
        await loadLinks();
      },
      failed,
    );
  }

  function lockAll() {
    if (!d) return;
    const planned = d.loads.filter((l) => l.status === 'PLANNED').sort((a, b) => a.loadNo - b.loadNo);
    const warnings = planned.flatMap((l) => overlay?.lockWarnings[l.id] ?? []);
    if (warnings.length && !window.confirm(`${warnings.join('\n')}\n\nLock anyway?`)) return;
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
   * "Reset stuck plan" (audit F09, owner decision 17; the dispatcher since 5 Oct 2026, audited). Only offered
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

  /**
   * "Use the best plan found so far" (the dispatcher since 5 Oct 2026, audited): a running thorough search
   * ends at the next plan it finds; the job then checks and saves that plan as usual.
   */
  function stopSearch() {
    if (!window.confirm(STOP_SEARCH_CONFIRM)) return;
    return runPlanAction(
      lock,
      'stop-search',
      async () => {
        const r = await api<{ message?: string }>(`/api/runs/${runId}/stop-search`, { method: 'POST', json: {} });
        if (r.ok) toast.success(r.data?.message ?? 'Stopping the search: the best plan found so far is saved in about a minute.');
        else toast.error(r.error ?? 'Could not stop the search.');
        await load();
      },
      failed,
    );
  }

  /**
   * Quick or Thorough for a re-plan of this plan (null = cancelled). Thorough is suggested for a plan
   * made before its delivery day, Quick on the day itself (search-mode.ts) - by the clock when asked:
   * a plan screen left open across midnight must not suggest Thorough on the delivery day (skeptic
   * review of the long-search PR).
   */
  function askSearchMode(note?: string): Promise<SearchMode | null> {
    if (!d) return Promise.resolve(null);
    const stops = new Set([...d.loads.flatMap((l) => l.stops.map((s) => s.customerId)), ...d.unserved.map((u) => u.customerId)]).size + (d.pendingOrders ?? 0);
    const { defaultMode, deliveryDay } = searchModeNow(d.run.runDate, { timezone: d.timezone, today: today ?? d.today }, new Date());
    return searchChoice.ask({
      verb: 'Re-plan',
      defaultMode,
      stops: stops || null,
      capSec: d.thoroughMaxSec ?? THOROUGH_MAX_SEC_DEFAULT,
      deliveryDay,
      note: note ?? 'Locked and dispatched loads stay exactly as they are.',
    });
  }

  // The mode chosen with "Late order saved. Re-plan now?" (one dialog for both).
  const lateOrderMode = useRef<SearchMode | null>(null);

  async function replan(reason: 'LATE_ORDER' | 'REOPTIMIZE', preset?: SearchMode) {
    const searchMode = preset ?? (await askSearchMode());
    if (!searchMode) return;
    const expect = d ? { date: d.run.runDate, depotId: d.run.depot.id } : undefined;
    const capSec = d?.thoroughMaxSec ?? THOROUGH_MAX_SEC_DEFAULT;
    return runPlanAction(
      lock,
      'replan',
      async () => {
        let overrides: OptimizeOverrides = {};
        for (;;) {
          const r = await api<{ runId: string; version?: number; reason?: string } & StartedAnswer>(`/api/runs/${runId}/replan`, {
            method: 'POST',
            json: { reason, expect, searchMode, ...overrides },
          });
          if (r.ok && r.data?.alreadyRunning) {
            // A version with no plan yet is optimized in place: another dispatcher's job may already
            // run for it, with its own mode - never reported as this choice.
            const text = optimizeStartedText(r.data, searchMode, capSec, null);
            if (r.data.searchMode !== searchMode) toast.warning(text);
            else toast.success(text);
            await onChanged?.(r.data.runId);
            return;
          }
          if (r.ok && r.data) {
            const how =
              r.data.reason === 'LATE_ORDER'
                ? 'Late order added; the other orders stay on their trucks where possible.'
                : 'Full re-optimize: orders may move to other trucks.';
            const long = searchMode === 'THOROUGH' ? ` Thorough search: up to ${fmtSearchTime(capSec)}, stops early when the plan stops improving.` : '';
            toast.success(
              `Plan version ${r.data.version ?? ''} is ${r.data.queued ? 'queued behind other optimizations' : 'being optimized'}. ${how}${long} Locked and dispatched loads are kept; if the optimization fails, the previous plan stays in use.`,
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
          if (isPalletFactorRefusal(r.errorBody)) {
            // Refused, no question: the products to fix, with the Products link (the previous plan stays).
            toast.error(r.error ?? 'Cannot plan by pallets: products have no cases per pallet.', palletRefusalToast(slug));
          } else if (r.errorBody?.code !== 'LOCATION_REQUIRED' && r.errorBody?.code !== 'WEIGHT_REQUIRED') {
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
  // "Searching for the best plan - up to 20 min, stops early when it stops improving - 6 min so far".
  const progress = running && d.job ? searchProgressText(d.job, now, d.thoroughMaxSec ?? THOROUGH_MAX_SEC_DEFAULT) : null;
  // How the plan in use was searched (Quick / Thorough, how long, why it stopped); an alternative in
  // use: its own search, after the recommended plan's (skeptic review of the long-search PR).
  const searched = searchResultText(d.search ?? null, d.searchOption ?? null);
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
  // The driver page was opened after a load's planned departure while it is still at the depot (spec 6.5).
  const lateNotes = superseded ? [] : lateDispatchNotes(d.loads, links, d.run.runDate, d.timezone || 'Asia/Muscat');
  const dialogLoad = linkDialog ? d.loads.find((x) => x.id === linkDialog.loadId) ?? null : null;

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

      {searchChoice.dialog}
      {searched && !running ? (
        <p className="text-xs text-muted-foreground" data-testid="search-result">
          {searched}
        </p>
      ) : null}
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
          {progress ? (
            <span data-testid="search-progress">{progress}.</span>
          ) : (
            <>
              Optimizing… {d.job?.message ?? ''} ({d.job?.progressPct ?? 0}%)
            </>
          )}
          {applied ? ' Until the new plan is saved, the loads below are the previous plan (kept if the optimization fails).' : ''}
          {canResetStuck && d.job?.status === 'RUNNING' && d.job?.searchMode === 'THOROUGH' && !d.stuck ? (
            <div className="mt-2">
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void stopSearch()} data-testid="stop-search-btn">
                Use the best plan found so far
              </Button>
            </div>
          ) : null}
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
      {applied && !running ? (
        <HireSuggestionBox
          runId={runId}
          planKey={`${d.run.status}|${d.run.chosenScenario ?? ''}|${d.job?.status ?? ''}|${d.loads.length}`}
          canPlan={canPlan}
          superseded={superseded}
          busy={!!busy}
          expect={{ date: d.run.runDate, depotId: d.run.depot.id }}
          canEditProducts={canEditProducts}
          onUsed={async (newRunId) => {
            await load();
            await onChanged?.(newRunId);
          }}
        />
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
          {typeof s.palletUnits === 'number' ? (
            <Kpi
              label="Pallets · bay fill"
              value={`${palletText(s.palletUnits)} · ${s.avgBayFillPct ?? '—'}%`}
              title={`Pallets planned on the ${s.palletLoads ?? 0} load(s) of trucks with bays (mixed pallets: each product's cases / its cases per pallet, added up), and their average share of the bays.`}
              testId="kpi-pallets"
            />
          ) : null}
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

      {/* Owner decision 2 (5 Oct 2026): results saved without a photo ("Camera not working"), every one listed. */}
      {overlay && showCameraList ? <CameraExceptions list={overlay.cameraExceptions ?? []} alerts={overlay.cameraAlerts ?? []} testId="plan-camera" /> : null}

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
                <th className="p-2" title="Cases / the truck's capacity; a truck with bays is loaded by pallets: pallets / bays">
                  Load / capacity
                </th>
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
                      {l.hired ? (
                        <Badge variant="outline" className="ml-1 text-[10px]" title={l.oneDay ? `Hired for ${l.oneDay} only (hire suggestion)` : 'Hired from outside'} data-testid={`load-hired-${l.truckCode}-${l.loadNo}`}>
                          {l.oneDay ? 'hired · 1 day' : 'hired'}
                        </Badge>
                      ) : null}
                      {l.oneDay && canPlan && !superseded && !ON_ROAD.has(l.status) ? (
                        <Button
                          size="sm"
                          variant="link"
                          className="ml-1 h-auto p-0 text-xs"
                          disabled={!!busy}
                          title="Enter the hired truck's real plate (its truck code)"
                          onClick={(e) => {
                            e.stopPropagation();
                            void setPlate(l);
                          }}
                          data-testid={`load-plate-${l.truckCode}-${l.loadNo}`}
                        >
                          Plate
                        </Button>
                      ) : null}
                    </td>
                    <td className="p-2" onClick={(e) => e.stopPropagation()}>
                      <LoadDriver
                        l={l}
                        drivers={drivers}
                        editable={canPlan && !superseded && !running && !ON_ROAD.has(l.status)}
                        busy={!!busy}
                        onChange={(id) => setDriver(l, id)}
                        onAddDaily={() => setCasualFor(l)}
                        onKeep={() => setDriver(l, l.driverId, true)}
                        pdfUrl={`/api/runs/${runId}/export/pdf?load=${l.id}`}
                        clash={clashes.find((c) => c.loadIds.includes(l.id))?.text ?? null}
                        whatsapp={
                          superseded
                            ? { off: 'This plan version was replaced: send the trip from the latest version.' }
                            : running
                              ? { off: 'Wait for the optimization to finish: the trips are about to change.' }
                              : {
                                  // The driver link line only with an active link (not revoked, expired or missing).
                                  url: whatsappUrl(l.driverPhone, whatsappText(d.run, l, trips.get(l.truckId) ?? l.loadNo, { driverLinkUrl: linkOf(l.truckId)?.url ?? null }), phoneCountryCode),
                                  number: whatsappNumber(l.driverPhone, phoneCountryCode),
                                }
                        }
                        // The dispatcher (PLANNER+) without a usable link yet: WhatsApp opens the Driver link dialog first.
                        linkFirst={canPlan && !superseded && !running && (!linkOf(l.truckId) || !!linkOf(l.truckId)?.keyChanged)}
                        onLink={canPlan && !superseded && !running ? () => setLinkDialog({ truckId: l.truckId, loadId: l.id }) : null}
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
                      {ON_ROAD.has(l.status) && overlay?.loads[l.id] ? <LoadProgress o={overlay.loads[l.id]!} tag={`${l.truckCode}-${l.loadNo}`} tz={overlay.tz} /> : null}
                      {lateNotes.find((n) => n.loadId === l.id) ? (
                        <span className="mt-1 block text-xs text-amber-700" data-testid={`load-late-dispatch-${l.truckCode}-${l.loadNo}`}>
                          {lateNotes.find((n) => n.loadId === l.id)!.text}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2">
                      {hhmm(l.departMin)} → {hhmm(l.returnMin)}
                      {l.break ? (
                        <span className="block text-xs text-muted-foreground" data-testid="load-break">
                          break {breakTimes(l.break)}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2">{l.stops.length}</td>
                    <td className="p-2">
                      <LoadCapacityCell l={l} />
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
                          noDriver={!l.driverId}
                          onStatus={(st) => setStatus(l, st)}
                        />
                      ) : null}
                    </td>
                  </tr>
                  {open[l.id] ? (
                    <tr className="bg-muted/20">
                      <td colSpan={13} className="p-3">
                        <LoadDetail
                          l={l}
                          depotCode={d.run.depot.code}
                          overlay={overlay}
                          canRecord={canPlan && ON_ROAD.has(l.status)}
                          onRecord={(st, ov) =>
                            setRecordFor({
                              depotId: d.run.depot.id,
                              date: d.run.runDate,
                              truckId: l.truckId,
                              truckCode: l.truckCode,
                              loadNo: l.loadNo,
                              sequence: st.sequence,
                              customerName: st.customerName,
                              customerCode: st.customerCode,
                              lines: ov.lines,
                              current: ov.outcome ? { outcome: ov.outcome, reason: ov.reason, note: ov.note } : null,
                              times: officeTimesPrefill(ov, overlay?.tz ?? 'Asia/Muscat'),
                            })
                          }
                          onPhotos={(st, ov) => setPhotosFor({ title: `${l.truckCode} L${l.loadNo} stop ${st.sequence} · ${st.customerName}`, photos: ov.photos })}
                        />
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

      {canPlan && linkDialog ? (
        <DriverLinkDialog
          open
          onOpenChange={(o) => {
            if (!o) setLinkDialog(null);
          }}
          runId={runId}
          truckId={linkDialog.truckId}
          truckCode={dialogLoad?.truckCode ?? ''}
          date={d.run.runDate}
          timezone={d.timezone || 'Asia/Muscat'}
          link={linkOf(linkDialog.truckId)}
          driverName={dialogLoad?.driverName ?? null}
          driverPhone={dialogLoad?.driverPhone ?? null}
          phoneCountryCode={phoneCountryCode}
          onChanged={keepLink}
        />
      ) : null}
      <CasualDriverDialog
        load={casualFor ? { id: casualFor.id, truckCode: casualFor.truckCode, loadNo: casualFor.loadNo } : null}
        onOpenChange={(o) => {
          if (!o) setCasualFor(null);
        }}
        submit={(body) => (casualFor ? addDailyDriver(casualFor, body) : Promise.resolve(null))}
      />
      <ReissueLinkPrompt
        text={reissueAsk?.text ?? null}
        onKeep={() => setReissueAsk(null)}
        onReissue={() => {
          const ask = reissueAsk;
          setReissueAsk(null);
          if (ask) void reissueNow(ask.link);
        }}
      />
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
            // "Re-plan now?" and Quick or Thorough in one dialog (Cancel = not now).
            confirmReplan: async () => {
              lateOrderMode.current = await askSearchMode('Late order saved. Re-plan now? Locked and dispatched loads stay exactly as they are.');
              return lateOrderMode.current !== null;
            },
            replan: async () => {
              await replan('LATE_ORDER', lateOrderMode.current ?? undefined);
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
      {/* Delivery outcome (spec section 10.2): Record outcome and the photo viewer. */}
      <OutcomeDialog
        open={!!recordFor}
        onOpenChange={(v) => {
          if (!v) setRecordFor(null);
        }}
        target={recordFor}
        onSaved={() => {
          // A result can complete a load that is back: the plan and its results again, in place (the open
          // loads stay open), and the day's Deliveries card - also while a search runs.
          void load({ results: true });
          onResultRecorded?.();
        }}
      />
      <PhotoViewer open={!!photosFor} onOpenChange={(v) => (v ? null : setPhotosFor(null))} title={photosFor?.title ?? ''} photos={photosFor?.photos ?? []} timezone={overlay?.tz ?? d.timezone ?? 'Asia/Muscat'} />
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
  onAddDaily,
  linkFirst = false,
  onLink = null,
}: {
  l: DetailLoad;
  drivers: DriverOption[];
  editable: boolean;
  busy: boolean;
  onChange: (driverId: string | null) => void;
  /** "+ Add daily driver…" (owner rule 20): a daily driver added from this load. */
  onAddDaily?: () => void;
  /** No usable driver link for the truck-day yet: WhatsApp opens the Driver link dialog first (it makes the link). */
  linkFirst?: boolean;
  /** Opens the truck-day's Driver link dialog (PLANNER+); null = no Link action. */
  onLink?: (() => void) | null;
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
        onChange={(e) => (e.target.value === ADD_DAILY ? onAddDaily?.() : onChange(e.target.value || null))}
        data-testid={`driver-select-${tag}`}
      >
        <option value="">No driver</option>
        {options.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
            {x.casual ? ' (daily)' : ''}
            {x.active ? '' : ' (inactive)'}
          </option>
        ))}
        {editable && onAddDaily ? <option value={ADD_DAILY}>+ Add daily driver…</option> : null}
      </select>
      <div className="flex gap-2 text-xs">
        <a className="text-primary underline-offset-2 hover:underline" href={pdfUrl} target="_blank" rel="noreferrer" data-testid={`load-pdf-${tag}`} title="Driver sheet for this load">
          PDF
        </a>
        {onLink ? (
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            onClick={onLink}
            data-testid={`load-link-${tag}`}
            title="Driver link (QR): the driver's phone page with his trips, for every trip of this truck today"
          >
            Link
          </button>
        ) : null}
        {'url' in whatsapp && linkFirst && onLink ? (
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            onClick={onLink}
            data-testid={`load-whatsapp-${tag}`}
            title="Make the driver link first: the dialog sends it on WhatsApp"
          >
            WhatsApp
          </button>
        ) : 'url' in whatsapp ? (
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
  noDriver = false,
  onStatus,
}: {
  l: DetailLoad;
  /** Owner rule 20: Dispatch is off until the load has a driver (the server refuses it too: 409 DRIVER_REQUIRED). */
  noDriver?: boolean;
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
    out.push(b('Dispatch', 'DISPATCHED', <Send className="mr-1 h-3 w-3" />, canFreeze && !noDriver, timingTitle ?? (noDriver ? DISPATCH_NEEDS_DRIVER : undefined)));
  }
  if (l.status === 'DISPATCHED' && canDispatch) out.push(b('Completed', 'COMPLETED', <Flag className="mr-1 h-3 w-3" />));
  return <div className="flex flex-wrap gap-1">{out}</div>;
}

/** The driver break as a row of the stop table, where it is taken (never while unloading). */
function BreakRow({ l }: { l: DetailLoad }) {
  if (!l.break) return null;
  return (
    <tr className="border-b bg-muted/40" data-testid="break-row">
      <td className="py-1">—</td>
      <td colSpan={9}>
        {breakLine(l.break, l.stops.length)} · driver break, {l.break.lengthMin} min
      </td>
    </tr>
  );
}

/** The Loads table's delivery progress of a load that left: "Delivered 7/12", "1 not delivered", "2 no result", "Back 14:32". */
function LoadProgress({ o, tag, tz }: { o: NonNullable<OutcomeOverlay['loads'][string]>; tag: string; tz: string }) {
  const back = o.backAtDepotAt ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(o.backAtDepotAt)) : null;
  return (
    <span className="mt-1 flex flex-wrap gap-1" data-testid={`load-progress-${tag}`}>
      <Badge variant="secondary" title={`${o.done} of ${o.total} stops have a result`}>
        Delivered {o.delivered}/{o.total}
      </Badge>
      {o.partly ? <Badge variant="warning">{o.partly} partly</Badge> : null}
      {o.notDelivered ? <Badge variant="destructive">{o.notDelivered} not delivered</Badge> : null}
      {o.noResult ? <Badge variant="warning">{o.noResult} no result</Badge> : null}
      {/* Owner decision 2 (5 Oct 2026): this truck's driver link used "Camera not working" 3 times or more today. */}
      {(o.cameraFailedToday ?? 0) >= CAMERA_ALERT_PER_DAY ? (
        <Badge variant="destructive" title="Results saved without a photo by this truck's driver link today: check the phone's camera with the driver" data-testid={`load-camera-alert-${tag}`}>
          No photo {o.cameraFailedToday}× today
        </Badge>
      ) : null}
      {back ? <span className="text-xs text-muted-foreground">Back {back}</span> : null}
    </span>
  );
}

const fmtClock = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso)) : '—');

/** The result chip of a stop: "Delivered", "Not delivered · Shop closed (driver)", "→ 6 Oct", with its notes. */
function ResultCell({ o }: { o: OverlayStop }) {
  const tone = o.outcome === 'DELIVERED' ? 'success' : o.outcome === 'PARTLY_DELIVERED' ? 'warning' : o.outcome === 'NOT_DELIVERED' ? 'destructive' : 'outline';
  const label = o.outcome === 'DELIVERED' ? 'Delivered' : o.outcome === 'PARTLY_DELIVERED' ? `Partly ${o.casesDelivered ?? 0}/${o.casesPlanned}` : o.outcome === 'NOT_DELIVERED' ? 'Not delivered' : 'No result';
  return (
    <div className="space-y-0.5" data-testid="stop-result">
      <Badge variant={tone}>{label}</Badge>
      {o.reasonText ? <span className="block">{o.reasonText}</span> : null}
      {o.source ? <span className="block text-muted-foreground">by {o.source === 'dispatcher' && o.by ? `${o.by} (office)` : o.source}</span> : null}
      {o.carriedTo ? <span className="block font-medium">→ {fmtDayMonth(o.carriedTo)}</span> : null}
      {o.late ? <span className="block text-amber-700">recorded after the trip closed</span> : null}
      {o.noPhotoText ? <span className="block text-amber-700">{o.noPhotoText}</span> : null}
      {o.carryConflict ? <span className="block font-medium text-red-700">changed after it was brought forward: {o.carryConflict}</span> : null}
    </div>
  );
}

/** The result columns of one stop of a load that left: Result, Arrived, Left, Unload, Photos, [Record]. */
function StopResultCells({ o, tz, canRecord, onRecord, onPhotos }: { o: OverlayStop | null; tz: string; canRecord: boolean; onRecord: (o: OverlayStop) => void; onPhotos: (o: OverlayStop) => void }) {
  if (!o) return <td colSpan={6} className="text-muted-foreground">—</td>;
  return (
    <>
      <td className="max-w-[200px]">
        <ResultCell o={o} />
      </td>
      <td data-testid="stop-arrived">
        {fmtClock(o.arrivedAt, tz)}
        {o.arrivalNote ? <span className="block text-muted-foreground">{o.arrivalNote}</span> : null}
        {o.downgradedArrival ? <span className="block text-muted-foreground" title="The phone was far from the pin: the automatic arrival counts as manual">far from pin</span> : null}
      </td>
      <td data-testid="stop-left">
        {fmtClock(o.departedAt, tz)}
        {o.departureNote ? <span className="block text-muted-foreground">{o.departureNote}</span> : null}
      </td>
      <td data-testid="stop-unload" title={o.actualLabel ?? undefined}>
        {o.plannedMin !== null || o.actualMin !== null ? `plan ${o.plannedMin ?? '—'} / actual ${o.actualMin ?? '—'} min` : '—'}
        {o.timingSuspect ? <span className="block text-amber-700">unverified timing</span> : null}
      </td>
      <td>
        {o.photos.length ? (
          <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => onPhotos(o)} data-testid="stop-photos">
            {o.photos.length} photo{o.photos.length === 1 ? '' : 's'}
          </button>
        ) : (
          '—'
        )}
        {o.photoMissing ? <span className="block text-muted-foreground">{o.photoMissing} not received yet</span> : null}
      </td>
      <td>
        {canRecord ? (
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => onRecord(o)} data-testid="stop-record">
            Record
          </Button>
        ) : null}
      </td>
    </>
  );
}

/**
 * The loads table's "Load / capacity" cell: cases / the truck's case capacity, or for a load planned by
 * pallets (a truck with bays) its cases and "11.1 / 12 plt" (pallets / bays; the title gives the limit
 * at the Pallet fill). Cases stay first: orders, invoices and stops are in cases.
 */
function LoadCapacityCell({ l }: { l: DetailLoad }) {
  const p = loadPallets(l);
  if (!p) {
    return (
      <>
        {l.cases} / {l.truckCapacityCases}
      </>
    );
  }
  return (
    <span title={`Pallets ${palletsOverBays(p)} bays (${palletLimitText(p)}); the truck's case capacity is not used`} data-testid={`load-pallets-${l.truckCode}-${l.loadNo}`}>
      {l.cases.toLocaleString()} cs
      <span className="block text-xs text-muted-foreground">{palletsOverBays(p)} plt</span>
    </span>
  );
}

function LoadDetail({
  l,
  depotCode,
  overlay = null,
  canRecord = false,
  onRecord,
  onPhotos,
}: {
  l: DetailLoad;
  depotCode: string;
  /** The delivery results (spec section 10.2); the extra columns show for loads that left. */
  overlay?: OutcomeOverlay | null;
  canRecord?: boolean;
  onRecord?: (st: DetailLoad['stops'][number], o: OverlayStop) => void;
  onPhotos?: (st: DetailLoad['stops'][number], o: OverlayStop) => void;
}) {
  // A6 second review: an older version whose orders a later re-plan re-weighed says so (as its Excel sheet does).
  const kgNote = manifestKgNote(l);
  const results = ON_ROAD.has(l.status) && !!overlay;
  const tz = overlay?.tz ?? 'Asia/Muscat';
  const span = results ? 15 : 9;
  // A load planned by pallets: each product's "3 pallets + 12 cases" and the TOTAL in pallets too.
  const pallets = loadPallets(l);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Loading manifest</p>
        {pallets ? (
          <p className="mb-1 text-xs text-muted-foreground" data-testid={`manifest-pallets-${l.truckCode}-${l.loadNo}`}>
            Pallets {palletsOverBays(pallets)} ({palletLimitText(pallets)})
          </p>
        ) : null}
        <table className="w-full text-xs" data-testid={`manifest-${l.truckCode}-${l.loadNo}`}>
          <tbody>
            {l.manifest.map((m) => (
              <tr key={m.productCode} className="border-b">
                <td className="py-1 pr-2 font-mono">{m.productCode}</td>
                <td className="py-1 pr-2">{m.productName}</td>
                <td className="py-1 text-right font-semibold">{m.cases}</td>
                {pallets ? (
                  <td className="py-1 pl-2 text-right" title={m.casesPerPallet ? `${m.casesPerPallet} cases per pallet` : 'No cases per pallet'}>
                    {fullAndLooseText(m.cases, m.casesPerPallet)}
                  </td>
                ) : null}
                {/* Audit E3 (A6 review): each product's kg, which add up to the load's kg (to 0.1 kg). */}
                <td className="py-1 pl-2 text-right text-muted-foreground">{kgText(m.weightKg)} kg</td>
              </tr>
            ))}
            <tr>
              <td colSpan={2} className="py-1 font-semibold">
                TOTAL
              </td>
              <td className="py-1 text-right font-semibold">{l.cases}</td>
              {pallets ? <td className="py-1 pl-2 text-right font-semibold">{palletText(pallets.units)} pallets</td> : null}
              <td className="py-1 pl-2 text-right font-semibold">{kgText(l.weightKg)} kg</td>
            </tr>
          </tbody>
        </table>
        {pallets ? (
          <p className="mt-1 text-xs text-muted-foreground" data-testid={`manifest-pallet-total-${l.truckCode}-${l.loadNo}`}>
            {manifestTotalText(l.cases, pallets.units, manifestPalletTotals(l.manifest))}
          </p>
        ) : null}
        {(l.palletNotes ?? []).map((n) => (
          <p key={n} className="mt-1 text-xs text-amber-700">
            {n}
          </p>
        ))}
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
              {results ? (
                <>
                  <th>Result</th>
                  <th>Arrived</th>
                  <th>Left</th>
                  <th title="Unloading minutes: planned / actual (from the window start when the truck waited)">Unload</th>
                  <th>Photos</th>
                  <th />
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b">
              <td className="py-1">—</td>
              <td colSpan={span}>
                DEPOT {depotCode} — depart {hhmm(l.departMin)}
              </td>
            </tr>
            {l.break && (l.break.where === 'DEPOT' || (l.break.afterSequence ?? 0) === 0) ? <BreakRow l={l} /> : null}
            {l.stops.map((st) => (
              <Fragment key={st.sequence}>
              <tr className="border-b align-top">
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
                  {overlay?.copyConflicts[`${l.id}:${st.sequence}`] ? (
                    <Badge variant="destructive" className="mt-0.5" data-testid="stop-copy-conflict">
                      {overlay.copyConflicts[`${l.id}:${st.sequence}`]}
                    </Badge>
                  ) : null}
                  {!st.snapshot ? <span className="block text-muted-foreground" title="Planned before stop details were kept with the plan">current customer data</span> : null}
                </td>
                <td>P{st.priority}</td>
                <td className={st.hardWindowOk === false ? 'text-red-600' : ''}>
                  {hhmm(st.etaMin)}
                  {st.departureMin !== null ? <span className="block text-muted-foreground">unloading until {hhmm(st.departureMin)}</span> : null}
                  {st.waitMin ? <span className="block text-muted-foreground">wait {st.waitMin}m</span> : null}
                </td>
                <td className={st.prefWindowOk === false ? 'text-amber-700' : ''}>{st.window}</td>
                <td>{st.serviceMin}m</td>
                <td>{st.cases}</td>
                <td className="max-w-[220px]">{st.skus.map((k) => `${k.productCode} ×${k.cases}`).join('; ')}</td>
                <td>{st.legKm}</td>
                <td>{st.cumulativeKm ?? '—'}</td>
                {results ? <StopResultCells o={overlay!.stops[`${l.id}:${st.sequence}`] ?? null} tz={tz} canRecord={canRecord} onRecord={(o) => onRecord?.(st, o)} onPhotos={(o) => onPhotos?.(st, o)} /> : null}
              </tr>
              {l.break && l.break.where === 'ROAD' && (l.break.afterSequence ?? 0) === st.sequence ? <BreakRow l={l} /> : null}
              </Fragment>
            ))}
            <tr>
              <td className="py-1">—</td>
              <td colSpan={span}>
                DEPOT — return {hhmm(l.returnMin)} (+{l.returnLegKm} km)
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
