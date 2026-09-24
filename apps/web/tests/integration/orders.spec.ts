/**
 * Integration: order upload + UploadBatch lifecycle.
 * Requires dev server running.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, seedMinimal, tomorrowIso } from './helpers';

const createdSlugs = new Set<string>();

afterAll(async () => {
  for (const slug of createdSlugs) await cleanupTenant(slug);
  await prisma.$disconnect();
});

function csvFromRows(rows: string[][]): string {
  const header = 'customer_code,branch_code,delivery_date,product_code,cases,priority,payment_collection_amount,notes';
  return [header, ...rows.map((r) => r.join(','))].join('\n');
}

async function uploadCsv(jar: import('./helpers').CookieJar, csv: string, dryRun = false): Promise<Response> {
  const fd = new FormData();
  fd.set('file', new Blob([csv], { type: 'text/csv' }), 'orders.csv');
  if (dryRun) fd.set('dryRun', '1');
  return fetchWith(jar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
}

/** A delivery date never past the 18:00 (Asia/Muscat) planning cutoff, whatever time the suite
 * runs: a confirm for tomorrow after 18:00 needs a late reason. */
function beforeCutoffIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 3);
  return d.toISOString().slice(0, 10);
}

describe('order upload + confirm', () => {
  it('rejects upload with errors; commit attempt also fails', async () => {
    const h = await freshTenant('ord-bad');
    createdSlugs.add(h.slug);
    await seedMinimal(h.tenantId);

    const tomorrow = tomorrowIso();
    const csv = csvFromRows([
      ['C-001', '', tomorrow, 'P-WATER', '5', '3', '', ''],
      ['', '', tomorrow, 'P-WATER', '3', '3', '', ''], // missing customer_code
      ['C-002', '', tomorrow, 'P-WATER', '-1', '3', '', ''], // negative cases
      ['C-XXX', '', tomorrow, 'P-WATER', '2', '3', '', ''], // unknown customer: NOT an error (new, LOCATION REQUIRED)
    ]);

    const res = await uploadCsv(h.cookieJar, csv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { batchId: string; validation: { errorRows: number; errors: { row: number }[]; issues: { newCustomers: { code: string }[] } } };
    };
    expect(body.data.validation.errorRows).toBe(2);
    expect(body.data.validation.errors.map((e) => e.row).sort()).toEqual([3, 4]);
    expect(body.data.validation.issues.newCustomers.map((c) => c.code)).toEqual(['C-XXX']);

    // Try to confirm — must refuse.
    const confirm = await fetchWith(h.cookieJar, `${BASE}/api/orders/${body.data.batchId}/confirm`, {
      method: 'POST',
    });
    expect(confirm.status).toBe(400);
  });

  it('confirms a clean upload, creates orders with correct totals from product master', async () => {
    const h = await freshTenant('ord-clean');
    createdSlugs.add(h.slug);
    await seedMinimal(h.tenantId);

    const tomorrow = beforeCutoffIso();
    const csv = csvFromRows([
      ['C-001', '', tomorrow, 'P-WATER', '5', '3', '', ''],
      ['C-002', '', tomorrow, 'P-WATER', '3', '3', '', ''],
      ['C-003', '', tomorrow, 'P-WATER', '4', '2', '', ''],
    ]);

    const res = await uploadCsv(h.cookieJar, csv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { batchId: string; validation: { errorRows: number; validRows: number } } };
    expect(body.data.validation.errorRows).toBe(0);
    expect(body.data.validation.validRows).toBe(3);

    const confirm = await fetchWith(h.cookieJar, `${BASE}/api/orders/${body.data.batchId}/confirm`, {
      method: 'POST',
    });
    expect(confirm.status).toBe(200);
    const confirmBody = (await confirm.json()) as { data: { ordersCreated: number; linesCreated: number } };
    expect(confirmBody.data.ordersCreated).toBe(3);
    expect(confirmBody.data.linesCreated).toBe(3);

    // Totals: 5 cases × 12 kg = 60 kg per row.
    const orders = await prisma.order.findMany({ where: { tenantId: h.tenantId } });
    const cases5 = orders.find((o) => o.totalCases === 5);
    expect(cases5).toBeDefined();
    expect(cases5!.totalWeightKg).toBeCloseTo(60, 1);
  });

  it('UploadBatch is linked from every created order', async () => {
    const h = await freshTenant('ord-batch');
    createdSlugs.add(h.slug);
    await seedMinimal(h.tenantId);

    const tomorrow = beforeCutoffIso();
    const csv = csvFromRows([
      ['C-001', '', tomorrow, 'P-WATER', '2', '3', '', ''],
      ['C-002', '', tomorrow, 'P-WATER', '3', '3', '', ''],
    ]);
    const res = await uploadCsv(h.cookieJar, csv);
    const body = (await res.json()) as { data: { batchId: string } };
    await fetchWith(h.cookieJar, `${BASE}/api/orders/${body.data.batchId}/confirm`, { method: 'POST' });

    const orders = await prisma.order.findMany({ where: { tenantId: h.tenantId } });
    for (const o of orders) expect(o.uploadBatchId).toBe(body.data.batchId);
  });

  it('bulk-delete-batch cascades to its orders', async () => {
    const h = await freshTenant('ord-del');
    createdSlugs.add(h.slug);
    await seedMinimal(h.tenantId);

    const tomorrow = beforeCutoffIso();
    const csv = csvFromRows([['C-001', '', tomorrow, 'P-WATER', '2', '3', '', '']]);
    const res = await uploadCsv(h.cookieJar, csv);
    const body = (await res.json()) as { data: { batchId: string } };
    await fetchWith(h.cookieJar, `${BASE}/api/orders/${body.data.batchId}/confirm`, { method: 'POST' });

    expect(await prisma.order.count({ where: { tenantId: h.tenantId } })).toBe(1);
    const del = await fetchWith(h.cookieJar, `${BASE}/api/orders/${body.data.batchId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await prisma.order.count({ where: { tenantId: h.tenantId } })).toBe(0);
  });

  it('rejects unsupported file content-type', async () => {
    const h = await freshTenant('ord-mime');
    createdSlugs.add(h.slug);
    await seedMinimal(h.tenantId);

    const fd = new FormData();
    fd.set('file', new Blob(['not a csv'], { type: 'image/png' }), 'fake.png');
    const res = await fetchWith(h.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
    expect(res.status).toBe(400);
  });
});
