'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin, MapPinOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface MapPickerProps {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
  mapboxToken: string;
  /** When map can't load (no token or fetch error), still let the user type coords. */
  allowManualEntry?: boolean;
  /** Default center if no lat/lng is provided. Defaults to Muscat. */
  defaultCenter?: [number, number];
  disabled?: boolean;
  height?: number;
}

const MUSCAT: [number, number] = [58.4059, 23.5859];

export function MapPicker({
  lat,
  lng,
  onChange,
  mapboxToken,
  allowManualEntry = true,
  defaultCenter = MUSCAT,
  disabled = false,
  height = 320,
}: MapPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<unknown>(null);
  const markerRef = useRef<unknown>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  // Initialise map once.
  useEffect(() => {
    if (!mapboxToken) {
      setMapError('MAPBOX_TOKEN not set in env. Enter coordinates manually below.');
      return;
    }
    if (!containerRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const mb = await import('mapbox-gl');
        await import('mapbox-gl/dist/mapbox-gl.css');
        if (cancelled || !containerRef.current) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mb as any).default.accessToken = mapboxToken;
        const center: [number, number] = lat !== null && lng !== null ? [lng, lat] : defaultCenter;
        const map = new mb.Map({
          container: containerRef.current,
          style: 'mapbox://styles/mapbox/light-v11',
          center,
          zoom: lat !== null ? 13 : 9,
        });
        mapRef.current = map;
        const marker = new mb.Marker({ draggable: !disabled, color: '#2563eb' })
          .setLngLat(center)
          .addTo(map);
        markerRef.current = marker;
        marker.on('dragend', () => {
          const ll = marker.getLngLat();
          onChange(Number(ll.lat.toFixed(6)), Number(ll.lng.toFixed(6)));
        });
        map.on('click', (e) => {
          if (disabled) return;
          const { lng: nLng, lat: nLat } = e.lngLat;
          marker.setLngLat([nLng, nLat]);
          onChange(Number(nLat.toFixed(6)), Number(nLng.toFixed(6)));
        });
        map.on('load', () => setMapReady(true));
      } catch (err) {
        setMapError((err as Error).message ?? 'Failed to load map.');
      }
    })();
    return () => {
      cancelled = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = mapRef.current as any;
      if (m?.remove) m.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapboxToken, disabled]);

  // Sync marker when caller-controlled lat/lng changes (e.g. manual edits).
  useEffect(() => {
    if (lat === null || lng === null) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const marker = markerRef.current as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = mapRef.current as any;
    if (marker?.setLngLat) marker.setLngLat([lng, lat]);
    if (map?.easeTo) map.easeTo({ center: [lng, lat], duration: 200 });
  }, [lat, lng]);

  function handleManual(field: 'lat' | 'lng', value: string) {
    const next = { lat: lat ?? 0, lng: lng ?? 0 };
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    next[field] = n;
    onChange(next.lat, next.lng);
  }

  return (
    <div className="space-y-3">
      <div className="relative rounded-md border" style={{ height }}>
        <div ref={containerRef} className="absolute inset-0 rounded-md" />
        {!mapReady && !mapError ? (
          <div className="absolute inset-0 grid place-items-center bg-muted/40 text-sm text-muted-foreground">
            Loading map…
          </div>
        ) : null}
        {mapError ? (
          <div className="absolute inset-0 grid place-items-center bg-muted/40 p-6 text-center text-sm text-muted-foreground">
            <div>
              <MapPinOff className="mx-auto mb-2 h-6 w-6" />
              <p>{mapError}</p>
              {allowManualEntry ? <p className="mt-1 text-xs">Type coordinates manually below.</p> : null}
            </div>
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Latitude</Label>
          <Input
            type="number"
            step="0.000001"
            value={lat ?? ''}
            disabled={disabled}
            onChange={(e) => handleManual('lat', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Longitude</Label>
          <Input
            type="number"
            step="0.000001"
            value={lng ?? ''}
            disabled={disabled}
            onChange={(e) => handleManual('lng', e.target.value)}
          />
        </div>
      </div>
      {!mapError ? (
        <p className="text-xs text-muted-foreground">
          <MapPin className="me-1 inline h-3 w-3" />
          Click the map to drop the pin, or drag it. Coordinates also editable directly.
        </p>
      ) : null}
    </div>
  );
}
