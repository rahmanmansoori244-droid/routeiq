'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { OverlayPhoto } from '@/lib/delivery/outcome-view';
import { photoPlaceText } from '@/lib/delivery/office-text';

function clock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso));
}

/**
 * The delivery photos of one stop (owner request 4 Oct 2026, spec section 10.2): the full image,
 * fetched as a blob from GET /api/delivery-photos/<id> (signed-in users of the company only), its
 * time, "38 m from pin" or why there is no location, and "taken earlier" when the photo is older than
 * the arrival (a gallery photo). A photo removed by the retention says so.
 */
export function PhotoViewer({
  open,
  onOpenChange,
  title,
  photos,
  timezone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  photos: readonly OverlayPhoto[];
  timezone: string;
}) {
  const [i, setI] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const photo = photos[i] ?? null;

  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  useEffect(() => {
    if (!open || !photo) return;
    let gone = false;
    let made: string | null = null;
    setUrl(null);
    setError(null);
    if (photo.purged) {
      setError('Photo removed after the retention period (the record of it stays).');
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/delivery-photos/${encodeURIComponent(photo.id)}`, { cache: 'no-store' });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          // { data: null, error: "..." } or { data: null, error: { error: "...", code } } (httpErrorBody).
          const msg = typeof body?.error === 'string' ? body.error : (body?.error?.error ?? `HTTP ${res.status}`);
          if (!gone) setError(typeof msg === 'string' ? msg : 'Photo not available.');
          return;
        }
        const blob = await res.blob();
        made = URL.createObjectURL(blob);
        if (!gone) setUrl(made);
      } catch {
        if (!gone) setError('The photo could not be loaded. Check the connection and try again.');
      } finally {
        if (!gone) setLoading(false);
      }
    })();
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [open, photo]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {photo ? (
              <>
                Photo {i + 1} of {photos.length} · {clock(photo.takenAt, timezone)} · {photoPlaceText(photo)}
                {photo.oldPhoto ? <span className="ml-1 font-medium text-amber-700">· taken earlier (before the arrival)</span> : null}
              </>
            ) : (
              'No photo.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[240px] items-center justify-center rounded-md border bg-muted/30" data-testid="photo-viewer">
          {loading ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /> : null}
          {error ? (
            <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <ImageOff className="h-4 w-4" /> {error}
            </p>
          ) : null}
          {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL of a private photo, not an optimizable asset */}
          {url ? <img src={url} alt={`Delivery photo ${i + 1}`} className="max-h-[70vh] max-w-full object-contain" /> : null}
        </div>
        {photos.length > 1 ? (
          <div className="flex justify-between">
            <Button variant="outline" size="sm" disabled={i === 0} onClick={() => setI((x) => Math.max(0, x - 1))}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
            <Button variant="outline" size="sm" disabled={i >= photos.length - 1} onClick={() => setI((x) => Math.min(photos.length - 1, x + 1))}>
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
