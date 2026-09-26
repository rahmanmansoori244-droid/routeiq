'use client';

import 'maplibre-gl/dist/maplibre-gl.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Button } from '@/components/ui/button';
import { OSM_RASTER_STYLE, truckColor } from '@/lib/maps';
import type { EstimateReason } from '@/lib/dispatch/load-geometry';
import { roadShapesCaption, shouldAutoRetry } from '@/lib/dispatch/map-caption';

export interface PlanMapLoad {
  id: string;
  truckCode: string;
  loadNo: number;
  colorIdx: number;
  stops: { sequence: number; lat: number | null; lng: number | null; label: string }[];
}

interface Props {
  runId: string;
  depot: { lat: number; lng: number; name: string };
  loads: PlanMapLoad[];
  unserved: { lat: number | null; lng: number | null; label: string }[];
  selectedLoadId?: string | null;
}

interface GeoRow {
  loadId: string;
  estimated: boolean;
  coordinates: [number, number][];
  reason?: EstimateReason;
}

type GeoState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; rows: GeoRow[] };

/** One automatic second try this long after an answer with straight lines that a retry can fix. */
const AUTO_RETRY_MS = 5_000;

/**
 * Loads as road polylines (OSRM via the solver). While the shapes load only the depot and stops are
 * drawn; a load without its road shape is a straight dashed line, and the caption says how many and
 * why (lib/dispatch/map-caption.ts), with a Retry button when a retry can help.
 */
export function PlanMap({ runId, depot, loads, unserved, selectedLoadId }: Props) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const lastFit = useRef<string | null>(null);
  const autoRetried = useRef(false);
  const [geo, setGeo] = useState<GeoState>({ status: 'loading' });
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // What the road shapes depend on: which loads, and their stops' positions in order.
  const shapeKey = useMemo(() => loads.map((l) => `${l.id}:${l.stops.map((s) => `${s.lat},${s.lng}`).join(';')}`).join('|'), [loads]);

  // New plan content: start from "loading" with one automatic retry available again.
  useEffect(() => {
    autoRetried.current = false;
    setGeo((prev) => (prev.status === 'loading' ? prev : { status: 'loading' }));
    setRetrying(false);
  }, [runId, shapeKey]);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    fetch(`/api/runs/${runId}/load-geometry`, { cache: 'no-store', signal: ctrl.signal })
      .then(async (r) => {
        const b = (await r.json().catch(() => null)) as { data?: unknown } | null;
        if (!r.ok || !Array.isArray(b?.data)) throw new Error(`load-geometry HTTP ${r.status}`);
        return b.data as GeoRow[];
      })
      .then((rows) => {
        if (alive) setGeo({ status: 'ready', rows });
      })
      .catch(() => {
        // A failed retry keeps the shapes already shown; a failed first load says so.
        if (alive) setGeo((prev) => (prev.status === 'ready' ? prev : { status: 'failed' }));
      })
      .finally(() => {
        if (alive) setRetrying(false);
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [runId, shapeKey, attempt]);

  const retry = useCallback(() => {
    setRetrying(true);
    setAttempt((a) => a + 1);
  }, []);

  useEffect(() => {
    if (autoRetried.current || retrying || !shouldAutoRetry(geo)) return;
    const t = setTimeout(() => {
      autoRetried.current = true;
      retry();
    }, AUTO_RETRY_MS);
    return () => clearTimeout(t);
  }, [geo, retrying, retry]);

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, style: OSM_RASTER_STYLE as never, center: [depot.lng, depot.lat], zoom: 10 });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.current = m;
    lastFit.current = null;
    return () => {
      m.remove();
      map.current = null;
    };
  }, [depot.lat, depot.lng]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const draw = () => {
      for (const mk of markers.current) mk.remove();
      markers.current = [];
      for (const id of m.getStyle().layers?.map((l) => l.id) ?? []) if (id.startsWith('load-')) m.removeLayer(id);
      for (const id of Object.keys(m.getStyle().sources ?? {})) if (id.startsWith('load-')) m.removeSource(id);
      const bounds = new maplibregl.LngLatBounds([depot.lng, depot.lat], [depot.lng, depot.lat]);
      markers.current.push(new maplibregl.Marker({ color: '#0f172a' }).setLngLat([depot.lng, depot.lat]).setPopup(new maplibregl.Popup().setText(depot.name)).addTo(m));
      for (const l of loads) {
        const dim = selectedLoadId && selectedLoadId !== l.id;
        const color = truckColor(l.colorIdx);
        // While the shapes load: no connector lines (a straight line would look like the route).
        // After: the road shape, or a straight dashed line when the load has none.
        if (geo.status !== 'loading') {
          const row = geo.status === 'ready' ? geo.rows.find((x) => x.loadId === l.id) : undefined;
          const coords = row?.coordinates ?? [[depot.lng, depot.lat], ...l.stops.filter((s) => s.lat !== null && s.lng !== null).map((s) => [s.lng!, s.lat!] as [number, number]), [depot.lng, depot.lat]];
          const dashed = !row || row.estimated;
          m.addSource(`load-${l.id}`, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } });
          m.addLayer({
            id: `load-${l.id}`,
            type: 'line',
            source: `load-${l.id}`,
            paint: { 'line-color': color, 'line-width': dim ? 2 : 4, 'line-opacity': dim ? 0.25 : 0.85, ...(dashed ? { 'line-dasharray': [2, 1.5] } : {}) },
          });
        }
        for (const s of l.stops) {
          if (s.lat === null || s.lng === null) continue;
          bounds.extend([s.lng, s.lat]);
          const dot = document.createElement('div');
          dot.style.cssText = `background:${color};color:#fff;border-radius:9999px;min-width:20px;height:20px;padding:0 4px;font:600 11px/20px system-ui;text-align:center;border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.4);opacity:${dim ? 0.35 : 1}`;
          dot.textContent = String(s.sequence);
          markers.current.push(new maplibregl.Marker({ element: dot }).setLngLat([s.lng, s.lat]).setPopup(new maplibregl.Popup({ offset: 12 }).setText(`${l.truckCode} L${l.loadNo} #${s.sequence} ${s.label}`)).addTo(m));
        }
      }
      for (const u of unserved) {
        if (u.lat === null || u.lng === null) continue;
        bounds.extend([u.lng, u.lat]);
        markers.current.push(new maplibregl.Marker({ color: '#9ca3af', scale: 0.7 }).setLngLat([u.lng, u.lat]).setPopup(new maplibregl.Popup().setText(`UNSERVED: ${u.label}`)).addTo(m));
      }
      // Fit only when what is on the map changed (or a load was picked), not when the road shapes
      // arrive or a retry lands, so the dispatcher's zoom is kept.
      const fitKey = `${depot.lat},${depot.lng}|${shapeKey}|${unserved.map((u) => `${u.lat},${u.lng}`).join(';')}|${selectedLoadId ?? ''}`;
      if ((loads.length || unserved.length) && lastFit.current !== fitKey) {
        m.fitBounds(bounds, { padding: 40, maxZoom: 13, duration: 0 });
        lastFit.current = fitKey;
      }
    };
    if (m.isStyleLoaded()) draw();
    else m.once('load', draw);
    return () => {
      m.off('load', draw);
    };
  }, [geo, loads, unserved, selectedLoadId, depot.lat, depot.lng, depot.name, shapeKey]);

  const caption = roadShapesCaption(geo, { retrying });
  return (
    <div className="space-y-1">
      <div ref={el} className="h-[420px] w-full overflow-hidden rounded-md border" data-testid="plan-map" />
      <div className="flex flex-wrap items-center gap-2">
        <p className={`text-xs ${caption.warn ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`} data-testid="plan-map-caption">
          {caption.text}
        </p>
        {caption.canRetry ? (
          <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={retry}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
