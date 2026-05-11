/**
 * Shared map config (Module C).
 *
 * RouteIQ renders maps with MapLibre GL JS — a permissive fork of Mapbox GL JS
 * v1 that doesn't require a token. Default tile source is OpenStreetMap raster
 * (free, attribution required, fine for low-volume production). If
 * NEXT_PUBLIC_MAPBOX_TOKEN is set, callers can swap in Mapbox vector tiles for
 * higher quality.
 */

export const OSM_RASTER_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: 'raster' as const,
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster' as const,
      source: 'osm',
    },
  ],
};

/**
 * Returns either the Mapbox style URL (when a token is set) or the OSM raster
 * style object so MapLibre can render without any external account.
 */
export function defaultMapStyle(
  mapboxToken: string | null | undefined,
):
  | string
  | typeof OSM_RASTER_STYLE {
  if (mapboxToken && mapboxToken.length > 0) {
    return 'mapbox://styles/mapbox/light-v11';
  }
  return OSM_RASTER_STYLE;
}

/**
 * 12 visually-distinct colors for per-truck route polylines and stop markers.
 */
export const TRUCK_COLORS = [
  '#2563EB', '#DC2626', '#16A34A', '#D97706', '#7C3AED', '#0891B2',
  '#DB2777', '#65A30D', '#475569', '#9333EA', '#0EA5E9', '#EA580C',
];

export function truckColor(idx: number): string {
  return TRUCK_COLORS[idx % TRUCK_COLORS.length]!;
}
