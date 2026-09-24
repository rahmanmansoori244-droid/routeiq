'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, MapPin, Pencil, Upload, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from './client-api';
import { LocationDialog } from './location-dialog';
import { CustomerDialog, type EditableCustomer } from './customer-dialog';
import { PlanView } from './plan-view';

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
  productsWithoutWeight: { code: string; name: string }[];
  plan: null | { id: string; version: number; status: string; chosen: boolean; job: { status: string; message: string | null; progressPct: number } | null };
  pending: { count: number; cases: number; late: number };
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
  issues: { newCustomers: { code: string; name: string }[]; newProducts: { code: string; name: string }[]; customersWithoutLocation: string[] };
  mapping: Record<string, string>;
  late: { isLate: boolean; reasons: string[] };
  depotCode: string;
}

interface Props {
  slug: string;
  canPlan: boolean;
  canDispatch: boolean;
  initialDate: string | null;
  initialDepot: string | null;
}

export function DispatchClient({ slug, canPlan, canDispatch, initialDate, initialDepot }: Props) {
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
  const [planKey, setPlanKey] = useState(0);
  const [showAllCustomers, setShowAllCustomers] = useState(false);

  const refresh = useCallback(async () => {
    const q = new URLSearchParams();
    if (date) q.set('date', date);
    if (depotId) q.set('depotId', depotId);
    const r = await api<Day>(`/api/dispatch/day?${q}`);
    if (r.ok && r.data) {
      setDay(r.data);
      if (!date) setDate(r.data.date);
      if (!depotId && r.data.depot) setDepotId(r.data.depot.id);
    } else toast.error(r.error ?? 'Could not load the day.');
  }, [date, depotId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while an optimization runs.
  useEffect(() => {
    const running = day?.plan?.status === 'OPTIMIZING' || day?.plan?.job?.status === 'RUNNING' || day?.plan?.job?.status === 'QUEUED';
    if (!running) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [day, refresh]);

  function changeDay(nextDate: string, nextDepot: string | null) {
    setDate(nextDate);
    setDepotId(nextDepot);
    setBatch(null);
    const q = new URLSearchParams({ date: nextDate, ...(nextDepot ? { depot: nextDepot } : {}) });
    router.replace(`/t/${slug}/dispatch?${q}`);
  }

  async function upload() {
    if (!file || !day?.depot) return;
    setUploading(true);
    const fd = new FormData();
    fd.set('file', file);
    fd.set('depotId', day.depot.id);
    fd.set('deliveryDate', day.date);
    const res = await fetch('/api/orders/upload', { method: 'POST', body: fd });
    const body = await res.json().catch(() => ({}));
    setUploading(false);
    if (!res.ok) {
      toast.error(typeof body.error === 'string' ? body.error : 'Upload failed.');
      return;
    }
    setBatch({ id: body.data.batchId, v: body.data.validation });
    setLateReason('');
  }

  async function confirmBatch() {
    if (!batch) return;
    const r = await api<{ ordersCreated: number; cases: number; customersCreated: number; deliveryDates: string[] }>(`/api/orders/${batch.id}/confirm`, {
      method: 'POST',
      json: batch.v.late.isLate ? { lateReason } : {},
    });
    if (!r.ok || !r.data) {
      toast.error(r.error ?? 'Confirm failed.');
      return;
    }
    toast.success(`${r.data.ordersCreated} orders (${r.data.cases} cases) added${r.data.customersCreated ? `, ${r.data.customersCreated} new customers need a location` : ''}.`);
    setBatch(null);
    setFile(null);
    const d0 = r.data.deliveryDates[0];
    if (d0 && d0 !== date) changeDay(d0, depotId);
    else await refresh();
  }

  async function optimize(allowMissing = false) {
    if (!day?.depot || !date) return;
    setOptimizing(true);
    let r;
    if (day.plan?.chosen) {
      r = await api<{ runId: string }>(`/api/runs/${day.plan.id}/replan`, { method: 'POST', json: { reason: day.pending.late ? 'LATE_ORDER' : 'REOPTIMIZE', allowMissingLocations: allowMissing } });
    } else {
      r = await api<{ runId: string }>('/api/dispatch/plan', { method: 'POST', json: { date, depotId: day.depot.id, optimize: true, allowMissingLocations: allowMissing } });
    }
    setOptimizing(false);
    if (!r.ok) {
      if (r.errorBody?.code === 'LOCATION_REQUIRED') {
        const n = (r.errorBody.blocking as unknown[])?.length ?? 0;
        if (window.confirm(`${n} customer(s) still have no location. Their orders will be UNSERVED with reason "location missing". Optimize anyway?`)) {
          return optimize(true);
        }
        return;
      }
      toast.error(r.error ?? 'Could not start optimization.');
      return;
    }
    toast.success('Optimizing… this takes up to a minute for a normal day.');
    setPlanKey((k) => k + 1);
    await refresh();
  }

  if (!day) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!day.depot) return <p className="text-sm">No active depot. Create a depot and trucks first.</p>;

  const blocking = day.customers.filter((c) => c.blocking);
  const notes = day.customers.filter((c) => !c.blocking && c.issues.some((i) => i.code !== 'LOCATION_UNVERIFIED' && i.code !== 'NEW_CUSTOMER'));
  const running = day.plan?.status === 'OPTIMIZING' || day.plan?.job?.status === 'RUNNING' || day.plan?.job?.status === 'QUEUED';
  const needsPlan = day.orders.count > 0 && (!day.plan?.chosen || day.pending.count > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="d-date">Delivery date</Label>
          <Input id="d-date" type="date" value={day.date} onChange={(e) => e.target.value && changeDay(e.target.value, depotId)} className="w-44" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="d-depot">Depot</Label>
          <select id="d-depot" className="h-9 rounded-md border bg-background px-2 text-sm" value={day.depot.id} onChange={(e) => changeDay(day.date, e.target.value)}>
            {day.depots.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} — {d.name}
              </option>
            ))}
          </select>
        </div>
        <p className="pb-2 text-xs text-muted-foreground">
          Order cutoff {day.cutoff} the day before · {day.trucks.active} trucks ({day.trucks.capacityCases.toLocaleString()} cases per load round)
        </p>
      </div>

      {/* STEP 1 */}
      <Step n={1} title="Upload orders" done={day.orders.count > 0} summary={`${day.orders.count} orders · ${day.orders.customers} customers · ${day.orders.cases.toLocaleString()} cases${day.orders.late ? ` · ${day.orders.late} late` : ''}`}>
        {canPlan ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm hover:bg-muted/40">
              <FileSpreadsheet className="h-4 w-4" />
              <span>{file ? file.name : 'Choose the sales order file (Excel or CSV)'}</span>
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" data-testid="order-file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setBatch(null); }} />
            </label>
            <Button onClick={upload} disabled={!file || uploading} data-testid="upload-btn">
              {uploading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
              Check file
            </Button>
          </div>
        ) : null}
        {batch ? <ValidationPanel v={batch.v} lateReason={lateReason} setLateReason={setLateReason} onConfirm={confirmBatch} onCancel={() => setBatch(null)} /> : null}
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
        summary={blocking.length ? `${blocking.length} customer(s) need a location` : day.orders.count ? 'All delivery locations known' : '—'}
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
          <p className="text-xs text-amber-700">
            {day.productsWithoutWeight.length} product(s) have no case weight ({day.productsWithoutWeight.map((p) => p.code).join(', ')}): truck payload (kg) checks treat them as 0 kg. Add weights under Products.
          </p>
        ) : null}
      </Step>

      {/* STEP 3 */}
      <Step
        n={3}
        title="Optimize"
        done={!!day.plan?.chosen && day.pending.count === 0 && !running}
        summary={
          running
            ? `Optimizing… ${day.plan?.job?.message ?? ''}`
            : day.plan?.chosen
              ? `Plan version ${day.plan.version} ready${day.pending.count ? ` · ${day.pending.count} new order(s) not planned yet` : ''}`
              : 'Not optimized yet'
        }
      >
        {day.pending.count > 0 && day.plan?.chosen ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="pending-orders">
            {day.pending.count} order(s) ({day.pending.cases} cases{day.pending.late ? `, ${day.pending.late} late` : ''}) arrived after this plan. Re-plan to add them — locked and dispatched loads are kept exactly as they are.
          </div>
        ) : null}
        {canPlan ? (
          <Button onClick={() => optimize(false)} disabled={optimizing || running || !needsPlan} data-testid="optimize-btn" size="lg">
            {optimizing || running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wand2 className="mr-2 h-4 w-4" />}
            {day.plan?.chosen ? 'RE-PLAN' : 'OPTIMIZE'}
          </Button>
        ) : null}
        {!needsPlan && day.plan?.chosen ? <p className="text-xs text-muted-foreground">The plan is up to date with all orders.</p> : null}
      </Step>

      {/* STEPS 4-5 */}
      {day.plan ? (
        <Step n={4} title="Review plan · 5 Lock, export, dispatch" done={day.plan.status === 'DISPATCHED'} summary={`Version ${day.plan.version} · ${day.plan.status}`}>
          <PlanView
            key={`${day.plan.id}-${planKey}`}
            slug={slug}
            runId={day.plan.id}
            canPlan={canPlan}
            canDispatch={canDispatch}
            onChanged={() => {
              setPlanKey((k) => k + 1);
              void refresh();
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
      <p className="mt-1 text-xs">
        Location: {needsLoc ? <b className="text-red-700">{c.issues.find((i) => i.blocking)?.code === 'INVALID_LOCATION' ? 'INVALID' : 'MISSING'}</b> : c.locationVerified ? 'confirmed' : 'imported'} · Window: {c.window}
      </p>
      {c.issues
        .filter((i) => !i.blocking && i.code !== 'NEW_CUSTOMER')
        .map((i) => (
          <p key={i.code} className="text-xs text-muted-foreground">
            • {i.message}
          </p>
        ))}
      {canPlan ? (
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

function ValidationPanel({ v, lateReason, setLateReason, onConfirm, onCancel }: { v: Validation; lateReason: string; setLateReason: (s: string) => void; onConfirm: () => void; onCancel: () => void }) {
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
      {v.issues.newProducts.length ? <p className="text-amber-800">{v.issues.newProducts.length} new product(s) will be created: {v.issues.newProducts.map((p) => p.code).join(', ')} (add their case weight)</p> : null}
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
        <Button onClick={onConfirm} disabled={!ok || (v.late.isLate && lateReason.trim().length < 3)} data-testid="confirm-upload">
          Add {v.totals.lines} lines to the day
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
