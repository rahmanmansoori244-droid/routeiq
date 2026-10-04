'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { errorMessage } from '@/lib/error-message';
import {
  START_FRESH_ALSO_KEPT,
  START_FRESH_BACKUP_REMINDER,
  START_FRESH_KEPT,
  START_FRESH_LIVE_TICK,
  START_FRESH_PREVIEW_MAX_AGE_MS,
  START_FRESH_REMOVED,
  startFreshConfirmMatches,
  startFreshHasLive,
  startFreshLiveText,
  startFreshScopeText,
  startFreshShown,
  startFreshTotal,
  type StartFreshReport,
} from '@/lib/start-fresh-text';

/**
 * Settings, company admins only: "Start fresh (remove test data)" (owner request 4 Oct 2026). A
 * clearly separated danger section: the backup reminder, everything or only before a date, the
 * preview (what is removed and what is kept, what may already be real, and what refuses the run
 * now), the typed company code, the backup tick (and the live-data tick when needed), then the
 * summary. The run sends the preview it was shown: when there is more to remove now, the API
 * refuses (PREVIEW_STALE) and this panel checks again and shows the new numbers. A preview older
 * than START_FRESH_PREVIEW_MAX_AGE_MS is dropped. The API decides again under its locks
 * (lib/start-fresh.ts); this panel only shows.
 */
export function StartFreshPanel({ slug }: { slug: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'ALL' | 'BEFORE'>('ALL');
  const [before, setBefore] = useState('');
  const [preview, setPreview] = useState<StartFreshReport | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [typed, setTyped] = useState('');
  const [backup, setBackup] = useState(false);
  const [liveOk, setLiveOk] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<StartFreshReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const scopeBefore = mode === 'BEFORE' ? before : null;
  const dateMissing = mode === 'BEFORE' && !before;

  // An old check is not what the database holds now: drop it, the admin checks again.
  useEffect(() => {
    if (!preview) return;
    const left = Math.max(0, checkedAt + START_FRESH_PREVIEW_MAX_AGE_MS - Date.now());
    const timer = setTimeout(() => {
      setPreview(null);
      setLiveOk(false);
      setProblem('That check is more than 5 minutes old. Press "Check what will be removed" again before removing.');
    }, left);
    return () => clearTimeout(timer);
  }, [preview, checkedAt]);

  function changeScope(next: () => void) {
    next();
    setPreview(null);
    setLiveOk(false);
    setDone(null);
    setProblem(null);
  }

  /** The preview for `forBefore`; false when it could not be read (the problem is shown). */
  async function check(forBefore: string | null = scopeBefore): Promise<boolean> {
    setChecking(true);
    setProblem(null);
    setDone(null);
    setLiveOk(false);
    try {
      const q = forBefore ? `?before=${encodeURIComponent(forBefore)}` : '';
      const res = await fetch(`/api/tenant/start-fresh${q}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setPreview(null);
        setProblem(res.status === 429 ? 'Too many checks. Wait a minute, then check again.' : errorMessage(body, 'Could not check what would be removed. Try again.'));
        return false;
      }
      setPreview(body.data as StartFreshReport);
      setCheckedAt(Date.now());
      return true;
    } catch {
      setProblem('Could not reach RouteIQ. Check the connection and try again.');
      return false;
    } finally {
      setChecking(false);
    }
  }

  async function run() {
    if (!preview) return;
    setRunning(true);
    setProblem(null);
    try {
      const res = await fetch('/api/tenant/start-fresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: typed, before: preview.before, backupConfirmed: backup, expect: startFreshShown(preview), liveDataConfirmed: liveOk }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const code = (body?.error as { code?: unknown } | null)?.code;
        const message = errorMessage(
          body,
          res.status === 429 ? 'Too many attempts. Wait a few minutes, then check again. Nothing was removed.' : 'Nothing was removed. Try again.',
        );
        if (code === 'PREVIEW_STALE') {
          // Show what the database holds now; the admin reads it and confirms again.
          setTyped('');
          if (await check(preview.before)) setProblem(message);
          return;
        }
        setProblem(message);
        return;
      }
      const result = body.data as StartFreshReport;
      setDone(result);
      setPreview(null);
      setTyped('');
      setBackup(false);
      setLiveOk(false);
      toast.success(`Removed ${startFreshTotal(result.removed).toLocaleString()} records.`);
      router.refresh();
    } catch {
      setProblem('Could not reach RouteIQ. Nothing may have been removed: press "Check what will be removed" to see.');
    } finally {
      setRunning(false);
    }
  }

  const total = preview ? startFreshTotal(preview.removed) : 0;
  const blocked = !!preview?.blockers.length;
  const live = preview ? startFreshLiveText(preview.live) : null;
  const needsLiveTick = !!preview && startFreshHasLive(preview.live);
  const canRun = !!preview && !blocked && total > 0 && backup && (!needsLiveTick || liveOk) && startFreshConfirmMatches(typed, slug) && !running;
  const keptRows = (r: StartFreshReport) =>
    START_FRESH_KEPT.filter((k) => !('dateOnly' in k && k.dateOnly) || r.before).map((k) => ({ label: k.label, value: r.kept[k.key] }));
  const doneLive = done ? startFreshLiveText(done.live, true) : null;

  return (
    <Card className="border-2 border-destructive/60" aria-labelledby="start-fresh-title">
      <CardHeader>
        <CardTitle id="start-fresh-title" className="text-destructive">
          Start fresh (remove test data)
        </CardTitle>
        <CardDescription>
          Removes this company&apos;s orders, order files, plans, loads, driver links and delivery results, so the pilot starts clean. Use it only for test data. Customers (with
          their locations and confirmed hours), products, trucks, drivers, depots, regions, users, settings and the audit log stay. Only a company admin can do this.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div role="note" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Before you start</p>
          <p className="mt-1">{START_FRESH_BACKUP_REMINDER}</p>
          <p className="mt-1">
            It cannot run while an optimization is queued or running. Nobody should upload orders, plan or record results between your check and Remove: if anything
            changes, it stops, removes nothing and shows the new numbers.
          </p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">What to remove</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="start-fresh-scope" checked={mode === 'ALL'} onChange={() => changeScope(() => setMode('ALL'))} />
            Everything: every order, plan and delivery result of this company, all dates
          </label>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <input type="radio" name="start-fresh-scope" checked={mode === 'BEFORE'} onChange={() => changeScope(() => setMode('BEFORE'))} />
            Only data with a delivery date before
            <Input
              type="date"
              className="h-8 w-44"
              aria-label="Delivery date: remove only data before this day"
              value={before}
              disabled={mode !== 'BEFORE'}
              onChange={(e) => changeScope(() => setBefore(e.target.value))}
            />
          </label>
        </fieldset>

        <Button type="button" variant="outline" onClick={() => check()} disabled={checking || running || dateMissing}>
          {checking ? 'Checking…' : 'Check what will be removed'}
        </Button>

        {problem ? (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        ) : null}

        {preview ? (
          <div className="space-y-4">
            <p className="text-sm">
              Removes <strong>{startFreshScopeText(preview.before)}</strong>
              {preview.orderDates
                ? `, orders delivered ${preview.orderDates.from === preview.orderDates.to ? `on ${preview.orderDates.from}` : `from ${preview.orderDates.from} to ${preview.orderDates.to}`}`
                : ''}
              : <strong>{total.toLocaleString()}</strong> records in all.
            </p>
            {live ? (
              <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm font-medium text-destructive">
                {live}
              </p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              <CountTable title="Will be removed" rows={START_FRESH_REMOVED.map((r) => ({ label: r.label, value: preview.removed[r.key], sub: 'sub' in r && r.sub }))} tone="remove" />
              <CountTable title="Kept" rows={keptRows(preview)} tone="keep" note={START_FRESH_ALSO_KEPT} />
            </div>

            {blocked ? (
              <div role="alert" className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
                <p className="font-medium">It cannot run now:</p>
                <ul className="list-disc pl-5">
                  {preview.blockers.map((b) => (
                    <li key={b.code}>{b.message}</li>
                  ))}
                </ul>
              </div>
            ) : total === 0 ? (
              <p className="text-sm text-muted-foreground">There is nothing to remove.</p>
            ) : (
              <div className="space-y-3 rounded-md border border-destructive/40 p-3">
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={backup} onCheckedChange={(v) => setBackup(v === true)} aria-label="I have taken a Railway backup of the database" />
                  <span>I have taken a Railway backup of the database today, before this.</span>
                </label>
                {needsLiveTick ? (
                  <label className="flex items-start gap-2 text-sm text-destructive">
                    <Checkbox checked={liveOk} onCheckedChange={(v) => setLiveOk(v === true)} aria-label={START_FRESH_LIVE_TICK} />
                    <span>{START_FRESH_LIVE_TICK}</span>
                  </label>
                ) : null}
                <div className="space-y-1.5">
                  <Label htmlFor="start-fresh-confirm">
                    Type the company code <code className="rounded bg-muted px-1">{slug}</code> to confirm
                  </Label>
                  <Input id="start-fresh-confirm" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} className="max-w-xs" />
                </div>
                <Button type="button" variant="destructive" onClick={run} disabled={!canRun}>
                  {running ? 'Removing…' : `Remove ${total.toLocaleString()} records`}
                </Button>
                <p className="text-xs text-muted-foreground">
                  This cannot be undone in RouteIQ. It removes only what this check shows: if more data arrives first, it stops and shows the new numbers. The audit log keeps
                  a record of who did it and what was removed.
                </p>
              </div>
            )}
          </div>
        ) : null}

        {done ? (
          <div role="status" className="space-y-3 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
            <p className="font-medium">
              Done: {startFreshTotal(done.removed).toLocaleString()} records removed ({startFreshScopeText(done.before)}). The audit log has a &quot;Test data removed (Start
              fresh)&quot; row.
            </p>
            {doneLive ? <p className="font-medium text-destructive">{doneLive}</p> : null}
            <CountTable title="Removed" rows={START_FRESH_REMOVED.map((r) => ({ label: r.label, value: done.removed[r.key], sub: 'sub' in r && r.sub }))} tone="remove" hideZero />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CountTable({
  title,
  rows,
  tone,
  note,
  hideZero = false,
}: {
  title: string;
  rows: { label: string; value: number; sub?: boolean }[];
  tone: 'remove' | 'keep';
  note?: string;
  hideZero?: boolean;
}) {
  const shown = hideZero ? rows.filter((r) => r.value > 0) : rows;
  return (
    <div>
      <p className={`mb-1 text-sm font-medium ${tone === 'remove' ? 'text-destructive' : 'text-emerald-700'}`}>{title}</p>
      <table className="w-full text-sm">
        <tbody>
          {shown.map((r) => (
            <tr key={r.label} className="border-b last:border-0">
              <td className={`py-1 pr-3 ${r.sub ? 'pl-4 text-muted-foreground' : ''}`}>{r.label}</td>
              <td className="py-1 text-right tabular-nums">{r.value.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
