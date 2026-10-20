/**
 * What the salesman page is sent for one route or truck (owner feedback of 20 Oct 2026: "make it very simple":
 * no trucks, no reasons, no "not before" or "no update" - what is delivered, not delivered, partly delivered, and
 * the approximate time of each customer). Pure, server only: the detailed day (day.ts) said as ONE status and at
 * most ONE time per customer (view-types.ts SalesRow).
 *
 * THE STATUS of a delivery:
 *  - DELIVERED / PARTLY_DELIVERED / NOT_DELIVERED: the result for the route's own lines; a trip of an earlier day
 *    that never left (TRUCK_DID_NOT_GO) is NOT_DELIVERED;
 *  - NOT_CONFIRMED: the trip is over with no result (NO_RESULT), or the truck was there and the result is not in
 *    (VISITED). Never said as delivered or as not delivered without the driver's (or the office's) word: the owner
 *    found the drivers' results partly wrong on 15 Oct 2026, a guess would be worse. Its own button, shown only when
 *    there are some;
 *  - DELAYED: still to come on the delivery day and later than the window printed on the Salesman ETA - its expected
 *    time is after the window (EtaTiming LATE), or the window is over, or the lower bound is already past it;
 *  - ON_THE_WAY: every other delivery still to come: planned, being loaded, next, on the road, still due, and the
 *    truck at the customer (being delivered now).
 * The orders not on a truck: CANCELLED, or NOT_IN_PLAN (moved to another day: with the day; not planned yet or
 * received after planning; left out of the plan or the rest of a split delivery). The same customer's entries of one
 * kind are one row.
 *
 * THE TIME (at most one):
 *  - DELIVERED: when ("10:31"); PARTLY_DELIVERED: the cases (x of y) instead;
 *  - ON_THE_WAY / DELAYED: none while the truck is at the customer (`atCustomer`); else the expected arrival rounded
 *    to 5 minutes, never a time already past: the live time, else "due now" (now: any minute), else the lower bound
 *    while it is still ahead, else the planned arrival while it is still ahead; before the delivery day the planned
 *    arrival. Nothing better than a planned time already past: no time (and never a "no update" line). `inMin`
 *    (minutes from now) only on the delivery day itself.
 *
 * THE ORDER: the deliveries by their time (delivered at, else expected, else planned; the planned order between
 * equals), then the orders cancelled, then those not on a truck.
 */
import { localMinutes } from '../dispatch/time';
import { minutesOnDate } from '../alerts/text';
import { ceil5, hhmm, round5 } from './text';
import { dayRelOf, LATE_TOLERANCE_MIN, type DayDelivery, type DayOffTruck, type DayRel, type DayView } from './day';
import type { SalesOffKind, SalesRouteView, SalesRow } from './view-types';

const has = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const LAST = Number.POSITIVE_INFINITY;

interface Ctx {
  rel: DayRel;
  nowMin: number;
}

const blank = (key: string, customer: string, branch: string | null): Omit<SalesRow, 'status'> => ({
  key,
  customer,
  branch,
  at: null,
  eta: null,
  inMin: null,
  atCustomer: false,
  cases: null,
  off: null,
  movedTo: null,
});

/** The expected arrival to show for a delivery still to come (minutes of the delivery day), or null: see the file comment. */
export function shownEtaMin(d: Pick<DayDelivery, 'eta' | 'plannedMin'>, c: Ctx): number | null {
  if (c.rel === 'FUTURE') return has(d.plannedMin) ? round5(d.plannedMin) : null;
  const floor = ceil5(c.nowMin);
  const e = d.eta;
  if (e && has(e.min)) return Math.max(e.min, floor);
  if (e?.timing === 'DUE_NOW') return floor;
  if (e && has(e.notBeforeMin)) return Math.max(e.notBeforeMin, floor);
  if (has(d.plannedMin) && d.plannedMin >= c.nowMin) return Math.max(round5(d.plannedMin), floor);
  return null;
}

/** Later than the printed window (on the delivery day, not at the customer): see the file comment. */
export function isDelayed(d: Pick<DayDelivery, 'eta' | 'slot'>, c: Ctx): boolean {
  if (c.rel === 'FUTURE') return false;
  if (d.eta?.timing === 'LATE') return true;
  if (!d.slot) return false;
  const bound = d.eta?.notBeforeMin;
  return c.nowMin - d.slot.to >= LATE_TOLERANCE_MIN || (has(bound) && bound - d.slot.to >= LATE_TOLERANCE_MIN);
}

/** One delivery's row and the minute it sorts by. */
function deliveryRow(d: DayDelivery, key: string, c: Ctx): { row: SalesRow; sortMin: number } {
  const base = blank(key, d.customerName, d.branchCode);
  const planned = d.plannedMin ?? LAST;
  switch (d.status) {
    case 'DELIVERED':
      return { row: { ...base, status: 'DELIVERED', at: d.at }, sortMin: d.atMin ?? planned };
    case 'PARTLY_DELIVERED':
      return { row: { ...base, status: 'PARTLY_DELIVERED', cases: d.delivered ? { delivered: d.delivered.cases, of: d.delivered.of } : null }, sortMin: d.atMin ?? planned };
    case 'NOT_DELIVERED':
    case 'TRUCK_DID_NOT_GO':
      return { row: { ...base, status: 'NOT_DELIVERED' }, sortMin: d.atMin ?? planned };
    case 'NO_RESULT':
    case 'VISITED':
      return { row: { ...base, status: 'NOT_CONFIRMED' }, sortMin: planned };
    default: {
      // Still to come: AT_CUSTOMER, NEXT, ON_THE_WAY, PASSED, LOADING, PLANNED.
      const atCustomer = d.status === 'AT_CUSTOMER';
      const status = !atCustomer && isDelayed(d, c) ? 'DELAYED' : 'ON_THE_WAY';
      const shown = atCustomer ? null : shownEtaMin(d, c);
      const inMin = shown !== null && c.rel !== 'FUTURE' ? Math.max(0, shown - c.nowMin) : null;
      return { row: { ...base, status, atCustomer, eta: shown !== null ? hhmm(shown) : null, inMin }, sortMin: atCustomer ? c.nowMin : (shown ?? planned) };
    }
  }
}

const offKindOf = (o: DayOffTruck): SalesOffKind => (o.kind === 'MOVED' ? 'MOVED' : o.kind === 'NOT_PLANNED_YET' || o.kind === 'ADDED_AFTER_PLAN' ? 'NOT_PLANNED_YET' : 'NOT_IN_PLAN');

/** The orders cancelled or not on a truck: one row per customer and kind, cancelled first. */
function offRows(offs: readonly DayOffTruck[]): SalesRow[] {
  const rows = new Map<string, SalesRow>();
  for (const o of offs) {
    const cancelled = o.kind === 'CANCELLED';
    const off = cancelled ? null : offKindOf(o);
    const movedTo = off === 'MOVED' ? o.movedTo : null;
    const id = `${o.customerCode}|${o.branchCode ?? ''}|${off ?? 'CANCELLED'}|${movedTo ?? ''}`;
    if (!rows.has(id)) rows.set(id, { ...blank('', o.customerName, o.branchCode), status: cancelled ? 'CANCELLED' : 'NOT_IN_PLAN', off, movedTo });
  }
  // Stable: the day's own order (kind, customer) within the cancelled and within the rest.
  const rank = (r: SalesRow) => (r.status === 'CANCELLED' ? 0 : 1);
  return [...rows.values()].sort((a, b) => rank(a) - rank(b)).map((r, i) => ({ ...r, key: `o${i + 1}` }));
}

/** One result as the page is sent it (see the file comment). `builtAt`: when the day was read ("updated"). */
export function salesRouteView(v: DayView, o: { date: string; tz: string; now: Date; builtAt: Date }): SalesRouteView {
  const c: Ctx = { rel: dayRelOf(o.date, o.tz, o.now), nowMin: minutesOnDate(o.now, o.date, o.tz) };
  const rows = v.deliveries
    .map((d, i) => ({ ...deliveryRow(d, `d${i + 1}`, c), i }))
    .sort((a, b) => a.sortMin - b.sortMin || a.i - b.i)
    .map((x) => x.row);
  return { kind: v.kind, code: v.code, query: v.query, updated: hhmm(localMinutes(o.builtAt, o.tz)), rows: [...rows, ...offRows(v.offTruck)] };
}
