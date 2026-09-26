/**
 * The plan map's decisions (components/plan-map.tsx), kept out of the component so they are unit
 * tested (tests/lib/dispatch-plan-map-state.spec.ts; the component is held to them by static guards
 * there, as jsdom is not a dependency): which line each load gets, what a failed request leaves on
 * screen, when the one automatic retry is due, and when a draw may run on the map.
 */
import type { EstimateReason, LngLat } from '@/lib/dispatch/load-geometry';
import { shouldAutoRetry, type RoadShapesState } from '@/lib/dispatch/map-caption';

/** One row of `GET /api/runs/:id/load-geometry` as the map uses it. */
export interface GeoRow {
  loadId: string;
  estimated: boolean;
  coordinates: LngLat[];
  reason?: EstimateReason;
}

export type GeoState = RoadShapesState<GeoRow>;

/** The one "loading" value (a stable identity, so effects that depend on it do not loop). */
export const GEO_LOADING: GeoState = { status: 'loading' };

export interface MapLoadStops {
  id: string;
  stops: { lat: number | null; lng: number | null }[];
}

export interface LoadLine {
  loadId: string;
  coordinates: LngLat[];
  /** true = straight segments between the stops (not the road): drawn dashed. */
  dashed: boolean;
}

/** Depot -> located stops in order -> depot, as straight segments. */
export function straightTour(depot: { lat: number; lng: number }, stops: MapLoadStops['stops']): LngLat[] {
  const out: LngLat[] = [[depot.lng, depot.lat]];
  for (const s of stops) if (s.lat !== null && s.lng !== null) out.push([s.lng, s.lat]);
  out.push([depot.lng, depot.lat]);
  return out;
}

/**
 * The line each load gets. While the shapes load: none (a straight line would pass for the route;
 * the depot and stops are still drawn). After: the road shape (solid), or straight dashed segments
 * when the load has none (estimated, missing from the answer, or the request failed).
 */
export function linesToDraw(geo: GeoState, loads: MapLoadStops[], depot: { lat: number; lng: number }): LoadLine[] {
  if (geo.status === 'loading') return [];
  const rows = new Map(geo.status === 'ready' ? geo.rows.map((r) => [r.loadId, r] as const) : []);
  return loads.map((l) => {
    const row = rows.get(l.id);
    const has = !!row && Array.isArray(row.coordinates) && row.coordinates.length >= 2;
    if (has && !row.estimated) return { loadId: l.id, coordinates: row.coordinates, dashed: false };
    return { loadId: l.id, coordinates: has ? row.coordinates : straightTour(depot, l.stops), dashed: true };
  });
}

/**
 * What stays on screen when a request for the shapes fails: a retry that fails keeps what the last
 * answer showed (and its caption); a first request that fails is "failed" (straight lines, the
 * honest caption and Retry), never an empty answer that would read as "every load on the road".
 */
export function afterFailedFetch(prev: GeoState): GeoState {
  return prev.status === 'ready' ? prev : { status: 'failed' };
}

/** The one automatic retry: due when the answer has straight lines a retry is likely to fix. */
export function autoRetryDue(geo: GeoState, s: { retrying: boolean; alreadyRetried: boolean }): boolean {
  return !s.alreadyRetried && !s.retrying && shouldAutoRetry(geo);
}

/** The part of a MapLibre map the draw gate uses. */
export interface MapLoadEvents {
  on(type: 'load', listener: () => void): unknown;
  off(type: 'load', listener: () => void): unknown;
}

export interface DrawGate {
  /** Runs `draw` now when the map has loaded, else once it has (only the newest draw asked for). */
  run(draw: () => void): void;
  /** Drops a draw still waiting for the map. */
  cancel(): void;
  /** For the map's cleanup: drops a waiting draw and stops listening. */
  dispose(): void;
}

/**
 * Gate for drawing on one MapLibre map: every draw after the map's one-time 'load' runs at once.
 *
 * Not `map.isStyleLoaded()`: in maplibre-gl 4 it is false whenever any tile or GeoJSON source is
 * still loading, and 'load' fires only once per map. The old `isStyleLoaded() ? draw() :
 * once('load', draw)` therefore dropped every draw asked for after 'load' while tiles loaded, for
 * example the road shapes arriving right after the map fitted itself to the stops (new tiles): the
 * map kept the straight lines drawn before, or no lines at all, under a caption saying OSRM. Adding
 * sources and layers is valid once the style has loaded, tiles or not.
 *
 * Create it right after the map (before 'load' can fire).
 */
export function createDrawGate(map: MapLoadEvents): DrawGate {
  let ready = false;
  let waiting: (() => void) | null = null;
  const onLoad = () => {
    ready = true;
    const draw = waiting;
    waiting = null;
    draw?.();
  };
  map.on('load', onLoad);
  return {
    run(draw) {
      if (ready) draw();
      else waiting = draw;
    },
    cancel() {
      waiting = null;
    },
    dispose() {
      waiting = null;
      map.off('load', onLoad);
    },
  };
}
