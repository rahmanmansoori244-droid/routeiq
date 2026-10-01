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
}

/**
 * The window a customer's stop is planned with. All open orders of one customer are delivered in
 * one visit, so when any of them has its own delivery time the visit is planned within it: within
 * all of them when several overlap; when they do not overlap, the one that ends first (and
 * `conflict` is set so the plan warns). It replaces the customer's receiving hours, hard and
 * preferred (an urgent delivery may be outside them: the dispatcher agreed it with the customer).
 * No order with a delivery time: the customer's hours (`eff`) as they are.
 */
export function stopWindowFor(
  eff: { hardStart: number | null; hardEnd: number | null; prefStart: number | null; prefEnd: number | null },
  orders: readonly OrderTimeColumns[],
): StopWindow {
  const times = orders.map(orderTimeOf).filter((t): t is OrderTime => t !== null);
  if (!times.length) return { hardStart: eff.hardStart, hardEnd: eff.hardEnd, prefStart: eff.prefStart, prefEnd: eff.prefEnd, promised: null, conflict: false };
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
  return {
    hardStart: start,
    hardEnd: end,
    prefStart: null,
    prefEnd: null,
    promised: {
      startMin: start,
      endMin: end,
      reason: used.some((t) => t.reason === 'URGENT') ? 'URGENT' : used[0]!.reason,
      note: notes.length ? notes.join('; ').slice(0, DELIVERY_TIME_NOTE_MAX) : null,
    },
    conflict,
  };
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
