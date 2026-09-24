/**
 * Turn whatever the dispatcher pastes into a validated customer location.
 *
 * Accepted inputs
 *   - "23.5859, 58.4059" / "23.5859 58.4059" / "23.5859;58.4059"
 *   - DMS as Google copies it: 23°35'09.2"N 58°24'21.2"E
 *   - Google Maps URLs carrying coordinates:
 *       .../place/...!3d23.5859!4d58.4059   (the pin - most reliable)
 *       ?q=23.58,58.40  ?ll=  ?query=  ?destination=  ?daddr=  /search/23.58,+58.40
 *       .../@23.5859,58.4059,17z            (map CENTRE only -> needs a pin confirmation)
 *       geo:23.5859,58.4059
 *   - Short share links (maps.app.goo.gl/..., goo.gl/maps/...) - resolved server-side by
 *     following redirects to Google hosts only (no open proxy / SSRF).
 *
 * Anything we cannot read confidently comes back with `needsPin: true` so the UI asks the
 * dispatcher to drop / confirm a pin instead of guessing.
 */

export type LocationSourceKind = 'MANUAL_LATLNG' | 'GOOGLE_MAPS_URL' | 'MAP_PIN';

export interface ServiceArea {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** Oman + UAE with a margin. Configurable per tenant (TenantConfig.serviceAreaJson). */
export const DEFAULT_SERVICE_AREA: ServiceArea = { minLat: 16.4, maxLat: 26.6, minLng: 51.5, maxLng: 60.0 };

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface LocationParse {
  ok: boolean;
  lat?: number;
  lng?: number;
  source?: LocationSourceKind;
  confidence?: Confidence;
  /** true = show the point on a map and make the dispatcher confirm/move the pin */
  needsPin: boolean;
  warnings: string[];
  error?: string;
  resolvedUrl?: string;
}

const NUM = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;

function fail(error: string, extra: Partial<LocationParse> = {}): LocationParse {
  return { ok: false, needsPin: true, warnings: [], error, ...extra };
}

function decimals(v: string): number {
  const i = v.indexOf('.');
  return i < 0 ? 0 : v.length - i - 1;
}

function dmsToDec(deg: string, min: string | undefined, sec: string | undefined, hemi: string): number {
  let v = Number(deg) + (min ? Number(min) / 60 : 0) + (sec ? Number(sec) / 3600 : 0);
  if (/[SW]/i.test(hemi)) v = -v;
  return v;
}

/** 23°35'09.2"N 58°24'21.2"E (also with ′ ″ or spaces). */
function parseDms(s: string): { lat: number; lng: number } | null {
  const re =
    /(\d{1,3})\s*[°º]\s*(?:(\d{1,2})\s*['′’]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|″|”|'')\s*)?([NSns])[\s,;+]*(\d{1,3})\s*[°º]\s*(?:(\d{1,2})\s*['′’]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|″|”|'')\s*)?([EWew])/;
  const m = re.exec(s);
  if (!m) return null;
  return { lat: dmsToDec(m[1], m[2], m[3], m[4]), lng: dmsToDec(m[5], m[6], m[7], m[8]) };
}

function pairFrom(text: string): { lat: string; lng: string } | null {
  const m = new RegExp(`^\\s*(${NUM})\\s*[,;\\s]\\s*\\+?(${NUM})\\s*$`).exec(text);
  return m ? { lat: m[1], lng: m[2] } : null;
}

function withValidation(
  lat: number,
  lng: number,
  base: { source: LocationSourceKind; confidence: Confidence; needsPin?: boolean; warnings?: string[]; resolvedUrl?: string; precision?: number },
  area: ServiceArea,
): LocationParse {
  const warnings = [...(base.warnings ?? [])];
  let needsPin = base.needsPin ?? false;
  let confidence = base.confidence;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail('Coordinates are not numbers.');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return fail('Latitude must be -90..90 and longitude -180..180.');
  if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) return fail('0,0 is not a real delivery location.');
  const inArea = (a: number, b: number) => a >= area.minLat && a <= area.maxLat && b >= area.minLng && b <= area.maxLng;
  if (!inArea(lat, lng)) {
    if (inArea(lng, lat)) {
      warnings.push('Latitude and longitude looked swapped; they were swapped back. Please confirm on the map.');
      [lat, lng] = [lng, lat];
      needsPin = true;
      confidence = 'MEDIUM';
    } else {
      warnings.push('This point is outside the delivery area (Oman/UAE). Confirm it on the map.');
      needsPin = true;
      confidence = 'LOW';
    }
  }
  if (base.precision !== undefined && base.precision < 4) {
    warnings.push('Coordinates have fewer than 4 decimals (accurate to ~100 m or worse). Confirm the pin.');
    needsPin = true;
    if (confidence === 'HIGH') confidence = 'MEDIUM';
  }
  return {
    ok: true,
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    source: base.source,
    confidence,
    needsPin,
    warnings,
    resolvedUrl: base.resolvedUrl,
  };
}

const SHORT_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|g\.co)$/i;

export function isShortMapsLink(input: string): boolean {
  try {
    const u = new URL(input.trim());
    return SHORT_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/** Google hosts we are willing to follow redirects to / parse. */
export function isGoogleMapsHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    SHORT_HOSTS.test(h) ||
    /^(www\.|maps\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h) ||
    h === 'consent.google.com'
  );
}

/** Pure parser - no network. Short links return needsResolve via error code. */
export function parseLocationInput(raw: string, area: ServiceArea = DEFAULT_SERVICE_AREA): LocationParse & { needsResolve?: boolean } {
  const input = (raw ?? '').trim();
  if (!input) return fail('Paste a Google Maps link or "latitude, longitude".');
  if (input.length > 2000) return fail('Input is too long.');

  // 1. Plain "lat, lng"
  const pair = pairFrom(input);
  if (pair) {
    return withValidation(Number(pair.lat), Number(pair.lng),
      { source: 'MANUAL_LATLNG', confidence: 'HIGH', precision: Math.min(decimals(pair.lat), decimals(pair.lng)) }, area);
  }
  // 2. DMS
  const dmsPlain = parseDms(input);
  if (dmsPlain && !/^https?:/i.test(input)) {
    return withValidation(dmsPlain.lat, dmsPlain.lng, { source: 'MANUAL_LATLNG', confidence: 'HIGH' }, area);
  }
  // 3. geo: URI
  const geo = new RegExp(`^geo:(${NUM}),(${NUM})`, 'i').exec(input);
  if (geo) {
    return withValidation(Number(geo[1]), Number(geo[2]),
      { source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', precision: Math.min(decimals(geo[1]), decimals(geo[2])) }, area);
  }
  // 4. URLs
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return fail('Not a recognised location. Paste a Google Maps link or "latitude, longitude".');
  }
  if (!isGoogleMapsHost(url.hostname)) {
    return fail('Only Google Maps links are supported. You can also paste "latitude, longitude" or drop a pin.');
  }
  if (SHORT_HOSTS.test(url.hostname)) {
    return { ...fail('Short link - resolving...'), needsResolve: true };
  }
  return parseGoogleMapsUrl(url, area);
}

export function parseGoogleMapsUrl(url: URL, area: ServiceArea = DEFAULT_SERVICE_AREA): LocationParse {
  if (url.hostname === 'consent.google.com') {
    const cont = url.searchParams.get('continue');
    if (cont) {
      try {
        return parseGoogleMapsUrl(new URL(cont), area);
      } catch {
        /* fall through */
      }
    }
    return fail('Google returned a consent page instead of the location. Drop a pin instead.');
  }
  const full = decodeURIComponent(url.href.replace(/\+/g, ' '));
  const resolvedUrl = url.href;

  // Place pin: !3d<lat>!4d<lng> (most precise - the actual marker).
  const pin = new RegExp(`!3d(${NUM})!4d(${NUM})`).exec(full);
  if (pin) {
    return withValidation(Number(pin[1]), Number(pin[2]), { source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', resolvedUrl }, area);
  }
  // Explicit coordinate query parameters.
  for (const key of ['q', 'query', 'll', 'destination', 'daddr', 'center', 'sll']) {
    const v = url.searchParams.get(key);
    if (!v) continue;
    const p = pairFrom(v.replace(/^loc:/i, ''));
    if (p) {
      return withValidation(Number(p.lat), Number(p.lng), {
        source: 'GOOGLE_MAPS_URL',
        confidence: key === 'center' || key === 'sll' ? 'MEDIUM' : 'HIGH',
        needsPin: key === 'center' || key === 'sll',
        precision: Math.min(decimals(p.lat), decimals(p.lng)),
        resolvedUrl,
      }, area);
    }
    const d = parseDms(v);
    if (d) return withValidation(d.lat, d.lng, { source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', resolvedUrl }, area);
  }
  // Coordinates in the path: /search/23.58,+58.40  /place/23.58,58.40  /dir//23.58,58.40
  const pathPair = new RegExp(`/(?:search|place|dir(?:/[^/]*)?)/(${NUM}),\\s*\\+?(${NUM})(?:[/?@]|$)`).exec(full);
  if (pathPair) {
    return withValidation(Number(pathPair[1]), Number(pathPair[2]), {
      source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', precision: Math.min(decimals(pathPair[1]), decimals(pathPair[2])), resolvedUrl,
    }, area);
  }
  const pathDms = /\/(?:search|place)\/([^/@?]+)/.exec(full);
  if (pathDms) {
    const d = parseDms(pathDms[1]);
    if (d) return withValidation(d.lat, d.lng, { source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', resolvedUrl }, area);
  }
  // Map viewport centre: /@lat,lng,17z - NOT necessarily where the customer is.
  const at = new RegExp(`@(${NUM}),(${NUM})(?:,[\\d.]+[zm])?`).exec(full);
  if (at) {
    return withValidation(Number(at[1]), Number(at[2]), {
      source: 'GOOGLE_MAPS_URL',
      confidence: 'MEDIUM',
      needsPin: true,
      warnings: ['This link only gives the map centre, not a pin. Check the point and move the pin if needed.'],
      resolvedUrl,
    }, area);
  }
  return fail('This Google Maps link does not contain coordinates (it only names a place). Drop a pin on the map instead.', { resolvedUrl });
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Resolve a short share link by following redirects (max 5 hops, Google hosts only, 5 s per
 * hop), then parse the final URL. Never fetches non-Google hosts.
 */
export async function resolveLocationInput(
  raw: string,
  opts: { area?: ServiceArea; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<LocationParse> {
  const area = opts.area ?? DEFAULT_SERVICE_AREA;
  const first = parseLocationInput(raw, area);
  if (!first.needsResolve) return first;
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  // Same scheme default as parseLocationInput, so "maps.app.goo.gl/xyz" pasted bare resolves.
  let current = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  // Up to 5 fetches (hops); the URL after the 5th redirect is still checked and parsed.
  for (let hop = 0; hop <= 5; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      return fail('The short link redirected to an invalid address.');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return fail('Unsupported link.');
    if (!isGoogleMapsHost(u.hostname)) return fail('The short link does not lead to Google Maps.');
    if (!SHORT_HOSTS.test(u.hostname)) {
      const parsed = parseGoogleMapsUrl(u, area);
      return { ...parsed, resolvedUrl: u.href };
    }
    if (hop === 5) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
    let res: Response;
    try {
      res = await doFetch(u.href, {
        method: 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (RouteIQ location resolver)' },
      });
    } catch (e) {
      return fail(`Could not open the short link (${(e as Error).message}). Paste the full link or drop a pin.`);
    } finally {
      clearTimeout(timer);
    }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, u).href;
      continue;
    }
    return fail('The short link did not redirect to a map location. Paste the full link or drop a pin.');
  }
  return fail('Too many redirects while resolving the short link.');
}
