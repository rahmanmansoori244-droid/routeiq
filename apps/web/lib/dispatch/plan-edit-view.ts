/**
 * Moves by hand (PR M2/M3, owner decisions of 24 Oct 2026; part 2 from the owner's feedback of the same
 * evening): the request and answer shapes of POST /api/runs/:id/edit/check and POST /api/runs/:id/edit,
 * and the words the dialogs show. Browser-safe (no database, no Node): the dialog
 * (app/t/[slug]/dispatch/move-stop-dialog.tsx) and the server (plan-edit.ts) both read it.
 *
 * A check and a save take a change list (`ops`, at most 10 operations, applied in order; the v1 body
 * `{ move }` is one operation):
 * - MOVE: a stop of a PLANNED load (one customer visit with all its orders on that load, or one split
 *   part) to another PLANNED load of the same or another truck, at a position or at the best place;
 *   to a new load of a truck (after its last load, before one of its PLANNED loads, or the best place
 *   in its day); or to another position of its own load (a reorder);
 * - REMOVE: the stop taken off the plan (its orders go on the unserved list, reason REMOVED_BY_HAND);
 * - PLACE: an unserved customer visit (all its unserved orders) put on a load as above;
 * - MOVE_STOPS (part 2): several stops (of one or more Planned loads, or unserved visits) to one load,
 *   existing or new, each at its best place (or in a given order);
 * - REMOVE_STOPS: several stops taken off the plan;
 * - MOVE_LOAD: a whole Planned load to a truck (its own: a reorder of the day) as a new load, before a
 *   load, after the last load or at the best place in the day, keeping its stop order;
 * - SWAP_LOADS: two Planned loads change places (each keeps its stop order, timed again where it goes).
 * Only PLANNED loads change. A LOCKED load must be unlocked first; LOADING, DISPATCHED and COMPLETED
 * loads never change.
 *
 * Allow anyway (part 2): a red issue of a late arrival at a customer, truck capacity up to 20 % over the
 * truck's own capacity, or the driver break can be allowed by hand by a SUPERVISOR or TENANT_ADMIN with a
 * reason (PLAN_EDIT_OVERRIDES, default on). Every other rule stays. The allowance is kept with the load
 * (snapshots.ts HandAllowance) and printed on the plan and the sheets.
 */
import { DEFAULT_TZ, localMinutes } from './time';
import type { HandAllowance, HandAllowanceKind } from './snapshots';

/** PLAN_EDIT: off (the default: no Move button, the routes answer 404), check (Check works, Save does not), on. */
export type PlanEditMode = 'OFF' | 'CHECK' | 'ON';

/** PLAN_EDIT=off|check|on, read per request (as FEASIBILITY_GATE). Unset or unknown: OFF. */
export function planEditMode(env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {})): PlanEditMode {
  const v = (env.PLAN_EDIT ?? '').trim().toLowerCase();
  return v === 'on' ? 'ON' : v === 'check' ? 'CHECK' : 'OFF';
}

/**
 * PLAN_EDIT_OVERRIDES=off|on (default on: only the value `off` turns it off), read per request: whether a
 * check asks the solver what could be allowed by hand and a save may allow it. Off: no allow-by-hand panel,
 * a save with overrides answers 409 OVERRIDES_OFF; allowances already stored are still honoured.
 */
export function planEditOverridesOn(env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {})): boolean {
  return (env.PLAN_EDIT_OVERRIDES ?? '').trim().toLowerCase() !== 'off';
}

/** How far over the truck's own capacity (bays, cases, payload) a load may be allowed by hand (owner: 20 %). */
export const OVERRIDE_CAPACITY_MAX_PCT = 20;

/** The capacity cap in whole units (pallet units, cases, 0.1 kg): floor(x * 120 / 100), as the solver's. */
export function overrideCapUnits(units: number): number {
  return Math.floor((units * (100 + OVERRIDE_CAPACITY_MAX_PCT)) / 100);
}

/**
 * The startup line for PLAN_EDIT (lib/startup-checks.ts logs it as a warning, its only level): the mode when
 * check or on (and whether rules can be allowed by hand), or that a value it does not know leaves moves by
 * hand off. Null when off.
 */
export function planEditConfigNote(env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {})): string | null {
  const raw = (env.PLAN_EDIT ?? '').trim();
  if (!raw || raw.toLowerCase() === 'off') return null;
  if (!['on', 'check'].includes(raw.toLowerCase())) return `PLAN_EDIT=${raw} is not off, check or on: moves by hand stay off.`;
  const overrides = planEditOverridesOn(env)
    ? ` Rules can be allowed by hand by supervisors and company admins (up to ${OVERRIDE_CAPACITY_MAX_PCT}% over capacity, late arrivals, driver break). PLAN_EDIT_OVERRIDES=off turns it off.`
    : ' PLAN_EDIT_OVERRIDES=off: rules cannot be allowed by hand.';
  return (
    (planEditMode(env) === 'ON'
      ? 'PLAN_EDIT=on: dispatchers can move stops by hand and save them as a new plan version.'
      : 'PLAN_EDIT=check: dispatchers can check moves by hand; saving them is off.') + overrides
  );
}

/** A stop of a stored PLANNED load, or a whole unserved customer visit (all its whole unserved orders). */
export type EditStopRef = { loadId: string; sequence: number } | { orderId: string };

/** Where stops go. */
export interface EditTarget {
  truckId: string;
  /** A PLANNED load of the truck; null = a new load. */
  loadId: string | null;
  /** On an existing load, exactly ONE stop moved: its index once there (0 = first), or BEST. Absent = BEST. */
  position?: number | 'BEST';
  /** A new load: the PLANNED load of the truck it goes before (null / absent = after the truck's last load), or BEST (best place in its day). */
  before?: string | null | 'BEST';
  /**
   * v2, explicit layout. Existing load: its whole stop order after the change (its remaining stops and the stops
   * moved in). New load: the stops moved in, in order (then `before` must not be BEST). A best place resolved by
   * Check comes back in this form. Wins over `position`.
   */
  order?: EditStopRef[];
}

/** A stop of a PLANNED load: the load and the stop's sequence on it. */
export interface EditSource {
  loadId: string;
  sequence: number;
}

/** One change of a change list (applied in order to the working layout). */
export type PlanEditOp =
  // v1 (still accepted, still sent by the single-stop dialog)
  | { kind: 'MOVE'; from: EditSource; to: EditTarget }
  | { kind: 'REMOVE'; from: EditSource }
  | { kind: 'PLACE'; orderId: string; to: EditTarget }
  // v2
  | { kind: 'MOVE_STOPS'; stops: EditStopRef[]; to: EditTarget }
  | { kind: 'REMOVE_STOPS'; stops: EditSource[] }
  | { kind: 'MOVE_LOAD'; loadId: string; to: { truckId: string; before: string | null | 'BEST' } }
  | { kind: 'SWAP_LOADS'; a: string; b: string };

/** The v1 changes (one stop). */
export type PlanEditMove = Extract<PlanEditOp, { kind: 'MOVE' | 'REMOVE' | 'PLACE' }>;

/** The most operations one check or save takes. */
export const MAX_EDIT_OPS = 10;

/** What a hand change keeps with the option (`details.manual`): the plan header says "adjusted by hand" from it. */
export interface ManualEdit {
  v: 1;
  at: string;
  byUserId: string;
  parentRunId: string;
  /** Changes by hand on this option so far (copied forward with it). */
  count: number;
  /** The change, for a change of one v1 operation (an older web reads only v, at and count). */
  move?: PlanEditMove;
  /** The change list as saved (resolved). */
  ops?: PlanEditOp[];
  /** Rules newly allowed by hand in this save, and allowances carried from earlier ones. */
  allowed?: number;
  carried?: number;
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
  /** Outside its receiving hours, allowed by hand (shown violet, not red). */
  allowed?: boolean;
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

/** The kinds of rule that can be allowed by hand. */
export type OverrideKind = HandAllowanceKind;

/** A red issue of a checked change, and whether it can be allowed by hand. */
export interface EditIssue {
  /** Stable override id (`ovr_` + 16 hex) of an issue of a kind that can be allowed by hand; null otherwise. */
  id: string | null;
  /** The solver's code (HARD_WINDOW, CAPACITY_PALLETS, BREAK, TRIPS, NO_TIMETABLE, ...). */
  code: string;
  kind: OverrideKind | null;
  overridable: boolean;
  /** Why it cannot be allowed, in words. */
  whyNot: string | null;
  truckId: string | null;
  truckCode: string | null;
  loadNo: number | null;
  stopLabel: string | null;
  customerId: string | null;
  orderIds: string[];
  /**
   * By how much, in the issue's unit; null when the solver gave no figures (an older solver). LATE: value / limit
   * are clock minutes (start or unloading end / hours end), over = max(1, value - limit). Capacity: the web's own
   * figures (the ones the plan stores), capacity = the truck's own (bays, cases, kg), overPct over it.
   */
  amount: { unit: 'min' | 'pallets' | 'cases' | 'kg'; value: number; limit: number; over: number; capacity?: number; overPct?: number } | null;
  /** One line for the dispatcher. */
  text: string;
  /** Kept from an earlier approval: needs no tick, no reason and no role. */
  carried: { fromId: string; reason: string; byName: string; byRole: string; at: string } | null;
  /** Not carried, but the same kind was allowed before on this stop / load / truck: pre-fills the reason. */
  previous: { reason: string; byName: string; at: string } | null;
}

/** The allow-by-hand panel of a check. */
export interface OverridePreview {
  /** With the needed issues allowed, every other rule holds (the solver's relaxed answer is VERIFIED). */
  ok: boolean;
  /**
   * ok && PLAN_EDIT=on && PLAN_EDIT_OVERRIDES on && road distances usable && every needed issue can be allowed
   * (judged on the web's own figures) && (canOverride || every needed issue is carried).
   */
  canSave: boolean;
  /** Why canSave is false: the role, checking only, roads down, out of time, an older optimizer, an issue that cannot be allowed. */
  saveNote: string | null;
  /** What this save allows (deduplicated by id; carried ones flagged), amounts as on the relaxed timetable. */
  needed: EditIssue[];
  /** What still breaks even when allowed (cannot be allowed); [] when ok. */
  remaining: EditIssue[];
  /** The overrides hash Save must find ('' when !ok). */
  previewHash: string;
  /** Before / after with the issues allowed. */
  trucks: EditTruckPreview[];
  /** Soft warnings of the relaxed timetable. */
  warnings: string[];
  deltaCostOmr: number | null;
  deltaKm: number | null;
  /** The skipBreak used (edited trucks only). */
  skipBreak: string[];
  /**
   * "Skip the driver break on T08 instead" (re-checks with skipBreak). only = true: the truck cannot be timed even
   * with the issues allowed, but can without its break. only = false: the truck has late issues and a break is due.
   */
  breakAlternative: { truckId: string; truckCode: string; only: boolean }[];
}

/** The answer of Check (and of a refused Save: PREVIEW_CHANGED, MOVE_REFUSED, OVERRIDES_CHANGED). */
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
  /** Only for a request of one v1 operation (old clients): the change as Save sends it, a best place resolved. */
  move?: PlanEditMove;
  /** "Move C7 from T08 L2, stop 1 to T08 L1, stop 4"; a list joined with "; ". */
  title: string;
  trucks: EditTruckPreview[];
  /** Soft rules (cost or km up, preferred hours, overtime, a truck used for one load...): saving is allowed. */
  warnings: string[];
  /** What changed since planning on the edited trucks' stops and trucks, and in the settings: re-timed with today's data. */
  dataChanged: { label: string; text: string }[];
  /** "Best place": the other places found (best first after this one); a click checks that one (single-stop best only). */
  options: { label: string; move: PlanEditMove; deltaCostOmr: number | null; lastReturnMin: number }[];
  /** Day cost change of the edited trucks (OMR), null when not known. */
  deltaCostOmr: number | null;
  deltaKm: number | null;
  matrix: { provider: string; quality: string };
  /** v2: the change list as Save sends it (explicit whenever possible). */
  ops: PlanEditOp[];
  /** Every op explicit: "Add another change" can keep this list (a step may be red on its own). */
  draftable: boolean;
  /** The red issues of the change as resolved; [] when ok. */
  issues: EditIssue[];
  /** The allow-by-hand panel; null when nothing can be allowed (or overrides are off). */
  overrides: OverridePreview | null;
  /** A whole load or a new load at its best place: the other places found. */
  loadOptions?: { label: string; ops: PlanEditOp[]; deltaCostOmr: number | null; lastReturnMin: number }[];
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
  /** Rules newly allowed by hand in this save, and allowances kept from earlier ones. */
  allowed?: number;
  carried?: number;
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
  const kept = (s.allowed ?? 0) + (s.carried ?? 0);
  const allowed = kept
    ? ` ${kept} rule${kept === 1 ? ' was' : 's were'} allowed by hand: they are printed on the load sheet and the driver sheet. A RE-PLAN plans the Planned loads again with every rule: lock them to keep this.`
    : '';
  return `Saved as version ${s.version}.${first}${gone}${allowed} A RE-PLAN plans unlocked loads again and may undo this change: lock the load to keep it.`;
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
  ALREADY_REMOVED: 'A stop of this change was already taken off the plan by an earlier step.',
  BAD_ORDER: 'The order given for the load does not list exactly its stops: check the change again.',
  POSITION_ONE_STOP: 'A position can be chosen for one stop only: several stops go to their best place.',
  SAME_LOAD: 'Choose another load to swap with.',
  BEST_NOT_LAST: 'Only the last change can use Best place: check the earlier ones first.',
  NO_EXPLICIT_PLACE: 'Choose where the new load goes.',
  TOO_MANY_TRUCKS: 'A change by hand can touch at most 6 trucks: save part of it first.',
  OVERRIDE_ROLE: 'Only a supervisor or company admin can allow rules by hand.',
  OVERRIDES_OFF: 'Allowing rules by hand is switched off (PLAN_EDIT_OVERRIDES=off).',
  OVERRIDES_CHANGED: 'The rules this change breaks changed since your check: confirm them again.',
  OVERRIDES_NEED_SOLVER: 'Allowing rules by hand needs the updated route optimizer.',
  OVERRIDES_OUT_OF_TIME: 'Out of time while checking what can be allowed by hand: try again.',
} as const;

/** The codes whose words the dialog shows from EDIT_ERROR_TEXT (for the others the server's own message names more). */
export const EDIT_ERROR_GENERIC: readonly string[] = ['PREVIEW_CHANGED', 'DAY_CHANGED', 'PREVIEW_OLD', 'SUPERSEDED', 'CHECK_ONLY', 'SOLVER_OUTDATED', 'SOLVER_FAILED', 'ROADS_DOWN'];

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

// ---------------------------------------------------------------------------------------------
// Allow anyway: the words of an issue and of an allowance (one helper everywhere, design section 9)
// ---------------------------------------------------------------------------------------------

const clock = (m: number) => {
  const r = Math.round(m);
  return `${String(Math.floor(r / 60) % 24).padStart(2, '0')}:${String(((r % 60) + 60) % 60).padStart(2, '0')}`;
};
const num = (x: number, digits = 0) => x.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const plt = (x: number) => num(Math.round(x * 10) / 10, 1);

/** Lateness is shown and stored in whole minutes, at least 1 (a stop 1 s late is "1 min late"). */
export function lateMinutes(value: number, limit: number): number {
  return Math.max(1, Math.round(value - limit));
}

/** The one line of an issue the check found (design 3.12). `message`: the solver's words (BREAK and the rest). */
export function issueText(x: {
  kind: OverrideKind | null;
  truckCode: string | null;
  loadNo: number | null;
  stopLabel: string | null;
  amount: EditIssue['amount'];
  rule?: 'START' | 'FINISH';
  windowStartMin?: number | null;
  message: string;
  fillPct?: number | null;
}): string {
  const load = x.truckCode && x.loadNo !== null ? `${x.truckCode} L${x.loadNo}` : (x.truckCode ?? 'The load');
  const a = x.amount;
  if (x.kind === 'LATE' && a) {
    const who = `${x.stopLabel ?? 'The stop'} on ${load}`;
    return x.rule === 'FINISH'
      ? `${who} finishes unloading at ${clock(a.value)}, after its receiving hours end (${clock(a.limit)}): ${a.over} min late`
      : `${who} arrives ${clock(a.value)}, after its receiving hours ${windowText(x.windowStartMin ?? null, a.limit)}: ${a.over} min late`;
  }
  if (x.kind === 'CAPACITY_PALLETS' && a) {
    const bays = a.capacity ?? null;
    const over = bays !== null && typeof a.overPct === 'number' ? (a.overPct > 0 ? `, ${a.overPct}% over the truck's ${bays} bays` : `, within the truck's ${bays} bays`) : '';
    const fill = bays !== null ? ` (${bays} bays${typeof x.fillPct === 'number' ? ` at ${x.fillPct}% fill` : ''})` : '';
    return `${load} needs ${plt(a.value)} pallets; the truck takes ${plt(a.limit)}${fill}: ${plt(a.value - a.limit)} pallets over the limit${over}`;
  }
  if (x.kind === 'CAPACITY_CASES' && a) {
    return `${load} carries ${num(a.value)} cases; the truck takes ${num(a.limit)}: ${num(a.value - a.limit)} cases${typeof a.overPct === 'number' ? ` (${a.overPct}%)` : ''} over`;
  }
  if (x.kind === 'CAPACITY_KG' && a) {
    return `${load} weighs ${num(a.value, 1)} kg; the truck's payload is ${num(a.limit, 1)} kg: ${num(Math.round((a.value - a.limit) * 10) / 10, 1)} kg${typeof a.overPct === 'number' ? ` (${a.overPct}%)` : ''} over`;
  }
  return x.message;
}

/** Why an issue cannot be allowed by hand (design 3.12). */
export const WHY_NOT_TEXT = {
  TRUCK_NOT_ALLOWED: 'Small-truck-only customers cannot be allowed by hand.',
  SHIFT_LIMIT: 'The shift and the latest return cannot be allowed by hand.',
  TRIPS: 'The loads a day cannot be allowed by hand.',
  EARLY: 'Arriving before the receiving hours open cannot be allowed by hand.',
  NO_TIMETABLE: 'No timetable keeps every rule: see below what can be allowed by hand.',
  NO_FIGURES: 'The route optimizer gave no figures for it: it cannot be allowed by hand (it needs the updated optimizer).',
  OVERRIDES_OFF: 'Allowing rules by hand is switched off.',
  DEFAULT: 'This rule cannot be allowed by hand.',
} as const;

export function roleWord(role: string): string {
  return role === 'TENANT_ADMIN' ? 'company admin' : role === 'SUPER_ADMIN' ? 'platform admin' : role === 'SUPERVISOR' ? 'supervisor' : role.toLowerCase();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function whenText(iso: string, tz: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'numeric' }).formatToParts(d);
  const dd = parts.find((p) => p.type === 'day')?.value ?? '';
  const mm = Number(parts.find((p) => p.type === 'month')?.value ?? '1');
  return `${dd} ${MONTHS[mm - 1] ?? ''} ${clock(localMinutes(d, tz))}`;
}

/** "Allowed earlier by Ahmed (supervisor), 24 Oct 21:40: agreed with customer - kept". */
export function carriedText(c: { byName: string; byRole: string; at: string; reason: string }, tz = DEFAULT_TZ): string {
  return `Allowed earlier by ${c.byName} (${roleWord(c.byRole)}), ${whenText(c.at, tz)}: ${c.reason} - kept`;
}

/**
 * One allowance in words, everywhere it is printed (plan, load sheet, driver sheet, WhatsApp, Excel):
 * "Allowed by hand: arrives 13:20, after receiving hours 08:00–13:00 (20 min late) - agreed with customer".
 * `who`: " (Ahmed, supervisor, 21:40)" - a carried allowance names the original approver.
 */
export function allowedByHandText(a: HandAllowance, opts: { who?: boolean; tz?: string; prefix?: boolean } = {}): string {
  const tz = opts.tz ?? DEFAULT_TZ;
  const lead = opts.prefix === false ? '' : 'Allowed by hand: ';
  let what: string;
  if (a.kind === 'LATE') {
    const end = a.windowEndMin ?? 0;
    const late = a.lateMin ?? a.maxLateMin ?? 0;
    what =
      a.rule === 'FINISH'
        ? `unloading until ${clock(a.atMin ?? end + late)}, after receiving hours end ${clock(end)} (${late} min late)`
        : `arrives ${clock(a.atMin ?? end + late)}, after receiving hours ${windowText(a.windowStartMin ?? null, end)} (${late} min late)`;
  } else if (a.kind === 'CAPACITY_PALLETS') {
    what = `${plt(a.value ?? a.maxValue ?? 0)} pallets on ${a.capacity ?? '?'} bays (limit ${plt(a.limit ?? 0)}${typeof a.overPct === 'number' ? `; ${a.overPct}% over the truck` : ''})`;
  } else if (a.kind === 'CAPACITY_CASES') {
    what = `${num(a.value ?? a.maxValue ?? 0)} cases (truck takes ${num(a.capacity ?? a.limit ?? 0)}${typeof a.overPct === 'number' ? `; ${a.overPct}% over` : ''})`;
  } else if (a.kind === 'CAPACITY_KG') {
    what = `${num(a.value ?? a.maxValue ?? 0, 1)} kg (payload ${num(a.capacity ?? a.limit ?? 0, 1)} kg${typeof a.overPct === 'number' ? `; ${a.overPct}% over` : ''})`;
  } else {
    const w = typeof a.breakFromMin === 'number' && typeof a.breakToMin === 'number' ? `, to start ${clock(a.breakFromMin)}–${clock(a.breakToMin)}` : '';
    what = `no driver break today (${a.breakMin ?? '?'} min${w})`;
  }
  const who = opts.who ? ` (${a.byName}, ${roleWord(a.byRole)}, ${clock(localMinutes(new Date(a.at), tz))})` : '';
  return `${lead}${what} - ${a.reason}${who}`;
}

/** A short badge of a load-level allowance for the driver sheet: "ALLOWED BY HAND: NO DRIVER BREAK", "... 13.1 PALLETS (9% OVER)". */
export function allowedBadge(a: HandAllowance): string | null {
  const over = typeof a.overPct === 'number' && a.overPct > 0 ? ` (${a.overPct}% OVER)` : '';
  if (a.kind === 'NO_BREAK') return 'ALLOWED BY HAND: NO DRIVER BREAK';
  if (a.kind === 'CAPACITY_PALLETS') return `ALLOWED BY HAND: ${plt(a.value ?? 0)} PALLETS${over}`;
  if (a.kind === 'CAPACITY_CASES') return `ALLOWED BY HAND: ${num(a.value ?? 0)} CASES${over}`;
  if (a.kind === 'CAPACITY_KG') return `ALLOWED BY HAND: ${num(a.value ?? 0, 1)} KG${over}`;
  return null;
}

/** An allowance of the plan detail (plan-detail.ts `allowedByHand`): where it is and its words. */
export interface PlanAllowanceLine {
  loadId: string;
  status: string;
  truckCode: string;
  loadNo: number;
  kind: OverrideKind;
  text: string;
  byName: string;
  at: string;
}

/**
 * The lines a RE-PLAN (and the hire "Use this plan" / "Use instead") confirmation lists: allowances on
 * PLANNED loads only (a locked load keeps its own): "T08 L2: Allowed by hand: arrives 13:20 ...".
 */
export function allowancesOnPlannedText(list: readonly PlanAllowanceLine[] | null | undefined): string[] {
  return (list ?? []).filter((a) => a.status === 'PLANNED').map((a) => `${a.truckCode} L${a.loadNo}: ${a.text}`);
}

/** The heading of those lines in the confirmations (design 8.3). */
export const ALLOWANCES_DROPPED_TEXT = 'Allowed by hand on Planned loads: a RE-PLAN plans them again with every rule. Lock a load first to keep what was allowed.';
