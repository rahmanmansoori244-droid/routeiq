/**
 * PR9 "Bring forward": orders not delivered on their own day, carried to a later day.
 *
 * - carryCandidates (pure): what counts as not delivered - unserved in the live plan, on a load
 *   that never left (PLANNED / LOCKED / LOADING), a day never planned or an order added after its
 *   plan; orders on DISPATCHED / COMPLETED loads (and DISPATCHED / DELIVERED orders) are delivered;
 *   split orders carry only their open cases per line; deactivated customers, lines already
 *   confirmed for the day, the older of two open copies of one sales-order line and a day being
 *   optimized are listed but not carried; already carried orders never appear again;
 * - checkSelection (pure): idempotency (an order already carried is skipped, so a second run
 *   carries nothing new) and the expected state (other open cases, blocked since, gone: changed);
 * - carryCopyData (pure): the copy's lines, weights per case, money, priority and links;
 * - the planner: a carried order is out of its own day's scope, counts as a waiting late order
 *   on the day it went to, and a load holding one cannot be locked, loaded or dispatched.
 * The real-PostgreSQL path (transaction, lock, unique keys, re-plan) is
 * tests/integration/carry-over.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>) => m.fakePrisma.auditLog.create({ data: { ...input } })) };
});
const session = vi.hoisted(() => ({ role: 'PLANNER' }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: session.role, name: 'P', email: 'p@a.example' } })) }));

import { GET as previewRoute, POST as carryRoute } from '@/app/api/dispatch/carry-over/route';
import {
  bringForward,
  carryCandidates,
  carryCopyData,
  carryLateReason,
  carryOverPreview,
  carryWindow,
  checkSelection,
  isCarryConflict,
  type CarryOrderIn,
  type CarryPlanIn,
  type CarrySource,
  type LaterLine,
  type VisitShortfall,
} from '@/lib/dispatch/carry-over';
import {
  CARRY_TODAY_WARNING,
  carriedFromBadge,
  carriedLoadRemedy,
  carriedLoadShows,
  carriedLoadTitle,
  carriedStopText,
  carriedToBadge,
  carryButtonSuffix,
  carryConfirmText,
  carryDoneText,
  carryResultNote,
  carrySelected,
  carrySelectionPayload,
  carryTickedByDefault,
  carryTodayTitle,
  carryUndoConfirmText,
  carryWhyLabel,
  noOutcomeGroups,
  dayNothingLeftText,
  defaultCarrySelection,
  holdsOnlyCarried,
  orderCarryMarks,
  orderListTotals,
  replanWork,
  toggleCarry,
} from '@/lib/dispatch/carry-view';
import { orderStatusFilter } from '@/lib/orders-list';
import { customerKey, lineDupKey } from '@/lib/dispatch/order-intake';
import { carriedHeldCases, ordersInScopeWhere, pendingLateOrderIds, refreshPlanFacts, updateLoad } from '@/lib/dispatch/plan-service';
import ExcelJS from 'exceljs';
import { buildDispatchWorkbook, carriedOverRows, loadSheetName } from '@/lib/dispatch/workbook';
import { driverPackModel } from '@/lib/dispatch/driver-pack';
import { addDaysIso, fmtDayMonth, todayIso } from '@/lib/dispatch/time';
import { CARRIED_OUT_OF_PLAN } from '@/lib/dashboard';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { fixture } from './plan-detail-fixture';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const D = '2026-09-28';
const D1 = '2026-09-27';
const D2 = '2026-09-26';

function ord(id: string, over: Partial<CarryOrderIn> = {}, lines?: CarryOrderIn['lines']): CarryOrderIn {
  const ls = lines ?? [{ id: `${id}-l1`, cases: 100, weightKg: 1200, salesOrderNo: `SO-${id}`, productCode: 'W500' }];
  return {
    id,
    deliveryDate: D1,
    status: 'ASSIGNED',
    carriedToOrderId: null,
    carriedFromDate: null,
    priority: 3,
    totalCases: ls.reduce((a, l) => a + l.cases, 0),
    totalWeightKg: ls.reduce((a, l) => a + l.weightKg, 0),
    customerId: `c-${id}`,
    customer: { code: `C-${id}`, branchCode: null, branchKey: '__MAIN__', name: `Customer ${id}`, active: true },
    ...over,
    lines: ls,
  };
}

function plan(over: Partial<CarryPlanIn> = {}): CarryPlanIn {
  return { version: 1, status: 'READY', chosen: true, scopeOrderIds: [], loads: [], unserved: [], ...over };
}
const load = (truckCode: string, loadNo: number, status: string, assignments: { orderId: string; portionLinesJson: unknown }[]) => ({ truckCode, loadNo, status, assignments });
/** Day D, the company's today (default: D itself, so every earlier day is over) and the lines already on D. */
const target = (keys: string[] = [], today = D) => ({ date: D, today, confirmedKeys: new Set(keys) });

describe('carryCandidates: what was not delivered', () => {
  it('an order unserved in its day\'s live plan is carried whole, with the unserved reason', () => {
    const o = ord('A');
    const p = plan({ scopeOrderIds: ['A'], unserved: [{ orderId: 'A', reasonCode: 'SOLVER_DROPPED_LOW_PRIORITY', reasonMessage: 'Not enough trucks.', portionLinesJson: null }] });
    const [c] = carryCandidates([o], new Map([[D1, p]]), target());
    expect(c).toMatchObject({ orderId: 'A', date: D1, firstDate: D1, cases: 100, orderCases: 100, weightKg: 1200, partial: false, blocked: null });
    expect(c.why).toEqual([{ kind: 'UNSERVED', reasonCode: 'SOLVER_DROPPED_LOW_PRIORITY', text: 'Unserved: Not enough trucks.' }]);
    expect(c.lines).toEqual([{ lineId: 'A-l1', productCode: 'W500', salesOrderNo: 'SO-A', cases: 100, lineCases: 100 }]);
  });

  it('an order on a load that never left the depot (PLANNED, LOCKED or LOADING) is carried; the loads are named', () => {
    const orders = ['P', 'L', 'G'].map((id) => ord(id));
    const p = plan({
      scopeOrderIds: ['P', 'L', 'G'],
      loads: [
        load('T01', 1, 'PLANNED', [{ orderId: 'P', portionLinesJson: null }]),
        load('T01', 2, 'LOCKED', [{ orderId: 'L', portionLinesJson: null }]),
        load('T02', 1, 'LOADING', [{ orderId: 'G', portionLinesJson: null }]),
      ],
    });
    const out = carryCandidates(orders, new Map([[D1, p]]), target());
    expect(out.map((c) => [c.orderId, c.cases, c.why[0].kind, c.why[0].text])).toEqual([
      ['G', 100, 'NOT_LEFT', 'On T02 L1 (loading): never left the depot'],
      ['L', 100, 'NOT_LEFT', 'On T01 L2 (locked): never left the depot'],
      ['P', 100, 'NOT_LEFT', 'On T01 L1 (planned): never left the depot'],
    ]);
  });

  it('orders on DISPATCHED or COMPLETED loads count as delivered and are never carried; nor DISPATCHED / DELIVERED orders', () => {
    const orders = [ord('X'), ord('Y'), ord('Z', { status: 'DISPATCHED' }), ord('W', { status: 'DELIVERED' })];
    const p = plan({
      scopeOrderIds: ['X', 'Y', 'Z', 'W'],
      loads: [load('T01', 1, 'DISPATCHED', [{ orderId: 'X', portionLinesJson: null }]), load('T02', 1, 'COMPLETED', [{ orderId: 'Y', portionLinesJson: null }])],
    });
    expect(carryCandidates(orders, new Map([[D1, p]]), target())).toEqual([]);
  });

  it('a day with no plan, a plan never optimized, and an order added after its plan: never planned', () => {
    const a = ord('A', { deliveryDate: D2 });
    const b = ord('B');
    const c = ord('C', { deliveryDate: '2026-09-25' });
    const plans = new Map<string, CarryPlanIn | null>([
      [D2, null],
      [D1, plan({ version: 2, scopeOrderIds: ['other'] })],
      ['2026-09-25', plan({ chosen: false, scopeOrderIds: null })],
    ]);
    const out = carryCandidates([a, b, c], plans, target());
    expect(out.map((x) => [x.orderId, x.why])).toEqual([
      ['C', [{ kind: 'NEVER_PLANNED', text: 'The 25 Sep plan (version 1) was never optimized' }]],
      ['A', [{ kind: 'NEVER_PLANNED', text: 'No plan was made for 26 Sep' }]],
      ['B', [{ kind: 'NEVER_PLANNED', text: 'Added after the 27 Sep plan (version 2) was made: never planned' }]],
    ]);
  });

  it('a split order carries only its open part: the cases per line not on a load that left', () => {
    // Line 1: 60 of 100 cases dispatched, 40 unserved. Line 2: 30 of 50 on a LOCKED load, 20 completed.
    const o = ord('S', {}, [
      { id: 'S-l1', cases: 100, weightKg: 1000, salesOrderNo: 'SO-S', productCode: 'W500' },
      { id: 'S-l2', cases: 50, weightKg: 250, salesOrderNo: 'SO-S', productCode: 'W1500' },
    ]);
    const p = plan({
      scopeOrderIds: ['S'],
      loads: [
        load('T01', 1, 'DISPATCHED', [{ orderId: 'S', portionLinesJson: [{ lineId: 'S-l1', cases: 60 }] }]),
        load('T02', 1, 'COMPLETED', [{ orderId: 'S', portionLinesJson: [{ lineId: 'S-l2', cases: 20 }] }]),
        load('T02', 2, 'LOCKED', [{ orderId: 'S', portionLinesJson: [{ lineId: 'S-l2', cases: 30 }] }]),
      ],
      unserved: [{ orderId: 'S', reasonCode: 'TRIP_LIMIT', reasonMessage: 'Trucks out of loads.', portionLinesJson: [{ lineId: 'S-l1', cases: 40 }] }],
    });
    const [c] = carryCandidates([o], new Map([[D1, p]]), target());
    expect(c.cases).toBe(70);
    expect(c.orderCases).toBe(150);
    expect(c.partial).toBe(true);
    expect(c.lines.map((l) => [l.lineId, l.cases, l.lineCases])).toEqual([
      ['S-l1', 40, 100],
      ['S-l2', 30, 50],
    ]);
    expect(c.weightKg).toBe(40 * 10 + 30 * 5); // the weight per case recorded on each line
    expect(c.why.map((w) => w.kind)).toEqual(['NOT_LEFT', 'UNSERVED']);
    expect(c.why[1].text).toBe('Unserved (40 cases): Trucks out of loads.');
  });

  it('a split order whose every part left is delivered, even though one part is still unserved in an older row', () => {
    const o = ord('S');
    const p = plan({
      scopeOrderIds: ['S'],
      loads: [
        load('T01', 1, 'DISPATCHED', [{ orderId: 'S', portionLinesJson: [{ lineId: 'S-l1', cases: 70 }] }]),
        load('T01', 2, 'COMPLETED', [{ orderId: 'S', portionLinesJson: [{ lineId: 'S-l1', cases: 30 }] }]),
      ],
    });
    expect(carryCandidates([o], new Map([[D1, p]]), target())).toEqual([]);
  });

  it('orders of a deactivated customer are listed with the reason, not carried', () => {
    const o = ord('A', { customer: { code: 'C9', branchCode: 'B2', branchKey: 'B2', name: 'Closed shop', active: false } });
    const [c] = carryCandidates([o], new Map([[D1, null]]), target());
    expect(c.blocked).toEqual({ code: 'CUSTOMER_INACTIVE', text: 'Customer C9/B2 is deactivated: reactivate it in Customers to bring this order forward.' });
  });

  it('already carried orders never appear again, and only earlier days count', () => {
    const out = carryCandidates([ord('A', { carriedToOrderId: 'A2' }), ord('B', { deliveryDate: D }), ord('C', { deliveryDate: '2026-09-29' })], new Map(), target());
    expect(out).toEqual([]);
  });

  it('a sales-order line already confirmed for the day (entered again) is not carried, so the day never gets it twice', () => {
    const o = ord('A');
    const key = lineDupKey(D, 'so-a ', customerKey('c-a', '__main__'), 'w500');
    const [c] = carryCandidates([o], new Map([[D1, null]]), target([key]));
    expect(c.blocked?.code).toBe('ALREADY_ON_DAY');
    expect(c.blocked?.text).toBe('Sales order SO-A (W500) is already confirmed for 28 Sep: not brought forward. Check whether it was entered again for that day.');
  });

  it('the same sales-order line open on two earlier days: only the newer order is carried', () => {
    const old = ord('OLD', { deliveryDate: D2, customer: { code: 'C1', branchCode: null, branchKey: '__MAIN__', name: 'C1', active: true } }, [
      { id: 'o-l1', cases: 10, weightKg: 100, salesOrderNo: 'SO-9', productCode: 'W500' },
    ]);
    const neu = ord('NEW', { customer: { code: 'c1', branchCode: null, branchKey: '__MAIN__', name: 'C1', active: true } }, [
      { id: 'n-l1', cases: 10, weightKg: 100, salesOrderNo: ' so-9', productCode: 'w500' },
    ]);
    const out = carryCandidates([old, neu], new Map([[D2, null], [D1, null]]), target());
    expect(out.find((c) => c.orderId === 'NEW')!.blocked).toBeNull();
    expect(out.find((c) => c.orderId === 'OLD')!.blocked).toEqual({
      code: 'SAME_LINE_LATER',
      text: 'Sales order SO-9 (W500) is also open on 27 Sep: only that order is brought forward.',
    });
  });

  it('a day whose plan is being optimized right now is listed but not carried', () => {
    const [c] = carryCandidates([ord('A')], new Map([[D1, plan({ status: 'OPTIMIZING', scopeOrderIds: ['A'], unserved: [] })]]), target());
    expect(c.blocked?.code).toBe('DAY_OPTIMIZING');
  });

  it('an order carried before keeps the date it was first due; older orders weighed on the order use its kg per case', () => {
    const o = ord('A', { carriedFromDate: '2026-09-24', totalWeightKg: 500 }, [{ id: 'A-l1', cases: 100, weightKg: 0, salesOrderNo: null, productCode: 'W500' }]);
    const [c] = carryCandidates([o], new Map([[D1, null]]), target());
    expect(c.firstDate).toBe('2026-09-24');
    expect(c.weightKg).toBe(500);
    expect(c.salesOrders).toEqual([]);
  });
});

describe("today's orders: listed in their own group, unticked (owner decision); days not due yet never", () => {
  const TODAY = D1; // 27 Sep; the day screen opens on tomorrow, D = 28 Sep (planned in the evening)
  it('the window is [D-7, D-1] capped at today; for D = today it ends yesterday; a day more than a week ahead has none', () => {
    expect(carryWindow('2026-09-27', '2026-09-27')).toEqual({ from: '2026-09-20', to: '2026-09-26' });
    expect(carryWindow('2026-09-28', '2026-09-27')).toEqual({ from: '2026-09-21', to: '2026-09-27' });
    expect(carryWindow('2026-09-30', '2026-09-27')).toEqual({ from: '2026-09-23', to: '2026-09-27' });
    expect(carryWindow('2026-09-20', '2026-09-27')).toEqual({ from: '2026-09-13', to: '2026-09-19' });
    const far = carryWindow('2026-10-10', '2026-09-27');
    expect(far.to < far.from).toBe(true);
  });

  it("D = tomorrow: today's orders on loads that have not left, unserved or not planned are listed as today's, exactly like an earlier day's; on a load that left never", () => {
    const orders = [
      ord('TP', { deliveryDate: TODAY }), // afternoon trip, still PLANNED
      ord('TL', { deliveryDate: TODAY }), // loaded last night, LOCKED
      ord('TG', { deliveryDate: TODAY }), // LOADING
      ord('TU', { deliveryDate: TODAY }), // unserved
      ord('TN', { deliveryDate: TODAY }), // a late order not planned yet
      ord('TD', { deliveryDate: TODAY }), // on a DISPATCHED load
      ord('TC', { deliveryDate: TODAY }), // on a COMPLETED load
      ord('Y', { deliveryDate: D2 }),
    ];
    const todayPlan = plan({
      scopeOrderIds: ['TP', 'TL', 'TG', 'TU', 'TD', 'TC'],
      loads: [
        load('T01', 1, 'LOCKED', [{ orderId: 'TL', portionLinesJson: null }]),
        load('T01', 2, 'PLANNED', [{ orderId: 'TP', portionLinesJson: null }]),
        load('T02', 1, 'LOADING', [{ orderId: 'TG', portionLinesJson: null }]),
        load('T03', 1, 'DISPATCHED', [{ orderId: 'TD', portionLinesJson: null }]),
        load('T04', 1, 'COMPLETED', [{ orderId: 'TC', portionLinesJson: null }]),
      ],
      unserved: [{ orderId: 'TU', reasonCode: 'TRIP_LIMIT', reasonMessage: 'Trucks out of loads.', portionLinesJson: null }],
    });
    const out = carryCandidates(orders, new Map([[TODAY, todayPlan], [D2, null]]), target([], TODAY));
    expect(out.map((c) => [c.orderId, c.ofToday, c.why[0].kind, c.why[0].text, c.blocked])).toEqual([
      ['Y', false, 'NEVER_PLANNED', 'No plan was made for 26 Sep', null],
      ['TG', true, 'NOT_LEFT', 'On T02 L1 (loading): has not left the depot yet', null],
      ['TL', true, 'NOT_LEFT', 'On T01 L1 (locked): has not left the depot yet', null],
      ['TN', true, 'NEVER_PLANNED', 'Added after the 27 Sep plan (version 1) was made: not planned yet', null],
      ['TP', true, 'NOT_LEFT', 'On T01 L2 (planned): has not left the depot yet', null],
      ['TU', true, 'UNSERVED', 'Unserved: Trucks out of loads.', null],
    ]);
    // Earlier days are ticked by default, today's never: today's loads may still go out today.
    expect([...defaultCarrySelection(out)]).toEqual(['Y']);
    // The same orders once the day is over (the next morning, D = 28 Sep = today): earlier days, ticked.
    const later = carryCandidates(orders, new Map([[TODAY, todayPlan], [D2, null]]), target([], D));
    expect(later.map((c) => [c.orderId, c.ofToday, c.why[0].kind])).toEqual([
      ['Y', false, 'NEVER_PLANNED'],
      ['TG', false, 'NOT_LEFT'],
      ['TL', false, 'NOT_LEFT'],
      ['TN', false, 'NEVER_PLANNED'],
      ['TP', false, 'NOT_LEFT'],
      ['TU', false, 'UNSERVED'],
    ]);
    expect(later.find((c) => c.orderId === 'TL')!.why[0].text).toBe('On T01 L1 (locked): never left the depot');
    expect(defaultCarrySelection(later).size).toBe(6);
  });

  it("D = today: today's own orders are never listed (an order is never brought forward to its own day)", () => {
    const out = carryCandidates([ord('T', { deliveryDate: D }), ord('Y', { deliveryDate: D1 })], new Map([[D, null], [D1, null]]), target([], D));
    expect(out.map((c) => [c.orderId, c.ofToday])).toEqual([['Y', false]]);
  });

  it("D = today + 2: tomorrow's confirmed orders are not due yet and never listed; today's are, as today's", () => {
    const tomorrow = D; // 28 Sep
    const out = carryCandidates(
      [ord('TM', { deliveryDate: tomorrow }), ord('TD', { deliveryDate: TODAY }), ord('Y', { deliveryDate: D2 })],
      new Map([[tomorrow, null], [TODAY, null], [D2, null]]),
      { date: '2026-09-29', today: TODAY, confirmedKeys: new Set() },
    );
    expect(out.map((c) => [c.orderId, c.ofToday])).toEqual([
      ['Y', false],
      ['TD', true],
    ]);
    expect(out[1].why[0].text).toBe('No plan made for 27 Sep yet');
  });

  it("a line of an older order that is also on today's open order: only today's can be brought forward (and only when ticked)", () => {
    const c1 = { code: 'C1', branchCode: null, branchKey: '__MAIN__', name: 'C1', active: true };
    const old = ord('OLD', { deliveryDate: D2, customerId: 'c1', customer: c1 }, [{ id: 'o-l1', cases: 10, weightKg: 100, salesOrderNo: 'SO-9', productCode: 'W500' }]);
    const neu = ord('NEW', { deliveryDate: TODAY, customerId: 'c1', customer: c1 }, [{ id: 'n-l1', cases: 10, weightKg: 100, salesOrderNo: 'SO-9', productCode: 'W500' }]);
    const out = carryCandidates([old, neu], new Map([[D2, null], [TODAY, null]]), target([], TODAY));
    expect(out.map((c) => [c.orderId, c.ofToday, c.blocked])).toEqual([
      ['OLD', false, { code: 'SAME_LINE_LATER', text: 'Sales order SO-9 (W500) is also open today (27 Sep): only that order can be brought forward.' }],
      ['NEW', true, null],
    ]);
    expect(defaultCarrySelection(out).size).toBe(0);
  });
});

describe('checkSelection: the expected state, and idempotency', () => {
  const cands = carryCandidates([ord('A'), ord('B', { customer: { code: 'CB', branchCode: null, branchKey: '__MAIN__', name: 'B', active: false } })], new Map([[D1, null]]), target());

  it('carries exactly what the screen showed', () => {
    const r = checkSelection(cands, [{ orderId: 'A', cases: 100 }], new Map());
    expect(r.carry.map((c) => c.orderId)).toEqual(['A']);
    expect(r.skipped).toEqual([]);
    expect(r.changed).toEqual([]);
  });

  it('a second run carries nothing new: an order already carried is skipped, not an error', () => {
    // After the first run the order is carried: it is no longer a candidate, and it is skipped.
    const after = carryCandidates([ord('A', { carriedToOrderId: 'A2' })], new Map([[D1, null]]), target());
    expect(after).toEqual([]);
    const r = checkSelection(after, [{ orderId: 'A', cases: 100 }], new Map([['A', D]]));
    expect(r.carry).toEqual([]);
    expect(r.changed).toEqual([]);
    expect(r.skipped).toEqual([{ orderId: 'A', code: 'ALREADY_CARRIED', text: 'Already brought forward to 28 Sep.' }]);
  });

  it('other open cases than shown, a blocked order and an unknown id are "changed": nothing is carried', () => {
    const r = checkSelection(
      cands,
      [
        { orderId: 'A', cases: 90 },
        { orderId: 'B', cases: 100 },
        { orderId: 'nope', cases: 5 },
      ],
      new Map(),
    );
    expect(r.carry).toEqual([]);
    expect(r.changed.map((c) => c.orderId)).toEqual(['A', 'B', 'nope']);
    expect(r.changed[0].text).toBe('C-A (27 Sep): 100 cases are open now, the list showed 90.');
    expect(r.changed[1].text).toMatch(/^CB \(27 Sep\): Customer CB is deactivated/);
  });

  it('an order of today is carried only when sent with today: true (ticked on its own), never implied by the earlier days', () => {
    // 27 Sep is today, D = 28 Sep: Y (26 Sep) is an earlier day, T (27 Sep) is today's.
    const cs = carryCandidates([ord('Y', { deliveryDate: D2 }), ord('T')], new Map([[D2, null], [D1, null]]), target([], D1));
    expect(cs.map((c) => [c.orderId, c.ofToday])).toEqual([
      ['Y', false],
      ['T', true],
    ]);
    // Every listed order sent as the earlier days are ("select all"): today's is refused, not carried.
    const implied = checkSelection(cs, [{ orderId: 'Y', cases: 100 }, { orderId: 'T', cases: 100 }], new Map());
    expect(implied.carry.map((c) => c.orderId)).toEqual(['Y']);
    expect(implied.changed).toEqual([]);
    expect(implied.todayNotSelected).toEqual([
      { orderId: 'T', text: 'C-T is an order of today (27 Sep): it may still go out today, so it is brought forward only when it is ticked under Today.' },
    ]);
    expect(checkSelection(cs, [{ orderId: 'T', cases: 100, today: false }], new Map()).todayNotSelected.map((c) => c.orderId)).toEqual(['T']);
    // Ticked under Today: carried like an earlier day's order.
    const ticked = checkSelection(cs, [{ orderId: 'Y', cases: 100 }, { orderId: 'T', cases: 100, today: true }], new Map());
    expect(ticked.carry.map((c) => c.orderId)).toEqual(['Y', 'T']);
    expect([ticked.changed, ticked.todayNotSelected]).toEqual([[], []]);
    // The day screen sends exactly that: today's orders it ticked carry today: true.
    expect(carrySelectionPayload(cs, new Set(['Y', 'T']))).toEqual([
      { orderId: 'Y', cases: 100 },
      { orderId: 'T', cases: 100, today: true },
    ]);
  });
});

describe('carryCopyData: the order on the later day', () => {
  const src: CarrySource = {
    id: 'S',
    customerId: 'cust',
    deliveryDate: new Date(`${D1}T00:00:00Z`),
    carriedFromDate: null,
    totalCases: 150,
    totalWeightKg: 1250,
    totalVolumeL: 300,
    totalServiceTimeMin: 15,
    paymentCollectionAmount: 0,
    priority: 2,
    priorityFromFile: true,
    notes: 'Back gate',
    salesValue: 300,
    marginValue: 60,
    lines: [
      { id: 'S-l1', productId: 'p1', cases: 100, salesOrderNo: 'SO-S', orderDate: null, productDescription: 'Water 500', weightKg: 1000, weightFromMaster: false, salesValue: 200, marginValue: 40, sourceRow: 4, notes: null },
      { id: 'S-l2', productId: 'p2', cases: 50, salesOrderNo: 'SO-S', orderDate: null, productDescription: 'Water 1.5', weightKg: 250, weightFromMaster: true, salesValue: 100, marginValue: 20, sourceRow: 5, notes: 'fragile' },
    ],
  };
  const cand = { date: D1, firstDate: D1, cases: 70, lines: [{ lineId: 'S-l1', productCode: 'W500', salesOrderNo: 'SO-S', cases: 40, lineCases: 100 }, { lineId: 'S-l2', productCode: 'W1500', salesOrderNo: 'SO-S', cases: 30, lineCases: 50 }] };
  const now = new Date('2026-09-28T04:00:00Z');

  it('same customer, sales orders, products and weight per case; the open cases; money shared by cases; priority kept', () => {
    const data = carryCopyData(src, cand, { tenantId: 't', depotId: 'd', date: D, late: true, userId: 'u', now });
    const lines = (data.lines as { create: Record<string, unknown>[] }).create;
    expect(lines).toEqual([
      { productId: 'p1', cases: 40, salesOrderNo: 'SO-S', orderDate: null, productDescription: 'Water 500', weightKg: 400, weightFromMaster: false, salesValue: 80, marginValue: 16, sourceRow: 4, notes: null },
      { productId: 'p2', cases: 30, salesOrderNo: 'SO-S', orderDate: null, productDescription: 'Water 1.5', weightKg: 150, weightFromMaster: true, salesValue: 60, marginValue: 12, sourceRow: 5, notes: 'fragile' },
    ]);
    expect(data).toMatchObject({
      tenantId: 't',
      customerId: 'cust',
      depotId: 'd',
      deliveryDate: new Date(`${D}T00:00:00.000Z`),
      totalCases: 70,
      totalWeightKg: 550,
      totalVolumeL: 140,
      priority: 2, // no automatic bump
      priorityFromFile: true,
      notes: 'Back gate',
      status: 'VALIDATED',
      uploadBatchId: null,
      isLate: true,
      lateRecordedById: 'u',
      salesValue: 140,
      marginValue: 28,
      carriedFromOrderId: 'S',
      carriedFromDate: new Date(`${D1}T00:00:00.000Z`),
    });
    expect(data.lateReason).toBe('Brought forward from 27 Sep: not delivered on that day.');
  });

  it('an order carried again keeps the date it was first due', () => {
    const data = carryCopyData({ ...src, carriedFromDate: new Date('2026-09-24T00:00:00Z') }, cand, { tenantId: 't', depotId: 'd', date: D, late: false, userId: 'u', now });
    expect(data.carriedFromDate).toEqual(new Date('2026-09-24T00:00:00Z'));
    expect(data.isLate).toBe(false);
  });

  it('refuses a line that is not on the order (never a silent wrong copy)', () => {
    expect(() => carryCopyData(src, { ...cand, lines: [{ lineId: 'other', productCode: 'X', salesOrderNo: null, cases: 1, lineCases: 1 }] }, { tenantId: 't', depotId: 'd', date: D, late: false, userId: 'u', now })).toThrow(/not on order S/);
  });
});

describe('the words on every screen and paper', () => {
  it('badges, the stop line, the selection sent and the toast', () => {
    expect(fmtDayMonth('2026-09-27')).toBe('27 Sep');
    expect(carriedFromBadge('2026-09-27')).toBe('Carried over from 27 Sep');
    expect(carriedToBadge('2026-10-01')).toBe('Carried over to 1 Oct');
    expect(carriedStopText({ carriedFrom: '2026-09-27', carriedTo: null })).toBe('CARRIED OVER from 27 Sep (not delivered that day)');
    expect(carriedStopText({ carriedFrom: null, carriedTo: '2026-09-28' })).toBe('CARRIED OVER to 28 Sep - not delivered on this day');
    expect(carriedStopText({ carriedFrom: null, carriedTo: null })).toBeNull();
    const cands = [
      { orderId: 'A', cases: 10, blocked: null },
      { orderId: 'B', cases: 5, blocked: { code: 'CUSTOMER_INACTIVE' } },
      { orderId: 'C', cases: 7, blocked: null },
    ];
    expect([...defaultCarrySelection(cands)]).toEqual(['A', 'C']);
    expect(carrySelectionPayload(cands, new Set(['A', 'B']))).toEqual([{ orderId: 'A', cases: 10 }]);
    expect(carryDoneText({ orders: 2, cases: 17, skipped: [], replanNeeded: true }, D)).toBe(
      '2 order(s) (17 cases) brought forward to 28 Sep. RE-PLAN to add them to the plan: locked, loading and dispatched loads stay exactly as they are.',
    );
    expect(carryDoneText({ orders: 0, cases: 0, skipped: [{}], replanNeeded: false }, D)).toBe('Nothing new to bring forward: 1 order(s) were already brought forward.');
  });

  it("today's group: its heading, the owner's warning, and the question before bringing today's orders forward", () => {
    expect(carryTodayTitle('2026-09-27')).toBe('Today (27 Sep) - may still leave today');
    expect(CARRY_TODAY_WARNING).toBe("Today's loads that have not left yet may still go out today; tick only orders you know will not be delivered today.");
    const earlierOnly = carryConfirmText([{ cases: 10, ofToday: false }, { cases: 5, ofToday: false }], D, D1);
    expect(earlierOnly).toBe(
      'Bring 2 order(s) (15 cases) forward to 28 Sep?\n\nThey become orders of 28 Sep and are no longer open on their own days. The plans of those days stay as they are.',
    );
    const withToday = carryConfirmText([{ cases: 10, ofToday: false }, { cases: 20, ofToday: true }], D, D1);
    // Review of the owner decision: today's plan rows stay as they are (the load keeps the order -
    // that is why it is blocked), so the question never says they "come off today's plan".
    expect(withToday).toBe(
      'Bring 2 order(s) (30 cases) forward to 28 Sep?\n\n' +
        "1 of them (20 cases) are orders of TODAY (27 Sep): they are closed on today (today's plan stays as it is, for the record), and a load of today that still holds one cannot be locked, loaded or dispatched today. Only continue if you know they will not be delivered today." +
        '\n\nThey become orders of 28 Sep and are no longer open on their own days. The plans of those days stay as they are.',
    );
    expect(withToday).not.toMatch(/come off/);
    // The toast after bringing orders of today forward: their loads of today - re-plan today or unlock.
    const done = { orders: 2, cases: 30, skipped: [], replanNeeded: true, carried: [{ fromDate: D2 }, { fromDate: D1 }] };
    expect(carryDoneText(done, D, D1)).toBe(
      '2 order(s) (30 cases) brought forward to 28 Sep. RE-PLAN to add them to the plan: locked, loading and dispatched loads stay exactly as they are. ' +
        '1 of them were orders of today (27 Sep): a load of today that still holds one cannot be locked, loaded or dispatched - re-plan today for its other orders, or unlock it (a loading one goes Back to locked first; unload a loaded one).',
    );
    expect(carryDoneText({ ...done, carried: [{ fromDate: D2 }] }, D, D1)).not.toMatch(/today/);
  });

  it("today's rows say \"Load not left yet\" / \"Not planned\" (never \"never\"), and the button's count names today's ticked orders", () => {
    expect(carryWhyLabel('NOT_LEFT', false)).toBe('Load never left');
    expect(carryWhyLabel('NEVER_PLANNED', false)).toBe('Never planned');
    expect(carryWhyLabel('UNSERVED', false)).toBe('Unserved');
    // Today's loads have not left YET ("may still leave today"): never "Load never left" / "Never planned".
    expect(carryWhyLabel('NOT_LEFT', true)).toBe('Load not left yet');
    expect(carryWhyLabel('NEVER_PLANNED', true)).toBe('Not planned');
    expect(carryWhyLabel('UNSERVED', true)).toBe('Unserved');
    const y = (cases: number) => ({ cases, ofToday: false });
    const t = (cases: number) => ({ cases, ofToday: true });
    // Exactly every order of the earlier days: no count. Anything else: the count, with today's.
    expect(carryButtonSuffix([y(10), y(5)], { orders: 2 })).toBe('');
    expect(carryButtonSuffix([y(10)], { orders: 2 })).toBe(' (1 order(s), 10 cases)');
    expect(carryButtonSuffix([y(10), y(5), t(20)], { orders: 2 })).toBe(' (3 order(s), 35 cases, 1 of today)');
    // As many as the earlier days' orders, but one is today's (an earlier one unticked): still counted and named.
    expect(carryButtonSuffix([y(10), t(20)], { orders: 2 })).toBe(' (2 order(s), 30 cases, 1 of today)');
    expect(carryButtonSuffix([t(20), t(7)], { orders: 0 })).toBe(' (2 order(s), 27 cases, 2 of today)');
    expect(carryButtonSuffix([], { orders: 0 })).toBe('');
  });

  it('the driver sheet and the Excel SUMMARY mark carried orders', () => {
    const d = fixture();
    d.loads[0].stops[0].carriedFrom = '2026-09-26';
    d.carriedIn = { orders: 1, cases: d.loads[0].stops[0].cases, dates: ['2026-09-26'] };
    const sheet = driverPackModel(d, { tenantName: 'NMWC' }).sheets[0];
    expect(sheet.stops[0].carried).toBe('CARRIED OVER from 26 Sep (not delivered that day)');
    expect(sheet.stops.slice(1).every((s) => s.carried === null)).toBe(true);
    const rows = carriedOverRows(d);
    expect(rows[0][0]).toBe('Brought forward from earlier days');
    expect(rows[0][1]).toBe(`1 order · ${d.loads[0].stops[0].cases} cases`);
    expect(rows[1][0]).toBe('  from 26 Sep');
    expect(rows[1][1]).toContain(d.loads[0].stops[0].customerCode);
    expect(carriedOverRows({ ...d, carriedIn: null, carriedOut: { orders: 2, cases: 30, dates: [D] } })).toEqual([
      ['Brought forward to later days', '2 orders · 30 cases', 'to 28 Sep: not delivered on this day, planned there - do not load them from this plan'],
    ]);
    expect(carriedOverRows({ ...d, carriedIn: null, carriedOut: null })).toEqual([]);
  });

  it('the Excel workbook: CARRIED OVER on SUMMARY, on the stop of the load sheet and on the unserved sheet', async () => {
    const d = fixture();
    d.loads[0].stops[0].carriedFrom = '2026-09-26';
    d.carriedIn = { orders: 1, cases: d.loads[0].stops[0].cases, dates: ['2026-09-26'] };
    d.unserved[0] = { ...d.unserved[0], carriedTo: '2026-09-28' };
    const buf = await buildDispatchWorkbook(d, { tenantName: 'NMWC', currency: 'OMR', generatedAt: new Date('2026-09-27T05:00:00Z'), generatedBy: 'Planner', assumptions: {} });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const texts = (name: string) => {
      const out: string[] = [];
      wb.getWorksheet(name)!.eachRow((r) => r.eachCell((c) => out.push(c.text)));
      return out;
    };
    const summary = texts('SUMMARY');
    expect(summary).toContain('CARRIED OVER');
    expect(summary).toContain('Brought forward from earlier days');
    // The first load's sheet (the first load sheet gets its plain name).
    const loadSheet = wb.getWorksheet(loadSheetName(d.loads[0].truckCode, d.loads[0].loadNo, new Set()))!;
    const onLoad: string[] = [];
    loadSheet.eachRow((r) => r.eachCell((c) => onLoad.push(c.text)));
    expect(onLoad.some((t) => t.includes('CARRIED OVER from 26 Sep (not delivered that day)'))).toBe(true);
    expect(texts('UNSERVED - EXCEPTIONS').some((t) => t.startsWith('CARRIED OVER to 28 Sep: planned on that day now.'))).toBe(true);
  });

  it('the dashboard counts a carried order once: its own day subtracts it from its orders and unserved', () => {
    const sql = CARRIED_OUT_OF_PLAN.sql;
    expect(sql).toContain('"carriedToOrderId" IS NOT NULL');
    expect(sql).toContain('"UnservedOrder"');
    expect(sql).toContain('"RouteAssignment"');
  });

  it('a unique-index error of a carry or a line key is a conflict (409), anything else is not', () => {
    expect(isCarryConflict({ code: 'P2002', meta: { target: ['carriedFromOrderId'] } })).toBe(true);
    expect(isCarryConflict({ code: 'P2002', meta: { modelName: 'IntakeLineKey', target: ['tenantId', 'deliveryDate'] } })).toBe(true);
    expect(isCarryConflict({ code: 'P2002', meta: { target: ['email'] } })).toBe(false);
    expect(isCarryConflict({ code: 'P2003' })).toBe(false);
  });
});

describe('the planner around carried orders', () => {
  beforeEach(() => resetDb());

  it('a carried order no longer belongs to its own day (not open, unserved or pending there)', async () => {
    tables.depot = [{ id: 'D1', tenantId: 'tA', active: true }];
    const where = await ordersInScopeWhere('tA', 'D1', new Date(`${D1}T00:00:00Z`));
    expect(where).toMatchObject({ tenantId: 'tA', carriedToOrderId: null });
  });

  it('the "open orders" warning of a customer deactivation counts the copy, not the carried original', async () => {
    tables.tenantConfig = [{ id: 'cfg', tenantId: 'tA', timezone: 'Asia/Muscat' }];
    const day = new Date('2099-01-02T00:00:00Z');
    tables.order = [
      { id: 'ORIG', tenantId: 'tA', customerId: 'c1', status: 'UNSERVED', deliveryDate: day, carriedToOrderId: 'COPY' },
      { id: 'COPY', tenantId: 'tA', customerId: 'c1', status: 'VALIDATED', deliveryDate: new Date('2099-01-03T00:00:00Z'), carriedToOrderId: null },
    ];
    const { openOrders } = await import('@/lib/dispatch/open-orders');
    expect((await openOrders('tA', { customerId: 'c1' })).orders).toBe(1);
  });

  it('on the day it went to, a carried order waits like a late order: RE-PLAN adds it with reason LATE_ORDER', async () => {
    tables.depot = [{ id: 'D1', tenantId: 'tA', active: true }];
    tables.scenarioResult = [{ id: 'sc1', runId: 'P', detailsJson: { scope: { orderIds: ['IN'], frozenOrderIds: [], orderPriority: {} }, loads: [] } }];
    const day = new Date(`${D}T00:00:00Z`);
    tables.order = [
      { id: 'IN', tenantId: 'tA', depotId: 'D1', deliveryDate: day, isLate: false },
      { id: 'COPY', tenantId: 'tA', depotId: 'D1', deliveryDate: day, isLate: false, carriedFromOrderId: 'ORIG' },
      { id: 'LATE', tenantId: 'tA', depotId: 'D1', deliveryDate: day, isLate: true },
      { id: 'NEW', tenantId: 'tA', depotId: 'D1', deliveryDate: day, isLate: false },
    ];
    const ids = await pendingLateOrderIds('tA', { depotId: 'D1', runDate: day, chosenScenarioId: 'sc1' });
    expect(ids.sort()).toEqual(['COPY', 'LATE']);
  });

  describe('a load holding an order brought forward cannot move forward (it would be delivered twice)', () => {
    const T = 'tA';
    const user = { id: 'u1', role: 'TENANT_ADMIN' };
    const allow = () => true;
    /** 10:00 in Muscat on 28 Sep: the load's day (27 Sep) is over. */
    const AFTER = { now: new Date('2026-09-28T06:00:00Z') };
    /** 21:00 in Muscat on 27 Sep: the load's day is today (orders brought forward to tomorrow in the evening). */
    const TONIGHT = { now: new Date('2026-09-27T17:00:00Z') };
    function seed(loadStatus: string) {
      const day = new Date(`${D1}T00:00:00Z`);
      tables.truck = [{ id: 'T1', tenantId: T, code: 'T01', defaultDriverId: null, capacityCases: 100, capacityWeightKg: 1000 }];
      tables.order = [
        { id: 'O1', tenantId: T, depotId: 'D1', customerId: 'c1', customer: { code: 'C1', branchCode: null }, totalCases: 40, totalWeightKg: 400, status: 'ASSIGNED', deliveryDate: day, carriedToOrderId: 'O1b', carriedTo: { deliveryDate: new Date(`${D}T00:00:00Z`) } },
      ];
      tables.runPlan = [{
        id: 'P', tenantId: T, depotId: 'D1', runDate: day, status: 'READY', version: 1, reason: 'INITIAL', chosenScenarioId: 'sc1', parentRunId: null, supersededAt: null,
        currentJobId: null, finalizedAt: null, reconciliationJson: { ok: true }, summaryJson: null, feasibilityJson: null, createdAt: new Date('2026-09-26T12:00:00Z'),
      }];
      tables.planLoad = [{ id: 'L1', tenantId: T, runId: 'P', truckId: 'T1', loadNo: 1, status: loadStatus, departMin: 400, returnMin: 500, cases: 40, carriedFromLoadId: null }];
      tables.routeAssignment = [{ id: 'A1', runId: 'P', truckId: 'T1', loadId: 'L1', loadNo: 1, orderId: 'O1', sequenceInTruck: 1, orderInStop: 0, portionLinesJson: null }];
      tables.scenarioResult = [{
        id: 'sc1',
        runId: 'P',
        name: 'RECOMMENDED',
        detailsJson: {
          name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 1, engine: 'OR-Tools', matrix_provider: 'HAVERSINE',
          distance_is_estimated: true, response_warnings: [], warnings: [], loads: [], unserved: [],
          scope: { orderIds: ['O1'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] },
        },
      }];
      tables.unservedOrder = [];
      tables.auditLog = [];
    }

    it('LOCK, LOADING and DISPATCH are refused with 409 ORDERS_CARRIED naming the customer and the day; nothing changes', async () => {
      for (const [from, to] of [['PLANNED', 'LOCKED'], ['LOCKED', 'LOADING'], ['LOCKED', 'DISPATCHED'], ['LOADING', 'DISPATCHED']] as const) {
        resetDb();
        seed(from);
        const e = await updateLoad(T, 'P', 'L1', { status: to }, user, allow, AFTER).catch((x) => x);
        expect(e.status, `${from} -> ${to}`).toBe(409);
        expect(e.details).toMatchObject({ code: 'ORDERS_CARRIED', orderIds: ['O1'] });
        expect(e.message).toContain('T01 L1 carries 1 order(s) that were brought forward to a later day: C1 (to 2026-09-28)');
        // PR9 review: a load holding nothing else is never re-planned away - never "re-plan this day"
        // (a re-plan of a day with nothing else open has nothing to plan: NOTHING_TO_PLAN).
        expect(e.message).not.toMatch(/re-plan this day/i);
        expect(e.message).toContain('nothing needs to be re-planned');
        if (from === 'PLANNED') {
          // Never loaded: it needs nothing.
          expect(e.message).toContain('This load holds nothing else: leave it as it is. It stays in this plan for the record and is never loaded or dispatched');
        } else {
          // Second review: a LOCKED or LOADING load was loaded (the night before): its cases are on the
          // truck and planned on 28 Sep now - unload them before 28 Sep is picked, never "never loaded".
          expect(e.message).toContain(
            'This load holds nothing else, but it was loaded: its cases were brought forward to 28 Sep and are planned there. Unload them back to stock, or tell the warehouse, before the loads of 28 Sep are picked, so they are not loaded twice; then put this load back to Planned.',
          );
          expect(e.message).not.toMatch(/never loaded|leave it as it is/);
        }
        expect(row('planLoad', 'L1').status).toBe(from);
        expect(tables.auditLog.some((a) => String(a.action).startsWith('LOAD_'))).toBe(false);
      }
    });

    it('a load that also holds orders not brought forward: re-plan the day for them (unlock first when locked)', async () => {
      for (const from of ['PLANNED', 'LOCKED'] as const) {
        resetDb();
        seed(from);
        tables.order.push({ id: 'O9', tenantId: T, depotId: 'D1', customerId: 'c9', customer: { code: 'C9', branchCode: null }, totalCases: 10, totalWeightKg: 100, status: 'ASSIGNED', deliveryDate: new Date(`${D1}T00:00:00Z`), carriedToOrderId: null });
        tables.routeAssignment.push({ id: 'A9', runId: 'P', truckId: 'T1', loadId: 'L1', loadNo: 1, orderId: 'O9', sequenceInTruck: 2, orderInStop: 0, portionLinesJson: null });
        const e = await updateLoad(T, 'P', 'L1', { status: from === 'PLANNED' ? 'LOCKED' : 'LOADING' }, user, allow, AFTER).catch((x) => x);
        expect(e.details).toMatchObject({ code: 'ORDERS_CARRIED', orderIds: ['O1'] });
        expect(e.message).toContain(
          from === 'PLANNED' ? 'Re-plan this day to plan its other orders without them.' : 'To deliver its other orders, put the load back to Planned and re-plan this day',
        );
        if (from === 'LOCKED') expect(e.message).toContain('Their cases were loaded: unload them (they are planned on 28 Sep now).');
        expect(e.message).not.toContain('holds nothing else');
        expect(e.message).not.toMatch(/today/i);
      }
    });

    it("a load of TODAY (its order brought forward to tomorrow in the evening) is refused the same way, and the words say re-plan today or unlock", async () => {
      for (const [from, to, others] of [
        ['LOCKED', 'LOADING', false],
        ['LOADING', 'DISPATCHED', false],
        ['PLANNED', 'LOCKED', false],
        ['LOCKED', 'DISPATCHED', true],
        ['LOADING', 'DISPATCHED', true],
        ['PLANNED', 'LOCKED', true],
      ] as const) {
        resetDb();
        seed(from);
        tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat' }];
        if (others) {
          tables.order.push({ id: 'O9', tenantId: T, depotId: 'D1', customerId: 'c9', customer: { code: 'C9', branchCode: null }, totalCases: 10, totalWeightKg: 100, status: 'ASSIGNED', deliveryDate: new Date(`${D1}T00:00:00Z`), carriedToOrderId: null });
          tables.routeAssignment.push({ id: 'A9', runId: 'P', truckId: 'T1', loadId: 'L1', loadNo: 1, orderId: 'O9', sequenceInTruck: 2, orderInStop: 0, portionLinesJson: null });
        }
        const e = await updateLoad(T, 'P', 'L1', { status: to }, user, allow, TONIGHT).catch((x) => x);
        const what = `${from} -> ${to}${others ? ' (with other orders)' : ''}`;
        expect(e.status, what).toBe(409);
        expect(e.details, what).toMatchObject({ code: 'ORDERS_CARRIED', orderIds: ['O1'] });
        expect(e.message, what).toMatch(/re-plan today \(27 Sep\)|unlock it|unlock the load/i);
        expect(e.message, what).not.toMatch(/re-plan this day/i);
        if (!others && from === 'LOCKED') {
          // Loaded last night, never left: it does not go out today; unlock it and unload the cases.
          expect(e.message).toContain(
            'This load holds nothing else, but it was loaded: its cases were brought forward to 28 Sep and are planned there, so it does not go out today. Unlock it (put it back to Planned) and unload those cases back to stock, or tell the warehouse, before the loads of 28 Sep are picked, so they are not loaded twice. A later locked or loading load of the same truck must be unlocked first.',
          );
        } else if (!others && from === 'LOADING') {
          // A LOADING load has no Unlock (load-state.ts: LOADING -> LOCKED | DISPATCHED): Back to locked first.
          expect(e.message).toContain(
            'so it does not go out today. Put it Back to locked, then Unlock it (put it back to Planned), and unload those cases back to stock, or tell the warehouse, before the loads of 28 Sep are picked, so they are not loaded twice. A later locked or loading load of the same truck must be unlocked first.',
          );
          expect(e.message).not.toMatch(/today\. Unlock it/);
        } else if (!others) {
          expect(e.message).toContain("This load holds nothing else: it does not go out today. Leave it as it is (it stays in today's plan for the record); re-plan today (27 Sep) only if other orders of today still need a truck.");
        } else if (from === 'LOCKED') {
          expect(e.message).toContain(
            'To deliver its other orders today, unlock the load (put it back to Planned) and re-plan today (27 Sep): the re-plan leaves the brought-forward orders out. A later locked or loading load of the same truck must be unlocked first.',
          );
        } else if (from === 'LOADING') {
          expect(e.message).toContain(
            'To deliver its other orders today, put the load Back to locked, then Unlock it (put it back to Planned), and re-plan today (27 Sep): the re-plan leaves the brought-forward orders out. A later locked or loading load of the same truck must be unlocked first.',
          );
          expect(e.message).not.toContain('unlock the load (put it back to Planned) and re-plan');
        } else {
          expect(e.message).toContain('Re-plan today (27 Sep) to plan its other orders without them.');
          expect(e.message).not.toMatch(/unlock/i);
        }
        expect(row('planLoad', 'L1').status).toBe(from);
      }
    });

    it('stepping back is never refused: unlock the load to re-plan the day', async () => {
      seed('LOCKED');
      await updateLoad(T, 'P', 'L1', { status: 'PLANNED' }, user, allow, TONIGHT);
      expect(row('planLoad', 'L1').status).toBe('PLANNED');
    });

    it('the plan of the earlier day stays as it was, and shows its carried orders as "carried over to" (history, not a problem)', async () => {
      seed('LOCKED');
      const day = new Date(`${D1}T00:00:00Z`);
      tables.order.push(
        { id: 'O2', tenantId: T, depotId: 'D1', customerId: 'c2', totalCases: 15, totalWeightKg: 150, status: 'UNSERVED', deliveryDate: day, carriedToOrderId: 'O2b', carriedTo: { deliveryDate: new Date(`${D}T00:00:00Z`), totalCases: 15 } },
        { id: 'O3', tenantId: T, depotId: 'D1', customerId: 'c3', totalCases: 20, totalWeightKg: 200, status: 'ASSIGNED', deliveryDate: day, carriedFromDate: new Date(`${D2}T00:00:00Z`), carriedToOrderId: null },
      );
      tables.planLoad.push({ id: 'L2', tenantId: T, runId: 'P', truckId: 'T1', loadNo: 2, status: 'PLANNED', departMin: 600, returnMin: 700, cases: 20, carriedFromLoadId: null });
      tables.routeAssignment.push({ id: 'A2', runId: 'P', truckId: 'T1', loadId: 'L2', loadNo: 2, orderId: 'O3', sequenceInTruck: 1, orderInStop: 0, portionLinesJson: null });
      tables.unservedOrder = [{ id: 'U2', scenarioId: 'sc1', orderId: 'O2', reasonCode: 'TRIP_LIMIT', reasonMessage: 'Trucks out of loads.', portionLinesJson: null }];
      row('order', 'O1').carriedTo = { deliveryDate: new Date(`${D}T00:00:00Z`), totalCases: 40 };
      const before = structuredClone(tables.runPlan);
      const d = (await getPlanDetail(T, 'P'))!;
      const l1 = d.loads.find((l) => l.id === 'L1')!;
      const l2 = d.loads.find((l) => l.id === 'L2')!;
      expect(l1.carriedAway).toBe(1);
      expect(l1.stops[0]).toMatchObject({ carriedTo: D, carriedFrom: null });
      expect(l2.carriedAway).toBe(0);
      expect(l2.stops[0]).toMatchObject({ carriedFrom: D2, carriedTo: null });
      expect(d.unserved).toEqual([expect.objectContaining({ orderId: 'O2', carriedTo: D, carriedFrom: null })]);
      expect(d.carriedOut).toEqual({ orders: 2, cases: 55, dates: [D] });
      expect(d.carriedIn).toEqual({ orders: 1, cases: 20, dates: [D2] });
      // Reading it changes nothing: the plan version is kept exactly as it was.
      expect(tables.runPlan).toEqual(before);
    });

    it("the plan version page (no day screen around it): the plan detail gives the company's today, so a load of today's badge says today, like the 409 on that page", async () => {
      const remedyOf = (text: string) => text.slice(text.indexOf('with them. ') + 'with them. '.length);
      for (const status of ['LOCKED', 'LOADING'] as const) {
        resetDb();
        seed(status);
        tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat' }];
        // 21:00 on 27 Sep: the load's day is today.
        const night = (await getPlanDetail(T, 'P', TONIGHT))!;
        expect(night.today).toBe(D1);
        const title = carriedLoadTitle(night.loads.find((x) => x.id === 'L1')!, night);
        expect(title, status).toContain('so it does not go out today.');
        const refused = await updateLoad(T, 'P', 'L1', { status: 'DISPATCHED' }, user, allow, TONIGHT).catch((x) => x);
        expect(refused.details).toMatchObject({ code: 'ORDERS_CARRIED' });
        expect(remedyOf(refused.message), status).toBe(remedyOf(title));
        // 10:00 on 28 Sep: that day is over - the earlier-day words on both.
        const after = (await getPlanDetail(T, 'P', AFTER))!;
        expect(after.today).toBe(D);
        const later = carriedLoadTitle(after.loads.find((x) => x.id === 'L1')!, after);
        expect(later).not.toMatch(/today/);
        const refusedAfter = await updateLoad(T, 'P', 'L1', { status: 'DISPATCHED' }, user, allow, AFTER).catch((x) => x);
        expect(remedyOf(refusedAfter.message), status).toBe(remedyOf(later));
        expect(row('planLoad', 'L1').status).toBe(status);
      }
    });
  });
});

describe('PR9 review: the carry on the database, split orders, re-plans, lists and the dashboard', () => {
  const T = 'tA';
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  /** 10:00 in Muscat on 27 Sep: the dispatcher plans tomorrow, 28 Sep. */
  const NOW = new Date('2026-09-27T06:00:00Z');
  const shop = (code: string) => ({ id: `c-${code}`, code, branchCode: null, branchKey: '__MAIN__', name: `Shop ${code}`, active: true });
  const order = (id: string, iso: string, status: string, over: Record<string, unknown> = {}) => ({
    id,
    tenantId: T,
    depotId: 'DA',
    customerId: `c-${id}`,
    customer: shop(id),
    deliveryDate: day(iso),
    status,
    totalCases: 10,
    totalWeightKg: 100,
    priority: 3,
    isLate: false,
    salesValue: null,
    marginValue: null,
    carriedToOrderId: null,
    carriedFromDate: null,
    uploadedAt: new Date('2026-09-20T00:00:00Z'),
    lines: [{ id: `${id}-l1`, cases: 10, weightKg: 100, salesOrderNo: `SO-${id}`, product: { code: 'W500', name: 'Water' } }],
    ...over,
  });
  const runPlan = (id: string, iso: string, over: Record<string, unknown> = {}) => ({
    id, tenantId: T, depotId: 'DA', runDate: day(iso), status: 'READY', version: 1, reason: 'INITIAL', chosenScenarioId: `sc-${id}`, parentRunId: null, supersededAt: null,
    currentJobId: null, finalizedAt: null, reconciliationJson: { ok: true }, summaryJson: null, feasibilityJson: null, createdAt: new Date('2026-09-25T12:00:00Z'), ...over,
  });
  const details = (orderIds: string[], over: Record<string, unknown> = {}) => ({
    name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 1, engine: 'OR-Tools', matrix_provider: 'HAVERSINE',
    distance_is_estimated: true, response_warnings: [], warnings: [], loads: [], unserved: [],
    scope: { orderIds, frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] },
    ...over,
  });

  /** 26 Sep: YEST unserved. 27 Sep (today): TODAY on T01 L1, locked last night, not left yet. */
  function seedDays() {
    tables.depot = [{ id: 'DA', tenantId: T, code: 'A1', active: true }];
    tables.tenantConfig = [{ id: 'cfgA', tenantId: T, timezone: 'Asia/Muscat', planningCutoffMin: 1080 }];
    tables.truck = [{ id: 'T1', tenantId: T, code: 'T01' }];
    tables.order = [order('TODAY', D1, 'ASSIGNED'), order('YEST', D2, 'UNSERVED')];
    tables.runPlan = [runPlan('P26', D2), runPlan('P27', D1)];
    tables.planLoad = [
      { id: 'L27', tenantId: T, runId: 'P27', truckId: 'T1', loadNo: 1, status: 'LOCKED', truck: { code: 'T01' }, assignments: [{ orderId: 'TODAY', portionLinesJson: null }] },
    ];
    tables.routeAssignment = [];
    tables.scenarioResult = [
      { id: 'sc-P26', runId: 'P26', name: 'RECOMMENDED', detailsJson: details(['YEST']) },
      { id: 'sc-P27', runId: 'P27', name: 'RECOMMENDED', detailsJson: details(['TODAY']) },
    ];
    tables.unservedOrder = [{ id: 'U26', scenarioId: 'sc-P26', orderId: 'YEST', reasonCode: 'TRIP_LIMIT', reasonMessage: 'Trucks out of loads.', portionLinesJson: null }];
    tables.orderLine = [];
    tables.auditLog = [];
  }

  /** Every raw query of the fake with its values (the advisory lock keys are values). */
  function recordRaw() {
    const calls: { sql: string; values: unknown[] }[] = [];
    const orig = fakePrisma.$queryRaw;
    fakePrisma.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return orig(strings, ...values);
    };
    return { calls, restore: () => (fakePrisma.$queryRaw = orig) };
  }

  beforeEach(() => {
    resetDb();
    vi.unstubAllEnvs();
  });

  it("the preview for tomorrow lists yesterday (ticked) and today's order on its locked load as today's (unticked); the next morning both are earlier days", async () => {
    seedDays();
    const pv = await carryOverPreview(T, 'DA', D, { now: NOW });
    expect(pv).toMatchObject({ from: '2026-09-21', to: D1, today: D1, orders: 1, cases: 10, todayOrders: 1, todayCases: 10, blocked: 0 });
    expect(pv.candidates.map((c) => [c.orderId, c.ofToday, c.why[0].kind, c.why[0].text])).toEqual([
      ['YEST', false, 'UNSERVED', 'Unserved: Trucks out of loads.'],
      ['TODAY', true, 'NOT_LEFT', 'On T01 L1 (locked): has not left the depot yet'],
    ]);
    expect([...defaultCarrySelection(pv.candidates)]).toEqual(['YEST']);
    // 28 Sep, 07:00 in Muscat: 27 Sep is over, its locked load never left; both are earlier days now.
    const next = await carryOverPreview(T, 'DA', D, { now: new Date('2026-09-28T03:00:00Z') });
    expect(next.candidates.map((c) => [c.orderId, c.ofToday, c.why[0].kind])).toEqual([
      ['YEST', false, 'UNSERVED'],
      ['TODAY', false, 'NOT_LEFT'],
    ]);
    expect(next).toMatchObject({ orders: 2, todayOrders: 0 });
    // Today's own screen never lists today's orders: an order is never brought forward to its own day.
    const own = await carryOverPreview(T, 'DA', D1, { now: NOW });
    expect(own.candidates.map((c) => c.orderId)).toEqual(['YEST']);
  });

  it("one of today's orders sent without today: true (as selecting every order would): 409 TODAY_NOT_SELECTED, nothing carried, also not the earlier one", async () => {
    seedDays();
    for (const sel of [
      [{ orderId: 'TODAY', cases: 10 }],
      [{ orderId: 'YEST', cases: 10 }, { orderId: 'TODAY', cases: 10, today: false }],
    ]) {
      const e = await bringForward(T, 'DA', D, sel, { id: 'u1' }, { now: NOW }).catch((x) => x);
      expect(e.status).toBe(409);
      expect(e.details).toMatchObject({ code: 'TODAY_NOT_SELECTED', orderIds: ['TODAY'] });
      expect(e.message).toContain('1 order(s) of today (27 Sep) were sent without being ticked under Today: TODAY is an order of today (27 Sep)');
      expect(e.message).toContain("Today's loads that have not left yet may still go out today. Nothing was brought forward");
      expect(row('order', 'TODAY').carriedToOrderId).toBeNull();
      expect(row('order', 'YEST').carriedToOrderId).toBeNull();
      expect(tables.order).toHaveLength(2);
    }
    // Brought forward to today itself: never (not a candidate of its own day).
    const own = await bringForward(T, 'DA', D1, [{ orderId: 'TODAY', cases: 10, today: true }], { id: 'u1' }, { now: NOW }).catch((x) => x);
    expect(own.details).toMatchObject({ code: 'CARRY_OVER_CHANGED' });
    expect(row('order', 'TODAY').carriedToOrderId).toBeNull();
  });

  it('ticked under Today at night: brought forward to tomorrow like an earlier day\'s order, closed on today; its load of today can no longer go out and the 409 says unlock', async () => {
    seedDays();
    tables.routeAssignment = [{ id: 'A27', runId: 'P27', truckId: 'T1', loadId: 'L27', loadNo: 1, orderId: 'TODAY', sequenceInTruck: 1, orderInStop: 0, portionLinesJson: null }];
    const night = new Date('2026-09-27T17:00:00Z'); // 21:00 in Muscat: tomorrow's trucks are being loaded
    const before = structuredClone({ runPlan: tables.runPlan, planLoad: tables.planLoad, routeAssignment: tables.routeAssignment, unservedOrder: tables.unservedOrder });
    const raw = recordRaw();
    const res = await bringForward(T, 'DA', D, [{ orderId: 'YEST', cases: 10 }, { orderId: 'TODAY', cases: 10, today: true }], { id: 'u1' }, { now: night }).finally(() => raw.restore());
    // After the cutoff of 28 Sep: late, like a late order.
    expect(res).toMatchObject({ orders: 2, cases: 20, late: true, skipped: [] });
    const copy = tables.order.find((o) => o.carriedFromOrderId === 'TODAY')!;
    expect([copy.deliveryDate, copy.carriedFromDate, copy.totalCases]).toEqual([day(D), day(D1), 10]);
    expect(row('order', 'TODAY').carriedToOrderId).toBe(copy.id);
    // Today's plan rows are exactly as they were (the original is closed on today by its mark, like an earlier day's).
    expect({ runPlan: tables.runPlan, planLoad: tables.planLoad, routeAssignment: tables.routeAssignment, unservedOrder: tables.unservedOrder }).toEqual(before);
    // Today's day and live plan were locked like the earlier days' (a load of today dispatched meanwhile is seen).
    expect(raw.calls.some((c) => c.values[0] === `planday:tA|DA|${D1}`)).toBe(true);
    expect(raw.calls.some((c) => /FOR UPDATE/.test(c.sql) && c.values[0] === 'P27')).toBe(true);
    // Its load (loaded last night, never left) cannot be loaded or dispatched today with it.
    row('order', 'TODAY').carriedTo = { deliveryDate: day(D) };
    for (const to of ['LOADING', 'DISPATCHED'] as const) {
      const e = await updateLoad(T, 'P27', 'L27', { status: to }, { id: 'u1', role: 'TENANT_ADMIN' }, () => true, { now: night }).catch((x) => x);
      expect(e.details).toMatchObject({ code: 'ORDERS_CARRIED', orderIds: ['TODAY'] });
      expect(e.message).toContain('so it does not go out today. Unlock it (put it back to Planned)');
      expect(row('planLoad', 'L27').status).toBe('LOCKED');
    }
  });

  it("the day locks of the days read come before their plans' row locks (no re-plan makes a new version meanwhile)", async () => {
    seedDays();
    const raw = recordRaw();
    try {
      // The screen showed other cases: refused after every lock was taken.
      const e = await bringForward(T, 'DA', D, [{ orderId: 'YEST', cases: 5 }], { id: 'u1' }, { now: NOW }).catch((x) => x);
      expect(e.details).toMatchObject({ code: 'CARRY_OVER_CHANGED' });
    } finally {
      raw.restore();
    }
    const at = (pred: (c: { sql: string; values: unknown[] }) => boolean) => raw.calls.findIndex(pred);
    const intake = at((c) => c.values[0] === 'intake:tA');
    const dayLock = at((c) => c.values[0] === `planday:tA|DA|${D2}`);
    // Today is read too (its orders are listed, as today's): its day lock comes after 26 Sep's (date order).
    const todayLock = at((c) => c.values[0] === `planday:tA|DA|${D1}`);
    const rowLock = at((c) => /FOR UPDATE/.test(c.sql) && c.values[0] === 'P26');
    const todayRowLock = at((c) => /FOR UPDATE/.test(c.sql) && c.values[0] === 'P27');
    expect(intake).toBeGreaterThanOrEqual(0);
    expect(dayLock).toBeGreaterThan(intake);
    expect(todayLock).toBeGreaterThan(dayLock);
    expect(rowLock).toBeGreaterThan(todayLock);
    expect(todayRowLock).toBeGreaterThan(rowLock);
  });

  it('a plan that stopped being the live one while it was being locked: 409 PLAN_BUSY, nothing read from the unlocked version, nothing carried', async () => {
    seedDays();
    const inner = fakePrisma.$queryRaw;
    fakePrisma.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const res = await inner(strings, ...values);
      // A re-plan of 26 Sep commits right before the row lock is granted: v1 superseded, v2 live.
      if (/FOR UPDATE/.test(strings.join('?')) && values[0] === 'P26' && !tables.runPlan.some((r) => r.id === 'P26v2')) {
        row('runPlan', 'P26').supersededAt = new Date();
        row('runPlan', 'P26').status = 'SUPERSEDED';
        tables.runPlan.push(runPlan('P26v2', D2, { version: 2, chosenScenarioId: 'sc-P26' }));
      }
      return res;
    };
    try {
      const e = await bringForward(T, 'DA', D, [{ orderId: 'YEST', cases: 10 }], { id: 'u1' }, { now: NOW }).catch((x) => x);
      expect(e.status).toBe(409);
      expect(e.details).toMatchObject({ code: 'PLAN_BUSY' });
      expect(e.message).toContain('The 26 Sep plan changed while the orders were being brought forward');
    } finally {
      fakePrisma.$queryRaw = inner;
    }
    expect(row('order', 'YEST').carriedToOrderId).toBeNull();
    expect(tables.order.filter((o) => o.carriedFromOrderId)).toEqual([]);
  });

  /** 27 Sep re-planned (v2) after S's rest was brought forward: S's 60 cases left on T01 L1, its 40 were carried. */
  function seedSplitReplan() {
    tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot one', lat: 23.58, lng: 58.39, active: true }];
    tables.truck = [
      { id: 'T1', tenantId: T, code: 'T01', capacityCases: 800, capacityWeightKg: 12000 },
      { id: 'T2', tenantId: T, code: 'T02', capacityCases: 800, capacityWeightKg: 12000 },
    ];
    tables.order = [
      order('S', D1, 'ASSIGNED', {
        depotId: 'D1',
        customerId: 'cS',
        totalCases: 100,
        totalWeightKg: 1000,
        carriedToOrderId: 'S2',
        lines: [{ id: 'S-l1', cases: 100, weightKg: 1000, salesOrderNo: 'SO-S', product: { code: 'W500', name: 'Water' } }],
      }),
      order('N', D1, 'ASSIGNED', { depotId: 'D1', customerId: 'cN' }),
    ];
    tables.runPlan = [runPlan('P2', D1, { depotId: 'D1', version: 2, reason: 'LATE_ORDER', chosenScenarioId: 'sc2', reconciliationJson: null })];
    tables.planLoad = [
      { id: 'L1', tenantId: T, runId: 'P2', truckId: 'T1', loadNo: 1, status: 'DISPATCHED', departMin: 400, returnMin: 500, cases: 60, carriedFromLoadId: 'L1v1' },
      { id: 'L2', tenantId: T, runId: 'P2', truckId: 'T2', loadNo: 1, status: 'PLANNED', departMin: 400, returnMin: 500, cases: 10, carriedFromLoadId: null },
    ];
    tables.routeAssignment = [
      { id: 'A1', runId: 'P2', truckId: 'T1', loadId: 'L1', loadNo: 1, orderId: 'S', sequenceInTruck: 1, orderInStop: 0, portionLinesJson: [{ lineId: 'S-l1', cases: 60 }], portionCases: 60, portionWeightKg: 600 },
      { id: 'A2', runId: 'P2', truckId: 'T2', loadId: 'L2', loadNo: 1, orderId: 'N', sequenceInTruck: 1, orderInStop: 0, portionLinesJson: null },
    ];
    // What buildDispatchRequest makes after the carry: S only through the dispatched load (frozenLoadOrderIds).
    tables.scenarioResult = [
      {
        id: 'sc2',
        runId: 'P2',
        name: 'RECOMMENDED',
        detailsJson: details(['N'], {
          loads: [{ truck_id: 'T2', load_no: 1, stops: [{ order_ids: ['N'], customer_id: 'cN' }] }],
          scope: { orderIds: ['N'], frozenOrderIds: ['S'], orderPriority: {}, frozenLoadIds: ['L1'], frozenLoadOrderIds: ['S'] },
        }),
      },
    ];
    tables.unservedOrder = [];
    tables.auditLog = [];
  }

  it('a re-plan after carrying the rest of a split order whose other part left still reconciles, and its loads can be locked', async () => {
    seedSplitReplan();
    await refreshPlanFacts(fakePrisma as never, T, 'P2');
    const recon = row('runPlan', 'P2').reconciliationJson;
    expect(recon.problems).toEqual([]);
    expect(recon.ok).toBe(true);
    // S counts with the 60 cases this day still holds; its 40 are the copy's, on the day they went to.
    expect([recon.uploadedCases, recon.plannedCases, recon.unservedCases]).toEqual([70, 70, 0]);
    vi.stubEnv('FEASIBILITY_GATE', 'warn'); // this test is about the cases check, not the timetable
    await updateLoad(T, 'P2', 'L2', { status: 'LOCKED' }, { id: 'u1', role: 'TENANT_ADMIN' }, () => true);
    expect(row('planLoad', 'L2').status).toBe('LOCKED');
  });

  it('carriedHeldCases: only a carried order the version did not plan itself is cut to what it holds', () => {
    const orders = [
      { id: 'S', carriedToOrderId: 'S2', lines: [{ id: 'a', cases: 100 }, { id: 'b', cases: 20 }] },
      { id: 'W', carriedToOrderId: 'W2', lines: [{ id: 'w', cases: 30 }] },
      { id: 'X', carriedToOrderId: 'X2', lines: [{ id: 'x', cases: 50 }] },
      { id: 'N', carriedToOrderId: null, lines: [{ id: 'n', cases: 10 }] },
    ];
    const planned = [
      { orderId: 'S', lines: [{ lineId: 'a', cases: 60 }] },
      { orderId: 'W', lines: null },
      { orderId: 'X', lines: [{ lineId: 'x', cases: 20 }] },
      { orderId: 'N', lines: null },
    ];
    const held = carriedHeldCases(orders, ['X', 'N'], planned, [{ orderId: 'S', portionLinesJson: [{ lineId: 'b', cases: 5 }] }]);
    expect([...held.keys()]).toEqual(['S', 'W']); // X was planned by this version (before its carry): all its cases
    expect([...held.get('S')!]).toEqual([
      ['a', 60],
      ['b', 5],
    ]);
    expect([...held.get('W')!]).toEqual([['w', 30]]);
  });

  it('a split order whose part left is not marked "carried over" on the dispatched load or the driver sheet; the part that never left is', async () => {
    seedSplitReplan();
    // The version as it was when the rest was carried: 60 on T01 L1 (dispatched), 40 unserved.
    row('order', 'S').carriedTo = { deliveryDate: day(D), totalCases: 40 };
    tables.unservedOrder = [{ id: 'US', scenarioId: 'sc2', orderId: 'S', reasonCode: 'TRIP_LIMIT', reasonMessage: 'Trucks out of loads.', portionLinesJson: [{ lineId: 'S-l1', cases: 40 }] }];
    const d = (await getPlanDetail(T, 'P2'))!;
    const l1 = d.loads.find((l) => l.id === 'L1')!;
    expect(l1.carriedAway).toBe(0);
    expect(l1.stops[0].carriedTo).toBeNull();
    expect(d.unserved).toEqual([expect.objectContaining({ orderId: 'S', carriedTo: D })]);
    const sheets = driverPackModel(d, { tenantName: 'NMWC' }).sheets;
    expect(sheets.flatMap((s) => s.stops).every((s) => s.carried === null)).toBe(true);
    // The same part on a load that never left (locked): marked, and the load cannot move forward with it.
    row('planLoad', 'L1').status = 'LOCKED';
    const d2 = (await getPlanDetail(T, 'P2'))!;
    const locked = d2.loads.find((l) => l.id === 'L1')!;
    expect(locked.carriedAway).toBe(1);
    expect(locked.stops[0].carriedTo).toBe(D);
    expect(carriedLoadShows('LOCKED') && carriedLoadShows('PLANNED') && carriedLoadShows('LOADING')).toBe(true);
    expect(carriedLoadShows('DISPATCHED') || carriedLoadShows('COMPLETED')).toBe(false);
  });

  it('the plan screen: a load or an unserved line holding only brought-forward orders is no work for a re-plan', () => {
    const loads = [
      { status: 'PLANNED', carriedAway: 1, stops: [{ orderIds: ['C2'] }] },
      { status: 'COMPLETED', carriedAway: 0, stops: [{ orderIds: ['C1'] }] },
    ];
    expect(replanWork(loads, [{ carriedTo: D }])).toEqual({ loadStatuses: ['COMPLETED'], unservedOrders: 0 });
    // A load that also holds another order, or an unserved line not carried, is work.
    expect(replanWork([{ status: 'PLANNED', carriedAway: 1, stops: [{ orderIds: ['C2', 'C9'] }] }], [{ carriedTo: null }])).toEqual({ loadStatuses: ['PLANNED'], unservedOrders: 1 });
    expect(holdsOnlyCarried({ carriedAway: 0, stops: [] })).toBe(false);
    expect(carriedLoadRemedy('PLANNED', true)).toBe(
      'This load holds nothing else: leave it as it is. It stays in this plan for the record and is never loaded or dispatched; nothing needs to be re-planned.',
    );
    // Second review: a LOCKED or LOADING load holding only carried orders was loaded (NMWC loads at
    // night): unload before the later day is picked, then back to Planned - never "never loaded".
    for (const st of ['LOCKED', 'LOADING']) {
      const t = carriedLoadRemedy(st, true, [D, D]);
      expect(t).toBe(
        'This load holds nothing else, but it was loaded: its cases were brought forward to 28 Sep and are planned there. Unload them back to stock, or tell the warehouse, before the loads of 28 Sep are picked, so they are not loaded twice; then put this load back to Planned. It stays in this plan for the record; nothing needs to be re-planned.',
      );
      expect(t).not.toMatch(/never loaded|needs nothing|leave it as it is/);
    }
    expect(carriedLoadRemedy('LOCKED', true)).toContain('brought forward to the later day');
    // A load of a day that is over keeps these words; one of today says today (the plan screen's badge, the 409).
    expect(carriedLoadRemedy('LOCKED', true, [D], { date: D2, isToday: false })).toBe(carriedLoadRemedy('LOCKED', true, [D]));
    expect(carriedLoadRemedy('PLANNED', false, [D], { date: D1, isToday: true })).toBe('Re-plan today (27 Sep) to plan its other orders without them.');
    // Review of the owner decision: the way back to Planned uses the plan screen's own buttons. A
    // LOCKED load has "Unlock"; a LOADING load has only "Back to locked" and "Dispatch" (LOADING ->
    // PLANNED is refused), so it goes Back to locked first; Unlock waits for the truck's later loads.
    const today = { date: D1, isToday: true };
    expect(carriedLoadRemedy('LOCKED', true, [D], today)).toBe(
      "This load holds nothing else, but it was loaded: its cases were brought forward to 28 Sep and are planned there, so it does not go out today. Unlock it (put it back to Planned) and unload those cases back to stock, or tell the warehouse, before the loads of 28 Sep are picked, so they are not loaded twice. A later locked or loading load of the same truck must be unlocked first. It stays in today's plan for the record; nothing needs to be re-planned.",
    );
    expect(carriedLoadRemedy('LOADING', true, [D], today)).toBe(
      "This load holds nothing else, but it was loaded: its cases were brought forward to 28 Sep and are planned there, so it does not go out today. Put it Back to locked, then Unlock it (put it back to Planned), and unload those cases back to stock, or tell the warehouse, before the loads of 28 Sep are picked, so they are not loaded twice. A later locked or loading load of the same truck must be unlocked first. It stays in today's plan for the record; nothing needs to be re-planned.",
    );
    expect(carriedLoadRemedy('LOCKED', false, [D], today)).toBe(
      'Their cases were loaded: unload them (they are planned on 28 Sep now). To deliver its other orders today, unlock the load (put it back to Planned) and re-plan today (27 Sep): the re-plan leaves the brought-forward orders out. A later locked or loading load of the same truck must be unlocked first.',
    );
    expect(carriedLoadRemedy('LOADING', false, [D], today)).toBe(
      'Their cases were loaded: unload them (they are planned on 28 Sep now). To deliver its other orders today, put the load Back to locked, then Unlock it (put it back to Planned), and re-plan today (27 Sep): the re-plan leaves the brought-forward orders out. A later locked or loading load of the same truck must be unlocked first.',
    );
    // The plan screen's badge says the same; without the day screen's today it takes the plan's own (PlanDetail.today).
    const l = { status: 'LOADING', carriedAway: 1, stops: [{ orderIds: ['O1'], carriedTo: D }] };
    const prefix = 'Orders on this load were brought forward to a later day (planned there now): it cannot be locked, loaded or dispatched with them. ';
    expect(carriedLoadTitle(l, { run: { runDate: D1 }, today: D1 })).toBe(prefix + carriedLoadRemedy('LOADING', true, [D], today));
    expect(carriedLoadTitle(l, { run: { runDate: D1 } }, D1)).toBe(prefix + carriedLoadRemedy('LOADING', true, [D], today));
    // The day screen's today wins; a plan of a day that is over keeps the earlier-day words.
    expect(carriedLoadTitle(l, { run: { runDate: D1 }, today: D1 }, D)).toBe(prefix + carriedLoadRemedy('LOADING', true, [D]));
    expect(carriedLoadTitle(l, { run: { runDate: D1 }, today: D })).toBe(prefix + carriedLoadRemedy('LOADING', true, [D]));
    expect(carriedLoadTitle(l, { run: { runDate: D1 } })).toBe(prefix + carriedLoadRemedy('LOADING', true, [D]));
  });

  it('the dashboard subtracts the cases carried from their own day, so cost per case counts every case once', async () => {
    const { fetchRangeRows } = await import('@/lib/dashboard');
    const raw = recordRaw();
    try {
      await fetchRangeRows(T, D2, D1);
    } finally {
      raw.restore();
    }
    const sql = raw.calls.map((c) => c.sql).join('\n').replace(/\s+/g, ' ');
    expect(sql).toContain(
      `GREATEST(COALESCE(SUM(COALESCE((rp."summaryJson"->>'totalCases')::float8, case_totals.total_cases)), 0) - COALESCE(SUM(carried.cases), 0), 0) AS cases_total`,
    );
    expect(CARRIED_OUT_OF_PLAN.sql.replace(/\s+/g, ' ')).toContain('COALESCE(SUM(t.carried_cases) FILTER (WHERE t.unserved OR t.planned), 0) AS cases');
    expect(CARRIED_OUT_OF_PLAN.sql).toContain('c.id = o."carriedToOrderId"');
  });

  it('the Orders list: an open status never lists a carried original; both are marked; totals count the cases once', async () => {
    tables.order = [
      order('ORIG', D2, 'UNSERVED', { carriedToOrderId: 'COPY', carriedTo: { deliveryDate: day(D1) } }),
      order('COPY', D1, 'VALIDATED', { carriedFromOrderId: 'ORIG', carriedFromDate: day(D2) }),
      order('OTHER', D2, 'UNSERVED'),
    ];
    const { GET: ordersRoute } = await import('@/app/api/orders/route');
    const list = async (q: string) => {
      const res = await ordersRoute(new Request(`http://localhost/api/orders${q}`));
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { id: string; carriedTo: { deliveryDate: string } | null; carriedFromDate: string | null }[] }).data;
    };
    expect((await list('?status=UNSERVED')).map((o) => o.id)).toEqual(['OTHER']);
    expect((await list('?status=CARRIED')).map((o) => o.id)).toEqual(['ORIG']);
    const all = (await list('')).sort((a, b) => a.id.localeCompare(b.id));
    expect(all.map((o) => [o.id, orderCarryMarks(o)])).toEqual([
      ['COPY', { to: null, from: D2 }],
      ['ORIG', { to: D1, from: null }],
      ['OTHER', { to: null, from: null }],
    ]);
    expect(orderListTotals(all.map((o) => ({ ...o, totalCases: 10, totalWeightKg: 100 })))).toEqual({ cases: 20, kg: 200, carried: 1 });
    expect(orderStatusFilter('ASSIGNED')).toEqual({ status: 'ASSIGNED', carriedToOrderId: null });
    expect(orderStatusFilter('DISPATCHED')).toEqual({ status: 'DISPATCHED' });
    expect(carriedToBadge(orderCarryMarks(all[1]).to!)).toBe('Carried over to 27 Sep');
  });
});

describe('the carry-over API: roles, bodies and tenant isolation', () => {
  // The company's today on the real clock (the route has no clock of its own): yesterday is over.
  const DAY = todayIso('Asia/Muscat');
  const YESTERDAY = addDaysIso(DAY, -1);
  const line = (id: string) => [{ id: `${id}-l1`, cases: 5, weightKg: 50, salesOrderNo: `SO-${id}`, product: { code: 'W500' } }];
  const customer = (code: string) => ({ code, branchCode: null, branchKey: '__MAIN__', name: code, active: true });
  beforeEach(() => {
    resetDb();
    session.role = 'PLANNER';
    tables.depot = [
      { id: 'DA', tenantId: 'tA', code: 'A1', active: true },
      { id: 'DB', tenantId: 'tB', code: 'B1', active: true },
    ];
    tables.tenantConfig = [{ id: 'cfgA', tenantId: 'tA', timezone: 'Asia/Muscat', planningCutoffMin: 1080 }];
    // An order of this company and one of ANOTHER company, both not delivered the day before (no plan).
    tables.order = [
      { id: 'B-ORDER', tenantId: 'tB', depotId: 'DB', customerId: 'cb', customer: customer('CB'), deliveryDate: new Date(`${YESTERDAY}T00:00:00Z`), status: 'VALIDATED', priority: 3, totalCases: 5, totalWeightKg: 50, carriedToOrderId: null, carriedFromDate: null, lines: line('B') },
      { id: 'A-ORDER', tenantId: 'tA', depotId: 'DA', customerId: 'ca', customer: customer('CA'), deliveryDate: new Date(`${YESTERDAY}T00:00:00Z`), status: 'VALIDATED', priority: 3, totalCases: 5, totalWeightKg: 50, carriedToOrderId: null, carriedFromDate: null, lines: line('A') },
    ];
  });
  const post = (body: unknown) => carryRoute(new Request('http://localhost/api/dispatch/carry-over', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
  const get = (q: string) => previewRoute(new Request(`http://localhost/api/dispatch/carry-over?${q}`));

  it('another company\'s orders are never listed, and selecting one carries nothing (409, no data about it)', async () => {
    const pv = await get(`date=${DAY}&depotId=DA`);
    expect(pv.status).toBe(200);
    // Its own order is listed (the day before is over), the other company's never.
    expect(((await pv.json()) as { data: { candidates: { orderId: string }[] } }).data.candidates.map((c) => c.orderId)).toEqual(['A-ORDER']);
    const res = await post({ date: DAY, depotId: 'DA', selected: [{ orderId: 'B-ORDER', cases: 5 }] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; changed: { orderId: string; text: string }[] } };
    expect(body.error.code).toBe('CARRY_OVER_CHANGED');
    expect(body.error.changed).toEqual([{ orderId: 'B-ORDER', text: 'No longer open on an earlier day (delivered, dispatched or removed since the list was shown).' }]);
    expect(tables.order).toHaveLength(2);
    expect(row('order', 'B-ORDER').carriedToOrderId).toBeNull();
  });

  it('another company\'s depot: 400 for the preview and the bring forward', async () => {
    expect((await get(`date=${DAY}&depotId=DB`)).status).toBe(400);
    expect((await post({ date: DAY, depotId: 'DB', selected: [{ orderId: 'x', cases: 1 }] })).status).toBe(400);
  });

  it('bodies are checked: a real date, at least one order, each once, whole positive cases, nothing else', async () => {
    expect((await get('date=2099-02-30&depotId=DA')).status).toBe(400);
    expect((await get(`date=${DAY}`)).status).toBe(400);
    expect((await post({ date: DAY, depotId: 'DA', selected: [] })).status).toBe(400);
    expect((await post({ date: DAY, depotId: 'DA', selected: [{ orderId: 'a', cases: 1 }, { orderId: 'a', cases: 1 }] })).status).toBe(400);
    expect((await post({ date: DAY, depotId: 'DA', selected: [{ orderId: 'a', cases: 1.5 }] })).status).toBe(400);
    expect((await post({ date: DAY, depotId: 'DA', selected: [{ orderId: 'a', cases: 1 }], extra: true })).status).toBe(400);
    expect((await post({ date: DAY, depotId: 'DA', selected: [{ orderId: 'a', cases: 1, today: 'yes' }] })).status).toBe(400);
  });

  it("an order of today is listed for tomorrow as today's, and the POST brings it forward only with today: true", async () => {
    const TOMORROW = addDaysIso(DAY, 1);
    tables.order.push({
      id: 'A-TODAY', tenantId: 'tA', depotId: 'DA', customerId: 'ct', customer: customer('CT'), deliveryDate: new Date(`${DAY}T00:00:00Z`), status: 'VALIDATED', priority: 3,
      totalCases: 5, totalWeightKg: 50, carriedToOrderId: null, carriedFromDate: null, lines: line('T'),
    });
    const pv = await get(`date=${TOMORROW}&depotId=DA`);
    expect(pv.status).toBe(200);
    const data = ((await pv.json()) as { data: { candidates: { orderId: string; ofToday: boolean }[]; orders: number; todayOrders: number } }).data;
    expect(data.candidates.map((c) => [c.orderId, c.ofToday])).toEqual([
      ['A-ORDER', false],
      ['A-TODAY', true],
    ]);
    expect(data).toMatchObject({ orders: 1, todayOrders: 1 });
    // Sent like the earlier day's order (no Today tick): refused, nothing carried.
    const implied = await post({ date: TOMORROW, depotId: 'DA', selected: [{ orderId: 'A-ORDER', cases: 5 }, { orderId: 'A-TODAY', cases: 5 }] });
    expect(implied.status).toBe(409);
    expect(((await implied.json()) as { error: { code: string; orderIds: string[] } }).error).toMatchObject({ code: 'TODAY_NOT_SELECTED', orderIds: ['A-TODAY'] });
    expect(row('order', 'A-ORDER').carriedToOrderId).toBeNull();
    expect(row('order', 'A-TODAY').carriedToOrderId).toBeNull();
    // Ticked under Today: brought forward with the earlier one.
    const res = await post({ date: TOMORROW, depotId: 'DA', selected: [{ orderId: 'A-ORDER', cases: 5 }, { orderId: 'A-TODAY', cases: 5, today: true }] });
    expect(res.status).toBe(201);
    expect(row('order', 'A-ORDER').carriedToOrderId).not.toBeNull();
    expect(row('order', 'A-TODAY').carriedToOrderId).not.toBeNull();
  });

  it('bringing forward needs a planner (like confirming a file or a late order); the preview is readable by every role', async () => {
    session.role = 'VIEWER';
    expect((await post({ date: DAY, depotId: 'DA', selected: [{ orderId: 'a', cases: 1 }] })).status).toBe(403);
    expect((await get(`date=${DAY}&depotId=DA`)).status).toBe(200);
  });
});

describe('PR9 second review: a sales-order line entered again for a later day is never carried twice', () => {
  // Sales re-entered SO-9 / W500 of C1 in a later file; the intake only warns about lines on other dates.
  const c1 = { code: 'C1', branchCode: null, branchKey: '__MAIN__', name: 'C1', active: true };
  const O1 = (cases = 10) =>
    ord('O1', { deliveryDate: '2026-09-25', customerId: 'c1', customer: c1 }, [{ id: 'O1-l1', cases, weightKg: cases * 10, salesOrderNo: 'SO-9', productCode: 'W500' }]);
  const O2 = (over: Partial<CarryOrderIn> = {}) =>
    ord('O2', { deliveryDate: D2, customerId: 'c1', customer: { ...c1, code: 'c1' }, ...over }, [{ id: 'O2-l1', cases: 10, weightKg: 100, salesOrderNo: ' so-9', productCode: 'w500' }]);
  const key = lineDupKey('', 'SO-9', customerKey('C1', '__MAIN__'), 'W500');
  const later = (over: Partial<LaterLine>): LaterLine => ({ key, date: D2, orderId: 'O2', status: 'UNSERVED', carriedTo: null, ...over });
  const noPlans = new Map([['2026-09-25', null], [D2, null]]);
  /** D = 28 Sep planned on 27 Sep (the window ends on 26 Sep). */
  const at28 = (laterLines: LaterLine[] = []) => ({ date: D, today: D1, confirmedKeys: new Set<string>(), laterLines });
  const blockOf = (out: ReturnType<typeof carryCandidates>, id: string) => out.find((c) => c.orderId === id)?.blocked ?? null;

  it('the newer order was brought forward to another day: the older one is listed, not carried (it was ticked before)', () => {
    // The scratch reproduction: O2 (26 Sep) carried to 27 Sep as O2x; opening 28 Sep offered O1 again.
    const out = carryCandidates([O1(), O2({ carriedToOrderId: 'O2x' })], noPlans, at28());
    expect(out.map((c) => c.orderId)).toEqual(['O1']);
    expect(blockOf(out, 'O1')).toEqual({ code: 'SAME_LINE_LATER', text: 'Sales order SO-9 (W500) was entered again for 26 Sep (brought forward): not brought forward, so it is not delivered twice.' });
    expect(defaultCarrySelection(out).size).toBe(0);
    // As the database gives it (the carried O2 is not a window order): the day it went to is named.
    const db = carryCandidates([O1()], noPlans, at28([later({ carriedTo: D1 }), later({ orderId: 'O2x', date: D1, status: 'VALIDATED' })]));
    expect(blockOf(db, 'O1')?.text).toBe('Sales order SO-9 (W500) was entered again for 26 Sep (brought forward to 27 Sep): not brought forward, so it is not delivered twice.');
  });

  it('the newer order was dispatched or delivered: the older one is not carried', () => {
    expect(blockOf(carryCandidates([O1(), O2({ status: 'DISPATCHED' })], noPlans, at28()), 'O1')?.text).toBe(
      'Sales order SO-9 (W500) was entered again for 26 Sep (dispatched): not brought forward, so it is not delivered twice.',
    );
    expect(blockOf(carryCandidates([O1()], noPlans, at28([later({ status: 'DELIVERED' })])), 'O1')?.text).toContain('entered again for 26 Sep (delivered)');
    // On a load that left (the order still says ASSIGNED): delivered all the same, never offered again.
    const left = plan({ scopeOrderIds: ['O2'], loads: [load('T01', 1, 'COMPLETED', [{ orderId: 'O2', portionLinesJson: null }])] });
    const out = carryCandidates([O1(), O2()], new Map([['2026-09-25', null], [D2, left]]), at28());
    expect(out.map((c) => [c.orderId, c.blocked?.code])).toEqual([['O1', 'SAME_LINE_LATER']]);
  });

  it('the line re-entered for today (on an order the database gives, not listed here) or a later day (never in the window), or for day D itself', () => {
    for (const d of [D1, '2026-09-30']) {
      const out = carryCandidates([O1()], noPlans, at28([later({ orderId: 'OT', date: d, status: 'ASSIGNED' })]));
      expect(blockOf(out, 'O1')).toEqual({ code: 'SAME_LINE_LATER', text: `Sales order SO-9 (W500) was entered again for ${fmtDayMonth(d)}: not brought forward, so it is not delivered twice.` });
    }
    const onD = carryCandidates([O1()], noPlans, at28([later({ orderId: 'OD', date: D, status: 'VALIDATED' })]));
    expect(blockOf(onD, 'O1')?.code).toBe('ALREADY_ON_DAY');
  });

  it('the newer order is blocked itself (its day is being optimized): the older one is not carried either', () => {
    const optimizing = plan({ status: 'OPTIMIZING', scopeOrderIds: ['O2'] });
    const out = carryCandidates([O1(), O2()], new Map([['2026-09-25', null], [D2, optimizing]]), at28());
    expect(out.map((c) => [c.orderId, c.blocked?.code])).toEqual([
      ['O1', 'SAME_LINE_LATER'],
      ['O2', 'DAY_OPTIMIZING'],
    ]);
    expect(blockOf(out, 'O1')?.text).toBe('Sales order SO-9 (W500) was entered again for 26 Sep: not brought forward, so it is not delivered twice.');
  });

  it('a split newer order (800 delivered, 200 brought forward): the older 1000 cases are never offered again', () => {
    const out = carryCandidates([O1(1000)], noPlans, at28([later({ carriedTo: D1 }), later({ orderId: 'O2x', date: D1, status: 'VALIDATED' })]));
    expect(out.map((c) => [c.orderId, c.cases, c.blocked?.code])).toEqual([['O1', 1000, 'SAME_LINE_LATER']]);
  });

  it('only a LATER order counts: an earlier one with the same line, another product or another customer blocks nothing', () => {
    const earlier = ord('O0', { deliveryDate: '2026-09-24', status: 'DELIVERED', customerId: 'c1', customer: c1 }, [{ id: 'O0-l1', cases: 10, weightKg: 100, salesOrderNo: 'SO-9', productCode: 'W500' }]);
    const others = [
      later({ orderId: 'P', key: lineDupKey('', 'SO-9', customerKey('C1', '__MAIN__'), 'W1500') }),
      later({ orderId: 'Q', key: lineDupKey('', 'SO-9', customerKey('C2', '__MAIN__'), 'W500') }),
    ];
    const out = carryCandidates([earlier, O1()], new Map([['2026-09-24', null], ['2026-09-25', null]]), at28(others));
    expect(out.map((c) => [c.orderId, c.blocked])).toEqual([['O1', null]]);
  });

  describe('on the database: any depot, the preview and the bring forward alike', () => {
    const T = 'tA';
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
    /** 10:00 in Muscat on 27 Sep: the dispatcher plans tomorrow, 28 Sep. */
    const NOW = new Date('2026-09-27T06:00:00Z');
    const row0 = (id: string, depotId: string, iso: string, over: Record<string, unknown> = {}) => ({
      id, tenantId: T, depotId, customerId: 'c1', customer: { id: 'c1', ...c1 }, deliveryDate: day(iso), status: 'VALIDATED', totalCases: 10, totalWeightKg: 100, priority: 3,
      isLate: false, carriedToOrderId: null, carriedFromDate: null, uploadedAt: new Date('2026-09-20T00:00:00Z'),
      lines: [{ id: `${id}-l1`, cases: 10, weightKg: 100, salesOrderNo: 'SO-9', product: { code: 'W500' } }],
      ...over,
    });
    function seed(newer: Record<string, unknown>) {
      tables.depot = [
        { id: 'DA', tenantId: T, code: 'A1', active: true },
        { id: 'DB', tenantId: T, code: 'B1', active: true },
      ];
      tables.tenantConfig = [{ id: 'cfgA', tenantId: T, timezone: 'Asia/Muscat', planningCutoffMin: 1080 }];
      // O1: depot A, 25 Sep, never planned. The same line on depot B's order of 26 Sep (the newer one).
      tables.order = [row0('O1', 'DA', '2026-09-25'), row0('O2', 'DB', D2, newer)];
      tables.runPlan = [];
      tables.planLoad = [];
      tables.orderLine = [];
      tables.auditLog = [];
    }
    beforeEach(() => resetDb());

    it('the newer order on another depot, brought forward or dispatched: listed with the reason, and a bring forward is refused', async () => {
      for (const [newer, why] of [
        [{ carriedToOrderId: 'O2x', carriedTo: { deliveryDate: day(D1) } }, '26 Sep (brought forward to 27 Sep)'],
        [{ status: 'DISPATCHED' }, '26 Sep (dispatched)'],
      ] as const) {
        resetDb();
        seed(newer);
        const pv = await carryOverPreview(T, 'DA', D, { now: NOW });
        expect(pv.candidates.map((c) => [c.orderId, c.blocked?.code])).toEqual([['O1', 'SAME_LINE_LATER']]);
        expect(pv.candidates[0].blocked?.text).toBe(`Sales order SO-9 (W500) was entered again for ${why}: not brought forward, so it is not delivered twice.`);
        expect(pv).toMatchObject({ orders: 0, cases: 0, blocked: 1 });
        const e = await bringForward(T, 'DA', D, [{ orderId: 'O1', cases: 10 }], { id: 'u1' }, { now: NOW }).catch((x) => x);
        expect(e.details).toMatchObject({ code: 'CARRY_OVER_CHANGED' });
        expect(row('order', 'O1').carriedToOrderId).toBeNull();
        expect(tables.order).toHaveLength(2);
      }
    });

    it('without the newer order the same order is carried (the check blocks only a line entered again)', async () => {
      seed({ lines: [{ id: 'O2-l1', cases: 10, weightKg: 100, salesOrderNo: 'SO-OTHER', product: { code: 'W500' } }] });
      const res = await bringForward(T, 'DA', D, [{ orderId: 'O1', cases: 10 }], { id: 'u1' }, { now: NOW });
      expect(res.orders).toBe(1);
    });
  });
});

describe('PR9 second review: the day it goes to must not be over; a day being optimized; the list keeps unticked orders', () => {
  const T = 'tA';
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  /** 10:00 in Muscat on 27 Sep. */
  const NOW = new Date('2026-09-27T06:00:00Z');
  function seed() {
    tables.depot = [{ id: 'DA', tenantId: T, code: 'A1', active: true }];
    tables.tenantConfig = [{ id: 'cfgA', tenantId: T, timezone: 'Asia/Muscat', planningCutoffMin: 1080 }];
    const o = (id: string, iso: string) => ({
      id, tenantId: T, depotId: 'DA', customerId: `c-${id}`, customer: { id: `c-${id}`, code: id, branchCode: null, branchKey: '__MAIN__', name: id, active: true },
      deliveryDate: day(iso), status: 'VALIDATED', totalCases: 10, totalWeightKg: 100, priority: 3, isLate: false, carriedToOrderId: null, carriedFromDate: null,
      uploadedAt: new Date('2026-09-20T00:00:00Z'), lines: [{ id: `${id}-l1`, cases: 10, weightKg: 100, salesOrderNo: `SO-${id}`, product: { code: 'W500' } }],
    });
    // Never planned: 23 Sep and 26 Sep.
    tables.order = [o('OLD', '2026-09-23'), o('YEST', D2)];
    tables.runPlan = [];
    tables.planLoad = [];
    tables.orderLine = [];
    tables.auditLog = [];
  }
  beforeEach(() => resetDb());

  it('a day that is over lists nothing, and bringing orders forward to it is refused (409 DAY_OVER); today and later days are fine', async () => {
    seed();
    const past = await carryOverPreview(T, 'DA', '2026-09-24', { now: NOW });
    expect(past).toMatchObject({ date: '2026-09-24', today: D1, dayOver: true, orders: 0, candidates: [] });
    const e = await bringForward(T, 'DA', '2026-09-24', [{ orderId: 'OLD', cases: 10 }], { id: 'u1' }, { now: NOW }).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.details).toMatchObject({ code: 'DAY_OVER' });
    expect(e.message).toBe("24 Sep is over (today is 27 Sep): orders can only be brought forward to today or a later day. Open today's or a later day to bring them forward.");
    expect(row('order', 'OLD').carriedToOrderId).toBeNull();
    expect(tables.order).toHaveLength(2);
    // Today (27 Sep): its earlier days are listed and can be brought forward.
    const today = await carryOverPreview(T, 'DA', D1, { now: NOW });
    expect(today).toMatchObject({ dayOver: false, orders: 2 });
    const res = await bringForward(T, 'DA', D1, [{ orderId: 'YEST', cases: 10 }], { id: 'u1' }, { now: NOW });
    expect(res.orders).toBe(1);
  });

  it("day D's plan is being optimized: the copies are not in it, so RE-PLAN adds them after it - and the toast says so", async () => {
    seed();
    tables.runPlan = [{
      id: 'P28', tenantId: T, depotId: 'DA', runDate: day(D), status: 'OPTIMIZING', version: 1, reason: 'INITIAL', chosenScenarioId: null, parentRunId: null,
      supersededAt: null, currentJobId: 'J1', finalizedAt: null, reconciliationJson: null, summaryJson: null, createdAt: new Date('2026-09-27T05:00:00Z'),
    }];
    const res = await bringForward(T, 'DA', D, [{ orderId: 'YEST', cases: 10 }], { id: 'u1' }, { now: NOW });
    expect(res).toMatchObject({ orders: 1, replanNeeded: true, optimizing: true, planId: 'P28', late: false });
    expect(carryDoneText(res, D)).toBe(
      '1 order(s) (10 cases) brought forward to 28 Sep. They are not in the optimization running now: when it finishes, RE-PLAN to add them (locked, loading and dispatched loads stay exactly as they are).',
    );
    expect(carryDoneText(res, D)).not.toContain('OPTIMIZE plans them');
    // No plan at all: OPTIMIZE plans them.
    expect(carryDoneText({ ...res, replanNeeded: false, optimizing: false }, D)).toContain('OPTIMIZE plans them with the other orders of 28 Sep.');
  });

  it("the plan screen on the day screen knows today: a load of today holding a brought-forward order says re-plan today or unlock", () => {
    const dayScreen = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/dispatch-client.tsx'), 'utf8');
    const planView = dayScreen.slice(dayScreen.indexOf('<PlanView'), dayScreen.indexOf('/>', dayScreen.indexOf('<PlanView')));
    expect(planView).toContain('today={day.today}');
    const badge = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/plan-view.tsx'), 'utf8');
    // The badge's words come from carriedLoadTitle, which falls back to the plan's own today (the plan version page).
    expect(badge).toContain('title={carriedLoadTitle(l, d, today)}');
    expect(badge).not.toContain('carriedLoadRemedy(');
  });

  it('the day screen keeps the Bring forward button off while the day is being optimized', () => {
    const dayScreen = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/dispatch-client.tsx'), 'utf8');
    const panel = dayScreen.slice(dayScreen.indexOf('<CarryOverPanel'), dayScreen.indexOf('/>', dayScreen.indexOf('<CarryOverPanel')));
    expect(panel).toContain('busy={optimizing || planBusy || running}');
    expect(dayScreen).toMatch(/const running = day\.plan\?\.status === 'OPTIMIZING' \|\| day\.plan\?\.job\?\.status === 'RUNNING' \|\| day\.plan\?\.job\?\.status === 'QUEUED';/);
  });

  it('orders the dispatcher unticked stay unticked when the list is read again (a 409, a partial bring forward, a new version); new ones are ticked', () => {
    const list = [
      { orderId: 'A', blocked: null },
      { orderId: 'B', blocked: null },
      { orderId: 'X', blocked: { code: 'CUSTOMER_INACTIVE' } },
    ];
    // The customer cancelled B: the dispatcher unticks it.
    let choices = toggleCarry(new Map(), list[1]);
    expect([...carrySelected(list, choices)]).toEqual(['A']);
    // 409 CARRY_OVER_CHANGED, or an OPTIMIZE / RE-PLAN of the day: the list comes back with a new order C.
    const again = [...list, { orderId: 'C', blocked: null }];
    expect([...carrySelected(again, choices)]).toEqual(['A', 'C']);
    // A partial bring forward (A went): B is still left behind.
    expect([...carrySelected(again.filter((c) => c.orderId !== 'A'), choices)]).toEqual(['C']);
    // Ticked again by the dispatcher: selected again. A blocked order is never selected, even when chosen.
    choices = toggleCarry(choices, list[1]);
    expect([...carrySelected(again, choices)]).toEqual(['A', 'B', 'C']);
    expect(carrySelected(again, new Map()).has('X')).toBe(false);
    expect(carrySelected(again, new Map([['X', true]])).has('X')).toBe(false);
  });

  it("an order of today is never ticked by itself - not at first, not after a reload - and stays ticked once the dispatcher ticked it", () => {
    const list = [
      { orderId: 'Y', blocked: null, ofToday: false },
      { orderId: 'T', blocked: null, ofToday: true },
      { orderId: 'T2', blocked: null, ofToday: true },
    ];
    expect([...defaultCarrySelection(list)]).toEqual(['Y']);
    expect([...carrySelected(list, new Map())]).toEqual(['Y']);
    // The dispatcher knows T will not be delivered today: ticks it.
    let choices = toggleCarry(new Map(), list[1]);
    expect([...carrySelected(list, choices)]).toEqual(['Y', 'T']);
    // The list is read again (a 409, a new plan version, Look again) with another order of today: not ticked; T stays ticked.
    const again = [...list, { orderId: 'T3', blocked: null, ofToday: true }];
    expect([...carrySelected(again, choices)]).toEqual(['Y', 'T']);
    choices = toggleCarry(choices, list[1]);
    expect([...carrySelected(again, choices)]).toEqual(['Y']);
  });

  it("the panel keeps the dispatcher's ticks across reloads (never re-ticks on load), resets them only for another day or depot, shows today's group with the warning, and nothing for a day that is over", () => {
    const panel = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/carry-over-panel.tsx'), 'utf8');
    expect(panel).not.toContain('defaultCarrySelection(');
    expect(panel).not.toMatch(/setSelected\(/);
    const load = panel.slice(panel.indexOf('const load = useCallback('), panel.indexOf('}, [date, depotId]);'));
    expect(load).not.toContain('setChoices');
    expect([...panel.matchAll(/setChoices\(new Map\(\)\)/g)]).toHaveLength(1);
    expect(panel).toMatch(/setOpen\(false\);\s*setChoices\(new Map\(\)\);\s*\}, \[date, depotId\]\);/);
    expect(panel).toContain('const selected = carrySelected(preview.candidates, choices);');
    // What is sent is what is ticked, today's marked as ticked under Today (carrySelectionPayload).
    expect(panel).toContain('const body = carrySelectionPayload(preview.candidates, selected);');
    // A day that is over shows nothing; a day with no order to bring forward shows only the information
    // lists of the delivery results (no result recorded, shortfalls after a carry, Undo), when there are any.
    expect(panel).toContain('if (!preview || preview.dayOver || (preview.candidates.length === 0 && !hasFollowUps(preview))) return null;');
    // Today's orders in their own group, after the earlier days, under the owner's heading and warning.
    const list = panel.slice(panel.indexOf('data-testid="carry-over-list"'));
    expect(list.indexOf('{earlier.map(row)}')).toBeGreaterThan(0);
    expect(list.indexOf('{carryTodayTitle(preview.today)}')).toBeGreaterThan(list.indexOf('{earlier.map(row)}'));
    expect(list.indexOf('{CARRY_TODAY_WARNING}')).toBeGreaterThan(list.indexOf('{carryTodayTitle(preview.today)}'));
    expect(list.indexOf('{todays.map(row)}')).toBeGreaterThan(list.indexOf('{CARRY_TODAY_WARNING}'));
    expect(panel).toContain('const todays = preview.candidates.filter((c) => c.ofToday);');
    // The warning also shows with the list closed: it comes before the list's "{open ? (".
    const warningAt = panel.indexOf('data-testid="carry-over-today-warning"');
    expect(warningAt).toBeGreaterThan(0);
    expect(panel.indexOf('{open ? (')).toBeGreaterThan(warningAt);
    // The question names today's orders: it gets the listed orders (they say ofToday), never the POST body (it says today).
    expect(panel).toContain('carryConfirmText(preview.candidates.filter((c) => selected.has(c.orderId) && !c.blocked), date, preview.today)');
    // Each row's label and the button's count come from the helpers tested above.
    expect(panel).toContain('carryWhyLabel(w.kind, c.ofToday)');
    expect(panel).not.toMatch(/WHY_LABEL/);
    expect(panel).toContain('const suffix = carryButtonSuffix(chosen, preview);');
    expect(panel).toMatch(/Bring forward to \{fmtDayMonth\(date\)\}\s*\{suffix\}/);
    // After the carry the toast names today's orders and what to do with their loads.
    expect(panel).toContain('carryDoneText(r.data, date, preview.today)');
  });
});

describe('PR9 second review: Step 3 of the earlier day when its orders were brought forward', () => {
  const base = { orders: 1, openOrders: 0, pending: 0, chosen: true, carriedOut: { orders: 2, toDates: [D] } };

  it('a locked load holding only brought-forward orders: never "unlock it first"; unload its cases (it was loaded)', () => {
    // Integration test 1's day 1 after the carry: T01 L1 COMPLETED, T02 L1 LOCKED holding only C2 (carried).
    const t = dayNothingLeftText({ ...base, loadsByStatus: { COMPLETED: 1, LOCKED: 1 }, loadsOfDay: { COMPLETED: 1 } })!;
    expect(t).toBe(
      'Nothing left to plan: 2 order(s) of this day were brought forward to 28 Sep and are planned there, and every other order of this day is on a locked, loading or dispatched load. ' +
        'Loads and unserved lines that still show them stay in this plan for the record; nothing needs to be re-planned. ' +
        '1 locked or loading load(s) hold only brought-forward orders and were loaded: unload those cases back to stock, or tell the warehouse, before the loads of 28 Sep are picked; then put the load back to Planned.',
    );
    expect(t).not.toMatch(/unlock|left the depot/i);
  });

  it('that load put back to Planned: never "every load has left the depot" (it is still at the depot)', () => {
    const t = dayNothingLeftText({ ...base, loadsByStatus: { COMPLETED: 1, PLANNED: 1 }, loadsOfDay: { COMPLETED: 1 } })!;
    expect(t).toMatch(/^Nothing left to plan: 2 order\(s\) of this day were brought forward to 28 Sep/);
    expect(t).not.toMatch(/unlock|left the depot|were loaded/i);
    // Every order of the day brought forward: no "every other order".
    const all = dayNothingLeftText({ ...base, orders: 0, openOrders: 0, loadsByStatus: { PLANNED: 1 }, loadsOfDay: {} })!;
    expect(all).toMatch(/^Nothing left to plan: 2 order\(s\) of this day were brought forward to 28 Sep and are planned there\. /);
  });

  it('a locked load that still holds an order of the day: unlock it to change it', () => {
    expect(dayNothingLeftText({ ...base, loadsByStatus: { LOCKED: 2 }, loadsOfDay: { LOCKED: 1 } })).toMatch(/To change a locked or loading load, unlock it first\.$/);
  });

  it('nothing brought forward: the words as before; something open: nothing is said', () => {
    const none = { ...base, carriedOut: null };
    expect(dayNothingLeftText({ ...none, loadsByStatus: { LOCKED: 1 } })).toBe(
      'Every order of this day is already on a locked, loading or dispatched load: nothing left to plan. To change a load, unlock it first.',
    );
    expect(dayNothingLeftText({ ...none, loadsByStatus: { DISPATCHED: 1 } })).toBe(
      'Every order of this day is already on a locked, loading or dispatched load: nothing left to plan. Every load has left the depot; a late order for this day can still be planned.',
    );
    expect(dayNothingLeftText({ ...none, openOrders: 1, loadsByStatus: { PLANNED: 1 } })).toBeNull();
    expect(dayNothingLeftText({ ...base, pending: 1, loadsByStatus: {} })).toBeNull();
    expect(dayNothingLeftText({ ...none, orders: 0, loadsByStatus: {} })).toBeNull();
  });

  it('the day screen shows these words (no text of its own)', () => {
    const dayScreen = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/dispatch-client.tsx'), 'utf8');
    expect(dayScreen).toContain('const nothingLeftText = dayNothingLeftText({');
    expect(dayScreen).toContain('loadsOfDay: day.plan?.loadsOfDay,');
    expect(dayScreen).not.toContain('Every load has left the depot');
    expect(dayScreen).not.toContain('unlock it first');
  });
});

// ---------------------------------------------------------------------------------------------
// Delivery outcome (owner request 4 Oct 2026, spec sections 9.1 to 9.4): Bring forward reads the
// shortfall from the recorded results. Company today = 5 Oct, the dispatcher opens D = 6 Oct.
// Synthetic customers only (ACME, BETA, GAMMA, DELTA, EPS, ZETA, ETA).
// ---------------------------------------------------------------------------------------------

describe('delivery results in Bring forward: the worked examples E1 to E10 (pure)', () => {
  const TODAY = '2026-10-05';
  const DD = '2026-10-06';
  const EARLIER = '2026-10-03';
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  type Assign =[orderId: string, sequence: number, portion?: { lineId: string; cases: number }[]];
  const loadOn = (truckId: string, loadNo: number, status: string, assigns: Assign[]) => ({
    truckId,
    truckCode: truckId.toUpperCase(),
    loadNo,
    status,
    assignments: assigns.map(([orderId, sequenceInTruck, portion]) => ({ orderId, sequenceInTruck, portionLinesJson: portion ?? null })),
  });
  const result = (
    visitId: string,
    truckId: string,
    loadNo: number,
    sequence: number,
    outcome: string,
    reason: string | null,
    lines: [orderId: string, lineId: string, planned: number, notDelivered: number][],
    over: Partial<VisitShortfall> = {},
  ): VisitShortfall => ({
    visitId,
    truckId,
    loadNo,
    sequence,
    outcome,
    reason,
    note: null,
    source: 'PHONE_MANUAL',
    late: false,
    final: false,
    lines: lines.map(([orderId, lineId, planned, notDelivered]) => ({ orderId, lineId, planned, notDelivered })),
    ...over,
  });
  const at = (date: string, ...vs: VisitShortfall[]) => new Map([[date, vs]]);
  const tgt = (shortfalls: Map<string, VisitShortfall[]>) => ({ date: DD, today: TODAY, confirmedKeys: new Set<string>(), shortfalls });
  const lines2 = (id: string) => [
    { id: `${id}-a`, cases: 30, weightKg: 300, salesOrderNo: `SO-${id}`, productCode: 'A' },
    { id: `${id}-b`, cases: 10, weightKg: 100, salesOrderNo: `SO-${id}`, productCode: 'B' },
  ];
  const lineA = (id: string, cases = 100) => [{ id: `${id}-a`, cases, weightKg: cases * 10, salesOrderNo: `SO-${id}`, productCode: 'A' }];
  const planOf = (loads: ReturnType<typeof loadOn>[], unserved: CarryPlanIn['unserved'] = []) => new Map([[TODAY, plan({ loads, unserved })]]);

  // E1: ACME (A:30, B:10) on T01 L1 stop 3, dispatched today; the driver records Not delivered, Shop closed.
  const o1 = ord('O1', { deliveryDate: TODAY, status: 'DISPATCHED', customer: { code: 'ACME', branchCode: null, branchKey: '__MAIN__', name: 'ACME', active: true } }, lines2('O1'));
  const plan1 = planOf([loadOn('t01', 1, 'DISPATCHED', [['O1', 3]])]);
  const e1 = (over: Partial<VisitShortfall> = {}) => result('V1', 't01', 1, 3, 'NOT_DELIVERED', 'SHOP_CLOSED', [['O1', 'O1-a', 30, 30], ['O1', 'O1-b', 10, 10]], over);

  it('E1: not delivered today while the truck is out: listed, unticked, "the result may still change"; once back: ticked, copy with its basis', () => {
    const [c] = carryCandidates([o1], plan1, tgt(at(TODAY, e1())));
    expect(c).toMatchObject({ orderId: 'O1', cases: 40, ofToday: true, partial: false, confirmed: false, notFinal: true, late: false, openPartsText: null });
    expect(c!.why).toEqual([{ kind: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', source: 'driver', where: 'T01 L1 stop 3', text: 'Not delivered: Shop closed (driver)' }]);
    expect(carryTickedByDefault(c!)).toBe(false);
    expect(carryResultNote(c!)).toBe('truck still out, the result may still change');
    expect(carryWhyLabel('NOT_DELIVERED', true)).toBe('Not delivered today');
    expect(carryWhyLabel('NOT_DELIVERED', false)).toBe('Not delivered');
    // 16:40: Back at depot (or Completed): final -> confirmed, ticked by default.
    const [back] = carryCandidates([o1], plan1, tgt(at(TODAY, e1({ final: true }))));
    expect(back).toMatchObject({ confirmed: true, notFinal: false });
    expect(carryTickedByDefault(back!)).toBe(true);
    expect([...carrySelected([back!], new Map())]).toEqual(['O1']);
    expect(carrySelectionPayload([back!], new Set(['O1']))).toEqual([{ orderId: 'O1', cases: 40, today: true }]);
    // The copy: both lines, the basis, the late reason.
    expect(back!.basis).toEqual([{ visitId: 'V1', lines: [{ lineId: 'O1-a', notDelivered: 30 }, { lineId: 'O1-b', notDelivered: 10 }] }]);
    expect(carryLateReason(back!)).toBe('Brought forward from 5 Oct: not delivered (Shop closed, driver).');
    const src: CarrySource = {
      id: 'O1', customerId: 'c-O1', deliveryDate: day(TODAY), carriedFromDate: null, totalCases: 40, totalWeightKg: 400, totalVolumeL: 0, totalServiceTimeMin: 0,
      paymentCollectionAmount: 0, priority: 3, priorityFromFile: false, notes: null, salesValue: null, marginValue: null,
      lines: lines2('O1').map((l) => ({ id: l.id, productId: `p-${l.productCode}`, cases: l.cases, salesOrderNo: l.salesOrderNo, orderDate: null, productDescription: null, weightKg: l.weightKg, weightFromMaster: false, salesValue: null, marginValue: null, sourceRow: null, notes: null })),
    };
    const copy = carryCopyData(src, back!, { tenantId: 'tA', depotId: 'DA', date: DD, late: true, userId: 'u1', now: new Date() });
    expect(copy.lateReason).toBe('Brought forward from 5 Oct: not delivered (Shop closed, driver).');
    expect(copy.carryBasisJson).toEqual({ visits: back!.basis });
    expect((copy.lines as { create: { cases: number }[] }).create.map((l) => l.cases)).toEqual([30, 10]);
    // Copies from other whys have an empty basis and the old words.
    const plain = carryCopyData(src, { lines: back!.lines, cases: 40, date: TODAY, firstDate: TODAY }, { tenantId: 'tA', depotId: 'DA', date: DD, late: true, userId: 'u1', now: new Date() });
    expect(plain.carryBasisJson).toEqual({ visits: [] });
    expect(plain.lateReason).toBe('Brought forward from 5 Oct: not delivered on that day.');
  });

  it('E1b: the driver went back and changed it to Delivered before the truck came back: no longer a candidate', () => {
    expect(carryCandidates([o1], plan1, tgt(at(TODAY, result('V1', 't01', 1, 3, 'DELIVERED', null, [['O1', 'O1-a', 30, 0], ['O1', 'O1-b', 10, 0]], { final: true }))))).toEqual([]);
    // No result at all (E7): a dispatched order counts as delivered, as before.
    expect(carryCandidates([o1], plan1, tgt(new Map()))).toEqual([]);
  });

  it('E2: partly delivered: only the missing cases of the short line, with the reason', () => {
    const o2 = ord('O2', { deliveryDate: TODAY, status: 'DISPATCHED' }, lines2('O2'));
    const [c] = carryCandidates([o2], planOf([loadOn('t02', 1, 'COMPLETED', [['O2', 1]])]), tgt(at(TODAY, result('V2', 't02', 1, 1, 'PARTLY_DELIVERED', 'DAMAGED_GOODS', [['O2', 'O2-a', 30, 0], ['O2', 'O2-b', 10, 6]], { final: true }))));
    expect(c).toMatchObject({ cases: 6, partial: true, confirmed: true });
    expect(c!.lines.map((l) => [l.lineId, l.cases])).toEqual([['O2-b', 6]]);
    expect(c!.why[0]!.text).toBe('Partly delivered: 6 of 40 cases not delivered: Damaged goods (driver)');
    expect(c!.basis).toEqual([{ visitId: 'V2', lines: [{ lineId: 'O2-b', notDelivered: 6 }] }]);
    expect(carryTickedByDefault(c!)).toBe(true);
  });

  it('E3: a split order on two trucks: delivered on one, partly on the other: 15 open, confirmed', () => {
    const o3 = ord('O3', { deliveryDate: TODAY, status: 'DISPATCHED' }, lineA('O3'));
    const p = planOf([loadOn('t01', 1, 'COMPLETED', [['O3', 2, [{ lineId: 'O3-a', cases: 60 }]]]), loadOn('t03', 1, 'COMPLETED', [['O3', 1, [{ lineId: 'O3-a', cases: 40 }]]])]);
    const [c] = carryCandidates([o3], p, tgt(at(TODAY, result('VA', 't01', 1, 2, 'DELIVERED', null, [['O3', 'O3-a', 60, 0]], { final: true }), result('VB', 't03', 1, 1, 'PARTLY_DELIVERED', 'CUSTOMER_REFUSED', [['O3', 'O3-a', 40, 15]], { final: true }))));
    expect(c).toMatchObject({ cases: 15, confirmed: true, openPartsText: null });
    expect(c!.basis).toEqual([{ visitId: 'VB', lines: [{ lineId: 'O3-a', notDelivered: 15 }] }]);
  });

  it('E3b: one part without a result yet: it counts as delivered, the order is not confirmed and says which part', () => {
    const o3 = ord('O3', { deliveryDate: TODAY, status: 'DISPATCHED' }, lineA('O3'));
    const p = planOf([loadOn('t01', 1, 'COMPLETED', [['O3', 2, [{ lineId: 'O3-a', cases: 60 }]]]), loadOn('t03', 1, 'COMPLETED', [['O3', 1, [{ lineId: 'O3-a', cases: 40 }]]])]);
    const [c] = carryCandidates([o3], p, tgt(at(TODAY, result('VA', 't01', 1, 2, 'NOT_DELIVERED', 'SHOP_CLOSED', [['O3', 'O3-a', 60, 60]], { final: true }))));
    expect(c).toMatchObject({ cases: 60, confirmed: false, openPartsText: 'other part (T03 L1 stop 1) has no result' });
    expect(carryTickedByDefault(c!)).toBe(false);
    // An earlier day's order with an open part is still ticked (its day is over) and shows the note.
    const old = ord('O3', { deliveryDate: EARLIER, status: 'DISPATCHED' }, lineA('O3'));
    const [e] = carryCandidates([old], new Map([[EARLIER, p.get(TODAY)!]]), tgt(at(EARLIER, result('VA', 't01', 1, 2, 'NOT_DELIVERED', 'SHOP_CLOSED', [['O3', 'O3-a', 60, 60]]))));
    expect(e).toMatchObject({ ofToday: false, confirmed: false });
    expect(carryTickedByDefault(e!)).toBe(true);
    expect(carryResultNote(e!)).toBe('other part (T03 L1 stop 1) has no result');
  });

  it('E4: a partly delivered part and an unserved rest: both whys, never confirmed (the rest may still leave today)', () => {
    const o4 = ord('O4', { deliveryDate: TODAY, status: 'ASSIGNED' }, lineA('O4'));
    const p = planOf([loadOn('t01', 2, 'DISPATCHED', [['O4', 1, [{ lineId: 'O4-a', cases: 60 }]]])], [{ orderId: 'O4', reasonCode: 'EXCEEDS_TRUCK_CAPACITY', reasonMessage: 'Too big.', portionLinesJson: [{ lineId: 'O4-a', cases: 40 }] }]);
    const [c] = carryCandidates([o4], p, tgt(at(TODAY, result('V4', 't01', 2, 1, 'PARTLY_DELIVERED', 'SHOP_CLOSED', [['O4', 'O4-a', 60, 10]], { final: true }))));
    expect(c).toMatchObject({ cases: 50, confirmed: false });
    expect(c!.why.map((w) => w.kind)).toEqual(['NOT_DELIVERED', 'UNSERVED']);
    expect(carryTickedByDefault(c!)).toBe(false);
  });

  it('E5: the other part has not left (locked today): not confirmed; brought forward by hand it blocks that load (ORDERS_CARRIED, unchanged)', () => {
    const o5 = ord('O5', { deliveryDate: TODAY, status: 'ASSIGNED' }, lineA('O5'));
    const p = planOf([loadOn('t01', 1, 'DISPATCHED', [['O5', 1, [{ lineId: 'O5-a', cases: 60 }]]]), loadOn('t04', 2, 'LOCKED', [['O5', 2, [{ lineId: 'O5-a', cases: 40 }]]])]);
    const [c] = carryCandidates([o5], p, tgt(at(TODAY, result('V5', 't01', 1, 1, 'NOT_DELIVERED', 'WRONG_LOCATION', [['O5', 'O5-a', 60, 60]], { final: true }))));
    expect(c).toMatchObject({ cases: 100, confirmed: false });
    expect(c!.why.map((w) => w.kind)).toEqual(['NOT_DELIVERED', 'NOT_LEFT']);
    expect(c!.why[0]!.text).toBe('Not delivered: Wrong location or could not find (driver)');
  });

  it('E8: an earlier day recorded by the dispatcher: listed with "(dispatcher)", ticked; "Other" carries the note', () => {
    const o7 = ord('O7', { deliveryDate: EARLIER, status: 'DISPATCHED' }, lineA('O7', 12));
    const p = new Map([[EARLIER, plan({ loads: [loadOn('t02', 2, 'DISPATCHED', [['O7', 1]])] })]]);
    const [c] = carryCandidates([o7], p, tgt(at(EARLIER, result('V7', 't02', 2, 1, 'NOT_DELIVERED', 'PAYMENT_ISSUE', [['O7', 'O7-a', 12, 12]], { source: 'DISPATCHER' }))));
    expect(c).toMatchObject({ ofToday: false, cases: 12 });
    expect(c!.why[0]!.text).toBe('Not delivered: Payment issue (dispatcher)');
    expect(carryTickedByDefault(c!)).toBe(true);
    expect(carryLateReason(c!)).toBe('Brought forward from 3 Oct: not delivered (Payment issue, dispatcher).');
    const [other] = carryCandidates([o7], p, tgt(at(EARLIER, result('V7', 't02', 2, 1, 'NOT_DELIVERED', 'OTHER', [['O7', 'O7-a', 12, 12]], { note: 'gate locked' }))));
    expect(other!.why[0]!.text).toBe('Not delivered: Other - gate locked (driver)');
  });

  it('E9: the result changed after the list was shown: the order is no longer open, nothing is carried', () => {
    const check = checkSelection([], [{ orderId: 'O1', cases: 40, today: true }], new Map());
    expect(check.carry).toEqual([]);
    expect(check.changed.map((c) => c.orderId)).toEqual(['O1']);
  });

  it('E10: a result recorded after the trip closed is listed but never ticked by default, today or earlier', () => {
    const [today] = carryCandidates([o1], plan1, tgt(at(TODAY, e1({ final: true, late: true }))));
    expect(today).toMatchObject({ confirmed: false, late: true });
    expect(carryTickedByDefault(today!)).toBe(false);
    expect(carryResultNote(today!)).toBe('recorded after the trip closed');
    const earlier = ord('O1', { deliveryDate: EARLIER, status: 'DISPATCHED' }, lines2('O1'));
    const [e] = carryCandidates([earlier], new Map([[EARLIER, plan1.get(TODAY)!]]), tgt(at(EARLIER, e1({ late: true }))));
    expect(carryTickedByDefault(e!)).toBe(false);
  });

  it('a result that matches no stop of the live plan is ignored (it cannot carry cases the plan does not show)', () => {
    expect(carryCandidates([o1], plan1, tgt(at(TODAY, result('VX', 't09', 1, 3, 'NOT_DELIVERED', 'SHOP_CLOSED', [['O1', 'O1-a', 30, 30]], { final: true }))))).toEqual([]);
  });

  it("the question before Bring forward names today's recorded orders apart from the others; the Undo question", () => {
    const text = carryConfirmText(
      [
        { cases: 40, ofToday: true, confirmed: true },
        { cases: 10, ofToday: true, confirmed: false },
        { cases: 5, ofToday: false },
      ],
      DD,
      TODAY,
    );
    expect(text).toContain('Bring 3 order(s) (55 cases) forward to 6 Oct?');
    expect(text).toContain('1 of them were recorded as not delivered today (40 cases): their trucks are back.');
    expect(text).toContain('1 of them (10 cases) are orders of TODAY (5 Oct)');
    expect(carryUndoConfirmText({ customerCode: 'ACME', branchCode: null, cases: 40 }, DD)).toBe('Remove the copy of ACME on 6 Oct (40 cases)? The order goes back to the list.');
    expect(
      noOutcomeGroups([
        { date: TODAY, truckCode: 'T05', loadNo: 1, sequence: 4, customerCode: 'ZETA', branchCode: null, customerName: 'ZETA', cases: 20 },
        { date: TODAY, truckCode: 'T05', loadNo: 1, sequence: 6, customerCode: 'ETA', branchCode: null, customerName: 'ETA', cases: 5 },
      ]).map((g) => [g.truckCode, g.stops.length]),
    ).toEqual([['T05', 2]]);
  });
});

describe('delivery results in Bring forward: on the database (fake)', () => {
  const T = 'tA';
  // 5 Oct, 18:00 in Muscat: the dispatcher plans 6 Oct.
  const NOW5 = new Date('2026-10-05T14:00:00Z');
  const TODAY = '2026-10-05';
  const DD = '2026-10-06';
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const lines = [
    { id: 'O1-a', cases: 30, weightKg: 300, salesOrderNo: 'SO-1', productId: 'pA', product: { code: 'A', name: 'A' } },
    { id: 'O1-b', cases: 10, weightKg: 100, salesOrderNo: 'SO-1', productId: 'pB', product: { code: 'B', name: 'B' } },
  ];
  const visitRow = (over: Record<string, unknown> = {}) => ({
    id: 'V1',
    tenantId: T,
    depotId: 'DA',
    deliveryDate: day(TODAY),
    truckId: 'T1',
    loadNo: 1,
    sequence: 3,
    customerId: 'c-ACME',
    outcome: 'NOT_DELIVERED',
    reason: 'SHOP_CLOSED',
    reasonNote: null,
    outcomeSource: 'PHONE_MANUAL',
    outcomeLate: false,
    casesPlanned: 40,
    casesDelivered: 0,
    linesJson: [
      { orderId: 'O1', lineId: 'O1-a', productCode: 'A', plannedCases: 30, deliveredCases: 0 },
      { orderId: 'O1', lineId: 'O1-b', productCode: 'B', plannedCases: 10, deliveredCases: 0 },
    ],
    ...over,
  });
  function seed(loadStatus = 'DISPATCHED') {
    resetDb();
    tables.depot = [{ id: 'DA', tenantId: T, code: 'A1', active: true }];
    tables.tenantConfig = [{ id: 'cfgA', tenantId: T, timezone: 'Asia/Muscat', planningCutoffMin: 1080, outcomesSince: new Date('2026-10-01T00:00:00Z') }];
    tables.truck = [{ id: 'T1', tenantId: T, code: 'T01', hired: false }];
    tables.order = [
      {
        id: 'O1', tenantId: T, depotId: 'DA', customerId: 'c-ACME', customer: { id: 'c-ACME', code: 'ACME', branchCode: null, branchKey: '__MAIN__', name: 'ACME', active: true },
        deliveryDate: day(TODAY), status: 'DISPATCHED', totalCases: 40, totalWeightKg: 400, totalVolumeL: 0, totalServiceTimeMin: 0, paymentCollectionAmount: 0, priority: 3, priorityFromFile: false,
        notes: null, isLate: false, salesValue: null, marginValue: null, carriedToOrderId: null, carriedFromDate: null, uploadedAt: new Date('2026-10-04T00:00:00Z'), lines,
      },
    ];
    tables.runPlan = [{ id: 'P5', tenantId: T, depotId: 'DA', runDate: day(TODAY), status: 'DISPATCHED', version: 1, reason: 'INITIAL', chosenScenarioId: 'sc-P5', parentRunId: null, supersededAt: null, createdAt: new Date('2026-10-04T12:00:00Z') }];
    tables.planLoad = [{ id: 'L5', tenantId: T, runId: 'P5', truckId: 'T1', loadNo: 1, status: loadStatus, departMin: 420, returnMin: 900, truck: { code: 'T01' }, assignments: [{ orderId: 'O1', portionLinesJson: null, sequenceInTruck: 3 }] }];
    tables.routeAssignment = [];
    tables.scenarioResult = [{ id: 'sc-P5', runId: 'P5', name: 'RECOMMENDED', detailsJson: { scope: { orderIds: ['O1'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] }, loads: [] } }];
    tables.unservedOrder = [];
    tables.stopVisit = [visitRow()];
    tables.stopEvent = [];
    tables.driverLink = [];
    tables.orderLine = [];
    tables.auditLog = [];
  }

  it('E1 on the database: a dispatched order recorded as not delivered is listed; unticked while out, confirmed once the load is back', async () => {
    seed();
    const pv = await carryOverPreview(T, 'DA', DD, { now: NOW5 });
    expect(pv.candidates.map((c) => [c.orderId, c.cases, c.ofToday, c.confirmed, c.notFinal])).toEqual([['O1', 40, true, false, true]]);
    expect([...defaultCarrySelection(pv.candidates)]).toEqual([]);
    // Back at depot: final.
    tables.stopEvent = [{ id: 'e1', tenantId: T, depotId: 'DA', deliveryDate: day(TODAY), truckId: 'T1', loadNo: 1, sequence: null, kind: 'BACK_AT_DEPOT', at: new Date('2026-10-05T12:40:00Z') }];
    const back = await carryOverPreview(T, 'DA', DD, { now: NOW5 });
    expect(back.candidates[0]).toMatchObject({ confirmed: true, notFinal: false });
    expect([...defaultCarrySelection(back.candidates)]).toEqual(['O1']);
    // A COMPLETED load is final too.
    seed('COMPLETED');
    expect((await carryOverPreview(T, 'DA', DD, { now: NOW5 })).candidates[0]).toMatchObject({ confirmed: true });
  });

  it('bring forward writes the carry basis on the copy and in the audit, and takes the outcome-day lock after the day locks and before the plans row locks', async () => {
    seed('COMPLETED');
    const calls: { sql: string; values: unknown[] }[] = [];
    const orig = fakePrisma.$queryRaw;
    fakePrisma.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return orig(strings, ...values);
    };
    try {
      const res = await bringForward(T, 'DA', DD, [{ orderId: 'O1', cases: 40, today: true }], { id: 'u1' }, { now: NOW5 });
      expect(res).toMatchObject({ orders: 1, cases: 40 });
    } finally {
      fakePrisma.$queryRaw = orig;
    }
    const copy = tables.order.find((o) => o.carriedFromOrderId === 'O1')!;
    expect(copy.carryBasisJson).toEqual({ visits: [{ visitId: 'V1', lines: [{ lineId: 'O1-a', notDelivered: 30 }, { lineId: 'O1-b', notDelivered: 10 }] }] });
    expect(copy.lateReason).toBe('Brought forward from 5 Oct: not delivered (Shop closed, driver).');
    const a = tables.auditLog.find((x) => x.action === 'ORDERS_CARRIED_OVER')!;
    expect(a.afterJson.carried[0].basis).toEqual(copy.carryBasisJson);
    const idx = (pred: (c: { sql: string; values: unknown[] }) => boolean) => calls.findIndex(pred);
    const dayLock = idx((c) => c.values[0] === `planday:tA|DA|${TODAY}`);
    const outcomeLock = idx((c) => c.values[0] === `outcomes:tA|DA|${TODAY}`);
    const rowLock = idx((c) => /FOR UPDATE/.test(c.sql) && c.values[0] === 'P5');
    expect(dayLock).toBeGreaterThanOrEqual(0);
    expect(outcomeLock).toBeGreaterThan(dayLock);
    expect(rowLock).toBeGreaterThan(outcomeLock);
  });

  it('the panel lists: no result recorded on a load that is back (not before the feature started), and the copies that Undo can remove', async () => {
    seed('COMPLETED');
    tables.stopVisit = [];
    tables.planLoad[0].assignments = [];
    tables.order[0].status = 'DISPATCHED';
    tables.routeAssignment = [
      { id: 'ra1', runId: 'P5', loadId: 'L5', truckId: 'T1', loadNo: 1, orderId: 'O1', sequenceInTruck: 4, orderInStop: 0, portionLinesJson: null, stopSnapshotJson: { v: 1, customerId: 'c-ZETA', code: 'ZETA', name: 'ZETA', branchCode: null, lat: 23.6, lng: 58.4 } },
    ];
    const pv = await carryOverPreview(T, 'DA', DD, { now: NOW5 });
    expect(pv.candidates).toEqual([]);
    expect(pv.noOutcome).toEqual([{ date: TODAY, truckCode: 'T01', loadNo: 1, sequence: 4, customerCode: 'ZETA', branchCode: null, customerName: 'ZETA', cases: 40 }]);
    // Before the feature started (outcomesSince on 5 Oct, no link or visit that day): nothing.
    tables.tenantConfig[0].outcomesSince = new Date('2026-10-05T06:00:00Z');
    expect((await carryOverPreview(T, 'DA', DD, { now: NOW5 })).noOutcome).toEqual([]);
    // A driver link that day brings it in scope again.
    tables.driverLink = [{ id: 'dl1', tenantId: T, truckId: 'T1', deliveryDate: day(TODAY) }];
    expect((await carryOverPreview(T, 'DA', DD, { now: NOW5 })).noOutcome).toHaveLength(1);
    // A copy on D that no plan refers to: undoable; planned: not.
    tables.order.push({ id: 'C1', tenantId: T, depotId: 'DA', customerId: 'c-ACME', customer: { code: 'ACME', branchCode: null, name: 'ACME' }, deliveryDate: day(DD), status: 'VALIDATED', totalCases: 40, carriedFromOrderId: 'O1', carriedFrom: { deliveryDate: day(TODAY) }, lines: [] });
    tables.order[0].carriedToOrderId = 'C1';
    const u = await carryOverPreview(T, 'DA', DD, { now: NOW5 });
    expect(u.undoable).toEqual([{ originalOrderId: 'O1', copyId: 'C1', customerCode: 'ACME', branchCode: null, customerName: 'ACME', cases: 40, fromDate: TODAY }]);
    tables.unservedOrder = [{ id: 'U1', scenarioId: 'scX', orderId: 'C1', reasonCode: 'TRIP_LIMIT', portionLinesJson: null }];
    expect((await carryOverPreview(T, 'DA', DD, { now: NOW5 })).undoable).toEqual([]);
  });

  it('a shortfall that grew after the carry is listed as information (E3b)', async () => {
    seed('COMPLETED');
    tables.order.push({ id: 'C1', tenantId: T, depotId: 'DA', customerId: 'c-ACME', customer: { code: 'ACME', branchCode: null, name: 'ACME' }, deliveryDate: day(DD), status: 'VALIDATED', totalCases: 30, carriedFromOrderId: 'O1', carryBasisJson: { visits: [{ visitId: 'V1', lines: [{ lineId: 'O1-a', notDelivered: 30 }] }] }, lines: [] });
    tables.order[0].carriedToOrderId = 'C1';
    // At the carry only O1-a was short (30); now O1-b is short too (10).
    const pv = await carryOverPreview(T, 'DA', DD, { now: NOW5 });
    expect(pv.lateShortfalls).toEqual([
      { orderId: 'O1', copyDate: DD, customerCode: 'ACME', branchCode: null, customerName: 'ACME', cases: 10, text: 'Not delivered after it was brought forward: 10 cases of ACME (T01 L1 stop 3, Shop closed) - add a late order for 6 Oct' },
    ]);
  });
});
