/**
 * An order file may hold up to 50,000 rows, so it may hold more than 32,767 different sales orders.
 * PostgreSQL takes at most 32,767 bind parameters in one query, and Prisma does not split an `in`
 * list that comes with other conditions. The check of such a file asked for every sales order of the
 * file in one query, so the upload was refused with Prisma's own text ("Invalid
 * `prisma.intakeLineKey.findMany()` invocation ... Query parameter limit exceeded ...") instead of
 * being checked (third review of audit P5; the bug is older than P5).
 *
 *  - The sales orders are asked for in parts of `IN_LIST_PART` (10,000); no query of the check
 *    passes the limit (the fake database below refuses one that does, as PostgreSQL would), and the
 *    warning "already confirmed for another date" is still given for a sales order in any part.
 *  - Anything else that goes wrong while the file is checked (the database) is answered in plain
 *    words (500, nothing saved); Prisma's text goes only to the server log.
 *  - Such a file can then be added: the confirm put each line into its customer's order by copying
 *    the order's list of lines, which took 5-40 s for one customer's 40,000 lines on this PC, and
 *    the confirm's transaction has 60 s.
 *
 * The same on real PostgreSQL: tests/integration/intake-many-sales-orders-db.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { fakePrisma, resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'Planner One', email: 'p@a.example' } }),
}));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));

import { POST as uploadPost } from '@/app/api/orders/upload/route';
import { confirmIntake, IN_LIST_PART, INTAKE_CHECK_FAILED, inParts, validateIntake } from '@/lib/dispatch/intake-server';
import { dateOnly } from '@/lib/dispatch/time';

const T = 'tA';
const DAY = '2026-10-07';
const EARLIER = '2026-10-05';
/** PostgreSQL's limit of bind parameters in one query. */
const PG_MAX_BINDS = 32_767;
const RAW_PRISMA_TEXT =
  '\nInvalid `prisma.intakeLineKey.findMany()` invocation in\nC:\\app\\lib\\dispatch\\intake-server.ts:241:45\n\n  238 |   if (fileSos.length) {\n-> 241     const keys = await prisma.intakeLineKey.findMany(\nQuery parameter limit exceeded error: Parameter limits for this database provider require this query to be split into multiple queries, but the negation filters used prevent the query from being split.';

/** The bind parameters a where clause needs: one per value, every value of a list included. */
function binds(where: unknown): number {
  if (Array.isArray(where)) return where.reduce((n: number, w) => n + binds(w), 0);
  if (where === null || where === undefined) return 0;
  if (where instanceof Date || typeof where !== 'object') return 1;
  return Object.values(where).reduce((n: number, v) => n + binds(v), 0);
}

/** The largest query the check made, per model and method. */
let largest: Record<string, number> = {};

/** Every read of the fake database refuses a query over PostgreSQL's limit, as Prisma does (P2029). */
function limitBinds() {
  for (const model of ['intakeLineKey', 'orderLine', 'customer', 'product', 'depot', 'tenantConfig', 'uploadBatch', 'runPlan', 'planLoad']) {
    for (const method of ['findMany', 'findFirst', 'findUnique', 'findUniqueOrThrow', 'count']) {
      const real = fakePrisma[model][method];
      vi.spyOn(fakePrisma[model], method).mockImplementation(async (...args: unknown[]) => {
        const a = (args[0] ?? {}) as { where?: unknown };
        const n = binds(a.where);
        largest[`${model}.${method}`] = Math.max(largest[`${model}.${method}`] ?? 0, n);
        if (n > PG_MAX_BINDS) throw new Prisma.PrismaClientKnownRequestError(RAW_PRISMA_TEXT, { code: 'P2029', clientVersion: '5.22.0' });
        return real(a);
      });
    }
  }
}

const so = (i: number) => `SO${String(i).padStart(5, '0')}`;
/** A CSV of `n` rows, each its own sales order, for one customer and product. */
function csv(n: number): string {
  const lines = ['sales_order_no,delivery_date,customer_code,product_code,cases'];
  for (let i = 1; i <= n; i++) lines.push(`${so(i)},${DAY},C1,W500,1`);
  return `${lines.join('\n')}\n`;
}
async function upload(text: string) {
  const fd = new FormData();
  fd.set('file', new File([text], 'orders.csv', { type: 'text/csv' }));
  fd.set('depotId', 'D1');
  fd.set('deliveryDate', DAY);
  const res = await uploadPost(new Request('http://localhost/api/orders/upload', { method: 'POST', body: fd }));
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
}

beforeEach(() => {
  resetDb();
  largest = {};
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, orderColumnMapJson: null, timezone: 'Asia/Muscat', dateOrder: 'DMY', planningCutoffMin: 1080 }];
  tables.depot = [{ id: 'D1', tenantId: T, code: 'GHALA', name: 'Ghala', lat: 23.58, lng: 58.39, active: true, historyOnly: false }];
  tables.customer = [{ id: 'cust1', tenantId: T, code: 'C1', branchKey: '__MAIN__', branchCode: null, name: 'Customer One', active: true, lat: 23.6, lng: 58.4 }];
  tables.product = [{ id: 'prod1', tenantId: T, code: 'W500', name: 'Water 500ml', active: true, weightPerCaseKg: 12 }];
  limitBinds();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inParts: a list that grows with the file is asked for in parts', () => {
  it('splits in order into parts of IN_LIST_PART (10,000), far below the 32,767 limit', () => {
    expect(IN_LIST_PART).toBe(10_000);
    const values = Array.from({ length: 25_001 }, (_, i) => i);
    const parts = inParts(values);
    expect(parts.map((p) => p.length)).toEqual([10_000, 10_000, 5_001]);
    expect(parts.flat()).toEqual(values);
    expect(inParts([])).toEqual([]);
    expect(inParts(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });
});

describe('an order file with more than 32,767 different sales orders (third review of audit P5)', () => {
  it('40,000 sales orders: checked (200), every line valid, no query over the limit; the other-date warning in any part', async () => {
    // Confirmed earlier for another date: the first and the last sales order (different parts);
    // one confirmed for this same date is no "other date" (as with the old notIn).
    tables.intakeLineKey = [
      { id: 'k1', tenantId: T, salesOrderNorm: so(1), customerId: 'cust1', deliveryDate: dateOnly(EARLIER) },
      { id: 'k2', tenantId: T, salesOrderNorm: so(40_000), customerId: 'cust1', deliveryDate: dateOnly(EARLIER) },
      { id: 'k3', tenantId: T, salesOrderNorm: so(20_000), customerId: 'cust1', deliveryDate: dateOnly(DAY) },
      { id: 'k4', tenantId: 'tB', salesOrderNorm: so(30_000), customerId: 'cust1', deliveryDate: dateOnly(EARLIER) },
    ];
    const r = await upload(csv(40_000));
    expect(r.body.error).toBeNull();
    expect(r.status).toBe(200);
    const v = r.body.data.validation;
    expect(v.totalRows).toBe(40_000);
    expect(v.validRows).toBe(40_000);
    expect(v.errorRows).toBe(0);
    expect(v.totals.salesOrders).toBe(40_000);
    const otherDate = (v.warnings as string[]).filter((w) => /was already confirmed for/.test(w));
    expect(otherDate).toEqual([
      `Sales order ${so(1)} for C1 was already confirmed for ${EARLIER}; this file has it again for ${DAY}. Check that it is not the same order sent twice.`,
      `Sales order ${so(40_000)} for C1 was already confirmed for ${EARLIER}; this file has it again for ${DAY}. Check that it is not the same order sent twice.`,
    ]);
    // Asked in parts: the largest query holds one part and the company.
    expect(largest['intakeLineKey.findMany']).toBe(IN_LIST_PART + 1);
    expect(Math.max(...Object.values(largest))).toBeLessThanOrEqual(PG_MAX_BINDS);
    expect(tables.uploadBatch).toHaveLength(1);
    expect(tables.uploadBatch[0]).toMatchObject({ validRows: 40_000, errorRows: 0, status: 'VALIDATED' });
  });

  it('exactly the sizes around the limit (32,766 and 32,767 sales orders) are checked too', async () => {
    for (const n of [32_766, 32_767]) {
      resetDb();
      tables.tenantConfig = [{ id: 'cfg', tenantId: T, orderColumnMapJson: null, timezone: 'Asia/Muscat', dateOrder: 'DMY', planningCutoffMin: 1080 }];
      tables.depot = [{ id: 'D1', tenantId: T, code: 'GHALA', name: 'Ghala', lat: 23.58, lng: 58.39, active: true, historyOnly: false }];
      tables.customer = [{ id: 'cust1', tenantId: T, code: 'C1', branchKey: '__MAIN__', branchCode: null, name: 'Customer One', active: true, lat: 23.6, lng: 58.4 }];
      tables.product = [{ id: 'prod1', tenantId: T, code: 'W500', name: 'Water 500ml', active: true, weightPerCaseKg: 12 }];
      const r = await upload(csv(n));
      expect(r.status, String(n)).toBe(200);
      expect(r.body.data.validation.validRows, String(n)).toBe(n);
    }
  });
});

describe('such a file can be added (confirm)', () => {
  it("one customer's 40,000 lines become one order with 40,000 lines and keys, in under 3 s (the lines were copied 40,000 times)", async () => {
    const rows = csv(40_000)
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => {
        const [sales_order_no, delivery_date, customer_code, product_code, cases] = l.split(',');
        return { sales_order_no, delivery_date, customer_code, product_code, cases };
      });
    const v = await validateIntake(T, rows, { depotId: 'D1', defaultDeliveryDate: DAY });
    expect(v.lines).toHaveLength(40_000);
    const started = Date.now();
    const done = await confirmIntake(fakePrisma as never, T, { id: 'batch1', depotId: 'D1' }, v, { id: 'u1' }, { isLate: false, reason: null });
    const ms = Date.now() - started;
    expect(done).toMatchObject({ ordersCreated: 1, linesCreated: 40_000, cases: 40_000 });
    expect(tables.orderLine).toHaveLength(40_000);
    expect(tables.intakeLineKey).toHaveLength(40_000);
    expect(tables.orderLine.map((l) => l.sourceRow)).toEqual(Array.from({ length: 40_000 }, (_, i) => i + 2));
    // Measured on this PC with the fake database: 0.14-0.27 s; copying the list for each line took
    // 7-14 s here (40 s in a real confirm).
    expect(ms).toBeLessThan(3_000);
  });
});

describe('a database error while the file is checked is answered in plain words', () => {
  it('500 with what to do, no Prisma text, nothing saved; the details go to the server log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(fakePrisma.intakeLineKey, 'findMany').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(RAW_PRISMA_TEXT, { code: 'P2029', clientVersion: '5.22.0' }),
    );
    const r = await upload(csv(3));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ data: null, error: { code: 'CHECK_FAILED', message: INTAKE_CHECK_FAILED } });
    expect(INTAKE_CHECK_FAILED).toBe('RouteIQ could not check this file. Nothing was saved. Try again in a moment. If it happens again, tell your administrator.');
    expect(JSON.stringify(r.body)).not.toMatch(/prisma|invocation|parameter|intake-server/i);
    expect(tables.uploadBatch ?? []).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith('[orders-upload] checking the file failed', expect.objectContaining({ code: 'P2029' }));
  });

  it('the depot rule is still answered as before (422 DEPOT_NOT_ACTIVE), not as a failed check', async () => {
    tables.depot[0].active = false;
    const r = await upload(csv(2));
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'DEPOT_NOT_ACTIVE' });
  });
});
