/**
 * Moves by hand in a load-based plan (PR M2, owner decisions of 24 Oct 2026; design notes "M" and the
 * cross-design review's section D). Server only. The words and shapes the screen shares are in
 * plan-edit-view.ts; the database writes of a save are in plan-edit-apply.ts.
 *
 * Check (POST /api/runs/:id/edit/check) writes nothing:
 *  1. the version is the live, applied dispatch plan of a day that is not over, not optimizing;
 *  2. the day is read as a RE-PLAN reads it, with TODAY's customers, trucks and settings
 *     (buildDispatchRequest, owner decision D1), and only the trucks the change touches are re-timed;
 *  3. the stops of those trucks' PLANNED loads are matched to the request's stops (mapStops: the same
 *     orders and the same parts; a new, cancelled or postponed order of one of them, or parts cut
 *     differently, is STOP_CHANGED: re-plan first); on a day planned by pallets, the products of the
 *     orders re-timed (only those) must have their cases per pallet; at most 80 stops are re-timed;
 *  4. the change gives each edited truck its new loads (editTruckDays), and the solver re-times them
 *     exactly (POST /retime-truck-days, apps/solver/retime.py): every hard rule (bays 98% / 100% one
 *     customer, cases, kg, small truck only, receiving hours, latest return, shift, loads per day, the
 *     driver break) refuses with the rule and by how much; FEASIBILITY_GATE=warn never relaxes it.
 *     Soft costs (money, km, preferred hours, overtime, a truck used for one load) only warn. A best place
 *     that is where the stop already is answers 409 NO_CHANGE;
 *  5. the preview: per truck before and after, the cost change from the same call (like for like, critic
 *     M5), what changed since planning on those trucks, and previewHash.
 * Save (POST /api/runs/:id/edit) checks again with the day read as it was at the check (at most 10
 * minutes later), must find the same preview (PREVIEW_CHANGED with the new one otherwise), and then, in ONE
 * transaction under the intake, day and plan locks, reads the touched trucks again (DAY_CHANGED when
 * anything of them changed: a change elsewhere never blocks a move, critic M2), makes version N+1
 * (MANUAL_ADJUSTMENT, the parent SUPERSEDED) and re-creates only the edited trucks' PLANNED loads.
 */
import { createHash } from 'node:crypto';
import type { Prisma, RunPlan } from '@prisma/client';
import type { DispatchRequest, DispatchScenario, DispatchStop, FeasibilityReport, FeasibilityViolation, PlannedLoad, RetimeBest, RetimeRequest, RetimeResponse, UnservedStop } from '@routeiq/shared-types';
import { prisma } from '../db';
import { callRetimeTruckDays } from '../solver-client';
import { buildDispatchRequest, isDispatchDetails, PlanError, type BuiltRequest, type PlanScope, type ScenarioDetails } from './plan-service';
import { isSupersededRun } from './plan-status';
import { canonical, VOLATILE_CONFIG } from './hire';
import { companyToday } from './hire-whatif';
import { dayMismatch, type ExpectedDay } from './start-optimize';
import { orderIdOf, portionId, readPortionLines, type PortionRecord } from './split';
import { groupMissingPalletFactors, palletFactorGate } from './pallets';
import { parseLoadBreak, readPlanInputs, readStopSnapshot, readTruckSnapshot, stopMasterChanges, truckMasterChanges } from './snapshots';
import { fmtDayMonth, fmtHhmm, isoOf } from './time';
import {
  EDIT_ERROR_TEXT,
  signedOmr,
  windowText,
  type EditLoadView,
  type EditStopView,
  type EditTarget,
  type EditTruckDayView,
  type EditTruckPreview,
  type EditViolation,
  planEditMode,
  type ManualEdit,
  type PlanEditMode,
  type PlanEditMove,
  type PlanEditPreview,
} from './plan-edit-view';

type Db = Prisma.TransactionClient | typeof prisma;

// ---------------------------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------------------------

export { manualOf, planEditConfigNote, planEditMode, type ManualEdit } from './plan-edit-view';

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

const linesKey = (lines: readonly { lineId: string; cases: number }[] | null) => (lines ? lines.map((l) => `${l.lineId}:${l.cases}`).sort().join(',') : '*');

/** A row's identity: its order and, for a split part, its lines and cases ("*" = the whole order). */
export function rowKey(orderId: string, portionLinesJson: unknown): string {
  return `${orderId}|${linesKey(readPortionLines(portionLinesJson))}`;
}

/** The same identity of an optimizer order ref (an order id, or a portion id of `portions`). */
export function refKey(ref: string, portions: Record<string, PortionRecord> | undefined): string {
  const p = portions?.[ref];
  return `${orderIdOf(ref)}|${linesKey(p ? p.lines : null)}`;
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
// The change, as the edited trucks' new loads (pure)
// ---------------------------------------------------------------------------------------------

/** A PLANNED load of an edited truck as request stop ids, in its stored order. */
export interface PlannedDayLoad {
  loadId: string;
  stops: string[];
}

export interface TruckDayEdit {
  /** The trucks the change touches: the source first, then the target. */
  edited: string[];
  before: Map<string, string[][]>;
  after: Map<string, string[][]>;
  /** The stored load each of `after`'s loads continues (null = a new load). */
  afterLoadIds: Map<string, (string | null)[]>;
  /** Best place: sent to the solver instead of a position (the stop is in no `after` load then). */
  best: RetimeBest | null;
}

export type EditRefusalCode = 'NO_CHANGE' | 'UNKNOWN_LOAD';

/**
 * The edited trucks' new loads after `move` (`planned`: their PLANNED loads now, in load order;
 * `movedStop`: the request stop that moves, is put on or taken off). A position counts the target
 * load's stops once the stop has left it (a reorder works the same way); a load left empty is dropped
 * (the later ones of its truck move up); a new load goes before the PLANNED load named, or after the
 * truck's last load.
 */
export function editTruckDays(move: PlanEditMove, planned: ReadonlyMap<string, readonly PlannedDayLoad[]>, movedStop: string, truckOfLoad: (loadId: string) => string | null):
  | { ok: true; edit: TruckDayEdit }
  | { ok: false; code: EditRefusalCode; message: string } {
  const work = new Map<string, { loadId: string | null; stops: string[] }[]>();
  const listOf = (truckId: string) => {
    if (!work.has(truckId)) work.set(truckId, (planned.get(truckId) ?? []).map((l) => ({ loadId: l.loadId, stops: [...l.stops] })));
    return work.get(truckId)!;
  };
  const edited: string[] = [];
  if (move.kind !== 'PLACE') {
    const truck = truckOfLoad(move.from.loadId);
    if (!truck) return { ok: false, code: 'UNKNOWN_LOAD', message: 'Unknown load.' };
    edited.push(truck);
    const load = listOf(truck).find((l) => l.loadId === move.from.loadId);
    const at = load ? load.stops.indexOf(movedStop) : -1;
    if (!load || at < 0) return { ok: false, code: 'UNKNOWN_LOAD', message: 'Unknown stop.' };
    load.stops.splice(at, 1);
  }
  let bestLoad: string | null | undefined; // undefined = no best place; null = as a new load
  if (move.kind !== 'REMOVE') {
    const t: EditTarget = move.to;
    if (!edited.includes(t.truckId)) edited.push(t.truckId);
    const list = listOf(t.truckId);
    if (t.loadId) {
      const load = list.find((l) => l.loadId === t.loadId);
      if (!load) return { ok: false, code: 'UNKNOWN_LOAD', message: 'Unknown load.' };
      if (t.position === 'BEST' || t.position === undefined) {
        if (!load.stops.length) return { ok: false, code: 'NO_CHANGE', message: 'Nothing changes: the stop is already there.' };
        bestLoad = t.loadId;
      } else load.stops.splice(Math.max(0, Math.min(t.position, load.stops.length)), 0, movedStop);
    } else if (t.before === 'BEST') {
      bestLoad = null;
    } else {
      const at = t.before ? list.findIndex((l) => l.loadId === t.before) : list.length;
      if (at < 0) return { ok: false, code: 'UNKNOWN_LOAD', message: 'Unknown load.' };
      list.splice(at, 0, { loadId: null, stops: [movedStop] });
    }
  }
  const before = new Map<string, string[][]>();
  const after = new Map<string, string[][]>();
  const afterLoadIds = new Map<string, (string | null)[]>();
  for (const truck of edited) {
    const kept = listOf(truck).filter((l) => l.stops.length > 0);
    before.set(truck, (planned.get(truck) ?? []).map((l) => [...l.stops]));
    after.set(truck, kept.map((l) => l.stops));
    afterLoadIds.set(truck, kept.map((l) => l.loadId));
  }
  let best: RetimeBest | null = null;
  if (bestLoad !== undefined && move.kind !== 'REMOVE') {
    const ids = afterLoadIds.get(move.to.truckId)!;
    best = { stop_id: movedStop, truck_id: move.to.truckId, load_index: bestLoad === null ? null : ids.indexOf(bestLoad) };
  }
  if (!best && edited.every((t) => JSON.stringify(before.get(t)) === JSON.stringify(after.get(t)))) {
    return { ok: false, code: 'NO_CHANGE', message: 'Nothing changes: the stop is already there.' };
  }
  return { ok: true, edit: { edited, before, after, afterLoadIds, best } };
}

/**
 * A best place the solver found, as a change with a concrete place: on an existing load, its id and the
 * position; as a new load, the load it goes before (null = the end). Save always sends this, so a save
 * is deterministic (the contract: send the option's loads, never `best`).
 */
export function resolvedMoveOf(move: PlanEditMove, edit: TruckDayEdit, option: { load_index?: number | null; new_load_at?: number | null; position: number }): PlanEditMove {
  if (move.kind === 'REMOVE') return move;
  const ids = edit.afterLoadIds.get(move.to.truckId) ?? [];
  const to: EditTarget =
    option.load_index !== null && option.load_index !== undefined
      ? { truckId: move.to.truckId, loadId: ids[option.load_index] ?? null, position: option.position }
      : { truckId: move.to.truckId, loadId: null, before: ids[option.new_load_at ?? ids.length] ?? null };
  return { ...move, to };
}

/**
 * The best place the solver found (`option`, its options[0]) as the change Save sends, checked to give exactly
 * the option's loads. NO_CHANGE: the best place is where the stop already is (the dialog's default, own load
 * and Best place, on a stop the optimizer placed well): nothing to save, said as such. MISMATCH: the option
 * does not resolve to its own loads (a web or solver bug).
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

/** The most stops one /retime-truck-days call takes (apps/solver/dispatch_models.py RETIME_MAX_STOPS: 422 above it). */
export const RETIME_MAX_STOPS = 80;

/** The distinct stops a check sends: the edited trucks' loads before and after, and a best-place stop. */
export function retimeStopCount(edit: Pick<TruckDayEdit, 'before' | 'after' | 'best'>): number {
  const ids = new Set([...edit.before.values(), ...edit.after.values()].flat(2));
  if (edit.best) ids.add(edit.best.stop_id);
  return ids.size;
}

// ---------------------------------------------------------------------------------------------
// Merging the re-timed trucks into the option in use (pure)
// ---------------------------------------------------------------------------------------------

/**
 * The solver's report of the merged option: the option's own findings on the trucks the move did not
 * re-time (and on the edited trucks' frozen loads, which it did not change either), plus the new check of
 * the edited trucks. UNVERIFIED when either side is (or the option had none); VIOLATED when a finding is
 * left; EXACT only when both are. The web gate reads it per truck (feasibility.ts).
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
  const status: FeasibilityReport['status'] = copied.status === 'UNVERIFIED' || !fresh || fresh.status === 'UNVERIFIED' ? 'UNVERIFIED' : violations.length ? 'VIOLATED' : 'VERIFIED';
  return {
    ...copied,
    status,
    timing: copied.timing === 'EXACT' && fresh?.timing === 'EXACT' ? 'EXACT' : 'ESTIMATED',
    violations,
    ...(copied.travel_checked !== undefined || fresh?.travel_checked !== undefined ? { travel_checked: !!copied.travel_checked && !!fresh?.travel_checked } : {}),
  };
}

/** "The MIN TRUCKS option serves 2 more stop(s) than this plan ...": the child has only the option in use (critic M7). */
const SERVES_MORE = /option serves \d+ more stop\(s\) than this plan/;

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
   * put on a truck leave it; a stop taken off joins it (`order_ids`: today's refs, mapped as the loads' are).
   */
  unserved: { placedOrderIds: readonly string[]; removed: { stop_id: string; order_ids: readonly string[]; reason_message: string } | null };
}): { details: ScenarioDetails; loads: PlannedLoad[] } {
  const { copied, sc, edited } = input;
  const key = (l: { truck_id: string; load_no: number }) => `${l.truck_id}:${l.load_no}`;
  const keptLoads = copied.loads.filter((l) => !(edited.has(l.truck_id) && input.replacedKeys.has(key(l))));
  const portions: Record<string, PortionRecord> = { ...(copied.scope.portions ?? {}) };
  const units = copied.scope.palletUnits || input.freshScope.palletUnits ? { ...(copied.scope.palletUnits ?? {}) } : undefined;
  const used = new Set(keptLoads.flatMap((l) => l.stops.flatMap((s) => s.order_ids)));
  const sameLines = (a: PortionRecord, b: PortionRecord) => linesKey(a.lines) === linesKey(b.lines) && a.cases === b.cases;
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
  const removed = input.unserved.removed;
  const unserved: UnservedStop[] = [
    ...(copied.unserved ?? []).flatMap((u) => {
      const left = u.order_ids.filter((r) => !placed.has(orderIdOf(r)));
      return left.length ? [{ ...u, order_ids: left }] : [];
    }),
    ...(removed ? [{ stop_id: removed.stop_id, order_ids: removed.order_ids.map(refOf), reason_code: 'REMOVED_BY_HAND' as const, reason_message: removed.reason_message }] : []),
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
// The stale check and the preview hash (pure)
// ---------------------------------------------------------------------------------------------

/**
 * What a check depended on, as one hash (critic M2: only what the move touches, so a late order or a
 * customer edit elsewhere never refuses it): the config (without what moves with the clock or the
 * search), the depot, the edited trucks as the request sends them (their frozen trips included), the
 * request stops on them before and after (and the stop moved), their stored loads and rows, the
 * option in use, and the unserved rows of an order put on a truck.
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
        .map((l) => ({
          id: l.id,
          status: l.status,
          loadNo: l.loadNo,
          rows: l.rows.map((r) => [r.orderId, r.sequenceInTruck, r.orderInStop, r.portionCases, linesKey(readPortionLines(r.portionLinesJson))]),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      chosenScenarioId: input.chosenScenarioId,
      unserved: input.unserved.map((u) => [u.orderId, u.reasonCode, linesKey(readPortionLines(u.portionLinesJson))]).sort(),
    }),
  );
  return createHash('sha256').update(text).digest('hex');
}

/** The hash a save must find again: the basis, when the day was read, the change and what the solver answered. */
export function previewHash(input: { basis: string; builtAt: string; move: PlanEditMove; truckDays: { truck_id: string; loads: string[][] }[]; answer: RetimeResponse }): string {
  const a = input.answer;
  const text = JSON.stringify(
    canonical({
      v: 1,
      basis: input.basis,
      builtAt: input.builtAt,
      move: input.move,
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

function storedDayView(loads: readonly EditLoad[], movedKey: string | null): EditTruckDayView {
  const views: EditLoadView[] = loads.map((l) => ({
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
      return {
        sequence: p.sequence,
        label: p.label,
        cases: p.rows.reduce((a, r) => a + r.cases, 0),
        etaMin: first.etaMin,
        startMin: first.serviceStartMin,
        window: snap ? windowText(snap.hardStartMin, snap.hardEndMin) : null,
        hardOk: first.hardWindowOk,
        prefOk: first.prefWindowOk,
        moved: movedKey === stopKeyOf(l.id, p.sequence),
      };
    }),
  }));
  const planned = views.filter((v) => !v.kept);
  return {
    loads: views,
    firstDepartMin: views.length ? Math.min(...views.map((v) => v.departMin)) : null,
    lastReturnMin: views.length ? Math.max(...views.map((v) => v.returnMin)) : null,
    costOmr: r2(planned.reduce((a, v) => a + (v.costOmr ?? 0), 0)),
    km: r2(planned.reduce((a, v) => a + v.km, 0)),
  };
}

function solvedDayView(frozen: readonly EditLoad[], loads: readonly PlannedLoad[], names: ReadonlyMap<string, string>, stopsById: ReadonlyMap<string, DispatchStop>, moved: string | null): EditTruckDayView {
  const kept = storedDayView(frozen, null).loads;
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
      return {
        sequence: s.sequence,
        label: names.get(s.stop_id) ?? s.stop_id,
        cases: s.cases,
        etaMin: s.arrival_min,
        startMin: s.service_start_min,
        window: st ? windowText(st.hard_start_min, st.hard_end_min) : null,
        hardOk: s.hard_window_ok,
        prefOk: s.pref_window_ok,
        moved: s.stop_id === moved,
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
  edit: TruckDayEdit;
  /** The change with a best place resolved (what a save sends). */
  move: PlanEditMove;
  movedStop: string;
  stopOf: Map<string, string>;
  refMap: Map<string, string>;
  basis: string;
  /** The rows taken off the plan (REMOVE) and the orders put on a truck (PLACE). */
  removedRows: EditRow[];
  placedOrderIds: string[];
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

/**
 * Check a change (writes nothing). Throws PlanError for a change that cannot be checked (the version,
 * a frozen load, a stop whose orders changed, the solver unavailable); a change that breaks a rule is
 * answered with `preview.ok` false and the rules it breaks.
 */
export async function checkPlanEdit(
  tenantId: string,
  runId: string,
  input: { move: PlanEditMove; expect?: ExpectedDay; now?: Date; mode?: PlanEditMode },
): Promise<EditCheck> {
  const mode = input.mode ?? planEditMode();
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
  const move = input.move;

  // The stop that changes, and the loads it leaves and goes to.
  const sourceLoad = move.kind === 'PLACE' ? null : loadById.get(move.from.loadId);
  if (move.kind !== 'PLACE') {
    if (!sourceLoad) throw refuse(422, 'UNKNOWN_LOAD', 'Unknown load: reload the plan.');
    if (sourceLoad.status !== 'PLANNED') throw frozenRefusal(sourceLoad, false);
    if (!sourceLoad.rows.some((r) => r.sequenceInTruck === move.from.sequence)) throw refuse(422, 'UNKNOWN_STOP', 'Unknown stop: reload the plan.');
    // A truck taken out of service (or no longer of this day) since planning: today's request has no such truck to time.
    if (!built.request.trucks.some((x) => x.id === sourceLoad.truckId)) {
      throw refuse(409, 'TRUCK_NOT_AVAILABLE', `${sourceLoad.truckCode} is not available on ${fmtDayMonth(isoOf(run.runDate))} any more: RE-PLAN the day to move its stops.`);
    }
  }
  if (move.kind !== 'REMOVE') {
    const t = move.to;
    if (!built.request.trucks.some((x) => x.id === t.truckId)) {
      const code = (await prisma.truck.findFirst({ where: { id: t.truckId, tenantId }, select: { code: true } }))?.code;
      if (!code) throw refuse(422, 'UNKNOWN_TRUCK', 'Unknown truck: reload the plan.');
      throw refuse(409, 'TRUCK_NOT_AVAILABLE', `${code} is not available on ${fmtDayMonth(isoOf(run.runDate))}.`);
    }
    for (const id of [t.loadId, typeof t.before === 'string' && t.before !== 'BEST' ? t.before : null]) {
      if (!id) continue;
      const l = loadById.get(id);
      if (!l || l.truckId !== t.truckId) throw refuse(422, 'UNKNOWN_LOAD', 'Unknown load: reload the plan.');
      if (l.status !== 'PLANNED') throw frozenRefusal(l, true);
    }
  }
  const edited = [...new Set([...(sourceLoad ? [sourceLoad.truckId] : []), ...(move.kind !== 'REMOVE' ? [move.to.truckId] : [])])];
  const editedSet = new Set(edited);
  const plannedOfEdited = loads.filter((l) => editedSet.has(l.truckId) && l.status === 'PLANNED');
  const planStops = plannedOfEdited.flatMap(planStopsOf);
  const mapped = mapStops({ stops: planStops, request: built.request, portions: built.scope.portions, parentLoads: details.loads, parentPortions: details.scope.portions });
  if (!mapped.ok) {
    throw refuse(
      409,
      'STOP_CHANGED',
      `Orders of ${mapped.label} on ${mapped.truckCode} L${mapped.loadNo} changed since this plan (a new, cancelled or postponed order, or the customer is split differently today), and that truck is timed again for this change. RE-PLAN the day first.`,
    );
  }
  const { stopOf, refMap } = mapped;

  // PLACE: the request stop of the order, all of whose orders are whole unserved orders of the option.
  let movedStop: string;
  const placedOrderIds: string[] = [];
  const names = new Map<string, string>();
  for (const p of planStops) names.set(stopOf.get(stopKeyOf(p.loadId, p.sequence))!, p.label);
  if (move.kind === 'PLACE') {
    const row = unserved.find((u) => u.orderId === move.orderId);
    const customer = await prisma.order.findFirst({ where: { id: move.orderId, tenantId }, select: { customer: { select: { code: true, branchCode: true, name: true } } } });
    const label = customer ? customerLabel(customer.customer) : 'This order';
    if (!row) throw refuse(409, 'NOT_UNSERVED', `${label} is not on the unserved list of this plan any more. Reload the plan.`);
    if (readPortionLines(row.portionLinesJson)) throw refuse(409, 'PART_ON_TRUCK', `Part of ${label} is already on a truck: only a whole unserved customer can be put on a truck. RE-PLAN the day instead.`);
    const stop = built.request.stops.find((s) => s.order_ids.includes(move.orderId));
    if (!stop && built.request.stops.some((s) => s.order_ids.some((r) => orderIdOf(r) === move.orderId))) {
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
    const wholeUnserved = new Set(unserved.filter((u) => !readPortionLines(u.portionLinesJson)).map((u) => u.orderId));
    if (!stop.order_ids.every((r) => r === orderIdOf(r) && wholeUnserved.has(r))) {
      throw refuse(409, 'STOP_CHANGED', `${label} has orders that are not on the unserved list (a new order came in, or part of it is on a truck). RE-PLAN the day to plan them together.`);
    }
    movedStop = stop.stop_id;
    placedOrderIds.push(...stop.order_ids);
    names.set(movedStop, label);
  } else {
    movedStop = stopOf.get(stopKeyOf(move.from.loadId, move.from.sequence))!;
  }

  const planned = new Map<string, PlannedDayLoad[]>();
  for (const t of edited) {
    planned.set(
      t,
      plannedOfEdited.filter((l) => l.truckId === t).map((l) => ({ loadId: l.id, stops: planStopsOf(l).map((p) => stopOf.get(stopKeyOf(p.loadId, p.sequence))!) })),
    );
  }
  // Pallets: only the products of the orders the change re-times (a late order elsewhere never blocks a move).
  const stopById = new Map(built.request.stops.map((s) => [s.stop_id, s]));
  const timedOrders = new Set([...[...planned.values()].flat().flatMap((l) => l.stops), movedStop].flatMap((id) => (stopById.get(id)?.order_ids ?? []).map(orderIdOf)));
  const pallets = palletFactorGate({ missingPalletFactors: groupMissingPalletFactors((built.missingPalletLines ?? []).filter((l) => timedOrders.has(l.orderId))) }, 'check the move');
  if (pallets) {
    const { error, ...rest } = pallets.body;
    throw new PlanError(String(error), pallets.status, rest);
  }

  const truckOfLoad = (id: string) => loadById.get(id)?.truckId ?? null;
  const first = editTruckDays(move, planned, movedStop, truckOfLoad);
  if (!first.ok) throw refuse(first.code === 'NO_CHANGE' ? 409 : 422, first.code, first.message);
  const askedEdit = first.edit;
  let edit = first.edit;
  const named = retimeStopCount(edit);
  if (named > RETIME_MAX_STOPS) {
    throw refuse(
      409,
      'TOO_MANY_STOPS',
      `This change re-times ${named} stops on ${edited.map((t) => truckCodes.get(t) ?? t).join(' and ')}; a check takes at most ${RETIME_MAX_STOPS}. RE-PLAN the day instead.`,
    );
  }

  const body: RetimeRequest = {
    request: built.request,
    truck_days: edited.map((t) => ({ truck_id: t, loads: edit.after.get(t)! })),
    before: edited.map((t) => ({ truck_id: t, loads: edit.before.get(t)! })),
    ...(edit.best ? { best: edit.best } : {}),
  };
  const reply = await callRetimeTruckDays(body);
  if (reply.kind === 'outdated') throw refuse(503, 'SOLVER_OUTDATED', EDIT_ERROR_TEXT.SOLVER_OUTDATED);
  if (reply.kind === 'not_configured') throw refuse(503, 'SOLVER_NOT_CONFIGURED', 'The route optimizer is not configured (SOLVER_URL / SOLVER_TOKEN): moves cannot be checked. Nothing was changed.');
  if (reply.kind !== 'answer') {
    if (reply.kind === 'failed') console.error('plan edit: /retime-truck-days refused the check', { runId, status: reply.status, detail: reply.detail });
    throw refuse(503, reply.kind === 'busy' ? 'SOLVER_BUSY' : 'SOLVER_FAILED', EDIT_ERROR_TEXT.SOLVER_FAILED);
  }
  const answer = reply.body;

  // A best place found: the change with that place (what Save sends), checked to give the same loads.
  let resolved: PlanEditMove = move;
  if (edit.best && answer.options?.length) {
    const r = resolveBestPlace(move, edit, answer.options[0]!, planned, movedStop, truckOfLoad);
    if (!r.ok && r.code === 'NO_CHANGE' && sourceLoad && move.kind !== 'PLACE') {
      // The best place is where the stop already is (the dialog's default on a well-placed stop): nothing to save.
      throw refuse(
        409,
        'NO_CHANGE',
        `${names.get(movedStop) ?? 'This stop'} is already at its best place (${loadText(sourceLoad)}, stop ${move.from.sequence}): nothing changes. Choose a position or another load to move it.`,
      );
    }
    if (!r.ok) {
      console.error('plan edit: the best place does not resolve to its loads', { runId, option: answer.options[0] });
      throw refuse(503, 'SOLVER_FAILED', EDIT_ERROR_TEXT.SOLVER_FAILED);
    }
    resolved = r.move;
    edit = r.edit;
  }

  const stopIds = new Set<string>([movedStop, ...[...edit.before.values(), ...edit.after.values()].flat(2)]);
  const basis = editBasis({ request: built.request, edited, stopIds, loads, chosenScenarioId: run.chosenScenarioId, unserved: unserved.filter((u) => placedOrderIds.includes(u.orderId)) });
  const builtAt = built.builtAt ?? new Date().toISOString();
  const truckDays = edited.map((t) => ({ truck_id: t, loads: edit.after.get(t)! }));
  const hash = previewHash({ basis, builtAt, move: resolved, truckDays, answer });

  const removedRows = move.kind === 'REMOVE' ? sourceLoad!.rows.filter((r) => r.sequenceInTruck === move.from.sequence) : [];
  const preview = previewOf({
    mode,
    run,
    built,
    details,
    loads,
    edited,
    edit,
    move: resolved,
    asked: move,
    askedEdit,
    movedStop,
    names,
    truckCodes,
    answer,
    planStops,
    stopOf,
    hash,
    builtAt,
  });
  return { preview, run, built, details, loads, unserved, answer, edit, move: resolved, movedStop, stopOf, refMap, basis, removedRows, placedOrderIds };
}

/** The target in words: "T08 L1, stop 4", "T08, a new load before L2". */
function targetText(t: EditTarget, loads: ReadonlyMap<string, EditLoad>, code: string): string {
  if (t.loadId) {
    const l = loads.get(t.loadId);
    return `${code} L${l?.loadNo ?? '?'}${typeof t.position === 'number' ? `, stop ${t.position + 1}` : ' (best place)'}`;
  }
  if (t.before === 'BEST') return `${code}, a new load (best place in its day)`;
  return t.before ? `${code}, a new load before L${loads.get(t.before)?.loadNo ?? '?'}` : `${code}, a new load after its last load`;
}

/**
 * The preview of a checked change (pure; exported for its tests): per edited truck the day as planned (with
 * the solver's `before`, timed now, as the figures the change is counted from) and after; the hard rules
 * broken; the soft warnings (only what the change makes worse); what changed since planning; whether it can
 * be saved and why not; the other best places found (never the stop's current place).
 */
export function previewOf(x: {
  mode: PlanEditMode;
  run: RunPlan;
  built: BuiltRequest;
  details: ScenarioDetails;
  loads: EditLoad[];
  edited: string[];
  edit: TruckDayEdit;
  move: PlanEditMove;
  asked: PlanEditMove;
  /** The edit before a best place was resolved: the other places found resolve against it. */
  askedEdit: TruckDayEdit;
  movedStop: string;
  names: Map<string, string>;
  truckCodes: Map<string, string>;
  answer: RetimeResponse;
  planStops: PlanStop[];
  stopOf: Map<string, string>;
  hash: string;
  builtAt: string;
}): PlanEditPreview {
  const { answer, names, truckCodes } = x;
  const loadById = new Map(x.loads.map((l) => [l.id, l]));
  const code = (id: string) => truckCodes.get(id) ?? id;
  const stopsById = new Map(x.built.request.stops.map((s) => [s.stop_id, s]));
  const movedKey = x.move.kind === 'PLACE' ? null : stopKeyOf(x.move.from.loadId, x.move.from.sequence);
  const label = names.get(x.movedStop) ?? 'the stop';
  const scLoads = answer.scenario?.loads ?? [];
  const trucks: EditTruckPreview[] = x.edited.map((t) => {
    const out = answer.trucks.find((o) => o.truck_id === t);
    const own = x.loads.filter((l) => l.truckId === t);
    const b = out?.before;
    // The figures the change is counted from (critic M5): the Planned loads timed now, next to the stored ones.
    const timedNow = b?.feasible && typeof b.money_omr === 'number' ? { costOmr: r2(b.money_omr), km: r2(b.km ?? 0), lastReturnMin: b.last_return_min ?? null } : null;
    return {
      truckId: t,
      truckCode: code(t),
      before: { ...storedDayView(own, movedKey), timedNow },
      after: answer.scenario ? solvedDayView(own.filter((l) => l.status !== 'PLANNED'), scLoads.filter((l) => l.truck_id === t), names, stopsById, x.movedStop) : null,
      feasible: !!out?.feasible,
      violations: (out?.violations ?? []).map((v) => viol(v, names, truckCodes)),
      beforeNow: out?.before ? { feasible: out.before.feasible, violations: out.before.violations.map((v) => viol(v, names, truckCodes)) } : null,
      deltaCostOmr: out?.delta_money_omr ?? null,
      deltaKm: out?.delta_km ?? null,
      deltaLastReturnMin: out?.delta_last_return_min ?? null,
    };
  });

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
  // Preferred hours: the stop moved, and the stops the change pushes out of theirs (one already outside as
  // planned is not news; delta_soft_omr above says the change in total).
  const prefAsPlanned = new Map(x.planStops.map((p) => [x.stopOf.get(stopKeyOf(p.loadId, p.sequence)) ?? '', p.rows[0]?.prefWindowOk ?? null]));
  for (const l of scLoads) {
    for (const s of l.stops) {
      if (s.pref_window_ok !== false || !s.hard_window_ok) continue;
      if (s.stop_id !== x.movedStop && prefAsPlanned.get(s.stop_id) === false) continue;
      warnings.push(`${names.get(s.stop_id) ?? s.stop_id} is reached outside its preferred hours (${fmtHhmm(s.arrival_min)}).`);
    }
  }
  const legs = scLoads.reduce((a, l) => a + (l.estimated_legs ?? 0), 0);
  if (legs > 0 && answer.distance_quality !== 'ESTIMATED') warnings.push(`${legs} leg(s) of the new loads use straight-line estimates.`);
  for (const t of trucks) {
    if (t.beforeNow && !t.beforeNow.feasible) warnings.push(`${t.truckCode}'s current loads no longer keep the rules with today's data: ${t.beforeNow.violations.map((v) => v.message).join(' ')}`);
  }
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
    ? 'Cannot be saved: it breaks the rules above.'
    : roadsDown
      ? EDIT_ERROR_TEXT.ROADS_DOWN
      : x.mode !== 'ON'
        ? EDIT_ERROR_TEXT.CHECK_ONLY
        : null;

  // Best place: the other places found (each a change to check), best first after the one shown; never the
  // place the stop has now (its truck's loads as they are: a check of it would change nothing).
  const options = (answer.options ?? []).slice(1).filter((o) => JSON.stringify(o.loads) !== JSON.stringify(x.askedEdit.before.get(o.truck_id))).map((o) => {
    const m = resolvedMoveOf(x.asked, x.askedEdit, o);
    const others = answer.trucks.filter((t) => t.truck_id !== o.truck_id);
    const beforeAll = answer.trucks.map((t) => t.before?.money_omr);
    const afterOthers = others.map((t) => t.money_omr);
    const delta = [...beforeAll, ...afterOthers].every((v) => typeof v === 'number')
      ? o.money_omr + afterOthers.reduce<number>((a, v) => a + (v as number), 0) - beforeAll.reduce<number>((a, v) => a + (v as number), 0)
      : null;
    const where = m.kind === 'REMOVE' ? '' : targetText(m.to, loadById, code(o.truck_id));
    return { label: `${where}, back ${fmtHhmm(o.last_return_min)}`, move: m, deltaCostOmr: delta === null ? null : r2(delta), lastReturnMin: o.last_return_min };
  });

  const from = x.move.kind === 'PLACE' ? null : loadById.get(x.move.from.loadId)!;
  const fromText = from && x.move.kind !== 'PLACE' ? `${loadText(from)}, stop ${x.move.from.sequence}` : '';
  const title =
    x.move.kind === 'REMOVE'
      ? `Take ${label} off the plan (from ${fromText})`
      : x.move.kind === 'PLACE'
        ? `Put ${label} on ${targetText(x.move.to, loadById, code(x.move.to.truckId))}`
        : `Move ${label} from ${fromText} to ${targetText(x.move.to, loadById, code(x.move.to.truckId))}`;
  return {
    ok: answer.ok,
    canSave,
    saveNote,
    mode: x.mode,
    version: x.run.version,
    previewHash: x.hash,
    builtAt: x.builtAt,
    move: x.move,
    title,
    trucks,
    warnings: [...new Set(warnings)],
    dataChanged,
    options,
    deltaCostOmr: answer.delta_money_omr ?? null,
    deltaKm: answer.delta_km ?? null,
    matrix: { provider: answer.matrix_provider, quality: answer.distance_quality },
  };
}
