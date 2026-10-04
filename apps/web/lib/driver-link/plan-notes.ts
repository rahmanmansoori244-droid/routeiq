/**
 * Notes the plan screen shows about driver links (owner request 4 Oct 2026, spec section 6.5).
 * Pure and browser-safe.
 *
 * Late dispatch: the truck-day's driver page was opened (lastSeenAt) after a load's planned
 * departure while that load is still LOCKED or LOADING - the truck has probably left and the
 * dispatcher has not pressed Dispatch, so the driver cannot record results yet. Uses lastSeenAt
 * only: no location data.
 */
import type { DriverLinkView } from './manifest-types';

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (min: number) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

/** Minutes after local midnight of `dateIso` (the plan's day) of an instant, in the company's time zone. */
export function minutesOnDay(instant: string | Date, dateIso: string, tz: string): number | null {
  const d = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const day = `${p.year}-${p.month}-${p.day}`;
  const dayDiff = Math.round((Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) - Date.UTC(+dateIso.slice(0, 4), +dateIso.slice(5, 7) - 1, +dateIso.slice(8, 10))) / 86_400_000);
  return dayDiff * 1440 + Number(p.hour) * 60 + Number(p.minute);
}

export interface LateDispatchNote {
  loadId: string;
  text: string;
}

const STATUS_WORD: Record<string, string> = { LOCKED: 'Locked', LOADING: 'Loading' };

export function lateDispatchNotes(
  loads: readonly { id: string; truckId: string; truckCode: string; loadNo: number; status: string; departMin: number }[],
  links: readonly Pick<DriverLinkView, 'truckId' | 'lastSeenAt'>[],
  dateIso: string,
  tz: string,
): LateDispatchNote[] {
  const out: LateDispatchNote[] = [];
  for (const l of loads) {
    if (l.status !== 'LOCKED' && l.status !== 'LOADING') continue;
    const seen = links.find((x) => x.truckId === l.truckId)?.lastSeenAt;
    if (!seen) continue;
    const at = minutesOnDay(seen, dateIso, tz);
    if (at === null || at <= l.departMin) continue;
    out.push({
      loadId: l.id,
      text: `${l.truckCode} L${l.loadNo}: driver page opened ${hhmm(at)}, load still ${STATUS_WORD[l.status]} - planned departure ${hhmm(l.departMin)}. Dispatch it if it has left.`,
    });
  }
  return out;
}

/** A truck-day with more than one driver: the one link covers all its trips. */
export function manyDriversNote(link: Pick<DriverLinkView, 'truckCode' | 'driversOnTruck'>): string | null {
  const names = [...new Set(link.driversOnTruck.map((l) => l.driverId).filter(Boolean))];
  return names.length > 1 ? `${link.truckCode} has more than one driver today: the one link covers all its trips. Whoever holds it records for the truck.` : null;
}
