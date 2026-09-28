/**
 * EVERY ORDER HAS A DEPOT, ON REAL POSTGRESQL (audit PR A5, owner decision of 27 Sep 2026: "all
 * orders must have depots linked to them"). Library level like master-data-db.spec.ts: the real
 * route handlers, zod, tenantDb, Prisma and the database; only the session is faked. Needs
 * DATABASE_URL migrated with 20260930120000_orders_always_have_depot; no web server, no solver.
 *
 *  1. The older Upload orders page (no depot sent) with one active depot: the file and its orders
 *     get that depot. With a second active depot the same upload is refused (422 DEPOT_REQUIRED)
 *     and nothing is stored; the dispatch screen's choice still works.
 *  2. The history-only depot (what the migration made for orders without a depot): a file checked
 *     for it is refused at confirm; it is never made active, and no truck is put on it.
 *  3. The database itself refuses an order or an order file without a depot.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => (session.user ? { user: session.user } : null)) }));

import { POST as uploadOrders } from '@/app/api/orders/upload/route';
import { POST as confirmBatch } from '@/app/api/orders/[batchId]/confirm/route';
import { PATCH as patchDepot } from '@/app/api/depots/[id]/route';
import { POST as createTruck } from '@/app/api/trucks/route';
import { prisma as libPrisma } from '@/lib/db';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `depot-rule-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let adminId = '';
let ghala = '';
let history = '';
const DAY = (() => {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + 21);
  return d.toISOString().slice(0, 10);
})();

const jreq = (url: string, method: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });

async function upload(rows: string, forDepot?: string) {
  const fd = new FormData();
  fd.set('file', new File([`sales_order_no,delivery_date,customer_code,product_code,cases\n${rows}\n`], 'orders.csv', { type: 'text/csv' }));
  if (forDepot) fd.set('depotId', forDepot);
  fd.set('deliveryDate', DAY);
  return answer(await uploadOrders(new Request('http://localhost/api/orders/upload', { method: 'POST', body: fd })));
}
const confirm = async (batchId: string) =>
  answer(await confirmBatch(new Request(`http://localhost/api/orders/${batchId}/confirm`, { method: 'POST', body: '' }), { params: { batchId } }));
const batches = () => prisma.uploadBatch.count({ where: { tenantId } });

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Depot rule ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  adminId = (await prisma.user.create({ data: { tenantId, email: `admin@${slug}.test`, passwordHash: 'x', name: 'Admin', role: 'TENANT_ADMIN' } })).id;
  ghala = (await prisma.depot.create({ data: { tenantId, code: 'GHALA', name: 'Ghala', lat: 23.568, lng: 58.392 } })).id;
  history = (
    await prisma.depot.create({ data: { tenantId, code: 'NO-DEPOT', name: 'No depot (kept for history)', lat: 23.568, lng: 58.392, active: false, historyOnly: true } })
  ).id;
  await prisma.product.create({ data: { tenantId, code: 'JA1.5L', name: 'Water 1.5L', weightPerCaseKg: 17 } });
  session.user = { id: adminId, tenantId, role: 'TENANT_ADMIN', name: 'Admin', email: `admin@${slug}.test` };
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('1. an order file is for one depot, never a guessed one', () => {
  it('no depot sent, one active depot (and the history-only one): the file and its orders get it', async () => {
    const up = await upload(`SO-1,${DAY},C1,JA1.5L,10`);
    expect(up.status).toBe(200);
    expect(up.body.data.validation.depotCode).toBe('GHALA');
    const done = await confirm(up.body.data.batchId);
    expect(done.status).toBe(200);
    const batch = await prisma.uploadBatch.findUniqueOrThrow({ where: { id: up.body.data.batchId }, include: { orders: { select: { depotId: true } } } });
    expect(batch.depotId).toBe(ghala);
    expect(batch.orders.map((o) => o.depotId)).toEqual([ghala]);
  });

  it('a second active depot: the same upload without a choice is refused (422 DEPOT_REQUIRED), nothing stored; a choice works', async () => {
    const sohar = await prisma.depot.create({ data: { tenantId, code: 'SOHAR', name: 'Sohar', lat: 24.34, lng: 56.73 } });
    try {
      const before = await batches();
      const refused = await upload(`SO-2,${DAY},C2,JA1.5L,4`);
      expect(refused.status).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'DEPOT_REQUIRED' });
      expect(refused.body.error.message).toMatch(/more than one depot\. Upload the file on the Daily dispatch screen after choosing its depot/);
      expect(await batches()).toBe(before);
      const chosen = await upload(`SO-2,${DAY},C2,JA1.5L,4`, sohar.id);
      expect(chosen.status).toBe(200);
      expect((await prisma.uploadBatch.findUniqueOrThrow({ where: { id: chosen.body.data.batchId } })).depotId).toBe(sohar.id);
    } finally {
      await prisma.uploadBatch.deleteMany({ where: { tenantId, depotId: sohar.id } });
      await prisma.depot.delete({ where: { id: sohar.id } });
    }
  });

  it('the history-only depot cannot be chosen for a file (422 DEPOT_NOT_ACTIVE)', async () => {
    const before = await batches();
    const r = await upload(`SO-3,${DAY},C3,JA1.5L,2`, history);
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'DEPOT_NOT_ACTIVE' });
    expect(await batches()).toBe(before);
  });
});

describe('2. the history-only depot keeps old rows and gets nothing new', () => {
  it('a file checked before the rule, now on the history-only depot, is refused at confirm: no orders', async () => {
    const up = await upload(`SO-4,${DAY},C4,JA1.5L,6`);
    expect(up.status).toBe(200);
    // What the migration does to a checked file that had no depot.
    await prisma.uploadBatch.update({ where: { id: up.body.data.batchId }, data: { depotId: history } });
    const r = await confirm(up.body.data.batchId);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'MASTER_CHANGED',
      message: 'This file was checked before every order file had a depot. Nothing was added: upload the file again on the Daily dispatch screen for an active depot.',
    });
    expect(await prisma.order.count({ where: { uploadBatchId: up.body.data.batchId } })).toBe(0);
  });

  it('it is never made active and never gets a truck (422 DEPOT_HISTORY_ONLY)', async () => {
    const on = await answer(await patchDepot(jreq(`/api/depots/${history}`, 'PATCH', { active: true }), { params: { id: history } }));
    expect(on.status).toBe(422);
    expect(on.body.error).toMatchObject({ code: 'DEPOT_HISTORY_ONLY' });
    expect(await prisma.depot.findUniqueOrThrow({ where: { id: history } })).toMatchObject({ active: false, historyOnly: true });
    const truck = await answer(
      await createTruck(jreq('/api/trucks', 'POST', { code: 'T9', depotId: history, capacityCases: 100, capacityWeightKg: 1000, capacityVolumeL: 0, fixedCostPerDay: 0, costPerKm: 0 })),
    );
    expect(truck.status).toBe(422);
    expect(await prisma.truck.count({ where: { tenantId } })).toBe(0);
  });
});

describe('3. the database refuses a row without a depot', () => {
  it('an order and an order file without a depot: not-null violation (23502)', async () => {
    const customer = await prisma.customer.findFirstOrThrow({ where: { tenantId } });
    await expect(
      prisma.$executeRaw`INSERT INTO "Order" ("id", "tenantId", "customerId", "deliveryDate") VALUES (${`nodepot-${slug}`}, ${tenantId}, ${customer.id}, ${DAY}::date)`,
    ).rejects.toThrow(/23502/);
    await expect(
      prisma.$executeRaw`INSERT INTO "UploadBatch" ("id", "tenantId", "fileName", "fileType", "uploadedById") VALUES (${`nodepot-${slug}`}, ${tenantId}, 'x.csv', 'csv', ${adminId})`,
    ).rejects.toThrow(/23502/);
  });
});
