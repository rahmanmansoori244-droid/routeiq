/**
 * One customer identity (lib/customer-code.ts): a customer is its code and branch, trimmed, whatever
 * the letter case; "_" and "%" are characters of the code, never wildcards. Before, the order file's
 * confirm, the late order and the Customers page's create and edit asked the database with Prisma's
 * `equals` + `mode: 'insensitive'`, an ILIKE on PostgreSQL that reads "_" as "any one character" and
 * "%" as "any text": a new customer "C_1" was attached at confirm to the existing "CX1" and its
 * location, while the check (which matches in the program) had listed C_1 as new. Here, on the
 * in-memory database (fake-plan-db.ts):
 *  - the matcher: C_1 is not CX1, c001 is C001, "%" matches nothing else, the branch key "__MAIN__"
 *    is not a pattern, spaces at the ends are cut; the order intake uses the same function;
 *  - POST /api/customers and PATCH /api/customers/:id: "C_1" is created / renamed next to "CX1",
 *    "cx1" is refused as CX1's twin (409);
 *  - the late order: "C_1" becomes a new customer (no location), "cx1" is CX1, "%" is new;
 *  - the order file check and confirm: C_1 and C% are new customers (LOCATION REQUIRED) at the check
 *    and at confirm, cx1 is CX1; no order of C_1 or C% goes to CX1.
 * The same on real PostgreSQL: tests/integration/master-data-db.spec.ts. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';

const session = vi.hoisted(() => ({ role: 'PLANNER' }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: session.role, name: 'Dispatcher Ali', email: 'ali@a.example' } })) }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/dispatch/service-area', async () => {
  const { DEFAULT_SERVICE_AREA } = await import('@/lib/dispatch/location-input');
  return { tenantServiceArea: async () => DEFAULT_SERVICE_AREA };
});

import { customerKey, customerTwinsOf } from '@/lib/customer-code';
import { customerKey as intakeCustomerKey, normalizeOrderRows, resolveOrderLines } from '@/lib/dispatch/order-intake';
import { POST as createCustomer } from '@/app/api/customers/route';
import { PATCH as patchCustomer } from '@/app/api/customers/[id]/route';
import { POST as lateOrder } from '@/app/api/dispatch/late-order/route';
import { POST as uploadPost } from '@/app/api/orders/upload/route';
import { confirmIntake, type IntakeValidation } from '@/lib/dispatch/intake-server';

const T = 'tA';
const DAY = '2026-10-07';
const json = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** CX1 (with a usable, verified location), CYZ and a branch "XXMAINYY" of B1: every one an ILIKE trap. */
function seed() {
  resetDb();
  session.role = 'PLANNER';
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat', dateOrder: 'DMY', planningCutoffMin: 1020, orderColumnMapJson: null }];
  tables.depot = [{ id: 'DA', tenantId: T, code: 'A1', active: true }];
  tables.product = [{ id: 'p1', tenantId: T, code: 'W500', name: 'Water', weightPerCaseKg: 12, volumePerCaseL: 0, active: true, createdFromUpload: false }];
  const cust = (id: string, code: string, extra: Record<string, unknown> = {}) => ({
    id, tenantId: T, code, branchCode: null, branchKey: '__MAIN__', name: `Shop ${code}`, active: true, lat: 23.6123, lng: 58.4123,
    geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, avgServiceTimeMin: 10, ...extra,
  });
  tables.customer = [cust('cX1', 'CX1'), cust('cYZ', 'CYZ'), cust('cB1', 'B1', { branchCode: 'XXMAINYY', branchKey: 'XXMAINYY' })];
}
const customerCodes = () => (tables.customer ?? []).map((c) => c.code);

describe('the matcher: one literal identity, letter case aside', () => {
  it('C_1 is not CX1, c001 is C001, % is not a wildcard, the main branch key is not a pattern, spaces at the ends are cut', () => {
    expect(customerKey('C_1', '__MAIN__')).not.toBe(customerKey('CX1', '__MAIN__'));
    expect(customerKey('c001', '__MAIN__')).toBe(customerKey('C001', '__MAIN__'));
    expect(customerKey(' C001 ', ' __main__ ')).toBe(customerKey('C001', '__MAIN__'));
    for (const other of ['CX1', 'C1', 'C%1', 'ABC', '']) expect([other, customerKey('%', '__MAIN__') === customerKey(other, '__MAIN__')]).toEqual([other, false]);
    expect(customerKey('C%1', '__MAIN__')).not.toBe(customerKey('CX1', '__MAIN__'));
    expect(customerKey('c%1', '__MAIN__')).toBe(customerKey('C%1', '__MAIN__'));
    expect(customerKey('B1', 'XXMAINYY')).not.toBe(customerKey('B1', '__MAIN__'));
    expect(customerKey('B1', 'north')).toBe(customerKey('B1', 'NORTH'));
    expect(customerKey('B1', 'NORTH')).not.toBe(customerKey('B1', '__MAIN__'));
  });

  it('customerTwinsOf finds the twins by letter case only, in the list order', () => {
    const list = [
      { id: 1, code: 'CX1', branchKey: '__MAIN__' },
      { id: 2, code: 'c_1', branchKey: '__MAIN__' },
      { id: 3, code: 'C_1', branchKey: '__MAIN__' },
      { id: 4, code: 'C_1', branchKey: 'N1' },
      { id: 5, code: 'C%', branchKey: '__MAIN__' },
    ];
    expect(customerTwinsOf(list, 'C_1', '__MAIN__').map((c) => c.id)).toEqual([2, 3]);
    expect(customerTwinsOf(list, 'cx1', '__MAIN__').map((c) => c.id)).toEqual([1]);
    expect(customerTwinsOf(list, 'C%', '__MAIN__').map((c) => c.id)).toEqual([5]);
    expect(customerTwinsOf(list, '%', '__MAIN__')).toEqual([]);
    expect(customerTwinsOf(list, 'C_1', 'n1').map((c) => c.id)).toEqual([4]);
  });

  it('the order intake (check, duplicate keys, Bring forward) uses the same function', () => {
    expect(intakeCustomerKey).toBe(customerKey);
    const norm = normalizeOrderRows(
      [
        { 'Customer Code': 'C_1', 'Product Code': 'W500', Cases: '5' },
        { 'Customer Code': 'cx1', 'Product Code': 'W500', Cases: '6' },
        { 'Customer Code': '%', 'Product Code': 'W500', Cases: '7' },
      ],
      { defaultDeliveryDate: DAY, dateOrder: 'DMY' },
    );
    const known = [{ id: 'cX1', code: 'CX1', branchKey: '__MAIN__', name: 'X', active: true, lat: 23.6, lng: 58.4 }];
    const res = resolveOrderLines(norm, known, [{ id: 'p1', code: 'W500', name: 'Water', active: true, weightPerCaseKg: 12 }], new Set());
    expect(res.lines.map((l) => [l.customerCode, l.customerId])).toEqual([['C_1', null], ['cx1', 'cX1'], ['%', null]]);
    expect(res.issues.newCustomers.map((c) => c.code)).toEqual(['C_1', '%']);
  });
});

describe('Customers page: create and rename', () => {
  beforeEach(seed);
  const create = (body: Record<string, unknown>) => createCustomer(new Request('http://x/api/customers', json('POST', { name: 'New shop', ...body })));
  const patch = (id: string, body: Record<string, unknown>) => patchCustomer(new Request(`http://x/api/customers/${id}`, json('PATCH', body)), { params: { id } });

  it('"C_1" is created next to "CX1"; "cx1" is CX1 (409 naming it)', async () => {
    expect((await create({ code: 'C_1' })).status).toBe(201);
    expect((await create({ code: 'C.1' })).status).toBe(201);
    const twin = await create({ code: 'cx1' });
    expect(twin.status).toBe(409);
    expect(((await twin.json()) as { error: string }).error).toBe('Customer CX1 already exists (codes are the same whatever the letter case).');
    expect(customerCodes()).toEqual(['CX1', 'CYZ', 'B1', 'C_1', 'C.1']);
  });

  it('a branch "__main__" written in another case is the main branch; the branch "XXMAINYY" is not', async () => {
    expect((await create({ code: 'B1' })).status).toBe(201);
    expect((await create({ code: 'CYZ', branchCode: 'XXMAINYY' })).status).toBe(201);
    expect((await create({ code: 'cyz', branchCode: '__main__' })).status).toBe(409);
  });

  it('renaming a customer to "C_1" next to "CX1" is allowed; to "cx1" is 409, nothing changed', async () => {
    // A company admin: only an admin changes the code of a customer with a saved location (owner decision 1 Oct 2026).
    session.role = 'TENANT_ADMIN';
    expect((await patch('cYZ', { code: 'C_1' })).status).toBe(200);
    expect(tables.customer!.find((c) => c.id === 'cYZ')!.code).toBe('C_1');
    const twin = await patch('cYZ', { code: 'cx1' });
    expect(twin.status).toBe(409);
    expect(tables.customer!.find((c) => c.id === 'cYZ')!.code).toBe('C_1');
  });
});

describe('the late order: a new customer code is never another customer', () => {
  beforeEach(seed);
  const post = (customerCode: string, so: string) =>
    lateOrder(new Request('http://x/api/dispatch/late-order', json('POST', { date: DAY, depotId: 'DA', customerCode, reason: 'Phoned in at 22:15', lines: [{ productCode: 'W500', cases: 4, salesOrderNo: so }] })));
  const data = async (res: Response) => ((await res.json()) as { data: { customerId: string; customerCreated: boolean; locationRequired: boolean } }).data;

  it('"C_1" next to "CX1": a new customer without a location; the order is not CX1\'s', async () => {
    const res = await post('C_1', 'SO-1');
    expect(res.status).toBe(201);
    const d = await data(res);
    expect(d).toMatchObject({ customerCreated: true });
    expect(d.customerId).not.toBe('cX1');
    // A stub without a location (LOCATION REQUIRED; on PostgreSQL the answer says locationRequired: master-data-db.spec.ts).
    expect(tables.customer!.find((c) => c.id === d.customerId)).toMatchObject({ code: 'C_1', branchKey: '__MAIN__', geocodeConfidence: 'MISSING', createdFromUpload: true });
    expect(tables.customer!.find((c) => c.id === d.customerId)!.lat ?? null).toBeNull();
    expect(tables.order!.map((o) => o.customerId)).toEqual([d.customerId]);
  });

  it('"%" is a new customer, not any customer; "cx1" is CX1 (letter case aside)', async () => {
    const pct = await data(await post('%', 'SO-2'));
    expect(pct).toMatchObject({ customerCreated: true });
    expect(tables.customer!.find((c) => c.id === pct.customerId)!.code).toBe('%');
    const cx1 = await data(await post('cx1', 'SO-3'));
    expect(cx1).toMatchObject({ customerId: 'cX1', customerCreated: false, locationRequired: false });
    expect(customerCodes()).toEqual(['CX1', 'CYZ', 'B1', '%']);
  });
});

describe('the order file: check, then confirm', () => {
  beforeEach(seed);
  const upload = (rows: [string, string, number][]) => {
    const text = ['SO No,Customer Code,Item Code,Qty (Cases)', ...rows.map(([so, code, cases]) => `${so},${code},W500,${cases}`)].join('\n');
    const fd = new FormData();
    fd.set('file', new File([text], 'orders.csv', { type: 'text/csv' }));
    fd.set('depotId', 'DA');
    fd.set('deliveryDate', DAY);
    return uploadPost(new Request('http://x/api/orders/upload', { method: 'POST', body: fd }));
  };

  it('C_1 and C% are new customers at the check and at confirm (location required); cx1 is CX1; nothing of C_1 or C% goes to CX1', async () => {
    const res = await upload([['S1', 'C_1', 5], ['S2', 'C%', 6], ['S3', 'cx1', 7]]);
    expect(res.status).toBe(200);
    const { batchId, validation } = ((await res.json()) as { data: { batchId: string; validation: { errorRows: number; issues: { newCustomers: { code: string }[] } } } }).data;
    expect(validation.errorRows).toBe(0);
    expect(validation.issues.newCustomers.map((c) => c.code)).toEqual(['C_1', 'C%']);
    const v = tables.uploadBatch!.find((b) => b.id === batchId)!.validationJson as IntakeValidation;
    const out = await confirmIntake((await import('./fake-plan-db')).fakePrisma as never, T, { id: batchId, depotId: 'DA' }, v, { id: 'u1' }, { isLate: false, reason: null });
    expect(out).toMatchObject({ ordersCreated: 3, customersCreated: 2 });
    expect(customerCodes()).toEqual(['CX1', 'CYZ', 'B1', 'C_1', 'C%']);
    const byCode = new Map(tables.customer!.map((c) => [c.code, c]));
    for (const code of ['C_1', 'C%']) expect(byCode.get(code)).toMatchObject({ geocodeConfidence: 'MISSING', createdFromUpload: true, branchKey: '__MAIN__' });
    const casesOf = (code: string) => tables.order!.filter((o) => o.customerId === byCode.get(code)!.id).map((o) => o.totalCases);
    expect([casesOf('C_1'), casesOf('C%'), casesOf('CX1'), casesOf('CYZ')]).toEqual([[5], [6], [7], []]);
  });

  it('a customer created meanwhile as "c_1" (after the check) is reused at confirm, never "CX1"', async () => {
    const res = await upload([['S1', 'C_1', 5]]);
    const { batchId } = ((await res.json()) as { data: { batchId: string } }).data;
    tables.customer!.push({ id: 'cNew', tenantId: T, code: 'c_1', branchCode: null, branchKey: '__MAIN__', name: 'c_1', active: true, lat: null, lng: null, priority: 3, avgServiceTimeMin: 10 });
    const v = tables.uploadBatch!.find((b) => b.id === batchId)!.validationJson as IntakeValidation;
    const out = await confirmIntake((await import('./fake-plan-db')).fakePrisma as never, T, { id: batchId, depotId: 'DA' }, v, { id: 'u1' }, { isLate: false, reason: null });
    expect(out).toMatchObject({ ordersCreated: 1 });
    expect(customerCodes()).toEqual(['CX1', 'CYZ', 'B1', 'c_1']);
    expect(tables.order!.map((o) => o.customerId)).toEqual(['cNew']);
  });
});
