'use client';

import 'maplibre-gl/dist/maplibre-gl.css';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { Button } from '@/components/ui/button';
import { OSM_RASTER_STYLE, truckColor } from '@/lib/maps';
import { roadShapesCaption } from '@/lib/dispatch/map-caption';
import { GEO_LOADING, afterFailedFetch, answerIsStale, autoRetryDue, createDrawGate, drawnShapes, linesToDraw, type DrawGate, type GeoRow, type GeoState } from '@/lib/dispatch/plan-map-state';

export interface PlanMapLoad {
  id: string;
  truckCode: string;
  loadNo: number;
  colorIdx: number;
  stops: { sequence: number; lat: number | null; lng: number | null; label: string }[];
  /** Audit E1: the depot pin the load was planned from, when not the plan's depot (a moved depot). */
  origin?: { lat: number; lng: number } | null;
}

interface Props {
  runId: string;
  depot: { lat: number; lng: number; name: string };
  loads: PlanMapLoad[];
  unserved: { lat: number | null; lng: number | null; label: string }[];
  selectedLoadId?: string | null;
  /**
   * Called when the road shapes answer is for other content than the loads shown (the plan changed on
   * the server after it was loaded here): reload the plan. May return the reload; when it brings the
   * same loads, the map asks for the shapes once more.
   */
  onStale?: () => unknown;
}

/** One automatic second try this long after an answer with straight lines that a retry can fix. */
const AUTO_RETRY_MS = 5_000;

/**
 * Loads as road polylines (OSRM via the solver). While the shapes load only the depot and stops are
 * drawn; a load without its road shape is a straight dashed line, and the caption says how many and
 * why (lib/dispatch/map-caption.ts, counting the lines drawn), with a Retry button when a retry can
 * help. An answer for other content than the loads shown makes the map reload the plan (onStale). The
 * decisions live in lib/dispatch/plan-map-state.ts (unit-tested); drawing waits for the map's style
 * (not its tiles) through the draw gate.
 */
export function PlanMap({ runId, depot, loads, unserved, selectedLoadId, onStale }: Props) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const gate = useRef<DrawGate | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const lastFit = useRef<string | null>(null);
  const autoRetried = useRef(false);
  const staleHandled = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The plan content a plan reload asked for by catchUp() has finished for.
  const [reloadedFor, setReloadedFor] = useState<string | null>(null);

  // What the road shapes depend on: the run, its loads, and their stops' positions in order. An
  // answer asked for other content is never drawn (it shows as loading until the new answer is in),
  // and an answer whose rows are for other content than the loads shown (the server's plan moved on
  // after this screen loaded it) is caught by answerIsStale: those loads are drawn straight.
  const shapeKey = useMemo(() => loads.map((l) => `${l.id}:${l.origin ? `${l.origin.lat},${l.origin.lng}>` : ''}${l.stops.map((s) => `${s.lat},${s.lng}`).join(';')}`).join('|'), [loads]);
  const contentKey = `${runId}|${shapeKey}`;
  const [shapes, setShapes] = useState<{ key: string; geo: GeoState }>({ key: contentKey, geo: GEO_LOADING });
  const geo = shapes.key === contentKey ? shapes.geo : GEO_LOADING;
  const depotAt = useMemo(() => ({ lat: depot.lat, lng: depot.lng }), [depot.lat, depot.lng]);
  const stale = useMemo(() => answerIsStale(geo, loads, depotAt), [geo, loads, depotAt]);

  // New plan content: the one automatic retry (or plan reload) is available again.
  useEffect(() => {
    autoRetried.current = false;
    staleHandled.current = false;
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

  // The answer is for other content than the loads shown: this screen's plan is behind the server,
  // and asking for the shapes again would give the same answer. Reload the plan (new plan content
  // asks for its own shapes); when the reload brings the same loads, ask for the shapes once more.
  const catchUp = useCallback(() => {
    if (!onStale) return retry();
    setRetrying(true);
    const key = contentKey;
    void Promise.resolve()
      .then(onStale)
      .catch(() => null)
      .then(() => setReloadedFor(key));
  }, [onStale, contentKey, retry]);

  useEffect(() => {
    if (reloadedFor === null) return;
    setReloadedFor(null);
    if (reloadedFor === contentKey) retry();
  }, [reloadedFor, contentKey, retry]);

  // A stale answer: catch up once per plan content, by itself (the one automatic second request).
  useEffect(() => {
    if (!stale || staleHandled.current) return;
    staleHandled.current = true;
    autoRetried.current = true;
    catchUp();
  }, [stale, catchUp]);

  useEffect(() => {
    if (!autoRetryDue(geo, { retrying, alreadyRetried: autoRetried.current, stale })) return;
    const t = setTimeout(() => {
      autoRetried.current = true;
      retry();
    }, AUTO_RETRY_MS);
    return () => clearTimeout(t);
  }, [geo, retrying, stale, retry]);

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, style: OSM_RASTER_STYLE as never, center: [depot.lng, depot.lat], zoom: 10 });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    // Right after the map: ready once its style has loaded, whatever the base-map tiles do.
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
      // Audit E1: a load planned from a depot pin moved since starts and ends there: marked, and in view.
      const origins = new Map<string, { lat: number; lng: number }>();
      for (const l of loads) if (l.origin && (l.origin.lat !== depot.lat || l.origin.lng !== depot.lng)) origins.set(`${l.origin.lat},${l.origin.lng}`, l.origin);
      for (const o of origins.values()) {
        bounds.extend([o.lng, o.lat]);
        markers.current.push(new maplibregl.Marker({ color: '#64748b', scale: 0.8 }).setLngLat([o.lng, o.lat]).setPopup(new maplibregl.Popup().setText('Depot pin these loads were planned from (the depot moved since)')).addTo(m));
      }
      const lines = new Map(linesToDraw(geo, loads, depotAt).map((x) => [x.loadId, x] as const));
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
    // Through the gate: it waits for the map's style only. Not the map's 'load' event (it waits for
    // every tile of the first view, until the map is moved when one hangs) nor its style-loaded check
    // (false while tiles load; a draw parked on the one-time 'load' after it had fired never ran).
    g.run(draw);
    return () => g.cancel();
  }, [geo, loads, unserved, selectedLoadId, depot.lat, depot.lng, depot.name, depotAt, shapeKey]);

  // The caption counts the lines drawn (a load on screen the answer has no row for is straight).
  const caption = roadShapesCaption(drawnShapes(geo, loads, depotAt), { retrying });
  return (
    <div className="space-y-1">
      <div ref={el} className="h-[420px] w-full overflow-hidden rounded-md border" data-testid="plan-map" />
      <div className="flex flex-wrap items-center gap-2">
        <p className={`text-xs ${caption.warn ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`} data-testid="plan-map-caption">
          {caption.text}
        </p>
        {caption.canRetry ? (
          <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={stale ? catchUp : retry}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
