/**
 * The words the office side uses for delivery results (owner request 4 Oct 2026, Part 3). Pure and
 * browser-safe: the plan screen's results, the Record outcome dialog, the day screen's Deliveries card,
 * Bring forward and the actuals Excel all read these, so the same fact never reads two ways.
 */
import { DICT } from '../driver-page/i18n';
import { NOT_DELIVERED_REASONS, type NotDeliveredReasonName } from '../driver-link/manifest-types';
import { addDaysIso, daysBetween, fmtHhmm, localMinutes } from '../dispatch/time';

/** "1 stop" / "2 stops" / "0 stops" (`many` for a plural that is not just an s). */
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Record outcome's Arrived / Left boxes start with the stored times (HH:MM, company time), so the
 * dispatcher sees what a correction replaces. A "Left" that is only the result time is not shown.
 */
export function officeTimesPrefill(v: { arrivedAt: string | null; departedAt: string | null; departedAtOutcome: boolean } | null, tz: string): { arrived: string; left: string } {
  const hhmm = (iso: string | null) => (iso ? fmtHhmm(localMinutes(new Date(iso), tz)) : '');
  return { arrived: hhmm(v?.arrivedAt ?? null), left: v && !v.departedAtOutcome ? hhmm(v.departedAt) : '' };
}

/** The Arrived / Left to send: only the boxes the dispatcher changed (a box left as stored records nothing). */
export function officeTimesToSend(typed: { arrived: string; left: string }, shown: { arrived: string; left: string }): { arrivedAt: string | null; departedAt: string | null } {
  const a = typed.arrived.trim();
  const l = typed.left.trim();
  return { arrivedAt: a && a !== shown.arrived ? a : null, departedAt: l && l !== shown.left ? l : null };
}

/** The "Delivery actuals" Excel covers at most this many days at a time. */
export const ACTUALS_MAX_DAYS = 31;

/** The default range of the Deliveries card's range picker: the 7 days up to the day on screen. */
export function actualsDefaultRange(dateIso: string): { from: string; to: string } {
  return { from: addDaysIso(dateIso, -6), to: dateIso };
}

/** Why a From / To range cannot be downloaded, or null (the same rules as the route). */
export function actualsRangeProblem(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 'Choose both dates.';
  if (to < from) return '"To" must not be before "From".';
  if (daysBetween(from, to) + 1 > ACTUALS_MAX_DAYS) return `At most ${ACTUALS_MAX_DAYS} days at a time.`;
  return null;
}

/** GET /api/dispatch/delivery-actuals for a range and a depot. */
export function actualsUrl(from: string, to: string, depotId: string | null): string {
  const q = new URLSearchParams({ from, to });
  if (depotId) q.set('depotId', depotId);
  return `/api/dispatch/delivery-actuals?${q}`;
}

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
export function timedByText(v: { autoBasis: string | null; arrivalSource: string | null; departureSource?: string | null; departedAtOutcome: boolean; outcomeSource: string | null }): string {
  if (v.autoBasis === 'DEPARTURE') return 'Auto to departure';
  if (v.autoBasis === 'RESULT') return 'Auto to result';
  if (v.arrivalSource === 'DISPATCHER' || v.departureSource === 'DISPATCHER' || (v.departedAtOutcome && v.outcomeSource === 'DISPATCHER')) return 'Office';
  if (v.departedAtOutcome) return 'Result time';
  if (v.arrivalSource) return 'Manual';
  return '';
}

const minutesBetween = (a: Date, b: Date) => Math.round(((b.getTime() - a.getTime()) / 60_000) * 10) / 10;

/**
 * Actual unloading of a visit (spec section 10.1), the plan screen's and the actuals Excel's: automatic
 * from the window start, else automatic, else arrival to departure (an office or manual timing).
 */
export function actualMinutes(v: {
  autoServiceMinutes: number | null;
  autoMinutes: number | null;
  arrivedAt: Date | null;
  departedAt: Date | null;
  departedAtOutcome: boolean;
  outcomeSource: string | null;
}): { min: number | null; label: string | null; auto: boolean } {
  if (v.autoServiceMinutes !== null) return { min: v.autoServiceMinutes, label: 'auto, from the window start', auto: true };
  if (v.autoMinutes !== null) return { min: v.autoMinutes, label: 'auto', auto: true };
  // An office result recorded later is not the end of the stop.
  if (v.arrivedAt && v.departedAt && v.departedAt > v.arrivedAt && !(v.departedAtOutcome && v.outcomeSource === 'DISPATCHER')) {
    return { min: minutesBetween(v.arrivedAt, v.departedAt), label: v.departedAtOutcome ? 'arrival to result' : 'arrival to departure', auto: false };
  }
  return { min: null, label: null, auto: false };
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
