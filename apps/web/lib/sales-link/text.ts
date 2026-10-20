/**
 * The salesman link's server-side words and time helpers (owner request 19 Oct 2026). Pure and browser-safe.
 * Since the owner's feedback of 20 Oct 2026 the salesman page says everything itself, in English, Arabic or Urdu
 * (lib/sales-page/i18n.ts): the API sends codes, numbers and "HH:MM" times only. What stays here is the office's
 * side (the WhatsApp message for the salesmen's group, the link's end) and the minute helpers.
 *
 * Never in these texts: a driver's name or phone, a customer's phone or notes, money.
 */
import { fmtDayMonth, fmtHhmm } from '../dispatch/time';

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

/** The WhatsApp message the office sends to the salesmen's group (no link preview data: the page is an empty shell). */
export function salesLinkMessage(o: { dayShort: string; company: string; url: string; expiryText: string }): string {
  return [
    `RouteIQ - live deliveries for ${o.dayShort} (${o.company}): ${o.url}`,
    "Open it, type your route code (as on your Salesman ETA page) and see each customer's delivery: delivered, on the way with the expected time, delayed, not delivered or cancelled. English, Arabic or Urdu.",
    `${o.expiryText}. For the sales team only - please do not forward.`,
  ].join('\n');
}
