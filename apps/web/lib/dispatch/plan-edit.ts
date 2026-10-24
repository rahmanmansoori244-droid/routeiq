/**
 * Moves by hand in a load-based plan (PR M2, owner decisions of 24 Oct 2026; design notes "M" and the
 * cross-design review's section D; part 2 - whole loads, several stops at once, allow anyway - from the
 * owner's feedback of the same evening). Server only. The words and shapes the screen shares are in
 * plan-edit-view.ts; the database writes of a save are in plan-edit-apply.ts.
 *
 * Check (POST /api/runs/:id/edit/check) writes nothing:
 *  1. the version is the live, applied dispatch plan of a day that is not over, not optimizing;
 *  2. the day is read as a RE-PLAN reads it, with TODAY's customers, trucks and settings
 *     (buildDispatchRequest, owner decision D1), and only the trucks the change touches are re-timed;
 *  3. every load the change list names is a PLANNED load of this version (a locked, loading or
 *     dispatched one: LOAD_FROZEN, also when it is named in a given order); the stops of the candidate
 *     trucks' PLANNED loads are matched to the request's stops (mapStops: the same orders and the same
 *     parts; a new, cancelled or postponed order of one of them, or parts cut differently, is
 *     STOP_CHANGED: re-plan first); an unserved customer visit is all its whole unserved orders (Put on a
 *     truck's rules); on a day planned by pallets, the products of the orders re-timed (only those) must
 *     have their cases per pallet, and a cases per pallet corrected since planning on one of them is
 *     PALLET_FACTOR_CHANGED (re-plan first, release review F1); at most 6 trucks and 120 stops are
 *     re-timed;
 *  4. the change list (applyOps: moves of one or several stops, take offs, whole loads, swaps; at most
 *     10 operations, a best place only in the last) gives each edited truck its new loads, and the solver
 *     re-times them exactly (POST /retime-truck-days, apps/solver/retime.py): every hard rule (bays 98% /
 *     100% one customer, cases, kg, small truck only, receiving hours, latest return, shift, loads per
 *     day, the driver break) refuses with the rule and by how much; FEASIBILITY_GATE=warn never relaxes
 *     it. Soft costs (money, km, preferred hours, overtime, a truck used for one load) only warn. A best
 *     place that is where the stops already are answers 409 NO_CHANGE;
 *  5. allow anyway (PLAN_EDIT_OVERRIDES, default on): the solver is also asked what the change needs
 *     allowed by hand - a late arrival (judged in seconds), capacity up to 20 % over the truck's own,
 *     the driver break - with every other rule kept; each issue is judged again on the web's own figures
 *     (judgeIssue) and an allowance already on the edited trucks' loads is carried when the issue is the
 *     same and no worse (carryIssues);
 *  6. the preview: per truck before and after, the cost change from the same call (like for like, critic
 *     M5), what changed since planning on those trucks, the issues, the allow-by-hand panel, previewHash
 *     (every rule) and the overrides hash.
 * Save (POST /api/runs/:id/edit) checks again with the day read as it was at the check (at most 10
 * minutes later), must find the same preview (PREVIEW_CHANGED with the new one otherwise), and then, in ONE
 * transaction under the intake, day and plan locks, reads the touched trucks again (DAY_CHANGED when
 * anything of them changed: a change elsewhere never blocks a move, critic M2), makes version N+1
 * (MANUAL_ADJUSTMENT, the parent SUPERSEDED) and re-creates only the edited trucks' PLANNED loads, with
 * the rules allowed by hand kept on them (plan-edit-apply.ts).
 */
import { createHash } from 'node:crypto';
import type { Prisma, RunPlan } from '@prisma/client';
import type {
  DispatchRequest,
  DispatchScenario,
  DispatchStop,
  FeasibilityReport,
  FeasibilityViolation,
  PlannedLoad,
  RetimeBest,
  RetimeRelaxations,
  RetimeRelaxed,
  RetimeRequest,
  RetimeResponse,
  RetimeTruckOut,
  UnservedStop,
} from '@routeiq/shared-types';
import { prisma } from '../db';
import { callRetimeTruckDays } from '../solver-client';
import { buildDispatchRequest, isDispatchDetails, loadKgFromRefs, PlanError, type BuiltRequest, type PlanScope, type ScenarioDetails } from './plan-service';
import { isSupersededRun } from './plan-status';
import { canonical, VOLATILE_CONFIG } from './hire';
import { companyToday } from './hire-whatif';
import { dayMismatch, type ExpectedDay } from './start-optimize';
import { orderIdOf, portionId, portionLinesKey, readPortionLines, readPortionPalletFactors, rowKeyOf, type PortionRecord } from './split';
import { groupMissingPalletFactors, palletFactorGate, validPalletFactor } from './pallets';
import { parseLoadBreak, readHandAllowances, readPlanInputs, readStopSnapshot, readTruckSnapshot, stopMasterChanges, truckMasterChanges, type HandAllowance } from './snapshots';
import { fmtDayMonth, fmtHhmm, isoOf } from './time';
import { KG_ROUNDING_TOL, payloadTenths } from './weights';
import {
  EDIT_ERROR_TEXT,
  issueText,
  lateMinutes,
  MAX_EDIT_OPS,
  OVERRIDE_CAPACITY_MAX_PCT,
  overrideCapUnits,
  planEditMode,
  planEditOverridesOn,
  signedOmr,
  windowText,
  WHY_NOT_TEXT,
  type EditIssue,
  type EditLoadView,
  type EditSource,
  type EditStopRef,
  type EditStopView,
  type EditTarget,
  type EditTruckDayView,
  type EditTruckPreview,
  type EditViolation,
  type ManualEdit,
  type OverrideKind,
  type OverridePreview,
  type PlanEditMode,
  type PlanEditMove,
  type PlanEditOp,
  type PlanEditPreview,
} from './plan-edit-view';

type Db = Prisma.TransactionClient | typeof prisma;

// ---------------------------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------------------------

export { manualOf, planEditConfigNote, planEditMode, planEditOverridesOn, type ManualEdit } from './plan-edit-view';

/** How long a check stays good for its save (as the hire suggestion's SAME_DAY_SLACK_MIN). */
export const PREVIEW_MAX_AGE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------------------------
// What a move reads of the version
// ---------------------------------------------------------------------------------------------

/** One stored row of a load (an order, or a split part of one, on one stop). */
export interface EditRow {
  orderId: string;
  sequenceInTruck: number;
  orderInStop: number;
  portionCases: number | null;
  portionWeightKg: number | null;
  portionLinesJson: unknown;
  stopSnapshotJson: unknown;
  etaMin: number | null;
  serviceStartMin: number | null;
  hardWindowOk: boolean | null;
  prefWindowOk: boolean | null;
  /** The row's cases (its part's, else the order's). */
  cases: number;
  customerId: string;
  /** "Name (CODE/BRANCH)": the customer as planned (snapshot), else now. */
  label: string;
}

/** One stored load of the version. */
export interface EditLoad {
  id: string;
  truckId: string;
  truckCode: string;
  loadNo: number;
  status: string;
  departMin: number;
  returnMin: number;
  distanceKm: number;
  cases: number;
  operatingCost: number;
  palletUnits: number | null;
  truckSnapshotJson: unknown;
  breakJson: unknown;
  rows: EditRow[];
}

/** A row of the option's unserved list. */
export interface EditUnserved {
  orderId: string;
  reasonCode: string;
  portionLinesJson: unknown;
}

export function customerLabel(c: { code: string; branchCode: string | null; name: string }): string {
  const code = c.branchCode ? `${c.code}/${c.branchCode}` : c.code;
  return c.name && c.name !== c.code ? `${c.name} (${code})` : code;
}

/** The version's loads as a move reads them (every status), in truck code and load order. */
export async function readEditLoads(db: Db, tenantId: string, runId: string): Promise<EditLoad[]> {
  const rows = await db.planLoad.findMany({
    where: { runId, tenantId },
    orderBy: [{ truck: { code: 'asc' } }, { loadNo: 'asc' }],
    select: {
      id: true, truckId: true, loadNo: true, status: true, departMin: true, returnMin: true, distanceKm: true, cases: true, operatingCost: true,
      palletUnits: true, truckSnapshotJson: true, breakJson: true,
      truck: { select: { code: true } },
      assignments: {
        orderBy: [{ sequenceInTruck: 'asc' }, { orderInStop: 'asc' }],
        select: {
          orderId: true, sequenceInTruck: true, orderInStop: true, portionCases: true, portionWeightKg: true, portionLinesJson: true, stopSnapshotJson: true,
          etaMin: true, serviceStartMin: true, hardWindowOk: true, prefWindowOk: true,
          order: { select: { totalCases: true, customerId: true, customer: { select: { code: true, branchCode: true, name: true } } } },
        },
      },
    },
  });
  return rows.map((l) => {
    const ts = readTruckSnapshot(l.truckSnapshotJson);
    return {
      id: l.id,
      truckId: l.truckId,
      truckCode: ts?.code || l.truck.code,
      loadNo: l.loadNo,
      status: l.status,
      departMin: l.departMin,
      returnMin: l.returnMin,
      distanceKm: l.distanceKm,
      cases: l.cases,
      operatingCost: l.operatingCost,
      palletUnits: l.palletUnits,
      truckSnapshotJson: l.truckSnapshotJson,
      breakJson: l.breakJson,
      rows: l.assignments.map((a) => {
        const snap = readStopSnapshot(a.stopSnapshotJson);
        return {
          orderId: a.orderId,
          sequenceInTruck: a.sequenceInTruck,
          orderInStop: a.orderInStop,
          portionCases: a.portionCases,
          portionWeightKg: a.portionWeightKg,
          portionLinesJson: a.portionLinesJson,
          stopSnapshotJson: a.stopSnapshotJson,
          etaMin: a.etaMin,
          serviceStartMin: a.serviceStartMin,
          hardWindowOk: a.hardWindowOk,
          prefWindowOk: a.prefWindowOk,
          cases: a.portionCases ?? a.order.totalCases,
          customerId: a.order.customerId,
          label: customerLabel(snap ? { code: snap.code || a.order.customer.code, branchCode: snap.branchCode, name: snap.name || a.order.customer.name } : a.order.customer),
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Rows to request stops (pure)
// ---------------------------------------------------------------------------------------------

/** A row's identity: its order and, for a split part, its lines and cases ("*" = the whole order). */
export const rowKey = rowKeyOf;

/** The same identity of an optimizer order ref (an order id, or a portion id of `portions`). */
export function refKey(ref: string, portions: Record<string, PortionRecord> | undefined): string {
  const p = portions?.[ref];
  return `${orderIdOf(ref)}|${portionLinesKey(p ? p.lines : null)}`;
}

const bag = (keys: readonly string[]) => [...keys].sort().join(';');

/** One stop of a stored load: the rows of one sequence. */
export interface PlanStop {
  loadId: string;
  truckId: string;
  truckCode: string;
  loadNo: number;
  sequence: number;
  rows: EditRow[];
  label: string;
}

export const stopKeyOf = (loadId: string, sequence: number) => `${loadId}:${sequence}`;

export function planStopsOf(load: EditLoad): PlanStop[] {
  const by = new Map<number, EditRow[]>();
  for (const r of load.rows) by.set(r.sequenceInTruck, [...(by.get(r.sequenceInTruck) ?? []), r]);
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sequence, rows]) => ({
      loadId: load.id,
      truckId: load.truckId,
      truckCode: load.truckCode,
      loadNo: load.loadNo,
      sequence,
      rows: [...rows].sort((a, b) => a.orderInStop - b.orderInStop),
      label: rows[0]!.label,
    }));
}

export type MapStopsResult =
  | {
      ok: true;
      /** stopKeyOf(load, sequence) -> the request's stop id. */
      stopOf: Map<string, string>;
      /** A fresh order ref of a mapped stop -> the ref the option in use has for that row (critic M3). */
      refMap: Map<string, string>;
    }
  | { ok: false; label: string; truckCode: string; loadNo: number };

/**
 * Match the stops of the edited trucks' PLANNED loads to the fresh request's stops. A stop matches a
 * request stop with exactly the same rows: the same orders, and for split parts the same lines and cases
 * (the request makes one stop per customer branch, so a new order of that customer, or one cancelled or
 * postponed, or parts cut differently, finds none: STOP_CHANGED, re-plan first). Where the option in use
 * has the stop at that place (`parentLoads`), its stop id and refs are preferred (two equal parts of a
 * split customer keep their own ids). Only the edited trucks are matched: a change elsewhere never blocks.
 */
export function mapStops(input: {
  stops: readonly PlanStop[];
  request: Pick<DispatchRequest, 'stops'>;
  portions: Record<string, PortionRecord> | undefined;
  parentLoads: readonly Pick<PlannedLoad, 'truck_id' | 'load_no' | 'stops'>[];
  parentPortions: Record<string, PortionRecord> | undefined;
}): MapStopsResult {
  const byId = new Map(input.request.stops.map((s) => [s.stop_id, s]));
  const bagOf = new Map(input.request.stops.map((s) => [s.stop_id, bag(s.order_ids.map((r) => refKey(r, input.portions)))]));
  const taken = new Set<string>();
  const stopOf = new Map<string, string>();
  const refMap = new Map<string, string>();
  const parentAt = (p: PlanStop) => input.parentLoads.find((l) => l.truck_id === p.truckId && l.load_no === p.loadNo)?.stops.find((s) => s.sequence === p.sequence) ?? null;
  for (const p of input.stops) {
    const want = bag(p.rows.map((r) => rowKey(r.orderId, r.portionLinesJson)));
    const hint = parentAt(p);
    const fits = (id: string) => !taken.has(id) && bagOf.get(id) === want;
    const chosen = hint && byId.has(hint.stop_id) && fits(hint.stop_id) ? hint.stop_id : [...bagOf.keys()].filter(fits).sort()[0];
    if (!chosen) return { ok: false, label: p.label, truckCode: p.truckCode, loadNo: p.loadNo };
    taken.add(chosen);
    stopOf.set(stopKeyOf(p.loadId, p.sequence), chosen);
    // Each row's fresh ref, and the ref the option in use has for that row.
    const free = [...byId.get(chosen)!.order_ids];
    for (const r of p.rows) {
      const k = rowKey(r.orderId, r.portionLinesJson);
      const at = free.findIndex((f) => refKey(f, input.portions) === k);
      if (at < 0) continue;
      const fresh = free.splice(at, 1)[0]!;
      const old = hint?.order_ids[r.orderInStop];
      if (old && refKey(old, input.parentPortions) === k) refMap.set(fresh, old);
    }
  }
  return { ok: true, stopOf, refMap };
}

// ---------------------------------------------------------------------------------------------
// The change list, as the edited trucks' new loads (pure)
// ---------------------------------------------------------------------------------------------

/** A PLANNED load of an edited truck as request stop ids, in its stored order. */
export interface PlannedDayLoad {
  loadId: string;
  stops: string[];
}

export interface TruckDayEdit {
  /** The trucks the change touches, first touched first (a moved stop's or load's truck, then the target). */
  edited: string[];
  before: Map<string, string[][]>;
  after: Map<string, string[][]>;
  /** The stored load each of `after`'s loads continues (null = a new load). */
  afterLoadIds: Map<string, (string | null)[]>;
  /** Best place (only in the last operation): sent to the solver; its stops are in no `after` load then. */
  best: RetimeBest | null;
  /** The stops the change moves, puts on or takes off (the preview marks them). */
  movedStops: Set<string>;
  /** The stops taken off the plan (unserved, REMOVED_BY_HAND), in order. */
  removedStops: string[];
  /** The unserved stops put on a truck (they are in `after`, or in `best`). */
  placedStops: string[];
}

/** One operation in its internal form: the v1 kinds become MOVE_STOPS / REMOVE_STOPS (one code path). */
export type NormOp =
  | { kind: 'MOVE_STOPS'; stops: EditStopRef[]; to: EditTarget; v1?: 'MOVE' | 'PLACE' }
  | { kind: 'REMOVE_STOPS'; stops: EditSource[]; v1?: 'REMOVE' }
  | Extract<PlanEditOp, { kind: 'MOVE_LOAD' | 'SWAP_LOADS' }>;

export const isV1Op = (op: PlanEditOp): op is PlanEditMove => op.kind === 'MOVE' || op.kind === 'REMOVE' || op.kind === 'PLACE';

export function normalizeOp(op: PlanEditOp): NormOp {
  switch (op.kind) {
    case 'MOVE':
      return { kind: 'MOVE_STOPS', stops: [op.from], to: op.to, v1: 'MOVE' };
    case 'PLACE':
      return { kind: 'MOVE_STOPS', stops: [{ orderId: op.orderId }], to: op.to, v1: 'PLACE' };
    case 'REMOVE':
      return { kind: 'REMOVE_STOPS', stops: [op.from], v1: 'REMOVE' };
    default:
      return op;
  }
}

export type EditRefusal = { ok: false; status: number; code: string; message: string };
const refusal = (status: number, code: string, message: string): EditRefusal => ({ ok: false, status, code, message });

/** The most trucks one change re-times (apps/solver RETIME_MAX_TRUCKS). */
export const RETIME_MAX_TRUCKS = 6;

/** What applyOps needs besides the ops: how a ref is a request stop, and the words of a load. */
export interface ApplyContext {
  /** The request stop of a ref; null = not known (UNKNOWN_STOP). */
  stopOf: (ref: EditStopRef) => string | null;
  /** "T05 L1" for the words. */
  loadText?: (loadId: string) => string;
}

type Slot = { loadId: string | null; stops: string[] };
type BestMark =
  | { kind: 'LOAD'; truckId: string; slot: Slot; stops: string[] }
  | { kind: 'NEW'; truckId: string; stops: string[] }
  | { kind: 'NEW_AT'; truckId: string; list: Slot[]; at: number; stops: string[] }
  | { kind: 'LOAD_KEEP'; truckId: string; stops: string[] };

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const samePerm = (a: readonly string[], b: readonly string[]) => a.length === b.length && sameList([...a].sort(), [...b].sort());

/**
 * The edited trucks' new loads after the change list `ops`, applied in order to the working layout of the
 * candidate trucks' PLANNED loads (`planned`, in load order, as request stop ids). Pure (design 3.2):
 * - a stop is found wherever it is now (a stop moved by an earlier op can move again; one taken off cannot:
 *   ALREADY_REMOVED); refs that are the same stop in one op are one stop;
 * - MOVE_STOPS: the stops leave where they are, then go to the target: an existing load (its whole `order`, a
 *   numeric position for exactly one stop, else BEST), or a new load (in `order` before a load or at the end;
 *   one stop before a load or at the end; several stops before a load or at the end in the best order; or BEST
 *   in the day). Loads left empty are dropped at the end of each op;
 * - REMOVE_STOPS: the stops are taken off; MOVE_LOAD: the load (as it is now) goes to a truck, keeping its id
 *   on its own truck (a reorder) and as a new load on another; SWAP_LOADS: two loads change places;
 * - BEST only in the LAST op (BEST_NOT_LAST); at most 6 edited trucks; nothing changes: NO_CHANGE.
 */
export function applyOps(ops: readonly PlanEditOp[], planned: ReadonlyMap<string, readonly PlannedDayLoad[]>, ctx: ApplyContext): { ok: true; edit: TruckDayEdit } | EditRefusal {
  const work = new Map<string, Slot[]>();
  const listOf = (truckId: string) => {
    if (!work.has(truckId)) work.set(truckId, (planned.get(truckId) ?? []).map((l) => ({ loadId: l.loadId, stops: [...l.stops] })));
    return work.get(truckId)!;
  };
  for (const t of planned.keys()) listOf(t);
  const initial = new Set([...planned.values()].flat().flatMap((l) => l.stops));
  const edited: string[] = [];
  const touch = (t: string) => {
    if (!edited.includes(t)) edited.push(t);
  };
  const removed: string[] = [];
  const moved = new Set<string>();
  const placed: string[] = [];
  const text = (id: string) => ctx.loadText?.(id) ?? 'The load';
  const find = (stopId: string) => {
    for (const [t, list] of work) {
      for (const slot of list) {
        const i = slot.stops.indexOf(stopId);
        if (i >= 0) return { t, slot, i };
      }
    }
    return null;
  };
  const findLoad = (loadId: string) => {
    for (const [t, list] of work) {
      const i = list.findIndex((s) => s.loadId === loadId);
      if (i >= 0) return { t, list, i, slot: list[i]! };
    }
    return null;
  };
  const gone = (loadId: string) => refusal(422, 'UNKNOWN_LOAD', `${text(loadId)} has no stop left after the change before it.`);
  const resolveAll = (refs: readonly EditStopRef[]): string[] | EditRefusal => {
    const ids: string[] = [];
    for (const ref of refs) {
      const id = ctx.stopOf(ref);
      if (!id) return refusal(422, 'UNKNOWN_STOP', 'Unknown stop: reload the plan.');
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  };
  const dropEmpty = () => {
    for (const [t, list] of work) work.set(t, list.filter((s) => s.stops.length > 0));
  };
  let best: BestMark | null = null;

  for (let k = 0; k < ops.length; k++) {
    const op = normalizeOp(ops[k]!);
    const last = k === ops.length - 1;
    if (op.kind === 'MOVE_STOPS') {
      const ids = resolveAll(op.stops);
      if (!Array.isArray(ids)) return ids;
      for (const id of ids) {
        const at = find(id);
        if (at) {
          at.slot.stops.splice(at.i, 1);
          touch(at.t);
        } else if (removed.includes(id)) {
          return refusal(422, 'ALREADY_REMOVED', 'A stop of this change was already taken off the plan by an earlier step.');
        } else if (initial.has(id)) {
          return refusal(422, 'UNKNOWN_STOP', 'Unknown stop: reload the plan.');
        }
        moved.add(id);
        if (!initial.has(id) && !placed.includes(id)) placed.push(id);
      }
      const t = op.to;
      touch(t.truckId);
      const list = listOf(t.truckId);
      if (t.loadId) {
        const slot = list.find((s) => s.loadId === t.loadId);
        if (!slot) return gone(t.loadId);
        if (t.order) {
          const want = resolveAll(t.order);
          if (!Array.isArray(want)) return want;
          if (want.length !== t.order.length || !samePerm(want, [...slot.stops, ...ids])) {
            return refusal(422, 'BAD_ORDER', `The order given for ${text(t.loadId)} does not list exactly its stops: check the change again.`);
          }
          slot.stops = want;
        } else if (typeof t.position === 'number') {
          if (ids.length !== 1) return refusal(422, 'POSITION_ONE_STOP', 'A position can be chosen for one stop only: several stops go to their best place.');
          slot.stops.splice(Math.max(0, Math.min(t.position, slot.stops.length)), 0, ids[0]!);
        } else {
          if (!last) return refusal(422, 'BEST_NOT_LAST', 'Only the last change can use Best place: check the earlier ones first.');
          if (!slot.stops.length && ids.length === 1) return refusal(409, 'NO_CHANGE', 'Nothing changes: the stop is already there.');
          if (!slot.stops.length) {
            // Every stop of the load moves into it again: the load made again at its place, in the best order.
            best = { kind: 'NEW_AT', truckId: t.truckId, list, at: list.indexOf(slot), stops: ids };
          } else best = { kind: 'LOAD', truckId: t.truckId, slot, stops: ids };
        }
      } else if (t.order) {
        if (t.before === 'BEST') return refusal(422, 'BAD_ORDER', 'A new load in a given order needs a place: choose where it goes.');
        const want = resolveAll(t.order);
        if (!Array.isArray(want)) return want;
        if (want.length !== t.order.length || !samePerm(want, ids)) return refusal(422, 'BAD_ORDER', 'The order given for the new load does not list exactly the stops moved: check the change again.');
        const at = t.before ? list.findIndex((s) => s.loadId === t.before) : list.length;
        if (at < 0) return gone(t.before as string);
        list.splice(at, 0, { loadId: null, stops: want });
      } else if (t.before === 'BEST') {
        if (!last) return refusal(422, 'BEST_NOT_LAST', 'Only the last change can use Best place: check the earlier ones first.');
        best = { kind: 'NEW', truckId: t.truckId, stops: ids };
      } else {
        const at = t.before ? list.findIndex((s) => s.loadId === t.before) : list.length;
        if (at < 0) return gone(t.before as string);
        if (ids.length === 1) list.splice(at, 0, { loadId: null, stops: [ids[0]!] });
        else {
          // Several stops as a new load at a given place: the solver orders them (best order inside).
          if (!last) return refusal(422, 'BEST_NOT_LAST', 'Only the last change can use Best place: check the earlier ones first.');
          best = { kind: 'NEW_AT', truckId: t.truckId, list, at, stops: ids };
        }
      }
    } else if (op.kind === 'REMOVE_STOPS') {
      const ids = resolveAll(op.stops);
      if (!Array.isArray(ids)) return ids;
      for (const id of ids) {
        const at = find(id);
        if (!at) {
          return removed.includes(id)
            ? refusal(422, 'ALREADY_REMOVED', 'A stop of this change was already taken off the plan by an earlier step.')
            : refusal(422, 'UNKNOWN_STOP', 'Unknown stop: reload the plan.');
        }
        at.slot.stops.splice(at.i, 1);
        touch(at.t);
        removed.push(id);
        moved.add(id);
        const p = placed.indexOf(id);
        if (p >= 0) placed.splice(p, 1);
      }
    } else if (op.kind === 'MOVE_LOAD') {
      const at = findLoad(op.loadId);
      if (!at) return gone(op.loadId);
      if (op.to.before === op.loadId) return refusal(409, 'NO_CHANGE', `Nothing changes: ${text(op.loadId)} cannot go before itself.`);
      at.list.splice(at.i, 1);
      touch(at.t);
      touch(op.to.truckId);
      for (const id of at.slot.stops) moved.add(id);
      const list = listOf(op.to.truckId);
      const slot: Slot = { loadId: at.t === op.to.truckId ? op.loadId : null, stops: at.slot.stops };
      if (op.to.before === 'BEST') {
        if (!last) return refusal(422, 'BEST_NOT_LAST', 'Only the last change can use Best place: check the earlier ones first.');
        best = slot.stops.length === 1 ? { kind: 'NEW', truckId: op.to.truckId, stops: slot.stops } : { kind: 'LOAD_KEEP', truckId: op.to.truckId, stops: slot.stops };
      } else {
        const i = op.to.before ? list.findIndex((s) => s.loadId === op.to.before) : list.length;
        if (i < 0) return gone(op.to.before as string);
        list.splice(i, 0, slot);
      }
    } else {
      if (op.a === op.b) return refusal(422, 'SAME_LOAD', 'Choose another load to swap with.');
      const a = findLoad(op.a);
      if (!a) return gone(op.a);
      const b = findLoad(op.b);
      if (!b) return gone(op.b);
      touch(a.t);
      touch(b.t);
      for (const id of [...a.slot.stops, ...b.slot.stops]) moved.add(id);
      if (a.t === b.t) {
        a.list[a.i] = b.slot;
        a.list[b.i] = a.slot;
      } else {
        a.list[a.i] = { loadId: null, stops: b.slot.stops };
        b.list[b.i] = { loadId: null, stops: a.slot.stops };
      }
    }
    // A NEW_AT best counts its place among the loads that stay (dropped ones before it move it up).
    if (best && best.kind === 'NEW_AT' && last) best = { ...best, at: best.list.slice(0, best.at).filter((s) => s.stops.length > 0).length };
    dropEmpty();
  }
  if (edited.length > RETIME_MAX_TRUCKS) {
    return refusal(409, 'TOO_MANY_TRUCKS', `This change touches ${edited.length} trucks; a change by hand can touch at most ${RETIME_MAX_TRUCKS}: save part of it first.`);
  }

  const before = new Map<string, string[][]>();
  const after = new Map<string, string[][]>();
  const afterLoadIds = new Map<string, (string | null)[]>();
  for (const truck of edited) {
    const kept = listOf(truck);
    before.set(truck, (planned.get(truck) ?? []).map((l) => [...l.stops]));
    after.set(truck, kept.map((l) => [...l.stops]));
    afterLoadIds.set(truck, kept.map((l) => l.loadId));
  }
  let retimeBest: RetimeBest | null = null;
  if (best) {
    const [first, ...more] = best.stops;
    const many = more.length ? { more_stop_ids: more } : {};
    if (best.kind === 'LOAD') {
      const index = listOf(best.truckId).indexOf(best.slot);
      retimeBest = { stop_id: first!, truck_id: best.truckId, load_index: index, ...many };
    } else if (best.kind === 'NEW') {
      retimeBest = { stop_id: first!, truck_id: best.truckId, load_index: null, ...many };
    } else if (best.kind === 'NEW_AT') {
      retimeBest = { stop_id: first!, truck_id: best.truckId, load_index: null, ...many, new_load_at: best.at };
    } else {
      retimeBest = { stop_id: first!, truck_id: best.truckId, load_index: null, more_stop_ids: more, keep_order: true };
    }
  }
  if (!retimeBest && edited.every((t) => JSON.stringify(before.get(t)) === JSON.stringify(after.get(t)))) {
    return refusal(409, 'NO_CHANGE', ops.length === 1 && isV1Op(ops[0]!) ? 'Nothing changes: the stop is already there.' : 'Nothing changes: every load is already as asked.');
  }
  return { ok: true, edit: { edited, before, after, afterLoadIds, best: retimeBest, movedStops: moved, removedStops: removed, placedStops: placed } };
}

/**
 * v1 (kept for one stop): the edited trucks' new loads after `move` (`planned`: their PLANNED loads now, in
 * load order; `movedStop`: the request stop that moves, is put on or taken off). applyOps with one op.
 */
export function editTruckDays(move: PlanEditMove, planned: ReadonlyMap<string, readonly PlannedDayLoad[]>, movedStop: string, truckOfLoad: (loadId: string) => string | null):
  | { ok: true; edit: TruckDayEdit }
  | { ok: false; code: string; message: string } {
  if (move.kind !== 'PLACE') {
    const truck = truckOfLoad(move.from.loadId);
    if (!truck) return { ok: false, code: 'UNKNOWN_LOAD', message: 'Unknown load.' };
    const load = (planned.get(truck) ?? []).find((l) => l.loadId === move.from.loadId);
    if (!load || !load.stops.includes(movedStop)) return { ok: false, code: 'UNKNOWN_LOAD', message: 'Unknown stop.' };
  }
  if (move.kind !== 'REMOVE' && move.to.loadId && !(planned.get(move.to.truckId) ?? []).some((l) => l.loadId === move.to.loadId)) return { ok: false, code: 'UNKNOWN_LOAD', message: 'Unknown load.' };
  const r = applyOps([move], planned, { stopOf: () => movedStop });
  if (!r.ok) return { ok: false, code: r.code === 'NO_CHANGE' ? 'NO_CHANGE' : 'UNKNOWN_LOAD', message: r.message };
  return r;
}

/**
 * Where the best-place stops went in the solver's layout `S` of the best truck, against `W` (that truck's
 * layout without them, as applyOps left it): a new load at q (S has one load more, S[q] holds exactly the
 * best stops and S without it is W), or the existing load j (S[j] without them is W[j] in the same order,
 * every other load equal). Anything else: null (MISMATCH).
 */
export function resolveLayout(W: readonly (readonly string[])[], S: readonly (readonly string[])[], bestStops: readonly string[]): { kind: 'NEW'; q: number } | { kind: 'LOAD'; j: number } | null {
  const B = new Set(bestStops);
  if (S.length === W.length + 1) {
    for (let q = 0; q < S.length; q++) {
      if (!samePerm(S[q]!, bestStops)) continue;
      const rest = S.filter((_, i) => i !== q);
      if (rest.every((l, i) => sameList(l, W[i]!))) return { kind: 'NEW', q };
    }
    return null;
  }
  if (S.length === W.length) {
    for (let j = 0; j < S.length; j++) {
      if (!bestStops.every((s) => S[j]!.includes(s)) || S[j]!.length !== W[j]!.length + bestStops.length) continue;
      if (!sameList(S[j]!.filter((s) => !B.has(s)), W[j]!)) continue;
      if (S.every((l, i) => i === j || sameList(l, W[i]!))) return { kind: 'LOAD', j };
    }
  }
  return null;
}

/**
 * The last op of a list with its best place written out (design 3.4): an existing load gets its whole `order`
 * (a single v1 MOVE / PLACE: the numeric position), a new load the load it goes before (and its order), a whole
 * load moved the load it goes before. NO_EXPLICIT_PLACE: the best place is before a load made by an earlier op
 * of the list, which cannot be named.
 */
export function rewriteBest(op: PlanEditOp, place: { kind: 'NEW'; q: number } | { kind: 'LOAD'; j: number }, x: { truckId: string; wIds: readonly (string | null)[]; S: readonly (readonly string[])[]; bestStops: readonly string[]; refOf: (stopId: string) => EditStopRef }): PlanEditOp | 'NO_EXPLICIT_PLACE' | 'MISMATCH' {
  const beforeOf = (q: number): string | null | 'NO_EXPLICIT_PLACE' => {
    if (q >= x.wIds.length) return null;
    return x.wIds[q] ?? 'NO_EXPLICIT_PLACE';
  };
  if (op.kind === 'MOVE_LOAD') {
    if (place.kind !== 'NEW') return 'MISMATCH';
    const before = beforeOf(place.q);
    return before === 'NO_EXPLICIT_PLACE' ? before : { ...op, to: { truckId: x.truckId, before } };
  }
  if (op.kind === 'REMOVE' || op.kind === 'REMOVE_STOPS' || op.kind === 'SWAP_LOADS') return 'MISMATCH';
  if (place.kind === 'LOAD') {
    const loadId = x.wIds[place.j];
    if (!loadId) return 'MISMATCH';
    const stops = x.S[place.j]!;
    if (op.kind === 'MOVE_STOPS') return { ...op, to: { truckId: x.truckId, loadId, order: stops.map(x.refOf) } };
    return { ...op, to: { truckId: x.truckId, loadId, position: stops.indexOf(x.bestStops[0]!) } };
  }
  const before = beforeOf(place.q);
  if (before === 'NO_EXPLICIT_PLACE') return before;
  if (op.kind === 'MOVE_STOPS') return { ...op, to: { truckId: x.truckId, loadId: null, before, order: x.S[place.q]!.map(x.refOf) } };
  return { ...op, to: { truckId: x.truckId, loadId: null, before } };
}

/** An op whose place is explicit (no best place left in it). */
export function opIsExplicit(op: PlanEditOp): boolean {
  if (op.kind === 'REMOVE' || op.kind === 'REMOVE_STOPS' || op.kind === 'SWAP_LOADS') return true;
  if (op.kind === 'MOVE_LOAD') return op.to.before !== 'BEST';
  const to = op.to;
  const n = op.kind === 'MOVE_STOPS' ? op.stops.length : 1;
  if (to.order) return true;
  if (to.loadId) return typeof to.position === 'number' && n === 1;
  return to.before !== 'BEST' && n === 1;
}

/**
 * A best place the solver found, as a change with a concrete place (v1, one stop): on an existing load, its id
 * and the position; as a new load, the load it goes before (null = the end).
 */
export function resolvedMoveOf(move: PlanEditMove, edit: Pick<TruckDayEdit, 'afterLoadIds'>, option: { load_index?: number | null; new_load_at?: number | null; position: number }): PlanEditMove {
  if (move.kind === 'REMOVE') return move;
  const ids = edit.afterLoadIds.get(move.to.truckId) ?? [];
  const to: EditTarget =
    option.load_index !== null && option.load_index !== undefined
      ? { truckId: move.to.truckId, loadId: ids[option.load_index] ?? null, position: option.position }
      : { truckId: move.to.truckId, loadId: null, before: ids[option.new_load_at ?? ids.length] ?? null };
  return { ...move, to };
}

/**
 * v1: the best place the solver found (`option`, its options[0]) as the change Save sends, checked to give
 * exactly the option's loads. NO_CHANGE: the best place is where the stop already is. MISMATCH: the option does
 * not resolve to its own loads (a web or solver bug).
 */
export function resolveBestPlace(
  move: PlanEditMove,
  edit: TruckDayEdit,
  option: { truck_id: string; load_index?: number | null; new_load_at?: number | null; position: number; loads: string[][] },
  planned: ReadonlyMap<string, readonly PlannedDayLoad[]>,
  movedStop: string,
  truckOfLoad: (loadId: string) => string | null,
): { ok: true; move: PlanEditMove; edit: TruckDayEdit } | { ok: false; code: 'NO_CHANGE' | 'MISMATCH' } {
  const resolved = resolvedMoveOf(move, edit, option);
  const again = editTruckDays(resolved, planned, movedStop, truckOfLoad);
  if (!again.ok) return { ok: false, code: again.code === 'NO_CHANGE' ? 'NO_CHANGE' : 'MISMATCH' };
  if (JSON.stringify(again.edit.after.get(option.truck_id)) !== JSON.stringify(option.loads)) return { ok: false, code: 'MISMATCH' };
  return { ok: true, move: resolved, edit: again.edit };
}

/** The most stops one /retime-truck-days call takes (apps/solver/dispatch_models.py RETIME_MAX_STOPS v2: 422 above it; 80 in v1). */
export const RETIME_MAX_STOPS = 120;

/** The distinct stops a check sends: the edited trucks' loads before and after, and the best-place stops. */
export function retimeStopCount(edit: Pick<TruckDayEdit, 'before' | 'after' | 'best'>): number {
  const ids = new Set([...edit.before.values(), ...edit.after.values()].flat(2));
  if (edit.best) {
    ids.add(edit.best.stop_id);
    for (const s of edit.best.more_stop_ids ?? []) ids.add(s);
  }
  return ids.size;
}

/**
 * The amber warnings of a change (design 3.2 step 12): both parts of a customer delivered in parts on one load
 * after the change (the driver unloads it twice), and a truck hired for this day left with no load.
 */
export function editWarnings(x: {
  edit: Pick<TruckDayEdit, 'edited' | 'before' | 'after'>;
  stops: ReadonlyMap<string, Pick<DispatchStop, 'customer_id'>>;
  names: ReadonlyMap<string, string>;
  truckCodes: ReadonlyMap<string, string>;
  frozenCount: (truckId: string) => number;
  hiredForDay: ReadonlySet<string>;
}): string[] {
  const out: string[] = [];
  for (const t of x.edit.edited) {
    const code = x.truckCodes.get(t) ?? t;
    const before = new Set((x.edit.before.get(t) ?? []).map((l) => l.join(',')));
    (x.edit.after.get(t) ?? []).forEach((load, j) => {
      if (before.has(load.join(','))) return;
      const by = new Map<string, number[]>();
      load.forEach((id, i) => {
        const c = x.stops.get(id)?.customer_id;
        if (c) by.set(c, [...(by.get(c) ?? []), i + 1]);
      });
      for (const [, at] of by) {
        if (at.length < 2) continue;
        const label = (x.names.get(load[at[0]! - 1]!) ?? 'A customer').replace(/#\d+$/, '');
        out.push(
          `Both parts of ${label} (delivered in parts today) are on ${code} L${x.frozenCount(t) + j + 1}: the driver unloads it twice (stops ${at.join(' and ')}). A RE-PLAN delivers it in one stop.`,
        );
      }
    });
    if (x.hiredForDay.has(t) && (x.edit.after.get(t) ?? []).length === 0 && x.frozenCount(t) === 0) {
      out.push(`${code}, hired for this day, has no load after this change: cancel its hire under Hired trucks if it is not needed.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Allow anyway: judging an issue, its override id, carrying allowances forward (pure)
// ---------------------------------------------------------------------------------------------

/** The override id of an issue (design 3.10): its kind, truck and rows. Amounts are not in it. */
export function overrideId(kind: OverrideKind, truckId: string, rowKeys: readonly string[]): string {
  return 'ovr_' + createHash('sha256').update(JSON.stringify([kind, truckId, [...rowKeys].sort()])).digest('hex').slice(0, 16);
}

/** An issue as the server keeps it: the preview's EditIssue plus what a save stores. */
export interface JudgedIssue extends EditIssue {
  stopId: string | null;
  rowKeys: string[];
  /** LATE: the receiving-hours rule and hours as today's request has them. */
  rule?: 'START' | 'FINISH';
  windowStartMin?: number | null;
  windowEndMin?: number | null;
  /** CAPACITY_*: the planning limit (display unit). */
  limit?: number | null;
  /** The source allowance of a carried issue. */
  carriedFrom?: HandAllowance;
}

export interface JudgeContext {
  request: Pick<DispatchRequest, 'stops' | 'trucks' | 'config'>;
  scope: Pick<PlanScope, 'portions' | 'palletUnits'>;
  /** Order id -> its kg (as materializeLoads reads it). */
  orderKg: ReadonlyMap<string, number>;
  /** The stop ids of a load of the layout the issue is judged on (load_no as the solver numbers it). */
  loadStops: (truckId: string, loadNo: number) => readonly string[] | null;
  names: ReadonlyMap<string, string>;
  truckCodes: ReadonlyMap<string, string>;
  /** The request asked the solver what can be allowed (PLAN_EDIT_OVERRIDES on). */
  overridesOn: boolean;
  /** The solver answered a relaxed attempt (NO_TIMETABLE then points to it). */
  relaxedPresent: boolean;
}

const pctOver = (figure: number, capacity: number) => (capacity > 0 ? Math.round((figure / capacity - 1) * 100) : 0);

/**
 * One solver violation as an issue (design 3.7, one function for Check and Save): its kind, whether it can be
 * allowed by hand, by how much and why not. Capacity is judged on the WEB's own figures for the load (the ones
 * materializeLoads stores and the gate reads), which must agree with the solver's, and capped at 120 % of the
 * truck's own capacity in whole units; a late arrival needs the solver's late_s > 0 (a stop 1 s late counts);
 * arriving early never; the break only with the break rule on.
 */
export function judgeIssue(v: FeasibilityViolation, c: JudgeContext): JudgedIssue {
  const truckId = v.truck_id ?? null;
  const truckCode = truckId ? (c.truckCodes.get(truckId) ?? truckId) : null;
  const loadNo = v.load_no ?? null;
  const stop = v.stop_id ? c.request.stops.find((s) => s.stop_id === v.stop_id) : undefined;
  const message = relabel(relabel(v.message, c.names), c.truckCodes);
  const base: JudgedIssue = {
    id: null,
    code: v.code,
    kind: null,
    overridable: false,
    whyNot: null,
    truckId,
    truckCode,
    loadNo,
    stopLabel: v.stop_id ? (c.names.get(v.stop_id) ?? null) : null,
    customerId: stop?.customer_id ?? null,
    orderIds: stop ? [...new Set(stop.order_ids.map(orderIdOf))] : [],
    amount: null,
    text: message,
    carried: null,
    previous: null,
    stopId: v.stop_id ?? null,
    rowKeys: [],
  };
  const notJudged = c.overridesOn ? WHY_NOT_TEXT.NO_FIGURES : WHY_NOT_TEXT.OVERRIDES_OFF;
  const truck = truckId ? c.request.trucks.find((t) => t.id === truckId) : undefined;
  if (v.code === 'HARD_WINDOW') {
    const rule: 'START' | 'FINISH' = c.request.config.window_rule === 'FINISH' ? 'FINISH' : 'START';
    const value = typeof v.value === 'number' ? v.value : null;
    const limit = typeof v.limit === 'number' ? v.limit : null;
    if (value !== null && limit !== null && value < limit) return { ...base, whyNot: WHY_NOT_TEXT.EARLY };
    const late = typeof v.late_s === 'number' && v.late_s > 0 && value !== null && limit !== null && value >= limit;
    if (!late || !truckId || !stop) return { ...base, whyNot: notJudged };
    const rowKeys = stop.order_ids.map((r) => refKey(r, c.scope.portions));
    const amount = { unit: 'min' as const, value, limit, over: lateMinutes(value, limit) };
    const overridable = v.overridable === true;
    const issue: JudgedIssue = {
      ...base,
      id: overrideId('LATE', truckId, rowKeys),
      kind: 'LATE',
      overridable,
      whyNot: overridable ? null : v.overridable === false ? WHY_NOT_TEXT.DEFAULT : notJudged,
      amount,
      rowKeys,
      rule,
      windowStartMin: stop.hard_start_min ?? null,
      windowEndMin: stop.hard_end_min ?? null,
    };
    return { ...issue, text: issueText({ ...issue, rule, windowStartMin: stop.hard_start_min ?? null, message }) };
  }
  if (v.code === 'CAPACITY_PALLETS' || v.code === 'CAPACITY_CASES' || v.code === 'CAPACITY_KG') {
    const kind = v.code;
    const ids = truckId && loadNo !== null ? c.loadStops(truckId, loadNo) : null;
    if (!truckId || !truck || !ids) return { ...base, whyNot: notJudged };
    const stops = ids.map((id) => c.request.stops.find((s) => s.stop_id === id)).filter((s): s is DispatchStop => !!s);
    const refs = stops.flatMap((s) => s.order_ids);
    const rowKeys = refs.map((r) => refKey(r, c.scope.portions));
    const id = overrideId(kind, truckId, rowKeys);
    let figure: number;
    let capacityUnits: number;
    let agree: boolean;
    let amount: NonNullable<EditIssue['amount']>;
    let capacityWords: string;
    const limit = typeof v.limit === 'number' ? v.limit : null;
    if (kind === 'CAPACITY_PALLETS') {
      const bays = typeof truck.bays === 'number' ? truck.bays : null;
      const known = !!c.scope.palletUnits && refs.every((r) => typeof c.scope.palletUnits?.[r] === 'number');
      figure = refs.reduce((a, r) => a + (c.scope.palletUnits?.[r] ?? 0), 0);
      capacityUnits = (bays ?? 0) * 1000;
      agree = known && bays !== null && typeof v.value === 'number' && Math.round(v.value * 1000) === figure;
      amount = { unit: 'pallets', value: figure / 1000, limit: limit ?? capacityUnits / 1000, over: Math.round((figure / 1000 - (limit ?? capacityUnits / 1000)) * 10) / 10, capacity: bays ?? 0, overPct: pctOver(figure, capacityUnits) };
      capacityWords = `the truck's ${bays ?? '?'} bays`;
    } else if (kind === 'CAPACITY_CASES') {
      figure = stops.reduce((a, s) => a + s.demand_cases, 0);
      capacityUnits = truck.capacity_cases;
      agree = typeof v.value === 'number' && v.value === figure;
      amount = { unit: 'cases', value: figure, limit: limit ?? capacityUnits, over: figure - (limit ?? capacityUnits), capacity: capacityUnits, overPct: pctOver(figure, capacityUnits) };
      capacityWords = `the truck's ${capacityUnits.toLocaleString('en-US')} cases`;
    } else {
      const kg = loadKgFromRefs(refs, c.scope, new Map(c.orderKg));
      figure = Math.round(kg * 10);
      capacityUnits = payloadTenths(truck.capacity_kg ?? 0);
      agree = typeof v.value === 'number' && Math.abs(v.value - kg) <= KG_ROUNDING_TOL;
      amount = { unit: 'kg', value: kg, limit: limit ?? capacityUnits / 10, over: Math.round((kg - (limit ?? capacityUnits / 10)) * 10) / 10, capacity: capacityUnits / 10, overPct: pctOver(figure, capacityUnits) };
      capacityWords = `the truck's payload of ${(capacityUnits / 10).toLocaleString('en-US')} kg`;
    }
    const withinCap = capacityUnits > 0 && figure <= overrideCapUnits(capacityUnits);
    const overridable = v.overridable === true && agree && withinCap;
    const solverFigure = typeof v.value === 'number' ? v.value : null;
    const unitWord = kind === 'CAPACITY_PALLETS' ? 'pallets' : kind === 'CAPACITY_CASES' ? 'cases' : 'kg';
    const whyNot = overridable
      ? null
      : !agree && solverFigure !== null
        ? `The optimizer's figures for this load do not match the plan's (${solverFigure} / ${amount.value} ${unitWord}): re-plan the day.`
        : !agree
          ? notJudged
          : !withinCap
            ? `${amount.overPct}% over ${capacityWords}: more than the ${OVERRIDE_CAPACITY_MAX_PCT}% that can be allowed by hand.`
            : v.overridable === false
              ? WHY_NOT_TEXT.DEFAULT
              : notJudged;
    const issue: JudgedIssue = { ...base, id, kind, overridable, whyNot, amount, rowKeys, limit, orderIds: [...new Set(refs.map(orderIdOf))], customerId: null };
    return { ...issue, text: issueText({ ...issue, message, fillPct: typeof c.request.config.pallet_fill_pct === 'number' ? c.request.config.pallet_fill_pct : null }) };
  }
  if (v.code === 'BREAK') {
    if (!truckId) return { ...base, whyNot: WHY_NOT_TEXT.DEFAULT };
    const breakOn = (c.request.config.break_min ?? 0) > 0;
    const overridable = v.overridable === true && breakOn;
    const whyNot = overridable
      ? null
      : v.overridable === false || !breakOn
        ? `This driver break problem cannot be allowed by hand: ${truckCode} has no time left for a break today.`
        : notJudged;
    return { ...base, id: overrideId('NO_BREAK', truckId, []), kind: 'NO_BREAK', overridable, whyNot };
  }
  if (v.code === 'NO_TIMETABLE') return { ...base, whyNot: c.relaxedPresent ? WHY_NOT_TEXT.NO_TIMETABLE : WHY_NOT_TEXT.DEFAULT };
  const why = (WHY_NOT_TEXT as Record<string, string>)[v.code];
  return { ...base, whyNot: why ?? WHY_NOT_TEXT.DEFAULT };
}

/** Issues deduplicated by override id (several BREAK findings of one truck are one NO_BREAK; the first message is kept). */
export function dedupeIssues<T extends EditIssue>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of list) {
    const key = x.id ?? `${x.code}|${x.truckId}|${x.loadNo}|${x.stopLabel}|${x.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

/** A stored allowance of an edited truck's load (PLANNED: every kind; frozen: NO_BREAK only). */
export interface StoredAllowance {
  allowance: HandAllowance;
  truckId: string;
  loadId: string;
  loadNo: number;
  status: string;
}

/** The allowances a check reads: the edited trucks' PLANNED loads (every kind), their frozen loads (NO_BREAK). */
export function storedAllowancesOf(loads: readonly EditLoad[], edited: ReadonlySet<string>): StoredAllowance[] {
  return loads
    .filter((l) => edited.has(l.truckId))
    .flatMap((l) =>
      readHandAllowances(l.truckSnapshotJson)
        .filter((a) => l.status === 'PLANNED' || a.kind === 'NO_BREAK')
        .map((a) => ({ allowance: a, truckId: l.truckId, loadId: l.id, loadNo: l.loadNo, status: l.status })),
    );
}

const maxOf = (a: HandAllowance) => (a.kind === 'LATE' ? (a.maxLateMin ?? 0) : (a.maxValue ?? 0));

/**
 * Carrying allowances forward (design 3.8, D6): a needed issue is carried - kept without asking, with no role -
 * when one stored allowance of the same truck covers it: LATE the same rule, the same rows, the same hours today
 * and no more minutes late than approved; CAPACITY_* the same kind, the load's rows a subset, the figure no more
 * than approved and the truck's capacity unchanged; NO_BREAK any NO_BREAK of the truck-day under today's break
 * rule. Several: the largest maximum, then the latest. Otherwise a same-kind allowance on the same stop / rows /
 * truck is `previous` (its reason pre-fills the input; the issue needs approval).
 */
export function carryIssues(needed: readonly JudgedIssue[], stored: readonly StoredAllowance[], config: Pick<DispatchRequest['config'], 'break_min' | 'break_start_from_min' | 'break_start_to_min'>): JudgedIssue[] {
  return needed.map((issue) => {
    if (!issue.kind || !issue.truckId) return issue;
    const mine = stored.filter((s) => s.truckId === issue.truckId && s.allowance.kind === issue.kind).map((s) => s.allowance);
    const keys = new Set(issue.rowKeys);
    const sameRows = (a: HandAllowance) => a.rowKeys.length === keys.size && a.rowKeys.every((k) => keys.has(k));
    const subset = (a: HandAllowance) => issue.rowKeys.every((k) => a.rowKeys.includes(k));
    let covers: HandAllowance[] = [];
    let previous: HandAllowance[] = [];
    if (issue.kind === 'LATE') {
      previous = mine.filter(sameRows);
      covers = previous.filter(
        (a) =>
          (a.rule ?? 'START') === (issue.rule ?? 'START') &&
          (a.windowStartMin ?? null) === (issue.windowStartMin ?? null) &&
          a.windowEndMin === (issue.windowEndMin ?? undefined) &&
          !!issue.amount &&
          issue.amount.over <= (a.maxLateMin ?? 0),
      );
    } else if (issue.kind === 'NO_BREAK') {
      previous = mine;
      covers = mine.filter((a) => a.breakMin === (config.break_min ?? undefined) && a.breakFromMin === (config.break_start_from_min ?? undefined) && a.breakToMin === (config.break_start_to_min ?? undefined));
    } else {
      previous = mine.filter((a) => a.rowKeys.some((k) => keys.has(k)));
      covers = mine.filter((a) => subset(a) && !!issue.amount && issue.amount.value <= (a.maxValue ?? -1) + 1e-9 && a.capacity === issue.amount.capacity);
    }
    const pick = (list: HandAllowance[]) => [...list].sort((a, b) => maxOf(b) - maxOf(a) || b.at.localeCompare(a.at))[0];
    const src = pick(covers);
    if (src) return { ...issue, carried: { fromId: src.id, reason: src.reason, byName: src.byName, byRole: src.byRole, at: src.at }, carriedFrom: src, previous: null };
    const prev = pick(previous);
    return prev ? { ...issue, previous: { reason: prev.reason, byName: prev.byName, at: prev.at } } : issue;
  });
}

/** The issue as the preview shows it (the server's own fields left out). */
export function issueView(x: JudgedIssue): EditIssue {
  const { stopId: _s, rowKeys: _r, rule: _u, windowStartMin: _a, windowEndMin: _b, limit: _l, carriedFrom: _c, ...view } = x;
  void _s; void _r; void _u; void _a; void _b; void _l; void _c;
  return view;
}

/**
 * The allowances a save stores on each new load (design 5), from the needed issues (web figures; confirmed or
 * carried): LATE on the stop's load, CAPACITY_* on its load, NO_BREAK on every new load of the truck. Keyed
 * `${truckId}:${loadNo}` (the solver's load numbers, which materializeLoads stores).
 */
export function allowancesOfSave(x: {
  needed: readonly JudgedIssue[];
  confirmed: ReadonlyMap<string, string>;
  user: { id: string; name: string; role: 'SUPERVISOR' | 'TENANT_ADMIN' | 'SUPER_ADMIN' };
  at: string;
  runId: string;
  newLoads: readonly { truck_id: string; load_no: number }[];
  config: Pick<DispatchRequest['config'], 'break_min' | 'break_start_from_min' | 'break_start_to_min'>;
}): Map<string, HandAllowance[]> {
  const out = new Map<string, HandAllowance[]>();
  const add = (key: string, a: HandAllowance) => out.set(key, [...(out.get(key) ?? []).filter((y) => y.id !== a.id), a]);
  for (const issue of x.needed) {
    if (!issue.kind || !issue.id || !issue.truckId) continue;
    const src = issue.carriedFrom ?? null;
    const reason = src ? src.reason : (x.confirmed.get(issue.id) ?? '');
    const who = src
      ? { reason, byUserId: src.byUserId, byName: src.byName, byRole: src.byRole, at: src.at, runId: src.runId, carriedFrom: { id: src.id, runId: src.runId } }
      : { reason, byUserId: x.user.id, byName: x.user.name, byRole: x.user.role, at: x.at, runId: x.runId };
    const base = { v: 1 as const, id: issue.id, kind: issue.kind, rowKeys: [...issue.rowKeys].sort(), orderIds: [...issue.orderIds].sort(), ...who };
    if (issue.kind === 'LATE' && issue.amount && issue.loadNo !== null) {
      add(`${issue.truckId}:${issue.loadNo}`, {
        ...base,
        ...(issue.customerId ? { customerId: issue.customerId } : {}),
        ...(issue.stopLabel ? { stopLabel: issue.stopLabel } : {}),
        rule: issue.rule ?? 'START',
        windowStartMin: issue.windowStartMin ?? null,
        windowEndMin: issue.windowEndMin ?? issue.amount.limit,
        atMin: issue.amount.value,
        lateMin: issue.amount.over,
        maxLateMin: src ? Math.max(src.maxLateMin ?? 0, issue.amount.over) : issue.amount.over,
      });
    } else if (issue.kind === 'NO_BREAK') {
      for (const l of x.newLoads.filter((n) => n.truck_id === issue.truckId)) {
        add(`${l.truck_id}:${l.load_no}`, { ...base, breakMin: x.config.break_min ?? undefined, breakFromMin: x.config.break_start_from_min ?? undefined, breakToMin: x.config.break_start_to_min ?? undefined });
      }
    } else if (issue.amount && issue.loadNo !== null) {
      add(`${issue.truckId}:${issue.loadNo}`, {
        ...base,
        value: issue.amount.value,
        maxValue: src ? Math.max(src.maxValue ?? 0, issue.amount.value) : issue.amount.value,
        limit: issue.amount.limit,
        ...(typeof issue.amount.capacity === 'number' ? { capacity: issue.amount.capacity } : {}),
        ...(typeof issue.amount.overPct === 'number' ? { overPct: issue.amount.overPct } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Merging the re-timed trucks into the option in use (pure)
// ---------------------------------------------------------------------------------------------

/**
 * The solver's report of the merged option: the option's own findings on the trucks the move did not
 * re-time (and on the edited trucks' frozen loads, which it did not change either), plus the new check of
 * the edited trucks. UNVERIFIED when either side is (or the option had none); VIOLATED when a finding is
 * left; EXACT only when both are. The issues allowed by hand (`allowed`) are merged the same way. The web
 * gate reads it per truck (feasibility.ts).
 */
export function mergeSolverReport(
  copied: FeasibilityReport | null | undefined,
  fresh: FeasibilityReport | null | undefined,
  edited: ReadonlySet<string>,
  replacedKeys: ReadonlySet<string>,
): FeasibilityReport | null {
  if (!copied) return fresh ? { ...fresh, status: 'UNVERIFIED' } : null;
  const replaced = (v: FeasibilityViolation) => !!v.truck_id && edited.has(v.truck_id) && (v.load_no === null || v.load_no === undefined || replacedKeys.has(`${v.truck_id}:${v.load_no}`));
  const violations = [...(copied.violations ?? []).filter((v) => !replaced(v)), ...(fresh?.violations ?? [])];
  const allowed = [...(copied.allowed ?? []).filter((v) => !replaced(v)), ...(fresh?.allowed ?? [])];
  const status: FeasibilityReport['status'] = copied.status === 'UNVERIFIED' || !fresh || fresh.status === 'UNVERIFIED' ? 'UNVERIFIED' : violations.length ? 'VIOLATED' : 'VERIFIED';
  const { allowed: _a, ...rest } = copied;
  void _a;
  return {
    ...rest,
    status,
    timing: copied.timing === 'EXACT' && fresh?.timing === 'EXACT' ? 'EXACT' : 'ESTIMATED',
    violations,
    ...(copied.travel_checked !== undefined || fresh?.travel_checked !== undefined ? { travel_checked: !!copied.travel_checked && !!fresh?.travel_checked } : {}),
    ...(allowed.length ? { allowed } : {}),
  };
}

/** "The MIN TRUCKS option serves 2 more stop(s) than this plan ...": the child has only the option in use (critic M7). */
const SERVES_MORE = /option serves \d+ more stop\(s\) than this plan/;

type RemovedStop = { stop_id: string; order_ids: readonly string[]; reason_message: string };

/**
 * The option in use with the edited trucks re-timed (critic M3, M7): their PLANNED loads replaced by the
 * solver's (refs mapped back to the option's own ids, a new split part's record added), their truck days
 * replaced, the totals counted again over the merged loads, the findings merged (mergeSolverReport), the
 * pallet units of the edited refs taken from today's request, the unserved stops as the UnservedOrder rows
 * will be (an order put on leaves, a stop taken off joins as REMOVED_BY_HAND), the "Use instead" note
 * dropped and the manual line and block added. Everything else (scope, inputs, search) stays as copied.
 */
export function mergeOption(input: {
  copied: ScenarioDetails;
  sc: DispatchScenario;
  edited: ReadonlySet<string>;
  /** `${truckId}:${loadNo}` of the edited trucks' PLANNED loads before the change. */
  replacedKeys: ReadonlySet<string>;
  refMap: ReadonlyMap<string, string>;
  freshScope: Pick<PlanScope, 'portions' | 'palletUnits'>;
  frozenTruckIds: Iterable<string>;
  /** Truck ids in the order the option lists them (the request's: by code). */
  truckOrder: readonly string[];
  manual: ManualEdit;
  warning: string;
  /**
   * The option's unserved stops (details.unserved: the hire box and check read them, not the rows): the orders
   * put on a truck leave it; the stops taken off join it (`order_ids`: today's refs, mapped as the loads' are).
   */
  unserved: { placedOrderIds: readonly string[]; removed: RemovedStop | readonly RemovedStop[] | null };
}): { details: ScenarioDetails; loads: PlannedLoad[] } {
  const { copied, sc, edited } = input;
  const key = (l: { truck_id: string; load_no: number }) => `${l.truck_id}:${l.load_no}`;
  const keptLoads = copied.loads.filter((l) => !(edited.has(l.truck_id) && input.replacedKeys.has(key(l))));
  const portions: Record<string, PortionRecord> = { ...(copied.scope.portions ?? {}) };
  const units = copied.scope.palletUnits || input.freshScope.palletUnits ? { ...(copied.scope.palletUnits ?? {}) } : undefined;
  const used = new Set(keptLoads.flatMap((l) => l.stops.flatMap((s) => s.order_ids)));
  const sameLines = (a: PortionRecord, b: PortionRecord) => portionLinesKey(a.lines) === portionLinesKey(b.lines) && a.cases === b.cases;
  const refOf = (fresh: string): string => {
    const rec = input.freshScope.portions?.[fresh];
    let ref = input.refMap.get(fresh) ?? fresh;
    if (rec) {
      if (!input.refMap.has(fresh) && ((portions[ref] && !sameLines(portions[ref]!, rec)) || used.has(ref))) {
        let k = 1;
        while (portions[portionId(orderIdOf(fresh), `m${k}`)] || used.has(portionId(orderIdOf(fresh), `m${k}`))) k++;
        ref = portionId(orderIdOf(fresh), `m${k}`);
      }
      // Today's record of the part (the kg and pallets the solver was sent).
      portions[ref] = rec;
    }
    used.add(ref);
    const u = input.freshScope.palletUnits?.[fresh];
    if (units && typeof u === 'number') units[ref] = u;
    return ref;
  };
  const newLoads: PlannedLoad[] = sc.loads.map((l) => ({ ...l, stops: l.stops.map((s) => ({ ...s, order_ids: s.order_ids.map(refOf) })) }));
  // An order put on a truck is no longer left out; a stop taken off is (never a capacity reason: no hire for it).
  const placed = new Set(input.unserved.placedOrderIds);
  const removedList: readonly RemovedStop[] = !input.unserved.removed ? [] : Array.isArray(input.unserved.removed) ? (input.unserved.removed as readonly RemovedStop[]) : [input.unserved.removed as RemovedStop];
  const unserved: UnservedStop[] = [
    ...(copied.unserved ?? []).flatMap((u) => {
      const left = u.order_ids.filter((r) => !placed.has(orderIdOf(r)));
      return left.length ? [{ ...u, order_ids: left }] : [];
    }),
    ...removedList.map((removed) => ({ stop_id: removed.stop_id, order_ids: removed.order_ids.map(refOf), reason_code: 'REMOVED_BY_HAND' as const, reason_message: removed.reason_message })),
  ];
  const rank = new Map(input.truckOrder.map((id, i) => [id, i]));
  const order = (a: { truck_id: string; load_no: number }, b: { truck_id: string; load_no: number }) =>
    (rank.get(a.truck_id) ?? 1e9) - (rank.get(b.truck_id) ?? 1e9) || a.truck_id.localeCompare(b.truck_id) || a.load_no - b.load_no;
  const loads = [...keptLoads, ...newLoads].sort(order);
  const truckDays = [...(copied.truck_days ?? []).filter((d) => !edited.has(d.truck_id)), ...(sc.truck_days ?? [])].sort((a, b) => order({ truck_id: a.truck_id, load_no: 0 }, { truck_id: b.truck_id, load_no: 0 }));
  const sum = (f: (l: PlannedLoad) => number) => loads.reduce((a, l) => a + f(l), 0);
  const util = loads.map((l) => l.utilization_pct);
  const trucksUsed = new Set([...loads.map((l) => l.truck_id), ...input.frozenTruckIds]).size;
  const details: ScenarioDetails = {
    ...copied,
    loads,
    unserved,
    truck_days: truckDays,
    trips: loads.length,
    trucks_used: trucksUsed,
    total_distance_km: Math.round(sum((l) => l.distance_km) * 100) / 100,
    total_duration_min: sum((l) => l.duration_min),
    total_cases: sum((l) => l.cases),
    total_kg: Math.round(sum((l) => l.kg) * 10) / 10,
    avg_utilization_pct: util.length ? Math.round((util.reduce((a, b) => a + b, 0) / util.length) * 10) / 10 : 0,
    fuel_litres: Math.round(sum((l) => l.fuel_litres ?? 0) * 10) / 10,
    fuel_cost: Math.round(sum((l) => l.fuel_cost) * 1000) / 1000,
    operating_cost: Math.round(sum((l) => l.total_cost) * 1000) / 1000,
    paid_driver_min: truckDays.reduce((a, d) => a + (d.paid_min ?? 0), 0),
    estimated_legs: copied.estimated_legs === null || copied.estimated_legs === undefined ? copied.estimated_legs : sum((l) => l.estimated_legs ?? 0),
    feasibility: mergeSolverReport(copied.feasibility, sc.feasibility, edited, input.replacedKeys),
    warnings: [...(copied.warnings ?? []).filter((w) => !SERVES_MORE.test(w)), input.warning],
    scope: { ...copied.scope, portions, ...(units ? { palletUnits: units } : {}) },
    ...({ manual: input.manual } as Record<string, unknown>),
  };
  return { details, loads: newLoads };
}

// ---------------------------------------------------------------------------------------------
// The stale check and the preview hashes (pure)
// ---------------------------------------------------------------------------------------------

/**
 * What a check depended on, as one hash (critic M2: only what the move touches, so a late order or a
 * customer edit elsewhere never refuses it): the config (without what moves with the clock or the
 * search), the depot, the edited trucks as the request sends them (their frozen trips included), the
 * request stops on them before and after (and the stops moved), their stored loads and rows (and the
 * allowances by hand they carry), the option in use, and the unserved rows of an order put on a truck.
 */
export function editBasis(input: {
  request: DispatchRequest;
  edited: readonly string[];
  stopIds: Iterable<string>;
  loads: readonly EditLoad[];
  chosenScenarioId: string | null;
  unserved: readonly EditUnserved[];
}): string {
  const edited = new Set(input.edited);
  const stops = new Set(input.stopIds);
  const config = Object.fromEntries(Object.entries(input.request.config ?? {}).filter(([k]) => !VOLATILE_CONFIG.has(k)));
  const text = JSON.stringify(
    canonical({
      config,
      depot: input.request.depot,
      trucks: input.request.trucks.filter((t) => edited.has(t.id)).sort((a, b) => a.id.localeCompare(b.id)),
      stops: input.request.stops.filter((s) => stops.has(s.stop_id)).sort((a, b) => a.stop_id.localeCompare(b.stop_id)),
      loads: input.loads
        .filter((l) => edited.has(l.truckId))
        .map((l) => {
          const allowed = readHandAllowances(l.truckSnapshotJson).map((a) => `${a.id}:${a.at}`).sort();
          return {
            id: l.id,
            status: l.status,
            loadNo: l.loadNo,
            rows: l.rows.map((r) => [r.orderId, r.sequenceInTruck, r.orderInStop, r.portionCases, portionLinesKey(readPortionLines(r.portionLinesJson))]),
            ...(allowed.length ? { allowed } : {}),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
      chosenScenarioId: input.chosenScenarioId,
      unserved: input.unserved.map((u) => [u.orderId, u.reasonCode, portionLinesKey(readPortionLines(u.portionLinesJson))]).sort(),
    }),
  );
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The strict hash a save must find again (v2): the basis, when the day was read, the change list (resolved)
 * and what the solver answered with every rule. `move` (v1 callers) is a list of one.
 */
export function previewHash(input: { basis: string; builtAt: string; ops?: readonly PlanEditOp[]; move?: PlanEditOp; truckDays: { truck_id: string; loads: string[][] }[]; answer: RetimeResponse }): string {
  const a = input.answer;
  const text = JSON.stringify(
    canonical({
      v: 2,
      basis: input.basis,
      builtAt: input.builtAt,
      ops: input.ops ?? (input.move ? [input.move] : []),
      truckDays: input.truckDays,
      ok: a.ok,
      trucks: a.trucks.map((t) => ({ id: t.truck_id, feasible: t.feasible, violations: t.violations.map((v) => [v.code, v.load_no ?? null, v.stop_id ?? null, v.short_by_min ?? null]) })),
      loads: (a.scenario?.loads ?? []).map((l) => ({
        t: l.truck_id,
        n: l.load_no,
        d: l.depart_min,
        r: l.return_min,
        c: l.total_cost,
        s: l.stops.map((s) => [s.stop_id, s.arrival_min, s.service_start_min]),
      })),
      matrix: a.distance_quality,
    }),
  );
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The overrides hash (design 3.11): the basis, builtAt, the change list (resolved), skipBreak, the carried
 * pairs, the needed issues with their web figures, and the RELAXED answer only (never the strict answer, the
 * options or the best counts), so a best Check and the explicit Save of its place agree.
 */
export function overridesHash(input: {
  basis: string;
  builtAt: string;
  ops: readonly PlanEditOp[];
  skipBreak: readonly string[];
  carried: readonly [string, string][];
  needed: readonly EditIssue[];
  relaxed: RetimeRelaxed;
  matrix: string;
}): string {
  const r = input.relaxed;
  const sorted = (x: readonly string[] | undefined) => [...(x ?? [])].sort();
  const text = JSON.stringify(
    canonical({
      v: 2,
      kind: 'OVERRIDES',
      basis: input.basis,
      builtAt: input.builtAt,
      ops: input.ops,
      skipBreak: sorted(input.skipBreak),
      carried: [...input.carried].map((p) => [...p]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
      needed: input.needed.map((n) => [n.id, n.kind, n.amount?.unit ?? null, n.amount?.value ?? null, n.amount?.limit ?? null, n.amount?.over ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      relaxed: {
        ok: r.ok,
        relaxations: {
          late: sorted(r.relaxations.late_stop_ids),
          cap: sorted(r.relaxations.over_capacity_truck_ids),
          factor: r.relaxations.capacity_factor ?? null,
          noBreak: sorted(r.relaxations.no_break_truck_ids),
        },
        loads: r.loads,
        trucks: r.trucks.map((t) => ({
          id: t.truck_id,
          feasible: t.feasible,
          violations: t.violations.map((v) => [v.code, v.load_no ?? null, v.stop_id ?? null]),
          allowed: (t.allowed ?? []).map((v) => [v.code, v.load_no ?? null, v.stop_id ?? null, v.value ?? null, v.limit ?? null, v.late_s ?? null]),
        })),
        scenario: (r.scenario?.loads ?? []).map((l) => [l.truck_id, l.load_no, l.depart_min, l.return_min, l.total_cost, l.stops.map((s) => [s.stop_id, s.service_start_min, s.departure_min])]),
        delta: r.delta_money_omr ?? null,
      },
      matrix: input.matrix,
    }),
  );
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// The preview (pure)
// ---------------------------------------------------------------------------------------------

/** The solver's words with the request's stop ids replaced by the customers the dispatcher knows. */
export function relabel(message: string, names: ReadonlyMap<string, string>): string {
  const ids = [...names.keys()].sort((a, b) => b.length - a.length);
  let out = message;
  for (const id of ids) out = out.split(id).join(names.get(id)!);
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function storedDayView(loads: readonly EditLoad[], movedKeys: ReadonlySet<string>): EditTruckDayView {
  const views: EditLoadView[] = loads.map((l) => {
    const late = readHandAllowances(l.truckSnapshotJson).filter((a) => a.kind === 'LATE');
    return {
      loadNo: l.loadNo,
      status: l.status,
      kept: l.status !== 'PLANNED',
      departMin: l.departMin,
      returnMin: l.returnMin,
      km: l.distanceKm,
      cases: l.cases,
      palletUnits: l.palletUnits,
      roomUnits: readTruckSnapshot(l.truckSnapshotJson)?.palletRoomUnits ?? null,
      costOmr: l.operatingCost,
      breakStartMin: parseLoadBreak(l.breakJson)?.startMin ?? null,
      stops: planStopsOf(l).map((p): EditStopView => {
        const first = p.rows[0]!;
        const snap = readStopSnapshot(first.stopSnapshotJson);
        const keys = p.rows.map((r) => rowKey(r.orderId, r.portionLinesJson));
        const allowed = first.hardWindowOk === false && late.some((a) => keys.every((k) => a.rowKeys.includes(k)));
        return {
          sequence: p.sequence,
          label: p.label,
          cases: p.rows.reduce((a, r) => a + r.cases, 0),
          etaMin: first.etaMin,
          startMin: first.serviceStartMin,
          window: snap ? windowText(snap.hardStartMin, snap.hardEndMin) : null,
          hardOk: first.hardWindowOk,
          prefOk: first.prefWindowOk,
          moved: movedKeys.has(stopKeyOf(l.id, p.sequence)),
          ...(allowed ? { allowed: true } : {}),
        };
      }),
    };
  });
  const planned = views.filter((v) => !v.kept);
  return {
    loads: views,
    firstDepartMin: views.length ? Math.min(...views.map((v) => v.departMin)) : null,
    lastReturnMin: views.length ? Math.max(...views.map((v) => v.returnMin)) : null,
    costOmr: r2(planned.reduce((a, v) => a + (v.costOmr ?? 0), 0)),
    km: r2(planned.reduce((a, v) => a + v.km, 0)),
  };
}

function solvedDayView(frozen: readonly EditLoad[], loads: readonly PlannedLoad[], names: ReadonlyMap<string, string>, stopsById: ReadonlyMap<string, DispatchStop>, moved: ReadonlySet<string>, lateAllowed: ReadonlySet<string> = new Set()): EditTruckDayView {
  const kept = storedDayView(frozen, new Set()).loads;
  const fresh: EditLoadView[] = loads.map((l) => ({
    loadNo: l.load_no,
    status: 'PLANNED',
    kept: false,
    departMin: l.depart_min,
    returnMin: l.return_min,
    km: l.distance_km,
    cases: l.cases,
    palletUnits: l.pallet_units ?? null,
    roomUnits: l.pallet_room_units ?? null,
    costOmr: l.total_cost,
    breakStartMin: l.driver_break?.start_min ?? null,
    stops: l.stops.map((s) => {
      const st = stopsById.get(s.stop_id);
      const allowed = s.hard_window_ok === false && lateAllowed.has(s.stop_id);
      return {
        sequence: s.sequence,
        label: names.get(s.stop_id) ?? s.stop_id,
        cases: s.cases,
        etaMin: s.arrival_min,
        startMin: s.service_start_min,
        window: st ? windowText(st.hard_start_min, st.hard_end_min) : null,
        hardOk: s.hard_window_ok,
        prefOk: s.pref_window_ok,
        moved: moved.has(s.stop_id),
        ...(allowed ? { allowed: true } : {}),
      };
    }),
  }));
  const all = [...kept, ...fresh].sort((a, b) => a.loadNo - b.loadNo);
  return {
    loads: all,
    firstDepartMin: all.length ? Math.min(...all.map((v) => v.departMin)) : null,
    lastReturnMin: all.length ? Math.max(...all.map((v) => v.returnMin)) : null,
    costOmr: r2(fresh.reduce((a, v) => a + (v.costOmr ?? 0), 0)),
    km: r2(fresh.reduce((a, v) => a + v.km, 0)),
  };
}

const viol = (v: FeasibilityViolation, names: ReadonlyMap<string, string>, codes: ReadonlyMap<string, string>): EditViolation => ({
  code: v.code,
  message: relabel(relabel(v.message, names), codes),
  loadNo: v.load_no ?? null,
  stopLabel: v.stop_id ? (names.get(v.stop_id) ?? null) : null,
  shortBy: v.short_by_min ?? null,
});

const SETTING_LABEL: Record<string, string> = {
  shift_max_min: 'Longest shift (min)',
  overtime_after_min: 'Overtime after (min)',
  reload_min: 'Turnaround between loads (min)',
  loading_min_per_case: 'Loading per case (min)',
  latest_return_min: 'Latest return',
  break_min: 'Driver break (min)',
  break_start_from_min: 'Break starts from',
  break_start_to_min: 'Break starts by',
  max_trips_per_truck: 'Loads per truck a day',
  pallet_fill_pct: 'Pallet fill %',
  single_customer_fill_pct: 'One-customer fill %',
  window_rule: 'Receiving hours rule',
  fuel_price_per_litre: 'Fuel price per litre',
  driver_cost_per_hour: 'Driver cost per hour',
  avg_speed_kmh: 'Average speed (km/h)',
  road_time_factor: 'Road time factor',
  haversine_multiplier: 'Straight-line factor',
};
const CLOCK_SETTINGS = new Set(['latest_return_min', 'break_start_from_min', 'break_start_to_min']);
/** Settings that never change a hand move's times or money (or are the move's own). */
const SETTINGS_SKIPPED = new Set([...VOLATILE_CONFIG, 'osrm_configured', 'change_penalty_per_stop']);

/**
 * What changed since planning on the edited trucks (owner decision: a move re-times them with today's
 * data, and the preview says what changed): each stored stop's planned pin, hours, delivery time,
 * unloading time and priority against today's request; each edited truck's planned capacity, bays and
 * hours against today's; the planner settings the option was made with against today's.
 */
export function dataChangedSince(input: {
  stops: readonly PlanStop[];
  stopOf: ReadonlyMap<string, string>;
  request: DispatchRequest;
  promised: BuiltRequest['promised'];
  trucks: readonly { truckId: string; truckCode: string; loads: readonly EditLoad[] }[];
  plannedConfig: Record<string, unknown> | null;
}): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  const byId = new Map(input.request.stops.map((s) => [s.stop_id, s]));
  for (const p of input.stops) {
    const fresh = byId.get(input.stopOf.get(stopKeyOf(p.loadId, p.sequence)) ?? '');
    const snap = readStopSnapshot(p.rows[0]?.stopSnapshotJson);
    if (!fresh || !snap) continue;
    const texts = stopMasterChanges(snap, {
      name: snap.name,
      address: snap.address,
      lat: fresh.lat,
      lng: fresh.lng,
      hardStartMin: fresh.hard_start_min ?? null,
      hardEndMin: fresh.hard_end_min ?? null,
      prefStartMin: fresh.pref_start_min ?? null,
      prefEndMin: fresh.pref_end_min ?? null,
      promised: input.promised?.[fresh.stop_id] ?? null,
    }).map((c) => c.text.replace(/after planning/, 'since planning'));
    if (snap.serviceMin !== null && fresh.service_min !== undefined && snap.serviceMin !== fresh.service_min) texts.push(`Unloading time now ${fresh.service_min} min (planned with ${snap.serviceMin} min)`);
    if (snap.priority !== null && fresh.priority !== undefined && snap.priority !== fresh.priority) texts.push(`Priority now P${fresh.priority} (planned with P${snap.priority})`);
    for (const text of texts) out.push({ label: p.label, text: `${text}: re-timed with today's data.` });
  }
  const trucks = new Map(input.request.trucks.map((t) => [t.id, t]));
  for (const t of input.trucks) {
    const live = trucks.get(t.truckId);
    const planned = t.loads.find((l) => l.status === 'PLANNED');
    const snap = planned ? readTruckSnapshot(planned.truckSnapshotJson) : null;
    if (!live || !snap) continue;
    const texts = truckMasterChanges(snap, { capacityCases: live.capacity_cases, capacityWeightKg: live.capacity_kg ?? 0, bays: live.bays ?? null }).map((c) => c.text.replace(/after planning/, 'since planning'));
    if ((snap.availableFromMin ?? null) !== (live.available_from_min ?? null) || (snap.availableToMin ?? null) !== (live.available_to_min ?? null)) {
      texts.push(`Truck hours now ${windowText(live.available_from_min, live.available_to_min)} (planned with ${windowText(snap.availableFromMin, snap.availableToMin)})`);
    }
    for (const text of texts) out.push({ label: t.truckCode, text: `${text}.` });
  }
  if (input.plannedConfig) {
    const now = input.request.config as unknown as Record<string, unknown>;
    const fmt = (k: string, v: unknown) => (v === null || v === undefined ? 'none' : CLOCK_SETTINGS.has(k) && typeof v === 'number' ? fmtHhmm(v) : typeof v === 'object' ? JSON.stringify(v) : String(v));
    for (const k of [...new Set([...Object.keys(input.plannedConfig), ...Object.keys(now)])].sort()) {
      if (SETTINGS_SKIPPED.has(k)) continue;
      const a = input.plannedConfig[k];
      const b = now[k];
      if (JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null))) continue;
      out.push({ label: 'Settings', text: `${SETTING_LABEL[k] ?? k} now ${fmt(k, b)} (planned with ${fmt(k, a)}).` });
    }
  }
  return out;
}

/** A product whose cases per pallet was corrected under Products since the plan was made. */
export interface PalletFactorChange {
  code: string;
  name: string;
  planned: number;
  now: number;
}

/**
 * The cases per pallet corrected since planning on the rows a change re-times (release review F1). A save
 * re-creates the edited trucks' PLANNED loads from the solver's re-timing, which used TODAY's factor, but
 * the plan screen, the sheets and the day overview read a row with the factor it was planned with (a split
 * part's own cut factor, else the option's `inputs.palletFactors`): the manifest, the "Changed after
 * planning" note and RE-PLAN would then all be wrong for that load. So such a change is refused (re-plan
 * first). A line counts when it has cases on the row, a factor it was planned with and a different usable
 * factor now; a product with no factor now is PALLET_FACTOR_REQUIRED's, one with no planned factor reads
 * with today's anyway. Pure; one entry per product code, by code.
 */
export function palletFactorsChangedSince(input: {
  rows: readonly { orderId: string; portionLinesJson: unknown }[];
  lines: readonly { id: string; orderId: string; cases: number; product: { code: string; name: string; casesPerPallet: number | null } }[];
  plannedFactors: Readonly<Record<string, number>>;
}): PalletFactorChange[] {
  const byId = new Map(input.lines.map((l) => [l.id, l]));
  const ofOrder = new Map<string, { lineId: string; cases: number }[]>();
  for (const l of input.lines) ofOrder.set(l.orderId, [...(ofOrder.get(l.orderId) ?? []), { lineId: l.id, cases: l.cases }]);
  const out = new Map<string, PalletFactorChange>();
  for (const row of input.rows) {
    const cut = readPortionPalletFactors(row.portionLinesJson);
    for (const x of readPortionLines(row.portionLinesJson) ?? ofOrder.get(row.orderId) ?? []) {
      if (!(x.cases > 0)) continue;
      const l = byId.get(x.lineId);
      if (!l) continue;
      const now = validPalletFactor(l.product.casesPerPallet);
      const planned = cut.get(x.lineId) ?? validPalletFactor(input.plannedFactors[l.product.code]);
      if (now === null || planned === null || now === planned || out.has(l.product.code)) continue;
      out.set(l.product.code, { code: l.product.code, name: l.product.name, planned, now });
    }
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** The PALLET_FACTOR_CHANGED refusal's words: the products (at most 5 named) and what to do. */
export function palletFactorChangedText(changes: readonly PalletFactorChange[]): string {
  const named = changes.slice(0, 5).map((c) => `${c.code}${c.name ? ` (${c.name})` : ''} is now ${c.now} (planned with ${c.planned})`);
  const more = changes.length > 5 ? ` and ${changes.length - 5} more` : '';
  return `The cases per pallet changed under Products since this plan: ${named.join('; ')}${more}. This change re-times loads that carry ${changes.length === 1 ? 'it' : 'them'}: RE-PLAN the day first, so every load uses the new figure.`;
}

// ---------------------------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------------------------

/** Statuses of a version whose loads can change (plan-service LOAD_CHANGE_FROM). */
export const EDIT_FROM = ['DRAFT', 'READY', 'FAILED', 'DISPATCHED'] as const;

/** Everything a check read and decided, for its save. */
export interface EditCheck {
  preview: PlanEditPreview;
  run: RunPlan;
  built: BuiltRequest;
  details: ScenarioDetails;
  loads: EditLoad[];
  unserved: EditUnserved[];
  answer: RetimeResponse;
  /** The edited trucks' new loads, a best place resolved. */
  edit: TruckDayEdit;
  /** The change list with a best place resolved (what a save sends). */
  ops: PlanEditOp[];
  /** A change of one v1 operation, resolved (the audit's `move`); null otherwise. */
  move: PlanEditMove | null;
  /** That operation's stop. */
  movedStop: string | null;
  stopOf: Map<string, string>;
  refMap: Map<string, string>;
  basis: string;
  /** The stops taken off the plan, with their stored rows; the orders put on a truck. */
  removedStops: { stopId: string; rows: EditRow[] }[];
  removedRows: EditRow[];
  placedOrderIds: string[];
  /** The trucks timed without their driver break at the user's choice (edited trucks only). */
  skipBreak: string[];
  /** The allowances by hand the edited trucks' loads carry now. */
  stored: StoredAllowance[];
  /** What a save with overrides allows (null when nothing can be allowed). */
  overrides: { needed: JudgedIssue[]; remaining: JudgedIssue[]; carried: [string, string][] } | null;
}

export const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => new PlanError(message, status, { code, ...extra });

export function loadText(l: Pick<EditLoad, 'truckCode' | 'loadNo'>): string {
  return `${l.truckCode} L${l.loadNo}`;
}

function frozenRefusal(l: EditLoad, onto: boolean): PlanError {
  return l.status === 'LOCKED'
    ? refuse(409, 'LOAD_FROZEN', `${loadText(l)} is locked: unlock it first to ${onto ? 'put stops on it' : 'move its stops'}.`, { loadId: l.id })
    : refuse(409, 'LOAD_FROZEN', `${loadText(l)} is ${l.status === 'LOADING' ? 'loading' : l.status === 'DISPATCHED' ? 'out for delivery' : 'completed'}: its stops cannot be changed.`, { loadId: l.id });
}

/** Every load an op names, and how (design 3.2 step 1): a stop's load, a target, a load moved or swapped. */
function namedLoadsOf(ops: readonly PlanEditOp[]): { id: string; onto: boolean; truckId?: string; sequence?: number }[] {
  const out: { id: string; onto: boolean; truckId?: string; sequence?: number }[] = [];
  const ref = (r: EditStopRef) => {
    if ('loadId' in r) out.push({ id: r.loadId, onto: false, sequence: r.sequence });
  };
  for (const op of ops) {
    const n = normalizeOp(op);
    if (n.kind === 'MOVE_STOPS') {
      n.stops.forEach(ref);
      (n.to.order ?? []).forEach(ref);
      if (n.to.loadId) out.push({ id: n.to.loadId, onto: true, truckId: n.to.truckId });
      if (typeof n.to.before === 'string' && n.to.before !== 'BEST') out.push({ id: n.to.before, onto: true, truckId: n.to.truckId });
    } else if (n.kind === 'REMOVE_STOPS') {
      n.stops.forEach(ref);
    } else if (n.kind === 'MOVE_LOAD') {
      out.push({ id: n.loadId, onto: false });
      if (typeof n.to.before === 'string' && n.to.before !== 'BEST') out.push({ id: n.to.before, onto: true, truckId: n.to.truckId });
    } else {
      out.push({ id: n.a, onto: false }, { id: n.b, onto: false });
    }
  }
  return out;
}

const targetTruckOf = (op: PlanEditOp): string | null => (op.kind === 'REMOVE' || op.kind === 'REMOVE_STOPS' || op.kind === 'SWAP_LOADS' ? null : op.to.truckId);
const unservedRefsOf = (ops: readonly PlanEditOp[]): string[] => {
  const ids: string[] = [];
  for (const op of ops) {
    const n = normalizeOp(op);
    if (n.kind !== 'MOVE_STOPS') continue;
    for (const r of [...n.stops, ...(n.to.order ?? [])]) if ('orderId' in r && !ids.includes(r.orderId)) ids.push(r.orderId);
  }
  return ids;
};

/**
 * Check a change list (writes nothing; design 3.3). Throws PlanError for a change that cannot be checked (the
 * version, a frozen load, a stop whose orders changed, the solver unavailable); a change that breaks a rule is
 * answered with `preview.ok` false, its issues, and what could be allowed by hand (`preview.overrides`).
 * `move` is the v1 body (one change).
 */
export async function checkPlanEdit(
  tenantId: string,
  runId: string,
  input: { ops?: PlanEditOp[]; move?: PlanEditMove; skipBreak?: string[]; expect?: ExpectedDay; now?: Date; mode?: PlanEditMode; canOverride?: boolean; overridesOn?: boolean },
): Promise<EditCheck> {
  const mode = input.mode ?? planEditMode();
  const overridesOn = input.overridesOn ?? planEditOverridesOn();
  const asked: PlanEditOp[] = input.ops ?? (input.move ? [input.move] : []);
  if (!asked.length || asked.length > MAX_EDIT_OPS) throw refuse(422, 'BAD_REQUEST', `Send one to ${MAX_EDIT_OPS} changes.`);
  const lastAsked = asked[asked.length - 1]!;
  const v1Single = asked.length === 1 && isV1Op(lastAsked) && !(lastAsked.kind !== 'REMOVE' && lastAsked.to.order);
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId } });
  if (!run) throw refuse(404, 'NOT_FOUND', 'Plan not found.');
  const mismatch = dayMismatch(run, input.expect);
  if (mismatch) throw refuse(mismatch.status, 'DAY_MISMATCH', String(mismatch.body.error));
  if (isSupersededRun(run)) throw refuse(409, 'SUPERSEDED', `A newer plan version is in use (this is version ${run.version}). Reload.`);
  if (run.status === 'OPTIMIZING' || (await prisma.runJob.count({ where: { runId, status: { in: ['QUEUED', 'RUNNING'] } } }))) {
    throw refuse(409, 'OPTIMIZING', 'An optimization is running for this plan. Wait for it to finish.');
  }
  if (!(EDIT_FROM as readonly string[]).includes(run.status)) throw refuse(409, 'PLAN_STATUS', `This plan version is ${run.status} and cannot be changed by hand.`);
  if (!run.chosenScenarioId) throw refuse(409, 'NOT_APPLIED', 'This plan version has no plan applied yet: OPTIMIZE the day first.');
  const option = await prisma.scenarioResult.findFirst({ where: { id: run.chosenScenarioId, runId }, include: { unservedOrders: { select: { orderId: true, reasonCode: true, portionLinesJson: true } } } });
  const details: unknown = option?.detailsJson;
  if (!option || !isDispatchDetails(details) || (await prisma.routeAssignment.count({ where: { runId, loadId: null } }))) {
    throw refuse(409, 'LEGACY_PLAN', 'This plan was made by the previous optimizer and is kept exactly as it was: its stops cannot be moved.');
  }
  if (isoOf(run.runDate) < (await companyToday(tenantId))) throw refuse(409, 'DAY_OVER', 'This day is over: its plan cannot be changed any more.');

  const built = await buildDispatchRequest(tenantId, runId, ['RECOMMENDED'], { now: input.now });
  const loads = await readEditLoads(prisma, tenantId, runId);
  const unserved: EditUnserved[] = option.unservedOrders.map((u) => ({ orderId: u.orderId, reasonCode: u.reasonCode, portionLinesJson: u.portionLinesJson }));
  const loadById = new Map(loads.map((l) => [l.id, l]));
  const truckCodes = new Map(built.request.trucks.map((t) => [t.id, t.code ?? t.id]));
  for (const l of loads) if (!truckCodes.has(l.truckId)) truckCodes.set(l.truckId, l.truckCode);
  const inRequest = new Set(built.request.trucks.map((t) => t.id));
  const day = fmtDayMonth(isoOf(run.runDate));

  // 1. Every load an op names: of this version, PLANNED, of the target truck, the stop on it.
  const named = namedLoadsOf(asked);
  for (const x of named) {
    const l = loadById.get(x.id);
    if (!l || (x.truckId !== undefined && l.truckId !== x.truckId)) throw refuse(422, 'UNKNOWN_LOAD', 'Unknown load: reload the plan.');
  }
  for (const x of named.filter((n) => !n.onto)) if (loadById.get(x.id)!.status !== 'PLANNED') throw frozenRefusal(loadById.get(x.id)!, false);
  for (const x of named) {
    const l = loadById.get(x.id)!;
    if (x.sequence !== undefined && !l.rows.some((r) => r.sequenceInTruck === x.sequence)) throw refuse(422, 'UNKNOWN_STOP', 'Unknown stop: reload the plan.');
  }
  // 2. The trucks: a truck taken out of service (or no longer of this day) since planning has nothing to time.
  for (const x of named.filter((n) => !n.onto)) {
    const l = loadById.get(x.id)!;
    if (!inRequest.has(l.truckId)) throw refuse(409, 'TRUCK_NOT_AVAILABLE', `${l.truckCode} is not available on ${day} any more: RE-PLAN the day to move its stops.`);
  }
  for (const t of [...new Set(asked.map(targetTruckOf).filter((x): x is string => !!x))]) {
    if (inRequest.has(t)) continue;
    const code = (await prisma.truck.findFirst({ where: { id: t, tenantId }, select: { code: true } }))?.code;
    if (!code) throw refuse(422, 'UNKNOWN_TRUCK', 'Unknown truck: reload the plan.');
    throw refuse(409, 'TRUCK_NOT_AVAILABLE', `${code} is not available on ${day}.`);
  }
  for (const x of named.filter((n) => n.onto)) if (loadById.get(x.id)!.status !== 'PLANNED') throw frozenRefusal(loadById.get(x.id)!, true);
  const candidates = [...new Set([...named.map((x) => loadById.get(x.id)!.truckId), ...asked.map(targetTruckOf).filter((x): x is string => !!x)])];
  const candidateSet = new Set(candidates);
  const plannedOfCandidates = loads.filter((l) => candidateSet.has(l.truckId) && l.status === 'PLANNED');
  const planStops = plannedOfCandidates.flatMap(planStopsOf);
  const mapped = mapStops({ stops: planStops, request: built.request, portions: built.scope.portions, parentLoads: details.loads, parentPortions: details.scope.portions });
  if (!mapped.ok) {
    throw refuse(
      409,
      'STOP_CHANGED',
      `Orders of ${mapped.label} on ${mapped.truckCode} L${mapped.loadNo} changed since this plan (a new, cancelled or postponed order, or the customer is split differently today), and that truck is timed again for this change. RE-PLAN the day first.`,
    );
  }
  const { stopOf, refMap } = mapped;
  const names = new Map<string, string>();
  const refOfStop = new Map<string, EditStopRef>();
  for (const p of planStops) {
    const id = stopOf.get(stopKeyOf(p.loadId, p.sequence))!;
    names.set(id, p.label);
    refOfStop.set(id, { loadId: p.loadId, sequence: p.sequence });
  }

  // 3. Unserved customer visits: all their orders are whole unserved orders of the option (Put on a truck's rules).
  const orderRefs = unservedRefsOf(asked);
  const unservedStopOf = new Map<string, string>();
  const placeable = new Map<string, string[]>();
  if (orderRefs.length) {
    const customers = new Map(
      (await prisma.order.findMany({ where: { id: { in: orderRefs }, tenantId }, select: { id: true, customer: { select: { code: true, branchCode: true, name: true } } } })).map((o) => [o.id, customerLabel(o.customer)]),
    );
    const wholeUnserved = new Set(unserved.filter((u) => !readPortionLines(u.portionLinesJson)).map((u) => u.orderId));
    for (const orderId of orderRefs) {
      const label = customers.get(orderId) ?? 'This order';
      const row = unserved.find((u) => u.orderId === orderId);
      if (!row) throw refuse(409, 'NOT_UNSERVED', `${label} is not on the unserved list of this plan any more. Reload the plan.`);
      if (readPortionLines(row.portionLinesJson)) throw refuse(409, 'PART_ON_TRUCK', `Part of ${label} is already on a truck: only a whole unserved customer can be put on a truck. RE-PLAN the day instead.`);
      const stop = built.request.stops.find((s) => s.order_ids.includes(orderId));
      if (!stop && built.request.stops.some((s) => s.order_ids.some((r) => orderIdOf(r) === orderId))) {
        // Today's request cuts the customer into parts (more than one truck carries): one part is never put on alone.
        throw refuse(409, 'SPLIT_TODAY', `${label} is delivered in parts today (more than one truckload): it cannot be put on one load by hand. RE-PLAN the day to plan it.`);
      }
      if (!stop) {
        throw refuse(
          409,
          'NOT_PLANNABLE',
          `${label} cannot be planned now (cancelled, moved to another day, no usable location, a deactivated customer, or heavier than any truck). Fix it, then RE-PLAN the day.`,
        );
      }
      if (!stop.order_ids.every((r) => r === orderIdOf(r) && wholeUnserved.has(r))) {
        throw refuse(409, 'STOP_CHANGED', `${label} has orders that are not on the unserved list (a new order came in, or part of it is on a truck). RE-PLAN the day to plan them together.`);
      }
      unservedStopOf.set(orderId, stop.stop_id);
      placeable.set(stop.stop_id, [...stop.order_ids]);
      names.set(stop.stop_id, label);
      refOfStop.set(stop.stop_id, { orderId: [...stop.order_ids].sort()[0]! });
    }
  }
  const stopOfRef = (ref: EditStopRef): string | null => ('orderId' in ref ? (unservedStopOf.get(ref.orderId) ?? null) : (stopOf.get(stopKeyOf(ref.loadId, ref.sequence)) ?? null));
  const planned = new Map<string, PlannedDayLoad[]>();
  for (const t of candidates) {
    planned.set(
      t,
      plannedOfCandidates.filter((l) => l.truckId === t).map((l) => ({ loadId: l.id, stops: planStopsOf(l).map((p) => stopOf.get(stopKeyOf(p.loadId, p.sequence))!) })),
    );
  }
  const applyCtx: ApplyContext = { stopOf: stopOfRef, loadText: (id) => (loadById.get(id) ? loadText(loadById.get(id)!) : 'The load') };

  // 4. The change list on the working layout.
  const first = applyOps(asked, planned, applyCtx);
  if (!first.ok) throw refuse(first.status, first.code, first.message);
  const askedEdit = first.edit;
  let edit = first.edit;
  const edited = edit.edited;
  const editedSet = new Set(edited);
  const plannedOfEdited = loads.filter((l) => editedSet.has(l.truckId) && l.status === 'PLANNED');

  // 5. Pallets: only the products of the orders the change re-times (a late order elsewhere never blocks a move).
  const stopById = new Map(built.request.stops.map((s) => [s.stop_id, s]));
  const bestIds = edit.best ? [edit.best.stop_id, ...(edit.best.more_stop_ids ?? [])] : [];
  const timedStops = new Set([...[...edit.before.values(), ...edit.after.values()].flat(2), ...bestIds]);
  const timedOrders = new Set([...timedStops].flatMap((id) => (stopById.get(id)?.order_ids ?? []).map(orderIdOf)));
  const pallets = palletFactorGate({ missingPalletFactors: groupMissingPalletFactors((built.missingPalletLines ?? []).filter((l) => timedOrders.has(l.orderId))) }, 'check the move');
  if (pallets) {
    const { error, ...rest } = pallets.body;
    throw new PlanError(String(error), pallets.status, rest);
  }
  const placedAsked = edit.placedStops.flatMap((s) => placeable.get(s) ?? []);
  // A cases per pallet corrected since planning on those orders (release review F1): their loads would be
  // stored with today's figure and read with the planned one. Only on a day planned by pallets.
  if (built.palletFactors) {
    const rows = [...plannedOfEdited.flatMap((l) => l.rows), ...placedAsked.map((orderId) => ({ orderId, portionLinesJson: null }))];
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const lines = orderIds.length
      ? await prisma.orderLine.findMany({
          where: { orderId: { in: orderIds }, order: { tenantId } },
          select: { id: true, orderId: true, cases: true, product: { select: { code: true, name: true, casesPerPallet: true } } },
        })
      : [];
    const changed = palletFactorsChangedSince({ rows, lines, plannedFactors: readPlanInputs(details.inputs)?.palletFactors ?? {} });
    if (changed.length) throw refuse(409, 'PALLET_FACTOR_CHANGED', palletFactorChangedText(changed), { palletFactorChanges: changed });
  }

  // 6. The stops re-timed.
  const count = retimeStopCount(edit);
  if (count > RETIME_MAX_STOPS) {
    throw refuse(409, 'TOO_MANY_STOPS', `This change re-times ${count} stops on ${edited.map((t) => truckCodes.get(t) ?? t).join(', ')}; a check takes at most ${RETIME_MAX_STOPS}. RE-PLAN the day instead.`);
  }

  // 7. The allowances by hand the edited trucks carry now, and the times of `before` with them.
  const stored = storedAllowancesOf(loads, editedSet);
  const skipBreak = [...new Set(input.skipBreak ?? [])].filter((t) => editedSet.has(t));
  const beforeRelax = overridesOn ? beforeRelaxOf(stored, planStops, stopOf) : null;

  // 8-9. The solver.
  const body: RetimeRequest = {
    request: built.request,
    truck_days: edited.map((t) => ({ truck_id: t, loads: edit.after.get(t)! })),
    before: edited.map((t) => ({ truck_id: t, loads: edit.before.get(t)! })),
    ...(edit.best ? { best: edit.best } : {}),
    ...(overridesOn ? { relax: { late: true, capacity_factor: 1 + OVERRIDE_CAPACITY_MAX_PCT / 100, no_break: true, seed_no_break: skipBreak } } : {}),
    ...(beforeRelax ? { before_relax: beforeRelax } : {}),
  };
  const reply = await callRetimeTruckDays(body);
  if (reply.kind === 'outdated') throw refuse(503, 'SOLVER_OUTDATED', EDIT_ERROR_TEXT.SOLVER_OUTDATED);
  if (reply.kind === 'not_configured') throw refuse(503, 'SOLVER_NOT_CONFIGURED', 'The route optimizer is not configured (SOLVER_URL / SOLVER_TOKEN): moves cannot be checked. Nothing was changed.');
  if (reply.kind === 'failed' && reply.status === 422 && reply.detail && /^At most (\d+) stops/.test(reply.detail)) {
    const n = Number(/^At most (\d+) stops/.exec(reply.detail)![1]);
    throw refuse(409, 'TOO_MANY_STOPS', `This change re-times ${count} stops on ${edited.map((t) => truckCodes.get(t) ?? t).join(', ')}; the route optimizer checks at most ${n}. RE-PLAN the day instead, or change fewer stops at once.`);
  }
  if (reply.kind !== 'answer') {
    if (reply.kind === 'failed') console.error('plan edit: /retime-truck-days refused the check', { runId, status: reply.status, detail: reply.detail });
    throw refuse(503, reply.kind === 'busy' ? 'SOLVER_BUSY' : 'SOLVER_FAILED', EDIT_ERROR_TEXT.SOLVER_FAILED);
  }
  const answer = reply.body;
  // The version check first (design 4.9): an older solver ignores fields it does not know.
  const v2 = (answer.retime_version ?? 0) >= 2;
  const v2Placement = !!edit.best && (!!edit.best.more_stop_ids?.length || !!edit.best.keep_order || typeof edit.best.new_load_at === 'number');
  if (v2Placement && !v2) throw refuse(503, 'SOLVER_OUTDATED', EDIT_ERROR_TEXT.SOLVER_OUTDATED);
  const relaxed = v2 ? (answer.relaxed ?? null) : null;

  // 10. A best place found: the change list with that place (what Save sends), checked to give the same loads.
  let ops: PlanEditOp[] = asked;
  if (edit.best) {
    const bt = edit.best.truck_id;
    const bestStops = [edit.best.stop_id, ...(edit.best.more_stop_ids ?? [])];
    const fromRelaxed = !!relaxed?.ok;
    const option0 = answer.options?.[0] && answer.options[0].truck_id === bt ? answer.options[0] : null;
    const S = fromRelaxed ? relaxed!.loads.find((d) => d.truck_id === bt)?.loads : option0 ? option0.loads : v2 ? answer.loads?.find((d) => d.truck_id === bt)?.loads : undefined;
    if (S) {
      const place = resolveLayout(edit.after.get(bt) ?? [], S, bestStops);
      const rewritten = place ? rewriteBest(lastAsked, place, { truckId: bt, wIds: edit.afterLoadIds.get(bt) ?? [], S, bestStops, refOf: (id) => refOfStop.get(id)! }) : 'MISMATCH';
      if (rewritten === 'NO_EXPLICIT_PLACE') throw refuse(409, 'NO_EXPLICIT_PLACE', 'Choose where the new load goes: its best place is before a load made by an earlier step of this change.');
      if (rewritten === 'MISMATCH') {
        console.error('plan edit: the best place does not resolve to its loads', { runId, truckId: bt, loads: S });
        throw refuse(503, 'SOLVER_FAILED', EDIT_ERROR_TEXT.SOLVER_FAILED);
      }
      const resolvedOps = [...asked.slice(0, -1), rewritten];
      const again = applyOps(resolvedOps, planned, applyCtx);
      // The strict fallback (no place kept every rule) where the stops already are: not "already at its best
      // place" - the change stays as asked (not draftable) and the preview says what breaks.
      const fallbackOnly = !fromRelaxed && !option0;
      const keepAsked = !again.ok && again.code === 'NO_CHANGE' && fallbackOnly;
      if (!keepAsked && !again.ok && again.code === 'NO_CHANGE') {
        if (v1Single && lastAsked.kind === 'MOVE') {
          const src = loadById.get(lastAsked.from.loadId)!;
          throw refuse(
            409,
            'NO_CHANGE',
            `${names.get(edit.best.stop_id) ?? 'This stop'} is already at its best place (${loadText(src)}, stop ${lastAsked.from.sequence}): nothing changes. Choose a position or another load to move it.`,
          );
        }
        throw refuse(409, 'NO_CHANGE', 'Nothing changes: the best place found is where it is now. Choose a place to move it.');
      }
      const expected = (t: string) => (t === bt ? S : fromRelaxed ? (relaxed!.loads.find((d) => d.truck_id === t)?.loads ?? edit.after.get(t)) : edit.after.get(t));
      if (!keepAsked && (!again.ok || again.edit.best || edited.some((t) => JSON.stringify(again.edit.after.get(t)) !== JSON.stringify(expected(t))))) {
        console.error('plan edit: the best place does not resolve to its loads', { runId, truckId: bt, loads: S });
        throw refuse(503, 'SOLVER_FAILED', EDIT_ERROR_TEXT.SOLVER_FAILED);
      }
      if (!keepAsked && again.ok) {
        ops = resolvedOps;
        edit = again.edit;
      }
    }
  }

  const placedOrderIds = edit.placedStops.flatMap((s) => placeable.get(s) ?? []);
  const stopIds = new Set<string>([...edit.movedStops, ...[...edit.before.values(), ...edit.after.values()].flat(2), ...(edit.best ? [edit.best.stop_id, ...(edit.best.more_stop_ids ?? [])] : [])]);
  const basis = editBasis({ request: built.request, edited, stopIds, loads, chosenScenarioId: run.chosenScenarioId, unserved: unserved.filter((u) => placedOrderIds.includes(u.orderId)) });
  const builtAt = built.builtAt ?? new Date().toISOString();
  const truckDays = edited.map((t) => ({ truck_id: t, loads: edit.after.get(t)! }));
  const hash = previewHash({ basis, builtAt, ops, truckDays, answer });
  const planStopById = new Map(planStops.map((p) => [stopOf.get(stopKeyOf(p.loadId, p.sequence))!, p]));
  const removedStops = edit.removedStops.map((id) => ({ stopId: id, rows: planStopById.get(id)?.rows ?? [] }));

  // 11. The issues, and what can be allowed by hand.
  const orderKg = await orderKgOf(tenantId, [...stopIds].flatMap((id) => (stopById.get(id)?.order_ids ?? []).map(orderIdOf)));
  const frozenCount = (t: string) => built.request.trucks.find((x) => x.id === t)?.frozen_trips?.length ?? 0;
  const layoutOf = (days: readonly { truck_id: string; loads: string[][] }[] | undefined) => (truckId: string, loadNo: number) =>
    (days?.find((d) => d.truck_id === truckId)?.loads ?? edit.after.get(truckId) ?? [])[loadNo - frozenCount(truckId) - 1] ?? null;
  const judgeCtx: JudgeContext = { request: built.request, scope: built.scope, orderKg, loadStops: layoutOf(v2 ? answer.loads : undefined), names, truckCodes, overridesOn, relaxedPresent: !!relaxed };
  const issues: JudgedIssue[] = answer.ok
    ? []
    : relaxed
      ? dedupeIssues(relaxed.strict.flatMap((t) => t.violations).map((v) => judgeIssue(v, { ...judgeCtx, loadStops: layoutOf(relaxed.loads) })))
      : dedupeIssues(answer.trucks.flatMap((t) => t.violations).map((v) => judgeIssue(v, judgeCtx)));
  const roadsDown = details.distance_is_estimated === false && answer.distance_quality === 'ESTIMATED';
  const movedKeys = new Set([...edit.movedStops].map((id) => planStopById.get(id)).filter((p): p is PlanStop => !!p).map((p) => stopKeyOf(p.loadId, p.sequence)));
  let ov: EditCheck['overrides'] = null;
  let overrides: OverridePreview | null = null;
  if (overridesOn && !answer.ok && v2) {
    if (relaxed) {
      const rctx = { ...judgeCtx, loadStops: layoutOf(relaxed.loads) };
      const needed = carryIssues(dedupeIssues(relaxed.trucks.flatMap((t) => t.allowed ?? []).map((v) => judgeIssue(v, rctx))), stored, built.request.config);
      const remaining = dedupeIssues(relaxed.trucks.flatMap((t) => t.violations).map((v) => judgeIssue(v, rctx)));
      const carried = needed.filter((n) => n.carried && n.id).map((n): [string, string] => [n.id!, n.carried!.fromId]);
      const ok = relaxed.ok && remaining.length === 0 && needed.length > 0;
      const notAllowable = needed.find((n) => !n.overridable);
      const needsRole = needed.some((n) => !n.carried);
      const canSave = ok && mode === 'ON' && !roadsDown && !notAllowable && (!!input.canOverride || !needsRole);
      const saveNote = !ok
        ? relaxed.ok
          ? 'Nothing here can be allowed by hand.'
          : 'Even when allowed by hand, this change breaks the rules below.'
        : notAllowable
          ? notAllowable.whyNot
          : roadsDown
            ? EDIT_ERROR_TEXT.ROADS_DOWN
            : mode !== 'ON'
              ? EDIT_ERROR_TEXT.CHECK_ONLY
              : !input.canOverride && needsRole
                ? 'Only a supervisor or company admin can allow rules by hand. Ask one to open this change.'
                : null;
      const lateAllowed = new Set(relaxed.relaxations.late_stop_ids ?? []);
      const neededTrucks = new Set(needed.filter((n) => n.kind === 'LATE').map((n) => n.truckId));
      const breakDue = new Set((relaxed.scenario?.truck_days ?? []).filter((d) => d.break_status === 'PLANNED').map((d) => d.truck_id));
      overrides = {
        ok,
        canSave,
        saveNote,
        needed: needed.map(issueView),
        remaining: remaining.map(issueView),
        previewHash: ok ? overridesHash({ basis, builtAt, ops, skipBreak, carried, needed: needed.map(issueView), relaxed, matrix: answer.distance_quality }) : '',
        trucks: truckPreviews({ edited, loads, outs: relaxed.trucks, scenario: relaxed.scenario, names, truckCodes, stopsById: stopById, movedKeys, moved: edit.movedStops, lateAllowed }),
        warnings: [...new Set([...(relaxed.warnings ?? []), ...(typeof relaxed.delta_money_omr === 'number' && relaxed.delta_money_omr > 0.0005 ? [`Day cost of these trucks ${signedOmr(relaxed.delta_money_omr)} OMR.`] : [])])],
        deltaCostOmr: relaxed.delta_money_omr ?? null,
        deltaKm: relaxed.delta_km ?? null,
        skipBreak,
        breakAlternative: [
          ...(relaxed.break_alternative ?? []).map((t) => ({ truckId: t, truckCode: truckCodes.get(t) ?? t, only: true })),
          ...edited.filter((t) => neededTrucks.has(t) && breakDue.has(t) && !skipBreak.includes(t) && !(relaxed.break_alternative ?? []).includes(t)).map((t) => ({ truckId: t, truckCode: truckCodes.get(t) ?? t, only: false })),
        ],
      };
      ov = { needed, remaining, carried };
    } else if (issues.some((i) => i.overridable)) {
      const outOfTime = (answer.warnings ?? []).some((w) => /Out of time while checking what can be allowed by hand/i.test(w));
      overrides = {
        ok: false,
        canSave: false,
        saveNote: outOfTime ? EDIT_ERROR_TEXT.OVERRIDES_OUT_OF_TIME : 'Even when allowed by hand, this change breaks the rules that cannot be allowed (above).',
        needed: [],
        remaining: issues.filter((i) => !i.overridable).map(issueView),
        previewHash: '',
        trucks: [],
        warnings: [],
        deltaCostOmr: null,
        deltaKm: null,
        skipBreak,
        breakAlternative: [],
      };
    }
  }

  // 12. The preview.
  const hired = new Set(
    (await prisma.truck.findMany({ where: { tenantId, id: { in: edited } }, select: { id: true, onlyOnDate: true } })).filter((t) => t.onlyOnDate && isoOf(t.onlyOnDate) === isoOf(run.runDate)).map((t) => t.id),
  );
  const extraWarnings = editWarnings({ edit, stops: stopById, names, truckCodes, frozenCount, hiredForDay: hired });
  const move = v1Single ? (ops[0] as PlanEditMove) : null;
  const movedStop = v1Single ? (stopOfRef(isV1Op(lastAsked) && lastAsked.kind === 'PLACE' ? { orderId: lastAsked.orderId } : (lastAsked as { from: EditSource }).from) ?? null) : null;
  const loadOptions = !v1Single && askedEdit.best ? loadOptionsOf({ asked: lastAsked, prefix: asked.slice(0, -1), askedEdit, answer, refOf: (id) => refOfStop.get(id)!, loadById, truckCodes }) : [];
  const preview = previewOf({
    mode,
    run,
    built,
    details,
    loads,
    edited,
    edit,
    ops,
    move: move ?? undefined,
    asked: v1Single ? (lastAsked as PlanEditMove) : undefined,
    askedEdit,
    movedStop: movedStop ?? undefined,
    names,
    truckCodes,
    answer,
    planStops,
    stopOf,
    hash,
    builtAt,
    issues: issues.map(issueView),
    overrides,
    draftable: !edit.best,
    extraWarnings,
    overridesNeedSolver: overridesOn && !answer.ok && !v2,
    nameOfRef: (ref) => names.get(stopOfRef(ref) ?? '') ?? 'the stop',
    ...(loadOptions.length ? { loadOptions } : {}),
  });
  return {
    preview,
    run,
    built,
    details,
    loads,
    unserved,
    answer,
    edit,
    ops,
    move,
    movedStop,
    stopOf,
    refMap,
    basis,
    removedStops,
    removedRows: removedStops.flatMap((s) => s.rows),
    placedOrderIds,
    skipBreak,
    stored,
    overrides: ov,
  };
}

/** The order kg a capacity issue is judged with (as materializeLoads reads them). */
async function orderKgOf(tenantId: string, orderIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(orderIds)];
  if (!ids.length) return new Map();
  const rows = await prisma.order.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, totalWeightKg: true } });
  return new Map(rows.map((o) => [o.id, o.totalWeightKg]));
}

/**
 * `before_relax` (design 4.7): the relaxations the edited trucks' current loads already carry, so `before` is
 * timed with them (a truck overridden earlier keeps its money and deltas): the stops of a LATE allowance on a
 * PLANNED load (matched by rows), the trucks with a capacity allowance on a PLANNED load, and the trucks with a
 * NO_BREAK allowance on any load of the day (frozen ones included). Null when there is none.
 */
export function beforeRelaxOf(stored: readonly StoredAllowance[], planStops: readonly PlanStop[], stopOf: ReadonlyMap<string, string>): RetimeRelaxations | null {
  const late = new Set<string>();
  const cap = new Set<string>();
  const noBreak = new Set<string>();
  for (const s of stored) {
    const a = s.allowance;
    if (a.kind === 'NO_BREAK') noBreak.add(s.truckId);
    else if (s.status !== 'PLANNED') continue;
    else if (a.kind === 'LATE') {
      const keys = new Set(a.rowKeys);
      for (const p of planStops.filter((x) => x.loadId === s.loadId)) {
        const mine = p.rows.map((r) => rowKey(r.orderId, r.portionLinesJson));
        if (mine.length === keys.size && mine.every((k) => keys.has(k))) {
          const id = stopOf.get(stopKeyOf(p.loadId, p.sequence));
          if (id) late.add(id);
        }
      }
    } else cap.add(s.truckId);
  }
  if (!late.size && !cap.size && !noBreak.size) return null;
  return {
    late_stop_ids: [...late].sort(),
    over_capacity_truck_ids: [...cap].sort(),
    ...(cap.size ? { capacity_factor: 1 + OVERRIDE_CAPACITY_MAX_PCT / 100 } : {}),
    no_break_truck_ids: [...noBreak].sort(),
  };
}

/** The other places a whole load or a new load was found (a best of the list's last op): each a change list to check. */
function loadOptionsOf(x: {
  asked: PlanEditOp;
  prefix: readonly PlanEditOp[];
  askedEdit: TruckDayEdit;
  answer: RetimeResponse;
  refOf: (stopId: string) => EditStopRef;
  loadById: ReadonlyMap<string, EditLoad>;
  truckCodes: ReadonlyMap<string, string>;
}): NonNullable<PlanEditPreview['loadOptions']> {
  const best = x.askedEdit.best!;
  const bestStops = [best.stop_id, ...(best.more_stop_ids ?? [])];
  const out: NonNullable<PlanEditPreview['loadOptions']> = [];
  for (const o of (x.answer.options ?? []).slice(1)) {
    if (o.truck_id !== best.truck_id) continue;
    if (JSON.stringify(o.loads) === JSON.stringify(x.askedEdit.before.get(o.truck_id))) continue;
    const place = resolveLayout(x.askedEdit.after.get(o.truck_id) ?? [], o.loads, bestStops);
    if (!place) continue;
    const op = rewriteBest(x.asked, place, { truckId: o.truck_id, wIds: x.askedEdit.afterLoadIds.get(o.truck_id) ?? [], S: o.loads, bestStops, refOf: x.refOf });
    if (op === 'NO_EXPLICIT_PLACE' || op === 'MISMATCH') continue;
    const others = x.answer.trucks.filter((t) => t.truck_id !== o.truck_id);
    const beforeAll = x.answer.trucks.map((t) => t.before?.money_omr);
    const afterOthers = others.map((t) => t.money_omr);
    const delta = [...beforeAll, ...afterOthers].every((v) => typeof v === 'number')
      ? o.money_omr + afterOthers.reduce<number>((a, v) => a + (v as number), 0) - beforeAll.reduce<number>((a, v) => a + (v as number), 0)
      : null;
    const code = x.truckCodes.get(o.truck_id) ?? o.truck_id;
    const where = place.kind === 'NEW' ? newLoadPlaceText(op, x.loadById, code) : `${code} L${place.j + 1}`;
    out.push({ label: `${where}, back ${fmtHhmm(o.last_return_min)}`, ops: [...x.prefix, op], deltaCostOmr: delta === null ? null : r2(delta), lastReturnMin: o.last_return_min });
  }
  return out;
}

function newLoadPlaceText(op: PlanEditOp, loads: ReadonlyMap<string, EditLoad>, code: string): string {
  const before = op.kind === 'MOVE_LOAD' ? op.to.before : op.kind !== 'REMOVE' && op.kind !== 'REMOVE_STOPS' && op.kind !== 'SWAP_LOADS' ? op.to.before : null;
  if (before === 'BEST') return `${code}, a new load (best place in its day)`;
  return before ? `${code}, a new load before L${loads.get(before)?.loadNo ?? '?'}` : `${code}, a new load after its last load`;
}

/** The target in words: "T08 L1, stop 4", "T08, a new load before L2". */
function targetText(t: EditTarget, loads: ReadonlyMap<string, EditLoad>, code: string): string {
  if (t.loadId) {
    const l = loads.get(t.loadId);
    return `${code} L${l?.loadNo ?? '?'}${t.order ? '' : typeof t.position === 'number' ? `, stop ${t.position + 1}` : ' (best place)'}`;
  }
  if (t.before === 'BEST') return `${code}, a new load (best place in its day)`;
  return t.before ? `${code}, a new load before L${loads.get(t.before)?.loadNo ?? '?'}` : `${code}, a new load after its last load`;
}

/** One op in words ("Swap T03 L2 and T08 L1", "Move 3 stops to T05 L1 (best place)"); a list is joined with "; ". */
export function opTitle(op: PlanEditOp, c: { loads: ReadonlyMap<string, EditLoad>; code: (truckId: string) => string; nameOf: (ref: EditStopRef) => string }): string {
  const from = (s: EditSource) => {
    const l = c.loads.get(s.loadId);
    return l ? `${loadText(l)}, stop ${s.sequence}` : 'its load';
  };
  const loadWords = (id: string) => {
    const l = c.loads.get(id);
    return l ? loadText(l) : 'the load';
  };
  switch (op.kind) {
    case 'MOVE':
      return `Move ${c.nameOf(op.from)} from ${from(op.from)} to ${targetText(op.to, c.loads, c.code(op.to.truckId))}`;
    case 'REMOVE':
      return `Take ${c.nameOf(op.from)} off the plan (from ${from(op.from)})`;
    case 'PLACE':
      return `Put ${c.nameOf({ orderId: op.orderId })} on ${targetText(op.to, c.loads, c.code(op.to.truckId))}`;
    case 'MOVE_STOPS':
      return `Move ${op.stops.length === 1 ? c.nameOf(op.stops[0]!) : `${op.stops.length} stops`} to ${targetText(op.to, c.loads, c.code(op.to.truckId))}`;
    case 'REMOVE_STOPS':
      return op.stops.length === 1 ? `Take ${c.nameOf(op.stops[0]!)} off the plan (from ${from(op.stops[0]!)})` : `Take ${op.stops.length} stops off the plan`;
    case 'MOVE_LOAD': {
      const code = c.code(op.to.truckId);
      const where = op.to.before === 'BEST' ? `${code} (best place in its day)` : op.to.before ? `${code}, before L${c.loads.get(op.to.before)?.loadNo ?? '?'}` : `${code}, after its last load`;
      return `Move ${loadWords(op.loadId)} to ${where}`;
    }
    case 'SWAP_LOADS':
      return `Swap ${loadWords(op.a)} and ${loadWords(op.b)}`;
  }
}

/** Each edited truck's day as stored now and after the change (from a solver answer's trucks and scenario). */
function truckPreviews(x: {
  edited: readonly string[];
  loads: readonly EditLoad[];
  outs: readonly RetimeTruckOut[];
  scenario: DispatchScenario | null | undefined;
  names: ReadonlyMap<string, string>;
  truckCodes: ReadonlyMap<string, string>;
  stopsById: ReadonlyMap<string, DispatchStop>;
  movedKeys: ReadonlySet<string>;
  moved: ReadonlySet<string>;
  lateAllowed?: ReadonlySet<string>;
}): EditTruckPreview[] {
  const scLoads = x.scenario?.loads ?? [];
  return x.edited.map((t) => {
    const out = x.outs.find((o) => o.truck_id === t);
    const own = x.loads.filter((l) => l.truckId === t);
    const b = out?.before;
    // The figures the change is counted from (critic M5): the Planned loads timed now, next to the stored ones.
    const timedNow = b?.feasible && typeof b.money_omr === 'number' ? { costOmr: r2(b.money_omr), km: r2(b.km ?? 0), lastReturnMin: b.last_return_min ?? null } : null;
    return {
      truckId: t,
      truckCode: x.truckCodes.get(t) ?? t,
      before: { ...storedDayView(own, x.movedKeys), timedNow },
      after: x.scenario ? solvedDayView(own.filter((l) => l.status !== 'PLANNED'), scLoads.filter((l) => l.truck_id === t), x.names, x.stopsById, x.moved, x.lateAllowed) : null,
      feasible: !!out?.feasible,
      violations: (out?.violations ?? []).map((v) => viol(v, x.names, x.truckCodes)),
      beforeNow: out?.before ? { feasible: out.before.feasible, violations: out.before.violations.map((v) => viol(v, x.names, x.truckCodes)) } : null,
      deltaCostOmr: out?.delta_money_omr ?? null,
      deltaKm: out?.delta_km ?? null,
      deltaLastReturnMin: out?.delta_last_return_min ?? null,
    };
  });
}

/**
 * The preview of a checked change (pure; exported for its tests): per edited truck the day as planned (with
 * the solver's `before`, timed now, as the figures the change is counted from) and after; the hard rules
 * broken (and the issues, with what can be allowed by hand); the soft warnings (only what the change makes
 * worse); what changed since planning; whether it can be saved and why not; the other best places found
 * (never the stop's current place). `move` / `asked` / `movedStop`: a change of one v1 operation.
 */
export function previewOf(x: {
  mode: PlanEditMode;
  run: RunPlan;
  built: BuiltRequest;
  details: ScenarioDetails;
  loads: EditLoad[];
  edited: string[];
  edit: TruckDayEdit;
  ops?: PlanEditOp[];
  move?: PlanEditMove;
  asked?: PlanEditMove;
  /** The edit before a best place was resolved: the other places found resolve against it. */
  askedEdit: TruckDayEdit;
  movedStop?: string;
  names: Map<string, string>;
  truckCodes: Map<string, string>;
  answer: RetimeResponse;
  planStops: PlanStop[];
  stopOf: Map<string, string>;
  hash: string;
  builtAt: string;
  issues?: EditIssue[];
  overrides?: OverridePreview | null;
  draftable?: boolean;
  extraWarnings?: string[];
  overridesNeedSolver?: boolean;
  loadOptions?: PlanEditPreview['loadOptions'];
  /** The words of a stop ref of the list (an unserved visit too); default: the stored stop's customer. */
  nameOfRef?: (ref: EditStopRef) => string;
}): PlanEditPreview {
  const { answer, names, truckCodes } = x;
  const ops = x.ops ?? (x.move ? [x.move] : []);
  const loadById = new Map(x.loads.map((l) => [l.id, l]));
  const code = (id: string) => truckCodes.get(id) ?? id;
  const stopsById = new Map(x.built.request.stops.map((s) => [s.stop_id, s]));
  const moved = new Set<string>(x.edit.movedStops ?? []);
  if (x.movedStop) moved.add(x.movedStop);
  const movedKeys = new Set<string>();
  for (const p of x.planStops) if (moved.has(x.stopOf.get(stopKeyOf(p.loadId, p.sequence)) ?? '')) movedKeys.add(stopKeyOf(p.loadId, p.sequence));
  const scLoads = answer.scenario?.loads ?? [];
  const trucks = truckPreviews({ edited: x.edited, loads: x.loads, outs: answer.trucks, scenario: answer.scenario, names, truckCodes, stopsById, movedKeys, moved });

  // Soft rules: warn, saving is allowed.
  const warnings: string[] = [];
  const dm = answer.delta_money_omr;
  if (typeof dm === 'number' && dm > 0.0005) {
    const before = trucks.reduce((a, t) => a + (answer.trucks.find((o) => o.truck_id === t.truckId)?.before?.money_omr ?? 0), 0);
    warnings.push(`Day cost of ${x.edited.map(code).join(' and ')}: ${before.toFixed(2)} -> ${(before + dm).toFixed(2)} OMR (${signedOmr(dm)}).`);
  }
  if (typeof answer.delta_km === 'number' && answer.delta_km > 0.05) warnings.push(`${answer.delta_km.toFixed(1)} km more.`);
  if (typeof answer.delta_soft_omr === 'number' && answer.delta_soft_omr > 0.0005) {
    warnings.push(`Preferred hours and early delivery are kept less well (worse by ${answer.delta_soft_omr.toFixed(2)}, OMR-equivalent, not money).`);
  }
  for (const d of answer.scenario?.truck_days ?? []) if (d.overtime_min > 0) warnings.push(`${code(d.truck_id)} works ${d.overtime_min} min overtime.`);
  for (const t of x.edited) {
    const hadLoad = x.loads.some((l) => l.truckId === t);
    if (!hadLoad && scLoads.some((l) => l.truck_id === t)) warnings.push(`${code(t)} is used today for this change alone: its day cost (fixed cost, driver) counts.`);
  }
  // Preferred hours: the stops moved, and the stops the change pushes out of theirs (one already outside as
  // planned is not news; delta_soft_omr above says the change in total).
  const prefAsPlanned = new Map(x.planStops.map((p) => [x.stopOf.get(stopKeyOf(p.loadId, p.sequence)) ?? '', p.rows[0]?.prefWindowOk ?? null]));
  for (const l of scLoads) {
    for (const s of l.stops) {
      if (s.pref_window_ok !== false || !s.hard_window_ok) continue;
      if (!moved.has(s.stop_id) && prefAsPlanned.get(s.stop_id) === false) continue;
      warnings.push(`${names.get(s.stop_id) ?? s.stop_id} is reached outside its preferred hours (${fmtHhmm(s.arrival_min)}).`);
    }
  }
  const legs = scLoads.reduce((a, l) => a + (l.estimated_legs ?? 0), 0);
  if (legs > 0 && answer.distance_quality !== 'ESTIMATED') warnings.push(`${legs} leg(s) of the new loads use straight-line estimates.`);
  for (const t of trucks) {
    if (t.beforeNow && !t.beforeNow.feasible) warnings.push(`${t.truckCode}'s current loads no longer keep the rules with today's data: ${t.beforeNow.violations.map((v) => v.message).join(' ')}`);
  }
  for (const w of x.extraWarnings ?? []) warnings.push(w);
  for (const w of answer.warnings ?? []) warnings.push(w);

  const plannedConfig = readPlanInputs(x.details.inputs)?.config as Record<string, unknown> | undefined;
  const dataChanged = dataChangedSince({
    stops: x.planStops,
    stopOf: x.stopOf,
    request: x.built.request,
    promised: x.built.promised,
    trucks: x.edited.map((t) => ({ truckId: t, truckCode: code(t), loads: x.loads.filter((l) => l.truckId === t) })),
    plannedConfig: plannedConfig ?? null,
  });

  const roadsDown = x.details.distance_is_estimated === false && answer.distance_quality === 'ESTIMATED';
  const canSave = answer.ok && x.mode === 'ON' && !roadsDown;
  const saveNote = !answer.ok
    ? `Cannot be saved: it breaks the rules above.${x.overridesNeedSolver ? ` ${EDIT_ERROR_TEXT.OVERRIDES_NEED_SOLVER}.` : ''}`
    : roadsDown
      ? EDIT_ERROR_TEXT.ROADS_DOWN
      : x.mode !== 'ON'
        ? EDIT_ERROR_TEXT.CHECK_ONLY
        : null;

  // Best place of one stop: the other places found (each a change to check), best first after the one shown;
  // never the place the stop has now (its truck's loads as they are: a check of it would change nothing).
  const options =
    x.asked && x.askedEdit.best
      ? (answer.options ?? [])
          .slice(1)
          .filter((o) => JSON.stringify(o.loads) !== JSON.stringify(x.askedEdit.before.get(o.truck_id)))
          .map((o) => {
            const m = resolvedMoveOf(x.asked!, x.askedEdit, o);
            const others = answer.trucks.filter((t) => t.truck_id !== o.truck_id);
            const beforeAll = answer.trucks.map((t) => t.before?.money_omr);
            const afterOthers = others.map((t) => t.money_omr);
            const delta = [...beforeAll, ...afterOthers].every((v) => typeof v === 'number')
              ? o.money_omr + afterOthers.reduce<number>((a, v) => a + (v as number), 0) - beforeAll.reduce<number>((a, v) => a + (v as number), 0)
              : null;
            const where = m.kind === 'REMOVE' ? '' : targetText(m.to, loadById, code(o.truck_id));
            return { label: `${where}, back ${fmtHhmm(o.last_return_min)}`, move: m, deltaCostOmr: delta === null ? null : r2(delta), lastReturnMin: o.last_return_min };
          })
      : [];

  const singleName = (ref: EditStopRef) => {
    if (x.movedStop && ops.length === 1) return names.get(x.movedStop) ?? 'the stop';
    if (x.nameOfRef) return x.nameOfRef(ref);
    const id = 'orderId' in ref ? null : x.stopOf.get(stopKeyOf(ref.loadId, ref.sequence));
    return (id && names.get(id)) || 'the stop';
  };
  const title = ops.map((op) => opTitle(op, { loads: loadById, code, nameOf: singleName })).join('; ');
  return {
    ok: answer.ok,
    canSave,
    saveNote,
    mode: x.mode,
    version: x.run.version,
    previewHash: x.hash,
    builtAt: x.builtAt,
    ...(x.move ? { move: x.move } : {}),
    title,
    trucks,
    warnings: [...new Set(warnings)],
    dataChanged,
    options,
    deltaCostOmr: answer.delta_money_omr ?? null,
    deltaKm: answer.delta_km ?? null,
    matrix: { provider: answer.matrix_provider, quality: answer.distance_quality },
    ops,
    draftable: x.draftable ?? !x.edit.best,
    issues: x.issues ?? [],
    overrides: x.overrides ?? null,
    ...(x.loadOptions ? { loadOptions: x.loadOptions } : {}),
  };
}
