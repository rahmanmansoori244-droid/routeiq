/**
 * The plan map's decisions (components/plan-map.tsx), kept out of the component so they are unit
 * tested (tests/lib/dispatch-plan-map-state.spec.ts; the component is held to them by static guards
 * there, as jsdom is not a dependency): which line each load gets, what the caption counts, when the
 * answer is for other content than the screen, what a failed request leaves on screen, when the one
 * automatic retry is due, and when a draw may run on the map.
 */
import type { EstimateReason, LngLat } from '@/lib/dispatch/load-geometry';
import { distinctPoints, loadPath, loadPathKey } from '@/lib/dispatch/load-path';
import { shouldAutoRetry, type RoadShapesState, type ShapeRow } from '@/lib/dispatch/map-caption';

/** One row of `GET /api/runs/:id/load-geometry` as the map uses it. */
export interface GeoRow {
  loadId: string;
  estimated: boolean;
  coordinates: LngLat[];
  reason?: EstimateReason;
  /** Fingerprint of the path the server routed (`loadPathKey`); missing from an older server. */
  pointsKey?: string;
  /** The load has no line (no located stop away from the depot). */
  noPath?: boolean;
}

export type GeoState = RoadShapesState<GeoRow>;

/** The one "loading" value (a stable identity, so effects that depend on it do not loop). */
export const GEO_LOADING: GeoState = { status: 'loading' };

export interface MapLoadStops {
  id: string;
  stops: { lat: number | null; lng: number | null }[];
  /**
   * Audit E1: the depot pin this load was planned from (DetailLoad.origin), when it is not the plan's
   * depot: its line starts and ends there, as the road-shapes route routes it (the same pointsKey).
   */
  origin?: Depot | null;
}

type Depot = { lat: number; lng: number };

export interface LoadLine {
  loadId: string;
  coordinates: LngLat[];
  /** true = straight segments between the stops (not the road): drawn dashed. */
  dashed: boolean;
  /** Why it is dashed, when the server said: none when the answer has no row for the stops shown. */
  reason?: EstimateReason;
}

/** Where a load starts and ends: its own planned origin, else the plan's depot (audit E1). */
export function originOf(l: Pick<MapLoadStops, 'origin'>, depot: Depot): Depot {
  return l.origin ?? depot;
}

/** Depot -> located stops in order -> depot, as straight segments. */
export function straightTour(depot: Depot, stops: MapLoadStops['stops']): LngLat[] {
  return loadPath(depot, stops).map(([lat, lng]) => [lng, lat]);
}

/**
 * The answer's row for this load as the screen shows it: same load id and, when the server sent its
 * fingerprint, the same path. Else null: the row is for other content (a moved pin, other stops).
 */
function rowFor(rows: ReadonlyMap<string, GeoRow>, l: MapLoadStops, depot: Depot): GeoRow | null {
  const row = rows.get(l.id);
  if (!row) return null;
  if (row.pointsKey !== undefined && row.pointsKey !== loadPathKey(loadPath(originOf(l, depot), l.stops))) return null;
  return row;
}

const rowsById = (geo: GeoState) => new Map(geo.status === 'ready' ? geo.rows.map((r) => [r.loadId, r] as const) : []);

/**
 * The line each load on screen gets. While the shapes load: none (a straight line would pass for the
 * route; the depot and stops are still drawn). After: the road shape (solid), or straight dashed
 * segments when the load has none (estimated, no row for its stops as shown, or the request failed).
 * A load with no located stop away from the depot gets no line.
 */
export function linesToDraw(geo: GeoState, loads: MapLoadStops[], depot: Depot): LoadLine[] {
  if (geo.status === 'loading') return [];
  const rows = rowsById(geo);
  const out: LoadLine[] = [];
  for (const l of loads) {
    if (distinctPoints(loadPath(originOf(l, depot), l.stops)) < 2) continue;
    const row = rowFor(rows, l, depot);
    const has = !!row && Array.isArray(row.coordinates) && row.coordinates.length >= 2;
    if (has && !row.estimated) out.push({ loadId: l.id, coordinates: row.coordinates, dashed: false });
    else out.push({ loadId: l.id, coordinates: has ? row.coordinates : straightTour(originOf(l, depot), l.stops), dashed: true, ...(row?.estimated && row.reason ? { reason: row.reason } : {}) });
  }
  return out;
}

/**
 * What the caption counts: the lines the map draws (one row per line; a load with no line is left
 * out), never the server's rows as such. A load on screen that the answer has no row for is drawn
 * straight and counted straight, so the caption cannot say "Lines follow the road network (OSRM)"
 * over a dashed line.
 */
export function drawnShapes(geo: GeoState, loads: MapLoadStops[], depot: Depot): RoadShapesState<ShapeRow> {
  if (geo.status === 'loading') return geo;
  const lines = linesToDraw(geo, loads, depot);
  // Nothing to draw a line for: no claim either way, not "straight lines shown".
  if (geo.status === 'failed') return lines.length ? geo : { status: 'ready', rows: [] };
  return { status: 'ready', rows: lines.map((l) => ({ estimated: l.dashed, reason: l.reason })) };
}

/**
 * The answer is for other plan content than the screen shows: a load on screen has no row for its
 * stops as shown, or the answer has a load the screen does not. The screen's plan is then behind the
 * server (the shapes are always asked for after the plan was read): another dispatcher's "Use
 * instead" made new loads under the same run, or the pin of a stop planned before snapshots existed
 * moved (no stopSnapshotJson, so its path is today's customer pin; a stop planned with a snapshot
 * keeps its planned pin, and correcting the customer's pin changes nothing). Asking for the shapes
 * again gives the same answer; the plan must be reloaded.
 */
export function answerIsStale(geo: GeoState, loads: MapLoadStops[], depot: Depot): boolean {
  if (geo.status !== 'ready') return false;
  const onScreen = new Set(loads.map((l) => l.id));
  if (geo.rows.some((r) => !onScreen.has(r.loadId))) return true;
  const rows = rowsById(geo);
  return loads.some((l) => !rowFor(rows, l, depot));
}

/**
 * What stays on screen when a request for the shapes fails: a retry that fails keeps what the last
 * answer showed (and its caption); a first request that fails is "failed" (straight lines, the
 * honest caption and Retry), never an empty answer that would read as "every load on the road".
 */
export function afterFailedFetch(prev: GeoState): GeoState {
  return prev.status === 'ready' ? prev : { status: 'failed' };
}

/**
 * The one automatic retry: due when the answer has straight lines a retry is likely to fix. Not for
 * a stale answer: the map reloads the plan instead (which is then the one automatic second request).
 */
export function autoRetryDue(geo: GeoState, s: { retrying: boolean; alreadyRetried: boolean; stale: boolean }): boolean {
  return !s.alreadyRetried && !s.retrying && !s.stale && shouldAutoRetry(geo);
}

/** The part of a MapLibre map the draw gate uses. */
export interface MapStyleEvents {
  on(type: 'style.load', listener: () => void): unknown;
  off(type: 'style.load', listener: () => void): unknown;
  /** MapLibre's style: `_loaded` is true once the style itself has loaded (tiles or not). */
  style?: { _loaded?: boolean } | null;
}

export interface DrawGate {
  /** Runs `draw` now when the map's style has loaded, else once it has (only the newest draw asked for). */
  run(draw: () => void): void;
  /** Drops a draw still waiting for the map. */
  cancel(): void;
  /** For the map's cleanup: drops a waiting draw and stops listening. */
  dispose(): void;
}

/**
 * Gate for drawing on one MapLibre map: every draw once the map's style has loaded ('style.load', or
 * already loaded) runs at once. Adding sources, layers and markers is valid from then on, whatever
 * the base-map tiles are doing.
 *
 * Not the map's 'load' event: in maplibre-gl 4 it fires only when every tile of the first view has
 * loaded or failed, so a slow tile server left the map empty for seconds, and a tile request that
 * never answers (maplibre has no tile timeout) or fails late left it empty until the dispatcher moved
 * the map, while the caption already said OSRM. Not `map.isStyleLoaded()` either: it is false
 * whenever any tile or GeoJSON source is still loading, and the old `isStyleLoaded() ? draw() :
 * once('load', draw)` parked draws asked for while tiles loaded on a one-time event that had
 * already fired (the road shapes arriving right after the map fitted itself to the stops were never
 * drawn).
 *
 * Create it right after the map (the style of a new map loads a frame later at the earliest).
 */
export function createDrawGate(map: MapStyleEvents): DrawGate {
  let ready = !!map.style?._loaded;
  let waiting: (() => void) | null = null;
  const onStyleLoad = () => {
    ready = true;
    const draw = waiting;
    waiting = null;
    draw?.();
  };
  map.on('style.load', onStyleLoad);
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
      map.off('style.load', onStyleLoad);
    },
  };
}
