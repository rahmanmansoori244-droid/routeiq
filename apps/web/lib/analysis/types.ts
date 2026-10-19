/**
 * The analysis dataset (owner request 19 Oct 2026: "build on more data for our analysis later and
 * improvement"): the shared contract of lib/analysis/*, the export route, the Dashboard link and the tests.
 * Pure and browser-safe: no environment, no database.
 *
 * Why it exists (GPS study of 19 Oct 2026, real data of 18-19 Oct, 76 driver-tapped visits): the trucks'
 * trail (TruckTrailPoint) is deleted ivmsTrailDays (2 by default) after each fix, and a StopVisit keeps only
 * its final rebuilt times and result. The study could tell a second drop point from a pin 200 m off, a late
 * result tap from a truck still unloading, and a trip out and back from a long unloading only because the
 * trail still existed. Four fact tables (prisma/schema.prisma FactTruckDay, FactVisit, FactLeg,
 * FactDepotTurn) keep what is needed for later analysis and recalibration (serviceMinPerCase, the type base
 * times, distanceMultiplier: study item 12, after 3-4 weeks of facts), without any raw position.
 *
 * The constants below are the rules of lib/analysis/gps.ts and the value lists the migration
 * 20261019090000_analysis_facts CHECKs (tests/lib/analysis-contract.spec.ts compares them).
 */

/** The builder's marker on every row (FactX.analysisVersion): a later rule change never mixes silently. */
export const ANALYSIS_VERSION = 'analysis-v1';

/** TenantConfig.analysisRetentionDays: the bounds (database CHECK) and the default (2 years). */
export const ANALYSIS_RETENTION_BOUNDS = { min: 30, max: 3650 } as const;
export const DEFAULT_ANALYSIS_RETENTION_DAYS = 730;

/** The export covers at most this many delivery dates at a time (owner request: "a date range up to 92 days"). */
export const ANALYSIS_MAX_DAYS = 92;

/**
 * The nightly schedule (lib/analysis/job.ts), in company time: from 03:00 the day before is built in full
 * (its trail is at most 27 h old then, inside the default 2-day trail); the columns that do not come from
 * the trail are refreshed every night until the 4th day after the delivery date (results saved late, an
 * office correction), and that refresh freezes the rows (frozenAt): never written again.
 */
export const ANALYSIS_BUILD_AT_MIN = 180;
export const ANALYSIS_REFRESH_DAYS = 4;
/** A night the job did not run (a deploy, a restart) is built later, at most this many days back. */
export const ANALYSIS_CATCHUP_DAYS = 7;

/**
 * The customer site rules (lib/analysis/gps.ts), ported from the study's prototype (d-dataset/build_dataset.py)
 * with what its check found:
 * - siteRadiusM: points within 300 m of the pin (and nearer it than any other pin of the truck-day that is
 *   300 m or more away) are on the site;
 * - leaveRadiusM: a standstill of substayMin or more within 500 m is on the site too (a second drop point:
 *   one study customer's was 353-378 m from the pin; the prototype's 300 m ended that site early);
 * - beyond 500 m, or nearer another customer's pin, the truck is AWAY: the time away is never unloading (the
 *   check found one trip of 6.3 km to another customer's site and one 94-min park 1.2 km away in the middle
 *   of two visits); it is kept as a count and minutes;
 * - a standing spot 120-500 m from the pin is a pin offset (study: 7 customers' pins 120-300 m off caused
 *   missed GPS stops; an office data fix, never a code fix) when the truck stood there longer than within
 *   120 m of the pin: a big site's first drop at the pin and a second drop point further on is not one;
 * - the truck more than 500 m from the pin at the driver's result tap is a late result tap;
 * - frozen positions: the same coordinates for 60 s or more at 5 km/h or more (counted, never deleted);
 * - spikes: a single point that implies more than 150 km/h both to and from it while its neighbours agree
 *   with each other (a pairwise check: the study's 150 km/h "jumps" were mostly timestamp jitter, which a
 *   plain speed filter would delete).
 */
export const SITE_RULES = {
  siteRadiusM: 300,
  leaveRadiusM: 500,
  substayMin: 2,
  dropClusterM: 50,
  idleMin: 3,
  pinOffsetMinM: 120,
  pinOffsetMaxM: 500,
  lateResultM: 500,
  resultPairSec: 300,
  frozenRunSec: 60,
  frozenMinKmh: 5,
  spikeKmh: 150,
  /** A GPS departure RouteIQ holds this long (min) before the truck left the site: PREMATURE_DEP. */
  prematureDepMin: 5,
  /** A leg whose plan drives slower than this (straight km/h) holds idle time (a break, a wait). */
  planIdleKmh: 8,
} as const;

/**
 * FactVisit.flags (database CHECK "FactVisit_flags_check"):
 * - LATE_RESULT_TAP: the truck was more than 500 m from the pin at the driver's result tap;
 * - PIN_OFFSET: the truck stood 120-500 m from the pin to unload, longer than within 120 m of it;
 * - MULTI_DROP: sub-stays more than 50 m apart (drop points);
 * - LEFT_AND_RETURNED: the truck went away from the site and came back (time away not counted);
 * - PREMATURE_DEP: the GPS departure RouteIQ holds is more than 5 min before the truck left the site;
 * - SPLIT_STAYS: the live detector saw more than one stay inside the site;
 * - SHARED_SITE: another stop of the truck-day has its pin within 300 m;
 * - NEAR_DEPOT: the pin is within the depot radius + 50 m;
 * - RESULT_CHANGED: the first result saved is not the final one;
 * - PHOTO_FAR: a delivery photo more than 500 m from the pin;
 * - NO_GPS: no usable trail for the truck-day; GPS_NOT_SEEN: a trail, the visit's window searched (an arrival
 *   or a result when the GPS columns were built), but the truck was not seen on site.
 */
export const FACT_VISIT_FLAGS = [
  'LATE_RESULT_TAP',
  'PIN_OFFSET',
  'MULTI_DROP',
  'LEFT_AND_RETURNED',
  'PREMATURE_DEP',
  'SPLIT_STAYS',
  'SHARED_SITE',
  'NEAR_DEPOT',
  'RESULT_CHANGED',
  'PHOTO_FAR',
  'NO_GPS',
  'GPS_NOT_SEEN',
] as const;
export type FactVisitFlag = (typeof FACT_VISIT_FLAGS)[number];

/** FactVisit.unloadSource (CHECK): the GPS site, else the visit's arrival to departure. */
export const UNLOAD_SOURCES = ['GPS_SITE', 'VISIT'] as const;
export type UnloadSource = (typeof UNLOAD_SOURCES)[number];

/** FactTruckDay.lastInFrom (CHECK). */
export const LAST_IN_FROM = ['TRAIL', 'DEVICE_EVENT'] as const;
export type LastInFrom = (typeof LAST_IN_FROM)[number];

/**
 * FactTruckDay.gpsNote (CHECK): why its GPS columns are empty. PARTIAL_TRAIL (review of 19 Oct 2026): the
 * day was built late (a missed night, the first deploy) when the GPS retention (ivmsTrailDays) had already
 * deleted the start of its trail; built from the rest, the morning's stops would be "not seen" and the time
 * out and km would cover the afternoon only, so no GPS column is kept.
 */
export const GPS_NOTES = ['NO_TRACKER', 'NO_TRAIL', 'SUPPRESSED', 'PARTIAL_TRAIL'] as const;
export type GpsNote = (typeof GPS_NOTES)[number];

/** FactVisit.awayJson and substaysJson: a JSON array of at most this many bytes (CHECK), kept under it by the builder. */
export const FACT_JSON_MAX_BYTES = 8192;
export const FACT_JSON_KEEP_BYTES = 7000;

/** One sub-stay as FactVisit.substaysJson keeps it: from the site start, and from the pin only (never a position). */
export interface SubstayJson {
  startOffsetSec: number;
  minutes: number;
  distM: number;
  bearingDeg: number;
}

/** One trip away from the site as FactVisit.awayJson keeps it. */
export interface AwayJson {
  startOffsetSec: number;
  minutes: number;
  maxDistM: number;
}
