/**
 * The rules of a delivery result (owner request 4 Oct 2026, spec sections 8.2, 8.3, 9.4 and 13.3).
 * Pure: the driver API (event-service.ts) and, in Part 3, the dispatcher's "Record outcome" apply them.
 *
 * - normalizeResult: the lines and the reason of Delivered / Partly / Not delivered (section 8.2).
 * - photoRule: "Photo proof required" with its only exception, "Camera not working".
 * - writeRule: who may write what on a load in which state (section 8.3): after a trip is closed the
 *   driver link can only FILL GAPS (a stop that had no result at completion), flagged late.
 * - carryChangeCheck: a change that would shrink cases already brought forward is refused (section 9.4).
 * - clocks: one skew correction for every device time, then the clamp to the day (section 13.3).
 */
import { NOT_DELIVERED_REASONS, type NotDeliveredReasonName } from '../driver-link/manifest-types';
import type { OutcomeName } from './visit';

export const NOTE_MAX = 300;
export const OTHER_NOTE_MIN = 3;
export const MAX_DRIVER_PHOTOS_PER_STOP = 3;
/** A skew under this is the network, not a wrong phone clock: not corrected. */
export const SKEW_TOLERANCE_MS = 2 * 60_000;
/** Driver times may start this long before the delivery day's midnight (an early start). */
export const EARLY_START_MS = 6 * 60 * 60_000;

/** The refusal codes of a driver action (spec section 8.1). */
export type RefusalCode =
  | 'STOP_NOT_FOUND'
  | 'STOP_AMBIGUOUS'
  | 'LOAD_COMPLETED'
  | 'OUTCOME_CARRIED'
  | 'PHOTO_REQUIRED'
  | 'INVALID'
  | 'TIME_OUT_OF_RANGE'
  | 'LOAD_NOT_DISPATCHED';

/** The words of each refusal, for the driver page (English and Arabic). */
export const REFUSAL_TEXT: Record<RefusalCode, { en: string; ar: string }> = {
  STOP_NOT_FOUND: { en: 'This stop is no longer on your trip. Call your dispatcher.', ar: 'هذه المحطة لم تعد في رحلتك. اتصل بمسؤول التوزيع.' },
  // An entry saved by the page before the update of 7 Oct 2026 names a trip by its number only, and this
  // truck has that trip number at two depots today: it is not recorded against either (stop-key.ts).
  STOP_AMBIGUOUS: {
    en: 'Not recorded: this entry was saved before an update and fits two trips with the same number today. Call your dispatcher to record it.',
    ar: 'لم يتم التسجيل: هذا الإدخال حُفظ قبل تحديث ويطابق رحلتين بنفس الرقم اليوم. اتصل بمسؤول التوزيع لتسجيله.',
  },
  LOAD_COMPLETED: { en: 'This trip is already closed. Call your dispatcher to change it.', ar: 'هذه الرحلة مغلقة. اتصل بمسؤول التوزيع لتغييرها.' },
  OUTCOME_CARRIED: { en: 'Already moved to another day by the office. Call your dispatcher.', ar: 'تم نقلها إلى يوم آخر من المكتب. اتصل بمسؤول التوزيع.' },
  PHOTO_REQUIRED: { en: 'A photo is required for this result.', ar: 'الصورة مطلوبة لهذه النتيجة.' },
  INVALID: { en: 'This entry could not be saved. Check it and try again.', ar: 'تعذّر حفظ هذا الإدخال. تحقق منه وحاول مرة أخرى.' },
  TIME_OUT_OF_RANGE: { en: 'The phone time is outside this delivery day. Check the phone clock.', ar: 'وقت الهاتف خارج يوم التوصيل هذا. تحقق من ساعة الهاتف.' },
  LOAD_NOT_DISPATCHED: { en: 'Your dispatcher has not marked this trip as left yet.', ar: 'لم يسجّل مسؤول التوزيع خروج هذه الرحلة بعد.' },
};

export interface PlannedLine {
  orderId: string;
  lineId: string;
  plannedCases: number;
}

export interface ResultInput {
  outcome: OutcomeName | null;
  reason?: string | null;
  note?: string | null;
  lines?: { lineId: string; delivered: number }[] | null;
}

export type NormalizedResult =
  | { ok: true; outcome: null }
  | {
      ok: true;
      outcome: OutcomeName;
      reason: NotDeliveredReasonName | null;
      note: string | null;
      lines: { orderId: string; lineId: string; planned: number; delivered: number }[];
      casesDelivered: number;
      /** A Partly result with every line full became Delivered. */
      coerced: boolean;
    }
  | { ok: false; code: 'INVALID'; message: string };

const isReason = (r: unknown): r is NotDeliveredReasonName => typeof r === 'string' && (NOT_DELIVERED_REASONS as readonly string[]).includes(r);

function cleanNote(note: string | null | undefined): string | null {
  const n = (note ?? '').replace(/\s+/g, ' ').trim();
  return n ? n : null;
}

/**
 * The result as it is stored (spec section 8.2). Lines must be the stop's planned lines; a line not
 * sent defaults to all its cases (Delivered, Partly) or to 0 (Not delivered); each value is an integer
 * in 0..planned. Partly with every line full becomes Delivered; Partly with every line 0 is refused
 * ("Choose Not delivered"). Partly and Not delivered need a reason; Other needs a note of 3-300
 * characters; any note is at most 300 characters.
 */
export function normalizeResult(planned: readonly PlannedLine[], input: ResultInput): NormalizedResult {
  if (input.outcome === null) return { ok: true, outcome: null };
  if (input.outcome !== 'DELIVERED' && input.outcome !== 'PARTLY_DELIVERED' && input.outcome !== 'NOT_DELIVERED') {
    return { ok: false, code: 'INVALID', message: 'Unknown result.' };
  }
  const note = cleanNote(input.note);
  if (note && note.length > NOTE_MAX) return { ok: false, code: 'INVALID', message: `The note is longer than ${NOTE_MAX} characters.` };
  const byId = new Map(planned.map((l) => [l.lineId, l]));
  const sent = new Map<string, number>();
  for (const l of input.lines ?? []) {
    const p = byId.get(l.lineId);
    if (!p) return { ok: false, code: 'INVALID', message: 'A line is not on this stop.' };
    if (sent.has(l.lineId)) return { ok: false, code: 'INVALID', message: 'A line is sent twice.' };
    if (!Number.isInteger(l.delivered) || l.delivered < 0 || l.delivered > p.plannedCases) {
      return { ok: false, code: 'INVALID', message: `Cases delivered must be a whole number from 0 to ${p.plannedCases}.` };
    }
    sent.set(l.lineId, l.delivered);
  }
  let outcome: OutcomeName = input.outcome;
  const value = (l: PlannedLine) => (outcome === 'DELIVERED' ? l.plannedCases : outcome === 'NOT_DELIVERED' ? 0 : (sent.get(l.lineId) ?? l.plannedCases));
  let coerced = false;
  if (outcome === 'PARTLY_DELIVERED') {
    const vals = planned.map(value);
    const total = vals.reduce((a, v) => a + v, 0);
    const full = planned.reduce((a, l) => a + l.plannedCases, 0);
    if (total >= full) {
      outcome = 'DELIVERED';
      coerced = true;
    } else if (total <= 0) {
      return { ok: false, code: 'INVALID', message: 'No cases delivered: choose Not delivered.' };
    }
  }
  let reason: NotDeliveredReasonName | null = null;
  if (outcome !== 'DELIVERED') {
    if (!isReason(input.reason)) return { ok: false, code: 'INVALID', message: 'Choose a reason.' };
    reason = input.reason;
    if (reason === 'OTHER' && (!note || note.length < OTHER_NOTE_MIN)) return { ok: false, code: 'INVALID', message: 'Write the reason (at least 3 characters).' };
  }
  const lines = planned.map((l) => ({ orderId: l.orderId, lineId: l.lineId, planned: l.plannedCases, delivered: value(l) }));
  return { ok: true, outcome, reason, note, lines, casesDelivered: lines.reduce((a, l) => a + l.delivered, 0), coerced };
}

/**
 * "Photo proof required" (company setting, default on): a driver's Delivered or Partly needs a photo
 * key, unless the driver tapped "Camera not working" (the only exception: a broken camera or an in-app
 * browser must never block a delivery). The photos themselves may arrive later. The office is not held
 * to it. A changed or redone result needs no new photo when an earlier Delivered or Partly of the
 * driver at this stop named one (`proofPhotos`, proofPhotoKeys): a photo taken for a Not delivered
 * (the closed shutter) is no proof of a delivery made on a return visit.
 */
export function photoRule(args: {
  required: boolean;
  byDriver: boolean;
  outcome: OutcomeName | null;
  photoKeys: readonly string[];
  noPhotoReason: string | null | undefined;
  proofPhotos?: number;
}): 'ok' | 'PHOTO_REQUIRED' {
  if (!args.required || !args.byDriver || args.outcome === null || args.outcome === 'NOT_DELIVERED') return 'ok';
  if (args.photoKeys.length >= 1 || args.noPhotoReason === 'CAMERA_FAILED' || (args.proofPhotos ?? 0) >= 1) return 'ok';
  return 'PHOTO_REQUIRED';
}

/**
 * The photo keys that are proof of a delivery at a stop (pure): the keys named by the driver's
 * Delivered and Partly results (OUTCOME events not written by the office). Counted whether or not the
 * photo has arrived yet: a phone sends a result before its photos (the queue's order), so a change
 * sent in the same batch, or while the photo still waits for its position or backs off, finds the
 * earlier result's keys. The phone counts the same keys (StopResult.proofPhotos plus its queued
 * Delivered / Partly results), so the two never disagree.
 */
export function proofPhotoKeys(events: readonly { kind: string; source: string; payload: Record<string, unknown> | null }[]): Set<string> {
  const keys = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'OUTCOME' || e.source === 'DISPATCHER') continue;
    const outcome = e.payload?.outcome;
    if (outcome !== 'DELIVERED' && outcome !== 'PARTLY_DELIVERED') continue;
    const named = e.payload?.photoKeys;
    if (Array.isArray(named)) for (const k of named) if (typeof k === 'string') keys.add(k);
  }
  return keys;
}

export type WriteKind = 'ARRIVE' | 'DEPART' | 'OUTCOME' | 'BACK_AT_DEPOT' | 'PHOTO';

export type WriteDecision = { ok: true; late: boolean } | { ok: false; code: RefusalCode; transient: boolean };

/**
 * Who may write, and when (spec section 8.3), for a driver-page write. `office`: a signed-in RouteIQ
 * user (PLANNER+) on the driver page writes as the dispatcher: any time on a DISPATCHED or COMPLETED
 * load, never late.
 *
 * Driver link:
 * - DISPATCHED: yes (late when received after the link's expiry, in the upload grace);
 * - COMPLETED: gap-filling only: `at` before the completion, an OUTCOME only for a stop that had no
 *   result at completion; ARRIVE, DEPART, PHOTO and BACK_AT_DEPOT add timing or proof only; all late;
 * - LOCKED / LOADING: ARRIVE and DEPART are kept on the phone (transient LOAD_NOT_DISPATCHED); the rest refused;
 * - PLANNED: refused.
 */
export function writeRule(a: {
  kind: WriteKind;
  office: boolean;
  loadStatus: string;
  at: Date;
  statusChangedAt: Date | null;
  /** COMPLETED: the stop had a result when the load was completed (an OUTCOME received at or before it). */
  hadResultAtCompletion: boolean;
  receivedAt: Date;
  expiresAt: Date;
}): WriteDecision {
  const s = a.loadStatus;
  if (s === 'PLANNED') return { ok: false, code: 'LOAD_NOT_DISPATCHED', transient: false };
  if (s === 'LOCKED' || s === 'LOADING') {
    return { ok: false, code: 'LOAD_NOT_DISPATCHED', transient: a.kind === 'ARRIVE' || a.kind === 'DEPART' };
  }
  if (s === 'DISPATCHED') return { ok: true, late: !a.office && a.receivedAt.getTime() > a.expiresAt.getTime() };
  if (s === 'COMPLETED') {
    if (a.office) return { ok: true, late: false };
    if (a.statusChangedAt && a.at.getTime() >= a.statusChangedAt.getTime()) return { ok: false, code: 'LOAD_COMPLETED', transient: false };
    if (a.kind === 'OUTCOME' && a.hadResultAtCompletion) return { ok: false, code: 'LOAD_COMPLETED', transient: false };
    return { ok: true, late: true };
  }
  return { ok: false, code: 'STOP_NOT_FOUND', transient: false };
}

/** The basis a brought-forward copy was made from (Order.carryBasisJson on the copy, Part 3). */
export interface CarryBasis {
  visits: { visitId: string; lines: { lineId: string; notDelivered: number }[] }[];
}

export function readCarryBasis(json: unknown): CarryBasis {
  const visits: CarryBasis['visits'] = [];
  const raw = json && typeof json === 'object' ? (json as { visits?: unknown }).visits : null;
  if (!Array.isArray(raw)) return { visits };
  for (const v of raw) {
    const o = v as { visitId?: unknown; lines?: unknown };
    if (typeof o?.visitId !== 'string' || !Array.isArray(o.lines)) continue;
    const lines = (o.lines as unknown[]).flatMap((l) => {
      const x = l as { lineId?: unknown; notDelivered?: unknown };
      return typeof x?.lineId === 'string' && typeof x.notDelivered === 'number' ? [{ lineId: x.lineId, notDelivered: x.notDelivered }] : [];
    });
    visits.push({ visitId: o.visitId, lines });
  }
  return { visits };
}

/** Whether the visit is part of the copy's basis (its result was brought forward). */
export function inCarryBasis(basis: CarryBasis, visitId: string): boolean {
  return basis.visits.some((v) => v.visitId === visitId);
}

/**
 * The basis rule (spec section 9.4): a change on a visit in the carry basis that would REDUCE the
 * not-delivered cases of a basis line (more delivered, a cleared result) is refused; any other change
 * is stored. `after` = the not-delivered cases per line after the change (a cleared result: 0).
 */
export function carryChangeCheck(basis: CarryBasis, visitId: string, after: ReadonlyMap<string, number>): { ok: true } | { ok: false; lines: { lineId: string; carried: number; after: number }[] } {
  const v = basis.visits.find((x) => x.visitId === visitId);
  if (!v) return { ok: true };
  const short = v.lines.filter((l) => (after.get(l.lineId) ?? 0) < l.notDelivered).map((l) => ({ lineId: l.lineId, carried: l.notDelivered, after: after.get(l.lineId) ?? 0 }));
  return short.length ? { ok: false, lines: short } : { ok: true };
}

// ---------------------------------------------------------------------------------------
// Clocks (spec section 13.3)
// ---------------------------------------------------------------------------------------

/** receivedAt - clientNow, or 0 when the phone's clock is within 2 minutes of the server (or unknown). */
export function clockSkewMs(receivedAt: Date, clientNow: Date | null): number {
  if (!clientNow || Number.isNaN(clientNow.getTime())) return 0;
  const skew = receivedAt.getTime() - clientNow.getTime();
  return Math.abs(skew) > SKEW_TOLERANCE_MS ? skew : 0;
}

/** A device time with the skew applied once. */
export function corrected(at: Date, skewMs: number): Date {
  return new Date(at.getTime() + skewMs);
}

/**
 * An action time, corrected: clamped to at most the receipt, then it must lie within
 * [day start - 6 h, the link's expiry]; else TIME_OUT_OF_RANGE.
 */
export function actionTime(rawAt: Date, skewMs: number, bounds: { receivedAt: Date; dayStart: Date; expiresAt: Date }): Date | 'TIME_OUT_OF_RANGE' {
  if (Number.isNaN(rawAt.getTime())) return 'TIME_OUT_OF_RANGE';
  const at = Math.min(corrected(rawAt, skewMs).getTime(), bounds.receivedAt.getTime());
  if (at < bounds.dayStart.getTime() - EARLY_START_MS || at > bounds.expiresAt.getTime()) return 'TIME_OUT_OF_RANGE';
  return new Date(at);
}

/** A photo's capture time, corrected and clamped to [day start - 6 h, receipt] (the raw value is kept apart). */
export function photoTime(rawAt: Date, skewMs: number, bounds: { receivedAt: Date; dayStart: Date }): Date {
  const lo = bounds.dayStart.getTime() - EARLY_START_MS;
  const hi = bounds.receivedAt.getTime();
  const v = Number.isNaN(rawAt.getTime()) ? hi : corrected(rawAt, skewMs).getTime();
  return new Date(Math.min(hi, Math.max(lo, v)));
}

/** The not-delivered cases per line of a stored result (a cleared result: none). */
export function notDeliveredOf(lines: readonly { lineId: string; plannedCases: number; deliveredCases: number | null }[], hasResult: boolean): Map<string, number> {
  return new Map(lines.map((l) => [l.lineId, hasResult ? Math.max(0, l.plannedCases - (l.deliveredCases ?? l.plannedCases)) : 0]));
}
