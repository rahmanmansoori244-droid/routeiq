/**
 * START FRESH (owner request 4 Oct 2026, before the pilot) on real PostgreSQL, library level: the
 * real route handlers (GET / POST /api/tenant/start-fresh), zod, Prisma, the database's own foreign
 * keys (RouteAssignment.orderId RESTRICT, UnservedOrder.orderId and the Bring forward links NO
 * ACTION, PlanLoad.driverId NO ACTION, ...) and its locks; only the session is faked (vi.mock of
 * auth). Needs DATABASE_URL (migrated); the web server and the solver are not used.
 *
 * Two companies with the same kind of data: order files, orders on two days (a late one, one
 * brought forward with a delivery time of its own), intake keys, plan versions with options, loads
 * (a daily driver on one), stops, an unserved row, jobs, driver links, delivery results, events,
 * a photo, a comparison baseline, the retired driver app's rows, daily drivers and audit rows.
 *  1. The preview counts company A only, and changes nothing.
 *  2. A dispatcher (PLANNER) gets 403; a wrong company code 400; nothing is removed.
 *  3. Refused (409) while an optimization of A is RUNNING; nothing is removed.
 *  4. "Only before a date" that would split the Bring forward pair is refused (409); one after both
 *     days of the first day removes only that day.
 *  5. Everything: A has no order, file, plan, load, stop, job, link, result, photo, baseline or
 *     old driver app row left; its customers, products, trucks, regular drivers, depots, regions,
 *     users, settings and audit rows are kept, plus one TEST_DATA_CLEARED row with the counts and
 *     the user; the daily driver who is a truck's default driver stays; company B is untouched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => (session.user ? { user: session.user } : null)) }));

import { GET, POST } from '@/app/api/tenant/start-fresh/route';
import { prisma as libPrisma } from '@/lib/db';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const D1 = '2026-10-02';
const D2 = '2026-10-03';
const D3 = '2026-10-06';

interface Company {
  slug: string;
  tenantId: string;
  adminId: string;
}

const A: Company = { slug: `sfa-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '', adminId: '' };
const B: Company = { slug: `sfb-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '', adminId: '' };

const as = (c: Company, role: string) => {
  session.user = { id: c.adminId, tenantId: c.tenantId, role, name: 'Owner', email: `admin@${c.slug}.test` };
};
const get = async (q = '') => {
  const res = await GET(new Request(`http://localhost/api/tenant/start-fresh${q}`));
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
};
const post = async (body: unknown) => {
  const res = await POST(new Request('http://localhost/api/tenant/start-fresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
};

/** One company's master data and test activity. */
async function seed(c: Company) {
  const t = await prisma.tenant.create({ data: { slug: c.slug, name: `Start fresh ${c.slug}`, country: 'Oman' } });
  c.tenantId = t.id;
  const tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  c.adminId = (await prisma.user.create({ data: { tenantId, email: `admin@${c.slug}.test`, passwordHash: 'x', name: 'Owner', role: 'TENANT_ADMIN' } })).id;
  await prisma.user.create({ data: { tenantId, email: `planner@${c.slug}.test`, passwordHash: 'x', name: 'Coordinator', role: 'PLANNER' } });
  const depot = await prisma.depot.create({ data: { tenantId, code: 'MCT', name: 'Muscat', lat: 23.568, lng: 58.392 } });
  await prisma.region.create({ data: { tenantId, code: 'R1', name: 'Region 1', depotId: depot.id } });
  const product = await prisma.product.create({ data: { tenantId, code: 'JA0.5', name: 'Water 0.5L', weightPerCaseKg: 12.5, casesPerPallet: 84 } });
  const c1 = await prisma.customer.create({ data: { tenantId, code: 'C1', name: 'Customer 1', lat: 23.6, lng: 58.4, locationVerified: true, windowConfirmedAt: new Date() } });
  const c2 = await prisma.customer.create({ data: { tenantId, code: 'C2', name: 'Customer 2', lat: 23.61, lng: 58.41 } });
  const regular = await prisma.driver.create({ data: { tenantId, code: 'D01', name: 'Regular Driver' } });
  const dailyOnLoad = await prisma.driver.create({ data: { tenantId, code: 'DAY-261002-1', name: 'Daily One', casual: true } });
  const dailyDefault = await prisma.driver.create({ data: { tenantId, code: 'DAY-261002-2', name: 'Daily Two', casual: true } });
  await prisma.driver.create({ data: { tenantId, code: 'DAY-261002-3', name: 'Daily Three', casual: true, active: false } });
  const truck = await prisma.truck.create({ data: { tenantId, depotId: depot.id, code: 'T01', capacityCases: 1000, defaultDriverId: dailyDefault.id } });

  const batch = await prisma.uploadBatch.create({ data: { tenantId, fileName: 'orders.csv', fileType: 'csv', uploadedById: c.adminId, depotId: depot.id, deliveryDate: day(D1), status: 'CONFIRMED' } });
  const o1 = await prisma.order.create({ data: { tenantId, customerId: c1.id, depotId: depot.id, deliveryDate: day(D1), totalCases: 50, uploadBatchId: batch.id } });
  const o2 = await prisma.order.create({ data: { tenantId, customerId: c2.id, depotId: depot.id, deliveryDate: day(D1), totalCases: 30, uploadBatchId: batch.id, isLate: true } });
  const o3 = await prisma.order.create({
    data: { tenantId, customerId: c2.id, depotId: depot.id, deliveryDate: day(D2), totalCases: 30, carriedFromOrderId: o2.id, carriedFromDate: day(D1), carriedAt: new Date(), deliveryStartMin: 480, deliveryEndMin: 600, deliveryTimeReason: 'URGENT' },
  });
  await prisma.order.update({ where: { id: o2.id }, data: { carriedToOrderId: o3.id } });
  for (const [o, so] of [[o1, 'SO1'], [o2, 'SO2'], [o3, null]] as const) {
    const line = await prisma.orderLine.create({ data: { orderId: o.id, productId: product.id, cases: o.totalCases, salesOrderNo: so } });
    if (so) await prisma.intakeLineKey.create({ data: { tenantId, deliveryDate: o.deliveryDate, salesOrderNorm: so, customerId: o.customerId, productId: product.id, orderLineId: line.id } });
  }

  // Day 1: two plan versions, the second applied (a load with the daily driver, a stop, an unserved row).
  const p1 = await prisma.runPlan.create({ data: { tenantId, depotId: depot.id, runDate: day(D1), createdById: c.adminId, status: 'SUPERSEDED' } });
  const p1b = await prisma.runPlan.create({ data: { tenantId, depotId: depot.id, runDate: day(D1), createdById: c.adminId, status: 'DISPATCHED', version: 2, parentRunId: p1.id, reason: 'LATE_ORDER' } });
  const scenario = { name: 'Balanced', trucksUsed: 1, totalDistanceKm: 10, totalTimeMin: 60, totalCost: 5, avgUtilizationPct: 50, unservedCount: 1, detailsJson: {} };
  const s1 = await prisma.scenarioResult.create({ data: { runId: p1b.id, ...scenario } });
  await prisma.scenarioResult.create({ data: { runId: p1.id, ...scenario } });
  await prisma.unservedOrder.create({ data: { scenarioId: s1.id, orderId: o2.id, reasonCode: 'SHIFT_LIMIT' } });
  const load = { truckId: truck.id, loadNo: 1, departMin: 420, returnMin: 600, distanceKm: 10, durationMin: 180, cases: 50, weightKg: 625, utilizationPct: 5 };
  const l1 = await prisma.planLoad.create({ data: { tenantId, runId: p1b.id, ...load, status: 'COMPLETED', driverId: dailyOnLoad.id } });
  const ra1 = await prisma.routeAssignment.create({
    data: { runId: p1b.id, truckId: truck.id, orderId: o1.id, loadId: l1.id, sequenceInTruck: 1, plannedArrivalMin: 450, plannedDistanceFromPrevKm: 5, plannedLoadCases: 50 },
  });
  await prisma.runJob.create({ data: { tenantId, runId: p1b.id, createdById: c.adminId, status: 'SUCCEEDED' } });
  await prisma.manualBaseline.create({ data: { tenantId, runId: p1.id, uploadedById: c.adminId, assignments: { create: [{ orderId: o1.id, truckCode: 'T01', customerCode: 'C1' }] } } });

  // Day 2: the brought-forward order on a load of the regular driver.
  const p2 = await prisma.runPlan.create({ data: { tenantId, depotId: depot.id, runDate: day(D2), createdById: c.adminId, status: 'READY' } });
  await prisma.scenarioResult.create({ data: { runId: p2.id, ...scenario, unservedCount: 0 } });
  const l2 = await prisma.planLoad.create({ data: { tenantId, runId: p2.id, ...load, driverId: regular.id } });
  await prisma.routeAssignment.create({ data: { runId: p2.id, truckId: truck.id, orderId: o3.id, loadId: l2.id, sequenceInTruck: 1, plannedArrivalMin: 500, plannedDistanceFromPrevKm: 5, plannedLoadCases: 30 } });
  await prisma.runJob.create({ data: { tenantId, runId: p2.id, createdById: c.adminId, status: 'FAILED' } });

  // Day 3 (after the dates "only before" removes): its own file, order, plan, load, stop, job and link.
  const batch3 = await prisma.uploadBatch.create({ data: { tenantId, fileName: 'orders-6.csv', fileType: 'csv', uploadedById: c.adminId, depotId: depot.id, deliveryDate: day(D3), status: 'CONFIRMED' } });
  const o6 = await prisma.order.create({ data: { tenantId, customerId: c1.id, depotId: depot.id, deliveryDate: day(D3), totalCases: 40, uploadBatchId: batch3.id } });
  await prisma.orderLine.create({ data: { orderId: o6.id, productId: product.id, cases: 40 } });
  const p6 = await prisma.runPlan.create({ data: { tenantId, depotId: depot.id, runDate: day(D3), createdById: c.adminId, status: 'READY' } });
  await prisma.scenarioResult.create({ data: { runId: p6.id, ...scenario, unservedCount: 0 } });
  const l6 = await prisma.planLoad.create({ data: { tenantId, runId: p6.id, ...load, driverId: regular.id } });
  await prisma.routeAssignment.create({ data: { runId: p6.id, truckId: truck.id, orderId: o6.id, loadId: l6.id, sequenceInTruck: 1, plannedArrivalMin: 500, plannedDistanceFromPrevKm: 5, plannedLoadCases: 40 } });
  await prisma.runJob.create({ data: { tenantId, runId: p6.id, createdById: c.adminId, status: 'SUCCEEDED' } });
  await prisma.driverLink.create({
    data: { tenantId, truckId: truck.id, deliveryDate: day(D3), salt: 'c2FsdA', keyId: 'abcd1234', tokenHash: `hash6-${c.slug}`, expiresAt: new Date('2026-10-07T00:00:00Z') },
  });

  // Delivery results of day 1: a driver link, a stop with a result, its events, a photo.
  const link = await prisma.driverLink.create({
    data: { tenantId, truckId: truck.id, deliveryDate: day(D1), salt: 'c2FsdA', keyId: 'abcd1234', tokenHash: `hash-${c.slug}`, expiresAt: new Date('2026-10-03T00:00:00Z') },
  });
  const visit = await prisma.stopVisit.create({
    data: { tenantId, depotId: depot.id, deliveryDate: day(D1), truckId: truck.id, loadNo: 1, sequence: 1, customerId: c1.id, linesJson: [], casesPlanned: 50, casesDelivered: 50, outcome: 'DELIVERED' },
  });
  const ev = { tenantId, depotId: depot.id, deliveryDate: day(D1), truckId: truck.id, loadNo: 1, source: 'PHONE_MANUAL' as const, at: new Date('2026-10-02T05:00:00Z'), driverLinkId: link.id };
  await prisma.stopEvent.create({ data: { ...ev, sequence: 1, visitId: visit.id, kind: 'OUTCOME', idempotencyKey: `dl:${c.slug}:1` } });
  await prisma.stopEvent.create({ data: { ...ev, kind: 'BACK_AT_DEPOT', idempotencyKey: `dl:${c.slug}:2` } });
  await prisma.deliveryPhoto.create({
    data: { tenantId, visitId: visit.id, idempotencyKey: `dlphoto:${c.slug}`, source: 'PHONE_MANUAL', driverLinkId: link.id, takenAt: new Date(), positionStatus: 'OK', byteSize: 3, sha256: 'x', bytes: Buffer.from([1, 2, 3]) },
  });

  // The retired driver app (DriverShift -> Driver is RESTRICT).
  const shift = await prisma.driverShift.create({ data: { tenantId, driverId: regular.id, truckId: truck.id, runId: p1b.id, sessionToken: `tok-${c.slug}`, startedAt: new Date('2026-10-02T03:00:00Z') } });
  await prisma.truckLocation.create({ data: { tenantId, shiftId: shift.id, truckId: truck.id, ts: new Date('2026-10-02T04:00:00Z'), lat: 23.6, lng: 58.4 } });
  await prisma.deliveryProof.create({ data: { tenantId, shiftId: shift.id, assignmentId: ra1.id } });

  await prisma.auditLog.create({ data: { tenantId, userId: c.adminId, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: l1.id } });
  await prisma.auditLog.create({ data: { tenantId, userId: c.adminId, action: 'CASUAL_DRIVER_ADDED', entity: 'Driver', entityId: dailyOnLoad.id } });
}

/** Rows per table of one company (child tables through their parent). */
async function census(tenantId: string) {
  const runs = { run: { tenantId } };
  return {
    uploadBatch: await prisma.uploadBatch.count({ where: { tenantId } }),
    order: await prisma.order.count({ where: { tenantId } }),
    orderLine: await prisma.orderLine.count({ where: { order: { tenantId } } }),
    intakeLineKey: await prisma.intakeLineKey.count({ where: { tenantId } }),
    runPlan: await prisma.runPlan.count({ where: { tenantId } }),
    scenarioResult: await prisma.scenarioResult.count({ where: runs }),
    unservedOrder: await prisma.unservedOrder.count({ where: { order: { tenantId } } }),
    planLoad: await prisma.planLoad.count({ where: { tenantId } }),
    routeAssignment: await prisma.routeAssignment.count({ where: runs }),
    runJob: await prisma.runJob.count({ where: { tenantId } }),
    manualBaseline: await prisma.manualBaseline.count({ where: { tenantId } }),
    manualBaselineAssignment: await prisma.manualBaselineAssignment.count({ where: { baseline: { tenantId } } }),
    driverLink: await prisma.driverLink.count({ where: { tenantId } }),
    stopVisit: await prisma.stopVisit.count({ where: { tenantId } }),
    stopEvent: await prisma.stopEvent.count({ where: { tenantId } }),
    deliveryPhoto: await prisma.deliveryPhoto.count({ where: { tenantId } }),
    driverShift: await prisma.driverShift.count({ where: { tenantId } }),
    truckLocation: await prisma.truckLocation.count({ where: { tenantId } }),
    deliveryProof: await prisma.deliveryProof.count({ where: { tenantId } }),
    customer: await prisma.customer.count({ where: { tenantId } }),
    product: await prisma.product.count({ where: { tenantId } }),
    truck: await prisma.truck.count({ where: { tenantId } }),
    driverRegular: await prisma.driver.count({ where: { tenantId, casual: false } }),
    driverDaily: await prisma.driver.count({ where: { tenantId, casual: true } }),
    depot: await prisma.depot.count({ where: { tenantId } }),
    region: await prisma.region.count({ where: { tenantId } }),
    user: await prisma.user.count({ where: { tenantId } }),
    tenantConfig: await prisma.tenantConfig.count({ where: { tenantId } }),
    auditLog: await prisma.auditLog.count({ where: { tenantId } }),
  };
}

beforeAll(async () => {
  await seed(A);
  await seed(B);
});

afterAll(async () => {
  await cleanupTenant(A.slug);
  await cleanupTenant(B.slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('Start fresh on real PostgreSQL', () => {
  it('1. the preview counts company A only and changes nothing', async () => {
    const before = await census(A.tenantId);
    as(A, 'TENANT_ADMIN');
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.data.blockers).toEqual([]);
    expect(r.body.data.removed).toEqual({
      uploadBatches: 2,
      orders: 4,
      lateOrders: 1,
      broughtForward: 1,
      deliveryTimes: 1,
      orderLines: 4,
      planVersions: 4,
      planOptions: 4,
      optimizationJobs: 3,
      loads: 3,
      stops: 3,
      unserved: 1,
      driverLinks: 2,
      stopVisits: 1,
      stopEvents: 2,
      deliveryPhotos: 1,
      dailyDrivers: 2,
      baselines: 1,
      oldDriverApp: 3,
    });
    expect(r.body.data.kept).toEqual({ customers: 2, products: 1, trucks: 1, drivers: 1, dailyDrivers: 1, depots: 1, regions: 1, users: 2, auditRows: 2 });
    expect(await census(A.tenantId)).toEqual(before);
  });

  it('2. a dispatcher gets 403, a wrong company code 400: nothing removed', async () => {
    const before = await census(A.tenantId);
    as(A, 'PLANNER');
    expect((await post({ confirm: A.slug, backupConfirmed: true })).status).toBe(403);
    as(A, 'TENANT_ADMIN');
    const wrong = await post({ confirm: B.slug, backupConfirmed: true });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('CONFIRM_MISMATCH');
    expect(await census(A.tenantId)).toEqual(before);
  });

  it('3. refused while an optimization of the company is running', async () => {
    const before = await census(A.tenantId);
    const plan = await prisma.runPlan.findFirstOrThrow({ where: { tenantId: A.tenantId, runDate: day(D2) } });
    const job = await prisma.runJob.create({ data: { tenantId: A.tenantId, runId: plan.id, createdById: A.adminId, status: 'RUNNING', attemptNo: 2 } });
    as(A, 'TENANT_ADMIN');
    const r = await post({ confirm: A.slug, backupConfirmed: true });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('OPTIMIZATION_RUNNING');
    expect(await census(A.tenantId)).toEqual({ ...before, runJob: before.runJob + 1 });
    await prisma.runJob.delete({ where: { id: job.id } });
  });

  it('4. only before a date: a date that splits the Bring forward pair is refused; a date after it removes days 1 and 2 and keeps day 3', async () => {
    const beforeB = await census(B.tenantId);
    as(A, 'TENANT_ADMIN');
    const split = await post({ confirm: A.slug, backupConfirmed: true, before: D2 });
    expect(split.status).toBe(409);
    expect(split.body.error.code).toBe('CARRIED_ACROSS_DATE');
    expect(split.body.error.error).toMatch(/2026-10-02 or an earlier date/);

    const r = await post({ confirm: A.slug, backupConfirmed: true, before: '2026-10-04' });
    expect(r.status).toBe(200);
    expect(r.body.data.removed).toMatchObject({ uploadBatches: 1, orders: 3, orderLines: 3, planVersions: 3, loads: 2, stops: 2, unserved: 1, driverLinks: 1, stopVisits: 1, stopEvents: 2, deliveryPhotos: 1, dailyDrivers: 2, baselines: 1, oldDriverApp: 3 });
    const after = await census(A.tenantId);
    expect(after).toMatchObject({ uploadBatch: 1, order: 1, orderLine: 1, intakeLineKey: 0, runPlan: 1, scenarioResult: 1, planLoad: 1, routeAssignment: 1, runJob: 1, driverLink: 1, stopVisit: 0, driverShift: 0, driverDaily: 1 });
    const left = await prisma.order.findFirstOrThrow({ where: { tenantId: A.tenantId } });
    expect(left.deliveryDate.toISOString().slice(0, 10)).toBe(D3);
    expect(await census(B.tenantId)).toEqual(beforeB);
  });

  it('5. everything: test data gone, masters and the audit log kept, company B untouched', async () => {
    const beforeA = await census(A.tenantId);
    const beforeB = await census(B.tenantId);
    as(A, 'TENANT_ADMIN');
    const r = await post({ confirm: ` ${A.slug.toUpperCase()} `, backupConfirmed: true });
    expect(r.status).toBe(200);
    expect(r.body.data.removed).toMatchObject({ uploadBatches: 1, orders: 1, orderLines: 1, planVersions: 1, loads: 1, stops: 1, optimizationJobs: 1, driverLinks: 1, unserved: 0, dailyDrivers: 0 });

    const after = await census(A.tenantId);
    for (const k of ['uploadBatch', 'order', 'orderLine', 'intakeLineKey', 'runPlan', 'scenarioResult', 'unservedOrder', 'planLoad', 'routeAssignment', 'runJob', 'manualBaseline', 'manualBaselineAssignment', 'driverLink', 'stopVisit', 'stopEvent', 'deliveryPhoto', 'driverShift', 'truckLocation', 'deliveryProof'] as const) {
      expect(after[k], k).toBe(0);
    }
    expect(after).toMatchObject({
      customer: beforeA.customer,
      product: beforeA.product,
      truck: beforeA.truck,
      driverRegular: beforeA.driverRegular,
      driverDaily: 1, // the truck's default driver
      depot: beforeA.depot,
      region: beforeA.region,
      user: beforeA.user,
      tenantConfig: 1,
      auditLog: beforeA.auditLog + 1,
    });
    const customer = await prisma.customer.findFirstOrThrow({ where: { tenantId: A.tenantId, code: 'C1' } });
    expect(customer).toMatchObject({ lat: 23.6, lng: 58.4, locationVerified: true });
    expect(customer.windowConfirmedAt).not.toBeNull();
    const rows = await prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'TEST_DATA_CLEARED' }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ userId: A.adminId, entity: 'Tenant', entityId: A.tenantId });
    expect(rows[0]!.afterJson).toMatchObject({ before: '2026-10-04', backupConfirmed: true, removed: { orders: 3 } });
    expect(rows[1]!.afterJson).toMatchObject({ before: null, backupConfirmed: true, removed: { orders: 1 } });

    expect(await census(B.tenantId)).toEqual(beforeB);
  });
});
