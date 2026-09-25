'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Download, FileSpreadsheet, FileText, Loader2, Lock, MapPin, Play, RotateCcw, Send, Unlock } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { RunJobStatus, RunStatus } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ScenarioCards, type ScenarioCardData } from './scenario-cards';
import { RoutesTab, type RouteRow as RoutesTabRow } from './routes-tab';
import { BaselineTab, type BaselineRow } from './baseline-tab';
import { MapTab, type MapStop, type MapTruck } from './map-tab';
import { errorMessage } from '@/lib/error-message';
import { askOverride, type OptimizeOverrides } from '../../dispatch/client-api';

interface RunSummary {
  id: string;
  status: RunStatus;
  chosenScenarioId: string | null;
  unservedCount: number;
  totalOrders: number;
  optimizationMode: string;
  currentJobId: string | null;
  depot: { id: string; code: string; name: string; lat: number; lng: number };
  runDate: string;
}

interface JobRow {
  id: string;
  attemptNo: number;
  status: RunJobStatus;
  progressPct: number;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface RouteRow extends RoutesTabRow {
  customerBranchKey: string;
  customerLat: number | null;
  customerLng: number | null;
  locked: boolean;
}

interface Props {
  slug: string;
  canEdit: boolean;
  canDispatch: boolean;
  /** Company admin: can enter case weights under Products (the weight question says whom to ask). */
  canEditProducts?: boolean;
  currency: string;
  mapboxToken: string;
  run: RunSummary;
  scenarios: ScenarioCardData[];
  jobs: JobRow[];
  routes: RouteRow[];
  trucks: MapTruck[];
  unserved: { orderId: string; customerCode: string; customerName: string; cases: number; reason: string; lat: number | null; lng: number | null }[];
  baselines: BaselineRow[];
}

const RUN_STATUS_VARIANT: Record<RunStatus, 'default' | 'success' | 'warning' | 'secondary' | 'destructive' | 'outline'> = {
  DRAFT: 'outline',
  OPTIMIZING: 'warning',
  READY: 'success',
  FAILED: 'destructive',
  DISPATCHED: 'success',
  ARCHIVED: 'secondary',
  SUPERSEDED: 'secondary',
};

export function RunDetail({
  slug,
  canEdit,
  canDispatch,
  canEditProducts = false,
  currency,
  mapboxToken,
  run,
  scenarios,
  jobs,
  routes,
  trucks,
  unserved,
  baselines,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isActive = run.status === 'OPTIMIZING';
  const currentJob = jobs.find((j) => j.id === run.currentJobId) ?? jobs[0] ?? null;
  const isDispatched = run.status === 'DISPATCHED';

  const [tab, setTab] = useState<'scenarios' | 'routes' | 'map' | 'baseline'>('scenarios');
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchConfirm, setDispatchConfirm] = useState('');
  const [unlockOpen, setUnlockOpen] = useState(false);

  // Polling — only while optimizing.
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(async () => {
      try {
        const r = await fetch(`/api/runs/${run.id}/status`, { cache: 'no-store' });
        if (!r.ok) return;
        const body = await r.json();
        const newStatus = body?.data?.run?.status as RunStatus | undefined;
        if (newStatus && newStatus !== 'OPTIMIZING') router.refresh();
      } catch {
        // swallow
      }
    }, 1500);
    return () => clearInterval(interval);
  }, [isActive, run.id, router]);

  function optimize(retry = false, overrides: OptimizeOverrides = {}) {
    startTransition(async () => {
      const res = await fetch(`/api/runs/${run.id}/optimize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(overrides),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        // No location or no weight: the same questions as OPTIMIZE on the daily dispatch screen,
        // then the same request again with the dispatcher's go-ahead.
        const errorBody = body?.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : null;
        const more = askOverride(errorBody, 'Optimize', { canEditProducts });
        if (more) {
          optimize(retry, { ...overrides, ...more });
          return;
        }
        if (errorBody?.code === 'LOCATION_REQUIRED' || errorBody?.code === 'WEIGHT_REQUIRED') return;
        toast.error(errorMessage(body, 'Optimize failed to start.'));
        return;
      }
      toast.success(retry ? 'Retry queued.' : 'Optimization queued.');
      router.refresh();
    });
  }

  function chooseScenario(scenarioId: string) {
    startTransition(async () => {
      const res = await fetch(`/api/runs/${run.id}/choose-scenario`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Pick failed.'));
        return;
      }
      toast.success(`${body.data.assignmentsCreated} route assignments created.`);
      setTab('routes');
      router.refresh();
    });
  }

  function dispatch() {
    if (dispatchConfirm.trim().toLowerCase() !== run.depot.code.toLowerCase()) {
      toast.error(`Type "${run.depot.code}" to confirm.`);
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/runs/${run.id}/dispatch`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Dispatch failed.'));
        return;
      }
      toast.success('Run dispatched. Exports are now the final version.');
      setDispatchOpen(false);
      setDispatchConfirm('');
      router.refresh();
    });
  }

  function unlock() {
    startTransition(async () => {
      const res = await fetch(`/api/runs/${run.id}/unlock`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(errorMessage(body, 'Unlock failed.'));
        return;
      }
      toast.success('Run unlocked for further edits.');
      setUnlockOpen(false);
      router.refresh();
    });
  }

  // Build the data shapes the Map tab wants.
  const mapStops: MapStop[] = useMemo(
    () =>
      routes.map((r) => ({
        assignmentId: r.id,
        truckId: r.truckId,
        truckCode: r.truckCode,
        sequence: r.sequence,
        lat: r.customerLat,
        lng: r.customerLng,
        customerCode: r.customerCode,
        customerName: r.customerName,
        branchKey: r.customerBranchKey,
        cases: r.orderCases,
        arrivalMin: r.plannedArrivalMin,
        locked: r.locked,
      })),
    [routes],
  );

  return (
    <div className="space-y-4">
      {/* Top-line status + actions */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
          <div className="flex items-center gap-3">
            <Badge variant={RUN_STATUS_VARIANT[run.status]}>{run.status.toLowerCase()}</Badge>
            {currentJob ? (
              <span className="text-xs text-muted-foreground">
                Attempt #{currentJob.attemptNo} · {currentJob.status.toLowerCase()}
                {currentJob.message ? ` · ${currentJob.message}` : ''}
              </span>
            ) : null}
            {scenarios.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                {scenarios.length} scenario{scenarios.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && !isActive && !isDispatched && (run.status === 'DRAFT' || run.status === 'READY' || run.status === 'FAILED') ? (
              <Button size="sm" variant={run.status === 'FAILED' ? 'default' : 'default'} onClick={() => optimize(run.status === 'FAILED')} disabled={pending}>
                {run.status === 'FAILED' ? (
                  <>
                    <RotateCcw className="me-2 h-4 w-4" />
                    Retry optimization
                  </>
                ) : (
                  <>
                    <Play className="me-2 h-4 w-4" />
                    {run.status === 'READY' ? 'Re-optimize' : 'Optimize'}
                  </>
                )}
              </Button>
            ) : null}

            {/* Exports — available whenever there are routes */}
            {routes.length > 0 ? (
              <>
                <Button asChild size="sm" variant="outline">
                  <a href={`/api/runs/${run.id}/export/excel`} download>
                    <FileSpreadsheet className="me-2 h-4 w-4" />
                    Excel
                  </a>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a href={`/api/runs/${run.id}/export/pdf`} download>
                    <FileText className="me-2 h-4 w-4" />
                    PDF
                  </a>
                </Button>
              </>
            ) : null}

            {/* Live tracking — only meaningful once the run has been dispatched
                or stops are populated (drivers may sign in early to test). */}
            {routes.length > 0 ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/t/${slug}/runs/${run.id}/live`}>
                  <MapPin className="me-2 h-4 w-4" />
                  Live
                </Link>
              </Button>
            ) : null}

            {/* Dispatch */}
            {canDispatch && run.status === 'READY' && routes.length > 0 ? (
              <Button size="sm" onClick={() => setDispatchOpen(true)} disabled={pending}>
                <Send className="me-2 h-4 w-4" />
                Dispatch
              </Button>
            ) : null}
            {canDispatch && isDispatched ? (
              <Button size="sm" variant="outline" onClick={() => setUnlockOpen(true)} disabled={pending}>
                <Unlock className="me-2 h-4 w-4" />
                Unlock to edit
              </Button>
            ) : null}

            {isActive ? (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {currentJob?.progressPct ?? 0}%
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {isDispatched ? (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="flex items-center gap-2 pt-6 text-sm">
            <Lock className="h-4 w-4 text-green-700" />
            <span className="font-medium">
              Dispatched. Assignments are locked — click <span className="font-mono">Unlock to edit</span> to make changes.
            </span>
          </CardContent>
        </Card>
      ) : null}

      {/* Failure banner */}
      {run.status === 'FAILED' && currentJob ? <FailureBanner runId={run.id} job={currentJob} /> : null}

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="scenarios">Scenarios ({scenarios.length})</TabsTrigger>
          <TabsTrigger value="routes" disabled={routes.length === 0}>
            Routes ({routes.length})
          </TabsTrigger>
          <TabsTrigger value="map" disabled={routes.length === 0}>
            Map
          </TabsTrigger>
          <TabsTrigger value="baseline">Baseline ({baselines.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="scenarios">
          {scenarios.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {isActive ? 'Optimizing…' : 'No scenarios yet'}
                </CardTitle>
                <CardDescription>
                  {isActive
                    ? "We'll auto-refresh when the solver finishes. Polling every 1.5s."
                    : 'Click Optimize above to generate the three scenarios.'}
                </CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <ScenarioCards
              scenarios={scenarios}
              chosenScenarioId={run.chosenScenarioId}
              canPick={canEdit && run.status === 'READY'}
              onPick={chooseScenario}
              currency={currency}
            />
          )}
        </TabsContent>

        <TabsContent value="routes">
          <RoutesTab routes={routes} />
        </TabsContent>

        <TabsContent value="map">
          <MapTab
            runId={run.id}
            canEdit={canEdit && !isDispatched}
            mapboxToken={mapboxToken}
            depot={{ code: run.depot.code, lat: run.depot.lat, lng: run.depot.lng }}
            stops={mapStops}
            trucks={trucks}
            unserved={unserved}
          />
        </TabsContent>

        <TabsContent value="baseline">
          <BaselineTab
            slug={slug}
            runId={run.id}
            baselines={baselines}
            canUpload={canEdit && !isDispatched}
            chosenScenario={scenarios.find((s) => s.id === run.chosenScenarioId) ?? null}
          />
        </TabsContent>
      </Tabs>

      {/* Dispatch dialog */}
      <AlertDialog open={dispatchOpen} onOpenChange={setDispatchOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dispatch run for {run.runDate}?</AlertDialogTitle>
            <AlertDialogDescription>
              Dispatching locks assignments and marks orders as DISPATCHED. Exports become the final version. To
              confirm, type the depot code <strong>{run.depot.code}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="dispatch-confirm">Depot code</Label>
            <Input
              id="dispatch-confirm"
              value={dispatchConfirm}
              onChange={(e) => setDispatchConfirm(e.target.value)}
              placeholder={run.depot.code}
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDispatchOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={dispatch} disabled={pending}>
              {pending ? 'Dispatching…' : 'Confirm dispatch'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unlock dialog */}
      <AlertDialog open={unlockOpen} onOpenChange={setUnlockOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlock this dispatched run?</AlertDialogTitle>
            <AlertDialogDescription>
              The audit log will record this override. Drivers may still be acting on the prior exports.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setUnlockOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={unlock} disabled={pending}>
              {pending ? 'Unlocking…' : 'Unlock'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FailureBanner({ runId, job }: { runId: string; job: JobRow }) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="space-y-2 pt-6">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-destructive" />
          <h3 className="font-semibold">Optimization failed (attempt #{job.attemptNo})</h3>
        </div>
        <p className="text-sm text-muted-foreground">{job.message ?? 'Solver returned an error.'}</p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={`/api/runs/${runId}/jobs/${job.id}/debug`} download={`runjob-${job.attemptNo}.json`}>
              <Download className="me-2 h-4 w-4" />
              Download debug JSON
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
