/**
 * Local-time helpers for dispatch planning. NMWC plans in Asia/Muscat (UTC+4, no DST), but
 * everything takes the tenant timezone so a server running in UTC never shifts "tomorrow".
 * Plan times are integers: minutes from local midnight of the delivery day.
 */

export const DEFAULT_TZ = 'Asia/Muscat';

function parts(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: p.year, m: p.month, d: p.day, h: Number(p.hour), min: Number(p.minute) };
}

/** YYYY-MM-DD of `date` in the tenant timezone. */
export function localDateIso(date: Date, tz = DEFAULT_TZ): string {
  const p = parts(date, tz);
  return `${p.y}-${p.m}-${p.d}`;
}

/** Minutes since local midnight of `date` in the tenant timezone. */
export function localMinutes(date: Date, tz = DEFAULT_TZ): number {
  const p = parts(date, tz);
  return p.h * 60 + p.min;
}

/**
 * The instant local midnight starts the day `iso` (YYYY-MM-DD) in the tenant timezone:
 * 2026-09-25 in Asia/Muscat is 2026-09-24T20:00:00Z. Used for "from / to" day filters.
 */
export function zonedDayStart(iso: string, tz = DEFAULT_TZ): Date {
  const utcMidnight = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const offsetAt = (t: number) => {
    const p = parts(new Date(t), tz);
    const local = Date.UTC(+p.y, +p.m - 1, +p.d, p.h, p.min);
    return Math.round((local - Math.floor(t / 60_000) * 60_000) / 60_000);
  };
  let t = utcMidnight - offsetAt(utcMidnight) * 60_000;
  const again = offsetAt(t); // a DST change between the two instants (not in Oman)
  if (utcMidnight - again * 60_000 !== t) t = utcMidnight - again * 60_000;
  return new Date(t);
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function todayIso(tz = DEFAULT_TZ, now = new Date()): string {
  return localDateIso(now, tz);
}

export function tomorrowIso(tz = DEFAULT_TZ, now = new Date()): string {
  return addDaysIso(localDateIso(now, tz), 1);
}

/** Day difference b - a for two YYYY-MM-DD strings. */
export function daysBetween(aIso: string, bIso: string): number {
  const a = Date.UTC(+aIso.slice(0, 4), +aIso.slice(5, 7) - 1, +aIso.slice(8, 10));
  const b = Date.UTC(+bIso.slice(0, 4), +bIso.slice(5, 7) - 1, +bIso.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/**
 * An order is LATE when it is received after the planning cutoff, which is `cutoffMin` local
 * time on the day BEFORE delivery (cutoff 18:00 for tomorrow's deliveries). Orders received
 * on the delivery day itself are always late.
 */
export function isAfterCutoff(receivedAt: Date, deliveryDateIso: string, cutoffMin: number, tz = DEFAULT_TZ): boolean {
  const recvDay = localDateIso(receivedAt, tz);
  const cutoffDay = addDaysIso(deliveryDateIso, -1);
  const diff = daysBetween(recvDay, cutoffDay); // >0 means received before the cutoff day
  if (diff > 0) return false;
  if (diff < 0) return true;
  return localMinutes(receivedAt, tz) > cutoffMin;
}

/** 390 -> "06:30"; values >= 1440 get a "+1" (next day). */
export function fmtHhmm(min: number | null | undefined): string {
  if (min === null || min === undefined || Number.isNaN(min)) return '—';
  const m = Math.round(min);
  const h = Math.floor(m / 60) % 24;
  const mm = ((m % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}${m >= 1440 ? ' +1' : ''}`;
}

/** "06:30" / "6:30" / "0630" -> 390. Returns null for blank, throws on garbage. */
export function parseHhmm(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid time "${raw}" (use HH:MM)`);
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 24 || mm > 59 || (h === 24 && mm !== 0)) throw new Error(`Invalid time "${raw}"`);
  return h * 60 + mm;
}

export function fmtWindow(start: number | null | undefined, end: number | null | undefined): string {
  if (start == null && end == null) return 'Any time';
  return `${start == null ? '00:00' : fmtHhmm(start)}–${end == null ? '24:00' : fmtHhmm(end)}`;
}

/** Postgres DATE column value for a YYYY-MM-DD string (UTC midnight, as Prisma expects). */
export function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
