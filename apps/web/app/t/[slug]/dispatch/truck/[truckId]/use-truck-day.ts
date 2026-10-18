'use client';

/**
 * The truck's day as the page reads it (owner request 18 Oct 2026): GET /api/ivms/trucks/[id]/day for
 * the date shown, read again every minute while the truck can move on it (today, or a load of the date
 * still out: lib/ivms/truck-day.ts truckDayRefreshMs) and the tab is visible; a past day is read once.
 * Only the newest read changes the page: an answer for a date picked before is dropped.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { truckDayRefreshMs, type TruckDayModel } from '@/lib/ivms/truck-day';
import { api } from '../../client-api';

export interface TruckDayState {
  /** The last day read (it may be another date's while `loading`). */
  data: TruckDayModel | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useTruckDay(truckId: string, date: string): TruckDayState {
  const [data, setData] = useState<TruckDayModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const newest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++newest.current;
    const r = await api<TruckDayModel>(`/api/ivms/trucks/${encodeURIComponent(truckId)}/day?date=${encodeURIComponent(date)}`);
    if (mine !== newest.current) return;
    if (r.ok && r.data) {
      setData(r.data);
      setError(null);
    } else {
      setError(r.error ?? "The truck's day could not be read.");
    }
    setLoading(false);
  }, [truckId, date]);

  useEffect(() => {
    setLoading(true);
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
    setLoading(true);
    void load();
  }, [load]);
  return { data, error, loading, reload };
}
