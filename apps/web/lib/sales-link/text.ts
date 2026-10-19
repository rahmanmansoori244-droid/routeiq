/**
 * The salesman link's words (owner request 19 Oct 2026). Pure and browser-safe. Plain English for a busy
 * salesman on a phone; every time is the company's clock ("10:45", " +1" after midnight). Kept in one module
 * so an Arabic version can follow the same keys later (lib/driver-page/i18n.ts is the pattern).
 *
 * Never in these texts: a driver's name or phone, a customer's phone or notes, the office's cancel note or
 * the driver's free-text note (only the reason's label), money, a link.
 */
import { fmtDayMonth, fmtHhmm } from '../dispatch/time';
import { orderActionReasonText } from '../dispatch/order-cancel-rules';
import { reasonLabel } from '../delivery/office-text';
import { explicitTruck } from './route-code';
import type { DeliveryStatus, EtaSource, OffTruckKind } from './view-types';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-10-19" -> "Sun 19 Oct" (the weekday from the date itself: no time zone involved). */
export function shortDayText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const wd = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay();
  return `${WEEKDAY_SHORT[wd]} ${fmtDayMonth(iso)}`;
}

/** Rounded to 5 minutes ("about 10:45"). */
export const round5 = (min: number): number => Math.round(min / 5) * 5;
/** Up to the next 5 minutes. */
export const ceil5 = (min: number): number => Math.ceil(min / 5) * 5;

/** "10:45", "00:30 +1": minutes of the delivery day. */
export const hhmm = (min: number): string => fmtHhmm(min);

/** "Works until Mon 20 Oct 06:00" (the link's end, in the company's time on the day after delivery). */
export function expiryText(dateIso: string, endIso: string, endHour: number): string {
  return `Works until ${shortDayText(endIso)} ${String(endHour).padStart(2, '0')}:00`;
}

/** The hint under the route field. */
export const ROUTE_HINT = 'Your route code (as on your Salesman ETA page) or a truck code';

/** The WhatsApp message the office sends to the salesmen's group (no link preview data: the page is an empty shell). */
export function salesLinkMessage(o: { dayShort: string; company: string; url: string; expiryText: string }): string {
  return [
    `RouteIQ - live deliveries for ${o.dayShort} (${o.company}): ${o.url}`,
    "Open it, type your route code (as on your Salesman ETA page) and see each customer's delivery: delivered, on the way with the expected time, delayed, not delivered or cancelled.",
    `${o.expiryText}. For the sales team only - please do not forward.`,
  ].join('\n');
}

/**
 * "No deliveries for route or truck R9 on Sun 19 Oct. Check the route code on your Salesman ETA page, or the truck
 * code."; an explicit truck form ("TRUCK 1234") is said as "truck 1234".
 */
export function notFoundText(codes: readonly string[], dayShort: string): string | null {
  if (!codes.length) return null;
  const trucks: string[] = [];
  const plain: string[] = [];
  for (const c of codes) {
    const t = explicitTruck(c);
    if (t !== null) trucks.push(t);
    else plain.push(c);
  }
  const which = [
    plain.length ? `${plain.length === 1 ? 'route or truck' : 'routes or trucks'} ${plain.join(', ')}` : null,
    trucks.length ? `${trucks.length === 1 ? 'truck' : 'trucks'} ${trucks.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' or ');
  return `No deliveries for ${which} on ${dayShort}. Check the route code on your Salesman ETA page, or the truck code.`;
}

/** The line above the trucks offered for a code: several trucks with its digits, or a route code that is also a truck's. */
export function choiceText(kind: 'SEVERAL_TRUCKS' | 'ALSO_TRUCK', asked: string, trucks: number): string {
  return kind === 'SEVERAL_TRUCKS' ? `${asked} matches ${trucks} trucks today. Pick one:` : `${asked} is also a truck code. Show the truck instead:`;
}

/** The status chip's words. */
export const STATUS_TEXT: Record<DeliveryStatus, string> = {
  DELIVERED: 'Delivered',
  PARTLY_DELIVERED: 'Partly delivered',
  NOT_DELIVERED: 'Not delivered',
  NO_RESULT: 'No result recorded',
  VISITED: 'Truck was there',
  AT_CUSTOMER: 'Truck at the customer now',
  NEXT: 'Next stop',
  ON_THE_WAY: 'On the way',
  PASSED: 'Still due',
  LOADING: 'Truck being loaded',
  PLANNED: 'Planned',
  TRUCK_DID_NOT_GO: 'Truck did not go out',
};

/** The heading of each kind of order not on a truck. */
export const OFF_KIND_TEXT: Record<OffTruckKind, string> = {
  CANCELLED: 'Cancelled',
  MOVED: 'Moved to another day',
  NOT_PLANNED: 'Not on a truck',
  PART_NOT_PLANNED: 'Part not on a truck',
  ADDED_AFTER_PLAN: 'Received after planning',
  NOT_PLANNED_YET: 'Not planned yet',
};

export const SOURCE_TEXT: Record<EtaSource, string> = {
  GPS: 'GPS',
  TRIP: 'from the trip so far',
  PLAN: 'as planned',
};

/** Why an order the plan left out is not on a truck, in a salesman's words (not the office's REASON_TEXT). */
export function salesWhy(reasonCode: string | null | undefined): string {
  switch (reasonCode) {
    case 'NO_AVAILABLE_TRUCK':
    case 'EXCEEDS_ANY_TRUCK_CAPACITY':
    case 'EXCEEDS_TRUCK_CAPACITY':
    case 'SHIFT_LIMIT':
    case 'SHIFT_TIME_LIMIT':
    case 'TRIP_LIMIT':
    case 'LATE_ORDER_NO_CAPACITY':
    case 'SOLVER_DROPPED_LOW_PRIORITY':
    case 'LOCKED_PLAN_CONFLICT':
      return 'No room on the trucks for this day';
    case 'HARD_WINDOW_INFEASIBLE':
      return "The customer's receiving hours could not be met";
    case 'MISSING_COORDINATES':
    case 'INVALID_LOCATION':
      return 'Customer location missing or wrong in RouteIQ';
    case 'NO_ALLOWED_TRUCK':
      return 'Needs a small truck; none was free';
    case 'UNKNOWN_CUSTOMER':
    case 'UNKNOWN_PRODUCT':
    case 'INVALID_CUSTOMER':
      return 'Order details need checking by the office';
    default:
      return 'Left out of the plan';
  }
}

export const OFFICE_ADVISES = ' (the office will advise)';
export const NOT_PLANNED_WHY = (reasonCode: string | null | undefined) => `${salesWhy(reasonCode)}${OFFICE_ADVISES}`;
export const PART_NOT_PLANNED_WHY = `Rest of a split delivery - not on a truck on this day${OFFICE_ADVISES}`;
export const ADDED_AFTER_PLAN_WHY = 'Received after planning - the next re-plan adds it';
export const NOT_PLANNED_YET_WHY = 'Not planned yet - the plan is made the evening before';
export const movedWhy = (toIso: string) => `Moved to ${shortDayText(toIso)}`;
/** "Cancelled - Customer cancelled": the reason's label only, never the office's note. */
export const cancelledWhy = (reason: string | null | undefined) => `Cancelled - ${orderActionReasonText(reason ?? null, null)}`;

export const NOT_LOCKED_NOTE = 'Not locked yet: times can change if the day is re-planned';
export const REST_NOT_PLANNED_NOTE = "More of this customer's cases are not on a truck on this day (the office will advise).";
export const movedHereNote = (fromIso: string) => `Moved here from ${shortDayText(fromIso)}`;
export const restMovedNote = (toIso: string) => `Rest moved to ${shortDayText(toIso)}`;

/**
 * The reason of a result that is not a full delivery: the label only ("Shop closed"), with who said so - the
 * owner found the drivers' results of 15 Oct 2026 partly wrong, so the salesman should know it is the driver's word.
 */
export function resultReason(reason: string | null | undefined, outcomeSource: string | null | undefined): string {
  const label = reasonLabel(reason);
  const who = outcomeSource === 'DISPATCHER' ? 'recorded by the office' : 'as reported by the driver';
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} (${who})`;
}

/** "07:45-09:00". */
export const windowText = (from: number, to: number) => `${hhmm(from)}-${hhmm(to)}`;

/** A truck's GPS line. */
export const GPS_NONE_TEXT = "No GPS on this truck - times from the driver's updates";
export const NO_LIVE_TEXT = 'No live updates from this truck';
/** Why a stop is still due (critique 13: never "skipped"). */
export const STILL_DUE_NOTE = 'the driver is serving other customers first';

/**
 * The customer's WhatsApp text (no link): the status and the expected time, else the printed window while it is
 * still ahead (never a window that is over: "later than planned - we will confirm the time"), with the invoices.
 * "The truck has been to you" only when the truck was seen there.
 */
export function shareTextOf(d: {
  customerName: string;
  invoices: readonly string[];
  status: DeliveryStatus;
  dayShort: string;
  window: string | null;
  expected: string | null;
  /** The printed window is over, or the truck can no longer make it. */
  windowOver: boolean;
  /** The truck was seen at the customer (an arrival, a departure or a delivery photo). */
  seen: boolean;
  at: string | null;
  delivered: { cases: number; of: number } | null;
}): string {
  const inv = d.invoices.length ? ` (invoice ${d.invoices.join(', ')})` : '';
  const head = `${d.customerName}: your delivery${inv}`;
  const ready = 'Please have someone ready to receive and sign.';
  const later = 'later than planned - we will confirm the time';
  const when = d.expected ? `expected about ${d.expected}` : d.window && !d.windowOver ? `expected between ${d.window}` : null;
  switch (d.status) {
    case 'DELIVERED':
      return `${head} was delivered${d.at ? ` at ${d.at}` : ''} on ${d.dayShort}.`;
    case 'PARTLY_DELIVERED':
      return `${head} was partly delivered${d.delivered ? ` (${d.delivered.cases} of ${d.delivered.of} cases)` : ''} on ${d.dayShort}. We will contact you about the rest.`;
    case 'NOT_DELIVERED':
      return `${head} could not be delivered on ${d.dayShort}. We will contact you.`;
    case 'NO_RESULT':
    case 'VISITED':
      if (d.status === 'VISITED' || d.seen) return `${head}: the truck has been to you on ${d.dayShort}. Please tell us if anything is missing.`;
      return `${head} of ${d.dayShort}: we are checking its status and will contact you.`;
    case 'AT_CUSTOMER':
      return `${head}: the truck is with you now. ${ready}`;
    case 'NEXT':
    case 'ON_THE_WAY':
    case 'PASSED':
      if (!when && d.windowOver) return `${head} is on the way today, ${later}. ${ready}`;
      return `${head} is on the way${when ? `, ${when}` : ''} today. ${ready}`;
    case 'TRUCK_DID_NOT_GO':
      return `${head} was not delivered on ${d.dayShort}. We will contact you with a new time.`;
    case 'LOADING':
    case 'PLANNED':
    default:
      if (!when && d.windowOver) return `${head} is planned for ${d.dayShort}, ${later}. ${ready}`;
      return `${head} is planned for ${d.dayShort}${when ? `, ${when}` : ''}. ${ready}`;
  }
}
