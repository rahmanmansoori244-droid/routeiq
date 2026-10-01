/**
 * A delivery time for ONE order (owner decision 1 Oct 2026, item 1): an urgent delivery or a time
 * promised to the customer. The dispatcher sets it on the day screen with a short reason; it does
 * not change the customer master. The optimizer plans the order's stop with it (it replaces the
 * customer's receiving hours for that visit), and the plan screen, the Excel workbook, the driver
 * PDF and the WhatsApp message show it as "Promised 10:00-11:00". Pure (no database), so the day
 * screen, the route and the planner share one reading of it.
 */
import { fmtHhmm, parseHhmm } from './time';

export const DELIVERY_TIME_REASONS = ['URGENT', 'PROMISED', 'OTHER'] as const;
export type DeliveryTimeReason = (typeof DELIVERY_TIME_REASONS)[number];

export const DELIVERY_TIME_REASON_TEXT: Record<DeliveryTimeReason, string> = {
  URGENT: 'Urgent',
  PROMISED: 'Promised to customer',
  OTHER: 'Other',
};

/** Longest note kept with a delivery time. */
export const DELIVERY_TIME_NOTE_MAX = 200;

/** A delivery time of one order. One end may be empty ("by 10:00", "from 14:00"), never both. */
export interface OrderTime {
  startMin: number | null;
  endMin: number | null;
  reason: DeliveryTimeReason;
  note: string | null;
}

/** The Order columns that hold it. */
export interface OrderTimeColumns {
  deliveryStartMin: number | null;
  deliveryEndMin: number | null;
  deliveryTimeReason: string | null;
  deliveryTimeNote?: string | null;
}

const isReason = (r: unknown): r is DeliveryTimeReason => typeof r === 'string' && (DELIVERY_TIME_REASONS as readonly string[]).includes(r);

/** The order's own delivery time, or null when it has none (the customer's hours apply). */
export function orderTimeOf(o: OrderTimeColumns): OrderTime | null {
  if (o.deliveryStartMin == null && o.deliveryEndMin == null) return null;
  return {
    startMin: o.deliveryStartMin ?? null,
    endMin: o.deliveryEndMin ?? null,
    reason: isReason(o.deliveryTimeReason) ? o.deliveryTimeReason : 'OTHER',
    note: o.deliveryTimeNote?.trim() ? o.deliveryTimeNote.trim() : null,
  };
}

/** A window minute as people read it: 1440 is "24:00" (end of the day), not "00:00 +1". */
export function clockText(min: number): string {
  return min === 1440 ? '24:00' : fmtHhmm(min);
}

/** "Promised 10:00–11:00", "Promised by 10:00" or "Promised from 14:00" (what every output shows). */
export function promisedText(t: Pick<OrderTime, 'startMin' | 'endMin'>): string {
  if (t.startMin != null && t.endMin != null) return `Promised ${clockText(t.startMin)}–${clockText(t.endMin)}`;
  if (t.endMin != null) return `Promised by ${clockText(t.endMin)}`;
  return `Promised from ${clockText(t.startMin ?? 0)}`;
}

export type OrderTimeCheck = { ok: true; time: OrderTime } | { ok: false; error: string };

/** Checks a delivery time as the route receives it (minutes). The same rules as the dialog. */
export function checkOrderTime(input: { startMin?: number | null; endMin?: number | null; reason?: string | null; note?: string | null }): OrderTimeCheck {
  const startMin = input.startMin ?? null;
  const endMin = input.endMin ?? null;
  if (startMin === null && endMin === null) return { ok: false, error: 'Give a start or an end time (or both).' };
  for (const m of [startMin, endMin]) {
    if (m !== null && (!Number.isInteger(m) || m < 0 || m > 1440)) return { ok: false, error: 'A time must be between 00:00 and 24:00.' };
  }
  if (startMin !== null && endMin !== null && endMin <= startMin) return { ok: false, error: 'The end must be after the start.' };
  if (!isReason(input.reason)) return { ok: false, error: 'Choose a reason: Urgent, Promised to customer or Other.' };
  const note = input.note?.trim() ? input.note.trim() : null;
  if (note && note.length > DELIVERY_TIME_NOTE_MAX) return { ok: false, error: `The note is too long (at most ${DELIVERY_TIME_NOTE_MAX} characters).` };
  if (input.reason === 'OTHER' && !note) return { ok: false, error: 'Reason "Other": write a short note saying why.' };
  return { ok: true, time: { startMin, endMin, reason: input.reason, note } };
}

/** The dialog's form as typed ('' = empty). */
export interface OrderTimeForm {
  start: string;
  end: string;
  reason: string;
  note: string;
}

/** Reads the dialog's form (HH:MM, strict) and checks it; the body PUT /api/orders/:id/delivery-time takes. */
export function orderTimeFromForm(f: OrderTimeForm): OrderTimeCheck {
  let startMin: number | null;
  let endMin: number | null;
  try {
    startMin = parseHhmm(f.start);
  } catch {
    return { ok: false, error: `Start "${f.start.trim()}" is not a time. Use HH:MM, e.g. 10:00.` };
  }
  try {
    endMin = parseHhmm(f.end);
  } catch {
    return { ok: false, error: `End "${f.end.trim()}" is not a time. Use HH:MM, e.g. 11:00 (24:00 = midnight at the end of the day).` };
  }
  return checkOrderTime({ startMin, endMin, reason: f.reason, note: f.note });
}

/** The receiving hours one stop is planned with. */
export interface StopWindow {
  hardStart: number | null;
  hardEnd: number | null;
  prefStart: number | null;
  prefEnd: number | null;
  /** The delivery time of the stop's orders that the stop is planned with; null = the customer's hours. */
  promised: OrderTime | null;
  /** Two orders of the customer have delivery times that do not overlap: the earliest is used. */
  conflict: boolean;
  /**
   * A time with one end only lies outside the customer's receiving hours (e.g. "Promised from 15:00"
   * at a shop that closes at 14:00): the visit is planned with the promised time alone, and the plan
   * warns.
   */
  outsideHours: boolean;
}

/** The part of [start, end] inside [lo, hi] (null = no limit), or null when nothing is left. */
function clip(start: number | null, end: number | null, lo: number | null, hi: number | null): [number | null, number | null] | null {
  const s = start === null ? lo : lo === null ? start : Math.max(start, lo);
  const e = end === null ? hi : hi === null ? end : Math.min(end, hi);
  return s !== null && e !== null && e <= s ? null : [s, e];
}

/**
 * The window a customer's stop is planned with. All open orders of one customer are delivered in
 * one visit, so when any of them has its own delivery time the visit is planned within it: within
 * all of them when several overlap; when they do not overlap, the one that ends first (and
 * `conflict` is set so the plan warns).
 * A time with both ends (from all the orders together) replaces the customer's receiving hours, hard
 * and preferred (an urgent delivery may be outside them: the dispatcher agreed it with the customer).
 * A time with one end only ("Promised from 14:00", "Promised by 10:00") sets that end and keeps the
 * customer's own hours on the open side - "from 14:00" is never after closing (the finish-by-closing
 * rule), "by 10:00" never before opening - and its preferred hours inside what is left. When the
 * two do not meet, the promised time alone is used and `outsideHours` is set so the plan warns.
 * No order with a delivery time: the customer's hours (`eff`) as they are.
 */
export function stopWindowFor(
  eff: { hardStart: number | null; hardEnd: number | null; prefStart: number | null; prefEnd: number | null },
  orders: readonly OrderTimeColumns[],
): StopWindow {
  const times = orders.map(orderTimeOf).filter((t): t is OrderTime => t !== null);
  if (!times.length) return { hardStart: eff.hardStart, hardEnd: eff.hardEnd, prefStart: eff.prefStart, prefEnd: eff.prefEnd, promised: null, conflict: false, outsideHours: false };
  const starts = times.map((t) => t.startMin).filter((m): m is number => m !== null);
  const ends = times.map((t) => t.endMin).filter((m): m is number => m !== null);
  let start = starts.length ? Math.max(...starts) : null;
  let end = ends.length ? Math.min(...ends) : null;
  let conflict = false;
  let used = times;
  if (start !== null && end !== null && end <= start) {
    conflict = true;
    const first = [...times].sort((a, b) => (a.endMin ?? 1441) - (b.endMin ?? 1441) || (a.startMin ?? -1) - (b.startMin ?? -1))[0]!;
    start = first.startMin;
    end = first.endMin;
    used = [first];
  }
  const notes = [...new Set(used.map((t) => t.note).filter((n): n is string => !!n))];
  let hard: [number | null, number | null] = [start, end];
  let pref: [number | null, number | null] = [null, null];
  let outsideHours = false;
  if (start === null || end === null) {
    // One end only: the promised end, and the customer's own hours on the open side.
    const s = start ?? eff.hardStart;
    const e = end ?? eff.hardEnd;
    const kept: [number | null, number | null] | null = s !== null && e !== null && e <= s ? null : [s, e];
    if (kept) {
      hard = kept;
      const p = eff.prefStart === null && eff.prefEnd === null ? null : clip(eff.prefStart, eff.prefEnd, kept[0], kept[1]);
      if (p) pref = p;
    } else {
      outsideHours = true;
    }
  }
  return {
    hardStart: hard[0],
    hardEnd: hard[1],
    prefStart: pref[0],
    prefEnd: pref[1],
    outsideHours,
    promised: {
      startMin: start,
      endMin: end,
      reason: used.some((t) => t.reason === 'URGENT') ? 'URGENT' : used[0]!.reason,
      note: notes.length ? notes.join('; ').slice(0, DELIVERY_TIME_NOTE_MAX) : null,
    },
    conflict,
  };
}

/** The same delivery time (start and end): what a stop is planned with. A reason or a note is not. */
export function samePromisedTime(a: Pick<OrderTime, 'startMin' | 'endMin'> | null | undefined, b: Pick<OrderTime, 'startMin' | 'endMin'> | null | undefined): boolean {
  return (a?.startMin ?? null) === (b?.startMin ?? null) && (a?.endMin ?? null) === (b?.endMin ?? null);
}

/** Where an order sits on a plan version (plannedVisitOrders). */
export interface OrderPlacement {
  orderId: string;
  /** On a load that is locked or later (frozen). */
  frozen: boolean;
  /**
   * The cases of each order line it carries (a split portion, RouteAssignment.portionLinesJson read
   * with readPortionLines); null = the whole order.
   */
  lines: readonly { lineId: string; cases: number }[] | null;
  /** When the stop it is on was planned (its snapshot's capturedAt); null = not known. */
  capturedAt: string | null;
}

/**
 * Every case of the order is in `on` (cases per order line id, e.g. what frozen loads carry), at
 * least one of them: buildDispatchRequest's "every case is already on frozen loads" (a part of the
 * order on them and nothing of it left to plan), which leaves the order out of the plan.
 */
export function allCasesOn(lines: readonly { id: string; cases: number }[], on: ReadonlyMap<string, number>): boolean {
  return lines.some((l) => l.cases > 0 && (on.get(l.id) ?? 0) > 0) && lines.every((l) => (on.get(l.id) ?? 0) >= l.cases);
}

/** Why a plan leaves an order unserved before the optimizer when a case is heavier than any truck. */
const TOO_HEAVY = 'EXCEEDS_ANY_TRUCK_CAPACITY';

/**
 * The orders a plan left unserved whole as heavier than any truck (its UnservedOrder rows with that
 * reason and no portion). buildDispatchRequest leaves such an order out of its customer's visit, so
 * the visit never carried its delivery time (plannedVisitOrders). The optimizer's own "larger than
 * any truck" of a whole stop is that customer's only stop of the plan: nothing of it is judged.
 */
export function leftOutWhole(unserved: readonly { orderId: string; reasonCode: string; portionLinesJson: unknown }[]): Set<string> {
  return new Set(unserved.filter((u) => u.reasonCode === TOO_HEAVY && !Array.isArray(u.portionLinesJson)).map((u) => u.orderId));
}

/**
 * The orders a customer's planned stop is judged with now (data collection review). All open orders
 * of a customer go in one visit, and every part of a split customer is planned within their
 * delivery times (buildDispatchRequest), so a stop is judged with all of the customer's orders of the
 * day - on this load, on another load or left unserved - not only the part on its own load. Except
 * what that plan left out, as buildDispatchRequest does:
 *  - an order with every case on loads that were already locked when the stop's plan was made, whole
 *    or in split portions (a split customer stores every order of every part as a portion; third
 *    review): that optimization did not see it (it came from an earlier plan, captured before the stop;
 *    not known: as a re-plan now, which leaves frozen orders out). An order locked after the plan was
 *    made, or with a case still open then, still counts;
 *  - `leftOut`: orders the stop's plan left unserved whole as heavier than any truck (leftOutWhole);
 *    pass them only for a stop of that plan (one on a PLANNED load).
 */
export function plannedVisitOrders<T extends { id: string; lines: readonly { id: string; cases: number }[] }>(
  orders: readonly T[],
  placements: readonly OrderPlacement[],
  stopCapturedAt: string | null,
  leftOut: ReadonlySet<string> = new Set(),
): T[] {
  const at = stopCapturedAt ? Date.parse(stopCapturedAt) : Number.NaN;
  const whole = new Set<string>();
  // Cases per order line on loads locked before the stop was planned.
  const lockedCases = new Map<string, number>();
  for (const p of placements) {
    if (!p.frozen) continue;
    const t = p.capturedAt ? Date.parse(p.capturedAt) : Number.NaN;
    if (Number.isFinite(at) && Number.isFinite(t) && t >= at) continue;
    if (!p.lines) whole.add(p.orderId);
    else for (const l of p.lines) lockedCases.set(l.lineId, (lockedCases.get(l.lineId) ?? 0) + l.cases);
  }
  return orders.filter((o) => !leftOut.has(o.id) && !whole.has(o.id) && !(lockedCases.size > 0 && allCasesOn(o.lines, lockedCases)));
}

/** A planned stop's promised time as kept in the plan inputs (StopFacts.promised), or null. */
export function readPromised(json: unknown): OrderTime | null {
  if (!json || typeof json !== 'object') return null;
  const p = json as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const startMin = num(p.startMin);
  const endMin = num(p.endMin);
  if (startMin === null && endMin === null) return null;
  return { startMin, endMin, reason: isReason(p.reason) ? p.reason : 'OTHER', note: typeof p.note === 'string' && p.note.trim() ? p.note.trim() : null };
}
