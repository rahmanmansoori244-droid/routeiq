'use client';

import 'maplibre-gl/dist/maplibre-gl.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Button } from '@/components/ui/button';
import { OSM_RASTER_STYLE, truckColor } from '@/lib/maps';
import { roadShapesCaption } from '@/lib/dispatch/map-caption';
import { GEO_LOADING, afterFailedFetch, autoRetryDue, createDrawGate, linesToDraw, type DrawGate, type GeoRow, type GeoState } from '@/lib/dispatch/plan-map-state';

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

/** One automatic second try this long after an answer with straight lines that a retry can fix. */
const AUTO_RETRY_MS = 5_000;

/**
 * Loads as road polylines (OSRM via the solver). While the shapes load only the depot and stops are
 * drawn; a load without its road shape is a straight dashed line, and the caption says how many and
 * why (lib/dispatch/map-caption.ts), with a Retry button when a retry can help. The decisions live in
 * lib/dispatch/plan-map-state.ts (unit-tested); drawing waits for the map through its draw gate.
 */
export function PlanMap({ runId, depot, loads, unserved, selectedLoadId }: Props) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const gate = useRef<DrawGate | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const lastFit = useRef<string | null>(null);
  const autoRetried = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // What the road shapes depend on: the run, its loads, and their stops' positions in order. An
  // answer for other content is never drawn (it shows as loading until the new answer is in).
  const shapeKey = useMemo(() => loads.map((l) => `${l.id}:${l.stops.map((s) => `${s.lat},${s.lng}`).join(';')}`).join('|'), [loads]);
  const contentKey = `${runId}|${shapeKey}`;
  const [shapes, setShapes] = useState<{ key: string; geo: GeoState }>({ key: contentKey, geo: GEO_LOADING });
  const geo = shapes.key === contentKey ? shapes.geo : GEO_LOADING;

  // New plan content: the one automatic retry is available again.
  useEffect(() => {
    autoRetried.current = false;
    setRetrying(false);
  }, [contentKey]);

  useEffect(() => {
    let alive = true;
    const key = contentKey;
    const ctrl = new AbortController();
    fetch(`/api/runs/${runId}/load-geometry`, { cache: 'no-store', signal: ctrl.signal })
      .then(async (r) => {
        const b = (await r.json().catch(() => null)) as { data?: unknown } | null;
        if (!r.ok || !Array.isArray(b?.data)) throw new Error(`load-geometry HTTP ${r.status}`);
        return b.data as GeoRow[];
      })
      .then((rows) => {
        if (alive) setShapes({ key, geo: { status: 'ready', rows } });
      })
      .catch(() => {
        if (alive) setShapes((prev) => ({ key, geo: afterFailedFetch(prev.key === key ? prev.geo : GEO_LOADING) }));
      })
      .finally(() => {
        if (alive) setRetrying(false);
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [runId, contentKey, attempt]);

  const retry = useCallback(() => {
    setRetrying(true);
    setAttempt((a) => a + 1);
  }, []);

  useEffect(() => {
    if (!autoRetryDue(geo, { retrying, alreadyRetried: autoRetried.current })) return;
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
    const g = createDrawGate(m);
    map.current = m;
    gate.current = g;
    lastFit.current = null;
    return () => {
      g.dispose();
      if (gate.current === g) gate.current = null;
      m.remove();
      map.current = null;
    };
  }, [depot.lat, depot.lng]);

  useEffect(() => {
    const m = map.current;
    const g = gate.current;
    if (!m || !g) return;
    const draw = () => {
      for (const mk of markers.current) mk.remove();
      markers.current = [];
      for (const id of m.getStyle().layers?.map((l) => l.id) ?? []) if (id.startsWith('load-')) m.removeLayer(id);
      for (const id of Object.keys(m.getStyle().sources ?? {})) if (id.startsWith('load-')) m.removeSource(id);
      const bounds = new maplibregl.LngLatBounds([depot.lng, depot.lat], [depot.lng, depot.lat]);
      markers.current.push(new maplibregl.Marker({ color: '#0f172a' }).setLngLat([depot.lng, depot.lat]).setPopup(new maplibregl.Popup().setText(depot.name)).addTo(m));
      const lines = new Map(linesToDraw(geo, loads, { lat: depot.lat, lng: depot.lng }).map((x) => [x.loadId, x] as const));
      for (const l of loads) {
        const dim = selectedLoadId && selectedLoadId !== l.id;
        const color = truckColor(l.colorIdx);
        const line = lines.get(l.id);
        if (line) {
          m.addSource(`load-${l.id}`, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line.coordinates } } });
          m.addLayer({
            id: `load-${l.id}`,
            type: 'line',
            source: `load-${l.id}`,
            paint: { 'line-color': color, 'line-width': dim ? 2 : 4, 'line-opacity': dim ? 0.25 : 0.85, ...(line.dashed ? { 'line-dasharray': [2, 1.5] } : {}) },
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
    // Through the gate, not the map's style-loaded check: that check is false while tiles load, and
    // a draw parked on the one-time 'load' event after it had fired never ran (createDrawGate).
    g.run(draw);
    return () => g.cancel();
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
