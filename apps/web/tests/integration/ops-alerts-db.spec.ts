/**
 * OPERATIONS ALERTS ON REAL POSTGRESQL (owner request 16 Oct 2026), library level: the sweep
 * (lib/alerts/sweep.ts) with Prisma, the migration's columns, CHECKs and unique key, and the company's
 * advisory lock. Needs DATABASE_URL (migrated); the web server and the solver are not used. A fixed
 * delivery day (10 Mar 2026, Asia/Muscat) with a fixed clock, so the real date never matters.
 *
 * Company A (alerts on since 06:00): T05 L1 dispatched 07:30, its driver page open, stop 1 (priority 1)
 * Not delivered by the driver 08:20, stop 2 planned 09:00 not reached; T07 L1 dispatched 07:00 with no
 * driver link; T09 L1 Locked, planned 08:00, not dispatched. Company B: the same kind of day, alerts off.
 *  1. At 09:40 the sweep raises ETA_LATE (T05), PRIORITY_NOT_DELIVERED (T05 stop 1), PAGE_NOT_OPENED (T07)
 *     and DEPART_LATE (T09), with the words, tiers and delivery the catalog gives; B gets nothing.
 *  2. Sweeping again (and twice at the same moment) adds no row: one per rule and subject.
 *  3. Dispatch of T09 closes DEPART_LATE with the press time; the result corrected to Delivered closes
 *     the priority alert as CORRECTED; T07's load gone from the plan closes its alert as NOT_IN_PLAN.
 *  4. The database refuses what the catalog refuses (CHECKs on severity, kind and tier) and a second row
 *     for the same rule and subject.
 * Invented names and codes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';
import { runAlertSweep, resetAlertSweepClock, sweepTenant, type AlertTenantConfig } from '@/lib/alerts/sweep';
import { zonedDayStart } from '@/lib/dispatch/time';

const TZ = 'Asia/Muscat';
const D = '2026-03-10';
const day = new Date(`${D}T00:00:00.000Z`);
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(zonedDayStart(D, TZ).getTime() + (h * 60 + m) * 60_000);
};

interface Co {
  slug: string;
  tenantId: string;
  userId: string;
  runId: string;
  loads: Record<string, string>;
  trucks: Record<string, string>;
}
const A: Co = { slug: `oa-a-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '', userId: '', runId: '', loads: {}, trucks: {} };
const B: Co = { slug: `oa-b-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '', userId: '', runId: '', loads: {}, trucks: {} };

async function seed(c: Co, alertsOn: boolean) {
  const t = await prisma.tenant.create({ data: { slug: c.slug, name: `Alerts ${c.slug}`, country: 'Oman' } });
  c.tenantId = t.id;
  const tenantId = t.id;
  await prisma.tenantConfig.create({
    data: { tenantId, timezone: TZ, distanceProvider: 'HAVERSINE', osrmUrl: null, alertsEnabled: alertsOn, alertsEnabledAt: alertsOn ? at('06:00') : null },
  });
  c.userId = (await prisma.user.create({ data: { tenantId, email: `planner@${c.slug}.test`, passwordHash: 'x', name: 'Planner Example', role: 'PLANNER' } })).id;
  const depotId = (await prisma.depot.create({ data: { tenantId, code: 'D1', name: 'Depot Example', lat: 24.95, lng: 59.55 } })).id;
  for (const code of ['T05', 'T07', 'T09']) c.trucks[code] = (await prisma.truck.create({ data: { tenantId, depotId, code, capacityCases: 400 } })).id;
  const driverId = (await prisma.driver.create({ data: { tenantId, code: 'DR1', name: 'Driver Example' } })).id;
  const cust = async (code: string, name: string) => (await prisma.customer.create({ data: { tenantId, code, name, branchKey: '__MAIN__', lat: 24.96, lng: 59.56, locationVerified: true } })).id;
  const c100 = await cust('C100', 'Hyper Example A');
  const c200 = await cust('C200', 'Shop Example B');
  const order = async (customerId: string, priority: number) => (await prisma.order.create({ data: { tenantId, customerId, depotId, deliveryDate: day, totalCases: 10, priority, status: 'DISPATCHED' } })).id;
  const o1 = await order(c100, 1);
  const o2 = await order(c200, 3);
  const o3 = await order(c200, 3);
  const o4 = await order(c200, 3);
  c.runId = (await prisma.runPlan.create({ data: { tenantId, depotId, runDate: day, status: 'READY', createdById: c.userId, reconciliationJson: { ok: true } } })).id;
  const load = async (truck: string, status: 'DISPATCHED' | 'LOCKED' | 'LOADING', departMin: number, changed: string, loadNo = 1) =>
    (
      await prisma.planLoad.create({
        data: { tenantId, runId: c.runId, truckId: c.trucks[truck]!, loadNo, status, departMin, returnMin: 720, distanceKm: 20, durationMin: 200, cases: 20, weightKg: 200, utilizationPct: 5, driverId, statusChangedAt: at(changed) },
      })
    ).id;
  c.loads.T05 = await load('T05', 'DISPATCHED', 450, '07:30');
  c.loads.T07 = await load('T07', 'DISPATCHED', 420, '07:00');
  c.loads.T09 = await load('T09', 'LOCKED', 480, '05:00');
  c.loads.T05L2 = await load('T05', 'LOADING', 780, '09:00', 2);
  const ra = (loadId: string, truck: string, orderId: string, seq: number, eta: number, loadNo = 1) =>
    prisma.routeAssignment.create({
      data: { runId: c.runId, truckId: c.trucks[truck]!, orderId, loadId, loadNo, sequenceInTruck: seq, orderInStop: 0, plannedArrivalMin: eta, plannedDistanceFromPrevKm: 5, plannedLoadCases: 10, etaMin: eta, serviceStartMin: eta, departureMin: eta + 20 },
    });
  await ra(c.loads.T05!, 'T05', o1, 1, 480);
  await ra(c.loads.T05!, 'T05', o2, 2, 540);
  await ra(c.loads.T07!, 'T07', o3, 1, 480);
  await ra(c.loads.T09!, 'T09', o4, 1, 520);
  // T05: the driver page open; stop 1 Not delivered by the driver at 08:20.
  await prisma.driverLink.create({
    data: { tenantId, truckId: c.trucks.T05!, deliveryDate: day, salt: 'salt', keyId: 'k1', tokenHash: `hash-${c.slug}`, expiresAt: at('23:59'), lastSeenAt: at('07:35') },
  });
  const visit = await prisma.stopVisit.create({
    data: {
      tenantId, depotId, deliveryDate: day, truckId: c.trucks.T05!, loadNo: 1, sequence: 1, customerId: c100, linesJson: [], casesPlanned: 10, plannedServiceMin: 20, plannedEtaMin: 480,
      arrivedAt: at('08:00'), arrivalSource: 'PHONE_MANUAL', departedAt: at('08:20'), departedAtOutcome: true,
      outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', reasonNote: 'closed, call 8123 4567', outcomeAt: at('08:20'), outcomeSource: 'PHONE_MANUAL', casesDelivered: 0,
    },
  });
  await prisma.stopEvent.create({
    data: { tenantId, depotId, deliveryDate: day, truckId: c.trucks.T05!, loadNo: 1, sequence: 1, visitId: visit.id, kind: 'OUTCOME', source: 'PHONE_MANUAL', at: at('08:20'), receivedAt: at('08:20'), idempotencyKey: `dl:${c.slug}-1` },
  });
}

const cfgOf = async (c: Co) => (await prisma.tenantConfig.findFirstOrThrow({ where: { tenantId: c.tenantId } })) as unknown as AlertTenantConfig;
const rows = (c: Co) => prisma.opsAlert.findMany({ where: { tenantId: c.tenantId }, orderBy: [{ rule: 'asc' }, { subjectKey: 'asc' }] });

beforeAll(async () => {
  await seed(A, true);
  await seed(B, false);
}, 60_000);

afterAll(async () => {
  await cleanupTenant(A.slug);
  await cleanupTenant(B.slug);
}, 60_000);

describe('operations alerts on the real database', () => {
  it('1. at 09:40 the sweep raises the four alerts of company A; company B (alerts off) gets nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetAlertSweepClock();
    const report = await runAlertSweep(at('09:40'), { force: true });
    expect(report!.failed).toBe(0);
    const a = await rows(A);
    expect(a.map((r) => r.rule)).toEqual(['DEPART_LATE', 'ETA_LATE', 'PAGE_NOT_OPENED', 'PRIORITY_NOT_DELIVERED']);
    const by = Object.fromEntries(a.map((r) => [r.rule, r]));
    expect(by.ETA_LATE).toMatchObject({ kind: 'CONDITION', tier: 1, severity: 'WARN', value: 40, threshold: 30, truckCode: 'T05', loadNo: 1, resolvedAt: null, ackedAt: null, mayToast: true, mayEmail: true });
    expect(by.ETA_LATE!.text).toMatch(/^T05 L1 is running about 40 min late: next stop 2 Shop Example B \(C200\) not reached yet \(planned 09:00\)/);
    expect(by.PRIORITY_NOT_DELIVERED).toMatchObject({ kind: 'EVENT', tier: 2, severity: 'HIGH', sequence: 1, resolvedAt: null });
    expect(by.PRIORITY_NOT_DELIVERED!.text).toContain('Note: "closed, call [number]"');
    expect(by.PAGE_NOT_OPENED).toMatchObject({ truckCode: 'T07', loadNo: null, tier: 1 });
    expect(by.DEPART_LATE).toMatchObject({ truckCode: 'T09', tier: 3, severity: 'HIGH', value: 100 });
    expect(by.DEPART_LATE!.occurredAt).toEqual(at('08:30'));
    expect(await rows(B)).toEqual([]);
  });

  it('2. sweeping again, and twice at the same moment, adds no row', async () => {
    const before = (await rows(A)).map((r) => r.id).sort();
    const cfg = await cfgOf(A);
    expect(await sweepTenant(cfg, at('09:42'))).toMatchObject({ raised: 0, history: 0 });
    const both = await Promise.all([sweepTenant(cfg, at('09:44')), sweepTenant(cfg, at('09:44'))]);
    // One of them may find the company's alert lock busy (null).
    for (const r of both) if (r) expect(r.raised).toBe(0);
    expect((await rows(A)).map((r) => r.id).sort()).toEqual(before);
  });

  it('3. a dispatch, a corrected result and a load gone from the plan close their rows with their own words', async () => {
    const cfg = await cfgOf(A);
    await prisma.planLoad.update({ where: { id: A.loads.T09 }, data: { status: 'DISPATCHED', statusChangedAt: at('09:45') } });
    await prisma.stopVisit.updateMany({ where: { tenantId: A.tenantId, sequence: 1, loadNo: 1, truckId: A.trucks.T05 }, data: { outcome: 'DELIVERED', outcomeSource: 'DISPATCHER', reason: null } });
    await prisma.routeAssignment.deleteMany({ where: { loadId: A.loads.T07 } });
    await prisma.planLoad.delete({ where: { id: A.loads.T07 } });
    const r = await sweepTenant(cfg, at('09:46'));
    expect(r!.resolved).toMatchObject({ ENDED: 1, CORRECTED: 1, NOT_IN_PLAN: 1 });
    const by = Object.fromEntries((await rows(A)).map((x) => [`${x.rule}:${x.truckCode}`, x]));
    expect(by['DEPART_LATE:T09']).toMatchObject({ resolvedReason: 'ENDED', text: 'T09 L1 dispatched 09:45, 1 h 45 min after the planned 08:00.' });
    expect(by['PRIORITY_NOT_DELIVERED:T05']).toMatchObject({ resolvedReason: 'CORRECTED' });
    expect(by['PRIORITY_NOT_DELIVERED:T05']!.text).toContain('now Delivered (dispatcher');
    expect(by['PAGE_NOT_OPENED:T07']).toMatchObject({ resolvedReason: 'NOT_IN_PLAN' });
    expect(by['PAGE_NOT_OPENED:T07']!.text).toMatch(/\(no longer in the plan\)$/);
    // T09 is now out without a driver page: its own one WARN, raised once.
    expect(by['PAGE_NOT_OPENED:T09']).toMatchObject({ resolvedAt: null, tier: 1 });
    expect(by['ETA_LATE:T05']!.resolvedAt).toBeNull();
  });

  it('4. the database refuses what the catalog refuses, and a second row for the same rule and subject', async () => {
    const base = {
      tenantId: A.tenantId, depotId: 'D1', deliveryDate: day, rule: 'ETA_LATE', subjectKey: `x|${D}|y|9`, truckId: 'y', truckCode: 'T99', kind: 'CONDITION', severity: 'WARN', tier: 1, value: 1, threshold: 1, text: 'test', occurredAt: at('09:00'),
    };
    await expect(prisma.opsAlert.create({ data: { ...base, severity: 'LOW' } })).rejects.toThrow();
    await expect(prisma.opsAlert.create({ data: { ...base, kind: 'OTHER' } })).rejects.toThrow();
    await expect(prisma.opsAlert.create({ data: { ...base, tier: 4 } })).rejects.toThrow();
    const ok = await prisma.opsAlert.create({ data: base });
    await expect(prisma.opsAlert.create({ data: base })).rejects.toThrow();
    // A rule code the app does not know yet is accepted (checked in the app: a new rule needs no migration).
    await prisma.opsAlert.create({ data: { ...base, rule: 'SOME_FUTURE_RULE' } });
    await prisma.opsAlert.deleteMany({ where: { tenantId: A.tenantId, subjectKey: base.subjectKey } });
    expect(ok.id).toBeTruthy();
    // The settings CHECKs (bounds of lib/alerts/catalog.ts).
    await expect(prisma.tenantConfig.update({ where: { tenantId: A.tenantId }, data: { alertEtaLateMin: 5 } })).rejects.toThrow();
    await expect(prisma.tenantConfig.update({ where: { tenantId: A.tenantId }, data: { alertQuietFromMin: 600, alertQuietToMin: null } })).rejects.toThrow();
  });
});
