/**
 * Live dispatcher map (Client Component).
 *
 * - Polls /api/runs/[id]/live every 5s.
 * - Renders truck positions on a Mapbox map (when NEXT_PUBLIC_MAPBOX_TOKEN
 *   is set; otherwise falls back to a tabular list and a "no map" notice).
 * - Color codes by status: ON_PLAN (green), BEHIND (amber), AHEAD (blue),
 *   OFFLINE (gray).
 * - Sidebar lists each truck with stop progress + distance to next stop.
 */
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CheckCircle2, MapPin, Wifi, WifiOff } from 'lucide-react';
import { defaultMapStyle, TRUCK_COLORS } from '@/lib/maps';

const POLL_MS = 5_000;
const OFFLINE_AFTER_MIN = 10;
// Color picks come from lib/maps to stay consistent with the run detail map.

interface TruckLive {
  truckId: string;
  truckCode: string;
  shiftId: string | null;
  lastTs: string | null;
  lat: number | null;
  lng: number | null;
  speedKmh: number | null;
  headingDeg: number | null;
  totalStops: number;
  doneStops: number;
  nextStop: {
    assignmentId: string;
    sequence: number;
    customerCode: string;
    customerName: string;
    lat: number | null;
    lng: number | null;
    plannedArrivalMin: number;
  } | null;
  distanceToNextKm: number | null;
  status: 'ON_PLAN' | 'BEHIND' | 'AHEAD' | 'OFFLINE';
}

interface LiveResponse {
  run: { id: string; runDate: string; depotName: string; depotLat: number; depotLng: number };
  trucks: TruckLive[];
}

export function LiveDispatcher({
  runId,
  depot,
  mapboxToken,
}: {
  runId: string;
  depot: { name: string; lat: number; lng: number };
  mapboxToken: string;
}) {
  const mapContainer = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

  // Init map once. MapLibre + OSM tiles when no Mapbox token; upgrades to
  // Mapbox vector tiles automatically if one is set.
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const style = defaultMapStyle(mapboxToken);
    mapRef.current = new maplibregl.Map({
      container: mapContainer.current,
      style: style as never,
      center: [depot.lng, depot.lat],
      zoom: 11,
    });
    new maplibregl.Marker({ color: '#0f172a' })
      .setLngLat([depot.lng, depot.lat])
      .setPopup(new maplibregl.Popup().setText(`Depot: ${depot.name}`))
      .addTo(mapRef.current);
    return () => {
      // Clear truck markers explicitly — map.remove() does NOT detach
      // externally-added Markers, so without this they'd linger as detached
      // DOM nodes if the component remounted (e.g. route switch + back).
      for (const m of markersRef.current.values()) m.remove();
      markersRef.current.clear();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [mapboxToken, depot.lat, depot.lng, depot.name]);

  // Poll.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(`/api/runs/${runId}/live`, { cache: 'no-store' });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.data) {
          setError(typeof json.error === 'string' ? json.error : 'Could not load live data.');
        } else {
          setData(json.data);
          setError(null);
          setLastFetchedAt(new Date());
        }
      } catch {
        if (!cancelled) setError('Network error.');
      }
    }
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId]);

  // Update markers when data changes.
  useEffect(() => {
    if (!mapRef.current || !data) return;
    const map = mapRef.current;
    const liveTruckIds = new Set<string>();
    data.trucks.forEach((t, idx) => {
      if (t.lat == null || t.lng == null) return;
      liveTruckIds.add(t.truckId);
      const color = colorFor(t.status, idx);
      let m = markersRef.current.get(t.truckId);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'truck-marker';
        el.style.cssText = `width:28px;height:28px;border-radius:50%;border:2px solid white;display:flex;align-items:center;justify-content:center;font:600 11px sans-serif;color:white;background:${color};box-shadow:0 1px 4px rgba(0,0,0,.3);`;
        el.textContent = t.truckCode.slice(-3);
        m = new maplibregl.Marker({ element: el }).setLngLat([t.lng, t.lat]).addTo(map);
        m.setPopup(
          new maplibregl.Popup({ offset: 18 }).setText(
            `${t.truckCode} · ${t.doneStops}/${t.totalStops} delivered`,
          ),
        );
        markersRef.current.set(t.truckId, m);
      } else {
        m.setLngLat([t.lng, t.lat]);
        const el = m.getElement();
        if (el.style.background !== color) el.style.background = color;
      }
    });
    // Remove markers for trucks that aren't in latest data.
    for (const [tid, m] of markersRef.current) {
      if (!liveTruckIds.has(tid)) {
        m.remove();
        markersRef.current.delete(tid);
      }
    }
  }, [data]);

  const sortedTrucks = useMemo(() => {
    if (!data) return [];
    return [...data.trucks].sort((a, b) => a.truckCode.localeCompare(b.truckCode));
  }, [data]);

  return (
    <div className="grid h-[calc(100vh-12rem)] grid-cols-1 gap-3 lg:grid-cols-3">
      {/* Truck list / sidebar */}
      <aside className="space-y-2 overflow-y-auto rounded-lg border bg-card p-3 lg:order-2 lg:col-span-1">
        <div className="flex items-center justify-between border-b pb-2 text-xs text-muted-foreground">
          <span>
            {sortedTrucks.length} trucks · {lastFetchedAt ? `updated ${secondsAgo(lastFetchedAt)}s ago` : 'fetching…'}
          </span>
          {error && <span className="text-red-600">{error}</span>}
        </div>
        {sortedTrucks.length === 0 && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            No trucks have started yet. Once drivers sign into <code>/driver</code> and start their
            shifts, their positions will appear here.
          </div>
        )}
        {sortedTrucks.map((t, idx) => {
          const color = colorFor(t.status, idx);
          return (
            <div key={t.truckId} className="rounded-md border bg-background p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full" style={{ background: color }} />
                  <span className="font-semibold">{t.truckCode}</span>
                  {t.status === 'OFFLINE' ? (
                    <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Wifi className="h-3.5 w-3.5 text-emerald-600" />
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {t.doneStops}/{t.totalStops} done
                </span>
              </div>
              {t.nextStop ? (
                <div className="mt-2 text-xs">
                  <div className="text-muted-foreground">Next stop · seq {t.nextStop.sequence}</div>
                  <div className="font-medium">{t.nextStop.customerName}</div>
                  {t.distanceToNextKm != null && (
                    <div className="text-muted-foreground">
                      <MapPin className="mr-1 inline h-3 w-3" />
                      {t.distanceToNextKm.toFixed(1)} km away
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700">
                  <CheckCircle2 className="h-3.5 w-3.5" /> All stops delivered.
                </div>
              )}
              {t.lastTs ? (
                <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  ping {minutesAgo(t.lastTs)} min ago{t.speedKmh != null ? ` · ${t.speedKmh.toFixed(0)} km/h` : ''}
                </div>
              ) : (
                <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">no ping yet</div>
              )}
            </div>
          );
        })}
      </aside>

      {/* Map: MapLibre + OSM tiles by default; upgrades to Mapbox if a token is set. */}
      <div className="overflow-hidden rounded-lg border bg-card lg:order-1 lg:col-span-2">
        <div ref={mapContainer} className="h-full w-full" />
      </div>
    </div>
  );
}

function colorFor(status: TruckLive['status'], idx: number): string {
  if (status === 'OFFLINE') return '#94a3b8';
  if (status === 'BEHIND') return '#d97706';
  if (status === 'AHEAD') return '#2563eb';
  return TRUCK_COLORS[idx % TRUCK_COLORS.length] ?? '#2563eb';
}

function secondsAgo(d: Date) {
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
}

function minutesAgo(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}
