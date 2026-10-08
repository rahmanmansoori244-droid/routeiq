/**
 * THE DELIVERY ACTUALS OF A RANGE WITH MORE THAN 32,767 VISITS, ON REAL POSTGRESQL (review of 8 Oct
 * 2026, web-exports-1). Library level like intake-many-sales-orders-db.spec.ts: readActuals and
 * buildActualsWorkbook with Prisma and the database; the web server and the solver are not used.
 * Needs DATABASE_URL migrated.
 *
 * The actuals asked for the photos of every visit of the range in one query, next to the company,
 * which Prisma cannot split: a range of 32,766 or more visits (a month of every depot at NMWC) was
 * answered 500 (P2035). Now they are asked for in parts of IN_LIST_PART. Here one truck-day has
 * 33,000 visits, each with a photo, and one planned stop: visits need no plan rows, so the data is
 * cheap to make and to delete. The same parts for the brought-forward orders, with 40,000 planned
 * stops, are in tests/lib/delivery-actuals-large.spec.ts (fake database).
 *  1. readActuals reads the range: the planned stop's row has its photo;
 *  2. the workbook of it is made.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildActualsWorkbook, readActuals } from '@/lib/delivery/actuals-workbook';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `actuals-many-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
/** Just over the limit (32,766 already failed). */
const N = 33_000;
/** A delivery day far from today on the real clock. */
const D = (() => {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() - 200);
  return d.toISOString().slice(0, 10);
})();
const day = new Date(`${D}T00:00:00Z`);
const at = (hhmmZ: string) => new Date(`${D}T${hhmmZ}:00Z`);

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Many visits ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  const depotId = (await prisma.depot.create({ data: { tenantId, code: 'GHALA', name: 'Ghala', lat: 23.568, lng: 58.392 } })).id;
  const truckId = (await prisma.truck.create({ data: { tenantId, depotId, code: 'T05', capacityCases: 400 } })).id;
  const customerId = (await prisma.customer.create({ data: { tenantId, code: 'ACME', name: 'Acme Shop', branchKey: '__MAIN__', lat: 23.6, lng: 58.4 } })).id;
  const orderId = (await prisma.order.create({ data: { tenantId, customerId, depotId, deliveryDate: day, totalCases: 10, status: 'DISPATCHED' } })).id;
  const runId = (await prisma.runPlan.create({ data: { tenantId, depotId, runDate: day, status: 'DISPATCHED', createdById: 'test' } })).id;
  const loadId = (
    await prisma.planLoad.create({
      data: { tenantId, runId, truckId, loadNo: 1, status: 'COMPLETED', departMin: 420, returnMin: 600, distanceKm: 12, durationMin: 90, cases: 10, weightKg: 100, utilizationPct: 3 },
    })
  ).id;
  await prisma.routeAssignment.create({
    data: { runId, truckId, orderId, loadId, loadNo: 1, sequenceInTruck: 1, orderInStop: 0, plannedArrivalMin: 460, plannedDistanceFromPrevKm: 6, plannedLoadCases: 10, etaMin: 460, serviceStartMin: 460, departureMin: 475 },
  });
  // The visits of the truck-day: sequence 1 is the planned stop's, delivered with a photo; the others too.
  const visitIds = Array.from({ length: N }, () => randomUUID());
  for (let i = 0; i < N; i += 1000) {
    const part = visitIds.slice(i, i + 1000);
    await prisma.stopVisit.createMany({
      data: part.map((id, k) => ({
        id, tenantId, depotId, deliveryDate: day, truckId, loadNo: 1, sequence: i + k + 1, customerId, linesJson: [], casesPlanned: 10, casesDelivered: 10,
        outcome: 'DELIVERED' as const, outcomeSource: 'PHONE_MANUAL' as const, outcomeAt: at('04:00'), driverResultOutcome: 'DELIVERED' as const, driverResultAt: at('04:00'), driverPhotoKeys: 1, photoCount: 1,
      })),
    });
    await prisma.deliveryPhoto.createMany({
      data: part.map((visitId, k) => ({
        tenantId, visitId, idempotencyKey: `photo-${i + k}`, source: 'PHONE_MANUAL' as const, takenAt: at('03:58'), positionStatus: 'OK' as const, distanceM: 18.4, byteSize: 1000, sha256: 'x'.repeat(64),
      })),
    });
  }
}, 120_000);

afterAll(async () => {
  await cleanupTenant(slug);
}, 120_000);

describe(`the actuals of a range with ${N.toLocaleString('en')} visits`, () => {
  let rows: Awaited<ReturnType<typeof readActuals>> | null = null;

  it('1. are read (no query over the limit): the planned stop has its result and photo', async () => {
    expect(await prisma.stopVisit.count({ where: { tenantId } })).toBe(N);
    rows = await readActuals(tenantId, { from: D, to: D }, null);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ date: D, depot: 'GHALA', truck: 'T05', trip: 1, stop: 1, customerCode: 'ACME', result: 'Delivered', photos: 1, photoLocation: 'OK', photoDistanceM: 18, recordedBy: 'Driver link' });
    expect(rows.kpis).toMatchObject({ stops: 1, delivered: 1 });
  });

  it('2. the workbook is made', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildActualsWorkbook(rows!.rows, { tenantName: 'Many visits', from: D, to: D, depot: null, generatedAt: new Date(), generatedBy: 'Test', kpis: rows!.kpis, tz: rows!.tz })) as never);
    expect(wb.getWorksheet('Stops')!.rowCount).toBe(2);
  });
});
