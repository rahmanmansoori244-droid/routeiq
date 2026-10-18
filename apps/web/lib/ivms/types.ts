/**
 * IVMS live link (Ayun, a GPS-Server.net tracking platform; 16 Oct 2026): the shared contract of every
 * lib/ivms module, the day screen's live map and the tests. Pure and browser-safe: no environment, no
 * database, no provider call.
 *
 * The rules the types encode (design + binding critique of 16 Oct 2026):
 * - Modes step up: OFF (default; nothing is called, written or shown) < MAP (live positions on the day
 *   screen) < TIMES (MAP + GPS arrival and departure times) < ALERTS (TIMES + the operations alerts read
 *   the GPS times and the depot moves, and the live position where it is fresh: owner request 18 Oct 2026,
 *   "build GPS alerts"; lib/alerts/gps.ts). ALERTS does everything TIMES does (ivmsModeAtLeast(mode,
 *   'TIMES') is true for it); the database CHECK "TenantConfig_ivmsMode_check" allows it from migration
 *   20261018120000_ivms_alerts_mode on.
 * - Live positions (OBJECT_GET_LOCATIONS) feed the MAP only: a fix older than STALE_FIX_SEC is shown as
 *   stale and is never used for times (H5).
 * - GPS times come only from the provider's history (OBJECT_GET_ROUTE), pulled per truck while a load is
 *   out and once at the end (H5); the trail is split into trips by depot OUT/IN and the trips are matched
 *   to the truck's loads in dispatch order (H3).
 * - The detector never writes an automatic arrival at a pin near the depot, writes nothing when several
 *   pending pins are inside together, and needs a longer dwell for a stop out of sequence (H4).
 * - GPS never writes a result and never completes a load; driver and office entries always win (H1).
 * - Each call class has its own share of the daily allowance, so no class starves another (H2).
 */

// ---------------------------------------------------------------------------------------------------
// Modes

export const IVMS_MODES = ['OFF', 'MAP', 'TIMES', 'ALERTS'] as const;
export type IvmsMode = (typeof IVMS_MODES)[number];

// ---------------------------------------------------------------------------------------------------
// Provider calls and the daily allowance

/** The call classes, each with its own counter (IvmsState) and share of the daily allowance (H2). */
export const IVMS_CALL_CLASSES = ['MAP', 'ROUTE', 'EVENTS', 'ADMIN'] as const;
export type IvmsCallClass = (typeof IVMS_CALL_CLASSES)[number];

/** The IvmsState column that counts each class's calls of the UTC day. */
export const CALL_CLASS_COUNTER = {
  MAP: 'mapCalls',
  ROUTE: 'routeCalls',
  EVENTS: 'eventCalls',
  ADMIN: 'adminCalls',
} as const satisfies Record<IvmsCallClass, string>;

/**
 * The only provider commands RouteIQ ever sends (the client's allow-list), with the class each is
 * counted in. Never the command that returns a key from a user name and password.
 * - OBJECT_GET_LOCATIONS,<imei;imei>: the latest fix of the mapped trackers (live map);
 * - OBJECT_GET_ROUTE,<imei>,<from>,<to>,<min stop minutes>: one tracker's history (GPS times);
 * - OBJECT_GET_LAST_EVENTS: the account's recent events (backstop for missed depot webhooks);
 * - USER_GET_OBJECTS, USER_GET_ZONES: the admin's tracker and depot-zone pickers (nothing is stored).
 */
export const AYUN_COMMANDS = {
  OBJECT_GET_LOCATIONS: 'MAP',
  OBJECT_GET_ROUTE: 'ROUTE',
  OBJECT_GET_LAST_EVENTS: 'EVENTS',
  USER_GET_OBJECTS: 'ADMIN',
  USER_GET_ZONES: 'ADMIN',
} as const satisfies Record<string, IvmsCallClass>;
export type AyunCommand = keyof typeof AYUN_COMMANDS;

/**
 * Why a provider call gave no data. Stored in IvmsState.lastError and shown on Settings: a kind code only
 * (database CHECK ^[A-Z0-9_]{1,40}$), never a URL, a key or a response body. The provider answers its
 * errors as plain text "ERROR: ..." with HTTP 200, so the text is classified before any JSON parse.
 */
export const AYUN_ERROR_KINDS = [
  'NOT_CONFIGURED', // a Railway variable is missing or not usable (names in IvmsEnv.problems)
  'DISABLED', // ROUTEIQ_DISABLE_IVMS=1
  'TIMEOUT',
  'NETWORK',
  'HTTP_ERROR', // any status other than 200
  'REDIRECT', // any 3xx: never followed (the host is fixed)
  'TOO_LARGE',
  'EMPTY',
  'PARSE',
  'AUTH', // ERROR: wrong API key
  'LIMIT', // ERROR: API call limit exceeded
  'NO_PERMISSION', // ERROR: no permission to access this IMEI
  'PROVIDER_ERROR', // any other "ERROR: ..."
] as const;
export type AyunErrorKind = (typeof AYUN_ERROR_KINDS)[number];

/** What every provider call returns: it never throws. */
export type AyunResult<T> = { ok: true; data: T } | { ok: false; kind: AyunErrorKind; status?: number };

// ---------------------------------------------------------------------------------------------------
// Positions and the trail

/** Flags of a live fix (TruckPosition.flags, database CHECK). */
export const FIX_FLAGS = ['INVALID_FIX', 'CLOCK_AHEAD', 'DELAYED'] as const;
export type FixFlag = (typeof FIX_FLAGS)[number];

/** A live fix older than this (seconds) is stale: grey on the map, never "moving", never used for times. */
export const STALE_FIX_SEC = 300;
/** A fix this far ahead of the server's clock (seconds) is CLOCK_AHEAD: kept off the map's "latest". */
export const CLOCK_AHEAD_SEC = 120;
/** A fix the provider received this long after its GPS time (seconds) is DELAYED (buffered). */
export const DELAYED_FIX_SEC = 600;
/** Speed at or above which the truck is moving (km/h): movedAt, "parked for N min", the detector. */
export const MOVING_KMH = 5;

/**
 * One parsed live fix of a MAPPED tracker (OBJECT_GET_LOCATIONS). The provider's object name, plate,
 * driver and other fields are dropped by the parser: they never reach a caller.
 */
export interface LiveFix {
  imei: string;
  /** Device GPS time (dt_tracker, UTC) plus the API time offset. */
  fixAt: Date;
  /** Provider receipt time (dt_server, UTC) plus the API time offset; null when missing. */
  serverAt: Date | null;
  lat: number;
  lng: number;
  speedKmh: number | null;
  heading: number | null;
  ignition: boolean | null;
  flags: FixFlag[];
}

/** One point of a truck's history (OBJECT_GET_ROUTE): valid fixes only (TruckTrailPoint). */
export interface TrailPoint {
  fixAt: Date;
  lat: number;
  lng: number;
  speedKmh: number | null;
  ignition: boolean | null;
}

// ---------------------------------------------------------------------------------------------------
// Depot and zone moves (IvmsEvent)

export const IVMS_EVENT_KINDS = ['DEPOT_IN', 'DEPOT_OUT', 'ZONE_IN', 'ZONE_OUT'] as const;
export type IvmsEventKind = (typeof IVMS_EVENT_KINDS)[number];

/** WEBHOOK: Ayun called us; BACKSTOP: OBJECT_GET_LAST_EVENTS; TRAIL: derived from the history pull. */
export const IVMS_EVENT_ORIGINS = ['WEBHOOK', 'BACKSTOP', 'TRAIL'] as const;
export type IvmsEventOrigin = (typeof IVMS_EVENT_ORIGINS)[number];

/**
 * What processing did with a move (IvmsEvent.outcome; database CHECK ^[A-Z_]{1,40}$):
 * USED (a trip boundary of the day), NO_DEPOT (not a depot zone of this company), NO_LOAD (no load out),
 * DUPLICATE (the same move from another origin), UNCONFIRMED (a webhook move the trail does not confirm:
 * never a trip boundary, M6), SUPPRESSED (the truck-day's GPS is suppressed), STALE (too old).
 */
export const IVMS_EVENT_OUTCOMES = ['USED', 'NO_DEPOT', 'NO_LOAD', 'DUPLICATE', 'UNCONFIRMED', 'SUPPRESSED', 'STALE'] as const;
export type IvmsEventOutcome = (typeof IVMS_EVENT_OUTCOMES)[number];

/** A depot or zone move as the processing step reads it. */
export interface IvmsMove {
  truckId: string;
  depotId: string | null;
  kind: IvmsEventKind;
  origin: IvmsEventOrigin;
  eventAt: Date;
  zoneName: string | null;
}

/** Why a truck-day's GPS is suppressed (IvmsTruckDay.suppressReason, database CHECK). */
export const IVMS_SUPPRESS_REASONS = ['UNDO', 'MISMATCH', 'REMAP'] as const;
export type IvmsSuppressReason = (typeof IVMS_SUPPRESS_REASONS)[number];

// ---------------------------------------------------------------------------------------------------
// GPS stop times (TIMES)

/** The detector's parameters: the settings (TenantConfig.ivms*) and the fixed rules beside them. */
export interface DetectorParams {
  /** ivmsStopRadiusM: inside this distance of a pin the truck is at that stop. */
  stopRadiusM: number;
  /** A dwell ends at the first of two consecutive points beyond stopRadiusM + this (one drifting point does not end it). */
  exitExtraM: number;
  /** ivmsStopDwellMin: minutes inside before an arrival counts, for the next stop in sequence. */
  dwellMin: number;
  /** A stop that is not the next pending one in sequence needs this longer dwell (H4). */
  outOfSequenceDwellMin: number;
  /** At or above this speed (km/h) the truck is moving. */
  movingKmh: number;
  /** A gap longer than this (seconds) just before the first point inside = the arrival was not observed. */
  observedMaxGapSec: number;
  /** ivmsDepotRadiusM: the depot. A pin this close to the depot never gets an automatic arrival (H4). */
  depotRadiusM: number;
  /** Minutes inside or outside the depot radius before a trail-derived depot move counts. */
  depotDwellMin: number;
}

/** The fixed parts of DetectorParams (the rest are the company's settings). */
export const DETECTOR_FIXED = {
  exitExtraM: 50,
  outOfSequenceDwellMin: 6,
  movingKmh: MOVING_KMH,
  observedMaxGapSec: 300,
  depotDwellMin: 5,
} as const satisfies Partial<DetectorParams>;

/**
 * One trip of a truck-day: from a depot OUT to the next depot IN (inAt null: still out). Trips are
 * matched to the truck's loads in dispatch order (H3): a dwell is matched only to the stops of the load
 * whose trip contains it, never to another load's stops.
 */
export interface GpsTrip {
  outAt: Date;
  inAt: Date | null;
  /** The load this trip is (dispatch order), or null when no dispatched load is left for it. */
  loadNo: number | null;
}

/**
 * An arrival or departure the detector proposes for one stop. The idempotency key of the event it
 * becomes is built from the dwell's first inside fix time (segmentStartAt), never from a cycle index, so a
 * rerun over a re-segmented trail never writes the same dwell twice (M2).
 */
export interface StopCandidate {
  loadNo: number;
  sequence: number;
  kind: 'ARRIVED' | 'DEPARTED';
  at: Date;
  /** false: the point before was more than observedMaxGapSec earlier, so `at` is only an upper bound. */
  observed: boolean;
  segmentStartAt: Date;
  /** The truck's own fix (display only, erased with the driver positions) and its distance from the pin. */
  lat: number;
  lng: number;
  distanceM: number;
}

/** A dwell the detector saw but must not write by itself (H4): shown to the office as a fact. */
export interface StopAmbiguity {
  reason: 'SEVERAL_PINS' | 'NEAR_DEPOT' | 'OUT_OF_SEQUENCE_SHORT';
  loadNo: number;
  sequences: number[];
  from: Date;
  to: Date | null;
}

// ---------------------------------------------------------------------------------------------------
// The live map (MAP; GET /api/runs/[id]/vehicles, PLANNER and up)

/** One truck on the day screen's live map. Never the IMEI or any provider field. */
export interface LiveVehicle {
  truckId: string;
  /** The code shown for the truck (a one-day hired truck's own plate). */
  truckCode: string;
  /** The load out (LOCKED, LOADING or DISPATCHED), or null. */
  loadNo: number | null;
  /** 5 decimals (about 1 m). */
  lat: number;
  lng: number;
  fixAt: string;
  ageSec: number;
  speedKmh: number | null;
  heading: number | null;
  /** Minutes since the last moving fix, null while moving or unknown. */
  parkedMin: number | null;
  /** ageSec > STALE_FIX_SEC: grey on the map, never shown as moving. */
  stale: boolean;
  flags: FixFlag[];
}

export interface LiveVehiclesResponse {
  mode: IvmsMode;
  /** Seconds between live-position calls in effect (the allowance may stretch ivmsPollSec), null = none. */
  intervalSec: number | null;
  /** The last successful live-position call, ISO, or null. */
  updatedAt: string | null;
  vehicles: LiveVehicle[];
}

// ---------------------------------------------------------------------------------------------------
// What the operations alerts read about a truck-day in ivmsMode ALERTS (owner request 18 Oct 2026)

/**
 * A depot move of the truck confirmed by its trail (IvmsEvent DEPOT_IN / DEPOT_OUT with outcome USED: a
 * trail move, or an Ayun zone move the trail confirmed, as lib/ivms/stops.ts uses them as trip
 * boundaries). `observed`: the time is exact - a zone move is the device's own event; a trail move only
 * when a trail point lies at most DETECTOR_FIXED.observedMaxGapSec before it (else the truck crossed the
 * radius earlier, during a gap: the time is an upper bound and never feeds a measured duration).
 */
export interface GpsDepotMove {
  at: Date;
  observed: boolean;
}

/**
 * What the alerts engine reads about one truck-day in ivmsMode ALERTS (lib/alerts/facts.ts builds it;
 * lib/alerts/gps.ts and rules.ts read it). Only for a truck-day whose GPS is not suppressed
 * (IvmsTruckDay.suppressedAt): a suppressed one has none and falls back to the phone-based rules.
 *
 * `tracked` is true only while the latest live fix is usable (younger than STALE_FIX_SEC, valid, clock not
 * ahead: lib/ivms/eta.ts fixUsable; an absolute limit, H5). Only a tracked truck-day's live position is
 * read (the live ETA, "still at the stop", "away from the depot"); a stale one falls back to the
 * phone-based rules for those, while the GPS times its trail already gave (the visits' AYUN times, the
 * depot moves) stay facts. The position never appears in an alert text, its facts or a log.
 */
export interface GpsTruckDayFact {
  tracked: boolean;
  /** The latest live fix's GPS time (TruckPosition.fixAt), tracked or not; null: no live fix. */
  fixAt: Date | null;
  speedKmh: number | null;
  /** Minutes the truck stood still at the latest fix (null: moving, stale or unknown). */
  parkedSinceMin: number | null;
  /** The latest live fix's position, only to tell whether the truck is at a pin or at the depot (null: not tracked). */
  position: { lat: number; lng: number } | null;
  /** The trail-confirmed depot moves of the truck around the delivery day, oldest first. */
  depotOut: GpsDepotMove[];
  depotIn: GpsDepotMove[];
  /** The trips between those moves (depot OUT to the next IN). loadNo stays null: the detector's own matching needs the trail. */
  trips: GpsTrip[];
  /** The truck-day's history was pulled up to this provider time (IvmsTruckDay.pulledTo); null: not known. */
  trailTo: Date | null;
}
