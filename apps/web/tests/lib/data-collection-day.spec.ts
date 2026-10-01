/**
 * The day screen (getDayOverview) and a split customer with a part on a locked load (data collection,
 * third review). A split customer stores every order of every part as a portion, so the screen must
 * read "on a locked load" by cases, as the planner does:
 *
 *  - an order whose every case is on a load locked before the re-plan is not in the re-planned stop
 *    (buildDispatchRequest leaves it out), so its delivery time is no "change after planning" there:
 *    step 3 does not ask for a RE-PLAN that would build the same stop again;
 *  - an order only partly on a locked load still has a part on a PLANNED load, which the loading rule
 *    judges at LOCK: its customer stays in the "Loading rule is on" box (Set time stays hidden for it).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface State {
  orders: unknown[];
  assignments: unknown[];
  unserved: unknown[];
}
const state: State = { orders: [], assignments: [], unserved: [] };

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findUnique: async () => ({ country: 'OM' }) },
    order: { findMany: async () => state.orders },
    routeAssignment: { findMany: async () => state.assignments },
    scenarioResult: {
      findUnique: async () => ({ id: 'sc1', detailsJson: { scope: { orderIds: ['O1', 'O2'], frozenOrderIds: [] } }, unservedOrders: state.unserved }),
    },
    planLoad: { findMany: async () => [] },
  },
}));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    tenantConfig: {
      findUniqueOrThrow: async () => ({ timezone: 'Asia/Muscat', planningCutoffMin: 1080, serviceAreaJson: null, defaultServiceTimeMin: 10, requireDataBeforeLoading: true, dataCollectDays: 3 }),
    },
    depot: { findMany: async () => [{ id: 'D1', code: 'D1', name: 'Depot', lat: 23.6, lng: 58.4 }] },
    customerTypeProfile: { findMany: async () => [] },
    runJob: { findFirst: async () => null },
    planLoad: { groupBy: async () => [] },
    truck: { findMany: async () => [{ capacityCases: 600 }] },
    uploadBatch: { findMany: async () => [] },
  }),
}));
vi.mock('@/lib/dispatch/plan-service', () => ({
  currentPlan: async () => ({ id: 'run1', version: 2, status: 'READY', reason: 'REOPTIMIZE', chosenScenarioId: 'sc1', summaryJson: null, reconciliationJson: null }),
  ordersInScopeWhere: async () => ({}),
}));

import { getDayOverview } from '@/lib/dispatch/day-overview';

// No confirmed hours, no customer type: no delivery window of its own.
const customer = {
  id: 'C1', code: 'C1', branchCode: null, name: 'Hyper', address: 'x', customerType: null, priority: 2, priorityConfirmed: true, avgServiceTimeMin: 10,
  serviceTimeConfirmed: true, active: true, lat: 23.6, lng: 58.4, locationVerified: true, geocodeConfidence: 'HIGH', createdFromUpload: false, accessNotes: null,
  hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, windowConfirmedAt: null, windowConfirmedBy: null,
};

function order(id: string, cases: number, time: { startMin: number; endMin: number } | null = null) {
  return {
    id, status: 'ASSIGNED', totalCases: cases, totalWeightKg: cases * 10, isLate: false, customerId: 'C1', customer, carriedFromOrderId: null,
    deliveryStartMin: time?.startMin ?? null, deliveryEndMin: time?.endMin ?? null, deliveryTimeReason: time ? 'PROMISED' : null, deliveryTimeNote: null,
    lines: [{ id: `${id}-l1`, cases, weightKg: cases * 10, weightFromMaster: false, salesOrderNo: `SO-${id}`, product: { code: 'P1', name: 'Water', weightPerCaseKg: 10 } }],
  };
}

/** The stop as the plan that made it kept it (no hours: the customer has none; `promised` when it had a time). */
const snapshot = (capturedAt: string, promised: { startMin: number; endMin: number } | null = null) => ({
  v: 1, customerId: 'C1', code: 'C1', branchCode: null, name: 'Hyper', customerType: null, address: 'x', accessNotes: null, lat: 23.6, lng: 58.4,
  hardStartMin: promised?.startMin ?? null, hardEndMin: promised?.endMin ?? null, prefStartMin: null, prefEndMin: null, serviceMin: 10, priority: 2,
  source: 'PLAN', capturedAt, ...(promised ? { promised: { ...promised, reason: 'PROMISED', note: null } } : {}),
});

/** A part of order `orderId` (its only line) of `cases` on a load with `status`. */
function part(orderId: string, status: string, cases: number, snap: unknown) {
  return { orderId, portionLinesJson: [{ lineId: `${orderId}-l1`, cases, kgPerCase: 10 }], portionWeightKg: cases * 10, stopSnapshotJson: snap, load: { status } };
}

const EARLIER = '2026-09-26T18:00:00.000Z';
const REPLAN = '2026-09-26T20:00:00.000Z';

async function day() {
  const d = await getDayOverview('tA', { date: '2026-09-27', depotId: 'D1' });
  if (!('loadingGaps' in d)) throw new Error('the depot was not found');
  return d;
}

beforeEach(() => {
  state.unserved = [];
});

describe('day screen: a split customer whose part 1 was locked before the re-plan', () => {
  it('the order wholly on the locked part is not a "change after planning" of the re-planned part: no RE-PLAN asked', async () => {
    state.orders = [order('O1', 10, { startMin: 600, endMin: 660 }), order('O2', 10)];
    state.assignments = [part('O1', 'LOCKED', 10, snapshot(EARLIER, { startMin: 600, endMin: 660 })), part('O2', 'PLANNED', 10, snapshot(REPLAN))];
    const d = await day();
    expect(d.outdated.masterChanged).toBe(0);
    // Control: a case of O1 still open was planned with part 2, with O1's time; the stop without it is out of date.
    state.assignments = [part('O1', 'LOCKED', 6, snapshot(EARLIER, { startMin: 600, endMin: 660 })), part('O2', 'PLANNED', 10, snapshot(REPLAN))];
    expect((await day()).outdated.masterChanged).toBe(1);
  });

  it('an order the plan left out whole as heavier than any truck does not make the stop out of date', async () => {
    state.orders = [order('O1', 10, { startMin: 480, endMin: 540 }), order('O2', 10)];
    state.assignments = [part('O2', 'PLANNED', 10, snapshot(REPLAN))];
    state.unserved = [{ orderId: 'O1', reasonCode: 'EXCEEDS_ANY_TRUCK_CAPACITY', portionLinesJson: null }];
    expect((await day()).outdated.masterChanged).toBe(0);
    state.unserved = [{ orderId: 'O1', reasonCode: 'NO_AVAILABLE_TRUCK', portionLinesJson: null }];
    expect((await day()).outdated.masterChanged).toBe(1);
  });

  it('"Loading rule is on": an order only partly on a locked load keeps its customer in the box (LOCK of its planned part refuses it)', async () => {
    state.orders = [order('O1', 20)];
    state.assignments = [part('O1', 'LOCKED', 10, snapshot(EARLIER)), part('O1', 'PLANNED', 10, snapshot(EARLIER))];
    const d = await day();
    expect(d.loadingGaps).toMatchObject([{ customerId: 'C1', window: true, location: false }]);
    // Its time cannot be set here (a part is on a locked load).
    expect(d.customers[0]!.orderTimes).toMatchObject([{ orderId: 'O1', frozen: true, allFrozen: false }]);
    // Every case on locked loads: the rule never judges it again, not listed.
    state.assignments = [part('O1', 'LOCKED', 10, snapshot(EARLIER)), part('O1', 'LOADING', 10, snapshot(EARLIER))];
    const all = await day();
    expect(all.loadingGaps).toEqual([]);
    expect(all.customers[0]!.orderTimes).toMatchObject([{ orderId: 'O1', frozen: true, allFrozen: true }]);
  });
});
