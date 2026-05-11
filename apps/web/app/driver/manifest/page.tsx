/**
 * Driver manifest screen.
 *
 * - Lists today's stops in planned sequence.
 * - Pings GPS every 30s using the browser's Geolocation API while open.
 * - "Open in Maps" handoff for turn-by-turn (Google Maps URL).
 * - "Mark done" button per stop — opens a sheet with optional notes + signature
 *   stub (deferred to v2; for now just notes).
 * - "End shift" at the bottom — clears localStorage, returns to /driver.
 *
 * Note: this is a regular React client page, not a full PWA with a service
 * worker. The user can still "Add to Home Screen" in their phone browser and
 * get an icon. v2 can add offline caching.
 */
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, ChevronRight, Loader2, LogOut, MapPin, Navigation, Phone, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { SignaturePad, type SignaturePadHandle } from '../signature-pad';

const PING_INTERVAL_MS = 30_000;

interface Stop {
  assignmentId: string;
  sequence: number;
  customerCode: string;
  customerName: string;
  customerPhone: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  plannedArrivalMin: number;
  plannedLoadCases: number;
  cases: number;
  doneAt: string | null;
}

interface Manifest {
  driver: { id: string; name: string } | null;
  truck: { id: string; code: string; description: string | null } | null;
  run: {
    id: string;
    runDate: string;
    depotName: string;
    depotLat: number;
    depotLng: number;
  } | null;
  stops: Stop[];
}

export default function DriverManifestPage() {
  const router = useRouter();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastPingAt, setLastPingAt] = useState<Date | null>(null);
  const [stopBeingDone, setStopBeingDone] = useState<Stop | null>(null);
  const [doneNote, setDoneNote] = useState('');
  const [submittingDone, setSubmittingDone] = useState(false);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const signatureRef = useRef<SignaturePadHandle>(null);

  const getToken = useCallback(() => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem('riq.driver.token');
  }, []);

  const logout = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('riq.driver.token');
      window.localStorage.removeItem('riq.driver.name');
      window.localStorage.removeItem('riq.driver.truck');
    }
    router.replace('/driver');
  }, [router]);

  const loadManifest = useCallback(async () => {
    const token = getToken();
    if (!token) {
      router.replace('/driver');
      return;
    }
    try {
      const res = await fetch('/api/driver/manifest', { headers: { 'X-Driver-Token': token } });
      const json = await res.json();
      if (res.status === 401) {
        toast.error('Session expired. Sign in again.');
        logout();
        return;
      }
      if (!res.ok || !json.data) {
        toast.error('Could not load manifest.');
        return;
      }
      setManifest(json.data);
    } catch {
      toast.error('Network error.');
    } finally {
      setLoading(false);
    }
  }, [getToken, logout, router]);

  // GPS ping loop.
  const sendPing = useCallback(() => {
    if (!navigator.geolocation) return;
    const token = getToken();
    if (!token) return;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const res = await fetch('/api/driver/ping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Driver-Token': token },
            body: JSON.stringify({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              ts: Date.now(),
              speedKmh: pos.coords.speed != null ? pos.coords.speed * 3.6 : undefined,
              headingDeg: pos.coords.heading ?? undefined,
              accuracyM: pos.coords.accuracy,
            }),
          });
          if (res.ok) setLastPingAt(new Date());
          else if (res.status === 401) logout();
        } catch {
          /* swallow — next interval retries */
        }
      },
      () => {
        /* permission denied / unavailable */
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
    );
  }, [getToken, logout]);

  useEffect(() => {
    loadManifest();
    sendPing();
    pingTimer.current = setInterval(sendPing, PING_INTERVAL_MS);
    return () => {
      if (pingTimer.current) clearInterval(pingTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitStopDone() {
    if (!stopBeingDone) return;
    const token = getToken();
    if (!token) return;
    setSubmittingDone(true);
    try {
      const pos: GeolocationPosition | null = await new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve(p),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 8_000, maximumAge: 5_000 },
        );
      });
      // Capture signature (if any) as base64 PNG. Strip the "data:image/png;base64,"
      // prefix so server only stores the raw payload — keeps the column smaller.
      let signaturePngB64: string | undefined;
      const dataUrl = signatureRef.current?.getDataURL?.();
      if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
        signaturePngB64 = dataUrl.slice('data:image/png;base64,'.length);
      }
      const res = await fetch('/api/driver/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Driver-Token': token },
        body: JSON.stringify({
          assignmentId: stopBeingDone.assignmentId,
          notes: doneNote.trim() || undefined,
          signaturePngB64,
          lat: pos?.coords.latitude,
          lng: pos?.coords.longitude,
        }),
      });
      const json = await res.json();
      if (res.status === 401) {
        toast.error('Session expired.');
        logout();
        return;
      }
      if (!res.ok) {
        toast.error(typeof json.error === 'string' ? json.error : 'Could not mark done.');
        return;
      }
      toast.success(`${stopBeingDone.customerName} marked delivered.`);
      setStopBeingDone(null);
      setDoneNote('');
      signatureRef.current?.clear?.();
      loadManifest();
    } catch {
      toast.error('Network error.');
    } finally {
      setSubmittingDone(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </main>
    );
  }

  if (!manifest) return null;

  const remainingStops = manifest.stops.filter((s) => !s.doneAt);
  const doneCount = manifest.stops.length - remainingStops.length;

  if (!manifest.run) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10 text-center">
        <Truck className="mx-auto mb-3 h-10 w-10 text-slate-400" />
        <p className="text-base text-slate-700">
          No run is assigned to your truck yet. Ask your dispatcher to assign you and pull-to-refresh.
        </p>
        <button onClick={loadManifest} className="mt-4 rounded-md bg-blue-600 px-4 py-3 text-white">Refresh</button>
        <button onClick={logout} className="mt-2 text-sm text-slate-500">Sign out</button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl pb-20">
      {/* Sticky header */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">
              {manifest.run.depotName} · {manifest.run.runDate}
            </div>
            <div className="mt-0.5 text-base font-semibold">
              {manifest.driver?.name ?? 'Driver'} · Truck {manifest.truck?.code}
            </div>
          </div>
          <button onClick={logout} className="text-slate-500" aria-label="Sign out">
            <LogOut className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-slate-600">
          <span>
            {doneCount} / {manifest.stops.length} delivered
          </span>
          <span>{lastPingAt ? `GPS ping ${secondsAgo(lastPingAt)}s ago` : 'GPS pending…'}</span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-blue-600 transition-all"
            style={{ width: `${(doneCount / Math.max(manifest.stops.length, 1)) * 100}%` }}
          />
        </div>
      </header>

      {/* Stop list */}
      <ul className="space-y-2 px-3 py-3">
        {manifest.stops.map((stop) => {
          const isDone = !!stop.doneAt;
          return (
            <li
              key={stop.assignmentId}
              className={`rounded-lg border p-4 ${isDone ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-white shadow-sm'}`}
            >
              <div className="flex items-start gap-3">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${isDone ? 'bg-emerald-600 text-white' : 'bg-slate-900 text-white'}`}>
                  {isDone ? <CheckCircle2 className="h-5 w-5" /> : stop.sequence}
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold">{stop.customerName}</div>
                  <div className="text-xs text-slate-500">
                    {stop.customerCode} · {stop.cases} cases · arrives ~{minToHm(stop.plannedArrivalMin)}
                  </div>
                  {stop.address && <div className="mt-1 text-xs text-slate-500">{stop.address}</div>}
                  {isDone && stop.doneAt && (
                    <div className="mt-1 text-xs text-emerald-700">Done at {formatTime(stop.doneAt)}</div>
                  )}
                </div>
              </div>
              {!isDone && (
                <div className="mt-3 flex gap-2">
                  {stop.lat != null && stop.lng != null && (
                    <a
                      href={`https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <Navigation className="h-4 w-4" /> Navigate
                    </a>
                  )}
                  {stop.customerPhone && (
                    <a
                      href={`tel:${stop.customerPhone}`}
                      className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                      <Phone className="h-4 w-4" />
                    </a>
                  )}
                  <button
                    onClick={() => setStopBeingDone(stop)}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                  >
                    Mark done <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </li>
          );
        })}
        {manifest.stops.length === 0 && (
          <li className="rounded-lg border border-slate-200 bg-white p-6 text-center text-sm text-slate-600">
            <MapPin className="mx-auto mb-2 h-6 w-6 text-slate-400" />
            No stops assigned to your truck yet. Pull-to-refresh once the dispatcher releases the run.
          </li>
        )}
      </ul>

      {/* Mark-done sheet */}
      {stopBeingDone && (
        <div className="fixed inset-0 z-20 flex flex-col justify-end bg-black/40 px-3 pb-3" onClick={() => !submittingDone && setStopBeingDone(null)}>
          <div className="rounded-xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <div className="text-xs font-medium uppercase text-slate-500">Confirm delivery</div>
            <div className="mt-1 text-lg font-semibold">{stopBeingDone.customerName}</div>
            <div className="text-xs text-slate-500">
              {stopBeingDone.customerCode} · {stopBeingDone.cases} cases
            </div>
            <textarea
              value={doneNote}
              onChange={(e) => setDoneNote(e.target.value)}
              placeholder="Optional note (e.g., left with security, partial delivery, customer absent)"
              className="mt-3 h-20 w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none"
            />
            <div className="mt-3">
              <SignaturePad ref={signatureRef} height={140} />
            </div>
            <div className="mt-3 flex gap-2">
              <button
                disabled={submittingDone}
                onClick={() => {
                  setStopBeingDone(null);
                  setDoneNote('');
                }}
                className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-3 text-sm font-medium text-slate-700"
              >
                Cancel
              </button>
              <button
                disabled={submittingDone}
                onClick={submitStopDone}
                className="flex-1 rounded-md bg-emerald-600 px-3 py-3 text-sm font-medium text-white disabled:opacity-50"
              >
                {submittingDone ? 'Saving…' : 'Confirm delivered'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function secondsAgo(d: Date) {
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
}

function minToHm(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}h${m.toString().padStart(2, '0')}`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
