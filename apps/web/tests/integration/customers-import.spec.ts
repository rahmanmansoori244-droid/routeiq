/**
 * Integration: customer import (review ADD-import-serviceTimeConfirmed, case-variant twins;
 * stabilization PR2).
 *
 *  - a re-import without the service-time column keeps a dispatcher-confirmed time (and region,
 *    address) instead of writing the default 10 min over it;
 *  - a service time in the file counts as confirmed, so it wins over the customer-type default;
 *  - a code that differs only in letter case updates the existing customer, no twin is created;
 *  - the dry-run reports new / updated rows and confirmed times that would change;
 *  - service times above 480 min are refused.
 *
 * Requires dev server running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';
import { effectiveAttrs } from '@/lib/dispatch/customer-attrs';

let t: TenantHandle;

async function importCsv(csv: string, dryRun = false) {
  const fd = new FormData();
  fd.set('file', new Blob([csv], { type: 'text/csv' }), 'customers.csv');
  if (dryRun) fd.set('dryRun', '1');
  const r = await fetchWith(t.cookieJar, `${BASE}/api/customers/import`, { method: 'POST', body: fd });
  return { status: r.status, body: (await r.json()) as any };
}

beforeAll(async () => {
  t = await freshTenant('custimp');
  const region = await prisma.region.create({ data: { tenantId: t.tenantId, code: 'R1', name: 'Muscat' } });
  await prisma.customer.create({
    data: {
      tenantId: t.tenantId, code: 'C100', name: 'Hyper', branchKey: '__MAIN__', regionId: region.id, address: 'Bawshar',
      avgServiceTimeMin: 45, serviceTimeConfirmed: true, customerType: 'HYPERMARKET', lat: 23.57, lng: 58.39, locationVerified: true,
    },
  });
  await prisma.customerTypeProfile.create({ data: { tenantId: t.tenantId, customerType: 'GROCERY', serviceTimeMin: 8 } });
  await prisma.customer.create({ data: { tenantId: t.tenantId, code: 'G1', name: 'Grocery', branchKey: '__MAIN__', customerType: 'GROCERY' } });
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('customer import', () => {
  it('a re-import without the column keeps the confirmed 45 min, the region and the address', async () => {
    const r = await importCsv('code,name,priority\nC100,Hyper Bawshar,1\n');
    expect(r.status).toBe(200);
    const c = await prisma.customer.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'C100' } });
    expect(c).toMatchObject({ name: 'Hyper Bawshar', avgServiceTimeMin: 45, serviceTimeConfirmed: true, address: 'Bawshar' });
    expect(c.regionId).not.toBeNull();
  });

  it('a service time in the file is confirmed and wins over the customer-type default', async () => {
    const r = await importCsv('code,name,priority,avg_service_time_min\nG1,Grocery,3,25\n');
    expect(r.status).toBe(200);
    const g = await prisma.customer.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'G1' } });
    expect(g).toMatchObject({ avgServiceTimeMin: 25, serviceTimeConfirmed: true });
    const profiles = new Map((await prisma.customerTypeProfile.findMany({ where: { tenantId: t.tenantId } })).map((p) => [p.customerType as string, p]));
    expect(effectiveAttrs(g, profiles, { serviceTimeMin: 10 }).serviceMin).toBe(25);
  });

  it('a code in other letter case updates the existing customer (no twin)', async () => {
    const r = await importCsv('code,name,priority\nc100,Hyper renamed,1\n');
    expect(r.status).toBe(200);
    expect(await prisma.customer.count({ where: { tenantId: t.tenantId, code: { equals: 'C100', mode: 'insensitive' } } })).toBe(1);
    expect((await prisma.customer.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'C100' } })).name).toBe('Hyper renamed');
    // Creating one by hand is refused too.
    const twin = await fetchWith(t.cookieJar, `${BASE}/api/customers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'c100', name: 'Twin' }),
    });
    expect(twin.status).toBe(409);
  });

  it('the dry-run lists what would change, and refuses more than 480 min', async () => {
    const dry = await importCsv('code,name,priority,avg_service_time_min\nC100,Hyper,1,30\nNEW1,New shop,3,\n', true);
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ dryRun: true, creates: 1, updates: 1, errorRows: 0 });
    expect(dry.body.data.confirmedServiceChanges).toEqual([{ code: 'C100', branchCode: null, from: 45, to: 30 }]);
    expect((await prisma.customer.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'C100' } })).avgServiceTimeMin).toBe(45);
    const tooLong = await importCsv('code,name,priority,avg_service_time_min\nC100,Hyper,1,600\n', true);
    expect(tooLong.body.data.errorRows).toBe(1);
    expect(tooLong.body.data.errors[0].message).toMatch(/0-480/);
  });
});
