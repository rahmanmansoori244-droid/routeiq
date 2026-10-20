/**
 * The salesman link's API answer (GET /api/s/view, owner request 19 Oct 2026; the truck lookup: owner decision of
 * 20 Oct 2026; made simple on the owner's feedback of 20 Oct 2026). Browser-safe: types only.
 *
 * Language-neutral: codes, numbers and "HH:MM" times only (the company's time zone, " +1" after midnight); the page
 * says them in English, Arabic or Urdu (lib/sales-page/i18n.ts). Per customer: the name (and branch), ONE status
 * and at most one time. The answer never carries a truck of a delivery, a trip, a stop number, a position, a
 * window, a reason, a note, an invoice, a customer code, an internal id (customer, order, load, truck, run), a
 * driver's name or phone, an IMEI, a customer's phone or address, money, a priority, or customers of a route or
 * truck not asked for: `key` is a per-answer index ("d7", "o2"). How the detailed day becomes these rows:
 * lib/sales-link/simple-view.ts.
 */

/** What a result is: one sales route's deliveries, or one truck's deliveries of the day (every route). */
export type SalesViewKind = 'ROUTE' | 'TRUCK';

/** A link that does not work (404 / 410 / 503 / 403): the page shows it full-page. */
export type SalesLinkStateCode = 'LINK_NOT_FOUND' | 'LINK_REPLACED' | 'LINK_REVOKED' | 'LINK_EXPIRED' | 'SALES_LINKS_OFF' | 'SIGNED_IN_OTHER_TENANT';

/** A refused lookup (400), or too many requests (429, with Retry-After). */
export type SalesQueryErrorCode = 'ROUTE_CODE_MISSING' | 'ROUTE_CODE_TOO_LONG' | 'TOO_MANY_CODES' | 'RATE_LIMITED';

/**
 * The one status of a customer's delivery, each a button on the page:
 * - DELIVERED / PARTLY_DELIVERED / NOT_DELIVERED: the driver's (or the office's) result for this route's lines; a
 *   trip that never left on an earlier day is NOT_DELIVERED;
 * - NOT_CONFIRMED: the truck has been there or its trip is over, and no result was recorded (never said as delivered
 *   or not delivered);
 * - ON_THE_WAY: still to be delivered and not late (planned, being loaded, on the road, being delivered now);
 * - DELAYED: still to be delivered and later than the window printed on the Salesman ETA;
 * - CANCELLED: the order was cancelled;
 * - NOT_IN_PLAN: not on a truck of the day: moved to another day, left out of the plan, or not planned yet.
 */
export type SalesStatus = 'DELIVERED' | 'PARTLY_DELIVERED' | 'NOT_DELIVERED' | 'NOT_CONFIRMED' | 'ON_THE_WAY' | 'DELAYED' | 'CANCELLED' | 'NOT_IN_PLAN';

/** Why a NOT_IN_PLAN order is not on a truck: moved to another day, not planned yet (or received after planning), or left out. */
export type SalesOffKind = 'MOVED' | 'NOT_PLANNED_YET' | 'NOT_IN_PLAN';

/** One customer's delivery (or order not on a truck) of the result. */
export interface SalesRow {
  /** Per answer ("d7": a delivery, "o2": an order not on a truck). */
  key: string;
  /** The customer's name as stored. */
  customer: string;
  branch: string | null;
  status: SalesStatus;
  /** DELIVERED: when ("10:31"); else null. */
  at: string | null;
  /**
   * ON_THE_WAY / DELAYED: the approximate expected arrival ("16:30", rounded to 5 minutes), never a time already
   * past; null when there is none to give (or the truck is at the customer now).
   */
  eta: string | null;
  /** Minutes from now to `eta` on the delivery day itself (0: any minute now); null otherwise. The page rounds it. */
  inMin: number | null;
  /** ON_THE_WAY / DELAYED: the truck is at the customer now (being delivered). */
  atCustomer: boolean;
  /** PARTLY_DELIVERED: the route's cases delivered of its cases; else null. */
  cases: { delivered: number; of: number } | null;
  /** NOT_IN_PLAN: why; else null. */
  off: SalesOffKind | null;
  /** off MOVED: the day it was moved to (YYYY-MM-DD); else null. */
  movedTo: string | null;
}

/** One result of a lookup: a sales route's customers (kind ROUTE) or a truck's customers of the day (kind TRUCK). */
export interface SalesRouteView {
  kind: SalesViewKind;
  /** The route code as stored ("R2X"), or the truck code as the plan shows it ("1234-AB"; a day-hired truck: its plate). */
  code: string;
  /** What the page asks for to refresh this result: the route code ("R2X"), or the truck form ("Truck 1234-AB"). */
  query: string;
  /** When the data was read: "10:32" (company time). */
  updated: string;
  /**
   * The deliveries by time (delivered at, else expected, else planned), then the orders cancelled or not on a truck;
   * one row per customer (and branch) and status: a customer's two deliveries with one status are one row.
   */
  rows: SalesRow[];
}

/** One truck the salesman can pick: its code as shown and the lookup to send when he does. */
export interface SalesChoiceOption {
  /** "1234-AB". */
  code: string;
  /** The whole lookup text to send ("R1, Truck 1234-AB"): what is shown now with this truck added (ALSO_TRUCK: in place of the route). */
  query: string;
}

/**
 * A typed code the page offers trucks for: several trucks have its digits ("5678") or its compact key ("ab1" for AB-1
 * and AB.1): none is shown; or a route code is also a truck's code (the route is shown, the truck offered).
 */
export interface SalesChoice {
  asked: string;
  kind: 'SEVERAL_TRUCKS' | 'ALSO_TRUCK';
  options: SalesChoiceOption[];
}

export interface SalesLookup {
  /** The codes asked for, normalised ("R1", "R2X", "5678", "TRUCK 1234-AB"). */
  asked: string[];
  /** What they matched, routes first (natural order), then trucks (by code); each says its kind. */
  results: SalesRouteView[];
  /** The codes that matched no route and no truck with deliveries that day (unknown or not on that day: the same answer). */
  notFound: string[];
  /** Codes that matched more than one route by the compact key, or trucks whose codes differ in letter case alone (each is in `results`). */
  ambiguous: string[];
  /** Trucks to pick from (several trucks with the compact key or the digits typed; a route code that is also a truck's). */
  choices: SalesChoice[];
}

export interface SalesMeta {
  /** The delivery date, YYYY-MM-DD. */
  date: string;
  /** The company's name. */
  company: string;
  /** When the link stops working (ISO instant: 06:00 company time the day after the delivery date). */
  expiresAt: string;
  /** The company's time zone (every time in the answer is already in it). */
  tz: string;
  /** The server's clock (ISO instant). */
  serverNow: string;
  /** The page refreshes every this many seconds while visible. */
  refreshSec: number;
}

/** GET /api/s/view (no `route`: meta only, lookup null) and GET /api/s/view?route=<codes> (route and truck codes). */
export interface SalesViewAnswer {
  meta: SalesMeta;
  lookup: SalesLookup | null;
}

/** The error object of a refused answer: { data: null, error: SalesErrorBody }. The page says it by `code` in its language. */
export interface SalesErrorBody {
  code: SalesLinkStateCode | SalesQueryErrorCode | string;
  /** English, for API clients and logs. */
  message: string;
  /** LINK_EXPIRED / LINK_REPLACED / LINK_REVOKED: the link's delivery date. */
  date?: string;
}

/**
 * The office's view of a link (GET / POST /api/dispatch/sales-links, PATCH /api/dispatch/sales-links/:id): the plan
 * screen's Salesman link dialog. POST adds `created` (true when made now).
 */
export interface SalesLinkView {
  id: string;
  /** The delivery date, YYYY-MM-DD, and "Sun 19 Oct". */
  date: string;
  dayShort: string;
  /** The link to send; null when it does not work now (turned off, over, or made with an older key and not refreshed). */
  url: string | null;
  expiresAt: string;
  /** "Works until Mon 20 Oct 06:00". */
  expiryText: string;
  generation: number;
  revoked: boolean;
  expired: boolean;
  keyChanged: boolean;
  issuedAt: string;
  /** The last time a salesman's phone opened it (the office's own views are not counted). */
  lastSeenAt: string | null;
  /** "Opened on N phones". */
  phones: number;
  /** The route codes looked up that had deliveries, in natural order. */
  routesSeen: string[];
  /** The truck codes looked up that had deliveries (kept with a "T:" prefix in SalesLink.routesJson), in natural order. */
  trucksSeen: string[];
  /** The WhatsApp text for the group (null without a URL), and its wa.me link (the dispatcher picks the group). */
  message: string | null;
  whatsappUrl: string | null;
}
