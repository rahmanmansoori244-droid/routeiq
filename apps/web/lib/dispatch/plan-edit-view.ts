/**
 * Moves by hand (PR M2/M3, owner decisions of 24 Oct 2026): the request and answer shapes of
 * POST /api/runs/:id/edit/check and POST /api/runs/:id/edit, and the words the Move dialog shows.
 * Browser-safe (no database, no Node): the dialog (app/t/[slug]/dispatch/move-stop-dialog.tsx) and the
 * server (plan-edit.ts) both read it.
 *
 * One change per check and save, one of:
 * - MOVE: a stop of a PLANNED load (one customer visit with all its orders on that load, or one split
 *   part) to another PLANNED load of the same or another truck, at a position or at the best place;
 *   to a new load of a truck (after its last load, before one of its PLANNED loads, or the best place
 *   in its day); or to another position of its own load (a reorder);
 * - REMOVE: the stop taken off the plan (its orders go on the unserved list, reason REMOVED_BY_HAND);
 * - PLACE: an unserved customer visit (all its unserved orders) put on a load as above.
 * Only PLANNED loads change. A LOCKED load must be unlocked first; LOADING, DISPATCHED and COMPLETED
 * loads never change.
 */

/** PLAN_EDIT: off (the default: no Move button, the routes answer 404), check (Check works, Save does not), on. */
export type PlanEditMode = 'OFF' | 'CHECK' | 'ON';

/** PLAN_EDIT=off|check|on, read per request (as FEASIBILITY_GATE). Unset or unknown: OFF. */
export function planEditMode(env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {})): PlanEditMode {
  const v = (env.PLAN_EDIT ?? '').trim().toLowerCase();
  return v === 'on' ? 'ON' : v === 'check' ? 'CHECK' : 'OFF';
}

/**
 * The startup line for PLAN_EDIT (lib/startup-checks.ts logs it as a warning, its only level): the mode when
 * check or on, or that a value it does not know leaves moves by hand off. Null when off.
 */
export function planEditConfigNote(env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {})): string | null {
  const raw = (env.PLAN_EDIT ?? '').trim();
  if (!raw || raw.toLowerCase() === 'off') return null;
  if (!['on', 'check'].includes(raw.toLowerCase())) return `PLAN_EDIT=${raw} is not off, check or on: moves by hand stay off.`;
  return planEditMode(env) === 'ON'
    ? 'PLAN_EDIT=on: dispatchers can move stops by hand and save them as a new plan version.'
    : 'PLAN_EDIT=check: dispatchers can check moves by hand; saving them is off.';
}

/** Where a stop goes. */
export interface EditTarget {
  truckId: string;
  /** A PLANNED load of the truck; null = a new load. */
  loadId: string | null;
  /** On an existing load: the stop's index in that load once it is there (0 = first), or BEST. */
  position?: number | 'BEST';
  /** A new load: the PLANNED load of the truck it goes before (null = after the truck's last load), or BEST. */
  before?: string | null | 'BEST';
}

/** A stop of a PLANNED load: the load and the stop's sequence on it. */
export interface EditSource {
  loadId: string;
  sequence: number;
}

export type PlanEditMove =
  | { kind: 'MOVE'; from: EditSource; to: EditTarget }
  | { kind: 'REMOVE'; from: EditSource }
  | { kind: 'PLACE'; orderId: string; to: EditTarget };

/** What a hand change keeps with the option (`details.manual`): the plan header says "adjusted by hand" from it. */
export interface ManualEdit {
  v: 1;
  at: string;
  byUserId: string;
  parentRunId: string;
  /** Changes by hand on this option so far (copied forward with it). */
  count: number;
  move: PlanEditMove;
  trucks: string[];
  builtAt: string;
  matrix: { provider: string; quality: string };
  previewHash: string;
  /** The option's preference figures were not re-computed for the edited trucks (they are the optimizer's). */
  preferenceApprox: true;
}

/** The option's hand-change block, if it has one. */
export function manualOf(details: unknown): ManualEdit | null {
  const m = (details as { manual?: Partial<ManualEdit> } | null)?.manual;
  return m && typeof m === 'object' && m.v === 1 && typeof m.at === 'string' ? (m as ManualEdit) : null;
}

/** A rule the move breaks (hard: it cannot be saved), in the dispatcher's words. */
export interface EditViolation {
  code: string;
  message: string;
  loadNo: number | null;
  stopLabel: string | null;
  /** By how much: minutes for a time, pallets / cases / kg for a capacity. */
  shortBy: number | null;
}

export interface EditStopView {
  sequence: number;
  label: string;
  cases: number;
  etaMin: number | null;
  startMin: number | null;
  /** "06:00–14:00" / "any time": the receiving hours it is timed with. */
  window: string | null;
  hardOk: boolean | null;
  prefOk: boolean | null;
  /** The stop this change moves. */
  moved: boolean;
}

export interface EditLoadView {
  loadNo: number;
  status: string;
  /** A locked, loading or dispatched load: it never changes (shown for the truck's day). */
  kept: boolean;
  departMin: number;
  returnMin: number;
  km: number;
  cases: number;
  /** Planned by pallets: 1/1000 pallet, and the room; null = by cases. */
  palletUnits: number | null;
  roomUnits: number | null;
  costOmr: number | null;
  breakStartMin: number | null;
  stops: EditStopView[];
}

export interface EditTruckDayView {
  loads: EditLoadView[];
  firstDepartMin: number | null;
  lastReturnMin: number | null;
  /** The Planned loads' money (the plan's cost model): as planned on "now", as timed on "after"; null when not known. */
  costOmr: number | null;
  km: number;
  /**
   * "now" only: the same Planned loads timed in this check with today's data (the solver's `before`), the
   * figures the change and the day-cost warning are counted from; null when they no longer keep the rules
   * (or on "after").
   */
  timedNow?: { costOmr: number; km: number; lastReturnMin: number | null } | null;
}

export interface EditTruckPreview {
  truckId: string;
  truckCode: string;
  /** As stored now (what the plan screen shows). */
  before: EditTruckDayView;
  /** After the change, timed with today's data; null when the solver gave no timetable. */
  after: EditTruckDayView | null;
  feasible: boolean;
  violations: EditViolation[];
  /** The truck's current loads timed now with today's data no longer keep a rule (said, never blocking). */
  beforeNow: { feasible: boolean; violations: EditViolation[] } | null;
  /** after - before, both timed in the same check (like for like); null when either cannot be timed. */
  deltaCostOmr: number | null;
  deltaKm: number | null;
  deltaLastReturnMin: number | null;
}

/** The answer of Check (and of a refused Save: PREVIEW_CHANGED, MOVE_REFUSED). */
export interface PlanEditPreview {
  /** Every edited truck keeps every hard rule. */
  ok: boolean;
  /** ok, PLAN_EDIT=on, the road distances usable and something changes. */
  canSave: boolean;
  /** Why canSave is false, in words (null when it can be saved). */
  saveNote: string | null;
  mode: PlanEditMode;
  /** The plan version checked; Save makes version + 1. */
  version: number;
  previewHash: string;
  /** When the day was read (ISO): Save reads it as it was then (at most 10 minutes later). */
  builtAt: string;
  /** The change as Save sends it: a best place is resolved to its load and position. */
  move: PlanEditMove;
  /** "Move C7 from T08 L2, stop 1 to T08 L1, stop 4". */
  title: string;
  trucks: EditTruckPreview[];
  /** Soft rules (cost or km up, preferred hours, overtime, a truck used for one load...): saving is allowed. */
  warnings: string[];
  /** What changed since planning on the edited trucks' stops and trucks, and in the settings: re-timed with today's data. */
  dataChanged: { label: string; text: string }[];
  /** "Best place": the other places found (best first after this one); a click checks that one. */
  options: { label: string; move: PlanEditMove; deltaCostOmr: number | null; lastReturnMin: number }[];
  /** Day cost change of the edited trucks (OMR), null when not known. */
  deltaCostOmr: number | null;
  deltaKm: number | null;
  matrix: { provider: string; quality: string };
}

/** The answer of a Save. */
export interface PlanEditSaved {
  runId: string;
  version: number;
  /** "T08 L1" ...: the loads whose sheets must be printed again. */
  reprint: string[];
  /** "T03 L2" ...: Planned loads of the edited trucks that are no longer in the plan (their printed sheets are void). */
  gone: string[];
  /** The trucks whose driver link may need sending again. */
  trucks: string[];
}

/** The Save toast (20 s). */
export function savedText(s: PlanEditSaved): string {
  const todo = [
    ...(s.reprint.length ? [`print the sheets again for ${s.reprint.join(', ')} (load sheet, driver sheet)`] : []),
    ...(s.trucks.length ? [`send the driver link of ${s.trucks.join(', ')} again if you already sent it`] : []),
  ].join(' and ');
  const first = todo ? ` ${todo[0]!.toUpperCase()}${todo.slice(1)}.` : '';
  const one = (s.gone ?? []).length === 1;
  const gone = s.gone?.length ? ` ${s.gone.join(', ')} ${one ? 'is' : 'are'} no longer in the plan: throw away ${one ? 'its' : 'their'} printed sheets.` : '';
  return `Saved as version ${s.version}.${first}${gone} A RE-PLAN plans unlocked loads again and may undo this change: lock the load to keep it.`;
}

/** The words of the dialog's refusals that are not a broken rule (409 / 404 / 503 from the routes). */
export const EDIT_ERROR_TEXT = {
  PREVIEW_CHANGED: 'The day changed since your check: here is the new result.',
  DAY_CHANGED: 'The plan changed while you were checking (a load was locked, an order came in). Check the move again.',
  PREVIEW_OLD: 'This check is more than 10 minutes old: check the move again.',
  SUPERSEDED: 'A newer plan version is in use. Reload.',
  CHECK_ONLY: 'Saving moves is not switched on yet (checking only).',
  SOLVER_OUTDATED: 'The route optimizer is being updated: try again in a few minutes. Nothing was changed.',
  SOLVER_FAILED: 'The route check did not answer. Try again in a minute. Nothing was changed.',
  ROADS_DOWN:
    'Road distances are not available right now (routing is down), so the new times cannot be checked on the road. Try again in a few minutes.',
} as const;

/** "Locked: unlock this load to move its stops (unlock a truck's last load first)." */
export const LOCKED_MOVE_TITLE = "Locked: unlock this load to move its stops (unlock a truck's last load first).";

/** A receiving window as the dialog prints it. */
export function windowText(start: number | null | undefined, end: number | null | undefined): string {
  const t = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  if ((start ?? null) === null && (end ?? null) === null) return 'any time';
  return `${start === null || start === undefined ? '--:--' : t(start)}–${end === null || end === undefined ? '--:--' : t(end)}`;
}

/**
 * The positions a stop can take in a load whose stops are `labels` (the moved stop left out when it is
 * that load): Best place first, then First (before ...), After ..., Last.
 */
export function positionChoices(labels: readonly string[]): { value: number | 'BEST'; label: string }[] {
  const out: { value: number | 'BEST'; label: string }[] = [{ value: 'BEST', label: 'Best place' }];
  if (!labels.length) return [...out, { value: 0, label: 'Only stop' }];
  out.push({ value: 0, label: `First (before ${labels[0]})` });
  for (let i = 1; i < labels.length; i++) out.push({ value: i, label: `After ${labels[i - 1]} (before ${labels[i]})` });
  out.push({ value: labels.length, label: `Last (after ${labels[labels.length - 1]})` });
  return out;
}

/** "+2.10" / "-6.16" / "0.00": a money change in OMR. */
export function signedOmr(x: number): string {
  const r = Math.round(x * 100) / 100;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}`;
}
