/**
 * GET /api/runs/:id/load-geometry end to end with a fake tenant client and a fake solver call: the
 * loads come from the caller's own run through the tenant-scoped client, each load's path is depot
 * -> stops in order -> depot, routing off makes no solver call, a failed load is the only straight one,
 * a second view is served from the road-shape cache, the rows keep their original fields, and each
 * row's fingerprint matches the one the map computes from the stops it shows (getPlanDetail's shape),
 * so the map can tell when its plan is behind the answer. Since PR4 (review F08) the path goes through
 * the pins the stops were planned with (their snapshots) and from the depot the plan was made from,
 * exactly as getPlanDetail shows them, so a pin corrected after planning neither redraws the load nor
 * makes the answer look stale.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Pt = [number, number];
const h = vi.hoisted(() => ({
  tenants: [] as string[],
  run: null as null | { id: string; depot: { lat: number; lng: number }; chosenScenarioId?: string | null },
  scenario: null as null | { id: string; runId: string; detailsJson: unknown },
  scenarioWhere: [] as unknown[],
  cfg: null as null | { distanceProvider: string; osrmUrl: string | null },
  country: 'Oman' as string | null,
  loads: [] as Record<string, unknown>[],
  call: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'VIEWER', name: 'V', email: 'v@a.example' } }) }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: (tenantId: string) => {
    h.tenants.push(tenantId);
    return {
      runPlan: { findUnique: async ({ where }: { where: { id: string } }) => (h.run && where.id === h.run.id ? h.run : null) },
      tenantConfig: { findUnique: async () => h.cfg },
      planLoad: { findMany: async ({ where }: { where: { runId: string } }) => h.loads.filter((l) => l.runId === where.runId) },
    };
  },
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: { findUnique: async () => ({ country: h.country }) },
    scenarioResult: {
      findFirst: async ({ where }: { where: { id: string; runId: string } }) => {
        h.scenarioWhere.push(where);
        return h.scenario && h.scenario.id === where.id && h.scenario.runId === where.runId ? { detailsJson: h.scenario.detailsJson } : null;
      },
    },
  },
}));
vi.mock('@/lib/solver-client', () => ({ callRouteGeometry: h.call }));

import { GET } from '@/app/api/runs/[id]/load-geometry/route';
import { roadShapeCache } from '@/lib/dispatch/load-geometry';
import { loadPathKey } from '@/lib/dispatch/load-path';
import { answerIsStale, drawnShapes, type GeoRow, type MapLoadStops } from '@/lib/dispatch/plan-map-state';
import { ROAD_TEXT, roadShapesCaption } from '@/lib/dispatch/map-caption';

const DEPOT = { lat: 23.6, lng: 58.4 };
const cust = (lat: number | null, lng: number | null) => ({ order: { customer: { lat, lng } } });
const bend = (pts: Pt[]) => pts.flatMap(([lat, lng]) => [[lng, lat], [lng + 0.001, lat]]);

function seed() {
  h.run = { id: 'R1', depot: DEPOT };
  h.loads = [
    {
      id: 'L1', runId: 'R1', loadNo: 1, truck: { code: 'T01' },
      // Two orders at stop 1 (one stop), stop 2 without a location, stop 3.
      assignments: [
        { sequenceInTruck: 1, ...cust(23.61, 58.41) },
        { sequenceInTruck: 1, ...cust(23.61, 58.41) },
        { sequenceInTruck: 2, ...cust(null, null) },
        { sequenceInTruck: 3, ...cust(23.63, 58.43) },
      ],
    },
    { id: 'L2', runId: 'R1', loadNo: 2, truck: { code: 'T01' }, assignments: [{ sequenceInTruck: 1, ...cust(23.7, 58.5) }] },
    { id: 'X', runId: 'OTHER', loadNo: 1, truck: { code: 'Z' }, assignments: [{ sequenceInTruck: 1, ...cust(1, 1) }] },
  ];
}

const get = async (id = 'R1') => {
  const res = await GET(new Request(`http://t.test/api/runs/${id}/load-geometry`), { params: { id } });
  return { status: res.status, body: (await res.json()) as { data: Record<string, unknown>[] | null } };
};

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
afterAll(() => warn.mockRestore());

beforeEach(() => {
  warn.mockClear();
  h.scenario = null;
  h.scenarioWhere.length = 0;
  roadShapeCache.clear();
  h.tenants.length = 0;
  h.call.mockReset();
  h.cfg = { distanceProvider: 'OSRM', osrmUrl: null };
  h.country = 'Oman';
  seed();
});

describe('GET /api/runs/:id/load-geometry', () => {
  it('sends each load of the run as depot -> located stops in order -> depot, and returns road shapes', async () => {
    h.call.mockImplementation(async (pts: Pt[]) => ({ kind: 'answer', provider: 'OSRM', isEstimated: false, coordinates: bend(pts), warning: null }));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(h.tenants).toEqual(['tA']);
    expect(h.call).toHaveBeenCalledTimes(2);
    const sent = h.call.mock.calls.map((c) => c[0]);
    expect(sent).toContainEqual([[23.6, 58.4], [23.61, 58.41], [23.63, 58.43], [23.6, 58.4]]);
    expect(sent).toContainEqual([[23.6, 58.4], [23.7, 58.5], [23.6, 58.4]]);
    expect(h.call.mock.calls[0][1]).toBeNull(); // no tenant OSRM URL: the solver's own
    expect(h.call.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
    expect(body.data).toEqual([
      { loadId: 'L1', truckCode: 'T01', loadNo: 1, estimated: false, coordinates: bend([[23.6, 58.4], [23.61, 58.41], [23.63, 58.43], [23.6, 58.4]]), pointsKey: loadPathKey([[23.6, 58.4], [23.61, 58.41], [23.63, 58.43], [23.6, 58.4]]) },
      { loadId: 'L2', truckCode: 'T01', loadNo: 2, estimated: false, coordinates: bend([[23.6, 58.4], [23.7, 58.5], [23.6, 58.4]]), pointsKey: loadPathKey([[23.6, 58.4], [23.7, 58.5], [23.6, 58.4]]) },
    ]);
  });

  it("each row's fingerprint is the one the map computes from the stops it shows; a pin moved on the server makes the answer stale", async () => {
    h.call.mockImplementation(async (pts: Pt[]) => ({ kind: 'answer', provider: 'OSRM', isEstimated: false, coordinates: bend(pts), warning: null }));
    // What PlanView passes the map for this run (getPlanDetail: one stop per sequence, first order's customer).
    const onScreen: MapLoadStops[] = [
      { id: 'L1', stops: [{ lat: 23.61, lng: 58.41 }, { lat: null, lng: null }, { lat: 23.63, lng: 58.43 }] },
      { id: 'L2', stops: [{ lat: 23.7, lng: 58.5 }] },
    ];
    const answer = async () => ({ status: 'ready' as const, rows: (await get()).body.data as unknown as GeoRow[] });
    const fresh = await answer();
    expect(answerIsStale(fresh, onScreen, DEPOT)).toBe(false);
    expect(roadShapesCaption(drawnShapes(fresh, onScreen, DEPOT)).text).toBe(ROAD_TEXT);

    // The customer of L2's stop is moved after this screen loaded the plan: same load id, other path.
    (h.loads[1].assignments as { order: { customer: { lat: number; lng: number } } }[])[0].order.customer = { lat: 23.75, lng: 58.55 };
    const moved = await answer();
    expect(answerIsStale(moved, onScreen, DEPOT)).toBe(true);
    const c = roadShapesCaption(drawnShapes(moved, onScreen, DEPOT));
    expect(c.text).not.toBe(ROAD_TEXT);
    expect(c.text).toMatch(/^1 load of 2 is drawn as a straight dashed line/);
  });

  it('a load whose only stop is on the depot pin comes back noPath, never as a road shape, and is not routed', async () => {
    h.loads[1].assignments = [{ sequenceInTruck: 1, ...cust(DEPOT.lat, DEPOT.lng) }];
    h.call.mockResolvedValue({ kind: 'not_configured' });
    const { body } = await get();
    expect(h.call).toHaveBeenCalledTimes(1); // L1 only
    expect(body.data?.map((r) => [r.loadId, r.estimated, r.reason, r.noPath])).toEqual([
      ['L1', true, 'NOT_CONFIGURED', undefined],
      ['L2', false, undefined, true],
    ]);
    expect(roadShapesCaption({ status: 'ready', rows: body.data as unknown as GeoRow[] }).text).toBe('Straight dashed lines: road routing (OSRM) is not set up, so the map has no road shapes.');
  });

  it('a failed load is straight with a reason; the other keeps its road shape; a second view asks only for the missing one', async () => {
    h.call.mockImplementation(async (pts: Pt[]) =>
      pts.length === 4 ? { kind: 'failed', status: 502 } : { kind: 'answer', provider: 'OSRM', isEstimated: false, coordinates: bend(pts), warning: null },
    );
    const first = await get();
    expect(first.body.data?.map((r) => [r.loadId, r.estimated, r.reason])).toEqual([
      ['L1', true, 'ROUTING_ERROR'],
      ['L2', false, undefined],
    ]);
    expect(first.body.data?.[0].coordinates).toEqual([[58.4, 23.6], [58.41, 23.61], [58.43, 23.63], [58.4, 23.6]]);
    expect(warn).toHaveBeenCalledWith('[load-geometry] run=R1 1/2 load(s) drawn straight (ROUTING_ERROR)');
    h.call.mockClear();
    h.call.mockImplementation(async (pts: Pt[]) => ({ kind: 'answer', provider: 'OSRM', isEstimated: false, coordinates: bend(pts), warning: null }));
    const second = await get();
    expect(h.call).toHaveBeenCalledTimes(1);
    expect(second.body.data?.every((r) => r.estimated === false)).toBe(true);
  });

  it("uses the tenant's own OSRM URL when it has one", async () => {
    h.cfg = { distanceProvider: 'OSRM', osrmUrl: ' http://osrm.tenant.test ' };
    h.call.mockResolvedValue({ kind: 'timeout' });
    await get();
    expect(h.call.mock.calls[0][1]).toBe('http://osrm.tenant.test');
  });

  it('company on straight-line distances: no solver call, every load ROUTING_OFF', async () => {
    h.cfg = { distanceProvider: 'HAVERSINE', osrmUrl: null };
    const { body } = await get();
    expect(h.call).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled(); // a company setting, not a problem to log
    expect(body.data?.map((r) => [r.estimated, r.reason])).toEqual([
      [true, 'ROUTING_OFF'],
      [true, 'ROUTING_OFF'],
    ]);
  });

  it('company outside the shared road map (Settings still say OSRM): no solver call, OUTSIDE_COVERAGE, not blamed on Settings', async () => {
    h.country = 'Saudi Arabia';
    const { body } = await get();
    expect(h.call).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(body.data?.map((r) => [r.estimated, r.reason])).toEqual([
      [true, 'OUTSIDE_COVERAGE'],
      [true, 'OUTSIDE_COVERAGE'],
    ]);
    // With its own OSRM the same company routes on roads.
    h.cfg = { distanceProvider: 'OSRM', osrmUrl: 'http://ksa-osrm.test' };
    h.call.mockResolvedValue({ kind: 'failed', status: 502 });
    await get();
    expect(h.call).toHaveBeenCalled();
  });

  it('no settings row: no solver call, NOT_CONFIGURED (logged)', async () => {
    h.cfg = null;
    const { body } = await get();
    expect(h.call).not.toHaveBeenCalled();
    expect(body.data?.map((r) => r.reason)).toEqual(['NOT_CONFIGURED', 'NOT_CONFIGURED']);
    expect(warn).toHaveBeenCalledWith('[load-geometry] run=R1 2/2 load(s) drawn straight (NOT_CONFIGURED)');
  });

  it('F08: the planned pins (snapshots) and the depot the plan was made from; a pin corrected later changes nothing', async () => {
    const PLAN_DEPOT = { lat: 23.5, lng: 58.3 }; // the depot pin when the option was optimized (moved since)
    const snap = (lat: number | null, lng: number | null) => ({ v: 1, customerId: 'C', code: 'C', name: 'C', lat, lng });
    h.run = { id: 'R1', depot: DEPOT, chosenScenarioId: 'S1' };
    h.scenario = {
      id: 'S1',
      runId: 'R1',
      detailsJson: { scope: { orderPriority: {} }, loads: [], inputs: { v: 1, config: {}, stops: {}, trucks: {}, depot: { id: 'D1', ...PLAN_DEPOT, openMin: 0, closeMin: 1440 } } },
    };
    h.loads = [
      {
        id: 'L1', runId: 'R1', loadNo: 1, truck: { code: 'T01' },
        assignments: [
          // Planned at 23.62,58.42; the customer's pin was corrected afterwards.
          { sequenceInTruck: 1, stopSnapshotJson: snap(23.62, 58.42), ...cust(23.61, 58.41) },
          // A later order of the same stop: the stop's pin is its first order's.
          { sequenceInTruck: 1, stopSnapshotJson: snap(23.69, 58.49), ...cust(23.69, 58.49) },
          // Planned before snapshots existed: today's customer pin.
          { sequenceInTruck: 2, stopSnapshotJson: null, ...cust(23.63, 58.43) },
          // Planned without a location (one was added later): no point, as the plan shows it.
          { sequenceInTruck: 3, stopSnapshotJson: snap(null, null), ...cust(23.64, 58.44) },
        ],
      },
    ];
    h.call.mockImplementation(async (pts: Pt[]) => ({ kind: 'answer', provider: 'OSRM', isEstimated: false, coordinates: bend(pts), warning: null }));
    const planned: Pt[] = [[23.5, 58.3], [23.62, 58.42], [23.63, 58.43], [23.5, 58.3]];
    const { body } = await get();
    expect(h.scenarioWhere).toEqual([{ id: 'S1', runId: 'R1' }]); // the run's own option only
    expect(h.call.mock.calls.map((c) => c[0])).toEqual([planned]);
    expect(body.data?.[0].pointsKey).toBe(loadPathKey(planned));
    // What getPlanDetail shows for this plan: the plan's depot, each stop at its planned pin.
    const onScreen: MapLoadStops[] = [{ id: 'L1', stops: [{ lat: 23.62, lng: 58.42 }, { lat: 23.63, lng: 58.43 }, { lat: null, lng: null }] }];
    const fresh = { status: 'ready' as const, rows: body.data as unknown as GeoRow[] };
    expect(answerIsStale(fresh, onScreen, PLAN_DEPOT)).toBe(false);
    expect(roadShapesCaption(drawnShapes(fresh, onScreen, PLAN_DEPOT)).text).toBe(ROAD_TEXT);

    // Another pin correction on the customer master: the snapshotted stop does not move.
    (h.loads[0].assignments as { order: { customer: { lat: number; lng: number } } }[])[0].order.customer = { lat: 23.9, lng: 58.9 };
    const again = await get();
    expect(again.body.data?.[0].pointsKey).toBe(loadPathKey(planned));
    expect(answerIsStale({ status: 'ready', rows: again.body.data as unknown as GeoRow[] }, onScreen, PLAN_DEPOT)).toBe(false);
  });

  it('an option from before inputs were kept (or not found for this run) uses the live depot', async () => {
    h.run = { id: 'R1', depot: DEPOT, chosenScenarioId: 'S-old' };
    h.scenario = { id: 'S-old', runId: 'R1', detailsJson: { scope: { orderPriority: {} }, loads: [] } };
    h.call.mockImplementation(async (pts: Pt[]) => ({ kind: 'answer', provider: 'OSRM', isEstimated: false, coordinates: bend(pts), warning: null }));
    await get();
    expect(h.call.mock.calls.map((c) => c[0])).toContainEqual([[23.6, 58.4], [23.7, 58.5], [23.6, 58.4]]);
    h.call.mockClear();
    roadShapeCache.clear();
    h.scenario = { id: 'S-old', runId: 'OTHER-RUN', detailsJson: { scope: {}, loads: [], inputs: { v: 1, config: {}, stops: {}, trucks: {}, depot: { id: 'D9', lat: 1, lng: 1 } } } };
    await get();
    expect(h.call.mock.calls.map((c) => c[0])).toContainEqual([[23.6, 58.4], [23.7, 58.5], [23.6, 58.4]]);
  });

  it('a run the tenant client does not find is 404, with no solver call', async () => {
    const { status } = await get('R-of-another-tenant');
    expect(status).toBe(404);
    expect(h.call).not.toHaveBeenCalled();
  });
});
