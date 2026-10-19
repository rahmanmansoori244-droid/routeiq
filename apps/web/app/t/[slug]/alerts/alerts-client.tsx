'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { acknowledgeAlerts } from '@/components/alerts-api';
import { AlertReviewDialog } from '@/components/alert-review-dialog';
import { api } from '@/app/t/[slug]/dispatch/client-api';
import { ALERT_POLL_MS, ALERT_RULE_LIST } from '@/lib/alerts/catalog';
import { ALERT_FOLLOWUP_DAYS } from '@/lib/alerts/review';
import type { OpsAlertRow, SweepCheck } from '@/lib/alerts/types';
import { alertReviewFlags, alertReviewText, alertStateText, alertText, alertWhen, alertWhere, ruleLabel, SEVERITY_BADGE, sweepCheckText } from '@/lib/alerts/view';
import { analysisExportUrl } from '@/lib/analysis/view';
import { fmtDayMonth } from '@/lib/dispatch/time';

interface Filters {
  from: string;
  to: string;
  depotId: string;
  state: string;
  rule: string;
  /** Cause & action: all, missing, saved, followup (owner request 20 Oct 2026). */
  review: string;
}

/** GET /api/alerts reviewCounts (lib/alerts/inbox.ts alertReviewCounts). */
interface ReviewCounts {
  alerts: number;
  saved: number;
  other: number;
  followUp: number;
}

interface ListAnswer extends Partial<SweepCheck> {
  enabled: boolean;
  /** The company's today when the answer was read (GET /api/alerts). */
  today?: string;
  rows: OpsAlertRow[];
  truncated: boolean;
  reviewCounts?: ReviewCounts;
}

const STATES = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'acked', label: 'Acknowledged' },
  { value: 'resolved', label: 'Over' },
];

const REVIEWS = [
  { value: 'all', label: 'All' },
  { value: 'missing', label: 'Missing' },
  { value: 'saved', label: 'Saved' },
  { value: 'followup', label: `Follow-up (last ${ALERT_FOLLOWUP_DAYS} days)` },
];

/** The query of GET /api/alerts for these filters. */
export function alertsQuery(f: Filters): string {
  const q = new URLSearchParams({ from: f.from, to: f.to, state: f.state });
  if (f.depotId) q.set('depotId', f.depotId);
  if (f.rule) q.set('rule', f.rule);
  if (f.review && f.review !== 'all') q.set('review', f.review);
  return q.toString();
}

/** "12 of 40 alerts of these dates have a cause & action (2 say Other) · 3 to follow up (last 92 days)". */
export function reviewCountText(c: ReviewCounts | undefined): string | null {
  if (!c) return null;
  const other = c.other ? ` (${c.other} say Other: worth a code of its own when it comes back often)` : '';
  return `${c.saved} of ${c.alerts} alert${c.alerts === 1 ? '' : 's'} of these dates ${c.saved === 1 ? 'has' : 'have'} a cause & action${other} · ${c.followUp} to follow up (last ${ALERT_FOLLOWUP_DAYS} days)`;
}

/** The note as the row shows it: at most 120 characters (the whole note in the tooltip). */
const shortNote = (note: string) => (Array.from(note).length > 120 ? `${Array.from(note).slice(0, 119).join('')}…` : note);

/**
 * The Alerts page (operations alerts, owner request 16 Oct 2026): the filters, then every alert of the
 * range, open ones first and HIGH before warnings, with who acknowledged what. Reads again every 60 s
 * while the tab is visible, alerts are on and the range reaches today (switched off: one read, no polling).
 * Dates (owner request 19 Oct 2026): an alert of another day than today says its day in Since and State
 * ("Yesterday 17:20", "18 Oct 17:20"; today's keep the time only), from the company's today in the last
 * answer (the page's until then); a row closed at the end of its day says "Day ended".
 * Cause & action (owner request 20 Oct 2026, lib/alerts/review.ts): under each alert, what the office found and
 * decided (every role sees it); the dispatcher and up record or edit it on any alert ("Cause & action" under
 * the text, so it is in view on a phone), filter by it, and download the alerts with it (Excel). `reviewId` in
 * the URL (the bell's link) opens the dialog of that alert.
 */
export function AlertsClient({
  enabled,
  canAck,
  isAdmin,
  slug,
  timezone,
  today,
  depots,
  initial,
  initialReviewId = null,
}: {
  enabled: boolean;
  canAck: boolean;
  isAdmin: boolean;
  slug: string;
  timezone: string;
  today: string;
  depots: { id: string; code: string; name: string }[];
  initial: { from: string; to: string; depotId: string; state: string; review?: string };
  initialReviewId?: string | null;
}) {
  const [f, setF] = useState<Filters>({ ...initial, rule: '', review: initial.review ?? 'all' });
  const [answer, setAnswer] = useState<ListAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A snapshot of the alert whose cause & action is being edited: the poll never resets the dialog.
  const [reviewing, setReviewing] = useState<OpsAlertRow | null>(null);
  const deepLinked = useRef(false);

  const read = useCallback(async () => {
    const r = await api<ListAnswer>(`/api/alerts?${alertsQuery(f)}`);
    if (!r.ok || !r.data) {
      setError(r.error ?? 'Could not read the alerts.');
      return;
    }
    setError(null);
    setAnswer(r.data);
  }, [f]);

  const live = f.from <= today && today <= f.to;
  useEffect(() => {
    void read();
    if (!live || !enabled) return;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void read();
    }, ALERT_POLL_MS);
    return () => clearInterval(t);
  }, [read, live, enabled]);

  // The bell's "Cause & action" link: open that alert's dialog once its row is read.
  useEffect(() => {
    if (deepLinked.current || !initialReviewId || !canAck || !answer) return;
    deepLinked.current = true;
    const row = answer.rows.find((r) => r.id === initialReviewId);
    if (row) setReviewing(row);
  }, [answer, initialReviewId, canAck]);

  async function ack(rows: OpsAlertRow[]) {
    setBusy(true);
    try {
      await acknowledgeAlerts(rows);
      await read();
    } finally {
      setBusy(false);
    }
  }

  const rows = answer?.rows ?? [];
  const open = rows.filter((r) => r.state === 'OPEN');
  const dayNow = answer?.today ?? today;
  const check = enabled && answer ? sweepCheckText({ checkedAt: answer.checkedAt ?? null, checkStale: !!answer.checkStale, checkFailed: !!answer.checkFailed }, timezone) : null;
  const depotCode = (id: string) => depots.find((d) => d.id === id)?.code ?? '';
  const counts = reviewCountText(answer?.reviewCounts);
  return (
    <div className="space-y-4">
      {!enabled ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="alerts-off">
          Operations alerts are switched off: no new alert is raised. {isAdmin ? 'Switch them on under ' : 'A company admin switches them on under '}
          {isAdmin ? (
            <Link className="underline" href={`/t/${slug}/settings`}>
              Settings &gt; Operations alerts
            </Link>
          ) : (
            'Settings > Operations alerts'
          )}
          . Alerts raised before stay listed here.
        </p>
      ) : null}
      {check ? (
        <p className={`text-xs ${check.warn ? 'rounded-md border border-red-300 bg-red-50 p-2 text-red-800' : 'text-muted-foreground'}`} data-testid="alerts-checked">
          {check.text}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3" data-testid="alerts-filters">
        <div className="space-y-1">
          <Label htmlFor="al-from">From</Label>
          <Input id="al-from" type="date" className="h-9 w-40" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="al-to">To</Label>
          <Input id="al-to" type="date" className="h-9 w-40" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="al-depot">Depot</Label>
          <select id="al-depot" className="h-9 rounded-md border bg-background px-2 text-sm" value={f.depotId} onChange={(e) => setF({ ...f, depotId: e.target.value })}>
            <option value="">Every depot</option>
            {depots.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} — {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="al-state">State</Label>
          <select id="al-state" className="h-9 rounded-md border bg-background px-2 text-sm" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
            {STATES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="al-rule">Rule</Label>
          <select id="al-rule" className="h-9 rounded-md border bg-background px-2 text-sm" value={f.rule} onChange={(e) => setF({ ...f, rule: e.target.value })}>
            <option value="">Every rule</option>
            {ALERT_RULE_LIST.map((s) => (
              <option key={s.rule} value={s.rule}>
                R{s.no} {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="al-review">Cause &amp; action</Label>
          <select id="al-review" className="h-9 rounded-md border bg-background px-2 text-sm" value={f.review} onChange={(e) => setF({ ...f, review: e.target.value })} data-testid="alerts-review-filter">
            {REVIEWS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <Button size="sm" variant="outline" className="h-9" onClick={() => void read()} disabled={busy}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Refresh
        </Button>
        {canAck && open.length ? (
          <Button size="sm" className="h-9" onClick={() => void ack(open.slice(0, 200))} disabled={busy} data-testid="alerts-ack-all">
            Acknowledge {open.length > 200 ? 'the first 200' : `all ${open.length}`} open
          </Button>
        ) : null}
        {canAck ? (
          <a className="self-center text-sm text-primary underline" href={analysisExportUrl(f.from, f.to, f.depotId || null, { only: 'alerts' })} data-testid="alerts-excel">
            Excel (alerts with their cause &amp; action)
          </a>
        ) : null}
      </div>
      {f.review === 'followup' ? (
        <p className="text-xs text-muted-foreground" data-testid="alerts-followup-note">
          Follow-up lists the alerts that need it from the last {ALERT_FOLLOWUP_DAYS} days, whatever the dates above.
        </p>
      ) : null}
      {counts ? (
        <p className="text-xs text-muted-foreground" data-testid="alerts-review-count">
          {counts}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {answer && !rows.length ? <p className="text-sm text-muted-foreground" data-testid="alerts-none">No alerts for these filters.</p> : null}
      {rows.length ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="alerts-table">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Severity</th>
                <th className="p-2">Day</th>
                <th className="p-2">Since</th>
                <th className="p-2">Truck</th>
                <th className="p-2">Rule</th>
                <th className="p-2">What happened</th>
                <th className="p-2">State</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const flags = alertReviewFlags(r);
                return (
                  <tr key={r.id} className={`border-t align-top ${r.state === 'RESOLVED' ? 'text-muted-foreground' : ''}`} data-testid="alerts-row" data-state={r.state}>
                    <td className="p-2">
                      <Badge variant={r.state === 'RESOLVED' ? 'outline' : SEVERITY_BADGE[r.severity]}>{r.severity}</Badge>
                    </td>
                    <td className="whitespace-nowrap p-2">
                      {fmtDayMonth(r.deliveryDate)}
                      {depots.length > 1 ? <span className="ms-1 text-xs text-muted-foreground">{depotCode(r.depotId)}</span> : null}
                    </td>
                    <td className="whitespace-nowrap p-2" data-testid="alerts-when">
                      {alertWhen(r.occurredAt, r.deliveryDate, timezone, dayNow)}
                    </td>
                    <td className="whitespace-nowrap p-2 font-medium">{alertWhere(r)}</td>
                    <td className="p-2">{ruleLabel(r.rule)}</td>
                    <td className="min-w-[16rem] break-words p-2">
                      {alertText(r)}
                      {r.occurrences > 1 ? <span className="ms-1 text-xs text-muted-foreground">(came back {r.occurrences - 1}×)</span> : null}
                      {r.review ? (
                        <div className="mt-1 text-xs text-muted-foreground" data-testid="alerts-review-line">
                          <span className="text-foreground">{alertReviewText(r, timezone, dayNow)}</span>
                          {r.review.followUp ? (
                            <Badge variant="warning" className="ms-1" data-testid="alerts-review-followup">
                              Follow-up
                            </Badge>
                          ) : null}
                          {r.review.note ? (
                            <span className="block" title={r.review.note}>
                              Note: {shortNote(r.review.note)}
                            </span>
                          ) : null}
                          {flags.length ? <span className="block text-amber-700">({flags.join(', ')})</span> : null}
                        </div>
                      ) : null}
                      {canAck ? (
                        <Button
                          size="sm"
                          variant="link"
                          className="h-6 whitespace-nowrap px-0 text-xs"
                          onClick={() => setReviewing(r)}
                          data-testid="alerts-review"
                        >
                          {r.detailsRemoved ? 'Cause & action (read only)' : r.review ? 'Edit cause & action' : 'Cause & action'}
                        </Button>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap p-2 text-xs" data-testid="alerts-state">
                      {alertStateText(r, timezone, dayNow)}
                    </td>
                    <td className="p-2">
                      {canAck && r.state === 'OPEN' ? (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void ack([r])} data-testid="alerts-ack">
                          Acknowledge
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {answer?.truncated ? <p className="text-xs text-muted-foreground">Only 500 alerts are shown: narrow the dates, the depot or the rule.</p> : null}
      {canAck ? (
        <AlertReviewDialog target={reviewing} related={rows} timezone={timezone} today={dayNow} canAck={canAck} onClose={() => setReviewing(null)} onSaved={() => void read()} />
      ) : null}
    </div>
  );
}
