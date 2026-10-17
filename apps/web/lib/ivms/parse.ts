/**
 * IVMS live link (Ayun, a GPS-Server.net tracking platform; 16 Oct 2026): the provider's answers read
 * into RouteIQ's own shapes. Pure: no environment, no database, no network, never throws.
 *
 * What the provider sends (user API 1.x; hand-written examples in tests/fixtures/ivms/):
 * - every value may be a string ("23.5", "1"), a number, or missing; nothing is trusted: each value is
 *   parsed and range-checked, and a row that fails is dropped (counted), never half-stored;
 * - times are "YYYY-MM-DD HH:MM:SS" in UTC. AYUN_API_TIME_OFFSET_MIN / AYUN_WEBHOOK_TIME_OFFSET_MIN
 *   (lib/ivms/env.ts) are ADDED to them for a provider that does not send UTC (Muscat local time: -240);
 * - an empty answer is `[]` (a PHP empty array), not `{}`: both read as "nothing";
 * - errors are plain text "ERROR: ..." with HTTP 200: lib/ivms/ayun-client.ts classifies them before any
 *   of this runs.
 *
 * Privacy: only the IMEI, times, position, speed, heading, ignition and a zone name are ever returned.
 * The provider's object name (it often holds the driver's name), plate, SIM, VIN, driver, trailer,
 * odometer and the like are never read into a result, so no caller can store or log them. Answers about
 * IMEIs that are not mapped to one of the company's trucks are counted and dropped unread.
 */
import { CLOCK_AHEAD_SEC, DELAYED_FIX_SEC, type FixFlag, type LiveFix, type TrailPoint } from './types';

const IMEI_RE = /^\d{10,20}$/;

/** Is this a tracker IMEI RouteIQ accepts (10-20 digits; the database CHECK "Truck_ivmsImei_format")? */
export function isImei(v: unknown): v is string {
  return typeof v === 'string' && IMEI_RE.test(v);
}

// ---------------------------------------------------------------------------------------------------
// Times

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * A provider time ("YYYY-MM-DD HH:MM:SS", UTC) as an instant, with the channel's offset added. Null for
 * anything else, including PHP's empty date "0000-00-00 00:00:00" and impossible dates (2026-02-30).
 */
export function parseProviderTime(raw: unknown, offsetMin = 0): Date | null {
  if (typeof raw !== 'string') return null;
  const m = TIME_RE.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (y < 2000 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return new Date(ms + offsetMin * 60_000);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * An instant as the provider expects it in a request, the inverse of parseProviderTime: the channel's
 * offset taken off, written YYYYMMDDHHMMSS (digits only: no space or colon in the request).
 */
export function formatProviderTime(at: Date, offsetMin = 0): string {
  const t = new Date(at.getTime() - offsetMin * 60_000);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}`;
}

// ---------------------------------------------------------------------------------------------------
// Values

/** A finite number from a number or a plain decimal string ("23.5", "-0.25", "12"), else null. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A usable position: inside the earth's ranges and not (0, 0) (a device without a fix sends that). */
export function validLatLng(lat: number | null, lng: number | null): lat is number {
  if (lat === null || lng === null) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return !(Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6);
}

/** km/h, 0-250 (anything else is a device fault: unknown). */
export function speedOf(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 && n <= 250 ? n : null;
}

/** Degrees 0-359 (360 is north too), else unknown. */
export function headingOf(v: unknown): number | null {
  const n = num(v);
  if (n === null || n < 0 || n > 360) return null;
  return Math.round(n) % 360;
}

/** The ignition input (`params.acc`) when the device sends one: "1" on, "0" off, else unknown. */
export function ignitionOf(params: unknown): boolean | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const acc = (params as Record<string, unknown>).acc;
  if (acc === '1' || acc === 1 || acc === true) return true;
  if (acc === '0' || acc === 0 || acc === false) return false;
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** `[]` (PHP's empty array) or `{}`: the provider has nothing to say. */
const isEmptyAnswer = (v: unknown) => (Array.isArray(v) && v.length === 0) || (isRecord(v) && Object.keys(v).length === 0);

// ---------------------------------------------------------------------------------------------------
// OBJECT_GET_LOCATIONS (live positions: the map only)

export interface ParsedLocations {
  /** Fixes of mapped trackers only, flagged (types.ts FIX_FLAGS). */
  fixes: LiveFix[];
  /** Entries about IMEIs that are not mapped (an answer to `*`): dropped unread. */
  unmapped: number;
  /** Entries of mapped trackers without a usable position or time: dropped. */
  invalid: number;
}

/**
 * The answer to OBJECT_GET_LOCATIONS: an object keyed by IMEI ({name, dt_server, dt_tracker, lat, lng,
 * altitude, angle, speed, params, loc_valid}, all strings), or `[]` when nothing matched. Null = not that
 * shape at all (the caller's PARSE).
 * - loc_valid "0": INVALID_FIX (shown greyed, never used for anything else);
 * - the fix time more than CLOCK_AHEAD_SEC after `now`: CLOCK_AHEAD (never moves the map's latest row);
 * - received more than DELAYED_FIX_SEC after the fix: DELAYED (a fix buffered through a coverage gap).
 */
export function parseLocations(body: unknown, mapped: ReadonlySet<string>, now: Date, offsetMin = 0): ParsedLocations | null {
  const out: ParsedLocations = { fixes: [], unmapped: 0, invalid: 0 };
  if (isEmptyAnswer(body)) return out;
  if (!isRecord(body)) return null;
  for (const [imei, v] of Object.entries(body)) {
    if (!isImei(imei) || !mapped.has(imei)) {
      out.unmapped++;
      continue;
    }
    if (!isRecord(v)) {
      out.invalid++;
      continue;
    }
    const lat = num(v.lat);
    const lng = num(v.lng);
    const fixAt = parseProviderTime(v.dt_tracker, offsetMin);
    if (!validLatLng(lat, lng) || !fixAt) {
      out.invalid++;
      continue;
    }
    const serverAt = parseProviderTime(v.dt_server, offsetMin);
    const flags: FixFlag[] = [];
    if (v.loc_valid === '0' || v.loc_valid === 0) flags.push('INVALID_FIX');
    if (fixAt.getTime() > now.getTime() + CLOCK_AHEAD_SEC * 1000) flags.push('CLOCK_AHEAD');
    if (serverAt && serverAt.getTime() - fixAt.getTime() > DELAYED_FIX_SEC * 1000) flags.push('DELAYED');
    out.fixes.push({ imei, fixAt, serverAt, lat, lng: lng!, speedKmh: speedOf(v.speed), heading: headingOf(v.angle), ignition: ignitionOf(v.params), flags });
  }
  out.fixes.sort((a, b) => a.imei.localeCompare(b.imei));
  return out;
}

/**
 * How far the provider's clock (as corrected by the API offset) is from ours, in seconds: the newest
 * receipt time of the answer minus `now`. About 0 when the times are UTC (or the offset is right), about
 * +14400 when the provider sends Muscat local time without an offset (set -240), about -14400 when the
 * offset was set the wrong way round. Null without any receipt time. Computed from the corrected times
 * before any fix is flagged, so a wrong offset shows here even when every fix is CLOCK_AHEAD (M9).
 */
export function providerSkewSec(fixes: readonly Pick<LiveFix, 'serverAt'>[], now: Date): number | null {
  let newest: number | null = null;
  for (const f of fixes) if (f.serverAt && (newest === null || f.serverAt.getTime() > newest)) newest = f.serverAt.getTime();
  return newest === null ? null : Math.round((newest - now.getTime()) / 1000);
}

/**
 * The time offset to set for a skew (whole quarter hours), or null when the skew is small enough to be
 * trackers that have not reported for a while (within 20 min ahead, or 3 h behind).
 */
export function suggestedOffsetMin(skewSec: number | null, currentOffsetMin = 0): number | null {
  if (skewSec === null || (skewSec <= 20 * 60 && skewSec >= -3 * 3600)) return null;
  return currentOffsetMin - Math.round(skewSec / 900) * 15;
}

// ---------------------------------------------------------------------------------------------------
// OBJECT_GET_ROUTE (one tracker's history: the only source of GPS times)

export interface ParsedRoute {
  /** Valid points inside the window, by time, one per fix time. */
  points: TrailPoint[];
  /** Points dropped: no usable position or time, (0, 0), clock ahead, or outside the window. */
  dropped: number;
}

/**
 * The answer to OBJECT_GET_ROUTE,<imei>,<from>,<to>,<min stop>: `{route: [[dt_tracker, lat, lng,
 * altitude, angle, speed, params], ...], stops, drives, events, ...}`, or `[]`. Only `route` is read
 * (RouteIQ detects stops itself, lib/ivms/stops.ts); a point given as an object ({dt_tracker, lat, lng,
 * speed, params}) is read too. Null = not that shape (PARSE).
 */
export function parseRoute(body: unknown, now: Date, offsetMin = 0, window?: { from: Date; to: Date }): ParsedRoute | null {
  const out: ParsedRoute = { points: [], dropped: 0 };
  if (isEmptyAnswer(body)) return out;
  if (!isRecord(body)) return null;
  const route = body.route;
  if (route === undefined || isEmptyAnswer(route)) return out;
  if (!Array.isArray(route)) return null;
  const aheadLimit = now.getTime() + CLOCK_AHEAD_SEC * 1000;
  const seen = new Set<number>();
  for (const p of route) {
    let dt: unknown, la: unknown, ln: unknown, sp: unknown, params: unknown;
    if (Array.isArray(p)) [dt, la, ln, , , sp, params] = p;
    else if (isRecord(p)) ({ dt_tracker: dt, lat: la, lng: ln, speed: sp, params } = p);
    else {
      out.dropped++;
      continue;
    }
    const fixAt = parseProviderTime(dt, offsetMin);
    const lat = num(la);
    const lng = num(ln);
    const t = fixAt?.getTime() ?? NaN;
    if (!fixAt || !validLatLng(lat, lng) || t > aheadLimit || (window && (t < window.from.getTime() || t > window.to.getTime())) || seen.has(t)) {
      out.dropped++;
      continue;
    }
    seen.add(t);
    out.points.push({ fixAt, lat, lng: lng!, speedKmh: speedOf(sp), ignition: ignitionOf(params) });
  }
  out.points.sort((a, b) => a.fixAt.getTime() - b.fixAt.getTime());
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Zone events (the webhook and the OBJECT_GET_LAST_EVENTS backstop)

/** The provider event types RouteIQ stores. Long stop, idle, overspeed and the rest carry the detection time, not when they began: ignored. */
export const ZONE_EVENT_TYPES = ['zone_in', 'zone_out'] as const;
export type ZoneEventType = (typeof ZONE_EVENT_TYPES)[number];

/** A depot or zone move as the provider reported it (before it is matched to a truck and a depot). */
export interface ParsedZoneEvent {
  imei: string;
  type: ZoneEventType;
  /** The fix's time (dt_tracker) plus the channel's offset. */
  eventAt: Date;
  serverAt: Date | null;
  /** The zone's name (the webhook's zone_name, else the text in the description's last parentheses), at most 80 characters. */
  zoneName: string | null;
  lat: number | null;
  lng: number | null;
}

/** A webhook or backstop event is accepted only within this window around `now` (a wrong offset shows as refused times). */
export const EVENT_MAX_AGE_SEC = 26 * 3600;

/** A zone name as stored: trimmed, inner spaces collapsed, at most 80 characters (database CHECK). */
export function cleanZoneName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 80) : null;
}

/** A zone name for comparing (Depot.ivmsZoneName): as stored, then lower case. */
export function zoneKey(v: unknown): string | null {
  return cleanZoneName(v)?.toLowerCase() ?? null;
}

/** "Depot IN (Example depot zone)" -> "Example depot zone": the text of the last parentheses. */
export function zoneFromDesc(desc: unknown): string | null {
  if (typeof desc !== 'string') return null;
  const m = /\(([^()]*)\)\s*$/.exec(desc);
  return m ? cleanZoneName(m[1]) : null;
}

export type ZoneEventProblem = 'IMEI' | 'TYPE' | 'TIME';

/**
 * One zone event from its fields (the webhook's parameters, or a backstop row). Only these fields are
 * read: imei, type, desc, zone_name, lat, lng, dt_tracker, dt_server. A problem says why it is not kept:
 * IMEI (not 10-20 digits), TYPE (not zone_in / zone_out: counted as ignored), TIME (no usable time, or
 * outside [now - 26 h, now + 2 min]: usually a wrong time offset).
 */
export function zoneEventOf(
  f: { imei?: unknown; type?: unknown; desc?: unknown; zone_name?: unknown; lat?: unknown; lng?: unknown; dt_tracker?: unknown; dt_server?: unknown },
  now: Date,
  offsetMin = 0,
): { ok: true; event: ParsedZoneEvent } | { ok: false; problem: ZoneEventProblem } {
  const imei = typeof f.imei === 'string' ? f.imei.trim() : '';
  if (!isImei(imei)) return { ok: false, problem: 'IMEI' };
  const type = typeof f.type === 'string' ? f.type.trim().toLowerCase() : '';
  if (!(ZONE_EVENT_TYPES as readonly string[]).includes(type)) return { ok: false, problem: 'TYPE' };
  const eventAt = parseProviderTime(f.dt_tracker, offsetMin);
  if (!eventAt) return { ok: false, problem: 'TIME' };
  const t = eventAt.getTime();
  if (t < now.getTime() - EVENT_MAX_AGE_SEC * 1000 || t > now.getTime() + CLOCK_AHEAD_SEC * 1000) return { ok: false, problem: 'TIME' };
  const lat = num(f.lat);
  const lng = num(f.lng);
  const ok = validLatLng(lat, lng);
  return {
    ok: true,
    event: {
      imei,
      type: type as ZoneEventType,
      eventAt,
      serverAt: parseProviderTime(f.dt_server, offsetMin),
      zoneName: cleanZoneName(f.zone_name) ?? zoneFromDesc(f.desc),
      lat: ok ? lat : null,
      lng: ok ? lng : null,
    },
  };
}

export interface ParsedLastEvents {
  /** Zone events of mapped trackers inside the time window. */
  events: ParsedZoneEvent[];
  /** Rows of IMEIs that are not mapped: dropped unread. */
  unmapped: number;
  /** Rows of mapped trackers that are not zone events, or have no usable time. */
  ignored: number;
}

/**
 * The answer to OBJECT_GET_LAST_EVENTS (the account's events of about the last day): rows
 * [type, event_desc, imei, name, dt_tracker, lat, lng, altitude, angle, speed, params], or `[]`. The
 * name (index 3) is never read. Null = not that shape (PARSE).
 */
export function parseLastEvents(body: unknown, mapped: ReadonlySet<string>, now: Date, offsetMin = 0): ParsedLastEvents | null {
  const out: ParsedLastEvents = { events: [], unmapped: 0, ignored: 0 };
  if (isEmptyAnswer(body)) return out;
  if (!Array.isArray(body)) return null;
  for (const row of body) {
    let f: Parameters<typeof zoneEventOf>[0];
    if (Array.isArray(row)) f = { type: row[0], desc: row[1], imei: row[2], dt_tracker: row[4], lat: row[5], lng: row[6] };
    else if (isRecord(row)) f = { type: row.type, desc: row.event_desc ?? row.desc, imei: row.imei, dt_tracker: row.dt_tracker, lat: row.lat, lng: row.lng };
    else {
      out.ignored++;
      continue;
    }
    if (typeof f.imei !== 'string' || !mapped.has(f.imei)) {
      out.unmapped++;
      continue;
    }
    const r = zoneEventOf(f, now, offsetMin);
    if (r.ok) out.events.push(r.event);
    else out.ignored++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// USER_GET_OBJECTS (the admin's tracker picker: shown, never stored)

/** A tracker of the account, for the admin's picker: never its object name (it often holds a driver's name). */
export interface AyunObject {
  imei: string;
  /** The plate the provider has for it, or null. */
  plate: string | null;
  /** The provider's group of the object (since API 1.16), or null. */
  group: string | null;
  /** The last fix time, or null. */
  fixAt: Date | null;
}

/** The answer to USER_GET_OBJECTS: an array (or an object keyed by IMEI) of objects; `[]` = none. Null = not that shape. */
export function parseObjects(body: unknown, offsetMin = 0): AyunObject[] | null {
  if (isEmptyAnswer(body)) return [];
  const rows = Array.isArray(body) ? body : isRecord(body) ? Object.entries(body).map(([k, v]) => (isRecord(v) ? { imei: k, ...v } : null)) : null;
  if (!rows) return null;
  const out: AyunObject[] = [];
  for (const r of rows) {
    if (!isRecord(r) || !isImei(r.imei)) continue;
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
    out.push({ imei: r.imei, plate: text(r.plate_number), group: text(r.group_name ?? r.group), fixAt: parseProviderTime(r.dt_tracker, offsetMin) });
  }
  return out.sort((a, b) => a.imei.localeCompare(b.imei));
}
