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

export type OutcomeName = 'DELIVERED' | 'PARTLY_DELIVERED' | 'NOT_DELIVERED';

/** A stop's result as the page shows it (spec section 8.6; filled from Part 2 on, null until then). */
export interface StopResult {
  /** DONE = a result; ARRIVED = an arrival and no departure yet (a stop in progress); else PENDING. */
  state: 'PENDING' | 'ARRIVED' | 'DONE';
  arrivedAt: string | null;
  arrivalObserved: boolean;
  departedAt: string | null;
  minutes: number | null;
  outcome: OutcomeName | null;
  reason: NotDeliveredReasonName | null;
  /** The result's note (Other, or any note), null = none. */
  note: string | null;
  /** When the result was recorded (the tracker's "done" time). */
  outcomeAt: string | null;
  /** Who recorded the current result: the driver link or the office. */
  by: 'DRIVER' | 'OFFICE' | null;
  casesDelivered: number | null;
  /** Delivered cases per order line of the current result (Partly entry prefills from it). */
  lines: { lineId: string; delivered: number }[] | null;
  photoIds: string[];
  /**
   * Photo keys named by the driver's Delivered and Partly results of this stop (arrived or not): a
   * changed result needs no new photo when there is one. Photos taken for a Not delivered do not count.
   */
  proofPhotos: number;
  noPhotoReason: string | null;
  late: boolean;
  /** Load DISPATCHED and the visit is not in the carry basis of a brought-forward order. */
  editable: boolean;
  /** The copy's date (YYYY-MM-DD), for any stop holding a brought-forward order. */
  carriedTo: string | null;
}

/** One action of the driver page's queue (POST /api/d/actions, spec section 8.1). */
export interface DriverPos {
  lat: number;
  lng: number;
  accuracyM: number;
  /** The device clock when the position was read (ISO). */
  at: string;
  gpsAt?: string | null;
  speedMps?: number | null;
}

export type DriverAction =
  | {
      key: string;
      type: 'ARRIVE';
      stop: string;
      at: string;
      mode: 'AUTO' | 'MANUAL';
      pos?: DriverPos;
      chained?: boolean;
      /** The stop the chained arrival came from (neighbour shops). */
      from?: string;
      observed?: boolean;
      chosen?: boolean;
      /** An answer to "Arrived at ... - when?". */
      when?: boolean;
    }
  | { key: string; type: 'DEPART'; stop: string; at: string; mode: 'AUTO'; pos?: DriverPos; reason: 'LEFT' | 'NEXT_STOP'; gap?: boolean }
  | {
      key: string;
      type: 'OUTCOME';
      stop: string;
      at: string;
      pos?: DriverPos;
      outcome: OutcomeName | null;
      reason?: NotDeliveredReasonName | null;
      note?: string | null;
      lines?: { lineId: string; delivered: number }[] | null;
      photoKeys: string[];
      noPhotoReason?: 'CAMERA_FAILED' | null;
    }
  /**
   * `depot` names the load's depot (a truck can load at two depots on one date, each with its own
   * Load 1); an action queued before it was sent has none and is accepted only when one load matches.
   */
  | { key: string; type: 'BACK_AT_DEPOT'; load: number; depot?: string; at: string; pos?: DriverPos };

/** The answer per action: ok, a duplicate of one already stored, or refused (with the driver's words). */
export interface DriverActionResult {
  key: string;
  status: 'ok' | 'duplicate' | 'refused' | 'error';
  code?: string;
  /** Refused but worth keeping on the phone (an arrival before the load is dispatched). */
  transient?: boolean;
  message?: { en: string; ar: string };
}

/** POST /api/d/actions and the photo route answer with the truck-day's results, merged into the stored manifest. */
export interface DriverResults {
  /** Per stop key (`<depotId>:<loadNo>:<sequence>`, stop-key.ts). */
  stops: Record<string, StopResult>;
  /** Back at depot per load key (`<depotId>:<loadNo>`, stop-key.ts) (ISO time). */
  back: Record<string, string>;
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
  /** `<depotId>:<loadNo>:<sequence>` (stop-key.ts): the depot too, a truck can have a Load 1 at two depots. */
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
  /** `<depotId>:<loadNo>` (stop-key.ts): the load's identity on the page; the number is for display. */
  key: string;
  depotId: string;
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
  settings: { radiusM: number; photoRequired: boolean; maxPhotos: 3; locationRetentionDays: number; photoRetentionDays: number; dispatcherPhone: string | null };
  /** Set when a signed-in RouteIQ user opened the page: results are then recorded as the office. */
  office: { userName: string } | null;
  loads: ManifestLoad[];
}

/** The answer of a driver route that refuses the link (404 / 410 / 503), as the page reads it. */
export type LinkStateCode = 'LINK_NOT_FOUND' | 'LINK_REPLACED' | 'LINK_REVOKED' | 'LINK_EXPIRED' | 'UPLOAD_CLOSED' | 'DRIVER_LINKS_OFF' | 'SIGNED_IN_OTHER_TENANT';

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
