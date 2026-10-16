/**
 * IVMS LIVE LINK, GPS TIMES on real PostgreSQL, library level (lib/ivms/stop-events.ts with the stop
 * detector, the visit rebuild and the database's own keys and CHECKs). Needs DATABASE_URL (migrated, with
 * 20261016200000_ivms_live and 20261016210000_ivms_gps_facts); the web server and the solver are not used,
 * and no call is made to Ayun. Invented data only: the vendor documentation's dummy IMEI, a depot and
 * shops in empty desert.
 *
 *  1. A dispatched load with a stored trail gets AYUN arrivals and departures with natural keys, its
 *     visits rebuilt (GPS times, no result), the depot moves as TRAIL facts; a second run writes nothing.
 *  2. A driver's tap already on a stop stays its arrival (GPS fills the departure only).
 *  3. A Back at depot of source AYUN never completes the load (the returned-loads sweep, H1).
 *  4. The facts column takes a JSON array only (CHECK); the trail-move keys fit IvmsEvent's key CHECK.
 *  5. Undo marks the truck-day suppressed, removes the AYUN events, rebuilds the visits; the next run
 *     writes nothing. Another company's truck-day is never touched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => null) }));

import { prisma as libPrisma } from '@/lib/db';
import { processGpsTimes, suppressGpsTimes } from '@/lib/ivms/stop-events';
import { completeReturnedLoads } from '@/lib/delivery/event-service';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const IMEI_A = '111111111111111';
const slug = `ivmsgt-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const slugOther = `ivmsgt2-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
/** A delivery day 20 days ago (GPS times are never in the future). */
const D = new Date(Date.now() + 4 * 3600_000 - 20 * 86_400_000).toISOString().slice(0, 10);
const dayDate = new Date(`${D}T00:00:00.000Z`);
/** Local HH:MM (Muscat, UTC+4) on D as an instant. */
const L = (hhmm: string, sec = 0) => new Date(Date.parse(`${D}T${hhmm}:00+04:00`) + sec * 1000);
const ORIGIN = { lat: 20.1, lng: 55.1 };
const at = (east: number) => ({ lat: ORIGIN.lat, lng: ORIGIN.lng + east / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)) });

let tenantId = '';
let otherId = '';
let truckId = '';
let loadId = '';
let depotId = '';

/** A trail: at the depot 06:30-07:00, 40 km/h to 3 km, 10 min there, to 6 km, 8 min there, back. */
function trail(): { fixAt: Date; lat: number; lng: number; speedKmh: number; ignition: boolean }[] {
  const pts: { fixAt: Date; lat: number; lng: number; speedKmh: number; ignition: boolean }[] = [];
  let t = L('06:30').getTime();
  let pos = 0;
  const park = (min: number) => {
    for (const end = t + min * 60_000; t < end; t += 30_000) pts.push({ fixAt: new Date(t), ...at(pos), speedKmh: 0, ignition: true });
  };
  const drive = (to: number) => {
    const dur = (Math.abs(to - pos) / (40 / 3.6)) * 1000;
    const from = pos;
    for (let dt = 30_000; dt < dur; dt += 30_000) pts.push({ fixAt: new Date(t + dt), ...at(from + ((to - from) * dt) / dur), speedKmh: 40, ignition: true });
    t += Math.ceil(dur / 30_000) * 30_000;
    pos = to;
  };
  park(30);
  drive(3000);
  park(10);
  drive(6000);
  park(8);
  drive(0);
  park(20);
  return pts;
}

async function company(s: string): Promise<{ tenantId: string; truckId: string; loadId: string; depotId: string }> {
  const t = await prisma.tenant.create({ data: { slug: s, name: `GPS times ${s}`, country: 'Oman' } });
  await prisma.tenantConfig.create({ data: { tenantId: t.id, ivmsMode: 'TIMES', timezone: 'Asia/Muscat' } });
  const user = await prisma.user.create({ data: { tenantId: t.id, email: `admin@${s}.test`, passwordHash: 'x', name: 'Admin', role: 'TENANT_ADMIN' } });
  const depot = await prisma.depot.create({ data: { tenantId: t.id, code: 'GD1', name: 'Example depot', ...at(0) } });
  const truck = await prisma.truck.create({ data: { tenantId: t.id, depotId: depot.id, code: 'GT05', capacityCases: 500, ivmsImei: IMEI_A } });
  const custA = await prisma.customer.create({ data: { tenantId: t.id, code: 'GA', name: 'Shop Example A', ...at(3000) } });
  const custB = await prisma.customer.create({ data: { tenantId: t.id, code: 'GB', name: 'Shop Example B', ...at(6000) } });
  const run = await prisma.runPlan.create({ data: { tenantId: t.id, depotId: depot.id, runDate: dayDate, createdById: user.id, status: 'DISPATCHED' } });
  const load = await prisma.planLoad.create({
    data: { tenantId: t.id, runId: run.id, truckId: truck.id, loadNo: 1, departMin: 420, returnMin: 480, distanceKm: 12, durationMin: 60, cases: 20, weightKg: 0, utilizationPct: 5, status: 'DISPATCHED', statusChangedAt: L('06:55') },
  });
  for (const [i, c] of [custA, custB].entries()) {
    const order = await prisma.order.create({ data: { tenantId: t.id, customerId: c.id, deliveryDate: dayDate, depotId: depot.id, totalCases: 10 } });
    await prisma.routeAssignment.create({
      data: { runId: run.id, truckId: truck.id, loadId: load.id, orderId: order.id, sequenceInTruck: i + 1, plannedArrivalMin: 430 + i * 20, plannedDistanceFromPrevKm: 3, plannedLoadCases: 10, etaMin: 430 + i * 20, serviceStartMin: 430 + i * 20, departureMin: 440 + i * 20 },
    });
  }
  await prisma.auditLog.create({ data: { tenantId: t.id, userId: user.id, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: load.id, createdAt: L('06:55') } });
  await prisma.truckTrailPoint.createMany({ data: trail().map((p) => ({ tenantId: t.id, truckId: truck.id, ...p })) });
  return { tenantId: t.id, truckId: truck.id, loadId: load.id, depotId: depot.id };
}

beforeAll(async () => {
  ({ tenantId, truckId, loadId, depotId } = await company(slug));
  otherId = (await company(slugOther)).tenantId;
});

afterAll(async () => {
  await cleanupTenant(slug);
  await cleanupTenant(slugOther);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

const events = () => prisma.stopEvent.findMany({ where: { tenantId, truckId, deliveryDate: dayDate }, orderBy: [{ at: 'asc' }] });

describe('1-2. GPS times of a dispatched load', () => {
  it('a driver tap stays the arrival of stop 2', async () => {
    const visit = await prisma.stopVisit.create({
      data: { tenantId, depotId, deliveryDate: dayDate, truckId, loadNo: 1, sequence: 2, customerId: (await prisma.customer.findFirstOrThrow({ where: { tenantId, code: 'GB' } })).id, firstLoadId: loadId, casesPlanned: 10, linesJson: [] },
    });
    await prisma.stopEvent.create({ data: { tenantId, depotId, deliveryDate: dayDate, truckId, loadNo: 1, sequence: 2, visitId: visit.id, kind: 'ARRIVED', source: 'PHONE_MANUAL', at: L('07:20'), idempotencyKey: `dl:${uniqueSuffix()}`, payloadJson: { mode: 'MANUAL' } } });
    const r = await processGpsTimes(tenantId, truckId, D, new Date());
    expect(r).toMatchObject({ skipped: null, busy: false });
    expect(r.written).toBe(4);
    const ev = await events();
    expect(ev.filter((e) => e.source === 'AYUN').map((e) => `${e.sequence} ${e.kind}`)).toEqual(['1 ARRIVED', '1 DEPARTED', '2 ARRIVED', '2 DEPARTED']);
    expect(ev.every((e) => e.kind === 'ARRIVED' || e.kind === 'DEPARTED')).toBe(true);
    const v1 = await prisma.stopVisit.findFirstOrThrow({ where: { tenantId, truckId, deliveryDate: dayDate, sequence: 1 } });
    expect(v1).toMatchObject({ arrivalSource: 'AYUN', departureSource: 'AYUN', outcome: null, autoServiceMinutes: null });
    const v2 = await prisma.stopVisit.findFirstOrThrow({ where: { id: visit.id } });
    expect(v2).toMatchObject({ arrivalSource: 'PHONE_MANUAL', departureSource: 'AYUN' });
    const moves = await prisma.ivmsEvent.findMany({ where: { tenantId, truckId }, orderBy: { eventAt: 'asc' } });
    expect(moves.map((m) => `${m.kind} ${m.origin} ${m.outcome}`)).toEqual(['DEPOT_OUT TRAIL USED', 'DEPOT_IN TRAIL USED']);
    expect((await prisma.ivmsTruckDay.findFirstOrThrow({ where: { tenantId, truckId, deliveryDate: dayDate } })).gpsFactsJson).toEqual([]);
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: loadId } })).status).toBe('DISPATCHED');
  });

  it('a second run writes nothing (natural keys, first write wins)', async () => {
    const before = (await events()).length;
    const r = await processGpsTimes(tenantId, truckId, D, new Date());
    expect(r.written).toBe(0);
    expect((await events()).length).toBe(before);
    expect(await prisma.ivmsEvent.count({ where: { tenantId, truckId } })).toBe(2);
  });
});

describe('3. a GPS Back at depot never completes a load (H1)', () => {
  it('the returned-loads sweep leaves the load DISPATCHED', async () => {
    await prisma.stopEvent.create({ data: { tenantId, depotId, deliveryDate: dayDate, truckId, loadNo: 1, sequence: null, kind: 'BACK_AT_DEPOT', source: 'AYUN', at: L('07:40'), idempotencyKey: `ayun:test-back:${uniqueSuffix()}` } });
    await completeReturnedLoads(new Date());
    expect((await prisma.planLoad.findUniqueOrThrow({ where: { id: loadId } })).status).toBe('DISPATCHED');
    await prisma.stopEvent.deleteMany({ where: { tenantId, kind: 'BACK_AT_DEPOT' } });
  });
});

describe('4. the database CHECKs', () => {
  it('gpsFactsJson takes a JSON array only', async () => {
    const day = await prisma.ivmsTruckDay.findFirstOrThrow({ where: { tenantId, truckId } });
    await expect(prisma.ivmsTruckDay.update({ where: { id: day.id }, data: { gpsFactsJson: { kind: 'SEVERAL_PINS' } } })).rejects.toThrow();
    await prisma.ivmsTruckDay.update({ where: { id: day.id }, data: { gpsFactsJson: [{ kind: 'NO_DEPOT_BOUNDARY' }] } });
  });
});

describe('5. undo and isolation', () => {
  it("undo removes the AYUN events, keeps the driver's tap, and the next run writes nothing", async () => {
    const dry = await suppressGpsTimes(tenantId, truckId, D, 'UNDO');
    expect(dry).toMatchObject({ events: 4, dryRun: true });
    await suppressGpsTimes(tenantId, truckId, D, 'UNDO', { dryRun: false });
    const ev = await events();
    expect(ev.map((e) => e.source)).toEqual(['PHONE_MANUAL']);
    expect((await prisma.stopVisit.findFirstOrThrow({ where: { tenantId, truckId, deliveryDate: dayDate, sequence: 2 } })).departureSource).toBeNull();
    expect(await processGpsTimes(tenantId, truckId, D, new Date())).toMatchObject({ skipped: 'SUPPRESSED', written: 0 });
  });

  it("another company's truck-day was never touched", async () => {
    expect(await prisma.stopEvent.count({ where: { tenantId: otherId } })).toBe(0);
    expect(await prisma.ivmsEvent.count({ where: { tenantId: otherId } })).toBe(0);
  });
});
