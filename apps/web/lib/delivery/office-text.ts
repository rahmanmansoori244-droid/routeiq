/**
 * The words the office side uses for delivery results (owner request 4 Oct 2026, Part 3). Pure and
 * browser-safe: the plan screen's results, the Record outcome dialog, the day screen's Deliveries card,
 * Bring forward and the actuals Excel all read these, so the same fact never reads two ways.
 */
import { DICT } from '../driver-page/i18n';
import { NOT_DELIVERED_REASONS, type NotDeliveredReasonName } from '../driver-link/manifest-types';

/** "Shop closed", "Wrong location or could not find", ... (the driver page's English labels). */
export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'no reason';
  return (NOT_DELIVERED_REASONS as readonly string[]).includes(reason) ? DICT.en[`r.${reason as NotDeliveredReasonName}`] : reason;
}

/** The reason as Bring forward and the overlay say it: "Shop closed", "Other - gate locked". */
export function reasonText(reason: string | null | undefined, note: string | null | undefined): string {
  const n = (note ?? '').trim();
  if (reason === 'OTHER') return n ? `Other - ${n}` : 'Other';
  return reasonLabel(reason);
}

/** Who recorded it: "driver", "dispatcher", "Ayun", "RouteIQ". */
export function sourceWord(source: string | null | undefined): string {
  switch (source) {
    case 'PHONE_AUTO':
    case 'PHONE_MANUAL':
      return 'driver';
    case 'DISPATCHER':
      return 'dispatcher';
    case 'AYUN':
      return 'Ayun';
    case 'SYSTEM':
      return 'RouteIQ';
    default:
      return 'unknown';
  }
}

export const OUTCOME_LABEL: Record<string, string> = {
  DELIVERED: 'Delivered',
  PARTLY_DELIVERED: 'Partly delivered',
  NOT_DELIVERED: 'Not delivered',
};

/** One recorded shortfall as Bring forward lists it (spec section 9.1 item 4). */
export function shortfallText(s: { outcome: string; notDelivered: number; planned: number; reason: string | null; note: string | null; source: string | null }): string {
  const why = `${reasonText(s.reason, s.note)} (${sourceWord(s.source)})`;
  if (s.outcome === 'PARTLY_DELIVERED') return `Partly delivered: ${s.notDelivered} of ${s.planned} cases not delivered: ${why}`;
  return `Not delivered: ${why}`;
}

/** "no photo: camera failed (driver)" / "no photo (office)" / null when photos exist or are not needed. */
export function noPhotoText(v: { outcome: string | null; noPhotoReason: string | null; outcomeSource: string | null; photoCount: number }): string | null {
  if (!v.outcome || v.outcome === 'NOT_DELIVERED' || v.photoCount > 0) return null;
  if (v.noPhotoReason === 'CAMERA_FAILED') return 'no photo: camera failed (driver)';
  if (v.outcomeSource === 'DISPATCHER') return 'no photo (office)';
  return null;
}

/** How an arrival was recorded, for the plan screen and the Excel ("Arrival by"). */
export function arrivalByText(source: string | null, observed: boolean): string {
  switch (source) {
    case 'PHONE_AUTO':
      return observed ? 'Auto' : 'Auto, not observed';
    case 'PHONE_MANUAL':
      return 'Manual';
    case 'DISPATCHER':
      return 'Office';
    case 'AYUN':
      return 'Ayun';
    default:
      return '';
  }
}

/** The note under an arrival time: "manual", "set by office", "arrival not observed (page opened at the shop)". */
export function arrivalNote(source: string | null, observed: boolean): string | null {
  if (source === 'PHONE_MANUAL') return 'manual';
  if (source === 'DISPATCHER') return 'set by office';
  if ((source === 'PHONE_AUTO' || source === 'AYUN') && !observed) return 'arrival not observed (page opened at the shop)';
  return null;
}

/** The note under a departure time: "result time" / "not observed". */
export function departureNote(atOutcome: boolean, gap: boolean): string | null {
  if (atOutcome) return 'result time';
  if (gap) return 'not observed';
  return null;
}

/** "Timed by" in the Excel. */
export function timedByText(v: { autoBasis: string | null; arrivalSource: string | null; departedAtOutcome: boolean; outcomeSource: string | null }): string {
  if (v.autoBasis === 'DEPARTURE') return 'Auto to departure';
  if (v.autoBasis === 'RESULT') return 'Auto to result';
  if (v.arrivalSource === 'DISPATCHER' || (v.departedAtOutcome && v.outcomeSource === 'DISPATCHER')) return 'Office';
  if (v.departedAtOutcome) return 'Result time';
  if (v.arrivalSource) return 'Manual';
  return '';
}

export const POSITION_TEXT: Record<string, string> = {
  OK: 'OK',
  POOR: 'poor',
  DENIED: 'off',
  TIMEOUT: 'timed out',
  UNSUPPORTED: 'not available',
};

/** The photo viewer's location line: "38 m from pin" or "no location: location off / timed out / poor signal". */
export function photoPlaceText(p: { positionStatus: string; distanceM: number | null }): string {
  if (p.positionStatus === 'OK' && p.distanceM !== null) return `${Math.round(p.distanceM)} m from pin`;
  if (p.positionStatus === 'POOR') return p.distanceM !== null ? `about ${Math.round(p.distanceM)} m from pin (poor signal)` : 'no location: poor signal';
  if (p.positionStatus === 'DENIED') return 'no location: location off';
  if (p.positionStatus === 'TIMEOUT') return 'no location: timed out';
  return 'no location';
}
