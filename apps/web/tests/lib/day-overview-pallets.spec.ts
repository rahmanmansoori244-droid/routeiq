/**
 * The day overview with trucks that have bays (truck capacity in pallets, review of parts A and B):
 * - a cases per pallet corrected under Products after planning makes the plan out of date
 *   (`outdated.palletFactorCases`: the cases on PLANNED loads planned by pallets whose rows now give
 *   other pallets), so RE-PLAN is offered; before, only a grey manifest line said so, and the
 *   dispatcher saw the plan as ready;
 * - the red "OPTIMIZE is refused" list of products without cases per pallet names only the lines
 *   OPTIMIZE refuses for: buildDispatchRequest leaves out deactivated customers, customers without a
 *   usable location and cases heavier than any truck before it looks for factors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface State {
  plan: boolean;
  orders: unknown[];
  assignments: unknown[];
  trucks: unknown[];
  inputs?: unknown;
}
const state: State = { plan: true, orders: [], assignments: [], trucks: [] };

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findUnique: async () => ({ country: 'OM' }) },
    order: { findMany: async (a: { where: { carriedToOrderId?: unknown } }) => (a.where.carriedToOrderId && typeof a.where.carriedToOrderId === 'object' ? [] : state.orders) },
    routeAssignment: { findMany: async () => state.assignments },
    scenarioResult: {
      findUnique: async () => ({ id: 'sc1', unservedOrders: [], detailsJson: { scope: { orderIds: ['O1'], frozenOrderIds: [] }, ...(state.inputs ? { inputs: state.inputs } : {}) } }),
    },
    planLoad: { findMany: async () => [] },
  },
}));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    tenantConfig: {
      findUniqueOrThrow: async () => ({ timezone: 'Asia/Muscat', planningCutoffMin: 1080, serviceAreaJson: null, defaultServiceTimeMin: 10, maxTripsPerTruck: 3, palletFillPct: 95 }),
    },
    depot: { findMany: async () => [{ id: 'D1', code: 'D1', name: 'Depot', lat: 23.6, lng: 58.4 }] },
    customerTypeProfile: { findMany: async () => [] },
    runJob: { findFirst: async () => null },
    planLoad: { groupBy: async () => [] },
    truck: { findMany: async () => state.trucks },
    uploadBatch: { findMany: async () => [] },
  }),
}));
vi.mock('@/lib/dispatch/plan-service', () => ({
  currentPlan: async () => (state.plan ? { id: 'run1', version: 2, status: 'READY', reason: 'INITIAL', chosenScenarioId: 'sc1', summaryJson: null, reconciliationJson: null } : null),
  ordersInScopeWhere: async () => ({ tenantId: 't', carriedToOrderId: null }),
}));

import { getDayOverview, UP_TO_DATE } from '@/lib/dispatch/day-overview';

const BAY_TRUCK = { code: 'R1', capacityCases: 1140, capacityWeightKg: 10_000, maxTripsPerDay: null, bays: 12 };

const customer = (id: string, over: Record<string, unknown> = {}) => ({
  id, code: id, branchCode: null, name: `Shop ${id}`, address: 'x', customerType: null, priority: 2, priorityConfirmed: true, avgServiceTimeMin: 10,
  serviceTimeConfirmed: true, active: true, lat: 23.6, lng: 58.4, locationVerified: true, geocodeConfidence: 'HIGH', createdFromUpload: false, accessNotes: null,
  hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, windowConfirmedAt: null, windowConfirmedBy: null,
  ...over,
});

/** An order of `cases` of one product (known weight on the line unless `lineKg` says otherwise). */
function order(id: string, cust: ReturnType<typeof customer>, code: string, cases: number, product: { kg: number; cpp: number | null }, lineKg = cases * product.kg) {
  return {
    id, status: 'ASSIGNED', totalCases: cases, totalWeightKg: lineKg, isLate: false, customerId: cust.id, customer: cust, carriedFromOrderId: null,
    lines: [{ id: `${id}-l`, cases, weightKg: lineKg, weightFromMaster: lineKg === 0, salesOrderNo: null, product: { code, name: code, weightPerCaseKg: product.kg, casesPerPallet: product.cpp } }],
  };
}

/** O1's row on a load with `status`, planned with `units` (the load planned by pallets unless `byCases`). */
const row = (status: string, units: number | null, byCases = false, portionLinesJson: unknown = null) => ({
  orderId: 'O1', portionLinesJson, portionWeightKg: null, stopSnapshotJson: null, palletUnits: units, load: { status, palletUnits: byCases ? null : 11_355 },
});

async function day() {
  return getDayOverview('tA', { date: '2026-10-05', depotId: 'D1' });
}

beforeEach(() => {
  state.plan = true;
  state.orders = [];
  state.assignments = [];
  state.trucks = [BAY_TRUCK];
  state.inputs = { v: 1, depot: { id: 'D1', lat: 23.6, lng: 58.4 }, config: {}, stops: {}, trucks: {}, palletFactors: { 'JA0.5L': 96 } };
});

describe('day overview: a cases per pallet corrected after planning (pallets review)', () => {
  // The pilot's case: 1,090 cases of JA0.5L planned at 96 per pallet (11.355 pallets on 12 bays); the owner says 84.
  it('makes the plan out of date, so RE-PLAN is offered (before: "ready")', async () => {
    state.orders = [order('O1', customer('C1'), 'JA0.5L', 1090, { kg: 9.9, cpp: 84 })];
    state.assignments = [row('PLANNED', 11_355)];
    expect((await day()).outdated).toEqual({ ...UP_TO_DATE, palletFactorCases: 1090 });
  });

  it('a split part on a PLANNED load counts its own cases (the factor it was cut with)', async () => {
    state.orders = [order('O1', customer('C1'), 'JA0.5L', 1090, { kg: 9.9, cpp: 84 })];
    state.assignments = [row('PLANNED', 5_209, false, [{ lineId: 'O1-l', cases: 500, kgPerCase: 9.9, casesPerPallet: 96 }])];
    expect((await day()).outdated.palletFactorCases).toBe(500);
  });

  it('not counted: the figure planned with, a load planned by cases, a locked load (a re-plan keeps it)', async () => {
    state.orders = [order('O1', customer('C1'), 'JA0.5L', 1090, { kg: 9.9, cpp: 96 })];
    state.assignments = [row('PLANNED', 11_355)];
    expect((await day()).outdated).toEqual(UP_TO_DATE);
    state.orders = [order('O1', customer('C1'), 'JA0.5L', 1090, { kg: 9.9, cpp: 84 })];
    state.assignments = [row('PLANNED', 11_355, true)];
    expect((await day()).outdated).toEqual(UP_TO_DATE);
    state.assignments = [row('LOCKED', 11_355)];
    expect((await day()).outdated).toEqual(UP_TO_DATE);
  });
});

describe("day overview: the red list of products without cases per pallet names only what OPTIMIZE refuses for (pallets review)", () => {
  const NEW = { kg: 10, cpp: null };

  it('lists an open line of an active customer with a usable location', async () => {
    state.plan = false;
    state.orders = [order('O1', customer('C1'), 'NEW-1', 40, NEW)];
    expect((await day()).productsWithoutPalletFactor).toEqual([{ code: 'NEW-1', name: 'NEW-1', lines: 1, cases: 40 }]);
  });

  it('leaves out a customer without a pin, a deactivated customer and a case heavier than any truck (OPTIMIZE does not refuse for them)', async () => {
    state.plan = false;
    state.orders = [
      order('O2', customer('C2', { lat: null, lng: null, locationVerified: false, geocodeConfidence: null }), 'NEW-2', 20, NEW),
      order('O3', customer('C3', { active: false }), 'NEW-3', 30, NEW),
      // 20,000 kg per case: more than the 10,000 kg payload (a wrong case weight), left unserved before the factors.
      order('O4', customer('C4'), 'NEW-4', 5, { kg: 20_000, cpp: null }, 0),
    ];
    expect((await day()).productsWithoutPalletFactor).toEqual([]);
  });

  it('still nothing without trucks with bays', async () => {
    state.plan = false;
    state.trucks = [{ code: 'C1', capacityCases: 600, capacityWeightKg: 3000, maxTripsPerDay: null, bays: null }];
    state.orders = [order('O1', customer('C1'), 'NEW-1', 40, NEW)];
    expect((await day()).productsWithoutPalletFactor).toEqual([]);
  });
});
