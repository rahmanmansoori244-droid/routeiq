/**
 * Operations alerts on the screens (owner request 16 Oct 2026): the words and groupings the bell, the day
 * screen's Alerts card and the Alerts page share. Pure and browser-safe.
 *
 * Dates (owner request 19 Oct 2026: "alerts of yesterday looked like today's because only the time is
 * shown"; "ok add the date fix"): the bell and the Alerts page show the date of any alert whose delivery
 * date is not the company's today - "Yesterday 17:20", "18 Oct 17:20" - and today's keep the time only
 * (alertWhen); the bell puts a small date header over the rows of another day (alertDayGroups). "Today"
 * is the company's, in its time zone, from the server's answer.
 */
import { daysBetween, fmtDayMonth, fmtHhmm, localDateIso, localMinutes } from '../dispatch/time';
import { ALERT_RULE_SPECS, ALERT_TOAST_MAX, RESOLVED_REASON_TEXT, SEVERITY_RANK, isAlertRule, type AlertSeverity } from './catalog';
import type { OpsAlertRow, SweepCheck } from './types';

/** "T05 L1 stop 3", "T05 L1", "T05". */
export function alertWhere(r: Pick<OpsAlertRow, 'truckCode' | 'loadNo' | 'sequence'>): string {
  return [r.truckCode, r.loadNo != null ? `L${r.loadNo}` : null, r.sequence != null ? `stop ${r.sequence}` : null].filter(Boolean).join(' ');
}

export function ruleLabel(rule: string): string {
  return isAlertRule(rule) ? ALERT_RULE_SPECS[rule].label : rule;
}

/** hh:mm of an ISO instant in the company's time zone. */
export function alertTime(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : fmtHhmm(localMinutes(d, timezone));
}

/**
 * A day as seen from the company's today: null for today, "Yesterday", "Tomorrow", else "18 Oct". `today` is
 * the company's (todayIso in its time zone: the summary and the list answer carry it, so a browser whose
 * clock or zone is off does not move it).
 */
export function alertDayWord(date: string, today: string): string | null {
  const d = daysBetween(today, date);
  if (d === 0) return null;
  if (d === -1) return 'Yesterday';
  if (d === 1) return 'Tomorrow';
  return fmtDayMonth(date);
}

/**
 * When an alert began, was last seen, closed or was acknowledged, as the bell and the Alerts page show it
 * (owner request 19 Oct 2026): the time only for an alert of today at a time of today ("17:20"); otherwise
 * the day of that time too - "Yesterday 17:20", "18 Oct 17:20", and "Today 00:40" for yesterday's alert
 * seen after midnight or tomorrow's seen this evening (the bell's day header and the Alerts page's Day
 * column say whose day it is). Every label is the instant's own date and clock in the company's time zone,
 * so a summer-time change or a browser in another zone does not move it. '' without a time.
 */
export function alertWhen(iso: string | null | undefined, deliveryDate: string, timezone: string, today: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const clock = fmtHhmm(localMinutes(d, timezone));
  const on = localDateIso(d, timezone);
  if (deliveryDate === today && on === today) return clock;
  return `${alertDayWord(on, today) ?? 'Today'} ${clock}`;
}

/** The bell's small date header over the rows of one delivery day: "Today", "Yesterday, 18 Oct", "Tomorrow, 20 Oct", "16 Oct". */
export function alertDayHeader(deliveryDate: string, today: string): string {
  const word = alertDayWord(deliveryDate, today);
  if (word === null) return 'Today';
  return word === 'Yesterday' || word === 'Tomorrow' ? `${word}, ${fmtDayMonth(deliveryDate)}` : word;
}

/**
 * The rows by delivery day, each day in the order the rows came (open and HIGH first): today first, then the
 * days ahead, then the days before, the latest first. `header` is null when every row is of today: the bell
 * then looks as before (owner request 19 Oct 2026: "grouping or a small date header is fine").
 */
export function alertDayGroups<T extends Pick<OpsAlertRow, 'deliveryDate'>>(rows: readonly T[], today: string): { date: string; header: string | null; rows: T[] }[] {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const list = by.get(r.deliveryDate);
    if (list) list.push(r);
    else by.set(r.deliveryDate, [r]);
  }
  const rank = (date: string) => {
    const d = daysBetween(today, date);
    return d === 0 ? [0, 0] : d > 0 ? [1, d] : [2, -d];
  };
  const dates = [...by.keys()].sort((a, b) => {
    const [ga, da] = rank(a);
    const [gb, db] = rank(b);
    return ga! - gb! || da! - db!;
  });
  const onlyToday = dates.length === 1 && dates[0] === today;
  return dates.map((date) => ({ date, header: onlyToday ? null : alertDayHeader(date, today), rows: by.get(date)! }));
}

/**
 * "Open", "Acknowledged by Sam 10:42", "Over 10:50", "No longer in the plan 11:02", "Day ended". With the
 * company's `today` (the bell and the Alerts page), a time that is not of today says its day too ("Over
 * yesterday 17:40", owner request 19 Oct 2026); without it (the day screen's card and the truck's day, which
 * show one day) the time only, as before. A row closed at the day's end says so without the time (it is
 * always the first check after the midnight that followed its day), and who had acknowledged it, which the
 * close keeps: "Day ended (acknowledged by Sam 10:42)".
 */
export function alertStateText(r: OpsAlertRow, timezone: string, today?: string): string {
  const when = (iso: string | null) => (today ? alertWhen(iso, r.deliveryDate, timezone, today).replace(/^(Today|Yesterday|Tomorrow)\b/, (w) => w.toLowerCase()) : alertTime(iso, timezone));
  const acked = () => `${r.ackedByName ? ` by ${r.ackedByName}` : ''} ${when(r.ackedAt)}`.trimEnd();
  if (r.state === 'RESOLVED') {
    if (r.resolvedReason === 'DAY_ENDED') return r.ackedAt ? `${RESOLVED_REASON_TEXT.DAY_ENDED} (acknowledged${acked()})` : RESOLVED_REASON_TEXT.DAY_ENDED;
    return `${r.resolvedReason ? RESOLVED_REASON_TEXT[r.resolvedReason] : 'Over'} ${when(r.resolvedAt)}`.trim();
  }
  if (r.state === 'ACKED') return `Acknowledged${acked()}`;
  return 'Open';
}

export const SEVERITY_BADGE: Record<AlertSeverity, 'destructive' | 'warning'> = { HIGH: 'destructive', WARN: 'warning' };

/** One truck's alerts, worst first: the per-truck roll-up of the day card (8-10 trucks on one screen). */
export interface TruckAlerts {
  truckCode: string;
  truckId: string;
  /** The worst severity among its open and acknowledged rows; null when every row is history. */
  worst: AlertSeverity | null;
  open: number;
  acked: number;
  resolved: number;
  rows: OpsAlertRow[];
}

const rank = (s: AlertSeverity) => SEVERITY_RANK[s] ?? 1;

export function groupByTruck(rows: OpsAlertRow[]): TruckAlerts[] {
  const by = new Map<string, TruckAlerts>();
  for (const r of rows) {
    const g = by.get(r.truckId) ?? { truckCode: r.truckCode, truckId: r.truckId, worst: null, open: 0, acked: 0, resolved: 0, rows: [] };
    by.set(r.truckId, g);
    g.rows.push(r);
    if (r.state === 'OPEN') g.open++;
    else if (r.state === 'ACKED') g.acked++;
    else g.resolved++;
    if (r.state !== 'RESOLVED' && (g.worst === null || rank(r.severity) < rank(g.worst))) g.worst = r.severity;
  }
  const order = (g: TruckAlerts) => (g.worst === null ? 9 : rank(g.worst) + (g.open ? 0 : 2));
  return [...by.values()].sort((a, b) => order(a) - order(b) || a.truckCode.localeCompare(b.truckCode, undefined, { numeric: true }));
}

/** The body of POST /api/alerts/ack for these rows: each with the tier it was shown at. */
export function ackBody(rows: Pick<OpsAlertRow, 'id' | 'tier' | 'state'>[]): { ids: string[]; seen: Record<string, number> } | null {
  const open = rows.filter((r) => r.state === 'OPEN');
  if (!open.length) return null;
  return { ids: open.map((r) => r.id), seen: Object.fromEntries(open.map((r) => [r.id, r.tier])) };
}

/** A row at a tier: a row that became worse (a higher tier) is news again. */
export const seenKey = (r: Pick<OpsAlertRow, 'id' | 'tier'>) => `${r.id}:${r.tier}`;

/**
 * Which of the bell's rows pop up as a toast (review M11, no toast storm): none from the first summary
 * after the page opened (those rows were already there: they fill the seen list silently); then only rows
 * not seen before at their tier, HIGH, allowed to toast (lib/alerts/catalog.ts deliveryOf), at most
 * ALERT_TOAST_MAX. Returns the seen list to keep (bounded).
 */
export function newAlertToasts(seen: ReadonlySet<string> | null, latest: OpsAlertRow[]): { toasts: OpsAlertRow[]; seen: Set<string> } {
  const next = new Set(seen ?? []);
  const fresh = latest.filter((r) => !next.has(seenKey(r)));
  for (const r of latest) next.add(seenKey(r));
  // Keep the list small: the newest keys win (a Set keeps insertion order).
  while (next.size > 500) next.delete(next.values().next().value as string);
  if (seen === null) return { toasts: [], seen: next };
  return { toasts: fresh.filter((r) => r.severity === 'HIGH' && r.mayToast && r.state === 'OPEN').slice(0, ALERT_TOAST_MAX), seen: next };
}

/**
 * The "Checked" line of the bell and the Alerts page (review M2: nobody could tell when the sweep had
 * stopped): the last good check, or a warning when it is overdue or failed. Null while there is nothing
 * to say (no answer yet).
 */
export function sweepCheckText(s: SweepCheck | null | undefined, timezone: string): { text: string; warn: boolean } | null {
  if (!s) return null;
  const at = s.checkedAt ? alertTime(s.checkedAt, timezone) : null;
  if (s.checkStale) {
    return { text: `${at ? `Alerts last checked ${at}` : 'Alerts not checked yet since the server started'}: new alerts may be missing. Tell the administrator (the server log says why).`, warn: true };
  }
  if (s.checkFailed) return { text: `${at ? `Checked ${at}; ` : ''}the last check failed: some alerts may be missing.`, warn: true };
  return at ? { text: `Checked ${at}`, warn: false } : null;
}

/** The bell's colour: red with a HIGH open, amber with any open, none without. */
export function bellTone(s: { open: number; high: number }): 'high' | 'warn' | 'none' {
  return s.high > 0 ? 'high' : s.open > 0 ? 'warn' : 'none';
}
