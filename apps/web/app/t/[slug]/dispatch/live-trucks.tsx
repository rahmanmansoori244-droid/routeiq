'use client';

/**
 * Live trucks on the day screen's map (IVMS live link, 16 Oct 2026, design section 8.2): the GPS
 * positions of the trucks with a load out, read every 60 s while the tab is visible, and a "Live trucks"
 * switch remembered on this browser. Used by PlanView only when the company's GPS tracking is MAP or
 * TIMES (the page says so) and the plan is of today or yesterday with a load out: otherwise nothing is
 * fetched and nothing is shown.
 */
import { useCallback, useEffect, useState } from 'react';
import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { liveMapCaption, type DayVehiclesResponse } from '@/lib/ivms/live-map';
import { api } from './client-api';

const KEY = 'routeiq.liveTrucks';

function readOn(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeOn(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Private window or blocked storage: the switch works for this page only.
  }
}

/** The live positions of a plan's trucks while `enabled`; null until read (or while switched off). */
export function useLiveTrucks(runId: string, enabled: boolean): { data: DayVehiclesResponse | null; on: boolean; setOn: (on: boolean) => void } {
  const [data, setData] = useState<DayVehiclesResponse | null>(null);
  const [on, setOnState] = useState(true);
  useEffect(() => setOnState(readOn()), []);
  const setOn = useCallback((v: boolean) => {
    writeOn(v);
    setOnState(v);
  }, []);
  const load = useCallback(async () => {
    const r = await api<DayVehiclesResponse>(`/api/runs/${runId}/vehicles`);
    if (r.ok && r.data) setData(r.data);
  }, [runId]);
  useEffect(() => {
    if (!enabled || !on) {
      setData(null);
      return;
    }
    void load();
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => clearInterval(t);
  }, [enabled, on, load]);
  return { data, on, setOn };
}

/** The switch and the line above the map: when the positions are from, how many trucks, which are stale. */
export function LiveTrucksBar({ data, on, setOn, tz }: { data: DayVehiclesResponse | null; on: boolean; setOn: (on: boolean) => void; tz: string }) {
  const caption = on && data ? liveMapCaption(data, new Date(), tz) : null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="live-trucks-bar">
      <Button type="button" variant={on ? 'default' : 'outline'} size="sm" className="h-7 px-2 text-xs" onClick={() => setOn(!on)} aria-pressed={on}>
        <MapPin className="mr-1 h-3.5 w-3.5" /> Live trucks {on ? 'on' : 'off'}
      </Button>
      {caption ? <p className={`text-xs ${caption.warn ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>{caption.text}</p> : null}
    </div>
  );
}
