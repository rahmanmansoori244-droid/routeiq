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
import { resetDb, row, tables } from './fake-plan-db';

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
  carryCandidates,
  carryCopyData,
  checkSelection,
  isCarryConflict,
  type CarryOrderIn,
  type CarryPlanIn,
  type CarrySource,
} from '@/lib/dispatch/carry-over';
import { carriedFromBadge, carriedStopText, carriedToBadge, carryDoneText, carrySelectionPayload, defaultCarrySelection } from '@/lib/dispatch/carry-view';
import { customerKey, lineDupKey } from '@/lib/dispatch/order-intake';
import { ordersInScopeWhere, pendingLateOrderIds, updateLoad } from '@/lib/dispatch/plan-service';
import ExcelJS from 'exceljs';
import { buildDispatchWorkbook, carriedOverRows, loadSheetName } from '@/lib/dispatch/workbook';
import { driverPackModel } from '@/lib/dispatch/driver-pack';
import { fmtDayMonth } from '@/lib/dispatch/time';
import { CARRIED_OUT_OF_PLAN } from '@/lib/dashboard';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { fixture } from './plan-detail-fixture';

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
const target = (keys: string[] = []) => ({ date: D, confirmedKeys: new Set(keys) });

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
        expect(e.message).toContain(from === 'PLANNED' ? 'Re-plan this day to take them off.' : 'Put the load back to Planned and re-plan this day');
        expect(row('planLoad', 'L1').status).toBe(from);
        expect(tables.auditLog.some((a) => String(a.action).startsWith('LOAD_'))).toBe(false);
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

describe('the carry-over API: roles, bodies and tenant isolation', () => {
  const DAY = '2099-03-10';
  beforeEach(() => {
    resetDb();
    session.role = 'PLANNER';
    tables.depot = [
      { id: 'DA', tenantId: 'tA', code: 'A1', active: true },
      { id: 'DB', tenantId: 'tB', code: 'B1', active: true },
    ];
    tables.tenantConfig = [{ id: 'cfgA', tenantId: 'tA', timezone: 'Asia/Muscat', planningCutoffMin: 1080 }];
    // An unserved order of ANOTHER company, the day before.
    tables.order = [{ id: 'B-ORDER', tenantId: 'tB', depotId: 'DB', customerId: 'cb', deliveryDate: new Date('2099-03-09T00:00:00Z'), status: 'UNSERVED', totalCases: 5, totalWeightKg: 50, carriedToOrderId: null }];
  });
  const post = (body: unknown) => carryRoute(new Request('http://localhost/api/dispatch/carry-over', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
  const get = (q: string) => previewRoute(new Request(`http://localhost/api/dispatch/carry-over?${q}`));

  it('another company\'s orders are never listed, and selecting one carries nothing (409, no data about it)', async () => {
    const pv = await get(`date=${DAY}&depotId=DA`);
    expect(pv.status).toBe(200);
    expect(((await pv.json()) as { data: { candidates: unknown[] } }).data.candidates).toEqual([]);
    const res = await post({ date: DAY, depotId: 'DA', selected: [{ orderId: 'B-ORDER', cases: 5 }] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; changed: { orderId: string; text: string }[] } };
    expect(body.error.code).toBe('CARRY_OVER_CHANGED');
    expect(body.error.changed).toEqual([{ orderId: 'B-ORDER', text: 'No longer open on an earlier day (delivered, dispatched or removed since the list was shown).' }]);
    expect(tables.order).toHaveLength(1);
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
