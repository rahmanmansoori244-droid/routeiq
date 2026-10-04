'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DriverAction, DriverPos } from '@/lib/driver-link/manifest-types';
import {
  chooseCustomer as chooseInTracker,
  currentTrip,
  geofenceParams,
  initialTracker,
  manualArrive as manualInTracker,
  restoreTracker,
  step,
  trackStops,
  type Fix,
  type TrackEvent,
  type TrackerState,
} from '@/lib/delivery/geofence';
import { stopInProgress, type OverlayLoad } from '@/lib/driver-page/overlay';
import { newKey } from '@/lib/driver-page/queue';

/**
 * The automatic stop timer on the phone (owner request 4 Oct 2026, spec section 7.3). It reads the
 * browser's position while the page is open (watchPosition), runs the pure tracker (geofence.ts) on
 * every fix, a 5-second tick and every visibility change, and queues the arrivals and departures it
 * finds. Positions stay in memory: only the one attached to an event is sent.
 *
 * Honest about its limits: positions arrive only while the page is visible, so the timer may pause
 * when the screen locks or the driver is in Maps; the page says so. A screen wake lock is held while
 * at a stop where the browser allows it.
 */

export type GpsStatus = 'idle' | 'waiting' | 'ok' | 'lost' | 'denied' | 'unsupported';

export interface TrackerOptions {
  loads: OverlayLoad[] | null;
  depot: { lat: number; lng: number } | null;
  radiusM: number;
  /** Minutes since the delivery day's midnight (company time) of a moment. */
  nowMinOf: (now: number) => number;
  /** Queue an action (held = the trip is not dispatched yet: kept on the phone until it is). */
  enqueue: (action: DriverAction, held: boolean) => void;
  /** Tracking restarts by itself after a reload when it was on and location is already allowed. */
  resume: boolean;
  onTrackingChange: (on: boolean) => void;
  /**
   * The phone's queue has been read for these loads (default true). Until then the trip is not
   * started: an arrival still waiting to send would be missing from `loads`, the stop would not be
   * restored, and the tracker would find it again ("Arrived when?").
   */
  ready?: boolean;
}

export interface TrackerApi {
  on: boolean;
  gps: GpsStatus;
  state: TrackerState;
  trip: { loadNo: number; held: boolean } | null;
  whichCustomer: string[] | null;
  arrivedWhen: string | null;
  /** "Back at depot?" suggested for this trip (load number), null = none; cleared when the trip changes. */
  backSuggested: number | null;
  lastFix: () => Fix | null;
  start: () => void;
  stop: () => void;
  manualArrive: (key: string) => void;
  answerWhen: (key: string, minutesAgo: number | null) => void;
  chooseCustomer: (key: string) => void;
  dismissBack: () => void;
}

const TICK_MS = 5_000;
const LOST_MS = 90_000;

export function posOf(f: Fix | null): DriverPos | undefined {
  if (!f) return undefined;
  return { lat: f.lat, lng: f.lng, accuracyM: Math.round(f.accuracyM * 10) / 10, at: new Date(f.at).toISOString(), gpsAt: f.gpsAt ? new Date(f.gpsAt).toISOString() : null, speedMps: f.speedMps };
}

type WakeLockLike = { release: () => Promise<void> };

export function useTracker(opts: TrackerOptions): TrackerApi {
  const params = useMemo(() => geofenceParams(opts.radiusM), [opts.radiusM]);
  const [on, setOn] = useState(false);
  const [gps, setGps] = useState<GpsStatus>('idle');
  const [state, setState] = useState<TrackerState>(initialTracker());
  const [whichCustomer, setWhich] = useState<string[] | null>(null);
  const [arrivedWhen, setWhen] = useState<string | null>(null);
  const [backSuggested, setBack] = useState<number | null>(null);
  const stateRef = useRef<TrackerState>(state);
  const fixRef = useRef<Fix | null>(null);
  const watchRef = useRef<number | null>(null);
  const wakeRef = useRef<WakeLockLike | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const tripKey = useRef<string>('');

  const trip = useMemo(() => {
    if (!opts.loads) return null;
    return currentTrip(
      opts.loads.map((l) => ({ loadNo: l.loadNo, status: l.status, departMin: l.departMin, back: l.back })),
      { started: on, nowMin: opts.nowMinOf(Date.now()) },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.loads, on]);
  const tripRef = useRef(trip);
  tripRef.current = trip;

  const stops = useMemo(() => {
    if (!trip || !opts.loads) return [];
    const load = opts.loads.find((l) => l.loadNo === trip.loadNo);
    if (!load) return [];
    return trackStops(
      trip.loadNo,
      load.stops.map((s) => ({ key: s.key, sequence: s.sequence, lat: s.lat, lng: s.lng, doneAt: s.view.doneAt, visited: s.view.arrivedAt !== null || s.view.doneAt !== null })),
      opts.depot,
      params,
    );
  }, [trip, opts.loads, opts.depot, params]);
  const stopsRef = useRef(stops);
  stopsRef.current = stops;

  const setTracker = useCallback((s: TrackerState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  // A new trip (or the first manifest): the tracker starts from the server's and the phone's state -
  // once the phone's queue was read (an unsent arrival restores its stop with its own time).
  const ready = opts.ready !== false;
  useEffect(() => {
    const k = trip ? `${trip.loadNo}|${trip.held}` : '';
    if (k === tripKey.current || !opts.loads || !ready) return;
    tripKey.current = k;
    setTracker(trip ? restoreTracker(stopInProgress(opts.loads, trip.loadNo)) : initialTracker());
    setWhich(null);
    setWhen(null);
    // A "Back at depot?" raised for the trip before belongs to that trip only.
    setBack(null);
  }, [trip, opts.loads, ready, setTracker]);

  const emit = useCallback((events: TrackEvent[]) => {
    const held = !!tripRef.current?.held;
    for (const e of events) {
      const action: DriverAction =
        e.type === 'ARRIVED'
          ? {
              key: newKey(),
              type: 'ARRIVE',
              stop: e.key,
              at: new Date(e.at).toISOString(),
              mode: 'AUTO',
              pos: posOf(e.fix),
              ...(e.observed ? {} : { observed: false }),
              ...(e.chained ? { chained: true, from: e.from } : {}),
              ...(e.chosen ? { chosen: true } : {}),
            }
          : { key: newKey(), type: 'DEPART', stop: e.key, at: new Date(e.at).toISOString(), mode: 'AUTO', pos: posOf(e.fix), reason: e.reason, ...(e.gap ? { gap: true } : {}) };
      optsRef.current.enqueue(action, held);
    }
  }, []);

  const run = useCallback(() => {
    const now = Date.now();
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    const r = step(stateRef.current, { now, fix: fixRef.current, visible, stops: stopsRef.current, depot: optsRef.current.depot }, params);
    setTracker(r.state);
    if (r.events.length) emit(r.events);
    for (const p of r.prompts) {
      if (p.kind === 'WHICH_CUSTOMER') setWhich(p.keys);
      else if (p.kind === 'ARRIVED_WHEN') setWhen(p.key);
      else if (tripRef.current && !tripRef.current.held) setBack(tripRef.current.loadNo);
    }
    if (r.state.phase === 'SEEKING' && !r.state.ambiguous) setWhich(null);
    const f = fixRef.current;
    if (watchRef.current !== null) setGps((g) => (g === 'denied' ? g : !f ? 'waiting' : now - f.at > LOST_MS ? 'lost' : 'ok'));
  }, [params, emit, setTracker]);

  // Wake lock while at a stop (tolerate refusal and browsers without it).
  useEffect(() => {
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLockLike> } }) : null;
    const want = on && state.phase === 'AT_STOP';
    const take = () => {
      if (!want || wakeRef.current || !nav?.wakeLock || document.visibilityState !== 'visible') return;
      nav.wakeLock
        .request('screen')
        .then((l) => {
          wakeRef.current = l;
        })
        .catch(() => {});
    };
    if (want) take();
    else if (wakeRef.current) {
      wakeRef.current.release().catch(() => {});
      wakeRef.current = null;
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        wakeRef.current = null; // the browser released it while hidden
        take();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [on, state.phase]);

  const stop = useCallback(() => {
    if (watchRef.current !== null && typeof navigator !== 'undefined') navigator.geolocation?.clearWatch(watchRef.current);
    watchRef.current = null;
    setOn(false);
    setGps('idle');
    optsRef.current.onTrackingChange(false);
  }, []);

  const start = useCallback(() => {
    const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
    if (!geo) {
      setGps('unsupported');
      return;
    }
    if (watchRef.current !== null) return;
    setGps('waiting');
    try {
      watchRef.current = geo.watchPosition(
        (p) => {
          fixRef.current = { at: Date.now(), gpsAt: Number.isFinite(p.timestamp) ? p.timestamp : null, lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy, speedMps: p.coords.speed ?? null };
          setGps('ok');
          run();
        },
        (e) => {
          if (e.code === 1) {
            setGps('denied');
            if (watchRef.current !== null) geo.clearWatch(watchRef.current);
            watchRef.current = null;
            setOn(false);
            optsRef.current.onTrackingChange(false);
          }
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 30_000 },
      );
      setOn(true);
      optsRef.current.onTrackingChange(true);
    } catch {
      setGps('unsupported');
    }
  }, [run]);

  // The tick and visibility changes (the tracker records gaps; a page coming back may ask "when?").
  useEffect(() => {
    if (!on) return;
    const t = setInterval(run, TICK_MS);
    const onVis = () => run();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [on, run]);

  // Restart without a tap after a reload when location is already allowed.
  useEffect(() => {
    if (!opts.resume || on) return;
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
    if (!perms?.query) return;
    perms
      .query({ name: 'geolocation' as PermissionName })
      .then((s) => {
        if (s.state === 'granted') start();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.resume]);

  useEffect(
    () => () => {
      if (watchRef.current !== null && typeof navigator !== 'undefined') navigator.geolocation?.clearWatch(watchRef.current);
      wakeRef.current?.release().catch(() => {});
    },
    [],
  );

  const currentFix = useCallback(() => {
    const f = fixRef.current;
    return f && Date.now() - f.at <= params.maxFixAgeMs ? f : null;
  }, [params]);

  const manualArrive = useCallback(
    (key: string) => {
      const now = Date.now();
      setTracker(manualInTracker(stateRef.current, key, now));
      const held = !!tripRef.current?.held && tripRef.current.loadNo === Number(key.split(':')[0]);
      optsRef.current.enqueue({ key: newKey(), type: 'ARRIVE', stop: key, at: new Date(now).toISOString(), mode: 'MANUAL', pos: posOf(currentFix()) }, held);
    },
    [currentFix, setTracker],
  );

  const answerWhen = useCallback(
    (key: string, minutesAgo: number | null) => {
      setWhen(null);
      if (minutesAgo === null) return;
      const at = Date.now() - minutesAgo * 60_000;
      const held = !!tripRef.current?.held;
      optsRef.current.enqueue({ key: newKey(), type: 'ARRIVE', stop: key, at: new Date(at).toISOString(), mode: 'MANUAL', when: true, pos: posOf(currentFix()) }, held);
    },
    [currentFix],
  );

  const chooseCustomer = useCallback(
    (key: string) => {
      const r = chooseInTracker(stateRef.current, key);
      setTracker(r.state);
      setWhich(null);
      emit(r.events);
    },
    [emit, setTracker],
  );

  return {
    on,
    gps,
    state,
    trip,
    whichCustomer,
    arrivedWhen,
    backSuggested,
    lastFix: () => fixRef.current,
    start,
    stop,
    manualArrive,
    answerWhen,
    chooseCustomer,
    dismissBack: () => setBack(null),
  };
}
