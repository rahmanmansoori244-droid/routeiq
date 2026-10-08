/**
 * Review of 8 Oct 2026, fix "csv-intake" (finding s5-security-1): a U+0000 in an order file's cell
 * or name reached `uploadBatch.create`, PostgreSQL refused it (22P05 "\u0000 cannot be converted to
 * text"), and the write was outside any try, so the order upload answered 500 with an EMPTY body:
 * the dispatch screen showed "HTTP 500". Now the parser takes U+0000 out (lib/csv), and a database
 * error on the write answers the route's own CHECK_FAILED body, as a failed check already did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const S = vi.hoisted(() => ({ creates: [] as unknown[], fail: null as Error | null, audits: 0 }));

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'P', email: 'p@a.example' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => S.audits++) }));
vi.mock('@/lib/db', () => ({ prisma: { tenantConfig: { findUnique: async () => null } } }));
vi.mock('@/lib/dispatch/intake-server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/dispatch/intake-server')>();
  return {
    ...real,
    findSameConfirmedFile: async () => null,
    // The check itself is not what this spec is about: the rows as they came from the parser.
    validateIntake: vi.fn(async (_tenantId: string, rows: Record<string, string>[]) => ({
      rows,
      lines: rows,
      errors: [],
      warnings: [],
      duplicates: [],
      totals: { deliveryDates: ['2026-12-01'], cases: 5 },
      fileCases: 5,
      issues: {},
      mapping: {},
      unmappedColumns: [],
      late: { isLate: false },
      depotId: 'd1',
      depotCode: 'D1',
      contentHash: 'h',
    })),
  };
});
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    uploadBatch: {
      // As PostgreSQL: a text or jsonb value with U+0000 is refused.
      create: async ({ data }: { data: unknown }) => {
        if (S.fail) throw S.fail;
        if (JSON.stringify(data).includes('\\u0000')) throw new Error('22P05: unsupported Unicode escape sequence: \\u0000 cannot be converted to text');
        S.creates.push(data);
        return { id: 'b1', fileName: (data as { fileName: string }).fileName };
      },
    },
  }),
}));

import { POST as ordersUpload } from '@/app/api/orders/upload/route';
import { INTAKE_CHECK_FAILED } from '@/lib/dispatch/intake-server';

const post = (file: File) => {
  const fd = new FormData();
  fd.set('file', file);
  fd.set('depotId', 'd1');
  return ordersUpload(new Request('http://localhost/api/orders/upload', { method: 'POST', body: fd }));
};
const ORDERS = 'customer_code,branch_code,delivery_date,product_code,cases\nC-001,__MAIN__,2026-12-01,P1,5\n';

beforeEach(() => {
  S.creates = [];
  S.fail = null;
  S.audits = 0;
});

describe('the order upload with U+0000 in the file, and when the database refuses the write', () => {
  it('a U+0000 in a cell and in the file name: the batch is written without it (before: 500 with an empty body)', async () => {
    const res = await post(new File([ORDERS.replace(',5', ',\u00005')], 'ord\u0000er.csv', { type: 'text/csv' }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.batchId).toBe('b1');
    expect(S.creates).toHaveLength(1);
    expect(S.creates[0]).toMatchObject({ fileName: 'order.csv', validationJson: { lines: [{ cases: '5' }] } });
  });

  it('a database error on the write answers 500 with the CHECK_FAILED body and plain words, not an empty body', async () => {
    S.fail = Object.assign(new Error('Invalid `prisma.uploadBatch.create()` invocation in C:\\app\\route.js:99 ... 22P05'), { code: 'P2010' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await post(new File([ORDERS], 'orders.csv', { type: 'text/csv' }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ data: null, error: { code: 'CHECK_FAILED', message: INTAKE_CHECK_FAILED } });
      // Prisma's text (paths, code lines) goes to the server log only.
      expect(logged).toHaveBeenCalledWith('[orders-upload] saving the checked file failed', S.fail);
      expect(S.audits).toBe(0);
    } finally {
      logged.mockRestore();
    }
  });
});
