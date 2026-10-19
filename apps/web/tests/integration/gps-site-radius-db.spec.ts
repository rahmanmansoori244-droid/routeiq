/**
 * GPS STOP DETECTION AT BIG CUSTOMERS on real PostgreSQL (owner request 19 Oct 2026: "at big customers the
 * truck moves between drop points and the model thinks it left"), library level: migration
 * 20261019120000_gps_site_radius_away's columns and CHECKs, and lib/ivms/stop-events.ts with the stop
 * detector, the customer's site radius and the visit rebuild's minutes away. Needs DATABASE_URL (migrated);
 * the web server and the solver are not used, and no call is made to Ayun. Invented data only: the vendor
 * documentation's dummy IMEI, a depot and shops in empty desert (20.1 N, 55.1 E).
 *
 *  1. Customer.siteRadiusM takes NULL or 100-500 m (CHECK); StopVisit.awayMinutes NULL or more than 0.
 *  2. A customer with a 400 m site radius: the truck unloading at a second drop point 370 m from the pin is
 *     still at the customer; the GPS departure is when it leaves the site, with the stay summary stored.
 *  3. A leave-and-return under the driver's own arrival and result: both GPS stays are written, the visit's
 *     departure is the second one's (it holds the result), and its minutes away are stored on the visit.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => null) }));

import { prisma as libPrisma } from '@/lib/db';
import { processGpsTimes } from '@/lib/ivms/stop-events';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const IMEI = '111111111111111';
const slug = `gpssite-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
/** A delivery day 20 days ago (GPS times are never in the future). */
const D = new Date(Date.now() + 4 * 3600_000 - 20 * 86_400_000).toISOString().slice(0, 10);
const dayDate = new Date(`${D}T00:00:00.000Z`);
const L = (hhmm: string, sec = 0) => new Date(Date.parse(`${D}T${hhmm}:00+04:00`) + sec * 1000);
const ORIGIN = { lat: 20.1, lng: 55.1 };
const at = (east: number, north = 0) => ({ lat: ORIGIN.lat + north / 111_320, lng: ORIGIN.lng + east / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)) });

type Pt = { fixAt: Date; lat: number; lng: number; speedKmh: number; ignition: boolean };

/** A trail builder: points every 30 s, parked or driving in a straight line. */
function trailOf(script: (park: (min: number) => void, drive: (east: number, north: number, kmh?: number) => void) => void): Pt[] {
  const pts: Pt[] = [];
  let t = L('06:30').getTime();
  let pos = { east: 0, north: 0 };
  const park = (min: number) => {
    for (const end = t + min * 60_000; t < end; t += 30_000) pts.push({ fixAt: new Date(t), ...at(pos.east, pos.north), speedKmh: 0, ignition: true });
  };
  const drive = (east: number, north: number, kmh = 40) => {
    const dist = Math.hypot(east - pos.east, north - pos.north);
    const dur = (dist / (kmh / 3.6)) * 1000;
    const from = pos;
    for (let dt = 30_000; dt < dur; dt += 30_000) pts.push({ fixAt: new Date(t + dt), ...at(from.east + ((east - from.east) * dt) / dur, from.north + ((north - from.north) * dt) / dur), speedKmh: kmh, ignition: true });
    t += Math.max(30_000, Math.ceil(dur / 30_000) * 30_000);
    pos = { east, north };
  };
  script(park, drive);
  return pts;
}

let tenantId = '';
let depotId = '';
let userId = '';
let custSite = '';
let custBack = '';

/** A truck with one dispatched load to one customer, and its stored trail. */
async function truckDay(code: string, customerId: string, trail: Pt[]): Promise<{ truckId: string; loadId: string }> {
  const truck = await prisma.truck.create({ data: { tenantId, depotId, code, capacityCases: 500, ivmsImei: code === 'GS1' ? IMEI : null } });
  const run = await prisma.runPlan.create({ data: { tenantId, depotId, runDate: dayDate, createdById: userId, status: 'DISPATCHED' } });
  const load = await prisma.planLoad.create({
    data: { tenantId, runId: run.id, truckId: truck.id, loadNo: 1, departMin: 420, returnMin: 720, distanceKm: 12, durationMin: 60, cases: 10, weightKg: 0, utilizationPct: 5, status: 'DISPATCHED', statusChangedAt: L('06:55') },
  });
  const order = await prisma.order.create({ data: { tenantId, customerId, deliveryDate: dayDate, depotId, totalCases: 10 } });
  await prisma.routeAssignment.create({
    data: { runId: run.id, truckId: truck.id, loadId: load.id, orderId: order.id, sequenceInTruck: 1, plannedArrivalMin: 430, plannedDistanceFromPrevKm: 3, plannedLoadCases: 10, etaMin: 430, serviceStartMin: 430, departureMin: 470 },
  });
  await prisma.auditLog.create({ data: { tenantId, userId, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: load.id, createdAt: L('06:55') } });
  await prisma.truckTrailPoint.createMany({ data: trail.map((p) => ({ tenantId, truckId: truck.id, ...p })) });
  return { truckId: truck.id, loadId: load.id };
}

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `GPS site ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, ivmsMode: 'TIMES', timezone: 'Asia/Muscat' } });
  userId = (await prisma.user.create({ data: { tenantId, email: `admin@${slug}.test`, passwordHash: 'x', name: 'Admin', role: 'TENANT_ADMIN' } })).id;
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'GSD', name: 'Example depot', ...at(0) } })).id;
  custSite = (await prisma.customer.create({ data: { tenantId, code: 'TST0001', name: 'Shop Example Big Site', ...at(3000) } })).id;
  custBack = (await prisma.customer.create({ data: { tenantId, code: 'TST0002', name: 'Shop Example Return', ...at(3000, 3000) } })).id;
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('1. the CHECKs of migration 20261019120000_gps_site_radius_away', () => {
  it('Customer.siteRadiusM: NULL or 100-500 m', async () => {
    for (const v of [100, 500, null]) await expect(prisma.customer.update({ where: { id: custBack }, data: { siteRadiusM: v } })).resolves.toBeTruthy();
    for (const v of [99, 501, 0]) await expect(prisma.customer.update({ where: { id: custBack }, data: { siteRadiusM: v } }), String(v)).rejects.toThrow();
  });

  it('StopVisit.awayMinutes: NULL or more than 0', async () => {
    const v = await prisma.stopVisit.create({ data: { tenantId, depotId, deliveryDate: new Date(`${D.slice(0, 8)}01T00:00:00.000Z`), truckId: (await prisma.truck.create({ data: { tenantId, depotId, code: 'GCHK', capacityCases: 1 } })).id, loadNo: 9, sequence: 1, customerId: custBack, casesPlanned: 1, linesJson: [] } });
    for (const m of [12.5, null]) await expect(prisma.stopVisit.update({ where: { id: v.id }, data: { awayMinutes: m } })).resolves.toBeTruthy();
    for (const m of [0, -3]) await expect(prisma.stopVisit.update({ where: { id: v.id }, data: { awayMinutes: m } }), String(m)).rejects.toThrow();
  });
});

describe("2. a customer's site radius", () => {
  it('the truck at a second drop point 370 m from the pin is still at the customer: the departure is when it leaves the site', async () => {
    await prisma.customer.update({ where: { id: custSite }, data: { siteRadiusM: 400 } });
    const { truckId } = await truckDay(
      'GS1',
      custSite,
      trailOf((park, drive) => {
        park(30);
        drive(3000, 0);
        park(40);
        drive(3000, 370, 14);
        park(30);
        drive(6000, 370);
        park(10);
        drive(0, 0);
        park(20);
      }),
    );
    const r = await processGpsTimes(tenantId, truckId, D, new Date());
    expect(r).toMatchObject({ skipped: null, written: 2 });
    const ev = await prisma.stopEvent.findMany({ where: { tenantId, truckId, source: 'AYUN' }, orderBy: { at: 'asc' } });
    expect(ev.map((e) => e.kind)).toEqual(['ARRIVED', 'DEPARTED']);
    // Before the site radius the move to the second drop point (07:45) was the departure.
    expect(ev[1]!.at.getTime()).toBeGreaterThan(L('08:10').getTime());
    expect(ev[1]!.payloadJson).toMatchObject({ detector: 'ivms-v2', stay: { radiusM: 400, merged: 0, exitRule: 'FAST' } });
    const v = await prisma.stopVisit.findFirstOrThrow({ where: { tenantId, truckId } });
    expect(v).toMatchObject({ arrivalSource: 'AYUN', departureSource: 'AYUN', awayMinutes: null });
  });
});

describe('3. a leave-and-return under the driver\'s own times', () => {
  it('the departure of the stay holding the result, and the minutes away on the visit', async () => {
    const { truckId, loadId } = await truckDay(
      'GS2',
      custBack,
      trailOf((park, drive) => {
        park(30);
        drive(3000, 3000);
        park(20);
        drive(9000, 3000);
        park(30);
        drive(3000, 3000);
        park(40);
        drive(0, 0);
        park(20);
      }),
    );
    // The driver tapped the arrival at 07:16 and the result at 08:50 (in the second stay).
    const visit = await prisma.stopVisit.create({ data: { tenantId, depotId, deliveryDate: dayDate, truckId, loadNo: 1, sequence: 1, customerId: custBack, firstLoadId: loadId, casesPlanned: 10, linesJson: [] } });
    await prisma.stopEvent.createMany({
      data: [
        { tenantId, depotId, deliveryDate: dayDate, truckId, loadNo: 1, sequence: 1, visitId: visit.id, kind: 'ARRIVED', source: 'PHONE_MANUAL', at: L('07:16'), idempotencyKey: `dl:${uniqueSuffix()}`, payloadJson: { mode: 'MANUAL' } },
        { tenantId, depotId, deliveryDate: dayDate, truckId, loadNo: 1, sequence: 1, visitId: visit.id, kind: 'OUTCOME', source: 'PHONE_MANUAL', at: L('08:50'), idempotencyKey: `dl:${uniqueSuffix()}`, payloadJson: { outcome: 'DELIVERED' } },
      ],
    });
    await processGpsTimes(tenantId, truckId, D, new Date());
    const gps = await prisma.stopEvent.findMany({ where: { tenantId, truckId, source: 'AYUN' }, orderBy: { at: 'asc' } });
    expect(gps.map((e) => e.kind)).toEqual(['ARRIVED', 'DEPARTED', 'ARRIVED', 'DEPARTED']);
    const away = (gps[2]!.payloadJson as { stay: { awayMin: number } }).stay.awayMin;
    expect(away).toBeGreaterThan(35);
    const v = await prisma.stopVisit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(v).toMatchObject({ arrivalSource: 'PHONE_MANUAL', departureSource: 'AYUN', outcome: 'DELIVERED' });
    expect(v.departedAt!.getTime()).toBe(gps[3]!.at.getTime());
    expect(v.awayMinutes).toBe(away);
  });
});
