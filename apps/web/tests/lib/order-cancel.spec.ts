/**
 * Cancel order and Postpone order (owner request of the first live night, 12 Oct 2026): the pure rules
 * and words (lib/dispatch/order-cancel-rules.ts) and how the shared helpers treat a cancelled order.
 * The database side (locks, the load gate, re-plan, re-upload, 404 / 403) is covered by
 * tests/integration/order-cancel-db.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  cancelDoneText,
  cancelledLoadText,
  checkOrderActionReason,
  invoicesText,
  NOT_CANCELLED,
  orderActionReasonText,
  orderActionRefusal,
  plannedLoadsOf,
  postponeDateRefusal,
  postponeDoneText,
  postponeLateReason,
  postponeRange,
  severalInvoicesNote,
  undoCancelDayOver,
  undoCancelDoneText,
  type OrderStateNow,
} from '@/lib/dispatch/order-cancel-rules';
import { ordersInScopeWhere } from '@/lib/dispatch/plan-service';
import { orderStatusFilter } from '@/lib/orders-list';
import { carriedStopText, dayNothingLeftText, holdsOnlyGone, orderListTotals, replanWork } from '@/lib/dispatch/carry-view';
import { cancelledLineNote, customerKey, lineDupKey, resolveOrderLines } from '@/lib/dispatch/order-intake';
import { orderActionBlockedText } from '@/app/t/[slug]/dispatch/delivery-times';
import { UP_TO_DATE } from '@/lib/dispatch/day-overview';
import { AUDIT_ACTIONS } from '@/lib/audit-catalog';

const state = (over: Partial<OrderStateNow> = {}): OrderStateNow => ({
  status: 'VALIDATED',
  cancelled: false,
  carriedTo: null,
  placements: [],
  planStatus: null,
  date: '2026-10-13',
  ...over,
});

describe('which orders can be cancelled or postponed (judged on the latest plan version)', () => {
  it('not planned, only unserved, or on a PLANNED load: allowed', () => {
    expect(orderActionRefusal('CANCEL', state())).toBeNull();
    expect(orderActionRefusal('CANCEL', state({ status: 'UNSERVED', planStatus: 'READY' }))).toBeNull();
    expect(orderActionRefusal('POSTPONE', state({ status: 'ASSIGNED', planStatus: 'READY', placements: [{ truckCode: 'T05', loadNo: 2, status: 'PLANNED' }] }))).toBeNull();
  });

  it('a locked or loading load: refused, naming the truck and load, unlock first (a loading load goes Back to locked first)', () => {
    for (const status of ['LOCKED', 'LOADING']) {
      const r = orderActionRefusal('CANCEL', state({ placements: [{ truckCode: 'T05', loadNo: 2, status }], planStatus: 'READY' }));
      expect(r).toMatchObject({ status: 409, code: 'ORDER_ON_LOCKED_LOAD' });
      expect(r!.text).toContain('T05 load 2');
      expect(r!.text).toContain('unlock the load first (a loading load goes Back to locked first), then cancel');
    }
    expect(orderActionRefusal('POSTPONE', state({ placements: [{ truckCode: 'T01', loadNo: 1, status: 'LOCKED' }] }))!.text).toContain('then postpone');
  });

  it('a load that left, or an order DISPATCHED / DELIVERED: refused, the driver records the result', () => {
    for (const s of [
      state({ placements: [{ truckCode: 'T01', loadNo: 1, status: 'DISPATCHED' }] }),
      state({ placements: [{ truckCode: 'T01', loadNo: 1, status: 'COMPLETED' }, { truckCode: 'T02', loadNo: 1, status: 'PLANNED' }] }),
      state({ status: 'DISPATCHED' }),
      state({ status: 'DELIVERED' }),
    ]) {
      const r = orderActionRefusal('CANCEL', s);
      expect(r).toMatchObject({ status: 409, code: 'ORDER_LEFT' });
      expect(r!.text).toMatch(/driver records the result/);
    }
  });

  it('the day being optimized: refused, try again when it finishes; a moved order: do it on that day', () => {
    expect(orderActionRefusal('CANCEL', state({ planStatus: 'OPTIMIZING' }))).toMatchObject({ code: 'PLAN_OPTIMIZING' });
    expect(orderActionRefusal('CANCEL', state({ planStatus: 'OPTIMIZING' }))!.text).toContain('try again when it finishes');
    const moved = orderActionRefusal('CANCEL', state({ carriedTo: '2026-10-15' }));
    expect(moved).toMatchObject({ code: 'ORDER_CARRIED' });
    expect(moved!.text).toContain('15 Oct');
  });

  it('a cancelled order is postponed only after Undo; left beats locked beats optimizing', () => {
    expect(orderActionRefusal('POSTPONE', state({ cancelled: true }))).toMatchObject({ code: 'ORDER_CANCELLED' });
    expect(
      orderActionRefusal('CANCEL', state({ planStatus: 'OPTIMIZING', placements: [{ truckCode: 'T1', loadNo: 1, status: 'LOCKED' }, { truckCode: 'T1', loadNo: 2, status: 'DISPATCHED' }] })),
    ).toMatchObject({ code: 'ORDER_LEFT' });
    expect(orderActionRefusal('CANCEL', state({ planStatus: 'OPTIMIZING', placements: [{ truckCode: 'T1', loadNo: 1, status: 'LOADING' }] }))).toMatchObject({ code: 'ORDER_ON_LOCKED_LOAD' });
  });

  it('the PLANNED loads still holding the order, each once', () => {
    expect(
      plannedLoadsOf([
        { truckCode: 'T05', loadNo: 2, status: 'PLANNED' },
        { truckCode: 'T05', loadNo: 2, status: 'PLANNED' },
        { truckCode: 'T01', loadNo: 1, status: 'LOCKED' },
      ]),
    ).toEqual(['T05 L2']);
  });
});

describe('reasons and notes', () => {
  it('a reason of the list; Other needs a note; a note is at most 200 characters', () => {
    expect(checkOrderActionReason('CANCEL', 'CUSTOMER_CANCELLED', '  ')).toEqual({ ok: true, reason: 'CUSTOMER_CANCELLED', note: null });
    expect(checkOrderActionReason('CANCEL', 'OTHER', '')).toMatchObject({ ok: false, error: 'Other needs a note: say why.' });
    expect(checkOrderActionReason('CANCEL', 'OTHER', 'shop closed')).toEqual({ ok: true, reason: 'OTHER', note: 'shop closed' });
    expect(checkOrderActionReason('CANCEL', 'OTHER', 'x'.repeat(201))).toMatchObject({ ok: false });
    // "Postponed by sales" is a postpone reason only.
    expect(checkOrderActionReason('CANCEL', 'POSTPONED_BY_SALES', null)).toMatchObject({ ok: false });
    expect(checkOrderActionReason('POSTPONE', 'POSTPONED_BY_SALES', null)).toMatchObject({ ok: true });
    expect(checkOrderActionReason('POSTPONE', undefined, null)).toMatchObject({ ok: false });
  });

  it('the words of a reason', () => {
    expect(orderActionReasonText('NO_ACCESS_SMALL_TRUCK', null)).toBe('Truck cannot reach the customer (small truck only)');
    expect(orderActionReasonText('OTHER', 'shop closed')).toBe('Other: shop closed');
    expect(orderActionReasonText('WRONG_OR_DUPLICATE')).toBe('Wrong or duplicate order');
    expect(postponeLateReason('2026-10-13', 'POSTPONED_BY_SALES', null)).toBe('Postponed from 13 Oct: Postponed by sales/customer.');
  });
});

describe('dates', () => {
  it('postpone: after the order day, at most 14 days later, never before today', () => {
    expect(postponeRange('2026-10-13', '2026-10-13')).toEqual({ from: '2026-10-14', to: '2026-10-27' });
    expect(postponeRange('2026-10-20', '2026-10-13')).toEqual({ from: '2026-10-21', to: '2026-11-03' });
    expect(postponeDateRefusal('2026-10-13', '2026-10-14', '2026-10-13')).toBeNull();
    expect(postponeDateRefusal('2026-10-13', '2026-10-27', '2026-10-13')).toBeNull();
    expect(postponeDateRefusal('2026-10-13', '2026-10-28', '2026-10-13')).toMatchObject({ code: 'POSTPONE_DATE' });
    expect(postponeDateRefusal('2026-10-13', '2026-10-13', '2026-10-13')).toMatchObject({ code: 'POSTPONE_DATE' });
    expect(postponeDateRefusal('2026-10-15', '2026-10-14', '2026-10-13')).toMatchObject({ code: 'POSTPONE_DATE' });
  });

  it("an order of a day that is over is not postponed (Bring forward does it)", () => {
    const r = postponeDateRefusal('2026-10-12', '2026-10-14', '2026-10-13');
    expect(r).toMatchObject({ code: 'ORDER_DAY_OVER' });
    expect(r!.text).toContain('Bring forward');
  });

  it('undo cancel while the day is not over', () => {
    expect(undoCancelDayOver('2026-10-13', '2026-10-13')).toBeNull();
    expect(undoCancelDayOver('2026-10-14', '2026-10-13')).toBeNull();
    expect(undoCancelDayOver('2026-10-12', '2026-10-13')).toMatch(/is over/);
  });
});

describe('the words on screen', () => {
  it('invoices: every one, and lines without an invoice no.', () => {
    expect(invoicesText(['4711', '4712'])).toBe('SO 4711, 4712');
    expect(invoicesText([], 2)).toBe('2 line(s) with no invoice no.');
    expect(invoicesText([])).toBe('no invoice no.');
    expect(invoicesText(['4711'], 1)).toBe('SO 4711 and 1 line(s) with no invoice no.');
    expect(severalInvoicesNote(['1'], 'CANCEL')).toBeNull();
    expect(severalInvoicesNote(['1', '2'], 'CANCEL')).toMatch(/cancels all 2 invoices of this order together.*later step/);
  });

  it('after a cancel: RE-PLAN when a planned load still holds it, nothing to do otherwise', () => {
    expect(cancelDoneText({ customer: 'Shop A (C1)', invoices: 'SO 1', cases: 12, onPlannedLoads: ['T05 L2'], unserved: false, planned: true })).toBe(
      'Order of Shop A (C1) (SO 1; 12 cases) cancelled. It is still on T05 L2 (planned): RE-PLAN the day to take it off. Until then that load cannot be locked, loaded or dispatched.',
    );
    expect(cancelDoneText({ customer: 'A', invoices: 'SO 1', cases: 1, onPlannedLoads: [], unserved: false, planned: false })).toMatch(/It was not planned yet: nothing else to do\.$/);
    expect(cancelDoneText({ customer: 'A', invoices: 'SO 1', cases: 1, onPlannedLoads: [], unserved: true, planned: true })).toMatch(/unserved list: nothing else to do/);
  });

  it('after an undo and a postpone', () => {
    expect(undoCancelDoneText({ customer: 'A', cases: 1, onPlannedLoads: [], unserved: false, planInUse: true })).toMatch(/RE-PLAN adds it/);
    expect(undoCancelDoneText({ customer: 'A', cases: 1, onPlannedLoads: [], unserved: false, planInUse: false })).toMatch(/OPTIMIZE plans it/);
    expect(undoCancelDoneText({ customer: 'A', cases: 1, onPlannedLoads: ['T1 L1'], unserved: false, planInUse: true })).toMatch(/still on T1 L1 as planned/);
    const p = postponeDoneText({ customer: 'A', cases: 5, fromDate: '2026-10-13', toDate: '2026-10-15', onPlannedLoads: ['T1 L1'], toHasPlan: true, toOptimizing: false });
    expect(p).toContain('postponed from 13 Oct to 15 Oct');
    expect(p).toContain('RE-PLAN 13 Oct to take it off');
    expect(p).toContain('RE-PLAN 15 Oct to add it');
    expect(p).toContain('Undo: on 15 Oct');
  });

  it("the 409 ORDERS_CANCELLED words: re-plan the day; a load holding nothing else is left for the record", () => {
    expect(cancelledLoadText('T05 L2', ['C1'], false)).toBe(
      'T05 L2 holds 1 cancelled order(s): C1. It must not be loaded with them, so it cannot be locked, loaded or dispatched. Re-plan the day: the cancelled order is taken off.',
    );
    expect(cancelledLoadText('T05 L2', ['C1'], true)).toMatch(/holds nothing else: leave it as it is/);
  });

  it('the day list offers no Cancel / Postpone for an order on a locked load or one that left', () => {
    expect(orderActionBlockedText({ frozen: false, left: false })).toBeNull();
    expect(orderActionBlockedText({ frozen: true, left: false, loads: ['T05 L2 (locked)'] })).toBe('on a locked load (T05 L2 (locked)): unlock it first to change, cancel or postpone it');
    expect(orderActionBlockedText({ frozen: true, left: true })).toMatch(/driver records the result/);
  });
});

describe('a cancelled order is left out everywhere it is planned, counted or offered', () => {
  it('the plan scope (every optimize, re-plan, day overview, pending and late-order read) leaves cancelled orders out', async () => {
    const day = new Date('2026-10-13T00:00:00Z');
    expect(NOT_CANCELLED).toEqual({ cancelledAt: null });
    expect(await ordersInScopeWhere('t1', 'd1', day)).toEqual({ tenantId: 't1', deliveryDate: day, carriedToOrderId: null, cancelledAt: null, depotId: 'd1' });
  });

  it('the order list: open statuses leave them out, status=CANCELLED lists them, totals do not count them', () => {
    expect(orderStatusFilter('CANCELLED')).toEqual({ cancelledAt: { not: null } });
    expect(orderStatusFilter('VALIDATED')).toEqual({ status: 'VALIDATED', carriedToOrderId: null, cancelledAt: null });
    expect(orderStatusFilter('DELIVERED')).toEqual({ status: 'DELIVERED' });
    expect(
      orderListTotals([
        { totalCases: 10, totalWeightKg: 100 },
        { totalCases: 5, totalWeightKg: 50, cancelledAt: new Date() },
        { totalCases: 7, totalWeightKg: 70, carriedTo: { deliveryDate: new Date() } },
      ]),
    ).toEqual({ cases: 10, kg: 100, carried: 1, cancelled: 1 });
  });

  it('a re-plan has no work in a PLANNED load holding only cancelled orders, nor in a cancelled unserved row', () => {
    const onlyCancelled = { status: 'PLANNED', carriedAway: 0, cancelledHere: 1, stops: [{ orderIds: ['O1'] }] };
    const mixed = { status: 'PLANNED', carriedAway: 0, cancelledHere: 1, stops: [{ orderIds: ['O1'] }, { orderIds: ['O2'] }] };
    const carriedAndCancelled = { status: 'PLANNED', carriedAway: 1, cancelledHere: 1, stops: [{ orderIds: ['O1', 'O2'] }] };
    expect(holdsOnlyGone(onlyCancelled)).toBe(true);
    expect(holdsOnlyGone(mixed)).toBe(false);
    expect(holdsOnlyGone(carriedAndCancelled)).toBe(true);
    expect(replanWork([onlyCancelled, mixed], [{ carriedTo: null, cancelled: true }, { carriedTo: null }])).toEqual({ loadStatuses: ['PLANNED'], unservedOrders: 1 });
  });

  it('the papers say CANCELLED on a stop holding a cancelled order (before any carried-over line)', () => {
    expect(carriedStopText({ carriedFrom: '2026-10-12', carriedTo: null, cancelled: true })).toBe('CANCELLED - do not load or deliver (re-plan the day)');
    expect(carriedStopText({ carriedFrom: null, carriedTo: null, cancelled: false })).toBeNull();
  });

  it('Step 3: a day whose open orders were all cancelled has nothing left to plan, and says why', () => {
    const text = dayNothingLeftText({ orders: 0, openOrders: 0, pending: 0, chosen: true, carriedOut: null, loadsByStatus: { PLANNED: 1 }, cancelled: 2 });
    expect(text).toMatch(/^Nothing left to plan: 2 order\(s\) of this day were cancelled\./);
    expect(text).not.toMatch(/left the depot|unlock/i);
    expect(dayNothingLeftText({ orders: 3, openOrders: 2, pending: 0, chosen: true, carriedOut: null, loadsByStatus: {}, cancelled: 1 })).toBeNull();
  });

  it('a plan with a cancelled order on a planned load is out of date (RE-PLAN on); the audit actions are in the catalog', () => {
    expect(UP_TO_DATE.cancelledOnPlan).toBe(0);
    for (const a of ['ORDER_CANCELLED', 'ORDER_CANCEL_UNDONE', 'ORDER_POSTPONED'] as const) expect(AUDIT_ACTIONS[a].label).toBeTruthy();
  });
});

describe('re-uploading a cancelled invoice for the same day', () => {
  it('stays skipped, and the message says it was cancelled, by whom, and how to undo', () => {
    expect(cancelledLineNote({ at: '2026-10-12', by: 'Salim' }, '2026-10-13')).toBe(
      'It was CANCELLED on 12 Oct by Salim, so it stays cancelled. To deliver it, open Daily dispatch for 13 Oct and press Undo in the Cancelled orders list (Step 1).',
    );
    const line = {
      row: 2, salesOrderNo: 'SO-1', orderDate: null, deliveryDate: '2026-10-13', customerCode: 'C1', branchCode: null, branchKey: '__MAIN__', customerName: null,
      productCode: 'P1', productDescription: null, cases: 10, weightKg: null, salesValue: null, margin: null, priority: null, notes: null, depotCode: null, customerType: null,
    };
    const norm = { lines: [line], errors: [], warnings: [] };
    const customers = [{ id: 'c1', code: 'C1', branchKey: '__MAIN__', name: 'Shop', active: true, lat: 23.6, lng: 58.4 }];
    const products = [{ id: 'p1', code: 'P1', name: 'Water', active: true, weightPerCaseKg: 12 }];
    const key = lineDupKey('2026-10-13', 'SO-1', customerKey('C1', '__MAIN__'), 'P1');
    const res = resolveOrderLines(norm as never, customers, products, new Map([[key, [10]]]), { cancelledLines: new Map([[key, { at: '2026-10-12', by: 'Salim' }]]) });
    expect(res.lines).toEqual([]);
    expect(res.duplicates.map((d) => d.message)).toEqual([
      'Already confirmed: sales order SO-1, P1 for C1 on 2026-10-13. Skipped. It was CANCELLED on 12 Oct by Salim, so it stays cancelled. To deliver it, open Daily dispatch for 13 Oct and press Undo in the Cancelled orders list (Step 1).',
    ]);
    // A line of an order that is not cancelled keeps the plain message.
    const plain = resolveOrderLines(norm as never, customers, products, new Map([[key, [10]]]));
    expect(plain.duplicates.map((d) => d.message)).toEqual(['Already confirmed: sales order SO-1, P1 for C1 on 2026-10-13. Skipped.']);
  });
});
