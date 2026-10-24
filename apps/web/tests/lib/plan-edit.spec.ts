/**
 * Moves by hand (PR M2/M3): the pure parts of lib/dispatch/plan-edit.ts and plan-edit-view.ts - the
 * switch, matching stored stops to today's request (mapStops: STOP_CHANGED, split parts, ids kept),
 * the edited trucks' new loads (editTruckDays: move, reorder, new load, best place, take off, put on),
 * a best place resolved for the save, the merged option (critic M3: every ref resolves to its row; M5
 * and M7) and its solver report, the stale check scoped to the touched trucks (critic M2), the preview
 * hash and the words, the cases per pallet corrected since planning (PALLET_FACTOR_CHANGED, release
 * review F1). Synthetic data only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunPlan } from '@prisma/client';
import type { DispatchRequest, DispatchScenario, DispatchStop, FeasibilityReport, PlannedLoad, RetimeRequest, RetimeResponse } from '@routeiq/shared-types';
import {
  dataChangedSince,
  editBasis,
  editTruckDays,
  mapStops,
  mergeOption,
  mergeSolverReport,
  palletFactorChangedText,
  palletFactorsChangedSince,
  planStopsOf,
  previewHash,
  previewOf,
  refKey,
  relabel,
  resolveBestPlace,
  resolvedMoveOf,
  retimeStopCount,
  RETIME_MAX_STOPS,
  rowKey,
  stopKeyOf,
  type EditLoad,
  type EditRow,
  type PlannedDayLoad,
} from '@/lib/dispatch/plan-edit';
import { EDIT_ERROR_TEXT, manualOf, planEditConfigNote, planEditMode, positionChoices, savedText, signedOmr, windowText, type ManualEdit, type PlanEditMode, type PlanEditMove } from '@/lib/dispatch/plan-edit-view';
import { afterTitle, moveOfChoices } from '@/app/t/[slug]/dispatch/move-stop-dialog';
import { resolveOrderRef, type BuiltRequest, type ScenarioDetails } from '@/lib/dispatch/plan-service';
import { callRetimeTruckDays } from '@/lib/solver-client';
import type { PortionRecord } from '@/lib/dispatch/split';

// ---------------------------------------------------------------------------------------------
// Fixtures

const snap = (code: string, extra: Record<string, unknown> = {}) => ({
  v: 2, customerId: `cu-${code}`, code, branchCode: null, name: `Customer ${code}`, customerType: null, lat: 23.6, lng: 58.4,
  hardStartMin: 360, hardEndMin: 1080, prefStartMin: null, prefEndMin: null, serviceMin: 15, priority: 3, address: null, accessNotes: null,
  source: 'PLAN', capturedAt: '2026-10-23T14:00:00.000Z', ...extra,
});

function row(orderId: string, seq: number, k = 0, lines: { lineId: string; cases: number }[] | null = null, code = orderId.toUpperCase()): EditRow {
  return {
    orderId, sequenceInTruck: seq, orderInStop: k, portionCases: lines ? lines.reduce((a, l) => a + l.cases, 0) : null, portionWeightKg: null,
    portionLinesJson: lines, stopSnapshotJson: snap(code), etaMin: 400 + seq * 30, serviceStartMin: 400 + seq * 30, hardWindowOk: true, prefWindowOk: true,
    cases: lines ? lines.reduce((a, l) => a + l.cases, 0) : 10, customerId: `cu-${code}`, label: `Customer ${code} (${code})`,
  };
}

function load(id: string, truckId: string, loadNo: number, rows: EditRow[], status = 'PLANNED'): EditLoad {
  return { id, truckId, truckCode: truckId, loadNo, status, departMin: 360, returnMin: 600, distanceKm: 30, cases: 40, operatingCost: 20, palletUnits: null, truckSnapshotJson: null, breakJson: null, rows };
}

const stop = (stop_id: string, order_ids: string[], extra: Partial<DispatchStop> = {}): DispatchStop =>
  ({ stop_id, customer_id: stop_id.split('#')[0]!, order_ids, lat: 23.6, lng: 58.4, demand_cases: 10, demand_kg: 100, service_min: 15, priority: 3, hard_start_min: 360, hard_end_min: 1080, ...extra }) as DispatchStop;

const portion = (orderId: string, lines: { lineId: string; cases: number }[], part: number | null = null): PortionRecord => ({
  orderId, lines, cases: lines.reduce((a, l) => a + l.cases, 0), weightKg: 0, part, parts: part ? 2 : null,
});

function plannedLoad(truck_id: string, load_no: number, stops: { stop_id: string; order_ids: string[] }[], extra: Partial<PlannedLoad> = {}): PlannedLoad {
  return {
    truck_id, load_no, depart_min: 360, return_min: 600, distance_km: 30, duration_min: 240, cases: 40, kg: 400, utilization_pct: 50,
    fuel_litres: 5, fuel_cost: 1, distance_cost: 2, time_cost: 3, fixed_cost: 4, total_cost: 20, return_leg_km: 5,
    stops: stops.map((s, i) => ({ sequence: i + 1, stop_id: s.stop_id, order_ids: s.order_ids, customer_id: s.stop_id.split('#')[0]!, arrival_min: 400 + i * 30, service_start_min: 400 + i * 30, departure_min: 415 + i * 30, wait_min: 0, leg_km: 3, cum_km: 3 * (i + 1), leg_min: 10, cases: 10, kg: 100, hard_window_ok: true, pref_window_ok: true })),
    ...extra,
  };
}

const request = (stops: DispatchStop[], trucks: { id: string; frozen?: number }[] = [{ id: 'T01' }, { id: 'T02' }]): DispatchRequest =>
  ({
    run_id: 'run-1', tenant_id: 'ten-1', depot: { id: 'dep', lat: 23.5, lng: 58.3, open_min: 0, close_min: 1440 },
    trucks: trucks.map((t) => ({ id: t.id, code: t.id, capacity_cases: 200, capacity_kg: 3000, frozen_trips: Array.from({ length: t.frozen ?? 0 }, (_, i) => ({ load_no: i + 1, depart_min: 300, return_min: 350, cases: 5 })) })),
    stops,
    config: { shift_start_min: 360, shift_max_min: 600, reload_min: 30, loading_from_min: null, search_mode: 'QUICK' },
  }) as unknown as DispatchRequest;

// ---------------------------------------------------------------------------------------------

describe('the switch PLAN_EDIT', () => {
  it('is off unless check or on, and the startup line names a value it does not know', () => {
    expect(planEditMode({})).toBe('OFF');
    expect(planEditMode({ PLAN_EDIT: ' on ' })).toBe('ON');
    expect(planEditMode({ PLAN_EDIT: 'CHECK' })).toBe('CHECK');
    expect(planEditMode({ PLAN_EDIT: 'yes' })).toBe('OFF');
    expect(planEditConfigNote({})).toBeNull();
    expect(planEditConfigNote({ PLAN_EDIT: 'off' })).toBeNull();
    expect(planEditConfigNote({ PLAN_EDIT: 'yes' })).toBe('PLAN_EDIT=yes is not off, check or on: moves by hand stay off.');
    expect(planEditConfigNote({ PLAN_EDIT: 'check' })).toMatch(/saving them is off/);
    expect(planEditConfigNote({ PLAN_EDIT: 'on' })).toMatch(/new plan version/);
  });
});

describe('mapStops: the stored stops of the edited trucks to today\'s request', () => {
  const L1 = load('L1', 'T01', 1, [row('o1', 1), row('o2', 2), row('o3', 2, 1, null, 'O2')]);
  const parent = [plannedLoad('T01', 1, [{ stop_id: 'c1', order_ids: ['o1'] }, { stop_id: 'c2', order_ids: ['o2', 'o3'] }])];

  it('maps whole stops, a stop with two orders of one customer, and keeps the option\'s refs', () => {
    const r = mapStops({ stops: planStopsOf(L1), request: request([stop('c1', ['o1']), stop('c2', ['o3', 'o2'])]), portions: {}, parentLoads: parent, parentPortions: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stopOf.get(stopKeyOf('L1', 1))).toBe('c1');
    expect(r.stopOf.get(stopKeyOf('L1', 2))).toBe('c2');
    expect(r.refMap.get('o2')).toBe('o2');
  });

  it('refuses a stop with a new order of the same customer, an order cancelled or postponed, or parts cut differently (STOP_CHANGED, the customer named)', () => {
    const newOrder = mapStops({ stops: planStopsOf(L1), request: request([stop('c1', ['o1', 'o9']), stop('c2', ['o2', 'o3'])]), portions: {}, parentLoads: parent, parentPortions: {} });
    expect(newOrder).toEqual({ ok: false, label: 'Customer O1 (O1)', truckCode: 'T01', loadNo: 1 });
    const cancelled = mapStops({ stops: planStopsOf(L1), request: request([stop('c1', ['o1']), stop('c2', ['o2'])]), portions: {}, parentLoads: parent, parentPortions: {} });
    expect(cancelled).toEqual({ ok: false, label: 'Customer O2 (O2)', truckCode: 'T01', loadNo: 1 });
    const split = load('L1', 'T01', 1, [row('o5', 1, 0, [{ lineId: 'l1', cases: 100 }])]);
    const cut = mapStops({
      stops: planStopsOf(split),
      request: request([stop('c5#1', ['o5~1']), stop('c5#2', ['o5~2'])]),
      portions: { 'o5~1': portion('o5', [{ lineId: 'l1', cases: 120 }], 1), 'o5~2': portion('o5', [{ lineId: 'l1', cases: 80 }], 2) },
      parentLoads: [],
      parentPortions: {},
    });
    expect(cut.ok).toBe(false);
  });

  it('maps split parts by their lines; two equal parts keep the ids the option had at that place (critic M3)', () => {
    const lines = [{ lineId: 'l1', cases: 100 }];
    const a = load('LA', 'T01', 1, [row('o5', 1, 0, lines)]);
    const b = load('LB', 'T02', 1, [row('o5', 1, 0, lines)]);
    const fresh = { 'o5~1': portion('o5', lines, 1), 'o5~2': portion('o5', lines, 2) };
    // The option had part 2 on T01 and part 1 on T02 (the request numbers them again).
    const parentLoads = [plannedLoad('T01', 1, [{ stop_id: 'c5#2', order_ids: ['o5~2'] }]), plannedLoad('T02', 1, [{ stop_id: 'c5#1', order_ids: ['o5~1'] }])];
    const r = mapStops({ stops: [...planStopsOf(a), ...planStopsOf(b)], request: request([stop('c5#1', ['o5~1']), stop('c5#2', ['o5~2'])]), portions: fresh, parentLoads, parentPortions: fresh });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stopOf.get(stopKeyOf('LA', 1))).toBe('c5#2');
    expect(r.stopOf.get(stopKeyOf('LB', 1))).toBe('c5#1');
    expect(r.refMap.get('o5~2')).toBe('o5~2');
  });

  it('a stored part maps back to the option\'s ref when today\'s request numbers it otherwise', () => {
    const lines = [{ lineId: 'l1', cases: 60 }];
    const L = load('L', 'T01', 2, [row('o7', 1, 0, lines)]);
    const r = mapStops({
      stops: planStopsOf(L),
      request: request([stop('c7', ['o7~open'])]),
      portions: { 'o7~open': portion('o7', lines) },
      parentLoads: [plannedLoad('T01', 2, [{ stop_id: 'c7#2', order_ids: ['o7~2'] }])],
      parentPortions: { 'o7~2': portion('o7', lines, 2) },
    });
    expect(r.ok && r.refMap.get('o7~open')).toBe('o7~2');
    expect(rowKey('o7', lines)).toBe(refKey('o7~2', { 'o7~2': portion('o7', lines, 2) }));
    expect(rowKey('o7', null)).toBe('o7|*');
  });
});

describe('editTruckDays: the edited trucks\' new loads', () => {
  const planned = new Map<string, PlannedDayLoad[]>([
    ['T01', [{ loadId: 'A1', stops: ['c1', 'c2', 'c3'] }, { loadId: 'A2', stops: ['c4'] }]],
    ['T02', [{ loadId: 'B1', stops: ['c5', 'c6'] }]],
  ]);
  const truckOf = (id: string) => (id.startsWith('A') ? 'T01' : id.startsWith('B') ? 'T02' : null);
  const run = (move: PlanEditMove, moved: string) => editTruckDays(move, planned, moved, truckOf);
  const after = (r: ReturnType<typeof run>, t: string) => (r.ok ? r.edit.after.get(t) : r);

  it('reorders within a load (the position counts the load without the stop)', () => {
    const r = run({ kind: 'MOVE', from: { loadId: 'A1', sequence: 1 }, to: { truckId: 'T01', loadId: 'A1', position: 2 } }, 'c1');
    expect(after(r, 'T01')).toEqual([['c2', 'c3', 'c1'], ['c4']]);
    expect(r.ok && r.edit.edited).toEqual(['T01']);
  });

  it('moves to another truck\'s load at every position', () => {
    for (const [pos, want] of [[0, ['c3', 'c5', 'c6']], [1, ['c5', 'c3', 'c6']], [2, ['c5', 'c6', 'c3']], [9, ['c5', 'c6', 'c3']]] as const) {
      const r = run({ kind: 'MOVE', from: { loadId: 'A1', sequence: 3 }, to: { truckId: 'T02', loadId: 'B1', position: pos } }, 'c3');
      expect(after(r, 'T02')).toEqual([want]);
      expect(after(r, 'T01')).toEqual([['c1', 'c2'], ['c4']]);
      expect(r.ok && r.edit.edited).toEqual(['T01', 'T02']);
      expect(r.ok && r.edit.before.get('T02')).toEqual([['c5', 'c6']]);
    }
  });

  it('a load left empty is dropped; a new load goes at the end or before a load', () => {
    const r = run({ kind: 'MOVE', from: { loadId: 'A2', sequence: 1 }, to: { truckId: 'T01', loadId: 'A1', position: 3 } }, 'c4');
    expect(after(r, 'T01')).toEqual([['c1', 'c2', 'c3', 'c4']]);
    expect(r.ok && r.edit.afterLoadIds.get('T01')).toEqual(['A1']);
    const end = run({ kind: 'MOVE', from: { loadId: 'B1', sequence: 1 }, to: { truckId: 'T01', loadId: null, before: null } }, 'c5');
    expect(after(end, 'T01')).toEqual([['c1', 'c2', 'c3'], ['c4'], ['c5']]);
    const before = run({ kind: 'MOVE', from: { loadId: 'B1', sequence: 1 }, to: { truckId: 'T01', loadId: null, before: 'A2' } }, 'c5');
    expect(after(before, 'T01')).toEqual([['c1', 'c2', 'c3'], ['c5'], ['c4']]);
    expect(before.ok && before.edit.afterLoadIds.get('T01')).toEqual(['A1', null, 'A2']);
  });

  it('best place: in a load (its index after a load left empty is dropped), or as a new load', () => {
    const r = run({ kind: 'MOVE', from: { loadId: 'A2', sequence: 1 }, to: { truckId: 'T02', loadId: 'B1', position: 'BEST' } }, 'c4');
    expect(r.ok && r.edit.best).toEqual({ stop_id: 'c4', truck_id: 'T02', load_index: 0 });
    expect(after(r, 'T02')).toEqual([['c5', 'c6']]);
    expect(after(r, 'T01')).toEqual([['c1', 'c2', 'c3']]);
    const own = run({ kind: 'MOVE', from: { loadId: 'A1', sequence: 1 }, to: { truckId: 'T01', loadId: 'A2', position: 'BEST' } }, 'c1');
    expect(own.ok && own.edit.best).toEqual({ stop_id: 'c1', truck_id: 'T01', load_index: 1 });
    const fresh = run({ kind: 'MOVE', from: { loadId: 'A1', sequence: 1 }, to: { truckId: 'T02', loadId: null, before: 'BEST' } }, 'c1');
    expect(fresh.ok && fresh.edit.best).toEqual({ stop_id: 'c1', truck_id: 'T02', load_index: null });
  });

  it('takes a stop off the plan, and puts an unserved stop on (a truck with no load today too)', () => {
    const off = run({ kind: 'REMOVE', from: { loadId: 'A2', sequence: 1 } }, 'c4');
    expect(after(off, 'T01')).toEqual([['c1', 'c2', 'c3']]);
    const on = run({ kind: 'PLACE', orderId: 'o9', to: { truckId: 'T02', loadId: 'B1', position: 1 } }, 'c9');
    expect(after(on, 'T02')).toEqual([['c5', 'c9', 'c6']]);
    expect(on.ok && on.edit.edited).toEqual(['T02']);
    const idle = run({ kind: 'PLACE', orderId: 'o9', to: { truckId: 'T03', loadId: null, before: null } }, 'c9');
    expect(idle.ok && idle.edit.before.get('T03')).toEqual([]);
    expect(after(idle, 'T03')).toEqual([['c9']]);
  });

  it('refuses a change that changes nothing, and an unknown load', () => {
    expect(run({ kind: 'MOVE', from: { loadId: 'A1', sequence: 2 }, to: { truckId: 'T01', loadId: 'A1', position: 1 } }, 'c2')).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    expect(run({ kind: 'MOVE', from: { loadId: 'A2', sequence: 1 }, to: { truckId: 'T01', loadId: 'A2', position: 'BEST' } }, 'c4')).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    expect(run({ kind: 'MOVE', from: { loadId: 'A2', sequence: 1 }, to: { truckId: 'T01', loadId: null, before: null } }, 'c4')).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    expect(run({ kind: 'MOVE', from: { loadId: 'A1', sequence: 1 }, to: { truckId: 'T02', loadId: 'ZZ', position: 0 } }, 'c1')).toMatchObject({ ok: false, code: 'UNKNOWN_LOAD' });
    expect(run({ kind: 'REMOVE', from: { loadId: 'A1', sequence: 1 } }, 'c9')).toMatchObject({ ok: false, code: 'UNKNOWN_LOAD' });
  });

  it('a best place the solver found resolves to a change that gives exactly its loads (what a save sends)', () => {
    const move: PlanEditMove = { kind: 'MOVE', from: { loadId: 'A2', sequence: 1 }, to: { truckId: 'T02', loadId: 'B1', position: 'BEST' } };
    const first = run(move, 'c4');
    if (!first.ok) throw new Error('no edit');
    const resolved = resolvedMoveOf(move, first.edit, { load_index: 0, new_load_at: null, position: 1 });
    expect(resolved).toEqual({ ...move, to: { truckId: 'T02', loadId: 'B1', position: 1 } });
    expect(after(run(resolved, 'c4'), 'T02')).toEqual([['c5', 'c4', 'c6']]);
    const bestNew: PlanEditMove = { ...move, to: { truckId: 'T01', loadId: null, before: 'BEST' } };
    const second = run(bestNew, 'c4');
    if (!second.ok) throw new Error('no edit');
    // T01 without c4: [[c1, c2, c3]] (its L2 is gone), so a new load at 0 goes before A1, at 1 after it.
    expect(resolvedMoveOf(bestNew, second.edit, { load_index: null, new_load_at: 0, position: 0 })).toMatchObject({ to: { truckId: 'T01', loadId: null, before: 'A1' } });
    expect(resolvedMoveOf(bestNew, second.edit, { load_index: null, new_load_at: 1, position: 0 })).toMatchObject({ to: { truckId: 'T01', loadId: null, before: null } });
  });

  it('a best place where the stop already is: NO_CHANGE, never a solver failure (review F1/M-01); an option off its own loads: MISMATCH', () => {
    // The dialog's default: the stop's own load, Best place. c2 sits at index 1 of A1 and the solver finds it best there.
    const own: PlanEditMove = { kind: 'MOVE', from: { loadId: 'A1', sequence: 2 }, to: { truckId: 'T01', loadId: 'A1', position: 'BEST' } };
    const asked = run(own, 'c2');
    if (!asked.ok) throw new Error('no edit');
    expect(asked.edit.best).toEqual({ stop_id: 'c2', truck_id: 'T01', load_index: 0 });
    const opt = (position: number, loads: string[][]) => ({ truck_id: 'T01', load_index: 0, new_load_at: null, position, loads });
    expect(resolveBestPlace(own, asked.edit, opt(1, [['c1', 'c2', 'c3'], ['c4']]), planned, 'c2', truckOf)).toEqual({ ok: false, code: 'NO_CHANGE' });
    const elsewhere = resolveBestPlace(own, asked.edit, opt(0, [['c2', 'c1', 'c3'], ['c4']]), planned, 'c2', truckOf);
    expect(elsewhere.ok && elsewhere.move).toEqual({ ...own, to: { truckId: 'T01', loadId: 'A1', position: 0 } });
    expect(elsewhere.ok && elsewhere.edit.after.get('T01')).toEqual([['c2', 'c1', 'c3'], ['c4']]);
    expect(resolveBestPlace(own, asked.edit, opt(0, [['c1', 'c2', 'c3'], ['c4']]), planned, 'c2', truckOf)).toEqual({ ok: false, code: 'MISMATCH' });
    // The only stop of a truck's last load, best place as a new load: the end of the day is where it is.
    const lone: PlanEditMove = { kind: 'MOVE', from: { loadId: 'A2', sequence: 1 }, to: { truckId: 'T01', loadId: null, before: 'BEST' } };
    const loneEdit = run(lone, 'c4');
    if (!loneEdit.ok) throw new Error('no edit');
    expect(resolveBestPlace(lone, loneEdit.edit, { truck_id: 'T01', load_index: null, new_load_at: 1, position: 0, loads: [['c1', 'c2', 'c3'], ['c4']] }, planned, 'c4', truckOf)).toEqual({ ok: false, code: 'NO_CHANGE' });
  });

  it("counts the stops a check sends (before, after and a best-place stop once each) against the solver's 80", () => {
    const r = run({ kind: 'MOVE', from: { loadId: 'A1', sequence: 3 }, to: { truckId: 'T02', loadId: 'B1', position: 'BEST' } }, 'c3');
    if (!r.ok) throw new Error('no edit');
    expect(retimeStopCount(r.edit)).toBe(6);
    expect(RETIME_MAX_STOPS).toBe(80);
  });
});

describe('mergeSolverReport: the option\'s findings with the edited trucks checked again', () => {
  const v = (truck_id: string, load_no: number | null, code = 'HARD_WINDOW') => ({ code, truck_id, load_no, message: `${truck_id} ${code}` }) as FeasibilityReport['violations'][number];
  const edited = new Set(['T01']);
  const replaced = new Set(['T01:2']);
  it('VERIFIED + VERIFIED is VERIFIED / EXACT', () => {
    expect(mergeSolverReport({ status: 'VERIFIED', timing: 'EXACT', violations: [] }, { status: 'VERIFIED', timing: 'EXACT', violations: [] }, edited, replaced)).toMatchObject({ status: 'VERIFIED', timing: 'EXACT', violations: [] });
  });
  it('a finding of another truck stays (VIOLATED); one on an edited truck\'s replaced load or truck day goes; one on its frozen load stays', () => {
    const r = mergeSolverReport({ status: 'VIOLATED', timing: 'EXACT', violations: [v('T02', 1), v('T01', 2), v('T01', null, 'TRIPS'), v('T01', 1)] }, { status: 'VERIFIED', timing: 'EXACT', violations: [] }, edited, replaced);
    expect(r?.status).toBe('VIOLATED');
    expect(r?.violations.map((x) => `${x.truck_id}:${x.load_no}`)).toEqual(['T02:1', 'T01:1']);
    expect(mergeSolverReport({ status: 'VIOLATED', timing: 'EXACT', violations: [v('T01', 2)] }, { status: 'VERIFIED', timing: 'EXACT', violations: [] }, edited, replaced)?.status).toBe('VERIFIED');
  });
  it('UNVERIFIED on either side, or no report on the option, stays UNVERIFIED; EXACT only when both are', () => {
    expect(mergeSolverReport({ status: 'UNVERIFIED', timing: 'ESTIMATED', violations: [] }, { status: 'VERIFIED', timing: 'EXACT', violations: [] }, edited, replaced)?.status).toBe('UNVERIFIED');
    expect(mergeSolverReport({ status: 'VERIFIED', timing: 'EXACT', violations: [] }, { status: 'UNVERIFIED', timing: 'EXACT', violations: [] }, edited, replaced)?.status).toBe('UNVERIFIED');
    expect(mergeSolverReport(null, { status: 'VERIFIED', timing: 'EXACT', violations: [] }, edited, replaced)?.status).toBe('UNVERIFIED');
    expect(mergeSolverReport({ status: 'VERIFIED', timing: 'ESTIMATED', violations: [] }, { status: 'VERIFIED', timing: 'EXACT', violations: [] }, edited, replaced)?.timing).toBe('ESTIMATED');
  });
});

describe('mergeOption: the option in use with the edited trucks re-timed', () => {
  const lines2 = [{ lineId: 'l7', cases: 60 }];
  const copied = {
    name: 'RECOMMENDED', status: 'OPTIMIZED', trips: 3, trucks_used: 2, operating_cost: 60, total_distance_km: 90, total_duration_min: 720,
    loads: [
      plannedLoad('T01', 1, [{ stop_id: 'c1', order_ids: ['o1'] }]), // locked since the solve: kept
      plannedLoad('T01', 2, [{ stop_id: 'c7#2', order_ids: ['o7~2'] }, { stop_id: 'c2', order_ids: ['o2'] }]),
      plannedLoad('T02', 1, [{ stop_id: 'c7#1', order_ids: ['o7~1'] }], { total_cost: 25, distance_km: 40 }),
    ],
    truck_days: [{ truck_id: 'T01', loads: 2, paid_min: 300 }, { truck_id: 'T02', loads: 1, paid_min: 200 }],
    warnings: ['The MIN TRUCKS option serves 2 more stop(s) than this plan. Review it under Plan options and choose \'Use instead\' if it suits.', 'kept warning'],
    feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
    scope: {
      orderIds: ['o1', 'o2', 'o7', 'o8'], frozenOrderIds: [], orderPriority: {},
      portions: { 'o7~1': { orderId: 'o7', lines: [{ lineId: 'l7', cases: 40 }], cases: 40, weightKg: 0, part: 1, parts: 2 }, 'o7~2': { orderId: 'o7', lines: lines2, cases: 60, weightKg: 0, part: 2, parts: 2 } },
      palletUnits: { o1: 100, o2: 200, 'o7~1': 300, 'o7~2': 400 },
    },
    engine: 'test', matrix_provider: 'HAVERSINE', distance_is_estimated: true, response_warnings: [],
  } as unknown as ScenarioDetails;
  const manual: ManualEdit = { v: 1, at: '2026-10-24T10:00:00.000Z', byUserId: 'u1', parentRunId: 'run-0', count: 1, move: { kind: 'REMOVE', from: { loadId: 'x', sequence: 1 } }, trucks: ['T01'], builtAt: '2026-10-24T09:59:00.000Z', matrix: { provider: 'HAVERSINE', quality: 'ESTIMATED' }, previewHash: 'h', preferenceApprox: true };
  // T01's L2 is re-timed: its split part (today numbered o7~open, mapped back to o7~2) and another part of o7
  // that today's request numbers o7~1 - the id of T02's part in the option, with other lines: it gets a new id.
  const sc = {
    loads: [plannedLoad('T01', 2, [{ stop_id: 'c2', order_ids: ['o2'] }, { stop_id: 'c7', order_ids: ['o7~open'] }, { stop_id: 'c7#9', order_ids: ['o7~1'] }], { total_cost: 18, distance_km: 25 })],
    truck_days: [{ truck_id: 'T01', loads: 1, paid_min: 250 }],
    feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
  } as unknown as DispatchScenario;
  const fresh = {
    portions: { 'o7~open': { orderId: 'o7', lines: lines2, cases: 60, weightKg: 0, part: null, parts: null }, 'o7~1': { orderId: 'o7', lines: [{ lineId: 'l9', cases: 5 }], cases: 5, weightKg: 0, part: 1, parts: 2 } },
    palletUnits: { o2: 210, 'o7~open': 410, 'o7~1': 50 },
  };
  const out = mergeOption({
    copied, sc, edited: new Set(['T01']), replacedKeys: new Set(['T01:2']), refMap: new Map([['o7~open', 'o7~2'], ['o2', 'o2']]), freshScope: fresh,
    frozenTruckIds: ['T01'], truckOrder: ['T01', 'T02'], manual, warning: 'Changed by hand by Planner at 14:00: Move X.',
    unserved: { placedOrderIds: [], removed: null },
  });
  const d = out.details;

  it('replaces only the edited trucks\' PLANNED loads; a load locked since the solve and the other trucks stay', () => {
    expect(d.loads.map((l) => `${l.truck_id}:${l.load_no}`)).toEqual(['T01:1', 'T01:2', 'T02:1']);
    expect(d.loads[1]!.total_cost).toBe(18);
    expect(d.loads[2]).toEqual(copied.loads[2]);
    expect(d.truck_days?.map((t) => [t.truck_id, t.paid_min])).toEqual([['T01', 250], ['T02', 200]]);
  });

  it('every ref resolves to its row\'s order and lines (critic M3): mapped back, or added under a new id when it would clash', () => {
    const refs = out.loads[0]!.stops.flatMap((s) => s.order_ids);
    expect(refs).toEqual(['o2', 'o7~2', 'o7~m1']);
    expect(resolveOrderRef(d.scope, 'o7~2')).toEqual({ orderId: 'o7', portion: fresh.portions['o7~open'] });
    expect(resolveOrderRef(d.scope, 'o7~m1')).toEqual({ orderId: 'o7', portion: fresh.portions['o7~1'] });
    // The untouched truck's part keeps its record.
    expect(resolveOrderRef(d.scope, 'o7~1').portion).toEqual(copied.scope.portions!['o7~1']);
    expect(d.scope.palletUnits).toMatchObject({ o1: 100, o2: 210, 'o7~2': 410, 'o7~m1': 50, 'o7~1': 300 });
  });

  it('counts the totals again over the merged loads, the physical trucks with the frozen ones', () => {
    expect(d.trips).toBe(3);
    expect(d.operating_cost).toBe(63);
    expect(d.total_distance_km).toBe(95);
    expect(d.trucks_used).toBe(2);
    expect(d.paid_driver_min).toBe(450);
  });

  it('drops the "Use instead" note (one option in the child), adds the manual line and block, merges the report', () => {
    expect(d.warnings).toEqual(['kept warning', 'Changed by hand by Planner at 14:00: Move X.']);
    expect(manualOf(d)).toEqual(manual);
    expect(d.feasibility?.status).toBe('VERIFIED');
    expect(manualOf({})).toBeNull();
  });

  it("keeps the option's unserved stops when nothing is put on or taken off", () => {
    expect(d.unserved).toEqual(copied.unserved ?? []);
  });
});

describe('mergeOption: the unserved stops follow the change (review F2: the hire box reads them, not the rows)', () => {
  const base = {
    name: 'RECOMMENDED', status: 'OPTIMIZED', trips: 1, trucks_used: 1,
    loads: [plannedLoad('T01', 1, [{ stop_id: 'c1', order_ids: ['o1'] }, { stop_id: 'c7#1', order_ids: ['o7~1'] }])],
    truck_days: [{ truck_id: 'T01', loads: 1, paid_min: 300 }],
    unserved: [
      { stop_id: 'c9', order_ids: ['o9', 'o10'], reason_code: 'NO_AVAILABLE_TRUCK', reason_message: 'Fleet capacity shortage' },
      { stop_id: 'c8', order_ids: ['o8'], reason_code: 'SOLVER_DROPPED_LOW_PRIORITY', reason_message: 'x' },
    ],
    warnings: [], feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
    scope: { orderIds: ['o1', 'o7', 'o8', 'o9', 'o10'], frozenOrderIds: [], orderPriority: {}, portions: { 'o7~1': portion('o7', [{ lineId: 'l7', cases: 40 }], 1) } },
  } as unknown as ScenarioDetails;
  const manual = { v: 1, at: 'a', byUserId: 'u', parentRunId: 'p', count: 1, move: { kind: 'REMOVE', from: { loadId: 'x', sequence: 1 } }, trucks: ['T01'], builtAt: 'b', matrix: { provider: 'H', quality: 'ESTIMATED' }, previewHash: 'h', preferenceApprox: true } as ManualEdit;
  const merge = (sc: DispatchScenario, unserved: Parameters<typeof mergeOption>[0]['unserved'], refMap = new Map<string, string>(), portions: Record<string, PortionRecord> = {}) =>
    mergeOption({ copied: base, sc, edited: new Set(['T01']), replacedKeys: new Set(['T01:1']), refMap, freshScope: { portions }, frozenTruckIds: [], truckOrder: ['T01'], manual, warning: 'w', unserved }).details;

  it('PLACE: the orders put on a truck leave the list (the rest of the entry stays)', () => {
    const sc = { loads: [plannedLoad('T01', 1, [{ stop_id: 'c1', order_ids: ['o1'] }, { stop_id: 'c7#1', order_ids: ['o7~1'] }, { stop_id: 'c9', order_ids: ['o9', 'o10'] }])], truck_days: [], feasibility: null } as unknown as DispatchScenario;
    expect(merge(sc, { placedOrderIds: ['o9', 'o10'], removed: null }, new Map([['o7~1', 'o7~1']])).unserved).toEqual([base.unserved[1]]);
    expect(merge(sc, { placedOrderIds: ['o9'], removed: null }, new Map([['o7~1', 'o7~1']])).unserved.map((u) => [u.stop_id, u.order_ids])).toEqual([['c9', ['o10']], ['c8', ['o8']]]);
  });

  it("REMOVE: the stop joins the list as REMOVED_BY_HAND, its split part under the option's own ref (never a capacity reason)", () => {
    const sc = { loads: [plannedLoad('T01', 1, [{ stop_id: 'c1', order_ids: ['o1'] }])], truck_days: [], feasibility: null } as unknown as DispatchScenario;
    const fresh = { 'o7~open': portion('o7', [{ lineId: 'l7', cases: 40 }]) };
    const out = merge(sc, { placedOrderIds: [], removed: { stop_id: 'c7#1', order_ids: ['o7~open'], reason_message: 'Taken off the plan by hand (P).' } }, new Map([['o1', 'o1'], ['o7~open', 'o7~1']]), fresh);
    expect(out.unserved.at(-1)).toEqual({ stop_id: 'c7#1', order_ids: ['o7~1'], reason_code: 'REMOVED_BY_HAND', reason_message: 'Taken off the plan by hand (P).' });
    expect(resolveOrderRef(out.scope, 'o7~1')).toEqual({ orderId: 'o7', portion: fresh['o7~open'] });
    expect(out.unserved.slice(0, 2)).toEqual(base.unserved);
  });
});

describe('editBasis: the stale check covers the touched trucks only (critic M2)', () => {
  const stops = [stop('c1', ['o1']), stop('c2', ['o2']), stop('c9', ['o9'])];
  const loads = [load('L1', 'T01', 1, [row('o1', 1), row('o2', 2)]), load('L2', 'T02', 1, [row('o9', 1)])];
  const base = (req: DispatchRequest, l: EditLoad[] = loads) => editBasis({ request: req, edited: ['T01'], stopIds: ['c1', 'c2'], loads: l, chosenScenarioId: 'sc-1', unserved: [] });
  const req = request(stops);

  it('is the same when another truck\'s stop, a stop of no edited truck or a clock setting changes', () => {
    const elsewhere = request([stops[0]!, stops[1]!, stop('c9', ['o9', 'o10'])]);
    expect(base(elsewhere)).toBe(base(req));
    expect(base({ ...req, config: { ...req.config, shift_start_min: 600, loading_from_min: 610 } })).toBe(base(req));
    expect(base(req, [loads[0]!, load('L2', 'T02', 1, [row('o9', 1)], 'LOCKED')])).toBe(base(req));
  });

  it('changes with an edited truck\'s locked trip, its stop data, its rows, a setting or the option in use', () => {
    expect(base(request(stops, [{ id: 'T01', frozen: 1 }, { id: 'T02' }]))).not.toBe(base(req));
    expect(base(request([stop('c1', ['o1'], { hard_end_min: 900 }), stops[1]!, stops[2]!]))).not.toBe(base(req));
    expect(base(req, [load('L1', 'T01', 1, [row('o1', 1)], 'LOCKED'), loads[1]!])).not.toBe(base(req));
    expect(base({ ...req, config: { ...req.config, shift_max_min: 660 } })).not.toBe(base(req));
    expect(editBasis({ request: req, edited: ['T01'], stopIds: ['c1', 'c2'], loads, chosenScenarioId: 'sc-2', unserved: [] })).not.toBe(base(req));
  });
});

describe('previewHash', () => {
  const answer = {
    ok: true, matrix_provider: 'HAVERSINE', distance_quality: 'ESTIMATED', distance_is_estimated: true,
    trucks: [{ truck_id: 'T01', feasible: true, violations: [], loads: 1 }],
    scenario: { loads: [plannedLoad('T01', 1, [{ stop_id: 'c1', order_ids: ['o1'] }])] },
  } as unknown as RetimeResponse;
  const input = { basis: 'b', builtAt: '2026-10-24T10:00:00.000Z', move: { kind: 'REMOVE', from: { loadId: 'L1', sequence: 2 } } as PlanEditMove, truckDays: [{ truck_id: 'T01', loads: [['c1']] }], answer };
  it('is stable across key order and changes with the move, a time or a cost', () => {
    expect(previewHash(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(previewHash({ ...input, move: { from: { sequence: 2, loadId: 'L1' }, kind: 'REMOVE' } as PlanEditMove })).toBe(previewHash(input));
    expect(previewHash({ ...input, move: { kind: 'REMOVE', from: { loadId: 'L1', sequence: 3 } } })).not.toBe(previewHash(input));
    const later = { ...answer, scenario: { loads: [plannedLoad('T01', 1, [{ stop_id: 'c1', order_ids: ['o1'] }], { depart_min: 370 })] } } as unknown as RetimeResponse;
    expect(previewHash({ ...input, answer: later })).not.toBe(previewHash(input));
    const dearer = { ...answer, scenario: { loads: [plannedLoad('T01', 1, [{ stop_id: 'c1', order_ids: ['o1'] }], { total_cost: 21 })] } } as unknown as RetimeResponse;
    expect(previewHash({ ...input, answer: dearer })).not.toBe(previewHash(input));
    expect(previewHash({ ...input, builtAt: '2026-10-24T10:01:00.000Z' })).not.toBe(previewHash(input));
  });
});

describe('what changed since planning, and the words', () => {
  it('names the hours and unloading time of a stop and a setting changed since planning', () => {
    const L = load('L1', 'T01', 1, [row('o1', 1)]);
    const out = dataChangedSince({
      stops: planStopsOf(L),
      stopOf: new Map([[stopKeyOf('L1', 1), 'c1']]),
      request: request([stop('c1', ['o1'], { hard_start_min: 540, service_min: 25 })]),
      promised: undefined,
      trucks: [],
      plannedConfig: { shift_max_min: 540, reload_min: 30, search_mode: 'THOROUGH', osrm_configured: true },
    });
    expect(out.map((x) => x.text)).toEqual([
      expect.stringMatching(/^Receiving hours changed since planning: now receives 09:00–18:00 \(planned with 06:00–18:00\): re-timed with today's data\.$/),
      "Unloading time now 25 min (planned with 15 min): re-timed with today's data.",
      'Longest shift (min) now 600 (planned with 540).',
    ]);
    expect(out[0]!.label).toBe('Customer O1 (O1)');
  });

  it('relabels the solver\'s stop and truck ids, and prints positions, money and the toast', () => {
    expect(relabel('Stop cuX#1 late at cuX#10 on T1', new Map([['cuX#1', 'A'], ['cuX#10', 'B']]))).toBe('Stop A late at B on T1');
    expect(positionChoices(['C1', 'C2']).map((p) => p.label)).toEqual(['Best place', 'First (before C1)', 'After C1 (before C2)', 'Last (after C2)']);
    expect(positionChoices([])).toEqual([{ value: 'BEST', label: 'Best place' }, { value: 0, label: 'Only stop' }]);
    expect(signedOmr(2.104)).toBe('+2.10');
    expect(signedOmr(-6.156)).toBe('−6.16');
    expect(windowText(null, null)).toBe('any time');
    expect(windowText(540, 1020)).toBe('09:00–17:00');
    expect(savedText({ runId: 'r', version: 4, reprint: ['T08 L1'], gone: [], trucks: ['T08'] })).toBe(
      'Saved as version 4. Print the sheets again for T08 L1 (load sheet, driver sheet) and send the driver link of T08 again if you already sent it. A RE-PLAN plans unlocked loads again and may undo this change: lock the load to keep it.',
    );
    // The only stop of a truck taken off: nothing to print, its load's sheets void (review M-02: no broken sentence).
    expect(savedText({ runId: 'r', version: 4, reprint: [], gone: ['T03 L1'], trucks: ['T03'] })).toBe(
      'Saved as version 4. Send the driver link of T03 again if you already sent it. T03 L1 is no longer in the plan: throw away its printed sheets. A RE-PLAN plans unlocked loads again and may undo this change: lock the load to keep it.',
    );
    expect(savedText({ runId: 'r', version: 5, reprint: ['T01 L1'], gone: ['T01 L2', 'T01 L3'], trucks: [] })).toBe(
      'Saved as version 5. Print the sheets again for T01 L1 (load sheet, driver sheet). T01 L2, T01 L3 are no longer in the plan: throw away their printed sheets. A RE-PLAN plans unlocked loads again and may undo this change: lock the load to keep it.',
    );
  });

  it('the dialog\'s choices make the change the API takes', () => {
    const l = { id: 'L1', truckId: 'T01', loadNo: 1, stops: [] } as never;
    const st = { sequence: 2 } as never;
    const subject = { kind: 'MOVE' as const, load: l, stop: st };
    expect(moveOfChoices(subject, 'T02', 'load:L9', 'BEST')).toEqual({ kind: 'MOVE', from: { loadId: 'L1', sequence: 2 }, to: { truckId: 'T02', loadId: 'L9', position: 'BEST' } });
    expect(moveOfChoices(subject, 'T02', 'new:before:L9', 'BEST')).toEqual({ kind: 'MOVE', from: { loadId: 'L1', sequence: 2 }, to: { truckId: 'T02', loadId: null, before: 'L9' } });
    expect(moveOfChoices(subject, 'T02', 'new:best', 0)).toMatchObject({ to: { loadId: null, before: 'BEST' } });
    expect(moveOfChoices(subject, 'T02', 'remove', 0)).toEqual({ kind: 'REMOVE', from: { loadId: 'L1', sequence: 2 } });
    expect(moveOfChoices(subject, 'T02', '', 0)).toBeNull();
    const place = { kind: 'PLACE' as const, unserved: { orderId: 'o9' } as never, orders: 1, cases: 10 };
    expect(moveOfChoices(place, 'T02', 'new:end', 'BEST')).toEqual({ kind: 'PLACE', orderId: 'o9', to: { truckId: 'T02', loadId: null, before: null } });
    expect(moveOfChoices(place, 'T02', 'remove', 'BEST')).toBeNull();
  });
});

describe('migration 20261024120000_unserved_removed_by_hand', () => {
  it('adds the one enum value REMOVED_BY_HAND and nothing else; schema.prisma and the reason labels agree', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const web = path.resolve(__dirname, '../..');
    const sql = readFileSync(path.join(web, 'prisma', 'migrations', '20261024120000_unserved_removed_by_hand', 'migration.sql'), 'utf8');
    const statements = sql.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));
    expect(statements).toEqual([`ALTER TYPE "UnservedReasonCode" ADD VALUE 'REMOVED_BY_HAND';`]);
    const schema = readFileSync(path.join(web, 'prisma', 'schema.prisma'), 'utf8');
    const reasons = schema.slice(schema.indexOf('enum UnservedReasonCode'), schema.indexOf('}', schema.indexOf('enum UnservedReasonCode')));
    expect(reasons).toMatch(/\n\s+REMOVED_BY_HAND\r?\n/);
    const { REASON_TEXT } = await import('@/app/t/[slug]/dispatch/client-api');
    expect(REASON_TEXT.REMOVED_BY_HAND).toBe('Taken off the plan by hand');
    // Never a capacity reason: a stop taken off by hand never starts a hire check.
    const { CAPACITY_REASONS } = await import('@/lib/dispatch/hire');
    expect(CAPACITY_REASONS).not.toContain('REMOVED_BY_HAND');
  });
});

describe('previewOf: the result a Check shows (review M-03, M-04, F5)', () => {
  // T01 L1: c1 (outside its preferred hours as planned) and c2; T02 L1: c3. c2 moves to T02 after c3.
  const L1 = load('L1', 'T01', 1, [{ ...row('o1', 1), prefWindowOk: false }, row('o2', 2)]);
  const L2 = load('L2', 'T02', 1, [row('o3', 1)]);
  const loads = [L1, L2];
  const planStops = [...planStopsOf(L1), ...planStopsOf(L2)];
  const stopOf = new Map([[stopKeyOf('L1', 1), 'c1'], [stopKeyOf('L1', 2), 'c2'], [stopKeyOf('L2', 1), 'c3']]);
  const planned = new Map<string, PlannedDayLoad[]>([['T01', [{ loadId: 'L1', stops: ['c1', 'c2'] }]], ['T02', [{ loadId: 'L2', stops: ['c3'] }]]]);
  const truckOf = (id: string) => loads.find((l) => l.id === id)?.truckId ?? null;
  const names = new Map(planStops.map((p) => [stopOf.get(stopKeyOf(p.loadId, p.sequence))!, p.label]));
  const built = { request: request([stop('c1', ['o1']), stop('c2', ['o2']), stop('c3', ['o3'])]), promised: undefined } as unknown as BuiltRequest;
  const pref = (l: PlannedLoad, outside: string[]) => ({ ...l, stops: l.stops.map((s) => ({ ...s, pref_window_ok: !outside.includes(s.stop_id) })) });
  const answer = (over: Partial<RetimeResponse> = {}): RetimeResponse =>
    ({
      ok: true, matrix_provider: 'HAVERSINE', distance_quality: 'ESTIMATED', distance_is_estimated: true,
      trucks: [
        { truck_id: 'T01', feasible: true, violations: [], loads: 1, money_omr: 18, km: 20, last_return_min: 560, before: { feasible: true, violations: [], loads: 1, money_omr: 20.004, km: 25, last_return_min: 600 }, delta_money_omr: -2.004, delta_km: -5, delta_last_return_min: -40 },
        { truck_id: 'T02', feasible: true, violations: [], loads: 1, money_omr: 13.504, km: 17.3, last_return_min: 640, before: { feasible: true, violations: [], loads: 1, money_omr: 10, km: 10, last_return_min: 600 }, delta_money_omr: 3.504, delta_km: 7.3, delta_last_return_min: 40 },
      ],
      scenario: {
        loads: [pref(plannedLoad('T01', 1, [{ stop_id: 'c1', order_ids: ['o1'] }]), ['c1']), pref(plannedLoad('T02', 1, [{ stop_id: 'c3', order_ids: ['o3'] }, { stop_id: 'c2', order_ids: ['o2'] }]), ['c3', 'c2'])],
        truck_days: [{ truck_id: 'T02', overtime_min: 10 }],
      },
      options: [], delta_money_omr: 1.5, delta_soft_omr: 0.5, delta_km: 2.3, warnings: [],
      ...over,
    }) as unknown as RetimeResponse;
  function preview(opts: { move?: PlanEditMove; moved?: string; answer?: RetimeResponse; mode?: PlanEditMode; roadPlan?: boolean } = {}) {
    const move: PlanEditMove = opts.move ?? { kind: 'MOVE', from: { loadId: 'L1', sequence: 2 }, to: { truckId: 'T02', loadId: 'L2', position: 1 } };
    const moved = opts.moved ?? 'c2';
    const e = editTruckDays(move, planned, moved, truckOf);
    if (!e.ok) throw new Error(e.message);
    return previewOf({
      mode: opts.mode ?? 'ON', run: { version: 3 } as RunPlan, built, details: { inputs: null, distance_is_estimated: !opts.roadPlan } as unknown as ScenarioDetails,
      loads, edited: e.edit.edited, edit: e.edit, move, asked: move, askedEdit: e.edit, movedStop: moved, names, truckCodes: new Map([['T01', 'T01'], ['T02', 'T02'], ['T03', 'T03']]),
      answer: opts.answer ?? answer(), planStops, stopOf, hash: 'h'.repeat(64), builtAt: '2026-10-24T10:00:00.000Z',
    });
  }

  it('warns of what the change makes worse only, and can be saved', () => {
    const p = preview();
    expect(p.title).toBe('Move Customer O2 (O2) from T01 L1, stop 2 to T02 L1, stop 2');
    expect(p.warnings).toEqual([
      'Day cost of T01 and T02: 30.00 -> 31.50 OMR (+1.50).',
      '2.3 km more.',
      'Preferred hours and early delivery are kept less well (worse by 0.50, OMR-equivalent, not money).',
      'T02 works 10 min overtime.',
      // c3 was inside its preferred hours as planned, c2 is the stop moved; c1 was already outside: not news.
      'Customer O3 (O3) is reached outside its preferred hours (06:40).',
      'Customer O2 (O2) is reached outside its preferred hours (07:10).',
    ]);
    expect([p.ok, p.canSave, p.saveNote, p.deltaCostOmr]).toEqual([true, true, null, 1.5]);
  });

  it('"now" shows the stored figures as planned and the solver\'s before, timed now, that the change is counted from (M-04)', () => {
    const [t1, t2] = preview().trucks;
    expect([t1!.before.costOmr, t1!.before.km, t1!.before.lastReturnMin]).toEqual([20, 30, 600]);
    expect(t1!.before.timedNow).toEqual({ costOmr: 20, km: 25, lastReturnMin: 600 });
    expect(t2!.before.timedNow).toEqual({ costOmr: 10, km: 10, lastReturnMin: 600 });
    expect(t1!.after?.timedNow).toBeUndefined();
    expect([t1!.deltaCostOmr, t1!.deltaLastReturnMin]).toEqual([-2.004, -40]);
    // Current loads that no longer keep the rules: said (never blocking), and nothing timed now to count from.
    const broken = answer();
    broken.trucks[0]!.before = { feasible: false, violations: [{ code: 'HARD_WINDOW', truck_id: 'T01', load_no: 1, stop_id: 'c1', message: 'c1 starts 12 min late.' } as never], loads: 1, money_omr: null };
    const p = preview({ answer: broken });
    expect(p.trucks[0]!.before.timedNow).toBeNull();
    expect(p.warnings).toContain("T01's current loads no longer keep the rules with today's data: Customer O1 (O1) starts 12 min late.");
  });

  it('cannot be saved: a broken rule, checking only, or a plan on road distances checked on straight lines (ROADS_DOWN)', () => {
    const refused = preview({ answer: answer({ ok: false }) });
    expect([refused.ok, refused.canSave, refused.saveNote]).toEqual([false, false, 'Cannot be saved: it breaks the rules above.']);
    expect([preview({ mode: 'CHECK' }).canSave, preview({ mode: 'CHECK' }).saveNote]).toEqual([false, EDIT_ERROR_TEXT.CHECK_ONLY]);
    expect([preview({ roadPlan: true }).canSave, preview({ roadPlan: true }).saveNote]).toEqual([false, EDIT_ERROR_TEXT.ROADS_DOWN]);
    expect(preview({ roadPlan: true, answer: answer({ distance_quality: 'ROAD' }) }).canSave).toBe(true);
  });

  it('a truck with no load today used for this change alone is said; the other best places never include the stop\'s current place', () => {
    const place: PlanEditMove = { kind: 'PLACE', orderId: 'o9', to: { truckId: 'T03', loadId: null, before: null } };
    const placed = answer({
      trucks: [{ truck_id: 'T03', feasible: true, violations: [], loads: 1, money_omr: 25, km: 12, last_return_min: 500, before: { feasible: true, violations: [], loads: 0, money_omr: 0, km: 0, last_return_min: null }, delta_money_omr: 25, delta_km: 12, delta_last_return_min: null }],
      scenario: { loads: [plannedLoad('T03', 1, [{ stop_id: 'c9', order_ids: ['o9'] }])], truck_days: [] } as never,
      delta_money_omr: 25, delta_soft_omr: 0, delta_km: 12,
    });
    const p = preview({ move: place, moved: 'c9', answer: placed });
    expect(p.warnings).toContain('T03 is used today for this change alone: its day cost (fixed cost, driver) counts.');
    expect(p.title).toBe('Put the stop on T03, a new load after its last load');
    // Own load, best place: the solver's second place is where c2 is now - not offered.
    const own: PlanEditMove = { kind: 'MOVE', from: { loadId: 'L1', sequence: 2 }, to: { truckId: 'T01', loadId: 'L1', position: 'BEST' } };
    const opt = (position: number, stops: string[], money: number) => ({ truck_id: 'T01', load_index: 0, new_load_at: null, position, loads: [stops], money_omr: money, soft_omr: 0, km: 20, last_return_min: 590 });
    const withOptions = answer({ options: [opt(0, ['c2', 'c1'], 19), opt(1, ['c1', 'c2'], 20)], trucks: [answer().trucks[0]!] });
    expect(preview({ move: own, answer: withOptions }).options).toEqual([]);
  });
});

describe('callRetimeTruckDays: what the solver answered, never an exception (review M-03)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  const body = { request: request([stop('c1', ['o1'])]), truck_days: [{ truck_id: 'T01', loads: [['c1']] }] } as RetimeRequest;
  const reply = (status: number, text: string) => vi.fn(async () => new Response(text, { status }));

  it('not configured: no request', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    vi.stubEnv('SOLVER_URL', '');
    vi.stubEnv('SOLVER_TOKEN', '');
    expect(await callRetimeTruckDays(body)).toEqual({ kind: 'not_configured' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('an answer; 404 outdated; 503 busy; 422 with its detail; a redirect never followed; not JSON; a network error; a timeout', async () => {
    vi.stubEnv('SOLVER_URL', 'http://solver.test');
    vi.stubEnv('SOLVER_TOKEN', 'tok');
    const ok = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ ok: true, trucks: [] }), { status: 200 }));
    vi.stubGlobal('fetch', ok);
    expect(await callRetimeTruckDays(body)).toEqual({ kind: 'answer', body: { ok: true, trucks: [] } });
    const [url, init] = ok.mock.calls[0]!;
    expect(url).toBe('http://solver.test/retime-truck-days');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', cache: 'no-store', headers: { 'X-Solver-Token': 'tok' } });
    expect(JSON.parse(String(init.body))).toEqual(body);
    vi.stubGlobal('fetch', reply(404, 'Not Found'));
    expect(await callRetimeTruckDays(body)).toEqual({ kind: 'outdated' });
    vi.stubGlobal('fetch', reply(503, JSON.stringify({ detail: 'Route checks busy: try again in a few seconds.' })));
    expect(await callRetimeTruckDays(body)).toEqual({ kind: 'busy' });
    vi.stubGlobal('fetch', reply(422, JSON.stringify({ detail: 'Unknown stop c9 in truck_days: it is not in the request.' })));
    expect(await callRetimeTruckDays(body)).toEqual({ kind: 'failed', status: 422, detail: 'Unknown stop c9 in truck_days: it is not in the request.' });
    vi.stubGlobal('fetch', reply(422, JSON.stringify({ detail: [{ loc: ['body'], msg: 'bad' }] })));
    expect(await callRetimeTruckDays(body)).toEqual({ kind: 'failed', status: 422, detail: '[{"loc":["body"],"msg":"bad"}]' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://elsewhere.test/' } })));
    expect(await callRetimeTruckDays(body)).toEqual({ kind: 'failed', status: 302, detail: null });
    vi.stubGlobal('fetch', reply(200, '<html>'));
    expect(await callRetimeTruckDays(body)).toEqual({ kind: 'failed', status: 200, detail: 'not JSON' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    expect(await callRetimeTruckDays(body)).toEqual({ kind: 'failed', status: 0, detail: null });
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))));
    expect(await callRetimeTruckDays(body, { timeoutMs: 20 })).toEqual({ kind: 'timeout' });
  });
});

describe('the dialog\'s "after" title (review M-08)', () => {
  it('names only the changes known, with one kind of minus sign', () => {
    expect(afterTitle({ truckCode: 'T08', deltaCostOmr: -6.156, deltaLastReturnMin: -20 })).toBe('T08 after (−6.16 OMR, back −20 min)');
    expect(afterTitle({ truckCode: 'T08', deltaCostOmr: -6.156, deltaLastReturnMin: null })).toBe('T08 after (−6.16 OMR)');
    expect(afterTitle({ truckCode: 'T08', deltaCostOmr: null, deltaLastReturnMin: 15 })).toBe('T08 after (back +15 min)');
    expect(afterTitle({ truckCode: 'T08', deltaCostOmr: null, deltaLastReturnMin: null })).toBe('T08 after');
  });
});

describe('a cases per pallet corrected since planning (PALLET_FACTOR_CHANGED, release review F1)', () => {
  const line = (id: string, orderId: string, cases: number, code: string, casesPerPallet: number | null) => ({ id, orderId, cases, product: { code, name: `Product ${code}`, casesPerPallet } });
  const whole = (orderId: string) => ({ orderId, portionLinesJson: null });

  it('a whole order: its lines against the factors the option was planned with', () => {
    const lines = [line('l1', 'o1', 35, 'P-1', 20), line('l2', 'o1', 10, 'P-2', 12)];
    expect(palletFactorsChangedSince({ rows: [whole('o1')], lines, plannedFactors: { 'P-1': 50, 'P-2': 12 } })).toEqual([{ code: 'P-1', name: 'Product P-1', planned: 50, now: 20 }]);
    expect(palletFactorsChangedSince({ rows: [whole('o1')], lines, plannedFactors: { 'P-1': 20, 'P-2': 12 } })).toEqual([]);
  });

  it("a split part: the factor it was cut with first, then the option's; only its own lines with cases", () => {
    const lines = [line('l1', 'o1', 300, 'P-1', 20), line('l2', 'o1', 40, 'P-2', 8)];
    const part = (cpp: number | null, extra: unknown[] = []) => ({ orderId: 'o1', portionLinesJson: [{ lineId: 'l1', cases: 150, ...(cpp ? { casesPerPallet: cpp } : {}) }, ...extra] });
    // Cut with today's figure: nothing to say, although the option was planned with another one.
    expect(palletFactorsChangedSince({ rows: [part(20)], lines, plannedFactors: { 'P-1': 50, 'P-2': 10 } })).toEqual([]);
    // Cut with the old figure.
    expect(palletFactorsChangedSince({ rows: [part(50)], lines, plannedFactors: {} })).toEqual([{ code: 'P-1', name: 'Product P-1', planned: 50, now: 20 }]);
    // No cut figure kept: the option's. P-2 is not on this part (or has no cases on it): never named.
    expect(palletFactorsChangedSince({ rows: [part(null, [{ lineId: 'l2', cases: 0 }])], lines, plannedFactors: { 'P-1': 50, 'P-2': 10 } })).toEqual([{ code: 'P-1', name: 'Product P-1', planned: 50, now: 20 }]);
  });

  it("no factor now (PALLET_FACTOR_REQUIRED says so) or none planned (it reads with today's anyway): nothing; one entry per product, by code", () => {
    const lines = [line('a', 'o1', 5, 'P-9', null), line('b', 'o1', 5, 'P-8', 6), line('c', 'o2', 5, 'P-3', 4), line('d', 'o3', 5, 'P-3', 4), line('e', 'o3', 5, 'P-2', 7)];
    const rows = [whole('o1'), whole('o2'), whole('o3'), whole('o-gone')];
    expect(palletFactorsChangedSince({ rows, lines, plannedFactors: { 'P-9': 10, 'P-3': 5, 'P-2': 9 } })).toEqual([
      { code: 'P-2', name: 'Product P-2', planned: 9, now: 7 },
      { code: 'P-3', name: 'Product P-3', planned: 5, now: 4 },
    ]);
  });

  it('the words name the products (at most five) and say to re-plan', () => {
    const one = palletFactorChangedText([{ code: 'P-1', name: 'Product One', planned: 50, now: 20 }]);
    expect(one).toBe('The cases per pallet changed under Products since this plan: P-1 (Product One) is now 20 (planned with 50). This change re-times loads that carry it: RE-PLAN the day first, so every load uses the new figure.');
    const many = palletFactorChangedText(Array.from({ length: 7 }, (_, i) => ({ code: `P-${i}`, name: '', planned: 10, now: 12 })));
    expect(many).toContain('P-4 is now 12 (planned with 10) and 2 more. This change re-times loads that carry them');
    expect(many).not.toContain('P-5');
  });
});
