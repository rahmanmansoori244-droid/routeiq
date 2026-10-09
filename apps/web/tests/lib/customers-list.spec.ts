/**
 * The Customers page past 1,000 customers (review findings ui-rest-1, web-day-data-3 and M10, 9 Oct
 * 2026) and the priority the planner uses (ui-rest-2).
 *
 * The page loaded the first 1,000 customers (active first, by code) and searched only those in the
 * browser: customer 1,001 and later could not be found or edited there, the header said "1000
 * customers" and the "need a pin" / "missing geocode" badges counted only the loaded rows. Now
 * lib/customer-list.ts searches (code, name, branch), filters (region, active only, data to collect,
 * need a pin, missing location) and pages (200 a page) in the database over every customer of the
 * company, from the page's address. The list and the customer page also showed only the stored
 * priority, while the planner uses the customer type's default when it is not confirmed; and
 * picking the shown priority in the list sent nothing (Radix fires only for another value).
 *
 * Here: the real page (server component), the real CustomersClient through tests/lib/hook-host.ts,
 * the real customer page, and lib/customer-list.ts on a fake tenant database that answers the
 * Prisma subset they use (and refuses any other filter). The same query on real PostgreSQL, with
 * another company's customers next to it: tests/integration/master-data-db.spec.ts section 7.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf } from './hook-host';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, notFound: () => { throw new Error('404'); }, redirect: () => { throw new Error('redirect'); } }));
vi.mock('next/dynamic', () => ({ default: () => function MapStub() { return null; } }));
vi.mock('sonner', () => ({ toast: { success() {}, error() {}, warning() {}, info() {} } }));
vi.mock('@/lib/auth', () => ({ auth: async () => null }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
const session = vi.hoisted(() => ({ role: 'PLANNER' }));
vi.mock('@/lib/tenant', () => ({
  getCurrentTenant: async () => ({ db: fakeDb, user: { id: 'u1', tenantId: 'tA', role: session.role, name: 'Planner', email: 'p@a.example' }, tenant: { id: 'tA', slug: 'acme' } }),
  tenantDb: () => fakeDb,
}));
vi.mock('@/lib/dispatch/service-area', async () => {
  const { DEFAULT_SERVICE_AREA } = await import('@/lib/dispatch/location-input');
  return { tenantServiceArea: async () => DEFAULT_SERVICE_AREA };
});
const worklist = vi.hoisted(() => ({ rows: [] as { customerId: string; missing: string; firstDelivery: string; depots: string[] }[] }));
vi.mock('@/lib/dispatch/customer-master', () => ({
  loadWorklist: async () => ({ from: '2026-10-10', to: '2026-10-12', days: 3, perDepot: [{ code: 'MCT', customers: worklist.rows.length }], rows: worklist.rows }),
}));
vi.mock('@/lib/delivery/customer-stats', () => ({ measuredByCustomer: async () => ({}) }));

import CustomersPage from '@/app/t/[slug]/customers/page';
import CustomerDetailPage from '@/app/t/[slug]/customers/[id]/page';
import { CustomersClient } from '@/app/t/[slug]/customers/customers-client';
import { DEFAULT_SERVICE_AREA } from '@/lib/dispatch/location-input';

// ---------------------------------------------------------------------------------------------
// A fake tenant database: the Prisma subset of the Customers page, the list and the customer page.
// ---------------------------------------------------------------------------------------------
type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
const calls: { model: string; op: string; args: Row }[] = [];

function matches(r: Row, w: Row | undefined): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, v]) => {
    if (k === 'AND') return (v as Row[]).every((x) => matches(r, x));
    if (k === 'OR') return (v as Row[]).some((x) => matches(r, x));
    if (v === null) return r[k] === null;
    if (typeof v === 'object') {
      if ('contains' in v) {
        if (r[k] == null) return false;
        return v.mode === 'insensitive' ? String(r[k]).toLowerCase().includes(String(v.contains).toLowerCase()) : String(r[k]).includes(v.contains);
      }
      if ('in' in v) return (v.in as unknown[]).includes(r[k]);
      if ('not' in v && v.not === null) return r[k] !== null;
      throw new Error(`fake database: unsupported filter ${k} ${JSON.stringify(v)}`);
    }
    return r[k] === v;
  });
}
function sorted(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) => Object.entries(o)) as [string, 'asc' | 'desc'][];
  return [...rows].sort((a, b) => {
    for (const [k, d] of keys) {
      const x = typeof a[k] === 'boolean' ? Number(a[k]) : a[k];
      const y = typeof b[k] === 'boolean' ? Number(b[k]) : b[k];
      if (x === y) continue;
      return (x < y ? -1 : 1) * (d === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
const regionOf = (r: Row) => (r.regionId ? db.region!.find((g) => g.id === r.regionId) ?? null : null);
function shape(r: Row, a: Row): Row {
  if (a.select) {
    const out: Row = {};
    for (const [k, v] of Object.entries(a.select as Row)) {
      if (!v) continue;
      out[k] = k === 'region' ? (regionOf(r) && { id: regionOf(r)!.id, code: regionOf(r)!.code, name: regionOf(r)!.name }) : r[k];
    }
    return out;
  }
  const out = { ...r };
  if (a.include?.region) out.region = regionOf(r);
  if (a.include?.windowConfirmedBy) out.windowConfirmedBy = null;
  return out;
}
function model(name: string) {
  const t = () => db[name] ?? [];
  const log = (op: string, args: Row = {}) => calls.push({ model: name, op, args });
  return {
    findMany: async (a: Row = {}) => {
      log('findMany', a);
      const rows = sorted(t().filter((r) => matches(r, a.where)), a.orderBy);
      return rows.slice(a.skip ?? 0, a.take === undefined ? undefined : (a.skip ?? 0) + a.take).map((r) => shape(r, a));
    },
    count: async (a: Row = {}) => {
      log('count', a);
      return t().filter((r) => matches(r, a.where)).length;
    },
    findUnique: async (a: Row) => {
      log('findUnique', a);
      const r = t().find((x) => matches(x, a.where));
      return r ? shape(r, a) : null;
    },
    findFirst: async (a: Row = {}) => {
      log('findFirst', a);
      const r = sorted(t().filter((x) => matches(x, a.where)), a.orderBy)[0];
      return r ? shape(r, a) : null;
    },
  };
}
const fakeDb: any = {
  customer: model('customer'),
  region: model('region'),
  customerTypeProfile: model('customerTypeProfile'),
  tenantConfig: model('tenantConfig'),
  depot: model('depot'),
};

// 1,250 customers. Codes C00001..C01250; every third has no region; every hundredth is inactive;
// C00005 and C01201..C01250 have no location (51); C01101..C01110 are saved at 0,0 and C01111 is LOW
// and never confirmed (11 need a pin). C01249 is a GROCERY at branch NIZWA-7, its priority 3 not
// confirmed (the GROCERY profile says P4); C00002 has a confirmed P2.
const code = (i: number) => `C${String(i).padStart(5, '0')}`;
function customer(i: number): Row {
  const noPoint = i === 5 || i > 1200;
  const zero = i >= 1101 && i <= 1110;
  return {
    id: `id${i}`,
    tenantId: 'tA',
    code: code(i),
    name: `Shop ${i}`,
    branchCode: i === 1249 ? 'NIZWA-7' : null,
    branchKey: i === 1249 ? 'NIZWA-7' : '__MAIN__',
    regionId: i % 3 === 0 ? null : i % 3 === 1 ? 'r1' : 'r2',
    address: null,
    lat: noPoint ? null : zero ? 0 : 23.5 + (i % 100) / 1000,
    lng: noPoint ? null : zero ? 0 : 58.3 + (i % 100) / 1000,
    geocodeConfidence: noPoint ? 'MISSING' : i === 1111 ? 'LOW' : 'HIGH',
    locationVerified: false,
    priority: i === 2 ? 2 : 3,
    priorityConfirmed: i === 2,
    customerType: i === 1249 ? 'GROCERY' : null,
    avgServiceTimeMin: 10,
    serviceTimeConfirmed: false,
    paymentType: 'CREDIT',
    active: i % 100 !== 0,
    hardWindowStartMin: null,
    hardWindowEndMin: null,
    prefWindowStartMin: null,
    prefWindowEndMin: null,
    windowConfirmedAt: null,
    createdFromUpload: true,
  };
}

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  calls.length = 0;
  session.role = 'PLANNER';
  worklist.rows = [];
  router.replace.mockClear();
  router.refresh.mockClear();
  db.customer = Array.from({ length: 1250 }, (_, k) => customer(k + 1));
  db.region = [
    { id: 'r1', tenantId: 'tA', code: 'MCT', name: 'Muscat' },
    { id: 'r2', tenantId: 'tA', code: 'SOH', name: 'Sohar' },
  ];
  db.customerTypeProfile = [{ id: 'p1', tenantId: 'tA', customerType: 'GROCERY', defaultPriority: 4, serviceTimeMin: null, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null }];
  db.tenantConfig = [{ tenantId: 'tA', defaultServiceTimeMin: 10 }];
  db.depot = [];
});

/** The page for this address: its header and the props it gives the list. */
async function openPage(searchParams: Record<string, string> = {}) {
  const tree = await CustomersPage({ params: { slug: 'acme' }, searchParams });
  const list = elements(tree).find((e) => e.type === CustomersClient);
  return { description: tree.props.description as string, props: list?.props as Record<string, any> };
}

describe('the Customers page reads every customer of the company, a page at a time (ui-rest-1, web-day-data-3, M10)', () => {
  it('1,250 customers: the header says 1,250, the first page has 200 rows and says 7 pages', async () => {
    const { description, props } = await openPage();
    // Before: "1000 customers" and 1000 rows in the page.
    expect(description).toBe('1,250 customers · click a row to edit on the map.');
    expect(props.initial).toHaveLength(200);
    expect(props.list).toMatchObject({ total: 1250, pages: 7, pageSize: 200, params: { q: '', region: '', active: false, show: null, page: 1 } });
    // Active first, then by code: the inactive C00100 is not on the first page.
    expect(props.initial.slice(0, 3).map((r: Row) => r.code)).toEqual(['C00001', 'C00002', 'C00003']);
    expect(props.initial.map((r: Row) => r.code)).not.toContain('C00100');
  });

  it('a search finds a customer past the first 1000, by code (any letter case), name or branch', async () => {
    for (const q of ['c01249', 'C01249', 'nizwa-7', 'Shop 1249']) {
      const { props } = await openPage({ q });
      // Before: the page ignored the address and the browser searched only C00001..C01000 (C00100 etc. inactive last).
      expect(props.initial.map((r: Row) => r.code), q).toEqual(['C01249']);
      expect(props.list.total).toBe(1);
      expect(props.list.params.q).toBe(q);
    }
  });

  it('the header and the badges count the whole company: 51 without a location, 11 that need a pin', async () => {
    const { props } = await openPage();
    // Before: the badges counted the 1000 loaded rows (1 missing, 0 need a pin).
    expect(props.list.counts).toEqual({ missingLocation: 51, needsPin: 11 });
  });

  it('page 7 has the last 50, a page past the end is the last page', async () => {
    for (const page of ['7', '99']) {
      const { props } = await openPage({ page });
      expect(props.list.params.page).toBe(7);
      expect(props.initial).toHaveLength(50);
      expect(props.initial.at(-1).code).toBe('C01200'); // the 12 inactive ones are last
    }
  });

  it('the region, "no region" and active-only filters run on every customer, with the search', async () => {
    const want = (f: (r: Row) => boolean) => db.customer!.filter(f).length;
    expect((await openPage({ region: 'r1' })).props.list.total).toBe(want((r) => r.regionId === 'r1'));
    expect((await openPage({ region: '__noregion__', active: '1' })).props.list.total).toBe(want((r) => r.regionId === null && r.active));
    const both = await openPage({ region: '__noregion__', q: 'shop 12' });
    expect(both.props.list.total).toBe(want((r) => r.regionId === null && r.name.toLowerCase().includes('shop 12')));
    expect(both.props.initial.every((r: Row) => r.regionId === null && r.name.startsWith('Shop 12'))).toBe(true);
  });

  it('the data to collect (?show=collect, the day screen\'s link) is every worklist customer, soonest delivery first, also past the first 1000', async () => {
    worklist.rows = [
      { customerId: 'id1240', missing: 'Location', firstDelivery: '2026-10-12', depots: ['MCT'] },
      { customerId: 'id1100', missing: 'Hours', firstDelivery: '2026-10-10', depots: ['MCT'] },
      { customerId: 'id3', missing: 'Location', firstDelivery: '2026-10-10', depots: ['MCT'] },
    ];
    const { props } = await openPage({ show: 'collect' });
    expect(props.initial.map((r: Row) => r.code)).toEqual(['C00003', 'C01100', 'C01240']);
    expect(props.list.total).toBe(3);
    expect(Object.keys(props.collect.rows)).toHaveLength(3);
    // Without the view the worklist marks still reach the rows of the page (C00003 is on page 1).
    expect(Object.keys((await openPage()).props.collect.rows)).toContain('id3');
  });

  it('a viewer has no data to collect: ?show=collect shows every customer', async () => {
    session.role = 'VIEWER';
    worklist.rows = [{ customerId: 'id3', missing: 'Location', firstDelivery: '2026-10-10', depots: ['MCT'] }];
    const { props } = await openPage({ show: 'collect' });
    expect(props.collect).toBeNull();
    expect(props.list.params.show).toBeNull();
    expect(props.list.total).toBe(1250);
  });

  it('the "need a pin" and "missing location" views list exactly those customers of the company', async () => {
    const pin = await openPage({ show: 'pin' });
    expect(pin.props.initial.map((r: Row) => r.code)).toEqual(Array.from({ length: 11 }, (_, k) => code(1101 + k)));
    const missing = await openPage({ show: 'missing' });
    expect(missing.props.list.total).toBe(51);
    expect(missing.props.initial[0].code).toBe('C00005');
  });

  it('a company without customers still gets the empty state', async () => {
    db.customer = [];
    const tree = await CustomersPage({ params: { slug: 'acme' }, searchParams: {} });
    expect(elements(tree).some((e) => e.type === CustomersClient)).toBe(false);
    expect(tree.props.description).toBe('Master data for every delivery destination.');
  });
});

describe('the page and the list show the priority the planner uses (ui-rest-2)', () => {
  it('each row carries the stored priority, whether it is confirmed, and the planned one (the type default wins when not confirmed)', async () => {
    const one = (await openPage({ q: 'C01249' })).props.initial[0];
    expect(one).toMatchObject({ priority: 3, priorityConfirmed: false, plannedPriority: 4, plannedPrioritySource: 'TYPE' });
    const two = (await openPage({ q: 'C00002' })).props.initial[0];
    expect(two).toMatchObject({ priority: 2, priorityConfirmed: true, plannedPriority: 2, plannedPrioritySource: 'CUSTOMER' });
    const plain = (await openPage({ q: 'C00003' })).props.initial[0];
    expect(plain).toMatchObject({ priority: 3, priorityConfirmed: false, plannedPriority: 3, plannedPrioritySource: 'DEFAULT' });
  });

  it("the customer page's Details card says which priority the planner uses", async () => {
    const tree = await CustomerDetailPage({ params: { slug: 'acme', id: 'id1249' } });
    const note = elements(tree).find((e) => e.props?.['data-testid'] === 'customer-priority-note');
    // Before: only the stored "3".
    expect(textOf(note)).toBe('The planner uses P4 - customer type default, not confirmed. Confirm a priority in Details.');
    const confirmed = await CustomerDetailPage({ params: { slug: 'acme', id: 'id2' } });
    expect(elements(confirmed).find((e) => e.props?.['data-testid'] === 'customer-priority-note')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The list in the browser (the real CustomersClient, hook-host.ts).
// ---------------------------------------------------------------------------------------------
const byTestId = (tree: any, id: string) => elements(tree).filter((e) => e.props?.['data-testid'] === id);

async function clientFor(searchParams: Record<string, string> = {}, canEdit = true) {
  const { props } = await openPage(searchParams);
  const host = new Host<Record<string, any>>(CustomersClient as any, { ...props, canEdit });
  host.render();
  return host;
}

describe('the list in the browser asks the server for the search, the filters and the page', () => {
  it('typing searches every customer once the typing pauses; Enter at once', async () => {
    vi.useFakeTimers();
    try {
      const host = await clientFor();
      const box = () => byTestId(host.tree, 'customers-search')[0]!;
      box().props.onChange({ target: { value: 'c0124' } });
      host.flush();
      box().props.onChange({ target: { value: 'c01249 ' } });
      host.flush();
      vi.advanceTimersByTime(299);
      expect(router.replace).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      // Before: the browser filtered its 1000 rows and never asked the server.
      expect(router.replace.mock.calls).toEqual([['/t/acme/customers?q=c01249', { scroll: false }]]);
      // The server's answer for that address: the box keeps the text, nothing is asked again.
      host.render((await openPage({ q: 'c01249' })).props);
      vi.advanceTimersByTime(1000);
      expect(router.replace).toHaveBeenCalledTimes(1);
      expect(host.props.initial.map((r: Row) => r.code)).toEqual(['C01249']);
      box().props.onChange({ target: { value: 'nizwa' } });
      host.flush();
      box().props.onKeyDown({ key: 'Enter' });
      expect(router.replace).toHaveBeenLastCalledWith('/t/acme/customers?q=nizwa', { scroll: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the filters and the pages are links of the address; a filter goes back to the first page', async () => {
    const host = await clientFor({ q: 'shop', page: '2' });
    const region = elements(host.tree).find((e) => typeof e.props?.onValueChange === 'function' && e.props.value === '__all__')!;
    region.props.onValueChange('__noregion__');
    expect(router.replace).toHaveBeenLastCalledWith('/t/acme/customers?q=shop&region=__noregion__', { scroll: false });
    byTestId(host.tree, 'active-only')[0]!.props.onCheckedChange(true);
    expect(router.replace).toHaveBeenLastCalledWith('/t/acme/customers?q=shop&active=1', { scroll: false });
    byTestId(host.tree, 'customers-next')[0]!.props.onClick();
    expect(router.replace).toHaveBeenLastCalledWith('/t/acme/customers?q=shop&page=3', { scroll: false });
    byTestId(host.tree, 'customers-prev')[0]!.props.onClick();
    expect(router.replace).toHaveBeenLastCalledWith('/t/acme/customers?q=shop', { scroll: false });
    expect(textOf(byTestId(host.tree, 'customers-shown')[0])).toBe('201–400 of 1,250 matching');
  });

  it('the badges show the company counts and open their customers; "Show all customers" clears everything', async () => {
    const host = await clientFor();
    expect(textOf(byTestId(host.tree, 'customers-need-pin')[0])).toBe('11 need a pin');
    expect(textOf(byTestId(host.tree, 'customers-missing-location')[0])).toBe('51 missing geocode');
    byTestId(host.tree, 'show-need-pin')[0]!.props.onClick();
    expect(router.replace).toHaveBeenLastCalledWith('/t/acme/customers?show=pin', { scroll: false });
    byTestId(host.tree, 'show-missing-location')[0]!.props.onClick();
    expect(router.replace).toHaveBeenLastCalledWith('/t/acme/customers?show=missing', { scroll: false });

    const none = await clientFor({ q: 'no such shop', active: '1' });
    expect(textOf(byTestId(none.tree, 'customers-shown')[0])).toBe('None');
    byTestId(none.tree, 'customers-show-all')[0]!.props.onClick();
    expect(router.replace).toHaveBeenLastCalledWith('/t/acme/customers', { scroll: false });
  });

  it('"Data to collect" switches the collect view of the server, and its rows keep their marks', async () => {
    worklist.rows = [{ customerId: 'id1240', missing: 'Location', firstDelivery: '2026-10-12', depots: ['MCT'] }];
    const host = await clientFor({ show: 'collect' });
    expect(byTestId(host.tree, 'collect-only')[0]!.props.checked).toBe(true);
    expect(byTestId(host.tree, 'to-collect').map((e) => e.props['data-customer'])).toEqual(['C01240']);
    byTestId(host.tree, 'collect-only')[0]!.props.onCheckedChange(false);
    expect(router.replace).toHaveBeenLastCalledWith('/t/acme/customers', { scroll: false });
  });
});

describe('the list shows the planned priority and confirms the shown one (ui-rest-2)', () => {
  // PlannedPriority and PriorityCell are child components: hook-host does not render them, so a
  // test renders one from its element (they use no hooks).
  const planned = (host: Host<any>, c: string) => {
    const el = elements(host.tree).find((e) => e.type?.name === 'PlannedPriority' && e.props.row.code === c);
    if (!el) throw new Error(`no planned priority element for ${c}`);
    return el.type(el.props);
  };

  it('a grocery stored as P3 but planned as P4 says so; an unconfirmed default says "not confirmed"; a confirmed one nothing more', async () => {
    const host = await clientFor({ q: 'C0124' });
    const note = planned(host, 'C01249');
    // Before: only the stored "3".
    expect(textOf(note)).toBe('planned P4');
    expect(note.props.title).toBe('The planner uses P4 - customer type default, not confirmed. Pick a priority to confirm it.');
    expect(textOf(planned(host, 'C01240'))).toBe('not confirmed');
    expect(planned(host, 'C01240').props.title).toBe('The planner uses P3 - default, not confirmed. Pick a priority to confirm it.');
    const two = await clientFor({ q: 'C00002' });
    expect(planned(two, 'C00002')).toBeNull();
    // A viewer sees the same note, without the hint to pick one.
    const viewer = await clientFor({ q: 'C01249' }, false);
    expect(planned(viewer, 'C01249').props.title).toBe('The planner uses P4 - customer type default, not confirmed.');
  });

  it('an unconfirmed priority is not selected, so picking the shown one confirms it (PATCH { priority: 3 })', async () => {
    const sent: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ data: { id: 'id1249', priority: 3, priorityConfirmed: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const host = await clientFor({ q: 'C01249' });
      const pc = elements(host.tree).find((e) => e.type?.name === 'PriorityCell')!;
      expect(pc.props).toMatchObject({ value: 3, confirmed: false });
      const select = pc.type(pc.props);
      // Before: value "3", and Radix calls onValueChange only for another value.
      expect(select.props.value).toBe('');
      expect(elements(select).find((e) => 'placeholder' in (e.props ?? {}))!.props.placeholder).toBe('3');
      select.props.onValueChange('3');
      await host.settle();
      expect(sent.map((s) => [s.url, s.init?.method, s.init?.body])).toEqual([['/api/customers/id1249', 'PATCH', JSON.stringify({ priority: 3 })]]);
      expect(router.refresh).toHaveBeenCalledTimes(1);
      // Saved: it is the confirmed priority, the one planned.
      const after = elements(host.tree).find((e) => e.type?.name === 'PriorityCell')!;
      expect(after.props).toMatchObject({ value: 3, confirmed: true });
      expect(after.type(after.props).props.value).toBe('3');
      expect(planned(host, 'C01249')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('lib/customer-list.ts', () => {
  it('reads the address and writes it back; anything unknown is the default', async () => {
    const { customerListQuery, readCustomerListParams, CUSTOMER_SEARCH_MAX } = await import('@/lib/customer-list');
    const p = readCustomerListParams({ q: '  C_1 & co ', region: 'r1', active: '1', show: 'pin', page: '3' });
    expect(p).toEqual({ q: 'C_1 & co', region: 'r1', active: true, show: 'pin', page: 3 });
    expect(readCustomerListParams(Object.fromEntries(new URLSearchParams(customerListQuery(p).slice(1))))).toEqual(p);
    expect(readCustomerListParams({ show: 'all', page: '-2', active: 'yes' })).toEqual({ q: '', region: '', active: false, show: null, page: 1 });
    expect(readCustomerListParams({ page: '1e9x', q: ['a', 'b'] })).toMatchObject({ page: 1, q: 'a' });
    expect(readCustomerListParams({ q: 'x'.repeat(500) }).q).toHaveLength(CUSTOMER_SEARCH_MAX);
    expect(readCustomerListParams(undefined)).toEqual({ q: '', region: '', active: false, show: null, page: 1 });
    expect(customerListQuery(readCustomerListParams({}))).toBe('');
  });

  it('pages in a stable order: a code twin (another branch) is never repeated or skipped', async () => {
    const { loadCustomerList, DEFAULT_CUSTOMER_LIST } = await import('@/lib/customer-list');
    db.customer!.push({ ...customer(7), id: 'id7b', branchCode: 'B', branchKey: 'B' });
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const l = await loadCustomerList(fakeDb, { ...DEFAULT_CUSTOMER_LIST, page }, { collect: null, area: DEFAULT_SERVICE_AREA, pageSize: 500 });
      seen.push(...l.rows.map((r) => r.id));
    }
    expect(seen).toHaveLength(1251);
    expect(new Set(seen).size).toBe(1251);
    // Next to each other (branch "B" sorts before "__MAIN__").
    expect(seen.indexOf('id7b')).toBe(seen.indexOf('id7') - 1);
    const orderBy = calls.find((c) => c.model === 'customer' && c.op === 'findMany' && c.args.take)!.args.orderBy;
    expect(orderBy).toEqual([{ active: 'desc' }, { code: 'asc' }, { branchKey: 'asc' }, { id: 'asc' }]);
  });

  it('reads only the columns the table shows', async () => {
    const { loadCustomerList, DEFAULT_CUSTOMER_LIST } = await import('@/lib/customer-list');
    const l = await loadCustomerList(fakeDb, DEFAULT_CUSTOMER_LIST, { collect: null, area: DEFAULT_SERVICE_AREA });
    expect(Object.keys(l.rows[0]!).sort()).toEqual(
      [
        'id', 'code', 'name', 'branchCode', 'branchKey', 'regionId', 'region', 'address', 'lat', 'lng', 'geocodeConfidence', 'locationVerified',
        'priority', 'priorityConfirmed', 'avgServiceTimeMin', 'paymentType', 'active', 'plannedPriority', 'plannedPrioritySource',
      ].sort(),
    );
    expect(l.rows[0]!.region).toEqual({ id: 'r1', code: 'MCT', name: 'Muscat' });
  });
});
