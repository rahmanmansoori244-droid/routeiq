/**
 * Audit P5: the three upload routes (order file and late orders, customer import, baseline) read the
 * file in the parser process. When it is refused there - too long, too much memory, the reader
 * stopped, or every parser busy - the route answers `{ data: null, error }` in plain words with
 * 400 / 500 / 503 (503 with Retry-After), and writes nothing: no upload batch, no customer, no
 * baseline, no audit row. A workbook with orders on two sheets is answered as before P5.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

const S = vi.hoisted(() => ({ writes: [] as string[] }));
const write = (what: string) => async () => {
  S.writes.push(what);
  return { id: 'x', _count: { assignments: 0 } };
};
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'P', email: 'p@a.example' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => S.writes.push('audit')) }));
vi.mock('@/lib/db', () => ({ prisma: { tenantConfig: { findUnique: async () => null } } }));
vi.mock('@/lib/dispatch/intake-server', () => ({
  DepotRequired: class extends Error {},
  findSameConfirmedFile: async () => null,
  legacyRowsHash: () => 'h',
  validateIntake: vi.fn(async () => {
    S.writes.push('validateIntake');
    throw new Error('not reached in these tests');
  }),
}));
vi.mock('@/lib/dispatch/service-area', async () => {
  const { DEFAULT_SERVICE_AREA } = await import('@/lib/dispatch/location-input');
  return { tenantServiceArea: async () => DEFAULT_SERVICE_AREA };
});
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    uploadBatch: { create: write('uploadBatch.create') },
    region: { findMany: async () => [] },
    customer: { findMany: async () => [], create: write('customer.create'), update: write('customer.update'), updateMany: write('customer.updateMany') },
    runPlan: { findUnique: async () => ({ id: 'run1', runDate: new Date('2026-10-01') }) },
    order: { findMany: async () => [] },
    manualBaseline: { create: write('manualBaseline.create') },
    $transaction: async () => S.writes.push('$transaction'),
  }),
}));

import { POST as ordersUpload } from '@/app/api/orders/upload/route';
import { POST as customersImport } from '@/app/api/customers/import/route';
import { POST as baselineUpload } from '@/app/api/runs/[id]/baseline/route';
import { parseUploadIsolated, setUploadParseTestOverrides, UPLOAD_REFUSALS } from '@/lib/upload-parse';
import { outcome, standIn, useRealUploadParser } from './upload-parse-helpers';

useRealUploadParser();

const csv = () => new File(['code,name\nC1,One\n'], 'file.csv', { type: 'text/csv' });
const post = (url: string, file: File) => {
  const fd = new FormData();
  fd.set('file', file);
  return new Request(url, { method: 'POST', body: fd });
};
const ROUTES = {
  'order file (and late orders)': (f: File) => ordersUpload(post('http://localhost/api/orders/upload', f)),
  'customer import': (f: File) => customersImport(post('http://localhost/api/customers/import', f)),
  baseline: (f: File) => baselineUpload(post('http://localhost/api/runs/run1/baseline', f), { params: { id: 'run1' } }),
};
async function answer(res: Response) {
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() };
}

beforeEach(() => {
  S.writes = [];
});

describe.each(Object.entries(ROUTES))('the %s route when the parser refuses the file (audit P5)', (_name, route) => {
  it('too long: 400 "takes too long", the parser killed, nothing written', async () => {
    process.env.UPLOAD_PARSE_TIMEOUT_MS = '400';
    setUploadParseTestOverrides({ entry: standIn('busy') });
    expect(await answer(await route(csv()))).toEqual({ status: 400, retryAfter: null, body: { data: null, error: UPLOAD_REFUSALS.UPLOAD_TIMEOUT.message } });
    expect(S.writes).toEqual([]);
  });

  it('too much memory: 400 "needs too much memory", nothing written', async () => {
    process.env.UPLOAD_WORKER_MAX_HEAP_MB = '64';
    setUploadParseTestOverrides({ entry: standIn('hog') });
    expect(await answer(await route(csv()))).toEqual({ status: 400, retryAfter: null, body: { data: null, error: UPLOAD_REFUSALS.UPLOAD_OUT_OF_MEMORY.message } });
    expect(S.writes).toEqual([]);
  });

  it('the reader stopped: 500, nothing written', async () => {
    setUploadParseTestOverrides({ entry: standIn('crash') });
    expect(await answer(await route(csv()))).toEqual({ status: 500, retryAfter: null, body: { data: null, error: UPLOAD_REFUSALS.UPLOAD_CRASHED.message } });
    expect(S.writes).toEqual([]);
  });

  it('every parser busy: 503 "try again in a moment" with Retry-After, nothing written', async () => {
    process.env.UPLOAD_PARSE_CONCURRENCY = '1';
    process.env.UPLOAD_PARSE_TIMEOUT_MS = '1500';
    setUploadParseTestOverrides({ entry: standIn('busy'), queueWaitMs: 100 });
    const holder = outcome(parseUploadIsolated(csv()));
    await new Promise((r) => setTimeout(r, 50));
    expect(await answer(await route(csv()))).toEqual({
      status: 503,
      retryAfter: '5',
      body: { data: null, error: 'RouteIQ is reading other files right now. Try again in a moment.' },
    });
    expect(S.writes).toEqual([]);
    await holder;
  });
});

describe('the order file route with the real parser', () => {
  it('orders on two sheets: 400 { code, message, sheets } as before P5, nothing written', async () => {
    const rows = (n: number) => [['customer_code', 'product_code', 'cases'], ...Array.from({ length: n }, (_, i) => [`C${i}`, 'P1', 2])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows(3)), 'Orders');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows(1)), 'LateOrder');
    const file = new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer], 'orders.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(await answer(await ROUTES['order file (and late orders)'](file))).toEqual({
      status: 400,
      retryAfter: null,
      body: {
        data: null,
        error: {
          code: 'MULTIPLE_SHEETS',
          message:
            'This workbook has order rows on 2 sheets: "Orders" (3 rows), "LateOrder" (1 row). Nothing was read. Upload each sheet as its own file (save it as a separate workbook or CSV), so each one is checked and confirmed on its own.',
          sheets: [
            { name: 'Orders', rows: 3 },
            { name: 'LateOrder', rows: 1 },
          ],
        },
      },
    });
    expect(S.writes).toEqual([]);
  });
});
