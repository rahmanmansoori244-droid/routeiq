/**
 * A hired truck's plate after a later day's hired truck took it (fourth review of the hire branch): the
 * earlier day's truck is renamed "12345AB.261006" (hired-truck.ts freedCode), and the run's route sheets
 * (PDF and Excel, lib/exports/route-sheet-data.ts), its map routes (load-geometry, route-geometries) and
 * the run API show the plate it drove with ("12345AB", hire.ts shownTruckCode), as the plan screen does;
 * so does the office's download of a delivery photo (its file name, fifth review).
 * Each fake query returns only the truck fields the code selects, so a select without `onlyOnDate`
 * shows the renamed code. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  trucks: {} as Record<string, Record<string, unknown>>,
  // The truck of the delivery visit whose photo the office downloads.
  visitTruck: 'H6',
}));

/** The fields of `row` a Prisma `select` asks for (the whole row without one). */
function pick(row: Row, select: unknown): Row {
  if (!select || typeof select !== 'object') return row;
  return Object.fromEntries(Object.keys(select as Row).filter((k) => (select as Row)[k]).map((k) => [k, row[k]]));
}

const customer = { id: 'c1', code: 'C1', name: 'Customer 1', branchKey: '__MAIN__', address: null, lat: 23.61, lng: 58.41 };
/** A route row of the run on truck `truckId`, its truck as the query selects it. */
const routeRow = (truckId: string, truckSelect: unknown, seq = 1) => ({
  id: `ra-${truckId}-${seq}`,
  truckId,
  sequenceInTruck: seq,
  portionCases: null,
  portionWeightKg: null,
  plannedArrivalMin: 480,
  plannedDistanceFromPrevKm: 5,
  lockedByUserId: null,
  truck: pick(h.trucks[truckId]!, truckSelect),
  order: { id: `o-${truckId}`, notes: null, totalCases: 20, totalWeightKg: 100, customer },
});

type Args = { include?: { routes?: { include?: { truck?: { select?: unknown } } }; truck?: { select?: unknown } } };
const runOf = (a: Args) => ({
  id: 'R6',
  tenantId: 'tA',
  runDate: new Date('2026-10-06T00:00:00Z'),
  optimizationMode: 'BALANCED',
  status: 'READY',
  finalizedAt: null,
  chosenScenarioId: null,
  depot: { id: 'D1', code: 'D1', name: 'Depot', lat: 23.6, lng: 58.4 },
  routes: a.include?.routes ? ['H6', 'OWN'].map((t) => routeRow(t, a.include!.routes!.include?.truck?.select)) : undefined,
  scenarios: [],
  jobs: [],
  manualBaselines: [],
});

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'VIEWER', name: 'V', email: 'v@a.example' } }) }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    runPlan: { findUnique: async (a: Args) => runOf(a) },
    tenantConfig: { findUnique: async () => null },
    planLoad: {
      findMany: async (a: Args) =>
        ['H6', 'OWN'].map((t) => ({ id: `L-${t}`, runId: 'R6', truckId: t, loadNo: 1, truckSnapshotJson: null, assignments: [], truck: pick(h.trucks[t]!, a.include?.truck?.select) })),
    },
  }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findUniqueOrThrow: async () => ({ name: 'Tenant A', currency: 'OMR', config: { distanceProvider: 'HAVERSINE' } }),
      findUnique: async () => ({ country: 'Oman' }),
    },
    runPlan: { findFirstOrThrow: async (a: Args) => runOf(a) },
    scenarioResult: { findFirst: async () => null },
    // A delivery photo of stop 3 on load 1 of the visit's truck (the office's photo download).
    deliveryPhoto: {
      findFirst: async () => ({ id: 'ph1', visitId: 'V1', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), purgedAt: null, receivedAt: new Date() }),
      findMany: async () => [{ id: 'ph1', takenAt: new Date('2026-10-06T08:00:00Z') }],
    },
    stopVisit: { findFirst: async () => ({ id: 'V1', truckId: h.visitTruck, loadNo: 1, sequence: 3 }) },
    truck: { findFirst: async (a: { where: { id: string }; select?: unknown }) => pick(h.trucks[a.where.id]!, a.select) },
    tenantConfig: { findFirst: async () => null },
  },
}));
vi.mock('@/lib/dispatch/legacy-runs', async (importActual) => ({ ...(await importActual<object>()), isDispatchPlan: async () => false }));
vi.mock('@/lib/solver-client', () => ({ callRouteGeometry: vi.fn(async () => null) }));

import { buildRouteSheet } from '@/lib/exports/route-sheet-data';
import { readOfficePhoto } from '@/lib/delivery/office-service';
import { GET as runGET } from '@/app/api/runs/[id]/route';
import { GET as loadGeometryGET } from '@/app/api/runs/[id]/load-geometry/route';
import { GET as routeGeometriesGET } from '@/app/api/runs/[id]/route-geometries/route';

beforeEach(() => {
  h.trucks = {
    H6: { id: 'H6', code: '12345AB.261006', description: null, capacityCases: 1140, hired: true, onlyOnDate: new Date('2026-10-06T00:00:00Z') },
    OWN: { id: 'OWN', code: 'T01', description: null, capacityCases: 1140, hired: false, onlyOnDate: null },
  };
  h.visitTruck = 'H6';
});

const req = (path: string) => new Request(`http://localhost/api/runs/R6${path}`);
const params = { params: { id: 'R6' } };

describe("a past day's hired truck on the run's sheets, maps and API shows the plate it drove with (fourth review)", () => {
  it('the route sheet (PDF and Excel of the run)', async () => {
    const sheet = await buildRouteSheet('tA', 'R6');
    expect(sheet.routes.map((r) => [r.truckId, r.truckCode])).toEqual([
      ['H6', '12345AB'],
      ['OWN', 'T01'],
    ]);
  });

  it('the run API (its route rows)', async () => {
    const res = await runGET(req(''), params);
    const body = (await res.json()) as { data: { routes: { truckId: string; truck: Row }[] } };
    expect(body.data.routes.map((r) => [r.truckId, r.truck.code])).toEqual([
      ['H6', '12345AB'],
      ['OWN', 'T01'],
    ]);
    // The truck fields it always gave, no more.
    expect(Object.keys(body.data.routes[0]!.truck).sort()).toEqual(['capacityCases', 'code', 'id']);
  });

  it('the map: one shape per load, and per truck on an older run', async () => {
    const loads = (await (await loadGeometryGET(req('/load-geometry'), params)).json()) as { data: { loadId: string; truckCode: string }[] };
    expect(loads.data.map((l) => [l.loadId, l.truckCode])).toEqual([
      ['L-H6', '12345AB'],
      ['L-OWN', 'T01'],
    ]);
    const trucks = (await (await routeGeometriesGET(req('/route-geometries'), params)).json()) as { data: { trucks: { truckId: string; truckCode: string }[] } };
    expect(trucks.data.trucks.map((t) => [t.truckId, t.truckCode])).toEqual([
      ['H6', '12345AB'],
      ['OWN', 'T01'],
    ]);
  });

  it("the office's download of a delivery photo names the plate it drove with (fifth review)", async () => {
    // It read the renamed code and removed the dot: "12345AB261006-L1-stop3-1.jpg".
    expect((await readOfficePhoto('tA', 'ph1')).filename).toBe('12345AB-L1-stop3-1.jpg');
    h.visitTruck = 'OWN';
    expect((await readOfficePhoto('tA', 'ph1')).filename).toBe('T01-L1-stop3-1.jpg');
  });
});
