/**
 * Road-network route geometry for the LEGACY run-detail Map tab (pre-Sep 2026 runs). The dispatch
 * plan screen does not use this: it draws loads through the solver's private /route-geometry.
 *
 * Two providers in priority order, then straight lines:
 *
 *   1. **Mapbox Directions** (`MAPBOX_TOKEN` set).
 *
 *   2. **OSRM** (`OSRM_URL` set, e.g. `http://routeiq-osrm.railway.internal:5000`, the
 *      self-hosted server). There is deliberately NO default: with `OSRM_URL` unset or empty the
 *      map draws straight lines, so customer coordinates never go to a third-party demo server
 *      (review F22).
 *
 * Both providers return polyline6 encoded geometry which we decode into
 * an array of `[lng, lat]` pairs ready to plug into MapLibre GL JS as a
 * GeoJSON LineString. A process-local LRU keyed by the rounded coordinate
 * tuple is good for ~70% hit rate on a day's planning churn (planner moves
 * stops around, re-renders the map repeatedly with the same waypoints).
 */

const OSRM_URL = (process.env.OSRM_URL ?? '').trim().replace(/\/+$/, '');
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN ?? '';
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_MAX = 200;

export type LngLat = [number, number]; // GeoJSON order: lng,lat

export interface RouteGeometry {
  /** Polyline as GeoJSON-ordered [lng, lat] pairs. */
  coordinates: LngLat[];
  /** Real road distance in km (sum of the legs). */
  distanceKm: number;
  /** Real road duration in minutes. */
  durationMin: number;
  /** Which provider returned this. */
  provider: 'osrm' | 'mapbox' | 'fallback';
}

class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v); // bump to most-recent
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

const cache = new LRU<string, RouteGeometry>(CACHE_MAX);

function cacheKey(waypoints: LngLat[]): string {
  // Round to 5 decimals (~1m) so trivially-different requests share cache.
  return waypoints.map(([lng, lat]) => `${lng.toFixed(5)},${lat.toFixed(5)}`).join('|');
}

function straightLineFallback(waypoints: LngLat[]): RouteGeometry {
  let km = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const [lng1, lat1] = waypoints[i - 1];
    const [lng2, lat2] = waypoints[i];
    km += haversineKm(lat1, lng1, lat2, lng2);
  }
  return {
    coordinates: waypoints,
    distanceKm: km * 1.3, // match the v1 default distanceMultiplier
    durationMin: Math.round((km * 1.3 / 40) * 60), // assume 40 km/h
    provider: 'fallback',
  };
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371.0088;
  const dl = ((lat2 - lat1) * Math.PI) / 180;
  const dg = ((lng2 - lng1) * Math.PI) / 180;
  const la = (lat1 * Math.PI) / 180;
  const lb = (lat2 * Math.PI) / 180;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await p;
  } finally {
    clearTimeout(t);
  }
}

async function fetchOSRM(waypoints: LngLat[]): Promise<RouteGeometry | null> {
  if (!OSRM_URL) return null; // not configured: straight lines, nothing leaves the server
  // OSRM expects lng,lat;lng,lat;... — same order as our LngLat tuple.
  const coords = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(';');
  // geometries=geojson returns ready-to-render coords; overview=full keeps
  // every shape node (we want the road bends).
  const url = `${OSRM_URL}/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=true`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'RouteIQ/1.0' } });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      code?: string;
      routes?: Array<{
        geometry: { type: 'LineString'; coordinates: LngLat[] };
        distance: number; // meters
        duration: number; // seconds
      }>;
    };
    if (json.code !== 'Ok' || !json.routes?.length) return null;
    const r = json.routes[0];
    return {
      coordinates: r.geometry.coordinates,
      distanceKm: r.distance / 1000,
      durationMin: Math.round(r.duration / 60),
      provider: 'osrm',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchMapbox(waypoints: LngLat[]): Promise<RouteGeometry | null> {
  if (!MAPBOX_TOKEN) return null;
  if (waypoints.length > 25) return null; // Mapbox Directions hard limit
  const coords = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(';');
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      code?: string;
      routes?: Array<{
        geometry: { type: 'LineString'; coordinates: LngLat[] };
        distance: number;
        duration: number;
      }>;
    };
    if (json.code !== 'Ok' || !json.routes?.length) return null;
    const r = json.routes[0];
    return {
      coordinates: r.geometry.coordinates,
      distanceKm: r.distance / 1000,
      durationMin: Math.round(r.duration / 60),
      provider: 'mapbox',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Resolve real road geometry for a sequence of waypoints. Tries Mapbox
 * (if token configured) → OSRM → straight-line Haversine fallback. The
 * fallback keeps the map functional even when both providers are down.
 *
 * `waypoints` is the full ordered tour for one truck: usually
 * `[depot, stop1, stop2, …, stopN, depot]`. Caller is responsible for
 * filtering out stops with null coordinates before calling.
 */
export async function getRouteGeometry(waypoints: LngLat[]): Promise<RouteGeometry> {
  if (waypoints.length < 2) {
    return { coordinates: waypoints, distanceKm: 0, durationMin: 0, provider: 'fallback' };
  }
  const key = cacheKey(waypoints);
  const cached = cache.get(key);
  if (cached) return cached;

  // Try Mapbox first when configured (paying-tenant tier).
  let geometry = MAPBOX_TOKEN ? await fetchMapbox(waypoints) : null;
  // Then OSRM.
  if (!geometry) geometry = await fetchOSRM(waypoints);
  // Last resort.
  if (!geometry) geometry = straightLineFallback(waypoints);

  cache.set(key, geometry);
  return geometry;
}

/** For diagnostic endpoints / Sentry. */
export function getCacheStats() {
  return { max: CACHE_MAX };
}
