/**
 * GPS ALERTS (owner request 18 Oct 2026: "build GPS alerts"; GPS tracking mode ALERTS) on real PostgreSQL,
 * library level: the alert sweep (lib/alerts/sweep.ts sweepTenant) reading the IVMS rows through
 * lib/alerts/facts.ts (IvmsTruckDay, TruckPosition, IvmsEvent, TruckTrailPoint and the AYUN StopEvents).
 * Needs DATABASE_URL (migrated, with 20261018120000_ivms_alerts_mode and 20261018130000_ivms_move_observed); the web server and the solver are
 * not used, and no call is made to Ayun. A fixed delivery day (10 Mar 2026, Asia/Muscat) with a fixed
 * clock. Invented data only: truck T-100, a depot and a shop at made-up coordinates near 10.0001 / 20.0002.
 *
 * Three companies with the same day: T-100 L1 dispatched 07:00, one stop planned 07:30 for 20 min, the
 * driver page open, no tap at the stop; the GPS history gave the stop an arrival at 08:00 and a departure
 * at 09:20 (observed), and the trail-confirmed depot OUT 07:05 and IN 09:40 (exact, as the stop detector
 * stored them: IvmsEvent.observed - the trail points are deleted by then, review of 18 Oct 2026, finding 6);
 * planned back 09:00; the latest live fix at 11:09 at the depot. Alerts on since 06:00.
 *  1. Company A in ALERTS: at 11:10 the sweep keeps one UNLOAD_OVER history row naming GPS (1 h 20 min,
 *     GPS arrival and departure), and LOAD_NOT_CLOSED says the truck is back at the depot by GPS.
 *  2. Company B in TIMES: the same rows read without GPS: no unloading alert at all (a GPS-only visit is
 *     none), and LOAD_NOT_CLOSED has no Back at depot.
 *  3. Company C in ALERTS with the truck-day's GPS suppressed: as B.
 * The database accepts the mode ALERTS (the seed itself) and still refuses junk, and keeps a move's
 * exactness only on a move from the trail (CHECK "IvmsEvent_observed_trail_only").
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';
import { sweepTenant, type AlertTenantConfig } from '@/lib/alerts/sweep';
import { zonedDayStart } from '@/lib/dispatch/time';

const TZ = 'Asia/Muscat';
const D = '2026-03-10';
const day = new Date(`${D}T00:00:00.000Z`);
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(zonedDayStart(D, TZ).getTime() + (h * 60 + m) * 60_000);
};
const DEPOT = { lat: 10.0001, lng: 20.0002 };
const SHOP = { lat: 10.01, lng: 20.01 };

interface Co {
  slug: string;
  tenantId: string;
}
const A: Co = { slug: `ga-a-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '' };
const B: Co = { slug: `ga-b-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '' };
const C: Co = { slug: `ga-c-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '' };

async function seed(c: Co, mode: 'TIMES' | 'ALERTS', suppressed = false) {
  const t = await prisma.tenant.create({ data: { slug: c.slug, name: `GPS alerts ${c.slug}`, country: 'Oman' } });
  c.tenantId = t.id;
  const tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: TZ, distanceProvider: 'HAVERSINE', osrmUrl: null, alertsEnabled: true, alertsEnabledAt: at('06:00'), ivmsMode: mode } });
  const userId = (await prisma.user.create({ data: { tenantId, email: `planner@${c.slug}.test`, passwordHash: 'x', name: 'Planner Example', role: 'PLANNER' } })).id;
  const depotId = (await prisma.depot.create({ data: { tenantId, code: 'D1', name: 'Depot Example', ...DEPOT } })).id;
  const truckId = (await prisma.truck.create({ data: { tenantId, depotId, code: 'T-100', capacityCases: 400 } })).id;
  const driverId = (await prisma.driver.create({ data: { tenantId, code: 'DR1', name: 'Driver Example' } })).id;
  const customerId = (await prisma.customer.create({ data: { tenantId, code: 'C100', name: 'Shop Example A', branchKey: '__MAIN__', ...SHOP, locationVerified: true } })).id;
  const orderId = (await prisma.order.create({ data: { tenantId, customerId, depotId, deliveryDate: day, totalCases: 10, priority: 3, status: 'DISPATCHED' } })).id;
  const runId = (await prisma.runPlan.create({ data: { tenantId, depotId, runDate: day, status: 'READY', createdById: userId, reconciliationJson: { ok: true } } })).id;
  const loadId = (
    await prisma.planLoad.create({
      data: { tenantId, runId, truckId, loadNo: 1, status: 'DISPATCHED', departMin: 420, returnMin: 540, distanceKm: 20, durationMin: 80, cases: 10, weightKg: 100, utilizationPct: 3, driverId, statusChangedAt: at('07:00'), createdAt: at('04:00') },
    })
  ).id;
  await prisma.routeAssignment.create({
    data: { runId, truckId, orderId, loadId, loadNo: 1, sequenceInTruck: 1, orderInStop: 0, plannedArrivalMin: 450, plannedDistanceFromPrevKm: 2, plannedLoadCases: 10, etaMin: 450, serviceStartMin: 450, departureMin: 470 },
  });
  await prisma.driverLink.create({ data: { tenantId, truckId, deliveryDate: day, salt: 'salt', keyId: 'k1', tokenHash: `hash-${c.slug}`, expiresAt: at('23:59'), lastSeenAt: at('07:05') } });
  // What the GPS writer (lib/ivms/stop-events.ts) leaves: the AYUN events and the visit rebuilt with them.
  const visit = await prisma.stopVisit.create({
    data: {
      tenantId, depotId, deliveryDate: day, truckId, loadNo: 1, sequence: 1, customerId, linesJson: [], casesPlanned: 10, plannedServiceMin: 20, plannedEtaMin: 450, ...{ plannedLat: SHOP.lat, plannedLng: SHOP.lng },
      arrivedAt: at('08:00'), arrivalSource: 'AYUN', arrivalObserved: true, arrivalDistanceM: 30, departedAt: at('09:20'), departureSource: 'AYUN', departedAtOutcome: false,
    },
  });
  const gpsEvent = (kind: 'ARRIVED' | 'DEPARTED', hhmm: string, received: string) =>
    prisma.stopEvent.create({
      data: {
        tenantId, depotId, deliveryDate: day, truckId, loadNo: 1, sequence: 1, visitId: visit.id, kind, source: 'AYUN', at: at(hhmm), receivedAt: at(received), distanceM: 30,
        idempotencyKey: `ayun:${kind[0]}:${c.slug}:${hhmm}`, payloadJson: { observed: true, detector: 'ivms-v1', segmentStartAt: at('08:00').toISOString() },
      },
    });
  await gpsEvent('ARRIVED', '08:00', '09:05');
  await gpsEvent('DEPARTED', '09:20', '10:05');
  await prisma.ivmsTruckDay.create({ data: { tenantId, truckId, deliveryDate: day, pulledTo: at('10:00'), lastPullAt: at('10:05'), processedAt: at('10:05'), pulls: 3, ...(suppressed ? { suppressedAt: at('10:10'), suppressReason: 'UNDO' } : {}) } });
  // The detector stored both moves as exact; no trail point is left (the retention deleted them).
  const move = (kind: 'DEPOT_OUT' | 'DEPOT_IN', hhmm: string) =>
    prisma.ivmsEvent.create({ data: { tenantId, truckId, depotId, kind, origin: 'TRAIL', eventAt: at(hhmm), receivedAt: at('10:05'), processedAt: at('10:05'), outcome: 'USED', observed: true, dedupeKey: `ayun:t:${c.slug}:${kind}:${hhmm}`.slice(0, 64), ...DEPOT } });
  await move('DEPOT_OUT', '07:05');
  await move('DEPOT_IN', '09:40');
  await prisma.truckPosition.create({ data: { tenantId, truckId, fixAt: at('11:09'), receivedAt: at('11:09'), ...DEPOT, speedKmh: 0, flags: [], movedAt: at('09:40') } });
}

const cfgOf = async (c: Co) => (await prisma.tenantConfig.findFirstOrThrow({ where: { tenantId: c.tenantId } })) as unknown as AlertTenantConfig;
const rows = (c: Co) => prisma.opsAlert.findMany({ where: { tenantId: c.tenantId }, orderBy: [{ rule: 'asc' }, { subjectKey: 'asc' }] });

beforeAll(async () => {
  vi.stubEnv('ROUTEIQ_DISABLE_IVMS', '');
  await seed(A, 'ALERTS');
  await seed(B, 'TIMES');
  await seed(C, 'ALERTS', true);
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await cleanupTenant(A.slug);
  await cleanupTenant(B.slug);
  await cleanupTenant(C.slug);
}, 60_000);

describe('GPS alerts on the real database', () => {
  it('1. ALERTS: the unloading GPS timed is one history row naming GPS; the truck back at the depot by GPS', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await sweepTenant(await cfgOf(A), at('11:10'));
    expect(r).not.toBeNull();
    const a = await rows(A);
    const unload = a.find((x) => x.rule === 'UNLOAD_OVER');
    expect(unload).toMatchObject({ truckCode: 'T-100', sequence: 1, tier: 1, value: 60, resolvedReason: 'ENDED' });
    expect(unload!.resolvedAt).not.toBeNull();
    expect(unload!.text).toBe('T-100 L1 stop 1 Shop Example A (C100): unloading took 1 h 20 min (GPS arrival and departure), planned 20 min (1 h over).');
    expect(unload!.factsJson).toMatchObject({ gps: true });
    const notClosed = a.find((x) => x.rule === 'LOAD_NOT_CLOSED');
    expect(notClosed?.text).toMatch(/planned back 09:00, back at the depot at 09:40 \(GPS\), 1 of 1 stop without a result/);
    // The live position is never in a text.
    for (const x of a) expect(x.text).not.toMatch(/10\.0|20\.0/);
  });

  it('2. TIMES: the same day without GPS - no unloading alert, no Back at depot', async () => {
    await sweepTenant(await cfgOf(B), at('11:10'));
    const b = await rows(B);
    expect(b.find((x) => x.rule === 'UNLOAD_OVER')).toBeUndefined();
    expect(b.find((x) => x.rule === 'LOAD_NOT_CLOSED')?.text).toMatch(/no Back at depot, 1 of 1 stop without a result/);
    for (const x of b) expect(x.text).not.toContain('(GPS)');
  });

  it('3. ALERTS with the truck-day suppressed: read as with the link off', async () => {
    await sweepTenant(await cfgOf(C), at('11:10'));
    const c = await rows(C);
    expect(c.find((x) => x.rule === 'UNLOAD_OVER')).toBeUndefined();
    for (const x of c) expect(x.text).not.toContain('(GPS)');
  });

  it('the database takes the mode ALERTS and still refuses junk', async () => {
    const refused = async (mode: string) => {
      try {
        await prisma.tenantConfig.update({ where: { tenantId: B.tenantId }, data: { ivmsMode: mode } });
        return false;
      } catch {
        return true;
      }
    };
    expect(await refused('ALERTS')).toBe(false);
    for (const junk of ['alerts', 'GPS', '']) expect(await refused(junk), junk).toBe(true);
    await prisma.tenantConfig.update({ where: { tenantId: B.tenantId }, data: { ivmsMode: 'TIMES' } });
  });

  it('a depot move keeps whether its time is exact only when it comes from the trail (migration 20261018130000_ivms_move_observed)', async () => {
    const truck = await prisma.truck.findFirstOrThrow({ where: { tenantId: B.tenantId }, select: { id: true } });
    const zoneMove = (observed: boolean | null) =>
      prisma.ivmsEvent.create({
        data: { tenantId: B.tenantId, truckId: truck.id, kind: 'DEPOT_IN', origin: 'WEBHOOK', eventAt: at('12:00'), outcome: 'USED', observed, dedupeKey: `ayun:z:${B.slug}:${String(observed)}`.slice(0, 64) },
      });
    await expect(zoneMove(true)).rejects.toThrow();
    await expect(zoneMove(null)).resolves.toMatchObject({ observed: null });
    const trail = await prisma.ivmsEvent.findMany({ where: { tenantId: B.tenantId, origin: 'TRAIL' }, select: { observed: true } });
    expect(trail.map((e) => e.observed)).toEqual([true, true]);
  });
});
