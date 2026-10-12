/**
 * The Crew report (owner request 13 Oct 2026: management wants to know who were the driver and the
 * helpers on each truck and load), the browser-safe part: the range rules, the download URL and the
 * columns. The server side is crew-report.ts.
 */
import { addDaysIso, daysBetween } from './time';

/** At most this many days in one report (as the Delivery actuals). */
export const CREW_MAX_DAYS = 31;

/** The last 7 days up to the day on screen. */
export function crewDefaultRange(dateIso: string): { from: string; to: string } {
  return { from: addDaysIso(dateIso, -6), to: dateIso };
}

/** Why a From / To range cannot be downloaded, or null (the same rules as the route). */
export function crewRangeProblem(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 'Choose both dates.';
  if (to < from) return '"To" must not be before "From".';
  if (daysBetween(from, to) + 1 > CREW_MAX_DAYS) return `At most ${CREW_MAX_DAYS} days at a time.`;
  return null;
}

/** GET /api/dispatch/crew-report for a range, one depot or (null) every depot. */
export function crewReportUrl(from: string, to: string, depotId: string | null): string {
  const q = new URLSearchParams({ from, to });
  if (depotId) q.set('depotId', depotId);
  return `/api/dispatch/crew-report?${q}`;
}

/** One load of the report: a load of the plan in use of a depot and day, whatever its status. */
export interface CrewRow {
  /** YYYY-MM-DD */
  date: string;
  depot: string;
  truck: string;
  trip: number;
  status: string;
  driver: string;
  helper1: string;
  helper2: string;
  helper3: string;
  /** "07:12" (the day's local time; another day "2026-10-12 21:40"). */
  departed: string;
  /** "Dispatched in RouteIQ" (when the load was marked dispatched) or "Planned" (not dispatched yet). */
  departedBasis: string;
  /** The driver's Back at depot tap, "15:58"; '' when not recorded. */
  backAtDepot: string;
  stops: number;
  cases: number;
}

export const CREW_COLUMNS: { header: string; key: keyof CrewRow; width: number }[] = [
  { header: 'Date', key: 'date', width: 11 },
  { header: 'Depot', key: 'depot', width: 12 },
  { header: 'Truck', key: 'truck', width: 14 },
  { header: 'Trip', key: 'trip', width: 6 },
  { header: 'Load status', key: 'status', width: 12 },
  { header: 'Driver', key: 'driver', width: 22 },
  { header: 'Helper 1', key: 'helper1', width: 20 },
  { header: 'Helper 2', key: 'helper2', width: 20 },
  { header: 'Helper 3', key: 'helper3', width: 20 },
  { header: 'Departed', key: 'departed', width: 17 },
  { header: 'Departed from', key: 'departedBasis', width: 20 },
  { header: 'Back at depot', key: 'backAtDepot', width: 17 },
  { header: 'Stops', key: 'stops', width: 7 },
  { header: 'Cases', key: 'cases', width: 8 },
];

/** The Driver cell of a load without a driver. */
export const NO_DRIVER_TEXT = 'Not assigned';

/** Per helper: loads, days and trucks in the range (the report's Helpers sheet), by name. */
export function helperTotals(rows: readonly CrewRow[]): { helper: string; loads: number; days: number; trucks: string }[] {
  const by = new Map<string, { loads: number; days: Set<string>; trucks: Set<string> }>();
  for (const r of rows) {
    for (const h of [r.helper1, r.helper2, r.helper3]) {
      if (!h) continue;
      const t = by.get(h) ?? { loads: 0, days: new Set<string>(), trucks: new Set<string>() };
      t.loads++;
      t.days.add(r.date);
      t.trucks.add(r.truck);
      by.set(h, t);
    }
  }
  return [...by.entries()]
    .map(([helper, t]) => ({ helper, loads: t.loads, days: t.days.size, trucks: [...t.trucks].sort().join(', ') }))
    .sort((a, b) => a.helper.localeCompare(b.helper));
}
