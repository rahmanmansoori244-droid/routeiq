/**
 * A customer file's lat / lng pair under the owner's location rule (27 Sep 2026, audit PR A5: "locations
 * should always be correct ... no item will be delivered without location"). Pure, shared by the
 * customer import and its tests.
 *
 * The pair is read like ADD LOCATION reads "lat, lng" (`parseLocationInput`, the text as written, so its
 * decimals count, with the company's delivery area). An exact reading is stored; one that needs a pin
 * is never stored as a usable location, and the import says why in its own words (the Read dialog's
 * warnings talk about a pin and a map the import screen does not have, A5 review).
 *
 * A customer that already has a saved point, not confirmed by a dispatcher, keeps it only when the
 * file's pair points at the same place within the file's own precision (23.586 stands for 23.5855 to
 * 23.5865), or within 150 m. Otherwise the file contradicts it (the customer moved, or one of the two
 * is wrong): the saved point stays on the map but is marked LOW, which blocks planning until a
 * dispatcher drops the pin by hand (`locationBlocksDelivery`, A5 review).
 */
import { decimalPlaces, parseLocationInput, type ServiceArea } from './location-input';
import { coordStatus } from './customer-attrs';
import { distanceM } from './snapshots';

export interface ImportedPair {
  /** The point to store (an exact reading, HIGH); null = nothing is stored. */
  point: { lat: number; lng: number } | null;
  /** Why nothing is stored, in the import's words; null when the point is stored. */
  reason: string | null;
  /** Where the file points (latitude and longitude put back the right way), when it is a point at all. */
  filePoint: { lat: number; lng: number } | null;
  /** How far the file's point may be from what it stands for, per axis, in degrees (half a unit of its last decimal). */
  tolerance: { lat: number; lng: number } | null;
}

export const IMPORT_REASON = {
  ZERO: '0,0 is not a location.',
  UNREADABLE: 'These numbers are not a location.',
  SWAPPED: 'Latitude and longitude look swapped.',
  OUTSIDE: 'Outside the delivery area.',
  FEW_DECIMALS: 'Fewer than 4 decimals.',
} as const;

/** A saved point this close to the file's point is the same place, whatever the decimals (GPS noise). */
export const SAME_PLACE_M = 150;

const halfUnit = (text: string) => 0.5 * 10 ** -decimalPlaces(text);

/** Read a file's pair (both cells already checked to be numbers in range). */
export function readImportedPair(latText: string, lngText: string, area: ServiceArea): ImportedPair {
  const p = parseLocationInput(`${latText.trim()}, ${lngText.trim()}`, area);
  if (!p.ok || p.lat === undefined || p.lng === undefined) {
    const zero = Number(latText) === 0 && Number(lngText) === 0;
    return { point: null, reason: zero ? IMPORT_REASON.ZERO : IMPORT_REASON.UNREADABLE, filePoint: null, tolerance: null };
  }
  // The parser puts a swapped pair back the right way round (only when the swapped point is in the area).
  const swapped = Math.abs(p.lat - Number(latText)) > 1e-5;
  const filePoint = { lat: p.lat, lng: p.lng };
  const tolerance = swapped ? { lat: halfUnit(lngText), lng: halfUnit(latText) } : { lat: halfUnit(latText), lng: halfUnit(lngText) };
  if (!p.needsPin) return { point: filePoint, reason: null, filePoint, tolerance };
  const reasons: string[] = [];
  if (swapped) reasons.push(IMPORT_REASON.SWAPPED);
  else if (coordStatus(p.lat, p.lng, area) === 'OUTSIDE_AREA') reasons.push(IMPORT_REASON.OUTSIDE);
  if (Math.min(decimalPlaces(latText), decimalPlaces(lngText)) < 4) reasons.push(IMPORT_REASON.FEW_DECIMALS);
  return { point: null, reason: reasons.join(' ') || 'Not exact.', filePoint, tolerance };
}

/**
 * Does the file's pair (not stored: it needs a pin) point at the customer's saved point? Yes within the
 * file's own precision on each axis, or within SAME_PLACE_M. A pair that is no point at all (0,0) says
 * nothing about the saved point, like a blank cell.
 */
export function fileAgreesWithSaved(pair: ImportedPair, saved: { lat: number; lng: number }): boolean {
  if (!pair.filePoint || !pair.tolerance) return true;
  const eps = 1e-6; // the parser rounds to 6 decimals
  const withinPrecision =
    Math.abs(pair.filePoint.lat - saved.lat) <= pair.tolerance.lat + eps && Math.abs(pair.filePoint.lng - saved.lng) <= pair.tolerance.lng + eps;
  return withinPrecision || distanceM(pair.filePoint, saved) <= SAME_PLACE_M;
}

/** "about 600 m", "about 3.4 km", "about 12 km", "about 1,216 km". */
export function aboutDistance(m: number): string {
  if (m < 1000) return `about ${Math.max(10, Math.round(m / 10) * 10)} m`;
  const km = m / 1000;
  return km < 10 ? `about ${km.toFixed(1)} km` : `about ${Math.round(km).toLocaleString('en-US')} km`;
}

/** The sentence added to the row's reason when the file contradicts the saved point. */
export function pointsElsewhereText(pair: ImportedPair, saved: { lat: number; lng: number }): string {
  return pair.filePoint ? `The file points ${aboutDistance(distanceM(pair.filePoint, saved))} from the saved location.` : '';
}
