'use client';

import 'maplibre-gl/dist/maplibre-gl.css';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { OSM_RASTER_STYLE, isMapPoint } from '@/lib/maps';
import { createDrawGate, type DrawGate } from '@/lib/dispatch/plan-map-state';
import { RESULT_COLOR, type TruckDayModel } from '@/lib/ivms/truck-day';

const TRAIL_COLOR = '#2563EB';
const LIVE_COLOR = '#0f172a';

interface Props {
  model: Pick<TruckDayModel, 'depots' | 'stops' | 'trail' | 'live' | 'truck' | 'tz'>;
  /** The stop picked in the timeline: the map flies to it. */
  focus?: { lat: number; lng: number } | null;
}

/**
 * The map of a truck's day (owner request 18 Oct 2026; MapLibre + OpenStreetMap like the plan map): the
 * depot, the planned stops of the truck's loads numbered in sequence and coloured by result, the day's
 * GPS trail as a line (TIMES only, at most 2,000 points from the server), and the live position (today).
 * The view is fitted once per date and truck, so the 60 s refresh never moves the map under the user;
 * drawing waits for the map's style through the plan map's draw gate.
 */
export function TruckDayMap({ model, focus }: Props) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const gate = useRef<DrawGate | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const fitted = useRef<string | null>(null);
  // Where the map opens before the first fit: the depot, else the first stop with a pin.
  const first = model.depots[0] ?? model.stops.find((s) => s.lat !== null && s.lng !== null) ?? null;
  const center: [number, number] = first && first.lat !== null && first.lng !== null ? [first.lng, first.lat] : [0, 0];

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, style: OSM_RASTER_STYLE as never, center, zoom: 10 });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    const g = createDrawGate(m);
    map.current = m;
    gate.current = g;
    fitted.current = null;
    return () => {
      g.dispose();
      if (gate.current === g) gate.current = null;
      m.remove();
      map.current = null;
    };
    // The map is made once; the content below redraws on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = gate.current;
    if (!m || !g) return;
    const draw = () => {
      for (const mk of markers.current) mk.remove();
      markers.current = [];
      if (m.getLayer('truck-trail')) m.removeLayer('truck-trail');
      if (m.getSource('truck-trail')) m.removeSource('truck-trail');
      const bounds = new maplibregl.LngLatBounds();
      let any = false;
      const extend = (lng: number, lat: number) => {
        bounds.extend([lng, lat]);
        any = true;
      };
      // The trail first, so the markers are drawn on top of it.
      const pts = model.trail.points.filter(([lng, lat]) => isMapPoint(lat, lng));
      if (pts.length > 1) {
        m.addSource('truck-trail', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } } });
        m.addLayer({ id: 'truck-trail', type: 'line', source: 'truck-trail', paint: { 'line-color': TRAIL_COLOR, 'line-width': 3, 'line-opacity': 0.7 } });
        for (const [lng, lat] of pts) extend(lng, lat);
      }
      for (const d of model.depots) {
        if (!isMapPoint(d.lat, d.lng)) continue;
        extend(d.lng, d.lat);
        markers.current.push(new maplibregl.Marker({ color: '#0f172a' }).setLngLat([d.lng, d.lat]).setPopup(new maplibregl.Popup().setText(`Depot ${d.name}`)).addTo(m));
      }
      for (const s of model.stops) {
        if (s.lat === null || s.lng === null || !isMapPoint(s.lat, s.lng)) continue;
        extend(s.lng, s.lat);
        const dot = document.createElement('div');
        dot.dataset.testid = `truck-day-stop-${s.loadNo}-${s.sequence}`;
        dot.style.cssText = `background:${RESULT_COLOR[s.result]};color:#fff;border-radius:9999px;min-width:22px;height:22px;padding:0 4px;font:600 11px/22px system-ui;text-align:center;border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.4)`;
        dot.textContent = model.stops.some((x) => x.loadNo !== s.loadNo) ? `${s.loadNo}.${s.sequence}` : String(s.sequence);
        const text = `L${s.loadNo} stop ${s.sequence} · ${s.customerName}${s.resultText ? ` · ${s.resultText}` : ''}`;
        markers.current.push(new maplibregl.Marker({ element: dot }).setLngLat([s.lng, s.lat]).setPopup(new maplibregl.Popup({ offset: 12 }).setText(text)).addTo(m));
      }
      const v = model.live;
      if (v && isMapPoint(v.lat, v.lng)) {
        extend(v.lng, v.lat);
        const box = document.createElement('div');
        box.dataset.testid = v.stale ? 'truck-day-live-stale' : 'truck-day-live';
        box.style.cssText = `display:flex;align-items:center;gap:3px;font:700 11px/16px system-ui;color:#fff;background:${v.stale ? '#9ca3af' : LIVE_COLOR};border:2px solid #fff;border-radius:6px;padding:1px 5px;box-shadow:0 1px 3px rgba(0,0,0,.5);white-space:nowrap`;
        // A dotted circle for a stale position (never shown as moving), an arrow while moving, a square parked.
        box.textContent = `${v.stale ? '\u25CC' : v.moving ? '\u27A4' : '\u25A0'} ${model.truck.code}`;
        markers.current.push(new maplibregl.Marker({ element: box }).setLngLat([v.lng, v.lat]).setPopup(new maplibregl.Popup({ offset: 14 }).setText(v.text)).addTo(m));
      }
      // Fit once per truck and date: the 60 s refresh never moves the map under the user.
      const fitKey = `${model.truck.id}|${model.stops.map((s) => `${s.lat},${s.lng}`).join(';')}|${pts.length > 1}`;
      if (any && fitted.current !== fitKey) {
        m.fitBounds(bounds, { padding: 40, maxZoom: 14, duration: 0 });
        fitted.current = fitKey;
      }
    };
    g.run(draw);
    return () => g.cancel();
  }, [model]);

  useEffect(() => {
    const m = map.current;
    if (!m || !focus || !isMapPoint(focus.lat, focus.lng)) return;
    m.flyTo({ center: [focus.lng, focus.lat], zoom: Math.max(m.getZoom(), 14) });
  }, [focus]);

  return <div ref={el} className="h-[420px] w-full overflow-hidden rounded-md border" data-testid="truck-day-map" />;
}
