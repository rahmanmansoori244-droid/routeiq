'use client';

import 'maplibre-gl/dist/maplibre-gl.css';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { OSM_RASTER_STYLE, isMapPoint } from '@/lib/maps';
import { createDrawGate, type DrawGate } from '@/lib/dispatch/plan-map-state';
import type { MapPin, MapTruck } from '@/lib/sales-page/format';

interface Props {
  trucks: MapTruck[];
  pins: MapPin[];
  /** The view is fitted once per key (the route and its pins): a refresh that moves a truck never moves the map. */
  fitKey: string;
  /** The map cannot draw on this phone (no WebGL, or the context was lost): the card shows text instead. */
  onFail: () => void;
}

const TRUCK_COLOR = '#0f172a';
const STALE_COLOR = '#9ca3af';

/**
 * The salesman link's map (owner request 19 Oct 2026; MapLibre + OpenStreetMap like the plan map, loaded only when
 * shown): the route's trucks the server gives a position for (about 100 m, grey when the fix is old) and the
 * route's deliveries still to come, numbered as in the list, coloured by status, with no names. No trail, no
 * depot, no other route's customers. One finger scrolls the page; two move the map (cooperative gestures).
 * Markers are built with textContent only.
 */
export function SalesRouteMap({ trucks, pins, fitKey, onFail }: Props) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const gate = useRef<DrawGate | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const fitted = useRef<string | null>(null);
  const failRef = useRef(onFail);
  failRef.current = onFail;

  useEffect(() => {
    if (!el.current) return;
    const first = trucks[0] ?? pins[0] ?? null;
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({
        container: el.current,
        style: OSM_RASTER_STYLE as never,
        center: first ? [first.lng, first.lat] : [0, 0],
        zoom: 11,
        attributionControl: { compact: true },
        cooperativeGestures: true,
      });
    } catch {
      // No WebGL after all (the check passed but the context could not be made).
      failRef.current();
      return;
    }
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    const canvas = m.getCanvas();
    const lost = () => failRef.current();
    canvas.addEventListener('webglcontextlost', lost);
    const g = createDrawGate(m);
    map.current = m;
    gate.current = g;
    fitted.current = null;
    return () => {
      canvas.removeEventListener('webglcontextlost', lost);
      g.dispose();
      if (gate.current === g) gate.current = null;
      for (const mk of markers.current) mk.remove();
      markers.current = [];
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
      const bounds = new maplibregl.LngLatBounds();
      let any = false;
      for (const p of pins) {
        if (!isMapPoint(p.lat, p.lng)) continue;
        bounds.extend([p.lng, p.lat]);
        any = true;
        const dot = document.createElement('div');
        dot.dataset.testid = 'sales-map-pin';
        dot.style.cssText = `background:${p.color};color:#fff;border-radius:9999px;min-width:24px;height:24px;padding:0 5px;font:700 12px/24px system-ui;text-align:center;border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.45)`;
        dot.textContent = String(p.no);
        markers.current.push(new maplibregl.Marker({ element: dot }).setLngLat([p.lng, p.lat]).setPopup(new maplibregl.Popup({ offset: 12, closeButton: false }).setText(p.text)).addTo(m));
      }
      for (const t of trucks) {
        if (!isMapPoint(t.lat, t.lng)) continue;
        bounds.extend([t.lng, t.lat]);
        any = true;
        const box = document.createElement('div');
        box.dataset.testid = t.stale ? 'sales-map-truck-stale' : 'sales-map-truck';
        box.style.cssText = `display:flex;align-items:center;gap:3px;font:700 12px/18px system-ui;color:#fff;background:${t.stale ? STALE_COLOR : TRUCK_COLOR};border:2px solid #fff;border-radius:6px;padding:1px 6px;box-shadow:0 1px 3px rgba(0,0,0,.5);white-space:nowrap`;
        // A dotted circle for an old position (never shown as moving), an arrow while moving, a square when parked.
        box.textContent = `${t.stale ? '◌' : t.moving ? '➤' : '■'} ${t.label}`;
        markers.current.push(new maplibregl.Marker({ element: box }).setLngLat([t.lng, t.lat]).setPopup(new maplibregl.Popup({ offset: 14, closeButton: false }).setText(t.text)).addTo(m));
      }
      if (any && fitted.current !== fitKey) {
        // More room on the right: the zoom buttons sit there.
        m.fitBounds(bounds, { padding: { top: 40, bottom: 40, left: 36, right: 60 }, maxZoom: 14, duration: 0 });
        fitted.current = fitKey;
      }
    };
    g.run(draw);
    return () => g.cancel();
  }, [trucks, pins, fitKey]);

  return <div ref={el} className="h-[320px] w-full overflow-hidden rounded-md" data-testid="sales-route-map" />;
}
