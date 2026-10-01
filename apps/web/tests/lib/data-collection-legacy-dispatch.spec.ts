/**
 * Data collection review: the loading rule (owner decision 1 Oct 2026, "no truck is loaded unless every
 * pre-sales order has a location and a delivery window") on POST /api/runs/:id/dispatch - a legacy run
 * (a plan of the previous planner, not a daily dispatch plan) is dispatched whole there. It checked the
 * location (audit PR A5) but not the delivery window, so with the rule on a customer without its own
 * confirmed hours and without a delivery time on its order went out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ruleOn: true,
  stops: [] as Record<string, any>[],
  flipped: 0,
}));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'SUPERVISOR', name: 'S', email: 's@a.example' } }) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/dispatch/legacy-runs', () => ({ isDispatchPlan: async () => false, DISPATCH_PLAN_REFUSAL: { code: 'DISPATCH_PLAN', error: 'x' } }));
vi.mock('@/lib/dispatch/service-area', async () => {
  const { DEFAULT_SERVICE_AREA } = await import('@/lib/dispatch/location-input');
  return { tenantServiceArea: async () => DEFAULT_SERVICE_AREA };
});
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    runPlan: { findUnique: async () => ({ id: 'R1', status: 'READY', supersededAt: null, chosenScenarioId: 'S1', _count: { routes: state.stops.length } }) },
  }),
}));
vi.mock('@/lib/db', () => {
  const tx = {
    runPlan: {
      updateMany: async () => {
        state.flipped++;
        return { count: 1 };
      },
      findUniqueOrThrow: async () => ({ id: 'R1', status: 'DISPATCHED', finalizedAt: new Date(), runDate: new Date('2026-10-02T00:00:00Z') }),
    },
    order: { updateMany: async () => ({ count: state.stops.length }) },
  };
  return {
    prisma: {
      ...tx,
      routeAssignment: { findMany: async () => state.stops.map((s) => ({ order: s })) },
      tenantConfig: { findUnique: async () => ({ requireDataBeforeLoading: state.ruleOn }) },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

import { POST } from '@/app/api/runs/[id]/dispatch/route';
import { DATA_GATE_RULE } from '@/lib/dispatch/data-collection';

const customer = (code: string, over: Record<string, unknown> = {}) => ({
  id: code, code, branchCode: null, name: `Shop ${code}`, lat: 23.5859, lng: 58.4059, locationVerified: false, geocodeConfidence: 'HIGH', windowConfirmedAt: null, ...over,
});
const stop = (code: string, over: Record<string, unknown> = {}, time: Record<string, unknown> = {}) => ({
  customerId: code, deliveryStartMin: null, deliveryEndMin: null, ...time, customer: customer(code, over),
});
const dispatch = async () => {
  const res = await POST(new Request('http://localhost/api/runs/R1/dispatch', { method: 'POST' }), { params: { id: 'R1' } });
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
};

beforeEach(() => {
  state.ruleOn = true;
  state.flipped = 0;
  state.stops = [stop('C1', { windowConfirmedAt: new Date() }), stop('C2'), stop('C3', {}, { deliveryStartMin: 600, deliveryEndMin: 660 })];
});

describe('POST /api/runs/:id/dispatch with the loading rule on', () => {
  it('a customer with no delivery window (no confirmed hours, no time on its order): 409 DATA_REQUIRED, nothing dispatched', async () => {
    const r = await dispatch();
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'DATA_REQUIRED', customers: [{ code: 'C2', missing: 'delivery window' }] });
    expect(r.body.error.error).toBe(
      `1 customer(s) on this run have no delivery window: C2 (Shop C2). Nothing was dispatched. ${DATA_GATE_RULE} Enter each customer's receiving hours in Details (Daily dispatch or the customer page) and tick "These hours are confirmed with the customer", or tick "Open all day", then dispatch again.`,
    );
    expect(state.flipped).toBe(0);
  });

  it('every customer with its own confirmed hours or a time on its order: dispatched; the rule off: dispatched as before', async () => {
    state.stops = state.stops.filter((s) => s.customerId !== 'C2');
    expect((await dispatch()).status).toBe(200);
    state.stops = [stop('C2')];
    state.ruleOn = false;
    expect((await dispatch()).status).toBe(200);
    expect(state.flipped).toBe(2);
  });

  it('a missing location is still refused first by the location rule (LOCATION_REQUIRED)', async () => {
    state.stops = [stop('C9', { lat: null, lng: null, geocodeConfidence: 'MISSING' })];
    expect((await dispatch()).body.error).toMatchObject({ code: 'LOCATION_REQUIRED' });
  });
});
