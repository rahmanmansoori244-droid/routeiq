/**
 * Turn whatever the dispatcher pastes into a validated customer location.
 *
 * Accepted inputs
 *   - "23.5859, 58.4059" / "23.5859 58.4059" / "23.5859;58.4059"
 *   - DMS as Google copies it: 23°35'09.2"N 58°24'21.2"E (minutes and seconds below 60; whole
 *     degrees or minutes only -> needs a pin confirmation)
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

/** How many decimals a written number has ("23.5850" has 4): its precision as written. */
export const decimalPlaces = (text: string): number => decimals(text.trim());

/** How precise a degrees-minutes-seconds point is: whole degrees (~110 km), whole minutes (~1.8 km) or seconds. */
export type DmsPrecision = 'DEGREES' | 'MINUTES' | 'SECONDS';

export type DmsParse = { lat: number; lng: number; precision: DmsPrecision } | { error: string };

/**
 * One coordinate of a DMS pair, or why it is not a real one (audit F17). Minutes and seconds must be
 * below 60, seconds need minutes, and the value must stay within 90° (latitude, N/S) or 180°
 * (longitude, E/W): 23°99'00"N used to be read as 24.65°N - another real point in Oman, with high
 * confidence and no pin to confirm.
 */
function dmsValue(deg: string, min: string | undefined, sec: string | undefined, hemi: string, axis: 'lat' | 'lng'): number | string {
  const name = axis === 'lat' ? 'Latitude' : 'Longitude';
  const max = axis === 'lat' ? 90 : 180;
  if (sec !== undefined && min === undefined) return `${name} ${deg}°${sec}": seconds without minutes. Write degrees, minutes and seconds, e.g. 23°35'09.2"N.`;
  const d = Number(deg);
  const m = min === undefined ? 0 : Number(min);
  const s = sec === undefined ? 0 : Number(sec);
  if (!(m < 60)) return `${name}: minutes must be 0 to 59 (got ${min}').`;
  if (!(s < 60)) return `${name}: seconds must be below 60 (got ${sec}").`;
  const v = d + m / 60 + s / 3600;
  if (v > max) return `${name} must be at most ${max}° (got ${deg}°${min !== undefined ? `${min}'` : ''}${sec !== undefined ? `${sec}"` : ''}${hemi.toUpperCase()}).`;
  return /[SW]/i.test(hemi) ? -v : v;
}

const dmsPrecisionOf = (min: string | undefined, sec: string | undefined): DmsPrecision => (min === undefined ? 'DEGREES' : sec === undefined ? 'MINUTES' : 'SECONDS');
const PRECISION_RANK: Record<DmsPrecision, number> = { DEGREES: 0, MINUTES: 1, SECONDS: 2 };

// Latitude (N/S) first, then longitude (E/W), as Google copies it. Minutes and seconds are matched
// with up to 3 digits so an impossible value is refused with its reason instead of "not a location".
// The degrees start a number ("1234°" is not read as 234°); no lookbehind, for older browsers.
const DMS_RE =
  /(?:^|[^\d.])(\d{1,3})\s*[°º]\s*(?:(\d{1,3})\s*['′’]\s*)?(?:(\d{1,3}(?:\.\d+)?)\s*(?:"|″|”|'')\s*)?([NSns])[\s,;+]*(\d{1,3})\s*[°º]\s*(?:(\d{1,3})\s*['′’]\s*)?(?:(\d{1,3}(?:\.\d+)?)\s*(?:"|″|”|'')\s*)?([EWew])/;

/**
 * 23°35'09.2"N 58°24'21.2"E (also with ′ ″ or spaces). null = no DMS pair in the text; `error` = a
 * DMS pair that is not a real point (refused, never rolled over into another point).
 */
export function parseDms(s: string): DmsParse | null {
  const m = DMS_RE.exec(s);
  if (!m) return null;
  const lat = dmsValue(m[1], m[2], m[3], m[4], 'lat');
  if (typeof lat === 'string') return { error: lat };
  const lng = dmsValue(m[5], m[6], m[7], m[8], 'lng');
  if (typeof lng === 'string') return { error: lng };
  const a = dmsPrecisionOf(m[2], m[3]);
  const b = dmsPrecisionOf(m[6], m[7]);
  return { lat, lng, precision: PRECISION_RANK[a] <= PRECISION_RANK[b] ? a : b };
}

/**
 * How sure a DMS point is. Whole degrees (about 110 km) or whole minutes (about 1.8 km) are not a
 * delivery point: the dispatcher confirms the pin (audit F17), like decimals with fewer than 4 places.
 */
function dmsBase(precision: DmsPrecision): { confidence: Confidence; needsPin?: boolean; warnings?: string[] } {
  if (precision === 'DEGREES') {
    return { confidence: 'LOW', needsPin: true, warnings: ['Whole degrees only (accurate to about 100 km). Drop the pin on the customer.'] };
  }
  if (precision === 'MINUTES') {
    return { confidence: 'MEDIUM', needsPin: true, warnings: ['Degrees and minutes only, no seconds (accurate to about 2 km). Confirm the pin.'] };
  }
  return { confidence: 'HIGH' };
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
      // Never raises a lower confidence (whole-degree DMS stays LOW).
      if (confidence === 'HIGH') confidence = 'MEDIUM';
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
    if ('error' in dmsPlain) return fail(dmsPlain.error);
    return withValidation(dmsPlain.lat, dmsPlain.lng, { source: 'MANUAL_LATLNG', ...dmsBase(dmsPlain.precision) }, area);
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

/** A DMS pair found in a Google Maps link: refused when it is not a real point, else checked like any other. */
function dmsResult(d: DmsParse, resolvedUrl: string, area: ServiceArea): LocationParse {
  if ('error' in d) return fail(d.error, { resolvedUrl });
  return withValidation(d.lat, d.lng, { source: 'GOOGLE_MAPS_URL', ...dmsBase(d.precision), resolvedUrl }, area);
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
    if (d) return dmsResult(d, resolvedUrl, area);
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
    if (d) return dmsResult(d, resolvedUrl, area);
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

/**
 * The owner's standing rule (27 Sep 2026, audit PR A5): "locations should always be correct ... no
 * item will be delivered without location". A reading that needs a pin (`needsPin`: every LOW
 * reading and the MEDIUM ones - map centre, fewer than 4 decimals, degrees and minutes only, swapped,
 * outside the delivery area) is never saved as read: the dispatcher places the pin by hand.
 */
export const PIN_REQUIRED_MESSAGE = "This reading is not exact. Drop the pin on the customer's exact location, then save.";
/** The customer's saved point shown on the map, saved again without a hand pin, when it is not exact. */
export const SAVED_NOT_EXACT_MESSAGE = "This saved location is not exact. Drop the pin on the customer's exact location, then save.";
/** The same, for a saved point outside the company's delivery area that no dispatcher confirmed. */
export const SAVED_OUTSIDE_AREA_MESSAGE = "This saved location is outside the delivery area and was never confirmed. Drop the pin on the customer's exact location, then save.";
/** The same, for a saved point whose latitude and longitude are the wrong way round. */
export const SAVED_SWAPPED_MESSAGE = "This saved location has latitude and longitude swapped. Drop the pin on the customer's exact location, then save.";
export const LOCATION_MISMATCH_MESSAGE = 'The point sent is not where this text points. Press Read again, or drop the pin by hand, then save.';

/** Two points the same to the 6 decimals the parser and the pin map round to. */
export function samePoint(a: { lat: number; lng: number }, b: { lat: number; lng: number }): boolean {
  // Half a unit of the 6th decimal: 23.123456 and 23.123457 differ, 23.1234560 and 23.123456 do not.
  return Math.abs(a.lat - b.lat) < 5e-7 && Math.abs(a.lng - b.lng) < 5e-7;
}

/** A parse's refusal in plain words, always ending with what to do (drop the pin). */
export function pinRequiredMessage(p: Pick<LocationParse, 'ok' | 'error'>): string {
  if (p.ok) return PIN_REQUIRED_MESSAGE;
  const e = (p.error ?? 'This location could not be read.').trim();
  return /\bpin\b/i.test(e) ? e : `${e} Drop the pin on the customer's exact location, then save.`;
}

/**
 * Read a saved location's text again, with no network call. A short link (maps.app.goo.gl ...) is
 * read from `resolvedUrl`, the final Google Maps address the Read (POST /api/locations/parse) found
 * by following it on the server: only an http(s) Google Maps address that is not itself a short link
 * is accepted. Without one the answer is "not read" (press Read again, or drop a pin).
 */
export function rereadSavedInput(input: string, resolvedUrl: string | null | undefined, area: ServiceArea = DEFAULT_SERVICE_AREA): LocationParse {
  const first = parseLocationInput(input, area);
  if (!first.needsResolve) return first;
  const notRead = fail('This short link was not read on this screen. Press Read again, or drop the pin on the map.');
  if (!resolvedUrl) return notRead;
  let u: URL;
  try {
    u = new URL(resolvedUrl);
  } catch {
    return notRead;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !isGoogleMapsHost(u.hostname) || SHORT_HOSTS.test(u.hostname)) return notRead;
  return { ...parseGoogleMapsUrl(u, area), resolvedUrl: u.href };
}

export type ManualLocationCheck =
  | { ok: true; lat: number; lng: number; source: LocationSourceKind; confidence: Confidence }
  | { ok: false; code: 'PIN_REQUIRED' | 'LOCATION_MISMATCH'; message: string; parse?: LocationParse };

/**
 * Server side of the location rule for a save that is NOT a pin placed by hand (audit PR A5, L2):
 * the text the point was read from is read again with the same parser (no network), and the save
 * is refused when that reading needs a pin or cannot be read (PIN_REQUIRED), or when the point sent
 * is not the point the text reads as (LOCATION_MISMATCH). The source and confidence stored are the
 * parser's, never the client's. An accepted reading is always HIGH: the parser asks for a pin for
 * every MEDIUM or LOW one.
 */
export function checkManualLocation(args: {
  input: string | null | undefined;
  resolvedUrl?: string | null;
  lat: number;
  lng: number;
  area?: ServiceArea;
}): ManualLocationCheck {
  const text = (args.input ?? '').trim();
  if (!text) {
    return { ok: false, code: 'PIN_REQUIRED', message: 'Paste the Google Maps link or coordinates and press Read, or drop the pin on the map, then save.' };
  }
  const p = rereadSavedInput(text, args.resolvedUrl, args.area ?? DEFAULT_SERVICE_AREA);
  if (!p.ok || p.needsPin || p.lat === undefined || p.lng === undefined) {
    return { ok: false, code: 'PIN_REQUIRED', message: pinRequiredMessage(p), parse: p };
  }
  if (!samePoint({ lat: p.lat, lng: p.lng }, { lat: args.lat, lng: args.lng })) {
    return { ok: false, code: 'LOCATION_MISMATCH', message: LOCATION_MISMATCH_MESSAGE, parse: p };
  }
  return { ok: true, lat: p.lat, lng: p.lng, source: p.source ?? 'MANUAL_LATLNG', confidence: p.confidence ?? 'HIGH' };
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
