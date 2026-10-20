'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/app/t/[slug]/dispatch/client-api';
import { ALERT_POLL_MS } from '@/lib/alerts/catalog';
import type { AlertSummary, OpsAlertRow } from '@/lib/alerts/types';
import { alertDayGroups, alertWhen, alertWhere, bellTone, newAlertToasts, reviewCauseText, ruleLabel, SEVERITY_BADGE, sweepCheckText } from '@/lib/alerts/view';
import { todayIso } from '@/lib/dispatch/time';
import { acknowledgeAlerts } from './alerts-api';

/** A focus right after a poll does not read again (focus and visibilitychange often fire together). */
const MIN_GAP_MS = 5_000;

/**
 * The bell in the top bar (operations alerts, owner request 16 Oct 2026). Rendered only while the
 * company has alerts switched on (the layout passes `enabled`, so nothing polls when they are off: review
 * L10). Reads GET /api/alerts/summary every ALERT_POLL_MS while the tab is visible, and when it comes back
 * into view. Red with a HIGH open alert, amber with any open one. A toast only for a HIGH alert that is
 * new since the page opened (review M11: the first read fills the seen list silently), at most 3 at once.
 * Today's and tomorrow's open alerts only (owner request 19 Oct 2026: yesterday's looked like today's with
 * the time only), and yesterday's Load not closed raised after midnight (review of the branch, finding 2:
 * inbox.ts bellOpenWhere); the rows of a day that is not today come under a small date header ("Tomorrow, 20 Oct")
 * and a time that is not today's says its day ("Yesterday 23:40"), from the company's today in the summary
 * (the browser's clock only before the first answer). When every row is today's the bell looks as before.
 */
export function AlertBell({ slug, enabled, canAck, timezone }: { slug: string; enabled: boolean; canAck: boolean; timezone: string }) {
  // The toast's link uses the router of the latest render; reading it from a ref keeps `read` (and the
  // polling effect) from starting again when the router object changes.
  const nav = useRouter();
  const router = useRef(nav);
  router.current = nav;
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const lastRead = useRef(0);

  const read = useCallback(async () => {
    lastRead.current = Date.now();
    const r = await api<AlertSummary>('/api/alerts/summary');
    if (!r.ok || !r.data) return; // keep showing the last answer
    const { toasts, seen: next } = newAlertToasts(seen.current, r.data.latest);
    seen.current = next;
    setSummary(r.data);
    for (const row of toasts) {
      toast.error(`${alertWhere(row)}: ${ruleLabel(row.rule)}`, {
        description: row.text,
        duration: 15_000,
        action: { label: 'Alerts', onClick: () => router.current.push(`/t/${slug}/alerts`) },
      });
    }
  }, [slug]);

  useEffect(() => {
    if (!enabled) return;
    void read();
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const timer = setInterval(() => {
      if (visible()) void read();
    }, ALERT_POLL_MS);
    const back = () => {
      if (visible() && Date.now() - lastRead.current > MIN_GAP_MS) void read();
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
    };
  }, [enabled, read]);

  async function ack(rows: OpsAlertRow[]) {
    setBusy(true);
    try {
      await acknowledgeAlerts(rows);
      await read();
    } finally {
      setBusy(false);
    }
  }

  if (!enabled || (summary && !summary.enabled)) return null;
  const tone = summary ? bellTone(summary) : 'none';
  const rows = summary?.latest ?? [];
  const check = sweepCheckText(summary, timezone);
  const today = summary?.today ?? todayIso(timezone);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9"
          aria-label={summary ? `Alerts: ${summary.open} open, ${summary.high} high` : 'Alerts'}
          data-testid="alert-bell"
          data-tone={tone}
        >
          <Bell className={tone === 'high' ? 'h-5 w-5 text-red-600' : tone === 'warn' ? 'h-5 w-5 text-amber-600' : 'h-5 w-5'} />
          {summary && summary.open > 0 ? (
            <span
              className={`absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full px-1 text-center text-[10px] font-semibold leading-[1.1rem] text-white ${tone === 'high' ? 'bg-red-600' : 'bg-amber-500'}`}
              data-testid="alert-bell-count"
            >
              {summary.open > 99 ? '99+' : summary.open}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[22rem] max-w-[92vw]">
        <DropdownMenuLabel className="flex items-center justify-between gap-2">
          <span>{summary ? (summary.open ? `${summary.open} open alert${summary.open === 1 ? '' : 's'}${summary.high ? `, ${summary.high} high` : ''}` : 'No open alerts') : 'Alerts'}</span>
          <Link href={`/t/${slug}/alerts`} className="text-xs font-normal text-primary underline" data-testid="alert-bell-all">
            All alerts
          </Link>
        </DropdownMenuLabel>
        {check ? (
          <p className={`px-2 pb-1 text-xs ${check.warn ? 'text-red-700' : 'text-muted-foreground'}`} data-testid="alert-bell-checked">
            {check.text}
          </p>
        ) : null}
        {summary?.emailCapReached ? (
          <p className="px-2 pb-1 text-xs text-amber-700" data-testid="alert-bell-email-cap">
            Today&apos;s alert e-mails reached their daily limit: the rest show here only until tomorrow.
          </p>
        ) : null}
        <DropdownMenuSeparator />
        <div className="max-h-[60vh] overflow-y-auto">
          {rows.length ? (
            alertDayGroups(rows, today).map((g) => (
              <div key={g.date} data-testid="alert-bell-group">
                {g.header ? (
                  <p className="bg-muted/50 px-2 py-0.5 text-xs font-medium text-muted-foreground" data-testid="alert-bell-day">
                    {g.header}
                  </p>
                ) : null}
                {g.rows.map((r) => (
                  <div key={r.id} className="border-b px-2 py-1.5 text-sm last:border-b-0" data-testid="alert-bell-row">
                    <div className="flex items-center gap-1.5">
                      <Badge variant={SEVERITY_BADGE[r.severity]}>{r.severity}</Badge>
                      <span className="font-medium">{alertWhere(r)}</span>
                      <span className="ms-auto whitespace-nowrap text-xs text-muted-foreground" data-testid="alert-bell-when">
                        {alertWhen(r.lastSeenAt, r.deliveryDate, timezone, today)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{ruleLabel(r.rule)}</p>
                    <p className="mt-0.5 break-words text-xs">{r.text}</p>
                    {r.review ? (
                      // Owner request 20 Oct 2026: who already recorded a cause & action, so two dispatchers do not both call the driver.
                      <p className="mt-0.5 break-words text-xs text-muted-foreground" data-testid="alert-bell-review-line">
                        Cause &amp; action saved by {r.review.byName ?? 'someone'}: {reviewCauseText(r.review)}
                      </p>
                    ) : null}
                    {canAck ? (
                      <div className="mt-1 flex items-center gap-2">
                        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void ack([r])} data-testid="alert-bell-ack">
                          Acknowledge
                        </Button>
                        <Link
                          href={`/t/${slug}/alerts?date=${encodeURIComponent(r.deliveryDate)}&reviewId=${encodeURIComponent(r.id)}`}
                          className="text-xs text-primary underline"
                          data-testid="alert-bell-review"
                        >
                          {r.review ? 'Edit cause & action' : 'Cause & action'}
                        </Link>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ))
          ) : (
            <p className="px-2 py-3 text-sm text-muted-foreground">{summary ? 'Nothing needs attention now.' : 'Reading the alerts...'}</p>
          )}
        </div>
        {canAck && rows.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1">
              <Button size="sm" variant="secondary" className="h-7 w-full text-xs" disabled={busy} onClick={() => void ack(rows)} data-testid="alert-bell-ack-all">
                Acknowledge these {rows.length}
              </Button>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
