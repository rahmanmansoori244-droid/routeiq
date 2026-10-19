'use client';

import dynamic from 'next/dynamic';
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Map as MapIcon, MapPin } from 'lucide-react';
import type { SalesRouteView } from '@/lib/sales-link/view-types';
import { mapModel, mapsHref, UI, webglAvailable, type MapTruck } from '@/lib/sales-page/format';

// MapLibre is large: loaded only when the map is shown, never on the server.
const SalesRouteMap = dynamic(() => import('@/components/sales-route-map').then((m) => m.SalesRouteMap), {
  ssr: false,
  loading: () => <div className="flex h-[320px] w-full items-center justify-center rounded-md bg-slate-100 text-sm text-slate-500">Loading the map…</div>,
});

/** A map that throws (its code did not load, a MapLibre error) shows the text fallback, never a broken page. */
class MapBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    // The fallback says what the map would show; nothing to report.
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Without WebGL (older phones, some in-app browsers): the truck positions as text, each with an Open in Maps link. */
export function MapFallback({ trucks, pins }: { trucks: MapTruck[]; pins: number }) {
  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm" data-testid="map-fallback">
      <p className="text-slate-700">{UI.noMap}</p>
      {trucks.map((t) => (
        <p key={t.key} className="flex flex-wrap items-center gap-2">
          <MapPin className="h-4 w-4 text-slate-600" aria-hidden />
          <span className="font-medium">{t.text}</span>
          <a href={mapsHref(t.lat, t.lng)} target="_blank" rel="noopener noreferrer" className="font-semibold text-sky-800 underline">
            {UI.openInMaps}
          </a>
        </p>
      ))}
      {pins ? <p className="text-slate-600">{pins === 1 ? '1 delivery still to come is listed below.' : `${pins} deliveries still to come are listed below.`}</p> : null}
    </div>
  );
}

/**
 * The route's map card: opened by itself when a truck carrying the route's deliveries is on the road with a
 * position (the server sends one only then), else behind "Show map". The phone's WebGL is checked before the map's
 * code is loaded.
 */
export function MapCard({ view }: { view: SalesRouteView }) {
  const model = useMemo(() => mapModel(view), [view]);
  const [choice, setChoice] = useState<boolean | null>(null);
  const [gl, setGl] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const open = choice ?? model.trucks.length > 0;
  useEffect(() => {
    if (open && gl === null) setGl(webglAvailable());
  }, [open, gl]);
  if (!model.trucks.length && !model.pins.length) return null;
  const fallback = <MapFallback trucks={model.trucks} pins={model.pins.length} />;
  return (
    <section className="space-y-2 rounded-lg bg-white p-3 shadow-sm ring-1 ring-slate-200" data-testid="map-card">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600">
          <MapIcon className="h-4 w-4" aria-hidden /> {UI.map}
        </h3>
        <button type="button" onClick={() => setChoice(!open)} className="min-h-10 rounded-md border border-slate-300 px-3 text-sm font-medium" data-testid="map-toggle" aria-expanded={open}>
          {open ? UI.hideMap : UI.showMap}
        </button>
      </div>
      {open ? (
        gl === null ? null : gl && !failed ? (
          <MapBoundary fallback={fallback}>
            <SalesRouteMap trucks={model.trucks} pins={model.pins} fitKey={model.fitKey} onFail={() => setFailed(true)} />
          </MapBoundary>
        ) : (
          fallback
        )
      ) : null}
      {open && gl && !failed ? <p className="text-xs text-slate-500">{UI.mapNote}</p> : null}
    </section>
  );
}
