/**
 * THE ANALYSIS DATASET (owner request 19 Oct 2026: "build on more data for our analysis later and
 * improvement") on real PostgreSQL, library level: the nightly job (lib/analysis/job.ts) with its real reader
 * (the plan in use, the stops, the visits, the events, the trail), the database's own keys and CHECKs
 * (migration 20261019090000_analysis_facts), the retention (lib/ivms/retention.ts purgeAnalysisFacts) and the
 * export route (GET /api/analysis/export) called in the test process with the session faked. Needs
 * DATABASE_URL (migrated); the web server and the solver are not used, and no call is made to Ayun. Invented
 * data only: the vendor documentation's dummy IMEI, a depot and shops in empty desert near 20.1, 55.1.
 *
 *  1. At 03:10 the day after, company A's truck-day (a tracker, a trail) is built with its GPS site facts and
 *     legs; company B's (no tracker) without GPS. A second run the same night writes nothing.
 *  2. The next nights a result corrected by the office is refreshed; the trail pulled again after the build
 *     (IvmsTruckDay.lastPullAt) and still whole gives the GPS columns again, and with the trail gone (the
 *     retention) they stay as they are. The 4th night freezes the rows; a frozen row is never written again.
 *  3. The CHECKs: no negative unloading, flags and sources from their lists (PARTIAL_TRAIL among the GPS
 *     notes), JSON arrays only, the retention 30-3650 days.
 *  4. The retention deletes facts older than analysisRetentionDays, of that company only.
 *  5. The export: PLANNER gets company A's facts only; VIEWER 403.
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => (session.user ? { user: session.user } : null)) }));

import { prisma as libPrisma } from '@/lib/db';
import { GET } from '@/app/api/analysis/export/route';
import { _resetAnalysisJobState, runAnalysisJob } from '@/lib/analysis/job';
import { purgeAnalysisFacts } from '@/lib/ivms/retention';
import { DETECTOR_VERSION } from '@/lib/ivms/types';
import { addDaysIso } from '@/lib/dispatch/time';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const IMEI = '111111111111111';
const slugA = `anfa-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
const slugB = `anfb-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
/** A delivery day 25 days ago; the job is run with its own clock (the nights after it). */
const D = new Date(Date.now() + 4 * 3600_000 - 25 * 86_400_000).toISOString().slice(0, 10);
const dayDate = new Date(`${D}T00:00:00.000Z`);
const L = (hhmm: string, sec = 0) => new Date(Date.parse(`${D}T${hhmm}:00+04:00`) + sec * 1000);
/** 03:10 company time n nights after D. */
const night = (n: number) => new Date(Date.parse(`${addDaysIso(D, n)}T03:10:00+04:00`));
const ORIGIN = { lat: 20.1, lng: 55.1 };
const at = (east: number) => ({ lat: ORIGIN.lat, lng: ORIGIN.lng + east / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)) });

interface Company {
  tenantId: string;
  userId: string;
  truckId: string;
  depotId: string;
}
let A: Company;
let B: Company;

/** At the depot 06:30-07:00, 40 km/h to stop 1 (3 km), 10 min there, to stop 2 (6 km), 8 min there, back, 20 min at the depot. */
function trail(): { fixAt: Date; lat: number; lng: number; speedKmh: number; ignition: null }[] {
  const pts: { fixAt: Date; lat: number; lng: number; speedKmh: number; ignition: null }[] = [];
  let t = L('06:30').getTime();
  let pos = 0;
  const park = (min: number) => {
    for (const end = t + min * 60_000; t < end; t += 30_000) pts.push({ fixAt: new Date(t), ...at(pos), speedKmh: 0, ignition: null });
  };
  const drive = (to: number) => {
    const dur = (Math.abs(to - pos) / (40 / 3.6)) * 1000;
    const from = pos;
    for (let dt = 30_000; dt < dur; dt += 30_000) pts.push({ fixAt: new Date(t + dt), ...at(from + ((to - from) * dt) / dur), speedKmh: 40, ignition: null });
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

async function company(slug: string, tracked: boolean, truckCode: string): Promise<Company> {
  const t = await prisma.tenant.create({ data: { slug, name: `Analysis ${slug}`, country: 'Oman' } });
  await prisma.tenantConfig.create({ data: { tenantId: t.id, ivmsMode: tracked ? 'TIMES' : 'OFF', timezone: 'Asia/Muscat' } });
  const user = await prisma.user.create({ data: { tenantId: t.id, email: `admin@${slug}.test`, passwordHash: 'x', name: 'Admin', role: 'TENANT_ADMIN' } });
  const depot = await prisma.depot.create({ data: { tenantId: t.id, code: 'AD1', name: 'Example depot', ...at(0) } });
  const truck = await prisma.truck.create({ data: { tenantId: t.id, depotId: depot.id, code: truckCode, capacityCases: 500, ...(tracked ? { ivmsImei: IMEI } : {}) } });
  const custs = [
    await prisma.customer.create({ data: { tenantId: t.id, code: 'TST0001', name: 'Shop Example One', ...at(3000) } }),
    await prisma.customer.create({ data: { tenantId: t.id, code: 'TST0002', name: 'Shop Example Two', ...at(6000) } }),
  ];
  const run = await prisma.runPlan.create({ data: { tenantId: t.id, depotId: depot.id, runDate: dayDate, createdById: user.id, status: 'DISPATCHED' } });
  const load = await prisma.planLoad.create({
    data: { tenantId: t.id, runId: run.id, truckId: truck.id, loadNo: 1, departMin: 420, returnMin: 480, distanceKm: 12, returnLegKm: 6, durationMin: 60, cases: 20, weightKg: 0, utilizationPct: 5, status: 'COMPLETED', statusChangedAt: L('08:00') },
  });
  const taps = [
    { arrived: L('07:05'), result: L('07:13') },
    { arrived: L('07:20'), result: L('07:26') },
  ];
  for (const [i, c] of custs.entries()) {
    const order = await prisma.order.create({ data: { tenantId: t.id, customerId: c.id, deliveryDate: dayDate, depotId: depot.id, totalCases: 10 } });
    await prisma.routeAssignment.create({
      data: { runId: run.id, truckId: truck.id, loadId: load.id, orderId: order.id, sequenceInTruck: i + 1, plannedArrivalMin: 430 + i * 20, plannedDistanceFromPrevKm: 3, plannedLoadCases: 10, etaMin: 430 + i * 20, serviceStartMin: 430 + i * 20, departureMin: 440 + i * 20 },
    });
    const visit = await prisma.stopVisit.create({
      data: {
        tenantId: t.id, depotId: depot.id, deliveryDate: dayDate, truckId: truck.id, loadNo: 1, sequence: i + 1, customerId: c.id, firstLoadId: load.id, casesPlanned: 10, linesJson: [],
        plannedLat: c.lat, plannedLng: c.lng, arrivedAt: taps[i]!.arrived, arrivalSource: 'PHONE_MANUAL', departedAt: taps[i]!.result, departureSource: 'PHONE_MANUAL', departedAtOutcome: true,
        outcome: 'DELIVERED', outcomeAt: taps[i]!.result, outcomeSource: 'PHONE_MANUAL', casesDelivered: 10,
      },
    });
    await prisma.stopEvent.create({ data: { tenantId: t.id, depotId: depot.id, deliveryDate: dayDate, truckId: truck.id, loadNo: 1, sequence: i + 1, visitId: visit.id, kind: 'ARRIVED', source: 'PHONE_MANUAL', at: taps[i]!.arrived, idempotencyKey: `dl:${uniqueSuffix()}-a${i}`, payloadJson: { mode: 'MANUAL' } } });
    await prisma.stopEvent.create({ data: { tenantId: t.id, depotId: depot.id, deliveryDate: dayDate, truckId: truck.id, loadNo: 1, sequence: i + 1, visitId: visit.id, kind: 'OUTCOME', source: 'PHONE_MANUAL', at: taps[i]!.result, idempotencyKey: `dl:${uniqueSuffix()}-o${i}`, payloadJson: { outcome: 'DELIVERED' } } });
  }
  await prisma.auditLog.create({ data: { tenantId: t.id, userId: user.id, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: load.id, createdAt: L('06:55') } });
  if (tracked) await prisma.truckTrailPoint.createMany({ data: trail().map((p) => ({ tenantId: t.id, truckId: truck.id, ...p })) });
  return { tenantId: t.id, userId: user.id, truckId: truck.id, depotId: depot.id };
}

const run = (n: number) => {
  _resetAnalysisJobState();
  return runAnalysisJob(night(n), { force: true, tenantIds: [A.tenantId, B.tenantId] });
};
const facts = (c: Company) =>
  Promise.all([
    prisma.factTruckDay.findMany({ where: { tenantId: c.tenantId } }),
    prisma.factVisit.findMany({ where: { tenantId: c.tenantId }, orderBy: { sequence: 'asc' } }),
    prisma.factLeg.findMany({ where: { tenantId: c.tenantId }, orderBy: { legNo: 'asc' } }),
  ]);

beforeAll(async () => {
  A = await company(slugA, true, 'T-100');
  B = await company(slugB, false, 'T-200');
});

afterAll(async () => {
  await cleanupTenant(slugA);
  await cleanupTenant(slugB);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('1-2. the nightly job on PostgreSQL', () => {
  it('builds the day before at 03:10: GPS site facts for the tracked truck, none for the other; a second run writes nothing', async () => {
    const r = await run(1);
    expect(r).toMatchObject({ tenants: 2, built: 2, refreshed: 0, failed: 0, unfinished: false });
    const [[dayA], visitsA, legsA] = await facts(A);
    expect(dayA).toMatchObject({ truckCode: 'T-100', tracked: true, loads: 1, stopsPlanned: 2, delivered: 2, gpsNote: null, lastInFrom: 'TRAIL', frozenAt: null, analysisVersion: 'analysis-v1', detectorVersion: DETECTOR_VERSION });
    expect(dayA!.kmGps).toBeGreaterThan(10);
    expect(dayA!.gpsBuiltAt).toEqual(night(1));
    expect(visitsA.map((v) => [v.sequence, v.customerCode, v.unloadSource])).toEqual([
      [1, 'TST0001', 'GPS_SITE'],
      [2, 'TST0002', 'GPS_SITE'],
    ]);
    expect(visitsA[0]!.siteStartAt!.getTime()).toBeLessThanOrEqual(L('07:05').getTime());
    expect(visitsA[0]!.unloadVisitMin).toBe(8);
    expect(visitsA.every((v) => v.lateResultTap === false && v.visitId)).toBe(true);
    expect(legsA.map((l) => [l.fromSeq, l.toSeq])).toEqual([
      [null, 1],
      [1, 2],
      [2, null],
    ]);
    expect(legsA[1]!.kmGps).toBeGreaterThan(2);
    const [[dayB], visitsB] = await facts(B);
    expect(dayB).toMatchObject({ truckCode: 'T-200', tracked: false, gpsNote: 'NO_TRACKER', kmGps: null, gpsBuiltAt: null });
    expect(visitsB.every((v) => v.flags.includes('NO_GPS') && v.unloadSource === 'VISIT')).toBe(true);
    // The same night again: nothing written.
    const before = await facts(A);
    expect(await run(1)).toMatchObject({ built: 0, refreshed: 0, frozen: 0 });
    expect(await facts(A)).toEqual(before);
  });

  it('the next nights refresh what does not come from the trail (pulled again while whole: computed again; the trail gone: copied); the 4th night freezes; frozen is never written again', async () => {
    const [[day1], built] = await facts(A);
    // The poller pulled the truck-day's trail again after the 03:10 build (its final pull, the morning after):
    // the first refresh computes the GPS columns again from it, with the settings of the build (review of 19 Oct 2026).
    await prisma.ivmsTruckDay.create({ data: { tenantId: A.tenantId, truckId: A.truckId, deliveryDate: dayDate, pulledTo: night(1), lastPullAt: new Date(night(1).getTime() + 6 * 3600_000), pulls: 2 } });
    await prisma.stopVisit.updateMany({ where: { tenantId: A.tenantId, sequence: 2 }, data: { outcome: 'PARTLY_DELIVERED', casesDelivered: 5, outcomeSource: 'DISPATCHER' } });
    expect(await run(2)).toMatchObject({ built: 0, refreshed: 2, frozen: 0 });
    const [[day2], v2] = await facts(A);
    expect(v2[1]).toMatchObject({ outcome: 'PARTLY_DELIVERED', casesDelivered: 5, refreshedAt: night(2), builtAt: night(1), gpsBuiltAt: night(2) });
    for (const k of ['siteStartAt', 'siteEndAt', 'unloadSiteMin', 'substays', 'truckDistAtResultM'] as const) expect(v2[1]![k], k).toEqual(built[1]![k]);
    expect(day2).toMatchObject({ gpsBuiltAt: night(2), kmGps: day1!.kmGps, firstOutAt: day1!.firstOutAt });
    // The trail gone (the retention): the next nights copy the GPS columns as they are.
    await prisma.truckTrailPoint.deleteMany({ where: { tenantId: A.tenantId } });
    expect(await run(3)).toMatchObject({ refreshed: 2, frozen: 0 });
    expect((await facts(A))[0][0]).toMatchObject({ gpsBuiltAt: night(2), kmGps: day1!.kmGps });
    expect(await run(4)).toMatchObject({ refreshed: 2, frozen: 2 });
    const frozen = await facts(A);
    expect(frozen.flat().every((r) => r.frozenAt?.getTime() === night(4).getTime())).toBe(true);
    await prisma.stopVisit.updateMany({ where: { tenantId: A.tenantId, sequence: 2 }, data: { outcome: 'NOT_DELIVERED', casesDelivered: 0 } });
    expect(await run(5)).toMatchObject({ built: 0, refreshed: 0 });
    expect(await facts(A)).toEqual(frozen);
  });
});

describe('3. the CHECKs of 20261019090000_analysis_facts', () => {
  const visit = (extra: Record<string, unknown>) =>
    prisma.factVisit.create({
      data: {
        tenantId: A.tenantId, depotId: A.depotId, deliveryDate: new Date('2026-01-05T00:00:00Z'), truckId: A.truckId, loadNo: 9, sequence: 1, customerId: 'c', truckCode: 'T-100', customerCode: 'TST0001',
        casesPlanned: 1, serviceMinPerCase: 0, reloadMinutes: 30, stopRadiusM: 100, dwellMin: 3, detectorVersion: 'ivms-v1', analysisVersion: 'analysis-v1', builtAt: new Date(), refreshedAt: new Date(),
        ...extra,
      } as never,
    });
  it('no negative unloading or wait, flags and the unload source from their lists, JSON arrays only', async () => {
    await expect(visit({ unloadVisitMin: -49.6 })).rejects.toThrow(/FactVisit_minutes_nonneg/);
    await expect(visit({ waitMin: -1 })).rejects.toThrow(/FactVisit_minutes_nonneg/);
    await expect(visit({ flags: ['SOMETHING_ELSE'] })).rejects.toThrow(/FactVisit_flags_check/);
    await expect(visit({ unloadSource: 'GUESS' })).rejects.toThrow(/FactVisit_unloadSource_check/);
    await expect(visit({ substaysJson: { distM: 10 } })).rejects.toThrow(/FactVisit_substaysJson_shape/);
    await expect(visit({ frozenAt: new Date(Date.now() - 86_400_000) })).rejects.toThrow(/FactVisit_frozen_after_built/);
    const ok = await visit({ flags: ['PIN_OFFSET'], unloadVisitMin: 0, substaysJson: [{ startOffsetSec: 0, minutes: 2, distM: 150, bearingDeg: 90 }] });
    await prisma.factVisit.delete({ where: { id: ok.id } });
  });

  it('the truck-day lists, and the retention setting 30-3650 days', async () => {
    const base = {
      tenantId: A.tenantId, depotId: A.depotId, deliveryDate: new Date('2026-01-05T00:00:00Z'), truckId: 'no-such-truck', truckCode: 'T-100', loads: 0, stopsPlanned: 0, stopsWithResult: 0, delivered: 0,
      partlyDelivered: 0, notDelivered: 0, casesPlanned: 0, casesDelivered: 0, overtimeAfterMin: 540, serviceMinPerCase: 0, reloadMinutes: 30, loadingMinPerCase: 0, distanceMultiplier: 1.3, avgSpeedKmh: 40,
      roadTimeFactor: 1.25, stopRadiusM: 100, dwellMin: 3, detectorVersion: 'ivms-v1', analysisVersion: 'analysis-v1', builtAt: new Date(), refreshedAt: new Date(),
    };
    await expect(prisma.factTruckDay.create({ data: { ...base, lastInFrom: 'PHONE' } })).rejects.toThrow(/FactTruckDay_lastInFrom_check/);
    await expect(prisma.factTruckDay.create({ data: { ...base, gpsNote: 'MAYBE' } })).rejects.toThrow(/FactTruckDay_gpsNote_check/);
    // A day built late from a partly deleted trail (review of 19 Oct 2026): a note of its own.
    await prisma.factTruckDay.delete({ where: { id: (await prisma.factTruckDay.create({ data: { ...base, gpsNote: 'PARTIAL_TRAIL' } })).id } });
    await expect(prisma.factTruckDay.create({ data: { ...base, outMin: -5 } })).rejects.toThrow(/FactTruckDay_minutes_nonneg/);
    await expect(prisma.factLeg.create({ data: { tenantId: A.tenantId, depotId: A.depotId, deliveryDate: base.deliveryDate, truckId: 'x', truckCode: 'T-100', loadNo: 1, legNo: 0, distanceMultiplier: 1.3, avgSpeedKmh: 40, roadTimeFactor: 1.25, serviceMinPerCase: 0, reloadMinutes: 30, stopRadiusM: 100, dwellMin: 3, detectorVersion: 'ivms-v1', analysisVersion: 'analysis-v1', builtAt: new Date(), refreshedAt: new Date() } })).rejects.toThrow(/FactLeg_legNo_range/);
    for (const days of [29, 3651]) {
      await expect(prisma.tenantConfig.update({ where: { tenantId: A.tenantId }, data: { analysisRetentionDays: days } })).rejects.toThrow(/TenantConfig_analysisRetentionDays_range/);
    }
    expect((await prisma.tenantConfig.findUniqueOrThrow({ where: { tenantId: A.tenantId } })).analysisRetentionDays).toBe(730);
  });
});

describe('4. the retention', () => {
  it('deletes the facts older than analysisRetentionDays before the company\'s today, frozen or not, of that company only', async () => {
    const old = new Date(`${addDaysIso(D, -800)}T00:00:00.000Z`);
    for (const c of [A, B]) {
      await prisma.factLeg.create({
        data: { tenantId: c.tenantId, depotId: c.depotId, deliveryDate: old, truckId: c.truckId, truckCode: 'T-100', loadNo: 1, legNo: 1, distanceMultiplier: 1.3, avgSpeedKmh: 40, roadTimeFactor: 1.25, serviceMinPerCase: 0, reloadMinutes: 30, stopRadiusM: 100, dwellMin: 3, detectorVersion: 'ivms-v1', analysisVersion: 'analysis-v1', builtAt: old, refreshedAt: old, frozenAt: old },
      });
    }
    const r = await purgeAnalysisFacts(new Date(), libPrisma, A.tenantId);
    expect(r).toEqual({ truckDays: 0, visits: 0, legs: 1, turns: 0 });
    expect(await prisma.factLeg.count({ where: { tenantId: A.tenantId, deliveryDate: old } })).toBe(0);
    expect(await prisma.factLeg.count({ where: { tenantId: B.tenantId, deliveryDate: old } })).toBe(1);
    // D's rows (25 days ago) are inside 730 days: kept.
    expect(await prisma.factVisit.count({ where: { tenantId: A.tenantId, deliveryDate: dayDate } })).toBe(2);
  });
});

describe('5. the export (GET /api/analysis/export)', () => {
  it("PLANNER gets the company's own facts only; VIEWER 403; another company's depot 404", async () => {
    session.user = { id: A.userId, tenantId: A.tenantId, role: 'PLANNER', name: 'Office Example', email: `office@${slugA}.test` };
    const res = await GET(new Request(`http://localhost/api/analysis/export?from=${D}&to=${D}`));
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
    const truckDays: unknown[][] = [];
    wb.getWorksheet('Truck days')!.eachRow((row) => truckDays.push((row.values as unknown[]).slice(1)));
    expect(truckDays.slice(1).map((r) => r[2])).toEqual(['T-100']);
    const visits: unknown[][] = [];
    wb.getWorksheet('Visits')!.eachRow((row) => visits.push((row.values as unknown[]).slice(1)));
    expect(visits).toHaveLength(3);
    expect(JSON.stringify(visits)).not.toContain('T-200');
    expect((await GET(new Request(`http://localhost/api/analysis/export?from=${D}&to=${D}&depotId=${B.depotId}`))).status).toBe(404);
    session.user = { ...session.user, role: 'VIEWER' };
    expect((await GET(new Request(`http://localhost/api/analysis/export?from=${D}&to=${D}`))).status).toBe(403);
  });
});
