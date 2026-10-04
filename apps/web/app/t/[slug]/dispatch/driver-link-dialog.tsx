'use client';

import { useEffect, useState } from 'react';
import { Copy, MessageCircle, QrCode, RefreshCw, Ban } from 'lucide-react';
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
import type { DriverLinkView } from '@/lib/driver-link/manifest-types';
import { manyDriversNote } from '@/lib/driver-link/plan-notes';
import { reissueOnRoadText } from '@/lib/driver-link/reissue-prompt';
import { driverLinkMessage, whatsappUrl } from '@/lib/dispatch/driver-links';
import { fmtDate } from '@/lib/driver-page/i18n';
import { api } from './client-api';

/** "6 Oct 12:00" in the company's time zone. */
function dayTime(iso: string, tz: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(d);
}

function clock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso));
}

/**
 * The truck-day's driver link (owner request 4 Oct 2026, spec section 6.5): one QR / link for every
 * trip of the truck that day. The driver scans it with the phone camera and sees his trips and
 * stops - no account, no app. Opening the dialog makes the link when there is none yet.
 */
export function DriverLinkDialog({
  open,
  onOpenChange,
  runId,
  truckId,
  truckCode,
  date,
  timezone,
  link,
  driverName,
  driverPhone,
  phoneCountryCode,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  truckId: string;
  truckCode: string;
  /** YYYY-MM-DD */
  date: string;
  timezone: string;
  link: DriverLinkView | null;
  driverName: string | null;
  driverPhone: string | null;
  phoneCountryCode: string | null;
  /** The link as the server answered (made, reissued or revoked): the plan screen keeps it. */
  onChanged: (view: DriverLinkView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askReissue, setAskReissue] = useState<string | null>(null);

  // No link yet (or one made with an older server key): make it now.
  useEffect(() => {
    if (!open || busy || error) return;
    if (link && !link.keyChanged) return;
    setBusy(true);
    void api<DriverLinkView>('/api/dispatch/driver-links', { method: 'POST', json: { runId, truckId } }).then((r) => {
      setBusy(false);
      if (r.ok && r.data) onChanged(r.data);
      else setError(r.error ?? 'Could not make the driver link.');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, link?.linkId, link?.keyChanged]);

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  const change = async (action: 'REISSUE' | 'REVOKE') => {
    if (!link) return;
    setBusy(true);
    const r = await api<DriverLinkView>(`/api/dispatch/driver-links/${link.linkId}`, { method: 'PATCH', json: { action } });
    setBusy(false);
    if (!r.ok || !r.data) {
      toast.error(r.error ?? 'Could not change the driver link.');
      return;
    }
    onChanged(r.data);
    toast.success(action === 'REISSUE' ? `New driver link for ${truckCode}: send or print it again.` : `Driver link for ${truckCode} stopped. Reissue to make a new one.`);
  };

  const reissue = () => {
    // A leaked QR must be stoppable at once: never refused, but asked while a trip is on the road.
    const out = link?.driversOnTruck.find((l) => l.status === 'DISPATCHED' && l.driverName);
    if (out) setAskReissue(reissueOnRoadText(truckCode, out.loadNo, out.driverName!));
    else void change('REISSUE');
  };

  const day = fmtDate('en')(date);
  const message = link?.url ? driverLinkMessage(day, truckCode, link.url) : null;
  const many = link ? manyDriversNote(link) : null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md" data-testid="driver-link-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5" /> Driver link · {truckCode} · {day}
            </DialogTitle>
            <DialogDescription>
              One link for every trip of {truckCode} that day. The driver scans it with the phone camera (it opens in Chrome or Safari) and sees his trips
              and stops. No account and no app: daily drivers and drivers of hired trucks just scan.
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {busy && !link ? <p className="text-sm text-muted-foreground">Making the link…</p> : null}
          {link ? (
            <div className="space-y-3 text-sm">
              {link.qr && link.url ? (
                <div className="flex flex-col items-center gap-2">
                  <svg
                    viewBox={`-4 -4 ${link.qr.size + 8} ${link.qr.size + 8}`}
                    className="h-48 w-48 bg-white"
                    role="img"
                    aria-label={`QR code of the driver link for ${truckCode}`}
                    data-testid="driver-link-qr"
                  >
                    <path d={link.qr.d} fill="#000" />
                  </svg>
                  <code className="w-full break-all rounded bg-muted p-2 text-xs" data-testid="driver-link-url">
                    {link.url}
                  </code>
                </div>
              ) : link.revoked ? (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2" data-testid="driver-link-revoked">
                  This link was stopped: it no longer opens the driver page. Reissue to make a new one, then send or print it again.
                </p>
              ) : link.expired ? (
                <p className="rounded-md border p-2" data-testid="driver-link-expired">
                  This link&apos;s day is over: it worked until {dayTime(link.expiresAt, timezone)}. Results already saved on the driver&apos;s phone may still
                  arrive until {dayTime(link.uploadUntil, timezone)}.
                </p>
              ) : null}
              {link.url ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard?.writeText(link.url!).then(
                        () => toast.success('Link copied'),
                        () => toast.error('Could not copy: select the link and copy it.'),
                      );
                    }}
                  >
                    <Copy className="mr-1 h-4 w-4" /> Copy
                  </Button>
                  {message ? (
                    <a
                      className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
                      href={whatsappUrl(driverPhone, message, phoneCountryCode)}
                      target="_blank"
                      rel="noreferrer noopener"
                      data-testid="driver-link-whatsapp"
                      title={driverPhone ? `Send the link to ${driverName ?? 'the driver'} on WhatsApp` : 'No phone for this driver: WhatsApp asks who to send it to'}
                    >
                      <MessageCircle className="mr-1 h-4 w-4" /> WhatsApp
                    </a>
                  ) : null}
                </div>
              ) : null}
              {!link.expired ? <p className="text-muted-foreground">Works until {dayTime(link.expiresAt, timezone)} (12:00 the day after delivery).</p> : null}
              <p className="text-muted-foreground" data-testid="driver-link-seen">
                {link.lastSeenAt ? `Last opened ${clock(link.lastSeenAt, timezone)}` : 'Not opened yet'} · Used on {link.devices.n}{' '}
                {link.devices.n === 1 ? 'phone' : 'phones'}
                {link.generation > 1 ? ` · link #${link.generation}` : ''}
              </p>
              {link.devices.n > 1 ? <p className="text-amber-700">If one of them is not the driver&apos;s phone, reissue the link.</p> : null}
              {many ? <p className="text-amber-700">{many}</p> : null}
              {!link.expired ? (
                <div className="flex flex-wrap gap-2 border-t pt-3">
                  <Button size="sm" variant="outline" disabled={busy} onClick={reissue} data-testid="driver-link-reissue">
                    <RefreshCw className="mr-1 h-4 w-4" /> Reissue link
                  </Button>
                  {!link.revoked ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void change('REVOKE')} data-testid="driver-link-revoke">
                      <Ban className="mr-1 h-4 w-4" /> Revoke
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Reissue when the driver changes or the QR was shared: the old link stops at once, so printed sheets and WhatsApp messages already sent must be
                sent or printed again. Revoke stops the link until you reissue it.
              </p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog open={askReissue !== null} onOpenChange={(o) => !o && setAskReissue(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reissue the driver link for {truckCode}?</AlertDialogTitle>
            <AlertDialogDescription>{askReissue}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>Keep link</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setAskReissue(null);
                void change('REISSUE');
              }}
            >
              Reissue link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * "Reissue link?" after a driver change (spec section 4.3; reissuePrompt decides when it is asked).
 * [Keep link] is the default.
 */
export function ReissueLinkPrompt({ text, onKeep, onReissue }: { text: string | null; onKeep: () => void; onReissue: () => void }) {
  return (
    <AlertDialog open={text !== null} onOpenChange={(o) => !o && onKeep()}>
      <AlertDialogContent data-testid="reissue-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle>Reissue the driver link?</AlertDialogTitle>
          <AlertDialogDescription>{text}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus onClick={onKeep}>
            Keep link
          </AlertDialogCancel>
          <AlertDialogAction onClick={onReissue}>Reissue link</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
