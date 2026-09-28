/**
 * Audit PR A5, owner decision of 27 Sep 2026: "all orders must have depots linked to them". The
 * database refuses an order or order file without a depot (migration
 * 20260930120000_orders_always_have_depot, checked on real PostgreSQL by
 * tests/migrations/orders-always-have-depot.spec.ts); the app never creates one and never guesses:
 *
 *  - an order file is for one depot: the one chosen on the dispatch screen (it must be active), or,
 *    without a choice (the older Upload orders page), the company's only active depot. With no
 *    active depot, or two or more and no choice, the file is refused (422 DEPOT_REQUIRED); a chosen
 *    depot that is not active is refused (422 DEPOT_NOT_ACTIVE). Before, the first active depot by
 *    code was taken silently;
 *  - a plan holds only the orders of its own depot (the "orders without a depot" branch is gone);
 *  - the history-only depot the migration made for orders that had no depot (code NO-DEPOT) is
 *    never made active and never gets a truck or a region (422 DEPOT_HISTORY_ONLY), the Depots
 *    screen shows it as "History only" without an Active switch or a Delete button, and the
 *    onboarding truck picker lists active depots only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';
import { Host, elements, textOf, typeName } from './hook-host';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'TENANT_ADMIN', name: 'Admin One', email: 'a@a.example' } }),
}));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('sonner', () => ({ toast: { success() {}, error() {}, warning() {}, info() {} } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));
vi.mock('@/components/map-picker', () => ({ MapPicker: () => null }));

import { POST as uploadPost } from '@/app/api/orders/upload/route';
import { PATCH as depotPatch } from '@/app/api/depots/[id]/route';
import { POST as truckPost } from '@/app/api/trucks/route';
import { PATCH as truckPatch } from '@/app/api/trucks/[id]/route';
import { POST as regionPost } from '@/app/api/regions/route';
import { PATCH as regionPatch } from '@/app/api/regions/[id]/route';
import { CHOOSE_DEPOT, DEPOT_NOT_ACTIVE, NO_ACTIVE_DEPOT } from '@/lib/dispatch/intake-server';
import { ordersInScopeWhere } from '@/lib/dispatch/plan-service';
import { AUDIT_ACTIONS } from '@/lib/audit-catalog';
import { DepotFormDialog, HISTORY_ONLY_NOTE } from '@/app/t/[slug]/depots/depot-form';
import { DepotsTable } from '@/app/t/[slug]/depots/depots-table';
import { OnboardWizard } from '@/app/t/[slug]/onboard/onboard-wizard';

const T = 'tA';
const depot = (id: string, code: string, over: Record<string, unknown> = {}) => ({
  id,
  tenantId: T,
  code,
  name: `Depot ${code}`,
  lat: 23.58,
  lng: 58.39,
  address: null,
  active: true,
  historyOnly: false,
  openMin: null,
  closeMin: null,
  ...over,
});
const GHALA = depot('D1', 'GHALA');
const SOHAR = depot('D2', 'SOHAR');
const OLD = depot('D0', 'AAA-OLD', { active: false });
const HISTORY = depot('DH', 'NO-DEPOT', { active: false, historyOnly: true, name: 'No depot (kept for history)' });
const OTHER_COMPANY = depot('DX', 'ELSEWHERE', { tenantId: 'tB' });
/** Fresh copies for the fake tables (an update changes the row object in place). */
const rows = (...ds: ReturnType<typeof depot>[]) => ds.map((d) => ({ ...d }));

const json = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });

beforeEach(() => {
  resetDb();
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, orderColumnMapJson: null, timezone: 'Asia/Muscat', dateOrder: 'DMY', planningCutoffMin: 1080 }];
});

// ---------------------------------------------------------------------------------------
// The order file's depot
// ---------------------------------------------------------------------------------------

describe('POST /api/orders/upload: every order file is for one depot, never a guessed one', () => {
  const upload = async (depotId?: string) => {
    const fd = new FormData();
    const csv = 'sales_order_no,delivery_date,customer_code,product_code,cases\nINV-1,2026-10-07,C1,W500,3\n';
    fd.set('file', new File([csv], 'orders.csv', { type: 'text/csv' }));
    if (depotId) fd.set('depotId', depotId);
    return answer(await uploadPost(new Request('http://localhost/api/orders/upload', { method: 'POST', body: fd })));
  };

  it('one active depot (the others inactive or history-only): used without a choice, as the older Upload orders page needs', async () => {
    tables.depot = rows(OLD, HISTORY, GHALA);
    const r = await upload();
    expect(r.status).toBe(200);
    expect(r.body.data.validation.depotCode).toBe('GHALA');
    expect(tables.uploadBatch).toHaveLength(1);
    expect(tables.uploadBatch[0].depotId).toBe('D1');
  });

  it('two active depots and no choice: 422 DEPOT_REQUIRED, nothing saved (before: the first depot by code, silently)', async () => {
    tables.depot = rows(SOHAR, GHALA);
    const r = await upload();
    expect(r.status).toBe(422);
    expect(r.body.error).toEqual({ code: 'DEPOT_REQUIRED', message: CHOOSE_DEPOT });
    expect(tables.uploadBatch ?? []).toHaveLength(0);
  });

  it('no active depot: 422 DEPOT_REQUIRED with what to do, nothing saved', async () => {
    tables.depot = rows(OLD, HISTORY);
    const r = await upload();
    expect(r.status).toBe(422);
    expect(r.body.error).toEqual({ code: 'DEPOT_REQUIRED', message: NO_ACTIVE_DEPOT });
    expect(NO_ACTIVE_DEPOT).toBe('There is no active depot, so these orders cannot be linked to one. Add a depot under Depots, then upload the file again.');
    expect(tables.uploadBatch ?? []).toHaveLength(0);
  });

  it('a chosen depot that is inactive, history-only or of another company: 422 DEPOT_NOT_ACTIVE, nothing saved', async () => {
    tables.depot = rows(GHALA, OLD, HISTORY, OTHER_COMPANY);
    for (const id of ['D0', 'DH', 'DX', 'nope']) {
      const r = await upload(id);
      expect(r.status, id).toBe(422);
      expect(r.body.error, id).toEqual({ code: 'DEPOT_NOT_ACTIVE', message: DEPOT_NOT_ACTIVE });
    }
    expect(tables.uploadBatch ?? []).toHaveLength(0);
  });

  it('the depot chosen on the dispatch screen is the file\'s depot, also with two active depots', async () => {
    tables.depot = rows(SOHAR, GHALA);
    const r = await upload('D2');
    expect(r.status).toBe(200);
    expect(tables.uploadBatch[0].depotId).toBe('D2');
    expect(r.body.data.validation.depotCode).toBe('SOHAR');
  });
});

// ---------------------------------------------------------------------------------------
// A plan's orders
// ---------------------------------------------------------------------------------------

describe('a plan holds only the orders of its own depot', () => {
  it('ordersInScopeWhere: same company, day and depot; no "orders without a depot" branch and no depot count', async () => {
    const day = new Date('2026-10-07T00:00:00Z');
    tables.depot = rows(GHALA);
    const where = await ordersInScopeWhere(T, 'D1', day);
    expect(where).toEqual({ tenantId: T, deliveryDate: day, carriedToOrderId: null, depotId: 'D1' });
  });
});

// ---------------------------------------------------------------------------------------
// The history-only depot
// ---------------------------------------------------------------------------------------

describe('the history-only depot is never made active and never gets a truck or a region', () => {
  beforeEach(() => {
    tables.depot = rows(GHALA, OLD, HISTORY);
    tables.truck = [{ id: 'T1', tenantId: T, depotId: 'D1', code: 'T01', availableFromMin: null, availableToMin: null, defaultDriverId: null, active: true }];
    tables.region = [{ id: 'R1', tenantId: T, code: 'N', name: 'North', depotId: 'D1' }];
  });

  it('PATCH /api/depots/:id {active: true}: 422 DEPOT_HISTORY_ONLY, it stays inactive', async () => {
    const r = await answer(await depotPatch(json('/api/depots/DH', 'PATCH', { active: true }), { params: { id: 'DH' } }));
    expect(r.status).toBe(422);
    expect(r.body.error).toEqual({
      code: 'DEPOT_HISTORY_ONLY',
      message: 'Depot NO-DEPOT only keeps old orders and order files that had no depot. It cannot be made active. Add a new depot instead.',
    });
    expect(tables.depot.find((d) => d.id === 'DH')).toMatchObject({ active: false, historyOnly: true });
  });

  it('its name and address can still be changed; an ordinary inactive depot is still reactivated', async () => {
    const renamed = await answer(await depotPatch(json('/api/depots/DH', 'PATCH', { name: 'Old orders', address: 'n/a' }), { params: { id: 'DH' } }));
    expect(renamed.status).toBe(200);
    expect(tables.depot.find((d) => d.id === 'DH')).toMatchObject({ name: 'Old orders', active: false });
    const back = await answer(await depotPatch(json('/api/depots/D0', 'PATCH', { active: true }), { params: { id: 'D0' } }));
    expect(back.status).toBe(200);
    expect(tables.depot.find((d) => d.id === 'D0')!.active).toBe(true);
  });

  it('a truck or a region on it: 422 DEPOT_HISTORY_ONLY (create and change); an active depot still works', async () => {
    const truck = { code: 'T02', capacityCases: 100, capacityWeightKg: 1000, capacityVolumeL: 0, fixedCostPerDay: 0, costPerKm: 0 };
    const truckMsg = 'Depot NO-DEPOT only keeps old orders and order files that had no depot. Choose an active depot for this truck.';
    const regionMsg = 'Depot NO-DEPOT only keeps old orders and order files that had no depot. Choose an active depot for this region.';
    const calls = [
      { what: 'POST /api/trucks', run: () => truckPost(json('/api/trucks', 'POST', { ...truck, depotId: 'DH' })), message: truckMsg },
      { what: 'PATCH /api/trucks/T1', run: () => truckPatch(json('/api/trucks/T1', 'PATCH', { depotId: 'DH' }), { params: { id: 'T1' } }), message: truckMsg },
      { what: 'POST /api/regions', run: () => regionPost(json('/api/regions', 'POST', { code: 'S', name: 'South', depotId: 'DH' })), message: regionMsg },
      { what: 'PATCH /api/regions/R1', run: () => regionPatch(json('/api/regions/R1', 'PATCH', { depotId: 'DH' }), { params: { id: 'R1' } }), message: regionMsg },
    ];
    for (const c of calls) {
      const r = await answer(await c.run());
      expect(r.status, c.what).toBe(422);
      expect(r.body.error, c.what).toEqual({ code: 'DEPOT_HISTORY_ONLY', message: c.message });
    }
    expect(tables.truck).toHaveLength(1);
    expect(tables.truck[0].depotId).toBe('D1');
    expect(tables.region).toHaveLength(1);
    expect(tables.region[0].depotId).toBe('D1');
    // The same calls with an active depot are accepted.
    expect((await truckPost(json('/api/trucks', 'POST', { ...truck, depotId: 'D1' }))).status).toBe(201);
    expect((await regionPatch(json('/api/regions/R1', 'PATCH', { depotId: 'D1', name: 'North 2' }), { params: { id: 'R1' } })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------------------

describe('the Depots screen and the onboarding truck picker never offer the history-only depot', () => {
  const realFetch = globalThis.fetch;
  let sent: { url: string; method: string; body: any }[] = [];
  beforeEach(() => {
    sent = [];
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      sent.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
      const data = String(url) === '/api/depots' && (init?.method ?? 'GET') === 'GET' ? [GHALA, OLD, HISTORY] : { id: 'x' };
      return new Response(JSON.stringify({ data, error: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const editForm = async (row: Record<string, unknown>) => {
    const host = new Host(DepotFormDialog as any, { open: true, onOpenChange() {}, mode: 'edit', depot: row, mapboxToken: '', onSaved() {} });
    host.render();
    const els = () => elements(host.tree);
    const save = async () => {
      els().find((e) => e.type === 'form')!.props.onSubmit({ preventDefault() {} });
      await host.settle();
      return sent.at(-1)!;
    };
    return { host, els, save };
  };

  it('Edit of the history-only depot: a note instead of the Active switch, and Save never sends "active"', async () => {
    const f = await editForm(HISTORY);
    expect(f.els().some((e) => e.props?.id === 'active')).toBe(false);
    const note = f.els().find((e) => e.props?.['data-testid'] === 'depot-history-only');
    expect(textOf(note)).toBe(HISTORY_ONLY_NOTE);
    const req = await f.save();
    expect(req).toMatchObject({ url: '/api/depots/DH', method: 'PATCH' });
    expect(req.body).not.toHaveProperty('active');
    expect(req.body).toMatchObject({ code: 'NO-DEPOT', name: 'No depot (kept for history)' });
  });

  it('Edit of an ordinary depot keeps its Active switch and sends it', async () => {
    const f = await editForm(OLD);
    expect(f.els().some((e) => e.props?.id === 'active')).toBe(true);
    expect(f.els().some((e) => e.props?.['data-testid'] === 'depot-history-only')).toBe(false);
    expect((await f.save()).body).toMatchObject({ active: false });
  });

  it('the Depots table shows it as "History only", without a Delete button', () => {
    const rows = [GHALA, OLD, HISTORY].map((d) => ({ ...d, _count: { trucks: 0, regions: 0, runs: 0, orders: d === HISTORY ? 12 : 0, uploadBatches: 0 } }));
    const host = new Host(DepotsTable as any, { initial: rows, canManage: true, mapboxToken: '' });
    host.render();
    const els = elements(host.tree);
    const badges = els.filter((e) => typeName(e) === 'Badge').map((e) => textOf(e));
    expect(badges).toEqual(['Active', 'Inactive', 'History only']);
    expect(els.filter((e) => e.props?.['aria-label'] === 'Delete')).toHaveLength(2);
    expect(els.filter((e) => e.props?.['aria-label'] === 'Edit')).toHaveLength(3);
  });

  it('the onboarding "Add a truck" picker lists active depots only', async () => {
    const wizard = new Host(OnboardWizard as any, { slug: 'acme', mapboxToken: '', completion: { depots: 1, trucks: 0, customers: 0 } });
    wizard.render();
    const step = elements(wizard.tree).find((e) => typeName(e) === 'TruckStep')!;
    const host = new Host(step.type, step.props);
    host.render();
    await host.settle();
    expect(sent[0]).toMatchObject({ url: '/api/depots', method: 'GET' });
    const offered = elements(host.tree).filter((e) => ['D1', 'D0', 'DH'].includes(e.key)).map((e) => e.key);
    expect(offered).toEqual(['D1']);
  });
});

describe('the migration writes an audit event the Audit log can filter', () => {
  it('DEPOT_BACKFILL is in the audit catalog', () => {
    const sql = readFileSync(path.join(__dirname, '../../prisma/migrations/20260930120000_orders_always_have_depot/migration.sql'), 'utf8');
    const actions = [...sql.matchAll(/'([A-Z][A-Z_]+)',\s*\r?\n\s*'Tenant'/g)].map((m) => m[1]);
    expect(actions).toEqual(['DEPOT_BACKFILL']);
    expect(AUDIT_ACTIONS).toHaveProperty('DEPOT_BACKFILL');
  });
});
