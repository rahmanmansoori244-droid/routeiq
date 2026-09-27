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

/**
 * A load that never left the depot (PLANNED, LOCKED or LOADING): the only kind of load that can
 * hold carried cases. What left (DISPATCHED, COMPLETED) was delivered - also the part of a split
 * order whose rest was carried - so such a load shows no "carried over" mark.
 */
export function carriedLoadShows(status: string): boolean {
  return status === 'PLANNED' || status === 'LOCKED' || status === 'LOADING';
}

/**
 * What to do with a load of an earlier day that still holds orders brought forward to a later day
 * (the end of the 409 ORDERS_CARRIED answer and the plan screen's badge). `onlyCarried`: the load
 * holds nothing else. Such a load needs nothing: a re-plan of its day has nothing to plan when
 * nothing else is open, so the answer never sends the dispatcher to one.
 */
export function carriedLoadRemedy(status: string, onlyCarried: boolean): string {
  if (onlyCarried) {
    return `This load holds nothing else: leave it as it is. It stays in this plan for the record and is never loaded or dispatched${status === 'PLANNED' ? '' : ' (you can put it back to Planned)'}; nothing needs to be re-planned.`;
  }
  return status === 'PLANNED'
    ? 'Re-plan this day to plan its other orders without them.'
    : 'To deliver its other orders, put the load back to Planned and re-plan this day: the re-plan leaves the brought-forward orders out.';
}

/** A load of the plan screen holds only orders brought forward to a later day. */
export function holdsOnlyCarried(l: { carriedAway: number; stops: readonly { orderIds: readonly string[] }[] }): boolean {
  return l.carriedAway > 0 && l.carriedAway === new Set(l.stops.flatMap((s) => s.orderIds)).size;
}

/**
 * What a re-plan of this plan would still plan (the input of nothingToReplan): a PLANNED load
 * holding only orders brought forward, and an unserved row brought forward, are not work - the
 * re-plan leaves those orders out (ordersInScopeWhere), and the server answers NOTHING_TO_PLAN.
 */
export function replanWork(
  loads: readonly { status: string; carriedAway: number; stops: readonly { orderIds: readonly string[] }[] }[],
  unserved: readonly { carriedTo: string | null }[],
): { loadStatuses: string[]; unservedOrders: number } {
  return {
    loadStatuses: loads.filter((l) => !(l.status === 'PLANNED' && holdsOnlyCarried(l))).map((l) => l.status),
    unservedOrders: unserved.filter((u) => !u.carriedTo).length,
  };
}

/** A carried original and its copy in an order list: "Carried over to 28 Sep" / "Carried over from 27 Sep". */
export function orderCarryMarks(o: { carriedTo?: { deliveryDate: Date | string } | null; carriedFromDate?: Date | string | null }): { to: string | null; from: string | null } {
  const iso = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  return { to: o.carriedTo ? iso(o.carriedTo.deliveryDate) : null, from: o.carriedFromDate ? iso(o.carriedFromDate) : null };
}

/**
 * Totals of an order list without the carried originals (their cases are counted on the day they
 * went to, by their copy): `carried` = how many were left out.
 */
export function orderListTotals(rows: readonly { totalCases: number; totalWeightKg: number; carriedTo?: unknown }[]): { cases: number; kg: number; carried: number } {
  let cases = 0;
  let kg = 0;
  let carried = 0;
  for (const r of rows) {
    if (r.carriedTo) {
      carried++;
      continue;
    }
    cases += r.totalCases;
    kg += r.totalWeightKg;
  }
  return { cases, kg, carried };
}
