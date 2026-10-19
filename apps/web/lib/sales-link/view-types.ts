/**
 * The salesman link's API answer (GET /api/s/view, owner request 19 Oct 2026; the truck lookup: owner decision
 * of 20 Oct 2026). Browser-safe: types only. The page (app/s/[token]) renders these; every text is ready to show
 * (plain English, times in the company's time zone, "HH:MM" with " +1" after midnight). The answer never carries
 * an internal id (customer, order, load, truck, run), a driver's name or phone, an IMEI, a customer's phone,
 * address or notes, money, a priority, or customers of a route or truck not asked for: `key` and `truckKey` are
 * per-answer indexes ("d7", "t2").
 */

/** What a result is: one sales route's deliveries, or one truck's deliveries of the day (every route). */
export type SalesViewKind = 'ROUTE' | 'TRUCK';

/** A link that does not work (404 / 410 / 503 / 403): the page shows it full-page. */
export type SalesLinkStateCode = 'LINK_NOT_FOUND' | 'LINK_REPLACED' | 'LINK_REVOKED' | 'LINK_EXPIRED' | 'SALES_LINKS_OFF' | 'SIGNED_IN_OTHER_TENANT';

/** A refused lookup (400), or too many requests (429, with Retry-After). */
export type SalesQueryErrorCode = 'ROUTE_CODE_MISSING' | 'ROUTE_CODE_TOO_LONG' | 'TOO_MANY_CODES' | 'RATE_LIMITED';

/** What happened, or will happen, at one delivery (one stop of one trip) of the route. */
export type DeliveryStatus =
  | 'DELIVERED'
  | 'PARTLY_DELIVERED'
  | 'NOT_DELIVERED'
  /** The trip is over (or probably over) and the driver recorded no result for this stop. */
  | 'NO_RESULT'
  /** The truck was there (arrival or departure known) but the result is not in yet. */
  | 'VISITED'
  | 'AT_CUSTOMER'
  | 'NEXT'
  | 'ON_THE_WAY'
  /** Not visited yet while later stops were: still due, the driver serves other customers first. */
  | 'PASSED'
  | 'LOADING'
  | 'PLANNED'
  /** An earlier day's trip that never left. */
  | 'TRUCK_DID_NOT_GO';

/** Orders of the route that are not on a truck of the day (listed under the deliveries). */
export type OffTruckKind = 'CANCELLED' | 'MOVED' | 'NOT_PLANNED' | 'PART_NOT_PLANNED' | 'ADDED_AFTER_PLAN' | 'NOT_PLANNED_YET';

/** Where an expected time comes from: the truck's GPS, the trip so far (the plan moved by the driver's updates), or the plan. */
export type EtaSource = 'GPS' | 'TRIP' | 'PLAN';

/**
 * The expected time against the window the salesman gave the customer (the printed Salesman ETA window):
 * inside it, after it, before it (GPS only), "due now - no update yet" (the plan says the truck should be
 * there and nothing says it is: no minutes), or no time to give: no live updates from this truck at all, a trip
 * not marked as left, or a stop after one the clock decides ("Not before 11:00 - no update from the truck yet").
 */
export type EtaTiming = 'ON_TIME' | 'LATE' | 'EARLY' | 'DUE_NOW' | 'NO_UPDATES';

export type TripStatus = 'PLANNED' | 'LOCKED' | 'LOADING' | 'DISPATCHED' | 'COMPLETED';

export interface SalesMeta {
  /** The delivery date, YYYY-MM-DD. */
  date: string;
  /** "Sunday 19 October 2026". */
  dayText: string;
  /** "Sun 19 Oct". */
  dayShort: string;
  /** The company's name. */
  company: string;
  /** When the link stops working (ISO instant). */
  expiresAt: string;
  /** "Works until Mon 20 Oct 06:00". */
  expiryText: string;
  /** The company's time zone (every time in the answer is already in it). */
  tz: string;
  /** The server's clock (ISO instant). */
  serverNow: string;
  /** The page refreshes every this many seconds while visible. */
  refreshSec: number;
  /** "Your route code (as on your Salesman ETA page) or a truck code". */
  routeHint: string;
}

export interface SalesEta {
  /** "10:45" (company time, " +1" after midnight); never earlier than now. Null: no time to show (timing DUE_NOW / NO_UPDATES). */
  expected: string | null;
  source: EtaSource | null;
  timing: EtaTiming;
  /** Minutes after the window's end, rounded to 5 (timing LATE only; never when the time is only "not reached yet"). */
  lateMin: number | null;
  /** Minutes before the window's start, rounded to 5 (timing EARLY: GPS only). */
  earlyMin: number | null;
  /** The line to show: "Expected about 10:45 (GPS) - within 10:15-11:15", "Due now - no update from the truck yet", ... */
  text: string;
}

export interface SalesDelivery {
  /** 1, 2, ... in expected order (the planned arrival, then truck, trip, stop). The map pins carry it. */
  no: number;
  /** Per answer ("d7"). */
  key: string;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  /** The route's invoices on this delivery (no other route's); a truck's result: every invoice of the stop. */
  invoices: string[];
  /** The route's cases on this delivery (a truck's result: the stop's). */
  cases: number;
  /** The sales routes of the delivery's lines, in natural order (a route's result: that route only; [] = none given). */
  routes: string[];
  /** The truck of this delivery in `trucks` (per answer, "t2"). */
  truckKey: string;
  /** The truck code as on the plan (a hired truck: its plate). */
  truckCode: string;
  loadNo: number;
  /** 1-based position of the stop on its trip, and the trip's stops: "Trip 2 · stop 3 of 9". */
  stopNo: number;
  stopsOnTrip: number;
  /** "part 1 of 2" when the route's customer has more than one delivery that day; else null. */
  part: string | null;
  status: DeliveryStatus;
  /** "Delivered", "On the way", "Truck at the customer now", ... */
  statusText: string;
  /** The second line: "Delivered 10:31", "Truck there since 10:31", "Truck stopped there 10:31-10:52 - result not recorded", ... (null: none). */
  detailText: string | null;
  /** The window printed on the Salesman ETA ("07:45-09:00"); null when the plan has no time for the stop. */
  window: string | null;
  /** The planned arrival "08:05"; null = not planned. */
  planned: string | null;
  /** The live expected arrival (pending deliveries of today's trips); null when done or not live (plan only). */
  eta: SalesEta | null;
  /** NEXT / ON_THE_WAY / PASSED: stops of the same trip still to be served before this one; else null. */
  stopsBefore: number | null;
  /** "May arrive after the customer's receiving hours (until 14:00)"; null = no. */
  afterHours: string | null;
  /** The result's time "10:31" (DELIVERED / PARTLY / NOT_DELIVERED); else null. */
  at: string | null;
  /** The route's delivered cases of the route's cases (results only). */
  delivered: { cases: number; of: number } | null;
  /** Why not (or not all) delivered: "Shop closed (as reported by the driver)"; never the driver's own note. */
  reason: string | null;
  /** The receiving hours "06:00-14:00", "any time", or null (only the order's own time is known). */
  hours: string | null;
  /** "this order: 10:00-11:00" when an order has its own delivery time; else null. */
  orderTime: string | null;
  /** "Not locked yet: times can change if the day is re-planned", "Moved here from Sat 18 Oct", ... */
  notes: string[];
  /** The customer's planned pin, 4 decimals (about 10 m), for the map only (no name on it); null = none. */
  pin: { lat: number; lng: number } | null;
  /** A WhatsApp text for the customer (`https://wa.me/?text=` + encodeURIComponent): status, window or time; never a link. */
  shareText: string;
}

export interface SalesTruckPosition {
  /** About 100 m (3 decimals). */
  lat: number;
  lng: number;
  /** The GPS time of the position (ISO). */
  fixAt: string;
  /** "Updated 10:32", or "Last GPS position 10:12 (25 min ago)" when not fresh. */
  updatedText: string;
  ageMin: number;
  /** Older than 5 minutes (or an invalid fix): drawn grey. */
  stale: boolean;
  moving: boolean;
}

export interface SalesTruck {
  /** Per answer ("t2"). */
  key: string;
  /** As on the plan (a hired truck: its plate). */
  truckCode: string;
  /** The trip that matters now: the first on the road, else being loaded, else the next to go, else the last finished. */
  trip: { loadNo: number; status: TripStatus; text: string } | null;
  /** How many trips of the day carry this route (a truck's result: its trips with deliveries). */
  trips: number;
  /** "Running about 20 min late" (the trip on the road, past its plan by 15 min or more); null otherwise. */
  lateText: string | null;
  /** The route's next customer on this truck (a truck's result: the truck's next customer): "Example Mart · about 10:45 · 2 stops before it"; null = none. */
  nextYours: string | null;
  /**
   * Only while the trip on the road still has deliveries of this result to make (a route's: that route's; a truck's:
   * any), on the delivery day itself, and the GPS position is at most 60 min old.
   */
  position: SalesTruckPosition | null;
  /** "GPS: updated 10:32", "No GPS on this truck - times from the driver's updates", ...; null when GPS tracking is off. */
  gpsText: string | null;
}

export interface SalesOffTruck {
  kind: OffTruckKind;
  /** "Cancelled", "Moved to another day", "Not on a truck", ... */
  kindText: string;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  invoices: string[];
  cases: number;
  /** "Cancelled - Customer cancelled", "Moved to Mon 20 Oct", "No room on the trucks for this day (the office will advise)", ... */
  why: string;
}

export interface SalesCounts {
  delivered: number;
  partly: number;
  notDelivered: number;
  noResult: number;
  /** AT_CUSTOMER + NEXT. */
  now: number;
  /** ON_THE_WAY + VISITED + PASSED. */
  onTheWay: number;
  /** PLANNED + LOADING. */
  planned: number;
  didNotGo: number;
  /** Deliveries not done whose expected time is after their window (EtaTiming LATE). */
  delayed: number;
  cancelled: number;
  moved: number;
  /** NOT_PLANNED + PART_NOT_PLANNED + ADDED_AFTER_PLAN + NOT_PLANNED_YET. */
  notPlanned: number;
}

/** One result of a lookup: a sales route's deliveries (kind ROUTE) or a truck's deliveries of the day (kind TRUCK). */
export interface SalesRouteView {
  kind: SalesViewKind;
  /** The route code as stored ("R2X"), or the truck code as the plan shows it ("1234-AB"; a day-hired truck: its plate). */
  code: string;
  /** What the page asks for to refresh this result: the route code ("R2X"), or the truck form ("Truck 1234-AB"). */
  query: string;
  /** "Route R2X · Sunday 19 October 2026", "Truck 1234-AB · Sunday 19 October 2026". */
  heading: string;
  /** When the data was read (ISO) and "Updated 10:32". */
  updatedAt: string;
  updatedText: string;
  /** A trip of this result is not locked yet: times can change if the day is re-planned. */
  notLocked: boolean;
  counts: SalesCounts;
  /** "4 delivered · 1 at the customer now · 6 on the way · 2 not on a truck". */
  summaryText: string;
  trucks: SalesTruck[];
  deliveries: SalesDelivery[];
  /** A route's orders not on a truck; a truck's: the orders taken off its trips (cancelled, moved to another day). */
  offTruck: SalesOffTruck[];
}

/** One truck the salesman can pick: its code as shown and the lookup to send when he does. */
export interface SalesChoiceOption {
  /** "1234-AB". */
  code: string;
  /** The whole lookup text to send ("R1, Truck 1234-AB"): what is shown now with this truck added (ALSO_TRUCK: in place of the route). */
  query: string;
}

/**
 * A typed code the page offers trucks for: several trucks have its digits ("5678": none is shown), or a route code
 * is also a truck's code (the route is shown, the truck offered).
 */
export interface SalesChoice {
  asked: string;
  kind: 'SEVERAL_TRUCKS' | 'ALSO_TRUCK';
  /** "5678 matches 2 trucks today. Pick one:", "C1 is also a truck code. Show the truck instead:". */
  text: string;
  options: SalesChoiceOption[];
}

export interface SalesLookup {
  /** The codes asked for, normalised ("R1", "R2X", "5678", "TRUCK 1234-AB"). */
  asked: string[];
  /** What they matched, routes first (natural order), then trucks (by code); each says its kind. */
  results: SalesRouteView[];
  /** The codes that matched no route and no truck with deliveries that day (unknown or not on that day: the same answer). */
  notFound: string[];
  /** Codes that matched more than one route (or truck) by the compact key (each is in `results`). */
  ambiguous: string[];
  /** Trucks to pick from (several trucks with the digits typed; a route code that is also a truck's). */
  choices: SalesChoice[];
  /** "No deliveries for route or truck R9 on Sun 19 Oct. ..."; null when every code matched. */
  notFoundText: string | null;
}

/** GET /api/s/view (no `route`: meta only, lookup null) and GET /api/s/view?route=<codes> (route and truck codes). */
export interface SalesViewAnswer {
  meta: SalesMeta;
  lookup: SalesLookup | null;
}

/** The error object of a refused answer: { data: null, error: SalesErrorBody }. */
export interface SalesErrorBody {
  code: SalesLinkStateCode | SalesQueryErrorCode | string;
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
