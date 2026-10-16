/**
 * GET /api/runs/[id]/vehicles (IVMS live link, design section 8.2 with review M7/H5) on the in-memory
 * database: PLANNER and up only, nothing while the mode is OFF or the kill switch is set, only a plan of
 * today or yesterday, only trucks with a load out, stale positions grey, never an IMEI, another
 * company's plan 404. Invented data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';
import { at } from './ivms-trail';
import { todayIso, addDaysIso, zonedDayStart } from '@/lib/dispatch/time';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
const { session } = vi.hoisted(() => ({ session: { value: null as null | { user: { id: string; name: string; role: string; tenantId: string; email: string } } } }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => session.value) }));

const { GET } = await import('@/app/api/runs/[id]/vehicles/route');

const TEN = 'tA';
const TZ = 'Asia/Muscat';
const TODAY = todayIso(TZ);
const dateOnlyOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function seed(mode = 'MAP', runDate = TODAY) {
  resetDb();
  session.value = { user: { id: 'u1', name: 'Planner', role: 'PLANNER', tenantId: TEN, email: 'planner@example.test' } };
  tables.tenantConfig = [{ id: 'cfg', tenantId: TEN, timezone: TZ, ivmsMode: mode, avgSpeedKmh: 40, distanceMultiplier: 1.3, ivmsPollSec: 60 }];
  tables.depot = [{ id: 'D1', tenantId: TEN, code: 'D1', name: 'Depot', ...at(0) }];
  tables.truck = [
    { id: 't5', tenantId: TEN, code: 'T05', onlyOnDate: null, ivmsImei: '111111111111111' },
    { id: 't6', tenantId: TEN, code: 'T06', onlyOnDate: null, ivmsImei: '222222222222222' },
  ];
  tables.runPlan = [{ id: 'R1', tenantId: TEN, depotId: 'D1', runDate: dateOnlyOf(runDate), status: 'DISPATCHED', version: 1 }];
  tables.planLoad = [
    { id: 'L1', tenantId: TEN, runId: 'R1', truckId: 't5', loadNo: 1, status: 'DISPATCHED', departMin: 420, breakJson: null, truckSnapshotJson: null },
    // T06's only load is back: an off-duty truck is never shown (M7).
    { id: 'L6', tenantId: TEN, runId: 'R1', truckId: 't6', loadNo: 1, status: 'COMPLETED', departMin: 420, breakJson: null, truckSnapshotJson: null },
  ];
  tables.routeAssignment = [];
  tables.stopVisit = [];
  tables.ivmsState = [{ tenantId: TEN, lastOkAt: new Date(Date.now() - 30_000) }];
  tables.ivmsTruckDay = [];
  tables.truckPosition = [
    { id: 'p5', tenantId: TEN, truckId: 't5', fixAt: new Date(Date.now() - 60_000), receivedAt: new Date(), ...at(4000), speedKmh: 40, heading: 80, flags: [], movedAt: new Date(Date.now() - 60_000) },
    { id: 'p6', tenantId: TEN, truckId: 't6', fixAt: new Date(Date.now() - 60_000), receivedAt: new Date(), ...at(100), speedKmh: 0, heading: null, flags: [], movedAt: null },
  ];
}

const call = async (runId = 'R1') => {
  const res = await GET(new Request(`https://routeiq.test/api/runs/${runId}/vehicles`), { params: { id: runId } });
  return { status: res.status, body: (await res.json()) as { data: { mode: string; updatedAt: string | null; vehicles: Record<string, unknown>[] } | null; error?: unknown }, text: '' };
};

let prevDisable: string | undefined;
beforeEach(() => {
  prevDisable = process.env.ROUTEIQ_DISABLE_IVMS;
  delete process.env.ROUTEIQ_DISABLE_IVMS;
  seed();
});
afterEach(() => {
  if (prevDisable === undefined) delete process.env.ROUTEIQ_DISABLE_IVMS;
  else process.env.ROUTEIQ_DISABLE_IVMS = prevDisable;
});

describe('who may see the live trucks', () => {
  it('PLANNER, SUPERVISOR and the company admin; VIEWER is refused (positions of people at work)', async () => {
    for (const role of ['PLANNER', 'SUPERVISOR', 'TENANT_ADMIN']) {
      session.value!.user.role = role;
      expect((await call()).status).toBe(200);
    }
    session.value!.user.role = 'VIEWER';
    expect((await call()).status).toBe(403);
    session.value = null;
    expect((await call()).status).toBe(401);
  });

  it("another company's plan (or no plan) is 404", async () => {
    tables.runPlan![0]!.tenantId = 'tB';
    expect((await call()).status).toBe(404);
  });
});

describe('what is shown', () => {
  it('MAP: the trucks with a load out only, with their position, never an IMEI', async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.data!.mode).toBe('MAP');
    expect(r.body.data!.vehicles.map((v) => v.truckCode)).toEqual(['T05']);
    expect(r.body.data!.vehicles[0]).toMatchObject({ truckId: 't5', loadNo: 1, stale: false, speedKmh: 40 });
    expect(JSON.stringify(r.body)).not.toMatch(/111111111111111|222222222222222|imei/i);
  });

  it('OFF, the kill switch, or a plan of another day: no vehicle at all', async () => {
    seed('OFF');
    expect((await call()).body.data).toEqual({ mode: 'OFF', intervalSec: null, updatedAt: null, vehicles: [] });
    seed('TIMES');
    process.env.ROUTEIQ_DISABLE_IVMS = '1';
    expect((await call()).body.data).toEqual({ mode: 'OFF', intervalSec: null, updatedAt: null, vehicles: [] });
    delete process.env.ROUTEIQ_DISABLE_IVMS;
    seed('MAP', addDaysIso(TODAY, -2));
    expect((await call()).body.data!.vehicles).toEqual([]);
    seed('MAP', addDaysIso(TODAY, -1));
    expect((await call()).body.data!.vehicles).toHaveLength(1);
  });

  it('a stale position is grey with no speed; the next stop gets no ETA from it', async () => {
    tables.truckPosition![0]!.fixAt = new Date(Date.now() - 30 * 60_000);
    const v = (await call()).body.data!.vehicles[0]!;
    expect(v).toMatchObject({ stale: true, speedKmh: null, next: null });
  });

  it('a fresh position on the road gets the next stop and its ETA from the plan', async () => {
    tables.order = [{ id: 'O1', tenantId: TEN, customerId: 'C-A', carriedToOrderId: null, lines: [{ id: 'LA', cases: 10, weightKg: 100, product: { code: 'W' } }] }];
    const start = zonedDayStart(TODAY, TZ).getTime();
    const nowMin = Math.floor((Date.now() - start) / 60_000);
    tables.routeAssignment = [
      { id: 'A1', runId: 'R1', loadId: 'L1', truckId: 't5', orderId: 'O1', loadNo: 1, sequenceInTruck: 1, orderInStop: 0, etaMin: nowMin + 10, serviceStartMin: nowMin + 10, departureMin: nowMin + 25, portionLinesJson: null, stopSnapshotJson: { v: 1, customerId: 'C-A', code: 'A', branchCode: null, name: 'Shop Example A', customerType: null, ...at(9000), address: null, accessNotes: null, serviceMin: 15, priority: 3, hardStartMin: 0, hardEndMin: 1439, prefStartMin: null, prefEndMin: null, source: 'PLAN', capturedAt: new Date().toISOString() } },
    ];
    const v = (await call()).body.data!.vehicles[0]!;
    expect(v.next).toMatchObject({ sequence: 1, customerName: 'Shop Example A', atStop: false });
  });
});
