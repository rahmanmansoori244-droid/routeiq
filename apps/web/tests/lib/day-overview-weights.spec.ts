/**
 * The day overview's case weights for a split order partly on a frozen load (stabilization PR4
 * review). The open rest of such an order is planned with the product's case weight at every
 * optimize but never saved on its line (the frozen part shares it), so the day overview reads the
 * case weight the PLANNED parts of the plan in use carry (portionPlannedKgPerCase, the same rule
 * as the timetable check). A weight entered or corrected since makes the plan out of date (RE-PLAN
 * on, "applied at the next OPTIMIZE or RE-PLAN"), exactly when the check blocks the PLANNED load it
 * now overloads (CAPACITY_KG_NEW_WEIGHT) - the day screen no longer says "up to date" meanwhile.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface State {
  orders: unknown[];
  assignments: unknown[];
  scope: string[];
}
const state: State = { orders: [], assignments: [], scope: [] };

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findUnique: async () => ({ country: 'OM' }) },
    order: { findMany: async () => state.orders },
    routeAssignment: { findMany: async () => state.assignments },
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
  currentPlan: async () => ({ id: 'run1', version: 2, status: 'READY', reason: 'INITIAL', chosenScenarioId: 'sc1', summaryJson: null, reconciliationJson: null }),
  ordersInScopeWhere: async () => ({}),
}));

import { getDayOverview, UP_TO_DATE } from '@/lib/dispatch/day-overview';

const customer = {
  id: 'C1', code: 'C1', branchCode: null, name: 'Hyper', address: 'x', customerType: null, priority: 2, priorityConfirmed: true, avgServiceTimeMin: 10,
  serviceTimeConfirmed: true, active: true, lat: 23.6, lng: 58.4, locationVerified: true, createdFromUpload: false, accessNotes: null,
  hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null,
};

/** Order O1: one line of 1000 cases of P1, weighed from the master (`lineKg`), the product at `productKg` per case now. */
function order(productKg: number, lineKg = 0) {
  return {
    id: 'O1', status: 'ASSIGNED', totalCases: 1000, totalWeightKg: lineKg, isLate: false, customerId: 'C1', customer,
    lines: [{ id: 'ln1', cases: 1000, weightKg: lineKg, weightFromMaster: true, product: { code: 'P1', name: 'Water', weightPerCaseKg: productKg } }],
  };
}

/** A stop row of O1 on a load with `status`: a split part of `cases` (planned at `kgPerCase`; undefined = before it was kept). */
function part(status: string, cases: number, kgPerCase: number | undefined, portionWeightKg: number) {
  return {
    orderId: 'O1',
    portionLinesJson: [kgPerCase === undefined ? { lineId: 'ln1', cases } : { lineId: 'ln1', cases, kgPerCase }],
    portionWeightKg,
    stopSnapshotJson: null,
    load: { status },
  };
}

async function day() {
  return getDayOverview('tA', { date: '2026-09-27', depotId: 'D1' });
}

beforeEach(() => {
  state.scope = ['O1'];
});

describe('day overview: case weights of a split order partly on a frozen load (PR4 review)', () => {
  it('a weight entered after planning: the open rest planned at 0 kg makes the plan out of date', async () => {
    state.orders = [order(10)];
    state.assignments = [part('LOCKED', 100, 0, 0), part('PLANNED', 900, 0, 0)];
    const d = await day();
    expect(d.outdated).toEqual({ ...UP_TO_DATE, weightCases: 900 });
    expect(d.weightsToApply).toEqual([{ code: 'P1', name: 'Water', lines: 1, cases: 900, kgPerCase: 10 }]);
    expect(d.productsWithoutWeight).toEqual([]);
  });

  it('the same order whole on a PLANNED load reads the same (the control)', async () => {
    state.orders = [order(10)];
    state.assignments = [{ orderId: 'O1', portionLinesJson: null, portionWeightKg: null, stopSnapshotJson: null, load: { status: 'PLANNED' } }];
    const d = await day();
    expect(d.outdated.weightCases).toBe(1000);
  });

  it('once re-planned with the weight (the PLANNED part carries 10 kg per case) the plan is up to date again', async () => {
    state.orders = [order(10)];
    state.assignments = [part('LOCKED', 100, 0, 0), part('PLANNED', 900, 10, 9000)];
    const d = await day();
    expect(d.outdated.weightCases).toBe(0);
    expect(d.weightsToApply).toEqual([]);
  });

  it('a case weight corrected since (1500 -> 1.5 kg) is out of date the same way', async () => {
    state.orders = [order(1.5, 1_500_000)];
    state.assignments = [part('LOCKED', 100, 1500, 150_000), part('PLANNED', 900, 1500, 1_350_000)];
    const d = await day();
    expect(d.outdated.weightCases).toBe(900);
    expect(d.weightsToApply).toEqual([{ code: 'P1', name: 'Water', lines: 1, cases: 900, kgPerCase: 1.5 }]);
  });

  it('a part stored before kgPerCase was kept: out of date when its own kg shows it was planned at 0 kg', async () => {
    state.orders = [order(10)];
    state.assignments = [part('LOCKED', 100, undefined, 0), part('PLANNED', 900, undefined, 0)];
    expect((await day()).outdated.weightCases).toBe(900);
    // Planned with the weight then (its kg shows it): nothing to re-plan.
    state.assignments = [part('LOCKED', 100, undefined, 0), part('PLANNED', 900, undefined, 9000)];
    expect((await day()).outdated.weightCases).toBe(0);
  });

  it('`outdated` has exactly the keys of UP_TO_DATE on every path (the integration specs compare against it)', async () => {
    expect(UP_TO_DATE).toEqual({ weightCases: 0, inactiveOrders: 0, masterChanged: 0, trucksChanged: 0 });
    state.orders = [order(10)];
    state.assignments = [part('PLANNED', 1000, 0, 0)];
    expect(Object.keys((await day()).outdated).sort()).toEqual(Object.keys(UP_TO_DATE).sort());
    state.orders = [];
    state.assignments = [];
    expect((await day()).outdated).toEqual(UP_TO_DATE);
  });

  it('before any weight is entered, the open rest is listed as having no weight (unchanged)', async () => {
    state.orders = [order(0)];
    state.assignments = [part('LOCKED', 100, 0, 0), part('PLANNED', 900, 0, 0)];
    const d = await day();
    expect(d.outdated.weightCases).toBe(0);
    expect(d.productsWithoutWeight).toEqual([{ code: 'P1', name: 'Water', lines: 1, cases: 900, kgPerCase: 0 }]);
  });
});
