'use client';

// Static CSS import: MapLibre tiles do not render without it (see runs/[id]/map-tab.tsx).
import 'maplibre-gl/dist/maplibre-gl.css';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { OSM_RASTER_STYLE } from '@/lib/maps';

interface Props {
  /** current pin (null = no pin yet) */
  lat: number | null;
  lng: number | null;
  /** where to look when there is no pin (depot) */
  center: { lat: number; lng: number };
  onChange: (lat: number, lng: number) => void;
  height?: number;
}

/** Click to drop a pin, drag it to adjust. Token-free (OpenStreetMap raster tiles). */
export function PinMap({ lat, lng, center, onChange, height = 280 }: Props) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: OSM_RASTER_STYLE as never,
      center: [lng ?? center.lng, lat ?? center.lat],
      zoom: lat !== null ? 15 : 10,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.on('click', (e) => {
      place(e.lngLat.lat, e.lngLat.lng);
      cb.current(round(e.lngLat.lat), round(e.lngLat.lng));
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      marker.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (lat === null || lng === null || !map.current) return;
    place(lat, lng);
    map.current.easeTo({ center: [lng, lat], zoom: Math.max(map.current.getZoom(), 15) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  function place(la: number, ln: number) {
    if (!map.current) return;
    if (!marker.current) {
      marker.current = new maplibregl.Marker({ color: '#dc2626', draggable: true }).setLngLat([ln, la]).addTo(map.current);
      marker.current.on('dragend', () => {
        const p = marker.current!.getLngLat();
        cb.current(round(p.lat), round(p.lng));
      });
    } else {
      marker.current.setLngLat([ln, la]);
    }
  }

  return <div ref={el} style={{ height }} className="w-full overflow-hidden rounded-md border" data-testid="pin-map" />;
}

function round(v: number) {
  return Math.round(v * 1e6) / 1e6;
}
