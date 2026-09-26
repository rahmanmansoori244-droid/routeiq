/**
 * A load's path on the plan map (depot -> located stops in order -> depot) and its fingerprint.
 *
 * The road-shapes route (`GET /api/runs/:id/load-geometry`) builds each load's path from the
 * database and sends the fingerprint with the load's row (`pointsKey`); the map
 * (components/plan-map.tsx) builds it from the stops it shows. When the two differ, the answer is
 * for other content than the screen (the plan changed on the server after the screen loaded it), and
 * the map treats that load as having no road shape (lib/dispatch/plan-map-state.ts). Both sides use
 * these functions, so the same stops always give the same fingerprint. Free of server code: the map
 * imports it.
 */
import type { LatLng } from '@/lib/dispatch/load-geometry';

/** Depot, the stops that have a location (in the order given), depot. */
export function loadPath(depot: { lat: number; lng: number }, stops: readonly { lat: number | null; lng: number | null }[]): LatLng[] {
  const out: LatLng[] = [[depot.lat, depot.lng]];
  for (const s of stops) if (s.lat !== null && s.lng !== null) out.push([s.lat, s.lng]);
  out.push([depot.lat, depot.lng]);
  return out;
}

/** How many different points the path has. Under 2: nothing to route and no line to draw. */
export function distinctPoints(points: readonly LatLng[]): number {
  return new Set(points.map(([lat, lng]) => `${lat},${lng}`)).size;
}

/** FNV-1a (32 bit) of a string, from a given start value. */
function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Fingerprint of a path: the exact numbers in order (no rounding: a moved pin is other content), as
 * 16 hex digits (two 32-bit FNV-1a hashes with different start values).
 */
export function loadPathKey(points: readonly LatLng[]): string {
  const s = points.map(([lat, lng]) => `${lat},${lng}`).join(';');
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return hex(fnv1a(s, 0x811c9dc5)) + hex(fnv1a(s, 0x01000193 ^ 0x5bd1e995));
}
