'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { acknowledgeAlerts } from '@/components/alerts-api';
import { AlertReviewDialog } from '@/components/alert-review-dialog';
import { daysBetween } from '@/lib/dispatch/time';
import { ALERT_DAYS_AHEAD, ALERT_DAYS_BACK, ALERT_POLL_MS } from '@/lib/alerts/catalog';
import type { OpsAlertRow } from '@/lib/alerts/types';
import { alertReviewText, alertStateText, alertText, alertTime, alertWhere, groupByTruck, ruleLabel, SEVERITY_BADGE } from '@/lib/alerts/view';
import { api } from './client-api';

interface ListAnswer {
  enabled: boolean;
  rows: OpsAlertRow[];
  truncated: boolean;
}

/** The day is one the alert sweep reads (yesterday, today, tomorrow): only then can it change, so only then does the card poll. */
export function alertDayIsLive(date: string, today: string): boolean {
  const d = daysBetween(today, date);
  return d >= -ALERT_DAYS_BACK && d <= ALERT_DAYS_AHEAD;
}

/**
 * The day screen's Alerts card (operations alerts, owner request 16 Oct 2026): this day's and depot's
 * alerts, one block per truck with its worst state first, so 8-10 trucks fit on one screen. Open and
 * acknowledged rows are listed; what is over is behind "Show N over". Reads every 60 s while the tab is
 * visible and the day is yesterday, today or tomorrow. Shown only while alerts are switched on.
 * Cause & action (owner request 20 Oct 2026): each row says what the office recorded ("Cause & action saved by
 * Sam", so two dispatchers do not both call the driver); the dispatcher and up record or edit it here too.
 */
export function AlertsCard({
  slug,
  date,
  depotId,
  today,
  timezone,
  canAck,
  enabled,
}: {
  slug: string;
  date: string;
  depotId: string;
  today: string;
  timezone: string;
  canAck: boolean;
  enabled: boolean;
}) {
  const [answer, setAnswer] = useState<ListAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showOver, setShowOver] = useState(false);
  // A snapshot of the alert whose cause & action is being edited: the poll never resets the dialog.
  const [reviewing, setReviewing] = useState<OpsAlertRow | null>(null);

  const read = useCallback(async () => {
    const r = await api<ListAnswer>(`/api/alerts?date=${encodeURIComponent(date)}&depotId=${encodeURIComponent(depotId)}&state=all`);
    if (!r.ok || !r.data) {
      setError(r.error ?? 'Could not read the alerts.');
      return;
    }
    setError(null);
    setAnswer(r.data);
  }, [date, depotId]);

  const live = alertDayIsLive(date, today);
  useEffect(() => {
    if (!enabled) return;
    setAnswer(null);
    void read();
    if (!live) return;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void read();
    }, ALERT_POLL_MS);
    return () => clearInterval(t);
  }, [enabled, live, read]);

  async function ack(rows: OpsAlertRow[]) {
    setBusy(true);
    try {
      await acknowledgeAlerts(rows);
      await read();
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;
  const rows = answer?.rows ?? [];
  const trucks = groupByTruck(rows);
  const open = rows.filter((r) => r.state === 'OPEN');
  const over = rows.filter((r) => r.state === 'RESOLVED').length;
  return (
    <Card className="mt-4" data-testid="alerts-card">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="h-4 w-4" />
          Alerts
          {open.length ? (
            <Badge variant={open.some((r) => r.severity === 'HIGH') ? 'destructive' : 'warning'} data-testid="alerts-card-open">
              {open.length} open
            </Badge>
          ) : null}
        </CardTitle>
        <div className="flex items-center gap-2">
          {canAck && open.length > 1 ? (
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void ack(open)} data-testid="alerts-card-ack-all">
              Acknowledge all {open.length}
            </Button>
          ) : null}
          <Link className="text-xs text-primary underline" href={`/t/${slug}/alerts?from=${date}&to=${date}&depot=${encodeURIComponent(depotId)}`}>
            All alerts
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {error ? (
          <p className="text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {!answer && !error ? <p className="text-muted-foreground">Reading the alerts...</p> : null}
        {answer && !rows.length ? <p className="text-muted-foreground" data-testid="alerts-card-none">No alerts for this day and depot.</p> : null}
        {trucks.map((g) => {
          const shown = g.rows.filter((r) => showOver || r.state !== 'RESOLVED');
          if (!shown.length) return null;
          return (
            <div key={g.truckId} className="rounded-md border p-2" data-testid={`alerts-truck-${g.truckCode}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{g.truckCode}</span>
                {g.worst ? <Badge variant={SEVERITY_BADGE[g.worst]}>{g.worst}</Badge> : <Badge variant="secondary">over</Badge>}
                <span className="text-xs text-muted-foreground">
                  {[g.open ? `${g.open} open` : null, g.acked ? `${g.acked} acknowledged` : null, g.resolved ? `${g.resolved} over` : null].filter(Boolean).join(' · ')}
                </span>
              </div>
              <ul className="mt-1 space-y-1">
                {shown.map((r) => (
                  <li key={r.id} className={`flex flex-wrap items-start gap-2 ${r.state === 'RESOLVED' ? 'text-muted-foreground' : ''}`} data-testid="alerts-card-row" data-state={r.state}>
                    <Badge variant={r.state === 'RESOLVED' ? 'outline' : SEVERITY_BADGE[r.severity]}>{r.severity}</Badge>
                    <span className="text-xs text-muted-foreground">{alertTime(r.occurredAt, timezone)}</span>
                    <span className="min-w-0 flex-1 break-words">
                      <span className="font-medium">{ruleLabel(r.rule)}</span> - {alertText(r)}
                      <span className="ms-1 text-xs text-muted-foreground">({r.state === 'OPEN' ? alertWhere(r) : alertStateText(r, timezone)})</span>
                      {r.review ? (
                        <span className="block text-xs text-muted-foreground" data-testid="alerts-card-review-line">
                          {alertReviewText(r, timezone)}
                          {r.review.followUp ? ' · follow-up' : ''}
                        </span>
                      ) : null}
                    </span>
                    {canAck && r.state === 'OPEN' ? (
                      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void ack([r])} data-testid="alerts-card-ack">
                        Acknowledge
                      </Button>
                    ) : null}
                    {canAck ? (
                      <Button size="sm" variant="outline" className="h-6 whitespace-nowrap px-2 text-xs" onClick={() => setReviewing(r)} data-testid="alerts-card-review">
                        {r.review ? 'Edit cause' : 'Cause & action'}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {over ? (
          <button type="button" className="text-xs text-primary underline" onClick={() => setShowOver((v) => !v)} data-testid="alerts-card-show-over">
            {showOver ? 'Hide what is over' : `Show ${over} over`}
          </button>
        ) : null}
        {answer?.truncated ? <p className="text-xs text-muted-foreground">Only the latest 500 are shown: open the Alerts page for the rest.</p> : null}
        {canAck ? (
          <AlertReviewDialog target={reviewing} related={rows} timezone={timezone} today={today} canAck={canAck} onClose={() => setReviewing(null)} onSaved={() => void read()} />
        ) : null}
      </CardContent>
    </Card>
  );
}
