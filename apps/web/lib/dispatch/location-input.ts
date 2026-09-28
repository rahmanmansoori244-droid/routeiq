/**
 * Turn whatever the dispatcher pastes into a validated customer location.
 *
 * Accepted inputs
 *   - "23.5859, 58.4059" / "23.5859 58.4059" / "23.5859;58.4059"
 *   - DMS as Google copies it: 23°35'09.2"N 58°24'21.2"E (minutes and seconds below 60; whole
 *     degrees or minutes only, or a pair with 3 decimals or fewer written as DMS -> needs a pin)
 *   - Google Maps URLs carrying coordinates:
 *       .../place/...!3d23.5859!4d58.4059   (the pin - most reliable; fewer than 4 decimals -> needs a pin)
 *       ?q=23.58,58.40  ?query=  ?destination=  ?daddr=  /search/23.58,+58.40
 *       /dir/<start>/23.58,58.40            (a directions link: only the END of the route is read)
 *       .../@23.5859,58.4059,17z  ?ll=  ?center=  ?sll=   (map CENTRE only -> needs a pin confirmation)
 *       geo:23.5859,58.4059
 *   - Short share links (maps.app.goo.gl/..., goo.gl/maps/...) - resolved server-side by
 *     following redirects to Google hosts only (no open proxy / SSRF).
 *
 * Anything we cannot read confidently comes back with `needsPin: true` so the UI asks the
 * dispatcher to drop / confirm a pin instead of guessing.
 *
 * Decimals (owner decision of 28 Sep 2026, "Same rule everywhere", audit PR A5): a pair written as
 * decimals needs at least 4, and of the zeros at the end of each coordinate only one counts
 * (`countedText`, the customer import's rule): "23.5800, 58.4100" counts 3 and needs a pin. That
 * holds for a pair typed or pasted, and for a pair written as text inside a link or URI - `geo:`,
 * `?q=`, `?query=`, `?destination=`, `?daddr=`, `/search/`, `/place/<pair>`, the end of a directions
 * link - because padding reaches those: /search/ and ?q= carry the text searched for, as typed, and
 * other programs build such links with a fixed number of decimals (Java "%f", JavaScript toFixed(6)),
 * so a rough 23.58 comes out "23.580000". RouteIQ's own links (`driver-links.ts`) never pad a number.
 * A map centre needs a pin whatever its digits.
 *
 * Google's own pin (`!3d...!4d...`) needs 4 decimals too (A5 sixth review), counted as Google wrote
 * them: Google writes no zeros at the end (a searched "23.5800, 58.4100" comes back as !3d23.58!4d58.41),
 * so its digits are not cut, but it is not always a marker Google placed: Google repeats a coordinate
 * searched for as the pin. A real place marker has 6 or 7 decimals. For the same reason degrees,
 * minutes and seconds that are a pair with 3 decimals or fewer written another way (Google shows a
 * searched "23.58, 58.41" as 23°34'48.0"N 58°24'36.0"E) need a pin (`dmsIsRoughPair`).
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

/**
 * A written coordinate as its decimals are counted: of the zeros at the end, one ("23.5800" ->
 * "23.580", "23.580000" -> "23.580", "23.0000" -> "23.0"; "23.5850" stays). The rule for every
 * decimal coordinate a person or a program wrote: the customer import (A5 fifth review, `readImportedPair`)
 * and, by the owner's decision of 28 Sep 2026 ("Same rule everywhere"), every pair ADD LOCATION and
 * `POST /api/customers` read. Text cannot tell padding from precision: Excel writes a cell formatted
 * to show 4 decimals as it shows it (23.58 as "23.5800"), and programs print a fixed number of
 * decimals (Java "%f", JavaScript toFixed(6): "23.580000"). A rough pair is never made exact by its
 * format. The price: a real 4-decimal value ending in 00 (about 1 in 100 per axis) is not exact
 * either; its pin is placed by hand.
 */
export function countedText(text: string): string {
  const t = text.trim();
  return /^([-+]?\d+\.\d*?0)0+$/.exec(t)?.[1] ?? t;
}

/** Did the zeros at the end make the difference: a value written with 4 decimals or more that counts fewer? */
export function zerosCut(texts: string[]): boolean {
  return texts.some((c) => decimalPlaces(c) >= 4 && decimalPlaces(countedText(c)) < 4);
}

/** The reason when the zeros made the difference (the import's words too, `IMPORT_REASON.FEW_DECIMALS_ZEROS`). */
export const FEW_DECIMALS_ZEROS_WARNING = 'Fewer than 4 decimals (only one zero at the end counts).';
const FEW_DECIMALS_WARNING = 'Coordinates have fewer than 4 decimals (accurate to ~100 m or worse).';

/** How precise a written pair is, as counted (one zero at the end), and whether the zeros made the difference. */
function pairPrecision(lat: string, lng: string): { precision: number; zerosCut: boolean } {
  return { precision: Math.min(decimals(countedText(lat)), decimals(countedText(lng))), zerosCut: zerosCut([lat, lng]) };
}

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
 * delivery point: the dispatcher drops the pin by hand (audit F17, owner's rule A5), like decimals
 * with fewer than 4 places.
 *
 * The warnings of a reading (here and in withValidation) say what is wrong with it, never what to do
 * (A5 fourth review): a reading that needs a pin is saved only as a pin placed by hand, and the
 * screens say that in their own words (ADD LOCATION: PIN_REQUIRED_MESSAGE, and Save stays off until
 * the pin is placed). They said "Confirm the pin", "Please confirm on the map" or "move the pin if
 * needed", which Save did not allow.
 */
function dmsBase(d: { lat: number; lng: number; precision: DmsPrecision }): { confidence: Confidence; needsPin?: boolean; warnings?: string[] } {
  if (d.precision === 'DEGREES') {
    return { confidence: 'LOW', needsPin: true, warnings: ['Whole degrees only (accurate to about 100 km).'] };
  }
  if (d.precision === 'MINUTES') {
    return { confidence: 'MEDIUM', needsPin: true, warnings: ['Degrees and minutes only, no seconds (accurate to about 2 km).'] };
  }
  if (dmsIsRoughPair(d.lat, d.lng)) {
    const text = (v: number) => String(Number(v.toFixed(3)));
    return {
      confidence: 'MEDIUM',
      needsPin: true,
      warnings: [`These degrees, minutes and seconds are ${text(d.lat)}, ${text(d.lng)} written another way: fewer than 4 decimals (accurate to ~100 m or worse).`],
    };
  }
  return { confidence: 'HIGH' };
}

/** How far a coordinate is from the nearest value with 3 decimals or fewer, in seconds of arc (0.001° is 3.6"). */
const secondsFromThreeDecimals = (v: number): number => Math.abs(v * 1000 - Math.round(v * 1000)) * 3.6;

/**
 * Degrees, minutes and seconds that are a pair with fewer than 4 decimals written another way (A5
 * sixth review, the owner's rule and "Same rule everywhere"): both coordinates within 0.05" (half the
 * tenth of a second Google writes) of a value with 3 decimals or fewer. Google Maps shows a searched
 * "23.58, 58.41" as 23°34'48.0"N 58°24'36.0"E, and a value with 3 decimals is always a whole number of
 * tenths of a second (0.001° is 3.6"), so the text alone looked exact. A real point written to a tenth
 * of a second lands there on both coordinates about once in 1,300 (once in 36 per coordinate), in whole
 * seconds once in 324; its pin is then placed by hand. One coordinate alone is not enough: a real
 * point does that once in 36.
 */
function dmsIsRoughPair(lat: number, lng: number): boolean {
  return secondsFromThreeDecimals(lat) < 0.05 && secondsFromThreeDecimals(lng) < 0.05;
}

function pairFrom(text: string): { lat: string; lng: string } | null {
  const m = new RegExp(`^\\s*(${NUM})\\s*[,;\\s]\\s*\\+?(${NUM})\\s*$`).exec(text);
  return m ? { lat: m[1], lng: m[2] } : null;
}

function withValidation(
  lat: number,
  lng: number,
  base: {
    source: LocationSourceKind;
    confidence: Confidence;
    needsPin?: boolean;
    warnings?: string[];
    resolvedUrl?: string;
    /** Decimals of a written pair as counted (`pairPrecision`); none for a point nobody wrote as decimals. */
    precision?: number;
    zerosCut?: boolean;
  },
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
      warnings.push('Latitude and longitude looked swapped; they were swapped back.');
      [lat, lng] = [lng, lat];
      needsPin = true;
      // Never raises a lower confidence (whole-degree DMS stays LOW).
      if (confidence === 'HIGH') confidence = 'MEDIUM';
    } else {
      warnings.push('This point is outside the delivery area (Oman/UAE).');
      needsPin = true;
      confidence = 'LOW';
    }
  }
  if (base.precision !== undefined && base.precision < 4) {
    warnings.push(base.zerosCut ? FEW_DECIMALS_ZEROS_WARNING : FEW_DECIMALS_WARNING);
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
      { source: 'MANUAL_LATLNG', confidence: 'HIGH', ...pairPrecision(pair.lat, pair.lng) }, area);
  }
  // 2. DMS
  const dmsPlain = parseDms(input);
  if (dmsPlain && !/^https?:/i.test(input)) {
    if ('error' in dmsPlain) return fail(dmsPlain.error);
    return withValidation(dmsPlain.lat, dmsPlain.lng, { source: 'MANUAL_LATLNG', ...dmsBase(dmsPlain) }, area);
  }
  // 3. geo: URI
  const geo = new RegExp(`^geo:(${NUM}),(${NUM})`, 'i').exec(input);
  if (geo) {
    return withValidation(Number(geo[1]), Number(geo[2]),
      { source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', ...pairPrecision(geo[1], geo[2]) }, area);
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
  return withValidation(d.lat, d.lng, { source: 'GOOGLE_MAPS_URL', ...dmsBase(d), resolvedUrl }, area);
}

const MAP_CENTRE_WARNING = 'This link only gives the map centre, not a pin.';
const DIRECTIONS_NO_POINT = 'This directions link does not end at a point, so it does not say where the customer is.';

/**
 * Query keys that hold the centre of the map view, not a marker: `ll` (classic links; Google shows
 * no pin there), `center` and `sll`. Read as MEDIUM and always need a pin (A5 third review: `ll` was
 * read as an exact point, HIGH, and saved as read).
 */
const CENTRE_KEYS = new Set(['ll', 'center', 'sll']);

/**
 * The waypoints of a directions link, /maps/dir/<start>/<stops>/<end>/@centre/data=..., in route
 * order (decoded; an empty one is a box left blank), or null when the link is not a directions link.
 * Only the LAST one is where the route ends. Google puts the start in the path as coordinates when
 * the route starts at "Your location" or at a dropped pin, so any earlier waypoint can be the
 * dispatcher's or the salesman's own position (A5 third review). One waypoint alone is the start
 * (Google's own "directions to here" link leaves the start blank: /dir//<point>).
 */
function directionsWaypoints(url: URL): string[] | null {
  const m = /^(?:\/maps)?\/dir(?:\/(.*))?$/.exec(url.pathname);
  if (!m) return null;
  const parts = (m[1] ?? '').split('/');
  const end = parts.findIndex((p) => p.startsWith('@') || p.startsWith('data='));
  const slots = end < 0 ? parts : parts.slice(0, end);
  // "/dir/A/B/": the last slash ends the path, it is not a blank waypoint.
  if (end < 0 && slots.length > 1 && slots[slots.length - 1] === '') slots.pop();
  return slots.map((s) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' ')).trim();
    } catch {
      return s.trim();
    }
  });
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
  const dir = directionsWaypoints(url);

  // Place pin: !3d<lat>!4d<lng> (the actual marker). Not on a directions link: its data part does not
  // say which waypoint a point belongs to. It needs 4 decimals like any pair (A5 sixth review): Google
  // repeats a coordinate searched for as the pin, so a searched "23.58, 58.41" (or "23.5800, 58.4100":
  // Google drops the zeros at the end) comes back as !3d23.58!4d58.41. Its digits are counted as Google
  // wrote them, the zeros at the end not cut (Google writes none; a real marker has 6 or 7 decimals).
  const pin = dir ? null : new RegExp(`!3d(${NUM})!4d(${NUM})`).exec(full);
  if (pin) {
    return withValidation(Number(pin[1]), Number(pin[2]), {
      source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', precision: Math.min(decimals(pin[1]), decimals(pin[2])), resolvedUrl,
    }, area);
  }
  // Explicit coordinate query parameters.
  for (const key of ['q', 'query', 'll', 'destination', 'daddr', 'center', 'sll']) {
    const v = url.searchParams.get(key);
    if (!v) continue;
    const p = pairFrom(v.replace(/^loc:/i, ''));
    if (p) {
      const centre = CENTRE_KEYS.has(key);
      return withValidation(Number(p.lat), Number(p.lng), {
        source: 'GOOGLE_MAPS_URL',
        confidence: centre ? 'MEDIUM' : 'HIGH',
        needsPin: centre,
        warnings: centre ? [MAP_CENTRE_WARNING] : [],
        ...pairPrecision(p.lat, p.lng),
        resolvedUrl,
      }, area);
    }
    const d = parseDms(v);
    if (d) return dmsResult(d, resolvedUrl, area);
  }
  if (dir) {
    // A directions link: only the end of the route can be the customer. It is read when it is a
    // point and something comes before it (a start, even a blank one); never another waypoint.
    const last = dir[dir.length - 1] ?? '';
    const p = dir.length >= 2 ? pairFrom(last) : null;
    if (p) {
      return withValidation(Number(p.lat), Number(p.lng), {
        source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', ...pairPrecision(p.lat, p.lng), resolvedUrl,
      }, area);
    }
    const d = dir.length >= 2 && last ? parseDms(last) : null;
    if (d) return dmsResult(d, resolvedUrl, area);
  } else {
    // Coordinates in the path: /search/23.58,+58.40  /place/23.58,58.40
    const pathPair = new RegExp(`/(?:search|place)/(${NUM}),\\s*\\+?(${NUM})(?:[/?@]|$)`).exec(full);
    if (pathPair) {
      return withValidation(Number(pathPair[1]), Number(pathPair[2]), {
        source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', ...pairPrecision(pathPair[1], pathPair[2]), resolvedUrl,
      }, area);
    }
    const pathDms = /\/(?:search|place)\/([^/@?]+)/.exec(full);
    if (pathDms) {
      const d = parseDms(pathDms[1]);
      if (d) return dmsResult(d, resolvedUrl, area);
    }
  }
  // Map viewport centre: /@lat,lng,17z - NOT necessarily where the customer is.
  const at = new RegExp(`@(${NUM}),(${NUM})(?:,[\\d.]+[zm])?`).exec(full);
  if (at) {
    return withValidation(Number(at[1]), Number(at[2]), {
      source: 'GOOGLE_MAPS_URL',
      confidence: 'MEDIUM',
      needsPin: true,
      warnings: dir ? [`${DIRECTIONS_NO_POINT} The pin shows the map centre. Drop the pin on the customer's exact location.`] : [MAP_CENTRE_WARNING],
      resolvedUrl,
    }, area);
  }
  if (dir) return fail(`${DIRECTIONS_NO_POINT} Drop a pin on the map instead.`, { resolvedUrl });
  return fail('This Google Maps link does not contain coordinates (it only names a place). Drop a pin on the map instead.', { resolvedUrl });
}

/**
 * The owner's standing rule (27 Sep 2026, audit PR A5): "locations should always be correct ... no
 * item will be delivered without location". A reading that needs a pin (`needsPin`: every LOW
 * reading and the MEDIUM ones - map centre, fewer than 4 decimals, degrees and minutes only, swapped,
 * outside the delivery area) is never saved as read: the dispatcher places the pin by hand.
 */
export const PIN_REQUIRED_MESSAGE = "This reading is not exact. Drop the pin on the customer's exact location, then save.";
/**
 * The same, when the zeros at the end made the difference (owner decision of 28 Sep 2026, "Same rule
 * everywhere"): the reason is said plainly, since the text on screen looks like 4 decimals.
 */
export const ZEROS_PIN_REQUIRED_MESSAGE = `${FEW_DECIMALS_ZEROS_WARNING} Drop the pin on the customer's exact location.`;

/** What to do with a reading that needs a pin (ADD LOCATION's note and the server's 422 say the same). */
export function notExactMessage(p: { warnings?: string[] }): string {
  return p.warnings?.includes(FEW_DECIMALS_ZEROS_WARNING) ? ZEROS_PIN_REQUIRED_MESSAGE : PIN_REQUIRED_MESSAGE;
}
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
export function pinRequiredMessage(p: Pick<LocationParse, 'ok' | 'error'> & { warnings?: string[] }): string {
  if (p.ok) return notExactMessage(p);
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
