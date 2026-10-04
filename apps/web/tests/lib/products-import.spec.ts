/**
 * Truck capacity in pallets (owner decision 4 Oct 2026), part B: the products import and the product
 * fields. The pilot's product master (46+ SKUs) gets its cases per pallet from the ERP in one file:
 * - lib/dispatch/product-import.ts: header aliases, blank = keep, whole-number factors, errors per row,
 *   create / update / unchanged, case-insensitive codes, products still without a factor;
 * - POST /api/products/import: company admins only, Validate only writes nothing, a file with an error
 *   imports nothing, each product created or changed is audited plus one PRODUCTS_IMPORTED row;
 * - productSchema.casesPerPallet and the truck's bays: whole numbers, '' / null = not set.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { headerKey, planProductImport, productsStillWithoutFactor, readProductRows, type KnownImportProduct } from '@/lib/dispatch/product-import';
import { productSchema, truckSchema } from '@/lib/schemas';

const state = vi.hoisted(() => ({
  role: 'TENANT_ADMIN' as string,
  products: [] as Record<string, unknown>[],
  creates: [] as Record<string, unknown>[],
  updates: [] as { id: string; data: Record<string, unknown> }[],
  audits: [] as Record<string, unknown>[],
}));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: state.role, name: 'Admin', email: 'a@x' } })) }));
vi.mock('@/lib/audit', () => ({
  audit: vi.fn(async (a: Record<string, unknown>) => {
    state.audits.push(a);
  }),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: () => ({ ok: true }), LIMITS: { ordersUpload: { limit: 1000, windowMs: 1000 } } }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    product: {
      findMany: async () => state.products,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.creates.push(data);
        return { id: `new-${state.creates.length}`, ...data };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        state.updates.push({ id: where.id, data });
        return { id: where.id, ...data };
      },
    },
  }),
}));

import { POST } from '@/app/api/products/import/route';

async function importCsv(csv: string, dryRun = false) {
  const fd = new FormData();
  fd.set('file', new File([csv], 'products.csv', { type: 'text/csv' }));
  if (dryRun) fd.set('dryRun', '1');
  const res = await POST(new Request('http://localhost/api/products/import', { method: 'POST', body: fd }));
  return { status: res.status, body: (await res.json()) as any };
}

const KNOWN: KnownImportProduct[] = [
  { id: 'p1', code: 'JA0.5L', name: 'JA0.5L', weightPerCaseKg: 9.9, casesPerPallet: null, active: true },
  { id: 'p2', code: 'TN1.5L', name: 'Tanuf 1.5L', weightPerCaseKg: 12, casesPerPallet: 39, active: true },
  { id: 'p3', code: 'OLD-1', name: 'Old', weightPerCaseKg: 5, casesPerPallet: null, active: false },
];

beforeEach(() => {
  state.role = 'TENANT_ADMIN';
  state.products = KNOWN.map((p) => ({ ...p }));
  state.creates = [];
  state.updates = [];
  state.audits = [];
});

describe('reading a products file (product-import.ts)', () => {
  it('reads the ERP header names without case, spaces or punctuation', () => {
    expect(headerKey('Cases per pallet')).toBe('casesperpallet');
    expect(headerKey('weight_per_case_kg_ESTIMATE')).toBe('weightpercasekgestimate');
    const r = readProductRows([
      { 'item code': 'JA0.5L', description: 'JA 0.5 L x 24', 'weight per case (kg)': '9.9', 'pallet factor': '96', status: 'yes' },
      { 'item code': 'SS0.5L', description: '', 'weight per case (kg)': '', 'pallet factor': '84', status: '' },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.columns.sort()).toEqual(['active', 'casesPerPallet', 'code', 'name', 'weightPerCaseKg']);
    expect(r.rows).toEqual([
      { row: 2, code: 'JA0.5L', name: 'JA 0.5 L x 24', weightPerCaseKg: 9.9, casesPerPallet: 96, active: true },
      // Blank cells keep what the product has.
      { row: 3, code: 'SS0.5L', name: null, weightPerCaseKg: null, casesPerPallet: 84, active: null },
    ]);
  });

  it('refuses a row with a factor that is not a whole number 1-10,000, a bad weight or active, a blank or repeated code', () => {
    const r = readProductRows([
      { code: 'A', cases_per_pallet: '84.5' },
      { code: 'B', cases_per_pallet: '0' },
      { code: 'C', cases_per_pallet: 'abc' },
      { code: 'D', cases_per_pallet: '10001' },
      { code: 'E', weight_per_case_kg: '-1' },
      { code: 'F', active: 'maybe' },
      { code: '', cases_per_pallet: '84' },
      { code: 'a', cases_per_pallet: '84' },
      { code: 'G', cases_per_pallet: '1,200' },
      { code: '', cases_per_pallet: '' },
    ]);
    expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.errors[0]!.message).toBe('cases per pallet "84.5" must be a whole number 1-10,000.');
    expect(r.errors[7]!.message).toMatch(/code a is also on row 2 \(codes are the same whatever the letter case\)/);
    // "1,200" reads as 1200; a fully blank row is skipped.
    expect(r.rows).toEqual([{ row: 10, code: 'G', name: null, weightPerCaseKg: null, casesPerPallet: 1200, active: null }]);
    expect(readProductRows([{ sku_name: 'x' }]).errors[0]!.message).toMatch(/No code column/);
  });

  it('plans creates, updates and unchanged rows; codes match whatever their letter case; a new code is kept as the ERP writes it', () => {
    const rows = readProductRows([
      { code: 'ja0.5l', cases_per_pallet: '96' },
      { code: 'TN1.5L', cases_per_pallet: '39', name: 'Tanuf 1.5L' },
      { code: 'NEW-1', name: 'New one', weight_per_case_kg: '11', cases_per_pallet: '84' },
      // NMWC's ERP codes have spaces and brackets (the order intake creates them as written).
      { code: 'TN1.5L (6)', cases_per_pallet: '39' },
      { code: 'X'.repeat(65), cases_per_pallet: '84' },
    ]).rows;
    const { changes, errors } = planProductImport(rows, KNOWN);
    expect(errors).toEqual([{ row: 6, message: `code "${'X'.repeat(64)}" cannot be created: at most 64 characters, without line breaks or tabs.` }]);
    expect(changes).toEqual([
      { kind: 'UPDATE', row: 2, id: 'p1', code: 'JA0.5L', before: { casesPerPallet: null }, data: { casesPerPallet: 96 } },
      { kind: 'UNCHANGED', row: 3, id: 'p2', code: 'TN1.5L' },
      { kind: 'CREATE', row: 4, code: 'NEW-1', data: { code: 'NEW-1', name: 'New one', weightPerCaseKg: 11, casesPerPallet: 84, active: true } },
      { kind: 'CREATE', row: 5, code: 'TN1.5L (6)', data: { code: 'TN1.5L (6)', name: 'TN1.5L (6)', weightPerCaseKg: 0, casesPerPallet: 39, active: true } },
    ]);
    // Active products still without a factor after it: none here (OLD-1 is inactive).
    expect(productsStillWithoutFactor(KNOWN, changes)).toEqual([]);
    expect(productsStillWithoutFactor(KNOWN, [])).toEqual(['JA0.5L']);
  });
});

describe('POST /api/products/import', () => {
  it('Validate only writes nothing and says what the import would do', async () => {
    const r = await importCsv('code,name,cases_per_pallet\nJA0.5L,JA0.5L,96\nTN1.5L,Tanuf 1.5L,40\nNEW-2,,56\n', true);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ dryRun: true, creates: 1, updates: 2, unchanged: 0, factorsSet: 3, errorRows: 0, imported: 0, productsWithoutFactor: [] });
    expect(state.creates).toEqual([]);
    expect(state.updates).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('imports: creates and updates each product with its own audit row, then one PRODUCTS_IMPORTED', async () => {
    const r = await importCsv('Code,Cases per pallet,Weight per case (kg)\nJA0.5L,96,\nTN1.5L,39,12\nNEW-2,56,8.5\n');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ dryRun: false, creates: 1, updates: 1, unchanged: 1, imported: 2 });
    expect(state.updates).toEqual([{ id: 'p1', data: { casesPerPallet: 96 } }]);
    expect(state.creates).toEqual([{ tenantId: 'tA', code: 'NEW-2', name: 'NEW-2', weightPerCaseKg: 8.5, casesPerPallet: 56, active: true }]);
    expect(state.audits.map((a) => a.action)).toEqual(['UPDATE', 'CREATE', 'PRODUCTS_IMPORTED']);
    expect(state.audits[0]).toMatchObject({ entity: 'Product', entityId: 'p1', beforeJson: { casesPerPallet: null }, afterJson: { casesPerPallet: 96, source: 'IMPORT' } });
    expect(state.audits[2]).toMatchObject({ entity: 'Product', entityId: null, afterJson: { creates: 1, updates: 1, unchanged: 1, factorsSet: 2, withoutFactor: 0 } });
  });

  it('a file with an error imports nothing', async () => {
    const r = await importCsv('code,cases_per_pallet\nJA0.5L,96\nTN1.5L,39.5\n');
    expect(r.status).toBe(200);
    expect(r.body.data.errorRows).toBe(1);
    expect(r.body.data.errors).toEqual([{ row: 3, message: 'cases per pallet "39.5" must be a whole number 1-10,000.' }]);
    expect(state.updates).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('warns about products still without cases per pallet, and about a file without the column', async () => {
    const r = await importCsv('code,weight_per_case_kg\nJA0.5L,10\n');
    expect(r.body.data.warnings).toContain('The file has no cases per pallet column: pallet factors are unchanged.');
    expect(r.body.data.warnings.some((w: string) => /1 active product\(s\) still have no cases per pallet: JA0.5L/.test(w))).toBe(true);
  });

  it('is for company admins only (a dispatcher is refused)', async () => {
    state.role = 'PLANNER';
    const r = await importCsv('code,cases_per_pallet\nJA0.5L,96\n');
    expect(r.status).toBe(403);
    expect(state.updates).toEqual([]);
  });
});

describe('product and truck fields', () => {
  it('cases per pallet is a whole number 1-10,000; empty or null clears it; left out is unchanged', () => {
    const base = { code: 'JA0.5L', name: 'JA', weightPerCaseKg: 9.9, volumePerCaseL: 0 };
    expect(productSchema.parse({ ...base, casesPerPallet: 84 }).casesPerPallet).toBe(84);
    expect(productSchema.parse({ ...base, casesPerPallet: '96' }).casesPerPallet).toBe(96);
    expect(productSchema.parse({ ...base, casesPerPallet: '' }).casesPerPallet).toBeNull();
    expect(productSchema.parse({ ...base, casesPerPallet: null }).casesPerPallet).toBeNull();
    expect(productSchema.parse(base).casesPerPallet).toBeUndefined();
    expect(productSchema.partial().parse({ name: 'x' })).not.toHaveProperty('casesPerPallet');
    expect(productSchema.safeParse({ ...base, casesPerPallet: 84.5 }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, casesPerPallet: 0 }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, casesPerPallet: 10_001 }).success).toBe(false);
  });

  it('a truck has bays 1-40 or none (planned by cases)', () => {
    const base = { code: 'R1', depotId: 'd1', capacityCases: 1140, capacityWeightKg: 10000, capacityVolumeL: 0, fixedCostPerDay: 0, costPerKm: 0 };
    expect(truckSchema.parse({ ...base, bays: 12 }).bays).toBe(12);
    expect(truckSchema.parse({ ...base, bays: '' }).bays).toBeNull();
    expect(truckSchema.safeParse({ ...base, bays: 0 }).success).toBe(false);
    expect(truckSchema.safeParse({ ...base, bays: 41 }).success).toBe(false);
    expect(truckSchema.safeParse({ ...base, bays: 2.5 }).success).toBe(false);
  });
});
