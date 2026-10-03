/**
 * Browser-safe types of the driver link (owner request 4 Oct 2026): what the driver page receives
 * (GET /api/d/manifest) and what the plan screen's Driver link dialog receives
 * (GET / POST /api/dispatch/driver-links). Types only: no server code, so the page bundle stays clean.
 */

export type LoadStatusName = 'PLANNED' | 'LOCKED' | 'LOADING' | 'DISPATCHED' | 'COMPLETED';

export const NOT_DELIVERED_REASONS = [
  'SHOP_CLOSED',
  'CUSTOMER_REFUSED',
  'NO_ONE_TO_RECEIVE',
  'WRONG_LOCATION',
  'NO_TIME_LEFT',
  'PAYMENT_ISSUE',
  'DAMAGED_GOODS',
  'NOT_ON_TRUCK',
  'OTHER',
] as const;
export type NotDeliveredReasonName = (typeof NOT_DELIVERED_REASONS)[number];

export const PHOTO_POSITION_STATUSES = ['OK', 'POOR', 'DENIED', 'TIMEOUT', 'UNSUPPORTED'] as const;
export type PhotoPositionStatusName = (typeof PHOTO_POSITION_STATUSES)[number];

/** A stop's result as the page shows it (spec section 8.6; filled from Part 2 on, null until then). */
export interface StopResult {
  state: 'PENDING' | 'ARRIVED' | 'DONE';
  arrivedAt: string | null;
  arrivalObserved: boolean;
  departedAt: string | null;
  minutes: number | null;
  outcome: 'DELIVERED' | 'PARTLY_DELIVERED' | 'NOT_DELIVERED' | null;
  reason: NotDeliveredReasonName | null;
  casesDelivered: number | null;
  photoIds: string[];
  noPhotoReason: string | null;
  late: boolean;
  /** Load DISPATCHED and the visit is not in the carry basis of a brought-forward order. */
  editable: boolean;
  /** The copy's date (YYYY-MM-DD), for any stop holding a brought-forward order. */
  carriedTo: string | null;
}

export interface ManifestOrderLine {
  lineId: string;
  productCode: string;
  productName: string;
  cases: number;
}

export interface ManifestOrder {
  orderId: string;
  salesOrders: string[];
  lines: ManifestOrderLine[];
}

export interface ManifestStop {
  /** `${loadNo}:${sequence}` */
  key: string;
  sequence: number;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  address: string | null;
  /** The planned pin (the same as the driver sheet); null = no location (call the dispatcher). */
  lat: number | null;
  lng: number | null;
  /** Google Maps directions to the planned pin; null without a pin. */
  navUrl: string | null;
  /** Planned arrival and the planned end of unloading, minutes from midnight. */
  etaMin: number | null;
  untilMin: number | null;
  hours: { hardStart: number | null; hardEnd: number | null; prefStart: number | null; prefEnd: number | null } | null;
  promised: { startMin: number | null; endMin: number | null } | null;
  cases: number;
  orders: ManifestOrder[];
  notes: string[];
  accessNotes: string | null;
  split: { part: number; parts: number } | null;
  /** YYYY-MM-DD the stop's order was first due (brought forward); null = none. */
  carriedFrom: string | null;
  /** The customer data changed after planning (a moved pin: ask the dispatcher). */
  changeNotes: string[];
  result: StopResult | null;
}

export interface ManifestLoad {
  loadNo: number;
  /** Trips of the truck that day ("Trip 1 of 2"). */
  trips: number;
  status: LoadStatusName;
  /** Only a DISPATCHED load takes results. */
  actionable: boolean;
  departMin: number;
  returnMin: number;
  driverName: string | null;
  cases: number;
  /** When the driver reported back at the depot (Part 2); null = not yet. */
  backAtDepotAt: string | null;
  stops: ManifestStop[];
}

export interface DriverManifest {
  /** YYYY-MM-DD */
  date: string;
  tz: string;
  serverNow: string;
  tenantName: string;
  link: { expiresAt: string; uploadUntil: string; generation: number };
  truck: { id: string; code: string; hired: boolean };
  /** Distinct drivers of the truck-day's loads. */
  drivers: { name: string; casual: boolean }[];
  depot: { code: string; name: string; lat: number; lng: number };
  settings: { radiusM: number; photoRequired: boolean; maxPhotos: 3; locationRetentionDays: number; dispatcherPhone: string | null };
  /** Set when a signed-in RouteIQ user opened the page: results are then recorded as the office. */
  office: { userName: string } | null;
  loads: ManifestLoad[];
}

/** The answer of a driver route that refuses the link (404 / 410 / 503), as the page reads it. */
export type LinkStateCode = 'LINK_NOT_FOUND' | 'LINK_REPLACED' | 'LINK_REVOKED' | 'LINK_EXPIRED' | 'UPLOAD_CLOSED' | 'DRIVER_LINKS_OFF';

/** One truck-day link as the plan screen's Driver link dialog shows it. */
export interface DriverLinkView {
  linkId: string;
  truckId: string;
  truckCode: string;
  hired: boolean;
  /** YYYY-MM-DD */
  date: string;
  /** The link, or null when it is revoked, expired or made with an older server key (reopen the dialog). */
  url: string | null;
  /** The QR code as one SVG path (the server draws it; `qrcode` stays out of the browser). */
  qr: { size: number; d: string } | null;
  expiresAt: string;
  uploadUntil: string;
  generation: number;
  revoked: boolean;
  expired: boolean;
  /** Made with an older server key: POST (ensure) makes it work again with a new link. */
  keyChanged: boolean;
  driverIdAtIssue: string | null;
  driverNameAtIssue: string | null;
  devices: { n: number; lastAt: string | null };
  lastSeenAt: string | null;
  /** The truck-day's loads on the plan in use, in departure order, with their drivers. */
  driversOnTruck: { loadId: string; loadNo: number; status: LoadStatusName; departMin: number; driverId: string | null; driverName: string | null; driverPhone: string | null; casual: boolean }[];
}
