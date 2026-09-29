/**
 * AN ORDER FILE WITH MORE THAN 32,767 SALES ORDERS, ON REAL POSTGRESQL (third review of audit P5;
 * the bug is older than P5). Library level like orders-have-depot-db.spec.ts: the real route
 * handlers, Prisma and the database; only the session is faked; the web server and solver are not
 * used. Needs DATABASE_URL migrated.
 *
 * An order file may hold 50,000 rows. PostgreSQL takes at most 32,767 bind parameters in one query,
 * and the check asked for every sales order of the file in one query next to the company and the
 * file's dates, which Prisma cannot split: a file of 32,766 or more sales orders was refused with
 * Prisma's own text (P2035 or P2029). Now:
 *
 *  1. a file of 33,000 sales orders is checked (200), with the "already confirmed for another date"
 *     warning for the first and the last sales order (asked for in different parts), and confirmed
 *     (33,000 lines and keys);
 *  2. the same file again is checked too: every line is reported as already confirmed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => (session.user ? { user: session.user } : null)) }));

import { POST as uploadOrders } from '@/app/api/orders/upload/route';
import { POST as confirmBatch } from '@/app/api/orders/[batchId]/confirm/route';
import { prisma as libPrisma } from '@/lib/db';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const slug = `many-so-${uniqueSuffix()}`.toLowerCase().slice(0, 32);
let tenantId = '';
let depotId = '';
const isoPlus = (days: number) => {
  const d = new Date(Date.now() + 4 * 3600_000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const EARLIER = isoPlus(20);
const DAY = isoPlus(21);
/** Just over the limit (32,766 already failed), so the check and the confirm stay well inside the test time. */
const N = 33_000;
const so = (i: number) => `SO${String(i).padStart(5, '0')}`;

const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });
async function upload(rows: string[], day: string) {
  const fd = new FormData();
  fd.set('file', new File([`sales_order_no,delivery_date,customer_code,product_code,cases\n${rows.join('\n')}\n`], 'orders.csv', { type: 'text/csv' }));
  fd.set('depotId', depotId);
  fd.set('deliveryDate', day);
  return answer(await uploadOrders(new Request('http://localhost/api/orders/upload', { method: 'POST', body: fd })));
}
const confirm = async (batchId: string) =>
  answer(await confirmBatch(new Request(`http://localhost/api/orders/${batchId}/confirm`, { method: 'POST', body: '' }), { params: { batchId } }));
const bigFile = () => Array.from({ length: N }, (_, k) => `${so(k + 1)},${DAY},C1,JA1.5L,1`);

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Many sales orders ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null } });
  const adminId = (await prisma.user.create({ data: { tenantId, email: `admin@${slug}.test`, passwordHash: 'x', name: 'Admin', role: 'TENANT_ADMIN' } })).id;
  depotId = (await prisma.depot.create({ data: { tenantId, code: 'GHALA', name: 'Ghala', lat: 23.568, lng: 58.392 } })).id;
  await prisma.product.create({ data: { tenantId, code: 'JA1.5L', name: 'Water 1.5L', weightPerCaseKg: 17 } });
  await prisma.customer.create({ data: { tenantId, code: 'C1', name: 'Customer One', branchKey: '__MAIN__', lat: 23.6, lng: 58.4, geocodeConfidence: 'HIGH', locationVerified: true } });
  session.user = { id: adminId, tenantId, role: 'TENANT_ADMIN', name: 'Admin', email: `admin@${slug}.test` };
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
  await libPrisma.$disconnect();
});

describe('an order file with more than 32,767 sales orders', () => {
  it('1. 33,000 sales orders: checked (200) with the other-date warnings at both ends, then confirmed', async () => {
    // The first and the last sales order were confirmed the day before.
    const earlier = await upload([`${so(1)},${EARLIER},C1,JA1.5L,2`, `${so(N)},${EARLIER},C1,JA1.5L,3`], EARLIER);
    expect(earlier.status).toBe(200);
    expect((await confirm(earlier.body.data.batchId)).status).toBe(200);

    const checked = await upload(bigFile(), DAY);
    expect(checked.body.error).toBeNull();
    expect(checked.status).toBe(200);
    const v = checked.body.data.validation;
    expect(v).toMatchObject({ totalRows: N, validRows: N, errorRows: 0 });
    expect(v.totals.salesOrders).toBe(N);
    expect((v.warnings as string[]).filter((w) => /was already confirmed for/.test(w))).toEqual([
      `Sales order ${so(1)} for C1 was already confirmed for ${EARLIER}; this file has it again for ${DAY}. Check that it is not the same order sent twice.`,
      `Sales order ${so(N)} for C1 was already confirmed for ${EARLIER}; this file has it again for ${DAY}. Check that it is not the same order sent twice.`,
    ]);

    const done = await confirm(checked.body.data.batchId);
    expect(done.body.error).toBeNull();
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ ordersCreated: 1, linesCreated: N, cases: N });
    expect(await prisma.intakeLineKey.count({ where: { tenantId, deliveryDate: new Date(`${DAY}T00:00:00Z`) } })).toBe(N);
  });

  it('2. the same file again: checked (200), every line already confirmed and skipped, nothing to add', async () => {
    const again = await upload(bigFile(), DAY);
    expect(again.body.error).toBeNull();
    expect(again.status).toBe(200);
    const v = again.body.data.validation;
    expect(v).toMatchObject({ totalRows: N, validRows: 0 });
    // The whole file was confirmed before: one error names it; each line is a skipped duplicate.
    expect(v.errors[0].message).toMatch(new RegExp(`^These orders were already confirmed for ${DAY} \\(file orders\\.csv, `));
    expect(v.duplicates).toHaveLength(N);
  });
});
