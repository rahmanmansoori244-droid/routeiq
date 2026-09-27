/**
 * PR9 "Bring forward": the words every screen and paper uses for an order carried from one day to
 * another. Pure and browser-safe (the day screen, the plan screen, the driver sheets and the Excel
 * workbook all read these), so the marks never drift apart.
 */
import { fmtDayMonth } from './time';

/** Badge of an order brought forward from an earlier day: "Carried over from 26 Sep" (the date it was first due). */
export function carriedFromBadge(firstDateIso: string): string {
  return `Carried over from ${fmtDayMonth(firstDateIso)}`;
}

/** Mark of an order of an earlier day brought forward since: "Carried over to 28 Sep". */
export function carriedToBadge(toDateIso: string): string {
  return `Carried over to ${fmtDayMonth(toDateIso)}`;
}

/** What the day screen offers by default: every listed order that can be brought forward. */
export function defaultCarrySelection(candidates: readonly { orderId: string; blocked: unknown }[]): Set<string> {
  return new Set(candidates.filter((c) => !c.blocked).map((c) => c.orderId));
}

/** The POST body's selection: each selected order with the open cases the list showed (the expected state). */
export function carrySelectionPayload(candidates: readonly { orderId: string; cases: number; blocked: unknown }[], selected: ReadonlySet<string>) {
  return candidates.filter((c) => selected.has(c.orderId) && !c.blocked).map((c) => ({ orderId: c.orderId, cases: c.cases }));
}

/** The toast after "Bring forward": what was carried and what the dispatcher does next. */
export function carryDoneText(res: { orders: number; cases: number; skipped: unknown[]; replanNeeded: boolean }, dateIso: string): string {
  const day = fmtDayMonth(dateIso);
  if (!res.orders) return res.skipped.length ? `Nothing new to bring forward: ${res.skipped.length} order(s) were already brought forward.` : 'Nothing was brought forward.';
  const next = res.replanNeeded
    ? `RE-PLAN to add them to the plan: locked, loading and dispatched loads stay exactly as they are.`
    : `OPTIMIZE plans them with the other orders of ${day}.`;
  const skipped = res.skipped.length ? ` ${res.skipped.length} order(s) were already brought forward.` : '';
  return `${res.orders} order(s) (${res.cases.toLocaleString()} cases) brought forward to ${day}. ${next}${skipped}`;
}

/** The carried-over line of a stop on the driver sheet and the Excel load sheet, or null. */
export function carriedStopText(s: { carriedFrom: string | null; carriedTo: string | null }): string | null {
  if (s.carriedTo) return `CARRIED OVER to ${fmtDayMonth(s.carriedTo)} - not delivered on this day`;
  if (s.carriedFrom) return `CARRIED OVER from ${fmtDayMonth(s.carriedFrom)} (not delivered that day)`;
  return null;
}
