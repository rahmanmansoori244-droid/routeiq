/**
 * Moves by hand, part 2 (owner feedback of 24 Oct 2026: whole loads, several stops at once, allow anyway): the
 * pure parts, without a database or a solver.
 *  - applyOps: every operation (several stops to a load or a new load, take off, a whole load moved, a swap), a
 *    change list (a stop moved twice, one taken off and named again), and the refusals (BEST only last, an
 *    order that is not the stops, a position for several stops, a swap with itself, an emptied target, a load
 *    before itself, more than 6 trucks); refs that are one stop are one (F7); the v2 best shapes;
 *  - resolveLayout / rewriteBest: the solver's place as an explicit change, MISMATCH, NO_EXPLICIT_PLACE;
 *  - the amber warnings (both parts of a split customer on one load, a hired truck left empty);
 *  - judgeIssue (F1, F2, F17): late by 1 s / 29 s / 31 s, early never, no late_s never, the 120 % cap in whole
 *    units from the truck's own capacity, the web's figures against the solver's, the break rule, the switch off;
 *  - carrying an allowance forward (F9), the override id, the overrides hash, before_relax, the allowances a save
 *    stores, the report merge and the stale check with allowances;
 *  - the timetable gate with allowances (D5, F2, F3, F8): WARN with allowedByHand, worse is BLOCK, the cap
 *    defence, a new case weight, a new cases per pallet, the break on its target load, the input hash;
 *  - the kept-load warning with a late arrival allowed by hand; the request schemas; the words.
 */
import { describe, expect, it } from 'vitest';
import type { DispatchRequest, DispatchStop, FeasibilityReport, FeasibilityViolation, RetimeRelaxed } from '@routeiq/shared-types';
import {
  allowancesOfSave,
  applyOps,
  beforeRelaxOf,
  carryIssues,
  dedupeIssues,
  editBasis,
  editWarnings,
  judgeIssue,
  mergeSolverReport,
  overrideId,
  overridesHash,
  planStopsOf,
  resolveLayout,
  rewriteBest,
  rowKey,
  stopKeyOf,
  storedAllowancesOf,
  type EditLoad,
  type EditRow,
  type JudgeContext,
  type JudgedIssue,
  type PlannedDayLoad,
} from '@/lib/dispatch/plan-edit';
import {
  allowancesOnPlannedText,
  allowedBadge,
  allowedByHandText,
  issueText,
  overrideCapUnits,
  planEditConfigNote,
  planEditOverridesOn,
  savedText,
  type EditStopRef,
  type PlanAllowanceLine,
  type PlanEditOp,
} from '@/lib/dispatch/plan-edit-view';
import { readHandAllowances, type HandAllowance, type PlanRules } from '@/lib/dispatch/snapshots';
import { checkPlanFeasibility, inputHash, type FeasLoad, type FeasStop } from '@/lib/dispatch/feasibility';
import { keptReport, type KeptLoadInput } from '@/lib/dispatch/kept-changes';
import { planEditCheckSchema, planEditSaveSchema } from '@/lib/schemas';
import { cleanReason } from '@/lib/dispatch/plan-edit-apply';

// ---------------------------------------------------------------------------------------------
// The change list

const planned = new Map<string, PlannedDayLoad[]>([
  ['T01', [{ loadId: 'A1', stops: ['c1', 'c2', 'c3'] }, { loadId: 'A2', stops: ['c4'] }]],
  ['T02', [{ loadId: 'B1', stops: ['c5', 'c6'] }]],
  ['T03', [{ loadId: 'C1', stops: ['c7'] }]],
]);
/** Stored stops are `${loadId}:${sequence}` of the layout above; an unserved order o9 / o10 is the visit c9. */
const SEQ: Record<string, string> = { 'A1:1': 'c1', 'A1:2': 'c2', 'A1:3': 'c3', 'A2:1': 'c4', 'B1:1': 'c5', 'B1:2': 'c6', 'C1:1': 'c7' };
const ctx = { stopOf: (r: EditStopRef) => ('orderId' in r ? (r.orderId === 'o9' || r.orderId === 'o10' ? 'c9' : null) : (SEQ[`${r.loadId}:${r.sequence}`] ?? null)), loadText: (id: string) => `${id}` };
const run = (ops: PlanEditOp[], p: ReadonlyMap<string, PlannedDayLoad[]> = planned) => applyOps(ops, p, ctx);
const after = (r: ReturnType<typeof run>, t: string) => (r.ok ? r.edit.after.get(t) : r);
const s = (loadId: string, sequence: number) => ({ loadId, sequence });

describe('applyOps: several stops, whole loads and swaps (owner items 1 and 2)', () => {
  it('several stops to an existing load at their best place: one best of all of them (v2 shape), the source loads emptied are dropped', () => {
    const r = run([{ kind: 'MOVE_STOPS', stops: [s('A2', 1), s('C1', 1), { orderId: 'o9' }], to: { truckId: 'T02', loadId: 'B1' } }]);
    expect(r.ok && r.edit.best).toEqual({ stop_id: 'c4', truck_id: 'T02', load_index: 0, more_stop_ids: ['c7', 'c9'] });
    expect(r.ok && r.edit.edited).toEqual(['T01', 'T03', 'T02']);
    expect(after(r, 'T01')).toEqual([['c1', 'c2', 'c3']]);
    expect(after(r, 'T03')).toEqual([]);
    expect(r.ok && r.edit.placedStops).toEqual(['c9']);
    // One stop: the v1 shape (no v2 field), so an older solver answers it as before.
    expect(run([{ kind: 'MOVE_STOPS', stops: [s('A2', 1)], to: { truckId: 'T02', loadId: 'B1' } }]).ok && true).toBe(true);
    const one = run([{ kind: 'MOVE_STOPS', stops: [s('A2', 1)], to: { truckId: 'T02', loadId: 'B1' } }]);
    expect(one.ok && one.edit.best).toEqual({ stop_id: 'c4', truck_id: 'T02', load_index: 0 });
  });

  it('refs that are the same stop are one (F7): two unserved orders of one customer, a stop named twice', () => {
    const r = run([{ kind: 'MOVE_STOPS', stops: [{ orderId: 'o9' }, { orderId: 'o10' }, s('A2', 1), s('A2', 1)], to: { truckId: 'T02', loadId: 'B1', order: [s('B1', 1), { orderId: 'o10' }, s('B1', 2), s('A2', 1)] } }]);
    expect(after(r, 'T02')).toEqual([['c5', 'c9', 'c6', 'c4']]);
  });

  it('an explicit order (the whole load), a position for one stop only, a new load in order before a load', () => {
    expect(after(run([{ kind: 'MOVE_STOPS', stops: [s('A1', 1)], to: { truckId: 'T02', loadId: 'B1', position: 1 } }]), 'T02')).toEqual([['c5', 'c1', 'c6']]);
    expect(run([{ kind: 'MOVE_STOPS', stops: [s('A1', 1), s('A1', 2)], to: { truckId: 'T02', loadId: 'B1', position: 1 } }])).toMatchObject({ ok: false, status: 422, code: 'POSITION_ONE_STOP' });
    const r = run([{ kind: 'MOVE_STOPS', stops: [s('A1', 1), s('A1', 2)], to: { truckId: 'T01', loadId: null, before: 'A1', order: [s('A1', 2), s('A1', 1)] } }]);
    expect(after(r, 'T01')).toEqual([['c2', 'c1'], ['c3'], ['c4']]);
    expect(r.ok && r.edit.afterLoadIds.get('T01')).toEqual([null, 'A1', 'A2']);
    expect(r.ok && r.edit.best).toBeNull();
  });

  it('several stops as a new load at a given place: the solver orders them (new_load_at among the loads that stay)', () => {
    const r = run([{ kind: 'MOVE_STOPS', stops: [s('A2', 1), s('B1', 1)], to: { truckId: 'T01', loadId: null, before: 'A1' } }]);
    expect(r.ok && r.edit.best).toEqual({ stop_id: 'c4', truck_id: 'T01', load_index: null, more_stop_ids: ['c5'], new_load_at: 0 });
    const end = run([{ kind: 'MOVE_STOPS', stops: [s('A1', 1), s('B1', 1)], to: { truckId: 'T01', loadId: null, before: null } }]);
    expect(end.ok && end.edit.best).toMatchObject({ new_load_at: 2 });
    const best = run([{ kind: 'MOVE_STOPS', stops: [s('A1', 1), s('B1', 1)], to: { truckId: 'T02', loadId: null, before: 'BEST' } }]);
    expect(best.ok && best.edit.best).toEqual({ stop_id: 'c1', truck_id: 'T02', load_index: null, more_stop_ids: ['c5'] });
  });

  it('takes several stops off: they are removed, and naming one again later is ALREADY_REMOVED', () => {
    const r = run([{ kind: 'REMOVE_STOPS', stops: [s('A1', 1), s('A2', 1)] }]);
    expect(after(r, 'T01')).toEqual([['c2', 'c3']]);
    expect(r.ok && r.edit.removedStops).toEqual(['c1', 'c4']);
    expect(run([{ kind: 'REMOVE_STOPS', stops: [s('A1', 1)] }, { kind: 'MOVE_STOPS', stops: [s('A1', 1)], to: { truckId: 'T02', loadId: 'B1', position: 0 } }])).toMatchObject({ ok: false, code: 'ALREADY_REMOVED' });
  });

  it('a whole load to another truck (a new load), to its own truck (a reorder keeping its id), at the best place; never before itself', () => {
    const r = run([{ kind: 'MOVE_LOAD', loadId: 'A1', to: { truckId: 'T02', before: 'B1' } }]);
    expect(after(r, 'T02')).toEqual([['c1', 'c2', 'c3'], ['c5', 'c6']]);
    expect(r.ok && r.edit.afterLoadIds.get('T02')).toEqual([null, 'B1']);
    expect(after(r, 'T01')).toEqual([['c4']]);
    const reorder = run([{ kind: 'MOVE_LOAD', loadId: 'A2', to: { truckId: 'T01', before: 'A1' } }]);
    expect(after(reorder, 'T01')).toEqual([['c4'], ['c1', 'c2', 'c3']]);
    expect(reorder.ok && reorder.edit.afterLoadIds.get('T01')).toEqual(['A2', 'A1']);
    expect(run([{ kind: 'MOVE_LOAD', loadId: 'A1', to: { truckId: 'T01', before: 'A1' } }])).toMatchObject({ ok: false, status: 409, code: 'NO_CHANGE' });
    expect(run([{ kind: 'MOVE_LOAD', loadId: 'A2', to: { truckId: 'T01', before: null } }])).toMatchObject({ ok: false, code: 'NO_CHANGE' });
    const best = run([{ kind: 'MOVE_LOAD', loadId: 'A1', to: { truckId: 'T03', before: 'BEST' } }]);
    expect(best.ok && best.edit.best).toEqual({ stop_id: 'c1', truck_id: 'T03', load_index: null, more_stop_ids: ['c2', 'c3'], keep_order: true });
    // A load of one stop at its best place: the v1 shape.
    const lone = run([{ kind: 'MOVE_LOAD', loadId: 'C1', to: { truckId: 'T02', before: 'BEST' } }]);
    expect(lone.ok && lone.edit.best).toEqual({ stop_id: 'c7', truck_id: 'T02', load_index: null });
  });

  it('a swap of two loads on two trucks (each a new load in the other slot) or on one truck (they change places)', () => {
    const r = run([{ kind: 'SWAP_LOADS', a: 'A1', b: 'B1' }]);
    expect([after(r, 'T01'), after(r, 'T02')]).toEqual([[['c5', 'c6'], ['c4']], [['c1', 'c2', 'c3']]]);
    expect(r.ok && r.edit.afterLoadIds.get('T01')).toEqual([null, 'A2']);
    expect(r.ok && r.edit.edited).toEqual(['T01', 'T02']);
    const same = run([{ kind: 'SWAP_LOADS', a: 'A1', b: 'A2' }]);
    expect(after(same, 'T01')).toEqual([['c4'], ['c1', 'c2', 'c3']]);
    expect(same.ok && same.edit.afterLoadIds.get('T01')).toEqual(['A2', 'A1']);
    expect(run([{ kind: 'SWAP_LOADS', a: 'A1', b: 'A1' }])).toMatchObject({ ok: false, status: 422, code: 'SAME_LOAD' });
  });

  it('a change list: a stop moved twice is found where it is now; BEST only in the last op; an emptied target; a bad order', () => {
    const twice = run([
      { kind: 'MOVE_STOPS', stops: [s('A1', 1)], to: { truckId: 'T02', loadId: 'B1', position: 0 } },
      { kind: 'MOVE_STOPS', stops: [s('A1', 1)], to: { truckId: 'T03', loadId: 'C1', position: 1 } },
    ]);
    expect([after(twice, 'T02'), after(twice, 'T03')]).toEqual([[['c5', 'c6']], [['c7', 'c1']]]);
    expect(twice.ok && twice.edit.edited).toEqual(['T01', 'T02', 'T03']);
    expect(run([{ kind: 'MOVE_STOPS', stops: [s('A1', 1)], to: { truckId: 'T02', loadId: 'B1' } }, { kind: 'REMOVE_STOPS', stops: [s('A2', 1)] }])).toMatchObject({ ok: false, code: 'BEST_NOT_LAST' });
    expect(run([{ kind: 'MOVE_STOPS', stops: [s('A2', 1)], to: { truckId: 'T03', loadId: 'C1', position: 0 } }, { kind: 'MOVE_STOPS', stops: [s('A1', 1)], to: { truckId: 'T01', loadId: 'A2', position: 0 } }])).toMatchObject({
      ok: false,
      code: 'UNKNOWN_LOAD',
      message: 'A2 has no stop left after the change before it.',
    });
    expect(run([{ kind: 'MOVE_STOPS', stops: [s('A1', 1)], to: { truckId: 'T02', loadId: 'B1', order: [s('B1', 1), s('A1', 1)] } }])).toMatchObject({ ok: false, code: 'BAD_ORDER' });
    expect(run([{ kind: 'MOVE_STOPS', stops: [s('A1', 1)], to: { truckId: 'T02', loadId: null, before: 'BEST', order: [s('A1', 1)] } }])).toMatchObject({ ok: false, code: 'BAD_ORDER', message: 'A new load in a given order needs a place: choose where it goes.' });
  });

  it('at most 6 edited trucks (TOO_MANY_TRUCKS); nothing changing is NO_CHANGE', () => {
    const many = new Map<string, PlannedDayLoad[]>([...Array(7).keys()].map((i) => [`T${i}`, [{ loadId: `L${i}`, stops: [`x${i}`] }]]));
    const ctx2 = { stopOf: (r: EditStopRef) => ('loadId' in r ? `x${r.loadId.slice(1)}` : null) };
    const ops: PlanEditOp[] = [...Array(6).keys()].map((i) => ({ kind: 'MOVE_STOPS', stops: [{ loadId: `L${i + 1}`, sequence: 1 }], to: { truckId: 'T0', loadId: 'L0', position: 0 } }));
    expect(applyOps(ops, many, ctx2)).toMatchObject({ ok: false, status: 409, code: 'TOO_MANY_TRUCKS' });
    expect(run([{ kind: 'MOVE_STOPS', stops: [s('A1', 2)], to: { truckId: 'T01', loadId: 'A1', position: 1 } }])).toMatchObject({ ok: false, code: 'NO_CHANGE' });
  });
});

describe('resolveLayout and rewriteBest: the place the solver found, written out (design 3.4)', () => {
  const W = [['c1', 'c2'], ['c4']];
  it('a new load at q, an existing load j (its order kept), anything else MISMATCH', () => {
    expect(resolveLayout(W, [['c1', 'c2'], ['c9', 'c8'], ['c4']], ['c8', 'c9'])).toEqual({ kind: 'NEW', q: 1 });
    expect(resolveLayout(W, [['c1', 'c9', 'c2'], ['c4']], ['c9'])).toEqual({ kind: 'LOAD', j: 0 });
    expect(resolveLayout(W, [['c2', 'c9', 'c1'], ['c4']], ['c9'])).toBeNull();
    expect(resolveLayout(W, [['c1', 'c2', 'c9']], ['c9'])).toBeNull();
  });
  it('MOVE_STOPS gets the whole order (refs of the stored version); a v1 MOVE its position; a new load before a load made earlier is NO_EXPLICIT_PLACE', () => {
    const refOf = (id: string): EditStopRef => (id === 'c9' ? { orderId: 'o9' } : { loadId: 'A1', sequence: Number(id.slice(1)) });
    const op: PlanEditOp = { kind: 'MOVE_STOPS', stops: [{ orderId: 'o9' }], to: { truckId: 'T01', loadId: 'A1' } };
    expect(rewriteBest(op, { kind: 'LOAD', j: 0 }, { truckId: 'T01', wIds: ['A1', 'A2'], S: [['c1', 'c9', 'c2'], ['c4']], bestStops: ['c9'], refOf })).toEqual({
      ...op,
      to: { truckId: 'T01', loadId: 'A1', order: [{ loadId: 'A1', sequence: 1 }, { orderId: 'o9' }, { loadId: 'A1', sequence: 2 }] },
    });
    const v1: PlanEditOp = { kind: 'PLACE', orderId: 'o9', to: { truckId: 'T01', loadId: 'A1', position: 'BEST' } };
    expect(rewriteBest(v1, { kind: 'LOAD', j: 0 }, { truckId: 'T01', wIds: ['A1', 'A2'], S: [['c1', 'c9', 'c2'], ['c4']], bestStops: ['c9'], refOf })).toEqual({ ...v1, to: { truckId: 'T01', loadId: 'A1', position: 1 } });
    const load: PlanEditOp = { kind: 'MOVE_LOAD', loadId: 'B1', to: { truckId: 'T01', before: 'BEST' } };
    expect(rewriteBest(load, { kind: 'NEW', q: 1 }, { truckId: 'T01', wIds: ['A1', 'A2'], S: [], bestStops: [], refOf })).toEqual({ ...load, to: { truckId: 'T01', before: 'A2' } });
    expect(rewriteBest(load, { kind: 'NEW', q: 2 }, { truckId: 'T01', wIds: ['A1', 'A2'], S: [], bestStops: [], refOf })).toEqual({ ...load, to: { truckId: 'T01', before: null } });
    expect(rewriteBest(load, { kind: 'NEW', q: 0 }, { truckId: 'T01', wIds: [null, 'A2'], S: [], bestStops: [], refOf })).toBe('NO_EXPLICIT_PLACE');
  });
});

describe('the amber warnings of a change (design 3.2 step 12)', () => {
  it('both parts of a customer delivered in parts on one load; a truck hired for the day left with no load', () => {
    const edit = { edited: ['T01', 'T09'], before: new Map([['T01', [['k#1']]], ['T09', [['x']]]]), after: new Map([['T01', [['k#1', 'b', 'k#2']]], ['T09', []]]) };
    const stops = new Map([['k#1', { customer_id: 'k' }], ['k#2', { customer_id: 'k' }], ['b', { customer_id: 'b' }]]);
    const w = editWarnings({ edit, stops, names: new Map([['k#1', 'C7 Corner Shop'], ['k#2', 'C7 Corner Shop']]), truckCodes: new Map([['T01', 'T05'], ['T09', 'T21']]), frozenCount: () => 0, hiredForDay: new Set(['T09']) });
    expect(w).toEqual([
      'Both parts of C7 Corner Shop (delivered in parts today) are on T05 L1: the driver unloads it twice (stops 1 and 3). A RE-PLAN delivers it in one stop.',
      'T21, hired for this day, has no load after this change: cancel its hire under Hired trucks if it is not needed.',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Judging issues

const stop = (stop_id: string, order_ids: string[], extra: Partial<DispatchStop> = {}): DispatchStop =>
  ({ stop_id, customer_id: `cu-${stop_id}`, order_ids, lat: 23.6, lng: 58.4, demand_cases: 100, demand_kg: 1000, service_min: 15, priority: 3, hard_start_min: 480, hard_end_min: 780, ...extra }) as DispatchStop;
const req = (over: Partial<DispatchRequest['config']> = {}): Pick<DispatchRequest, 'stops' | 'trucks' | 'config'> =>
  ({
    stops: [stop('s1', ['o1']), stop('s2', ['o2'], { demand_cases: 1100 }), stop('s3', ['o3~1'])],
    trucks: [{ id: 'T1', code: 'T08', capacity_cases: 1000, capacity_kg: 8000, bays: 12 }],
    config: { window_rule: 'START', break_min: 60, break_start_from_min: 720, break_start_to_min: 840, pallet_fill_pct: 98, ...over },
  }) as unknown as Pick<DispatchRequest, 'stops' | 'trucks' | 'config'>;
function jctx(over: Partial<JudgeContext> = {}): JudgeContext {
  return {
    request: req(),
    scope: { portions: { 'o3~1': { orderId: 'o3', lines: [{ lineId: 'l1', cases: 40 }], cases: 40, weightKg: 0, part: 1, parts: 2 } }, palletUnits: { o1: 6000, o2: 7000, 'o3~1': 500 } },
    orderKg: new Map([['o1', 4000], ['o2', 5000]]),
    loadStops: (t, n) => (t === 'T1' && n === 1 ? ['s1', 's2'] : null),
    names: new Map([['s1', 'C7 Corner Shop (C7)']]),
    truckCodes: new Map([['T1', 'T08']]),
    overridesOn: true,
    relaxedPresent: true,
    ...over,
  };
}
const v = (over: Partial<FeasibilityViolation>): FeasibilityViolation => ({ code: 'HARD_WINDOW', truck_id: 'T1', load_no: 1, stop_id: 's1', message: 'm', ...over }) as FeasibilityViolation;

describe('judgeIssue (design 3.7; F1, F2, F17)', () => {
  it('LATE: late_s > 0 (1 s, 29 s, 31 s late) with value >= limit, shown as at least 1 min; early never; no late_s (an older solver) never', () => {
    for (const late_s of [1, 29, 31]) {
      const i = judgeIssue(v({ value: 780, limit: 780, late_s, overridable: true }), jctx());
      expect(i).toMatchObject({ kind: 'LATE', overridable: true, amount: { unit: 'min', value: 780, limit: 780, over: 1 }, whyNot: null });
    }
    const late = judgeIssue(v({ value: 800, limit: 780, late_s: 1200, overridable: true }), jctx());
    expect(late.text).toBe('C7 Corner Shop (C7) on T08 L1 arrives 13:20, after its receiving hours 08:00–13:00: 20 min late');
    expect(late.id).toBe(overrideId('LATE', 'T1', ['o1|*']));
    expect(judgeIssue(v({ value: 470, limit: 480, overridable: false }), jctx())).toMatchObject({ kind: null, overridable: false, whyNot: 'Arriving before the receiving hours open cannot be allowed by hand.' });
    expect(judgeIssue(v({ short_by_min: 20 }), jctx())).toMatchObject({ kind: null, overridable: false });
    // The switch off: not asked, said so.
    expect(judgeIssue(v({ value: 800, limit: 780, late_s: 1200 }), jctx({ overridesOn: false }))).toMatchObject({ overridable: false, whyNot: 'Allowing rules by hand is switched off.' });
    // FINISH: the unloading end.
    const fin = judgeIssue(v({ value: 815, limit: 780, late_s: 2100, overridable: true }), jctx({ request: req({ window_rule: 'FINISH' }) }));
    expect(fin.text).toBe('C7 Corner Shop (C7) on T08 L1 finishes unloading at 13:35, after its receiving hours end (13:00): 35 min late');
  });

  it('capacity: the web\'s own figures, the cap in whole units from the truck\'s own capacity (119.9 / 120.0 / 120.1 %), the figures must agree', () => {
    const cases = (n: number, value = n) => {
      const r = req();
      r.stops[1] = stop('s2', ['o2'], { demand_cases: n - 100 });
      return judgeIssue(v({ code: 'CAPACITY_CASES', stop_id: null, value, limit: 1000, capacity: 1000, overridable: true }), jctx({ request: r }));
    };
    expect(cases(1199)).toMatchObject({ kind: 'CAPACITY_CASES', overridable: true, amount: { unit: 'cases', value: 1199, limit: 1000, capacity: 1000, overPct: 20 } });
    expect(cases(1200).overridable).toBe(true);
    expect(cases(1201)).toMatchObject({ overridable: false, whyNot: "20% over the truck's 1,000 cases: more than the 20% that can be allowed by hand." });
    expect(cases(1150, 1149)).toMatchObject({ overridable: false, whyNot: "The optimizer's figures for this load do not match the plan's (1149 / 1150 cases): re-plan the day." });
    expect(cases(1150, 1151).overridable).toBe(false);
    // Pallets from bays (12 bays = 12,000 units: 13,000 is 108 %), never from the 98 % room.
    const p = judgeIssue(v({ code: 'CAPACITY_PALLETS', stop_id: null, value: 13, limit: 11.76, capacity: 12, overridable: true }), jctx());
    expect(p).toMatchObject({ kind: 'CAPACITY_PALLETS', overridable: true, amount: { unit: 'pallets', value: 13, limit: 11.76, capacity: 12, overPct: 8 } });
    expect(p.text).toBe("T08 L1 needs 13.0 pallets; the truck takes 11.8 (12 bays at 98% fill): 1.2 pallets over the limit, 8% over the truck's 12 bays");
    expect(overrideCapUnits(12_000)).toBe(14_400);
    // Kg: 9,000 on a payload of 8,000 (113 %).
    const kg = judgeIssue(v({ code: 'CAPACITY_KG', stop_id: null, value: 9000, limit: 8000, capacity: 8000, overridable: true }), jctx());
    expect(kg).toMatchObject({ kind: 'CAPACITY_KG', overridable: true, amount: { unit: 'kg', value: 9000, overPct: 13 } });
    expect(judgeIssue(v({ code: 'CAPACITY_KG', stop_id: null, value: 8800, limit: 8000, overridable: true }), jctx()).overridable).toBe(false);
  });

  it('the break: allowed only with the break rule on and the solver saying so; the other rules never; one NO_BREAK per truck (F17)', () => {
    expect(judgeIssue(v({ code: 'BREAK', stop_id: null, overridable: true }), jctx())).toMatchObject({ kind: 'NO_BREAK', overridable: true, id: overrideId('NO_BREAK', 'T1', []) });
    expect(judgeIssue(v({ code: 'BREAK', stop_id: null, overridable: true }), jctx({ request: req({ break_min: 0 }) })).overridable).toBe(false);
    expect(judgeIssue(v({ code: 'BREAK', stop_id: null, overridable: false }), jctx()).whyNot).toBe('This driver break problem cannot be allowed by hand: T08 has no time left for a break today.');
    expect(judgeIssue(v({ code: 'TRUCK_NOT_ALLOWED', overridable: false }), jctx()).whyNot).toBe('Small-truck-only customers cannot be allowed by hand.');
    expect(judgeIssue(v({ code: 'SHIFT_LIMIT', stop_id: null }), jctx()).whyNot).toBe('The shift and the latest return cannot be allowed by hand.');
    expect(judgeIssue(v({ code: 'TRIPS', stop_id: null }), jctx()).whyNot).toBe('The loads a day cannot be allowed by hand.');
    expect(judgeIssue(v({ code: 'NO_TIMETABLE', stop_id: null }), jctx()).whyNot).toBe('No timetable keeps every rule: see below what can be allowed by hand.');
    const two = [v({ code: 'BREAK', stop_id: null, message: 'first', overridable: true }), v({ code: 'BREAK', stop_id: null, load_no: 2, message: 'second', overridable: true })].map((x) => judgeIssue(x, jctx()));
    expect(dedupeIssues(two).map((x) => x.text)).toEqual(['first']);
  });

  it('the override id: kind, truck and rows (split parts apart), never the amounts', () => {
    expect(overrideId('LATE', 'T1', ['b', 'a'])).toBe(overrideId('LATE', 'T1', ['a', 'b']));
    expect(overrideId('LATE', 'T1', ['a'])).toMatch(/^ovr_[0-9a-f]{16}$/);
    expect(overrideId('LATE', 'T1', ['o3|l1:40'])).not.toBe(overrideId('LATE', 'T1', ['o3|l1:60']));
    expect(overrideId('LATE', 'T2', ['a'])).not.toBe(overrideId('LATE', 'T1', ['a']));
  });
});

// ---------------------------------------------------------------------------------------------
// Allowances

const allowance = (over: Partial<HandAllowance>): HandAllowance => ({
  v: 1, id: 'ovr_0000000000000001', kind: 'LATE', rowKeys: ['o1|*'], orderIds: ['o1'], rule: 'START', windowStartMin: 480, windowEndMin: 780, atMin: 800, lateMin: 20, maxLateMin: 20,
  reason: 'agreed with customer', byUserId: 'u1', byName: 'Ahmed', byRole: 'SUPERVISOR', at: '2026-10-24T17:40:00.000Z', runId: 'r1', ...over,
});
const issue = (over: Partial<JudgedIssue>): JudgedIssue => ({
  id: 'ovr_x', code: 'HARD_WINDOW', kind: 'LATE', overridable: true, whyNot: null, truckId: 'T1', truckCode: 'T08', loadNo: 1, stopLabel: 'C7', customerId: 'cu', orderIds: ['o1'],
  amount: { unit: 'min', value: 800, limit: 780, over: 20 }, text: 't', carried: null, previous: null, stopId: 's1', rowKeys: ['o1|*'], rule: 'START', windowStartMin: 480, windowEndMin: 780, ...over,
});
const stored = (a: HandAllowance, status = 'PLANNED') => ({ allowance: a, truckId: 'T1', loadId: 'L1', loadNo: 1, status });
const CFG = { break_min: 60, break_start_from_min: 720, break_start_to_min: 840 };

describe('carrying an allowance forward (D6, F9)', () => {
  it('the same stop no later than agreed is carried with the approver; later, or with the hours changed, needs approval again (the reason pre-filled)', () => {
    const [c] = carryIssues([issue({ amount: { unit: 'min', value: 795, limit: 780, over: 15 } })], [stored(allowance({}))], CFG);
    expect(c!.carried).toEqual({ fromId: 'ovr_0000000000000001', reason: 'agreed with customer', byName: 'Ahmed', byRole: 'SUPERVISOR', at: '2026-10-24T17:40:00.000Z' });
    const [worse] = carryIssues([issue({ amount: { unit: 'min', value: 810, limit: 780, over: 30 } })], [stored(allowance({}))], CFG);
    expect(worse).toMatchObject({ carried: null, previous: { reason: 'agreed with customer', byName: 'Ahmed' } });
    const [hours] = carryIssues([issue({ windowEndMin: 760, amount: { unit: 'min', value: 775, limit: 760, over: 15 } })], [stored(allowance({}))], CFG);
    expect(hours.carried).toBeNull();
    // Another truck's allowance never covers it.
    expect(carryIssues([issue({})], [{ ...stored(allowance({})), truckId: 'T2' }], CFG)[0]!.carried).toBeNull();
  });

  it('capacity: a load made of a subset of the rows, no more than approved, the truck\'s capacity unchanged; the largest maximum wins', () => {
    const cap = issue({ kind: 'CAPACITY_CASES', code: 'CAPACITY_CASES', rowKeys: ['o1|*', 'o2|*'], amount: { unit: 'cases', value: 1080, limit: 1000, over: 80, capacity: 1000, overPct: 8 } });
    const a1 = allowance({ id: 'ovr_a', kind: 'CAPACITY_CASES', rowKeys: ['o1|*', 'o2|*', 'o3|*'], maxValue: 1100, value: 1100, capacity: 1000 });
    const a2 = allowance({ id: 'ovr_b', kind: 'CAPACITY_CASES', rowKeys: ['o1|*', 'o2|*', 'o3|*'], maxValue: 1150, value: 1150, capacity: 1000 });
    expect(carryIssues([cap], [stored(a1), stored(a2)], CFG)[0]!.carried?.fromId).toBe('ovr_b');
    expect(carryIssues([cap], [stored({ ...a1, capacity: 900 })], CFG)[0]!.carried).toBeNull();
    expect(carryIssues([{ ...cap, rowKeys: ['o1|*', 'o9|*'] }], [stored(a1)], CFG)[0]!.carried).toBeNull();
  });

  it('NO_BREAK: from any load of the truck-day, a frozen one too, under the same break rule', () => {
    const nb = issue({ kind: 'NO_BREAK', code: 'BREAK', rowKeys: [], amount: null });
    const a = allowance({ kind: 'NO_BREAK', rowKeys: [], breakMin: 60, breakFromMin: 720, breakToMin: 840 });
    expect(carryIssues([nb], [stored(a, 'LOCKED')], CFG)[0]!.carried).not.toBeNull();
    expect(carryIssues([nb], [stored(a)], { ...CFG, break_min: 45 })[0]!.carried).toBeNull();
    // storedAllowancesOf: PLANNED loads every kind, frozen loads NO_BREAK only.
    const load = (status: string, list: HandAllowance[]) => ({ id: `L-${status}`, truckId: 'T1', loadNo: 1, status, truckSnapshotJson: { v: 1, capacityCases: 1, handAllowed: list } }) as unknown as EditLoad;
    expect(storedAllowancesOf([load('LOCKED', [allowance({}), a]), load('PLANNED', [allowance({ id: 'ovr_p' })])], new Set(['T1'])).map((x) => x.allowance.id)).toEqual([a.id, 'ovr_p']);
  });

  it('the allowances a save stores: LATE on its load, capacity on its load, NO_BREAK on every new load of the truck; a carried one keeps the approver and the maximum', () => {
    const src = allowance({ maxLateMin: 25 });
    const out = allowancesOfSave({
      needed: [
        issue({ id: 'ovr_l', amount: { unit: 'min', value: 795, limit: 780, over: 15 }, carriedFrom: src, carried: { fromId: src.id, reason: src.reason, byName: 'Ahmed', byRole: 'SUPERVISOR', at: src.at } }),
        issue({ id: 'ovr_c', kind: 'CAPACITY_KG', code: 'CAPACITY_KG', loadNo: 2, rowKeys: ['o5|*'], orderIds: ['o5'], amount: { unit: 'kg', value: 9000, limit: 8000, over: 1000, capacity: 8000, overPct: 13 } }),
        issue({ id: 'ovr_b', kind: 'NO_BREAK', code: 'BREAK', loadNo: null, rowKeys: [], amount: null }),
      ],
      confirmed: new Map([['ovr_c', 'one day only'], ['ovr_b', 'driver agreed']]),
      user: { id: 'u2', name: 'Sara', role: 'TENANT_ADMIN' },
      at: '2026-10-25T08:00:00.000Z',
      runId: 'r2',
      newLoads: [{ truck_id: 'T1', load_no: 1 }, { truck_id: 'T1', load_no: 2 }],
      config: CFG,
    });
    expect(out.get('T1:1')!.map((a) => [a.kind, a.byName, a.reason])).toEqual([['LATE', 'Ahmed', 'agreed with customer'], ['NO_BREAK', 'Sara', 'driver agreed']]);
    expect(out.get('T1:1')![0]).toMatchObject({ lateMin: 15, maxLateMin: 25, atMin: 795, carriedFrom: { id: src.id, runId: 'r1' }, runId: 'r1' });
    expect(out.get('T1:2')!.map((a) => a.kind)).toEqual(['CAPACITY_KG', 'NO_BREAK']);
    expect(out.get('T1:2')![0]).toMatchObject({ value: 9000, maxValue: 9000, capacity: 8000, overPct: 13, byRole: 'TENANT_ADMIN', runId: 'r2' });
    // What a save stores reads back; a damaged entry is dropped.
    expect(readHandAllowances({ v: 1, capacityCases: 1, handAllowed: [...out.get('T1:2')!, { v: 1, id: 'x', kind: 'CAPACITY_KG' }, 'junk'] }).length).toBe(2);
    expect(readHandAllowances(null)).toEqual([]);
  });

  it('before_relax: the stops of a LATE allowance (by rows), the capacity trucks, NO_BREAK of any load', () => {
    const row = (orderId: string, seq: number) => ({ orderId, sequenceInTruck: seq, orderInStop: 0, portionCases: null, portionWeightKg: null, portionLinesJson: null, stopSnapshotJson: null, etaMin: 0, serviceStartMin: 0, hardWindowOk: false, prefWindowOk: true, cases: 1, customerId: 'c', label: 'C' }) as EditRow;
    const L1 = { id: 'L1', truckId: 'T1', truckCode: 'T08', loadNo: 1, rows: [row('o1', 1), row('o2', 2)] } as EditLoad;
    const stops = planStopsOf(L1);
    const stopOf = new Map([[stopKeyOf('L1', 1), 's1'], [stopKeyOf('L1', 2), 's2']]);
    expect(beforeRelaxOf([stored(allowance({ rowKeys: [rowKey('o2', null)] })), { ...stored(allowance({ kind: 'CAPACITY_CASES', maxValue: 1, capacity: 1 })), truckId: 'T2' }, { ...stored(allowance({ kind: 'NO_BREAK' }), 'LOCKED'), truckId: 'T3' }], stops, stopOf)).toEqual({
      late_stop_ids: ['s2'],
      over_capacity_truck_ids: ['T2'],
      capacity_factor: 1.2,
      no_break_truck_ids: ['T3'],
    });
    expect(beforeRelaxOf([], stops, stopOf)).toBeNull();
  });
});

describe('the hashes, the report merge and the stale check with allowances (F16)', () => {
  const relaxed = {
    ok: true,
    relaxations: { late_stop_ids: ['s1'], over_capacity_truck_ids: [], capacity_factor: 1.2, no_break_truck_ids: [] },
    loads: [{ truck_id: 'T1', loads: [['s1', 's2']] }],
    strict: [{ truck_id: 'T1', feasible: false, violations: [], loads: 1 }],
    trucks: [{ truck_id: 'T1', feasible: true, violations: [], loads: 1, allowed: [{ code: 'HARD_WINDOW', truck_id: 'T1', load_no: 1, stop_id: 's1', message: 'm', value: 800, limit: 780, late_s: 1200 }] }],
    scenario: { loads: [] },
    delta_money_omr: 1.5,
    warnings: [],
  } as unknown as RetimeRelaxed;
  const base = { basis: 'b', builtAt: 't', ops: [{ kind: 'SWAP_LOADS', a: 'A', b: 'B' }] as PlanEditOp[], skipBreak: [] as string[], carried: [] as [string, string][], needed: [issue({ id: 'ovr_1' })], relaxed, matrix: 'ROAD' };
  it('the overrides hash covers the relaxed answer only, and changes with the list, skipBreak, carried pairs and amounts', () => {
    const h = overridesHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // The strict parts (what the strict evaluation found) are not in it.
    expect(overridesHash({ ...base, relaxed: { ...relaxed, strict: [] } })).toBe(h);
    expect(overridesHash({ ...base, ops: [{ kind: 'SWAP_LOADS', a: 'B', b: 'A' }] })).not.toBe(h);
    expect(overridesHash({ ...base, skipBreak: ['T1'] })).not.toBe(h);
    expect(overridesHash({ ...base, carried: [['ovr_1', 'ovr_0']] })).not.toBe(h);
    expect(overridesHash({ ...base, needed: [issue({ id: 'ovr_1', amount: { unit: 'min', value: 801, limit: 780, over: 21 } })] })).not.toBe(h);
    expect(overridesHash({ ...base, relaxed: { ...relaxed, delta_money_omr: 2 } })).not.toBe(h);
  });
  it('the merged report keeps the allowed findings of the other trucks and adds the new ones', () => {
    const a = (truck_id: string, load_no: number) => ({ code: 'HARD_WINDOW', truck_id, load_no, message: 'x' }) as FeasibilityViolation;
    const r = mergeSolverReport({ status: 'VERIFIED', timing: 'EXACT', violations: [], allowed: [a('T2', 1), a('T1', 2)] } as FeasibilityReport, { status: 'VERIFIED', timing: 'EXACT', violations: [], allowed: [a('T1', 1)] }, new Set(['T1']), new Set(['T1:2']));
    expect(r?.allowed?.map((x) => `${x.truck_id}:${x.load_no}`)).toEqual(['T2:1', 'T1:1']);
    expect(mergeSolverReport({ status: 'VERIFIED', timing: 'EXACT', violations: [] }, { status: 'VERIFIED', timing: 'EXACT', violations: [] }, new Set(['T1']), new Set())).not.toHaveProperty('allowed');
  });
  it('the stale check covers the allowances of the edited trucks\' loads', () => {
    const L = (snap: unknown) => [{ id: 'L1', truckId: 'T1', status: 'PLANNED', loadNo: 1, rows: [], truckSnapshotJson: snap }] as unknown as EditLoad[];
    const request = { config: {}, depot: {}, trucks: [], stops: [] } as unknown as DispatchRequest;
    const b = (snap: unknown) => editBasis({ request, edited: ['T1'], stopIds: [], loads: L(snap), chosenScenarioId: 'sc', unserved: [] });
    expect(b({ v: 1, capacityCases: 1 })).toBe(b({ v: 1, capacityCases: 1, handAllowed: [] }));
    expect(b({ v: 1, capacityCases: 1, handAllowed: [allowance({})] })).not.toBe(b({ v: 1, capacityCases: 1 }));
    expect(b({ v: 1, capacityCases: 1, handAllowed: [allowance({ at: '2026-10-25T00:00:00.000Z' })] })).not.toBe(b({ v: 1, capacityCases: 1, handAllowed: [allowance({})] }));
  });
});

// ---------------------------------------------------------------------------------------------
// The timetable gate with allowances (design 6.1)

const RULES: PlanRules = { shiftStartMin: 360, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0, maxTrips: 3, depotOpenMin: 300, depotCloseMin: 1380, availableFromMin: null, availableToMin: null, windowRule: 'START' };
const fstop = (over: Partial<FeasStop> = {}): FeasStop => ({
  orderId: 'o1', rowKey: 'o1|*', sequence: 1, label: 'C7', cases: 40, kg: 400, kgUnknown: false, etaMin: 800, serviceStartMin: 800, departureMin: 815, hardWindowOk: false, hardStartMin: 480, hardEndMin: 780, ...over,
});
const fload = (over: Partial<FeasLoad> = {}): FeasLoad => ({
  id: 'L1', truckId: 't1', truckCode: 'T08', loadNo: 1, onRoad: false, departMin: 700, returnMin: 900, cases: 40, weightKg: 400, capacity: { cases: 100, kg: 1000 }, rules: RULES, stops: [fstop()], ...over,
});
const gate = (l: FeasLoad[]) => checkPlanFeasibility({ scenarioId: 'sc', solver: { status: 'VERIFIED', timing: 'EXACT', violations: [] }, loads: l });

describe('the timetable gate honours an allowance by hand, never more (D5)', () => {
  it('a late arrival allowed: a WARN that names it, Lock passes; 1 min more than allowed (+1 tolerance) is a BLOCK; early never', () => {
    const ok = gate([fload({ allowances: [allowance({ rowKeys: ['o1|*'], maxLateMin: 20 })] })]);
    expect(ok.ok).toBe(true);
    expect(ok.violations).toEqual([expect.objectContaining({ code: 'HARD_WINDOW', severity: 'WARN', allowedByHand: { id: 'ovr_0000000000000001', reason: 'agreed with customer', byName: 'Ahmed' } })]);
    expect(ok.violations[0]!.message).toMatch(/^Allowed by hand: T08 load 1: C7 starts unloading at 13:20, after its latest arrival 13:00 .* - agreed with customer$/);
    expect(gate([fload({ allowances: [allowance({ maxLateMin: 20 })], stops: [fstop({ serviceStartMin: 801 })] })]).ok).toBe(true);
    expect(gate([fload({ allowances: [allowance({ maxLateMin: 20 })], stops: [fstop({ serviceStartMin: 802 })] })]).ok).toBe(false);
    expect(gate([fload({ allowances: [allowance({ maxLateMin: 20 })], stops: [fstop({ serviceStartMin: 470, etaMin: 470, departureMin: 485 })] })]).ok).toBe(false);
  });

  it('F8: the allowance of one part of a split order never covers the other part on the same load (matched by row key)', () => {
    const parts = [fstop({ orderId: 'o3', rowKey: 'o3|l1:40', sequence: 1 }), fstop({ orderId: 'o3', rowKey: 'o3|l1:60', sequence: 2, serviceStartMin: 810, etaMin: 810 })];
    const f = gate([fload({ stops: parts, allowances: [allowance({ rowKeys: ['o3|l1:40'], maxLateMin: 40 })] })]);
    expect(f.violations.map((x) => x.severity)).toEqual(['WARN', 'BLOCK']);
  });

  it('capacity: within what was allowed a WARN; more, or an allowance above the 120 % cap (F2: ignored), a BLOCK', () => {
    const over = fload({ stops: [fstop({ cases: 115, etaMin: 700, serviceStartMin: 700, departureMin: 715, hardWindowOk: true })] });
    expect(gate([{ ...over, allowances: [allowance({ id: 'ovr_c', kind: 'CAPACITY_CASES', rowKeys: ['o1|*'], maxValue: 115, capacity: 100 })] }]).ok).toBe(true);
    expect(gate([{ ...over, allowances: [allowance({ id: 'ovr_c', kind: 'CAPACITY_CASES', rowKeys: ['o1|*'], maxValue: 110, capacity: 100 })] }]).ok).toBe(false);
    expect(gate([{ ...over, stops: [fstop({ cases: 125, etaMin: 700, serviceStartMin: 700, departureMin: 715, hardWindowOk: true })], allowances: [allowance({ kind: 'CAPACITY_CASES', maxValue: 125, capacity: 100 })] }]).ok).toBe(false);
  });

  it('F3: kg allowed at 110 %; a case weight entered since makes it 115 % (above what was allowed): CAPACITY_KG_NEW_WEIGHT; within it: a warning', () => {
    const heavy = (kgNow: number) =>
      fload({ stops: [fstop({ kg: 1100, kgUnknown: true, unknownKgNow: kgNow, etaMin: 700, serviceStartMin: 700, departureMin: 715, hardWindowOk: true })], allowances: [allowance({ kind: 'CAPACITY_KG', rowKeys: ['o1|*'], maxValue: 1100, capacity: 1000 })] });
    expect(gate([heavy(50)]).violations.find((x) => x.code === 'CAPACITY_KG_NEW_WEIGHT')?.message).toMatch(/more than allowed by hand \(1,100 kg\)\.$/);
    expect(gate([heavy(0)]).ok).toBe(true);
    expect(gate([heavy(0)]).violations.map((x) => [x.code, x.severity])).toEqual([['CAPACITY_KG', 'WARN'], ['KG_UNKNOWN', 'WARN']]);
  });

  it('pallets: the cases per pallet corrected since makes the load need more than allowed: a BLOCK on a Planned load, a warning on a locked one', () => {
    const pl = (status: Partial<FeasLoad>) =>
      fload({
        ...status,
        capacity: { cases: 1000, kg: 0, palletRoomUnits: 11_760, bays: 12, fillPct: 98 },
        stops: [fstop({ palletUnits: 13_000, palletUnitsNow: 13_400, etaMin: 700, serviceStartMin: 700, departureMin: 715, hardWindowOk: true })],
        allowances: [allowance({ kind: 'CAPACITY_PALLETS', rowKeys: ['o1|*'], maxValue: 13, capacity: 12 })],
      });
    expect(gate([pl({})]).violations.map((x) => [x.code, x.severity])).toEqual([['CAPACITY_PALLETS', 'WARN'], ['CAPACITY_PALLETS_NEW_FACTOR', 'BLOCK']]);
    expect(gate([pl({ frozen: true, status: undefined } as Partial<FeasLoad>)]).violations.map((x) => [x.code, x.severity])).toEqual([['CAPACITY_PALLETS', 'WARN'], ['CAPACITY_PALLETS_NEW_FACTOR', 'WARN']]);
  });

  it('NO_BREAK only on the load the missing break is put on, under the same break rule; a re-planned load without it is a BLOCK', () => {
    const rules = { ...RULES, break: { lengthMin: 60, startFromMin: 720, startToMin: 840 } };
    const day = (allowances?: HandAllowance[]) => [fload({ rules, departMin: 600, returnMin: 1000, stops: [fstop({ etaMin: 700, serviceStartMin: 700, departureMin: 715, hardWindowOk: true })], ...(allowances ? { allowances } : {}) })];
    const nb = allowance({ kind: 'NO_BREAK', rowKeys: [], breakMin: 60, breakFromMin: 720, breakToMin: 840 });
    expect(gate(day()).ok).toBe(false);
    expect(gate(day([nb])).ok).toBe(true);
    expect(gate(day([{ ...nb, breakMin: 45 }])).ok).toBe(false);
  });

  it('the input hash: unchanged for a load without allowances, changed by one', () => {
    const plain = { scenarioId: 'sc', solver: null, loads: [fload()] };
    expect(inputHash({ ...plain, loads: [fload({ allowances: [] })] })).toBe(inputHash(plain));
    expect(inputHash({ ...plain, loads: [fload({ allowances: [allowance({})] })] })).not.toBe(inputHash(plain));
  });
});

describe('the kept-load warning with a late arrival allowed by hand (design 6.3)', () => {
  const kept = (endNow: number): KeptLoadInput => ({
    loadId: 'L1', truckId: 't1', truckCode: 'T08', loadNo: 1, status: 'LOCKED', rules: RULES, truckSmallNow: true,
    stops: [
      {
        sequence: 1, customerId: 'cu', split: null, serviceStartMin: 800, departureMin: 815, allowance: { maxLateMin: 20, windowEndMin: 780, reason: 'agreed with customer' },
        snapshot: { v: 2, customerId: 'cu', code: 'C7', branchCode: null, name: 'C7', customerType: null, lat: 23.6, lng: 58.4, hardStartMin: 480, hardEndMin: 780, prefStartMin: null, prefEndMin: null, serviceMin: 15, priority: 3, address: null, accessNotes: null, source: 'PLAN', capturedAt: '2026-10-24T10:00:00.000Z' } as never,
        live: { name: 'C7', address: null, lat: 23.6, lng: 58.4, hardStartMin: 480, hardEndMin: endNow, prefStartMin: null, prefEndMin: null, promised: null },
        customer: { code: 'C7', branchCode: null, name: 'C7', active: true, smallTruckOnly: false, locationUsable: true },
        orders: [{ id: 'o1', cancelled: false, carriedTo: null }],
        newOrders: [],
      },
    ],
  });
  const effect = (endNow: number) => keptReport([kept(endNow)], [{ loadId: 'L1', truckId: 't1', truckCode: 'T08', loadNo: 1, status: 'LOCKED' }]).loads[0]?.stops[0]?.changes[0];
  it('hours changed: on time STILL_OK; late within what was allowed CHECK; later BREAKS - the words name the allowance', () => {
    expect(effect(840)?.effect).toBe('STILL_OK');
    expect(effect(785)).toMatchObject({ effect: 'CHECK' });
    expect(effect(785)?.text).toMatch(/Allowed by hand to arrive up to 20 min late \(agreed with customer\); with the hours now it is 15 min late: check with the customer\.$/);
    expect(effect(720)).toMatchObject({ effect: 'BREAKS' });
    expect(effect(720)?.text).toMatch(/80 min late, more than the 20 min allowed by hand\.$/);
  });
});

describe('the requests (lib/schemas.ts, design 3.5)', () => {
  const move = { kind: 'REMOVE', from: { loadId: 'L1', sequence: 1 } };
  const save = { previewHash: 'a'.repeat(64), builtAt: '2026-10-25T08:00:00.000Z' };
  it('one change or a list (exactly one of them), at most 10 ops, 40 stops an op, 120 in an order', () => {
    expect(planEditCheckSchema.safeParse({ move }).success).toBe(true);
    expect(planEditCheckSchema.safeParse({ ops: [move, { kind: 'SWAP_LOADS', a: 'A', b: 'B' }] }).success).toBe(true);
    expect(planEditCheckSchema.safeParse({ move, ops: [move] }).success).toBe(false);
    expect(planEditCheckSchema.safeParse({}).success).toBe(false);
    expect(planEditCheckSchema.safeParse({ ops: Array(11).fill(move) }).success).toBe(false);
    expect(planEditCheckSchema.safeParse({ ops: [{ kind: 'REMOVE_STOPS', stops: Array(41).fill(move.from) }] }).success).toBe(false);
    expect(planEditCheckSchema.safeParse({ ops: [{ kind: 'MOVE_STOPS', stops: [{ orderId: 'o1' }], to: { truckId: 'T', loadId: 'L', order: Array(121).fill({ orderId: 'o1' }) } }] }).success).toBe(false);
    expect(planEditCheckSchema.safeParse({ ops: [{ kind: 'MOVE_LOAD', loadId: 'L', to: { truckId: 'T', before: 'BEST' } }], skipBreak: ['T'] }).success).toBe(true);
    expect(planEditCheckSchema.safeParse({ ops: [{ kind: 'MOVE_STOPS', stops: [], to: { truckId: 'T', loadId: null } }] }).success).toBe(false);
  });
  it('overrides: an id of the right shape, a reason of 3-300 characters, at most 200, never twice; [] is a save with overrides', () => {
    const o = (id: string, reason = 'agreed') => ({ id, reason });
    expect(planEditSaveSchema.safeParse({ move, ...save, overrides: [] }).success).toBe(true);
    expect(planEditSaveSchema.safeParse({ move, ...save, overrides: [o('ovr_0123456789abcdef')] }).success).toBe(true);
    expect(planEditSaveSchema.safeParse({ move, ...save, overrides: [o('ovr_0123')] }).success).toBe(false);
    expect(planEditSaveSchema.safeParse({ move, ...save, overrides: [o('ovr_0123456789abcdef', '  a ')] }).success).toBe(false);
    expect(planEditSaveSchema.safeParse({ move, ...save, overrides: [o('ovr_0123456789abcdef', 'x'.repeat(301))] }).success).toBe(false);
    expect(planEditSaveSchema.safeParse({ move, ...save, overrides: [o('ovr_0123456789abcdef'), o('ovr_0123456789abcdef')] }).success).toBe(false);
    expect(planEditSaveSchema.safeParse({ move, ...save, overrides: Array.from({ length: 201 }, (_, i) => o(`ovr_${i.toString(16).padStart(16, '0')}`)) }).success).toBe(false);
    expect(cleanReason(' agreed\u0000 with\ncustomer ')).toBe('agreed with customer');
  });
});

describe('the words (plan-edit-view.ts)', () => {
  it('an allowance everywhere it is printed, with who on the plan and the load sheet', () => {
    expect(allowedByHandText(allowance({}))).toBe('Allowed by hand: arrives 13:20, after receiving hours 08:00–13:00 (20 min late) - agreed with customer');
    expect(allowedByHandText(allowance({}), { who: true })).toBe('Allowed by hand: arrives 13:20, after receiving hours 08:00–13:00 (20 min late) - agreed with customer (Ahmed, supervisor, 21:40)');
    expect(allowedByHandText(allowance({ rule: 'FINISH', atMin: 815, lateMin: 35 }))).toBe('Allowed by hand: unloading until 13:35, after receiving hours end 13:00 (35 min late) - agreed with customer');
    const pal = allowance({ kind: 'CAPACITY_PALLETS', value: 13.1, maxValue: 13.1, limit: 11.76, capacity: 12, overPct: 9, reason: 'same customer' });
    expect(allowedByHandText(pal)).toBe('Allowed by hand: 13.1 pallets on 12 bays (limit 11.8; 9% over the truck) - same customer');
    expect(allowedBadge(pal)).toBe('ALLOWED BY HAND: 13.1 PALLETS (9% OVER)');
    expect(allowedByHandText(allowance({ kind: 'CAPACITY_CASES', value: 1260, capacity: 1140, overPct: 11, reason: 'r' }))).toBe('Allowed by hand: 1,260 cases (truck takes 1,140; 11% over) - r');
    expect(allowedByHandText(allowance({ kind: 'CAPACITY_KG', value: 8900, capacity: 8000, overPct: 11, reason: 'r' }))).toBe('Allowed by hand: 8,900.0 kg (payload 8,000.0 kg; 11% over) - r');
    const nb = allowance({ kind: 'NO_BREAK', breakMin: 60, breakFromMin: 720, breakToMin: 840, reason: 'r' });
    expect(allowedByHandText(nb)).toBe('Allowed by hand: no driver break today (60 min, to start 12:00–14:00) - r');
    expect(allowedBadge(nb)).toBe('ALLOWED BY HAND: NO DRIVER BREAK');
  });
  it('the RE-PLAN confirmation lists the allowances on Planned loads only (F10)', () => {
    const line = (status: string): PlanAllowanceLine => ({ loadId: 'L', status, truckCode: 'T08', loadNo: 2, kind: 'LATE', text: 'Allowed by hand: x', byName: 'A', at: '' });
    expect(allowancesOnPlannedText([line('PLANNED'), line('LOCKED')])).toEqual(['T08 L2: Allowed by hand: x']);
    expect(allowancesOnPlannedText(undefined)).toEqual([]);
  });
  it('the switch, the startup line, an issue line and the toast', () => {
    expect([planEditOverridesOn({}), planEditOverridesOn({ PLAN_EDIT_OVERRIDES: 'on' }), planEditOverridesOn({ PLAN_EDIT_OVERRIDES: ' OFF ' })]).toEqual([true, true, false]);
    expect(planEditConfigNote({ PLAN_EDIT: 'on' })).toBe(
      'PLAN_EDIT=on: dispatchers can move stops by hand and save them as a new plan version. Rules can be allowed by hand by supervisors and company admins (up to 20% over capacity, late arrivals, driver break). PLAN_EDIT_OVERRIDES=off turns it off.',
    );
    expect(planEditConfigNote({ PLAN_EDIT: 'check', PLAN_EDIT_OVERRIDES: 'off' })).toMatch(/PLAN_EDIT_OVERRIDES=off: rules cannot be allowed by hand\.$/);
    expect(issueText({ kind: 'CAPACITY_CASES', truckCode: 'T08', loadNo: 2, stopLabel: null, amount: { unit: 'cases', value: 1260, limit: 1140, over: 120, overPct: 11 }, message: '' })).toBe(
      'T08 L2 carries 1,260 cases; the truck takes 1,140: 120 cases (11%) over',
    );
    expect(savedText({ runId: 'r', version: 4, reprint: ['T08 L1'], gone: [], trucks: [], allowed: 2, carried: 1 })).toBe(
      'Saved as version 4. Print the sheets again for T08 L1 (load sheet, driver sheet). 3 rules were allowed by hand: they are printed on the load sheet and the driver sheet. A RE-PLAN plans the Planned loads again with every rule: lock them to keep this. A RE-PLAN plans unlocked loads again and may undo this change: lock the load to keep it.',
    );
  });
});

describe('the sheets print what was allowed by hand (design 9, F18)', () => {
  /** The fixture's first load with a late arrival allowed at its first stop and its capacity allowed. */
  async function allowedPlan() {
    const { fixture } = await import('./plan-detail-fixture');
    const d = fixture();
    const l = d.loads[0]!;
    const late = allowance({});
    const cap = allowance({ id: 'ovr_c', kind: 'CAPACITY_CASES', value: 130, maxValue: 130, capacity: 120, overPct: 8, reason: 'one day only' });
    const stops = l.stops.map((s, i) => (i === 0 ? { ...s, hardWindowOk: false, handAllowed: late } : s));
    return { ...d, loads: [{ ...l, stops, handAllowed: [cap] }, ...d.loads.slice(1)] };
  }

  it('driver sheet: no "outside receiving hours" for an allowed stop, its line instead; the load badge and line', async () => {
    const { driverPackModel } = await import('@/lib/dispatch/driver-pack');
    const sheet = driverPackModel(await allowedPlan(), { tenantName: 'T' }).sheets[0]!;
    expect(sheet.stops[0]).toMatchObject({ outsideHours: false, allowedByHand: 'Allowed by hand: arrives 13:20, after receiving hours 08:00–13:00 (20 min late) - agreed with customer' });
    expect(sheet.badges).toContain('ALLOWED BY HAND: 130 CASES (8% OVER)');
    expect(sheet.allowedByHand).toEqual(['Allowed by hand: 130 cases (truck takes 120; 8% over) - one day only']);
  });

  it('WhatsApp, the load sheet (with who), the Excel stop notes (never HARD WINDOW MISSED for an allowed stop) and the driver page', async () => {
    const d = await allowedPlan();
    const { whatsappText } = await import('@/lib/dispatch/driver-links');
    const msg = whatsappText(d.run as never, d.loads[0]! as never, 1);
    expect(msg).toContain('! Allowed by hand: 130 cases (truck takes 120; 8% over) - one day only');
    expect(msg).toContain('! Allowed by hand: arrives 13:20, after receiving hours 08:00–13:00 (20 min late) - agreed with customer');
    const { loadSheetModel } = await import('@/lib/dispatch/warehouse-sheets');
    const ls = loadSheetModel(d, { tenantName: 'T' }).sheets[0]!;
    expect(ls.allowedByHand).toEqual([
      'Allowed by hand: 130 cases (truck takes 120; 8% over) - one day only (Ahmed, supervisor, 21:40)',
      expect.stringMatching(/^.+: Allowed by hand: arrives 13:20, .* - agreed with customer \(Ahmed, supervisor, 21:40\)$/),
    ]);
    const { renderLoadSheetHtml } = await import('@/lib/dispatch/warehouse-sheets-html');
    expect(renderLoadSheetHtml(loadSheetModel(d, { tenantName: 'T' }))).toContain('<div class="instr" data-kind="allowed-by-hand"><div class="instr-h">ALLOWED BY HAND</div>');
    const ExcelJS = (await import('exceljs')).default;
    const { buildDispatchWorkbook } = await import('@/lib/dispatch/workbook');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildDispatchWorkbook({ ...d, allowedByHand: [{ loadId: d.loads[0]!.id, status: 'PLANNED', truckCode: d.loads[0]!.truckCode, loadNo: 1, kind: 'LATE', text: 'Allowed by hand: arrives 13:20 - agreed with customer', byName: 'Ahmed', at: '2026-10-24T17:40:00.000Z' }] }, { tenantName: 'T', currency: 'OMR', generatedAt: new Date('2026-10-25T06:00:00Z'), generatedBy: 'x', assumptions: {}, timezone: 'Asia/Muscat' } as never)) as never);
    const all: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => void all.push(String(c.text ?? '')))));
    expect(all.some((t) => t.includes('ALLOWED BY HAND: LATE (agreed with customer)'))).toBe(true);
    expect(all.some((t) => t.includes('HARD WINDOW MISSED'))).toBe(false);
    expect(all).toContain('RULES ALLOWED BY HAND');
    expect(all.some((t) => t.startsWith('Allowed by hand: arrives 13:20 - agreed with customer (Ahmed, 2026-10-24 21:40)'))).toBe(true);
  });
});
