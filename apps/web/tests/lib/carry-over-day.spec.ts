/**
 * PR9 "Bring forward" on the day screen (getDayOverview, mocked database):
 * - an order brought forward from an earlier day is listed with the date it was first due (badge
 *   "Carried over from 26 Sep") and counted as pending (waiting like a late order) until a plan
 *   contains it;
 * - orders of this day brought forward to later days are no longer the day's orders (their own
 *   query leaves them out) and are summed apart: how many, their cases, and the days they went to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { orders: [] as unknown[], away: [] as unknown[], scope: [] as string[], chosen: true as boolean, orderWheres: [] as unknown[] };

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findUnique: async () => ({ country: 'OM' }) },
    order: {
      findMany: async (a: { where: { carriedToOrderId?: unknown } }) => {
        state.orderWheres.push(a.where);
        return a.where.carriedToOrderId && typeof a.where.carriedToOrderId === 'object' ? state.away : state.orders;
      },
    },
    routeAssignment: { findMany: async () => [] },
    scenarioResult: { findUnique: async () => ({ id: 'sc1', detailsJson: { scope: { orderIds: state.scope, frozenOrderIds: [] } } }) },
    planLoad: { findMany: async () => [] },
  },
}));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    tenantConfig: { findUniqueOrThrow: async () => ({ timezone: 'Asia/Muscat', planningCutoffMin: 1080, serviceAreaJson: null, defaultServiceTimeMin: 10 }) },
    depot: { findMany: async () => [{ id: 'D1', code: 'D1', name: 'Depot', lat: 23.6, lng: 58.4 }] },
    customerTypeProfile: { findMany: async () => [] },
    runJob: { findFirst: async () => null },
    planLoad: { groupBy: async () => [] },
    truck: { findMany: async () => [{ capacityCases: 600 }] },
    uploadBatch: { findMany: async () => [] },
  }),
}));
vi.mock('@/lib/dispatch/plan-service', () => ({
  currentPlan: async () =>
    state.chosen ? { id: 'run1', version: 1, status: 'READY', reason: 'INITIAL', chosenScenarioId: 'sc1', summaryJson: null, reconciliationJson: null } : null,
  ordersInScopeWhere: async () => ({ tenantId: 't', carriedToOrderId: null }),
}));

import { getDayOverview } from '@/lib/dispatch/day-overview';

const customer = (code: string) => ({
  id: code, code, branchCode: null, name: `Shop ${code}`, address: 'x', customerType: null, priority: 3, priorityConfirmed: true, avgServiceTimeMin: 10,
  serviceTimeConfirmed: true, active: true, lat: 23.6, lng: 58.4, locationVerified: true, createdFromUpload: false, accessNotes: null,
  hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null,
});
function order(id: string, code: string, cases: number, over: Record<string, unknown> = {}) {
  return {
    id, status: 'VALIDATED', totalCases: cases, totalWeightKg: cases * 10, isLate: false, customerId: code, customer: customer(code),
    deliveryDate: new Date('2026-09-28T00:00:00Z'), carriedFromOrderId: null, carriedFromDate: null,
    lines: [{ id: `${id}-l`, cases, weightKg: cases * 10, weightFromMaster: false, product: { code: 'P1', name: 'Water', weightPerCaseKg: 10 } }],
    ...over,
  };
}

beforeEach(() => {
  state.orders = [];
  state.away = [];
  state.scope = [];
  state.chosen = true;
  state.orderWheres = [];
});

describe('the day screen marks orders brought forward (PR9)', () => {
  it('lists the orders brought forward to this day with the date first due; they wait like late orders until re-planned', async () => {
    state.orders = [
      order('IN', 'C1', 40),
      order('COPY', 'C2', 25, { isLate: true, carriedFromOrderId: 'ORIG', carriedFromDate: new Date('2026-09-26T00:00:00Z') }),
    ];
    state.scope = ['IN'];
    const day = await getDayOverview('t', { date: '2026-09-28', depotId: 'D1' });
    expect(day.carriedIn).toEqual([{ orderId: 'COPY', customerCode: 'C2', branchCode: null, customerName: 'Shop C2', cases: 25, fromDate: '2026-09-26', pending: true }]);
    expect(day.pending).toMatchObject({ count: 1, cases: 25, late: 1, carried: 1 });
    expect(day.orders.count).toBe(2);
  });

  it('once the plan contains it, it is still marked, and no longer pending', async () => {
    state.orders = [order('COPY', 'C2', 25, { carriedFromOrderId: 'ORIG', carriedFromDate: new Date('2026-09-26T00:00:00Z') })];
    state.scope = ['COPY'];
    const day = await getDayOverview('t', { date: '2026-09-28', depotId: 'D1' });
    expect(day.carriedIn?.[0]).toMatchObject({ orderId: 'COPY', pending: false });
    expect(day.pending).toMatchObject({ count: 0, carried: 0 });
  });

  it('orders of this day brought forward to later days are summed apart (the day\'s own query leaves them out)', async () => {
    state.orders = [order('STAY', 'C1', 40)];
    state.scope = ['STAY'];
    state.away = [
      { carriedTo: { deliveryDate: new Date('2026-09-29T00:00:00Z'), totalCases: 30 } },
      { carriedTo: { deliveryDate: new Date('2026-09-29T00:00:00Z'), totalCases: 12 } },
    ];
    const day = await getDayOverview('t', { date: '2026-09-28', depotId: 'D1' });
    expect(day.carriedOut).toEqual({ orders: 2, cases: 42, toDates: ['2026-09-29'] });
    expect(day.orders.count).toBe(1);
    expect(day.openOrders).toBe(1);
    // The day's orders come from ordersInScopeWhere (carriedToOrderId: null); the carried ones from their own query.
    expect(state.orderWheres[0]).toMatchObject({ carriedToOrderId: null });
    expect(state.orderWheres.some((w) => JSON.stringify(w).includes('"carriedToOrderId":{"not":null}'))).toBe(true);
  });

  it('nothing carried: no list and no note', async () => {
    state.orders = [order('A', 'C1', 10)];
    state.scope = ['A'];
    const day = await getDayOverview('t', { date: '2026-09-28', depotId: 'D1' });
    expect(day.carriedIn).toEqual([]);
    expect(day.carriedOut).toBeNull();
  });
});
