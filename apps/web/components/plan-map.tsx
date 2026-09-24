'use client';

import 'maplibre-gl/dist/maplibre-gl.css';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { OSM_RASTER_STYLE, truckColor } from '@/lib/maps';

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

/** Loads as road polylines (OSRM via the solver; straight dashed lines when estimated). */
export function PlanMap({ runId, depot, loads, unserved, selectedLoadId }: Props) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [geo, setGeo] = useState<{ loadId: string; estimated: boolean; coordinates: [number, number][] }[] | null>(null);
  const [estimated, setEstimated] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/runs/${runId}/load-geometry`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((b) => {
        if (!alive) return;
        const g = (b?.data ?? []) as { loadId: string; estimated: boolean; coordinates: [number, number][] }[];
        setGeo(g);
        setEstimated(g.some((x) => x.estimated));
      })
      .catch(() => setGeo([]));
    return () => {
      alive = false;
    };
  }, [runId, loads.length]);

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, style: OSM_RASTER_STYLE as never, center: [depot.lng, depot.lat], zoom: 10 });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.current = m;
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
        const g = geo?.find((x) => x.loadId === l.id);
        const coords = g?.coordinates ?? [[depot.lng, depot.lat], ...l.stops.filter((s) => s.lat !== null).map((s) => [s.lng!, s.lat!] as [number, number]), [depot.lng, depot.lat]];
        m.addSource(`load-${l.id}`, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } });
        m.addLayer({
          id: `load-${l.id}`,
          type: 'line',
          source: `load-${l.id}`,
          paint: { 'line-color': color, 'line-width': dim ? 2 : 4, 'line-opacity': dim ? 0.25 : 0.85, ...(g && !g.estimated ? {} : { 'line-dasharray': [2, 1.5] }) },
        });
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
      if (loads.length || unserved.length) m.fitBounds(bounds, { padding: 40, maxZoom: 13, duration: 0 });
    };
    if (m.isStyleLoaded()) draw();
    else m.once('load', draw);
  }, [geo, loads, unserved, selectedLoadId, depot.lat, depot.lng, depot.name]);

  return (
    <div className="space-y-1">
      <div ref={el} className="h-[420px] w-full overflow-hidden rounded-md border" data-testid="plan-map" />
      <p className="text-xs text-muted-foreground">
        {geo === null ? 'Loading road shapes…' : estimated ? 'Dashed lines = straight-line estimate (road routing not available).' : 'Lines follow the road network (OSRM).'}
      </p>
    </div>
  );
}
