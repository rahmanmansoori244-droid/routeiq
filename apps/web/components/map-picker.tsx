'use client';

import dynamic from 'next/dynamic';
import { MapPin } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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

export function MapPicker({ lat, lng, onChange, allowManualEntry = true, defaultCenter = MUSCAT, disabled = false, height = 320 }: MapPickerProps) {
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
              value={lat ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && e.target.value.trim() !== '') onChange(v, lng ?? defaultCenter[0]);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Longitude</Label>
            <Input
              inputMode="decimal"
              disabled={disabled}
              value={lng ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && e.target.value.trim() !== '') onChange(lat ?? defaultCenter[1], v);
              }}
            />
          </div>
        </div>
      ) : null}
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <MapPin className="h-3 w-3" /> Click the map to place the pin; drag it to adjust.
      </p>
    </div>
  );
}
