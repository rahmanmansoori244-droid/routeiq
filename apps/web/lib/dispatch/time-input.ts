/**
 * Times of day in form fields (`<input type="time">`), which can show only 00:00-23:59 (audit
 * F25). An "until" time of 1440 (midnight, the end of the day) is shown as 00:00, and 00:00 or
 * 24:00 typed as an "until" time is 1440 again, so a truck available "until midnight" saves
 * unchanged when another field is edited. Before, the form showed 1440 as "00:00 +1" (the plan
 * screen's format), which its own save refused ("Enter availability as HH:MM") - the truck could
 * not be saved until the time was typed again.
 */
import { parseHhmm } from './time';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The HH:MM a time field shows for minutes from midnight ('' when not set). `until`: 1440 is the
 * end of the day and shows as 00:00. A value a time field cannot show (below 0, above 1440, or a
 * "from" of 1440) shows as '': truckAvailabilityFromForm then keeps the stored value unless the
 * field is changed.
 */
export function timeInputValue(min: number | null | undefined, kind: 'from' | 'until'): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return '';
  const m = Math.round(min);
  if (kind === 'until' && m === 1440) return '00:00';
  if (m < 0 || m >= 1440) return '';
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/**
 * Minutes from midnight for a typed time ('' = not set, null). `until`: 00:00 and 24:00 are the
 * end of the day (1440). Throws on anything that is not HH:MM.
 */
export function parseTimeInput(raw: string, kind: 'from' | 'until'): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (kind === 'until' && (s === '00:00' || s === '24:00' || s === '0000' || s === '2400')) return 1440;
  const v = parseHhmm(s);
  if (v !== null && kind === 'from' && v >= 1440) throw new Error(`Invalid time "${raw}"`);
  return v;
}

/**
 * A truck's availability from its form fields. A field still showing what was loaded keeps the
 * stored minutes exactly (so a value a time field cannot show is never changed by saving another
 * field); a field the user changed is parsed. Throws on a time that is not HH:MM.
 */
export function truckAvailabilityFromForm(
  form: { availableFrom: string; availableTo: string },
  loaded?: { availableFromMin?: number | null; availableToMin?: number | null; shownFrom: string; shownTo: string },
): { availableFromMin: number | null; availableToMin: number | null } {
  const keep = (shown: string | undefined, typed: string, stored: number | null | undefined) => loaded !== undefined && shown === typed && stored != null;
  return {
    availableFromMin: keep(loaded?.shownFrom, form.availableFrom, loaded?.availableFromMin) ? (loaded!.availableFromMin as number) : parseTimeInput(form.availableFrom, 'from'),
    availableToMin: keep(loaded?.shownTo, form.availableTo, loaded?.availableToMin) ? (loaded!.availableToMin as number) : parseTimeInput(form.availableTo, 'until'),
  };
}
