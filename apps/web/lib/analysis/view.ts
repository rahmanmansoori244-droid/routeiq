/**
 * The "Analysis data" Excel (owner request 19 Oct 2026), the browser-safe part: the range rules, the default
 * range and the download URL, shared by the Dashboard link, the Alerts page's Excel link and the route
 * (GET /api/analysis/export).
 */
import { addDaysIso, daysBetween } from '../dispatch/time';
import { ALERT_EXPORT_MAX_DAYS, ANALYSIS_MAX_DAYS } from './types';

export { ALERT_EXPORT_MAX_DAYS, ANALYSIS_MAX_DAYS } from './types';

/** `only=alerts`: the alerts with their cause & action alone (the ReadMe and that one sheet; owner request 20 Oct 2026). */
export type AnalysisExportOnly = 'alerts';

/** The longest range one download covers. */
export function analysisMaxDays(only?: AnalysisExportOnly | null): number {
  return only === 'alerts' ? ALERT_EXPORT_MAX_DAYS : ANALYSIS_MAX_DAYS;
}

/** The last 30 delivery dates up to yesterday (today's facts are built tonight). */
export function analysisDefaultRange(todayIso: string): { from: string; to: string } {
  const to = addDaysIso(todayIso, -1);
  return { from: addDaysIso(to, -29), to };
}

/** Why a From / To range cannot be downloaded, or null (the same rules as the route). */
export function analysisRangeProblem(from: string, to: string, only?: AnalysisExportOnly | null): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 'Choose both dates.';
  if (to < from) return '"To" must not be before "From".';
  const max = analysisMaxDays(only);
  if (daysBetween(from, to) + 1 > max) return `At most ${max} days at a time.`;
  return null;
}

/** GET /api/analysis/export for a range, one depot or (null) every depot; `only: 'alerts'` for the alerts alone. */
export function analysisExportUrl(from: string, to: string, depotId: string | null, opts: { only?: AnalysisExportOnly } = {}): string {
  const q = new URLSearchParams({ from, to });
  if (depotId) q.set('depotId', depotId);
  if (opts.only) q.set('only', opts.only);
  return `/api/analysis/export?${q}`;
}
