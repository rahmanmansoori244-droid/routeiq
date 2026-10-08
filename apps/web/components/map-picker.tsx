'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { MapPin } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { typedCoordinate } from '@/lib/maps';

// Token-free MapLibre + OpenStreetMap pin map (the old mapbox-gl picker refused to render
// without MAPBOX_TOKEN, which production never had). Same props as before.
const PinMap = dynamic(() => import('./pin-map').then((m) => m.PinMap), { ssr: false });

interface MapPickerProps {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
  /** kept for call-site compatibility; the map no longer needs a token */
  mapboxToken?: string;
  /** Also allow typing coordinates. */
  allowManualEntry?: boolean;
  /** Default centre if no lat/lng is provided: [lng, lat]. Defaults to Muscat. */
  defaultCenter?: [number, number];
  disabled?: boolean;
  height?: number;
}

const MUSCAT: [number, number] = [58.4059, 23.5859];

const shown = (v: number | null) => (v === null ? '' : String(v));

/** Why the typed text moves no pin; null while it is a coordinate or still being typed ("", "-", "23."). */
function coordinateNote(text: string, limit: 90 | 180, name: string): string | null {
  const t = text.trim();
  if (t === '' || t === '-' || typedCoordinate(t, limit) !== null) return null;
  if (t.endsWith('.') && typedCoordinate(t.slice(0, -1), limit) !== null) return null;
  return `${name} is a number from -${limit} to ${limit}: the pin stays where it is.`;
}

export function MapPicker({ lat, lng, onChange, allowManualEntry = true, defaultCenter = MUSCAT, disabled = false, height = 320 }: MapPickerProps) {
  // Each field keeps the text as typed (review of 8 Oct 2026, ui-rest-3). Bound to the number, "23."
  // showed as "23" (the dot vanished), the next digit made a latitude of 236, and MapLibre threw for
  // it and took the whole page down. The pin moves only for a complete coordinate in range
  // (typedCoordinate); a point set from outside (the map, the form) shows in the fields.
  const [latText, setLatText] = useState(() => shown(lat));
  const [lngText, setLngText] = useState(() => shown(lng));
  useEffect(() => {
    // Not when the text already says it ("23.50" is 23.5): the text being typed stays.
    setLatText((t) => (lat !== null && typedCoordinate(t, 90) === lat ? t : shown(lat)));
  }, [lat]);
  useEffect(() => {
    setLngText((t) => (lng !== null && typedCoordinate(t, 180) === lng ? t : shown(lng)));
  }, [lng]);
  const latNote = coordinateNote(latText, 90, 'Latitude');
  const lngNote = coordinateNote(lngText, 180, 'Longitude');

  return (
    <div className="space-y-2">
      <div className={disabled ? 'pointer-events-none opacity-70' : ''}>
        <PinMap lat={lat} lng={lng} center={{ lat: defaultCenter[1], lng: defaultCenter[0] }} onChange={onChange} height={height} />
      </div>
      {allowManualEntry ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Latitude</Label>
            <Input
              inputMode="decimal"
              disabled={disabled}
              value={latText}
              data-testid="map-picker-lat"
              onChange={(e) => {
                setLatText(e.target.value);
                const v = typedCoordinate(e.target.value, 90);
                if (v !== null) onChange(v, lng ?? defaultCenter[0]);
              }}
              // Left as text that is no coordinate: the field shows the pin's latitude again.
              onBlur={() => setLatText((t) => (typedCoordinate(t, 90) === null ? shown(lat) : t))}
            />
            {latNote ? <p className="text-xs text-destructive">{latNote}</p> : null}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Longitude</Label>
            <Input
              inputMode="decimal"
              disabled={disabled}
              value={lngText}
              data-testid="map-picker-lng"
              onChange={(e) => {
                setLngText(e.target.value);
                const v = typedCoordinate(e.target.value, 180);
                if (v !== null) onChange(lat ?? defaultCenter[1], v);
              }}
              onBlur={() => setLngText((t) => (typedCoordinate(t, 180) === null ? shown(lng) : t))}
            />
            {lngNote ? <p className="text-xs text-destructive">{lngNote}</p> : null}
          </div>
        </div>
      ) : null}
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <MapPin className="h-3 w-3" /> Click the map to place the pin; drag it to adjust.
      </p>
    </div>
  );
}
