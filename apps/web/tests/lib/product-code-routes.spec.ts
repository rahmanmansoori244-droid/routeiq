/**
 * Real NMWC ERP product codes ("JA1.5L(6)", "TN1.5L (6)", "SS5GB NRB", "INVOMAN330(24)") through
 * every route and export that carries a product code, on the in-memory database (fake-plan-db.ts):
 *  - Products: create, edit (the weight of JA1.5L(6) can be saved: the Edit call no longer sends
 *    the code, and a code that is sent is checked with the product rule), twins, refusals;
 *  - the order file upload (check) and its confirm: the codes match the master whatever the letter
 *    case and spacing, and a new product is created once, with its tidy code;
 *  - the late order;
 *  - the sample file, the Excel loading manifest and SKU summary.
 * Case-insensitive matching is done on the code (lib/product-code.ts), never by a database
 * pattern: Prisma's `equals` + `mode: insensitive` is an ILIKE, which reads _ as "any character".
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { resetDb, tables } from './fake-plan-db';

const session = vi.hoisted(() => ({ role: 'TENANT_ADMIN' }));
const auditCalls = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: session.role, name: 'Admin Ali', email: 'ali@a.example' } })) }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async (input: Record<string, unknown>) => void auditCalls.push(input)) }));

import { GET as listProducts, POST as createProduct } from '@/app/api/products/route';
import { PATCH as patchProduct } from '@/app/api/products/[id]/route';
import { POST as lateOrder } from '@/app/api/dispatch/late-order/route';
import { POST as uploadPost } from '@/app/api/orders/upload/route';
import { GET as sampleCsv } from '@/app/api/orders/sample/route';
import { confirmIntake, type IntakeValidation } from '@/lib/dispatch/intake-server';
import { buildDispatchWorkbook, SHEETS, type WorkbookMeta } from '@/lib/dispatch/workbook';
import { productRequestBody } from '@/app/t/[slug]/products/product-body';
import { fixture } from './plan-detail-fixture';

const T = 'tA';
const REAL = ['JA1.5L(6)', 'TN1.5L (6)', 'SS5GB NRB', 'INVOMAN330(24)'];

const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const create = (body: unknown) => createProduct(new Request('http://x/api/products', json('POST', body)));
const edit = (id: string, body: unknown) => patchProduct(new Request(`http://x/api/products/${id}`, json('PATCH', body)), { params: { id } });
const valid = { name: 'Water', weightPerCaseKg: 12, volumePerCaseL: 12 };

function seedProducts(codes: (string | Record<string, unknown>)[] = []) {
  resetDb();
  auditCalls.length = 0;
  session.role = 'TENANT_ADMIN';
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat', dateOrder: 'DMY', planningCutoffMin: 1020, orderColumnMapJson: null }];
  tables.product = codes.map((c, i) => {
    const p = typeof c === 'string' ? { code: c } : c;
    return { id: `p${i + 1}`, tenantId: T, name: String(p.code), weightPerCaseKg: 0, volumePerCaseL: 0, active: true, createdFromUpload: false, ...p };
  });
}
const codes = () => (tables.product ?? []).map((p) => p.code);
const fieldError = async (res: Response) => ((await res.json()) as { error: { fieldErrors: { code?: string[] } } }).error.fieldErrors.code?.[0];

describe('Products: create', () => {
  beforeEach(() => seedProducts());

  it.each(REAL)('creates the product %s', async (code) => {
    const res = await create({ ...valid, code });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { code: string } }).data.code).toBe(code);
    expect(codes()).toEqual([code]);
    expect(auditCalls[0]).toMatchObject({ action: 'CREATE', entity: 'Product' });
  });

  it('creates all four real codes side by side (TN1.5L (6) and JA1.5L(6) do not collide)', async () => {
    for (const code of REAL) expect((await create({ ...valid, code })).status).toBe(201);
    expect(codes()).toEqual(REAL);
    const list = (await (await listProducts(new Request('http://x/api/products'))).json()) as { data: { code: string }[] };
    expect(list.data.map((p) => p.code).sort()).toEqual([...REAL].sort());
  });

  it('stores " TN1.5L  (6) " as "TN1.5L (6)"', async () => {
    const res = await create({ ...valid, code: ' TN1.5L  (6) ' });
    expect(res.status).toBe(201);
    expect(codes()).toEqual(['TN1.5L (6)']);
  });

  it('keeps every character the rule allows: . ( ) - _ / + &', async () => {
    const code = 'BOX 12/6 (BLUE) 1+1 & CO_2.5-A';
    expect((await create({ ...valid, code })).status).toBe(201);
    expect(codes()).toEqual([code]);
  });

  it('refuses a code that breaks a CSV, a control character, a leading sign, 41 characters: 400 with the reason, nothing saved', async () => {
    for (const [code, text] of [
      ['A,B', /only letters, digits, spaces and \. \( \) - _ \/ \+ & \(not ","\)/],
      ['A"B', /only letters, digits, spaces/],
      ['A\tB', /control characters/],
      ['A\nB', /control characters/],
      ['-JA', /cannot start with \+ or -/],
      ['+JA', /cannot start with \+ or -/],
      ['A'.repeat(41), /Max 40 characters \(this code has 41\)/],
      ['   ', /Required/],
    ] as const) {
      const res = await create({ ...valid, code });
      expect(res.status, JSON.stringify(code)).toBe(400);
      expect(await fieldError(res), JSON.stringify(code)).toMatch(text);
    }
    expect(codes()).toEqual([]);
    expect(auditCalls).toEqual([]);
  });

  it('only a company admin creates products', async () => {
    session.role = 'PLANNER';
    expect((await create({ ...valid, code: 'JA1.5L(6)' })).status).toBe(403);
    expect(codes()).toEqual([]);
  });
});

describe('Products: the same code is one product (letter case and spaces), nothing else is a twin', () => {
  it('JA1.5L(6) exists: ja1.5l(6) is refused with 409 naming it', async () => {
    seedProducts(['JA1.5L(6)']);
    const res = await create({ ...valid, code: 'ja1.5l(6)' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('Product JA1.5L(6) already exists (codes are the same whatever the letter case).');
    expect(codes()).toEqual(['JA1.5L(6)']);
  });

  it('TN1.5L (6) exists: " tn1.5l  (6) " is the same product (409)', async () => {
    seedProducts(['TN1.5L (6)']);
    expect((await create({ ...valid, code: ' tn1.5l  (6) ' })).status).toBe(409);
    expect(codes()).toEqual(['TN1.5L (6)']);
  });

  it('a product saved with two spaces is the twin of the tidy code', async () => {
    seedProducts(['SS5GB  NRB']);
    expect((await create({ ...valid, code: 'SS5GB NRB' })).status).toBe(409);
  });

  it('TN1.5L(6) is not TN1.5L (6): a space that is there makes it another product', async () => {
    seedProducts(['TN1.5L (6)']);
    expect((await create({ ...valid, code: 'TN1.5L(6)' })).status).toBe(201);
    expect(codes()).toEqual(['TN1.5L (6)', 'TN1.5L(6)']);
  });

  it('A_B is not AxB: an underscore is a character of the code, not "any character" (the database ILIKE read it so)', async () => {
    seedProducts(['AxB']);
    expect((await create({ ...valid, code: 'A_B' })).status).toBe(201);
    expect((await create({ ...valid, code: 'a_b' })).status).toBe(409);
    expect(codes()).toEqual(['AxB', 'A_B']);
  });
});

describe('Products: edit (the weight of JA1.5L(6) can be saved)', () => {
  beforeEach(() => seedProducts([{ code: 'JA1.5L(6)', name: 'Jabal 1.5L x6' }, { code: 'TN1.5L (6)' }, { code: 'SS5GB NRB' }]));

  it('a weight alone, the way the Edit dialog now sends it: saved, the code untouched, audited', async () => {
    const res = await edit('p1', { name: 'Jabal 1.5L x6', weightPerCaseKg: 9.6, volumePerCaseL: 9, active: true });
    expect(res.status).toBe(200);
    expect(tables.product![0]).toMatchObject({ code: 'JA1.5L(6)', weightPerCaseKg: 9.6, volumePerCaseL: 9 });
    expect(auditCalls[0]).toMatchObject({ action: 'UPDATE', entity: 'Product', entityId: 'p1' });
  });

  it('the old Edit call, which sent the code with the weight, is accepted too (it was refused: 400 on the bracket)', async () => {
    for (const [id, code] of [['p1', 'JA1.5L(6)'], ['p2', 'TN1.5L (6)'], ['p3', 'SS5GB NRB']] as const) {
      const res = await edit(id, { code, name: code, weightPerCaseKg: 12.5, volumePerCaseL: 15, active: true });
      expect(res.status, code).toBe(200);
      expect(tables.product!.find((p) => p.id === id)).toMatchObject({ code, weightPerCaseKg: 12.5 });
    }
  });

  it('a product saved before the rule (a code the rule would refuse) still takes its weight when the code is left out', async () => {
    tables.product!.push({ id: 'p9', tenantId: T, code: 'SKU#7,B', name: 'Old', weightPerCaseKg: 0, volumePerCaseL: 0, active: true });
    expect((await edit('p9', { weightPerCaseKg: 8 })).status).toBe(200);
    expect(tables.product!.find((p) => p.id === 'p9')).toMatchObject({ code: 'SKU#7,B', weightPerCaseKg: 8 });
  });

  it('a code saved with two spaces is made tidy when the tidy code is sent', async () => {
    tables.product!.push({ id: 'p8', tenantId: T, code: 'INVOMAN330  (24)', name: 'Inv', weightPerCaseKg: 0, volumePerCaseL: 0, active: true });
    expect((await edit('p8', { code: 'INVOMAN330 (24)' })).status).toBe(200);
    expect(tables.product!.find((p) => p.id === 'p8')!.code).toBe('INVOMAN330 (24)');
  });

  it('the letter case of the same product can be corrected (it is not its own twin)', async () => {
    expect((await edit('p1', { code: 'ja1.5l(6)' })).status).toBe(200);
    expect(tables.product![0]!.code).toBe('ja1.5l(6)');
  });

  it('renaming onto another product (any letter case or spacing) is 409, nothing changed', async () => {
    const res = await edit('p1', { code: ' tn1.5l   (6)' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('Product TN1.5L (6) already exists (codes are the same whatever the letter case).');
    expect(tables.product![0]!.code).toBe('JA1.5L(6)');
  });

  it('a code the rule refuses is 400 with the reason, nothing changed', async () => {
    for (const code of ['A,B', 'A\tB', '+A', 'A'.repeat(41)]) {
      const res = await edit('p1', { code, weightPerCaseKg: 99 });
      expect(res.status, JSON.stringify(code)).toBe(400);
      expect(await fieldError(res)).toBeTruthy();
    }
    expect(tables.product![0]).toMatchObject({ code: 'JA1.5L(6)', weightPerCaseKg: 0 });
  });

  it('the answer says how many open lines the new weight reaches only when there are some (no warning for none)', async () => {
    const res = await edit('p1', { weightPerCaseKg: 9.6 });
    expect(((await res.json()) as { data: { warning?: string } }).data.warning).toBeUndefined();
  });

  it('only a company admin edits products', async () => {
    session.role = 'PLANNER';
    expect((await edit('p1', { weightPerCaseKg: 1 })).status).toBe(403);
    expect(tables.product![0]!.weightPerCaseKg).toBe(0);
  });
});

describe('the Products dialog: what the Edit call sends', () => {
  const form = { code: 'JA1.5L(6)', name: 'Jabal 1.5L x6', weightPerCaseKg: '9.6', volumePerCaseL: '9', casesPerPallet: '', active: true };

  it('edit: no code (the code cannot be changed there, and a saved code is never checked again by accident)', () => {
    const body = productRequestBody('edit', form);
    expect(body).toEqual({ name: 'Jabal 1.5L x6', weightPerCaseKg: 9.6, volumePerCaseL: 9, casesPerPallet: null, active: true });
    expect('code' in body).toBe(false);
  });

  it('create: the code as typed (the server tidies and checks it)', () => {
    expect(productRequestBody('create', { ...form, code: ' TN1.5L  (6) ' })).toEqual({ code: ' TN1.5L  (6) ', name: 'Jabal 1.5L x6', weightPerCaseKg: 9.6, volumePerCaseL: 9, casesPerPallet: null, active: true });
  });

  it('cases per pallet: the number typed, or null when the field is empty (pallets)', () => {
    expect(productRequestBody('edit', { ...form, casesPerPallet: ' 96 ' }).casesPerPallet).toBe(96);
    expect(productRequestBody('edit', { ...form, casesPerPallet: '  ' }).casesPerPallet).toBeNull();
  });
});

describe('POST /api/dispatch/late-order with real codes', () => {
  const DAY = '2026-10-07';
  const post = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    lateOrder(new Request('http://x/api/dispatch/late-order', json('POST', { date: DAY, depotId: 'DA', customerCode: 'C001', reason: 'Phoned in at 22:15', lines, ...extra })));
  const body = async (res: Response) => (await res.json()) as { data: Record<string, any>; error: any };

  beforeEach(() => {
    seedProducts([{ code: 'JA1.5L(6)', weightPerCaseKg: 9.6 }, { code: 'TN1.5L (6)', weightPerCaseKg: 9.1 }, { code: 'AxB', weightPerCaseKg: 5 }]);
    session.role = 'PLANNER';
    tables.depot = [{ id: 'DA', tenantId: T, code: 'A1', active: true }];
    tables.customer = [{ id: 'c1', tenantId: T, code: 'C001', branchCode: null, branchKey: '__MAIN__', name: 'ACME', active: true, lat: 23.6, lng: 58.4, priority: 3, avgServiceTimeMin: 10 }];
  });

  it('matches existing products whatever the letter case and spacing, and weighs the lines from them', async () => {
    const res = await post([
      { productCode: 'ja1.5l(6)', cases: 10, salesOrderNo: 'SO-1' },
      { productCode: ' TN1.5L  (6) ', cases: 5, salesOrderNo: 'SO-1' },
    ]);
    expect(res.status).toBe(201);
    expect(codes()).toEqual(['JA1.5L(6)', 'TN1.5L (6)', 'AxB']); // no product was created
    const order = tables.order![0]!;
    expect(order.lines.map((l: any) => [l.productId, l.cases, l.weightKg])).toEqual([['p1', 10, 96], ['p2', 5, 45.5]]);
    expect((await body(res)).data.productsWithoutWeight).toEqual([]);
  });

  it('a new real code creates one product with its tidy code, without a weight until entered', async () => {
    const res = await post([{ productCode: ' SS5GB   NRB ', cases: 3 }, { productCode: 'INVOMAN330(24)', cases: 4 }]);
    expect(res.status).toBe(201);
    expect(codes()).toEqual(['JA1.5L(6)', 'TN1.5L (6)', 'AxB', 'SS5GB NRB', 'INVOMAN330(24)']);
    expect(tables.product!.slice(3)).toMatchObject([{ createdFromUpload: true, name: 'SS5GB NRB' }, { createdFromUpload: true, name: 'INVOMAN330(24)' }]);
    expect((await body(res)).data.productsWithoutWeight).toEqual(['SS5GB NRB', 'INVOMAN330(24)']);
  });

  it('the same new code twice (other case, other spacing) is one product', async () => {
    const res = await post([{ productCode: 'SS5GB NRB', cases: 3 }, { productCode: 'ss5gb  nrb', cases: 4 }]);
    expect(res.status).toBe(201);
    expect(codes().filter((c) => /ss5gb/i.test(c))).toEqual(['SS5GB NRB']);
    const ids = tables.order![0]!.lines.map((l: any) => l.productId);
    expect(ids[0]).toBe(ids[1]);
  });

  it('an _ is a character of the code: A_B is a new product, it is not the product AxB', async () => {
    const res = await post([{ productCode: 'A_B', cases: 2 }]);
    expect(res.status).toBe(201);
    expect(codes()).toEqual(['JA1.5L(6)', 'TN1.5L (6)', 'AxB', 'A_B']);
    expect(tables.order![0]!.lines[0]!.productId).not.toBe('p3');
  });

  it('the same product twice in one sales order, written two ways, is refused', async () => {
    const res = await post([
      { productCode: 'TN1.5L (6)', cases: 2, salesOrderNo: 'SO-7' },
      { productCode: ' tn1.5l  (6)', cases: 3, salesOrderNo: 'SO-7' },
    ]);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('Product tn1.5l (6) is entered twice for sales order SO-7. Enter each product once with its total cases.');
    expect(tables.order ?? []).toEqual([]);
  });

  it('a new code the rule refuses is a 400 naming it, nothing saved (the customer stub made before it is rolled back too)', async () => {
    tables.customer = [];
    for (const productCode of ['A,B', 'A\tB', '-A', 'A'.repeat(41)]) {
      const res = await post([{ productCode, cases: 1 }]);
      expect(res.status, JSON.stringify(productCode)).toBe(400);
      const err = (await body(res)).error;
      expect(err.code).toBe('PRODUCT_CODE_INVALID');
      expect(err.message).toMatch(/^Item code ".*" cannot be used: /);
    }
    expect((await post([{ productCode: '   ', cases: 1 }])).status).toBe(400);
    expect(tables.order ?? []).toEqual([]);
    expect(tables.customer).toEqual([]);
    expect(codes()).toEqual(['JA1.5L(6)', 'TN1.5L (6)', 'AxB']);
  });

  it('a product already in the master with a code the rule would refuse today is still found: only a new code must follow the rule', async () => {
    tables.product!.push({ id: 'p9', tenantId: T, code: 'SKU#7,B', name: 'Old', weightPerCaseKg: 4, volumePerCaseL: 0, active: true });
    const res = await post([{ productCode: ' sku#7,b ', cases: 2 }]);
    expect(res.status).toBe(201);
    expect(codes()).toHaveLength(4);
    expect(tables.order![0]!.lines[0]).toMatchObject({ productId: 'p9', weightKg: 8 });
  });

  it('an inactive product is found by its tidy code too (409, not a second product)', async () => {
    tables.product![1]!.active = false;
    const res = await post([{ productCode: 'tn1.5l  (6)', cases: 1 }]);
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe('PRODUCT_INACTIVE');
    expect(codes()).toHaveLength(3);
  });
});

describe('the order file with real codes: check, then confirm', () => {
  const FILE_ROWS: [string, string, string][] = [
    // sales order, item code as the file has it, cases
    ['S1', 'JA1.5L(6)', '10'],
    ['S2', 'ja1.5l(6)', '4'],
    ['S3', ' TN1.5L  (6) ', '6'],
    ['S4', 'SS5GB NRB', '3'],
    ['S5', 'INVOMAN330(24)', '2'],
    ['S6', 'ss5gb  nrb', '5'],
  ];
  const csv = (rows: [string, string, string][] = FILE_ROWS) =>
    ['SO No,Req. Delivery Date,Customer Code,Item Code,Qty (Cases)', ...rows.map(([so, item, cases]) => `${so},07/10/2026,C001,"${item}",${cases}`)].join('\n');
  const upload = (text: string) => {
    const fd = new FormData();
    fd.set('file', new File([text], 'orders.csv', { type: 'text/csv' }));
    fd.set('depotId', 'DA');
    return uploadPost(new Request('http://x/api/orders/upload', { method: 'POST', body: fd }));
  };
  type Validation = { errorRows: number; validRows: number; errors: { row: number; message: string }[]; issues: { newProducts: { code: string; name: string; rows: number[] }[]; productsWithoutWeight: string[] } };
  const check = async (text: string) => {
    const res = await upload(text);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { batchId: string; validation: Validation } }).data;
  };

  beforeEach(() => {
    seedProducts([{ code: 'JA1.5L(6)', weightPerCaseKg: 9.6 }, { code: 'TN1.5L (6)', weightPerCaseKg: 9.1 }]);
    session.role = 'PLANNER';
    tables.depot = [{ id: 'DA', tenantId: T, code: 'A1', active: true }];
    tables.customer = [{ id: 'c1', tenantId: T, code: 'C001', branchCode: null, branchKey: '__MAIN__', name: 'ACME', active: true, lat: 23.6, lng: 58.4, priority: 3, avgServiceTimeMin: 10 }];
  });

  it('the check matches the known codes in any case and spacing, and lists each new code once, tidy', async () => {
    const { validation, batchId } = await check(csv());
    expect(validation.errors).toEqual([]);
    expect(validation.validRows).toBe(6);
    expect(validation.issues.newProducts).toEqual([
      { code: 'SS5GB NRB', name: 'SS5GB NRB', rows: [5, 7] },
      { code: 'INVOMAN330(24)', name: 'INVOMAN330(24)', rows: [6] },
    ]);
    const stored = tables.uploadBatch!.find((b) => b.id === batchId)!.validationJson as IntakeValidation;
    expect(stored.lines.map((l) => [l.productCode, l.productId])).toEqual([
      ['JA1.5L(6)', 'p1'],
      ['ja1.5l(6)', 'p1'],
      ['TN1.5L (6)', 'p2'],
      ['SS5GB NRB', null],
      ['INVOMAN330(24)', null],
      ['ss5gb nrb', null],
    ]);
  });

  it('a code the product master cannot hold is a row error, the other rows are still checked', async () => {
    const { validation } = await check(csv([['S1', 'JA1.5L(6)', '10'], ['S2', 'A,B', '3'], ['S3', 'X'.repeat(41), '2']]));
    expect(validation.validRows).toBe(1);
    expect(validation.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(validation.errors[0]!.message).toBe('Item code "A,B" cannot be used: A product code can have only letters, digits, spaces and . ( ) - _ / + & (not ","). Correct it in the file.');
    expect(validation.errors[1]!.message).toMatch(/^Item code "X{41}" cannot be used: Max 40 characters \(this code has 41\)\./);
    expect(validation.issues.newProducts).toEqual([]);
  });

  it('confirm creates each new product once with its tidy code, and every line points at the right product', async () => {
    const { batchId } = await check(csv());
    const v = tables.uploadBatch!.find((b) => b.id === batchId)!.validationJson as IntakeValidation;
    const out = await confirmIntake(
      (await import('./fake-plan-db')).fakePrisma as never,
      T,
      { id: batchId, depotId: 'DA' },
      v,
      { id: 'u1' },
      { isLate: false, reason: null },
    );
    expect(out).toMatchObject({ ordersCreated: 1, linesCreated: 6, cases: 30, productsCreated: 2 });
    expect(codes()).toEqual(['JA1.5L(6)', 'TN1.5L (6)', 'SS5GB NRB', 'INVOMAN330(24)']);
    expect(tables.product!.slice(2)).toMatchObject([{ createdFromUpload: true, name: 'SS5GB NRB' }, { createdFromUpload: true, name: 'INVOMAN330(24)' }]);
    const lines = tables.orderLine!;
    const idOf = (code: string) => tables.product!.find((p) => p.code === code)!.id;
    expect(lines.map((l) => l.productId)).toEqual([idOf('JA1.5L(6)'), idOf('JA1.5L(6)'), idOf('TN1.5L (6)'), idOf('SS5GB NRB'), idOf('INVOMAN330(24)'), idOf('SS5GB NRB')]);
    // Weighed from the master where it has a weight; the new products have none yet (0 kg = unknown).
    expect(lines.map((l) => l.weightKg)).toEqual([96, 38.4, 54.6, 0, 0, 0]);
  });

  it('confirm of a file checked before spaces were tidied (stored codes with two spaces) still creates one product', async () => {
    const { batchId } = await check(csv([['S1', 'SS5GB NRB', '3'], ['S2', 'ss5gb nrb', '5']]));
    const v = structuredClone(tables.uploadBatch!.find((b) => b.id === batchId)!.validationJson) as IntakeValidation;
    // The old check kept the file's spelling: two spaces, another case.
    v.lines[0]!.productCode = 'SS5GB  NRB';
    v.lines[1]!.productCode = 'ss5gb nrb';
    v.issues.newProducts = [{ code: 'SS5GB  NRB', name: 'SS5GB  NRB', rows: [2, 3] }];
    await confirmIntake((await import('./fake-plan-db')).fakePrisma as never, T, { id: batchId, depotId: 'DA' }, v, { id: 'u1' }, { isLate: false, reason: null });
    expect(codes()).toEqual(['JA1.5L(6)', 'TN1.5L (6)', 'SS5GB NRB']);
    expect(tables.orderLine!.map((l) => l.productId)).toEqual([tables.product![2]!.id, tables.product![2]!.id]);
  });
});

describe('GET /api/orders/sample: a CSV the upload reads back', () => {
  it('writes the real codes as they are, and quotes a saved code that holds a comma or a quote', async () => {
    seedProducts([...REAL, 'OLD,CODE', 'OLD"Q']);
    session.role = 'PLANNER';
    tables.customer = [{ id: 'c1', tenantId: T, code: 'C001', branchCode: null, branchKey: '__MAIN__', name: 'ACME', active: true, lat: 23.6, lng: 58.4 }];
    const res = await sampleCsv(new Request('http://x/api/orders/sample?mode=small'));
    expect(res.status).toBe(200);
    const lines = (await res.text()).split('\n').slice(1);
    const productOf = (l: string) => /^C001,,\d{4}-\d{2}-\d{2},(.*),\d+,\d,[\d.]*,$/.exec(l)![1]!;
    expect([...new Set(lines.map(productOf))].sort()).toEqual(['"OLD""Q"', '"OLD,CODE"', ...REAL].sort());
  });
});

describe('Excel: the loading manifest and SKU summary carry the real codes as text', () => {
  const META: WorkbookMeta = { tenantName: 'NMWC Test', currency: 'OMR', generatedAt: new Date('2026-10-04T13:05:00.000Z'), generatedBy: 'Planner One', assumptions: {} };
  const RENAME: [string, string][] = [
    ['TAN-500-24', 'JA1.5L(6)'],
    ['JAB-1500-6', 'TN1.5L (6)'],
    ['TAN-5G', 'SS5GB NRB & CO/1+2_3'],
  ];

  it('each code is one text cell in the SKU summary and the load manifests, and in the stop text', async () => {
    let text = JSON.stringify(fixture());
    for (const [from, to] of RENAME) text = text.split(`"${from}"`).join(JSON.stringify(to));
    const buf = await buildDispatchWorkbook(JSON.parse(text), META);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const sku = wb.getWorksheet(SHEETS.skuSummary)!;
    const col1: string[] = [];
    sku.eachRow((row, r) => r >= 5 && col1.push(String(row.getCell(1).value ?? '')));
    for (const [, code] of RENAME) {
      expect(col1, code).toContain(code);
      const cell = (() => { let found: ExcelJS.Cell | undefined; sku.eachRow((row) => { if (row.getCell(1).value === code) found = row.getCell(1); }); return found!; })();
      expect(cell.type).toBe(ExcelJS.ValueType.String);
    }
    const load = wb.getWorksheet('T01 - L1')!;
    const all: string[] = [];
    load.eachRow((row) => row.eachCell((c) => all.push(String(c.value ?? ''))));
    expect(all).toContain('JA1.5L(6)');
    expect(all).toContain('JA1.5L(6) x50; TN1.5L (6) x20');
  });
});
