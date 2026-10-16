/**
 * Operations alerts (owner request 16 Oct 2026): the words of every alert. Pure and browser-safe; the
 * rules (rules.ts) build each message from plain facts through these helpers, so every message reads the
 * same way: the truck as shown and "L<n>" first, then the stop number and the customer's name (code)
 * where they apply, times as hh:mm of the delivery day ("+1" after midnight), and minutes or km.
 *
 * Privacy (the repository is public and the e-mail goes through a third party):
 * - a message never takes a phone field (driver, customer or dispatcher phone): the facts carry none;
 * - free text (driver notes, customer names) loses every run of ALERT_REDACT_DIGITS_MIN (6) or more
 *   digits - spaces, "+", "-", "/", ".", "(" and ")" inside the run included, and Arabic-Indic digits
 *   too - before it is cut, so a phone number never survives in part;
 * - a driver note is folded to one line and cut to ALERT_NOTE_MAX (140) characters.
 */
import { fmtDayMonth, fmtHhmm, localDateIso, localMinutes, zonedDayStart } from '../dispatch/time';
import { ALERT_NOTE_MAX, ALERT_REDACT_DIGITS_MIN } from './catalog';

/** What a digit run becomes. */
export const REDACTED_NUMBER = '[number]';
/** A customer name in an alert is cut to this many characters. */
export const ALERT_NAME_MAX = 60;

/** A digit (any script), then at least ALERT_REDACT_DIGITS_MIN - 1 more, with separators allowed between them. */
const DIGIT_RUN = new RegExp(`\\+?\\p{Nd}(?:[\\s\\-+/.()]*\\p{Nd}){${ALERT_REDACT_DIGITS_MIN - 1},}`, 'gu');
// Control characters and the invisible direction marks a copy-paste brings along.
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** Every run of 6 or more digits (a phone number, an account number) becomes "[number]". */
export function redactNumbers(text: string): string {
  return text.replace(DIGIT_RUN, REDACTED_NUMBER);
}

/** Control and invisible characters removed, every whitespace run folded into one space, trimmed. */
export function oneLine(text: string | null | undefined): string {
  return (text ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}

/** `text` cut to `max` characters with "…" (never in the middle of a redaction: callers redact first). */
export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

/** A driver's note as an alert shows it: one line, digit runs removed, at most 140 characters; null when empty. */
export function shortNote(note: string | null | undefined, max = ALERT_NOTE_MAX): string | null {
  const t = redactNumbers(oneLine(note));
  return t ? cut(t, max) : null;
}

/** A customer name as an alert shows it: one line, digit runs removed, at most 60 characters. */
export function safeName(name: string | null | undefined): string {
  return cut(redactNumbers(oneLine(name)), ALERT_NAME_MAX) || 'customer';
}

/** "T05 L1". */
export function loadLabel(truckCode: string, loadNo: number): string {
  return `${oneLine(truckCode) || '?'} L${loadNo}`;
}

export interface StopWords {
  sequence: number;
  customerName: string;
  customerCode: string;
  branchCode?: string | null;
}

/** "stop 3 Hyper Example B (C100 / B2)". */
export function stopLabel(s: StopWords): string {
  const code = oneLine(s.customerCode);
  const branch = oneLine(s.branchCode);
  const ref = code ? ` (${branch ? `${code} / ${branch}` : code})` : '';
  return `stop ${s.sequence} ${safeName(s.customerName)}${ref}`;
}

/** "45 min", "2 h 05 min", "3 h". */
export function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')} min` : `${h} h`;
}

/** "2.4 km" from 1000 m on, else "450 m". */
export function fmtDistance(m: number): string {
  return m >= 1000 ? `${(Math.round(m / 100) / 10).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** Minutes after local midnight of the delivery day `date` of an instant (may be negative or pass 1440). */
export function minutesOnDate(at: Date, date: string, tz: string): number {
  return Math.floor((at.getTime() - zonedDayStart(date, tz).getTime()) / 60_000);
}

/**
 * The clock time of an instant as the delivery day `date` reads it: "09:10", "00:40 +1" the night after,
 * and "15 Oct 21:10" further away (the evening before, when tomorrow's loads are loaded).
 */
export function clockText(at: Date, date: string, tz: string): string {
  const m = minutesOnDate(at, date, tz);
  if (m >= 0 && m < 2 * 1440) return fmtHhmm(m);
  return `${fmtDayMonth(localDateIso(at, tz))} ${fmtHhmm(localMinutes(at, tz))}`;
}

/** A plan time (minutes of the delivery day): "07:30", "00:30 +1". */
export function planTime(min: number | null | undefined): string {
  return fmtHhmm(min);
}

/** "1 stop" / "4 stops". */
export function stopsText(n: number): string {
  return `${n} stop${n === 1 ? '' : 's'}`;
}

/** "stop 6", "stops 6 and 8", "stops 5, 6 and 8". */
export function sequencesText(seqs: readonly number[]): string {
  if (seqs.length === 1) return `stop ${seqs[0]}`;
  return `stops ${seqs.slice(0, -1).join(', ')} and ${seqs[seqs.length - 1]}`;
}

/** A quoted note: ` Note: "..."` (empty without a note). */
export function noteText(note: string | null | undefined): string {
  const n = shortNote(note);
  return n ? ` Note: "${n}"` : '';
}

/**
 * The words of a note that only confirms the delivery ("delivered", "received", "delivered at 11:25",
 * in Arabic or English): on the 15 Oct 2026 replay, 12 of the 13 "Delivered with a note" alerts were such
 * notes. Normalised: Arabic diacritics and tatweel removed, alef / taa marbuta / alef maqsura folded.
 */
const CONFIRMING_WORDS = new Set([
  // Arabic: "done", "delivered / delivery", "received", "successfully", "the order", "complete", "at (the hour)", "photographed", "thanks".
  'تم',
  'وتم',
  'التسليم',
  'تسليم',
  'بالتسليم',
  'الاستلام',
  'استلام',
  'التوصيل',
  'توصيل',
  'بنجاح',
  'الطلب',
  'الطلبيه',
  'كامل',
  'كامله',
  'بالكامل',
  'الساعه',
  'ساعه',
  'صباحا',
  'مساء',
  'مساءا',
  'ظهرا',
  'التصوير',
  'تصوير',
  'تصور',
  'الحمد',
  'لله',
  'شكرا',
  // English.
  'delivered',
  'delivery',
  'received',
  'done',
  'ok',
  'okay',
  'successfully',
  'success',
  'complete',
  'completed',
  'full',
  'fully',
  'all',
  'order',
  'the',
  'at',
  'am',
  'pm',
  'thanks',
  'thank',
  'you',
]);

function noteWords(note: string): string[] {
  return note
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * A clock time ("11:25", "9.40 am", "9 am", "١١:٢٥") or a full date with its year ("16/10/2026",
 * "2026-10-16"): the only numbers a note that just confirms the delivery may hold.
 */
const NOTE_TIME_OR_DATE = /(?<!\p{Nd})(?:\p{Nd}{1,2}[:.]\p{Nd}{2}(?:\s?[aApP]\.?[mM]\.?)?|\p{Nd}{1,2}\s?[aApP]\.?[mM]\.?|\p{Nd}{1,2}[/.-]\p{Nd}{1,2}[/.-]\p{Nd}{2,4}|\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2})(?!\p{Nd})/gu;

/**
 * The note only confirms the delivery: it has at least one word, every word is one of CONFIRMING_WORDS,
 * and its only numbers are clock times and dates (punctuation ignored). Any other word ("missing",
 * "not", "باقي", "لم", a name) or any other number ("18/20", "45 / 50", "50%", "3 short": a quantity)
 * keeps the note: a note that says something is never dropped (review of 16 Oct 2026, M5).
 */
export function noteOnlyConfirms(note: string | null | undefined): boolean {
  const text = oneLine(note).normalize('NFKC').replace(NOTE_TIME_OR_DATE, ' ');
  if (/\p{Nd}/u.test(text)) return false;
  const words = noteWords(text);
  return words.length > 0 && words.every((w) => CONFIRMING_WORDS.has(w));
}
