/**
 * Order validation pipeline — covers the rules in CLAUDE.md §6.
 *
 * The pipeline reads tenant master data via `tenantDb()`, so this suite seeds
 * an ephemeral tenant with the customers + products the fixture rows reference.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { validateOrderRows, parseRawRow, checkHeaders } from '@/lib/order-validate';
import { tenantDb } from '@/lib/tenant';

const prisma = new PrismaClient();

const SUFFIX = `ov-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let tenantId: string;

function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  const t = await prisma.tenant.create({
    data: {
      slug: `test-ov-${SUFFIX}`,
      name: `OrderValidate ${SUFFIX}`,
      country: 'Testland',
      currency: 'OMR',
      config: { create: {} },
      depots: { create: { code: 'D1', name: 'D1', lat: 23.5, lng: 58.4 } },
      regions: { create: { code: 'R1', name: 'R1' } },
    },
  });
  tenantId = t.id;
  // Seed customers and products via tenantDb wrapper.
  const db = tenantDb(tenantId);
  await db.customer.createMany({
    data: [
      { tenantId, code: 'C1', name: 'Customer 1', branchKey: '__MAIN__', lat: 23.5, lng: 58.4, priority: 3, avgServiceTimeMin: 10, paymentType: 'CREDIT' },
      { tenantId, code: 'C1', name: 'Customer 1 / B2', branchCode: 'B2', branchKey: 'B2', lat: 23.5, lng: 58.4, priority: 3, avgServiceTimeMin: 10, paymentType: 'CREDIT' },
      { tenantId, code: 'C2', name: 'Customer 2', branchKey: '__MAIN__', lat: null, lng: null, geocodeConfidence: 'MISSING', priority: 3, avgServiceTimeMin: 10, paymentType: 'CREDIT' },
      { tenantId, code: 'CINACT', name: 'Inactive', branchKey: '__MAIN__', lat: 23.5, lng: 58.4, priority: 3, avgServiceTimeMin: 10, paymentType: 'CREDIT', active: false },
    ],
  });
  await db.product.createMany({
    data: [
      { tenantId, code: 'P1', name: 'Water 500', weightPerCaseKg: 12, volumePerCaseL: 12 },
      { tenantId, code: 'PINACT', name: 'Inactive', weightPerCaseKg: 5, volumePerCaseL: 5, active: false },
    ],
  });
});

afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } });
  await prisma.$disconnect();
});

describe('checkHeaders', () => {
  it('reports missing required headers', () => {
    const errs = checkHeaders([{ customer_code: 'X', cases: '1' } as Record<string, string>]);
    expect(errs.length).toBeGreaterThan(0);
  });
  it('passes when required headers present', () => {
    const errs = checkHeaders([
      { customer_code: 'X', delivery_date: '2030-01-01', product_code: 'P', cases: '1' } as Record<string, string>,
    ]);
    expect(errs).toEqual([]);
  });
});

describe('parseRawRow', () => {
  const goodRow = {
    customer_code: 'C1',
    branch_code: '',
    delivery_date: tomorrowIso(),
    product_code: 'P1',
    cases: '5',
  };

  it('parses a valid row', () => {
    const r = parseRawRow(goodRow, 2);
    expect('message' in r).toBe(false);
  });
  it('rejects missing customer_code', () => {
    const r = parseRawRow({ ...goodRow, customer_code: '' }, 2);
    expect('message' in r).toBe(true);
  });
  it('rejects malformed delivery_date', () => {
    const r = parseRawRow({ ...goodRow, delivery_date: 'tomorrow' }, 2);
    expect('message' in r).toBe(true);
  });
  it('rejects cases=0', () => {
    const r = parseRawRow({ ...goodRow, cases: '0' }, 2);
    expect('message' in r).toBe(true);
  });
  it('rejects negative cases', () => {
    const r = parseRawRow({ ...goodRow, cases: '-1' }, 2);
    expect('message' in r).toBe(true);
  });
  it('rejects priority outside 1-5', () => {
    const r = parseRawRow({ ...goodRow, priority: '99' } as Record<string, string>, 2);
    expect('message' in r).toBe(true);
  });
  it('normalizes blank branch_code to __MAIN__', () => {
    const r = parseRawRow(goodRow, 2);
    if ('message' in r) throw new Error('expected parse to succeed');
    expect(r.branchKey).toBe('__MAIN__');
  });
});

describe('validateOrderRows (integration with tenant master)', () => {
  const tomorrow = tomorrowIso();

  it('rejects unknown customer code', async () => {
    const db = tenantDb(tenantId);
    const result = await validateOrderRows(
      [{ customer_code: 'UNKNOWN', branch_code: '', delivery_date: tomorrow, product_code: 'P1', cases: '3' }],
      db,
    );
    expect(result.errors.some((e) => /Unknown customer/i.test(e.message))).toBe(true);
  });

  it('rejects unknown product code', async () => {
    const db = tenantDb(tenantId);
    const result = await validateOrderRows(
      [{ customer_code: 'C1', branch_code: '', delivery_date: tomorrow, product_code: 'UNKNOWN-P', cases: '3' }],
      db,
    );
    expect(result.errors.some((e) => /Unknown product/i.test(e.message))).toBe(true);
  });

  it('rejects inactive customer', async () => {
    const db = tenantDb(tenantId);
    const result = await validateOrderRows(
      [{ customer_code: 'CINACT', branch_code: '', delivery_date: tomorrow, product_code: 'P1', cases: '3' }],
      db,
    );
    expect(result.errors.some((e) => /inactive/i.test(e.message))).toBe(true);
  });

  it('warns on missing coords (non-blocking)', async () => {
    const db = tenantDb(tenantId);
    const result = await validateOrderRows(
      [{ customer_code: 'C2', branch_code: '', delivery_date: tomorrow, product_code: 'P1', cases: '3' }],
      db,
    );
    expect(result.errors.length).toBe(0);
    expect(result.warnings.some((w) => /no coordinates/i.test(w.message))).toBe(true);
  });

  it('rejects date older than today', async () => {
    const db = tenantDb(tenantId);
    const result = await validateOrderRows(
      [{ customer_code: 'C1', branch_code: '', delivery_date: '2020-01-01', product_code: 'P1', cases: '3' }],
      db,
    );
    expect(result.errors.some((e) => /past/i.test(e.message))).toBe(true);
  });

  it('rejects date more than 14 days out', async () => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    const future = d.toISOString().slice(0, 10);
    const db = tenantDb(tenantId);
    const result = await validateOrderRows(
      [{ customer_code: 'C1', branch_code: '', delivery_date: future, product_code: 'P1', cases: '3' }],
      db,
    );
    expect(result.errors.some((e) => /14 days/i.test(e.message))).toBe(true);
  });

  it('merges duplicate (customer, product, date) rows with warning', async () => {
    const db = tenantDb(tenantId);
    const result = await validateOrderRows(
      [
        { customer_code: 'C1', branch_code: '', delivery_date: tomorrow, product_code: 'P1', cases: '3' },
        { customer_code: 'C1', branch_code: '', delivery_date: tomorrow, product_code: 'P1', cases: '2' },
      ],
      db,
    );
    expect(result.errors).toEqual([]);
    expect(result.validated.length).toBe(1);
    expect(result.validated[0].cases).toBe(5);
    expect(result.warnings.some((w) => /Merged/i.test(w.message))).toBe(true);
  });

  it('respects branchKey — same code different branches are distinct', async () => {
    const db = tenantDb(tenantId);
    const result = await validateOrderRows(
      [
        { customer_code: 'C1', branch_code: '', delivery_date: tomorrow, product_code: 'P1', cases: '3' },
        { customer_code: 'C1', branch_code: 'B2', delivery_date: tomorrow, product_code: 'P1', cases: '2' },
      ],
      db,
    );
    expect(result.errors).toEqual([]);
    expect(result.validated.length).toBe(2);
  });
});
