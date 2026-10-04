'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, Clock, Info, Languages, MapPin, Phone, Play, Square, Truck, Warehouse } from 'lucide-react';
import type { DriverAction, DriverManifest, DriverResults, LinkStateCode, NotDeliveredReasonName, OutcomeName, PhotoPositionStatusName } from '@/lib/driver-link/manifest-types';
import { deviceId, fetchManifest, photoUrl, postActions, postPhoto, safeLocalStorage, tokenFromPath } from '@/lib/driver-page/api';
import { driverNames, openTripIndex, stopTitle, telHref, tripLine } from '@/lib/driver-page/format';
import { clockTime, fmtDate, fmtHours, hhmm, LANG_TOGGLE, pickLang, statusLabel, t, type Lang } from '@/lib/driver-page/i18n';
import { applyQueued, unsentList, type OverlayLoad, type OverlayStop } from '@/lib/driver-page/overlay';
import { betterFix, freshFix, positionStatus } from '@/lib/driver-page/photo';
import {
  actionItem,
  flushQueue,
  newKey,
  nsOf,
  releaseHeld,
  staleNamespaces,
  waitingCount,
  type Draft,
  type PhotoBody,
  type QueueItem,
  type QueueStore,
  type Report,
  type SentMap,
} from '@/lib/driver-page/queue';
import { memoryStore, openIdbStore, phoneTodayIso, photoBlob } from '@/lib/driver-page/store';
import { dropDriverWorker, shouldRegisterWorker } from '@/lib/driver-page/worker';
import { zonedDayStart } from '@/lib/dispatch/time';
import { ArrivedWhen } from './arrived-when';
import type { PhotoPlace, TakenPhoto } from './camera-button';
import { LinkState } from './link-state';
import { OutcomeFlow, type DraftPhoto } from './outcome-flow';
import { ResultChip, StopSheet } from './stop-sheet';
import { SyncBadge } from './sync-badge';
import { posOf, useTracker } from './use-tracker';
import { WebviewGate } from './webview-gate';
import { WhichCustomer } from './which-customer';

/**
 * The driver's phone page (owner request 4 Oct 2026, spec sections 6, 7, 12 and 13). One page per
 * truck-day: the trips in departure order, their stops, Navigate, the plan and the cases; on a trip
 * that is on the road the automatic stop timer, the results (Delivered / Partly / Not delivered) with
 * photos, and Back at depot.
 *
 * Works without signal: everything is queued on the phone (IndexedDB) and sent when there is signal,
 * each action with its own key so a retry never records twice; the last manifest is kept and shown
 * with "Last updated"; a service worker scoped to /d/ reloads the page without signal. Mobile first
 * (360 x 640 and up), English / Arabic (RTL).
 */

const POLL_MS = 60_000;
const FLUSH_MS = 15_000;
const NOTICE_KEY = 'riq.d.notice';
const LANG_KEY = 'riq.d.lang';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'link'; code: LinkStateCode; date: string | null; uploadOnly: boolean }
  | { kind: 'offline' };

function storeGet(key: string): string | null {
  try {
    return safeLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storeSet(key: string, value: string): void {
  try {
    safeLocalStorage()?.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the choice lasts for this page view only.
  }
}

/** The first 16 hex of SHA-256 of the token (the `links` store key); a plain hash where SubtleCrypto is missing. */
async function tokenKey(token: string): Promise<string> {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  } catch {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619) >>> 0;
    return `f${h.toString(16).padStart(8, '0')}`;
  }
}

/** The build's tag for the service worker (its static cache is named after it). */
function buildTag(): string {
  const srcs = [...document.querySelectorAll('script[src*="/_next/static/"]')].map((s) => s.getAttribute('src') ?? '').join('|');
  let h = 5381;
  for (let i = 0; i < srcs.length; i++) h = (Math.imul(h, 33) ^ srcs.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** The truck-day's results laid into the manifest (the action and photo answers carry them). */
function withResults(m: DriverManifest, r: DriverResults): DriverManifest {
  return {
    ...m,
    loads: m.loads.map((l) => ({
      ...l,
      backAtDepotAt: r.back[String(l.loadNo)] ?? l.backAtDepotAt,
      stops: l.stops.map((s) => ({ ...s, result: r.stops[s.key] ?? s.result })),
    })),
  };
}

const STATUS_TONE: Record<string, string> = {
  PLANNED: 'bg-slate-200 text-slate-800',
  LOCKED: 'bg-slate-300 text-slate-900',
  LOADING: 'bg-amber-200 text-amber-950',
  DISPATCHED: 'bg-emerald-600 text-white',
  COMPLETED: 'bg-slate-700 text-white',
};

export function DriverPage() {
  const [lang, setLang] = useState<Lang>('en');
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [manifest, setManifest] = useState<DriverManifest | null>(null);
  const [staleAt, setStaleAt] = useState<number | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  // The phone's queue was read for the truck-day shown (the tracker waits for it: an unsent arrival
  // restores its stop with its own time instead of being found again).
  const [itemsRead, setItemsRead] = useState(false);
  const [sent, setSent] = useState<SentMap>({});
  const [reports, setReports] = useState<Report[]>([]);
  const [online, setOnline] = useState(true);
  const [persistent, setPersistent] = useState(true);
  const [openTrip, setOpenTrip] = useState<number | null>(null);
  const [openStop, setOpenStop] = useState<string | null>(null);
  const [entering, setEntering] = useState<{ stopKey: string; draft: Draft } | null>(null);
  const [draftPhotos, setDraftPhotos] = useState<Record<string, { url: string | null; positionStatus: PhotoPositionStatusName | null }>>({});
  const [serverPhotos, setServerPhotos] = useState<Record<string, string | null>>({});
  const [restored, setRestored] = useState<{ stopKey: string; lostPhoto: boolean } | null>(null);
  const [notice, setNotice] = useState(false);
  const [resume, setResume] = useState(false);
  const [cameraSlow, setCameraSlow] = useState(false);
  const [confirmBack, setConfirmBack] = useState<number | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const token = useRef<string | null>(null);
  const device = useRef<string>('');
  const store = useRef<QueueStore | null>(null);
  const ns = useRef<string | null>(null);
  const linkKey = useRef<string>('');
  const stopped = useRef(false);
  const dead = useRef(false);
  const pauseUntil = useRef(0);
  const flushing = useRef(false);
  const manifestRef = useRef<DriverManifest | null>(null);
  const sentRef = useRef<SentMap>({});
  const draftsChecked = useRef(false);
  const trackingOnRef = useRef(false);
  // Bumped each time a send brought results: a manifest asked for before that is older than them.
  const sendSeq = useRef(0);

  const refreshItems = useCallback(async () => {
    if (!store.current || !ns.current) return;
    setItems(await store.current.items(ns.current));
    setItemsRead(true);
  }, []);

  const saveManifest = useCallback(async (m: DriverManifest) => {
    manifestRef.current = m;
    setManifest(m);
    if (store.current && ns.current) await store.current.putManifest(ns.current, { manifest: m, savedAt: Date.now(), sent: sentRef.current }).catch(() => {});
  }, []);

  const forgetPage = useCallback(() => {
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'forget', url: window.location.pathname });
    } catch {
      // no worker
    }
  }, []);

  // ---------------------------------------------------------------- sending
  const flush = useCallback(async () => {
    const s = store.current;
    const n = ns.current;
    const tok = token.current;
    if (!s || !n || !tok || dead.current || flushing.current || Date.now() < pauseUntil.current) return;
    flushing.current = true;
    try {
      const r = await flushQueue({
        store: s,
        ns: n,
        now: () => Date.now(),
        postActions: (actions) => postActions(tok, device.current, actions),
        postPhoto: async (item) => {
          const blob = photoBlob(item.blob);
          if (!blob) return { status: 415, body: { data: null, error: { code: 'NOT_JPEG' } }, retryAfter: null };
          const { positionUntil: _u, width: _w, height: _h, ...meta } = item.body as PhotoBody;
          return postPhoto(tok, device.current, meta as unknown as Record<string, unknown>, blob);
        },
        // Each answer's results are shown BEFORE its items leave the queue (a sent result never vanishes).
        onResults: async (results) => {
          sendSeq.current++;
          if (manifestRef.current) await saveManifest(withResults(manifestRef.current, results));
        },
      });
      if (Object.keys(r.sentMap).length) {
        sentRef.current = { ...sentRef.current, ...r.sentMap };
        setSent(sentRef.current);
      }
      if (r.reports.length) setReports((prev) => [...prev, ...r.reports].slice(-30));
      if (r.pauseUntil) pauseUntil.current = r.pauseUntil;
      if (r.dead) {
        dead.current = true;
        stopped.current = true;
        forgetPage();
        setPhase({ kind: 'link', code: r.dead, date: manifestRef.current?.date ?? null, uploadOnly: false });
      }
      if (r.closed) {
        dead.current = true;
        stopped.current = true;
        forgetPage();
        setPhase({ kind: 'link', code: 'UPLOAD_CLOSED', date: manifestRef.current?.date ?? null, uploadOnly: false });
      }
      await refreshItems();
      if (r.closed) await s.clearNamespace(n).catch(() => {});
    } finally {
      flushing.current = false;
    }
  }, [refreshItems, saveManifest, forgetPage]);

  // ---------------------------------------------------------------- the manifest
  const load = useCallback(async () => {
    if (stopped.current || Date.now() < pauseUntil.current) return;
    const tok = token.current;
    if (!tok) {
      stopped.current = true;
      setPhase({ kind: 'link', code: 'LINK_NOT_FOUND', date: null, uploadOnly: false });
      return;
    }
    const asked = sendSeq.current;
    const a = await fetchManifest(tok, device.current);
    if (a.kind === 'ok') {
      const m = a.manifest;
      const n = nsOf(m.truck.id, m.date);
      // A send answered while this manifest was on its way: the manifest may predate those results
      // (read on the server before they were stored). The page keeps what it has; the next read is fresh.
      if (asked !== sendSeq.current && manifestRef.current && ns.current === n) {
        void flush();
        return;
      }
      if (ns.current !== n) {
        ns.current = n;
        setItemsRead(false);
        const kept = await store.current?.getManifest<DriverManifest>(n).catch(() => null);
        sentRef.current = kept?.sent ?? sentRef.current;
        setSent(sentRef.current);
        // The queue first, then the manifest: the tracker starts from both together.
        await refreshItems();
      }
      await saveManifest(m);
      setStaleAt(null);
      setPhase({ kind: 'ready' });
      await store.current?.putLink(linkKey.current, { ns: n, trackingOn: trackingOnRef.current }).catch(() => {});
      // Arrivals kept for a trip not dispatched yet go out now that it is.
      const s = store.current;
      if (s) {
        const out = new Set(m.loads.filter((l) => l.status === 'DISPATCHED' || l.status === 'COMPLETED').map((l) => l.loadNo));
        const released = releaseHeld(await s.items(n), out, Date.now());
        if (released.length) await s.put(released);
      }
      await refreshItems();
      void flush();
      return;
    }
    if (a.kind === 'link') {
      if (a.code === 'LINK_EXPIRED' && a.uploadOnly) {
        // The upload grace: no more reading, but the results kept on this phone still go out.
        stopped.current = true;
        setPhase({ kind: 'link', code: a.code, date: a.date, uploadOnly: true });
        void flush();
        return;
      }
      stopped.current = true;
      setPhase({ kind: 'link', code: a.code, date: a.date, uploadOnly: false });
      // Another company's RouteIQ session in this browser: nothing is wrong with the link itself.
      if (a.code === 'SIGNED_IN_OTHER_TENANT') return;
      dead.current = true;
      forgetPage();
      if (a.code === 'UPLOAD_CLOSED' && store.current && ns.current) {
        await refreshItems();
        await store.current.clearNamespace(ns.current).catch(() => {});
      }
      return;
    }
    if (a.kind === 'busy') {
      pauseUntil.current = Date.now() + (a.retryAfterSec ?? 60) * 1000;
      return;
    }
    if (manifestRef.current) {
      setStaleAt((s) => s ?? Date.now());
      setPhase({ kind: 'ready' });
    } else setPhase({ kind: 'offline' });
  }, [flush, refreshItems, saveManifest, forgetPage]);

  // ---------------------------------------------------------------- start up
  useEffect(() => {
    let cancelled = false;
    setLang(pickLang(storeGet(LANG_KEY), navigator.language));
    token.current = tokenFromPath(window.location.pathname);
    device.current = deviceId();
    setOnline(navigator.onLine !== false);
    void (async () => {
      const s = (await openIdbStore().catch(() => null)) ?? memoryStore();
      if (cancelled) return;
      store.current = s;
      setPersistent(s.persistent);
      // Truck-days whose upload window ended are deleted from the phone.
      try {
        for (const old of staleNamespaces(await s.namespaces(), phoneTodayIso())) await s.clearNamespace(old);
      } catch {
        // best effort
      }
      if (token.current) {
        linkKey.current = await tokenKey(token.current);
        const entry = await s.getLink(linkKey.current).catch(() => null);
        if (entry) {
          ns.current = entry.ns;
          trackingOnRef.current = entry.trackingOn;
          setResume(entry.trackingOn);
          const kept = await s.getManifest<DriverManifest>(entry.ns).catch(() => null);
          // The queue BEFORE the kept manifest: the tracker restores a stop in progress from both (an
          // arrival still waiting to send keeps its time instead of being found again).
          await refreshItems();
          if (kept && !manifestRef.current) {
            sentRef.current = kept.sent ?? {};
            setSent(sentRef.current);
            manifestRef.current = kept.manifest;
            setManifest(kept.manifest);
            setStaleAt(kept.savedAt);
            setPhase({ kind: 'ready' });
          }
        }
      }
      try {
        // Production builds only (lib/driver-page/worker.ts): next dev chunk URLs are not content-hashed.
        if (shouldRegisterWorker(process.env.NODE_ENV, navigator)) void navigator.serviceWorker.register(`/driver-sw.js?v=${buildTag()}`, { scope: '/d/' }).catch(() => {});
        else void dropDriverWorker(navigator, typeof caches === 'undefined' ? undefined : caches);
      } catch {
        // no worker: the page still works while it is open
      }
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load, refreshItems]);

  // Polling, flushing and the signal.
  useEffect(() => {
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const send = setInterval(() => {
      setNowTick(Date.now());
      if (document.visibilityState === 'visible') void flush();
    }, FLUSH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void flush();
        void load();
      }
    };
    const onOnline = () => {
      setOnline(true);
      onVisible();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(poll);
      clearInterval(send);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, flush]);

  // The location notice on the first open (and from the info button).
  useEffect(() => {
    if (manifest && storeGet(NOTICE_KEY) !== '1') setNotice(true);
  }, [manifest]);

  const overlay = useMemo<OverlayLoad[] | null>(() => (manifest ? applyQueued(manifest, items, sent) : null), [manifest, items, sent]);

  // A draft left by a reload (the camera can make the phone close the tab): reopen it once.
  useEffect(() => {
    if (draftsChecked.current || !manifest || !store.current || !ns.current) return;
    draftsChecked.current = true;
    void (async () => {
      const s = store.current!;
      const all = await s.drafts(ns.current!);
      const latest = Object.entries(all).sort((a, b) => b[1].savedAt - a[1].savedAt)[0];
      if (!latest) return;
      const [stopKey, draft] = latest;
      const queued = await s.items(ns.current!);
      const photos: Record<string, { url: string | null; positionStatus: PhotoPositionStatusName | null }> = {};
      for (const i of queued) {
        if (i.kind !== 'photo' || i.stopKey !== stopKey || i.state !== 'draft') continue;
        const b = photoBlob(i.blob);
        photos[i.key] = { url: b ? URL.createObjectURL(b) : null, positionStatus: (i.body as PhotoBody).positionStatus ?? null };
      }
      const kept = draft.photoKeys.filter((k) => photos[k]);
      const lostPhoto = !!draft.pendingPhotoKey && !photos[draft.pendingPhotoKey];
      setDraftPhotos(photos);
      setOpenStop(stopKey);
      setEntering({ stopKey, draft: { ...draft, photoKeys: kept, pendingPhotoKey: null } });
      setRestored({ stopKey, lostPhoto });
    })();
  }, [manifest]);

  // ---------------------------------------------------------------- queueing
  const enqueue = useCallback(
    async (action: DriverAction, held: boolean) => {
      const s = store.current;
      const n = ns.current;
      if (!s || !n) return;
      await s.put([actionItem(n, action, Date.now(), held)]);
      await refreshItems();
      void flush();
    },
    [refreshItems, flush],
  );

  const nowMinOf = useCallback((now: number) => {
    const m = manifestRef.current;
    if (!m) return 0;
    try {
      return (now - zonedDayStart(m.date, m.tz).getTime()) / 60_000;
    } catch {
      return 0;
    }
  }, []);

  const tracker = useTracker({
    loads: overlay,
    depot: manifest ? { lat: manifest.depot.lat, lng: manifest.depot.lng } : null,
    radiusM: manifest?.settings.radiusM ?? 100,
    nowMinOf,
    enqueue: (a, held) => void enqueue(a, held),
    resume,
    onTrackingChange: (on) => {
      trackingOnRef.current = on;
      if (store.current && ns.current) void store.current.putLink(linkKey.current, { ns: ns.current, trackingOn: on }).catch(() => {});
    },
    ready: itemsRead,
  });

  // ---------------------------------------------------------------- results
  const stopOf = (key: string | null): { load: OverlayLoad; stop: OverlayStop } | null => {
    if (!key || !overlay) return null;
    for (const l of overlay) {
      const s = l.stops.find((x) => x.key === key);
      if (s) return { load: l, stop: s };
    }
    return null;
  };

  const putDraft = useCallback(async (stopKey: string, d: Draft) => {
    setEntering({ stopKey, draft: d });
    if (store.current && ns.current) await store.current.putDraft(ns.current, stopKey, d).catch(() => {});
  }, []);

  const startResult = (stopKey: string, outcome: OutcomeName) => {
    const found = stopOf(stopKey);
    if (!found) return;
    const v = found.stop.view;
    const changing = v.outcome !== null;
    const lines: Record<string, number> = {};
    if (changing && v.lines) for (const l of v.lines) lines[l.lineId] = l.delivered;
    setRestored(null);
    void putDraft(stopKey, {
      outcome,
      reason: changing && outcome !== 'DELIVERED' ? v.reason : null,
      note: changing ? (v.note ?? '') : '',
      lines,
      photoKeys: [],
      pendingPhotoKey: null,
      noPhoto: false,
      savedAt: Date.now(),
    });
  };

  const cancelResult = async () => {
    if (!entering) return;
    for (const k of entering.draft.photoKeys) {
      const u = draftPhotos[k]?.url;
      if (u) URL.revokeObjectURL(u);
    }
    if (store.current && ns.current) await store.current.dropDrafts(ns.current, entering.stopKey).catch(() => {});
    setEntering(null);
    setDraftPhotos({});
    setRestored(null);
    await refreshItems();
  };

  const saveResult = async () => {
    if (!entering || !store.current || !ns.current) return;
    const found = stopOf(entering.stopKey);
    if (!found) return;
    const d = entering.draft;
    const outcome = d.outcome!;
    const lines = outcome === 'PARTLY_DELIVERED' ? found.stop.orders.flatMap((o) => o.lines).map((l) => ({ lineId: l.lineId, delivered: d.lines[l.lineId] ?? l.cases })) : null;
    const action: DriverAction = {
      key: newKey(),
      type: 'OUTCOME',
      stop: entering.stopKey,
      at: new Date().toISOString(),
      pos: posOf(tracker.lastFix()),
      outcome,
      reason: outcome === 'DELIVERED' ? null : (d.reason as NotDeliveredReasonName | null),
      note: d.note.trim() || null,
      lines,
      photoKeys: d.photoKeys,
      noPhotoReason: d.noPhoto && !d.photoKeys.length && outcome !== 'NOT_DELIVERED' ? 'CAMERA_FAILED' : null,
    } as DriverAction;
    await store.current.commit(ns.current, entering.stopKey, d.photoKeys, actionItem(ns.current, action, Date.now()));
    setEntering(null);
    setDraftPhotos({});
    setRestored(null);
    await refreshItems();
    void flush();
  };

  const undoResult = (stopKey: string) => {
    void enqueue({ key: newKey(), type: 'OUTCOME', stop: stopKey, at: new Date().toISOString(), pos: posOf(tracker.lastFix()), outcome: null, photoKeys: [] }, false);
  };

  // Not awaited by the camera (it opens inside the tap); the write ends long before the camera returns.
  const beforeCamera = (key: string) => {
    if (entering) void putDraft(entering.stopKey, { ...entering.draft, pendingPhotoKey: key, savedAt: Date.now() });
  };

  // Asked the moment the photo comes back from the camera: a fresh fix, and the tracker's last fix then.
  const locatePhoto = (): PhotoPlace => {
    const last = tracker.lastFix();
    return { fresh: freshFix(), last: last ? { lat: last.lat, lng: last.lng, accuracyM: last.accuracyM, at: last.at } : null };
  };

  const addPhoto = async (p: TakenPhoto) => {
    if (!entering || !store.current || !ns.current) return;
    const s = store.current;
    const n = ns.current;
    const stopKey = entering.stopKey;
    const now = Date.now();
    const body: PhotoBody = {
      key: p.key,
      stop: stopKey,
      takenAt: new Date(p.takenAt).toISOString(),
      positionStatus: 'TIMEOUT',
      pos: null,
      exif: p.exif ? { lat: p.exif.lat, lng: p.exif.lng, takenAt: p.exif.takenAt ? new Date(p.exif.takenAt).toISOString() : null, zoned: p.exif.zoned } : null,
      fileLastModified: p.fileLastModified ? new Date(p.fileLastModified).toISOString() : null,
      positionUntil: now + 15_000,
      width: p.width,
      height: p.height,
    };
    await s.put([{ key: p.key, ns: n, kind: 'photo', state: 'draft', createdAt: now, attempts: 0, nextAt: now, stopKey, loadNo: Number(stopKey.split(':')[0]), body, blob: p.blob }]);
    setDraftPhotos((prev) => ({ ...prev, [p.key]: { url: URL.createObjectURL(p.blob), positionStatus: null } }));
    await putDraft(stopKey, { ...entering.draft, photoKeys: [...entering.draft.photoKeys, p.key], pendingPhotoKey: null, savedAt: Date.now() });
    // The position asked when the photo came back (never where "Use photo" was tapped); Save never
    // waits for it, the photo is held at most 15 s for it.
    const fresh = await p.place.fresh;
    const fix = betterFix(fresh.fix, p.place.last, p.cameraOpenedAt);
    const status = positionStatus(fix, fresh.error);
    const current = (await s.items(n)).find((i) => i.key === p.key);
    if (current) {
      await s.put([{ ...current, body: { ...(current.body as PhotoBody), positionStatus: status, pos: fix ? { lat: fix.lat, lng: fix.lng, accuracyM: Math.round(fix.accuracyM), at: new Date(fix.at).toISOString() } : null, positionUntil: null } }]);
    }
    setDraftPhotos((prev) => (prev[p.key] ? { ...prev, [p.key]: { ...prev[p.key]!, positionStatus: status } } : prev));
    void flush();
  };

  const removePhoto = async (key: string) => {
    if (!entering) return;
    const u = draftPhotos[key]?.url;
    if (u) URL.revokeObjectURL(u);
    await store.current?.remove([key]);
    setDraftPhotos((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    await putDraft(entering.stopKey, { ...entering.draft, photoKeys: entering.draft.photoKeys.filter((k) => k !== key), savedAt: Date.now() });
  };

  const backAtDepot = (loadNo: number) => {
    setConfirmBack(null);
    const l = overlay?.find((x) => x.loadNo === loadNo);
    const missing = l ? l.stops.filter((s) => s.view.doneAt === null).length : 0;
    void enqueue({ key: newKey(), type: 'BACK_AT_DEPOT', load: loadNo, at: new Date().toISOString(), pos: posOf(tracker.lastFix()) }, false);
    tracker.dismissBack();
    if (missing) setInfo(t(lang, 'tripClosesWhenAll'));
  };

  // Photos of the open stop, fetched with the token in the header into blob URLs.
  const open = stopOf(openStop);
  useEffect(() => {
    const ids = open?.stop.view.photoIds ?? [];
    const tok = token.current;
    if (!tok) return;
    for (const id of ids) {
      if (id in serverPhotos) continue;
      setServerPhotos((p) => ({ ...p, [id]: null }));
      void photoUrl(tok, device.current, id).then((u) => setServerPhotos((p) => ({ ...p, [id]: u })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.stop.key, open?.stop.view.photoIds.join('|')]);

  const tripIndex = useMemo(() => (manifest ? (openTrip ?? openTripIndex(manifest)) : -1), [manifest, openTrip]);
  const toggleLang = () => {
    const next: Lang = lang === 'en' ? 'ar' : 'en';
    setLang(next);
    storeSet(LANG_KEY, next);
  };

  const waiting = waitingCount(items);
  const nowMin = nowMinOf(nowTick);
  const startOffered =
    !!overlay && !tracker.on && overlay.some((l) => l.status !== 'COMPLETED' && l.status !== 'PLANNED' && !l.back && (l.status === 'DISPATCHED' || l.departMin - 30 <= nowMin));
  const locationOff = tracker.gps === 'denied' || tracker.gps === 'unsupported';
  const whenStop = stopOf(tracker.arrivedWhen);
  const linkDown = phase.kind === 'link';
  const unsent = linkDown && overlay ? unsentList(overlay, items) : [];

  const flow =
    entering && open && entering.stopKey === open.stop.key ? (
      <>
        {restored && restored.stopKey === open.stop.key ? (
          <p className="rounded-xl bg-blue-50 p-3 text-sm font-semibold" data-testid="draft-restored">
            {t(lang, 'draftRestored')} {restored.lostPhoto ? t(lang, 'lastPhotoLost') : ''}
          </p>
        ) : null}
        <OutcomeFlow
          lang={lang}
          tz={manifest?.tz ?? 'Asia/Muscat'}
          stop={open.stop}
          draft={entering.draft}
          photos={entering.draft.photoKeys.map((k): DraftPhoto => ({ key: k, url: draftPhotos[k]?.url ?? null, positionStatus: draftPhotos[k]?.positionStatus ?? null }))}
          maxPhotos={Math.max(0, 3 - open.stop.view.photoIds.length - open.stop.view.localPhotos)}
          photoRequired={manifest?.settings.photoRequired ?? true}
          onDraft={(d) => void putDraft(entering.stopKey, d)}
          onBeforeCamera={beforeCamera}
          onLocate={locatePhoto}
          onPhoto={(p) => void addPhoto(p)}
          onRemovePhoto={(k) => void removePhoto(k)}
          onSave={() => void saveResult()}
          onCancel={() => void cancelResult()}
          onCameraSlow={() => setCameraSlow(true)}
        />
      </>
    ) : null;

  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} className="mx-auto min-h-screen max-w-xl pb-24 text-base">
      <Header lang={lang} manifest={manifest} staleAt={staleAt} waiting={waiting} online={online} onLang={toggleLang} onInfo={() => setNotice(true)} />
      <WebviewGate lang={lang} failed={cameraSlow} />
      {!persistent ? <p className="mx-3 mt-3 rounded-lg bg-red-600 p-3 text-sm font-semibold text-white">{t(lang, 'keepOpenNoStorage')}</p> : null}
      {manifest?.office ? (
        <div className="mx-3 mt-3 rounded-lg border border-yellow-500 bg-yellow-100 p-3 text-sm font-semibold" data-testid="office-banner">
          {t(lang, 'officeBanner', { name: manifest.office.userName })}
        </div>
      ) : null}
      {reports.length ? (
        <div className="mx-3 mt-3 space-y-1 rounded-lg border border-red-300 bg-red-50 p-3 text-sm" data-testid="not-sent">
          <p className="font-bold text-red-800">{t(lang, 'notSentTitle')}</p>
          {reports.slice(-5).map((r) => (
            <p key={r.key}>
              <span dir="auto">{(r.stopKey && stopOf(r.stopKey)?.stop.customerName) || r.type}</span>: {r.message ? r.message[lang] : r.code}
            </p>
          ))}
          <button type="button" className="mt-1 min-h-10 text-sm font-semibold underline" onClick={() => setReports([])}>
            {t(lang, 'close')}
          </button>
        </div>
      ) : null}
      {info ? (
        <button type="button" onClick={() => setInfo(null)} className="mx-3 mt-3 block w-[calc(100%-1.5rem)] rounded-lg bg-blue-50 p-3 text-start text-sm font-semibold">
          {info}
        </button>
      ) : null}

      {phase.kind === 'loading' ? <p className="p-6 text-center text-slate-600">{t(lang, 'loading')}</p> : null}
      {phase.kind === 'offline' ? (
        <div className="p-6 text-center">
          <p className="text-slate-700">{t(lang, 'networkError')}</p>
          <button type="button" className="mt-4 min-h-12 rounded-lg bg-slate-900 px-5 font-semibold text-white" onClick={() => void load()}>
            {t(lang, 'tryAgain')}
          </button>
        </div>
      ) : null}
      {phase.kind === 'link' ? (
        <>
          <LinkState lang={lang} code={phase.code} date={phase.date} />
          {phase.uploadOnly && waiting ? <p className="mx-3 rounded-lg bg-amber-50 p-3 text-center font-semibold">{t(lang, 'sendingSaved')}</p> : null}
          {unsent.length && !phase.uploadOnly ? (
            <div className="mx-3 space-y-1 rounded-lg bg-white p-3 text-sm" data-testid="unsent-list">
              <p className="font-bold">{t(lang, 'notSentList', { n: unsent.length })}</p>
              {unsent.map((u) => (
                <p key={`${u.stopKey}|${u.at}`}>
                  <span dir="auto">{u.customer}</span> · {u.outcome ? t(lang, u.outcome === 'DELIVERED' ? 'delivered' : u.outcome === 'PARTLY_DELIVERED' ? 'partly' : 'notDelivered') : t(lang, 'undo')} ·{' '}
                  {manifest ? clockTime(u.at, manifest.tz) : u.at}
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {!linkDown && manifest && overlay && open ? (
        <StopSheet
          lang={lang}
          manifest={manifest}
          load={open.load}
          stop={open.stop}
          actionable={open.load.status === 'DISPATCHED'}
          atThisStop={tracker.state.phase === 'AT_STOP' && tracker.state.key === open.stop.key}
          trackingOn={tracker.on}
          locationOff={locationOff}
          flow={flow}
          photoUrls={serverPhotos}
          onBack={() => setOpenStop(null)}
          onArrive={() => tracker.manualArrive(open.stop.key)}
          onStartResult={(o) => startResult(open.stop.key, o)}
          onUndo={() => undoResult(open.stop.key)}
        />
      ) : !linkDown && manifest && overlay ? (
        <main className="space-y-3 p-3">
          <TrackingBar lang={lang} on={tracker.on} gps={tracker.gps} offered={startOffered} onStart={tracker.start} onStop={tracker.stop} />
          {manifest.loads.length === 0 ? (
            <p className="rounded-xl bg-white p-5 text-center text-lg" data-testid="no-trips">
              {t(lang, 'noTrips', { truck: manifest.truck.code, date: fmtDate(lang)(manifest.date) })}
            </p>
          ) : null}
          {overlay.map((l, i) => (
            <TripCard
              key={l.loadNo}
              lang={lang}
              manifest={manifest}
              load={l}
              open={i === tripIndex}
              current={tracker.trip?.loadNo === l.loadNo}
              onToggle={() => setOpenTrip(i === tripIndex ? -1 : i)}
              onStop={(s) => setOpenStop(s.key)}
              onBack={() => setConfirmBack(l.loadNo)}
            />
          ))}
        </main>
      ) : null}

      {tracker.whichCustomer && overlay ? (
        <WhichCustomer
          lang={lang}
          options={tracker.whichCustomer.map((k) => ({ key: k, label: (() => { const f = stopOf(k); return f ? stopTitle(f.stop) : k; })() }))}
          onChoose={tracker.chooseCustomer}
          onClose={() => tracker.chooseCustomer('')}
        />
      ) : null}
      {whenStop && !tracker.whichCustomer ? <ArrivedWhen lang={lang} customer={whenStop.stop.customerName} onAnswer={(m) => tracker.answerWhen(whenStop.stop.key, m)} /> : null}
      {/* The suggestion names the trip it was raised for, and only while that trip is still the current one. */}
      {(confirmBack !== null || (tracker.backSuggested !== null && tracker.trip?.loadNo === tracker.backSuggested)) && overlay ? (
        <BackAtDepotDialog
          lang={lang}
          load={overlay.find((l) => l.loadNo === (confirmBack ?? tracker.backSuggested)) ?? null}
          onYes={(n) => backAtDepot(n)}
          onNo={() => {
            setConfirmBack(null);
            tracker.dismissBack();
          }}
        />
      ) : null}

      {notice && manifest ? (
        <LocationNotice
          lang={lang}
          company={manifest.tenantName}
          days={manifest.settings.locationRetentionDays}
          onOk={() => {
            storeSet(NOTICE_KEY, '1');
            setNotice(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Header({
  lang,
  manifest,
  staleAt,
  waiting,
  online,
  onLang,
  onInfo,
}: {
  lang: Lang;
  manifest: DriverManifest | null;
  staleAt: number | null;
  waiting: number;
  online: boolean;
  onLang: () => void;
  onInfo: () => void;
}) {
  const names = manifest ? driverNames(manifest) : null;
  return (
    <header className="sticky top-0 z-20 bg-slate-900 px-3 py-2 text-white shadow">
      <div className="flex items-center gap-2">
        <Truck className="h-6 w-6 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          {manifest ? (
            <div data-testid="driver-header">
              <p className="text-sm font-semibold text-slate-300">{fmtDate(lang)(manifest.date)}</p>
              <p className="break-words text-base font-bold leading-tight">
                {t(lang, 'truck')} <bdi>{manifest.truck.code}</bdi>
                {names ? (
                  <>
                    {' · '}
                    <bdi>{names}</bdi>
                  </>
                ) : null}
              </p>
              {manifest.truck.hired ? <p className="text-xs font-semibold text-amber-300">{t(lang, 'hiredTruck')}</p> : null}
            </div>
          ) : (
            <p className="text-base font-bold">{t(lang, 'appTitle')}</p>
          )}
        </div>
        <button type="button" onClick={onInfo} aria-label={t(lang, 'aboutLocation')} className="flex h-12 w-12 items-center justify-center rounded-lg hover:bg-slate-800">
          <Info className="h-6 w-6" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onLang}
          className="flex min-h-12 items-center gap-1 rounded-lg border border-slate-600 px-3 text-sm font-semibold"
          data-testid="lang-toggle"
          lang={lang === 'en' ? 'ar' : 'en'}
        >
          <Languages className="h-5 w-5" aria-hidden /> {LANG_TOGGLE[lang]}
        </button>
      </div>
      {manifest ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <SyncBadge lang={lang} waiting={waiting} online={online} />
          {staleAt ? <span className="text-xs text-slate-300">{t(lang, 'lastUpdated', { time: clockTime(new Date(staleAt).toISOString(), manifest.tz) })}</span> : null}
        </div>
      ) : null}
    </header>
  );
}

function TrackingBar({ lang, on, gps, offered, onStart, onStop }: { lang: Lang; on: boolean; gps: string; offered: boolean; onStart: () => void; onStop: () => void }) {
  if (on) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl bg-emerald-50 p-3" data-testid="tracking-on">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <MapPin className="h-5 w-5 text-emerald-700" aria-hidden />
          {gps === 'lost' ? t(lang, 'gpsLost') : gps === 'waiting' ? t(lang, 'waitingGps') : t(lang, 'timerOn')}
        </p>
        <button type="button" onClick={onStop} className="flex min-h-10 items-center gap-1 rounded-lg border border-slate-400 px-2 text-xs font-semibold">
          <Square className="h-4 w-4" aria-hidden /> {t(lang, 'stopTimer')}
        </button>
      </div>
    );
  }
  return (
    <>
      {gps === 'denied' || gps === 'unsupported' ? <p className="rounded-xl bg-amber-100 p-3 text-sm font-semibold">{t(lang, 'locationOff')}</p> : null}
      {offered ? (
        <button type="button" onClick={onStart} className="flex min-h-16 w-full items-center justify-center gap-2 rounded-xl bg-emerald-700 text-xl font-bold text-white" data-testid="start-deliveries">
          <Play className="h-7 w-7" aria-hidden /> {t(lang, 'startDeliveries')}
        </button>
      ) : null}
    </>
  );
}

function StatusChip({ lang, status }: { lang: Lang; status: OverlayLoad['status'] }) {
  return <span className={`inline-block rounded-full px-3 py-1 text-sm font-semibold ${STATUS_TONE[status] ?? 'bg-slate-200'}`}>{statusLabel(lang, status)}</span>;
}

function TripCard({
  lang,
  manifest,
  load,
  open,
  current,
  onToggle,
  onStop,
  onBack,
}: {
  lang: Lang;
  manifest: DriverManifest;
  load: OverlayLoad;
  open: boolean;
  current: boolean;
  onToggle: () => void;
  onStop: (s: OverlayStop) => void;
  onBack: () => void;
}) {
  const tel = telHref(manifest.settings.dispatcherPhone);
  const waiting = load.status === 'LOCKED' || load.status === 'LOADING';
  const done = load.stops.filter((s) => s.view.doneAt !== null).length;
  const nextKey = load.status === 'DISPATCHED' ? load.stops.find((s) => s.view.doneAt === null)?.key : undefined;
  return (
    <section className={`overflow-hidden rounded-xl bg-white shadow-sm ${current ? 'ring-2 ring-emerald-600' : ''}`} data-testid={`trip-${load.loadNo}`}>
      <button type="button" onClick={onToggle} className="flex min-h-16 w-full items-center gap-3 p-3 text-start" aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <p className="font-bold">{tripLine(lang, load)}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusChip lang={lang} status={load.status} />
            {load.status === 'DISPATCHED' || load.status === 'COMPLETED' ? <span className="text-sm font-semibold">{done}/{load.stops.length}</span> : null}
            {load.backAt ? <span className="text-sm">{t(lang, 'backAt', { time: clockTime(new Date(load.backAt).toISOString(), manifest.tz) })}</span> : null}
          </div>
        </div>
        <ChevronDown className={`h-6 w-6 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open ? (
        <div className="border-t">
          {waiting ? (
            <div className="space-y-3 bg-amber-50 p-3">
              <p className="text-sm">{t(lang, 'notDispatched')}</p>
              {tel ? (
                <a href={tel} className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-slate-900 font-semibold text-white">
                  <Phone className="h-5 w-5" aria-hidden /> {t(lang, 'callDispatcher')}
                </a>
              ) : null}
            </div>
          ) : null}
          <ol className="divide-y">
            {load.stops.map((s) => (
              <li key={s.key}>
                <button type="button" onClick={() => onStop(s)} className="flex min-h-16 w-full items-center gap-3 p-3 text-start" data-testid={`stop-${s.key}`}>
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg font-bold text-white ${s.view.doneAt !== null ? 'bg-slate-400' : 'bg-slate-900'}`}>{s.sequence}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-semibold leading-snug" dir="auto">
                      {stopTitle(s)}
                    </span>
                    <span className="block text-sm text-slate-600">
                      <Clock className="me-1 inline h-4 w-4" aria-hidden />
                      {hhmm(s.etaMin)} · {fmtHours(lang, s.hours, s.promised)} · <span className="whitespace-nowrap">{t(lang, 'casesLabel', { n: s.cases })}</span>
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {s.key === nextKey && s.view.arrivedAt === null ? <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white">{t(lang, 'next')}</span> : null}
                      <ResultChip lang={lang} stop={s} />
                      {load.status === 'COMPLETED' && !s.view.outcome ? <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold">{t(lang, 'noResult')}</span> : null}
                    </span>
                  </span>
                  {lang === 'ar' ? <ArrowLeft className="h-5 w-5 shrink-0 text-slate-400" aria-hidden /> : <ArrowRight className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />}
                </button>
              </li>
            ))}
          </ol>
          {load.status === 'DISPATCHED' && !load.back ? (
            <div className="border-t p-3">
              <button type="button" onClick={onBack} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 text-lg font-bold text-white" data-testid={`back-at-depot-${load.loadNo}`}>
                <Warehouse className="h-6 w-6" aria-hidden /> {t(lang, 'backAtDepot')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function BackAtDepotDialog({ lang, load, onYes, onNo }: { lang: Lang; load: OverlayLoad | null; onYes: (loadNo: number) => void; onNo: () => void }) {
  if (!load || load.status !== 'DISPATCHED' || load.back) return null;
  const missing = load.stops.filter((s) => s.view.doneAt === null).length;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 rounded-t-2xl border-t bg-white p-4 shadow-2xl" role="dialog" aria-modal="true" data-testid="back-at-depot-dialog">
      <p className="flex items-center gap-2 text-lg font-bold">
        <Warehouse className="h-6 w-6" aria-hidden /> {t(lang, 'confirmBackTitle')}
      </p>
      <p className="mt-1 text-sm">{t(lang, 'tripOf', { n: load.loadNo, m: Math.max(load.trips, load.loadNo) })}</p>
      {missing ? <p className="mt-2 rounded-lg bg-amber-50 p-2 text-sm font-semibold">{t(lang, 'stopsWithoutResult', { n: missing })}</p> : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onYes(load.loadNo)} className="min-h-14 rounded-xl bg-slate-900 text-lg font-bold text-white">
          {t(lang, 'backAtDepot')}
        </button>
        <button type="button" onClick={onNo} className="min-h-14 rounded-xl border border-slate-400 text-lg font-semibold">
          {t(lang, 'cancel')}
        </button>
      </div>
    </div>
  );
}

function LocationNotice({ lang, company, days, onOk }: { lang: Lang; company: string; days: number; onOk: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-3 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="loc-title">
      <div className="max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <p id="loc-title" className="flex items-center gap-2 text-lg font-bold">
          <MapPin className="h-6 w-6" aria-hidden /> {t(lang, 'locationTitle')}
        </p>
        <p className="mt-2 text-sm leading-relaxed">{t(lang, 'locationNotice', { company: company || 'RouteIQ', days })}</p>
        <button type="button" onClick={onOk} className="mt-4 min-h-12 w-full rounded-lg bg-slate-900 text-lg font-semibold text-white" data-testid="notice-ok">
          {t(lang, 'ok')}
        </button>
      </div>
    </div>
  );
}
