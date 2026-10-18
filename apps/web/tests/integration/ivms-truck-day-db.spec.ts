/**
 * A TRUCK'S DAY on real PostgreSQL, library level (owner request 18 Oct 2026: lib/ivms/truck-day-read.ts
 * over the rows the GPS times write, with the database's own types and keys). Needs DATABASE_URL
 * (migrated, with the IVMS migrations); the web server and the solver are not used, and no call is made
 * to Ayun. Invented data only: the vendor documentation's dummy IMEI, a depot and shops in empty desert.
 *
 *  1. A dispatched load whose GPS times were written (lib/ivms/stop-events.ts processGpsTimes): the day
 *     shows the load of the plan in use, the stops with who timed them (the driver's tap stays the
 *     arrival of stop 2, GPS fills the rest), the depot moves of the trail, the trail itself (the day is
 *     yesterday: inside the trail's retention), no live position (none stored), and never the tracker's
 *     IMEI or the depot's Ayun zone.
 *  2. Another company's truck, or this truck asked by another company, is null (the route's 404).
 *  3. The Leaving for next load tap shown is the one rule R2 counts (review of 18 Oct 2026): the latest
 *     before the first sign at a stop, the phone's own photo (DeliveryPhoto, read by the page's reader)
 *     being one and an old gallery photo not; a tap after it is named as not counted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => null) }));

import { prisma as libPrisma } from '@/lib/db';
import { processGpsTimes } from '@/lib/ivms/stop-events';
import { readTruckDay } from '@/lib/ivms/truck-day-read';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const IMEI_A = '111111111111111';
const IMEI_B = '222222222222222';
const slug = `ivmstd-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const slugOther = `ivmstd2-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
/** Yesterday in Muscat (UTC+4): its 06:30-08:00 trail is in the past, and inside the trail's retention (2 days). */
const D = new Date(Date.now() + 4 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
const dayDate = new Date(`${D}T00:00:00.000Z`);
/** Local HH:MM (Muscat, UTC+4) on D as an instant. */
const L = (hhmm: string) => new Date(Date.parse(`${D}T${hhmm}:00+04:00`));
const ORIGIN = { lat: 20.1, lng: 55.1 };
const at = (east: number) => ({ lat: ORIGIN.lat, lng: ORIGIN.lng + east / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)) });

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

let tenantId = '';
let otherId = '';
let truckId = '';
let otherTruckId = '';
let points = 0;

async function company(s: string, imei: string): Promise<{ tenantId: string; truckId: string }> {
  const t = await prisma.tenant.create({ data: { slug: s, name: `Truck day ${s}`, country: 'Oman' } });
  await prisma.tenantConfig.create({ data: { tenantId: t.id, ivmsMode: 'TIMES', timezone: 'Asia/Muscat' } });
  const user = await prisma.user.create({ data: { tenantId: t.id, email: `admin@${s}.test`, passwordHash: 'x', name: 'Admin', role: 'TENANT_ADMIN' } });
  const depot = await prisma.depot.create({ data: { tenantId: t.id, code: 'TD1', name: 'Example depot', ...at(0), ivmsZoneName: 'Example zone' } });
  const driver = await prisma.driver.create({ data: { tenantId: t.id, code: 'DR1', name: 'Driver Example' }, select: { id: true } });
  const truck = await prisma.truck.create({ data: { tenantId: t.id, depotId: depot.id, code: 'T-100', description: 'Example 10-ton truck', capacityCases: 500, ivmsImei: imei } });
  const custA = await prisma.customer.create({ data: { tenantId: t.id, code: 'TA', name: 'Shop Example A', ...at(3000) } });
  const custB = await prisma.customer.create({ data: { tenantId: t.id, code: 'TB', name: 'Shop Example B', ...at(6000) } });
  // An earlier version replaced by the plan in use: its load is never the truck's day.
  const old = await prisma.runPlan.create({ data: { tenantId: t.id, depotId: depot.id, runDate: dayDate, createdById: user.id, status: 'SUPERSEDED', version: 1, supersededAt: L('05:00') } });
  await prisma.planLoad.create({ data: { tenantId: t.id, runId: old.id, truckId: truck.id, loadNo: 1, departMin: 400, returnMin: 470, distanceKm: 12, durationMin: 60, cases: 20, weightKg: 0, utilizationPct: 5 } });
  const run = await prisma.runPlan.create({ data: { tenantId: t.id, depotId: depot.id, runDate: dayDate, createdById: user.id, status: 'DISPATCHED', version: 2, parentRunId: old.id } });
  const load = await prisma.planLoad.create({
    data: { tenantId: t.id, runId: run.id, truckId: truck.id, loadNo: 1, departMin: 420, returnMin: 480, distanceKm: 12, durationMin: 60, cases: 20, weightKg: 0, utilizationPct: 5, status: 'DISPATCHED', statusChangedAt: L('06:55'), driverId: driver.id },
  });
  for (const [i, c] of [custA, custB].entries()) {
    const order = await prisma.order.create({ data: { tenantId: t.id, customerId: c.id, deliveryDate: dayDate, depotId: depot.id, totalCases: 10 } });
    await prisma.routeAssignment.create({
      data: { runId: run.id, truckId: truck.id, loadId: load.id, orderId: order.id, sequenceInTruck: i + 1, plannedArrivalMin: 430 + i * 20, plannedDistanceFromPrevKm: 3, plannedLoadCases: 10, etaMin: 430 + i * 20, serviceStartMin: 430 + i * 20, departureMin: 440 + i * 20 },
    });
  }
  await prisma.auditLog.create({ data: { tenantId: t.id, userId: user.id, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: load.id, createdAt: L('06:55') } });
  const pts = trail();
  await prisma.truckTrailPoint.createMany({ data: pts.map((p) => ({ tenantId: t.id, truckId: truck.id, ...p })) });
  points = pts.length;
  // The driver tapped "I have arrived" at stop 2 (GPS fills only what the driver left).
  const visit = await prisma.stopVisit.create({
    data: { tenantId: t.id, depotId: depot.id, deliveryDate: dayDate, truckId: truck.id, loadNo: 1, sequence: 2, customerId: custB.id, firstLoadId: load.id, casesPlanned: 10, linesJson: [] },
  });
  await prisma.stopEvent.create({
    data: { tenantId: t.id, depotId: depot.id, deliveryDate: dayDate, truckId: truck.id, loadNo: 1, sequence: 2, visitId: visit.id, kind: 'ARRIVED', source: 'PHONE_MANUAL', at: L('07:20'), idempotencyKey: `dl:${uniqueSuffix()}`, payloadJson: { mode: 'MANUAL' } },
  });
  return { tenantId: t.id, truckId: truck.id };
}

beforeAll(async () => {
  ({ tenantId, truckId } = await company(slug, IMEI_A));
  ({ tenantId: otherId, truckId: otherTruckId } = await company(slugOther, IMEI_B));
  const r = await processGpsTimes(tenantId, truckId, D, new Date());
  expect(r).toMatchObject({ skipped: null, busy: false });
});

afterAll(async () => {
  await cleanupTenant(slug);
  await cleanupTenant(slugOther);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('1. the day of a truck with GPS times', () => {
  it('the load in use, the stops with who timed them, the trail moves, the trail; never the IMEI', async () => {
    const m = await readTruckDay(tenantId, truckId, D, new Date());
    expect(m).not.toBeNull();
    expect(m!.mode).toBe('TIMES');
    expect(m!.truck).toMatchObject({ code: 'T-100', description: 'Example 10-ton truck' });
    expect(m!.loads.map((l) => `L${l.loadNo} ${l.status} ${l.driverName}`)).toEqual(['L1 DISPATCHED Driver Example']);
    expect(m!.stops.map((s) => `${s.sequence} ${s.customerName} ${s.arrivalBy} ${s.departureBy}`)).toEqual(['1 Shop Example A GPS (Ayun) GPS (Ayun)', '2 Shop Example B driver GPS (Ayun)']);
    expect(m!.timeline.filter((t) => t.source === 'GPS trail').map((t) => t.kind)).toEqual(['DEPOT_OUT', 'DEPOT_IN']);
    expect(m!.timeline[0]).toMatchObject({ kind: 'DISPATCHED', at: L('06:55').toISOString() });
    expect(m!.trail.total).toBe(points);
    expect(m!.trail.points).toHaveLength(points);
    expect(m!.trail.from).toBe(L('06:30').toISOString());
    expect(m!.dates).toContain(D);
    expect(m!.live).toBeNull();
    const text = JSON.stringify(m);
    expect(text).not.toContain(IMEI_A);
    expect(text).not.toMatch(/imei|Example zone/i);
  });
});

describe('2. isolation', () => {
  it("another company's truck, or this truck asked by another company, is null", async () => {
    expect(await readTruckDay(tenantId, otherTruckId, D)).toBeNull();
    expect(await readTruckDay(otherId, truckId, D)).toBeNull();
  });
});

describe('3. the Leaving tap rule R2 counts (review of 18 Oct 2026)', () => {
  it("one line at the tap R2 counts: the latest before the first sign, the phone's own photo being one (an old photo is not)", async () => {
    const visit = await prisma.stopVisit.findFirstOrThrow({ where: { tenantId, truckId, sequence: 2 }, select: { id: true, depotId: true } });
    const tap = { tenantId, depotId: visit.depotId, deliveryDate: dayDate, truckId, loadNo: 1, source: 'PHONE_MANUAL' as const, kind: 'DEPOT_DEPART' as const };
    for (const hhmm of ['07:00', '07:10']) await prisma.stopEvent.create({ data: { ...tap, at: L(hhmm), idempotencyKey: `dl:${uniqueSuffix()}` } });
    const photo = { tenantId, visitId: visit.id, positionStatus: 'OK' as const, byteSize: 3, sha256: 'x' };
    // The phone's photo at stop 2 at 07:05, before the driver's 07:20 arrival tap: the first sign. Stop 1's
    // GPS arrival is not one (R2 leaves out GPS times), nor is a gallery photo older than the arrival.
    await prisma.deliveryPhoto.create({ data: { ...photo, idempotencyKey: `dlphoto:${uniqueSuffix()}`, source: 'PHONE_AUTO', takenAt: L('07:05') } });
    await prisma.deliveryPhoto.create({ data: { ...photo, idempotencyKey: `dlphoto:${uniqueSuffix()}`, source: 'PHONE_MANUAL', takenAt: L('06:58'), oldPhoto: true } });
    const m = await readTruckDay(tenantId, truckId, D, new Date());
    const left = m!.timeline.filter((t) => t.kind === 'DEPOT_OUT' && t.source === 'driver');
    expect(left.map((t) => t.at)).toEqual([L('07:00').toISOString()]);
    expect(left[0]!.lines).toContain('Tapped again at 07:10, after the truck had reached a stop: not counted');
  });
});
