'use client';

/**
 * The truck's day as the page reads it (owner request 18 Oct 2026): GET /api/ivms/trucks/[id]/day for
 * the date shown, read again every minute while the truck can move on it (today, or a load of the date
 * still out: lib/ivms/truck-day.ts truckDayRefreshMs) and the tab is visible; a past day is read once.
 * Only the newest read changes the page: an answer for a date picked before is dropped.
 *
 * `error` is the failed read of the date picked only, and `loading` is on while nothing is known of it yet
 * (review of 18 Oct 2026): a failure of another date never shows under this one, and a failed read of a
 * date just picked stops the loading, so the page offers "Try again" (lib/ivms/truck-day.ts truckDayScreen)
 * instead of "Loading..." for good over the old date's day.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { truckDayRefreshMs, type TruckDayModel } from '@/lib/ivms/truck-day';
import { api } from '../../client-api';

export interface TruckDayState {
  /** The last day read (it may be another date's while the date picked is read, or when its read failed). */
  data: TruckDayModel | null;
  /** Why the last read of the date picked failed; null: it did not (or none was made yet). */
  error: string | null;
  /** A read of the date picked is in flight, or nothing of it is known yet. */
  loading: boolean;
  reload: () => void;
}

export function useTruckDay(truckId: string, date: string): TruckDayState {
  const [data, setData] = useState<TruckDayModel | null>(null);
  // The last failed read with the date it was for.
  const [failed, setFailed] = useState<{ date: string; text: string } | null>(null);
  const [inFlight, setInFlight] = useState(true);
  const newest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++newest.current;
    const r = await api<TruckDayModel>(`/api/ivms/trucks/${encodeURIComponent(truckId)}/day?date=${encodeURIComponent(date)}`);
    if (mine !== newest.current) return;
    if (r.ok && r.data) {
      setData(r.data);
      setFailed(null);
    } else {
      setFailed({ date, text: r.error ?? "The truck's day could not be read." });
    }
    setInFlight(false);
  }, [truckId, date]);

  useEffect(() => {
    setInFlight(true);
    void load();
  }, [load]);

  const refreshMs = data && data.date === date ? truckDayRefreshMs(data) : null;
  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
    }, refreshMs);
    return () => clearInterval(t);
  }, [refreshMs, load]);

  const reload = useCallback(() => {
    setInFlight(true);
    void load();
  }, [load]);
  const error = failed && failed.date === date ? failed.text : null;
  // Also loading in the render before the read of a date just picked has started.
  const loading = inFlight || (data?.date !== date && !error);
  return { data, error, loading, reload };
}
