'use client';

import { useEffect, useState } from 'react';
import { Ban, Copy, MessageCircle, RefreshCw, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import type { SalesLinkView } from '@/lib/sales-link/view-types';
import { addDaysIso } from '@/lib/dispatch/time';
import { shortDayText } from '@/lib/sales-page/format';
import { api } from './client-api';

/**
 * The plan screen's Salesman link (owner request 19 Oct 2026): one read-only link per company and delivery date for
 * the salesmen's WhatsApp group, for every depot. Each salesman opens it, types his route code and follows his
 * customers' deliveries live. The owner chose one shared link: anyone holding it can look up any route of that
 * day until 06:00 the day after (docs/SECURITY.md), so the office can see its use, make a new one (the old one
 * stops at once) or turn it off.
 *
 * Opening the dialog only reads (GET): a link is made by pressing Make the link (POST, audited).
 */

/** The button shows on a plan of the company's today or tomorrow (the only days a link can be made for). */
export function salesLinkDayOk(runDate: string, today: string | null | undefined): boolean {
  if (!today) return false;
  return runDate === today || runDate === addDaysIso(today, 1);
}

/** "10:32" in the company's time zone. */
function clock(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  }
}

const ROUTES_SHOWN = 30;

/**
 * "Opened on 14 phones · last 10:32 · routes looked up: R1, R2X · trucks looked up: 1234-AB" (the office's own looks
 * are not counted).
 */
export function salesLinkSeenText(v: Pick<SalesLinkView, 'phones' | 'lastSeenAt' | 'routesSeen' | 'trucksSeen' | 'generation'>, tz: string): string {
  const parts: string[] = [v.phones ? `Opened on ${v.phones} ${v.phones === 1 ? 'phone' : 'phones'}` : 'Not opened by a salesman yet'];
  if (v.lastSeenAt) parts.push(`last ${clock(v.lastSeenAt, tz)}`);
  const list = (what: string, codes: readonly string[]) => {
    const more = codes.length - ROUTES_SHOWN;
    return `${what} looked up: ${codes.slice(0, ROUTES_SHOWN).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  };
  // An answer of the server before the truck lookup has no truck list.
  const trucks = v.trucksSeen ?? [];
  if (v.routesSeen.length) parts.push(list('routes', v.routesSeen));
  if (trucks.length) parts.push(list('trucks', trucks));
  if (!v.routesSeen.length && !trucks.length) parts.push('no route looked up yet');
  if (v.generation > 1) parts.push(`link #${v.generation}`);
  return parts.join(' · ');
}

type Change = 'REISSUE' | 'REVOKE';

const CONFIRM: Record<Change, { title: string; text: (day: string) => string; action: string }> = {
  REISSUE: {
    title: 'Make a new salesman link?',
    text: (day) =>
      `The link of ${day} that was sent stops working at once: salesmen who open it see "replaced". Send the new link to the group again. Use this when the link was forwarded outside the sales team. It still works only until 06:00 the day after delivery.`,
    action: 'Make a new link',
  },
  REVOKE: {
    title: 'Turn off the salesman link?',
    text: (day) => `No salesman can open the link of ${day} until you make a new one. The phones already showing it stop updating.`,
    action: 'Turn off',
  },
};

export function SalesLinkDialog({ open, onOpenChange, date, timezone }: { open: boolean; onOpenChange: (open: boolean) => void; date: string; timezone: string }) {
  const [view, setView] = useState<SalesLinkView | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The read failed: whether a link exists is not known (never "no link yet").
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Change | null>(null);
  const [reason, setReason] = useState('');
  const [readTick, setReadTick] = useState(0);
  const day = shortDayText(date);

  // Read the date's link (never makes one).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoaded(false);
    void api<SalesLinkView | null>(`/api/dispatch/sales-links?date=${encodeURIComponent(date)}`).then((r) => {
      if (!live) return;
      setLoaded(true);
      setReadFailed(!r.ok);
      if (r.ok) setView(r.data ?? null);
      else setError(r.error ?? 'Could not read the salesman link.');
    });
    return () => {
      live = false;
    };
  }, [open, date, readTick]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setAsk(null);
      setReason('');
    }
  }, [open]);

  const make = async () => {
    setBusy(true);
    setError(null);
    const r = await api<SalesLinkView & { created: boolean }>('/api/dispatch/sales-links', { method: 'POST', json: { date } });
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error ?? 'Could not make the salesman link.');
      return;
    }
    setView(r.data);
    if (r.data.url) toast.success(`Salesman link for ${r.data.dayShort} ready: send it to the salesmen's group.`);
  };

  const change = async (action: Change) => {
    if (!view) return;
    setBusy(true);
    setError(null);
    const why = reason.trim();
    const r = await api<SalesLinkView>(`/api/dispatch/sales-links/${encodeURIComponent(view.id)}`, { method: 'PATCH', json: why ? { action, reason: why } : { action } });
    setBusy(false);
    setAsk(null);
    setReason('');
    if (!r.ok || !r.data) {
      setError(r.error ?? 'Could not change the salesman link.');
      // Changed meanwhile (409 LINK_CHANGED) or over: show the link as it is now.
      setReadTick((n) => n + 1);
      return;
    }
    setView(r.data);
    toast.success(action === 'REISSUE' ? 'New salesman link made: the old one stopped. Send the new one to the group.' : 'Salesman link turned off: no salesman can open it now.');
  };

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast.success(`${what} copied`),
      () => toast.error('Could not copy: select the text and copy it.'),
    );
  };

  const v = view;
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg" data-testid="sales-link-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-5 w-5" /> Salesman link · {day}
            </DialogTitle>
            <DialogDescription>
              One link for the salesmen&apos;s WhatsApp group, for all depots. Each salesman opens it, types his route code and sees his customers&apos;
              deliveries live: delivered, on the way with the expected time, delayed, not delivered or cancelled. Anyone with the link can look up any route
              of {day} until 06:00 the next day.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="text-sm text-destructive" data-testid="sales-link-error">
              {error}
            </p>
          ) : null}
          {!loaded && !v ? <p className="text-sm text-muted-foreground">Reading the link…</p> : null}
          {loaded && !v && readFailed ? (
            <div className="space-y-3 text-sm" data-testid="sales-link-read-failed">
              <p>Could not check whether {day} already has a salesman link.</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setError(null);
                  setReadTick((n) => n + 1);
                }}
                data-testid="sales-link-read-again"
              >
                <RefreshCw className="mr-1 h-4 w-4" /> Try again
              </Button>
            </div>
          ) : null}
          {loaded && !v && !readFailed ? (
            <div className="space-y-3 text-sm" data-testid="sales-link-none">
              <p>No salesman link for {day} yet.</p>
              <Button size="sm" disabled={busy} onClick={() => void make()} data-testid="sales-link-make">
                <Share2 className="mr-1 h-4 w-4" /> {busy ? 'Making the link…' : 'Make the link'}
              </Button>
            </div>
          ) : null}
          {v ? (
            <div className="space-y-3 text-sm">
              {v.url ? (
                <>
                  <code className="block w-full break-all rounded bg-muted p-2 text-xs" data-testid="sales-link-url">
                    {v.url}
                  </code>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => copy(v.url!, 'Link')} data-testid="sales-link-copy">
                      <Copy className="mr-1 h-4 w-4" /> Copy link
                    </Button>
                    {v.message ? (
                      <Button size="sm" variant="outline" onClick={() => copy(v.message!, 'Message')} data-testid="sales-link-copy-message">
                        <Copy className="mr-1 h-4 w-4" /> Copy message
                      </Button>
                    ) : null}
                    {v.whatsappUrl ? (
                      <a
                        className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
                        href={v.whatsappUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        data-testid="sales-link-whatsapp"
                        title="WhatsApp asks which chat to send it to: pick the salesmen's group"
                      >
                        <MessageCircle className="mr-1 h-4 w-4" /> Send on WhatsApp
                      </a>
                    ) : null}
                  </div>
                  {v.message ? (
                    <pre className="whitespace-pre-wrap rounded border bg-muted/40 p-2 font-sans text-xs text-muted-foreground" data-testid="sales-link-message">
                      {v.message}
                    </pre>
                  ) : null}
                </>
              ) : v.expired ? (
                <p className="rounded-md border p-2" data-testid="sales-link-expired">
                  This link&apos;s day is over: it worked until {v.expiryText.replace(/^Works until\s+/i, '')}.
                </p>
              ) : v.revoked ? (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2" data-testid="sales-link-revoked">
                  This link is turned off: it no longer opens. Make a new link to start again, then send it to the group.
                </p>
              ) : v.keyChanged ? (
                <div className="space-y-2 rounded-md border p-2" data-testid="sales-link-key-changed">
                  <p>The server&apos;s key for these links changed, so this link no longer opens. Make it again (it gets a new address) and send it to the group.</p>
                  <Button size="sm" disabled={busy} onClick={() => void make()}>
                    <Share2 className="mr-1 h-4 w-4" /> Make the link
                  </Button>
                </div>
              ) : null}
              {!v.expired ? <p className="text-muted-foreground">{v.expiryText} (06:00 the day after delivery). A new link never works longer.</p> : null}
              <p className="text-muted-foreground" data-testid="sales-link-seen">
                {salesLinkSeenText(v, timezone)}
              </p>
              {!v.expired ? (
                <div className="flex flex-wrap gap-2 border-t pt-3">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsk('REISSUE')} data-testid="sales-link-reissue">
                    <RefreshCw className="mr-1 h-4 w-4" /> Make a new link
                  </Button>
                  {!v.revoked ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsk('REVOKE')} data-testid="sales-link-revoke">
                      <Ban className="mr-1 h-4 w-4" /> Turn off
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Make a new link when this one was forwarded outside the sales team: the old one stops at once (salesmen see &quot;replaced&quot;), so send
                the new one to the group. Turn off stops it until you make a new one. The page shows no phone numbers, money, notes or driver names.
              </p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog open={ask !== null} onOpenChange={(o) => !o && setAsk(null)}>
        <AlertDialogContent data-testid="sales-link-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{ask ? CONFIRM[ask].title : ''}</AlertDialogTitle>
            <AlertDialogDescription>{ask ? CONFIRM[ask].text(day) : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="Why (optional, kept in the audit log)" aria-label="Why (optional)" />
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>Keep the link</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (ask) void change(ask);
              }}
              data-testid="sales-link-confirm-action"
            >
              {ask ? CONFIRM[ask].action : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
