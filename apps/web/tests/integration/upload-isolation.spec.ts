/**
 * Integration (audit P5, E2's proper fix; the recheck's regression R4): while the web app reads a
 * slow upload, it keeps answering - the file is read in a separate parser process, not on the web
 * process's event loop (before P5, every request waited for the whole read) - and an upload the
 * parser refuses leaves nothing behind (no upload batch).
 *
 * Over HTTP against the running app (CI: `next start` with the built parser bundle; locally the
 * dev server, which builds it). Requires the web server running.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';
import { denseSheet, workbook, XLSX_TYPE } from '../lib/zip-fixtures';

let t: TenantHandle;

beforeAll(async () => {
  t = await freshTenant('upiso');
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

async function upload(url: string, bytes: Uint8Array<ArrayBuffer>, name: string, type: string, extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set('file', new Blob([bytes], { type }), name);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  const r = await fetchWith(t.cookieJar, url, { method: 'POST', body: fd });
  return { status: r.status, body: (await r.json()) as { data: unknown; error: unknown } };
}

describe('uploads are read outside the web process (audit P5)', () => {
  it('while a slow file is read, /api/health/live keeps answering quickly', async () => {
    // A legal 34 KB .xlsx the parser reads for seconds (50,100 rows x 10 columns), then refuses
    // "Too many rows". Before P5 the web process answered nothing else meanwhile.
    const slow = new Uint8Array(workbook({ Orders: { deflated: denseSheet(10, 8) } }));
    let done = false;
    const latencies: number[] = [];
    const poll = (async () => {
      while (!done) {
        const t0 = performance.now();
        const r = await fetch(`${BASE}/api/health/live`);
        latencies.push(performance.now() - t0);
        expect(r.status).toBe(200);
        await new Promise((res) => setTimeout(res, 25));
      }
    })();
    const t0 = performance.now();
    const r = await upload(`${BASE}/api/customers/import`, slow, 'customers.xlsx', XLSX_TYPE, { dryRun: '1' });
    const uploadMs = performance.now() - t0;
    done = true;
    await poll;
    expect(r).toEqual({ status: 400, body: { data: null, error: 'Too many rows: more than 50000. Max 50000.' } });
    expect(uploadMs).toBeGreaterThan(1_000);
    expect(latencies.length).toBeGreaterThan(5);
    expect(Math.max(...latencies)).toBeLessThan(Math.min(1_000, uploadMs / 2));
  });

  it('an order file the parser refuses leaves no upload batch', async () => {
    const before = await prisma.uploadBatch.count({ where: { tenantId: t.tenantId } });
    const rows = (n: number) => [['customer_code', 'product_code', 'cases'], ...Array.from({ length: n }, (_, i) => [`C${i}`, 'P1', 2])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows(2)), 'Orders');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows(1)), 'LateOrder');
    const twoSheets = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    const r = await upload(`${BASE}/api/orders/upload`, twoSheets, 'orders.xlsx', XLSX_TYPE);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'MULTIPLE_SHEETS', sheets: [{ name: 'Orders', rows: 2 }, { name: 'LateOrder', rows: 1 }] });
    const tooLong = new Uint8Array(workbook({ Orders: { deflated: denseSheet(10, 8) } }));
    expect((await upload(`${BASE}/api/orders/upload`, tooLong, 'orders.xlsx', XLSX_TYPE)).status).toBe(400);
    expect(await prisma.uploadBatch.count({ where: { tenantId: t.tenantId } })).toBe(before);
  });
});
