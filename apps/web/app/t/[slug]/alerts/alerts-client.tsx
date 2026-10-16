'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { acknowledgeAlerts } from '@/components/alerts-api';
import { api } from '@/app/t/[slug]/dispatch/client-api';
import { ALERT_POLL_MS, ALERT_RULE_LIST } from '@/lib/alerts/catalog';
import type { OpsAlertRow } from '@/lib/alerts/types';
import { alertStateText, alertTime, alertWhere, ruleLabel, SEVERITY_BADGE } from '@/lib/alerts/view';
import { fmtDayMonth } from '@/lib/dispatch/time';

interface Filters {
  from: string;
  to: string;
  depotId: string;
  state: string;
  rule: string;
}

interface ListAnswer {
  enabled: boolean;
  rows: OpsAlertRow[];
  truncated: boolean;
}

const STATES = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'acked', label: 'Acknowledged' },
  { value: 'resolved', label: 'Over' },
];

/** The query of GET /api/alerts for these filters. */
export function alertsQuery(f: Filters): string {
  const q = new URLSearchParams({ from: f.from, to: f.to, state: f.state });
  if (f.depotId) q.set('depotId', f.depotId);
  if (f.rule) q.set('rule', f.rule);
  return q.toString();
}

/**
 * The Alerts page (operations alerts, owner request 16 Oct 2026): the filters, then every alert of the
 * range, open ones first and HIGH before warnings, with who acknowledged what. Reads again every 60 s
 * while the tab is visible and the range reaches today.
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
}: {
  enabled: boolean;
  canAck: boolean;
  isAdmin: boolean;
  slug: string;
  timezone: string;
  today: string;
  depots: { id: string; code: string; name: string }[];
  initial: { from: string; to: string; depotId: string; state: string };
}) {
  const [f, setF] = useState<Filters>({ ...initial, rule: '' });
  const [answer, setAnswer] = useState<ListAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    if (!live) return;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void read();
    }, ALERT_POLL_MS);
    return () => clearInterval(t);
  }, [read, live]);

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
  const depotCode = (id: string) => depots.find((d) => d.id === id)?.code ?? '';
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
        <Button size="sm" variant="outline" className="h-9" onClick={() => void read()} disabled={busy}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Refresh
        </Button>
        {canAck && open.length ? (
          <Button size="sm" className="h-9" onClick={() => void ack(open.slice(0, 200))} disabled={busy} data-testid="alerts-ack-all">
            Acknowledge {open.length > 200 ? 'the first 200' : `all ${open.length}`} open
          </Button>
        ) : null}
      </div>
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
              {rows.map((r) => (
                <tr key={r.id} className={`border-t align-top ${r.state === 'RESOLVED' ? 'text-muted-foreground' : ''}`} data-testid="alerts-row" data-state={r.state}>
                  <td className="p-2">
                    <Badge variant={r.state === 'RESOLVED' ? 'outline' : SEVERITY_BADGE[r.severity]}>{r.severity}</Badge>
                  </td>
                  <td className="whitespace-nowrap p-2">
                    {fmtDayMonth(r.deliveryDate)}
                    {depots.length > 1 ? <span className="ms-1 text-xs text-muted-foreground">{depotCode(r.depotId)}</span> : null}
                  </td>
                  <td className="whitespace-nowrap p-2">{alertTime(r.occurredAt, timezone)}</td>
                  <td className="whitespace-nowrap p-2 font-medium">{alertWhere(r)}</td>
                  <td className="p-2">{ruleLabel(r.rule)}</td>
                  <td className="min-w-[16rem] break-words p-2">
                    {r.text}
                    {r.occurrences > 1 ? <span className="ms-1 text-xs text-muted-foreground">(came back {r.occurrences - 1}×)</span> : null}
                  </td>
                  <td className="whitespace-nowrap p-2 text-xs">{alertStateText(r, timezone)}</td>
                  <td className="p-2">
                    {canAck && r.state === 'OPEN' ? (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void ack([r])} data-testid="alerts-ack">
                        Acknowledge
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {answer?.truncated ? <p className="text-xs text-muted-foreground">Only 500 alerts are shown: narrow the dates, the depot or the rule.</p> : null}
    </div>
  );
}
