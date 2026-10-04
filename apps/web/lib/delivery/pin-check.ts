/**
 * "Pin may be wrong" (owner request 4 Oct 2026, spec section 11.2, D9b). Pure: the server reads the
 * visits and the photo points, this decides. The list is for the company admin on the Customers page;
 * the location lock stays - the admin opens the customer and uses Set location. No pin is ever moved
 * automatically.
 *
 * A visit's evidence point (accuracy 100 m or better), in this order: the median of its photo points
 * with position status OK (Geolocation, else EXIF); else its manual arrival point; else its result
 * point. An automatic arrival is never evidence (it is inside the radius by construction). A visit
 * with unverified timing is left out, and so is a visit planned at an older pin (its planned pin is
 * more than PIN_MOVED_M from the customer's pin now: that pin was corrected already). After the
 * location retention only the stored distances remain: they still count for the flag, but the
 * suggested point is built only from points still kept.
 *
 * A visit is far when its evidence is more than 150 m from the visit's planned pin, or the driver said
 * "Wrong location or could not find". A customer is flagged when at least 2 of its last 3 visits with
 * evidence are far.
 */
import { distanceM, PIN_MOVED_M } from '../dispatch/snapshots';
import { median } from './measured';

export const PIN_FAR_M = 150;
export const EVIDENCE_MAX_ACCURACY_M = 100;
export const PIN_CHECK_LAST = 3;
export const PIN_CHECK_FAR_NEEDED = 2;

export interface PinPoint {
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  /** Distance from the visit's planned pin, kept after the location retention erased lat/lng. */
  distanceM: number | null;
  /** The location retention erased the point and its accuracy: only the distance is left (it still counts). */
  purged?: boolean;
}

export interface PinPhoto extends PinPoint {
  positionStatus: string;
  exifLat?: number | null;
  exifLng?: number | null;
  exifDistanceM?: number | null;
}

export interface PinVisit {
  visitId: string;
  customerId: string;
  /** YYYY-MM-DD */
  deliveryDate: string;
  plannedLat: number | null;
  plannedLng: number | null;
  timingSuspect: boolean;
  reason: string | null;
  photos: PinPhoto[];
  /** The point of a manual (driver-tapped) arrival, else null. */
  manualArrival: PinPoint | null;
  /** The point of the result, else null. */
  result: PinPoint | null;
}

export interface Evidence {
  /** Distance from the planned pin (m). */
  distanceM: number;
  /** The point itself, when it is still kept (null after the location retention). */
  point: { lat: number; lng: number } | null;
  source: 'PHOTO' | 'ARRIVAL' | 'RESULT';
}

/** A point that may be evidence: accurate enough, or (after the retention) its stored distance. */
const usable = (p: PinPoint | null | undefined): boolean =>
  !!p &&
  (p.purged
    ? p.distanceM !== null
    : p.accuracyM !== null && p.accuracyM <= EVIDENCE_MAX_ACCURACY_M && (p.distanceM !== null || (p.lat !== null && p.lng !== null)));

/** The visit's evidence point (spec section 11.2), or null. */
export function evidenceOf(v: PinVisit): Evidence | null {
  const pin = v.plannedLat !== null && v.plannedLng !== null ? { lat: v.plannedLat, lng: v.plannedLng } : null;
  const distOf = (p: { lat: number | null; lng: number | null; distanceM: number | null }) =>
    p.lat !== null && p.lng !== null && pin ? distanceM({ lat: p.lat, lng: p.lng }, pin) : p.distanceM;
  // 1. Photos with an OK position: Geolocation, else EXIF.
  const photoPoints = v.photos
    .filter((ph) => ph.positionStatus === 'OK')
    .flatMap((ph) => {
      if (usable(ph)) return [{ lat: ph.lat, lng: ph.lng, d: distOf(ph) }];
      if (ph.exifLat != null && ph.exifLng != null) return [{ lat: ph.exifLat, lng: ph.exifLng, d: pin ? distanceM({ lat: ph.exifLat, lng: ph.exifLng }, pin) : (ph.exifDistanceM ?? null) }];
      if (ph.exifDistanceM != null) return [{ lat: null, lng: null, d: ph.exifDistanceM }];
      return [];
    })
    .filter((p): p is { lat: number | null; lng: number | null; d: number } => p.d !== null);
  if (photoPoints.length) {
    const kept = photoPoints.filter((p): p is { lat: number; lng: number; d: number } => p.lat !== null && p.lng !== null);
    return {
      distanceM: median(photoPoints.map((p) => p.d)),
      point: kept.length ? { lat: median(kept.map((p) => p.lat)), lng: median(kept.map((p) => p.lng)) } : null,
      source: 'PHOTO',
    };
  }
  // 2. A manual arrival, 3. the result.
  for (const [p, source] of [
    [v.manualArrival, 'ARRIVAL'],
    [v.result, 'RESULT'],
  ] as const) {
    if (!p || !usable(p)) continue;
    const d = distOf(p);
    if (d === null) continue;
    return { distanceM: d, point: p.lat !== null && p.lng !== null ? { lat: p.lat, lng: p.lng } : null, source };
  }
  return null;
}

export interface PinFlag {
  customerId: string;
  /** The far visits among the last 3 with evidence: date, distance (m, rounded) and whether the driver said wrong location. */
  far: { date: string; distanceM: number | null; wrongLocation: boolean }[];
  /** "Driver said: wrong location (3 Oct)" dates. */
  wrongLocationDates: string[];
  /** The median of the far evidence points still kept, or null. */
  suggested: { lat: number; lng: number } | null;
}

/**
 * The customers whose pin may be wrong. `visits`: their visits (any order); `pins`: each customer's
 * pin now (a visit planned more than PIN_MOVED_M from it is left out: corrected since).
 */
export function pinCheck(visits: readonly PinVisit[], pins: ReadonlyMap<string, { lat: number | null; lng: number | null }>): PinFlag[] {
  const byCustomer = new Map<string, PinVisit[]>();
  for (const v of visits) byCustomer.set(v.customerId, [...(byCustomer.get(v.customerId) ?? []), v]);
  const out: PinFlag[] = [];
  for (const [customerId, list] of byCustomer) {
    const now = pins.get(customerId);
    const current = (v: PinVisit) =>
      !now || now.lat === null || now.lng === null || v.plannedLat === null || v.plannedLng === null || distanceM({ lat: v.plannedLat, lng: v.plannedLng }, { lat: now.lat, lng: now.lng }) <= PIN_MOVED_M;
    const withEvidence = list
      .filter((v) => !v.timingSuspect && current(v))
      .map((v) => ({ v, e: evidenceOf(v) }))
      .filter((x) => x.e !== null || x.v.reason === 'WRONG_LOCATION')
      .sort((a, b) => b.v.deliveryDate.localeCompare(a.v.deliveryDate) || b.v.visitId.localeCompare(a.v.visitId))
      .slice(0, PIN_CHECK_LAST);
    const far = withEvidence.filter((x) => x.v.reason === 'WRONG_LOCATION' || (x.e !== null && x.e.distanceM > PIN_FAR_M));
    if (far.length < PIN_CHECK_FAR_NEEDED) continue;
    const points = far.flatMap((x) => (x.e?.point && x.e.distanceM > PIN_FAR_M ? [x.e.point] : []));
    out.push({
      customerId,
      far: far.map((x) => ({ date: x.v.deliveryDate, distanceM: x.e ? Math.round(x.e.distanceM) : null, wrongLocation: x.v.reason === 'WRONG_LOCATION' })),
      wrongLocationDates: far.filter((x) => x.v.reason === 'WRONG_LOCATION').map((x) => x.v.deliveryDate),
      suggested: points.length ? { lat: median(points.map((p) => p.lat)), lng: median(points.map((p) => p.lng)) } : null,
    });
  }
  return out.sort((a, b) => b.far.length - a.far.length || a.customerId.localeCompare(b.customerId));
}

/** A Google Maps link to a suggested point (the admin checks it, then uses Set location). */
export function suggestedMapsUrl(p: { lat: number; lng: number }): string {
  return `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}
