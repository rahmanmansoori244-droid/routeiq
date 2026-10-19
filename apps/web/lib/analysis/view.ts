/**
 * The "Analysis data" Excel (owner request 19 Oct 2026), the browser-safe part: the range rules, the default
 * range and the download URL, shared by the Dashboard link and the route (GET /api/analysis/export).
 */
import { addDaysIso, daysBetween } from '../dispatch/time';
import { ANALYSIS_MAX_DAYS } from './types';

export { ANALYSIS_MAX_DAYS } from './types';

/** The last 30 delivery dates up to yesterday (today's facts are built tonight). */
export function analysisDefaultRange(todayIso: string): { from: string; to: string } {
  const to = addDaysIso(todayIso, -1);
  return { from: addDaysIso(to, -29), to };
}

/** Why a From / To range cannot be downloaded, or null (the same rules as the route). */
export function analysisRangeProblem(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 'Choose both dates.';
  if (to < from) return '"To" must not be before "From".';
  if (daysBetween(from, to) + 1 > ANALYSIS_MAX_DAYS) return `At most ${ANALYSIS_MAX_DAYS} days at a time.`;
  return null;
}

/** GET /api/analysis/export for a range, one depot or (null) every depot. */
export function analysisExportUrl(from: string, to: string, depotId: string | null): string {
  const q = new URLSearchParams({ from, to });
  if (depotId) q.set('depotId', depotId);
  return `/api/analysis/export?${q}`;
}
