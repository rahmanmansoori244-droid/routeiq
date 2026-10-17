/**
 * IVMS live link (16 Oct 2026): how the provider's daily call allowance is shared and paced. Pure: the
 * database side (the counters, the lease) is lib/ivms/store.ts; the poller that follows these answers is
 * lib/ivms/poll.ts.
 *
 * The allowance (TenantConfig.ivmsDailyCallBudget; Ayun's default is 100 a day) is counted per UTC day,
 * the provider's day (it resets at 00:00 UTC, 04:00 in Muscat). Critique H2: every call class has its OWN
 * share of it, so no class can starve another:
 * - ADMIN   the admin's tracker and zone pickers (USER_GET_OBJECTS / USER_GET_ZONES): 5 %, 3-20 calls;
 * - EVENTS  the backstop for missed depot webhooks (OBJECT_GET_LAST_EVENTS, every 15 min): only with a
 *           webhook secret set and an allowance of at least 1,000 a day, 5 % and at most 96;
 * - ROUTE   the trucks' history pulls (OBJECT_GET_ROUTE: the only source of GPS times, H5): TIMES only,
 *           40 % of the rest;
 * - MAP     the live positions for the map (OBJECT_GET_LOCATIONS): everything left.
 * The shares add up to the allowance, so RouteIQ never makes more calls in a day than the provider allows,
 * failed calls included (the provider counts them).
 *
 * Pacing: a class spreads what is left of its share over the time left (to the end of the operating hours
 * or the provider's midnight, whichever is first), never more often than the company's setting. At 100 a
 * day the map moves about every 11-19 minutes; at 3,000 a day every 60 s. The cron route's `force` skips
 * the wait only while the allowance is ample (the setting's own interval is in effect): a low allowance
 * is never spent early (H2).
 */
import { addDaysIso, localMinutes, todayIso, zonedDayStart } from '../dispatch/time';
import { type AyunErrorKind, type IvmsCallClass, type IvmsMode } from './types';

/** The in-process timer's tick: cheap when nothing is due. */
export const IVMS_TICK_MS = 15_000;
/** A background tick holds the company's lease this long; each call renews it, the tick releases it. */
export const IVMS_LEASE_MS = 30_000;
/** The backstop for missed webhooks runs at most this often. */
export const EVENTS_EVERY_SEC = 15 * 60;
/** Below this daily allowance there is no backstop (the map and the history need every call). */
export const EVENTS_MIN_BUDGET = 1000;
/** History pulls in one tick at most (8 s each at worst: the tick stays inside its lease). */
export const MAX_ROUTE_PULLS_PER_TICK = 3;
/** Backoff after a failed call: doubling from the interval in effect, at most 15 minutes. */
export const BACKOFF_MAX_SEC = 15 * 60;
/** A wrong key (AUTH) pauses the background calls this long. */
export const AUTH_PAUSE_SEC = 3600;

// ---------------------------------------------------------------------------------------------------
// Days and hours

/** The provider's day: the UTC date, YYYY-MM-DD. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The next 00:00 UTC after `now` (the provider's counters reset). */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export interface OperatingHours {
  timezone: string;
  /** Minutes from local midnight; to > from (no hours across midnight: the CHECK TenantConfig_ivmsHours_order). */
  fromMin: number;
  toMin: number;
}

/** Is `now` inside the company's operating hours [from, to) in its time zone? */
export function inOperatingHours(now: Date, h: OperatingHours): boolean {
  const m = localMinutes(now, h.timezone);
  return m >= h.fromMin && m < h.toMin;
}

/** The end of today's operating hours (local), as an instant. */
export function hoursEndAt(now: Date, h: OperatingHours): Date {
  return new Date(zonedDayStart(todayIso(h.timezone, now), h.timezone).getTime() + h.toMin * 60_000);
}

/** The operating hours' start on a delivery date (YYYY-MM-DD), as an instant: where a truck-day's history begins. */
export function opsStartOf(dateIso: string, h: OperatingHours): Date {
  return new Date(zonedDayStart(dateIso, h.timezone).getTime() + h.fromMin * 60_000);
}

/** The operating hours' start on the day after a delivery date: where its history ends at the latest. */
export function nextOpsStartOf(dateIso: string, h: OperatingHours): Date {
  return opsStartOf(addDaysIso(dateIso, 1), h);
}

/**
 * Seconds over which what is left of a share is spread: until the end of the operating hours or the
 * provider's midnight, whichever comes first (after hours, with a load still out: until the midnight).
 * At least 60.
 */
export function horizonSec(now: Date, h: OperatingHours): number {
  const midnight = nextUtcMidnight(now).getTime();
  const end = inOperatingHours(now, h) ? Math.min(hoursEndAt(now, h).getTime(), midnight) : midnight;
  return Math.max(60, Math.round((end - now.getTime()) / 1000));
}

// ---------------------------------------------------------------------------------------------------
// Shares

/** Each call class's share of the daily allowance (H2). The shares add up to `budget`. */
export function classShares(budget: number, mode: IvmsMode, eventsOn: boolean): Record<IvmsCallClass, number> {
  const b = Math.max(0, Math.floor(budget));
  const admin = Math.min(b, Math.max(3, Math.min(20, Math.ceil(b * 0.05))));
  const events = eventsOn && b >= EVENTS_MIN_BUDGET ? Math.min(96, Math.floor(b * 0.05)) : 0;
  const rest = Math.max(0, b - admin - events);
  const route = mode === 'TIMES' ? Math.floor(rest * 0.4) : 0;
  return { ADMIN: admin, EVENTS: events, ROUTE: route, MAP: rest - route };
}

/** Is the backstop on? A webhook secret is set, and the allowance can pay for it. */
export function eventsBackstopOn(budget: number, webhookSecretSet: boolean): boolean {
  return webhookSecretSet && budget >= EVENTS_MIN_BUDGET;
}

// ---------------------------------------------------------------------------------------------------
// Pacing

/**
 * Seconds between two live-position calls: the company's setting, or longer when what is left of the
 * MAP share would not last until the end of the horizon. Null = the share is used up for the day.
 */
export function mapIntervalSec(p: { pollSec: number; share: number; used: number; horizonSec: number }): number | null {
  const left = p.share - p.used;
  if (left <= 0) return null;
  return Math.max(p.pollSec, Math.ceil(p.horizonSec / left));
}

/**
 * The live map's interval in effect now (seconds), as the poller paces it: for the day screen's caption
 * (GET /api/runs/[id]/vehicles). Null = the MAP share of the day is used up. Pure.
 */
export function mapIntervalInEffect(p: { budget: number; mode: IvmsMode; webhookSecretSet: boolean; pollSec: number; hours: OperatingHours; mapCallsToday: number; now: Date }): number | null {
  const shares = classShares(p.budget, p.mode, eventsBackstopOn(p.budget, p.webhookSecretSet));
  return mapIntervalSec({ pollSec: p.pollSec, share: shares.MAP, used: p.mapCallsToday, horizonSec: horizonSec(p.now, p.hours) });
}

/**
 * Is a call of a paced class due? `force` (the cron route) skips the wait only while the setting's own
 * interval is in effect (the allowance is ample), never when pacing stretched it (H2).
 */
export function callDue(p: { lastAt: Date | null; intervalSec: number; settingSec: number; now: Date; force?: boolean }): boolean {
  if (!p.lastAt) return true;
  if (p.force && p.intervalSec <= p.settingSec) return true;
  return p.now.getTime() - p.lastAt.getTime() >= p.intervalSec * 1000;
}

/**
 * Minutes between two history pulls of one truck while its load is out: the company's setting
 * (ivmsRoutePullMin), or longer when the ROUTE share left - minus one final pull kept for every truck
 * still out - would not last. Null = only the final pulls are left.
 */
export function routePullEveryMin(p: { pullMin: number; share: number; used: number; trucksOut: number; horizonSec: number }): number | null {
  const regularLeft = p.share - p.used - p.trucksOut;
  if (regularLeft <= 0) return null;
  const perTruck = regularLeft / Math.max(1, p.trucksOut);
  return Math.max(p.pullMin, Math.ceil(p.horizonSec / 60 / perTruck));
}

// ---------------------------------------------------------------------------------------------------
// Failures

/** Failures that say nothing about the account: retried with a backoff. */
export function transientKind(kind: AyunErrorKind): boolean {
  return ['TIMEOUT', 'NETWORK', 'HTTP_ERROR', 'REDIRECT', 'TOO_LARGE', 'EMPTY', 'PARSE', 'PROVIDER_ERROR'].includes(kind);
}

/**
 * When background calls may start again after a failure: LIMIT (the allowance is used up, maybe by
 * calls RouteIQ did not make) waits for the provider's midnight; AUTH (a wrong or revoked key) an hour;
 * anything else doubles from the interval in effect up to 15 minutes, +-20 % so two containers never
 * retry in step. `random` is injectable for tests.
 */
export function backoffUntil(kind: AyunErrorKind, failures: number, now: Date, baseSec: number, random: () => number = Math.random): Date {
  if (kind === 'LIMIT') return new Date(nextUtcMidnight(now).getTime() + 60_000);
  if (kind === 'AUTH') return new Date(now.getTime() + AUTH_PAUSE_SEC * 1000);
  const step = Math.min(BACKOFF_MAX_SEC, Math.max(15, baseSec) * 2 ** Math.max(0, Math.min(10, failures - 1)));
  const jitter = 0.8 + 0.4 * Math.min(1, Math.max(0, random()));
  return new Date(now.getTime() + Math.round(step * jitter * 1000));
}

// ---------------------------------------------------------------------------------------------------
// The provider's clock (first review H-1)

/** A provider receipt time this far AHEAD of RouteIQ's clock (seconds) is impossible: its times are shifted. */
export const CLOCK_AHEAD_MAX_SEC = 10 * 60;
/**
 * ... and this far BEHIND. A wrong offset is whole hours (4 h in Muscat: a provider in local time, or
 * -240 set on UTC times); the newest receipt of a fleet that is all parked with the ignition off can be
 * 30-60 min old, which is not a clock problem, so the limit behind is wider than ahead.
 */
export const CLOCK_BEHIND_MAX_SEC = 2 * 3600;
/** A skew measured longer ago than this is not trusted (it must be seen the same working day). */
export const CLOCK_SKEW_MAX_AGE_MS = 12 * 3600_000;

/** What the last live-position answer said of the provider's clock (IvmsState.providerSkew*). */
export interface SkewRecord {
  skewSec: number | null;
  skewAt: Date | null;
  /** The AYUN_API_TIME_OFFSET_MIN it was measured with. */
  skewOffsetMin: number | null;
}

/**
 * OK: GPS times may be pulled and processed. UNKNOWN: no skew measured with the offset in use within the
 * last 12 h (a changed offset needs a new live-position answer first). AHEAD / BEHIND: the provider's
 * times are shifted (a wrong AYUN_API_TIME_OFFSET_MIN): no history pull and no GPS stop time at all until
 * it is fixed, so a shifted trail is never stored and never written as times (first review H-1). Pure.
 */
export type ClockState = 'OK' | 'UNKNOWN' | 'AHEAD' | 'BEHIND';

export function clockCheck(s: SkewRecord | null, offsetMin: number, now: Date): ClockState {
  if (!s || s.skewSec === null || !s.skewAt || s.skewOffsetMin !== offsetMin) return 'UNKNOWN';
  const age = now.getTime() - s.skewAt.getTime();
  if (age > CLOCK_SKEW_MAX_AGE_MS || age < -60_000) return 'UNKNOWN';
  if (s.skewSec > CLOCK_AHEAD_MAX_SEC) return 'AHEAD';
  if (s.skewSec < -CLOCK_BEHIND_MAX_SEC) return 'BEHIND';
  return 'OK';
}
