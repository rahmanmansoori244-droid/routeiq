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
  carryOverPreview,
  carryWindow,
  checkSelection,
  isCarryConflict,
  type CarryOrderIn,
  type CarryPlanIn,
  type CarrySource,
  type LaterLine,
} from '@/lib/dispatch/carry-over';
import {
  carriedFromBadge,
  carriedLoadRemedy,
  carriedLoadShows,
  carriedStopText,
  carriedToBadge,
  carryDoneText,
  carrySelected,
  carrySelectionPayload,
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

describe('only days that are over: never today or later in the company\'s timezone (PR9 review)', () => {
  const TODAY = D1; // 27 Sep; the day screen opens on tomorrow, D = 28 Sep
  it('the window is [D-7, D-1] capped at yesterday; a day more than a week ahead has none', () => {
    expect(carryWindow('2026-09-27', '2026-09-27')).toEqual({ from: '2026-09-20', to: '2026-09-26' });
    expect(carryWindow('2026-09-28', '2026-09-27')).toEqual({ from: '2026-09-21', to: '2026-09-26' });
    expect(carryWindow('2026-09-30', '2026-09-27')).toEqual({ from: '2026-09-23', to: '2026-09-26' });
    expect(carryWindow('2026-09-20', '2026-09-27')).toEqual({ from: '2026-09-13', to: '2026-09-19' });
    const far = carryWindow('2026-10-10', '2026-09-27');
    expect(far.to < far.from).toBe(true);
  });

  it('D = tomorrow: today\'s orders (loads locked at night, afternoon trips, waiting late orders) are not listed; yesterday\'s are', () => {
    const orders = [
      ord('TP', { deliveryDate: TODAY }),
      ord('TL', { deliveryDate: TODAY }),
      ord('TU', { deliveryDate: TODAY }),
      ord('TN', { deliveryDate: TODAY }),
      ord('Y', { deliveryDate: D2 }),
    ];
    const todayPlan = plan({
      scopeOrderIds: ['TP', 'TL', 'TU'],
      loads: [load('T01', 1, 'LOCKED', [{ orderId: 'TL', portionLinesJson: null }]), load('T01', 2, 'PLANNED', [{ orderId: 'TP', portionLinesJson: null }])],
      unserved: [{ orderId: 'TU', reasonCode: 'TRIP_LIMIT', reasonMessage: null, portionLinesJson: null }],
    });
    const out = carryCandidates(orders, new Map([[TODAY, todayPlan], [D2, null]]), target([], TODAY));
    expect(out.map((c) => c.orderId)).toEqual(['Y']);
    // The same orders once the day is over (the next morning, D = 28 Sep = today): all listed.
    const later = carryCandidates(orders, new Map([[TODAY, todayPlan], [D2, null]]), target([], D));
    expect(later.map((c) => [c.orderId, c.why[0].kind])).toEqual([
      ['Y', 'NEVER_PLANNED'],
      ['TL', 'NOT_LEFT'],
      ['TN', 'NEVER_PLANNED'],
      ['TP', 'NOT_LEFT'],
      ['TU', 'UNSERVED'],
    ]);
  });

  it('D = today + 2: tomorrow\'s confirmed orders are not due yet and never listed (nor today\'s)', () => {
    const tomorrow = D; // 28 Sep
    const out = carryCandidates(
      [ord('TM', { deliveryDate: tomorrow }), ord('TD', { deliveryDate: TODAY }), ord('Y', { deliveryDate: D2 })],
      new Map([[tomorrow, null], [TODAY, null], [D2, null]]),
      { date: '2026-09-29', today: TODAY, confirmedKeys: new Set() },
    );
    expect(out.map((c) => c.orderId)).toEqual(['Y']);
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
    function seed(loadStatus: string) {
      const day = new Date(`${D1}T00:00:00Z`);
      tables.truck = [{ id: 'T1', tenantId: T, code: 'T01', defaultDriverId: null, capacityCases: 100, capacityWeightKg: 1000 }];
      tables.order = [
        { id: 'O1', tenantId: T, customerId: 'c1', customer: { code: 'C1', branchCode: null }, totalCases: 40, totalWeightKg: 400, status: 'ASSIGNED', deliveryDate: day, carriedToOrderId: 'O1b', carriedTo: { deliveryDate: new Date(`${D}T00:00:00Z`) } },
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
        const e = await updateLoad(T, 'P', 'L1', { status: to }, user, allow).catch((x) => x);
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
        tables.order.push({ id: 'O9', tenantId: T, customerId: 'c9', customer: { code: 'C9', branchCode: null }, totalCases: 10, totalWeightKg: 100, status: 'ASSIGNED', deliveryDate: new Date(`${D1}T00:00:00Z`), carriedToOrderId: null });
        tables.routeAssignment.push({ id: 'A9', runId: 'P', truckId: 'T1', loadId: 'L1', loadNo: 1, orderId: 'O9', sequenceInTruck: 2, orderInStop: 0, portionLinesJson: null });
        const e = await updateLoad(T, 'P', 'L1', { status: from === 'PLANNED' ? 'LOCKED' : 'LOADING' }, user, allow).catch((x) => x);
        expect(e.details).toMatchObject({ code: 'ORDERS_CARRIED', orderIds: ['O1'] });
        expect(e.message).toContain(
          from === 'PLANNED' ? 'Re-plan this day to plan its other orders without them.' : 'To deliver its other orders, put the load back to Planned and re-plan this day',
        );
        if (from === 'LOCKED') expect(e.message).toContain('Their cases were loaded: unload them (they are planned on 28 Sep now).');
        expect(e.message).not.toContain('holds nothing else');
      }
    });

    it('stepping back is never refused: unlock the load to re-plan the day', async () => {
      seed('LOCKED');
      await updateLoad(T, 'P', 'L1', { status: 'PLANNED' }, user, allow);
      expect(row('planLoad', 'L1').status).toBe('PLANNED');
    });

    it('the plan of the earlier day stays as it was, and shows its carried orders as "carried over to" (history, not a problem)', async () => {
      seed('LOCKED');
      const day = new Date(`${D1}T00:00:00Z`);
      tables.order.push(
        { id: 'O2', tenantId: T, customerId: 'c2', totalCases: 15, totalWeightKg: 150, status: 'UNSERVED', deliveryDate: day, carriedToOrderId: 'O2b', carriedTo: { deliveryDate: new Date(`${D}T00:00:00Z`), totalCases: 15 } },
        { id: 'O3', tenantId: T, customerId: 'c3', totalCases: 20, totalWeightKg: 200, status: 'ASSIGNED', deliveryDate: day, carriedFromDate: new Date(`${D2}T00:00:00Z`), carriedToOrderId: null },
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

  it('the preview for tomorrow lists yesterday, never today (its locked load may still leave); the next morning it does', async () => {
    seedDays();
    const pv = await carryOverPreview(T, 'DA', D, { now: NOW });
    expect(pv).toMatchObject({ from: '2026-09-21', to: D2, today: D1, orders: 1, cases: 10 });
    expect(pv.candidates.map((c) => [c.orderId, c.why[0].kind])).toEqual([['YEST', 'UNSERVED']]);
    // 28 Sep, 07:00 in Muscat: 27 Sep is over, its locked load never left.
    const next = await carryOverPreview(T, 'DA', D, { now: new Date('2026-09-28T03:00:00Z') });
    expect(next.candidates.map((c) => [c.orderId, c.why[0].kind])).toEqual([
      ['YEST', 'UNSERVED'],
      ['TODAY', 'NOT_LEFT'],
    ]);
  });

  it("bringing forward one of today's orders is refused (409 CARRY_OVER_CHANGED), nothing is carried and its load keeps it", async () => {
    seedDays();
    const e = await bringForward(T, 'DA', D, [{ orderId: 'TODAY', cases: 10 }], { id: 'u1' }, { now: NOW }).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.details).toMatchObject({ code: 'CARRY_OVER_CHANGED' });
    expect(row('order', 'TODAY').carriedToOrderId).toBeNull();
    expect(tables.order).toHaveLength(2);
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
    const rowLock = at((c) => /FOR UPDATE/.test(c.sql) && c.values[0] === 'P26');
    expect(intake).toBeGreaterThanOrEqual(0);
    expect(dayLock).toBeGreaterThan(intake);
    expect(rowLock).toBeGreaterThan(dayLock);
    // Today is not read, so neither locked.
    expect(raw.calls.some((c) => c.values[0] === `planday:tA|DA|${D1}`)).toBe(false);
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
  beforeEach(() => {
    resetDb();
    session.role = 'PLANNER';
    tables.depot = [
      { id: 'DA', tenantId: 'tA', code: 'A1', active: true },
      { id: 'DB', tenantId: 'tB', code: 'B1', active: true },
    ];
    tables.tenantConfig = [{ id: 'cfgA', tenantId: 'tA', timezone: 'Asia/Muscat', planningCutoffMin: 1080 }];
    // An order of this company and one of ANOTHER company, both not delivered the day before (no plan).
    const line = (id: string) => [{ id: `${id}-l1`, cases: 5, weightKg: 50, salesOrderNo: `SO-${id}`, product: { code: 'W500' } }];
    const customer = (code: string) => ({ code, branchCode: null, branchKey: '__MAIN__', name: code, active: true });
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

  it('the line re-entered for today or a later day (never in the window), or for day D itself', () => {
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
    let unticked = toggleCarry(new Set(), 'B');
    expect([...carrySelected(list, unticked)]).toEqual(['A']);
    // 409 CARRY_OVER_CHANGED, or an OPTIMIZE / RE-PLAN of the day: the list comes back with a new order C.
    const again = [...list, { orderId: 'C', blocked: null }];
    expect([...carrySelected(again, unticked)]).toEqual(['A', 'C']);
    // A partial bring forward (A went): B is still left behind.
    expect([...carrySelected(again.filter((c) => c.orderId !== 'A'), unticked)]).toEqual(['C']);
    // Ticked again by the dispatcher: selected again. A blocked order is never selected.
    unticked = toggleCarry(unticked, 'B');
    expect([...carrySelected(again, unticked)]).toEqual(['A', 'B', 'C']);
    expect(carrySelected(again, new Set()).has('X')).toBe(false);
  });

  it('the panel keeps what was unticked across reloads (never re-ticks on load), resets it only for another day or depot, and shows nothing for a day that is over', () => {
    const panel = readFileSync(path.resolve(__dirname, '../../app/t/[slug]/dispatch/carry-over-panel.tsx'), 'utf8');
    expect(panel).not.toContain('defaultCarrySelection(');
    expect(panel).not.toMatch(/setSelected\(/);
    const load = panel.slice(panel.indexOf('const load = useCallback('), panel.indexOf('}, [date, depotId]);'));
    expect(load).not.toContain('setUnticked');
    expect([...panel.matchAll(/setUnticked\(new Set\(\)\)/g)]).toHaveLength(1);
    expect(panel).toMatch(/setOpen\(false\);\s*setUnticked\(new Set\(\)\);\s*\}, \[date, depotId\]\);/);
    expect(panel).toContain('carrySelected(preview.candidates, unticked)');
    expect(panel).toContain('if (!preview || preview.dayOver || preview.candidates.length === 0) return null;');
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
