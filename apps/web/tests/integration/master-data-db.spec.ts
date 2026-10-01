/**
 * INTAKE AND MASTER DATA ON REAL POSTGRESQL (audit of 27 Sep 2026, PR "Intake and master data"),
 * library level: the real route handlers, zod, tenantDb, Prisma and the database; only the
 * session is faked (vi.mock of auth). Needs DATABASE_URL (migrated, with
 * 20260930093000_master_data_no_orphans); the web server and the solver are not used.
 *
 *  1. F02 / F04: an order file with the same sales order and product on two rows, in both row
 *     orders: the order is P1 with both notes, and a line with blank money on one row has no money.
 *  2. F03: a depot with orders but no trucks is deactivated, not deleted; its orders keep it; a file
 *     checked for it before is refused at confirm (MASTER_CHANGED); the database itself refuses to
 *     delete it (NO ACTION); a depot nothing refers to is deleted.
 *  3. F05: a dispatcher verifies a pin while the import runs (after its read, before its write -
 *     forced with a row lock, not left to timing): the pin, its attribution and "verified" survive,
 *     and the import reports it as kept.
 *  4. F20: "Delete" on a driver on a dispatched load and on a driver never used both deactivate;
 *     the loads and the trucks' default driver keep them; the database refuses a raw delete.
 *  5. F26: a driver's phone is cleared; a region's depot is cleared and a region created without one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => (session.user ? { user: session.user } : null)) }));

import { POST as uploadOrders } from '@/app/api/orders/upload/route';
import { POST as confirmBatch } from '@/app/api/orders/[batchId]/confirm/route';
import { DELETE as deleteDepot } from '@/app/api/depots/[id]/route';
import { POST as importCustomers } from '@/app/api/customers/import/route';
import { DELETE as deleteDriver, PATCH as patchDriver } from '@/app/api/drivers/[id]/route';
import { PATCH as patchRegion } from '@/app/api/regions/[id]/route';
import { POST as createRegion } from '@/app/api/regions/route';
import { prisma as libPrisma } from '@/lib/db';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `mdata-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let adminId = '';
let depotId = '';
const DAY = (() => {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + 20);
  return d.toISOString().slice(0, 10);
})();

const as = (role: 'TENANT_ADMIN' | 'PLANNER') => {
  session.user = { id: adminId, tenantId, role, name: 'Admin', email: `admin@${slug}.test` };
};
const jreq = (url: string, method: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const csv = (rows: (string | number)[][]) => rows.map((r) => r.join(',')).join('\n');

async function upload(text: string, forDepot: string) {
  const fd = new FormData();
  fd.set('file', new File([text], 'orders.csv', { type: 'text/csv' }));
  fd.set('depotId', forDepot);
  fd.set('deliveryDate', DAY);
  const res = await uploadOrders(new Request('http://localhost/api/orders/upload', { method: 'POST', body: fd }));
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
}
async function confirm(batchId: string) {
  const res = await confirmBatch(new Request(`http://localhost/api/orders/${batchId}/confirm`, { method: 'POST', body: '' }), { params: { batchId } });
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
}

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Master data ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  adminId = (await prisma.user.create({ data: { tenantId, email: `admin@${slug}.test`, passwordHash: 'x', name: 'Admin', role: 'TENANT_ADMIN' } })).id;
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'MCT', name: 'Muscat', lat: 23.568, lng: 58.392 } })).id;
  await prisma.product.create({ data: { tenantId, code: 'JA1.5L', name: 'Water 1.5L', weightPerCaseKg: 17 } });
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('1. merged order rows (F02 / F04)', () => {
  it('P5 then P1, P1 then P5: the order is P1 with both notes; blank money on one row leaves the line without money', async () => {
    for (const code of ['M9', 'M8', 'M7']) {
      await prisma.customer.create({ data: { tenantId, code, name: code, branchKey: '__MAIN__', lat: 23.6, lng: 58.4, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true } });
    }
    as('PLANNER');
    const head = ['SO Number', 'Delivery Date', 'Customer Code', 'Product Code', 'Cases', 'Priority', 'Notes', 'Sales Value', 'Margin'];
    const up = await upload(
      csv([
        head,
        ['901', DAY, 'M9', 'JA1.5L', 10, 'P5', 'routine', '', ''],
        ['901', DAY, 'M9', 'JA1.5L', 5, 'P1', 'URGENT call receiving', '', ''],
        ['902', DAY, 'M8', 'JA1.5L', 5, 'P1', 'URGENT call receiving', '', ''],
        ['902', DAY, 'M8', 'JA1.5L', 10, 'P5', 'routine', '', ''],
        ['903', DAY, 'M7', 'JA1.5L', 10, '', '', '100', '20'],
        ['903', DAY, 'M7', 'JA1.5L', 5, '', '', '', ''],
      ]),
      depotId,
    );
    expect(up.status).toBe(200);
    expect(up.body.data.validation.warnings.join('\n')).toMatch(/Rows 2 and 3 are one line \(sales order 901, JA1\.5L for M9\), 15 cases in all\. Different priorities \(row 2 P5, row 3 P1\): P1 is used/);
    const c = await confirm(up.body.data.batchId);
    expect(c.status).toBe(200);
    const orders = await prisma.order.findMany({
      where: { tenantId, uploadBatchId: up.body.data.batchId },
      include: { customer: { select: { code: true } }, lines: true },
    });
    const byCode = new Map(orders.map((o) => [o.customer.code, o]));
    for (const code of ['M9', 'M8']) {
      const o = byCode.get(code)!;
      expect(o).toMatchObject({ priority: 1, priorityFromFile: true, totalCases: 15 });
      expect((o.notes ?? '').split(' | ').sort()).toEqual(['URGENT call receiving', 'routine']);
    }
    expect(byCode.get('M7')).toMatchObject({ salesValue: null, marginValue: null, totalCases: 15 });
    expect(byCode.get('M7')!.lines[0]).toMatchObject({ salesValue: null, marginValue: null, cases: 15 });
    const batch = await prisma.uploadBatch.findUniqueOrThrow({ where: { id: up.body.data.batchId } });
    const merged = (batch.validationJson as any).lines.find((l: any) => l.salesOrderNo === '901');
    expect(merged.mergedRows.map((r: any) => [r.row, r.priority, r.notes])).toEqual([[2, 5, 'routine'], [3, 1, 'URGENT call receiving']]);
  });
});

describe('2. depots with orders are deactivated, never deleted (F03)', () => {
  it('a depot with orders but no trucks keeps its orders; a file checked for it is refused; the database refuses a delete', async () => {
    const nzw = await prisma.depot.create({ data: { tenantId, code: 'NZW', name: 'Nizwa', lat: 22.93, lng: 57.53 } });
    await prisma.customer.create({ data: { tenantId, code: 'NZ1', name: 'NZ1', branchKey: '__MAIN__', lat: 22.93, lng: 57.53, geocodeConfidence: 'HIGH', locationVerified: true } });
    await prisma.customer.create({ data: { tenantId, code: 'NZ2', name: 'NZ2', branchKey: '__MAIN__', lat: 22.94, lng: 57.54, geocodeConfidence: 'HIGH', locationVerified: true } });
    as('PLANNER');
    const first = await upload(csv([['SO Number', 'Customer Code', 'Product Code', 'Cases'], ['5001', 'NZ1', 'JA1.5L', 50]]), nzw.id);
    expect((await confirm(first.body.data.batchId)).status).toBe(200);
    const second = await upload(csv([['SO Number', 'Customer Code', 'Product Code', 'Cases'], ['5002', 'NZ2', 'JA1.5L', 30]]), nzw.id);
    expect(second.body.data.validation.errorRows).toBe(0);

    as('TENANT_ADMIN');
    const del = await deleteDepot(jreq(`/api/depots/${nzw.id}`, 'DELETE'), { params: { id: nzw.id } });
    const delBody = await del.json();
    expect(del.status).toBe(200);
    expect(delBody.data).toMatchObject({ softDeleted: true, depot: { active: false }, references: '1 order and 2 order files' });
    expect(await prisma.depot.findUnique({ where: { id: nzw.id } })).toMatchObject({ active: false });
    const nzOrders = await prisma.order.findMany({ where: { tenantId, customer: { code: 'NZ1' } }, select: { depotId: true } });
    expect(nzOrders).toEqual([{ depotId: nzw.id }]);

    as('PLANNER');
    const late = await confirm(second.body.data.batchId);
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: 'MASTER_CHANGED' });
    expect(await prisma.order.count({ where: { tenantId, customer: { code: 'NZ2' } } })).toBe(0);

    // The database enforces it too (a delete that bypasses the app).
    await expect(prisma.depot.delete({ where: { id: nzw.id } })).rejects.toMatchObject({ code: 'P2003' });

    as('TENANT_ADMIN');
    const spare = await prisma.depot.create({ data: { tenantId, code: 'SPARE', name: 'Spare', lat: 23, lng: 58 } });
    const gone = await deleteDepot(jreq(`/api/depots/${spare.id}`, 'DELETE'), { params: { id: spare.id } });
    expect((await gone.json()).data).toEqual({ deleted: true });
    expect(await prisma.depot.findUnique({ where: { id: spare.id } })).toBeNull();
  });
});

describe('3. customer import vs a pin verified meanwhile (F05)', () => {
  it('a verification between the import read and its write survives, with its attribution; the import reports it kept', async () => {
    const N = 40;
    await prisma.customer.createMany({
      data: Array.from({ length: N }, (_, i) => ({ tenantId, code: `K${i}`, name: `K${i}`, branchKey: '__MAIN__', lat: 23.5, lng: 58.3, geocodeConfidence: 'HIGH' as const, locationVerified: false, priority: 3 })),
    });
    const target = await prisma.customer.findFirstOrThrow({ where: { tenantId, code: `K${N - 1}` } });
    // The company admin: since 1 Oct 2026 a dispatcher's import never changes a usable saved location
    // (location admin-lock), so only an admin's import writes the other customers' pairs here.
    as('TENANT_ADMIN');
    const fd = new FormData();
    fd.set('file', new File([csv([['code', 'name', 'priority', 'lat', 'lng'], ...Array.from({ length: N }, (_, i) => [`K${i}`, `K${i}`, 3, '23.7001', '58.5001'])])], 'customers.csv', { type: 'text/csv' }));

    let importDone: Promise<{ status: number; body: any }> | null = null;
    await prisma.$transaction(
      async (tx) => {
        // Hold the target's row, start the import (it reads every customer, then blocks writing the target) ...
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${target.id} FOR UPDATE`;
        importDone = importCustomers(new Request('http://localhost/api/customers/import', { method: 'POST', body: fd })).then(async (r) => ({ status: r.status, body: await r.json() }));
        let blocked = 0;
        for (let i = 0; i < 200 && !blocked; i++) {
          await new Promise((r) => setTimeout(r, 25));
          const w = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          blocked = Number(w[0]!.n);
        }
        expect(blocked).toBeGreaterThan(0);
        // ... and the dispatcher's verification commits first (what PUT /api/customers/:id/location writes).
        await tx.customer.update({
          where: { id: target.id },
          data: { lat: 23.8123, lng: 58.7123, geocodeConfidence: 'HIGH', locationSource: 'MAP_PIN', locationVerified: true, locationVerifiedById: adminId, locationVerifiedAt: new Date() },
        });
      },
      { timeout: 20_000 },
    );
    const imp = await importDone!;
    expect(imp.status).toBe(200);
    expect(imp.body.data.keptVerifiedLocations).toBe(1);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: target.id } });
    expect(after).toMatchObject({ lat: 23.8123, lng: 58.7123, locationVerified: true, locationVerifiedById: adminId, locationSource: 'MAP_PIN' });
    const other = await prisma.customer.findFirstOrThrow({ where: { tenantId, code: 'K0' } });
    expect(other).toMatchObject({ lat: 23.7001, lng: 58.5001, locationSource: 'IMPORT' });
  });
});

describe('4. drivers are deactivated, never deleted (F20)', () => {
  it('a driver on a dispatched load and a driver never used: both deactivated; loads and truck defaults keep them', async () => {
    const used = await prisma.driver.create({ data: { tenantId, code: 'DR-USED', name: 'Used' } });
    const unused = await prisma.driver.create({ data: { tenantId, code: 'DR-NEW', name: 'Never used' } });
    const truck = await prisma.truck.create({ data: { tenantId, depotId, code: 'TD1', capacityCases: 100, defaultDriverId: unused.id } });
    const run = await prisma.runPlan.create({ data: { tenantId, depotId, runDate: new Date(`${DAY}T00:00:00.000Z`), status: 'DISPATCHED', createdById: adminId } });
    const load = await prisma.planLoad.create({
      data: { tenantId, runId: run.id, truckId: truck.id, loadNo: 1, status: 'DISPATCHED', driverId: used.id, departMin: 360, returnMin: 600, distanceKm: 50, durationMin: 240, cases: 10, weightKg: 100, utilizationPct: 10 },
    });
    as('TENANT_ADMIN');
    for (const d of [used, unused]) {
      const res = await deleteDriver(jreq(`/api/drivers/${d.id}`, 'DELETE'), { params: { id: d.id } });
      expect(res.status).toBe(200);
      expect((await res.json()).data).toMatchObject({ softDeleted: true, driver: { active: false } });
      expect(await prisma.driver.findUnique({ where: { id: d.id } })).toMatchObject({ active: false });
    }
    expect(await prisma.planLoad.findUniqueOrThrow({ where: { id: load.id } })).toMatchObject({ driverId: used.id, status: 'DISPATCHED' });
    expect(await prisma.truck.findUniqueOrThrow({ where: { id: truck.id } })).toMatchObject({ defaultDriverId: unused.id });
    // The database refuses a delete that bypasses the app.
    await expect(prisma.driver.delete({ where: { id: used.id } })).rejects.toMatchObject({ code: 'P2003' });
    await expect(prisma.driver.delete({ where: { id: unused.id } })).rejects.toMatchObject({ code: 'P2003' });
    await prisma.planLoad.delete({ where: { id: load.id } });
    await prisma.runPlan.delete({ where: { id: run.id } });
  });
});

describe('5. clearing optional fields (F26)', () => {
  it("a driver's phone is cleared; a region's depot is cleared; a region is created without a depot", async () => {
    const drv = await prisma.driver.create({ data: { tenantId, code: 'DR-PH', name: 'Phone', phone: '+968 9123 4567' } });
    const reg = await prisma.region.create({ data: { tenantId, code: 'RG1', name: 'Ghala', depotId } });
    as('TENANT_ADMIN');
    const p = await patchDriver(jreq(`/api/drivers/${drv.id}`, 'PATCH', { code: 'DR-PH', name: 'Phone', phone: '', active: true }), { params: { id: drv.id } });
    expect(p.status).toBe(200);
    expect((await p.json()).data.phone).toBeNull();
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: drv.id } })).phone).toBeNull();
    const r = await patchRegion(jreq(`/api/regions/${reg.id}`, 'PATCH', { code: 'RG1', name: 'Ghala', depotId: null }), { params: { id: reg.id } });
    expect(r.status).toBe(200);
    expect((await prisma.region.findUniqueOrThrow({ where: { id: reg.id } })).depotId).toBeNull();
    const c = await createRegion(jreq('/api/regions', 'POST', { code: 'RG2', name: 'Seeb', depotId: null }));
    expect(c.status).toBe(201);
    expect((await c.json()).data.depotId).toBeNull();
  });
});
